export function desktopApi() {
  return typeof window !== 'undefined' ? window.roundrelayDesktop || null : null
}

export function workspaceApi() {
  return desktopApi()?.localWorkspace || null
}

export function installerApi() {
  return desktopApi()?.agentInstaller || null
}

export function providerApi() {
  return desktopApi()?.localAgentProvider || null
}

export function emptySnapshot() {
  return { agents: [], groups: [], messages: [], runningGroupIds: [], runs: [] }
}

export function normalizeSnapshot(value) {
  return {
    agents: Array.isArray(value?.agents) ? value.agents : [],
    groups: Array.isArray(value?.groups) ? value.groups : [],
    messages: Array.isArray(value?.messages) ? value.messages : [],
    runningGroupIds: Array.isArray(value?.runningGroupIds) ? value.runningGroupIds : [],
    runs: Array.isArray(value?.runs) ? value.runs : [],
  }
}

export function errorCode(error) {
  return String(error?.code || error?.message || error || '').trim()
}
