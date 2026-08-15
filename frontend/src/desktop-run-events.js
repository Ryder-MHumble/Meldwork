import {
  MAX_AGENT_OUTPUT,
  MAX_SEEN_EVENT_SEQUENCES,
  MAX_TRACE_EVENTS,
  boundedString,
  normalizeRunEvent,
  normalizedAgentKinds,
  record,
} from './desktop-normalization.js'

function runAgentTerminal(status) {
  return ['completed', 'failed', 'cancelled', 'stopped', 'partial', 'timeout', 'interrupted'].includes(status)
}

function eventAdvancesAgentState(event) {
  return event.type === 'status'
    || (event.type === 'answer_delta' && runAgentTerminal(event.status))
}

function lifecycleEventFamily(type) {
  const normalized = String(type || '').toLowerCase()
  if (normalized.startsWith('tool_')) return 'tool'
  return ['reasoning_summary', 'plan', 'status', 'warning'].includes(normalized)
    ? normalized
    : ''
}

function lifecycleEventKey(event) {
  const family = lifecycleEventFamily(event?.type)
  return family && event?.id ? `${family}:${event.id}` : ''
}

function orderedRunEvents(events) {
  return events.map((event, index) => ({ event, index }))
    .sort((left, right) => {
      const leftSeq = Number(left.event?.seq)
      const rightSeq = Number(right.event?.seq)
      if (Number.isInteger(leftSeq) && Number.isInteger(rightSeq) && leftSeq !== rightSeq) {
        return leftSeq - rightSeq
      }
      return left.index - right.index
    })
    .map(item => item.event)
}

function scopedLiveRun(snapshot, event) {
  const messages = Array.isArray(snapshot.messages) ? snapshot.messages : []
  if (messages.some(message => (
    message?.trace?.runId === event.runId
    && message?.trace?.agentRunId === event.agentRunId
  ))) return null
  const group = (Array.isArray(snapshot.groups) ? snapshot.groups : [])
    .find(item => item?.id === event.groupId)
  if (!group || !event.threadRootId) return null
  const rootMessage = messages.find(message => (
    message?.id === event.threadRootId
    && message?.groupId === event.groupId
    && message?.role === 'user'
  ))
  if (!rootMessage) return null
  const messageTargets = normalizedAgentKinds(rootMessage.targetKinds)
  const mentionedTargets = normalizedAgentKinds(rootMessage.mentionedAgentKinds)
  const groupTargets = normalizedAgentKinds([
    group.directAgentKind,
    ...(Array.isArray(group.agentKinds) ? group.agentKinds : []),
  ])
  const targetKinds = messageTargets.length
    ? messageTargets
    : (mentionedTargets.length ? mentionedTargets : groupTargets)
  if (!targetKinds.includes(event.agentKind)) return null
  return {
    runId: event.runId,
    groupId: event.groupId,
    threadRootId: event.threadRootId,
    targetKinds,
    completedKinds: [],
    failedKinds: [],
    currentKind: '',
    currentRound: 0,
    agentRuns: [],
  }
}

function mergeMissingRunEventFields(existing, incoming) {
  const next = { ...existing }
  let changed = false
  for (const field of ['id', 'status', 'title', 'summary', 'detail', 'delta', 'timestamp']) {
    const current = next[field]
    const value = incoming[field]
    if ((current == null || current === '') && value != null && value !== '') {
      next[field] = value
      changed = true
    }
  }
  return changed ? next : existing
}

