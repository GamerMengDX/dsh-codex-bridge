import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  REPO_ROOT,
  cleanupTempDirs,
  makeFakeDsh,
  makeTempDir,
  runNode,
} from './helpers/fixtures.mjs'

const APPLY = join(REPO_ROOT, 'apply-config.mjs')
const SECRET = 'offline-fixture-value-never-write'

function makeConfig(extra = '') {
  const home = makeTempDir('codex mcp home')
  const configPath = join(home, 'config.toml')
  writeFileSync(configPath, `model = "gpt-6.1-sol"
model_provider = "openai-http"

[mcp_servers.other]
command = "/bin/true"

[mcp_servers.other.env]
FOO = "bar"

[mcp_servers.dsh_extra]
command = "/bin/false"

[plugins."computer-use@openai-bundled"]
enabled = true
${extra}`)
  return { home, configPath }
}

function fakeEnv(fake, overrides = {}) {
  const state = makeTempDir('bridge state')
  return {
    DSH_NODE: process.execPath,
    DSH_BIN: fake.bin,
    DSH_BRIDGE_HOME: join(state, 'dsh-home'),
    DSH_DEFAULT_CWD: join(state, 'proj'),
    DSH_HOST_ROOT: join(state, 'host'),
    DEEPSEEK_API_KEY: SECRET,
    ...overrides,
  }
}

function run(args, env) {
  const result = runNode(APPLY, args, { env })
  return { code: result.code, out: result.out, err: result.err }
}

const backupCount = (dir) => readdirSync(dir).filter((f) => f.includes('.bak-dshbridge-')).length

test.after(() => {
  for (const failure of cleanupTempDirs()) {
    console.warn(`清理临时目录失败：${failure.dir}（${failure.message}）`)
  }
})

test('未注册时 --check 退出码非零，且不改文件', () => {
  const fake = makeFakeDsh()
  const { configPath } = makeConfig()
  const before = readFileSync(configPath, 'utf8')
  const result = run(['--check', '--config', configPath], fakeEnv(fake))
  assert.equal(result.code, 1)
  assert.match(result.out, /未注册/)
  assert.equal(readFileSync(configPath, 'utf8'), before)
})

test('注册 MCP：写入路径与 env 覆盖，保留无关 MCP / 子表 / plugins', () => {
  const fake = makeFakeDsh()
  const { home, configPath } = makeConfig()
  const env = fakeEnv(fake)

  const result = run(['--config', configPath], env)
  assert.equal(result.code, 0, result.err)

  const config = readFileSync(configPath, 'utf8')
  assert.match(config, /\[mcp_servers\.dsh\]/)
  assert.ok(config.includes(`command = "${process.execPath}"`))
  assert.ok(config.includes(`args = ["${join(REPO_ROOT, 'server.mjs')}"]`))
  assert.ok(config.includes(`cwd = "${REPO_ROOT}"`), 'cwd 应指向桥接目录')

  // 非秘密的 DSH 路径覆盖必须持久化（GUI 启动的 Codex 不继承 shell 环境）
  assert.match(config, /\[mcp_servers\.dsh\.env\]/)
  assert.ok(config.includes(`DSH_BIN = "${fake.bin}"`))
  assert.ok(config.includes(`DSH_BRIDGE_HOME = "${env.DSH_BRIDGE_HOME}"`))
  assert.ok(config.includes(`DSH_DEFAULT_CWD = "${env.DSH_DEFAULT_CWD}"`))
  assert.ok(config.includes(`DSH_HOST_ROOT = "${env.DSH_HOST_ROOT}"`))

  // 秘密绝不落配置
  assert.ok(!config.includes(SECRET))
  assert.ok(!config.includes('DEEPSEEK_API_KEY'))

  // 无关配置原样保留
  assert.match(config, /\[mcp_servers\.other\]/)
  assert.match(config, /\[mcp_servers\.other\.env\]/)
  assert.match(config, /FOO = "bar"/)
  assert.match(config, /\[mcp_servers\.dsh_extra\]/)
  assert.match(config, /\[plugins\."computer-use@openai-bundled"\]/)
  assert.match(config, /^model = "gpt-6\.1-sol"$/m)

  // 安装记录同样不含秘密
  const manifest = readFileSync(join(home, '.dsh-codex-bridge-install.json'), 'utf8')
  assert.ok(!manifest.includes(SECRET))
  assert.ok(!/model = "gpt-6\.1-sol"/.test(manifest))
})

