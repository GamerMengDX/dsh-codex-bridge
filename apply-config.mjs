#!/usr/bin/env node
/**
 * apply-config.mjs — 把 DSH 桥接注册进 Codex 的 config.toml（并支持安全卸载）。
 * English: registers the local DSH MCP bridge in the selected Codex configuration.
 * Only managed fields are patched; user options and unrelated source text are retained.
 * Check mode is read-only. Uninstall uses ownership and restoration evidence and
 * preserves conflicts rather than guessing what is safe to remove.
 *
 *   node apply-config.mjs                     # 注册 / 就地更新（会自动备份）
 *   node apply-config.mjs --check             # 只读检查；未注册/过期/无效时退出码非零
 *   node apply-config.mjs --uninstall         # 只移除本插件注册段，可重复执行
 *   node apply-config.mjs --dry-run           # 预览将要写入的内容，不落盘
 *   node apply-config.mjs --no-computer-use   # 明确要求时才关闭 computer-use
 *   node apply-config.mjs --config <path>     # 指定别的配置文件
 *   node apply-config.mjs --codex-home <dir>  # 等价于 --config <dir>/config.toml
 *
 * 约束：
 * - 只维护 `[mcp_servers.dsh]` 及其子表（`[mcp_servers.dsh.env]`）；模型、登录方式、
 *   其他 MCP server、其他表一概不动，也不会用宽松正则误删后面的表。
 * - 生成配置里持久化**非秘密**的 DSH 路径覆盖（GUI 启动的 Codex 不继承 shell 环境），
 *   绝不写入 DEEPSEEK_API_KEY 等凭据，也绝不整段导出 process.env。
 * - `--check` 是真正的就绪检查：未注册、路径过期、node/DSH 找不到都会返回非零。
 * - 任何写操作前先备份（`<config>.bak-dshbridge-<时间戳>`，权限 600）。
 */

import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_TASK_CWD,
  DSH_BIN,
  DSH_HOME,
  HOST_ROOT,
  chooseNode,
  dshDiscoveryHelp,
} from './lib/config.mjs'
import {
  createBackup,
  hashText,
  looksSecretText,
  readManifest,
  removeManifest,
  writeManifest,
} from './lib/install-manifest.mjs'
import {
  MANAGED_COMMENT_PREFIX,
  TomlScanError,
  extractOwnedRegion,
  findOwnedRegions,
  parseTableHeader,
  removeOwnedRegions,
  replaceOwnedRegions,
  scanToml,
  tomlArray,
  tomlString,
} from './lib/toml-sections.mjs'

/**
 * 桥接根目录：直接执行时取「被调用的脚本路径」，保留调用方使用的路径写法
 * （/var 与 /private/var、符号链接目录等），避免同一目录出现两种别名；被 import 时按模块位置解析。
 */
const ROOT = isMainModule() ? dirname(resolve(process.argv[1])) : dirname(fileURLToPath(import.meta.url))
const SERVER_ENTRY = join(ROOT, 'server.mjs')
const BASE_TABLE = 'mcp_servers.dsh'

/** 只有这些环境变量允许写进生成的 MCP 配置（白名单，永远不含凭据）。 */
const ENV_ALLOWLIST = [
  'DSH_BIN',
  'DSH_BRIDGE_HOME',
  'DSH_DEFAULT_CWD',
  'DSH_HOST_ROOT',
  'DSH_HOST_PORT_ANALYZE',
  'DSH_HOST_PORT_EDIT',
]

const SECRET_KEY_PATTERN = /key|token|secret|password|passwd|credential/i

export const COMPUTER_USE_SECTIONS = [
  '[plugins."computer-use@openai-bundled"]',
  '[plugins."unified-computer-use@openai-bundled"]',
]

export function readVersion(root = ROOT) {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export const VERSION = readVersion()

/** 生成配置时要持久化的非秘密环境覆盖（显式 env 优先，默认值兜底）。 */
export function mcpEnvOverrides(env = process.env) {
  const values = {
    DSH_BIN,
    DSH_BRIDGE_HOME: DSH_HOME,
    DSH_DEFAULT_CWD: DEFAULT_TASK_CWD,
    DSH_HOST_ROOT: HOST_ROOT,
  }
  if (env.DSH_HOST_PORT_ANALYZE) values.DSH_HOST_PORT_ANALYZE = String(env.DSH_HOST_PORT_ANALYZE)
  if (env.DSH_HOST_PORT_EDIT) values.DSH_HOST_PORT_EDIT = String(env.DSH_HOST_PORT_EDIT)

  const out = {}
  for (const key of ENV_ALLOWLIST) {
    if (!(key in values)) continue
    if (SECRET_KEY_PATTERN.test(key)) continue // 双保险：白名单永不含秘密
    const value = values[key]
    if (value === undefined || value === null || String(value) === '') continue
    out[key] = String(value)
  }
  return out
}

/** 归属表路径与「只由本插件管理」的基础字段。 */
const BASE_PATH = ['mcp_servers', 'dsh']
const ENV_PATH = ['mcp_servers', 'dsh', 'env']
const BASE_MANAGED_KEYS = ['command', 'args', 'cwd', 'startup_timeout_sec']

function isPathEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  return a.every((segment, index) => segment === b[index])
}

