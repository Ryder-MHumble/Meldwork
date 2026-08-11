const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const {
  MAX_EVAL_RECORD_BYTES,
  createEvalCase,
  createEvalResult,
  createFitMatrix,
  parseEvalCase,
  parseEvalResult,
  parseFitMatrix,
} = require('./eval-records.cjs')
const { canonicalJson } = require('./outcome-records.cjs')

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600

function evalStoreError(code, cause) {
  const error = new Error(code)
  error.code = code
  if (cause) error.cause = cause
  return error
}

function fail(code) {
  throw evalStoreError(code)
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
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', FILE_MODE)
    fs.writeFileSync(descriptor, bytes)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.chmodSync(temporaryPath, FILE_MODE)
    try { fs.linkSync(temporaryPath, filename) } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    fs.unlinkSync(temporaryPath)
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch { /* already closed */ }
    }
    try { fs.unlinkSync(temporaryPath) } catch { /* absent */ }
    throw error
  }
}

const SPECS = Object.freeze({
  case: {
    category: 'cases',
    idKey: 'evalCaseId',
    pattern: /^eval-case-[a-f0-9]{64}$/,
    create: createEvalCase,
    parse: parseEvalCase,
    idError: 'EVAL_CASE_ID_INVALID',
    missingError: 'EVAL_CASE_NOT_FOUND',
    tamperedError: 'EVAL_CASE_TAMPERED',
  },
  result: {
    category: 'results',
    idKey: 'evalResultId',
    pattern: /^eval-result-[a-f0-9]{64}$/,
    create: createEvalResult,
    parse: parseEvalResult,
    idError: 'EVAL_RESULT_ID_INVALID',
    missingError: 'EVAL_RESULT_NOT_FOUND',
    tamperedError: 'EVAL_RESULT_TAMPERED',
  },
  matrix: {
    category: 'matrices',
    idKey: 'matrixId',
    pattern: /^fit-matrix-[a-f0-9]{64}$/,
    create: createFitMatrix,
    parse: parseFitMatrix,
    idError: 'FIT_MATRIX_ID_INVALID',
    missingError: 'FIT_MATRIX_NOT_FOUND',
    tamperedError: 'FIT_MATRIX_TAMPERED',
  },
})

class EvalStore {
  constructor({ rootPath } = {}) {
    if (typeof rootPath !== 'string' || !rootPath || rootPath.length > 4096) {
      fail('EVAL_STORE_ROOT_REQUIRED')
    }
    this.rootPath = path.resolve(rootPath)
    if (this.rootPath === path.parse(this.rootPath).root) fail('EVAL_STORE_ROOT_UNSAFE')
    this.rootRealPath = this.prepareRoot()
  }

  putCase(input) {
    return this.putRecord(SPECS.case, input)
  }

  getCase(id) {
    return this.getRecord(SPECS.case, id)
  }

  putResult(input) {
    const result = this.putRecord(SPECS.result, input, false)
    const evalCase = this.getCase(result.evalCaseId)
    if (evalCase.caseVersion !== result.caseVersion) fail('EVAL_RESULT_CASE_MISMATCH')
    return this.putRecord(SPECS.result, result)
  }

  getResult(id) {
    const result = this.getRecord(SPECS.result, id)
    const evalCase = this.getCase(result.evalCaseId)
    if (evalCase.caseVersion !== result.caseVersion) fail('EVAL_RESULT_CASE_MISMATCH')
    return result
  }

  putMatrix(input) {
    const matrix = Object.hasOwn(input || {}, 'matrixId') ? parseFitMatrix(input) : createFitMatrix(input)
    for (const resultId of matrix.resultIds) this.getResult(resultId)
    return this.putRecord(SPECS.matrix, matrix)
  }

  getMatrix(id) {
    const matrix = this.getRecord(SPECS.matrix, id)
    for (const resultId of matrix.resultIds) this.getResult(resultId)
    return matrix
  }

  putRecord(spec, input, persist = true) {
    const record = Object.hasOwn(input || {}, spec.idKey) ? spec.parse(input) : spec.create(input)
    if (!persist) return record
    const serialized = canonicalJson(record)
    const bytes = Buffer.from(serialized, 'utf8')
    const directory = this.ensureRecordDirectory(spec, record[spec.idKey], true)
    const filename = path.join(directory, `${record[spec.idKey]}.json`)
    try {
      writeExclusiveAtomic(filename, bytes)
      const stored = this.readRecord(spec, record[spec.idKey])
      if (canonicalJson(stored) !== serialized) fail(spec.tamperedError)
      return stored
    } catch (error) {
      if (String(error?.code || '').startsWith('EVAL_')
          || String(error?.code || '').startsWith('FIT_MATRIX_')) throw error
      throw evalStoreError('EVAL_STORE_UNAVAILABLE', error)
    }
  }

