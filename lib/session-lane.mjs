/**
 * session-lane.mjs — 同一 Session 的串行车道。
 *
 * 目的：绝不让第二个任务的等待者覆盖第一个。每个 sessionId 一条 promise 链，
 * 前一个任务无论成功或失败，后一个才开始。不同 Session 之间互不阻塞。
 *
 * dirty：任务状态未知（超时未确认取消、连接断开、host 异常退出）时置脏，
 * 之后的提交直接拒绝，避免在同一会话里继续叠加可能冲突的修改。
 *
 * English:
 * In-process serial lane per DSH session: every sessionId gets one promise chain, so a second
 * task always waits for the first, whether it succeeded or failed, and a later task can never
 * overwrite an earlier waiter. Different sessions never block each other.
 * Scope: this guarantee lives inside one node process only. Separate bridge processes (for
 * example two MCP servers) are NOT coordinated by it; the MCP entry additionally serializes
 * all tool calls in a single global queue.
 * dirty: when a task's state is unknown (timeout without confirmed cancel, dropped connection,
 * host crash) the lane is marked dirty, and later submissions are rejected with a clear error
 * instead of stacking possibly conflicting edits onto an unfinished turn.
 */

export class DirtySessionError extends Error {
  constructor(sessionId, reason) {
    super(
      `会话 ${sessionId} 的状态未知（${reason}），已停止接受新任务以免与未结束的修改冲突；` +
      `请换一个 session 标签，或确认 DSH 侧已空闲后重试`,
    )
    this.name = 'DirtySessionError'
    this.sessionId = sessionId
    this.reason = reason
  }
}

export class SessionLane {
  constructor(sessionId) {
    this.sessionId = sessionId
    this.tail = Promise.resolve()
    this.depth = 0
    this.dirty = null
  }

  get busy() {
    return this.depth > 0
  }

  /**
   * 排队执行；无论前一个成功或失败，都会继续排。置脏后拒绝执行。
   * English: enqueue behind the previous task whatever its outcome; a dirty lane fails fast
   * with DirtySessionError instead of running, so conflicting edits are never stacked.
   */
  run(job) {
    this.depth += 1
    const invoke = () => {
      if (this.dirty) throw new DirtySessionError(this.sessionId, this.dirty.reason)
      return job()
    }
    const started = this.tail.then(invoke, invoke)
    this.tail = started.then(
      () => undefined,
      () => undefined,
    )
    return started.finally(() => {
      this.depth -= 1
    })
  }

  markDirty(reason) {
    this.dirty = { reason: String(reason), at: new Date().toISOString() }
  }

  clearDirty() {
    this.dirty = null
  }

  assertClean() {
    if (this.dirty) throw new DirtySessionError(this.sessionId, this.dirty.reason)
  }
}

export class LanePool {
  constructor() {
    this.lanes = new Map()
  }

  get(sessionId) {
    let lane = this.lanes.get(sessionId)
    if (!lane) {
      lane = new SessionLane(sessionId)
      this.lanes.set(sessionId, lane)
    }
    return lane
  }
}
