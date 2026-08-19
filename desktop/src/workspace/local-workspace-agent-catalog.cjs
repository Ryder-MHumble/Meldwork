const {
  agentRuntimeCapabilities,
} = require('../agents/agent-runtime-contract.cjs')

const RECENT_VERIFICATION_MS = 24 * 60 * 60 * 1000

function agentVersionIdentified(agent) {
  if (agent?.custom === true) return true
  if (typeof agent?.versionIdentified === 'boolean') return agent.versionIdentified
  if (agent?.compatibilityState === 'unknown') return false
  if (String(agent?.resolvedVersion || '').trim()) return true
  if (agent?.compatibilityState === 'compatible') return true
  return typeof agent?.compatibilityState === 'undefined'
}

function agentCompatible(agent) {
  return agent?.custom === true
    || agent?.compatibilityState === 'compatible'
    || typeof agent?.compatibilityState === 'undefined'
}

function recentlyVerified(runtime, now) {
  if (runtime?.credentialState !== 'ready') return false
  const checkedAt = Date.parse(String(runtime.checkedAt || ''))
  const current = Date.parse(String(now || ''))
  return Number.isFinite(checkedAt) && Number.isFinite(current)
    && current >= checkedAt && current - checkedAt <= RECENT_VERIFICATION_MS
}

class LocalWorkspaceAgentCatalog {
  constructor(options) {
    this.state = options.state
    this.detectedAgents = options.detectedAgents
    this.setDetectedAgents = options.setDetectedAgents
    this.detectAgents = options.detectAgents
    this.credentialState = options.credentialState
    this.sharedProviderReady = options.sharedProviderReady
    this.attachmentSupport = options.attachmentSupport || (() => ({}))
    this.save = options.save
    this.emitChanged = options.emitChanged
    this.snapshot = options.snapshot
    this.now = options.now
  }

  async refresh() {
    const runtimeAtRefreshStart = new Map(Object.entries(this.state().agentRuntime))
    const detected = await this.detectAgents()
    const nativeStates = await Promise.all(detected.map((agent) => {
      const runtime = runtimeAtRefreshStart.get(agent.kind)
      const sharedProviderReady = Boolean(this.sharedProviderReady(agent.kind))
      if (sharedProviderReady && runtime?.credentialState === 'missing') {
        return { state: 'missing', source: 'runtime-auth-failure' }
      }
      if (sharedProviderReady) {
        return { state: 'ready', source: 'shared-provider' }
      }
      return this.credentialState(agent.kind, agent)
    }))
    const state = this.state()
    let recoveredRuntimeCredential = false
    const agents = detected.map((agent, index) => {
      const native = nativeStates[index]
      let runtime = state.agentRuntime[agent.kind]
      const sharedProviderReady = Boolean(this.sharedProviderReady(agent.kind))
      const nativeState = ['ready', 'missing'].includes(native?.state) ? native.state : 'unknown'
      const authoritativeNativeState = native?.source === 'native-auth-status'
      const sharedProviderRequired = native?.source === 'shared-provider-required'
      // A probe that started before a newer runtime failure cannot clear that failure.
      if (authoritativeNativeState && nativeState === 'ready'
          && ['missing', 'unknown'].includes(runtime?.credentialState)
          && runtime === runtimeAtRefreshStart.get(agent.kind)) {
        runtime = {
          credentialState: 'ready',
          checkedAt: this.now(),
        }
        state.agentRuntime[agent.kind] = runtime
        recoveredRuntimeCredential = true
      }
      const runtimeMissing = runtime?.credentialState === 'missing'
      const verifiedReady = runtime?.credentialState === 'ready'
        || state.messages.some(message => (
          message.role === 'agent' && message.agentKind === agent.kind
        ))
      const nativeReadySource = nativeState === 'ready'
        ? (native.source || 'native-credential')
        : ''
      let credentialState = 'unknown'
      if (runtimeMissing || sharedProviderRequired || nativeState === 'missing') {
        credentialState = 'missing'
      }
      if (!runtimeMissing && sharedProviderReady) credentialState = 'ready'
      else if (!runtimeMissing && nativeState === 'ready') credentialState = 'ready'
      else if (!runtimeMissing && verifiedReady && nativeState !== 'missing') credentialState = 'ready'
      const installed = true
      const versionIdentified = agentVersionIdentified(agent)
      const compatible = agentCompatible(agent)
      const nativeConfigurationUnknown = !runtimeMissing
        && nativeState === 'unknown'
        && native?.source !== 'native-runtime-unavailable'
      const configured = sharedProviderReady
        || nativeState === 'ready'
        || native?.source === 'native-auth-status'
        || native?.source === 'native-runtime-unavailable'
        || verifiedReady
        || runtimeMissing
        || nativeConfigurationUnknown
      const authenticated = !runtimeMissing && nativeState !== 'missing' && (
        sharedProviderReady || nativeState === 'ready' || verifiedReady || nativeConfigurationUnknown
      )
      const runtimePrerequisitesReady = native?.source !== 'native-runtime-unavailable'
      const invocable = installed && versionIdentified && compatible && configured
        && authenticated && runtimePrerequisitesReady
      const verifiedRecently = (authoritativeNativeState && nativeState === 'ready')
        || recentlyVerified(runtime, this.now())
      const available = invocable
      const preferred = state.agentPreferences[agent.kind]?.showInSidebar
      const capabilities = agentRuntimeCapabilities(agent.kind, {
        agent,
        attachmentSupport: this.attachmentSupport(agent.kind),
      })
      let availabilitySource = 'unverified'
      if (!compatible) availabilitySource = 'incompatible'
      else if (runtimeMissing) availabilitySource = 'runtime-auth-failure'
      else if (sharedProviderReady) availabilitySource = nativeReadySource || 'shared-provider'
      else if (nativeState === 'missing') availabilitySource = native.source || 'none'
      else if (nativeReadySource) availabilitySource = nativeReadySource
      else if (verifiedReady) availabilitySource = 'verified-run'
      else if (nativeConfigurationUnknown) availabilitySource = 'local-cli'
      return {
        ...agent,
        installed,
        versionIdentified,
        compatible,
        configured,
        authenticated,
        invocable,
        recentlyVerified: verifiedRecently,
        credentialState,
        availabilitySource,
        available,
        task: capabilities.task,
        resumable: capabilities.resumable,
        capabilities,
        showInSidebar: available
          && (typeof preferred === 'boolean' ? preferred : true),
      }
    })
    this.setDetectedAgents(agents)
    if (recoveredRuntimeCredential) this.save()
    this.emitChanged()
    return this.snapshot()
  }

