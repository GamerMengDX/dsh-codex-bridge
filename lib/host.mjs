/**
 * host.mjs — 常驻 DSH host + 会话续接后端。
 *
 * 并发模型：
 *   - 每个 sessionId 一条 SessionLane，任务严格串行；等待者按 sessionId 唯一，
 *     绝不会被后一个任务覆盖。
 *   - 不同 sessionId 之间并行，事件按 sessionId 分发，不会串话。
 *
 * 结果关联：
 *   - `turn/start` / `turn/end` 带自增 turn 号；建会话时用 `session.history`
 *     播种当前最大 turn，之后按 expected = max+1 精确匹配。
 *   - 匹配不到（历史失效）时降级为「prompt 之后第一个 turn/end」，并在日志留痕。
 *
 * 生命周期：
 *   - 超时 → session.cancel → 等待 aborted 或 host/session-status(false)；
 *     确认才报 timeout（并注明已取消），否则 execution_unknown + 置脏。
 *   - 置脏会话拒绝后续任务，避免与可能仍在运行的修改叠加。
 *   - mux / host 连接断开、host 退出 → 未完成等待者统一 unknown，并置脏。
 *
 * English:
 * Persistent DSH host plus in-session continuation backend.
 * Concurrency: one SessionLane per sessionId, so tasks in the same session run strictly
 * serially and a later task can never overwrite an earlier waiter. Different sessionIds run in
 * parallel and events are dispatched by sessionId, so they cannot cross-talk. Each Host owns
 * its own LanePool, so this serialization is IN-PROCESS only — separate bridge processes are
 * not coordinated (the MCP entry adds its own global queue on top of it).
 * Result correlation: turn/start and turn/end carry a monotonic turn number; on session
 * creation the current max turn is seeded from session.history, then matched exactly. If the
 * history is unavailable, matching degrades to "the first turn/end after the prompt" and says
 * so in the log.
 * Lifecycle: timeout → session.cancel → wait for aborted or an idle session-status; only a
 * confirmed cancellation is reported as `timeout`, otherwise execution_unknown + marked dirty.
 * A dirty lane rejects later submissions, so edits never stack onto a possibly running turn.
 * If a socket drops or the host exits, every unfinished waiter resolves as unknown.
 */

import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { buildPrompt } from './protocol.mjs'
import {
  DSH_BIN,
  DSH_HOME,
  HOST_PORTS,
  HOST_ROOT,
  MODE_PATCH,
  chooseNode,
  log,
  readApiKey,
} from './config.mjs'
import { ensureSession, canonicalCwd, touchSession } from './registry.mjs'
import { DirtySessionError, LanePool } from './session-lane.mjs'

const READY_TIMEOUT_MS = 90_000
const CANCEL_RPC_TIMEOUT_MS = 5_000
const CANCEL_GRACE_MS = 15_000
const STATUS_IDLE_GRACE_MS = 3_000
const PROMPT_RPC_TIMEOUT_MS = 120_000

const hosts = new Map()
const NODE_BIN = chooseNode()
const API_KEY = readApiKey()

/* ------------------------------------------------------------- home 准备 */

function pidFile(mode) {
  return join(HOST_ROOT, `${mode}.pid`)
}

function writePidFile(mode, pid, port) {
  mkdirSync(HOST_ROOT, { recursive: true, mode: 0o700 })
  writeFileSync(pidFile(mode), JSON.stringify({ pid, port, startedAt: new Date().toISOString() }), { mode: 0o600 })
}

function readPidFile(mode) {
  try {
    return JSON.parse(readFileSync(pidFile(mode), 'utf8'))
  } catch {
    return undefined
  }
}