function isPathWithin(path, basePath) {
  if (!Array.isArray(path) || !Array.isArray(basePath) || path.length < basePath.length) return false
  return basePath.every((segment, index) => path[index] === segment)
}

/** 本插件要写入 `[mcp_servers.dsh]` 的管理字段（env 只含白名单内的非秘密项）。 */
export function managedFields({ nodeBin, serverEntry, root, envValues = {} } = {}) {
  return {
    base: {
      command: String(nodeBin),
      args: [String(serverEntry)],
      cwd: String(root),
      startup_timeout_sec: 30,
    },
    env: { ...envValues },
  }
}

function renderManagedValue(key, value) {
  if (key === 'startup_timeout_sec') return String(value)
  if (Array.isArray(value)) return tomlArray(value)
  return tomlString(value)
}

/** 渲染管理段；`comments: false` 得到不含任何用户内容/秘密的干净段（可入库）。 */
export function renderBlock(managed, { comments = true, version = VERSION } = {}) {
  const lines = []
  if (comments) {
    lines.push(`${MANAGED_COMMENT_PREFIX} MCP 注册段（v${version} 生成；卸载 node ${join(ROOT, 'apply-config.mjs')} --uninstall）`)
    lines.push(`${MANAGED_COMMENT_PREFIX} Codex 通过标准 MCP 调用本地 DSH，不需要截屏 / computer use。`)
  }
  lines.push(`[${BASE_TABLE}]`)
  for (const key of BASE_MANAGED_KEYS) lines.push(`${key} = ${renderManagedValue(key, managed.base[key])}`)
  const envKeys = Object.keys(managed.env)
  if (envKeys.length) {
    lines.push('')
    lines.push(`[${BASE_TABLE}.env]`)
    for (const key of envKeys) lines.push(`${key} = ${tomlString(managed.env[key])}`)
  }
  return `${lines.join('\n')}\n`
}

/** 生成 `[mcp_servers.dsh]` 注册段（含 env 子表）。 */
export function buildBlock({ nodeBin, serverEntry, root, envValues = {}, version = VERSION } = {}) {
  return renderBlock(managedFields({ nodeBin, serverEntry, root, envValues }), { comments: true, version })
}

/* --------------------------------------------------------------- 解析辅助 */

function decodeBasicBody(body) {
  let out = ''
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (ch === '"') break
    if (ch === '\\') {
      const next = body[i + 1]
      const map = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\', b: '\b', f: '\f' }
      if (next in map) {
        out += map[next]
        i += 1
        continue
      }
      if (next === 'u') {
        out += String.fromCharCode(Number.parseInt(body.slice(i + 2, i + 6), 16))
        i += 5
        continue
      }
      out += next
      i += 1
      continue
    }
    out += ch
  }
  return out
}

/** 解析单行 TOML 值（字符串 / 字符串数组 / 标量）；只用于语义比较与提示，不做权威解析。 */
function parseTomlValue(raw) {
  const text = String(raw).trim()
  if (text.startsWith('"')) return decodeBasicBody(text.slice(1))
  if (text.startsWith("'")) {
    const end = text.indexOf("'", 1)
    return end === -1 ? text : text.slice(1, end)
  }
  if (text.startsWith('[')) {
    const values = []
    const close = text.lastIndexOf(']')
    const inner = text.slice(1, close === -1 ? undefined : close)
    const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g
    let match
    while ((match = re.exec(inner))) {
      values.push(match[2] !== undefined ? match[2] : decodeBasicBody(match[1]))
    }
    return values
  }
  return text
}

function sameManagedValue(expected, actual) {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, index) => String(value) === String(actual[index]))
    )
  }
  if (typeof expected === 'number') return Number(actual) === expected
  return String(actual) === String(expected)
}

/**
 * 扫描一次配置，收集归属表、管理字段位置与不可安全补丁的复杂写法。
 * @throws {TomlScanError} 语法上无法确定边界时抛出。
 */
