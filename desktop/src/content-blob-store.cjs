const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const MAX_CONTENT_BLOB_BYTES = 256 * 1024 * 1024
const SHA256 = /^[a-f0-9]{64}$/
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/

function contentBlobError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function fail(code) {
  throw contentBlobError(code)
}

function isContentBlobError(error) {
  return /^CONTENT_BLOB_[A-Z0-9_]+$/.test(String(error?.message || ''))
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function sortedKeys(value) {
  return isPlainObject(value) && Reflect.ownKeys(value).every(key => typeof key === 'string')
    ? Reflect.ownKeys(value).sort().join(',')
    : ''
}

function normalizeMediaType(value) {
  const mediaType = String(value || '').trim().toLowerCase()
  if (!mediaType || mediaType.length > 127 || !MEDIA_TYPE.test(mediaType)) {
    fail('CONTENT_BLOB_MEDIA_TYPE_INVALID')
  }
  return mediaType
}

function normalizeContentBlobRef(value) {
  const keys = sortedKeys(value)
  if (keys !== 'algorithm,hash,size' && keys !== 'algorithm,hash,mediaType,size') {
    fail('CONTENT_BLOB_REF_INVALID')
  }
  if (value.algorithm !== 'sha256' || typeof value.hash !== 'string'
      || !SHA256.test(value.hash) || !Number.isSafeInteger(value.size)
      || value.size < 0 || value.size > MAX_CONTENT_BLOB_BYTES) {
    fail('CONTENT_BLOB_REF_INVALID')
  }
  const ref = {
    algorithm: 'sha256',
    hash: value.hash,
    size: value.size,
  }
  if (Object.hasOwn(value, 'mediaType')) {
    const mediaType = normalizeMediaType(value.mediaType)
    if (mediaType !== value.mediaType) fail('CONTENT_BLOB_REF_INVALID')
    ref.mediaType = mediaType
  }
  return ref
}

function normalizeOptions(value) {
  if (value === undefined) return {}
  const keys = sortedKeys(value)
  if (keys !== '' && keys !== 'mediaType') fail('CONTENT_BLOB_OPTIONS_INVALID')
  if (keys === '') {
    if (!isPlainObject(value)) fail('CONTENT_BLOB_OPTIONS_INVALID')
    return {}
  }
  return { mediaType: normalizeMediaType(value.mediaType) }
}

function toBuffer(value) {
  let size
  if (typeof value === 'string') size = Buffer.byteLength(value)
  else if (Buffer.isBuffer(value) || value instanceof Uint8Array) size = value.byteLength
  else if (value instanceof ArrayBuffer) size = value.byteLength
  else fail('CONTENT_BLOB_BYTES_INVALID')
  if (size > MAX_CONTENT_BLOB_BYTES) fail('CONTENT_BLOB_TOO_LARGE')
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  if (Buffer.isBuffer(value)) return Buffer.from(value)
  if (value instanceof Uint8Array) return Buffer.from(value)
  return Buffer.from(new Uint8Array(value))
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return Boolean(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative))
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
    fail('CONTENT_BLOB_TAMPERED')
  }
  return bytes
}

function writeExclusiveAtomic(filename, bytes) {
  const directory = path.dirname(filename)
  const temporaryPath = path.join(
    directory,
    `.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`,
  )
  let descriptor
  let linked = false
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', FILE_MODE)
    fs.writeFileSync(descriptor, bytes)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.chmodSync(temporaryPath, FILE_MODE)
    try {
      fs.linkSync(temporaryPath, filename)
      linked = true
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    fs.unlinkSync(temporaryPath)
    return linked
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch { /* already closed */ }
    }
    try { fs.unlinkSync(temporaryPath) } catch { /* absent */ }
    throw error
  }
}

class ContentBlobStore {
  constructor({ rootPath } = {}) {
    if (typeof rootPath !== 'string' || !rootPath || rootPath.length > 4096) {
      fail('CONTENT_BLOB_ROOT_REQUIRED')
    }
    this.rootPath = path.resolve(rootPath)
    if (this.rootPath === path.parse(this.rootPath).root) fail('CONTENT_BLOB_ROOT_UNSAFE')
    this.rootRealPath = this.prepareRoot()
  }

  put(value, options) {
    const bytes = toBuffer(value)
    const normalizedOptions = normalizeOptions(options)
    const hash = crypto.createHash('sha256').update(bytes).digest('hex')
    const ref = {
      algorithm: 'sha256',
      hash,
      size: bytes.length,
      ...normalizedOptions,
    }
    const directory = this.ensureBlobDirectory(hash, true)
    const filename = path.join(directory, hash)
    try {
      const written = writeExclusiveAtomic(filename, bytes)
      const stored = this.read(ref)
      if (!stored.equals(bytes)) fail('CONTENT_BLOB_TAMPERED')
      if (!written) return { ...ref }
      return { ...ref }
    } catch (error) {
      if (isContentBlobError(error)) throw error
      throw contentBlobError('CONTENT_BLOB_STORAGE_UNAVAILABLE')
    }
  }