test('注册后 --check 通过；重复注册幂等且不产生新备份', () => {
  const fake = makeFakeDsh()
  const { home, configPath } = makeConfig()
  const env = fakeEnv(fake)

  assert.equal(run(['--config', configPath], env).code, 0)
  const check = run(['--check', '--config', configPath], env)
  assert.equal(check.code, 0, check.out + check.err)

  const backupsBefore = backupCount(home)
  const again = run(['--config', configPath], env)
  assert.equal(again.code, 0)
  assert.match(again.out, /无需改动/)
  assert.equal(backupCount(home), backupsBefore)

  const once = readFileSync(configPath, 'utf8')
  assert.equal(run(['--config', configPath], env).code, 0)
  assert.equal(readFileSync(configPath, 'utf8'), once)
})

test('路径过期：--check 非零，重新注册就地修复', () => {
  const fake = makeFakeDsh()
  const { configPath } = makeConfig()
  const env = fakeEnv(fake)
  assert.equal(run(['--config', configPath], env).code, 0)

  const stale = readFileSync(configPath, 'utf8').replace(`command = "${process.execPath}"`, 'command = "/usr/bin/env"')
  writeFileSync(configPath, stale)

  const check = run(['--check', '--config', configPath], env)
  assert.equal(check.code, 1)
  assert.match(check.out, /过期|未就绪/)
  assert.match(check.out, /command 不一致/)

  assert.equal(run(['--config', configPath], env).code, 0)
  assert.equal(run(['--check', '--config', configPath], env).code, 0)
  assert.ok(readFileSync(configPath, 'utf8').includes(`command = "${process.execPath}"`))
})

test('TOML 转义：路径含引号、反斜杠与空格也能生成合法配置', () => {
  const fake = makeFakeDsh()
  const { configPath } = makeConfig()
  const weird = '/tmp/a"b\\c 空格 中文'
  const env = fakeEnv(fake, { DSH_DEFAULT_CWD: weird })

  const result = run(['--config', configPath], env)
  assert.equal(result.code, 0, result.err)

  const config = readFileSync(configPath, 'utf8')
  const line = config.split('\n').find((item) => item.startsWith('DSH_DEFAULT_CWD = '))
  assert.ok(line, '应有 DSH_DEFAULT_CWD 行')
  assert.ok(line.includes('\\"'), '引号应转义')
  assert.ok(line.includes('\\\\'), '反斜杠应转义')
  // 写完之后自身仍然一致（同一渲染器比较，不会误报过期）
  assert.equal(run(['--check', '--config', configPath], env).code, 0)
})

test('找不到 DSH 时给出可操作诊断，且不写文件', () => {
  const fake = makeFakeDsh()
  const { configPath } = makeConfig()
  const before = readFileSync(configPath, 'utf8')
  const env = fakeEnv(fake, { DSH_BIN: '/definitely/missing/@deepseek-ai/dsh/lib/bin.js' })

  const check = run(['--check', '--config', configPath], env)
  assert.equal(check.code, 1)
  assert.match(check.err + check.out, /DSH/)
  assert.match(check.err + check.out, /DSH_BIN|DSH_CLI_ROOT/)

  const install = run(['--config', configPath], env)
  assert.equal(install.code, 1)
  assert.match(install.err, /DSH_BIN|DSH_CLI_ROOT/)
  assert.equal(readFileSync(configPath, 'utf8'), before)
  assert.equal(backupCount(dirname(configPath)), 0)
})

test('--dry-run 打印注册段但不落盘', () => {
  const fake = makeFakeDsh()
  const { home, configPath } = makeConfig()
  const before = readFileSync(configPath, 'utf8')

  const result = run(['--dry-run', '--config', configPath], fakeEnv(fake))
  assert.equal(result.code, 0, result.err)
  assert.match(result.out, /\[mcp_servers\.dsh\]/)
  assert.equal(readFileSync(configPath, 'utf8'), before)
  assert.equal(backupCount(home), 0)
})

