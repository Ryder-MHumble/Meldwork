const {
  DEFAULT_MAX_OUTPUT_CHARS,
  traceCapsuleFromAgentRun,
} = require('./run-harness.cjs')
const {
  MAX_SYSTEM_PARAM_TEXT_CHARS,
  RECOVERABLE_AGENT_STATUSES,
  RUN_LEDGER_CHECKPOINT_DELAY_MS,
  cleanText,
  isSupportedAgentKind,
  normalizeLoadedMessage,
  terminalMessageContent,
  terminalStatusPrefix,
  terminalStatusPrefixFromMessage,
} = require('./local-workspace-inputs.cjs')

class LocalWorkspaceRunLedger {
  constructor(options) {
    this.runLedger = options.runLedger
    this.state = options.state
    this.save = options.save
    this.createId = options.createId
    this.now = options.now
    this.agentLabel = options.agentLabel
    this.preserveWaitingRun = options.preserveWaitingRun
    this.preparingRuns = options.preparingRuns
    this.timers = options.timers
  }

  restoreInterruptedRuns() {
    let recovered = []
    let records = []
    try {
      recovered = this.runLedger?.recoverInterrupted?.({
        preserveWaitingRun: this.preserveWaitingRun,
      }) || []
      records = this.runLedger?.list?.() || recovered
    } catch {
      return
    }
    const state = this.state()
    let changed = false
    for (const record of records) {
      const group = state.groups.find(item => item.id === record.groupId)
      if (!group) {
        try { this.runLedger?.deleteGroup?.(record.groupId) } catch {}
        continue
      }
      for (const agentRun of Array.isArray(record.agentRuns) ? record.agentRuns : []) {
        const status = String(agentRun?.status || '').toLowerCase()
        if (!RECOVERABLE_AGENT_STATUSES.has(status)
            || !isSupportedAgentKind(agentRun?.kind)) continue
        const output = cleanText(agentRun.output, DEFAULT_MAX_OUTPUT_CHARS)
        const trace = traceCapsuleFromAgentRun({
          ...agentRun,
          summary: output || agentRun.reason || '',
        }, {
          runId: record.runId,
          status,
          context: {
            ...agentRun.context,
            ...(record.contextPackState === 'legacy-unavailable'
              && !agentRun.context?.contextPackId
              ? { contextPackState: 'legacy-unavailable' }
              : {}),
          },
        })
        if (!trace) continue
        const label = this.agentLabel(agentRun.kind)
        const completed = status === 'completed' || status === 'partial'
        const interrupted = status === 'interrupted'
        const stopped = status === 'stopped'
        const reason = cleanText(agentRun.reason, MAX_SYSTEM_PARAM_TEXT_CHARS)
          || (status === 'timeout' ? 'LOCAL_AGENT_TIMEOUT' : 'LOCAL_AGENT_UNKNOWN_FAILURE')
        const fallbackContent = terminalStatusPrefix(label, status, reason)
        const existingMessage = state.messages.find(message => (
          message.trace?.agentRunId === trace.agentRunId
        ))
        if (existingMessage) {
          if (!completed && output) {
            const prefix = terminalStatusPrefixFromMessage(
              existingMessage, label, status, reason,
            )
            const content = terminalMessageContent(prefix, output)
            if (content !== existingMessage.content) {
              existingMessage.content = content
              changed = true
            }
          }
          continue
        }
        const duplicateStableFailure = ['failed', 'timeout'].includes(status)
          && state.messages.some(message => (
            message.groupId === group.id
              && message.role === 'system'
              && message.agentKind === agentRun.kind
              && message.system?.key === 'system.agentCallFailed'
              && cleanText(message.system?.params?.reason, MAX_SYSTEM_PARAM_TEXT_CHARS) === reason
              && message.trace?.runId === trace.runId
              && message.trace?.status === status
              && message.trace?.agentRunId !== trace.agentRunId
              && (!output || message.content === terminalMessageContent(fallbackContent, output))
          ))
        if (duplicateStableFailure) continue
        const system = completed
          ? null
          : interrupted
            ? { key: 'system.agentInterrupted', params: { agent: label } }
            : stopped
              ? { key: 'system.agentStopped', params: { agent: label } }
              : { key: 'system.agentCallFailed', params: { agent: label, reason } }
        const message = normalizeLoadedMessage({
          id: this.createId(),
          groupId: group.id,
          role: completed ? 'agent' : 'system',
          agentKind: agentRun.kind,
          content: completed
            ? output
            : terminalMessageContent(fallbackContent, output),
          createdAt: this.now(),
          threadRootId: record.threadRootId,
          system,
          trace,
        })
        if (!message) continue
        state.messages.push(message)
        group.updatedAt = message.createdAt
        changed = true
      }
    }
    if (changed) this.save()
  }

  record(groupId, controller, status = '') {
    const group = this.state().groups.find(item => item.id === groupId)
    const agentRuns = (controller.harness?.snapshot?.() || []).map((agentRun) => {
      const reason = controller.agentFailureReasons?.get(agentRun.agentRunId) || ''
      return reason ? { ...agentRun, reason } : agentRun
    })
    return {
      runId: controller.runId,
      taskId: controller.taskId,
      contextPackId: controller.contextPackId,
      contextPackState: 'captured',
      groupId,
      threadRootId: controller.threadRootId,
      mode: controller.mode === 'auto' ? 'auto' : 'manual',
      targetKinds: controller.targetKinds,
      status: status || (this.preparingRuns.get(groupId) === controller ? 'preparing' : 'running'),
      startedAt: controller.startedAt,
      updatedAt: Date.now(),
      reason: controller.stopReason,
      permissionMode: group?.allowWrite ? 'workspace-write' : 'read-only',
      currentRound: controller.currentRound,
      maxRounds: controller.maxRounds,
      unlimitedRounds: controller.unlimitedRounds,
      budget: controller.budget?.snapshot?.(),
      attemptHistory: controller.attemptHistory,
      continuation: controller.continuation,
      agentRuns,
    }
  }

  checkpoint(groupId, controller, status = '') {
    if (!this.runLedger || !controller?.runId) return false
    try {
      this.runLedger.checkpoint(this.record(groupId, controller, status))
      return true
    } catch {
      return false
    }
  }

  schedule(groupId, controller) {
    if (!this.runLedger || !controller?.runId) return
    const key = controller.runId
    const previous = this.timers.get(key)
    if (previous) clearTimeout(previous)
    const timer = setTimeout(() => {
      this.timers.delete(key)
      this.checkpoint(groupId, controller)
    }, RUN_LEDGER_CHECKPOINT_DELAY_MS)
    timer.unref?.()
    this.timers.set(key, timer)
  }

  finish(groupId, controller, status) {
    if (!this.runLedger || !controller?.runId) return
    const timer = this.timers.get(controller.runId)
    if (timer) clearTimeout(timer)
    this.timers.delete(controller.runId)
    if (!this.checkpoint(groupId, controller, status)) return
    try {
      this.runLedger.finish?.(controller.runId, status, controller.stopReason || '')
    } catch { /* the conversation result remains authoritative */ }
  }
}

module.exports = { LocalWorkspaceRunLedger }
