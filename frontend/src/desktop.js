export function desktopApi() {
  return typeof window !== 'undefined' ? window.roundrelayDesktop || null : null
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/
const AGENT_KIND = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/
const RUN_EVENT_TYPES = new Set([
  'status',
  'answer_delta',
  'reasoning_summary',
  'plan',
  'tool_start',
  'tool_update',
  'tool_result_summary',
  'warning',
])
const CAPSULE_EVENT_TYPES = new Set([
  'reasoning_summary',
  'plan',
  'tool_start',
  'tool_update',
  'tool_result_summary',
  'warning',
])
const EVENT_STATUSES = new Set([
  'pending', 'queued', 'preparing', 'in_progress', 'running', 'streaming', 'waiting',
  'completed', 'succeeded', 'failed', 'cancelled', 'stopped', 'partial', 'timeout', 'interrupted',
])
const MAX_RUN_AGENTS = 64
const MAX_TRACE_EVENTS = 200
const MAX_CAPSULE_EVENTS = 12
const MAX_SEEN_EVENT_SEQUENCES = 512
const MAX_SOURCE_MESSAGE_IDS = 32
const MAX_AGENT_OUTPUT = 20000

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function boundedString(value, limit, { trim = true } = {}) {
  if (typeof value !== 'string' || value.length > limit) return ''
  return trim ? value.trim() : value
}

function identifier(value) {
  const normalized = boundedString(value, 160)
  return IDENTIFIER.test(normalized) ? normalized : ''
}

function agentKind(value) {
  const normalized = boundedString(value, 40)
  return AGENT_KIND.test(normalized) ? normalized : ''
}

function normalizedAgentKinds(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.slice(0, MAX_RUN_AGENTS).map(agentKind).filter(Boolean))]
}

function nonNegativeInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isInteger(value) && value >= 0 && value <= maximum ? value : null
}

function normalizedTimestamp(value) {
  if (Number.isFinite(value) && value >= 0) return value
  const text = boundedString(value, 80)
  return text && !Number.isNaN(Date.parse(text)) ? text : ''
}

function normalizedStatus(value) {
  const status = boundedString(value, 32).toLowerCase()
  return EVENT_STATUSES.has(status) ? status : ''
}

function sourceMessageIds(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.slice(0, MAX_SOURCE_MESSAGE_IDS).map(identifier).filter(Boolean))]
}

function normalizeTraceContext(value) {
  const input = record(value)
  if (!input) return { includedCount: 0, omittedCount: 0, charCount: 0 }
  const context = {
    includedCount: nonNegativeInteger(input.includedCount, 1000) ?? 0,
    omittedCount: nonNegativeInteger(input.omittedCount, 100000) ?? 0,
    charCount: nonNegativeInteger(input.charCount, 1000000) ?? 0,
  }
  if (input.sessionRotated === true) context.sessionRotated = true
  return context
}

function capsuleDetail(value) {
  const detail = boundedString(value, 600, { trim: false })
  if (!detail) return ''
  return detail.split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => (
      /^Exit code: -?\d+$/u.test(line)
      || /^Output: \d+ lines?, \d+ bytes$/u.test(line)
      || /^Result: (?:-?\d+(?:\.\d+)?|true|false|\d+ items?|\d+ fields?)$/u.test(line)
    ))
    .slice(0, 4)
    .join('\n')
}

export function normalizeCapsuleEvent(value, index = 0) {
  const input = record(value)
  if (!input) return null
  const type = boundedString(input.type, 40).toLowerCase()
  if (!CAPSULE_EVENT_TYPES.has(type)) return null
  const evidenceId = identifier(input.evidenceId) || `E-${index + 1}`
  const event = {
    evidenceId,
    type,
    status: normalizedStatus(input.status) || 'completed',
  }
  const title = boundedString(input.title, 120)
  const summary = boundedString(input.summary, 600)
  const detail = capsuleDetail(input.detail)
  if (title) event.title = title
  if (summary) event.summary = summary
  if (detail) event.detail = detail
  return event
}