test('卸载：移除注册段与 env 子表，保留其他配置，可重复执行', () => {
  const fake = makeFakeDsh()
  const { configPath } = makeConfig()
  const env = fakeEnv(fake)
  assert.equal(run(['--config', configPath], env).code, 0)

  const result = run(['--uninstall', '--config', configPath], env)
  assert.equal(result.code, 0, result.err)
  const config = readFileSync(configPath, 'utf8')
  assert.ok(!config.includes('[mcp_servers.dsh]'))
  assert.ok(!config.includes('[mcp_servers.dsh.env]'))
  assert.match(config, /\[mcp_servers\.other\]/)
  assert.match(config, /\[mcp_servers\.other\.env\]/)
  assert.match(config, /\[mcp_servers\.dsh_extra\]/)
  assert.match(config, /\[plugins\."computer-use@openai-bundled"\]/)
  assert.match(config, /enabled = true/)

  const again = run(['--uninstall', '--config', configPath], env)
  assert.equal(again.code, 0, again.err)
  assert.equal(readFileSync(configPath, 'utf8'), config)
})

test('卸载：恢复安装前用户自己的 [mcp_servers.dsh] 与子表', () => {
  const fake = makeFakeDsh()
  const { configPath } = makeConfig()
  const env = fakeEnv(fake)
  const userSection = `[mcp_servers.dsh]
command = "/opt/user/own-node"
args = ["/opt/user/own-server.mjs"]

[mcp_servers.dsh.env]
USER_OWN = "1"
`
  writeFileSync(configPath, `${readFileSync(configPath, 'utf8')}\n${userSection}`)
  assert.equal(run(['--config', configPath], env).code, 0)

  const result = run(['--uninstall', '--config', configPath], env)
  assert.equal(result.code, 0, result.err)
  const config = readFileSync(configPath, 'utf8')
  assert.match(config, /command = "\/opt\/user\/own-node"/)
  assert.match(config, /USER_OWN = "1"/)
  assert.ok(!config.includes(process.execPath))
})

test('卸载遇到用户修改过的注册段：保留并报告冲突（退出码非零）', () => {
  const fake = makeFakeDsh()
  const { configPath } = makeConfig()
  const env = fakeEnv(fake)
  assert.equal(run(['--config', configPath], env).code, 0)

  const edited = readFileSync(configPath, 'utf8').replace('startup_timeout_sec = 30', 'startup_timeout_sec = 45')
  writeFileSync(configPath, edited)

  const result = run(['--uninstall', '--config', configPath], env)
  assert.equal(result.code, 1)
  assert.match(result.err, /保留/)
  assert.ok(readFileSync(configPath, 'utf8').includes('startup_timeout_sec = 45'))
})

test('--no-computer-use 只在显式指定时关闭，卸载时恢复原状态', () => {
  const fake = makeFakeDsh()
  const { configPath } = makeConfig()
  const env = fakeEnv(fake)
  assert.equal(run(['--config', configPath], env).code, 0)
  assert.match(readFileSync(configPath, 'utf8'), /enabled = true/, '默认不动 computer-use')

  const applied = run(['--config', configPath, '--no-computer-use'], env)
  assert.equal(applied.code, 0, applied.err)
  assert.match(readFileSync(configPath, 'utf8'), /enabled = false/)

  const removed = run(['--uninstall', '--config', configPath], env)
  assert.equal(removed.code, 0, removed.err)
  assert.match(readFileSync(configPath, 'utf8'), /enabled = true/)
})

/* ------------------------- 字段级补丁：保留用户其他设置 ------------------------- */

const countOf = (text, needle) => text.split(needle).length - 1

