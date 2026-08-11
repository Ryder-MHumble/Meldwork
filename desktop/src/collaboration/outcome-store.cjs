const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { ContentBlobStore } = require('../attachments/content-blob-store.cjs')
const {
  ADOPTION_ACTION_STATUSES,
  MAX_OUTCOME_RECORD_BYTES,
  canonicalJson,
  createAdoptionRecord,
  createArtifactRecord,
  createEvidenceRecord,
  createReviewerFindingRecord,
  parseAdoptionRecord,
  parseArtifactRecord,
  parseEvidenceRecord,
  parseReviewerFindingRecord,
} = require('./outcome-records.cjs')

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const ARTIFACT_ID = /^artifact-[a-f0-9]{64}$/
const EVIDENCE_ID = /^evidence-[a-f0-9]{64}$/
const REVIEWER_FINDING_ID = /^reviewer-finding-[a-f0-9]{64}$/
const ADOPTION_ID = /^adoption-[a-f0-9]{64}$/
const HUMAN_ADOPTION_KEYS = new Set([
  'artifactId',
  'destinationRef',
  'evidenceIds',
  'findingIds',
  'previousAdoptionId',
  'status',
  'summary',
])
const ADOPTION_STATUS_SET = new Set(ADOPTION_ACTION_STATUSES)
const LOCAL_HUMAN_ACTOR = Object.freeze({ kind: 'human', actorId: 'local-user' })

function outcomeStoreError(code, cause) {
  const error = new Error(code)
  error.code = code
  if (cause) error.cause = cause
  return error
}

function fail(code) {
  throw outcomeStoreError(code)
}

function isKnownError(error) {
  return /^(?:ARTIFACT|EVIDENCE|REVIEWER_FINDING|ADOPTION|CANONICAL_JSON|OUTCOME_STORE)_[A-Z0-9_]+$/
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

const SPECS = {
  artifact: {
    category: 'artifacts',
    idKey: 'artifactId',
    idPattern: ARTIFACT_ID,
    idError: 'ARTIFACT_ID_INVALID',
    missingError: 'ARTIFACT_NOT_FOUND',
    tamperedError: 'ARTIFACT_TAMPERED',
    create: createArtifactRecord,
    parse: parseArtifactRecord,
  },
  evidence: {
    category: 'evidence',
    idKey: 'evidenceId',
    idPattern: EVIDENCE_ID,
    idError: 'EVIDENCE_ID_INVALID',
    missingError: 'EVIDENCE_NOT_FOUND',
    tamperedError: 'EVIDENCE_TAMPERED',
    create: createEvidenceRecord,
    parse: parseEvidenceRecord,
  },
  reviewerFinding: {
    category: 'reviewer-findings',
    idKey: 'reviewerFindingId',
    idPattern: REVIEWER_FINDING_ID,
    idError: 'REVIEWER_FINDING_ID_INVALID',
    missingError: 'REVIEWER_FINDING_NOT_FOUND',
    tamperedError: 'REVIEWER_FINDING_TAMPERED',
    create: createReviewerFindingRecord,
    parse: parseReviewerFindingRecord,
  },
  adoption: {
    category: 'adoptions',
    idKey: 'adoptionId',
    idPattern: ADOPTION_ID,
    idError: 'ADOPTION_ID_INVALID',
    missingError: 'ADOPTION_NOT_FOUND',
    tamperedError: 'ADOPTION_TAMPERED',
    create: createAdoptionRecord,
    parse: parseAdoptionRecord,
  },
}

function normalizeId(value, spec) {
  if (typeof value !== 'string' || !spec.idPattern.test(value)) fail(spec.idError)
  return value
}

function shouldParseRecord(input, idKey) {
  return typeof input === 'string' || Buffer.isBuffer(input) || input instanceof Uint8Array
    || (input && typeof input === 'object' && Object.hasOwn(input, idKey))
}

function humanAdoptionInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Reflect.ownKeys(input).some(key => (
        typeof key !== 'string' || !HUMAN_ADOPTION_KEYS.has(key)
      ))
      || !Object.hasOwn(input, 'artifactId')
      || !Object.hasOwn(input, 'status')
      || !Object.hasOwn(input, 'destinationRef')
      || !ADOPTION_STATUS_SET.has(input.status)) {
    fail('ADOPTION_REQUEST_INVALID')
  }
  return {
    artifactId: input.artifactId,
    status: input.status,
    actor: LOCAL_HUMAN_ACTOR,
    ...(Object.hasOwn(input, 'summary') ? { summary: input.summary } : {}),
    evidenceIds: Object.hasOwn(input, 'evidenceIds') ? input.evidenceIds : [],
    findingIds: Object.hasOwn(input, 'findingIds') ? input.findingIds : [],
    ...(Object.hasOwn(input, 'destinationRef')
      ? { destinationRef: input.destinationRef }
      : {}),
    previousAdoptionId: Object.hasOwn(input, 'previousAdoptionId')
      ? input.previousAdoptionId
      : null,
  }
}

