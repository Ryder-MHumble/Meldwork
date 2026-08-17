const AGENT_TERMINAL_SYSTEM_KEYS = new Set([
  'system.agentCallFailed', 'system.agentStopped', 'system.agentInterrupted',
  'system.agentBudgetExhausted',
])

export function responseVersionRootId(message) {
  if (message?.role !== 'agent') return ''
  return String(message.responseVersionRootId || message.id || '')
}

export function traceRound(item) {
  const directRound = Number(item?.round)
  if (Number.isInteger(directRound) && directRound >= 0) return directRound
  const evidence = item?.events?.find(event => /^E-R\d+-/i.test(String(event?.evidenceId || '')))?.evidenceId
  const match = String(evidence || '').match(/^E-R(\d+)-/i)
  return match ? Number(match[1]) : 0
}

export function retainedTraceEvents(events) {
  return (Array.isArray(events) ? events : [])
    .filter(event => String(event?.type || '').toLowerCase() !== 'answer_delta')
    .map((event, index) => ({ event, index }))
    .sort((left, right) => {
      const leftSeq = Number(left.event?.seq)
      const rightSeq = Number(right.event?.seq)
      const leftHasSeq = Number.isInteger(leftSeq)
      const rightHasSeq = Number.isInteger(rightSeq)
      if (leftHasSeq && rightHasSeq) return leftSeq - rightSeq || left.index - right.index
      if (leftHasSeq !== rightHasSeq) return leftHasSeq ? 1 : -1
      const leftTime = Date.parse(left.event?.timestamp)
      const rightTime = Date.parse(right.event?.timestamp)
      const leftHasTime = Number.isFinite(leftTime)
      const rightHasTime = Number.isFinite(rightTime)
      if (leftHasTime && rightHasTime) return leftTime - rightTime || left.index - right.index
      if (leftHasTime !== rightHasTime) return leftHasTime ? 1 : -1
      return left.index - right.index
    })
    .map(item => item.event)
}

export function runStatusTone(status) {
  const normalized = String(status || '').trim().toLowerCase()
  if (['completed', 'succeeded', 'settled', 'committed'].includes(normalized)) return 'completed'
  if (['failed', 'timeout', 'budget-exhausted', 'circuit-breaker'].includes(normalized)) return 'failed'
  if (['partial', 'round-limit', 'stopped', 'cancelled', 'interrupted'].includes(normalized)) return 'partial'
  if (['running', 'in_progress', 'waiting'].includes(normalized)) return 'running'
  return 'queued'
}

export function durableRunTurnStatus(run) {
  const latestAttempts = new Map()
  for (const attempt of Array.isArray(run?.agentAttempts) ? run.agentAttempts : []) {
    const previous = latestAttempts.get(attempt.agentKind)
    if (!previous || attempt.round > previous.round
        || (attempt.round === previous.round && attempt.index > previous.index)) {
      latestAttempts.set(attempt.agentKind, attempt)
    }
  }
  const statuses = [...latestAttempts.values()].map(attempt => attempt.status)
  const terminalStatus = String(run?.terminalStatus || '')
  if (['timeout', 'budget-exhausted', 'circuit-breaker'].includes(terminalStatus)) {
    return terminalStatus
  }
  if (terminalStatus === 'stopped' || statuses.some(status => ['stopped', 'cancelled'].includes(status))) {
    return 'stopped'
  }
  if (statuses.includes('interrupted')) return 'interrupted'
  const completed = statuses.includes('completed')
  if (terminalStatus === 'round-limit' && (completed || !statuses.length)) return 'round-limit'
  if (completed && statuses.some(status => ['failed', 'partial', 'timeout'].includes(status))) return 'partial'
  if (completed) return 'completed'
  if (statuses.includes('partial')) return 'partial'
  if (statuses.includes('timeout')) return 'timeout'
  if (statuses.includes('failed')) return 'failed'
  return terminalStatus
}

export function isAgentFailureMessage(message) {
  return message?.role === 'system'
    && ['system.agentCallFailed', 'system.agentBudgetExhausted'].includes(message?.system?.key)
}