  read(value) {
    const ref = normalizeContentBlobRef(value)
    const directory = this.ensureBlobDirectory(ref.hash, false)
    const filename = path.join(directory, ref.hash)
    let descriptor
    try {
      const fileStat = fs.lstatSync(filename)
      if (fileStat.isSymbolicLink() || !fileStat.isFile()
          || fileStat.size !== ref.size || fileStat.size > MAX_CONTENT_BLOB_BYTES
          || (process.platform !== 'win32' && (fileStat.mode & 0o777) !== FILE_MODE)) {
        fail('CONTENT_BLOB_TAMPERED')
      }
      const realPath = fs.realpathSync(filename)
      if (!isInside(this.rootRealPath, realPath)) fail('CONTENT_BLOB_TAMPERED')
      const noFollow = process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW || 0)
      descriptor = fs.openSync(filename, fs.constants.O_RDONLY | noFollow)
      const openedStat = fs.fstatSync(descriptor)
      if (!openedStat.isFile() || openedStat.size !== ref.size
          || openedStat.dev !== fileStat.dev || openedStat.ino !== fileStat.ino
          || (process.platform !== 'win32' && (openedStat.mode & 0o777) !== FILE_MODE)) {
        fail('CONTENT_BLOB_TAMPERED')
      }
      const bytes = readExactFile(descriptor, openedStat.size)
      const actualHash = crypto.createHash('sha256').update(bytes).digest()
      const expectedHash = Buffer.from(ref.hash, 'hex')
      if (!crypto.timingSafeEqual(actualHash, expectedHash)) fail('CONTENT_BLOB_TAMPERED')
      return bytes
    } catch (error) {
      if (isContentBlobError(error)) throw error
      if (error.code === 'ENOENT') throw contentBlobError('CONTENT_BLOB_NOT_FOUND')
      throw contentBlobError('CONTENT_BLOB_TAMPERED')
    } finally {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor) } catch { /* already closed */ }
      }
    }
  }

  has(value) {
    try {
      this.read(value)
      return true
    } catch (error) {
      if (error?.code === 'CONTENT_BLOB_NOT_FOUND') return false
      throw error
    }
  }

  prepareRoot() {
    try {
      try {
        const existing = fs.lstatSync(this.rootPath)
        if (existing.isSymbolicLink() || !existing.isDirectory()) {
          fail('CONTENT_BLOB_ROOT_UNSAFE')
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        fs.mkdirSync(this.rootPath, { recursive: true, mode: DIRECTORY_MODE })
      }
      const stat = fs.lstatSync(this.rootPath)
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail('CONTENT_BLOB_ROOT_UNSAFE')
      fs.chmodSync(this.rootPath, DIRECTORY_MODE)
      return fs.realpathSync(this.rootPath)
    } catch (error) {
      if (isContentBlobError(error)) throw error
      throw contentBlobError('CONTENT_BLOB_STORAGE_UNAVAILABLE')
    }
  }

  assertRoot() {
    try {
      const stat = fs.lstatSync(this.rootPath)
      if (stat.isSymbolicLink() || !stat.isDirectory()
          || fs.realpathSync(this.rootPath) !== this.rootRealPath
          || (process.platform !== 'win32' && (stat.mode & 0o777) !== DIRECTORY_MODE)) {
        fail('CONTENT_BLOB_ROOT_UNSAFE')
      }
    } catch (error) {
      if (isContentBlobError(error)) throw error
      throw contentBlobError('CONTENT_BLOB_ROOT_UNSAFE')
    }
  }

  ensureBlobDirectory(hash, create) {
    this.assertRoot()
    let current = this.rootPath
    for (const segment of ['sha256', hash.slice(0, 2)]) {
      current = path.join(current, segment)
      try {
        let stat
        try {
          stat = fs.lstatSync(current)
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
          if (!create) fail('CONTENT_BLOB_NOT_FOUND')
          try {
            fs.mkdirSync(current, { mode: DIRECTORY_MODE })
          } catch (mkdirError) {
            if (mkdirError.code !== 'EEXIST') throw mkdirError
          }
          stat = fs.lstatSync(current)
        }
        if (stat.isSymbolicLink() || !stat.isDirectory()
            || (process.platform !== 'win32' && (stat.mode & 0o777) !== DIRECTORY_MODE)) {
          fail('CONTENT_BLOB_ROOT_UNSAFE')
        }
        const realPath = fs.realpathSync(current)
        if (!isInside(this.rootRealPath, realPath)) fail('CONTENT_BLOB_ROOT_UNSAFE')
      } catch (error) {
        if (isContentBlobError(error)) throw error
        throw contentBlobError('CONTENT_BLOB_ROOT_UNSAFE')
      }
    }
    return current
  }
}

module.exports = {
  ContentBlobStore,
  MAX_CONTENT_BLOB_BYTES,
  normalizeContentBlobRef,
}
