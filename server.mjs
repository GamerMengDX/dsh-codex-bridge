#!/usr/bin/env node
/**
 * server.mjs — 把 DSH 以 MCP 工具 `dsh_task` 暴露给 Codex（stdio，零依赖）。
 *
 * 三层契约：
 *   输入（lib/protocol.mjs）：goal / cwd / files / mode / context / constraints / acceptance
 *   输出：状态 → 摘要 → 交付内容 → 发现问题 → 验证情况 → 未解决 → 建议动作
 *   权限（lib/runner.mjs + patches）：analyze = 只读；edit = 仅可写 cwd。均由沙箱强制。
 *
 * 日志走 stderr；stdout 只走 MCP 协议数据。
 *
 * English:
 * Exposes DSH to Codex as the single MCP tool `dsh_task` over stdio, with zero runtime deps.
 * Three contracts: structured input (lib/protocol.mjs), the fixed report layout, and the
 * permission mode (analyze / edit) whose file writes are confined by the DSH sandbox patches.
 * The sandbox constrains FILE WRITES only — "analyze" is read-only for files, it is not a
 * promise of "no network / no side effects", which is exactly why the prompt rules forbid
 * side-effecting commands as a separate layer.
 * This file only speaks MCP: sanitization, prompt building, process control and contract
 * checks live under lib/.
 */

import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

import { normalizeInput } from './lib/protocol.mjs'
import { DSH_BIN, DSH_HOME, chooseNode, readApiKey } from './lib/config.mjs'
import { outcomeHeader, runTask } from './lib/runner.mjs'

const PROTOCOL_VERSION = '2024-11-05'
/** 版本号只有一个来源：package.json（避免服务端显示与实际版本不一致）。 */
const SERVER_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()
const NODE_BIN = chooseNode()
const API_KEY = readApiKey()

const TOOL = {
  name: 'dsh_task',
  description:
    'Delegate one self-contained task to the local DSH agent and get back a structured report. ' +
    'Use it instead of computer-use / screenshotting DSH. DSH runs its own tools in its own session; ' +
    'only the final report returns here. Default mode "analyze" is READ-ONLY (sandbox-enforced); ' +
    '"edit" may only write inside cwd. Omit "session" for a fresh one-shot session; pass a label to ' +
    'reuse the same DSH session across calls (full history, survives restarts).',
  inputSchema: {
    type: 'object',
    properties: {
      goal: {
        type: 'string',
        description: 'The deliverable as an outcome (e.g. "列出这 3 个文件里所有未处理的异常路径"), not a vague topic.',
      },
      cwd: {
        type: 'string',
        description: 'Absolute working directory for the DSH session. "edit" writes are confined to it.',
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Files or directories the task concerns (absolute or cwd-relative).',
      },
      mode: {
        type: 'string',
        enum: ['analyze', 'edit'],
        description: '"analyze" (default) = read-only; "edit" = may modify files inside cwd. Only use "edit" when the user authorized changes.',
      },
      context: {
        type: 'string',
        description: 'Background DSH cannot infer: prior findings, decisions already made, why the task matters.',
      },
      constraints: {
        type: 'array',
        items: { type: 'string' },
        description: 'Hard limits: what not to touch, language, style, tool restrictions.',
      },
      acceptance: {
        type: 'array',
        items: { type: 'string' },
        description: 'How the result will be judged; DSH self-checks against these before answering.',
      },
      session: {
        type: 'string',
        description: 'Optional session label. Same label = same DSH session, so later calls keep the full conversation. Omit for a fresh one-shot session (best when tasks are independent).',
      },
      timeout_s: {
        type: 'number',
        description: 'Timeout in seconds (default 600, max 1800).',
      },
    },
    required: ['goal'],
  },
}

/* English: one process-wide queue — the MCP entry currently runs every dsh_task call
 * serially, i.e. at most one DSH task at a time per server process. */
let queue = Promise.resolve()

/* English: chain the job after the previous one regardless of its outcome, and keep `queue`
 * itself from staying rejected (so one failure cannot wedge later calls). */