function clearPidFile(mode, pid) {
  const record = readPidFile(mode)
  if (record && pid !== undefined && record.pid !== pid) return
  try {
    rmSync(pidFile(mode), { force: true })
  } catch {
    /* ignore */
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function modelSettingsBlock() {
  try {
    const yaml = readFileSync(join(DSH_HOME, 'settings.yaml'), 'utf8')
    const match = yaml.match(/^agent-default-model:\n(?:[ \t]+.*\n)+/m)
    return match ? match[0] : ''
  } catch {
    return ''
  }
}

/* English: build a per-mode home under HOST_ROOT: a settings.yaml that sets the permission
 * preset, the web profile directory, and the mode's patch overlay. The overlay is written into
 * the profile because the `web` subcommand does not accept --patch. */
function prepareHome(mode) {
  const home = join(HOST_ROOT, mode)
  mkdirSync(home, { recursive: true, mode: 0o700 })
  try {
    chmodSync(home, 0o700)
  } catch {
    /* ignore */
  }

  const settings = join(home, 'settings.yaml')
  if (!existsSync(settings)) {
    writeFileSync(
      settings,
      `${modelSettingsBlock()}permission:\n  defaultPreset: ${mode === 'edit' ? 'workspace-write' : 'read-only'}\n`,
      { mode: 0o600 },
    )
  }

  const profileDir = join(home, 'profiles', 'web')
  if (!existsSync(profileDir)) {
    spawnSync(NODE_BIN, ['--expose-internals', DSH_BIN, '--profile', 'web', '--help'], {
      env: { ...process.env, DSH_HOME: home },
      stdio: 'ignore',
    })
  }
  if (!existsSync(profileDir)) mkdirSync(profileDir, { recursive: true })

  // web 子命令不接受 --patch，overlay 落在 profile 的 patch 层。
  const overlay = readFileSync(MODE_PATCH[mode], 'utf8')
  const target = join(profileDir, 'cordis.patch.yml')
  const current = existsSync(target) ? readFileSync(target, 'utf8') : ''
  if (current !== overlay) writeFileSync(target, overlay, { mode: 0o600 })

  return home
}

/* ------------------------------------------------------------------ RPC */

async function request(port, method, payload, timeoutMs = 120_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`${method} HTTP ${res.status}: ${text.slice(0, 200)}`)
    let envelope
    try {
      envelope = JSON.parse(text)
    } catch {
      throw new Error(`${method} 返回非 JSON: ${text.slice(0, 200)}`)
    }
    if (!envelope.result?.ok) {
      const error = envelope.result?.error ?? {}
      throw new Error(`${method} 失败: ${error.code ?? 'error'} ${error.message ?? JSON.stringify(error).slice(0, 200)}`)
    }
    return envelope.result.value
  } finally {
    clearTimeout(timer)
  }
}

/* ----------------------------------------------------------------- host */

class Host {
  constructor(mode, port, home) {
    this.mode = mode
    this.port = port
    this.home = home
    this.proc = undefined
    this.pid = undefined
    this.mux = undefined
    this.hostWs = undefined
    this.muxConnecting = undefined
    this.hostConnecting = undefined
    this.lanes = new LanePool()
    this.turns = new Map()
    this.seeded = new Set()
    this.waiters = new Map()
    this.running = new Map()
    this.closed = false
  }

  lane(sessionId) {
    return this.lanes.get(sessionId)
  }

  async isReady() {
    try {
      await request(this.port, 'host.describe', {}, 2000)
      return true
    } catch {
      return false
    }
  }

