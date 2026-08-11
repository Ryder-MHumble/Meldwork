const crypto = require('node:crypto')
const { z } = require('zod')

const { MAX_CONTENT_BLOB_BYTES } = require('../attachments/content-blob-store.cjs')
const { redactSecrets } = require('../security/secret-redaction.cjs')

const ARTIFACT_VERSION = 1
const EVIDENCE_VERSION = 1
const REVIEWER_FINDING_VERSION = 1
const ADOPTION_VERSION = 1
const ADOPTION_ACTION_STATUSES = Object.freeze([
  'exported',
  'applied',
  'committed',
  'sent',
])
const ADOPTION_STATUSES = Object.freeze([
  ...ADOPTION_ACTION_STATUSES,
  'accepted',
  'rejected',
  'reopened',
])
const MAX_OUTCOME_RECORD_BYTES = 512 * 1024
const MAX_REFS = 64
const MAX_NAME_CHARS = 240
const MAX_SUMMARY_CHARS = 4000
const MAX_LOCATION_CHARS = 2048

const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const SHA256 = /^[a-f0-9]{64}$/
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/
const ARTIFACT_ID = /^artifact-[a-f0-9]{64}$/
const EVIDENCE_ID = /^evidence-[a-f0-9]{64}$/
const REVIEWER_FINDING_ID = /^reviewer-finding-[a-f0-9]{64}$/
const ADOPTION_ID = /^adoption-[a-f0-9]{64}$/

function outcomeRecordError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function fail(code) {
  throw outcomeRecordError(code)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function canonicalValue(value, seen) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('CANONICAL_JSON_INVALID')
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (typeof value !== 'object') fail('CANONICAL_JSON_INVALID')
  if (seen.has(value)) fail('CANONICAL_JSON_INVALID')
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return `[${value.map(item => canonicalValue(item, seen)).join(',')}]`
    }
    if (!isPlainObject(value)) fail('CANONICAL_JSON_INVALID')
    const ownKeys = Reflect.ownKeys(value)
    if (!ownKeys.every(key => typeof key === 'string')) fail('CANONICAL_JSON_INVALID')
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (ownKeys.some(key => !descriptors[key].enumerable
        || typeof descriptors[key].get === 'function'
        || typeof descriptors[key].set === 'function')) {
      fail('CANONICAL_JSON_INVALID')
    }
    return `{${ownKeys.sort().map(key => (
      `${JSON.stringify(key)}:${canonicalValue(value[key], seen)}`
    )).join(',')}}`
  } finally {
    seen.delete(value)
  }
}

function canonicalJson(value) {
  return canonicalValue(value, new Set())
}

function uniqueArray(schema, max, message) {
  return z.array(schema).max(max).superRefine((values, context) => {
    const unique = new Set(values.map(value => canonicalJson(value)))
    if (unique.size !== values.length) context.addIssue({ code: 'custom', message })
  })
}

const publicIdSchema = z.string().min(1).max(120).regex(PUBLIC_ID)
const hashSchema = z.string().length(64).regex(SHA256)
const artifactIdSchema = z.string().regex(ARTIFACT_ID)
const evidenceIdSchema = z.string().regex(EVIDENCE_ID)
const reviewerFindingIdSchema = z.string().regex(REVIEWER_FINDING_ID)
const adoptionIdSchema = z.string().regex(ADOPTION_ID)
const nameSchema = z.string().min(1).max(MAX_NAME_CHARS)
const summarySchema = z.string().min(1).max(MAX_SUMMARY_CHARS)

const blobRefSchema = z.strictObject({
  algorithm: z.literal('sha256'),
  hash: hashSchema,
  size: z.number().int().nonnegative().max(MAX_CONTENT_BLOB_BYTES),
  mediaType: z.string().min(3).max(127).regex(MEDIA_TYPE).optional(),
})

function isSafeWorkspacePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024
      || value.includes('\0') || value.includes('\\') || value.startsWith('/')
      || /^[A-Za-z]:/.test(value)) return false
  const segments = value.split('/')
  return segments.every(segment => segment && segment !== '.' && segment !== '..')
}

function isSafeUri(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_LOCATION_CHARS) return false
  try {
    const parsed = new URL(value)
    return ['http:', 'https:'].includes(parsed.protocol)
      && !parsed.username && !parsed.password && parsed.toString() === value
  } catch {
    return false
  }
}

const locationRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('workspace-relative'),
    path: z.string().superRefine((value, context) => {
      if (!isSafeWorkspacePath(value)) {
        context.addIssue({ code: 'custom', message: 'unsafe workspace path' })
      }
    }),
  }),
  z.strictObject({
    kind: z.literal('uri'),
    uri: z.string().superRefine((value, context) => {
      if (!isSafeUri(value)) context.addIssue({ code: 'custom', message: 'unsafe URI' })
    }),
  }),
])

