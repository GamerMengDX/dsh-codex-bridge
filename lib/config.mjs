/**
 * config.mjs — 路径、环境变量、node/DSH 发现与凭据解析。runner / host / 安装器共用。
 *
 * 三条原则：
 * 1. 不写死开发者机器上的绝对路径：默认值只与「本仓库位置」或「用户目录」有关。
 * 2. 显式环境变量优先（DSH_BIN / DSH_CLI_ROOT / DSH_NODE / DSH_BRIDGE_HOME / DSH_DEFAULT_CWD…）；
 *    发现逻辑只做补充，不覆盖用户明确配置。
 * 3. 发现不到时不猜：导出 discovered 状态与 `dshDiscoveryHelp()`，由调用方打印可操作提示。
 *    绝不为「探测」去执行真实模型调用。
 *
 * English:
 * Path, environment, node/DSH discovery and credential resolution shared by runner / host /
 * installers.
 * Rules: (1) no hard-coded developer paths — defaults derive only from this repo location or
 * the user home; (2) explicit environment variables win, discovery only fills the gaps and
 * never overrides a user's choice; (3) when nothing is found the module reports "not
 * discovered" plus actionable help text instead of guessing.
 * Discovery is filesystem stat/read only: it never executes DSH and never calls the model.
 * readApiKey() only reads environment and credential files; it never writes a key back.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = dirname(HERE)

/** `@deepseek-ai/dsh` 包内入口的相对路径（node_modules 之后的最后一段）。 */
const DSH_PACKAGE_BIN = join('@deepseek-ai', 'dsh', 'lib', 'bin.js')
const IS_WIN = process.platform === 'win32'

/** 桥接专用状态目录（默认在用户目录下；可用 DSH_BRIDGE_STATE_DIR 覆盖）。 */
export const BRIDGE_STATE_DIR = expandHome(process.env.DSH_BRIDGE_STATE_DIR) || join(homedir(), '.dsh-codex-bridge')

/**
 * DSH 状态 home 的默认值：用户目录下的桥接专用位置，而不是开发者的 DSH 项目目录。
 * 刻意不继承外部 DSH_HOME（Codex 若从 DSH 内部的 shell 启动，会指向桌面版 harness）。
 */
export const DEFAULT_DSH_HOME = join(BRIDGE_STATE_DIR, 'dsh-home')
export const DSH_HOME = expandHome(process.env.DSH_BRIDGE_HOME) || DEFAULT_DSH_HOME

/** 未显式给 cwd 时的默认工作目录：用户目录（不是原开发目录）。 */
export const DEFAULT_CWD = homedir()
export const DEFAULT_TASK_CWD = expandHome(process.env.DSH_DEFAULT_CWD) || DEFAULT_CWD

export const MAX_OUTPUT = Number(process.env.DSH_MAX_OUTPUT || 24000)
export const DEFAULT_TIMEOUT_S = Number(process.env.DSH_TASK_TIMEOUT_S || 600)
export const HARD_TIMEOUT_S = 1800

export const MODE_PATCH = {
  analyze: join(ROOT, 'patches', 'read-only.yml'),
  edit: join(ROOT, 'patches', 'workspace-write.yml'),
}

export const HOST_ROOT = expandHome(process.env.DSH_HOST_ROOT) || join(BRIDGE_STATE_DIR, 'host')
export const TRACE_DIR = expandHome(process.env.DSH_TRACE_DIR) || join(HOST_ROOT, 'trace')
export const HOST_PORTS = {
  analyze: Number(process.env.DSH_HOST_PORT_ANALYZE || 43191),
  edit: Number(process.env.DSH_HOST_PORT_EDIT || 43192),
}

/* --------------------------------------------------------------- 小工具 */

/** 展开 `~`（不解析相对于 cwd 的路径：配置里只接受绝对路径或 `~`）。 */
export function expandHome(value) {
  if (!value) return undefined
  const text = String(value)
  if (text === '~') return homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2))
  return text
}

export function nodeExecutableName(platform = process.platform) {
  return platform === 'win32' ? 'node.exe' : 'node'
}

function existingFile(candidate) {
  if (!candidate) return undefined
  try {
    return existsSync(candidate) && statSync(candidate).isFile() ? candidate : undefined
  } catch {
    return undefined
  }
}

