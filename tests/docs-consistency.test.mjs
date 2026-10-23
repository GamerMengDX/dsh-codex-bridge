import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

test('工作流 Skill 区分标准开发与严格隔离，且不再一刀切禁止临时目录', () => {
  const skill = read('codex/skills/multi-agent-development/SKILL.md')
  assert.match(skill, /标准开发模式/)
  assert.match(skill, /严格隔离模式/)
  assert.match(skill, /不得仅因合理的临时文件操作判失败/)
  assert.ok(!skill.includes('不要用 `/tmp` 或系统临时目录'), '旧的一刀切规则应已删除')
})

test('Bridge Skill 把任务约束与沙箱事实分开描述', () => {
  const skill = read('skill/SKILL.md')
  assert.match(skill, /业务写入范围/)
  assert.match(skill, /沙箱实际可写/)
  assert.match(skill, /不等于 cwd-only|cwd-only/)
  assert.match(skill, /系统临时目录/)
})

test('全局规则允许必要临时文件，并要求识别严格隔离任务', () => {
  const agents = read('codex/AGENTS.md.part')
  assert.match(agents, /任务必需的系统临时文件/)
  assert.match(agents, /严格隔离/)
  assert.ok(!/gpt-\d/.test(agents), 'AGENTS 不应写死模型名')
})

test('任务模板包含 permission 字段与权限边界段', () => {
  const template = read('docs/architecture/TASKS/TEMPLATE.md')
  assert.match(template, /^permission: standard$/m)
  assert.match(template, /## 权限与边界/)
  assert.match(template, /strict/)
})

test('README 的权限说明与 Skill 一致', () => {
  const readme = read('README.md')
  assert.match(readme, /标准开发模式/)
  assert.match(readme, /严格隔离模式/)
  assert.match(readme, /不等于 cwd-only/)
})

test('验收模板要求三态结论与审计范围', () => {
  const review = read('docs/architecture/REVIEW-TEMPLATE.md')
  for (const state of ['passed', 'failed', 'inconclusive']) assert.ok(review.includes(state), state)
  assert.match(review, /审计范围与限制/)
})
