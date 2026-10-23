import assert from 'node:assert/strict'
import test from 'node:test'

import { DirtySessionError, LanePool, SessionLane } from '../lib/session-lane.mjs'

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

test('同一会话严格串行，后一个任务不会覆盖前一个', async () => {
  const lane = new SessionLane('s1')
  const order = []
  const first = lane.run(async () => {
    order.push('a-start')
    await tick(30)
    order.push('a-end')
    return 'A'
  })
  const second = lane.run(async () => {
    order.push('b-start')
    await tick(5)
    order.push('b-end')
    return 'B'
  })

  assert.deepEqual(await Promise.all([first, second]), ['A', 'B'])
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end'])
})

test('前一个任务失败不会阻断后续任务', async () => {
  const lane = new SessionLane('s2')
  const failing = lane.run(async () => {
    throw new Error('boom')
  })
  const next = lane.run(async () => 'ok')
  await assert.rejects(failing, /boom/)
  assert.equal(await next, 'ok')
})

test('dirty 时拒绝新任务，清理后可继续', async () => {
  const lane = new SessionLane('s3')
  lane.markDirty('超时未确认')
  await assert.rejects(lane.run(async () => 'x'), DirtySessionError)
  lane.clearDirty()
  assert.equal(await lane.run(async () => 'y'), 'y')
})

test('不同会话互不阻塞', async () => {
  const pool = new LanePool()
  const a = pool.get('a')
  const b = pool.get('b')
  assert.equal(pool.get('a'), a)

  const order = []
  const slow = a.run(async () => {
    await tick(20)
    order.push('a')
  })
  const fast = b.run(async () => {
    order.push('b')
  })
  await Promise.all([slow, fast])
  assert.deepEqual(order, ['b', 'a'])
})

test('busy 计数随任务进出变化', async () => {
  const lane = new SessionLane('s4')
  assert.equal(lane.busy, false)
  const running = lane.run(async () => {
    assert.equal(lane.busy, true)
    await tick(5)
  })
  await running
  assert.equal(lane.busy, false)
})
