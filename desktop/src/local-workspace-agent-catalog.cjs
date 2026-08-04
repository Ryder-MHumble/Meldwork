const {
  agentRuntimeCapabilities,
  isReviewOnlyAgentKind,
} = require('./agent-runtime-contract.cjs')

class LocalWorkspaceAgentCatalog {
  constructor(options) {
    this.state = options.state
    this.detectedAgents = options.detectedAgents
    this.setDetectedAgents = options.setDetectedAgents
    this.detectAgents = options.detectAgents
    this.credentialState = options.credentialState
    this.sharedProviderReady = options.sharedProviderReady
    this.save = options.save
    this.emitChanged = options.emitChanged
    this.snapshot = options.snapshot
    this.now = options.now
  }

  async refresh() {
    const runtimeAtRefreshStart = new Map(Object.entries(this.state().agentRuntime))
    const detected = await this.detectAgents()
    const nativeStates = await Promise.all(detected.map(
      agent => this.credentialState(agent.kind, agent),
    ))
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
      const compatible = agent.custom === true || agent.compatibilityState !== 'incompatible'
      const available = compatible && credentialState === 'ready'
      const preferred = state.agentPreferences[agent.kind]?.showInSidebar
      const capabilities = agentRuntimeCapabilities(agent.kind)
      let availabilitySource = 'unverified'
      if (!compatible) availabilitySource = 'incompatible'
      else if (runtimeMissing) availabilitySource = 'runtime-auth-failure'
      else if (sharedProviderReady) availabilitySource = nativeReadySource || 'shared-provider'
      else if (nativeState === 'missing') availabilitySource = native.source || 'none'
      else if (nativeReadySource) availabilitySource = nativeReadySource
      else if (verifiedReady) availabilitySource = 'verified-run'
      return {
        ...agent,
        installed: true,
        credentialState,
        availabilitySource,
        available,
        task: capabilities.task,
        resumable: capabilities.resumable,
        showInSidebar: capabilities.task === 'general'
          && available
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
    if (isReviewOnlyAgentKind(agent.kind)) throw new Error('LOCAL_AGENT_REVIEW_ONLY')
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
      const compatible = agent.custom === true || agent.compatibilityState !== 'incompatible'
      agent.available = compatible && credentialState === 'ready'
      agent.availabilitySource = !compatible
        ? 'incompatible'
        : credentialState === 'ready'
          ? 'verified-run'
          : credentialState === 'missing'
            ? 'runtime-auth-failure'
            : 'unverified'
      const preferred = state.agentPreferences[kind]?.showInSidebar
      agent.showInSidebar = !isReviewOnlyAgentKind(agent.kind)
        && agent.available
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
