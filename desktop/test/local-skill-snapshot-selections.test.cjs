const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const { ContentBlobStore } = require('../src/content-blob-store.cjs')
const { LocalSkillCatalog } = require('../src/local-skill-catalog.cjs')
const { LocalSkillSnapshotStore } = require('../src/local-skill-snapshot.cjs')
const { LocalSkillSnapshotSelections } = require('../src/local-skill-snapshot-selections.cjs')

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
  fs.writeFileSync(path.join(skillDirectory, 'references', 'rules.md'), 'Original rules\n')
  const contentBlobStore = new ContentBlobStore({
    rootPath: path.join(directory, 'private', 'blobs'),
  })
  const snapshotStore = new LocalSkillSnapshotStore({
    contentBlobStore,
    rootPath: path.join(directory, 'private', 'materialized'),
  })
  const catalog = new LocalSkillCatalog({ home: path.join(directory, 'home') })
  const selections = new LocalSkillSnapshotSelections({
    catalog,
    snapshotStore,
    contentBlobStore,
  })
  return { catalog, contentBlobStore, directory, selections, skillDirectory }
}

function persistedHint(value) {
  return JSON.parse(JSON.stringify(value))
}

test('captures a current catalog selection without serializing source or materialized paths', (t) => {
  const { catalog, directory, selections } = fixture(t)
  const selected = catalog.list('codex').skills[0]
  const [runtime] = selections.prepare('codex', [selected])
  const persisted = persistedHint(runtime)

  assert.equal(fs.readFileSync(runtime.entryPath, 'utf8'), '# Original Skill\n')
  assert.deepEqual(Object.keys(persisted).sort(), [
    'manifestHash', 'name', 'namespace', 'slug', 'snapshotId', 'snapshotRef', 'targetKind',
  ])
  assert.equal(JSON.stringify(persisted).includes(directory), false)
  assert.equal(Object.keys(runtime).includes('entryPath'), false)
})

test('restores the same immutable snapshot after the live Skill changes or disappears', (t) => {
  const { catalog, selections, skillDirectory } = fixture(t)
  const [captured] = selections.prepare('codex', [catalog.list('codex').skills[0]])
  const persisted = persistedHint(captured)
  fs.writeFileSync(path.join(skillDirectory, 'SKILL.md'), '# Mutated Skill\n')
  fs.rmSync(path.join(skillDirectory, 'references'), { recursive: true })

  const [restored] = selections.prepare('codex', [persisted])

  assert.equal(restored.snapshotId, captured.snapshotId)
  assert.equal(fs.readFileSync(restored.entryPath, 'utf8'), '# Original Skill\n')
  assert.equal(
    fs.readFileSync(path.join(path.dirname(restored.entryPath), 'references', 'rules.md'), 'utf8'),
    'Original rules\n',
  )
})

test('rejects mixed, forged, missing, or tampered snapshot selections', (t) => {
  const { catalog, contentBlobStore, selections } = fixture(t)
  const selected = catalog.list('codex').skills[0]
  const [captured] = selections.prepare('codex', [selected])
  const persisted = persistedHint(captured)

  assert.throws(
    () => selections.prepare('codex', [selected, persisted]),
    { message: 'LOCAL_SKILL_SELECTION_INVALID' },
  )
  assert.throws(
    () => selections.prepare('codex', [{ ...persisted, manifestHash: 'b'.repeat(64) }]),
    { message: 'LOCAL_SKILL_SELECTION_INVALID' },
  )
  assert.throws(
    () => selections.prepare('hermes', [persisted]),
    { message: 'LOCAL_SKILL_SELECTION_INVALID' },
  )
  const missing = {
    ...persisted,
    snapshotRef: {
      ...persisted.snapshotRef,
      hash: 'c'.repeat(64),
    },
  }
  assert.throws(
    () => selections.prepare('codex', [missing]),
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
  assert.throws(
    () => selections.prepare('codex', [persisted]),
    { message: 'LOCAL_SKILL_SNAPSHOT_RESTORE_FAILED' },
  )
})
