const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { AttachmentStore } = require('../src/attachment-store.cjs')

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
const WEBP = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
])

function fixture(t, createId) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-attachments-'))
  const rootPath = path.join(directory, 'attachments')
  let sequence = 0
  const store = new AttachmentStore({
    rootPath,
    createId: createId || (() => `attachment-${++sequence}`),
  })
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return { directory, rootPath, store }
}

function importImage(store, bytes = PNG, name = 'image.png', mimeType = 'image/png') {
  return store.importBuffer({ bytes, name, mimeType })
}

test('imports IPC number arrays and exposes only sanitized public metadata', (t) => {
  const { directory, rootPath, store } = fixture(t)
  const metadata = store.importBuffer({
    bytes: [...PNG],
    name: '../../private\\portrait?.PNG',
    mimeType: 'image/png',
  })

  assert.deepEqual(metadata, {
    id: 'attachment-1',
    name: 'portrait_.png',
    mimeType: 'image/png',
    size: PNG.length,
  })
  assert.deepEqual(Object.keys(metadata).sort(), ['id', 'mimeType', 'name', 'size'])
  assert.equal(JSON.stringify(metadata).includes(directory), false)

  const [entry] = store.resolve([metadata])
  assert.deepEqual(Object.keys(entry).sort(), ['id', 'mimeType', 'name', 'path', 'size'])
  assert.equal(path.dirname(path.dirname(entry.path)), rootPath)
  assert.equal(path.basename(entry.path), 'image.png')
  assert.deepEqual(store.read(metadata.id), PNG)
})

test('reads preview metadata and bytes through one integrity-checked entry load', (t) => {
  const { store } = fixture(t)
  const metadata = importImage(store)
  const loadEntry = store.loadEntry.bind(store)
  let loadCount = 0
  store.loadEntry = (id) => {
    loadCount += 1
    return loadEntry(id)
  }

  const result = store.readWithMetadata(metadata.id)

  assert.equal(loadCount, 1)
  assert.deepEqual(result, { metadata, bytes: PNG })
  assert.equal('path' in result, false)
})

test('accepts PNG, JPEG, and WebP using their real magic bytes', (t) => {
  const { store } = fixture(t)

  assert.equal(importImage(store).mimeType, 'image/png')
  assert.deepEqual(
    store.importBuffer({ bytes: JPEG, name: 'photo.jpeg', mimeType: 'image/jpeg' }),
    { id: 'attachment-2', name: 'photo.jpg', mimeType: 'image/jpeg', size: JPEG.length },
  )
  assert.deepEqual(
    store.importBuffer({ bytes: WEBP, name: 'preview.webp', mimeType: 'image/webp' }),
    { id: 'attachment-3', name: 'preview.webp', mimeType: 'image/webp', size: WEBP.length },
  )
})

test('rejects unsupported bytes and declared type or extension mismatches', (t) => {
  const { directory, store } = fixture(t)

  assert.throws(
    () => store.importBuffer({ bytes: Buffer.from('not an image'), name: 'note.png', mimeType: 'image/png' }),
    { message: 'LOCAL_ATTACHMENT_TYPE_UNSUPPORTED' },
  )
  assert.throws(
    () => store.importBuffer({ bytes: PNG, name: 'photo.png', mimeType: 'image/jpeg' }),
    { message: 'LOCAL_ATTACHMENT_TYPE_MISMATCH' },
  )
  assert.throws(
    () => store.importBuffer({ bytes: PNG, name: 'photo.jpg', mimeType: 'image/png' }),
    { message: 'LOCAL_ATTACHMENT_TYPE_MISMATCH' },
  )
  assert.throws(
    () => store.importBuffer({ bytes: [0x89, 0x100], name: 'photo.png', mimeType: 'image/png' }),
    { message: 'LOCAL_ATTACHMENT_BYTES_INVALID' },
  )
  assert.deepEqual(fs.readdirSync(path.join(directory, 'attachments')), [])
})