export function normalizeRunEvent(value, fallback = {}) {
  const input = record(value)
  const defaults = record(fallback) || {}
  if (!input) return null
  const runId = identifier(input.runId || defaults.runId)
  const agentRunId = identifier(input.agentRunId || defaults.agentRunId)
  const groupId = identifier(input.groupId || defaults.groupId)
  const threadRootId = identifier(input.threadRootId || defaults.threadRootId)
  const kind = agentKind(input.agentKind || input.kind || defaults.agentKind || defaults.kind)
  const round = nonNegativeInteger(input.round ?? defaults.round, 10000)
  const seq = nonNegativeInteger(input.seq)
  const type = boundedString(input.type, 40).toLowerCase()
  if (!runId || !agentRunId || !groupId || !kind || seq == null || !RUN_EVENT_TYPES.has(type)) {
    return null
  }

  const event = { runId, agentRunId, groupId, agentKind: kind, round: round ?? 0, seq, type }
  if (threadRootId) event.threadRootId = threadRootId
  const id = identifier(input.id)
  const status = normalizedStatus(input.status)
  const title = boundedString(input.title, 160)
  const summary = boundedString(input.summary, 4000)
  const detail = boundedString(input.detail, 12000, { trim: false })
  const delta = boundedString(input.delta, 16000, { trim: false })
  const timestamp = normalizedTimestamp(input.timestamp)
  if (id) event.id = id
  if (status) event.status = status
  if (title) event.title = title
  if (summary) event.summary = summary
  if (detail) event.detail = detail
  if (delta) event.delta = delta
  if (timestamp !== '') event.timestamp = timestamp
  if (type === 'answer_delta' && !delta) return null
  return event
}

function normalizeStoredEvents(value, fallback) {
  if (!Array.isArray(value)) return []
  const bySequence = new Map()
  for (const item of value.slice(-MAX_TRACE_EVENTS)) {
    const event = normalizeRunEvent(item, fallback)
    if (event) bySequence.set(event.seq, event)
  }
  return [...bySequence.values()].sort((left, right) => left.seq - right.seq)
}

export function normalizeRunAgent(value, run = {}) {
  const input = record(value)
  const parent = record(run) || {}
  if (!input) return null
  const runId = identifier(parent.runId || input.runId)
  const groupId = identifier(parent.groupId || input.groupId)
  const threadRootId = identifier(parent.threadRootId || input.threadRootId)
  const agentRunId = identifier(input.agentRunId)
  const kind = agentKind(input.kind || input.agentKind)
  if (!runId || !groupId || !agentRunId || !kind) return null
  const round = nonNegativeInteger(input.round, 10000) ?? 0
  const status = normalizedStatus(input.status) || 'pending'
  const events = normalizeStoredEvents(input.events, {
    runId, agentRunId, groupId, threadRootId, agentKind: kind, round,
  })
  const output = boundedString(input.output, MAX_AGENT_OUTPUT, { trim: false })
  const startedAt = normalizedTimestamp(input.startedAt)
  const lastActivityAt = normalizedTimestamp(input.lastActivityAt)
  const seenSeqs = [...new Set([
    ...events.map(event => event.seq),
    ...(Array.isArray(input.seenSeqs) ? input.seenSeqs : []),
  ].map(value => nonNegativeInteger(value)).filter(value => value != null))]
    .slice(-MAX_SEEN_EVENT_SEQUENCES)
  return {
    agentRunId,
    kind,
    round,
    status,
    output,
    events,
    sourceMessageIds: sourceMessageIds(input.sourceMessageIds),
    ...(startedAt !== '' ? { startedAt } : {}),
    ...(lastActivityAt !== '' ? { lastActivityAt } : {}),
    silent: input.silent === true,
    truncated: input.truncated === true,
    seenSeqs,
  }
}

export function normalizeMessageTrace(value, message = {}) {
  const input = record(value)
  if (!input) return null
  const runId = identifier(input.runId)
  const agentRunId = identifier(input.agentRunId)
  if (!runId || !agentRunId) return null
  const round = nonNegativeInteger(input.round, 100000)
  const context = normalizeTraceContext(input.context)
  const events = (Array.isArray(input.events) ? input.events : [])
    .slice(0, MAX_CAPSULE_EVENTS)
    .map(normalizeCapsuleEvent)
    .filter(Boolean)
  const trace = {
    runId,
    agentRunId,
    ...(round != null ? { round } : {}),
    status: normalizedStatus(input.status) || 'completed',
    summary: boundedString(input.summary, 8000),
    events,
    sourceMessageIds: sourceMessageIds(input.sourceMessageIds),
    truncated: input.truncated === true,
    context,
  }
  return trace
}

