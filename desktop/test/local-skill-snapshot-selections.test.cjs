const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const { ContentBlobStore } = require('../src/content-blob-store.cjs')
const { LocalSkillCatalog } = require('../src/local-skill-catalog.cjs')
const { LocalSkillSnapshotStore } = require('../src/local-skill-snapshot.cjs')
const { LocalSkillSnapshotSelections } = require('../src/local-skill-snapshot-selections.cjs')
const { LocalSkillTrustStore } = require('../src/local-skill-trust-store.cjs')

function skillManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    recordType: 'meldwork-skill-manifest',
    identity: { id: 'global/review', version: '1.0.0' },
    origin: { type: 'local-unsigned', publisher: 'Local author' },
    agents: [{ kind: 'codex', minVersion: '0.100.0', maxVersion: '1.0.0' }],
    inputTypes: ['text'],
    tools: ['filesystem'],
    credentials: [],
    permissionMode: 'read-only',
    networkDestinations: [],
    sideEffectClass: 'none',
    ...overrides,
  }
}

function removeFixture(directory) {
  if (!fs.existsSync(directory)) return
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      fs.chmodSync(filename, 0o700)
      removeFixture(filename)
    } else {
      fs.chmodSync(filename, 0o600)
    }
  }
  fs.rmSync(directory, { recursive: true, force: true })
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-skill-selections-'))
  t.after(() => removeFixture(directory))
  const skillDirectory = path.join(directory, 'home', '.codex', 'skills', 'review')
  fs.mkdirSync(path.join(skillDirectory, 'references'), { recursive: true })
  fs.writeFileSync(path.join(skillDirectory, 'SKILL.md'), '# Original Skill\n')
  fs.writeFileSync(
    path.join(skillDirectory, 'meldwork.skill.json'),
    `${JSON.stringify(skillManifest())}\n`,
  )
  fs.writeFileSync(path.join(skillDirectory, 'references', 'rules.md'), 'Original rules\n')
  const contentBlobStore = new ContentBlobStore({
    rootPath: path.join(directory, 'private', 'blobs'),
  })
  const snapshotStore = new LocalSkillSnapshotStore({
    contentBlobStore,
    rootPath: path.join(directory, 'private', 'materialized'),
  })
  const catalog = new LocalSkillCatalog({ home: path.join(directory, 'home') })
  const trustStore = new LocalSkillTrustStore({
    storagePath: path.join(directory, 'private', 'skill-trust.jsonl'),
  })
  const approvals = []
  const selections = new LocalSkillSnapshotSelections({
    catalog,
    snapshotStore,
    contentBlobStore,
    trustStore,
    requestTrust: async request => {
      approvals.push(request)
      return true
    },
  })
  return {
    approvals, catalog, contentBlobStore, directory, selections, skillDirectory, trustStore,
  }
}

function persistedHint(value) {
  return JSON.parse(JSON.stringify(value))
}

test('captures a trusted current selection without serializing source or materialized paths', async (t) => {
  const { approvals, catalog, directory, selections } = fixture(t)
  const selected = catalog.list('codex').skills[0]
  const [runtime] = await selections.prepare('codex', [selected])
  const persisted = persistedHint(runtime)

  assert.equal(fs.readFileSync(runtime.entryPath, 'utf8'), '# Original Skill\n')
  assert.deepEqual(Object.keys(persisted).sort(), [
    'manifestHash', 'name', 'namespace', 'slug', 'snapshotId', 'snapshotRef', 'targetKind',
  ])
  assert.equal(JSON.stringify(persisted).includes(directory), false)
  assert.equal(Object.keys(runtime).includes('entryPath'), false)
  assert.equal(Object.keys(runtime).includes('approvedSkillManifest'), false)
  assert.equal(approvals.length, 1)
})