test('enforces the 8 MiB per-image limit and four-image batch limit', (t) => {
  const { store } = fixture(t)
  const oversized = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1)
  PNG.copy(oversized)

  assert.throws(
    () => importImage(store, oversized),
    { message: 'LOCAL_ATTACHMENT_TOO_LARGE' },
  )

  const refs = Array.from({ length: 5 }, () => importImage(store))
  assert.throws(() => store.resolve(refs), {
    message: 'LOCAL_ATTACHMENT_COUNT_LIMIT',
  })
  assert.deepEqual(store.resolve([]), [])
})

test('uses opaque controlled paths, atomic directory replacement, and private modes', (t) => {
  const { rootPath, store } = fixture(t, () => 'fixed-attachment-id')
  const metadata = importImage(store)
  const [entry] = store.resolve([metadata.id])
  const entryDirectory = path.dirname(entry.path)

  assert.equal(path.basename(entryDirectory), metadata.id)
  assert.equal(path.basename(entry.path), 'image.png')
  assert.equal(fs.statSync(rootPath).mode & 0o777, 0o700)
  assert.equal(fs.statSync(entryDirectory).mode & 0o777, 0o700)
  assert.equal(fs.statSync(entry.path).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.join(entryDirectory, 'metadata.json')).mode & 0o777, 0o600)
  assert.deepEqual(fs.readdirSync(rootPath), ['fixed-attachment-id'])
  assert.deepEqual(fs.readdirSync(entryDirectory).sort(), ['image.png', 'metadata.json'])

  assert.throws(() => importImage(store), {
    message: 'LOCAL_ATTACHMENT_ID_CONFLICT',
  })
  assert.deepEqual(fs.readdirSync(rootPath), ['fixed-attachment-id'])
  assert.deepEqual(store.read(metadata.id), PNG)
})

test('rejects identifier traversal and symlink roots or source files', {
  skip: process.platform === 'win32',
}, (t) => {
  const { directory, rootPath, store } = fixture(t, () => '../escape')
  assert.throws(() => importImage(store), {
    message: 'LOCAL_ATTACHMENT_ID_INVALID',
  })
  assert.equal(fs.existsSync(path.join(directory, 'escape')), false)
  assert.deepEqual(fs.readdirSync(rootPath), [])

  const source = path.join(directory, 'source.png')
  const sourceLink = path.join(directory, 'source-link.png')
  fs.writeFileSync(source, PNG)
  fs.symlinkSync(source, sourceLink)
  assert.throws(() => store.importFile(sourceLink), {
    message: 'LOCAL_ATTACHMENT_SOURCE_UNSAFE',
  })

  const realRoot = path.join(directory, 'real-root')
  const rootLink = path.join(directory, 'root-link')
  fs.mkdirSync(realRoot)
  fs.symlinkSync(realRoot, rootLink)
  assert.throws(() => new AttachmentStore({ rootPath: rootLink }), {
    message: 'LOCAL_ATTACHMENT_ROOT_UNSAFE',
  })
})

test('imports files without leaking their source path and survives restart', (t) => {
  const { directory, rootPath, store } = fixture(t)
  const source = path.join(directory, 'private-source.jpeg')
  fs.writeFileSync(source, JPEG)

  const metadata = store.importFile(source)
  assert.deepEqual(metadata, {
    id: 'attachment-1',
    name: 'private-source.jpg',
    mimeType: 'image/jpeg',
    size: JPEG.length,
  })
  assert.equal(JSON.stringify(metadata).includes(source), false)
  assert.equal(fs.readFileSync(path.join(rootPath, metadata.id, 'metadata.json'), 'utf8').includes(directory), false)

  const restarted = new AttachmentStore({ rootPath })
  assert.deepEqual(restarted.read(metadata.id), JPEG)
  assert.deepEqual(restarted.resolve([metadata.id]), [{
    ...metadata,
    path: path.join(rootPath, metadata.id, 'image.jpg'),
  }])

  const mismatched = path.join(directory, 'mismatched.png')
  fs.writeFileSync(mismatched, JPEG)
  assert.throws(() => restarted.importFile(mismatched), {
    message: 'LOCAL_ATTACHMENT_TYPE_MISMATCH',
  })
})

