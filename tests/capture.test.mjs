import assert from 'node:assert/strict'
import test from 'node:test'

import { createCapture } from '../lib/runner.mjs'

test('小输出原样返回，不标记截断', () => {
  const capture = createCapture(100, 20)
  capture.push('hello ')
  capture.push('world')
  const out = capture.finish()
  assert.equal(out.text, 'hello world')
  assert.equal(out.truncated, false)
  assert.equal(out.total, 11)
})

test('大输出保留头尾并明确标记省略量', () => {
  const capture = createCapture(10, 8)
  capture.push('A'.repeat(10))
  capture.push('B'.repeat(100))
  capture.push('C'.repeat(8))
  const out = capture.finish()
  assert.equal(out.truncated, true)
  assert.ok(out.text.startsWith('A'.repeat(10)))
  assert.ok(out.text.endsWith('C'.repeat(8)))
  assert.match(out.text, /中间省略 \d+ 字符，共 118 字符/)
})

test('多字节字符不会在块边界被破坏', () => {
  const capture = createCapture(6, 4)
  capture.push(Buffer.from('中文测试内容'))
  const out = capture.finish()
  assert.ok(!out.text.includes('\uFFFD'))
})

import { outcomeHeader } from '../lib/runner.mjs'

test('正常完成不附加状态行（省 token）', () => {
  assert.equal(outcomeHeader({ execution: 'completed', result: 'success', contractOk: true, warnings: [] }), '')
})

test('契约不通过时明确写出 contractOk=false', () => {
  const header = outcomeHeader({ execution: 'completed', result: 'success', contractOk: false, warnings: ['缺少段落：验证情况'] })
  assert.match(header, /contractOk=false/)
  assert.match(header, /warnings=1/)
})

test('异常或降级状态进入正文', () => {
  assert.match(outcomeHeader({ execution: 'timeout', result: 'unknown', warnings: [] }), /execution=timeout result=unknown/)
  assert.match(outcomeHeader({ execution: 'completed', result: 'failed', warnings: [] }), /result=failed/)
  assert.match(outcomeHeader({ execution: 'completed', result: 'success', warnings: ['缺证据'] }), /warnings=1/)
  assert.match(outcomeHeader({ execution: 'execution_unknown', result: 'unknown', warnings: [] }), /execution=execution_unknown/)
})
