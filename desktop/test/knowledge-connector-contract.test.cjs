const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const test = require('node:test')

const {
  KNOWLEDGE_CONNECTOR_CONTRACT_VERSION,
  MAX_KNOWLEDGE_CONTENT_BYTES,
  assertKnowledgeConnector,
  createKnowledgeCitationRecord,
  createKnowledgeSnapshotRecord,
  normalizeKnowledgeConnectorInstance,
  normalizeKnowledgeContent,
  normalizeSourceDescriptor,
  parseKnowledgeCitationRecord,
  parseKnowledgeSnapshotRecord,
  publicKnowledgeConnectorInstance,
  stableKnowledgeSourceId,
} = require('../src/knowledge-connector-contract.cjs')

function instanceInput(overrides = {}) {
  return {
    instanceId: 'remote-account-1',
    connectorId: 'knowledge.remote',
    accountId: 'account-1',
    label: 'Remote knowledge',
    scope: { scopeId: 'team-space-1', kind: 'remote' },
    accessMode: 'read-only',
    snapshotCapability: 'immutable',
    egressLimit: { maxResults: 10, maxContentBytes: 4096 },
    credentialLifecycle: 'persistent',
    credentialRef: 'credential-ref:opaque-reference-7',
    ...overrides,
  }
}

function contentRef(content, mediaType = 'text/plain') {
  const bytes = Buffer.from(content)
  return {
    algorithm: 'sha256',
    hash: crypto.createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    mediaType,
  }
}

test('projects scoped instance metadata without exposing CredentialRefs', () => {
  const privateInstance = normalizeKnowledgeConnectorInstance(instanceInput())
  const publicInstance = publicKnowledgeConnectorInstance(privateInstance)

  assert.equal(publicInstance.contractVersion, KNOWLEDGE_CONNECTOR_CONTRACT_VERSION)
  assert.equal(publicInstance.accountId, 'account-1')
  assert.deepEqual(publicInstance.scope, { kind: 'remote', scopeId: 'team-space-1' })
  assert.equal(publicInstance.accessMode, 'read-only')
  assert.equal(publicInstance.snapshotCapability, 'immutable')
  assert.deepEqual(publicInstance.egressLimit, { maxContentBytes: 4096, maxResults: 10 })
  assert.equal(publicInstance.credentialLifecycle, 'persistent')
  assert.equal(publicInstance.credentialConfigured, true)
  assert.equal(Object.hasOwn(publicInstance, 'credentialRef'), false)
  assert.equal(JSON.stringify(publicInstance).includes('opaque-reference-7'), false)
  assert.equal(JSON.stringify(publicInstance).includes('credential-ref:'), false)
  assert.equal(Object.isFrozen(publicInstance.scope), true)

  assert.throws(
    () => normalizeKnowledgeConnectorInstance(instanceInput({
      credentialRef: 'credential-ref:sk-abcdefghijklmnopqrstuvwxyz',
    })),
    { message: 'KNOWLEDGE_CONNECTOR_INSTANCE_INVALID' },
  )
  assert.throws(
    () => normalizeKnowledgeConnectorInstance(instanceInput({
      credentialLifecycle: 'none',
    })),
    { message: 'KNOWLEDGE_CONNECTOR_INSTANCE_INVALID' },
  )
})

test('derives stable scoped source IDs and rejects forged or unbounded content', () => {
  const sourceId = stableKnowledgeSourceId(
    'knowledge.filesystem',
    'vault-1',
    'notes/design.md',
  )
  const content = normalizeKnowledgeContent('bounded source')
  const source = normalizeSourceDescriptor({
    sourceId,
    connectorId: 'knowledge.filesystem',
    scopeId: 'vault-1',
    locator: 'notes/design.md',
    title: 'design.md',
    mediaType: 'text/markdown',
    contentHash: content.contentHash,
    size: content.size,
    snippet: 'bounded source',
  })

  assert.equal(source.sourceId, sourceId)
  assert.equal(stableKnowledgeSourceId(
    'knowledge.filesystem',
    'vault-1',
    'notes/design.md',
  ), sourceId)
  assert.throws(
    () => normalizeSourceDescriptor({ ...source, sourceId: `knowledge-source-${'0'.repeat(64)}` }),
    { message: 'KNOWLEDGE_SOURCE_DESCRIPTOR_INVALID' },
  )
  assert.throws(
    () => stableKnowledgeSourceId('knowledge.filesystem', 'vault-1', '../outside.md'),
    { message: 'KNOWLEDGE_SOURCE_ID_INPUT_INVALID' },
  )
  assert.throws(
    () => normalizeKnowledgeContent(Buffer.from([0xff, 0xfe, 0xfd])),
    { message: 'KNOWLEDGE_CONTENT_INVALID' },
  )
  assert.throws(
    () => normalizeKnowledgeContent(Buffer.alloc(MAX_KNOWLEDGE_CONTENT_BYTES + 1, 0x61)),
    { message: 'KNOWLEDGE_CONTENT_INVALID' },
  )
})

test('content-addresses immutable snapshots and verifiable citations', () => {
  const ref = contentRef('captured source')
  const sourceId = stableKnowledgeSourceId('knowledge.memory', 'memory-1', 'guide.txt')
  const snapshot = createKnowledgeSnapshotRecord({
    connectorId: 'knowledge.memory',
    instanceId: 'memory-instance-1',
    scopeId: 'memory-1',
    sourceId,
    locator: 'guide.txt',
    title: 'Guide',
    contentRef: ref,
    contentHash: ref.hash,
    mediaType: 'text/plain',
  })
  const citation = createKnowledgeCitationRecord({
    connectorId: 'knowledge.memory',
    instanceId: 'memory-instance-1',
    scopeId: 'memory-1',
    sourceId,
    locator: 'guide.txt',
    contentHash: ref.hash,
    snapshotId: snapshot.snapshotId,
    contentRef: ref,
    verification: 'snapshot',
  })

  assert.match(snapshot.snapshotId, /^knowledge-snapshot-[a-f0-9]{64}$/)
  assert.match(citation.citationId, /^knowledge-citation-[a-f0-9]{64}$/)
  assert.deepEqual(parseKnowledgeSnapshotRecord(snapshot), snapshot)
  assert.deepEqual(parseKnowledgeCitationRecord(citation), citation)
  assert.throws(
    () => parseKnowledgeSnapshotRecord({ ...snapshot, title: 'Forged' }),
    { message: 'KNOWLEDGE_SNAPSHOT_ID_MISMATCH' },
  )
  assert.throws(
    () => parseKnowledgeCitationRecord({
      ...citation,
      citationId: `knowledge-citation-${'0'.repeat(64)}`,
    }),
    { message: 'KNOWLEDGE_CITATION_ID_MISMATCH' },
  )
})

test('requires all seven Knowledge Connector operations', () => {
  const connector = {
    contractVersion: KNOWLEDGE_CONNECTOR_CONTRACT_VERSION,
    connectorId: 'knowledge.test',
    authorize() {},
    revoke() {},
    probe() {},
    search() {},
    fetch() {},
    snapshot() {},
    citation() {},
  }
  assert.equal(assertKnowledgeConnector(connector), connector)
  assert.throws(
    () => assertKnowledgeConnector({ ...connector, citation: undefined }),
    { message: 'KNOWLEDGE_CONNECTOR_CONTRACT_INVALID' },
  )
})
