/**
 * registry.mjs — 会话注册表：ID 生成、绑定校验、原子写入。
 *
 * ID 规则：`bridge-<mode>-<slug>-<hash8>`
 *   - slug 保留人类可读前缀（含中文）
 *   - hash8 = sha256(原始 label) 前 8 位，保证 `proj_a` / `proj a` / `proj-a` 不会撞车
 *
 * 兼容：旧版 ID 是 `bridge-<mode>-<slug>`（无哈希）。查找时先按 `label + mode`
 * 命中已有条目（旧条目也存了 label），因此老会话不会被丢弃或重建。
 *
 * English:
 * Session registry: deterministic ID generation, directory binding checks, atomic writes.
 * IDs are `bridge-<mode>-<slug>-<hash8>`: the slug keeps a human-readable prefix (CJK
 * included) and hash8 is the first 8 hex chars of sha256(label), so `proj_a`, `proj a` and
 * `proj-a` never collide.
 * A session is bound to one canonical cwd (symlinks resolved). Reusing a label with a different
 * directory is an error, never a silent migration; only a different spelling of the same
 * directory is normalized in place.
 * Writes take a pid lock and go through temp file + rename; a corrupt registry is renamed to a
 * timestamped backup instead of being silently emptied.
 */

import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

export const REGISTRY_VERSION = 2
const LOCK_STALE_MS = 10_000
const LOCK_TIMEOUT_MS = 2_000

export class SessionBindingError extends Error {}

export function canonicalCwd(value) {
  const absolute = resolve(String(value))
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

export function slugLabel(label) {
  const slug = String(label)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug || 'session'
}

export function hashLabel(label) {
  return createHash('sha256').update(String(label), 'utf8').digest('hex').slice(0, 8)
}

export function sessionIdFor(label, mode) {
  return `bridge-${mode}-${slugLabel(label)}-${hashLabel(label)}`
}

export function legacySessionIdFor(label, mode) {
  return `bridge-${mode}-${slugLabel(label)}`
}

export function registryPath(root) {
  return join(root, 'sessions.json')
}

function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600)
      writeFileSync(fd, String(process.pid))
      closeSync(fd)
      return () => {
        try {
          rmSync(lockPath, { force: true })
        } catch {
          /* ignore */
        }
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          rmSync(lockPath, { force: true })
          continue
        }
      } catch {
        continue
      }
      if (Date.now() > deadline) throw new Error(`会话注册表被占用：${lockPath}`)
      // 同步退避：这里只在 CLI 进程启动/收尾时短暂阻塞。
      const until = Date.now() + 50
      while (Date.now() < until) {
        /* spin */
      }
    }
  }
}

export function loadRegistry(root) {
  const file = registryPath(root)
  if (!existsSync(file)) return { version: REGISTRY_VERSION, sessions: {} }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || typeof parsed.sessions !== 'object' || parsed.sessions === null) {
      throw new Error('registry shape invalid')
    }
    return { version: parsed.version ?? 1, sessions: parsed.sessions }
  } catch {
    // 损坏时不静默清空：改名备份，保证历史可人工恢复。
    const backup = `${file}.corrupt-${Date.now()}`
    try {
      renameSync(file, backup)
    } catch {
      /* ignore */
    }
    return { version: REGISTRY_VERSION, sessions: {}, corruptBackup: backup }
  }
}

export function saveRegistry(root, registry) {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  try {
    chmodSync(root, 0o700)
  } catch {
    /* 目录可能是共享的，权限收紧失败不影响数据正确性 */
  }
  const file = registryPath(root)
  const release = acquireLock(`${file}.lock`)
  try {
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    const payload = { version: REGISTRY_VERSION, sessions: registry.sessions ?? {} }
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, file)
    chmodSync(file, 0o600)
  } finally {
    release()
  }
}

/** 按 label + mode 找条目；兼容旧 ID（旧条目同样带 label）。 */
export function findEntry(registry, { label, mode }) {
  for (const entry of Object.values(registry.sessions)) {
    if (entry && entry.label === label && entry.mode === mode) return entry
  }
  const legacy = registry.sessions[legacySessionIdFor(label, mode)]
  if (legacy && (!legacy.label || legacy.label === label)) return legacy
  return undefined
}

/**
 * 取或建一个会话条目。绑定不一致直接报错，绝不复用错误的 cwd。
 * 返回 { entry, created, idMigrated }。
 *
 * English: get-or-create one session entry. A label that is already bound to a different
 * canonical directory throws SessionBindingError — the task is never silently run in the wrong
 * directory. A registered id that no longer matches the current id scheme is reused (and
 * reported as idMigrated) so old history survives; an 8-hex hash collision is rejected rather
 * than routing to someone else's session.
 */
export function ensureSession(root, { label, mode, cwd }) {
  const canonical = canonicalCwd(cwd)
  const registry = loadRegistry(root)
  const existing = findEntry(registry, { label, mode })

  if (existing) {
    // 旧版本可能存了未解析符号链接的路径（如 macOS 的 /var → /private/var）。
    // 先规范化再比较；仅写法不同就就地迁移，真正不同则拒绝。
    const storedCanonical = canonicalCwd(existing.cwd)
    if (storedCanonical !== canonical) {
      throw new SessionBindingError(
        `会话 ${existing.id} 已绑定工作目录 ${storedCanonical}，与本次 ${canonical} 不一致；` +
        `请换一个 session 标签，或先把任务放回原目录`,
      )
    }
    if (existing.cwd !== canonical) {
      existing.cwd = canonical
      saveRegistry(root, registry)
    }
    return { entry: existing, created: false, idMigrated: existing.id !== sessionIdFor(label, mode) }
  }

  const id = sessionIdFor(label, mode)
  const clash = registry.sessions[id]
  if (clash && clash.label !== label) {
    // sha256 前 8 位碰撞：极不可能，但宁可拒绝也不要串到别人的会话。
    throw new Error(`会话 ID 冲突：${id} 已属于标签 ${clash.label}，请换一个标签`)
  }
  const entry = { id, label, mode, cwd: canonical, createdAt: new Date().toISOString() }
  registry.sessions[id] = entry
  saveRegistry(root, registry)
  return { entry, created: true, idMigrated: false }
}

export function touchSession(root, id) {
  const registry = loadRegistry(root)
  const entry = registry.sessions[id]
  if (!entry) return
  entry.lastUsedAt = new Date().toISOString()
  saveRegistry(root, registry)
}
