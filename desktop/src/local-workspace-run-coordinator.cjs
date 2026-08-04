const { randomUUID } = require('node:crypto')
const { RunHarness } = require('./run-harness.cjs')
const {
  RUN_STATUSES,
  cleanRunMaxRounds,
  cleanText,
  isSupportedAgentKind,
} = require('./local-workspace-inputs.cjs')

const TASK_ID = /^[A-Za-z0-9._:-]{1,120}$/

class LocalWorkspaceRunCoordinator {
  constructor(options) {
    this.preparingRuns = options.preparingRuns
    this.activeRuns = options.activeRuns
    this.createRunId = options.createRunId
    this.getRunSilenceWarningMs = typeof options.getRunSilenceWarningMs === 'function'
      ? options.getRunSilenceWarningMs
      : () => options.runSilenceWarningMs
    this.setTimeout = options.setTimeout || setTimeout
    this.clearTimeout = options.clearTimeout || clearTimeout
    this.isShuttingDown = options.isShuttingDown
    this.setShuttingDown = options.setShuttingDown
    this.checkpointRun = options.checkpointRun
    this.hasRunLedger = typeof options.hasRunLedger === 'function'
      ? options.hasRunLedger
      : () => false
    this.finishRunCheckpoint = options.finishRunCheckpoint
    this.scheduleRunCheckpoint = options.scheduleRunCheckpoint
    this.emitChanged = options.emitChanged
    this.emit = options.emit
  }

  createController(mode, targetKinds, threadRootId, maxRounds = 0, unlimitedRounds = false) {
    const controller = new AbortController()
    let done = false
    let resolveDone
    controller.done = new Promise(resolve => { resolveDone = resolve })
    controller.resolveDone = () => {
      if (done) return
      done = true
      resolveDone()
    }
    controller.mode = mode
    controller.runId = String(this.createRunId() || '')
    controller.taskId = TASK_ID.test(String(threadRootId || '')) ? String(threadRootId) : ''
    controller.targetKinds = [...targetKinds]
    controller.completedKinds = []
    controller.failedKinds = []
    controller.currentKind = ''
    controller.progress = []
    controller.threadRootId = threadRootId
    controller.currentRound = 0
    controller.unlimitedRounds = mode === 'auto' && unlimitedRounds === true
    controller.maxRounds = mode === 'auto' && !controller.unlimitedRounds
      ? cleanRunMaxRounds(maxRounds)
      : 0
    controller.startedAt = Date.now()
    controller.stopReason = ''
    controller.harness = null
    controller.agentFailureReasons = new Map()
    controller.silenceTimers = new Map()
    return controller
  }

  checkpointRequired(groupId, controller, status) {
    const persisted = this.checkpointRun(groupId, controller, status)
    if (this.hasRunLedger() && persisted !== true) {
      throw new Error('LOCAL_RUN_PERSIST_FAILED')
    }
    return persisted
  }

  isGroupBusy(groupId) {
    return this.preparingRuns.has(groupId) || this.activeRuns.has(groupId)
  }

  reserve(
    groupId, mode, targetKinds, threadRootId = '', maxRounds = 0, unlimitedRounds = false,
  ) {
    if (this.isShuttingDown()) throw new Error('LOCAL_AGENT_EXECUTION_STOPPED')
    if (this.isGroupBusy(groupId)) throw new Error('LOCAL_GROUP_RUNNING')
    const controller = this.createController(
      mode, targetKinds, threadRootId, maxRounds, unlimitedRounds,
    )
    controller.groupId = groupId
    this.preparingRuns.set(groupId, controller)
    try {
      this.checkpointRequired(groupId, controller, 'preparing')
      this.emitChanged()
    } catch (error) {
      if (this.preparingRuns.get(groupId) === controller) this.preparingRuns.delete(groupId)
      controller.abort()
      controller.resolveDone()
      throw error
    }
    return controller
  }

  bindTask(groupId, controller, taskId, threadRootId = '') {
    if (this.preparingRuns.get(groupId) !== controller || controller.signal.aborted) {
      throw new Error('LOCAL_AGENT_EXECUTION_STOPPED')
    }
    const nextTaskId = String(taskId || '')
    const nextThreadRootId = String(threadRootId || '')
    if (!TASK_ID.test(nextTaskId)
        || (nextThreadRootId && !TASK_ID.test(nextThreadRootId))) {
      throw new Error('LOCAL_RUN_TASK_INVALID')
    }
    const previousTaskId = controller.taskId
    const previousThreadRootId = controller.threadRootId
    controller.taskId = nextTaskId
    controller.threadRootId = nextThreadRootId
    try {
      this.checkpointRequired(groupId, controller, 'preparing')
    } catch (error) {
      controller.taskId = previousTaskId
      controller.threadRootId = previousThreadRootId
      throw error
    }
    return true
  }

  releasePreparation(groupId, controller) {
    if (this.preparingRuns.get(groupId) !== controller) return false
    this.preparingRuns.delete(groupId)
    this.finishRunCheckpoint(
      groupId,
      controller,
      controller.signal.aborted
        ? (controller.stopReason === 'shutdown' ? 'interrupted' : 'stopped')
        : 'failed',
    )
    try {
      this.emitChanged()
    } finally {
      controller.resolveDone()
    }
    return true
  }

