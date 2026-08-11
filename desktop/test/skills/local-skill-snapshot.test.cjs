const test = require('node:test')
const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { ContentBlobStore } = require('../../src/attachments/content-blob-store.cjs')
const {
  LocalSkillSnapshotStore,
  MAX_SKILL_DEPTH,
  MAX_SKILL_FILES,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_TOTAL_BYTES,
  canonicalSkillSnapshotJson,
} = require('../../src/skills/local-skill-snapshot.cjs')

function makeWritable(filename) {
  try {
    const stat = fs.lstatSync(filename)
    if (stat.isSymbolicLink()) return
    if (stat.isDirectory()) {
      fs.chmodSync(filename, 0o700)
      for (const entry of fs.readdirSync(filename)) {
        makeWritable(path.join(filename, entry))
      }
    } else {
      fs.chmodSync(filename, 0o600)
    }
  } catch { /* best effort */ }
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-skill-snapshot-'))
  t.after(() => {
    makeWritable(directory)
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const blobRoot = path.join(directory, 'private', 'content-blobs')
  const materializationRoot = path.join(directory, 'private', 'skill-snapshots')
  const contentBlobStore = new ContentBlobStore({ rootPath: blobRoot })
  const store = new LocalSkillSnapshotStore({
    contentBlobStore,
    rootPath: materializationRoot,
  })
  return { directory, blobRoot, materializationRoot, contentBlobStore, store }
}

function coordinates(sourceDirectory, overrides = {}) {
  return {
    sourceDirectory,
    targetKind: 'codex',
    namespace: 'global',
    slug: 'review',
    name: 'Review changes',
    ...overrides,
  }
}

function writeFile(filename, contents) {
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  fs.writeFileSync(filename, contents)
}

function storedPath(blobRoot, hash) {
  return path.join(blobRoot, 'sha256', hash.slice(0, 2), hash)
}

function envelope(manifest) {
  const manifestHash = crypto.createHash('sha256')
    .update(canonicalSkillSnapshotJson(manifest))
    .digest('hex')
  return {
    snapshotId: `skill-snapshot-${manifestHash}`,
    manifestHash,
    manifest,
  }
}

test('captures every nested file with deterministic IDs and no source path leakage', (t) => {
  const { directory, store } = fixture(t)
  const firstSource = path.join(directory, 'installed', 'first-review-skill')
  const secondSource = path.join(directory, 'elsewhere', 'same-review-skill')
  const files = new Map([
    ['SKILL.md', '---\nname: Review changes\n---\nInspect the patch.\n'],
    ['assets/rules.json', '{"strict":true}\n'],
    ['references/checklist.md', '# Checklist\n\n- Tests\n'],
    ['scripts/review.sh', '#!/bin/sh\necho review\n'],
  ])
  for (const [relativePath, contents] of files) {
    writeFile(path.join(firstSource, ...relativePath.split('/')), contents)
  }
  for (const [relativePath, contents] of [...files].reverse()) {
    writeFile(path.join(secondSource, ...relativePath.split('/')), contents)
  }
  const differentTime = new Date(Date.now() - 60_000)
  fs.utimesSync(path.join(secondSource, 'SKILL.md'), differentTime, differentTime)

  const first = store.create(coordinates(firstSource))
  const second = store.create(coordinates(secondSource))

  assert.deepEqual(second, first)
  assert.match(first.snapshotId, /^skill-snapshot-[a-f0-9]{64}$/)
  assert.equal(first.snapshotId, `skill-snapshot-${first.manifestHash}`)
  assert.deepEqual(Object.keys(first.manifest).sort(), [
    'coordinates', 'entry', 'fileCount', 'files', 'totalBytes', 'version',
  ])
  assert.deepEqual(first.manifest.files.map(file => file.relativePath), [...files.keys()].sort())
  assert.equal(first.manifest.entry, 'SKILL.md')
  assert.equal(first.manifest.fileCount, files.size)
  assert.equal(
    first.manifest.totalBytes,
    [...files.values()].reduce((total, contents) => total + Buffer.byteLength(contents), 0),
  )
  for (const file of first.manifest.files) {
    assert.deepEqual(Object.keys(file).sort(), ['blobRef', 'contentHash', 'relativePath'])
    assert.equal(file.contentHash, file.blobRef.hash)
  }
  const serialized = JSON.stringify(first)
  assert.equal(serialized.includes(firstSource), false)
  assert.equal(serialized.includes(secondSource), false)
  assert.equal(serialized.includes(directory), false)
  assert.equal(Object.isFrozen(first), true)
  assert.equal(Object.isFrozen(first.manifest.files[0].blobRef), true)
})

test('materializes only from blobs after the source is changed and deleted', (t) => {
  const { directory, store } = fixture(t)
  const sourceDirectory = path.join(directory, 'source')
  const skillContents = '---\nname: Review changes\n---\nOriginal instructions.\n'
  const nestedContents = Buffer.from([0, 1, 2, 3, 255])
  writeFile(path.join(sourceDirectory, 'SKILL.md'), skillContents)
  writeFile(path.join(sourceDirectory, 'assets', 'data.bin'), nestedContents)
  const snapshot = store.create(coordinates(sourceDirectory))

  fs.writeFileSync(path.join(sourceDirectory, 'SKILL.md'), 'changed live source')
  fs.rmSync(sourceDirectory, { recursive: true })

  const materialized = store.materialize(snapshot)
  const repeated = store.materialize(snapshot)
  assert.deepEqual(repeated, materialized)
  assert.equal(fs.readFileSync(materialized.entryPath, 'utf8'), skillContents)
  assert.deepEqual(
    fs.readFileSync(path.join(materialized.directory, 'assets', 'data.bin')),
    nestedContents,
  )
  assert.equal(materialized.directory.startsWith(path.join(directory, 'private')), true)
  assert.equal(materialized.directory.includes(sourceDirectory), false)
})

test('materialized directories and files are private and read-only', {
  skip: process.platform === 'win32',
}, (t) => {
  const { directory, materializationRoot, store } = fixture(t)
  const sourceDirectory = path.join(directory, 'source')
  writeFile(path.join(sourceDirectory, 'SKILL.md'), 'instructions')
  writeFile(path.join(sourceDirectory, 'nested', 'resource.txt'), 'resource')

  const materialized = store.materialize(store.create(coordinates(sourceDirectory)))
  const nestedDirectory = path.join(materialized.directory, 'nested')
  const nestedFile = path.join(nestedDirectory, 'resource.txt')

  assert.equal(fs.statSync(materializationRoot).mode & 0o777, 0o700)
  assert.equal(fs.statSync(materialized.directory).mode & 0o777, 0o500)
  assert.equal(fs.statSync(nestedDirectory).mode & 0o777, 0o500)
  assert.equal(fs.statSync(materialized.entryPath).mode & 0o777, 0o400)
  assert.equal(fs.statSync(nestedFile).mode & 0o777, 0o400)
  assert.throws(() => fs.appendFileSync(nestedFile, 'changed'), { code: 'EACCES' })
  assert.throws(
    () => fs.writeFileSync(path.join(materialized.directory, 'extra.txt'), 'extra'),
    { code: 'EACCES' },
  )
})

test('detects a file that changes while it is being captured', (t) => {
  const { directory, store } = fixture(t)
  const sourceDirectory = path.join(directory, 'source')
  const changingFile = path.join(sourceDirectory, 'A.txt')
  writeFile(changingFile, 'AAAA')
  writeFile(path.join(sourceDirectory, 'SKILL.md'), 'instructions')

  const originalReadSync = fs.readSync
  let changed = false
  fs.readSync = function patchedReadSync(...args) {
    const bytesRead = originalReadSync.apply(this, args)
    if (!changed && bytesRead > 0) {
      changed = true
      fs.writeFileSync(changingFile, 'BBBB')
    }
    return bytesRead
  }
  try {
    assert.throws(
      () => store.create(coordinates(sourceDirectory)),
      { message: 'LOCAL_SKILL_SNAPSHOT_SOURCE_CHANGED' },
    )
  } finally {
    fs.readSync = originalReadSync
  }
  assert.equal(changed, true)
})

test('rejects symlinks, special files, and traversal-shaped manifests', {
  skip: process.platform === 'win32',
}, (t) => {
  const { directory, store } = fixture(t)

  const linkedSource = path.join(directory, 'linked-source')
  const realSource = path.join(directory, 'real-source')
  writeFile(path.join(realSource, 'SKILL.md'), 'instructions')
  fs.symlinkSync(realSource, linkedSource)
  assert.throws(
    () => store.create(coordinates(linkedSource)),
    { message: 'LOCAL_SKILL_SNAPSHOT_SYMLINK' },
  )

  const childLinkSource = path.join(directory, 'child-link-source')
  writeFile(path.join(childLinkSource, 'SKILL.md'), 'instructions')
  fs.symlinkSync(path.join(realSource, 'SKILL.md'), path.join(childLinkSource, 'linked.md'))
  assert.throws(
    () => store.create(coordinates(childLinkSource)),
    { message: 'LOCAL_SKILL_SNAPSHOT_SYMLINK' },
  )

  const fifoSource = path.join(directory, 'fifo-source')
  writeFile(path.join(fifoSource, 'SKILL.md'), 'instructions')
  childProcess.execFileSync('mkfifo', [path.join(fifoSource, 'events.pipe')])
  assert.throws(
    () => store.create(coordinates(fifoSource)),
    { message: 'LOCAL_SKILL_SNAPSHOT_SPECIAL_FILE' },
  )

  const validSource = path.join(directory, 'valid-source')
  writeFile(path.join(validSource, 'SKILL.md'), 'instructions')
  const valid = store.create(coordinates(validSource))
  const manifest = JSON.parse(JSON.stringify(valid.manifest))
  manifest.entry = '../SKILL.md'
  manifest.files[0].relativePath = '../SKILL.md'
  assert.throws(
    () => store.materialize(envelope(manifest)),
    { message: 'LOCAL_SKILL_SNAPSHOT_PATH_INVALID' },
  )
})

test('enforces depth, file count, per-file, and aggregate byte bounds', (t) => {
  const { directory, store } = fixture(t)

  const deepSource = path.join(directory, 'deep-source')
  writeFile(path.join(deepSource, 'SKILL.md'), 'instructions')
  let current = deepSource
  for (let depth = 0; depth <= MAX_SKILL_DEPTH; depth += 1) {
    current = path.join(current, `depth-${depth}`)
    fs.mkdirSync(current)
  }
  writeFile(path.join(current, 'resource.txt'), 'too deep')
  assert.throws(
    () => store.create(coordinates(deepSource)),
    { message: 'LOCAL_SKILL_SNAPSHOT_DEPTH_LIMIT' },
  )

  const manyFilesSource = path.join(directory, 'many-files-source')
  writeFile(path.join(manyFilesSource, 'SKILL.md'), 'instructions')
  for (let index = 0; index < MAX_SKILL_FILES; index += 1) {
    writeFile(path.join(manyFilesSource, `resource-${String(index).padStart(3, '0')}.txt`), '')
  }
  assert.throws(
    () => store.create(coordinates(manyFilesSource)),
    { message: 'LOCAL_SKILL_SNAPSHOT_FILE_LIMIT' },
  )

  const largeFileSource = path.join(directory, 'large-file-source')
  writeFile(path.join(largeFileSource, 'SKILL.md'), 'instructions')
  const largeFile = path.join(largeFileSource, 'resource.bin')
  writeFile(largeFile, '')
  fs.truncateSync(largeFile, MAX_SKILL_FILE_BYTES + 1)
  assert.throws(
    () => store.create(coordinates(largeFileSource)),
    { message: 'LOCAL_SKILL_SNAPSHOT_FILE_TOO_LARGE' },
  )

  const totalSource = path.join(directory, 'total-source')
  writeFile(path.join(totalSource, 'SKILL.md'), 'x')
  const fileCount = Math.ceil(MAX_SKILL_TOTAL_BYTES / MAX_SKILL_FILE_BYTES)
  for (let index = 0; index < fileCount; index += 1) {
    const filename = path.join(totalSource, `payload-${index}.bin`)
    writeFile(filename, '')
    fs.truncateSync(filename, MAX_SKILL_FILE_BYTES)
  }
  assert.throws(
    () => store.create(coordinates(totalSource)),
    { message: 'LOCAL_SKILL_SNAPSHOT_TOTAL_TOO_LARGE' },
  )
})

test('rejects likely credential and private-key filenames', (t) => {
  const { directory, store } = fixture(t)
  const sensitiveNames = ['.env', 'credentials.json', 'id_rsa', 'server.key']
  for (const [index, name] of sensitiveNames.entries()) {
    const sourceDirectory = path.join(directory, `sensitive-${index}`)
    writeFile(path.join(sourceDirectory, 'SKILL.md'), 'instructions')
    writeFile(path.join(sourceDirectory, name), 'secret')
    assert.throws(
      () => store.create(coordinates(sourceDirectory)),
      { message: 'LOCAL_SKILL_SNAPSHOT_SENSITIVE_PATH' },
    )
  }

  const sshSource = path.join(directory, 'ssh-source')
  writeFile(path.join(sshSource, 'SKILL.md'), 'instructions')
  writeFile(path.join(sshSource, '.ssh', 'config'), 'private config')
  assert.throws(
    () => store.create(coordinates(sshSource)),
    { message: 'LOCAL_SKILL_SNAPSHOT_SENSITIVE_PATH' },
  )
})

test('fails closed when a referenced blob is missing or tampered', (t) => {
  const { directory, blobRoot, store } = fixture(t)
  const missingSource = path.join(directory, 'missing-source')
  const tamperedSource = path.join(directory, 'tampered-source')
  writeFile(path.join(missingSource, 'SKILL.md'), 'missing blob instructions')
  writeFile(path.join(tamperedSource, 'SKILL.md'), 'tampered blob instructions')
  const missingSnapshot = store.create(coordinates(missingSource, { slug: 'missing' }))
  const tamperedSnapshot = store.create(coordinates(tamperedSource, { slug: 'tampered' }))

  const missingRef = missingSnapshot.manifest.files[0].blobRef
  fs.unlinkSync(storedPath(blobRoot, missingRef.hash))
  assert.throws(
    () => store.materialize(missingSnapshot),
    { message: 'LOCAL_SKILL_SNAPSHOT_BLOB_NOT_FOUND' },
  )

  const tamperedRef = tamperedSnapshot.manifest.files[0].blobRef
  fs.writeFileSync(storedPath(blobRoot, tamperedRef.hash), Buffer.alloc(tamperedRef.size, 0x78))
  assert.throws(
    () => store.materialize(tamperedSnapshot),
    { message: 'LOCAL_SKILL_SNAPSHOT_BLOB_TAMPERED' },
  )
})

test('rejects a modified read-only materialization instead of silently rebuilding it', {
  skip: process.platform === 'win32',
}, (t) => {
  const { directory, store } = fixture(t)
  const sourceDirectory = path.join(directory, 'source')
  writeFile(path.join(sourceDirectory, 'SKILL.md'), 'instructions')
  const snapshot = store.create(coordinates(sourceDirectory))
  const materialized = store.materialize(snapshot)

  fs.chmodSync(materialized.entryPath, 0o600)
  fs.writeFileSync(materialized.entryPath, 'tampered data')
  fs.chmodSync(materialized.entryPath, 0o400)

  assert.throws(
    () => store.materialize(snapshot),
    { message: 'LOCAL_SKILL_SNAPSHOT_MATERIALIZATION_TAMPERED' },
  )
})
