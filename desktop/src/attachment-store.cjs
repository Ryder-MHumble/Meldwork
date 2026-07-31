const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const STORE_VERSION = 1
const MAX_ATTACHMENT_BYTES = 128 * 1024 * 1024
const MAX_ATTACHMENTS = 4
const MAX_METADATA_BYTES = 64 * 1024
const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600

const ATTACHMENT_TYPES = Object.freeze([
  Object.freeze({ mimeType: 'image/png', extension: 'png', maxBytes: 8 * 1024 * 1024, storageBase: 'image' }),
  Object.freeze({ mimeType: 'image/jpeg', extension: 'jpg', maxBytes: 8 * 1024 * 1024, storageBase: 'image' }),
  Object.freeze({ mimeType: 'audio/mpeg', extension: 'mp3', maxBytes: 32 * 1024 * 1024, storageBase: 'media' }),
  Object.freeze({ mimeType: 'audio/wav', extension: 'wav', maxBytes: 64 * 1024 * 1024, storageBase: 'media' }),
  Object.freeze({ mimeType: 'audio/mp4', extension: 'm4a', maxBytes: 64 * 1024 * 1024, storageBase: 'media' }),
  Object.freeze({ mimeType: 'video/mp4', extension: 'mp4', maxBytes: MAX_ATTACHMENT_BYTES, storageBase: 'media' }),
  Object.freeze({ mimeType: 'video/quicktime', extension: 'mov', maxBytes: MAX_ATTACHMENT_BYTES, storageBase: 'media' }),
  Object.freeze({ mimeType: 'video/webm', extension: 'webm', maxBytes: MAX_ATTACHMENT_BYTES, storageBase: 'media' }),
])
const TYPE_BY_MIME = new Map(ATTACHMENT_TYPES.map(type => [type.mimeType, type]))
const TYPE_BY_EXTENSION = new Map([
  ['png', TYPE_BY_MIME.get('image/png')],
  ['jpg', TYPE_BY_MIME.get('image/jpeg')],
  ['jpeg', TYPE_BY_MIME.get('image/jpeg')],
  ['mp3', TYPE_BY_MIME.get('audio/mpeg')],
  ['wav', TYPE_BY_MIME.get('audio/wav')],
  ['m4a', TYPE_BY_MIME.get('audio/mp4')],
  ['mp4', TYPE_BY_MIME.get('video/mp4')],
  ['mov', TYPE_BY_MIME.get('video/quicktime')],
  ['webm', TYPE_BY_MIME.get('video/webm')],
])

function attachmentError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function fail(code) {
  throw attachmentError(code)
}

function isAttachmentError(error) {
  return /^LOCAL_ATTACHMENT_[A-Z0-9_]+$/.test(String(error?.message || ''))
}

function sortedKeys(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Reflect.ownKeys(value).sort().join(',')
    : ''
}

function normalizeId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    fail('LOCAL_ATTACHMENT_ID_INVALID')
  }
  return value
}

function normalizeReferences(value) {
  const refs = Array.isArray(value) ? value : [value]
  if (refs.length > MAX_ATTACHMENTS) fail('LOCAL_ATTACHMENT_COUNT_LIMIT')
  const ids = refs.map((ref) => normalizeId(
    typeof ref === 'string' ? ref : ref?.id,
  ))
  if (new Set(ids).size !== ids.length) fail('LOCAL_ATTACHMENT_REFERENCE_INVALID')
  return ids
}

function normalizeDiscardReferences(value) {
  const refs = Array.isArray(value) ? value : [value]
  const ids = refs.map(ref => normalizeId(typeof ref === 'string' ? ref : ref?.id))
  return [...new Set(ids)]
}

function normalizeReferencedIds(value) {
  if (value == null) return new Set()
  if (!Array.isArray(value) && !(value instanceof Set)) {
    fail('LOCAL_ATTACHMENT_REFERENCE_INVALID')
  }
  return new Set([...value].map(normalizeId))
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return Boolean(relative && !relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative))
}

