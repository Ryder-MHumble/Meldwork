const assert = require('node:assert/strict')
const test = require('node:test')

const {
  normalizeCloudAgentConnector,
  parseCloudObservation,
  parseCloudSubmitResult,
} = require('../src/cloud-agent-contract.cjs')
const { RUN_EVENT_TYPES } = require('../src/agent-connector-manifest.cjs')

function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    connectorId: 'cloud.mock',
    connectorVersion: '1.0.0',
    manifestId: `connector-manifest-${'a'.repeat(64)}`,
    instanceId: 'cloud.mock.account',
    upstreamId: 'mock-cloud-service',
    upstreamVersion: '2.0.0',
    recipeId: 'cloud.mock.recipe',
    transport: { type: 'http', protocol: 'event-stream' },
    capabilities: {
      domains: ['coding'],
      session: { supported: true, resume: true, cancel: true, checkpoint: true },
      inputTypes: ['text'],
      permissionModes: ['read-only', 'workspace-write'],
      eventProtocolVersion: 1,
      eventTypes: [...RUN_EVENT_TYPES],
      usage: {
        inputTokens: true, outputTokens: true, costMicros: true,
        toolCalls: true, outboundBytes: true, elapsedMs: true,
      },
      outboundDestinations: ['https://cloud.example'],
    },
    ...overrides,
  }
}

test('normalizes the optional Cloud Agent contract with observe or poll', async () => {
  const calls = []
  const connector = normalizeCloudAgentConnector({
    snapshot: snapshot(),
    submit: async input => {
      calls.push(['submit', input])
      return { jobId: 'job-1', cursor: 'cursor-0' }
    },
    poll: async input => {
      calls.push(['poll', input])
      return { cursor: 'cursor-1', events: [] }
    },
    provideInput: async input => calls.push(['input', input]),
    decidePermission: async input => calls.push(['permission', input]),
    cancel: async input => calls.push(['cancel', input]),
    fetchArtifacts: async input => {
      calls.push(['artifacts', input])
      return []
    },
    reconcile: async input => {
      calls.push(['reconcile', input])
      return { cursor: input.cursor, events: [] }
    },
  })

  assert.equal(connector.connectorId, 'cloud.mock')
  assert.equal(Object.isFrozen(connector), true)
  assert.equal(Object.isFrozen(connector.snapshot), true)
  assert.deepEqual(parseCloudSubmitResult(await connector.submit({ value: 1 })), {
    jobId: 'job-1', cursor: 'cursor-0', events: [],
  })
  assert.deepEqual(parseCloudObservation(await connector.observe({ cursor: 'cursor-0' })), {
    cursor: 'cursor-1', events: [],
  })
  assert.deepEqual(calls.map(([method]) => method), ['submit', 'poll'])
})

test('fails closed for local transports, ambiguous observation, and malformed results', () => {
  const base = { snapshot: snapshot(), submit() {}, poll() {} }
  assert.throws(
    () => normalizeCloudAgentConnector({ ...base, snapshot: snapshot({
      transport: { type: 'cli', protocol: 'jsonl' },
    }) }),
    { message: 'CLOUD_AGENT_CONNECTOR_INVALID' },
  )
  assert.throws(
    () => normalizeCloudAgentConnector({ ...base, observe() {} }),
    { message: 'CLOUD_AGENT_CONNECTOR_INVALID' },
  )
  assert.throws(
    () => normalizeCloudAgentConnector({ snapshot: snapshot(), submit() {} }),
    { message: 'CLOUD_AGENT_CONNECTOR_INVALID' },
  )
  assert.throws(
    () => parseCloudSubmitResult({ jobId: '../unsafe' }),
    { message: 'CLOUD_AGENT_REMOTE_REF_INVALID' },
  )
  assert.throws(
    () => parseCloudObservation({ cursor: 'cursor-1', events: [], rawPayload: 'private' }),
    { message: 'CLOUD_AGENT_OBSERVATION_INVALID' },
  )
})
