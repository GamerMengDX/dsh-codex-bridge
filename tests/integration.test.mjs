/**
 * 集成测试：需要真实 DSH 环境与模型额度。
 *   DSH_BRIDGE_INTEGRATION=1 node --test tests/integration.test.mjs
 *
 * 只在专用临时目录里做破坏性探测；不触碰用户项目、不改全局 DSH 配置。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

const ENABLED = process.env.DSH_BRIDGE_INTEGRATION === '1'
const skip = ENABLED ? false : '设置 DSH_BRIDGE_INTEGRATION=1 才会跑真实 DSH 集成测试'
const IS_MAC = process.platform === 'darwin'

const ROOT = join(tmpdir(), `dsh-bridge-itest-${Date.now()}`)
const OUTSIDE = IS_MAC ? join('/Users/Shared', `dsh-bridge-itest-outside-${Date.now()}`) : join(ROOT, 'outside')
// 注意：workspace-write 允许写 /tmp 与 $TMPDIR，所以 host home 不能放在临时区，
// 否则「写 HOST_ROOT 应被拒绝」这个断言会假阳性。
const HOST_ROOT_FIXTURE = join('/Users/Shared', `dsh-bridge-itest-host-${Date.now()}`)
const ORIGINAL_HOST_ROOT = process.env.DSH_HOST_ROOT

let runTask
let normalizeInput
let shutdownHosts

before(async () => {
  if (!ENABLED) return
  process.env.DSH_HOST_ROOT = HOST_ROOT_FIXTURE
  process.env.DSH_HOST_PORT_ANALYZE = '43196'
  process.env.DSH_HOST_PORT_EDIT = '43197'
  mkdirSync(ROOT, { recursive: true })
  mkdirSync(OUTSIDE, { recursive: true })
  mkdirSync(HOST_ROOT_FIXTURE, { recursive: true })
  writeFileSync(join(ROOT, 'seed.txt'), 'seed\n')

  const protocol = await import('../lib/protocol.mjs')
  const runner = await import('../lib/runner.mjs')
  const host = await import('../lib/host.mjs')
  normalizeInput = protocol.normalizeInput
  runTask = runner.runTask
  shutdownHosts = host.shutdownHosts
})

after(() => {
  if (!ENABLED) return
  shutdownHosts()
  try {
    rmSync(ROOT, { recursive: true, force: true })
    rmSync(OUTSIDE, { recursive: true, force: true })
    rmSync(HOST_ROOT_FIXTURE, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响结论 */
  }
  if (ORIGINAL_HOST_ROOT === undefined) delete process.env.DSH_HOST_ROOT
  else process.env.DSH_HOST_ROOT = ORIGINAL_HOST_ROOT
})

const silent = () => {}

function task(goal, extra = {}) {
  return runTask(normalizeInput({ goal, mode: 'analyze', timeout_s: 180, ...extra }), {
    cwd: ROOT,
    log: silent,
    session: extra.session,
  })
}

test('headless analyze：读得到、写不进', { skip }, async () => {
  const target = join(ROOT, 'analyze-write.txt')
  await task(`用 bash 执行 "echo x > ${target}"，并报告退出码。不要尝试绕过沙箱。`)
  assert.equal(existsSync(target), false, '只读模式下不应生成文件')
  assert.ok(readFileSync(join(ROOT, 'seed.txt'), 'utf8').includes('seed'))
})

test('headless edit：cwd 内可写，cwd 外拒绝', { skip, timeout: 240_000 }, async () => {
  const inside = join(ROOT, 'edit-inside.txt')
  const outside = join(OUTSIDE, 'escape.txt')
  const out = await runTask(
    normalizeInput({ goal: `用 bash 执行 "echo x > ${inside}" 和 "echo x > ${outside}"，分别报告退出码。`, mode: 'edit', timeout_s: 180 }),
    { cwd: ROOT, log: silent },
  )
  assert.ok(out.ok, out.text)
  assert.equal(existsSync(inside), true, 'cwd 内应可写')
  assert.equal(existsSync(outside), false, 'cwd 外必须被拒绝')
})

