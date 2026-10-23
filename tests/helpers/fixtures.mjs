/**
 * fixtures.mjs — 安装/可移植性测试共用的小工具（不是测试文件本身，不会被 `node --test` 直接执行，
 * 因为 package.json 里显式列出了要跑的测试文件）。
 *
 * 约定：临时文件一律放在系统临时目录下、唯一命名、用完清理；清理失败如实输出警告。
 */

import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

const created = new Set()

export function trackTemp(dir) {
  created.add(dir)
  return dir
}

/** 清理本进程创建的所有临时目录；返回清理失败列表（调用方负责报告）。 */
export function cleanupTempDirs() {
  const failures = []
  for (const dir of created) {
    try {
      rmSync(dir, { recursive: true, force: true })
      created.delete(dir)
    } catch (error) {
      failures.push({ dir, message: error.message })
    }
  }
  return failures
}

/** 在系统临时目录里建一个带空格与中文的目录（验证路径可移植性）。 */
export function makeTempDir(label = 'dsh bridge 测试') {
  // macOS 上 /var 是 /private/var 的符号链接；统一用 realpath，断言才不会因为前缀不同而误判。
  return trackTemp(realpathSync(mkdtempSync(join(tmpdir(), `${label}-`))))
}

/**
 * 复制一份完整的桥接源码到新的临时目录（路径含空格与中文），模拟「换机器/换目录」。
 * 用于验证入口按自身位置定位、安装器按新目录渲染路径。
 */
export function copyBridge(label = '副本 含空格') {
  const target = makeTempDir(`dsh-codex-bridge ${label}`)
  const dir = join(target, 'bridge 副本')
  mkdirSync(dir, { recursive: true })
  cpSync(REPO_ROOT, dir, {
    recursive: true,
    filter: (source) => {
      const name = source.split('/').pop()
      return !['.git', 'node_modules', '.dsh-host', '.DS_Store'].includes(name)
    },
  })
  try {
    chmodSync(join(dir, 'dsh-run'), 0o755)
  } catch {
    /* 有些文件系统不支持改权限，dsh-run 仍然可以用 sh 调用 */
  }
  return realpathSync(dir)
}

/** 造一个假的 Codex home：config.toml 里有用户自己的模型、MCP 与其他角色。 */
export function makeFakeCodexHome({ auth = true } = {}) {
  const home = makeTempDir('codex home 假')
  writeFileSync(join(home, 'config.toml'), `model = "gpt-6.1-sol"
model_provider = "openai-http"

[model_providers.openai-http]
name = "OpenAI"

[mcp_servers.dsh]
command = "/usr/local/bin/node"
args = ["/x/server.mjs"]

[mcp_servers.other]
command = "/bin/true"

[mcp_servers.other.env]
FOO = "bar"

[agents."existing_role"]
description = "keep me"
config_file = "/x/existing.toml"
`)
  if (auth) writeFileSync(join(home, 'auth.json'), '{"token":"secret-should-not-change"}')
  return home
}

/** 造一个离线 DSH fixture：<tmp>/lib/node_modules/@deepseek-ai/dsh/lib/bin.js + bin/dsh 符号链接。 */
export function makeFakeDsh({ withPathLink = true } = {}) {
  const root = makeTempDir('dsh fixture')
  const pkgDir = join(root, 'lib', 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(join(pkgDir, 'lib'), { recursive: true })
  const bin = join(pkgDir, 'lib', 'bin.js')
  writeFileSync(bin, '// 离线 fixture：不执行任何真实 DSH 逻辑\nprocess.exit(0)\n')

  let pathBin
  if (withPathLink) {
    const binDir = join(root, 'bin')
    mkdirSync(binDir, { recursive: true })
    pathBin = join(binDir, 'dsh')
    try {
      symlinkSync(bin, pathBin)
    } catch {
      writeFileSync(pathBin, '#!/bin/sh\nexit 0\n')
      chmodSync(pathBin, 0o755)
      pathBin = undefined
    }
  }
  return { root, bin, pathBin, packageRoot: pkgDir }
}

/** 以「干净环境」跑一个 node 脚本：只给显式传入的变量，避免继承开发者机器的 DSH_* 配置。 */
export function runNode(script, args = [], { cwd = REPO_ROOT, env = {}, timeout = 60_000 } = {}) {
  const baseEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    DEEPSEEK_API_KEY: 'offline-test-placeholder-not-a-real-key',
  }
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    timeout,
    env: { ...baseEnv, ...env },
  })
  return { code: result.status, out: result.stdout ?? '', err: result.stderr ?? '', raw: result }
}

/** 跑 POSIX shell 脚本（用于验证 dsh-run）。 */
export function runSh(script, args = [], { cwd = REPO_ROOT, env = {} } = {}) {
  const result = spawnSync('/bin/sh', [script, ...args], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, DEEPSEEK_API_KEY: 'offline-test-placeholder-not-a-real-key', ...env },
  })
  return { code: result.status, out: result.stdout ?? '', err: result.stderr ?? '' }
}

export function read(file) {
  return readFileSync(file, 'utf8')
}

export { existsSync }
