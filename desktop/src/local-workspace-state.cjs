const fs = require('node:fs')
const path = require('node:path')
const { normalizeSessionMeta } = require('./run-harness.cjs')
const {
  SESSION_KEY,
  cleanCurrentRound,
  cleanProgressSteps,
  cleanRunMaxRounds,
  emptyState,
  normalizeLoadedGroup,
  normalizeLoadedMessage,
  normalizeSessionRef,
} = require('./local-workspace-inputs.cjs')

const FINISHED_AGENT_STATUSES = new Set([
  'completed', 'partial', 'failed', 'stopped', 'timeout', 'interrupted',
])
const FAILED_AGENT_STATUSES = new Set(['failed', 'stopped', 'timeout'])

function loadWorkspaceState(storagePath) {
  let source
  try {
    source = fs.readFileSync(storagePath, 'utf8')
  } catch (error) {
    const missing = error?.code === 'ENOENT'
    return {
      state: emptyState(),
      status: missing ? 'missing' : 'unreadable',
      trusted: missing,
      diagnostic: missing ? '' : 'LOCAL_WORKSPACE_STATE_UNREADABLE',
    }
  }

  let parsed
  try {
    parsed = JSON.parse(source)
  } catch {
    return {
      state: emptyState(),
      status: 'corrupt',
      trusted: false,
      diagnostic: 'LOCAL_WORKSPACE_STATE_CORRUPT',
    }
  }

  if (![1, 2, 3].includes(parsed?.version)) {
    return {
      state: emptyState(),
      status: 'unsupported',
      trusted: false,
      diagnostic: 'LOCAL_WORKSPACE_STATE_UNSUPPORTED',
    }
  }
  if (!Array.isArray(parsed.groups) || !Array.isArray(parsed.messages)
      || !parsed.sessions || typeof parsed.sessions !== 'object'
      || Array.isArray(parsed.sessions)) {
    return {
      state: emptyState(),
      status: 'corrupt',
      trusted: false,
      diagnostic: 'LOCAL_WORKSPACE_STATE_CORRUPT',
    }
  }

  try {
    const groups = parsed.groups
      .map(normalizeLoadedGroup)
      .filter(Boolean)
    const groupIds = new Set(groups.map(group => group.id))
    const messages = parsed.messages
      .map(normalizeLoadedMessage)
      .filter(message => message && groupIds.has(message.groupId))
    const sessionMeta = {}
    if (parsed.sessionMeta && typeof parsed.sessionMeta === 'object'
        && !Array.isArray(parsed.sessionMeta)) {
      for (const [key, value] of Object.entries(parsed.sessionMeta).slice(0, 1000)) {
        if (/^[A-Za-z0-9._:-]{1,240}$/.test(key)) {
          sessionMeta[key] = normalizeSessionMeta(value)
        }
      }
    }
    const sessions = {}
    if (parsed.sessions && typeof parsed.sessions === 'object'
        && !Array.isArray(parsed.sessions)) {
      for (const [key, value] of Object.entries(parsed.sessions).slice(0, 1000)) {
        const sessionRef = normalizeSessionRef(value)
        if (SESSION_KEY.test(key) && sessionRef) sessions[key] = sessionRef
      }
    }
    return {
      state: {
        version: 3,
        groups,
        messages,
        sessions,
        sessionMeta,
        agentPreferences: parsed.agentPreferences
          && typeof parsed.agentPreferences === 'object' && !Array.isArray(parsed.agentPreferences)
          ? { ...parsed.agentPreferences }
          : {},
        agentRuntime: parsed.agentRuntime
          && typeof parsed.agentRuntime === 'object' && !Array.isArray(parsed.agentRuntime)
          ? { ...parsed.agentRuntime }
          : {},
      },
      status: 'ready',
      trusted: true,
      diagnostic: '',
    }
  } catch {
    return {
      state: emptyState(),
      status: 'corrupt',
      trusted: false,
      diagnostic: 'LOCAL_WORKSPACE_STATE_CORRUPT',
    }
  }
}

function saveWorkspaceState(storagePath, state) {
  fs.mkdirSync(path.dirname(storagePath), { recursive: true })
  const tempPath = `${storagePath}.tmp`
  fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tempPath, storagePath)
}