  async start() {
    if (await this.isReady()) {
      const record = readPidFile(this.mode)
      if (!record || record.port !== this.port || !pidAlive(record.pid)) {
        throw new Error(
          `端口 ${this.port} 已被不是本桥接启动的进程占用（模式 ${this.mode}）。` +
          `请设置 DSH_HOST_PORT_${this.mode.toUpperCase()} 换一个端口，或先停掉占用者。`,
        )
      }
      log(`host ${this.mode} 复用已在监听 :${this.port}（pid ${record.pid}）`)
      return
    }
    clearPidFile(this.mode)

    const args = ['--expose-internals', DSH_BIN, '--profile', 'web', '--port', String(this.port), '--no-open']
    const env = { ...process.env, DSH_HOME: this.home }
    if (API_KEY) env.DEEPSEEK_API_KEY = API_KEY
    this.proc = spawn(NODE_BIN, args, { cwd: HOST_ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] })
    this.pid = this.proc.pid
    this.proc.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim()
      if (text) log(`host ${this.mode}: ${text.slice(0, 300)}`)
    })
    if (this.proc.pid) writePidFile(this.mode, this.proc.pid, this.port)
    this.proc.on('exit', (code) => {
      log(`host ${this.mode} 退出 code=${code}`)
      clearPidFile(this.mode, this.pid)
      this.proc = undefined
      this.failAll('execution_unknown', `DSH host（${this.mode}）退出`)
    })

    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (await this.isReady()) {
        log(`host ${this.mode} ready :${this.port}`)
        return
      }
      if (!this.proc) throw new Error(`DSH host（${this.mode}）启动即退出，端口 ${this.port} 可能被占用`)
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error(`DSH host（${this.mode}）在 ${READY_TIMEOUT_MS / 1000}s 内未就绪（端口 ${this.port}）`)
  }

  async ensureStreams() {
    if (!this.mux || this.mux.readyState !== 1) await this.connectMux()
    if (!this.hostWs || this.hostWs.readyState !== 1) await this.connectHost()
  }

  connectMux() {
    if (this.muxConnecting) return this.muxConnecting
    if (typeof WebSocket === 'undefined') {
      return Promise.reject(new Error('当前 node 没有全局 WebSocket（需要 >= 22）'))
    }
    this.muxConnecting = new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}/api/events.mux`)
      this.mux = ws
      ws.onopen = () => {
        this.muxConnecting = undefined
        resolve()
      }
      ws.onerror = () => {
        this.muxConnecting = undefined
        reject(new Error('mux WebSocket 连接失败'))
      }
      ws.onmessage = (event) => this.onMuxFrame(event.data)
      ws.onclose = () => {
        this.mux = undefined
        this.muxConnecting = undefined
        if (!this.closed) {
          this.failAll('execution_unknown', 'mux 连接断开')
          setTimeout(() => this.connectMux().catch(() => {}), 500)
        }
      }
    })
    return this.muxConnecting
  }

  connectHost() {
    if (this.hostConnecting) return this.hostConnecting
    this.hostConnecting = new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}/api/events.host`)
      this.hostWs = ws
      ws.onopen = () => {
        this.hostConnecting = undefined
        resolve()
      }
      ws.onerror = () => {
        this.hostConnecting = undefined
        reject(new Error('host WebSocket 连接失败'))
      }
      ws.onmessage = (event) => this.onHostFrame(event.data)
      ws.onclose = () => {
        this.hostWs = undefined
        this.hostConnecting = undefined
        if (!this.closed) setTimeout(() => this.connectHost().catch(() => {}), 500)
      }
    })
    return this.hostConnecting
  }

  onMuxFrame(raw) {
    const frame = this.parse(raw)
    if (!frame || frame.method !== 'session/event') return
    const sessionId = frame.payload?.sessionId
    const event = frame.payload?.event
    if (!sessionId || !event) return

    if (event.type === 'turn/start') {
      const turn = event.data?.turn
      if (typeof turn === 'number') this.bumpTurn(sessionId, turn)
      const waiter = this.waiters.get(sessionId)
      if (waiter && typeof turn === 'number') waiter.started = true
      return
    }

    if (event.type === 'turn/end') {
      const turn = event.data?.turn
      if (typeof turn === 'number') this.bumpTurn(sessionId, turn)
      const waiter = this.waiters.get(sessionId)
      if (!waiter) return
      if (typeof turn === 'number') {
        if (turn < waiter.turn) return
        if (turn > waiter.turn && !waiter.permissive) {
          log(`session ${sessionId} 出现非预期 turn ${turn}（expected ${waiter.turn}），忽略`)
          return
        }
      }
      this.settle(waiter, this.turnOutcome(waiter, event.data?.reason))
      return
    }

    if (event.type === 'assistant/message') {
      const waiter = this.waiters.get(sessionId)
      if (!waiter) return
      const text = (event.data?.message?.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
        .trim()
      if (text) waiter.lastText = text
    }
  }

  onHostFrame(raw) {
    const frame = this.parse(raw)
    if (!frame) return
    const sessionId = frame.payload?.sessionId
    if (!sessionId) return

    if (frame.method === 'host/session-status') {
      this.running.set(sessionId, frame.payload.running === true)
      const waiter = this.waiters.get(sessionId)
      if (!waiter || frame.payload.running === true) return
      // 空闲信号可能早于 turn/end 到达，给一个短窗口，避免丢结果。
      clearTimeout(waiter.statusTimer)
      waiter.statusTimer = setTimeout(() => {
        if (waiter.settled) return
        this.lane(sessionId).markDirty('会话已空闲但未观察到轮次结束')
        this.settle(waiter, {
          execution: 'execution_unknown',
          text: waiter.lastText,
          reason: { kind: 'idle-without-turn-end' },
        })
      }, STATUS_IDLE_GRACE_MS)
      return
    }

    if (frame.method === 'host/agent-error') {
      const waiter = this.waiters.get(sessionId)
      if (waiter) waiter.errorMessage = String(frame.payload?.message ?? 'agent error').slice(0, 400)
    }
  }

  parse(raw) {
    try {
      return JSON.parse(raw)
    } catch {
      return undefined
    }
  }

  bumpTurn(sessionId, turn) {
    const known = this.turns.get(sessionId) ?? 0
    if (turn > known) this.turns.set(sessionId, turn)
  }

  turnOutcome(waiter, reason) {
    const kind = reason?.kind ?? 'completed'
    if (kind === 'max-tokens') return { execution: 'completed', text: waiter.lastText, truncatedByModel: true }
    if (kind === 'aborted') {
      return waiter.timedOut
        ? { execution: 'timeout', text: waiter.lastText, cancelled: true, reason }
        : { execution: 'cancelled', text: waiter.lastText, reason }
    }
    if (kind === 'blocked') {
      return { execution: 'failed', text: waiter.lastText, error: '任务被阻塞（审批或策略拒绝）', reason }
    }
    if (kind === 'error') {
      const detail = waiter.errorMessage ?? JSON.stringify(reason?.error ?? {}).slice(0, 300)
      return { execution: 'failed', text: waiter.lastText, error: detail, reason }
    }
    return { execution: 'completed', text: waiter.lastText, reason }
  }

  createWaiter(sessionId, turn, timeoutS, { permissive = false } = {}) {
    const waiter = {
      sessionId,
      turn,
      permissive,
      settled: false,
      started: false,
      timedOut: false,
      lastText: '',
      errorMessage: undefined,
      timer: undefined,
      graceTimer: undefined,
      statusTimer: undefined,
      resolve: undefined,
    }
    waiter.promise = new Promise((resolve) => {
      waiter.resolve = resolve
    })
    waiter.timer = setTimeout(() => this.onTimeout(waiter, timeoutS), timeoutS * 1000)
    this.waiters.set(sessionId, waiter)
    return waiter
  }

  settle(waiter, outcome) {
    if (waiter.settled) return
    waiter.settled = true
    clearTimeout(waiter.timer)
    clearTimeout(waiter.graceTimer)
    clearTimeout(waiter.statusTimer)
    if (this.waiters.get(waiter.sessionId) === waiter) this.waiters.delete(waiter.sessionId)
    waiter.resolve({ ...outcome, sessionId: waiter.sessionId, turn: waiter.turn })
  }

  async cancel(sessionId) {
    try {
      const value = await request(this.port, 'session.cancel', { sessionId }, CANCEL_RPC_TIMEOUT_MS)
      return value?.accepted === true
    } catch (error) {
      log(`session ${sessionId} 取消失败: ${error.message}`)
      return false
    }
  }

  /* English: timeout is not yet a verdict. Send session.cancel, then give the turn a grace
   * window to actually finish; only a turn that ends as `aborted` counts as a confirmed
   * cancel. If nothing is confirmed in time the lane is marked dirty and the outcome is
   * execution_unknown, because DSH may still be running the task. */
  onTimeout(waiter, timeoutS) {
    if (waiter.settled) return
    waiter.timedOut = true
    log(`session ${waiter.sessionId} turn ${waiter.turn} 超时（${timeoutS}s），尝试取消`)
    this.cancel(waiter.sessionId)
    clearTimeout(waiter.graceTimer)
    waiter.graceTimer = setTimeout(() => {
      if (waiter.settled) return
      this.lane(waiter.sessionId).markDirty(`超时且取消未确认（turn ${waiter.turn}）`)
      this.settle(waiter, {
        execution: 'execution_unknown',
        text: waiter.lastText,
        reason: { kind: 'timeout-unconfirmed' },
      })
    }, CANCEL_GRACE_MS)
  }

  failAll(execution, reason) {
    for (const waiter of [...this.waiters.values()]) {
      this.lane(waiter.sessionId).markDirty(reason)
      this.settle(waiter, { execution, text: waiter.lastText, reason: { kind: 'connection-lost', message: reason } })
    }
  }

  async seedTurn(sessionId) {
    const value = await request(this.port, 'session.history', { sessionId, maxMessages: 200 }, 15_000)
    let max = 0
    for (const entry of value?.events ?? []) {
      const turn = entry?.event?.data?.turn
      if (typeof turn === 'number' && turn > max) max = turn
    }
    return max
  }

  /* English: submit one turn for a session and resolve when that turn ends. Running inside
   * lane.run() is what makes same-session tasks strictly sequential; the expected turn number
   * is max+1 after seeding from history, and `permissive` degrades to the first turn/end when
   * seeding failed. A rejected session.prompt fails this waiter instead of hanging. */
  async prompt(sessionId, text, timeoutS) {
    const lane = this.lane(sessionId)
    return lane.run(async () => {
      try {
        lane.assertClean()
      } catch (error) {
        if (error instanceof DirtySessionError) throw error
        throw error
      }

      await this.ensureStreams()

      let seeded = this.seeded.has(sessionId)
      let max = this.turns.get(sessionId) ?? 0
      if (!seeded) {
        try {
          max = Math.max(max, await this.seedTurn(sessionId))
          this.turns.set(sessionId, max)
          seeded = true
          this.seeded.add(sessionId)
        } catch (error) {
          log(`session ${sessionId} 轮次播种失败，降级为首个 turn/end 匹配: ${error.message}`)
        }
      }

      const waiter = this.createWaiter(sessionId, max + 1, timeoutS, { permissive: !seeded })

      try {
        const accepted = await request(
          this.port,
          'session.prompt',
          { sessionId, mode: 'queue', content: [{ type: 'text', text }] },
          PROMPT_RPC_TIMEOUT_MS,
        )
        if (accepted?.accepted !== true) throw new Error('session.prompt 未被接受')
      } catch (error) {
        this.settle(waiter, { execution: 'failed', text: '', error: error.message })
      }

      return waiter.promise
    })
  }

  stop() {
    this.closed = true
    try {
      this.mux?.close()
    } catch {
      /* ignore */
    }
    try {
      this.hostWs?.close()
    } catch {
      /* ignore */
    }
    this.failAll('execution_unknown', 'host 正在关闭')
    if (this.proc) {
      clearPidFile(this.mode, this.pid)
      this.proc.kill('SIGTERM')
      this.proc = undefined
    }
  }
}

