export function desktopApi() {
  return typeof window !== 'undefined' ? window.roundrelayDesktop || null : null
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

export function normalizeSnapshot(value) {
  return {
    agents: Array.isArray(value?.agents) ? value.agents : [],
    groups: Array.isArray(value?.groups) ? value.groups : [],
    messages: Array.isArray(value?.messages) ? value.messages : [],
    runningGroupIds: Array.isArray(value?.runningGroupIds) ? value.runningGroupIds : [],
    runs: Array.isArray(value?.runs)
      ? value.runs.map(run => ({ ...run, progress: normalizeProgress(run?.progress) }))
      : [],
  }
}

export function errorCode(error) {
  return String(error?.code || error?.message || error || '').trim()
}
