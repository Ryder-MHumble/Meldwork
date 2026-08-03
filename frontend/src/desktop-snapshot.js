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
  if (runId) run.runId = runId
  else delete run.runId
  if (groupId) run.groupId = groupId
  else delete run.groupId
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
  return {
    agents: Array.isArray(value?.agents) ? value.agents : [],
    groups: Array.isArray(value?.groups) ? value.groups : [],
    messages,
    runningGroupIds: Array.isArray(value?.runningGroupIds) ? value.runningGroupIds : [],
    runs,
  }
}
