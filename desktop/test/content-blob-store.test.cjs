const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  ContentBlobStore,
  normalizeContentBlobRef,
} = require('../src/content-blob-store.cjs')

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-content-blobs-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const rootPath = path.join(directory, 'private', 'content-blobs')
  return { directory, rootPath, store: new ContentBlobStore({ rootPath }) }
}

function storedPath(rootPath, hash) {
  return path.join(rootPath, 'sha256', hash.slice(0, 2), hash)
}

test('stores bytes by SHA-256 and deduplicates without rewriting', (t) => {
  const { rootPath, store } = fixture(t)
  const bytes = Buffer.from('immutable payload')
  const hash = crypto.createHash('sha256').update(bytes).digest('hex')

  const ref = store.put(bytes, { mediaType: 'Text/Plain' })
  const filename = storedPath(rootPath, hash)
  const before = fs.statSync(filename)

  assert.deepEqual(ref, {
    algorithm: 'sha256',
    hash,
    size: bytes.length,
    mediaType: 'text/plain',
  })
  assert.deepEqual(store.read(ref), bytes)
  assert.equal(store.has(ref), true)
  assert.deepEqual(store.put(Buffer.from(bytes), { mediaType: 'text/plain' }), ref)

  const after = fs.statSync(filename)
  assert.equal(after.ino, before.ino)
  assert.equal(after.mtimeMs, before.mtimeMs)
  assert.deepEqual(fs.readdirSync(path.dirname(filename)), [hash])
})

test('supports empty blobs and strict optional media types', (t) => {
  const { store } = fixture(t)
  const empty = store.put(Buffer.alloc(0))

  assert.equal(empty.size, 0)
  assert.equal('mediaType' in empty, false)
  assert.deepEqual(store.read(empty), Buffer.alloc(0))
  assert.deepEqual(normalizeContentBlobRef(empty), empty)

  assert.throws(
    () => store.put('payload', { mediaType: 'text/plain', name: 'payload.txt' }),
    { message: 'CONTENT_BLOB_OPTIONS_INVALID' },
  )
  assert.throws(
    () => store.put('payload', { mediaType: 'not a media type' }),
    { message: 'CONTENT_BLOB_MEDIA_TYPE_INVALID' },
  )
})

test('creates only private directories and files with no temporary residue', {
  skip: process.platform === 'win32',
}, (t) => {
  const { rootPath, store } = fixture(t)
  const ref = store.put('private')
  const algorithmDirectory = path.join(rootPath, 'sha256')
  const shardDirectory = path.join(algorithmDirectory, ref.hash.slice(0, 2))
  const filename = storedPath(rootPath, ref.hash)

  for (const directory of [rootPath, algorithmDirectory, shardDirectory]) {
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700)
  }
  assert.equal(fs.statSync(filename).mode & 0o777, 0o600)
  assert.deepEqual(fs.readdirSync(shardDirectory), [ref.hash])
})

test('rejects traversal-shaped references and unsafe roots', {
  skip: process.platform === 'win32',
}, (t) => {
  const { directory, store } = fixture(t)
  assert.throws(() => store.read({
    algorithm: 'sha256',
    hash: `../${'a'.repeat(61)}`,
    size: 1,
  }), { message: 'CONTENT_BLOB_REF_INVALID' })
  assert.throws(() => store.read({
    algorithm: 'sha512',
    hash: 'a'.repeat(64),
    size: 1,
  }), { message: 'CONTENT_BLOB_REF_INVALID' })
  assert.equal(fs.existsSync(path.join(directory, 'a'.repeat(61))), false)

  const realRoot = path.join(directory, 'real-root')
  const rootLink = path.join(directory, 'root-link')
  fs.mkdirSync(realRoot)
  fs.symlinkSync(realRoot, rootLink)
  assert.throws(
    () => new ContentBlobStore({ rootPath: rootLink }),
    { message: 'CONTENT_BLOB_ROOT_UNSAFE' },
  )
  assert.throws(
    () => new ContentBlobStore({ rootPath: path.parse(directory).root }),
    { message: 'CONTENT_BLOB_ROOT_UNSAFE' },
  )
})

test('validates both expected size and SHA-256 when reading', (t) => {
  const { rootPath, store } = fixture(t)
  const ref = store.put('original payload')
  const filename = storedPath(rootPath, ref.hash)

  assert.throws(
    () => store.read({ ...ref, size: ref.size + 1 }),
    { message: 'CONTENT_BLOB_TAMPERED' },
  )

  const changed = Buffer.from('modified payload')
  assert.equal(changed.length, ref.size)
  fs.writeFileSync(filename, changed)
  assert.throws(() => store.read(ref), { message: 'CONTENT_BLOB_TAMPERED' })
  assert.throws(
    () => store.put('original payload'),
    { message: 'CONTENT_BLOB_TAMPERED' },
  )
  assert.deepEqual(fs.readFileSync(filename), changed)
})

test('rejects stored symlinks without following them outside the root', {
  skip: process.platform === 'win32',
}, (t) => {
  const { directory, rootPath, store } = fixture(t)
  const ref = store.put('inside')
  const filename = storedPath(rootPath, ref.hash)
  const outside = path.join(directory, 'outside')
  fs.writeFileSync(outside, 'outside')
  fs.unlinkSync(filename)
  fs.symlinkSync(outside, filename)

  assert.throws(() => store.read(ref), { message: 'CONTENT_BLOB_TAMPERED' })
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside')
})

test('rejects replaced storage directories instead of writing through symlinks', {
  skip: process.platform === 'win32',
}, (t) => {
  const { directory, rootPath, store } = fixture(t)
  const first = store.put('first')
  const algorithmDirectory = path.join(rootPath, 'sha256')
  const outside = path.join(directory, 'outside-directory')
  fs.rmSync(algorithmDirectory, { recursive: true })
  fs.mkdirSync(outside)
  fs.symlinkSync(outside, algorithmDirectory)

  assert.throws(() => store.put('second'), { message: 'CONTENT_BLOB_ROOT_UNSAFE' })
  assert.deepEqual(fs.readdirSync(outside), [])
  assert.throws(() => store.has(first), { message: 'CONTENT_BLOB_ROOT_UNSAFE' })
})

test('treats permission changes as tampering', {
  skip: process.platform === 'win32',
}, (t) => {
  const { rootPath, store } = fixture(t)
  const ref = store.put('private')
  const filename = storedPath(rootPath, ref.hash)
  fs.chmodSync(filename, 0o644)

  assert.throws(() => store.read(ref), { message: 'CONTENT_BLOB_TAMPERED' })
})