class OutcomeStore {
  constructor({ rootPath, contentBlobStore } = {}) {
    if (typeof rootPath !== 'string' || !rootPath || rootPath.length > 4096) {
      fail('OUTCOME_STORE_ROOT_REQUIRED')
    }
    if (!(contentBlobStore instanceof ContentBlobStore)) {
      fail('OUTCOME_STORE_CONTENT_BLOB_STORE_REQUIRED')
    }
    this.rootPath = path.resolve(rootPath)
    if (this.rootPath === path.parse(this.rootPath).root) fail('OUTCOME_STORE_ROOT_UNSAFE')
    this.contentBlobStore = contentBlobStore
    this.rootRealPath = this.prepareRoot()
  }

  putArtifact(input) {
    return this.putRecord(SPECS.artifact, input)
  }

  getArtifact(value) {
    return this.getRecord(SPECS.artifact, value)
  }

  putEvidence(input) {
    return this.putRecord(SPECS.evidence, input)
  }

  getEvidence(value) {
    return this.getRecord(SPECS.evidence, value)
  }

  putReviewerFinding(input) {
    return this.putRecord(SPECS.reviewerFinding, input)
  }

  getReviewerFinding(value) {
    return this.getRecord(SPECS.reviewerFinding, value)
  }

  putAdoption(input) {
    return this.putRecord(SPECS.adoption, input)
  }

  recordHumanAdoption(input) {
    return this.putAdoption(humanAdoptionInput(input))
  }

  getAdoption(value) {
    return this.getRecord(SPECS.adoption, value)
  }

  putRecord(spec, input) {
    const record = shouldParseRecord(input, spec.idKey) ? spec.parse(input) : spec.create(input)
    this.validateReferences(spec, record)
    const serialized = canonicalJson(record)
    const bytes = Buffer.from(serialized, 'utf8')
    const directory = this.ensureRecordDirectory(spec, record[spec.idKey], true)
    const filename = path.join(directory, `${record[spec.idKey]}.json`)
    try {
      writeExclusiveAtomic(filename, bytes)
      const stored = this.getRecord(spec, record[spec.idKey])
      if (canonicalJson(stored) !== serialized) fail(spec.tamperedError)
      return stored
    } catch (error) {
      if (isKnownError(error)) throw error
      throw outcomeStoreError('OUTCOME_STORE_UNAVAILABLE', error)
    }
  }

