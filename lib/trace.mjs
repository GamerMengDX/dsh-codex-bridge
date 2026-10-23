/**
 * trace.mjs — 每次桥接调用的本地轨迹，用来回答「这条 DSH 指令是谁、什么时候、在哪个会话里跑的」。
 *
 * 为什么需要：桥接用的是独立 DSH_HOME（.dsh / .dsh-host），和桌面版 GUI 的 home 不同；
 * one-shot 的 sessionId 又由 DSH 内部随机生成，桥接只能通过「目录增量」反查。
 * 没有轨迹时，DSH 报告可疑就只能翻 stdout。
 *
 * 轨迹只记录元数据（goal 截断 200 字 + 哈希），不保存完整 prompt 与报告正文。
 *
 * English:
 * Local metadata trace for every bridge call, answering "which DSH prompt ran, when, in which
 * session". The bridge uses its own DSH_HOME (separate from the desktop GUI), and one-shot
 * sessionIds are generated inside DSH, so the bridge can only recover them by directory diff.
 * Without a trace, a suspicious DSH report could only be rebuilt from stdout.
 * Only metadata is persisted (goal truncated to 200 chars plus a digest); full prompts and
 * report bodies are NOT written here. Files are pruned to the newest TRACE_LIMIT entries, and
 * writes use temp file + rename so a reader never sees a half-written trace.
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const TRACE_LIMIT = 200

export function newTaskId() {
  return randomBytes(4).toString('hex')
}

export function goalDigest(goal) {
  return createHash('sha256').update(String(goal)).digest('hex').slice(0, 12)
}

export function writeTrace(dir, record) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, `${record.taskId}.json`)
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, file)
  pruneTraces(dir)
  return file
}

export function readTrace(dir, taskId) {
  const file = join(dir, `${taskId}.json`)
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

export function listTraces(dir, limit = 20) {
  if (!existsSync(dir)) return []
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'))
  const entries = []
  for (const name of files) {
    try {
      const stat = statSync(join(dir, name))
      entries.push({ name, mtime: stat.mtimeMs })
    } catch {
      /* 忽略读取失败的条目 */
    }
  }
  entries.sort((a, b) => b.mtime - a.mtime)
  return entries.slice(0, limit).map((entry) => readTrace(dir, entry.name.replace(/\.json$/, ''))).filter(Boolean)
}

export function pruneTraces(dir, limit = TRACE_LIMIT) {
  try {
    const files = readdirSync(dir).filter((name) => name.endsWith('.json'))
    if (files.length <= limit) return 0
    const stats = files.map((name) => {
      try {
        return { name, mtime: statSync(join(dir, name)).mtimeMs }
      } catch {
        return { name, mtime: 0 }
      }
    })
    stats.sort((a, b) => b.mtime - a.mtime)
    let removed = 0
    for (const item of stats.slice(limit)) {
      try {
        rmSync(join(dir, item.name), { force: true })
        removed += 1
      } catch {
        /* ignore */
      }
    }
    return removed
  } catch {
    return 0
  }
}

/** 列出某个 DSH home 下已有的 sessionId（目录名即 id）。English: scan
 * <home>/sessions/<slug>/session-* directories and collect the directory names as ids; an
 * unreadable directory is skipped rather than failing the run. */
export function listSessionIds(home) {
  const root = join(home, 'sessions')
  const ids = new Set()
  if (!existsSync(root)) return ids
  let slugs = []
  try {
    slugs = readdirSync(root)
  } catch {
    return ids
  }
  for (const slug of slugs) {
    const dir = join(root, slug)
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith('session-')) ids.add(entry.name)
      }
    } catch {
      /* 跳过不可读目录 */
    }
  }
  return ids
}

/**
 * 一次运行结束后，找出新出现的会话。
 * 只有恰好一个新会话时才认领；并发调用时宁可留空，也不要记错。
 * English: diff the session directories before/after one run and claim the id only when
 * exactly one new session appeared. Under concurrent runs it returns undefined on purpose —
 * leaving the id empty is better than attributing a report to someone else's session.
 */
export function discoverNewSession(home, before) {
  const after = listSessionIds(home)
  const created = [...after].filter((id) => !before.has(id))
  return created.length === 1 ? created[0] : undefined
}