test('合法 alternate 表：只补丁管理字段，保留 enabled=false / EXTRA_KEEP / 注释 / 用户键', () => {
  const fake = makeFakeDsh()
  const { home, configPath } = makeConfig()
  const env = fakeEnv(fake)
  const userSection = `[mcp_servers."dsh"] # user note
command = "/old/node" # keep tail comment
args = ["/old/server.mjs"]
cwd = "/old/root"
startup_timeout_sec = 99
enabled = false
custom_flag = "keep-me"

[mcp_servers."dsh".env]
EXTRA_KEEP = "preserve-extra"
DEEPSEEK_API_KEY = "${SECRET}"

[plugins."unified-computer-use@openai-bundled"]
enabled = false
`
  writeFileSync(configPath, `${readFileSync(configPath, 'utf8')}\n${userSection}`)
  const result = run(['--config', configPath], env)
  assert.equal(result.code, 0, result.err)

  const config = readFileSync(configPath, 'utf8')
  assert.ok(config.includes(`command = "${process.execPath}"`))
  assert.ok(config.includes('# keep tail comment'), '替换值应保留尾注释')
  assert.ok(config.includes(`args = ["${join(REPO_ROOT, 'server.mjs')}"]`))
  assert.ok(config.includes(`cwd = "${REPO_ROOT}"`))
  assert.match(config, /startup_timeout_sec = 30/)
  assert.ok(config.includes('enabled = false'), '不偷偷启用')
  assert.ok(config.includes('custom_flag = "keep-me"'), '未知键保留')
  assert.ok(config.includes('EXTRA_KEEP = "preserve-extra"'), '额外 env 保留')
  assert.ok(config.includes(SECRET), '用户自己的秘密留在自己的配置里')
  assert.ok(config.includes('# user note'), '表头尾注释保留')
  assert.equal(countOf(config, '[mcp_servers."dsh"]'), 1, '不追加重复主表')
  assert.equal(countOf(config, '[mcp_servers."dsh".env]'), 1, '不追加重复 env 子表')

  const manifest = readFileSync(join(home, '.dsh-codex-bridge-install.json'), 'utf8')
  assert.ok(!manifest.includes(SECRET), '安装记录不含用户 env 秘密')
  assert.ok(!manifest.includes('preserve-extra'), '安装记录不含用户额外 env 正文')

  // --check 按管理字段语义比较：额外键/env 不算过期，禁用状态单独提示
  const check = run(['--check', '--config', configPath], env)
  assert.equal(check.code, 0, check.out + check.err)
  assert.match(check.out, /已注册且最新/)
  assert.match(check.out, /enabled = false/)

  const backupsBefore = backupCount(home)
  const again = run(['--config', configPath], env)
  assert.equal(again.code, 0)
  assert.match(again.out, /无需改动/)
  assert.equal(backupCount(home), backupsBefore)
  assert.equal(readFileSync(configPath, 'utf8'), config)
})

test('分散的合法子表全部补丁，不只看第一段连续区域', () => {
  const fake = makeFakeDsh()
  const { configPath } = makeConfig()
  const env = fakeEnv(fake)
  writeFileSync(
    configPath,
    `[mcp_servers."dsh"]
command = "/old/node"
args = ["/old/server.mjs"]
cwd = "/old/root"
startup_timeout_sec = 5

[mcp_servers.other]
command = "/bin/true"

[mcp_servers."dsh".env]
EXTRA_KEEP = "1"
`,
  )

  const result = run(['--config', configPath], env)
  assert.equal(result.code, 0, result.err)
  const config = readFileSync(configPath, 'utf8')
  assert.ok(config.includes(`command = "${process.execPath}"`))
  assert.ok(config.includes('EXTRA_KEEP = "1"'))
  assert.ok(config.includes(`DSH_BIN = "${fake.bin}"`), '缺失 env 补进真实子表而不是新表')
  assert.equal(countOf(config, '[mcp_servers."dsh"]'), 1)
  assert.equal(countOf(config, '[mcp_servers."dsh".env]'), 1)
  assert.equal(run(['--check', '--config', configPath], env).code, 0)
})

