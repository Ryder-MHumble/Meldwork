const { createHash } = require('node:crypto')
const { normalizeTraceCapsule } = require('./run-harness.cjs')
const {
  AGENT_LABELS,
  MAX_SYSTEM_PARAM_TEXT_CHARS,
  cleanText,
  terminalMessageContent,
  terminalStatusPrefix,
} = require('./local-workspace-inputs.cjs')

class LocalWorkspaceRunMessages {
  constructor(options) {
    this.state = options.state
    this.activeRuns = options.activeRuns
    this.agentLabel = options.agentLabel
    this.checkpointRun = options.checkpointRun
    this.addMessage = options.addMessage
  }

  recordFailure(groupId, kind, error, threadRootId, reportedFailures = null) {
    const label = this.agentLabel(kind)
    const reason = cleanText(error?.message || error, MAX_SYSTEM_PARAM_TEXT_CHARS)
      || 'LOCAL_AGENT_UNKNOWN_FAILURE'
    const controller = this.activeRuns.get(groupId)
    const agentRunId = error?.runTrace?.agentRunId
    if (controller && agentRunId) {
      controller.agentFailureReasons.set(agentRunId, reason)
      this.checkpointRun(groupId, controller)
    }
    const streamedConclusion = this.streamedConclusion(groupId, agentRunId)
    const content = terminalMessageContent(
      terminalStatusPrefix(label, 'failed', reason),
      streamedConclusion,
    )
    const failureKey = `${kind}:${reason}:${createHash('sha256').update(content).digest('hex')}`
    if (!reportedFailures || !reportedFailures.has(failureKey)) {
      reportedFailures?.add(failureKey)
      this.addMessage(
        groupId,
        'system',
        content,
        kind,
        threadRootId,
        { key: 'system.agentCallFailed', params: { agent: label, reason } },
        { trace: error?.runTrace },
      )
    }
    return { label, reason }
  }

  streamedConclusion(groupId, agentRunId) {
    if (!agentRunId) return ''
    const agentRun = this.activeRuns.get(groupId)?.harness?.snapshot?.().find(run => (
      run.agentRunId === agentRunId
    ))
    return cleanText(agentRun?.output)
  }

  recordInterruption(
    groupId, kind, error, threadRootId, status = 'stopped', reportedFailures = null,
  ) {
    const trace = normalizeTraceCapsule(error?.runTrace
      ? { ...error.runTrace, status }
      : null)
    if (!trace) return null
    const label = AGENT_LABELS[kind] || kind
    const interruptionKey = `${kind}:${trace.agentRunId}:${status}`
    if (reportedFailures?.has(interruptionKey)) return trace
    reportedFailures?.add(interruptionKey)
    if (this.state().messages.some(message => message.trace?.agentRunId === trace.agentRunId)) {
      return trace
    }
    const interrupted = status === 'interrupted'
    const streamedConclusion = this.streamedConclusion(groupId, trace.agentRunId)
    this.addMessage(
      groupId,
      'system',
      terminalMessageContent(terminalStatusPrefix(label, status), streamedConclusion),
      kind,
      threadRootId,
      {
        key: interrupted ? 'system.agentInterrupted' : 'system.agentStopped',
        params: { agent: label },
      },
      { trace },
    )
    return trace
  }
}

module.exports = { LocalWorkspaceRunMessages }
