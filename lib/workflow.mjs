/**
 * workflow.mjs — 多 Agent 协作的状态机与规则（纯逻辑，可单测）。
 *
 * 这些规则同时被 multi-agent-development Skill、task-doc 脚本和测试引用，
 * 避免「文档写一套、执行做另一套」。
 *
 * English:
 * Pure-logic state machine and rules for multi-agent collaboration. No I/O and no imports, so
 * it is unit testable in isolation; the same rules are referenced by the multi-agent-
 * development skill, the task-doc scripts and the tests, which keeps documentation and
 * execution from drifting apart.
 * transition() throws on unknown states and illegal edges instead of auto-correcting them.
 * classifyTask() errs toward the more conservative class when input is incomplete, but never
 * upgrades an ordinary task to class D on a keyword alone.
 * escalationDecision() keeps fixing within budget, escalates when there is no progress, and
 * stops to ask the user once the budget is exhausted.
 */

export const STATES = Object.freeze([
  'requirements',
  'designing',
  'design_review',
  'ready_for_implementation',
  'implementing',
  'reviewing',
  'passed',
  'delivered',
  'failed',
  'fixing',
  'design_issue',
  'redesigning',
  'blocked',
])

const TRANSITIONS = Object.freeze({
  requirements: ['designing', 'ready_for_implementation', 'blocked'],
  designing: ['design_review', 'requirements'],
  design_review: ['ready_for_implementation', 'redesigning', 'blocked'],
  ready_for_implementation: ['implementing', 'blocked'],
  implementing: ['reviewing', 'blocked'],
  reviewing: ['passed', 'failed', 'design_issue', 'blocked'],
  failed: ['fixing', 'blocked'],
  fixing: ['reviewing', 'blocked'],
  design_issue: ['redesigning', 'blocked'],
  redesigning: ['design_review', 'implementing', 'blocked'],
  passed: ['delivered'],
  blocked: ['requirements', 'designing', 'ready_for_implementation'],
  delivered: [],
})

export function canTransition(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to)
}

export function transition(from, to) {
  if (!STATES.includes(from)) throw new Error(`未知状态: ${from}`)
  if (!STATES.includes(to)) throw new Error(`未知目标状态: ${to}`)
  if (!canTransition(from, to)) {
    throw new Error(`非法状态转换: ${from} → ${to}（允许：${(TRANSITIONS[from] ?? []).join('/') || '无'}）`)
  }
  return to
}

/* ------------------------------------------------------- 任务分类 */

const RISK_PATTERNS = [
  { re: /认证|登录|会话令牌|auth|oauth|sso|jwt/i, label: '认证' },
  { re: /权限|越权|rbac|acl|授权/i, label: '权限' },
  { re: /支付|计费|结算|退款|payment|billing/i, label: '资金' },
  { re: /迁移|migration|回填|schema\s*变更/i, label: '数据迁移' },
  { re: /并发|竞态|锁|事务|consisten|race/i, label: '并发一致性' },
  { re: /加密|密钥|secret|隐私|pii/i, label: '安全敏感' },
]

const SIMPLE_PATTERNS = [/文案|错别字|颜色|间距|样式|logo|图标/i, /单文件|一行|小\s*bug|typo/i]

/**
 * 判定任务类别（A/B/C/D）。
 * 输入不完整时倾向更保守的类别，但不会仅凭关键词把普通任务升级为 D。
 */
export function classifyTask({
  description = '',
  hasDesign = false,
  changesContract = false,
  newProject = false,
  riskAreas = [],
} = {}) {
  const text = `${description} ${riskAreas.join(' ')}`
  const risks = RISK_PATTERNS.filter(({ re }) => re.test(text)).map(({ label }) => label)

  if (risks.length) return { class: 'D', reasons: [`命中高风险领域：${risks.join('、')}`] }
  if (newProject) return { class: 'C', reasons: ['新项目：没有既有设计基线'] }
  if (changesContract) return { class: 'C', reasons: ['涉及接口契约/数据模型/模块边界变更'] }
  if (!hasDesign && !SIMPLE_PATTERNS.some((re) => re.test(text))) {
    return { class: 'C', reasons: ['没有可用的设计基线，且不属于明确的小改动'] }
  }
  if (hasDesign) return { class: 'B', reasons: ['已有设计基线，且不改变契约'] }
  return { class: 'A', reasons: ['看起来是局部小改动'] }
}