export function mergeRunEvent(snapshot, value) {
  const event = normalizeRunEvent(value)
  if (!event || !record(snapshot)) return snapshot
  let existingRuns = Array.isArray(snapshot.runs) ? snapshot.runs : []
  let runIndex = existingRuns.findIndex(run => run?.runId === event.runId)
  if (runIndex < 0) {
    const run = scopedLiveRun(snapshot, event)
    if (!run) return snapshot
    existingRuns = [...existingRuns, run]
    runIndex = existingRuns.length - 1
  }

  const existingRun = existingRuns[runIndex]
  if (existingRun.groupId !== event.groupId) return snapshot
  if (existingRun.threadRootId && event.threadRootId
      && existingRun.threadRootId !== event.threadRootId) return snapshot
  const existingTargetKinds = normalizedAgentKinds(existingRun.targetKinds)
  if (existingTargetKinds.length && !existingTargetKinds.includes(event.agentKind)) return snapshot
  const existingAgents = Array.isArray(existingRun.agentRuns)
    ? existingRun.agentRuns
    : (Array.isArray(existingRun.agents) ? existingRun.agents : [])
  let agentIndex = existingAgents.findIndex(agent => agent?.agentRunId === event.agentRunId)
  if (agentIndex >= 0 && (
    existingAgents[agentIndex]?.kind !== event.agentKind
    || existingAgents[agentIndex]?.round !== event.round
  )) return snapshot
  const existingAgent = agentIndex >= 0 ? existingAgents[agentIndex] : {
    agentRunId: event.agentRunId,
    kind: event.agentKind,
    round: event.round,
    status: 'queued',
    output: '',
    events: [],
    sourceMessageIds: [],
    silent: true,
    seenSeqs: [],
  }
  const seenSeqs = Array.isArray(existingAgent.seenSeqs)
    ? existingAgent.seenSeqs
    : (Array.isArray(existingAgent.events) ? existingAgent.events.map(item => item?.seq) : [])
  if (seenSeqs.includes(event.seq)) {
    const eventIndex = Array.isArray(existingAgent.events)
      ? existingAgent.events.findIndex(item => item?.seq === event.seq)
      : -1
    if (eventIndex < 0) return snapshot
    const mergedEvent = mergeMissingRunEventFields(existingAgent.events[eventIndex], event)
    if (mergedEvent === existingAgent.events[eventIndex]) return snapshot
    const events = [...existingAgent.events]
    events[eventIndex] = mergedEvent
    const nextAgent = { ...existingAgent, events }
    const agents = [...existingAgents]
    agents[agentIndex] = nextAgent
    const run = { ...existingRun, agentRuns: agents }
    const runs = [...existingRuns]
    runs[runIndex] = run
    return { ...snapshot, runs }
  }

  const existingEvents = Array.isArray(existingAgent.events) ? [...existingAgent.events] : []
  if (event.type !== 'answer_delta') {
    const eventLifecycleKey = lifecycleEventKey(event)
    const lifecycleIndex = eventLifecycleKey
      ? existingEvents.findIndex(item => lifecycleEventKey(item) === eventLifecycleKey)
      : -1
    if (lifecycleIndex >= 0) existingEvents[lifecycleIndex] = event
    else existingEvents.push(event)
  }
  const events = orderedRunEvents(existingEvents).slice(-MAX_TRACE_EVENTS)
  const nextSeenSeqs = [...seenSeqs, event.seq].slice(-MAX_SEEN_EVENT_SEQUENCES)
  let output = boundedString(existingAgent.output, MAX_AGENT_OUTPUT, { trim: false })
  if (event.type === 'answer_delta') {
    output = event.replace === true
      ? event.delta.slice(0, MAX_AGENT_OUTPUT)
      : output + event.delta.slice(0, Math.max(0, MAX_AGENT_OUTPUT - output.length))
  }
  const advancesAgentState = eventAdvancesAgentState(event)
  const nextStatus = runAgentTerminal(existingAgent.status)
    ? existingAgent.status
    : advancesAgentState
    ? (event.status || existingAgent.status || 'running')
    : (existingAgent.status === 'queued' ? 'running' : existingAgent.status || 'running')
  const nextAgent = {
    ...existingAgent,
    kind: event.agentKind,
    round: event.round,
    status: nextStatus,
    output,
    events,
    lastActivityAt: event.timestamp || existingAgent.lastActivityAt,
    silent: false,
    seenSeqs: nextSeenSeqs,
  }
  const agents = [...existingAgents]
  if (agentIndex >= 0) agents[agentIndex] = nextAgent
  else {
    agentIndex = agents.length
    agents.push(nextAgent)
  }

  const targetKinds = existingTargetKinds.length ? existingTargetKinds : [event.agentKind]
  const completedKinds = [...new Set(existingRun.completedKinds || [])]
  const failedKinds = [...new Set(existingRun.failedKinds || [])]
  const agentTerminal = runAgentTerminal(existingAgent.status)
    || (advancesAgentState && runAgentTerminal(nextStatus))
  if (agentTerminal) {
    if (!completedKinds.includes(event.agentKind)) completedKinds.push(event.agentKind)
    if (['failed', 'timeout', 'interrupted'].includes(nextStatus) && !failedKinds.includes(event.agentKind)) {
      failedKinds.push(event.agentKind)
    }
  }
  const run = {
    ...existingRun,
    runId: event.runId,
    groupId: event.groupId,
    threadRootId: event.threadRootId || existingRun.threadRootId || '',
    phase: agentTerminal ? existingRun.phase : 'running',
    targetKinds,
    completedKinds,
    failedKinds,
    currentKind: agentTerminal ? '' : event.agentKind,
    currentRound: Math.max(Number(existingRun.currentRound) || 0, event.round),
    agentRuns: agents,
  }
  delete run.agents
  delete run._targetKindsInferred
  const allTargetKindsTerminal = targetKinds.length > 0
    && targetKinds.every(kind => completedKinds.includes(kind))
  const runningGroupIds = new Set(snapshot.runningGroupIds || [])
  if (allTargetKindsTerminal && run.mode !== 'auto') runningGroupIds.delete(event.groupId)
  else runningGroupIds.add(event.groupId)
  const runs = [...existingRuns]
  runs[runIndex] = run
  return {
    ...snapshot,
    runningGroupIds: [...runningGroupIds],
    runs,
  }
}