function durableWaitingRunSnapshots({ state, runLedger, pendingGates, liveRunIds, liveGroupIds }) {
  let records = []
  try { records = runLedger?.list?.() || [] } catch { return [] }
  const groupIds = new Set(state.groups.map(group => group.id))
  const pendingById = new Map(pendingGates.map(gate => [gate.gateId, gate]))
  const projectedGroupIds = new Set()
  const snapshots = []

  for (const record of records) {
    const continuation = record?.continuation
    const gate = pendingById.get(continuation?.gateId)
    if (record?.status !== 'waiting' || continuation?.state !== 'pending'
        || !gate || liveRunIds.has(record.runId) || liveGroupIds.has(record.groupId)
        || projectedGroupIds.has(record.groupId) || !groupIds.has(record.groupId)
        || gate.runId !== record.runId || gate.type !== continuation.gateType
        || gate.agentRunId !== continuation.agentRunId
        || gate.agentKind !== continuation.agentKind
        || !record.targetKinds?.includes(continuation.agentKind)) continue

    const latestAgentStatuses = new Map()
    for (const agentRun of Array.isArray(record.agentRuns) ? record.agentRuns : []) {
      if (!record.targetKinds.includes(agentRun?.kind)
          || !FINISHED_AGENT_STATUSES.has(agentRun?.status)) continue
      latestAgentStatuses.set(agentRun.kind, agentRun.status)
    }
    const mode = record.mode === 'auto' ? 'auto' : 'manual'
    const unlimitedRounds = mode === 'auto' && record.unlimitedRounds === true
    const maxRounds = mode === 'auto' && !unlimitedRounds
      ? cleanRunMaxRounds(record.maxRounds)
      : 0
    projectedGroupIds.add(record.groupId)
    snapshots.push({
      groupId: record.groupId,
      runId: record.runId,
      taskId: record.taskId || '',
      contextPackId: record.contextPackId || '',
      contextPackState: record.contextPackState || (record.contextPackId
        ? 'captured'
        : 'legacy-unavailable'),
      phase: 'running',
      mode,
      targetKinds: record.targetKinds || [],
      completedKinds: [...latestAgentStatuses.keys()],
      failedKinds: [...latestAgentStatuses]
        .filter(([, status]) => FAILED_AGENT_STATUSES.has(status))
        .map(([kind]) => kind),
      currentKind: continuation.agentKind,
      currentRound: cleanCurrentRound(record.currentRound, maxRounds, unlimitedRounds),
      maxRounds,
      unlimitedRounds,
      progress: [],
      threadRootId: record.threadRootId || '',
      responseVersionRootId: record.responseVersionRootId || '',
      startedAt: record.startedAt || Date.now(),
      agentRuns: Array.isArray(record.agentRuns) ? record.agentRuns : [],
      waitingGateIds: [gate.gateId],
      budget: record.budget || null,
    })
  }
  return snapshots
}

function workspaceSnapshot({
  detectedAgents, state, preparingRuns, activeRuns, humanGateCoordinator, runLedger,
  workspaceRecovery,
}) {
  const busyEntries = [
    ...[...preparingRuns.entries()].map(entry => [...entry, 'preparing']),
    ...[...activeRuns.entries()].map(entry => [...entry, 'running']),
  ]
  const runEntries = busyEntries.filter(([, run, phase]) => (
    phase === 'running' || run.taskBound === true
  ))
  const pendingGates = humanGateCoordinator?.list?.({ pendingOnly: true }) || []
  const liveRunIds = new Set(runEntries.map(([, run]) => run.runId).filter(Boolean))
  const liveGroupIds = new Set(busyEntries.map(([groupId]) => groupId))
  const durableRuns = durableWaitingRunSnapshots({
    state, runLedger, pendingGates, liveRunIds, liveGroupIds,
  })
  const visibleRunIds = new Set([
    ...liveRunIds,
    ...durableRuns.map(run => run.runId),
  ])
  return {
    agents: detectedAgents.map(({ executable, ...agent }) => agent),
    groups: state.groups,
    messages: state.messages,
    ...(workspaceRecovery?.trusted === false ? {
      recovery: {
        state: 'read-only',
        status: workspaceRecovery.status,
        diagnostic: workspaceRecovery.diagnostic,
      },
    } : {}),
    runningGroupIds: [...new Set([
      ...busyEntries.map(([groupId]) => groupId),
      ...durableRuns.map(run => run.groupId),
    ])],
    humanGates: pendingGates.filter(gate => visibleRunIds.has(gate.runId)),
    runs: [...runEntries.map(([groupId, run, phase]) => {
      const mode = run.mode === 'auto' ? 'auto' : 'manual'
      const unlimitedRounds = mode === 'auto' && run.unlimitedRounds === true
      const maxRounds = mode === 'auto' && !unlimitedRounds ? cleanRunMaxRounds(run.maxRounds) : 0
      return {
        groupId,
        runId: run.runId || '',
        taskId: run.taskId || '',
        contextPackId: run.contextPackId || '',
        contextPackState: run.contextPackId ? 'captured' : 'legacy-unavailable',
        phase,
        mode,
        targetKinds: run.targetKinds || [],
        completedKinds: run.completedKinds || [],
        failedKinds: run.failedKinds || [],
        currentKind: run.currentKind || '',
        currentRound: cleanCurrentRound(run.currentRound, maxRounds, unlimitedRounds),
        maxRounds,
        unlimitedRounds,
        progress: cleanProgressSteps(run.progress),
        threadRootId: run.threadRootId || '',
        responseVersionRootId: run.responseVersionRootId || '',
        startedAt: run.startedAt || Date.now(),
        agentRuns: run.harness?.snapshot?.() || [],
        waitingGateIds: [...(run.waitingGateIds || [])],
        budget: run.budget?.snapshot?.() || null,
      }
    }), ...durableRuns],
  }
}

module.exports = {
  loadWorkspaceState,
  saveWorkspaceState,
  workspaceSnapshot,
}
