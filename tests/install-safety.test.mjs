import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createBackup, fileRecord, releaseFile } from '../lib/install-manifest.mjs'
import { REPO_ROOT, cleanupTempDirs, makeFakeCodexHome, makeFakeDsh, makeTempDir, runNode } from './helpers/fixtures.mjs'

const run = (home, ...args) => runNode(join(REPO_ROOT, 'install-codex.mjs'), ['--codex-home', home, '--no-doctor', ...args])
test.after(() => { for (const f of cleanupTempDirs()) console.warn(`临时目录清理失败：${f.message}`) })

test('备份以0600创建，短时间重复备份不会覆盖前一份', () => {
  const dir = makeTempDir('backup safety'), file = join(dir, 'config.toml')
  writeFileSync(file, 'first', { mode: 0o644 })
  const a = createBackup(file)
  writeFileSync(file, 'second')
  const b = createBackup(file)
  assert.notEqual(a, b)
  assert.equal(readFileSync(a, 'utf8'), 'first')
  assert.equal(readFileSync(b, 'utf8'), 'second')
  assert.equal(statSync(a).mode & 0o777, 0o600)
  assert.equal(statSync(b).mode & 0o777, 0o600)
})

for (const state of ['missing', 'tampered']) test(`卸载恢复遇到${state}备份时保留当前文件`, () => {
  const dir = makeTempDir('restore safety'), file = join(dir, 'skill.md')
  writeFileSync(file, 'original user content')
  const backup = createBackup(file)
  const record = fileRecord(file, 'installed', { existingText: 'original user content', backup })
  writeFileSync(file, 'installed')
  if (state === 'missing') rmSync(backup)
  else writeFileSync(backup, 'unexpected replacement')
  assert.equal(releaseFile(file, record).action, 'conflict')
  assert.equal(readFileSync(file, 'utf8'), 'installed')
})

test('不成对规则标记使安装安全失败，用户文字与其他配置保持不变', () => {
  const home = makeFakeCodexHome(), file = join(home, 'AGENTS.md')
  const text = '用户前言\n<!-- dsh-multi-agent:begin v2.2.2 -->\n不确定范围\n用户尾部必须保留\n'
  writeFileSync(file, text)
  const cfg = readFileSync(join(home, 'config.toml'), 'utf8')
  assert.equal(run(home).code, 1)
  assert.equal(readFileSync(file, 'utf8'), text)
  assert.equal(readFileSync(join(home, 'config.toml'), 'utf8'), cfg)
})

test('安装后用户修改规则块正文，卸载保留该文件并返回冲突', () => {
  const home = makeFakeCodexHome()
  assert.equal(run(home).code, 0)
  const file = join(home, 'AGENTS.md')
  const text = readFileSync(file, 'utf8').replace('<!-- dsh-multi-agent:end -->', '用户补充规则\n<!-- dsh-multi-agent:end -->')
  writeFileSync(file, text)
  assert.equal(run(home, '--uninstall').code, 1)
  assert.equal(readFileSync(file, 'utf8'), text)
})

test('含秘密的原角色段经备份恢复，秘密不进入安装记录正文', () => {
  const home = makeFakeCodexHome(), file = join(home, 'config.toml')
  const original = readFileSync(file, 'utf8') + '\n[agents."architecture_designer"]\nuser_token = "private-fixture-value"\n'
  writeFileSync(file, original)
  assert.equal(run(home).code, 0)
  assert.ok(!readFileSync(join(home, '.dsh-codex-bridge-install.json'), 'utf8').includes('private-fixture-value'))
  assert.equal(run(home, '--uninstall').code, 0)
  assert.ok(readFileSync(file, 'utf8').includes('private-fixture-value'))
})

test('安装记录丢失时不猜测归属，角色与MCP卸载均保留现有内容', () => {
  const home = makeFakeCodexHome(), fake = makeFakeDsh()
  assert.equal(run(home).code, 0)
  const apply = (...args) => runNode(join(REPO_ROOT, 'apply-config.mjs'), ['--codex-home', home, ...args], { env: { DSH_BIN: fake.bin } })
  assert.equal(apply().code, 0)
  const config = readFileSync(join(home, 'config.toml'), 'utf8')
  const skill = readFileSync(join(home, 'skills/dsh-bridge/SKILL.md'), 'utf8')
  rmSync(join(home, '.dsh-codex-bridge-install.json'))
  assert.equal(run(home, '--uninstall').code, 1)
  assert.equal(apply('--uninstall').code, 1)
  assert.equal(readFileSync(join(home, 'config.toml'), 'utf8'), config)
  assert.equal(readFileSync(join(home, 'skills/dsh-bridge/SKILL.md'), 'utf8'), skill)
})

test('先卸载角色再卸载MCP，也保留恢复所需的MCP记录', () => {
  const home = makeFakeCodexHome(), fake = makeFakeDsh()
  assert.equal(run(home).code, 0)
  const apply = (...args) => runNode(join(REPO_ROOT, 'apply-config.mjs'), ['--codex-home', home, ...args], { env: { DSH_BIN: fake.bin } })
  assert.equal(apply().code, 0)
  assert.equal(run(home, '--uninstall').code, 0)
  assert.ok(JSON.parse(readFileSync(join(home, '.dsh-codex-bridge-install.json'), 'utf8')).mcp)
  assert.equal(apply('--uninstall').code, 0)
  assert.ok(readFileSync(join(home, 'config.toml'), 'utf8').includes('/x/server.mjs'))
})

test('冲突文件的恢复记录保留，解决冲突后仍可恢复安装前内容', () => {
  const home = makeFakeCodexHome(), file = join(home, 'skills/dsh-bridge/SKILL.md')
  mkdirSync(join(home, 'skills/dsh-bridge'), { recursive: true })
  writeFileSync(file, 'original user skill')
  assert.equal(run(home).code, 0)
  const installed = readFileSync(file, 'utf8')
  writeFileSync(file, installed + '\nuser edit\n')
  assert.equal(run(home, '--uninstall').code, 1)
  writeFileSync(file, installed)
  assert.equal(run(home, '--uninstall').code, 0)
  assert.equal(readFileSync(file, 'utf8'), 'original user skill')
})
