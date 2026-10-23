#!/usr/bin/env node
/**
 * trace.mjs — 查看桥接调用轨迹（谁、什么时候、在哪个 DSH 会话里跑的）。
 * English: displays local task/session correlation metadata for bridge calls.
 * Goal prefixes and paths can still be sensitive even though full prompts and
 * final report bodies are not stored in these trace records.
 *
 *   node scripts/trace.mjs list [--limit 10]
 *   node scripts/trace.mjs show <taskId>
 *
 * 轨迹只含元数据（goal 截断 200 字 + 哈希），不含完整 prompt 与报告正文。
 */

import { TRACE_DIR } from '../lib/config.mjs'
import { listTraces, readTrace } from '../lib/trace.mjs'

const argv = process.argv.slice(2)
const command = argv[0] ?? 'list'
const limitIndex = argv.indexOf('--limit')
const limit = limitIndex >= 0 ? Number(argv[limitIndex + 1]) || 10 : 10

if (command === 'list') {
  const rows = listTraces(TRACE_DIR, limit)
  if (!rows.length) {
    process.stdout.write(`暂无轨迹（${TRACE_DIR}）\n`)
    process.exit(0)
  }
  const pad = (value, width) => String(value ?? '-').padEnd(width).slice(0, width)
  process.stdout.write(`${pad('taskId', 10)}${pad('时间', 21)}${pad('backend', 9)}${pad('mode', 8)}${pad('execution', 20)}${pad('result', 9)}${pad('session', 40)}\n`)
  for (const row of rows) {
    process.stdout.write(
      `${pad(row.taskId, 10)}${pad(row.at?.replace('T', ' ').slice(0, 19), 21)}${pad(row.backend, 9)}${pad(row.mode, 8)}` +
      `${pad(row.execution, 20)}${pad(row.result, 9)}${pad(row.sessionId ?? '(未识别)', 40)}\n`,
    )
  }
  process.stdout.write(`\n轨迹目录：${TRACE_DIR}\n`)
  process.exit(0)
}

if (command === 'show') {
  const id = argv[1]
  if (!id) {
    process.stderr.write('用法: node scripts/trace.mjs show <taskId>\n')
    process.exit(64)
  }
  const record = readTrace(TRACE_DIR, id)
  if (!record) {
    process.stderr.write(`找不到轨迹：${id}\n`)
    process.exit(1)
  }
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`)
  process.exit(0)
}

process.stderr.write('用法: node scripts/trace.mjs list [--limit N] | show <taskId>\n')
process.exit(64)