function detectAttachmentType(bytes) {
  if (bytes.length >= 8
      && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return TYPE_BY_MIME.get('image/png')
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return TYPE_BY_MIME.get('image/jpeg')
  }
  if (bytes.length >= 3 && (bytes.subarray(0, 3).toString('ascii') === 'ID3'
      || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))) {
    return TYPE_BY_MIME.get('audio/mpeg')
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
      && bytes.subarray(8, 12).toString('ascii') === 'WAVE') {
    return TYPE_BY_MIME.get('audio/wav')
  }
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = bytes.subarray(8, 12).toString('ascii')
    if (['M4A ', 'M4B ', 'F4A ', 'f4a '].includes(brand)) return TYPE_BY_MIME.get('audio/mp4')
    if (brand === 'qt  ') return TYPE_BY_MIME.get('video/quicktime')
    if (/^(?:iso[2-9m]|isom|avc1|mp4[12]|M4V |dash)$/.test(brand)) {
      return TYPE_BY_MIME.get('video/mp4')
    }
  }
  if (bytes.length >= 8 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
      && bytes.subarray(0, Math.min(bytes.length, 128)).includes(Buffer.from('webm'))) {
    return TYPE_BY_MIME.get('video/webm')
  }
  return null
}

function declaredMimeType(value) {
  const mimeType = String(value || '').split(';', 1)[0].trim().toLowerCase()
  return mimeType === 'image/jpg' ? 'image/jpeg' : mimeType
}

function declaredNameType(name) {
  const basename = path.posix.basename(String(name || '').replace(/\\/g, '/'))
  const extension = path.posix.extname(basename).slice(1).toLowerCase()
  return TYPE_BY_EXTENSION.get(extension) || null
}

function sanitizeName(value, type) {
  let basename = path.posix.basename(String(value || '').normalize('NFKC').replace(/\\/g, '/'))
  basename = basename
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .trim()
  let stem = basename.replace(/\.[^.]*$/, '').replace(/^\.+/, '').replace(/[. ]+$/, '').trim()
  stem = stem.slice(0, 120).replace(/[. ]+$/, '') || 'image'
  return `${stem}.${type.extension}`
}

function toBuffer(value) {
  const size = Array.isArray(value)
    ? value.length
    : Buffer.isBuffer(value) || value instanceof Uint8Array
      ? value.byteLength
      : value instanceof ArrayBuffer
        ? value.byteLength
        : -1
  if (size <= 0) fail('LOCAL_ATTACHMENT_BYTES_INVALID')
  if (size > MAX_ATTACHMENT_BYTES) fail('LOCAL_ATTACHMENT_TOO_LARGE')
  if (Array.isArray(value)) {
    if (!value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
      fail('LOCAL_ATTACHMENT_BYTES_INVALID')
    }
    return Buffer.from(value)
  }
  if (Buffer.isBuffer(value)) return Buffer.from(value)
  if (value instanceof Uint8Array) return Buffer.from(value)
  return Buffer.from(new Uint8Array(value))
}

function validateAttachment(bytes, name, mimeType, requireMimeType) {
  const actual = detectAttachmentType(bytes)
  if (!actual) fail('LOCAL_ATTACHMENT_TYPE_UNSUPPORTED')
  const declaredMime = declaredMimeType(mimeType)
  if (requireMimeType && !TYPE_BY_MIME.has(declaredMime)) {
    fail('LOCAL_ATTACHMENT_TYPE_UNSUPPORTED')
  }
  if (declaredMime && declaredMime !== actual.mimeType) {
    fail('LOCAL_ATTACHMENT_TYPE_MISMATCH')
  }
  const nameType = declaredNameType(name)
  if (nameType && nameType.mimeType !== actual.mimeType) {
    fail('LOCAL_ATTACHMENT_TYPE_MISMATCH')
  }
  if (bytes.length > actual.maxBytes) fail('LOCAL_ATTACHMENT_TOO_LARGE')
  return actual
}

function writePrivateFile(filename, contents) {
  let descriptor
  try {
    descriptor = fs.openSync(filename, 'wx', FILE_MODE)
    fs.writeFileSync(descriptor, contents)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.chmodSync(filename, FILE_MODE)
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch { /* already closed */ }
    }
    try { fs.unlinkSync(filename) } catch { /* absent */ }
    throw error
  }
}

function readExactFile(descriptor, size) {
  const bytes = Buffer.allocUnsafe(size)
  let offset = 0
  while (offset < size) {
    const count = fs.readSync(descriptor, bytes, offset, size - offset, offset)
    if (count === 0) break
    offset += count
  }
  const extra = Buffer.allocUnsafe(1)
  if (offset !== size || fs.readSync(descriptor, extra, 0, 1, size) !== 0) {
    throw new Error('file changed while reading')
  }
  return bytes
}

