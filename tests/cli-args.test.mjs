import assert from 'node:assert/strict'
import test from 'node:test'

import { parseArgs } from '../lib/cli-args.mjs'

test('文件路径含逗号时不被切分', () => {
  const { opts, errors } = parseArgs(['-g', 'g', '-f', 'dir/a,b.txt'])
  assert.deepEqual(errors, [])
  assert.deepEqual(opts.files, ['dir/a,b.txt'])
})

test('重复 -f / --files 累积，保持顺序', () => {
  const { opts } = parseArgs(['--goal', 'g', '-f', 'a.txt', '--files', 'b c.txt', '--file', '中文.md'])
  assert.deepEqual(opts.files, ['a.txt', 'b c.txt', '中文.md'])
})

test('--key=value 与长选项', () => {
  const { opts } = parseArgs(['--goal=目标', '--cwd=/tmp/x', '--mode=edit', '--timeout=120'])
  assert.equal(opts.goal, '目标')
  assert.equal(opts.cwd, '/tmp/x')
  assert.equal(opts.mode, 'edit')
  assert.equal(opts.timeout_s, '120')
})

test('位置参数合并为 goal，-- 之后不再解析', () => {
  assert.equal(parseArgs(['做个', '任务']).opts.goal, undefined)
  const { opts, positional } = parseArgs(['做个 任务'])
  assert.deepEqual(positional, ['做个 任务'])

  const afterDash = parseArgs(['-g', 'g', '--', '-not-a-flag'])
  assert.deepEqual(afterDash.positional, ['-not-a-flag'])
  assert.deepEqual(afterDash.errors, [])
})

test('未知参数与缺值被报告', () => {
  assert.match(parseArgs(['--nope']).errors[0], /未知参数/)
  assert.match(parseArgs(['-g']).errors[0], /缺少取值/)
})

test('--json 与 --help', () => {
  assert.equal(parseArgs(['--json']).opts.json, true)
  assert.equal(parseArgs(['-h']).opts.help, true)
})
