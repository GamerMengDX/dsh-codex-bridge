/**
 * runner.mjs — 执行器：把一份已规范化的任务输入跑成 DSH 的产出。
 *
 * 两条后端共用同一套状态机与契约检查：
 *   - 一次性：headless 进程，跑完即退；超时按进程组整树清理。
 *   - 续接：常驻 dsh web host + 固定 sessionId；超时会先取消再判定。
 *
 * execution: completed | failed | timeout | cancelled | execution_unknown
 * result:    success | partial | failed | unknown（来自 DSH 报告的「任务状态」）
 *
 * English:
 * Executor: turns one normalized task input into a DSH artifact, over two backends that share
 * the same state machine and the same contract check.
 *   - one-shot: a headless child process, exits when done; on timeout the whole process group
 *     is killed tree-wide.
 *   - session: a long-lived `dsh web` host plus a stable sessionId; on timeout the turn is
 *     canceled first and only a confirmed cancellation counts as `timeout`.
 * execution: completed | failed | timeout | cancelled | execution_unknown. The last one means
 * the bridge could not prove whether DSH is still running, so a blind retry may duplicate work.
 * result is read from the DSH report's own status line — the bridge does not verify facts.
 */

import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import {
  DEFAULT_TASK_CWD,
  TRACE_DIR,
  DEFAULT_TIMEOUT_S,
  DSH_BIN,
  DSH_HOME,
  HARD_TIMEOUT_S,
  MAX_OUTPUT,
  MODE_PATCH,
  chooseNode,
  readApiKey,
} from './config.mjs'
import { buildPrompt, formatContractWarning, sanitize, validateResult } from './protocol.mjs'
import { discoverNewSession, goalDigest, listSessionIds, newTaskId, writeTrace } from './trace.mjs'
import { runInSession } from './host.mjs'

const CHILD_TAIL_LIMIT = 4096
const STDERR_LIMIT = 200_000
const liveChildren = new Set()

/* English: resolve the working directory once, here. A relative value resolves against
 * DEFAULT_TASK_CWD (not the caller's shell) and the result must be an existing directory —
 * otherwise the task fails before any DSH process starts. */
export function resolveCwd(input) {
  const candidate = input ? String(input) : DEFAULT_TASK_CWD
  const absolute = isAbsolute(candidate) ? candidate : resolve(DEFAULT_TASK_CWD, candidate)
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    throw new Error(`cwd 不存在或不是目录: ${absolute}`)
  }
  return absolute
}

export function truncate(text, limit = MAX_OUTPUT) {
  if (text.length <= limit) return { text, truncated: false }
  return { text: `${text.slice(0, limit)}\n\n…[输出已截断，原长 ${text.length} 字符]`, truncated: true }
}

/**
 * 流式捕获：内存上限 = head + tail。
 * 超出时保留开头（报告主体）与结尾（建议动作），中间明确标记省略，不静默丢内容。
 *
 * English: bounded stream capture — memory is head + tail only. When output overflows, the
 * beginning (report body) and the end (recommended actions) are kept and the omitted middle is
 * marked explicitly with a character count; nothing is dropped silently.
 */
export function createCapture(headLimit, tailLimit) {
  const decoder = new StringDecoder('utf8')
  let head = ''
  let tail = ''
  let total = 0

  return {
    push(chunk) {
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk)
      if (!text) return
      total += text.length
      if (head.length < headLimit) {
        const room = headLimit - head.length
        head += text.slice(0, room)
        const rest = text.slice(room)
        if (rest) tail = (tail + rest).slice(-tailLimit)
      } else {
        tail = (tail + text).slice(-tailLimit)
      }
      if (tail.length > tailLimit) tail = tail.slice(-tailLimit)
    },
    finish() {
      const rest = decoder.end()
      if (rest) this.push(rest)
      const omitted = total - head.length - tail.length
      if (total <= headLimit) return { text: head, truncated: false, total }
      const marker = omitted > 0 ? `\n\n…[中间省略 ${omitted} 字符，共 ${total} 字符]…\n\n` : '\n\n'
      return {
        text: `${head}${marker}${tail}`,
        truncated: true,
        total,
      }
    },
    get size() {
      return total
    },
  }
}

/* English: kill the whole process group first, then the child itself; both steps tolerate an
 * already-dead target because a timed-out group may be gone by the time we run. */
function killTree(child) {
  try {
    if (child.pid) process.kill(-child.pid, 'SIGKILL')
  } catch {
    /* 进程组可能已不存在 */
  }
  try {
    child.kill('SIGKILL')
  } catch {
    /* ignore */
  }
}

/* English: one-shot backend. It rejects early (missing DSH entry or missing permission
 * overlay) rather than spawning something that cannot enforce the mode. The child runs in its
 * own process group so a timeout can kill the entire tree; a 5s hard timer guarantees the
 * promise settles even if the group ignores SIGKILL, in which case killConfirmed is false and
 * the outcome becomes execution_unknown rather than a clean timeout. */
