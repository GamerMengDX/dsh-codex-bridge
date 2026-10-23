#!/usr/bin/env node
/**
 * dsh-task.mjs — 命令行的任务交付入口（MCP 不可用时的等价通道）。
 *
 *   node dsh-task.mjs --goal "列出 src 下所有未处理的异常路径" --cwd /path/to/project
 *   node dsh-task.mjs -m edit -C /path/to/project -g "修复 X 并跑测试" -a "测试全绿"
 *   node dsh-task.mjs -s proj-x -g "接着上次的梳理，指出最该拆的两个函数"
 *   node dsh-task.mjs --json -g "..."
 *
 * 与 MCP 完全同源：同一个 normalizeInput、同一个 runner、同一个契约检查。
 * 退出码：0 完成；1 失败/超时/状态未知；64 参数或输入非法。
 *
 * English:
 * CLI task-delivery entry used when MCP is unavailable. It is the same pipeline as the MCP
 * tool: same normalizeInput, same runner, same contract check, so a task behaves identically
 * on both channels.
 * Exit codes are part of the interface: 0 = completed, 1 = failed / timed out / unknown state,
 * 64 = bad arguments or rejected input. `--json` prints the structured outcome instead of the
 * report text, which is what scripts should consume.
 */

import { HELP_TEXT, parseArgs } from './lib/cli-args.mjs'
import { normalizeInput } from './lib/protocol.mjs'
import { runTask } from './lib/runner.mjs'

const { opts, positional, errors } = parseArgs(process.argv.slice(2))

if (opts.help) {
  process.stdout.write(HELP_TEXT)
  process.exit(0)
}
if (errors.length) {
  for (const error of errors) process.stderr.write(`${error}\n`)
  process.stderr.write(`\n${HELP_TEXT}`)
  process.exit(64)
}
if (!opts.goal && positional.length) opts.goal = positional.join(' ')

let input
try {
  input = normalizeInput(opts)
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exit(64)
}

try {
  const outcome = await runTask(input, {
    log: (line) => process.stderr.write(`[dsh-bridge] ${line}\n`),
    session: opts.session,
  })

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`)
  } else {
    process.stdout.write(`${outcome.text}\n`)
  }
  process.exit(outcome.ok ? 0 : 1)
} catch (error) {
  process.stderr.write(`调用失败: ${error.message}\n`)
  process.exit(1)
}