function inspectOwnedConfig(text, managed) {
  const src = String(text ?? '')
  const scan = scanToml(src)
  const baseHeaders = scan.headers.filter((header) => isPathEqual(header.path, BASE_PATH))
  const envHeaders = scan.headers.filter((header) => isPathEqual(header.path, ENV_PATH))
  const baseAssign = new Map()
  const envAssign = new Map()
  const duplicateManaged = []

  for (const item of scan.assignments) {
    if (isPathEqual(item.tablePath, BASE_PATH) && item.path.length === 1) {
      const key = item.path[0]
      if (baseAssign.has(key)) {
        if (BASE_MANAGED_KEYS.includes(key)) duplicateManaged.push(`[${BASE_TABLE}] ${key}`)
      } else baseAssign.set(key, item)
    } else if (isPathEqual(item.tablePath, ENV_PATH) && item.path.length === 1) {
      const key = item.path[0]
      if (envAssign.has(key)) {
        if (Object.hasOwn(managed.env, key)) duplicateManaged.push(`[${BASE_TABLE}.env] ${key}`)
      } else envAssign.set(key, item)
    }
  }

  let unsupported
  if (baseHeaders.some((header) => header.array) || envHeaders.some((header) => header.array)) {
    unsupported = '归属表使用了数组表（[[...]]）写法，无法安全补丁'
  } else if (duplicateManaged.length) {
    unsupported = `归属表内出现重复键（${duplicateManaged.join('、')}），无法安全补丁`
  } else if (scan.assignments.some((item) => isPathEqual(item.tablePath, BASE_PATH) && item.path.length === 1 && item.path[0] === 'env')) {
    unsupported = '检测到 inline env（env = {...}），无法可靠拆分字段'
  } else if (scan.assignments.some((item) => isPathEqual(item.tablePath, ['mcp_servers']) && item.path.length === 1 && item.path[0] === 'dsh')) {
    unsupported = '检测到 inline [mcp_servers.dsh]，无法可靠拆分字段'
  }

  const enabledAssign = baseAssign.get('enabled')
  const disabled =
    enabledAssign !== undefined && parseTomlValue(src.slice(enabledAssign.valueStart, enabledAssign.valueEnd)) === 'false'

  return {
    src,
    scan,
    baseHeaders,
    envHeaders,
    baseHeader: baseHeaders[0],
    envHeader: envHeaders[0],
    baseAssign,
    envAssign,
    registered: Boolean(baseHeaders.length),
    disabled,
    unsupported,
  }
}

/** 按管理字段语义比较：允许额外键、额外 env 与额外子表；只报告管理字段的问题。 */
function checkManaged(info, managed) {
  if (info.unsupported) return { reasons: [info.unsupported] }
  const reasons = []
  const { src } = info
  if (!info.baseHeader) return { reasons }
  if (info.baseHeaders.length > 1) reasons.push(`存在 ${info.baseHeaders.length} 处 [${BASE_TABLE}]，需要合并为一处`)
  if (info.envHeaders.length > 1) reasons.push(`存在 ${info.envHeaders.length} 处 [${BASE_TABLE}.env]`)

  for (const key of BASE_MANAGED_KEYS) {
    const item = info.baseAssign.get(key)
    if (!item) {
      reasons.push(`[${BASE_TABLE}] 缺少 ${key}`)
      continue
    }
    const actual = parseTomlValue(src.slice(item.valueStart, item.valueEnd))
    if (!sameManagedValue(managed.base[key], actual)) reasons.push(`[${BASE_TABLE}] 的 ${key} 不一致`)
  }
  for (const key of Object.keys(managed.env)) {
    const item = info.envAssign.get(key)
    if (!item) {
      reasons.push(`[${BASE_TABLE}.env] 缺少 ${key}`)
      continue
    }
    const actual = parseTomlValue(src.slice(item.valueStart, item.valueEnd))
    if (String(actual) !== String(managed.env[key])) reasons.push(`[${BASE_TABLE}.env] 的 ${key} 不一致`)
  }
  return { reasons }
}

/** 一行赋值的行尾偏移（用于在所属表末尾插入缺失字段）。 */
function lineEndAfter(src, offset) {
  const newline = src.indexOf('\n', offset)
  return newline === -1 ? src.length : newline
}

/** 归属表末尾的插入位置：尽量放在该表最后一个赋值（含用户键）之后、下一个表头之前。 */
function insertionOffset(src, header, assignments) {
  let anchor = header.end
  for (const item of assignments) anchor = Math.max(anchor, item.valueEnd)
  return lineEndAfter(src, anchor)
}

