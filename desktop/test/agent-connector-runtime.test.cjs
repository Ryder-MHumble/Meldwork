const assert = require('node:assert/strict')
const test = require('node:test')

const { createAgentConnectorManifest } = require('../src/agent-connector-manifest.cjs')
const { AgentConnectorRegistry } = require('../src/agent-connector-registry.cjs')
const { AgentConnectorRuntime } = require('../src/agent-connector-runtime.cjs')

function manifestInput(overrides = {}) {
  return {
    connectorId: 'external.review-agent',
    connectorVersion: '1.0.0',
    kind: 'agent',
    label: 'External Review Agent',
    description: 'External structured review sample.',
    transport: { type: 'http', protocol: 'event-stream' },
    upstream: { id: 'review-service', minVersion: '3.0.0', maxVersion: '3.4.0' },
    invocation: { recipeId: 'external.review-agent.run' },
    domains: ['software-review'],
    session: { supported: true, resume: true, cancel: true, checkpoint: true },
    inputTypes: ['text', 'file'],
    permissionModes: ['read-only'],
    eventProtocolVersion: 1,
    eventTypes: [
      'Permission', 'SourceUsed', 'Artifact', 'Evidence', 'Usage',
      'WaitingInput', 'Completed', 'Failed', 'Cancelled',
    ],
    usage: {
      inputTokens: true,
      outputTokens: true,
      costMicros: true,
      toolCalls: true,
      outboundBytes: true,
      elapsedMs: true,
    },
    outboundDestinations: ['https://review.example.com'],
    credentials: {
      mode: 'credential-ref',
      slots: [{ slotId: 'account', type: 'oauth', required: true }],
    },
    license: 'Apache-2.0',
    ...overrides,
  }
}

function runtimeFixture(handler, overrides = {}) {
  const manifest = createAgentConnectorManifest(manifestInput(overrides))
  const registry = new AgentConnectorRegistry({
    approvedRecipeIds: ['external.review-agent.run'],
    approvedExternalManifestIds: [manifest.manifestId],
  })
  registry.registerExternal(manifest)
  registry.registerInstance({
    instanceId: 'custom-aaaaaaaaaaaaaaaa',
    connectorId: manifest.connectorId,
    connectorVersion: manifest.connectorVersion,
    upstreamVersion: '3.2.0',
    label: 'Review account A',
    credentialRef: 'credential-ref:review-account-a',
  })
  return {
    manifest,
    registry,
    runtime: new AgentConnectorRuntime({
      registry,
      recipes: { 'external.review-agent.run': handler },
    }),
  }
}

test('discovers and runs an approved external Connector with trusted durable provenance', async () => {
  const states = []
  const uiEvents = []
  const { manifest, runtime } = runtimeFixture(async (input) => {
    assert.equal(input.credentialRefId, 'credential-ref:review-account-a')
    assert.equal(input.connector.connectorVersion, '1.0.0')
    assert.equal(input.connector.upstreamVersion, '3.2.0')
    assert.equal(input.permissionMode, 'read-only')
    assert.equal(Object.hasOwn(input, 'executable'), false)
    assert.equal(Object.isFrozen(input.connector), true)
    input.emit({
      eventId: 'event-3', cursor: 'cursor-3', sequence: 3,
      type: 'Completed', outcome: 'completed', summary: 'Review complete.',
    })
    const source = {
      eventId: 'event-1', cursor: 'cursor-1', sequence: 1,
      type: 'SourceUsed', sourceId: 'source-1', sourceType: 'workspace-file',
      contentHash: 'd'.repeat(64), citation: 'src/index.js:10',
    }
    input.emit(source)
    input.emit({
      eventId: 'event-2', cursor: 'cursor-2', sequence: 2,
      type: 'Progress', rawOutput: 'Bearer connector-secret',
    })
    input.emit(source)
    return { text: 'External review result', sessionRef: 'review-session' }
  })

  const agents = runtime.detectAgents()
  assert.deepEqual(agents.map(agent => agent.kind), ['custom-aaaaaaaaaaaaaaaa'])
  assert.equal(agents[0].connectorInstanceId, 'custom-aaaaaaaaaaaaaaaa')
  assert.equal(Object.hasOwn(agents[0], 'credentialRef'), false)

  const result = await runtime.run(agents[0], 'Review the change', '/tmp/workspace', {
    runId: 'run-1',
    agentRunId: 'agent-run-1',
    sandbox: 'read-only',
    onConnectorState: context => states.push(context),
    onEvent: event => uiEvents.push(event),
  })
  assert.equal(result.text, 'External review result')
  assert.equal(result.outcome, 'completed')
  assert.equal(result.connector.manifestId, manifest.manifestId)
  assert.deepEqual(result.connectorEventState.events.map(event => event.type), [
    'SourceUsed', 'Unknown', 'Completed',
  ])
  assert.equal(result.connectorEventState.events[1].originalType, 'Progress')
  assert.doesNotMatch(JSON.stringify(result.connectorEventState), /connector-secret/)
  assert.equal(states.length, 4)
  assert.deepEqual(states.at(-1).connectorEventState, result.connectorEventState)
  assert.equal(uiEvents.length, 3)
  assert.equal(uiEvents.every(event => !Object.hasOwn(event, 'rawOutput')), true)
})

