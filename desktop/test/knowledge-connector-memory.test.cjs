const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { ContentBlobStore } = require('../src/content-blob-store.cjs')
const {
  assertKnowledgeConnector,
  stableKnowledgeSourceId,
} = require('../src/knowledge-connector-contract.cjs')
const { MemoryKnowledgeConnector } = require('../src/knowledge-connector-memory.cjs')

function fixture(t, documents) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-knowledge-memory-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const contentBlobStore = new ContentBlobStore({
    rootPath: path.join(directory, 'private', 'blobs'),
  })
  return new MemoryKnowledgeConnector({
    scopeId: 'memory-1',
    contentBlobStore,
    documents,
  })
}

function instanceInput(overrides = {}) {
  return {
    instanceId: 'memory-instance-1',
    connectorId: 'knowledge.memory',
    accountId: 'local-memory',
    label: 'Memory documents',
    scope: { scopeId: 'memory-1', kind: 'memory' },
    accessMode: 'read-only',
    snapshotCapability: 'immutable',
    egressLimit: { maxResults: 5, maxContentBytes: 4096 },
    credentialLifecycle: 'none',
    credentialRef: null,
    ...overrides,
  }
}

test('provides a second conforming Connector over immutable in-memory documents', (t) => {
  const documents = [{
    locator: 'handbook/roles.md',
    title: 'Roles handbook',
    mediaType: 'text/markdown',
    content: 'Reviewer checks evidence before approval.',
  }]
  const connector = fixture(t, documents)
  assert.equal(assertKnowledgeConnector(connector), connector)
  connector.authorize(instanceInput())

  documents[0].content = 'Mutated by caller'
  const results = connector.search('memory-instance-1', { query: 'evidence', limit: 5 })
  assert.equal(results.length, 1)
  assert.equal(results[0].sourceId, stableKnowledgeSourceId(
    'knowledge.memory',
    'memory-1',
    'handbook/roles.md',
  ))
  const fetched = connector.fetch('memory-instance-1', {
    sourceId: results[0].sourceId,
    locator: results[0].locator,
  })
  assert.equal(fetched.content, 'Reviewer checks evidence before approval.')

  const snapshot = connector.snapshot('memory-instance-1', {
    sourceId: results[0].sourceId,
    locator: results[0].locator,
  })
  const citation = connector.citation('memory-instance-1', { snapshot })
  assert.equal(citation.content, fetched.content)
  assert.equal(citation.citation.contentHash, fetched.source.contentHash)
  assert.equal(citation.citation.verification, 'snapshot')
})

test('enforces the same read-only authorization and bounded egress contract', (t) => {
  const connector = fixture(t, [{
    locator: 'large.txt',
    title: 'Large document',
    mediaType: 'text/plain',
    content: 'x'.repeat(256),
  }])
  assert.throws(
    () => connector.authorize(instanceInput({ accessMode: 'read-write' })),
    { message: 'KNOWLEDGE_MEMORY_AUTHORIZATION_INVALID' },
  )
  connector.authorize(instanceInput({
    egressLimit: { maxResults: 5, maxContentBytes: 64 },
  }))
  const sourceId = stableKnowledgeSourceId('knowledge.memory', 'memory-1', 'large.txt')
  assert.deepEqual(
    connector.search('memory-instance-1', { query: 'x', limit: 5 }),
    [],
  )
  assert.throws(
    () => connector.fetch('memory-instance-1', { sourceId, locator: 'large.txt' }),
    { message: 'KNOWLEDGE_CONTENT_LIMIT_EXCEEDED' },
  )
})

test('rejects duplicate locators and unsafe document metadata', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-knowledge-memory-invalid-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const contentBlobStore = new ContentBlobStore({ rootPath: path.join(directory, 'blobs') })
  const document = {
    locator: 'same.txt',
    title: 'Same',
    mediaType: 'text/plain',
    content: 'Same',
  }
  assert.throws(
    () => new MemoryKnowledgeConnector({
      scopeId: 'memory-1',
      contentBlobStore,
      documents: [document, document],
    }),
    { message: 'KNOWLEDGE_MEMORY_DOCUMENT_CONFLICT' },
  )
  assert.throws(
    () => new MemoryKnowledgeConnector({
      scopeId: 'memory-1',
      contentBlobStore,
      documents: [{ ...document, locator: '../outside.txt' }],
    }),
    { message: 'KNOWLEDGE_MEMORY_DOCUMENT_INVALID' },
  )
})
