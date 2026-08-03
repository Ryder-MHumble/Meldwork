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
    const detected = await this.detectAgents()
    const nativeStates = await Promise.all(detected.map(
      agent => this.credentialState(agent.kind, agent),
    ))
    const state = this.state()
    const agents = detected.map((agent, index) => {
      const native = nativeStates[index]
      const runtime = state.agentRuntime[agent.kind]
      const sharedProviderReady = Boolean(this.sharedProviderReady(agent.kind))
      const nativeState = ['ready', 'missing'].includes(native?.state) ? native.state : 'unknown'
      const sharedProviderRequired = native?.source === 'shared-provider-required'
      const runtimeMissing = runtime?.credentialState === 'missing'
      const verifiedReady = runtime?.credentialState === 'ready'
        || state.messages.some(message => (
          message.role === 'agent' && message.agentKind === agent.kind
        ))
      const nativeReadySource = nativeState === 'ready'
        ? (native.source || 'native-credential')
        : ''
      const credentialState = sharedProviderReady
        ? 'ready'
        : sharedProviderRequired
          ? 'missing'
          : runtimeMissing
            ? 'missing'
            : nativeState === 'missing'
              ? 'missing'
              : nativeState === 'ready'
                ? 'ready'
                : verifiedReady
                  ? 'ready'
                  : 'unknown'
      const available = credentialState === 'ready'
      const preferred = state.agentPreferences[agent.kind]?.showInSidebar
      return {
        ...agent,
        installed: true,
        credentialState,
        availabilitySource: sharedProviderReady
          ? (!runtimeMissing && nativeReadySource ? nativeReadySource : 'shared-provider')
          : runtimeMissing
              ? 'runtime-auth-failure'
            : nativeState === 'missing'
              ? (native.source || 'none')
              : nativeReadySource
                ? nativeReadySource
                : verifiedReady
                  ? 'verified-run'
                  : 'unverified',
        available,
        showInSidebar: available && (typeof preferred === 'boolean' ? preferred : true),
      }
    })
    this.setDetectedAgents(agents)
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
      agent.available = credentialState !== 'missing'
      agent.availabilitySource = credentialState === 'ready'
        ? 'verified-run'
        : 'runtime-auth-failure'
      const preferred = state.agentPreferences[kind]?.showInSidebar
      agent.showInSidebar = agent.available && (typeof preferred === 'boolean' ? preferred : true)
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
