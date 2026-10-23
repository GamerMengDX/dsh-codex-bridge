import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { VERSION, readVersion, renderAgentToml } from '../install-codex.mjs'
import {
  REPO_ROOT,
  cleanupTempDirs,
  copyBridge,
  makeFakeCodexHome,
  makeTempDir,
  runNode,
} from './helpers/fixtures.mjs'

const INSTALLER = join(REPO_ROOT, 'install-codex.mjs')

const makeCodexHome = () => makeFakeCodexHome()

function run(args, env = {}) {
  const result = runNode(INSTALLER, args, { env })
  return { code: result.code, out: result.out, err: result.err }
}

const backups = (dir) => readdirSync(dir).filter((f) => f.includes('.bak-dshbridge-'))

test.after(() => {
  for (const failure of cleanupTempDirs()) {
    console.warn(`清理临时目录失败：${failure.dir}（${failure.message}）`)
  }
})

test('版本号只有一个来源：package.json', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
  assert.equal(VERSION, pkg.version)
  assert.equal(readVersion(), pkg.version)
  assert.match(VERSION, /^\d+\.\d+\.\d+$/)
})

test('首次安装：写入角色、技能、规则块，且不动模型与既有配置', () => {
  const home = makeCodexHome()
  const before = readFileSync(join(home, 'config.toml'), 'utf8')
  const { code, out } = run(['--codex-home', home, '--no-doctor'])
  assert.equal(code, 0, out)

  const config = readFileSync(join(home, 'config.toml'), 'utf8')
  assert.match(config, /^model = "gpt-6\.1-sol"$/m)
  assert.match(config, /^model_provider = "openai-http"$/m)
  assert.match(config, /\[mcp_servers\.dsh\]/)
  assert.match(config, /\[agents\."existing_role"\]/)
  assert.equal((config.match(/\[agents\."architecture_designer"\]/g) ?? []).length, 1)
  assert.notEqual(config, before)

  assert.ok(existsSync(join(home, 'agents', 'architecture_designer.toml')))
  const agent = readFileSync(join(home, 'agents', 'architecture_designer.toml'), 'utf8')
  assert.match(agent, /^model = "gpt-6-astra"$/m)
  assert.match(agent, /^model_reasoning_effort = "high"$/m)
  assert.match(agent, /nickname_candidates = \["Designer"/)
  assert.match(agent, /developer_instructions/)

  assert.ok(existsSync(join(home, 'skills', 'multi-agent-development', 'SKILL.md')))
  assert.ok(existsSync(join(home, 'skills', 'dsh-bridge', 'SKILL.md')))

  const agentsMd = readFileSync(join(home, 'AGENTS.md'), 'utf8')
  assert.match(agentsMd, /dsh-multi-agent:begin/)
  assert.match(agentsMd, /角色固定、模型可替换/)
  assert.ok(!/gpt-6-astra|gpt-6\.1-sol/.test(agentsMd), 'AGENTS.md 不应写死模型名')

  assert.equal(readFileSync(join(home, 'auth.json'), 'utf8'), '{"token":"secret-should-not-change"}')
})

test('已安装的技能与规则块指向本机真实桥接路径，不残留占位符', () => {
  const home = makeCodexHome()
  assert.equal(run(['--codex-home', home, '--no-doctor']).code, 0)

  const bridgeSkill = readFileSync(join(home, 'skills', 'dsh-bridge', 'SKILL.md'), 'utf8')
  assert.ok(bridgeSkill.includes(join(REPO_ROOT, 'dsh-run')), '技能里应是本机桥接入口')
  assert.ok(!bridgeSkill.includes('{{'), '安装后的技能不应残留占位符')

  const workflowSkill = readFileSync(join(home, 'skills', 'multi-agent-development', 'SKILL.md'), 'utf8')
  assert.ok(workflowSkill.includes(join(REPO_ROOT, 'scripts', 'task-doc.mjs')), '任务单工具应指向桥接目录')
  assert.ok(!workflowSkill.includes('{{'), '安装后的技能不应残留占位符')

  const agentsMd = readFileSync(join(home, 'AGENTS.md'), 'utf8')
  assert.ok(agentsMd.includes(join(REPO_ROOT, 'dsh-run')))
})

test('重复安装幂等：--check 通过，且不产生新备份', () => {
  const home = makeCodexHome()
  assert.equal(run(['--codex-home', home, '--no-doctor']).code, 0)
  const backupsBefore = backups(home).length

  const check = run(['--codex-home', home, '--check', '--no-doctor'])
  assert.equal(check.code, 0, check.err)

  const again = run(['--codex-home', home, '--no-doctor'])
  assert.equal(again.code, 0)
  assert.match(again.err, /已是最新/)
  assert.equal(backups(home).length, backupsBefore)
})

test('未安装时 --check 返回非零（不会把「没装」当成就绪）', () => {
  const home = makeCodexHome()
  const check = run(['--codex-home', home, '--check', '--no-doctor'])
  assert.equal(check.code, 1)
  assert.match(check.err, /需要更新/)
})

test('模型升级：只替换映射值，模板其余部分不变', () => {
  const before = renderAgentToml({ model: 'gpt-6-astra', reasoning_effort: 'high' })
  const after = renderAgentToml({ model: 'gpt-7-next', reasoning_effort: 'medium' })
  assert.match(before, /^model = "gpt-6-astra"$/m)
  assert.match(after, /^model = "gpt-7-next"$/m)
  assert.equal(
    before.replace('gpt-6-astra', 'gpt-7-next').replace('"high"', '"medium"'),
    after,
  )
})

test('内容漂移：--check 返回失败并指出文件', () => {
  const home = makeCodexHome()
  assert.equal(run(['--codex-home', home, '--no-doctor']).code, 0)
  writeFileSync(join(home, 'agents', 'architecture_designer.toml'), 'model = "tampered"\n')
  const check = run(['--codex-home', home, '--check', '--no-doctor'])
  assert.equal(check.code, 1)
  assert.match(check.err, /architecture_designer\.toml/)
})

test('重新安装会先备份被覆盖的文件', () => {
  const home = makeCodexHome()
  assert.equal(run(['--codex-home', home, '--no-doctor']).code, 0)
  writeFileSync(join(home, 'agents', 'architecture_designer.toml'), 'model = "tampered"\n')
  assert.equal(run(['--codex-home', home, '--no-doctor']).code, 0)
  assert.equal(backups(join(home, 'agents')).length, 1)
})

test('--dry-run 不写任何文件', () => {
  const home = makeCodexHome()
  const before = readFileSync(join(home, 'config.toml'), 'utf8')
  const result = run(['--codex-home', home, '--dry-run', '--no-doctor'])
  assert.equal(result.code, 0)
  assert.equal(readFileSync(join(home, 'config.toml'), 'utf8'), before)
  assert.ok(!existsSync(join(home, 'agents', 'architecture_designer.toml')))
  assert.ok(!existsSync(join(home, 'AGENTS.md')))
  assert.ok(!existsSync(join(home, '.dsh-codex-bridge-install.json')))
})

test('缺失 config.toml 时给出明确错误', () => {
  const home = makeTempDir('codex empty')
  const result = run(['--codex-home', home, '--no-doctor'])
  assert.equal(result.code, 1)
  assert.match(result.out + result.err, /config\.toml/)
})

test('任务单 CLI：new → check → set-state，非法跳转失败', () => {
  const dir = makeTempDir('taskdoc')
  const script = join(REPO_ROOT, 'scripts', 'task-doc.mjs')
  const created = runNode(script, ['new', '--id', 'T-100', '--class', 'C', '--goal', '实现导出'], { cwd: dir })
  assert.equal(created.code, 0, created.err)
  const file = resolve(dir, 'docs/architecture/TASKS/T-100.md')
  assert.ok(existsSync(file))

  const ok = runNode(script, ['check', '--file', file], { cwd: dir })
  assert.equal(ok.code, 0, ok.err)

  const bad = runNode(script, ['set-state', '--file', file, '--state', 'delivered'], { cwd: dir })
  assert.equal(bad.code, 1)
  assert.match(bad.err, /非法状态转换/)

  const good = runNode(script, ['set-state', '--file', file, '--state', 'designing'], { cwd: dir })
  assert.equal(good.code, 0, good.err)
  assert.match(readFileSync(file, 'utf8'), /^status: designing$/m)
})

test('配置段后面还有别的表时，重复执行仍然幂等', () => {
  const home = makeCodexHome()
  assert.equal(run(['--codex-home', home, '--no-doctor']).code, 0)
  const config = `${readFileSync(join(home, 'config.toml'), 'utf8')}\n[mcp_servers.dsh]\ncommand = "/usr/local/bin/node"\n`
  writeFileSync(join(home, 'config.toml'), config)

  assert.equal(run(['--codex-home', home, '--no-doctor']).code, 0)
  const once = readFileSync(join(home, 'config.toml'), 'utf8')
  assert.equal(run(['--codex-home', home, '--no-doctor']).code, 0)
  assert.equal(readFileSync(join(home, 'config.toml'), 'utf8'), once)
  assert.equal(run(['--codex-home', home, '--check', '--no-doctor']).code, 0)
})

/* ------------------------------------------------ 跨版本规则块与迁移升级 */

test('从 v2.2.0 / v2.2.2 规则块升级：只剩一块，用户文字前后保留', () => {
  const home = makeCodexHome()
  writeFileSync(join(home, 'AGENTS.md'), `# 用户的全局规则

用户开头文字

<!-- dsh-multi-agent:begin v2.2.0 -->

v2.2.0 旧规则

<!-- dsh-multi-agent:end -->

中间用户文字

<!-- dsh-multi-agent:begin v2.2.2 -->

v2.2.2 旧规则

<!-- dsh-multi-agent:end -->

用户结尾文字
`)
  const result = run(['--codex-home', home, '--no-doctor'])
  assert.equal(result.code, 0, result.err)
  const agentsMd = readFileSync(join(home, 'AGENTS.md'), 'utf8')

  assert.equal((agentsMd.match(/dsh-multi-agent:begin/g) ?? []).length, 1)
  assert.equal((agentsMd.match(/dsh-multi-agent:end/g) ?? []).length, 1)
  assert.ok(!agentsMd.includes('v2.2.0'), '旧版本标记应已移除')
  assert.ok(!agentsMd.includes('v2.2.2 旧规则'))
  for (const text of ['用户开头文字', '中间用户文字', '用户结尾文字']) {
    assert.ok(agentsMd.includes(text), `${text} 应保留`)
  }

  const once = readFileSync(join(home, 'AGENTS.md'), 'utf8')
  assert.equal(run(['--codex-home', home, '--no-doctor']).code, 0)
  assert.equal(readFileSync(join(home, 'AGENTS.md'), 'utf8'), once)
})

test('完整的历史规则块在升级时被替换且不会追加重复规则', () => {
  const home = makeCodexHome()
  writeFileSync(join(home, 'AGENTS.md'), `用户开头

<!-- dsh-multi-agent:begin v2.2.0 -->

未闭合的旧块，后面没有配对标记

尾部文字

<!-- dsh-multi-agent:end -->
`)
  const result = run(['--codex-home', home, '--no-doctor'])
  assert.equal(result.code, 0, result.err)
  const agentsMd = readFileSync(join(home, 'AGENTS.md'), 'utf8')
  assert.equal((agentsMd.match(/dsh-multi-agent:begin/g) ?? []).length, 1)
  assert.equal((agentsMd.match(/dsh-multi-agent:end/g) ?? []).length, 1)
  assert.ok(!agentsMd.includes('未闭合的旧块'))
})

test('桥接目录迁移后重新安装：技能与规则块路径跟着新目录更新', () => {
  const home = makeFakeCodexHome()
  assert.equal(run(['--codex-home', home, '--no-doctor']).code, 0)
  const installedSkill = readFileSync(join(home, 'skills', 'dsh-bridge', 'SKILL.md'), 'utf8')
  assert.ok(installedSkill.includes(join(REPO_ROOT, 'dsh-run')))

  const copy = copyBridge('迁移 含空格')
  const moved = runNode(join(copy, 'install-codex.mjs'), ['--codex-home', home, '--no-doctor'])
  assert.equal(moved.code, 0, moved.err)

  const skill = readFileSync(join(home, 'skills', 'dsh-bridge', 'SKILL.md'), 'utf8')
  assert.ok(skill.includes(join(copy, 'dsh-run')), '技能应指向新目录')
  assert.ok(!skill.includes(join(REPO_ROOT, 'dsh-run')), '不应残留旧目录路径')

  const agentsMd = readFileSync(join(home, 'AGENTS.md'), 'utf8')
  assert.ok(agentsMd.includes(join(copy, 'dsh-run')))
  assert.ok(!agentsMd.includes(join(REPO_ROOT, 'dsh-run')))

  const check = runNode(join(copy, 'install-codex.mjs'), ['--codex-home', home, '--check', '--no-doctor'])
  assert.equal(check.code, 0, check.err)
})

test('安装记录不含秘密，也不含整份全局配置', () => {
  const home = makeCodexHome()
  assert.equal(run(['--codex-home', home, '--no-doctor']).code, 0)
  const manifest = readFileSync(join(home, '.dsh-codex-bridge-install.json'), 'utf8')
  assert.ok(!manifest.includes('secret-should-not-change'))
  assert.ok(!manifest.includes('"token"'))
  assert.ok(!/model = "gpt-6\.1-sol"/.test(manifest), '不应保存整份 config.toml 正文')
  assert.match(manifest, /"plugin": "dsh-codex-bridge"/)
})

/* -------------------------------------------------------------- 安全卸载 */

test('卸载：移除本插件内容，保留用户配置与认证文件', () => {
  const home = makeCodexHome()
  assert.equal(run(['--codex-home', home, '--no-doctor']).code, 0)

  const result = run(['--codex-home', home, '--uninstall'])
  assert.equal(result.code, 0, result.err)

  assert.ok(!existsSync(join(home, 'agents', 'architecture_designer.toml')))
  assert.ok(!existsSync(join(home, 'skills', 'dsh-bridge', 'SKILL.md')))
  assert.ok(!existsSync(join(home, 'skills', 'multi-agent-development', 'SKILL.md')))
  assert.ok(!existsSync(join(home, '.dsh-codex-bridge-install.json')))

  const config = readFileSync(join(home, 'config.toml'), 'utf8')
  assert.ok(!config.includes('architecture_designer'))
  assert.match(config, /^model = "gpt-6\.1-sol"$/m)
  assert.match(config, /^model_provider = "openai-http"$/m)
  assert.match(config, /\[mcp_servers\.dsh\]/)
  assert.match(config, /\[agents\."existing_role"\]/)
  assert.equal(readFileSync(join(home, 'auth.json'), 'utf8'), '{"token":"secret-should-not-change"}')

  const again = run(['--codex-home', home, '--uninstall'])
  assert.equal(again.code, 0, again.err)
  assert.equal(readFileSync(join(home, 'config.toml'), 'utf8'), config)
})

test('卸载：恢复安装前就存在的同名技能文件', () => {
  const home = makeCodexHome()
  const skillDir = join(home, 'skills', 'dsh-bridge')
  mkdirSync(skillDir, { recursive: true })
  const skillFile = join(skillDir, 'SKILL.md')
  writeFileSync(skillFile, '用户自己的 dsh-bridge 技能\n')

  assert.equal(run(['--codex-home', home, '--no-doctor']).code, 0)
  assert.match(readFileSync(skillFile, 'utf8'), /dsh-multi-agent|DSH is reachable/)

  const result = run(['--codex-home', home, '--uninstall'])
  assert.equal(result.code, 0, result.err)
  assert.equal(readFileSync(skillFile, 'utf8'), '用户自己的 dsh-bridge 技能\n')
})

test('卸载：恢复安装前就存在的同名角色段', () => {
  const home = makeCodexHome()
  const configPath = join(home, 'config.toml')
  const original = `${readFileSync(configPath, 'utf8')}
[agents."architecture_designer"]
description = "用户自己的旧设计角色"
config_file = "/old/designer.toml"
`
  writeFileSync(configPath, original)
  assert.equal(run(['--codex-home', home, '--no-doctor']).code, 0)
  assert.ok(!readFileSync(configPath, 'utf8').includes('用户自己的旧设计角色'))

  const result = run(['--codex-home', home, '--uninstall'])
  assert.equal(result.code, 0, result.err)
  const config = readFileSync(configPath, 'utf8')
  assert.match(config, /用户自己的旧设计角色/)
  assert.ok(!config.includes('系统设计角色'))
})

test('卸载遇到用户后改内容：保留并报告冲突（退出码非零）', () => {
  const home = makeCodexHome()
  assert.equal(run(['--codex-home', home, '--no-doctor']).code, 0)
  const skillFile = join(home, 'skills', 'dsh-bridge', 'SKILL.md')
  writeFileSync(skillFile, `${readFileSync(skillFile, 'utf8')}\n用户追加的说明\n`)

  const result = run(['--codex-home', home, '--uninstall'])
  assert.equal(result.code, 1)
  assert.match(result.err, /冲突/)
  assert.ok(existsSync(skillFile))
  assert.match(readFileSync(skillFile, 'utf8'), /用户追加的说明/)
})

test('卸载不改动无关文件（其他 skill / 其他 agent / 认证）', () => {
  const home = makeCodexHome()
  mkdirSync(join(home, 'skills', 'user-own-skill'), { recursive: true })
  writeFileSync(join(home, 'skills', 'user-own-skill', 'SKILL.md'), '用户自己的技能\n')
  const userAgents = `# 用户规则\n\n用户自己的文字\n`
  writeFileSync(join(home, 'AGENTS.md'), userAgents)

  assert.equal(run(['--codex-home', home, '--no-doctor']).code, 0)
  const result = run(['--codex-home', home, '--uninstall'])
  assert.equal(result.code, 0, result.err)

  assert.equal(readFileSync(join(home, 'skills', 'user-own-skill', 'SKILL.md'), 'utf8'), '用户自己的技能\n')
  assert.equal(readFileSync(join(home, 'AGENTS.md'), 'utf8'), userAgents)
  assert.equal(readFileSync(join(home, 'auth.json'), 'utf8'), '{"token":"secret-should-not-change"}')
})