test('session edit：工作区绑定 session 的 cwd，而不是 HOST_ROOT', { skip, timeout: 240_000 }, async () => {
  const work = join(ROOT, 'session-work')
  mkdirSync(work, { recursive: true })
  const inside = join(work, 'session-inside.txt')
  const hostRootProbe = join(process.env.DSH_HOST_ROOT, 'hostroot-probe.txt')

  const out = await runTask(
    normalizeInput({ goal: `用 bash 执行 "touch ${inside}" 和 "touch ${hostRootProbe}"，分别报告退出码。`, mode: 'edit', timeout_s: 180 }),
    { cwd: work, log: silent, session: 'itest-binding' },
  )
  assert.ok(out.ok, out.text)
  assert.equal(existsSync(inside), true, 'session cwd 内应可写')
  assert.equal(existsSync(hostRootProbe), false, '不得把 HOST_ROOT 当作工作区')
})

test('session analyze：只读，连 cwd 内也不能写', { skip, timeout: 240_000 }, async () => {
  const target = join(ROOT, 'session-analyze-write.txt')
  await runTask(
    normalizeInput({ goal: `用 bash 执行 "echo x > ${target}"，报告退出码。`, mode: 'analyze', timeout_s: 180 }),
    { cwd: ROOT, log: silent, session: 'itest-ro' },
  )
  assert.equal(existsSync(target), false)
})

test('同一 session 并发提交：串行、各自拿到自己的结果', { skip, timeout: 300_000 }, async () => {
  const cwd = ROOT
  const [a, b] = await Promise.all([
    runTask(normalizeInput({ goal: '只回复 TOKEN-FIRST-111', mode: 'analyze', timeout_s: 180 }), { cwd, log: silent, session: 'itest-conc' }),
    runTask(normalizeInput({ goal: '只回复 TOKEN-SECOND-222', mode: 'analyze', timeout_s: 180 }), { cwd, log: silent, session: 'itest-conc' }),
  ])
  assert.ok(a.ok && b.ok, `${a.text}\n---\n${b.text}`)
  assert.ok(a.text.includes('TOKEN-FIRST-111'))
  assert.ok(b.text.includes('TOKEN-SECOND-222'))
  assert.notEqual(a.sessionId, undefined)
  assert.equal(a.sessionId, b.sessionId)
})

test('session 超时：取消并确认，随后同会话仍可用', { skip, timeout: 300_000 }, async () => {
  const slow = await runTask(
    normalizeInput({ goal: '用 bash 执行 sleep 60，然后回复 SLEPT。', mode: 'analyze', timeout_s: 12 }),
    { cwd: ROOT, log: silent, session: 'itest-timeout' },
  )
  assert.equal(slow.execution, 'timeout')
  assert.equal(slow.ok, false)

  const after = await runTask(
    normalizeInput({ goal: '只回复 AFTER-TIMEOUT', mode: 'analyze', timeout_s: 120 }),
    { cwd: ROOT, log: silent, session: 'itest-timeout' },
  )
  assert.ok(after.ok, after.text)
})

test('跨 host 重启恢复同一会话', { skip, timeout: 300_000 }, async () => {
  const first = await runTask(
    normalizeInput({ goal: '记住数字 314。只回复 STORED-NUMBER。', mode: 'analyze', timeout_s: 180 }),
    { cwd: ROOT, log: silent, session: 'itest-restart' },
  )
  assert.ok(first.ok, first.text)

  shutdownHosts()

  const second = await runTask(
    normalizeInput({ goal: '我刚才让你记住的数字是多少？只回复数字。', mode: 'analyze', timeout_s: 180 }),
    { cwd: ROOT, log: silent, session: 'itest-restart' },
  )
  assert.ok(second.ok, second.text)
  assert.match(second.text, /314/)
})
