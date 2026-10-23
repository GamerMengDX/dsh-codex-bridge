import assert from 'node:assert/strict'
import { existsSync, readFileSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import {
  REPO_ROOT,
  cleanupTempDirs,
  copyBridge,
  makeFakeCodexHome,
  makeFakeDsh,
  makeTempDir,
  runNode,
  runSh,
} from './helpers/fixtures.mjs'
import {
  chooseNode,
  discoverDshBin,
  dshDiscoveryHelp,
  findOnPath,
  implicitDshCandidates,
} from '../lib/config.mjs'

test.after(() => {
  for (const failure of cleanupTempDirs()) {
    console.warn(`清理临时目录失败：${failure.dir}（${failure.message}）`)
  }
})

/* -------------------------------------------- 入口可移植性（复制到新目录） */

test('dsh-run 在含空格与中文的新目录里执行「该副本」，不回落到原源码', () => {
  const copy = copyBridge('CLI 可移植 副本')
  const marker = `COPY-MARKER-${Date.now()}`
  const cliArgs = join(copy, 'lib', 'cli-args.mjs')
  writeFileSync(cliArgs, readFileSync(cliArgs, 'utf8').replace('用法: dsh-task', `用法: dsh-task ${marker}`))

  const viaRun = runSh(join(copy, 'dsh-run'), ['--help'], { cwd: '/' })
  assert.equal(viaRun.code, 0, viaRun.err)
  assert.ok(viaRun.out.includes(marker), 'dsh-run 必须执行副本里的 dsh-task.mjs')
  assert.ok(viaRun.out.includes('--goal'))

  const viaRelative = runSh('./dsh-run', ['--help'], { cwd: copy })
  assert.equal(viaRelative.code, 0, viaRelative.err)
  assert.ok(viaRelative.out.includes(marker))

  const viaDirect = runNode(join(copy, 'dsh-task.mjs'), ['--help'], { cwd: '/' })
  assert.equal(viaDirect.code, 0, viaDirect.err)
  assert.ok(viaDirect.out.includes(marker), 'node dsh-task.mjs 仍是跨环境入口')

  const original = runSh(join(REPO_ROOT, 'dsh-run'), ['--help'], { cwd: '/' })
  assert.ok(!original.out.includes(marker), '原仓库不应被副本的调用链使用')
})

test('dsh-run 找不到 node 时给出明确错误（退出码 127）', () => {
  const copy = copyBridge('no node')
  const result = runSh(join(copy, 'dsh-run'), ['--help'], { env: { PATH: '/definitely/missing' } })
  assert.equal(result.code, 127)
  assert.match(result.err, /node/)
})

/* ---------------------------------------------------- DSH / Node 发现逻辑 */

test('DSH 发现：显式 DSH_BIN 优先，即使文件不存在也指向用户配置的路径', () => {
  const explicit = '/definitely/missing/@deepseek-ai/dsh/lib/bin.js'
  assert.equal(discoverDshBin({ env: { DSH_BIN: explicit } }), explicit)
})

test('DSH 发现：DSH_CLI_ROOT 指向离线 fixture 时能找到 lib/bin.js', () => {
  const fake = makeFakeDsh()
  assert.equal(discoverDshBin({ env: { DSH_CLI_ROOT: fake.packageRoot } }), fake.bin)
})

test('DSH 发现：PATH 上的 dsh（符号链接）能解析到真正的 bin.js', { skip: process.platform === 'win32' }, () => {
  const fake = makeFakeDsh()
  assert.ok(fake.pathBin, '需要符号链接 fixture')
  const found = discoverDshBin({ env: { PATH: join(fake.root, 'bin') }, platform: 'linux' })
  assert.ok(found)
  assert.equal(realpathSync(found), realpathSync(fake.bin))
})

test('DSH 发现：fixture 之外不会凭空造出路径，缺失时给出可操作提示', () => {
  const fake = makeFakeDsh()
  const candidates = implicitDshCandidates({
    env: { PATH: join(fake.root, 'bin'), DSH_CLI_ROOT: join(fake.root, 'empty') },
    platform: 'linux',
  })
  assert.ok(candidates.length > 0)
  assert.ok(!candidates.includes('/definitely/missing'))
  for (const hint of ['DSH_BIN', 'DSH_CLI_ROOT', 'PATH']) {
    assert.ok(dshDiscoveryHelp({ env: { DSH_BIN: '/definitely/missing' } }).includes(hint), hint)
  }
})

test('findOnPath 只在 PATH 里找，不存在时返回 undefined', () => {
  const fake = makeFakeDsh()
  assert.equal(findOnPath(['dsh'], { PATH: join(fake.root, 'bin') }), join(fake.root, 'bin', 'dsh'))
  assert.equal(findOnPath(['dsh'], { PATH: '/definitely/missing' }), undefined)
})

test('chooseNode：显式 DSH_NODE 优先，缺失时回落到当前进程的 node', () => {
  assert.equal(chooseNode({ DSH_NODE: process.execPath }), process.execPath)
  const fallback = chooseNode({ DSH_NODE: '/definitely/missing/node', PATH: '/definitely/missing' })
  assert.ok(existsSync(fallback))
  assert.ok(!fallback.includes('\0'))
})

test('DSH 缺失时 CLI 给出可操作的错误（不执行任何真实模型）', () => {
  // 用临时 HOME，确保连真实凭据文件都不会被碰到
  const fakeHome = makeTempDir('fake home')
  const result = runNode(join(REPO_ROOT, 'dsh-task.mjs'), ['-g', '只回复 OK'], {
    env: {
      HOME: fakeHome,
      DSH_BRIDGE_HOME: join(fakeHome, 'dsh-home'),
      DSH_HOST_ROOT: join(fakeHome, 'host'),
      DSH_TRACE_DIR: join(fakeHome, 'trace'),
      DSH_BIN: '/definitely/missing/@deepseek-ai/dsh/lib/bin.js',
    },
  })
  assert.equal(result.code, 1)
  assert.match(result.err, /找不到 DSH 入口/)
  assert.match(result.err, /DSH_BIN/)
})

/* ------------------------------------------------------ MCP 配置随目录迁移 */

function writeMcpConfig() {
  const home = makeFakeCodexHome()
  return { home, configPath: join(home, 'config.toml') }
}

test('MCP 配置引用当前源码位置与实际 node；迁移后重装随之更新', () => {
  const fake = makeFakeDsh()
  const { home, configPath } = writeMcpConfig()
  const state = makeTempDir('mcp state')
  const env = {
    DSH_NODE: process.execPath,
    DSH_BIN: fake.bin,
    DSH_BRIDGE_HOME: join(state, 'dsh-home'),
    DSH_DEFAULT_CWD: join(state, 'proj'),
    DSH_HOST_ROOT: join(state, 'host'),
  }

  const copy = copyBridge('MCP 迁移')
  const migrated = runNode(join(copy, 'apply-config.mjs'), ['--config', configPath], { env })
  assert.equal(migrated.code, 0, migrated.err)
  const config = readFileSync(configPath, 'utf8')
  assert.ok(config.includes(`args = ["${join(copy, 'server.mjs')}"]`), '应指向当前源码位置')
  assert.ok(config.includes(`cwd = "${copy}"`))
  assert.ok(!config.includes(join(REPO_ROOT, 'server.mjs')), '不应残留旧目录')

  const check = runNode(join(copy, 'apply-config.mjs'), ['--check', '--config', configPath], { env })
  assert.equal(check.code, 0, check.err)

  // 回到原目录重新注册（等价于迁移回旧目录），路径同样跟着走
  const restored = runNode(join(REPO_ROOT, 'apply-config.mjs'), ['--config', configPath], { env })
  assert.equal(restored.code, 0, restored.err)
  const back = readFileSync(configPath, 'utf8')
  assert.ok(back.includes(`args = ["${join(REPO_ROOT, 'server.mjs')}"]`))
  assert.equal(
    runNode(join(REPO_ROOT, 'apply-config.mjs'), ['--check', '--config', configPath], { env }).code,
    0,
  )
  assert.ok(existsSync(join(home, 'config.toml')))
})

/* ------------------------------------------------------------ 源码/文档体检 */

const READ = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8')

test('发行源码与文档不含开发者专属绝对路径', () => {
  const files = [
    'README.md',
    'docs/USAGE.md',
    'docs/ROLES.md',
    'PACKAGE-NOTES.md',
    'config-snippet.toml',
    'dsh-run',
    'dsh-task.mjs',
    'install-codex.mjs',
    'apply-config.mjs',
    'lib/config.mjs',
    'skill/SKILL.md',
    'codex/skills/multi-agent-development/SKILL.md',
    'codex/AGENTS.md.part',
  ]
  for (const file of files) {
    const text = READ(file)
    assert.ok(!/\/Users\/gamerm|Documents\/DSH\//.test(text), `${file} 仍含开发者绝对路径`)
  }
})

test('配置模板用占位符，且提示不要写入 API key', () => {
  const snippet = READ('config-snippet.toml')
  assert.match(snippet, /\{\{NODE\}\}/)
  assert.match(snippet, /\{\{DSH_BIN\}\}/)
  assert.match(snippet, /\[mcp_servers\.dsh\.env\]/)
  assert.match(snippet, /绝不在此写 API key/)
})

test('源 Skill 用占位符，安装器负责替换为本机路径', () => {
  const bridge = READ('skill/SKILL.md')
  assert.match(bridge, /\{\{DSH_RUN_CMD\}\}/)
  const workflow = READ('codex/skills/multi-agent-development/SKILL.md')
  assert.match(workflow, /\{\{TASK_DOC_CMD\}\}/)
  assert.match(workflow, /\{\{DSH_RUN_CMD\}\}/)
})

test('文档给出最小安装、升级、卸载与检查步骤，并保留开发署名', () => {
  const readme = READ('README.md')
  for (const phrase of ['install-codex.mjs --uninstall', 'apply-config.mjs --uninstall', '--check']) {
    assert.ok(readme.includes(phrase), `README 缺少 ${phrase}`)
  }
  assert.match(readme, /DeepSeek V4\.1 Flash/)
  assert.match(readme, /GPT 6\.1 sol/)

  const usage = READ('docs/USAGE.md')
  assert.ok(usage.includes('--uninstall'))
  assert.ok(!/node dsh-run/.test(usage), '`node dsh-run` 是错的写法')
})