test('fails closed when a recipe, permission mode, or terminal event is missing', async () => {
  const missingTerminal = runtimeFixture(async () => ({ text: 'Not terminal' })).runtime
  await assert.rejects(
    missingTerminal.run(missingTerminal.detectAgents()[0], 'Review', '/tmp/workspace', {
      runId: 'run-1', agentRunId: 'agent-run-1', sandbox: 'read-only',
    }),
    { message: 'AGENT_CONNECTOR_TERMINAL_EVENT_REQUIRED' },
  )
  const permissionStates = []
  await assert.rejects(
    missingTerminal.run(missingTerminal.detectAgents()[0], 'Review', '/tmp/workspace', {
      runId: 'run-2', agentRunId: 'agent-run-2', sandbox: 'workspace-write',
      onConnectorState: context => permissionStates.push(context),
    }),
    { message: 'AGENT_CONNECTOR_PERMISSION_MODE_UNSUPPORTED' },
  )
  assert.equal(permissionStates.length, 1)
  assert.equal(permissionStates[0].connector.connectorVersion, '1.0.0')
  assert.deepEqual(permissionStates[0].connectorEventState.events, [])

  const { registry } = runtimeFixture(async () => ({ text: 'unused' }))
  const missingRecipe = new AgentConnectorRuntime({ registry })
  const recipeStates = []
  await assert.rejects(
    missingRecipe.run(missingRecipe.detectAgents()[0], 'Review', '/tmp/workspace', {
      runId: 'run-3', agentRunId: 'agent-run-3', sandbox: 'read-only',
      onConnectorState: context => recipeStates.push(context),
    }),
    { message: 'AGENT_CONNECTOR_RECIPE_UNAVAILABLE' },
  )
  assert.equal(recipeStates.length, 1)
  assert.equal(recipeStates[0].connector.connectorVersion, '1.0.0')
})

test('passes one durable operation ID through repeated idempotent Connector calls', async () => {
  const received = []
  const { runtime } = runtimeFixture(async (input) => {
    received.push({
      operationId: input.operationId,
      idempotencyKey: input.idempotencyKey,
      mode: input.connector.capabilities.idempotencyMode,
    })
    input.emit({
      eventId: `${input.agentRunId}:completed`,
      cursor: `${input.agentRunId}:completed`,
      sequence: 1,
      type: 'Completed',
      outcome: 'completed',
    })
    return { text: 'done', sessionRef: '' }
  }, {
    invocation: { recipeId: 'external.review-agent.run', idempotencyMode: 'durable' },
    permissionModes: ['read-only', 'workspace-write'],
  })
  const [agent] = runtime.detectAgents()
  const operationId = `agent-operation-${'c'.repeat(64)}`

  await runtime.run(agent, 'Write once', '/tmp/workspace', {
    runId: 'run-1', agentRunId: 'agent-run-1', sandbox: 'workspace-write', operationId,
  })
  await runtime.run(agent, 'Write once', '/tmp/workspace', {
    runId: 'run-1', agentRunId: 'agent-run-2', sandbox: 'workspace-write', operationId,
  })

  assert.deepEqual(received, [
    { operationId, idempotencyKey: operationId, mode: 'durable' },
    { operationId, idempotencyKey: operationId, mode: 'durable' },
  ])
})