class AttachmentStore {
  constructor({ rootPath, createId = () => crypto.randomUUID() } = {}) {
    if (typeof rootPath !== 'string' || !rootPath || rootPath.length > 4096) {
      fail('LOCAL_ATTACHMENT_ROOT_REQUIRED')
    }
    if (typeof createId !== 'function') fail('LOCAL_ATTACHMENT_CREATE_ID_INVALID')
    this.rootPath = path.resolve(rootPath)
    if (this.rootPath === path.parse(this.rootPath).root) {
      fail('LOCAL_ATTACHMENT_ROOT_UNSAFE')
    }
    this.createId = createId
    this.rootRealPath = this.prepareRoot()
  }

  importBuffer(input) {
    if (sortedKeys(input) !== 'bytes,mimeType,name'
        || typeof input.name !== 'string' || input.name.length > 4096
        || typeof input.mimeType !== 'string') {
      fail('LOCAL_ATTACHMENT_INPUT_INVALID')
    }
    return this.importBytes(toBuffer(input.bytes), input.name, input.mimeType, true)
  }

  importFile(filename) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename) || filename.length > 4096) {
      fail('LOCAL_ATTACHMENT_SOURCE_INVALID')
    }
    let descriptor
    try {
      const sourceStat = fs.lstatSync(filename)
      if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
        fail('LOCAL_ATTACHMENT_SOURCE_UNSAFE')
      }
      const noFollow = process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW || 0)
      descriptor = fs.openSync(filename, fs.constants.O_RDONLY | noFollow)
      const stat = fs.fstatSync(descriptor)
      if (!stat.isFile()) fail('LOCAL_ATTACHMENT_SOURCE_UNSAFE')
      if (stat.size > MAX_ATTACHMENT_BYTES) fail('LOCAL_ATTACHMENT_TOO_LARGE')
      if (stat.size <= 0) fail('LOCAL_ATTACHMENT_BYTES_INVALID')
      const bytes = readExactFile(descriptor, stat.size)
      if (fs.fstatSync(descriptor).size !== stat.size) {
        fail('LOCAL_ATTACHMENT_SOURCE_UNAVAILABLE')
      }
      return this.importBytes(bytes, path.basename(filename), '', false)
    } catch (error) {
      if (isAttachmentError(error)) throw error
      throw attachmentError('LOCAL_ATTACHMENT_SOURCE_UNAVAILABLE')
    } finally {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor) } catch { /* already closed */ }
      }
    }
  }

  resolve(refs) {
    return normalizeReferences(refs).map((id) => {
      const entry = this.loadEntry(id)
      return { ...entry.metadata, path: entry.path }
    })
  }

  read(id) {
    return Buffer.from(this.loadEntry(normalizeId(id)).bytes)
  }

  readWithMetadata(id) {
    const entry = this.loadEntry(normalizeId(id))
    return {
      metadata: { ...entry.metadata },
      bytes: Buffer.from(entry.bytes),
    }
  }

  discard(refs) {
    this.assertRoot()
    const discardedIds = []
    for (const id of normalizeDiscardReferences(refs)) {
      const directory = path.join(this.rootPath, id)
      try {
        const stat = fs.lstatSync(directory)
        if (stat.isSymbolicLink() || !stat.isDirectory()) fail('LOCAL_ATTACHMENT_TAMPERED')
      } catch (error) {
        if (error.code === 'ENOENT') continue
        if (isAttachmentError(error)) throw error
        throw attachmentError('LOCAL_ATTACHMENT_STORAGE_UNAVAILABLE')
      }
      this.removeDirectory(directory)
      discardedIds.push(id)
    }
    return discardedIds
  }

  cleanup(referencedIds = []) {
    this.assertRoot()
    const referenced = normalizeReferencedIds(referencedIds)
    const discardedIds = []
    let removedTemporaryEntries = 0
    let entries
    try {
      entries = fs.readdirSync(this.rootPath, { withFileTypes: true })
    } catch {
      throw attachmentError('LOCAL_ATTACHMENT_STORAGE_UNAVAILABLE')
    }
    for (const entry of entries) {
      const candidate = path.join(this.rootPath, entry.name)
      if (entry.name.startsWith('.import-') || entry.name.startsWith('.discard-')) {
        this.removeTemporaryEntry(candidate)
        removedTemporaryEntries += 1
        continue
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(entry.name)
          || referenced.has(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
        continue
      }
      this.removeDirectory(candidate)
      discardedIds.push(entry.name)
    }
    return { discardedIds, removedTemporaryEntries }
  }

  prepareRoot() {
    try {
      try {
        const existing = fs.lstatSync(this.rootPath)
        if (existing.isSymbolicLink() || !existing.isDirectory()) {
          fail('LOCAL_ATTACHMENT_ROOT_UNSAFE')
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        fs.mkdirSync(this.rootPath, { recursive: true, mode: DIRECTORY_MODE })
      }
      const stat = fs.lstatSync(this.rootPath)
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail('LOCAL_ATTACHMENT_ROOT_UNSAFE')
      fs.chmodSync(this.rootPath, DIRECTORY_MODE)
      return fs.realpathSync(this.rootPath)
    } catch (error) {
      if (isAttachmentError(error)) throw error
      throw attachmentError('LOCAL_ATTACHMENT_STORAGE_UNAVAILABLE')
    }
  }

  assertRoot() {
    try {
      const stat = fs.lstatSync(this.rootPath)
      if (stat.isSymbolicLink() || !stat.isDirectory()
          || fs.realpathSync(this.rootPath) !== this.rootRealPath
          || (process.platform !== 'win32' && (stat.mode & 0o777) !== DIRECTORY_MODE)) {
        fail('LOCAL_ATTACHMENT_ROOT_UNSAFE')
      }
    } catch (error) {
      if (isAttachmentError(error)) throw error
      throw attachmentError('LOCAL_ATTACHMENT_ROOT_UNSAFE')
    }
  }

  removeDirectory(directory) {
    const tombstone = path.join(
      this.rootPath,
      `.discard-${process.pid}-${crypto.randomBytes(8).toString('hex')}`,
    )
    try {
      fs.renameSync(directory, tombstone)
      fs.rmSync(tombstone, { recursive: true, force: true })
    } catch (error) {
      if (error.code === 'ENOENT') return false
      throw attachmentError('LOCAL_ATTACHMENT_STORAGE_UNAVAILABLE')
    }
    return true
  }

  removeTemporaryEntry(filename) {
    try {
      const stat = fs.lstatSync(filename)
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        fs.rmSync(filename, { recursive: true, force: true })
      } else {
        fs.unlinkSync(filename)
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw attachmentError('LOCAL_ATTACHMENT_STORAGE_UNAVAILABLE')
    }
  }

  importBytes(bytes, name, mimeType, requireMimeType) {
    this.assertRoot()
    if (bytes.length > MAX_ATTACHMENT_BYTES) fail('LOCAL_ATTACHMENT_TOO_LARGE')
    const type = validateAttachment(bytes, name, mimeType, requireMimeType)
    let id
    try { id = normalizeId(this.createId()) } catch (error) {
      if (isAttachmentError(error)) throw error
      throw attachmentError('LOCAL_ATTACHMENT_CREATE_ID_INVALID')
    }
    const metadata = {
      id,
      name: sanitizeName(name, type),
      mimeType: type.mimeType,
      size: bytes.length,
    }
    const document = {
      version: STORE_VERSION,
      ...metadata,
      checksum: crypto.createHash('sha256').update(bytes).digest('hex'),
    }
    const finalDirectory = path.join(this.rootPath, id)
    let temporaryDirectory = ''
    try {
      if (fs.existsSync(finalDirectory)) fail('LOCAL_ATTACHMENT_ID_CONFLICT')
      temporaryDirectory = fs.mkdtempSync(path.join(this.rootPath, '.import-'))
      fs.chmodSync(temporaryDirectory, DIRECTORY_MODE)
      writePrivateFile(path.join(temporaryDirectory, `${type.storageBase}.${type.extension}`), bytes)
      writePrivateFile(
        path.join(temporaryDirectory, 'metadata.json'),
        Buffer.from(JSON.stringify(document), 'utf8'),
      )
      fs.renameSync(temporaryDirectory, finalDirectory)
      temporaryDirectory = ''
      return { ...metadata }
    } catch (error) {
      if (temporaryDirectory) {
        try { fs.rmSync(temporaryDirectory, { recursive: true, force: true }) } catch { /* best effort */ }
      }
      if (isAttachmentError(error)) throw error
      if (['EEXIST', 'ENOTEMPTY'].includes(error.code)) {
        throw attachmentError('LOCAL_ATTACHMENT_ID_CONFLICT')
      }
      throw attachmentError('LOCAL_ATTACHMENT_STORAGE_UNAVAILABLE')
    }
  }

  loadEntry(id) {
    this.assertRoot()
    const directory = path.join(this.rootPath, id)
    let directoryStat
    try {
      directoryStat = fs.lstatSync(directory)
    } catch (error) {
      if (error.code === 'ENOENT') fail('LOCAL_ATTACHMENT_NOT_FOUND')
      throw attachmentError('LOCAL_ATTACHMENT_STORAGE_UNAVAILABLE')
    }
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()
        || (process.platform !== 'win32' && (directoryStat.mode & 0o777) !== DIRECTORY_MODE)) {
      fail('LOCAL_ATTACHMENT_TAMPERED')
    }
    let realDirectory
    try { realDirectory = fs.realpathSync(directory) } catch { fail('LOCAL_ATTACHMENT_TAMPERED') }
    if (!isInside(this.rootRealPath, realDirectory)) fail('LOCAL_ATTACHMENT_TAMPERED')

    const metadataBytes = this.readStoredFile(
      path.join(directory, 'metadata.json'),
      'LOCAL_ATTACHMENT_FILE_MISSING',
      MAX_METADATA_BYTES,
    )
    let document
    try { document = JSON.parse(metadataBytes.toString('utf8')) } catch { fail('LOCAL_ATTACHMENT_TAMPERED') }
    if (sortedKeys(document) !== 'checksum,id,mimeType,name,size,version'
        || document.version !== STORE_VERSION || document.id !== id
        || typeof document.name !== 'string' || typeof document.mimeType !== 'string'
        || !Number.isSafeInteger(document.size) || document.size <= 0
        || document.size > MAX_ATTACHMENT_BYTES
        || typeof document.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(document.checksum)) {
      fail('LOCAL_ATTACHMENT_TAMPERED')
    }
    const type = TYPE_BY_MIME.get(document.mimeType)
    if (!type || sanitizeName(document.name, type) !== document.name) {
      fail('LOCAL_ATTACHMENT_TAMPERED')
    }
    const contentPath = path.join(directory, `${type.storageBase}.${type.extension}`)
    const bytes = this.readStoredFile(
      contentPath,
      'LOCAL_ATTACHMENT_FILE_MISSING',
      MAX_ATTACHMENT_BYTES,
    )
    if (bytes.length !== document.size
        || detectAttachmentType(bytes)?.mimeType !== document.mimeType
        || crypto.createHash('sha256').update(bytes).digest('hex') !== document.checksum) {
      fail('LOCAL_ATTACHMENT_TAMPERED')
    }
    return {
      directory,
      path: contentPath,
      bytes,
      metadata: {
        id: document.id,
        name: document.name,
        mimeType: document.mimeType,
        size: document.size,
      },
    }
  }

  readStoredFile(filename, missingCode, maxBytes) {
    let descriptor
    try {
      const fileStat = fs.lstatSync(filename)
      if (fileStat.isSymbolicLink() || !fileStat.isFile()
          || fileStat.size <= 0 || fileStat.size > maxBytes
          || (process.platform !== 'win32' && (fileStat.mode & 0o777) !== FILE_MODE)) {
        fail('LOCAL_ATTACHMENT_TAMPERED')
      }
      const realPath = fs.realpathSync(filename)
      if (!isInside(this.rootRealPath, realPath)) fail('LOCAL_ATTACHMENT_TAMPERED')
      const noFollow = process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW || 0)
      descriptor = fs.openSync(filename, fs.constants.O_RDONLY | noFollow)
      const openedStat = fs.fstatSync(descriptor)
      if (!openedStat.isFile() || openedStat.size !== fileStat.size
          || (process.platform !== 'win32' && (openedStat.mode & 0o777) !== FILE_MODE)) {
        fail('LOCAL_ATTACHMENT_TAMPERED')
      }
      const bytes = readExactFile(descriptor, openedStat.size)
      if (fs.fstatSync(descriptor).size !== openedStat.size) {
        fail('LOCAL_ATTACHMENT_TAMPERED')
      }
      return bytes
    } catch (error) {
      if (isAttachmentError(error)) throw error
      if (error.code === 'ENOENT') throw attachmentError(missingCode)
      throw attachmentError('LOCAL_ATTACHMENT_TAMPERED')
    } finally {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor) } catch { /* already closed */ }
      }
    }
  }
}

module.exports = { AttachmentStore }