export function runHeadless({
  prompt,
  cwd,
  timeoutS,
  mode,
  apiKey = readApiKey(),
  nodeBin = chooseNode(),
}) {
  if (!existsSync(DSH_BIN)) {
    return Promise.reject(new Error(`找不到 DSH 入口: ${DSH_BIN}（用 DSH_BIN 指定 dsh 包内 lib/bin.js）`))
  }
  const patch = MODE_PATCH[mode]
  if (!patch || !existsSync(patch)) {
    return Promise.reject(new Error(`缺少权限 overlay: ${patch}`))
  }

  const env = { ...process.env, DSH_HOME }
  if (apiKey) env.DEEPSEEK_API_KEY = apiKey

  const args = ['--expose-internals', DSH_BIN, '--profile', 'headless', '--patch', patch, '--', prompt]
  const started = Date.now()
  const capture = createCapture(MAX_OUTPUT, CHILD_TAIL_LIMIT)
  let stderr = ''

  return new Promise((resolvePromise, reject) => {
    const child = spawn(nodeBin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    liveChildren.add(child)

    let timedOut = false
    let hardTimer
    const cleanup = () => {
      clearTimeout(timer)
      clearTimeout(hardTimer)
      liveChildren.delete(child)
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
      // 兜底：进程组不响应时也要收尾，不能让调用方永久悬挂。
      hardTimer = setTimeout(() => {
        cleanup()
        const body = capture.finish()
        resolvePromise({
          code: null,
          stdout: body.text,
          stderr,
          timedOut: true,
          killConfirmed: false,
          seconds: ((Date.now() - started) / 1000).toFixed(1),
          truncated: body.truncated,
        })
      }, 5000)
    }, timeoutS * 1000)

    child.stdout.on('data', (chunk) => capture.push(chunk))
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
      if (stderr.length > STDERR_LIMIT) stderr = stderr.slice(-STDERR_LIMIT)
    })
    child.on('error', (error) => {
      cleanup()
      reject(error)
    })
    child.on('close', (code, signal) => {
      cleanup()
      const body = capture.finish()
      resolvePromise({
        code,
        signal,
        stdout: body.text,
        stderr: stderr.trim(),
        timedOut,
        killConfirmed: true,
        truncated: body.truncated,
        totalChars: body.total,
        seconds: ((Date.now() - started) / 1000).toFixed(1),
      })
    })
  })
}

/**
 * 给人/模型看的紧凑状态行。只在「不理想」时出现，避免正常路径多花 token。
 * `_meta` 只有 MCP 客户端能看到，模型看不到，因此关键状态必须进正文。
 */
export function outcomeHeader(outcome) {
  const notable = outcome.execution !== 'completed'
    || outcome.result === 'failed'
    || outcome.result === 'partial'
    || outcome.contractOk === false
    || (outcome.warnings?.length ?? 0) > 0
  if (!notable) return ''
  const parts = [`execution=${outcome.execution}`, `result=${outcome.result}`]
  if (outcome.contractOk === false) parts.push('contractOk=false')
  if (outcome.warnings?.length) parts.push(`warnings=${outcome.warnings.length}`)
  return `[dsh: ${parts.join(' ')}]`
}

function buildOutcome({
  execution,
  text,
  seconds,
  sessionId,
  mode,
  cwd,
  truncated,
  extraWarnings = [],
  log,
}) {
  const outcome = {
    ok: execution === 'completed',
    execution,
    result: 'unknown',
    contractOk: false,
    warnings: [...extraWarnings],
    text: '',
    seconds,
    sessionId,
    truncated: Boolean(truncated),
  }

  const head = outcome.warnings.length ? `⚠︎ ${outcome.warnings.join('；')}\n\n` : ''

  if (!text || !text.trim()) {
    if (execution !== 'completed') {
      outcome.text = `${head}任务未完成：${execution}（mode=${mode}, cwd=${cwd}）`
    } else {
      outcome.execution = 'failed'
      outcome.ok = false
      outcome.text = `${head}DSH 返回空结果（mode=${mode}, cwd=${cwd}）`
    }
    return outcome
  }

  const check = validateResult(text, { truncated: Boolean(truncated) })
  outcome.result = check.status
  outcome.contractOk = check.ok
  outcome.warnings.push(...check.warnings)

  if (execution !== 'completed') {
    outcome.warnings.unshift(`执行状态：${execution}`)
    outcome.text = outcome.warnings.length
      ? formatContractWarning(outcome.warnings, text)
      : text
    return outcome
  }

  outcome.text = outcome.warnings.length ? formatContractWarning(outcome.warnings, text) : text
  if (check.status === 'failed') {
    outcome.ok = false
    log('DSH 报告任务失败')
  }
  log(`task done mode=${mode} ${seconds}s chars=${text.length} result=${check.status}`)
  return outcome
}

