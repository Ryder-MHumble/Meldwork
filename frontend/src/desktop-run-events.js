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
  const existingRuns = Array.isArray(snapshot.runs) ? snapshot.runs : []
  let runIndex = existingRuns.findIndex(run => run?.runId === event.runId)
  if (runIndex < 0 && Array.isArray(snapshot.messages) && snapshot.messages.some(message => (
    message?.trace?.runId === event.runId && message?.trace?.agentRunId === event.agentRunId
  ))) {
    return snapshot
  }

  const existingRun = runIndex >= 0 ? existingRuns[runIndex] : {
    runId: event.runId,
    groupId: event.groupId,
    threadRootId: event.threadRootId || '',
    phase: 'running',
    targetKinds: [event.agentKind],
    completedKinds: [],
    failedKinds: [],
    currentKind: event.agentKind,
    currentRound: event.round,
    progress: [],
    agentRuns: [],
  }
  const existingTargetKinds = normalizedAgentKinds(existingRun.targetKinds)
  if (existingTargetKinds.length && !existingTargetKinds.includes(event.agentKind)) return snapshot
  const existingAgents = Array.isArray(existingRun.agentRuns)
    ? existingRun.agentRuns
    : (Array.isArray(existingRun.agents) ? existingRun.agents : [])
  let agentIndex = existingAgents.findIndex(agent => agent?.agentRunId === event.agentRunId)
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
    if (runIndex >= 0) runs[runIndex] = run
    else runs.push(run)
    return { ...snapshot, runs }
  }

  const existingEvents = Array.isArray(existingAgent.events) ? [...existingAgent.events] : []
  const lifecycleIndex = event.id && event.type.startsWith('tool_')
    ? existingEvents.findIndex(item => item?.id === event.id && String(item?.type || '').startsWith('tool_'))
    : -1
  if (lifecycleIndex >= 0) existingEvents[lifecycleIndex] = event
  else existingEvents.push(event)
  const events = existingEvents.slice(-MAX_TRACE_EVENTS)
  const nextSeenSeqs = [...seenSeqs, event.seq].slice(-MAX_SEEN_EVENT_SEQUENCES)
  let output = boundedString(existingAgent.output, MAX_AGENT_OUTPUT, { trim: false })
  if (event.type === 'answer_delta') {
    output += event.delta.slice(0, Math.max(0, MAX_AGENT_OUTPUT - output.length))
  }
  const nextStatus = event.status
    || (event.type === 'answer_delta' ? 'running' : existingAgent.status || 'running')
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
  if (runAgentTerminal(nextStatus)) {
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
    phase: runAgentTerminal(nextStatus) ? existingRun.phase : 'running',
    targetKinds,
    completedKinds,
    failedKinds,
    currentKind: runAgentTerminal(nextStatus) ? '' : event.agentKind,
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
  if (runIndex >= 0) runs[runIndex] = run
  else runs.push(run)
  return {
    ...snapshot,
    runningGroupIds: [...runningGroupIds],
    runs,
  }
}