const producerSchema = z.strictObject({
  runId: publicIdSchema,
  agentRunId: publicIdSchema,
  agentKind: publicIdSchema,
})

const actorSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('agent'),
    runId: publicIdSchema,
    agentRunId: publicIdSchema,
    agentKind: publicIdSchema,
  }),
  z.strictObject({
    kind: z.literal('human'),
    actorId: publicIdSchema,
  }),
  z.strictObject({
    kind: z.literal('system'),
    actorId: publicIdSchema,
  }),
])

const artifactContentFields = {
  type: z.enum([
    'file',
    'diff',
    'document',
    'structured-data',
    'media',
    'link',
    'bundle',
  ]),
  name: nameSchema,
  producedBy: producerSchema,
  contentRef: blobRefSchema.optional(),
  contentHash: hashSchema.optional(),
  locationRef: locationRefSchema.optional(),
}

function validateArtifactRelations(artifact, context) {
  if (!artifact.contentRef && !artifact.locationRef) {
    context.addIssue({ code: 'custom', message: 'artifact reference required' })
  }
  if (artifact.contentRef && artifact.contentHash !== artifact.contentRef.hash) {
    context.addIssue({
      code: 'custom',
      path: ['contentHash'],
      message: 'content hash mismatch',
    })
  }
  if (!artifact.contentRef && artifact.contentHash && !artifact.locationRef) {
    context.addIssue({ code: 'custom', path: ['contentHash'], message: 'orphan content hash' })
  }
  if (artifact.type !== 'link' && !artifact.contentHash) {
    context.addIssue({
      code: 'custom',
      path: ['contentHash'],
      message: 'content hash required',
    })
  }
  if (artifact.type === 'link' && artifact.locationRef?.kind !== 'uri') {
    context.addIssue({
      code: 'custom',
      path: ['locationRef'],
      message: 'link URI required',
    })
  }
  if (['diff', 'document', 'structured-data', 'media', 'bundle'].includes(artifact.type)
      && !artifact.contentRef) {
    context.addIssue({
      code: 'custom',
      path: ['contentRef'],
      message: 'durable content snapshot required',
    })
  }
}

const artifactInputSchema = z.strictObject(artifactContentFields)
  .superRefine(validateArtifactRelations)
const artifactRecordSchema = z.strictObject({
  artifactId: artifactIdSchema,
  version: z.literal(ARTIFACT_VERSION),
  recordType: z.literal('artifact'),
  ...artifactContentFields,
}).superRefine(validateArtifactRelations)

const subjectSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('artifact'), artifactId: artifactIdSchema }),
  z.strictObject({ type: z.literal('run'), runId: publicIdSchema }),
  z.strictObject({
    type: z.literal('agent-run'),
    runId: publicIdSchema,
    agentRunId: publicIdSchema,
  }),
])

const evidenceRefSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('artifact'), artifactId: artifactIdSchema }),
  z.strictObject({ type: z.literal('evidence'), evidenceId: evidenceIdSchema }),
  z.strictObject({
    type: z.literal('reviewer-finding'),
    reviewerFindingId: reviewerFindingIdSchema,
  }),
  z.strictObject({
    type: z.literal('blob'),
    contentRef: blobRefSchema,
    contentHash: hashSchema,
  }).superRefine((reference, context) => {
    if (reference.contentHash !== reference.contentRef.hash) {
      context.addIssue({ code: 'custom', path: ['contentHash'], message: 'hash mismatch' })
    }
  }),
  z.strictObject({
    type: z.literal('location'),
    locationRef: locationRefSchema,
    contentHash: hashSchema.optional(),
  }),
])

const evidenceContentFields = {
  kind: z.enum([
    'declaration',
    'source-snapshot',
    'observation',
    'test-result',
    'file-hash',
    'review',
    'human-decision',
    'other',
  ]),
  level: z.enum(['declared', 'observed', 'reproduced', 'human-accepted']),
  subject: subjectSchema,
  summary: summarySchema,
  recordedBy: actorSchema,
  refs: uniqueArray(evidenceRefSchema, MAX_REFS, 'duplicate evidence reference'),
}

function validateEvidenceRelations(evidence, context) {
  const concreteRef = evidence.refs.some(reference => (
    reference.type === 'evidence'
    || reference.type === 'blob'
    || (reference.type === 'location' && Boolean(reference.contentHash))
  ))
  if (['reproduced', 'human-accepted'].includes(evidence.level) && !concreteRef) {
    context.addIssue({
      code: 'custom',
      path: ['refs'],
      message: 'prior Evidence or immutable content reference required',
    })
  }
  if (evidence.level === 'human-accepted' && evidence.recordedBy.kind !== 'human') {
    context.addIssue({
      code: 'custom',
      path: ['recordedBy'],
      message: 'human acceptance requires a human actor',
    })
  }
}