const liveHosts = new Set()
const hostStarting = new Map()

async function ensureHost(mode) {
  const existing = hosts.get(mode)
  if (existing) {
    await existing.start()
    return existing
  }

  // 并发首次调用只允许启动一个 host：否则两个 Host 实例会抢同一个端口。
  let starting = hostStarting.get(mode)
  if (!starting) {
    starting = (async () => {
      const home = prepareHome(mode)
      const host = new Host(mode, HOST_PORTS[mode], home)
      await host.start()
      hosts.set(mode, host)
      liveHosts.add(host)
      return host
    })()
    hostStarting.set(mode, starting)
    starting.catch(() => {}).finally(() => hostStarting.delete(mode))
  }
  return starting
}

export function shutdownHosts() {
  for (const host of liveHosts) host.stop()
  liveHosts.clear()
  hosts.clear()
}

process.on('exit', () => {
  for (const host of liveHosts) host.stop()
})
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shutdownHosts()
    process.exit(0)
  })
}

/* ------------------------------------------------------------ 续接执行 */

export async function runInSession(input, { label, cwd, log: taskLog = log }) {
  const mode = input.mode
  const canonical = canonicalCwd(cwd)
  const { entry, created, idMigrated } = ensureSession(HOST_ROOT, { label, mode, cwd: canonical })

  if (idMigrated) {
    taskLog(`会话 ${label} 使用旧版 ID ${entry.id}（保持历史兼容）`)
  }

  const host = await ensureHost(mode)
  await request(host.port, 'session.create', { sessionId: entry.id, cwd: canonical })

  const timeoutS = input.timeoutS ?? 600
  const prompt = buildPrompt(input, { cwd: canonical, compact: true })
  taskLog(`session prompt session=${entry.id} cwd=${canonical} timeout=${timeoutS}s`)

  const outcome = await host.prompt(entry.id, prompt, timeoutS)
  touchSession(HOST_ROOT, entry.id)
  return { ...outcome, sessionId: entry.id, created }
}
