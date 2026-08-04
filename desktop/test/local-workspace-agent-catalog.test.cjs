const assert = require('node:assert/strict')
const test = require('node:test')

const catalogApi = require('../src/local-workspace-agent-catalog.cjs')
const { LocalWorkspaceAgentCatalog } = catalogApi

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function fixture(overrides = {}) {
  const state = {
    messages: [],
    agentPreferences: {},
    agentRuntime: {},
  }
  let agents = overrides.initialAgents || []
  const events = []
  const catalog = new LocalWorkspaceAgentCatalog({
    state: () => state,
    detectedAgents: () => agents,
    setDetectedAgents: (next) => { agents = next },
    detectAgents: overrides.detectAgents || (async () => []),
    credentialState: overrides.credentialState || (async () => ({
      state: 'unknown', source: 'unverified',
    })),
    sharedProviderReady: overrides.sharedProviderReady || (() => false),
    save: () => events.push('save'),
    emitChanged: () => events.push('emit'),
    snapshot: () => {
      events.push('snapshot')
      return { agents }
    },
    now: () => '2026-08-03T00:00:00.000Z',
  })
  return { agents: () => agents, catalog, events, state }
}

test('Agent catalog module exposes only its coordinator', () => {
  assert.deepEqual(Object.keys(catalogApi), ['LocalWorkspaceAgentCatalog'])
})

test('refresh starts credential checks concurrently and reads current runtime state after them', async () => {
  const codex = deferred()
  const hermes = deferred()
  const started = []
  const { agents, catalog, events, state } = fixture({
    detectAgents: async () => [
      { kind: 'codex', executable: '/tmp/codex', compatibilityState: 'compatible' },
      { kind: 'hermes', executable: '/tmp/hermes', compatibilityState: 'compatible' },
    ],
    credentialState: (kind) => {
      started.push(kind)
      return kind === 'codex' ? codex.promise : hermes.promise
    },
  })

  const refresh = catalog.refresh()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(started, ['codex', 'hermes'])
  state.agentRuntime.codex = { credentialState: 'missing' }
  codex.resolve({ state: 'ready', source: 'native-auth-status' })
  hermes.resolve({ state: 'ready', source: 'native-credential' })

  const snapshot = await refresh
  assert.deepEqual(agents().map(agent => agent.kind), ['codex', 'hermes'])
  assert.deepEqual(snapshot.agents.map(agent => agent.credentialState), ['missing', 'ready'])
  assert.equal(snapshot.agents[0].availabilitySource, 'runtime-auth-failure')
  assert.deepEqual(events, ['emit', 'snapshot'])
})

test('incompatible Agents remain installed but unavailable with ready credentials', async () => {
  const { agents, catalog, events } = fixture({
    detectAgents: async () => [{
      kind: 'codex',
      executable: '/tmp/codex',
      compatibilityState: 'incompatible',
      incompatibilityReason: 'LOCAL_AGENT_VERSION_UNSUPPORTED',
    }],
    credentialState: async () => ({ state: 'ready', source: 'native-auth-status' }),
    sharedProviderReady: () => true,
  })

  await catalog.refresh()

  assert.equal(agents()[0].installed, true)
  assert.equal(agents()[0].credentialState, 'ready')
  assert.equal(agents()[0].available, false)
  assert.equal(agents()[0].showInSidebar, false)
  assert.equal(agents()[0].availabilitySource, 'incompatible')
  assert.equal(agents()[0].incompatibilityReason, 'LOCAL_AGENT_VERSION_UNSUPPORTED')
  assert.throws(
    () => catalog.setSidebarVisibility('codex', true),
    { message: 'LOCAL_AGENT_UNAVAILABLE' },
  )
  assert.deepEqual(events, ['emit', 'snapshot'])
})

test('shared Provider readiness cannot override a recorded runtime auth failure', async () => {
  const { agents, catalog, events, state } = fixture({
    detectAgents: async () => [{
      kind: 'codex', executable: '/tmp/codex', compatibilityState: 'compatible',
    }],
    credentialState: async () => ({ state: 'ready', source: 'native-credential' }),
    sharedProviderReady: () => true,
  })
  state.agentRuntime.codex = { credentialState: 'missing' }

  await catalog.refresh()

  assert.equal(agents()[0].credentialState, 'missing')
  assert.equal(agents()[0].available, false)
  assert.equal(agents()[0].availabilitySource, 'runtime-auth-failure')
  assert.deepEqual(events, ['emit', 'snapshot'])
})