export function isAgentTerminalMessage(message) {
  return message?.role === 'system' && AGENT_TERMINAL_SYSTEM_KEYS.has(message?.system?.key)
}

export function durableGroupTerminalStatus(message) {
  if (message?.role !== 'system') return ''
  return {
    'system.autoRoundLimit': 'round-limit',
    'system.autoTimeout': 'timeout',
    'system.autoStopped': 'stopped',
    'system.agentBudgetExhausted': 'budget-exhausted',
    'system.runCircuitBreaker': 'circuit-breaker',
  }[message?.system?.key] || ''
}

export function durableAgentTurnStatus(message) {
  const traceStatus = String(message?.trace?.status || '').trim().toLowerCase()
  if (message?.role === 'agent' && message?.trace) {
    if (['completed', 'succeeded'].includes(traceStatus)) return 'completed'
    return ['failed', 'cancelled', 'stopped', 'partial', 'timeout', 'interrupted'].includes(traceStatus)
      ? traceStatus
      : ''
  }
  if (!isAgentTerminalMessage(message)) return ''
  if (['failed', 'cancelled', 'stopped', 'partial', 'timeout', 'interrupted'].includes(traceStatus)) {
    return traceStatus
  }
  if (message.system.key === 'system.agentStopped') return 'stopped'
  if (message.system.key === 'system.agentInterrupted') return 'interrupted'
  return 'failed'
}

export function terminalSystemFallback(message) {
  if (message?.role !== 'system'
      || !message.agentKind
      || !AGENT_TERMINAL_SYSTEM_KEYS.has(message?.system?.key)) return ''
  const key = message.system.key
  const agent = String(message.system?.params?.agent || '').trim()
  if (!agent) return ''
  if (key === 'system.agentStopped') return `${agent} was stopped.`
  if (key === 'system.agentInterrupted') return `${agent} was interrupted when Meldwork closed.`
  if (key === 'system.agentBudgetExhausted') {
    return `${agent} stopped because a hard run budget was exceeded.`
  }
  const reason = String(message.system?.params?.reason || '').trim()
  return reason ? `${agent} failed: ${reason}` : ''
}

export function terminalSystemConclusion(message) {
  const fallback = terminalSystemFallback(message)
  if (!fallback) return ''
  const content = String(message.content || '')
  const prefix = `${fallback}\n`
  return content.startsWith(prefix) ? content.slice(prefix.length).trim() : ''
}

export function messageElementId(id) {
  return `message-${String(id || '').replace(/[^a-zA-Z0-9_-]/g, '-')}`
}

export function messageExecutionSteps(message) {
  const values = Array.isArray(message?.toolCalls)
    ? message.toolCalls
    : Array.isArray(message?.metadata?.toolCalls) ? message.metadata.toolCalls : []
  return values.slice(0, 8).map(item => ({
    title: String(item?.title || item?.label || item?.name || item?.toolName || item?.tool || item?.type || item?.kind || '').trim(),
    status: String(item?.status || item?.state || '').trim().toLowerCase(),
  })).filter(item => item.title)
}

export function messageTraceKey(message) {
  return message?.liveAgentRun?.agentRunId || message?.trace?.agentRunId || message?.id || ''
}

export function isLiveDirectTrace(message) {
  return message?.provisional === true || Boolean(message?.liveAgentRun)
}

export function messageAgentRunId(message) {
  return message?.liveAgentRun?.agentRunId || message?.trace?.agentRunId || ''
}

export function messageTraceEvents(message) {
  return retainedTraceEvents(message?.liveAgentRun?.events || message?.trace?.events)
}

export function messageHasTrace(message) {
  return Boolean(
    message?.provisional
    || message?.trace?.agentRunId
    || message?.trace?.summary
    || messageTraceEvents(message).length,
  )
}

export function messageTraceSummary(message) {
  return String(message?.trace?.summary || '').trim()
}

export function messageTraceStatus(message) {
  return String(message?.liveAgentRun?.status || message?.trace?.status || '').trim().toLowerCase()
}