export function emptySnapshot() {
  return { agents: [], groups: [], messages: [], runningGroupIds: [], runs: [] }
}

function normalizeProgress(value) {
  if (!Array.isArray(value)) return []
  return value.slice(0, 8).map(item => ({
    title: String(item?.title || '').trim(),
    status: String(item?.status || '').trim(),
  })).filter(item => item.title)
}

function normalizeRun(value) {
  const input = record(value)
  if (!input) return null
  const run = { ...input, progress: normalizeProgress(input.progress) }
  const runId = identifier(input.runId)
  const groupId = identifier(input.groupId)
  const threadRootId = identifier(input.threadRootId)
  if (runId) run.runId = runId
  else delete run.runId
  if (groupId) run.groupId = groupId
  if (threadRootId) run.threadRootId = threadRootId
  else delete run.threadRootId
  const rawAgentRuns = Array.isArray(input.agentRuns) ? input.agentRuns : input.agents
  run.agentRuns = Array.isArray(rawAgentRuns)
    ? rawAgentRuns.slice(0, MAX_RUN_AGENTS).map(agent => normalizeRunAgent(agent, run)).filter(Boolean)
    : []
  delete run.agents
  const declaredTargetKinds = normalizedAgentKinds(input.targetKinds)
  const inferredTargetKinds = normalizedAgentKinds([
    ...run.agentRuns.map(agent => agent.kind),
    input.currentKind,
    ...(Array.isArray(input.completedKinds) ? input.completedKinds : []),
    ...(Array.isArray(input.failedKinds) ? input.failedKinds : []),
  ])
  return scopeRunToTargetKinds(
    run,
    declaredTargetKinds.length ? declaredTargetKinds : inferredTargetKinds,
  )
}

function normalizeMessage(value) {
  const input = record(value)
  if (!input) return null
  const message = { ...input }
  const targetKinds = normalizedAgentKinds(input.targetKinds)
  const mentionedAgentKinds = normalizedAgentKinds(input.mentionedAgentKinds)
  if (targetKinds.length) message.targetKinds = targetKinds
  else delete message.targetKinds
  if (mentionedAgentKinds.length) message.mentionedAgentKinds = mentionedAgentKinds
  else delete message.mentionedAgentKinds
  const trace = normalizeMessageTrace(input.trace, input)
  if (trace) message.trace = trace
  else delete message.trace
  return message
}

function scopeRunToTargetKinds(run, values) {
  const targetKinds = normalizedAgentKinds(values)
  const targets = new Set(targetKinds)
  const scoped = {
    ...run,
    targetKinds,
    completedKinds: normalizedAgentKinds(run.completedKinds).filter(kind => targets.has(kind)),
    failedKinds: normalizedAgentKinds(run.failedKinds).filter(kind => targets.has(kind)),
    currentKind: targets.has(agentKind(run.currentKind)) ? agentKind(run.currentKind) : '',
    agentRuns: (Array.isArray(run.agentRuns) ? run.agentRuns : []).filter(agent => targets.has(agent.kind)),
  }
  delete scoped._targetKindsInferred
  return scoped
}

export function normalizeSnapshot(value) {
  const messages = Array.isArray(value?.messages) ? value.messages.map(normalizeMessage).filter(Boolean) : []
  const messagesById = new Map(messages.map(message => [message.id, message]))
  const runs = (Array.isArray(value?.runs) ? value.runs : [])
    .map(normalizeRun)
    .filter(Boolean)
    .map((run) => {
      const rootMessage = messagesById.get(run.threadRootId)
      const messageTargets = normalizedAgentKinds(rootMessage?.targetKinds)
      const mentionedTargets = normalizedAgentKinds(rootMessage?.mentionedAgentKinds)
      const targets = messageTargets.length ? messageTargets : mentionedTargets
      return targets.length ? scopeRunToTargetKinds(run, targets) : run
    })
  return {
    agents: Array.isArray(value?.agents) ? value.agents : [],
    groups: Array.isArray(value?.groups) ? value.groups : [],
    messages,
    runningGroupIds: Array.isArray(value?.runningGroupIds) ? value.runningGroupIds : [],
    runs,
  }
}

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
  else {
    runIndex = runs.length
    runs.push(run)
  }
  return {
    ...snapshot,
    runningGroupIds: [...runningGroupIds],
    runs,
  }
}

export function errorCode(error) {
  return String(error?.code || error?.message || error || '').trim()
}