test('authoritative native validation persists recovery from a runtime auth failure', async () => {
  const { agents, catalog, events, state } = fixture({
    detectAgents: async () => [{
      kind: 'mimo', executable: '/tmp/mimo', compatibilityState: 'compatible',
    }],
    credentialState: async () => ({ state: 'ready', source: 'native-auth-status' }),
  })
  state.agentRuntime.mimo = { credentialState: 'missing' }

  await catalog.refresh()

  assert.deepEqual(state.agentRuntime.mimo, {
    credentialState: 'ready', checkedAt: '2026-08-03T00:00:00.000Z',
  })
  assert.equal(agents()[0].credentialState, 'ready')
  assert.equal(agents()[0].available, true)
  assert.equal(agents()[0].availabilitySource, 'native-auth-status')
  assert.deepEqual(events, ['save', 'emit', 'snapshot'])
})

test('failed refresh preserves the previous Agent list without emitting changes', async () => {
  const previous = [{ kind: 'codex', available: true }]
  const { agents, catalog, events } = fixture({
    initialAgents: previous,
    detectAgents: async () => [{ kind: 'hermes' }],
    credentialState: async () => { throw new Error('credential probe failed') },
  })

  await assert.rejects(catalog.refresh(), { message: 'credential probe failed' })
  assert.equal(agents(), previous)
  assert.deepEqual(events, [])
})

test('sidebar and runtime credential mutations preserve persistence and event ordering', () => {
  const initialAgent = {
    kind: 'codex', available: true, credentialState: 'ready', showInSidebar: true,
  }
  const { agents, catalog, events, state } = fixture({ initialAgents: [initialAgent] })

  assert.deepEqual(catalog.setSidebarVisibility('codex', false), { agents: [initialAgent] })
  assert.deepEqual(events, ['save', 'emit', 'snapshot'])
  assert.equal(state.agentPreferences.codex.showInSidebar, false)

  events.length = 0
  catalog.markRuntimeCredential('codex', 'missing')
  assert.deepEqual(events, ['save', 'emit'])
  assert.deepEqual(state.agentRuntime.codex, {
    credentialState: 'missing', checkedAt: '2026-08-03T00:00:00.000Z',
  })
  assert.equal(agents()[0].available, false)
  assert.equal(agents()[0].availabilitySource, 'runtime-auth-failure')
  assert.equal(agents()[0].showInSidebar, false)

  events.length = 0
  state.agentRuntime.hermes = { credentialState: 'missing' }
  catalog.markRuntimeCredential('codex', 'unknown')
  assert.deepEqual(events, ['save', 'emit'])
  assert.equal(state.agentRuntime.codex.credentialState, 'unknown')
  assert.equal(state.agentRuntime.hermes.credentialState, 'missing')
  assert.equal(agents()[0].credentialState, 'unknown')
  assert.equal(agents()[0].available, false)
  assert.equal(agents()[0].availabilitySource, 'unverified')
})

test('review-only Agents cannot be enabled in the conversation sidebar', () => {
  const reviewAgent = {
    kind: 'opencodereview', available: true, credentialState: 'ready', showInSidebar: false,
  }
  const { catalog, events } = fixture({ initialAgents: [reviewAgent] })

  assert.throws(
    () => catalog.setSidebarVisibility('opencodereview', true),
    { message: 'LOCAL_AGENT_REVIEW_ONLY' },
  )
  assert.deepEqual(events, [])
})

test('runtime credential cleanup removes only missing entries and never emits', () => {
  const { catalog, events, state } = fixture()
  state.agentRuntime = {
    codex: { credentialState: 'missing' },
    hermes: { credentialState: 'ready' },
    kimi: { credentialState: 'unknown' },
  }

  assert.equal(catalog.clearRuntimeCredentialFailures(), true)
  assert.deepEqual(state.agentRuntime, {
    hermes: { credentialState: 'ready' },
    kimi: { credentialState: 'unknown' },
  })
  assert.deepEqual(events, ['save'])

  events.length = 0
  assert.equal(catalog.clearRuntimeCredentialFailures(), false)
  assert.deepEqual(events, [])
})