function realOrSelf(candidate) {
  try {
    return realpathSync(candidate)
  } catch {
    return candidate
  }
}

function dedupe(values) {
  const seen = new Set()
  const out = []
  for (const value of values) {
    if (!value) continue
    const key = normalize(value)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

/**
 * 在 PATH（含 PATHEXT）里找一个可执行文件；只做文件存在性判断，不执行它。
 * English: search PATH (plus PATHEXT on Windows) by file existence only. Nothing is executed
 * here, so a discovery pass cannot trigger a real DSH or model run.
 */
export function findOnPath(names, env = process.env, platform = process.platform) {
  const list = Array.isArray(names) ? names : [names]
  const rawPath = env.PATH || env.Path || ''
  const dirs = String(rawPath)
    .split(delimiter)
    .map((dir) => (dir ? dir : '.'))
    .filter(Boolean)
  const extras = platform === 'win32' ? String(env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean) : ['']
  for (const dir of dirs) {
    for (const name of list) {
      for (const ext of extras) {
        const candidate = join(dir, ext && !name.toLowerCase().endsWith(ext.toLowerCase()) ? `${name}${ext}` : name)
        if (existingFile(candidate)) return candidate
      }
    }
  }
  return undefined
}

/* ------------------------------------------------------- DSH 入口发现 */

/** 从一个「可能是 DSH 安装目录」的位置推出候选 bin.js。 */
export function dshBinGuessesFromDir(dir) {
  const base = expandHome(dir)
  if (!base) return []
  return dedupe([
    join(base, 'lib', 'bin.js'),
    join(base, 'node_modules', DSH_PACKAGE_BIN),
    join(base, 'dsh', 'lib', 'bin.js'),
  ])
}

/** 从 PATH 上的 `dsh` 可执行文件（通常是符号链接）推出真正的 bin.js。 */
export function dshBinGuessesFromExecutable(executable) {
  if (!executable) return []
  const real = realOrSelf(executable)
  const guesses = []
  if (normalize(real).endsWith(normalize(join('lib', 'bin.js')))) guesses.push(real)
  const dir = dirname(real)
  guesses.push(join(dir, 'lib', 'bin.js'))
  guesses.push(join(dir, '..', 'lib', 'bin.js'))
  guesses.push(join(dir, '..', '..', 'lib', 'node_modules', DSH_PACKAGE_BIN))
  guesses.push(join(dir, '..', 'node_modules', DSH_PACKAGE_BIN))
  return dedupe(guesses)
}

/** Node 安装前缀（用于找全局 node_modules）：从 node 可执行文件位置反推。 */
export function nodeModulePrefixes({ env = process.env, execPath = process.execPath, platform = process.platform } = {}) {
  const prefixes = []
  const nodeBins = [execPath, findOnPath(['node', 'nodejs'], env, platform)].filter(Boolean)
  for (const nodeBin of nodeBins) {
    const dir = dirname(nodeBin)
    prefixes.push(dir)
    prefixes.push(dirname(dir))
  }
  prefixes.push(join(homedir(), '.local'), join(homedir(), '.npm-global'))
  prefixes.push('/usr/local', '/opt/homebrew', '/usr')
  if (env.APPDATA) prefixes.push(env.APPDATA)
  if (env.LOCALAPPDATA) prefixes.push(env.LOCALAPPDATA)
  if (env.NVM_BIN) prefixes.push(dirname(env.NVM_BIN))
  return dedupe(prefixes)
}

/** 隐式候选（按优先级）；显式 DSH_BIN 不在此列，由 discoverDshBin 直接返回。 */
export function implicitDshCandidates({ env = process.env, execPath = process.execPath, platform = process.platform } = {}) {
  const candidates = []
  if (env.DSH_CLI_ROOT) candidates.push(...dshBinGuessesFromDir(env.DSH_CLI_ROOT))

  const dshExe = findOnPath(platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh'] : ['dsh'], env, platform)
  if (dshExe) candidates.push(...dshBinGuessesFromExecutable(dshExe))

  for (const prefix of nodeModulePrefixes({ env, execPath, platform })) {
    candidates.push(join(prefix, 'lib', 'node_modules', DSH_PACKAGE_BIN))
    candidates.push(join(prefix, 'node_modules', DSH_PACKAGE_BIN))
    candidates.push(join(prefix, DSH_PACKAGE_BIN))
  }
  return dedupe(candidates)
}

/**
 * 找 DSH 入口（`.../@deepseek-ai/dsh/lib/bin.js`）。
 * 显式 DSH_BIN 永远优先——即使它指向不存在的文件，也原样返回，
 * 这样错误信息会指向用户真正配置的路径，而不是悄悄换成别的安装。
 */
export function discoverDshBin({ env = process.env, execPath = process.execPath, platform = process.platform } = {}) {
  const explicit = expandHome(env.DSH_BIN)
  if (explicit) return explicit
  for (const candidate of implicitDshCandidates({ env, execPath, platform })) {
    if (existingFile(candidate)) return candidate
  }
  return undefined
}

export const DSH_BIN = discoverDshBin() || ''

/** 找不到 DSH 时给用户的可操作提示（安装器与 server 共用，避免只报「路径为空」）。 */
export function dshDiscoveryHelp({ env = process.env } = {}) {
  const lines = ['找不到 DSH 入口（@deepseek-ai/dsh 的 lib/bin.js）。任选一种方式明确配置：']
  lines.push('  1) DSH_BIN=/绝对路径/@deepseek-ai/dsh/lib/bin.js')
  lines.push('  2) DSH_CLI_ROOT=/绝对路径/dsh-cli（内含 lib/bin.js 或 node_modules/@deepseek-ai/dsh）')
  lines.push('  3) npm i -g @deepseek-ai/dsh 后确保 dsh 在 PATH 上，或用 PATH 里的 node 全局目录（自动发现）')
  if (env.DSH_BIN) lines.push(`  当前 DSH_BIN=${env.DSH_BIN}（文件不存在）`)
  return lines.join('\n')
}

/* ------------------------------------------------------------ Node / 密钥 */

function looksLikeAppBundle(candidate) {
  return /\.app[\\/]/.test(candidate) || /app\.asar/.test(candidate)
}

/** 选一个「能直接 spawn」的 node，优先显式 DSH_NODE，其次当前进程，其次 PATH。 */
export function chooseNode(env = process.env, platform = process.platform) {
  const candidates = [
    expandHome(env.DSH_NODE),
    process.execPath,
    findOnPath(['node', 'nodejs'], env, platform),
    join(homedir(), '.local', 'node', 'bin', nodeExecutableName(platform)),
    '/usr/local/bin/node',
    '/opt/homebrew/bin/node',
  ].filter(Boolean)

  const usable = candidates.filter((candidate) => !looksLikeAppBundle(candidate))
  for (const candidate of usable) {
    if (existingFile(candidate)) return candidate
  }
  return process.execPath
}

function desktopCredentialCandidates(env = process.env) {
  const out = []
  const home = homedir()
  out.push(join(home, 'Library', 'Application Support', 'dsh-desktop', 'harness', '.credentials.yaml'))
  if (env.APPDATA) out.push(join(env.APPDATA, 'dsh-desktop', 'harness', '.credentials.yaml'))
  out.push(join(home, '.config', 'dsh-desktop', 'harness', '.credentials.yaml'))
  return out
}

/**
 * 读 DEEPSEEK_API_KEY：环境变量优先，其次本机凭据文件。绝不写回任何配置。
 * English: resolve the API key from the environment first, then from local credential files.
 * Read-only: it never writes a key back to any config, and an unreadable file is skipped.
 */
export function readApiKey(env = process.env) {
  if (env.DEEPSEEK_API_KEY) return env.DEEPSEEK_API_KEY
  const home = expandHome(env.DSH_BRIDGE_HOME) || DEFAULT_DSH_HOME
  const candidates = [
    join(home, '.credentials.yaml'),
    join(homedir(), '.dsh', '.credentials.yaml'),
    join(BRIDGE_STATE_DIR, '.credentials.yaml'),
    ...desktopCredentialCandidates(env),
  ]
  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue
      const match = readFileSync(file, 'utf8').match(/^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$/m)
      if (match && /^sk-/.test(match[1])) return match[1]
    } catch {
      /* 读不到就退回环境变量 */
    }
  }
  return undefined
}

export function isAbsolutePath(value) {
  return isAbsolute(String(value ?? ''))
}

export function log(...args) {
  process.stderr.write(`[dsh-bridge] ${args.join(' ')}\n`)
}
