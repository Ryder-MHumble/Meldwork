const assert = require('node:assert/strict')
const test = require('node:test')

const { createAgentConnectorManifest } = require('../src/agent-connector-manifest.cjs')
const {
  AgentConnectorRegistry,
  parseConnectorRunSnapshot,
} = require('../src/agent-connector-registry.cjs')

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
      toolCalls: false,
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

test('fails closed for unapproved recipes and untrusted external Manifests', () => {
  const manifest = createAgentConnectorManifest(manifestInput())
  assert.throws(
    () => new AgentConnectorRegistry().registerBuiltin(manifest),
    { message: 'AGENT_CONNECTOR_RECIPE_UNAPPROVED' },
  )
  const registry = new AgentConnectorRegistry({
    approvedRecipeIds: ['external.review-agent.run'],
  })
  assert.throws(
    () => registry.registerExternal(manifest),
    { message: 'AGENT_CONNECTOR_MANIFEST_UNTRUSTED' },
  )
})

test('discovers an approved external Connector without a core Agent allowlist', () => {
  const manifest = createAgentConnectorManifest(manifestInput())
  const builtin = createAgentConnectorManifest(manifestInput({
    connectorId: 'builtin.local-agent',
    connectorVersion: '2.0.0',
    label: 'Built-in Local Agent',
    description: 'Built-in local Connector sample.',
    transport: { type: 'cli', protocol: 'jsonl' },
    upstream: { id: 'local-agent-cli', minVersion: '1.0.0', maxVersion: '1.9.0' },
    invocation: { recipeId: 'builtin.local-agent.run' },
    outboundDestinations: [],
    credentials: { mode: 'none', slots: [] },
  }))
  const registry = new AgentConnectorRegistry({
    approvedRecipeIds: ['external.review-agent.run', 'builtin.local-agent.run'],
    approvedExternalManifestIds: [manifest.manifestId],
  })
  assert.deepEqual(registry.registerExternal(manifest), manifest)
  assert.deepEqual(registry.registerBuiltin(builtin), builtin)
  const discovered = registry.listManifests()
  assert.equal(discovered.length, 2)
  assert.deepEqual(discovered.map(item => [item.connectorId, item.trust]), [
    ['builtin.local-agent', 'builtin'],
    ['external.review-agent', 'external'],
  ])
  assert.equal(Object.isFrozen(discovered[0]), true)
})

test('supports multiple instances and keeps CredentialRefs out of Run provenance', () => {
  const manifest = createAgentConnectorManifest(manifestInput())
  const registry = new AgentConnectorRegistry({
    approvedRecipeIds: ['external.review-agent.run'],
    approvedExternalManifestIds: [manifest.manifestId],
  })
  registry.registerExternal(manifest)
  const first = registry.registerInstance({
    instanceId: 'review-account-a',
    connectorId: manifest.connectorId,
    connectorVersion: manifest.connectorVersion,
    upstreamVersion: '3.2.0',
    label: 'Review account A',
    credentialRef: 'credential-ref:review-account-a',
  })
  const second = registry.registerInstance({
    instanceId: 'review-account-b',
    connectorId: manifest.connectorId,
    connectorVersion: manifest.connectorVersion,
    upstreamVersion: '3.3.0',
    label: 'Review account B',
    credentialRef: 'credential-ref:review-account-b',
  })
  assert.notEqual(first.credentialRef, second.credentialRef)
  assert.equal(registry.listInstances().length, 2)

  const provenance = registry.runProvenance(first.instanceId)
  assert.deepEqual(provenance, {
    protocolVersion: 1,
    connectorId: manifest.connectorId,
    connectorVersion: manifest.connectorVersion,
    manifestId: manifest.manifestId,
    instanceId: first.instanceId,
    upstreamId: manifest.upstream.id,
    upstreamVersion: first.upstreamVersion,
  })
  assert.equal(Object.hasOwn(provenance, 'credentialRef'), false)
  const snapshot = registry.runSnapshot(first.instanceId)
  assert.equal(snapshot.connectorVersion, manifest.connectorVersion)
  assert.equal(snapshot.upstreamVersion, first.upstreamVersion)
  assert.equal(Object.hasOwn(snapshot, 'credentialRefId'), false)
  assert.deepEqual(snapshot.transport, manifest.transport)
  assert.deepEqual(snapshot.capabilities.eventTypes, manifest.eventTypes)
  assert.equal(Object.isFrozen(snapshot.capabilities), true)
  assert.deepEqual(parseConnectorRunSnapshot(JSON.stringify(snapshot)), snapshot)
  const execution = registry.resolveExecution(first.instanceId)
  assert.equal(execution.recipeId, 'external.review-agent.run')
  assert.equal(execution.credentialRef, 'credential-ref:review-account-a')
  assert.deepEqual(execution.provenance, provenance)
  assert.deepEqual(execution.runtimeProvenance, {
    connectorId: manifest.connectorId,
    connectorVersion: manifest.connectorVersion,
    manifestId: manifest.manifestId,
    manifestSchemaVersion: manifest.schemaVersion,
    instanceId: first.instanceId,
    recipeId: manifest.invocation.recipeId,
    upstreamId: manifest.upstream.id,
    upstreamVersion: first.upstreamVersion,
    credentialRefId: 'credential-ref:review-account-a',
  })
  assert.equal(Object.isFrozen(execution.runtimeProvenance), true)
  assert.throws(
    () => parseConnectorRunSnapshot({ ...snapshot, connectorVersion: 'not-semver' }),
    { message: 'AGENT_CONNECTOR_RUN_SNAPSHOT_INVALID' },
  )
})

test('rejects incompatible upstreams, missing CredentialRefs, and duplicate instances', () => {
  const manifest = createAgentConnectorManifest(manifestInput())
  const registry = new AgentConnectorRegistry({
    approvedRecipeIds: ['external.review-agent.run'],
    approvedExternalManifestIds: [manifest.manifestId],
  })
  registry.registerExternal(manifest)
  const input = {
    instanceId: 'review-account-a',
    connectorId: manifest.connectorId,
    connectorVersion: manifest.connectorVersion,
    upstreamVersion: '3.2.0',
    label: 'Review account A',
    credentialRef: 'credential-ref:review-account-a',
  }
  assert.throws(
    () => registry.registerInstance({ ...input, upstreamVersion: '4.0.0' }),
    { message: 'AGENT_CONNECTOR_UPSTREAM_INCOMPATIBLE' },
  )
  assert.throws(
    () => registry.registerInstance({ ...input, credentialRef: null }),
    { message: 'AGENT_CONNECTOR_CREDENTIAL_REF_INVALID' },
  )
  assert.throws(
    () => registry.registerInstance({
      ...input,
      credentialRef: 'credential-ref:sk-abcdefghijklmnopqrstuvwxyz',
    }),
    { message: 'AGENT_CONNECTOR_INSTANCE_INVALID' },
  )
  registry.registerInstance(input)
  assert.throws(
    () => registry.registerInstance(input),
    { message: 'AGENT_CONNECTOR_INSTANCE_CONFLICT' },
  )
})
