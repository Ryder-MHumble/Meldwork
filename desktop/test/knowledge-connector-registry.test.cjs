const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { ContentBlobStore } = require('../src/content-blob-store.cjs')
const {
  KNOWLEDGE_CONNECTOR_CONTRACT_VERSION,
  normalizeKnowledgeConnectorInstance,
  normalizeProbeResult,
  publicKnowledgeConnectorInstance,
} = require('../src/knowledge-connector-contract.cjs')
const {
  FilesystemKnowledgeConnector,
} = require('../src/knowledge-connector-filesystem.cjs')
const { MemoryKnowledgeConnector } = require('../src/knowledge-connector-memory.cjs')
const { KnowledgeConnectorRegistry } = require('../src/knowledge-connector-registry.cjs')

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-knowledge-registry-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const contentBlobStore = new ContentBlobStore({
    rootPath: path.join(directory, 'private', 'blobs'),
  })
  const vaultPath = path.join(directory, 'vault')
  fs.mkdirSync(vaultPath)
  fs.writeFileSync(path.join(vaultPath, 'vault.md'), 'Vault connector evidence')
  const filesystem = new FilesystemKnowledgeConnector({
    rootPath: vaultPath,
    scopeId: 'vault-1',
    contentBlobStore,
  })
  const memory = new MemoryKnowledgeConnector({
    scopeId: 'memory-1',
    contentBlobStore,
    documents: [{
      locator: 'memory.md',
      title: 'Memory evidence',
      mediaType: 'text/markdown',
      content: 'Memory connector evidence',
    }],
  })
  return {
    registry: new KnowledgeConnectorRegistry({ connectors: [filesystem, memory] }),
    filesystem,
  }
}

function instanceInput(kind) {
  const filesystem = kind === 'filesystem'
  return {
    instanceId: filesystem ? 'vault-instance-1' : 'memory-instance-1',
    connectorId: filesystem ? 'knowledge.filesystem' : 'knowledge.memory',
    accountId: 'local-user',
    label: filesystem ? 'Local vault' : 'Memory documents',
    scope: {
      scopeId: filesystem ? 'vault-1' : 'memory-1',
      kind,
    },
    accessMode: 'read-only',
    snapshotCapability: 'immutable',
    egressLimit: { maxResults: 10, maxContentBytes: 4096 },
    credentialLifecycle: 'none',
    credentialRef: null,
  }
}

test('routes all seven operations across two conforming implementations', async (t) => {
  const { registry } = fixture(t)
  assert.deepEqual(registry.listConnectors().map(item => item.connectorId), [
    'knowledge.filesystem',
    'knowledge.memory',
  ])
  await registry.authorize('knowledge.filesystem', instanceInput('filesystem'))
  await registry.authorize('knowledge.memory', instanceInput('memory'))
  assert.equal(registry.listInstances().length, 2)
  assert.equal(JSON.stringify(registry.listInstances()).includes('credentialRef'), false)

  const probe = await registry.probe('vault-instance-1')
  assert.equal(probe.status, 'ready')
  const search = await registry.search('vault-instance-1', { query: 'evidence', limit: 5 })
  assert.equal(search.length, 1)
  const sourceRequest = {
    sourceId: search[0].sourceId,
    locator: search[0].locator,
  }
  const fetched = await registry.fetch('vault-instance-1', sourceRequest)
  assert.equal(fetched.content, 'Vault connector evidence')
  const snapshot = await registry.snapshot('vault-instance-1', sourceRequest)
  const citation = await registry.citation('vault-instance-1', { snapshot })
  assert.equal(citation.content, fetched.content)
  assert.equal(citation.citation.verification, 'snapshot')

  const memorySearch = await registry.search(
    'memory-instance-1',
    { query: 'memory', limit: 5 },
  )
  assert.equal(memorySearch.length, 1)
  const revoked = await registry.revoke('memory-instance-1')
  assert.equal(revoked.authorized, false)
  await assert.rejects(
    () => registry.probe('memory-instance-1'),
    { message: 'KNOWLEDGE_CONNECTOR_INSTANCE_NOT_FOUND' },
  )
})

test('keeps opaque CredentialRefs inside the authorized Connector', async () => {
  const instances = new Map()
  const remote = {
    contractVersion: KNOWLEDGE_CONNECTOR_CONTRACT_VERSION,
    connectorId: 'knowledge.remote',
    authorize(input) {
      const instance = normalizeKnowledgeConnectorInstance(input, this.connectorId)
      instances.set(instance.instanceId, instance)
      return publicKnowledgeConnectorInstance(instance)
    },
    revoke(instanceId) {
      const instance = instances.get(instanceId)
      instances.delete(instanceId)
      return publicKnowledgeConnectorInstance(instance, false)
    },
    probe(instanceId) {
      const instance = instances.get(instanceId)
      return normalizeProbeResult({
        status: 'ready',
        instance: publicKnowledgeConnectorInstance(instance),
      }, instance)
    },
    search() { return [] },
    fetch() { throw new Error('not used') },
    snapshot() { throw new Error('not used') },
    citation() { throw new Error('not used') },
  }
  const registry = new KnowledgeConnectorRegistry({ connectors: [remote] })
  const publicInstance = await registry.authorize('knowledge.remote', {
    instanceId: 'remote-instance-1',
    connectorId: 'knowledge.remote',
    accountId: 'remote-account',
    label: 'Remote knowledge',
    scope: { scopeId: 'remote-scope', kind: 'remote' },
    accessMode: 'read-only',
    snapshotCapability: 'live-reference',
    egressLimit: { maxResults: 5, maxContentBytes: 1024 },
    credentialLifecycle: 'session',
    credentialRef: 'credential-ref:opaque-reference-7',
  })

  assert.equal(publicInstance.credentialConfigured, true)
  assert.equal(instances.get('remote-instance-1').credentialRef,
    'credential-ref:opaque-reference-7')
  assert.equal(JSON.stringify(registry.listInstances()).includes('opaque-reference-7'), false)
  assert.equal(JSON.stringify(registry.listInstances()).includes('credentialRef'), false)
})

test('rejects duplicate Connectors, cross-scope source IDs, and duplicate instances', async (t) => {
  const { filesystem, registry } = fixture(t)
  assert.throws(
    () => registry.register(filesystem),
    { message: 'KNOWLEDGE_CONNECTOR_CONFLICT' },
  )
  await registry.authorize('knowledge.filesystem', instanceInput('filesystem'))
  await assert.rejects(
    () => registry.authorize('knowledge.filesystem', instanceInput('filesystem')),
    { message: 'KNOWLEDGE_CONNECTOR_INSTANCE_CONFLICT' },
  )
  await assert.rejects(
    () => registry.fetch('vault-instance-1', {
      sourceId: `knowledge-source-${'0'.repeat(64)}`,
      locator: 'vault.md',
    }),
    { message: 'KNOWLEDGE_SOURCE_SCOPE_MISMATCH' },
  )
})
