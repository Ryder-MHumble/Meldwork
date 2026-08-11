const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const test = require('node:test')

const {
  compareSemanticVersions,
  createAgentConnectorManifest,
  isUpstreamVersionCompatible,
  parseAgentConnectorManifest,
  serializeAgentConnectorManifest,
} = require('../../../src/agents/connectors/agent-connector-manifest.cjs')
const { canonicalJson } = require('../../../src/collaboration/outcome-records.cjs')

function manifestInput(overrides = {}) {
  return {
    connectorId: 'example.review-agent',
    connectorVersion: '1.2.0',
    kind: 'agent',
    label: 'Example Review Agent',
    description: 'Produces structured reviews from an approved Main-process recipe.',
    transport: { type: 'cli', protocol: 'jsonl' },
    upstream: {
      id: 'example-cli',
      minVersion: '2.1.0',
      maxVersion: '2.9.0',
    },
    invocation: { recipeId: 'example.review-agent.run' },
    domains: ['software-review'],
    session: { supported: true, resume: true, cancel: true, checkpoint: false },
    inputTypes: ['text', 'file'],
    permissionModes: ['read-only', 'workspace-write'],
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
    outboundDestinations: ['https://api.example.com'],
    credentials: {
      mode: 'credential-ref',
      slots: [{ slotId: 'provider', type: 'api-key', required: true }],
    },
    license: 'Apache-2.0',
    ...overrides,
  }
}

test('creates a strict content-addressed versioned Agent Connector Manifest', () => {
  const manifest = createAgentConnectorManifest(manifestInput())
  const { manifestId, ...body } = manifest
  const hash = crypto.createHash('sha256').update(canonicalJson(body)).digest('hex')
  assert.equal(manifestId, `connector-manifest-${hash}`)
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.recordType, 'agent-connector-manifest')
  assert.deepEqual(
    parseAgentConnectorManifest(serializeAgentConnectorManifest(manifest)),
    manifest,
  )
})

test('fails closed on unknown executable fields, invalid capabilities, and forged IDs', () => {
  assert.throws(
    () => createAgentConnectorManifest({ ...manifestInput(), executable: '/bin/example' }),
    { message: 'AGENT_CONNECTOR_MANIFEST_SCHEMA_INVALID' },
  )
  assert.throws(
    () => createAgentConnectorManifest(manifestInput({
      transport: { type: 'acp', protocol: 'jsonl' },
    })),
    { message: 'AGENT_CONNECTOR_MANIFEST_SCHEMA_INVALID' },
  )
  assert.throws(
    () => createAgentConnectorManifest(manifestInput({
      eventTypes: ['Permission', 'Completed', 'Failed'],
    })),
    { message: 'AGENT_CONNECTOR_MANIFEST_SCHEMA_INVALID' },
  )
  assert.throws(
    () => createAgentConnectorManifest(manifestInput({
      credentials: { mode: 'none', slots: [{ slotId: 'provider', type: 'api-key', required: true }] },
    })),
    { message: 'AGENT_CONNECTOR_MANIFEST_SCHEMA_INVALID' },
  )
  const manifest = createAgentConnectorManifest(manifestInput())
  assert.throws(
    () => parseAgentConnectorManifest({ ...manifest, connectorVersion: '1.2.1' }),
    { message: 'AGENT_CONNECTOR_MANIFEST_ID_MISMATCH' },
  )
})

test('rejects invalid version ranges and unsafe outbound destinations', () => {
  assert.throws(
    () => createAgentConnectorManifest(manifestInput({
      upstream: { id: 'example-cli', minVersion: '3.0.0', maxVersion: '2.0.0' },
    })),
    { message: 'AGENT_CONNECTOR_MANIFEST_SCHEMA_INVALID' },
  )
  for (const destination of [
    'http://api.example.com',
    'https://user:password@example.com',
    'https://api.example.com/v1',
  ]) {
    assert.throws(
      () => createAgentConnectorManifest(manifestInput({
        outboundDestinations: [destination],
      })),
      { message: 'AGENT_CONNECTOR_MANIFEST_SCHEMA_INVALID' },
    )
  }
})

test('evaluates inclusive upstream compatibility with deterministic SemVer ordering', () => {
  const manifest = createAgentConnectorManifest(manifestInput())
  assert.equal(isUpstreamVersionCompatible(manifest, '2.1.0'), true)
  assert.equal(isUpstreamVersionCompatible(manifest, '2.5.4'), true)
  assert.equal(isUpstreamVersionCompatible(manifest, '2.9.0'), true)
  assert.equal(isUpstreamVersionCompatible(manifest, '2.9.1'), false)
  assert.equal(isUpstreamVersionCompatible(manifest, 'unknown'), false)
  assert.equal(compareSemanticVersions('1.0.0-rc.1', '1.0.0'), -1)
  assert.equal(compareSemanticVersions('1.0.0', '1.0.0'), 0)
  assert.equal(compareSemanticVersions('1.0.0-99999999999999999999', '1.0.0-2') > 0, true)
  assert.equal(compareSemanticVersions('99999999999999999999.0.0', '2.0.0') > 0, true)
  assert.equal(compareSemanticVersions('1.0.0-01', '1.0.0'), null)
})