  setSidebarVisibility(kind, visible) {
    const agent = this.detectedAgents().find(item => item.kind === kind)
    if (!agent) throw new Error('LOCAL_AGENT_NOT_INSTALLED')
    if (visible && !agent.available) throw new Error('LOCAL_AGENT_UNAVAILABLE')
    const state = this.state()
    state.agentPreferences[kind] = { showInSidebar: Boolean(visible) }
    agent.showInSidebar = agent.available && Boolean(visible)
    this.save()
    this.emitChanged()
    return this.snapshot()
  }

  markRuntimeCredential(kind, credentialState) {
    const state = this.state()
    state.agentRuntime[kind] = {
      credentialState,
      checkedAt: this.now(),
    }
    const agent = this.detectedAgents().find(item => item.kind === kind)
    if (agent) {
      agent.credentialState = credentialState
      agent.versionIdentified = agentVersionIdentified(agent)
      agent.compatible = agentCompatible(agent)
      agent.configured = credentialState !== 'unknown'
      agent.authenticated = credentialState === 'ready'
      agent.invocable = agent.versionIdentified && agent.compatible
        && agent.configured && agent.authenticated
      agent.recentlyVerified = credentialState === 'ready'
      agent.available = agent.invocable
      agent.availabilitySource = !agent.compatible
        ? 'incompatible'
        : credentialState === 'ready'
          ? 'verified-run'
          : credentialState === 'missing'
            ? 'runtime-auth-failure'
            : 'unverified'
      const preferred = state.agentPreferences[kind]?.showInSidebar
      agent.showInSidebar = agent.available
        && (typeof preferred === 'boolean' ? preferred : true)
    }
    this.save()
    this.emitChanged()
  }

  clearRuntimeCredentialFailures() {
    const state = this.state()
    let changed = false
    for (const [kind, runtime] of Object.entries(state.agentRuntime)) {
      if (runtime?.credentialState !== 'missing') continue
      delete state.agentRuntime[kind]
      changed = true
    }
    if (changed) this.save()
    return changed
  }
}

module.exports = { LocalWorkspaceAgentCatalog }