  getRecord(spec, value) {
    const id = normalizeId(value, spec)
    const directory = this.ensureRecordDirectory(spec, id, false)
    const filename = path.join(directory, `${id}.json`)
    let descriptor
    let record
    try {
      const fileStat = fs.lstatSync(filename)
      if (fileStat.isSymbolicLink() || !fileStat.isFile()
          || fileStat.size <= 0 || fileStat.size > MAX_OUTCOME_RECORD_BYTES
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
      const bytes = readExactFile(descriptor, openedStat.size)
      try { record = spec.parse(bytes) } catch { fail(spec.tamperedError) }
      if (record[spec.idKey] !== id) fail(spec.tamperedError)
    } catch (error) {
      if (error?.message === spec.tamperedError) throw error
      if (error.code === 'ENOENT' || error?.message === spec.missingError) {
        throw outcomeStoreError(spec.missingError)
      }
      if (isKnownError(error)) throw error
      throw outcomeStoreError(spec.tamperedError)
    } finally {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor) } catch { /* already closed */ }
      }
    }
    this.validateReferences(spec, record)
    return record
  }

  assertBlob(ref, prefix) {
    try {
      if (!this.contentBlobStore.has(ref)) fail(`${prefix}_CONTENT_NOT_FOUND`)
    } catch (error) {
      if (isKnownError(error)) throw error
      throw outcomeStoreError(`${prefix}_CONTENT_UNAVAILABLE`, error)
    }
  }

  validateReferences(spec, record) {
    if (spec === SPECS.artifact) {
      if (record.contentRef) this.assertBlob(record.contentRef, 'ARTIFACT')
      return
    }
    if (spec === SPECS.evidence) {
      if (record.subject.type === 'artifact') this.getArtifact(record.subject.artifactId)
      for (const reference of record.refs) {
        if (reference.type === 'artifact') this.getArtifact(reference.artifactId)
        else if (reference.type === 'evidence') this.getEvidence(reference.evidenceId)
        else if (reference.type === 'reviewer-finding') {
          this.getReviewerFinding(reference.reviewerFindingId)
        } else if (reference.type === 'blob') this.assertBlob(reference.contentRef, 'EVIDENCE')
      }
      return
    }
    if (spec === SPECS.reviewerFinding) {
      this.getArtifact(record.artifactId)
      for (const evidenceId of record.evidenceIds) this.getEvidence(evidenceId)
      return
    }
    this.getArtifact(record.artifactId)
    for (const evidenceId of record.evidenceIds) this.getEvidence(evidenceId)
    for (const findingId of record.findingIds) this.getReviewerFinding(findingId)
    if (record.previousAdoptionId) {
      const previous = this.getAdoption(record.previousAdoptionId)
      if (previous.artifactId !== record.artifactId) fail('ADOPTION_REFERENCE_INVALID')
    }
  }

  prepareRoot() {
    try {
      try {
        const existing = fs.lstatSync(this.rootPath)
        if (existing.isSymbolicLink() || !existing.isDirectory()) {
          fail('OUTCOME_STORE_ROOT_UNSAFE')
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        fs.mkdirSync(this.rootPath, { recursive: true, mode: DIRECTORY_MODE })
      }
      const stat = fs.lstatSync(this.rootPath)
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail('OUTCOME_STORE_ROOT_UNSAFE')
      fs.chmodSync(this.rootPath, DIRECTORY_MODE)
      return fs.realpathSync(this.rootPath)
    } catch (error) {
      if (isKnownError(error)) throw error
      throw outcomeStoreError('OUTCOME_STORE_UNAVAILABLE', error)
    }
  }

  assertRoot() {
    try {
      const stat = fs.lstatSync(this.rootPath)
      if (stat.isSymbolicLink() || !stat.isDirectory()
          || fs.realpathSync(this.rootPath) !== this.rootRealPath
          || (process.platform !== 'win32' && (stat.mode & 0o777) !== DIRECTORY_MODE)) {
        fail('OUTCOME_STORE_ROOT_UNSAFE')
      }
    } catch (error) {
      if (isKnownError(error)) throw error
      throw outcomeStoreError('OUTCOME_STORE_ROOT_UNSAFE')
    }
  }

  ensureRecordDirectory(spec, id, create) {
    this.assertRoot()
    const hash = id.slice(id.lastIndexOf('-') + 1)
    let current = this.rootPath
    for (const segment of [spec.category, hash.slice(0, 2)]) {
      current = path.join(current, segment)
      try {
        let stat
        try {
          stat = fs.lstatSync(current)
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
          if (!create) fail(spec.missingError)
          try {
            fs.mkdirSync(current, { mode: DIRECTORY_MODE })
          } catch (mkdirError) {
            if (mkdirError.code !== 'EEXIST') throw mkdirError
          }
          stat = fs.lstatSync(current)
        }
        if (stat.isSymbolicLink() || !stat.isDirectory()
            || (process.platform !== 'win32' && (stat.mode & 0o777) !== DIRECTORY_MODE)) {
          fail('OUTCOME_STORE_ROOT_UNSAFE')
        }
        const realPath = fs.realpathSync(current)
        if (!isInside(this.rootRealPath, realPath)) fail('OUTCOME_STORE_ROOT_UNSAFE')
      } catch (error) {
        if (isKnownError(error)) throw error
        throw outcomeStoreError('OUTCOME_STORE_ROOT_UNSAFE')
      }
    }
    return current
  }
}

module.exports = { OutcomeStore }