/* ------------------------------------------------------- 升级预算 */

export const DEFAULT_FIX_BUDGET = 2

/**
 * 决定下一步：继续修 / 升级设计 / 问用户。
 * - 明确指向设计缺陷 → 立即升级
 * - 达到预算且没有进展 → 升级
 * - 超出预算仍无进展 → 停下问用户
 *
 * English: choose the next move — keep fixing, escalate to design, or ask the user. A failure
 * that points at a design defect escalates immediately; an exhausted fix budget without
 * progress escalates; past the budget without progress it stops and asks the user instead of
 * looping forever.
 */
export function escalationDecision({ attempts = 0, progressed = false, designSuspected = false } = {}) {
  if (designSuspected) {
    return { action: 'escalate', reason: 'design-suspected', message: '失败指向设计缺陷，交设计角色复核' }
  }
  if (attempts > DEFAULT_FIX_BUDGET && !progressed) {
    return { action: 'ask_user', reason: 'budget-exhausted', message: '超出修复预算，建议停下并请用户决策' }
  }
  if (attempts >= DEFAULT_FIX_BUDGET && !progressed) {
    return { action: 'escalate', reason: 'no-progress', message: '达到修复预算且没有实质进展，升级设计角色' }
  }
  return { action: 'fix', reason: 'within-budget', message: '继续交回执行方修复' }
}

/* ------------------------------------------------------- 任务单 */

export const REQUIRED_META = ['id', 'class', 'status', 'design_version', 'goal']
const CLASSES = ['A', 'B', 'C', 'D']
export const PERMISSION_MODES = ['standard', 'strict']

/** 极简 YAML front matter 解析（仅 key: value，够用且无依赖）。 */
export function parseTaskDoc(text) {
  const match = String(text).match(/^---\n([\s\S]*?)\n---\n?/)
  if (!match) return { meta: {}, body: String(text), error: '缺少 front matter（--- ... ---）' }
  const meta = {}
  for (const line of match[1].split('\n')) {
    const pair = line.match(/^([a-z_]+):\s*(.*)$/)
    if (pair) meta[pair[1]] = pair[2].trim().replace(/^"(.*)"$/, '$1')
  }
  return { meta, body: String(text).slice(match[0].length) }
}

export function validateTaskDoc(text) {
  const { meta, body, error } = parseTaskDoc(text)
  const errors = []
  if (error) errors.push(error)
  for (const key of REQUIRED_META) {
    if (!meta[key]) errors.push(`缺少字段 ${key}`)
  }
  if (meta.class && !CLASSES.includes(meta.class)) errors.push(`class 必须是 ${CLASSES.join('/')}`)
  if (meta.status && !STATES.includes(meta.status)) errors.push(`status 非法：${meta.status}`)
  if (meta.permission && !PERMISSION_MODES.includes(meta.permission)) {
    errors.push(`permission 必须是 ${PERMISSION_MODES.join('/')}`)
  }

  const needsAcceptance = ['B', 'C', 'D'].includes(meta.class)
  if (needsAcceptance && !/^##\s*验收条件\s*$/m.test(body)) {
    errors.push('B/C/D 类任务必须有「## 验收条件」段')
  }
  return { ok: errors.length === 0, errors, meta }
}

export function renderTaskDoc({
  id,
  goal,
  class: taskClass = 'A',
  designVersion = 'v0',
  status = 'requirements',
  permission = 'standard',
  date = new Date().toISOString().slice(0, 10),
}) {
  return `---
id: ${id}
class: ${taskClass}
status: ${status}
design_version: ${designVersion}
permission: ${permission}
goal: "${String(goal).replace(/"/g, "'")}"
created: ${date}
---

## 目标与范围

${goal}

## 相关文件

- （待填）

## 允许修改

- （待填）

## 不允许修改

- （待填）

## 权限与边界

- 权限模式：standard（允许任务必需的系统临时文件）/ strict（所有写入仅限本目录）
- 临时文件：允许 / 禁止；结束前是否清理
- 网络与其他副作用：允许 / 禁止（文件沙箱不限制网络）

## 验收条件

- （可执行断言；B/C/D 类必填）

## 测试要求

- （命令与期望）

## 评审记录

- （状态 / 依据 / 待办）

## 未解决问题

- （待填）
`
}
