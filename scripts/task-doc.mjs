#!/usr/bin/env node
/**
 * task-doc.mjs — 生成 / 校验 / 更新任务交接单。
 * English: generates, structurally checks, and advances project handoff documents.
 * Run this bridge-owned tool from the business project's directory.
 * Required headings remain Chinese; a successful check does not execute acceptance tests.
 *
 *   node scripts/task-doc.mjs new --id T-001 --class C --goal "..." [--design v2] [--dir docs/architecture/TASKS]
 *   node scripts/task-doc.mjs check --file docs/architecture/TASKS/T-001.md
 *   node scripts/task-doc.mjs set-state --file ... --state implementing
 *   node scripts/task-doc.mjs set-state --file ... --state reviewing --note "已实现，待验收"
 *
 * 状态转换由 lib/workflow.mjs 校验，非法跳转直接失败（退出码 1）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { STATES, parseTaskDoc, renderTaskDoc, transition, validateTaskDoc } from '../lib/workflow.mjs'

const argv = process.argv.slice(2)
const command = argv[0]
const opts = {}
for (let i = 1; i < argv.length; i += 1) {
  const arg = argv[i]
  if (arg.startsWith('--')) {
    const key = arg.slice(2)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) {
      opts[key] = true
    } else {
      opts[key] = value
      i += 1
    }
  }
}

const HELP = `用法:
  task-doc new --id <ID> --goal <文本> [--class A|B|C|D] [--design v1] [--status requirements] [--dir <目录>]
  task-doc check --file <路径>
  task-doc set-state --file <路径> --state <状态> [--note <说明>]

状态: ${STATES.join(' / ')}`

if (!command || opts.help) {
  process.stdout.write(`${HELP}\n`)
  process.exit(command ? 0 : 64)
}

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

if (command === 'new') {
  if (!opts.id) fail('缺少 --id')
  if (!opts.goal) fail('缺少 --goal')
  const dir = resolve(opts.dir ?? 'docs/architecture/TASKS')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${opts.id}.md`)
  if (existsSync(file)) fail(`任务单已存在：${file}`)
  const text = renderTaskDoc({
    id: opts.id,
    goal: opts.goal,
    class: opts.class ?? 'A',
    designVersion: opts.design ?? 'v0',
    status: opts.status ?? 'requirements',
  })
  const check = validateTaskDoc(text)
  if (!check.ok) fail(`模板校验失败：${check.errors.join('；')}`)
  writeFileSync(file, text, { mode: 0o644 })
  process.stdout.write(`${file}\n`)
  process.exit(0)
}

if (command === 'check') {
  if (!opts.file) fail('缺少 --file')
  if (!existsSync(opts.file)) fail(`文件不存在：${opts.file}`)
  const result = validateTaskDoc(readFileSync(opts.file, 'utf8'))
  if (!result.ok) fail(result.errors.join('\n'))
  process.stdout.write(`OK ${result.meta.id} class=${result.meta.class} status=${result.meta.status}\n`)
  process.exit(0)
}

if (command === 'set-state') {
  if (!opts.file) fail('缺少 --file')
  if (!opts.state) fail('缺少 --state')
  const file = resolve(opts.file)
  if (!existsSync(file)) fail(`文件不存在：${file}`)
  const text = readFileSync(file, 'utf8')
  const { meta } = parseTaskDoc(text)
  if (!meta.status) fail('任务单缺少 status 字段')

  let next
  try {
    next = transition(meta.status, opts.state)
  } catch (error) {
    fail(error.message)
  }

  let updated = text.replace(/^status:.*$/m, `status: ${next}`)
  if (opts.note) {
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
    updated = updated.replace(/^## 评审记录\s*$/m, `## 评审记录\n\n- ${stamp} ${meta.status} → ${next}：${opts.note}`)
  }
  writeFileSync(file, updated)
  process.stdout.write(`${meta.status} → ${next}\n`)
  process.exit(0)
}

fail(`未知命令: ${command}\n${HELP}`)