test('restores the same trusted immutable snapshot after the live Skill changes or disappears', async (t) => {
  const { approvals, catalog, selections, skillDirectory } = fixture(t)
  const [captured] = await selections.prepare('codex', [catalog.list('codex').skills[0]])
  const persisted = persistedHint(captured)
  fs.writeFileSync(path.join(skillDirectory, 'SKILL.md'), '# Mutated Skill\n')
  fs.rmSync(path.join(skillDirectory, 'references'), { recursive: true })

  const [restored] = await selections.prepare('codex', [persisted])

  assert.equal(restored.snapshotId, captured.snapshotId)
  assert.equal(fs.readFileSync(restored.entryPath, 'utf8'), '# Original Skill\n')
  assert.equal(
    fs.readFileSync(path.join(path.dirname(restored.entryPath), 'references', 'rules.md'), 'utf8'),
    'Original rules\n',
  )
  assert.equal(approvals.length, 1)
})

test('rejects mixed, forged, missing, or tampered snapshot selections', async (t) => {
  const { catalog, contentBlobStore, selections } = fixture(t)
  const selected = catalog.list('codex').skills[0]
  const [captured] = await selections.prepare('codex', [selected])
  const persisted = persistedHint(captured)

  await assert.rejects(
    selections.prepare('codex', [selected, persisted]),
    { message: 'LOCAL_SKILL_SELECTION_INVALID' },
  )
  await assert.rejects(
    selections.prepare('codex', [{ ...persisted, manifestHash: 'b'.repeat(64) }]),
    { message: 'LOCAL_SKILL_SELECTION_INVALID' },
  )
  await assert.rejects(
    selections.prepare('hermes', [persisted]),
    { message: 'LOCAL_SKILL_SELECTION_INVALID' },
  )
  const missing = {
    ...persisted,
    snapshotRef: {
      ...persisted.snapshotRef,
      hash: 'c'.repeat(64),
    },
  }
  await assert.rejects(
    selections.prepare('codex', [missing]),
    { message: 'LOCAL_SKILL_SNAPSHOT_RESTORE_FAILED' },
  )

  const filename = path.join(
    contentBlobStore.rootPath,
    'sha256',
    persisted.snapshotRef.hash.slice(0, 2),
    persisted.snapshotRef.hash,
  )
  fs.chmodSync(filename, 0o600)
  fs.writeFileSync(filename, Buffer.alloc(persisted.snapshotRef.size, 0x78), { mode: 0o600 })
  await assert.rejects(
    selections.prepare('codex', [persisted]),
    { message: 'LOCAL_SKILL_SNAPSHOT_RESTORE_FAILED' },
  )
})

test('content upgrades require a new approval and revoked trust blocks restore', async (t) => {
  const { approvals, catalog, selections, skillDirectory, trustStore } = fixture(t)
  const selected = catalog.list('codex').skills[0]
  const [first] = await selections.prepare('codex', [selected])
  const firstBindingId = first.trustBindingId

  fs.writeFileSync(path.join(skillDirectory, 'SKILL.md'), '# Upgraded Skill\n')
  const [upgraded] = await selections.prepare('codex', [selected])
  assert.notEqual(upgraded.manifestHash, first.manifestHash)
  assert.notEqual(upgraded.trustBindingId, firstBindingId)
  assert.equal(approvals.length, 2)

  trustStore.revoke(upgraded.trustBindingId)
  await assert.rejects(
    selections.prepare('codex', [persistedHint(upgraded)]),
    { message: 'LOCAL_SKILL_TRUST_REQUIRED' },
  )
})

test('rejects missing manifests and manifest upgrades that are not explicitly approved', async (t) => {
  const { approvals, catalog, selections, skillDirectory } = fixture(t)
  const selected = catalog.list('codex').skills[0]
  fs.rmSync(path.join(skillDirectory, 'meldwork.skill.json'))
  await assert.rejects(
    selections.prepare('codex', [selected]),
    { message: 'LOCAL_SKILL_MANIFEST_MISSING' },
  )
  assert.equal(approvals.length, 0)
})
