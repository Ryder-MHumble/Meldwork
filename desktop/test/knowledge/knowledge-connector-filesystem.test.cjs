const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { ContentBlobStore } = require('../../src/attachments/content-blob-store.cjs')
const {
  FilesystemKnowledgeConnector,
} = require('../../src/knowledge/knowledge-connector-filesystem.cjs')
const { stableKnowledgeSourceId } = require('../../src/knowledge/knowledge-connector-contract.cjs')

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-knowledge-fs-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const rootPath = path.join(directory, 'vault')
  fs.mkdirSync(path.join(rootPath, 'notes'), { recursive: true })
  const contentBlobStore = new ContentBlobStore({
    rootPath: path.join(directory, 'private', 'blobs'),
  })
  const connector = new FilesystemKnowledgeConnector({
    rootPath,
    scopeId: 'vault-1',
    contentBlobStore,
  })
  return { connector, contentBlobStore, directory, rootPath }
}

function instanceInput(overrides = {}) {
  return {
    instanceId: 'vault-instance-1',
    connectorId: 'knowledge.filesystem',
    accountId: 'local-user',
    label: 'Local vault',
    scope: { scopeId: 'vault-1', kind: 'filesystem' },
    accessMode: 'read-only',
    snapshotCapability: 'immutable',
    egressLimit: { maxResults: 10, maxContentBytes: 4096 },
    credentialLifecycle: 'none',
    credentialRef: null,
    ...overrides,
  }
}

test('searches and fetches bounded text with stable source IDs', (t) => {
  const { connector, rootPath } = fixture(t)
  fs.writeFileSync(path.join(rootPath, 'notes', 'design.md'), 'Harness connector design')
  fs.writeFileSync(path.join(rootPath, 'other.txt'), 'Unrelated text')
  connector.authorize(instanceInput())

  const results = connector.search('vault-instance-1', { query: 'connector', limit: 5 })
  assert.equal(results.length, 1)
  assert.equal(results[0].locator, 'notes/design.md')
  assert.equal(results[0].sourceId, stableKnowledgeSourceId(
    'knowledge.filesystem',
    'vault-1',
    'notes/design.md',
  ))
  assert.equal(results[0].mediaType, 'text/markdown')

  const fetched = connector.fetch('vault-instance-1', {
    sourceId: results[0].sourceId,
    locator: results[0].locator,
  })
  assert.equal(fetched.content, 'Harness connector design')
  assert.equal(fetched.source.contentHash, results[0].contentHash)

  fs.writeFileSync(path.join(rootPath, 'notes', 'design.md'), 'Changed connector design')
  const changed = connector.fetch('vault-instance-1', {
    sourceId: results[0].sourceId,
    locator: results[0].locator,
  })
  assert.equal(changed.source.sourceId, results[0].sourceId)
  assert.notEqual(changed.source.contentHash, results[0].contentHash)
})

test('rejects traversal, symlinks, and write authorization', {
  skip: process.platform === 'win32',
}, (t) => {
  const { connector, directory, rootPath, contentBlobStore } = fixture(t)
  fs.writeFileSync(path.join(rootPath, 'notes', 'inside.md'), 'Inside')
  const outside = path.join(directory, 'outside.md')
  fs.writeFileSync(outside, 'Outside')
  fs.symlinkSync(outside, path.join(rootPath, 'notes', 'linked.md'))

  assert.throws(
    () => connector.authorize(instanceInput({ accessMode: 'read-write' })),
    { message: 'KNOWLEDGE_FILESYSTEM_AUTHORIZATION_INVALID' },
  )
  connector.authorize(instanceInput())
  assert.throws(
    () => connector.fetch('vault-instance-1', {
      sourceId: stableKnowledgeSourceId(
        'knowledge.filesystem',
        'vault-1',
        'notes/inside.md',
      ),
      locator: '../outside.md',
    }),
    { message: 'KNOWLEDGE_SOURCE_REQUEST_INVALID' },
  )
  assert.throws(
    () => connector.fetch('vault-instance-1', {
      sourceId: stableKnowledgeSourceId(
        'knowledge.filesystem',
        'vault-1',
        'notes/linked.md',
      ),
      locator: 'notes/linked.md',
    }),
    { message: 'KNOWLEDGE_FILESYSTEM_SYMLINK_REJECTED' },
  )
  assert.throws(
    () => connector.search('vault-instance-1', { query: 'inside', limit: 10 }),
    { message: 'KNOWLEDGE_FILESYSTEM_SYMLINK_REJECTED' },
  )
  assert.equal(fs.readFileSync(outside, 'utf8'), 'Outside')

  const rootLink = path.join(directory, 'vault-link')
  fs.symlinkSync(rootPath, rootLink)
  assert.throws(
    () => new FilesystemKnowledgeConnector({
      rootPath: rootLink,
      scopeId: 'vault-link',
      contentBlobStore,
    }),
    { message: 'KNOWLEDGE_FILESYSTEM_ROOT_UNSAFE' },
  )
})

test('reopens and hash-verifies snapshots after the live source changes', (t) => {
  const { connector, rootPath } = fixture(t)
  const filename = path.join(rootPath, 'notes', 'decision.md')
  fs.writeFileSync(filename, 'Original decision')
  connector.authorize(instanceInput())
  const sourceId = stableKnowledgeSourceId(
    'knowledge.filesystem',
    'vault-1',
    'notes/decision.md',
  )
  const request = { sourceId, locator: 'notes/decision.md' }
  const before = connector.fetch('vault-instance-1', request)
  const snapshot = connector.snapshot('vault-instance-1', request)
  const liveCitation = connector.citation('vault-instance-1', {
    ...request,
    contentHash: before.source.contentHash,
  })
  assert.equal(liveCitation.content, 'Original decision')
  assert.equal(liveCitation.citation.verification, 'live')

  fs.writeFileSync(filename, 'Revised decision')
  const reopened = connector.citation('vault-instance-1', { snapshot })
  assert.equal(reopened.content, 'Original decision')
  assert.equal(reopened.citation.contentHash, snapshot.contentHash)
  assert.equal(reopened.citation.snapshotId, snapshot.snapshotId)
  assert.equal(reopened.citation.verification, 'snapshot')
  assert.throws(
    () => connector.citation('vault-instance-1', {
      ...request,
      contentHash: before.source.contentHash,
    }),
    { message: 'KNOWLEDGE_CITATION_SOURCE_CHANGED' },
  )

  const revoked = connector.revoke('vault-instance-1')
  assert.equal(revoked.authorized, false)
  assert.throws(
    () => connector.fetch('vault-instance-1', request),
    { message: 'KNOWLEDGE_CONNECTOR_INSTANCE_NOT_AUTHORIZED' },
  )
})