const evidenceInputSchema = z.strictObject(evidenceContentFields)
  .superRefine(validateEvidenceRelations)
const evidenceRecordSchema = z.strictObject({
  evidenceId: evidenceIdSchema,
  version: z.literal(EVIDENCE_VERSION),
  recordType: z.literal('evidence'),
  ...evidenceContentFields,
}).superRefine(validateEvidenceRelations)

const reviewerFindingContentFields = {
  artifactId: artifactIdSchema,
  relation: z.enum(['support', 'contradict']),
  summary: summarySchema,
  reviewer: actorSchema,
  evidenceIds: uniqueArray(evidenceIdSchema, MAX_REFS, 'duplicate Evidence ID'),
}

const reviewerFindingInputSchema = z.strictObject(reviewerFindingContentFields)
const reviewerFindingRecordSchema = z.strictObject({
  reviewerFindingId: reviewerFindingIdSchema,
  version: z.literal(REVIEWER_FINDING_VERSION),
  recordType: z.literal('reviewer-finding'),
  ...reviewerFindingContentFields,
})

const adoptionContentFields = {
  artifactId: artifactIdSchema,
  status: z.enum(ADOPTION_STATUSES),
  actor: actorSchema,
  summary: summarySchema.optional(),
  evidenceIds: uniqueArray(evidenceIdSchema, MAX_REFS, 'duplicate Evidence ID'),
  findingIds: uniqueArray(reviewerFindingIdSchema, MAX_REFS, 'duplicate Finding ID'),
  destinationRef: locationRefSchema.optional(),
  previousAdoptionId: adoptionIdSchema.nullable(),
}

const adoptionInputSchema = z.strictObject(adoptionContentFields)
const adoptionRecordSchema = z.strictObject({
  adoptionId: adoptionIdSchema,
  version: z.literal(ADOPTION_VERSION),
  recordType: z.literal('adoption'),
  ...adoptionContentFields,
})

function forbiddenField(key) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  return normalized.includes('credential')
    || normalized.includes('password')
    || normalized.includes('apikey')
    || normalized.includes('accesskey')
    || normalized.includes('token')
    || normalized.includes('secret')
    || normalized.includes('authorization')
    || normalized.includes('privatekey')
    || normalized.includes('executable')
    || normalized.includes('command')
    || normalized.includes('reasoning')
    || normalized.includes('chainofthought')
    || normalized.includes('tooloutput')
    || normalized.includes('rawoutput')
    || normalized === 'stdout'
    || normalized === 'stderr'
    || normalized === 'argv'
    || normalized === 'shell'
    || normalized === 'environment'
    || normalized === 'env'
    || normalized === 'cot'
    || normalized === 'thought'
    || normalized === 'thoughts'
}

function assertNoForbiddenContent(value, prefix, seen = new Set()) {
  if (typeof value === 'string') {
    if (redactSecrets(value) !== value) fail(`${prefix}_FORBIDDEN_VALUE`)
    return
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') fail(`${prefix}_SCHEMA_INVALID`)
      if (forbiddenField(key)) fail(`${prefix}_FORBIDDEN_FIELD`)
      assertNoForbiddenContent(value[key], prefix, seen)
    }
  } finally {
    seen.delete(value)
  }
}

function parseInput(value, prefix) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array || typeof value === 'string') {
    const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value)
    if (!bytes.length || bytes.length > MAX_OUTCOME_RECORD_BYTES) {
      fail(`${prefix}_JSON_INVALID`)
    }
    let parsed
    try { parsed = JSON.parse(bytes.toString('utf8')) } catch { fail(`${prefix}_JSON_INVALID`) }
    return { parsed, serialized: bytes.toString('utf8') }
  }
  return { parsed: value, serialized: null }
}

function validated(schema, value, prefix) {
  const result = schema.safeParse(value)
  if (!result.success) fail(`${prefix}_SCHEMA_INVALID`)
  return result.data
}

function deriveId(prefix, body) {
  const hash = crypto.createHash('sha256').update(canonicalJson(body)).digest('hex')
  return `${prefix}-${hash}`
}

function canonicalRecord(record, prefix) {
  const serialized = canonicalJson(record)
  if (Buffer.byteLength(serialized) > MAX_OUTCOME_RECORD_BYTES) {
    fail(`${prefix}_SCHEMA_INVALID`)
  }
  return serialized
}