test('无关表多行字符串里的伪表头不损坏，缺表时安全追加', () => {
  const fake = makeFakeDsh()
  const { configPath } = makeConfig()
  const env = fakeEnv(fake)
  const instructions = '示例：\n[mcp_servers.dsh]\ncommand = "EXAMPLE"\n'
  writeFileSync(
    configPath,
    `${readFileSync(configPath, 'utf8')}\n[agents.documentation]\ndeveloper_instructions = """\n${instructions}"""\n`,
  )

  assert.equal(run(['--check', '--config', configPath], env).code, 1)
  const result = run(['--config', configPath], env)
  assert.equal(result.code, 0, result.err)

  const config = readFileSync(configPath, 'utf8')
  assert.ok(config.includes(`developer_instructions = """\n${instructions}"""`), '多行字符串原样保留')
  assert.match(config, /\[mcp_servers\.dsh\]\ncommand = "/)
  assert.equal(run(['--check', '--config', configPath], env).code, 0)
})

test('inline env 无法可靠拆分：拒绝修改且不落盘、不备份', () => {
  const fake = makeFakeDsh()
  const { home, configPath } = makeConfig()
  const env = fakeEnv(fake)
  writeFileSync(configPath, `${readFileSync(configPath, 'utf8')}\n[mcp_servers.dsh]\ncommand = "/old"\nenv = { EXTRA_KEEP = "1" }\n`)
  const before = readFileSync(configPath, 'utf8')

  const result = run(['--config', configPath], env)
  assert.equal(result.code, 1)
  assert.match(result.err, /inline env/)
  assert.equal(readFileSync(configPath, 'utf8'), before)
  assert.equal(backupCount(home), 0)
})

test('扫描错误：提示 code/line、退出非零、写前失败、不泄露配置值', () => {
  const fake = makeFakeDsh()
  const { home, configPath } = makeConfig()
  const env = fakeEnv(fake)
  const broken = `model = "gpt-6.1-sol"\nsecret_probe = "${SECRET}"\n[mcp_servers.dsh]\nbroken = """\nunterminated\n`
  writeFileSync(configPath, broken)

  const result = run(['--config', configPath], env)
  assert.equal(result.code, 1)
  assert.match(result.err, /TOML_UNTERMINATED_STRING/)
  assert.match(result.err, /line=\d+/)
  assert.ok(!result.err.includes(SECRET), '错误信息不含配置值')
  assert.equal(readFileSync(configPath, 'utf8'), broken)
  assert.equal(backupCount(home), 0)

  const check = run(['--check', '--config', configPath], env)
  assert.equal(check.code, 1)
  assert.match(check.err, /TOML_UNTERMINATED_STRING/)
})

test('卸载恢复安装前的用户 MCP 与 env（含秘密），manifest 只存 hash+备份引用', () => {
  const fake = makeFakeDsh()
  const { home, configPath } = makeConfig()
  const env = fakeEnv(fake)
  const userSection = `[mcp_servers.dsh]
command = "/opt/user/own-node"
args = ["/opt/user/own-server.mjs"]

[mcp_servers.dsh.env]
USER_TOKEN = "${SECRET}"
`
  writeFileSync(configPath, `${readFileSync(configPath, 'utf8')}\n${userSection}`)
  assert.equal(run(['--config', configPath], env).code, 0)

  const manifestText = readFileSync(join(home, '.dsh-codex-bridge-install.json'), 'utf8')
  assert.ok(!manifestText.includes(SECRET), 'manifest 不含秘密正文')
  const record = JSON.parse(manifestText)
  assert.ok(record.mcp.installedHash, '记录合并后的归属 hash')
  assert.ok(record.mcp.backup, '秘密正文只留 0600 备份引用')

  const result = run(['--uninstall', '--config', configPath], env)
  assert.equal(result.code, 0, result.err)
  const config = readFileSync(configPath, 'utf8')
  assert.ok(config.includes('command = "/opt/user/own-node"'))
  assert.ok(config.includes(`USER_TOKEN = "${SECRET}"`))
  assert.ok(!config.includes(process.execPath))
})

test('--codex-home 等价于 --config <home>/config.toml', () => {
  const fake = makeFakeDsh()
  const { home, configPath } = makeConfig()
  const env = fakeEnv(fake)
  const result = run(['--codex-home', home], env)
  assert.equal(result.code, 0, result.err)
  assert.match(readFileSync(configPath, 'utf8'), /\[mcp_servers\.dsh\]/)
  assert.ok(existsSync(join(home, '.dsh-codex-bridge-install.json')))
})

test('未知参数返回 64 且打印用法', () => {
  const result = run(['--nope'], {})
  assert.equal(result.code, 64)
  assert.match(result.err, /用法/)
})
