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

function loadWorkspaceState(storagePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(storagePath, 'utf8'))
    if (![1, 2, 3].includes(parsed?.version) || !Array.isArray(parsed.groups)
        || !Array.isArray(parsed.messages) || typeof parsed.sessions !== 'object') {
      return emptyState()
    }
    const groups = parsed.groups
      .map(group => normalizeLoadedGroup(group, parsed.version === 1))
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
    }
  } catch {
    return emptyState()
  }
}

function saveWorkspaceState(storagePath, state) {
  fs.mkdirSync(path.dirname(storagePath), { recursive: true })
  const tempPath = `${storagePath}.tmp`
  fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tempPath, storagePath)
}

function workspaceSnapshot({ detectedAgents, state, preparingRuns, activeRuns }) {
  const runEntries = [
    ...[...preparingRuns.entries()].map(entry => [...entry, 'preparing']),
    ...[...activeRuns.entries()].map(entry => [...entry, 'running']),
  ]
  return {
    agents: detectedAgents.map(({ executable, ...agent }) => agent),
    groups: state.groups,
    messages: state.messages,
    runningGroupIds: runEntries.map(([groupId]) => groupId),
    runs: runEntries.map(([groupId, run, phase]) => {
      const mode = run.mode === 'auto' ? 'auto' : 'manual'
      const unlimitedRounds = mode === 'auto' && run.unlimitedRounds === true
      const maxRounds = mode === 'auto' && !unlimitedRounds ? cleanRunMaxRounds(run.maxRounds) : 0
      return {
        groupId,
        runId: run.runId || '',
        taskId: run.taskId || '',
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
        startedAt: run.startedAt || Date.now(),
        agentRuns: run.harness?.snapshot?.() || [],
      }
    }),
  }
}

module.exports = {
  loadWorkspaceState,
  saveWorkspaceState,
  workspaceSnapshot,
}