/**
 * 跑一份任务输入。返回结构化结果，由 MCP / CLI 各自映射到 isError 或退出码。
 *
 * English: run one normalized input and return a structured outcome; MCP and CLI only map it
 * to isError / exit codes. Inputs are validated before anything spawns: the cwd must exist and
 * be a directory, and the timeout is clamped to HARD_TIMEOUT_S. For the one-shot backend the
 * post-run session id is recovered by directory diff and left empty when ambiguous. The trace
 * record is best-effort: a trace write failure is logged and never fails the task.
 */
export async function runTask(input, { cwd, log = () => {}, session } = {}) {
  const targetCwd = resolveCwd(cwd ?? input.cwd)
  const timeoutS = Math.min(input.timeoutS ?? DEFAULT_TIMEOUT_S, HARD_TIMEOUT_S)
  const started = Date.now()
  const startedAt = new Date(started).toISOString()
  const taskId = newTaskId()
  // 只有 one-shot 需要反查会话：它的 id 由 DSH 内部生成。
  const beforeSessions = session ? undefined : listSessionIds(DSH_HOME)

  log(
    `task start id=${taskId} backend=${session ? 'session' : 'oneshot'} mode=${input.mode} cwd=${targetCwd} ` +
    `goal=${sanitize(input.goal).slice(0, 70).replace(/\s+/g, ' ')}`,
  )

  let outcome

  if (session) {
    try {
      const result = await runInSession(input, { label: session, cwd: targetCwd, log })
      const extraWarnings = []
      if (result.execution === 'timeout') {
        extraWarnings.push(result.cancelled ? '任务超时，已取消并确认 DSH 轮次中止' : '任务超时，取消结果未确认')
      }
      if (result.execution === 'execution_unknown') {
        extraWarnings.push('任务状态未知（取消未确认或连接中断），该会话已置脏，后续提交会被拒绝')
      }
      if (result.execution === 'cancelled') extraWarnings.push('任务被取消')
      if (result.error) extraWarnings.push(`错误：${result.error}`)
      outcome = buildOutcome({
        execution: result.execution ?? 'completed',
        text: result.text ?? '',
        seconds: ((Date.now() - started) / 1000).toFixed(1),
        sessionId: result.sessionId,
        mode: input.mode,
        cwd: targetCwd,
        truncated: false,
        extraWarnings,
        log,
      })
    } catch (error) {
      outcome = {
        ok: false,
        execution: 'failed',
        result: 'unknown',
        contractOk: false,
        warnings: [],
        text: `DSH 会话任务失败（session=${session}, mode=${input.mode}, cwd=${targetCwd}）：${error.message}`,
        seconds: ((Date.now() - started) / 1000).toFixed(1),
      }
    }
  } else {
    const prompt = buildPrompt(input, { cwd: targetCwd, taskId })
    const result = await runHeadless({ prompt, cwd: targetCwd, timeoutS, mode: input.mode })

    if (result.timedOut) {
      const confirmed = result.killConfirmed !== false
      outcome = buildOutcome({
        execution: confirmed ? 'timeout' : 'execution_unknown',
        text: result.stdout,
        seconds: result.seconds,
        mode: input.mode,
        cwd: targetCwd,
        truncated: result.truncated,
        extraWarnings: [
          confirmed
            ? `超时（${timeoutS}s）后已终止进程组`
            : `超时（${timeoutS}s）后进程组未确认退出，状态未知`,
        ],
        log,
      })
    } else if (result.code !== 0) {
      const detail = (result.stderr || result.stdout || '(无输出)').slice(-4000)
      outcome = {
        ok: false,
        execution: 'failed',
        result: 'unknown',
        contractOk: false,
        warnings: [],
        text: `DSH 任务失败（exit=${result.code}, ${result.seconds}s, mode=${input.mode}, cwd=${targetCwd}）\n\n${detail}`,
        seconds: result.seconds,
      }
    } else {
      outcome = buildOutcome({
        execution: 'completed',
        text: result.stdout,
        seconds: result.seconds,
        mode: input.mode,
        cwd: targetCwd,
        truncated: result.truncated,
        log,
      })
    }

    if (beforeSessions) {
      const discovered = discoverNewSession(DSH_HOME, beforeSessions)
      if (discovered) outcome.sessionId = discovered
    }
  }

  outcome.taskId = taskId
  try {
    writeTrace(TRACE_DIR, {
      taskId,
      at: startedAt,
      backend: session ? 'session' : 'oneshot',
      mode: input.mode,
      cwd: targetCwd,
      sessionId: outcome.sessionId,
      execution: outcome.execution,
      result: outcome.result,
      warnings: outcome.warnings ?? [],
      seconds: outcome.seconds,
      goal: sanitize(input.goal).slice(0, 200),
      goalDigest: goalDigest(input.goal),
      reportChars: (outcome.text ?? '').length,
    })
  } catch (error) {
    log(`trace 写入失败: ${error.message}`)
  }

  return outcome
}

process.on('exit', () => {
  for (const child of liveChildren) killTree(child)
})
