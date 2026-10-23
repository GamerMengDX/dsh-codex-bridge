/**
 * install-manifest.mjs — 安装记录（manifest）与备份/恢复辅助，供 install-codex / apply-config 共用。
 * English: ownership records and protected backup/restore helpers for the installers.
 * Releasing a file requires its installed hash to match. Restoring previous user
 * content also requires a verifiable backup; missing or changed evidence is a conflict.
 * Secret-text detection is heuristic, not a general-purpose redaction guarantee.
 *
 * 记录什么：本插件写过哪些路径、写进去的内容哈希、以及被替换掉的原内容「引用」。
 * 不记录什么：API key、凭据、整份全局配置正文。可能含秘密的原内容只保留备份文件路径
 * （备份文件权限 600，内容就是用户自己的配置），manifest 里最多存本插件自己生成的
 * 无秘密段落正文，且写入前还会再过一遍 `looksSecretText`。
 *
 * 归属判定（卸载时的唯一依据）：
 * - 当前内容哈希 === 安装时哈希 → 本插件拥有，可删除或恢复原内容；
 * - 否则说明安装后被改过 → 保留并报告冲突，绝不覆盖用户的修改。
 * manifest 丢失时调用方应保留内容并报告无法确认归属，不能猜测删除。
 */

import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

export const PLUGIN_ID = 'dsh-codex-bridge'
export const MANIFEST_NAME = '.dsh-codex-bridge-install.json'

export function hashText(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 16)
}

export function hashFile(file) {
  try {
    return hashText(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** 备份文件名带毫秒时间戳；即使同一毫秒创建多次，也由 createBackup 的排他创建兜底。 */
export function backupStamp(date = new Date()) {
  return date.toISOString().replace(/[-:TZ.]/g, '').slice(0, 17)
}

export function manifestPath(codexHome) {
  return join(codexHome, MANIFEST_NAME)
}

export function readManifest(codexHome) {
  const file = manifestPath(codexHome)
  if (!existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

export function writeManifest(codexHome, manifest) {
  const file = manifestPath(codexHome)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  return file
}

export function removeManifest(codexHome) {
  const file = manifestPath(codexHome)
  if (existsSync(file)) unlinkSync(file)
}

/**
 * 在覆盖任何文件前复制一份备份（权限 600）。返回备份路径。
 *
 * 两个细节：
 * - 用 `wx` 排他创建，名称碰撞时追加序号，绝不复用/覆盖已有备份；
 * - 新建后显式 chmod 0600 —— 只靠 writeFileSync 的 mode 在文件已存在时无效，
 *   而 `flag: 'wx'` 仍受 umask 影响，显式 chmod 才能保证备份不变成组/其他可读。
 */
export function createBackup(file, label = 'dshbridge') {
  const data = readFileSync(file)
  const base = `${file}.bak-${label}-${backupStamp()}`
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const backup = attempt === 0 ? base : `${base}-${attempt}`
    try {
      writeFileSync(backup, data, { mode: 0o600, flag: 'wx' })
    } catch (error) {
      if (error?.code === 'EEXIST') continue
      throw error
    }
    try {
      chmodSync(backup, 0o600)
    } catch {
      /* 权限设置失败不阻断安装（创建模式已是最严格的 600 上限） */
    }
    return backup
  }
  throw new Error(`无法创建备份（名称持续冲突）：${base}`)
}

/** 粗判文本里是否含秘密：命中就不把正文写进 manifest，只留备份文件引用。 */
export function looksSecretText(text) {
  return /(?<![\w.])([A-Za-z0-9_]*(?:api[_-]?key|token|secret|password|passwd|credential)[A-Za-z0-9_]*)\s*=\s*["']?[^\s"']{6,}/i.test(
    String(text ?? ''),
  )
}

/**
 * 记录一个「整文件」归属项。
 * @returns manifest.files 里的一条记录
 */
export function fileRecord(file, content, { kind, existingText, backup } = {}) {
  return {
    kind,
    hash: hashText(content),
    existedBefore: existingText !== undefined,
    previousHash: existingText !== undefined ? hashText(existingText) : null,
    backup: backup ?? null,
  }
}

/**
 * 卸载时处理一个整文件归属项。
 *
 * 恢复原则：只有「当前内容确实是安装时写的内容」并且「原内容备份仍可核对」时才动文件。
 * 备份引用缺失、备份文件丢失或备份内容与记录里的 previousHash 不符时一律返回 conflict，
 * 保留当前文件原样等待人工处理——绝不把「恢复失败」退化成删除用户文件。
 *
 * @returns {{action: 'removed'|'restored'|'conflict'|'missing', detail?: string}}
 */
export function releaseFile(file, entry) {
  if (!existsSync(file)) return { action: 'missing' }
  const current = hashFile(file)
  if (!entry || current !== entry.hash) {
    return { action: 'conflict', detail: '安装后被修改过，保留用户内容' }
  }
  if (entry.existedBefore) {
    if (!entry.backup) {
      return { action: 'conflict', detail: '原内容备份引用缺失，保留当前内容（可在同目录 .bak-* 中查找原文件）' }
    }
    if (!existsSync(entry.backup)) {
      return { action: 'conflict', detail: `原内容备份已丢失：${entry.backup}，保留当前内容` }
    }
    if (entry.previousHash && hashFile(entry.backup) !== entry.previousHash) {
      return { action: 'conflict', detail: `原内容备份与安装记录不一致：${entry.backup}，保留当前内容` }
    }
    copyFileSync(entry.backup, file)
    return { action: 'restored', detail: entry.backup }
  }
  unlinkSync(file)
  return { action: 'removed' }
}

/** 删掉因卸载而变空的技能目录（只删一层，且必须是空目录）。 */
export function pruneEmptyDir(dir) {
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return false
    if (readdirSync(dir).length) return false
    rmdirSync(dir)
    return true
  } catch {
    return false
  }
}