function enqueue(job) {
  const run = queue.then(job, job)
  queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function log(...args) {
  process.stderr.write(`[dsh-bridge] ${args.join(' ')}\n`)
}

async function executeTask(rawArgs) {
  // 兼容 v1 的 { prompt } 调用
  // English: legacy v1 calls that only sent { prompt } are mapped onto goal; everything else
  // goes through normalizeInput, so both channels validate identically.
  const args = rawArgs && typeof rawArgs.prompt === 'string' && !rawArgs.goal
    ? { ...rawArgs, goal: rawArgs.prompt }
    : rawArgs

  const input = normalizeInput(args ?? {})
  const session = typeof args?.session === 'string' && args.session.trim() ? args.session.trim() : undefined
  return enqueue(() => runTask(input, { log, session }))
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const replyError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

async function handle(message) {
  const { id, method, params } = message
  const isNotification = id === undefined || id === null

  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'dsh-bridge', version: SERVER_VERSION },
        instructions:
          'DSH 通过 dsh_task 交付任务：给自包含的 goal + 权限模式，拿回结构化报告。' +
          '默认 analyze 只读；只有用户明确授权修改时才用 edit。不要用 computer use 操作 DSH 界面。' +
        '传 session 标签可复用同一个 DSH 会话（保留上下文）；独立任务不要传。' +
        '返回的 _meta 里有 execution/result/warnings，可据此判断报告可信度。',
      })
      return

    case 'notifications/initialized':
    case 'notifications/cancelled':
      if (!isNotification) reply(id, {})
      return

    case 'ping':
      if (!isNotification) reply(id, {})
      return

    case 'tools/list':
      reply(id, { tools: [TOOL] })
      return

    case 'tools/call': {
      if (params?.name !== TOOL.name) {
        replyError(id, -32602, `未知工具: ${String(params?.name)}`)
        return
      }
      try {
        const outcome = await executeTask(params?.arguments ?? {})
        // _meta 只有客户端看得到；把状态压成一行放进正文，模型才看得见。
        // English: _meta is visible to the MCP client only, so the degraded status is also
        // prepended to the text body — otherwise the model would see a normal-looking report.
        const header = outcomeHeader(outcome)
        reply(id, {
          isError: !outcome.ok,
          content: [{ type: 'text', text: header ? `${header}\n\n${outcome.text}` : outcome.text }],
          _meta: {
            taskId: outcome.taskId,
            execution: outcome.execution,
            result: outcome.result,
            contractOk: outcome.contractOk,
            warnings: outcome.warnings ?? [],
            sessionId: outcome.sessionId,
            seconds: outcome.seconds,
            truncated: outcome.truncated ?? false,
          },
        })
      } catch (error) {
        reply(id, { isError: true, content: [{ type: 'text', text: `调用失败: ${error.message}` }] })
      }
      return
    }

    case 'resources/list':
      if (!isNotification) reply(id, { resources: [] })
      return

    case 'prompts/list':
      if (!isNotification) reply(id, { prompts: [] })
      return

    default:
      if (!isNotification) replyError(id, -32601, `未实现的方法: ${String(method)}`)
  }
}

function main() {
  if (!DSH_BIN) log('警告：DSH 入口路径为空')
  log(`ready dshBin=${DSH_BIN} dshHome=${DSH_HOME} node=${NODE_BIN} apiKey=${API_KEY ? 'ok' : 'missing'}`)

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  const pending = new Set()

  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let message
    try {
      message = JSON.parse(trimmed)
    } catch {
      log(`忽略非法 JSON 行: ${trimmed.slice(0, 120)}`)
      return
    }
    const job = Promise.resolve()
      .then(() => handle(message))
      .catch((error) => {
        log(`处理异常: ${error.stack || error.message}`)
        if (message?.id !== undefined && message?.id !== null) {
          replyError(message.id, -32603, error.message)
        }
      })
      .finally(() => pending.delete(job))
    pending.add(job)
  })

  // stdin 关闭（客户端退出）时等在跑的任务收尾，避免半路砍掉 dsh_task。
  // English: on stdin close, let in-flight jobs settle before exiting so a client shutdown does
  // not cut a running dsh_task in half.
  rl.on('close', () => {
    Promise.allSettled([...pending]).then(() => process.exit(0))
  })
}

main()