function createRecord(input, options) {
  assertNoForbiddenContent(input, options.errorPrefix)
  const content = validated(options.inputSchema, input, options.errorPrefix)
  const body = {
    version: options.version,
    recordType: options.recordType,
    ...content,
  }
  const record = {
    [options.idKey]: deriveId(options.idPrefix, body),
    ...body,
  }
  options.validateRecord?.(record)
  canonicalRecord(record, options.errorPrefix)
  return JSON.parse(canonicalJson(record))
}

function parseRecord(input, options) {
  const { parsed, serialized } = parseInput(input, options.errorPrefix)
  assertNoForbiddenContent(parsed, options.errorPrefix)
  const record = validated(options.recordSchema, parsed, options.errorPrefix)
  const { [options.idKey]: id, ...body } = record
  if (deriveId(options.idPrefix, body) !== id) fail(`${options.errorPrefix}_ID_MISMATCH`)
  options.validateRecord?.(record)
  const canonical = canonicalRecord(record, options.errorPrefix)
  if (serialized !== null && serialized !== canonical) {
    fail(`${options.errorPrefix}_JSON_NOT_CANONICAL`)
  }
  return JSON.parse(canonical)
}

const artifactOptions = {
  errorPrefix: 'ARTIFACT',
  inputSchema: artifactInputSchema,
  recordSchema: artifactRecordSchema,
  version: ARTIFACT_VERSION,
  recordType: 'artifact',
  idKey: 'artifactId',
  idPrefix: 'artifact',
}

const evidenceOptions = {
  errorPrefix: 'EVIDENCE',
  inputSchema: evidenceInputSchema,
  recordSchema: evidenceRecordSchema,
  version: EVIDENCE_VERSION,
  recordType: 'evidence',
  idKey: 'evidenceId',
  idPrefix: 'evidence',
  validateRecord(record) {
    if (record.refs.some(ref => ref.type === 'evidence' && ref.evidenceId === record.evidenceId)) {
      fail('EVIDENCE_SCHEMA_INVALID')
    }
  },
}

const reviewerFindingOptions = {
  errorPrefix: 'REVIEWER_FINDING',
  inputSchema: reviewerFindingInputSchema,
  recordSchema: reviewerFindingRecordSchema,
  version: REVIEWER_FINDING_VERSION,
  recordType: 'reviewer-finding',
  idKey: 'reviewerFindingId',
  idPrefix: 'reviewer-finding',
}

const adoptionOptions = {
  errorPrefix: 'ADOPTION',
  inputSchema: adoptionInputSchema,
  recordSchema: adoptionRecordSchema,
  version: ADOPTION_VERSION,
  recordType: 'adoption',
  idKey: 'adoptionId',
  idPrefix: 'adoption',
  validateRecord(record) {
    if (record.previousAdoptionId === record.adoptionId) fail('ADOPTION_SCHEMA_INVALID')
  },
}

function createArtifactRecord(input) {
  return createRecord(input, artifactOptions)
}

function parseArtifactRecord(input) {
  return parseRecord(input, artifactOptions)
}

function createEvidenceRecord(input) {
  return createRecord(input, evidenceOptions)
}

function parseEvidenceRecord(input) {
  return parseRecord(input, evidenceOptions)
}

function createReviewerFindingRecord(input) {
  return createRecord(input, reviewerFindingOptions)
}

function parseReviewerFindingRecord(input) {
  return parseRecord(input, reviewerFindingOptions)
}

function createAdoptionRecord(input) {
  return createRecord(input, adoptionOptions)
}

function parseAdoptionRecord(input) {
  return parseRecord(input, adoptionOptions)
}

function serializeArtifactRecord(input) {
  return canonicalJson(parseArtifactRecord(input))
}

function serializeEvidenceRecord(input) {
  return canonicalJson(parseEvidenceRecord(input))
}

function serializeReviewerFindingRecord(input) {
  return canonicalJson(parseReviewerFindingRecord(input))
}

function serializeAdoptionRecord(input) {
  return canonicalJson(parseAdoptionRecord(input))
}

module.exports = {
  ADOPTION_ACTION_STATUSES,
  ADOPTION_STATUSES,
  ADOPTION_VERSION,
  ARTIFACT_VERSION,
  EVIDENCE_VERSION,
  MAX_OUTCOME_RECORD_BYTES,
  REVIEWER_FINDING_VERSION,
  canonicalJson,
  createAdoptionRecord,
  createArtifactRecord,
  createEvidenceRecord,
  createReviewerFindingRecord,
  parseAdoptionRecord,
  parseArtifactRecord,
  parseEvidenceRecord,
  parseReviewerFindingRecord,
  serializeAdoptionRecord,
  serializeArtifactRecord,
  serializeEvidenceRecord,
  serializeReviewerFindingRecord,
}
