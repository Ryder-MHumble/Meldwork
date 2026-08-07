import {
  MAX_RUN_AGENTS,
  agentKind,
  groupIdentifier,
  identifier,
  normalizeMessageTrace,
  normalizeRunAgent,
  normalizedAgentKinds,
  record,
} from './desktop-normalization.js'

const HUMAN_GATE_ID = /^human-gate-[a-f0-9]{64}$/
const HUMAN_GATE_OPTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const HUMAN_GATE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/
const HUMAN_GATE_FIELDS = new Set([
  'gateId', 'type', 'runId', 'agentRunId', 'agentKind', 'summary', 'options', 'status', 'createdAt',
])
const HUMAN_GATE_OPTION_FIELDS = new Set(['optionId', 'name', 'kind'])
const BUDGET_DIMENSIONS = [
  'inputTokens', 'outputTokens', 'costMicros', 'toolCalls', 'outboundBytes', 'elapsedMs',
]
const BUDGET_DIMENSION_FIELDS = new Set(BUDGET_DIMENSIONS)
const BUDGET_FIELDS = new Set(['limits', 'used', 'source', 'enforcement', 'startedAt'])
const BUDGET_SOURCES = new Set(['reported', 'estimated', 'unknown'])
const BUDGET_ENFORCEMENTS = new Set(['hard', 'soft'])

export function emptySnapshot() {
  return {
    agents: [], groups: [], messages: [], runningGroupIds: [], runs: [], humanGates: [],
  }
}

function normalizeProgress(value) {
  if (!Array.isArray(value)) return []
  return value.slice(0, 8).map(item => ({
    title: String(item?.title || '').trim(),
    status: String(item?.status || '').trim(),
  })).filter(item => item.title)
}

function exactRecord(value, fields) {
  const input = record(value)
  if (!input) return null
  const keys = Reflect.ownKeys(input)
  return keys.length === fields.size
    && keys.every(key => typeof key === 'string' && fields.has(key))
    && [...fields].every(field => Object.hasOwn(input, field))
    ? input
    : null
}

function normalizeBudget(value) {
  const input = exactRecord(value, BUDGET_FIELDS)
  if (!input || !Number.isSafeInteger(input.startedAt) || input.startedAt < 0) return null
  const limits = exactRecord(input.limits, BUDGET_DIMENSION_FIELDS)
  const used = exactRecord(input.used, BUDGET_DIMENSION_FIELDS)
  const source = exactRecord(input.source, BUDGET_DIMENSION_FIELDS)
  const enforcement = exactRecord(input.enforcement, BUDGET_DIMENSION_FIELDS)
  if (!limits || !used || !source || !enforcement) return null
  const output = { limits: {}, used: {}, source: {}, enforcement: {}, startedAt: input.startedAt }
  for (const dimension of BUDGET_DIMENSIONS) {
    const limit = limits[dimension]
    const usedValue = used[dimension]
    const sourceValue = source[dimension]
    const enforcementValue = enforcement[dimension]
    if ((limit !== null && (!Number.isSafeInteger(limit) || limit < 0))
        || !Number.isSafeInteger(usedValue) || usedValue < 0
        || !BUDGET_SOURCES.has(sourceValue)
        || !BUDGET_ENFORCEMENTS.has(enforcementValue)) return null
    output.limits[dimension] = limit
    output.used[dimension] = usedValue
    output.source[dimension] = sourceValue
    output.enforcement[dimension] = enforcementValue
  }
  return output
}

