import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  discoverNewSession,
  goalDigest,
  listSessionIds,
  listTraces,
  newTaskId,
  pruneTraces,
  readTrace,
  writeTrace,
} from '../lib/trace.mjs'

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), `${prefix}-`))
}

test('taskId 短且不重复', () => {
  const ids = new Set(Array.from({ length: 200 }, () => newTaskId()))
  assert.equal(ids.size, 200)
  assert.match([...ids][0], /^[0-9a-f]{8}$/)
})

test('轨迹写入后可读回，且按时间倒序列出', async () => {
  const dir = tempDir('trace')
  writeTrace(dir, { taskId: 'aaaa1111', at: '2026-01-01T00:00:00Z', execution: 'completed', result: 'success' })
  await new Promise((r) => setTimeout(r, 10))
  writeTrace(dir, { taskId: 'bbbb2222', at: '2026-01-01T00:01:00Z', execution: 'timeout', result: 'unknown' })

  assert.equal(readTrace(dir, 'aaaa1111').execution, 'completed')
  const list = listTraces(dir)
  assert.deepEqual(list.map((row) => row.taskId), ['bbbb2222', 'aaaa1111'])
})

test('轨迹目录按上限清理，保留最新', async () => {
  const dir = tempDir('trace-prune')
  for (const id of ['a1', 'b2', 'c3', 'd4']) {
    writeTrace(dir, { taskId: id, at: new Date().toISOString() })
    await new Promise((r) => setTimeout(r, 5))
  }
  const removed = pruneTraces(dir, 2)
  assert.equal(removed, 2)
  assert.deepEqual(listTraces(dir).map((row) => row.taskId), ['d4', 'c3'])
})

test('goal 摘要稳定且不泄露原文', () => {
  const a = goalDigest('同一个目标')
  const b = goalDigest('同一个目标')
  assert.equal(a, b)
  assert.equal(a.length, 12)
  assert.ok(!a.includes('目标'))
})

test('会话发现：只认领唯一新出现的会话', () => {
  const home = tempDir('dsh-home')
  mkdirSync(join(home, 'sessions', '--tmp--', 'session-old'), { recursive: true })

  const before = listSessionIds(home)
  assert.deepEqual([...before], ['session-old'])

  mkdirSync(join(home, 'sessions', '--tmp--', 'session-new'), { recursive: true })
  assert.equal(discoverNewSession(home, before), 'session-new')

  mkdirSync(join(home, 'sessions', '--tmp--', 'session-new2'), { recursive: true })
  assert.equal(discoverNewSession(home, before), undefined, '多个新会话时不应瞎猜')
})

test('会话发现：home 不存在时安全返回空', () => {
  const home = join(tempDir('missing'), 'nope')
  assert.equal(listSessionIds(home).size, 0)
  assert.equal(discoverNewSession(home, new Set()), undefined)
})

test('轨迹写入使用 600 权限且无临时残留', () => {
  const dir = tempDir('trace-mode')
  writeTrace(dir, { taskId: 'cccc3333', at: new Date().toISOString() })
  assert.ok(existsSync(join(dir, 'cccc3333.json')))
  assert.deepEqual(readdirSync(dir).filter((name) => name.includes('.tmp-')), [])
})
