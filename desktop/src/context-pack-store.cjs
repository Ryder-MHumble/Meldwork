const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const {
  MAX_CONTEXT_PACK_RECORD_BYTES,
  MAX_DELIVERY_RECORD_BYTES,
  canonicalJson,
  createContextPackRecord,
  createDeliveryRecord,
  parseContextPackRecord,
  parseDeliveryRecord,
} = require('./context-pack-records.cjs')

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const CONTEXT_PACK_ID = /^context-pack-[a-f0-9]{64}$/
const DELIVERY_RECORD_ID = /^delivery-record-[a-f0-9]{64}$/

function contextStoreError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function fail(code) {
  throw contextStoreError(code)
}

function isKnownError(error) {
  return /^(?:CONTEXT_PACK|DELIVERY_RECORD|CANONICAL_JSON)_[A-Z0-9_]+$/
    .test(String(error?.message || ''))
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
    throw new Error('record changed while reading')
  }
  return bytes
}

function writeExclusiveAtomic(filename, bytes) {
  const temporaryPath = path.join(
    path.dirname(filename),
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

function normalizeContextPackId(value) {
  if (typeof value !== 'string' || !CONTEXT_PACK_ID.test(value)) {
    fail('CONTEXT_PACK_ID_INVALID')
  }
  return value
}

function normalizeDeliveryRecordId(value) {
  if (typeof value !== 'string' || !DELIVERY_RECORD_ID.test(value)) {
    fail('DELIVERY_RECORD_ID_INVALID')
  }
  return value
}

class ContextPackStore {
  constructor({ rootPath } = {}) {
    if (typeof rootPath !== 'string' || !rootPath || rootPath.length > 4096) {
      fail('CONTEXT_PACK_STORE_ROOT_REQUIRED')
    }
    this.rootPath = path.resolve(rootPath)
    if (this.rootPath === path.parse(this.rootPath).root) {
      fail('CONTEXT_PACK_STORE_ROOT_UNSAFE')
    }
    this.rootRealPath = this.prepareRoot()
  }

  put(input) {
    const record = input && (
      typeof input === 'string' || Buffer.isBuffer(input) || input instanceof Uint8Array
      || Object.hasOwn(input, 'contextPackId')
    )
      ? parseContextPackRecord(input)
      : createContextPackRecord(input)
    return this.writeRecord({
      category: 'context-packs',
      id: record.contextPackId,
      record,
      parser: parseContextPackRecord,
      maxBytes: MAX_CONTEXT_PACK_RECORD_BYTES,
      missingCode: 'CONTEXT_PACK_NOT_FOUND',
      tamperedCode: 'CONTEXT_PACK_TAMPERED',
    })
  }

  get(value) {
    const id = normalizeContextPackId(value)
    return this.readRecord({
      category: 'context-packs',
      id,
      parser: parseContextPackRecord,
      maxBytes: MAX_CONTEXT_PACK_RECORD_BYTES,
      missingCode: 'CONTEXT_PACK_NOT_FOUND',
      tamperedCode: 'CONTEXT_PACK_TAMPERED',
    })
  }

  putDelivery(input) {
    const record = input && (
      typeof input === 'string' || Buffer.isBuffer(input) || input instanceof Uint8Array
      || Object.hasOwn(input, 'deliveryRecordId')
    )
      ? parseDeliveryRecord(input)
      : createDeliveryRecord(input)
    return this.writeRecord({
      category: 'deliveries',
      id: record.deliveryRecordId,
      record,
      parser: parseDeliveryRecord,
      maxBytes: MAX_DELIVERY_RECORD_BYTES,
      missingCode: 'DELIVERY_RECORD_NOT_FOUND',
      tamperedCode: 'DELIVERY_RECORD_TAMPERED',
    })
  }

  getDelivery(value) {
    const id = normalizeDeliveryRecordId(value)
    return this.readRecord({
      category: 'deliveries',
      id,
      parser: parseDeliveryRecord,
      maxBytes: MAX_DELIVERY_RECORD_BYTES,
      missingCode: 'DELIVERY_RECORD_NOT_FOUND',
      tamperedCode: 'DELIVERY_RECORD_TAMPERED',
    })
  }

  writeRecord(options) {
    const serialized = canonicalJson(options.record)
    const bytes = Buffer.from(serialized, 'utf8')
    const directory = this.ensureRecordDirectory(
      options.category, options.id, true, options.missingCode,
    )
    const filename = path.join(directory, `${options.id}.json`)
    try {
      writeExclusiveAtomic(filename, bytes)
      const stored = this.readRecord(options)
      if (canonicalJson(stored) !== serialized) fail(options.tamperedCode)
      return stored
    } catch (error) {
      if (isKnownError(error)) throw error
      throw contextStoreError('CONTEXT_PACK_STORE_UNAVAILABLE')
    }
  }

  readRecord(options) {
    const directory = this.ensureRecordDirectory(
      options.category, options.id, false, options.missingCode,
    )
    const filename = path.join(directory, `${options.id}.json`)
    let descriptor
    try {
      const fileStat = fs.lstatSync(filename)
      if (fileStat.isSymbolicLink() || !fileStat.isFile()
          || fileStat.size <= 0 || fileStat.size > options.maxBytes
          || (process.platform !== 'win32' && (fileStat.mode & 0o777) !== FILE_MODE)) {
        fail(options.tamperedCode)
      }
      const realPath = fs.realpathSync(filename)
      if (!isInside(this.rootRealPath, realPath)) fail(options.tamperedCode)
      const noFollow = process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW || 0)
      descriptor = fs.openSync(filename, fs.constants.O_RDONLY | noFollow)
      const openedStat = fs.fstatSync(descriptor)
      if (!openedStat.isFile() || openedStat.size !== fileStat.size
          || openedStat.dev !== fileStat.dev || openedStat.ino !== fileStat.ino
          || (process.platform !== 'win32' && (openedStat.mode & 0o777) !== FILE_MODE)) {
        fail(options.tamperedCode)
      }
      const bytes = readExactFile(descriptor, openedStat.size)
      let record
      try { record = options.parser(bytes) } catch { fail(options.tamperedCode) }
      const storedId = options.category === 'context-packs'
        ? record.contextPackId
        : record.deliveryRecordId
      if (storedId !== options.id) fail(options.tamperedCode)
      return record
    } catch (error) {
      if (error?.message === options.tamperedCode) throw error
      if (error.code === 'ENOENT' || error?.message === options.missingCode) {
        throw contextStoreError(options.missingCode)
      }
      if (isKnownError(error)) throw error
      throw contextStoreError(options.tamperedCode)
    } finally {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor) } catch { /* already closed */ }
      }
    }
  }

  prepareRoot() {
    try {
      try {
        const existing = fs.lstatSync(this.rootPath)
        if (existing.isSymbolicLink() || !existing.isDirectory()) {
          fail('CONTEXT_PACK_STORE_ROOT_UNSAFE')
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        fs.mkdirSync(this.rootPath, { recursive: true, mode: DIRECTORY_MODE })
      }
      const stat = fs.lstatSync(this.rootPath)
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        fail('CONTEXT_PACK_STORE_ROOT_UNSAFE')
      }
      fs.chmodSync(this.rootPath, DIRECTORY_MODE)
      return fs.realpathSync(this.rootPath)
    } catch (error) {
      if (isKnownError(error)) throw error
      throw contextStoreError('CONTEXT_PACK_STORE_UNAVAILABLE')
    }
  }

  assertRoot() {
    try {
      const stat = fs.lstatSync(this.rootPath)
      if (stat.isSymbolicLink() || !stat.isDirectory()
          || fs.realpathSync(this.rootPath) !== this.rootRealPath
          || (process.platform !== 'win32' && (stat.mode & 0o777) !== DIRECTORY_MODE)) {
        fail('CONTEXT_PACK_STORE_ROOT_UNSAFE')
      }
    } catch (error) {
      if (isKnownError(error)) throw error
      throw contextStoreError('CONTEXT_PACK_STORE_ROOT_UNSAFE')
    }
  }

  ensureRecordDirectory(category, id, create, missingCode) {
    this.assertRoot()
    const hash = id.slice(id.lastIndexOf('-') + 1)
    let current = this.rootPath
    for (const segment of [category, hash.slice(0, 2)]) {
      current = path.join(current, segment)
      try {
        let stat
        try {
          stat = fs.lstatSync(current)
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
          if (!create) fail(missingCode)
          try {
            fs.mkdirSync(current, { mode: DIRECTORY_MODE })
          } catch (mkdirError) {
            if (mkdirError.code !== 'EEXIST') throw mkdirError
          }
          stat = fs.lstatSync(current)
        }
        if (stat.isSymbolicLink() || !stat.isDirectory()
            || (process.platform !== 'win32' && (stat.mode & 0o777) !== DIRECTORY_MODE)) {
          fail('CONTEXT_PACK_STORE_ROOT_UNSAFE')
        }
        const realPath = fs.realpathSync(current)
        if (!isInside(this.rootRealPath, realPath)) fail('CONTEXT_PACK_STORE_ROOT_UNSAFE')
      } catch (error) {
        if (isKnownError(error)) throw error
        throw contextStoreError('CONTEXT_PACK_STORE_ROOT_UNSAFE')
      }
    }
    return current
  }
}

module.exports = { ContextPackStore }