  getRecord(spec, id) {
    if (typeof id !== 'string' || !spec.pattern.test(id)) fail(spec.idError)
    return this.readRecord(spec, id)
  }

  readRecord(spec, id) {
    const directory = this.ensureRecordDirectory(spec, id, false)
    const filename = path.join(directory, `${id}.json`)
    let descriptor
    try {
      const fileStat = fs.lstatSync(filename)
      if (fileStat.isSymbolicLink() || !fileStat.isFile()
          || fileStat.size <= 0 || fileStat.size > MAX_EVAL_RECORD_BYTES
          || (process.platform !== 'win32' && (fileStat.mode & 0o777) !== FILE_MODE)) {
        fail(spec.tamperedError)
      }
      const realPath = fs.realpathSync(filename)
      if (!isInside(this.rootRealPath, realPath)) fail(spec.tamperedError)
      const noFollow = process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW || 0)
      descriptor = fs.openSync(filename, fs.constants.O_RDONLY | noFollow)
      const openedStat = fs.fstatSync(descriptor)
      if (!openedStat.isFile() || openedStat.size !== fileStat.size
          || openedStat.dev !== fileStat.dev || openedStat.ino !== fileStat.ino
          || (process.platform !== 'win32' && (openedStat.mode & 0o777) !== FILE_MODE)) {
        fail(spec.tamperedError)
      }
      const record = spec.parse(readExactFile(descriptor, openedStat.size))
      if (record[spec.idKey] !== id) fail(spec.tamperedError)
      return record
    } catch (error) {
      if (error?.code === spec.tamperedError) throw error
      if (error?.code === 'ENOENT' || error?.code === spec.missingError) {
        throw evalStoreError(spec.missingError)
      }
      if (String(error?.code || '').startsWith('EVAL_')
          || String(error?.code || '').startsWith('FIT_MATRIX_')) {
        throw evalStoreError(spec.tamperedError)
      }
      throw evalStoreError(spec.tamperedError)
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
        if (existing.isSymbolicLink() || !existing.isDirectory()) fail('EVAL_STORE_ROOT_UNSAFE')
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        fs.mkdirSync(this.rootPath, { recursive: true, mode: DIRECTORY_MODE })
      }
      const stat = fs.lstatSync(this.rootPath)
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail('EVAL_STORE_ROOT_UNSAFE')
      fs.chmodSync(this.rootPath, DIRECTORY_MODE)
      return fs.realpathSync(this.rootPath)
    } catch (error) {
      if (String(error?.code || '').startsWith('EVAL_STORE_')) throw error
      throw evalStoreError('EVAL_STORE_UNAVAILABLE', error)
    }
  }

  assertRoot() {
    try {
      const stat = fs.lstatSync(this.rootPath)
      if (stat.isSymbolicLink() || !stat.isDirectory()
          || fs.realpathSync(this.rootPath) !== this.rootRealPath
          || (process.platform !== 'win32' && (stat.mode & 0o777) !== DIRECTORY_MODE)) {
        fail('EVAL_STORE_ROOT_UNSAFE')
      }
    } catch (error) {
      if (error?.code === 'EVAL_STORE_ROOT_UNSAFE') throw error
      throw evalStoreError('EVAL_STORE_ROOT_UNSAFE')
    }
  }

  ensureRecordDirectory(spec, id, create) {
    this.assertRoot()
    const digest = id.slice(id.lastIndexOf('-') + 1)
    let current = this.rootPath
    for (const segment of [spec.category, digest.slice(0, 2)]) {
      current = path.join(current, segment)
      let stat
      try { stat = fs.lstatSync(current) } catch (error) {
        if (error.code !== 'ENOENT') throw error
        if (!create) throw evalStoreError(spec.missingError)
        try { fs.mkdirSync(current, { mode: DIRECTORY_MODE }) } catch (mkdirError) {
          if (mkdirError.code !== 'EEXIST') throw mkdirError
        }
        stat = fs.lstatSync(current)
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()
          || (process.platform !== 'win32' && (stat.mode & 0o777) !== DIRECTORY_MODE)
          || !isInside(this.rootRealPath, fs.realpathSync(current))) {
        fail('EVAL_STORE_ROOT_UNSAFE')
      }
    }
    return current
  }
}

module.exports = { EvalStore }