test('returns stable errors for unknown, missing, and modified files', (t) => {
  const { store } = fixture(t)

  assert.throws(() => store.read('unknown-attachment'), {
    message: 'LOCAL_ATTACHMENT_NOT_FOUND',
  })

  const missing = importImage(store)
  const [missingEntry] = store.resolve([missing])
  fs.unlinkSync(missingEntry.path)
  assert.throws(() => store.read(missing.id), {
    message: 'LOCAL_ATTACHMENT_FILE_MISSING',
  })

  const modified = importImage(store)
  const [modifiedEntry] = store.resolve([modified])
  const changed = Buffer.from(PNG)
  changed[changed.length - 1] ^= 0xff
  fs.writeFileSync(modifiedEntry.path, changed)
  assert.throws(() => store.readWithMetadata(modified.id), {
    message: 'LOCAL_ATTACHMENT_TAMPERED',
  })
})

test('rejects stored-file symlinks without following them outside the root', {
  skip: process.platform === 'win32',
}, (t) => {
  const { directory, store } = fixture(t)
  const metadata = importImage(store)
  const [entry] = store.resolve([metadata])
  const outside = path.join(directory, 'outside.png')
  fs.writeFileSync(outside, PNG)
  fs.unlinkSync(entry.path)
  fs.symlinkSync(outside, entry.path)

  assert.throws(() => store.read(metadata.id), {
    message: 'LOCAL_ATTACHMENT_TAMPERED',
  })
  assert.deepEqual(fs.readFileSync(outside), PNG)
})

test('discards resolved IDs and metadata references idempotently', (t) => {
  const { rootPath, store } = fixture(t)
  const first = importImage(store)
  const second = importImage(store)

  assert.deepEqual(store.discard([first, second.id]), [first.id, second.id])
  assert.deepEqual(store.discard([first.id, 'already-absent']), [])

  assert.deepEqual(fs.readdirSync(rootPath), [])
  assert.throws(() => store.read(first.id), {
    message: 'LOCAL_ATTACHMENT_NOT_FOUND',
  })
  assert.throws(() => store.resolve([second.id]), {
    message: 'LOCAL_ATTACHMENT_NOT_FOUND',
  })
})

test('discard removes incomplete or tampered attachment directories without parsing them', (t) => {
  const { rootPath, store } = fixture(t)
  const missingImage = importImage(store)
  const modifiedImage = importImage(store)
  fs.unlinkSync(store.resolve([missingImage.id])[0].path)
  const modifiedPath = store.resolve([modifiedImage.id])[0].path
  fs.writeFileSync(modifiedPath, Buffer.from('tampered'))

  assert.deepEqual(store.discard([missingImage.id, modifiedImage.id]), [
    missingImage.id,
    modifiedImage.id,
  ])
  assert.deepEqual(fs.readdirSync(rootPath), [])
})

test('startup cleanup removes orphan attachments and interrupted operation residue', (t) => {
  const { rootPath, store } = fixture(t)
  const referenced = importImage(store)
  const orphan = importImage(store)
  fs.mkdirSync(path.join(rootPath, '.import-interrupted'))
  fs.writeFileSync(path.join(rootPath, '.discard-interrupted'), 'residue')
  fs.writeFileSync(path.join(rootPath, '.unrelated'), 'keep')

  const result = store.cleanup(new Set([referenced.id]))

  assert.deepEqual(result, {
    discardedIds: [orphan.id],
    removedTemporaryEntries: 2,
  })
  assert.deepEqual(fs.readdirSync(rootPath).sort(), ['.unrelated', referenced.id])
  assert.deepEqual(store.read(referenced.id), PNG)
  assert.throws(() => store.read(orphan.id), {
    message: 'LOCAL_ATTACHMENT_NOT_FOUND',
  })
})
