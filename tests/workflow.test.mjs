import assert from 'node:assert/strict'
import test from 'node:test'

import {
  STATES,
  canTransition,
  classifyTask,
  escalationDecision,
  parseTaskDoc,
  renderTaskDoc,
  transition,
  validateTaskDoc,
} from '../lib/workflow.mjs'

test('合法状态转换通过，非法跳转被拒绝', () => {
  assert.equal(transition('requirements', 'ready_for_implementation'), 'ready_for_implementation')
  assert.equal(transition('reviewing', 'failed'), 'failed')
  assert.equal(transition('failed', 'fixing'), 'fixing')
  assert.throws(() => transition('requirements', 'delivered'), /非法状态转换/)
  assert.throws(() => transition('delivered', 'implementing'), /非法状态转换/)
  assert.throws(() => transition('nope', 'passed'), /未知状态/)
})

test('每个状态都有定义，且 passed 只能到 delivered', () => {
  for (const state of STATES) assert.equal(typeof canTransition(state, state), 'boolean')
  assert.equal(canTransition('passed', 'delivered'), true)
  assert.equal(canTransition('passed', 'failed'), false)
})

test('分类：高风险领域优先判 D', () => {
  assert.equal(classifyTask({ description: '改造登录认证流程' }).class, 'D')
  assert.equal(classifyTask({ description: '普通页面', riskAreas: ['数据迁移'] }).class, 'D')
  assert.match(classifyTask({ description: '改支付回调' }).reasons.join(), /高风险/)
})

test('分类：新项目/契约变更判 C，设计内判 B，小改判 A', () => {
  assert.equal(classifyTask({ description: '做一个新系统', newProject: true }).class, 'C')
  assert.equal(classifyTask({ description: '调整接口', changesContract: true }).class, 'C')
  assert.equal(classifyTask({ description: '加一个列表页', hasDesign: true }).class, 'B')
  assert.equal(classifyTask({ description: '改一下按钮颜色', hasDesign: true }).class, 'B')
  assert.equal(classifyTask({ description: '改一下按钮颜色' }).class, 'A')
})

test('分类：无设计基线的非小改判 C', () => {
  assert.equal(classifyTask({ description: '实现订单导出功能' }).class, 'C')
})

test('升级决策：设计缺陷立即升级，预算内继续修，超预算问用户', () => {
  assert.equal(escalationDecision({ attempts: 0, designSuspected: true }).action, 'escalate')
  assert.equal(escalationDecision({ attempts: 1, progressed: true }).action, 'fix')
  assert.equal(escalationDecision({ attempts: 2, progressed: true }).action, 'fix')
  assert.equal(escalationDecision({ attempts: 2, progressed: false }).action, 'escalate')
  assert.equal(escalationDecision({ attempts: 3, progressed: false }).action, 'ask_user')
})

test('任务单：渲染后可通过校验', () => {
  const text = renderTaskDoc({ id: 'T-001', goal: '实现导出', class: 'C', designVersion: 'v2' })
  const result = validateTaskDoc(text)
  assert.deepEqual(result.errors, [])
  assert.equal(result.meta.id, 'T-001')
  assert.equal(result.meta.status, 'requirements')
  assert.equal(result.meta.design_version, 'v2')
})

test('任务单：缺字段与非法取值都报错', () => {
  const broken = `---\nid: T-2\nclass: X\nstatus: doing\n---\n\n## 目标与范围\n`
  const result = validateTaskDoc(broken)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('class')))
  assert.ok(result.errors.some((e) => e.includes('status')))
  assert.ok(result.errors.some((e) => e.includes('design_version')))

  const noFrontMatter = validateTaskDoc('# 随便写点')
  assert.equal(noFrontMatter.ok, false)
})

test('任务单：B/C/D 缺验收条件时报错，A 类不要求', () => {
  const base = (cls) => `---\nid: T-9\nclass: ${cls}\nstatus: requirements\ndesign_version: v0\ngoal: "g"\n---\n\n## 目标与范围\n\n无\n`
  assert.ok(validateTaskDoc(base('C')).errors.some((e) => e.includes('验收条件')))
  assert.deepEqual(validateTaskDoc(base('A')).errors, [])
})

test('任务单：解析 front matter 不影响正文', () => {
  const text = renderTaskDoc({ id: 'T-3', goal: 'a "quoted" goal', class: 'A' })
  const parsed = parseTaskDoc(text)
  assert.equal(parsed.meta.id, 'T-3')
  assert.match(parsed.body, /## 目标与范围/)
  assert.ok(!parsed.body.includes('status:'))
})

test('任务单支持 standard/strict 权限模式，非法值报错', () => {
  const strict = renderTaskDoc({ id: 'T-5', goal: 'g', class: 'B', permission: 'strict' })
  assert.equal(validateTaskDoc(strict).meta.permission, 'strict')
  assert.match(strict, /## 权限与边界/)

  const bad = strict.replace('permission: strict', 'permission: open')
  assert.ok(validateTaskDoc(bad).errors.some((e) => e.includes('permission')))

  const dflt = renderTaskDoc({ id: 'T-6', goal: 'g', class: 'A' })
  assert.equal(validateTaskDoc(dflt).meta.permission, 'standard')
})