  begin(
    groupId, mode, targetKinds, threadRootId, reservation = null, maxRounds = 0,
    unlimitedRounds = false,
  ) {
    if (this.isShuttingDown()) throw new Error('LOCAL_AGENT_EXECUTION_STOPPED')
    let controller = reservation
    const reserved = Boolean(controller)
    if (controller) {
      if (this.preparingRuns.get(groupId) !== controller || controller.signal.aborted) {
        throw new Error('LOCAL_AGENT_EXECUTION_STOPPED')
      }
      if (this.activeRuns.has(groupId)) throw new Error('LOCAL_GROUP_RUNNING')
    } else {
      if (this.isGroupBusy(groupId)) throw new Error('LOCAL_GROUP_RUNNING')
      controller = this.createController(
        mode, targetKinds, threadRootId, maxRounds, unlimitedRounds,
      )
    }
    controller.mode = mode
    controller.groupId = groupId
    controller.taskId = TASK_ID.test(String(controller.taskId || ''))
      ? controller.taskId
      : (TASK_ID.test(String(threadRootId || '')) ? String(threadRootId) : '')
    controller.targetKinds = [...targetKinds]
    controller.completedKinds = []
    controller.failedKinds = []
    controller.currentKind = ''
    controller.progress = []
    controller.threadRootId = threadRootId
    controller.currentRound = 0
    controller.unlimitedRounds = mode === 'auto'
      && (unlimitedRounds === true || controller.unlimitedRounds === true)
    controller.maxRounds = mode === 'auto' && !controller.unlimitedRounds
      ? cleanRunMaxRounds(maxRounds || controller.maxRounds)
      : 0
    controller.startedAt = Date.now()
    controller.stopReason = ''
    this.activeRuns.set(groupId, controller)
    try {
      this.checkpointRequired(groupId, controller, 'running')
      if (reserved) this.preparingRuns.delete(groupId)
      this.emitChanged()
    } catch (error) {
      if (this.activeRuns.get(groupId) === controller) this.activeRuns.delete(groupId)
      if (reserved) this.preparingRuns.set(groupId, controller)
      else {
        controller.abort()
        controller.resolveDone()
      }
      throw error
    }
    return controller
  }

  finish(groupId, controller, status) {
    if (controller.finished) return
    controller.finished = true
    this.clearRunSilence(controller)
    const finalStatus = RUN_STATUSES.has(status) ? status : 'failed'
    this.finishRunCheckpoint(groupId, controller, finalStatus)
    const ownsActiveRun = this.activeRuns.get(groupId) === controller
    if (ownsActiveRun) this.activeRuns.delete(groupId)
    const payload = {
      groupId: cleanText(groupId, 100),
      runId: cleanText(controller.runId, 120),
      taskId: cleanText(controller.taskId, 120),
      mode: controller.mode === 'auto' ? 'auto' : 'manual',
      status: finalStatus,
      threadRootId: cleanText(controller.threadRootId, 100),
      targetKinds: controller.targetKinds.filter(isSupportedAgentKind),
      completedKinds: controller.completedKinds.filter(isSupportedAgentKind),
      failedKinds: controller.failedKinds.filter(isSupportedAgentKind),
      startedAt: Number.isFinite(controller.startedAt) ? controller.startedAt : Date.now(),
      finishedAt: Date.now(),
    }
    try {
      if (ownsActiveRun) this.emitChanged()
    } catch {}
    try {
      this.emit('run-finished', payload)
    } catch {}
    controller.resolveDone()
  }

  ensureHarness(group, controller, threadRootId = '') {
    if (!controller) return null
    if (!controller.harness) {
      controller.harness = new RunHarness({
        runId: controller.runId || randomUUID(),
        groupId: group.id,
        threadRootId,
        targetKinds: controller.targetKinds,
        createId: randomUUID,
      })
    }
    return controller.harness
  }

  emitRunEvent(event) {
    if (!event) return
    try { this.emit('run-event', event) } catch {}
  }

  clearAgentSilence(controller, kind, round, agentRunId = '') {
    const key = agentRunId || `${kind}:${round}`
    const timer = controller?.silenceTimers?.get(key)
    if (timer) this.clearTimeout(timer)
    controller?.silenceTimers?.delete(key)
  }

  armAgentSilence(controller, kind, round, agentRunId = '') {
    const warningMs = this.getRunSilenceWarningMs()
    if (!controller || !warningMs) return
    const key = agentRunId || `${kind}:${round}`
    this.clearAgentSilence(controller, kind, round, agentRunId)
    const timer = this.setTimeout(() => {
      const warning = controller.harness?.markSilent(kind, round, agentRunId)
      if (warning) {
        this.emitRunEvent(warning)
        this.scheduleRunCheckpoint(controller.groupId, controller)
      }
    }, warningMs)
    timer.unref?.()
    controller.silenceTimers.set(key, timer)
  }

  clearRunSilence(controller) {
    for (const timer of controller?.silenceTimers?.values?.() || []) this.clearTimeout(timer)
    controller?.silenceTimers?.clear?.()
  }

  stop(groupId, runId) {
    const controller = this.activeRuns.get(groupId) || this.preparingRuns.get(groupId)
    if (!controller || !runId || controller.runId !== runId) return false
    controller.stopReason ||= 'user'
    controller.abort()
    return true
  }

  async stopAll() {
    this.setShuttingDown(true)
    const controllers = new Set([
      ...this.preparingRuns.values(),
      ...this.activeRuns.values(),
    ])
    for (const controller of controllers) {
      controller.stopReason ||= 'shutdown'
      controller.abort()
    }
    await Promise.allSettled([...controllers].map(controller => controller.done))
  }
}

module.exports = { LocalWorkspaceRunCoordinator }