function normalizeHumanGate(value) {
  const input = exactRecord(value, HUMAN_GATE_FIELDS)
  const gateId = String(input?.gateId || '')
  const runId = identifier(input?.runId)
  const agentRunId = identifier(input?.agentRunId)
  const kind = agentKind(input?.agentKind)
  const type = String(input?.type || '')
  const status = String(input?.status || '')
  const summary = typeof input?.summary === 'string' && input.summary.length <= 500
    ? input.summary.trim()
    : ''
  const createdAt = typeof input?.createdAt === 'string' && input.createdAt.length <= 80
    && HUMAN_GATE_TIMESTAMP.test(input.createdAt)
    && !Number.isNaN(Date.parse(input.createdAt))
    ? input.createdAt
    : ''
  if (!HUMAN_GATE_ID.test(gateId) || !runId || !agentRunId || !kind || !summary
      || runId !== input?.runId || agentRunId !== input?.agentRunId || kind !== input?.agentKind
      || !HUMAN_GATE_OPTION_ID.test(runId) || !HUMAN_GATE_OPTION_ID.test(agentRunId)
      || !['permission', 'budget', 'decision'].includes(type)
      || status !== 'pending'
      || summary !== input?.summary
      || /[\u0000-\u001f\u007f]/u.test(summary)
      || !createdAt
      || !Array.isArray(input.options)) return null
  const options = input.options.slice(0, 16).map((option) => {
    const normalized = exactRecord(option, HUMAN_GATE_OPTION_FIELDS)
    const optionId = String(normalized?.optionId || '')
    const name = typeof normalized?.name === 'string' && normalized.name.length <= 160
      ? normalized.name.trim()
      : ''
    const optionKind = String(normalized?.kind || '')
    return HUMAN_GATE_OPTION_ID.test(optionId) && HUMAN_GATE_OPTION_ID.test(optionKind) && name
      && name === normalized?.name && !/[\u0000-\u001f\u007f]/u.test(name)
      ? { optionId, name, kind: optionKind }
      : null
  }).filter(Boolean)
  if (!options.length || options.length !== input.options.length
      || new Set(options.map(option => option.optionId)).size !== options.length) return null
  return {
    gateId, runId, agentRunId, agentKind: kind, type, summary, options, status,
    createdAt,
  }
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

function normalizeRun(value) {
  const input = record(value)
  if (!input) return null
  const run = { ...input, progress: normalizeProgress(input.progress) }
  const runId = identifier(input.runId)
  const groupId = groupIdentifier(input.groupId)
  const threadRootId = identifier(input.threadRootId)
  const responseVersionRootId = identifier(input.responseVersionRootId)
  if (runId) run.runId = runId
  else delete run.runId
  if (groupId) run.groupId = groupId
  else delete run.groupId
  if (threadRootId) run.threadRootId = threadRootId
  else delete run.threadRootId
  if (responseVersionRootId) run.responseVersionRootId = responseVersionRootId
  else delete run.responseVersionRootId
  const rawAgentRuns = Array.isArray(input.agentRuns) ? input.agentRuns : input.agents
  run.agentRuns = Array.isArray(rawAgentRuns)
    ? rawAgentRuns.slice(0, MAX_RUN_AGENTS).map(agent => normalizeRunAgent(agent, run)).filter(Boolean)
    : []
  run.waitingGateIds = [...new Set((Array.isArray(input.waitingGateIds)
    ? input.waitingGateIds.slice(0, 32)
    : []).filter(gateId => typeof gateId === 'string' && HUMAN_GATE_ID.test(gateId)))]
  const budget = normalizeBudget(input.budget)
  if (budget) run.budget = budget
  else delete run.budget
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
  const responseVersionRootId = message.role === 'agent'
    ? identifier(input.responseVersionRootId)
    : ''
  if (responseVersionRootId) message.responseVersionRootId = responseVersionRootId
  else delete message.responseVersionRootId
  const targetKinds = normalizedAgentKinds(input.targetKinds)
  const mentionedAgentKinds = normalizedAgentKinds(input.mentionedAgentKinds)
  if (targetKinds.length) message.targetKinds = targetKinds
  else delete message.targetKinds
  if (mentionedAgentKinds.length) message.mentionedAgentKinds = mentionedAgentKinds
  else delete message.mentionedAgentKinds
  const trace = normalizeMessageTrace(input.trace)
  if (trace) message.trace = trace
  else delete message.trace
  return message
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
  const activeGates = (Array.isArray(value?.humanGates) ? value.humanGates.slice(0, 128) : [])
    .map(normalizeHumanGate)
    .filter((gate) => {
      if (!gate) return false
      const run = runs.find(item => item.runId === gate.runId)
      return Boolean(run?.agentRuns.some(agent => (
        agent.agentRunId === gate.agentRunId && agent.kind === gate.agentKind
      )))
    })
  const gatesById = new Map(activeGates.map(gate => [gate.gateId, gate]))
  for (const run of runs) {
    run.waitingGateIds = run.waitingGateIds.filter((gateId) => {
      const gate = gatesById.get(gateId)
      return gate?.runId === run.runId
    })
  }
  const waitingGateIds = new Set(runs.flatMap(run => run.waitingGateIds))
  return {
    agents: Array.isArray(value?.agents) ? value.agents : [],
    groups: Array.isArray(value?.groups) ? value.groups : [],
    messages,
    runningGroupIds: Array.isArray(value?.runningGroupIds) ? value.runningGroupIds : [],
    runs,
    humanGates: activeGates.filter(gate => waitingGateIds.has(gate.gateId)),
  }
}