/** 某张归属表占用的源码区间（表头到下一个表头，尾随空行并入、前导本插件注释并入）。 */
function ownedBlockRange(src, scan, header) {
  const lines = src.split('\n')
  const next = scan.headers.find((item) => item.line > header.line)
  const startLine = header.line - 1
  let endLine = next ? next.line - 1 : scan.lineStarts.length
  while (endLine > startLine + 1 && lines[endLine - 1] !== undefined && lines[endLine - 1].trim() === '') endLine -= 1
  let head = startLine
  while (head - 1 >= 0 && /^\s*#\s*-*\s*dsh-codex-bridge\b/i.test(lines[head - 1])) head -= 1
  const start = scan.lineStarts[head]
  const end = endLine < scan.lineStarts.length ? scan.lineStarts[endLine] : src.length
  return { start, end }
}

function applyEdits(src, edits) {
  const ordered = [...edits].sort((a, b) => b.start - a.start || b.end - a.end)
  let out = src
  for (const edit of ordered) out = out.slice(0, edit.start) + edit.insert + out.slice(edit.end)
  return out
}

function appendBlock(src, block) {
  const base = String(src).replace(/\s+$/, '')
  return base ? `${base}\n\n${block}` : block
}

/**
 * 只补丁管理字段：保留 enabled=false、用户的未知键、额外 env、格式与无关字节。
 * 已存在值按 valueStart/valueEnd 原位替换（尾注释保留）；缺失值插入真实表末尾；
 * 缺失的 env 子表安全追加；重复归属表清理。
 * @returns {{text: string, changed: boolean, changes: string[], unsupported?: string}}
 */
function patchManagedConfig(text, managed) {
  const info = inspectOwnedConfig(text, managed)
  const src = info.src
  if (info.unsupported) return { text: src, changed: false, changes: [], unsupported: info.unsupported }

  if (!info.baseHeader) {
    if (info.envHeaders.length) {
      return {
        text: src,
        changed: false,
        changes: [],
        unsupported: `存在 [${BASE_TABLE}.env] 但没有显式父表；当前无法安全补充此写法，未修改配置`,
      }
    }
    return { text: appendBlock(src, renderBlock(managed, { comments: true })), changed: true, changes: [`注册 [${BASE_TABLE}]`] }
  }

  const edits = []
  const changes = []
  const changedKeys = []

  for (const key of BASE_MANAGED_KEYS) {
    const item = info.baseAssign.get(key)
    if (!item) continue
    const actual = parseTomlValue(src.slice(item.valueStart, item.valueEnd))
    if (sameManagedValue(managed.base[key], actual)) continue
    edits.push({ start: item.valueStart, end: item.valueEnd, insert: renderManagedValue(key, managed.base[key]) })
    changedKeys.push(`[${BASE_TABLE}] ${key}`)
  }
  for (const key of Object.keys(managed.env)) {
    const item = info.envAssign.get(key)
    if (!item) continue
    const actual = parseTomlValue(src.slice(item.valueStart, item.valueEnd))
    if (String(actual) === String(managed.env[key])) continue
    edits.push({ start: item.valueStart, end: item.valueEnd, insert: tomlString(managed.env[key]) })
    changedKeys.push(`[${BASE_TABLE}.env] ${key}`)
  }

  const missingBase = BASE_MANAGED_KEYS.filter((key) => !info.baseAssign.has(key))
  if (missingBase.length) {
    const at = insertionOffset(src, info.baseHeader, [...info.baseAssign.values()])
    const insert = missingBase.map((key) => `\n${key} = ${renderManagedValue(key, managed.base[key])}`).join('')
    edits.push({ start: at, end: at, insert })
    changedKeys.push(...missingBase.map((key) => `[${BASE_TABLE}] ${key}`))
  }

  const envKeys = Object.keys(managed.env)
  if (info.envHeader) {
    const missingEnv = envKeys.filter((key) => !info.envAssign.has(key))
    if (missingEnv.length) {
      const at = insertionOffset(src, info.envHeader, [...info.envAssign.values()])
      const insert = missingEnv.map((key) => `\n${key} = ${tomlString(managed.env[key])}`).join('')
      edits.push({ start: at, end: at, insert })
      changedKeys.push(...missingEnv.map((key) => `[${BASE_TABLE}.env] ${key}`))
    }
  } else if (envKeys.length) {
    const envLines = [`[${BASE_TABLE}.env]`, ...envKeys.map((key) => `${key} = ${tomlString(managed.env[key])}`)]
    edits.push({
      start: src.length,
      end: src.length,
      insert: `${src.endsWith('\n') ? '' : '\n'}\n${envLines.join('\n')}\n`,
    })
    changes.push(`追加 [${BASE_TABLE}.env]（${envKeys.join(', ')}）`)
  }

  const duplicates = [...info.baseHeaders.slice(1), ...info.envHeaders.slice(1)]
  for (const header of duplicates) {
    const range = ownedBlockRange(src, info.scan, header)
    if (range.end > range.start) edits.push({ ...range, insert: '' })
  }

  if (changedKeys.length) changes.unshift(`更新 ${[...new Set(changedKeys)].join('、')}`)
  if (duplicates.length) changes.push(`清理 ${duplicates.length} 处重复的归属表`)

  return { text: applyEdits(src, edits), changed: edits.length > 0, changes }
}

/** 所有归属区域的原文（可能分成多段）；用于备份恢复与「安装前原内容」记录。 */
function ownedContent(text, base) {
  const src = String(text ?? '')
  if (!src) return undefined
  const regions = findOwnedRegions(src, base)
  if (!regions.length) return undefined
  const lines = src.split('\n')
  return regions
    .map((region) => lines.slice(region.start, region.end).join('\n').replace(/\s+$/, ''))
    .join('\n\n')
}

/**
 * 归属内容规范化快照：忽略空行/注释/排版，保留键、值原文与所在表。
 * 安装记录里的 hash 由此计算，避免把用户额外 env 的秘密正文写进 manifest。
 */
function canonicalOwnedContent(text, base) {
  const src = String(text ?? '')
  const basePath = String(base).split('.')
  const parts = []
  for (const item of scanToml(src).assignments) {
    if (!isPathWithin(item.tablePath, basePath)) continue
    parts.push(`${item.table}\n${item.name} = ${src.slice(item.valueStart, item.valueEnd).trim()}`)
  }
  // 排序后再拼接：字段顺序/排版变化不算「用户修改」，但值、键与所在表的变化算。
  return parts.sort().join('\n')
}

/** 当前文本可能对应的归属哈希集合（兼容旧版完整区域 hash）。 */
function ownedHashes(text, base) {
  const src = String(text ?? '')
  const regions = findOwnedRegions(src, base)
  if (!regions.length) return new Set()
  const raw = ownedContent(src, base)
  const first = extractOwnedRegion(src, base)
  const set = new Set([hashText(canonicalOwnedContent(src, base))])
  if (raw !== undefined) set.add(hashText(raw))
  if (first !== undefined) set.add(hashText(first))
  return set
}

function withoutManagedComments(text) {
  return String(text ?? '')
    .split('\n')
    .filter((line) => !/^\s*#\s*-*\s*dsh-codex-bridge\b/i.test(line))
    .join('\n')
    .replace(/\s+$/, '')
}

function buildMcpRecord({ configPath, original, next, priorMpc, backupPath, noComputerUse, managed }) {
  const priorHasEvidence = Boolean(
    priorMpc && (priorMpc.previousBlock != null || priorMpc.previousFound || priorMpc.previousHash || priorMpc.backup),
  )
  const firstRegion = extractOwnedRegion(original, BASE_TABLE)
  const ownedBefore = ownedContent(original, BASE_TABLE)
  const looksOwn =
    /^#\s*dsh-codex-bridge:/m.test(firstRegion ?? '') ||
    Boolean(priorMpc?.installedHash && ownedHashes(original, BASE_TABLE).has(priorMpc.installedHash)) ||
    Boolean(
      priorMpc?.installedBlock &&
        firstRegion !== undefined &&
        withoutManagedComments(firstRegion) === withoutManagedComments(priorMpc.installedBlock),
    ) ||
    (firstRegion !== undefined &&
      canonicalOwnedContent(original, BASE_TABLE) ===
        canonicalOwnedContent(renderBlock(managed, { comments: false }), BASE_TABLE))

  const record = {
    configPath,
    installedHash: hashText(canonicalOwnedContent(next, BASE_TABLE)),
    installedBlock: renderBlock(managed, { comments: false }).replace(/\s+$/, ''),
    previousBlock: null,
    previousFound: false,
    previousHash: null,
    backup: null,
    computerUse: noComputerUse ? Object.fromEntries(reportComputerUse(original)) : priorMpc?.computerUse ?? null,
  }
  if (priorHasEvidence) {
    record.previousBlock = priorMpc.previousBlock ?? null
    record.previousFound = Boolean(priorMpc.previousFound)
    record.previousHash = priorMpc.previousHash ?? null
    record.backup = priorMpc.backup ?? null
  } else if (ownedBefore !== undefined && !looksOwn) {
    record.previousFound = true
    record.previousHash = hashText(canonicalOwnedContent(original, BASE_TABLE))
    record.backup = backupPath ?? null
    record.previousBlock = looksSecretText(ownedBefore) ? null : ownedBefore
  }
  return record
}

function reportComputerUse(text) {
  const found = new Map()
  const src = String(text)
  for (const item of scanToml(src).assignments) {
    const section = `[${item.table}]`
    if (item.path.length !== 1 || item.path[0] !== 'enabled' || !COMPUTER_USE_SECTIONS.includes(section)) continue
    const value = src.slice(item.valueStart, item.valueEnd).trim()
    if (value === 'true' || value === 'false') found.set(section, value === 'true')
  }
  return found
}

function setComputerUse(text, wanted) {
  const src = String(text)
  const edits = []
  for (const item of scanToml(src).assignments) {
    const section = `[${item.table}]`
    if (item.path.length !== 1 || item.path[0] !== 'enabled' || !COMPUTER_USE_SECTIONS.includes(section)) continue
    const current = src.slice(item.valueStart, item.valueEnd).trim()
    const value = wanted.get(section)
    if (value === undefined || current === String(value) || !['true', 'false'].includes(current)) continue
    edits.push({ start: item.valueStart, end: item.valueEnd, insert: String(value) })
  }
  return { text: applyEdits(src, edits), changed: edits.length > 0 }
}

/* ------------------------------------------------------------------- 参数 */

export function parseArgs(argv) {
  const opts = {
    check: false,
    uninstall: false,
    dryRun: false,
    noComputerUse: false,
    config: undefined,
    codexHome: undefined,
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--check') opts.check = true
    else if (arg === '--uninstall') opts.uninstall = true
    else if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--no-computer-use') opts.noComputerUse = true
    else if (arg === '--config') opts.config = argv[++i]
    else if (arg === '--codex-home') opts.codexHome = argv[++i]
    else if (arg === '--help' || arg === '-h') opts.help = true
    else opts.unknown = arg
  }
  return opts
}

export function resolveConfigPath(opts, env = process.env) {
  if (opts.config) return resolve(opts.config)
  if (opts.codexHome) return resolve(opts.codexHome, 'config.toml')
  const codexHome = env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(homedir(), '.codex')
  return join(codexHome, 'config.toml')
}

const HELP = `用法:
  node apply-config.mjs [--config <path> | --codex-home <dir>] [--check] [--dry-run]
  node apply-config.mjs --uninstall [--config <path> | --codex-home <dir>]

  --check         只读检查；未注册 / 已过期 / 路径无效时退出码 1
  --uninstall     移除本插件注册段（保留用户其他配置，可重复执行）
  --dry-run       打印将要写入的注册段，不修改文件
  --no-computer-use  显式关闭 computer-use 插件（默认不动）
`

/* --------------------------------------------------------------- 主流程 */

export function applyConfig(opts, { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  const say = (line = '') => stdout.write(`${line}\n`)
  const warn = (line) => stderr.write(`${line}\n`)

  const configPath = resolveConfigPath(opts, env)
  const codexHome = dirname(configPath)
  const nodeBin = chooseNode(env)
  const nodeExists = existsSync(nodeBin)
  const serverExists = existsSync(SERVER_ENTRY)
  const dshExists = Boolean(DSH_BIN) && existsSync(DSH_BIN)
  const envValues = mcpEnvOverrides(env)
  const managed = managedFields({ nodeBin, serverEntry: SERVER_ENTRY, root: ROOT, envValues })
  const expected = renderBlock(managed, { comments: false }).replace(/\s+$/, '')

  if (!existsSync(configPath)) {
    warn(`找不到 ${configPath}`)
    warn('请先用 Codex 启动一次生成配置，或显式指定 --codex-home <dir> / --config <path>。')
    return 1
  }

  const original = readFileSync(configPath, 'utf8')
  let info
  try {
    info = inspectOwnedConfig(original, managed)
  } catch (error) {
    if (error instanceof TomlScanError) {
      // 只报 code/line，绝不输出配置值；解析失败时不会进入任何写入路径。
      warn(`无法解析 ${configPath}：${error.code}（line=${error.line}），未修改任何文件。`)
      return 1
    }
    throw error
  }
  const registered = info.registered

  const environmentReasons = []
  if (!nodeExists) environmentReasons.push(`node 不存在：${nodeBin}（用 DSH_NODE 指定）`)
  if (!serverExists) environmentReasons.push(`MCP server 入口不存在：${SERVER_ENTRY}`)
  if (!DSH_BIN) environmentReasons.push('未找到 DSH 入口（见下方配置方式）')
  else if (!dshExists) environmentReasons.push(`DSH 入口不存在：${DSH_BIN}`)

  if (opts.check) {
    const reasons = [...checkManaged(info, managed).reasons, ...environmentReasons]
    say(`config: ${configPath}`)
    say(`node:   ${nodeBin}（${nodeExists ? '存在' : '不存在'}）`)
    say(`entry:  ${SERVER_ENTRY}（${serverExists ? '存在' : '不存在'}）`)
    say(`dsh:    ${DSH_BIN || '未找到'}`)
    say(`dsh MCP server: ${!registered ? '未注册' : reasons.length ? '已注册但未就绪/已过期' : '已注册且最新'}`)
    for (const reason of reasons) say(`  - ${reason}`)
    if (info.disabled) say(`提示: [${BASE_TABLE}] 中 enabled = false（保留你的禁用设置，未自动启用）`)
    for (const [section, enabled] of reportComputerUse(original)) say(`${section}: ${enabled ? '启用' : '已关闭'}`)
    try {
      const mode = statSync(configPath).mode & 0o777
      if (mode & 0o077) say(`提示: ${configPath} 权限 ${mode.toString(8)}，组/其他可读；建议 chmod 600`)
    } catch {
      /* 权限读不到不影响结论 */
    }
    const ready = registered && reasons.length === 0
    if (!ready) {
      if (!DSH_BIN || !dshExists) warn(dshDiscoveryHelp({ env }))
      if (!registered) warn(`未注册 [${BASE_TABLE}]：运行 node ${join(ROOT, 'apply-config.mjs')} 完成注册。`)
      else warn('注册段需要更新：重新运行 apply-config.mjs 即可就地修复。')
      return 1
    }
    return 0
  }

  if (opts.uninstall) {
    return uninstall({ configPath, codexHome, original, expected, say, warn })
  }

  // 预览 / 写入：只补丁管理字段，保留用户其他设置与无关字节。
  const patch = patchManagedConfig(original, managed)
  if (patch.unsupported) {
    warn(`拒绝修改 [${BASE_TABLE}]：${patch.unsupported}`)
    warn('未修改任何文件。')
    return 1
  }

  const changes = [...patch.changes]
  let next = patch.text

  if (opts.noComputerUse) {
    const enabled = reportComputerUse(next)
    const wanted = new Map([...enabled].map(([section]) => [section, false]))
    const result = setComputerUse(next, wanted)
    next = result.text
    if (result.changed) changes.push('关闭 computer-use 插件（本次显式指定）')
  }

  const existing = readManifest(codexHome) ?? { plugin: 'dsh-codex-bridge', codexHome }
  const priorMpc = existing?.mcp?.configPath === configPath ? existing.mcp : undefined
  const recordCurrent = Boolean(priorMpc) && ownedHashes(next, BASE_TABLE).has(priorMpc.installedHash)

  if (next === original) {
    // 字节幂等：不制造新备份；仅在安装记录缺失/过期时刷新记录。
    if (!recordCurrent) {
      existing.plugin = 'dsh-codex-bridge'
      existing.version = VERSION
      existing.bridgeRoot = ROOT
      existing.codexHome = codexHome
      existing.mcp = buildMcpRecord({
        configPath,
        original,
        next,
        priorMpc,
        backupPath: priorMpc?.backup ?? null,
        noComputerUse: opts.noComputerUse,
        managed,
      })
      writeManifest(codexHome, existing)
    }
    say('无需改动：MCP server 已注册且为最新。')
    return 0
  }

  if (opts.dryRun) {
    say(`config: ${configPath}`)
    say('--- 管理字段补丁（其余内容原样保留） ---')
    say(`[${BASE_TABLE}]`)
    say('--- 变更 ---')
    for (const change of changes.length ? changes : ['无']) say(`  ${change}`)
    const problems = checkManaged(info, managed).reasons
    if (problems.length) {
      say('--- 当前问题 ---')
      for (const problem of problems) say(`  - ${problem}`)
    }
    if (!nodeExists || !serverExists || !DSH_BIN || !dshExists) {
      if (!DSH_BIN || !dshExists) warn(dshDiscoveryHelp({ env }))
      return 1
    }
    return 0
  }

  if (!nodeExists || !serverExists || !DSH_BIN || !dshExists) {
    if (!nodeExists) warn(`找不到可用的 node：${nodeBin}。请设置 DSH_NODE 指向 node 可执行文件。`)
    if (!serverExists) warn(`找不到 MCP server 入口：${SERVER_ENTRY}`)
    if (!DSH_BIN || !dshExists) warn(dshDiscoveryHelp({ env }))
    warn('未修改任何文件。')
    return 1
  }

  const backup = createBackup(configPath)
  writeFileSync(configPath, next)
  say(`已备份: ${backup}`)
  for (const change of changes) say(`已应用: ${change}`)

  // 安装记录：只存干净管理段 + 归属内容 hash；原用户内容（可能含秘密）只留 0600 备份引用。
  existing.plugin = 'dsh-codex-bridge'
  existing.version = VERSION
  existing.bridgeRoot = ROOT
  existing.codexHome = codexHome
  existing.mcp = buildMcpRecord({
    configPath,
    original,
    next,
    priorMpc,
    backupPath: backup,
    noComputerUse: opts.noComputerUse,
    managed,
  })
  writeManifest(codexHome, existing)

  say('\n重启 Codex（或重开 Codex Desktop）后生效。检查：codex mcp list')
  return 0
}

function uninstall({ configPath, codexHome, original, expected, say, warn }) {
  const manifest = readManifest(codexHome)
  const record = manifest?.mcp?.configPath === configPath ? manifest.mcp : undefined
  const regions = findOwnedRegions(original, BASE_TABLE)

  if (!regions.length) {
    say(`未注册 [${BASE_TABLE}]：${configPath} 中没有本插件内容，无需卸载。`)
    if (record) {
      if (manifest) {
        delete manifest.mcp
        if (Object.keys(manifest).length > 2) writeManifest(codexHome, manifest)
        else removeManifest(codexHome)
      }
    }
    return 0
  }

  const region = extractOwnedRegion(original, BASE_TABLE)
  const hashes = ownedHashes(original, BASE_TABLE)
  const installedHash = record?.installedHash
  const ownedByRecord = Boolean(installedHash) && hashes.has(installedHash)

  if (installedHash && !ownedByRecord) {
    warn(`保留 [${BASE_TABLE}]：安装后被修改过（可能是你的自定义），不删除。`)
    warn('确认可以删除后，备份 config.toml 并手动删除该表；或重新运行 apply-config.mjs 让记录与内容对齐。')
    return 1
  }
  if (!installedHash) {
    warn(`保留 [${BASE_TABLE}]：没有安装记录，也无法证明它由本插件生成，未删除。`)
    return 1
  }

  let next = original
  const changes = []
  let restored = typeof record?.previousBlock === 'string' && record.previousBlock ? record.previousBlock : undefined
  let restoreProblem

  if (restored === undefined && record?.previousFound) {
    // 安装前确实有 [mcp_servers.dsh]（可能是秘密段，正文未入库）：只允许从备份恢复。
    // 备份引用缺失 / 文件丢失 / 内容与记录不符时保留冲突，绝不退化成「删除当前段」。
    const backupPath = record.backup
    if (!backupPath) {
      restoreProblem = `安装记录里没有原 [${BASE_TABLE}] 的备份引用，保留当前段`
    } else if (!existsSync(backupPath)) {
      restoreProblem = `原 [${BASE_TABLE}] 的备份已丢失：${backupPath}，保留当前段`
    } else {
      const backupText = readFileSync(backupPath, 'utf8')
      const previous = ownedContent(backupText, BASE_TABLE)
      if (!previous) {
        restoreProblem = `备份中找不到原 [${BASE_TABLE}] 段：${backupPath}，保留当前段`
      } else if (record.previousHash && !ownedHashes(backupText, BASE_TABLE).has(record.previousHash)) {
        restoreProblem = `备份中的原 [${BASE_TABLE}] 段与安装记录不一致：${backupPath}，保留当前段`
      } else {
        restored = previous
      }
    }
  } else if (restored === undefined && record?.backup && existsSync(record.backup)) {
    // 兼容旧记录：只有 backups、没有 previousFound 标记的安装记录
    const previous = ownedContent(readFileSync(record.backup, 'utf8'), BASE_TABLE)
    if (previous) restored = previous
  }

  if (restoreProblem) {
    warn(`保留 [${BASE_TABLE}]：${restoreProblem}`)
    warn('原内容需要人工恢复；本次未修改 config.toml。')
    return 1
  }

  if (restored) {
    next = replaceOwnedRegions(next, BASE_TABLE, restored).text
    changes.push('已恢复安装前的 [mcp_servers.dsh] 原内容')
  } else {
    next = removeOwnedRegions(next, BASE_TABLE).text
    changes.push('已移除 [mcp_servers.dsh] 注册段')
  }

  if (record?.computerUse) {
    const wanted = new Map(
      Object.entries(record.computerUse)
        .filter(([section]) => COMPUTER_USE_SECTIONS.includes(section))
        .map(([section, value]) => [section, value === true]),
    )
    if (wanted.size) {
      const result = setComputerUse(next, wanted)
      if (result.changed) {
        next = result.text
        changes.push('已恢复 computer-use 插件的安装前开关状态')
      }
    }
  }

  if (next !== original) {
    const backup = createBackup(configPath)
    writeFileSync(configPath, next)
    say(`已备份: ${backup}`)
  }
  for (const change of changes) say(change)

  if (manifest) {
    delete manifest.mcp
    if (Object.keys(manifest).length > 2) writeManifest(codexHome, manifest)
    else removeManifest(codexHome)
  }
  say('卸载完成：只移除了本插件注册段，其他配置保持不变。')
  return 0
}

/* ------------------------------------------------------------------ CLI */

/**
 * 判断本文件是否被当作主程序直接执行。
 *
 * 见 install-codex.mjs 同名函数：/var 与 /private/var 的路径别名、或符号链接的源码目录，
 * 会让字符串比较失败、入口静默不执行。统一按真实文件路径比较，参数不动。
 */
export function isMainModule(invoked = process.argv[1], selfUrl = import.meta.url) {
  if (!invoked) return false
  try {
    return realpathSync(fileURLToPath(selfUrl)) === realpathSync(resolve(invoked))
  } catch {
    return false
  }
}

const isMain = isMainModule()
if (isMain) {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    process.stdout.write(HELP)
    process.exit(0)
  }
  if (opts.unknown) {
    process.stderr.write(`未知参数: ${opts.unknown}\n\n${HELP}`)
    process.exit(64)
  }
  process.exit(applyConfig(opts))
}
