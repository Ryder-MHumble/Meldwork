const crypto = require('node:crypto')
const { z } = require('zod')

const {
  MAX_CONTENT_BLOB_BYTES,
  normalizeContentBlobRef,
} = require('./content-blob-store.cjs')
const { canonicalJson } = require('./outcome-records.cjs')
const { redactSecrets } = require('./secret-redaction.cjs')

const KNOWLEDGE_CONNECTOR_CONTRACT_VERSION = 1
const KNOWLEDGE_RECORD_VERSION = 1
const MAX_KNOWLEDGE_CONTENT_BYTES = 1024 * 1024
const MAX_KNOWLEDGE_RESULTS = 50
const MAX_QUERY_CHARS = 240
const MAX_SNIPPET_CHARS = 1000

const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const CREDENTIAL_REF = /^credential-ref:[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const SOURCE_ID = /^knowledge-source-[a-f0-9]{64}$/
const SNAPSHOT_ID = /^knowledge-snapshot-[a-f0-9]{64}$/
const CITATION_ID = /^knowledge-citation-[a-f0-9]{64}$/
const SHA256 = /^[a-f0-9]{64}$/
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/

function contractError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function fail(code) {
  throw contractError(code)
}

function safePublicTextSchema(max) {
  return z.string().min(1).max(max).superRefine((value, context) => {
    if (/[\u0000-\u001f\u007f]/.test(value) || redactSecrets(value) !== value) {
      context.addIssue({ code: 'custom', message: 'unsafe public Connector text' })
    }
  })
}

const publicIdSchema = z.string().min(1).max(120).regex(PUBLIC_ID)
const safeLabelSchema = safePublicTextSchema(240)
const scopeSchema = z.strictObject({
  scopeId: publicIdSchema,
  kind: z.enum(['filesystem', 'memory', 'remote']),
})
const egressLimitSchema = z.strictObject({
  maxResults: z.number().int().min(1).max(MAX_KNOWLEDGE_RESULTS),
  maxContentBytes: z.number().int().min(1).max(MAX_KNOWLEDGE_CONTENT_BYTES),
})
const instanceInputSchema = z.strictObject({
  instanceId: publicIdSchema,
  connectorId: publicIdSchema,
  accountId: publicIdSchema,
  label: safeLabelSchema,
  scope: scopeSchema,
  accessMode: z.enum(['read-only', 'read-write']),
  snapshotCapability: z.enum(['immutable', 'live-reference', 'none']),
  egressLimit: egressLimitSchema,
  credentialLifecycle: z.enum(['none', 'session', 'persistent']),
  credentialRef: z.string().regex(CREDENTIAL_REF).nullable().superRefine((value, context) => {
    const opaqueId = value ? value.slice('credential-ref:'.length) : ''
    if (opaqueId && redactSecrets(opaqueId) !== opaqueId) {
      context.addIssue({ code: 'custom', message: 'secret value is not a CredentialRef' })
    }
  }),
}).superRefine((instance, context) => {
  if ((instance.credentialLifecycle === 'none') !== (instance.credentialRef === null)) {
    context.addIssue({ code: 'custom', path: ['credentialRef'], message: 'credential lifecycle mismatch' })
  }
})

const publicInstanceSchema = z.strictObject({
  contractVersion: z.literal(KNOWLEDGE_CONNECTOR_CONTRACT_VERSION),
  instanceId: publicIdSchema,
  connectorId: publicIdSchema,
  accountId: publicIdSchema,
  label: safeLabelSchema,
  scope: scopeSchema,
  accessMode: z.enum(['read-only', 'read-write']),
  snapshotCapability: z.enum(['immutable', 'live-reference', 'none']),
  egressLimit: egressLimitSchema,
  credentialLifecycle: z.enum(['none', 'session', 'persistent']),
  credentialConfigured: z.boolean(),
  authorized: z.boolean(),
})

const probeResultSchema = z.strictObject({
  status: z.enum(['ready', 'unavailable']),
  instance: publicInstanceSchema,
})

const sourceDescriptorSchema = z.strictObject({
  sourceId: z.string().regex(SOURCE_ID),
  connectorId: publicIdSchema,
  scopeId: publicIdSchema,
  locator: z.string().min(1).max(2048),
  title: safeLabelSchema,
  mediaType: z.string().min(3).max(127).regex(MEDIA_TYPE),
  contentHash: z.string().regex(SHA256),
  size: z.number().int().nonnegative().max(MAX_KNOWLEDGE_CONTENT_BYTES),
  snippet: z.string().max(MAX_SNIPPET_CHARS),
}).superRefine((source, context) => {
  if (!isSafeKnowledgeLocator(source.locator)
      || stableKnowledgeSourceId(source.connectorId, source.scopeId, source.locator)
        !== source.sourceId) {
    context.addIssue({ code: 'custom', path: ['sourceId'], message: 'unstable source identity' })
  }
})

const blobRefSchema = z.strictObject({
  algorithm: z.literal('sha256'),
  hash: z.string().regex(SHA256),
  size: z.number().int().nonnegative().max(MAX_CONTENT_BLOB_BYTES),
  mediaType: z.string().min(3).max(127).regex(MEDIA_TYPE).optional(),
})

const snapshotContentFields = {
  connectorId: publicIdSchema,
  instanceId: publicIdSchema,
  scopeId: publicIdSchema,
  sourceId: z.string().regex(SOURCE_ID),
  locator: z.string().min(1).max(2048),
  title: safeLabelSchema,
  contentRef: blobRefSchema,
  contentHash: z.string().regex(SHA256),
  mediaType: z.string().min(3).max(127).regex(MEDIA_TYPE),
}
const snapshotInputSchema = z.strictObject(snapshotContentFields).superRefine(validateSnapshot)
const snapshotRecordSchema = z.strictObject({
  snapshotId: z.string().regex(SNAPSHOT_ID),
  version: z.literal(KNOWLEDGE_RECORD_VERSION),
  recordType: z.literal('knowledge-snapshot'),
  ...snapshotContentFields,
}).superRefine(validateSnapshot)

const citationContentFields = {
  connectorId: publicIdSchema,
  instanceId: publicIdSchema,
  scopeId: publicIdSchema,
  sourceId: z.string().regex(SOURCE_ID),
  locator: z.string().min(1).max(2048),
  contentHash: z.string().regex(SHA256),
  snapshotId: z.string().regex(SNAPSHOT_ID).nullable(),
  contentRef: blobRefSchema.nullable(),
  verification: z.enum(['snapshot', 'live']),
}
const citationInputSchema = z.strictObject(citationContentFields).superRefine(validateCitation)
const citationRecordSchema = z.strictObject({
  citationId: z.string().regex(CITATION_ID),
  version: z.literal(KNOWLEDGE_RECORD_VERSION),
  recordType: z.literal('knowledge-citation'),
  ...citationContentFields,
}).superRefine(validateCitation)

function validateSnapshot(snapshot, context) {
  if (!isSafeKnowledgeLocator(snapshot.locator)
      || stableKnowledgeSourceId(snapshot.connectorId, snapshot.scopeId, snapshot.locator)
        !== snapshot.sourceId
      || snapshot.contentHash !== snapshot.contentRef.hash
      || (snapshot.contentRef.mediaType
        && snapshot.mediaType !== snapshot.contentRef.mediaType)) {
    context.addIssue({ code: 'custom', message: 'invalid snapshot relation' })
  }
}

function validateCitation(citation, context) {
  const stable = stableKnowledgeSourceId(
    citation.connectorId,
    citation.scopeId,
    citation.locator,
  ) === citation.sourceId
  const snapshotRelation = citation.verification === 'snapshot'
    && citation.snapshotId && citation.contentRef
    && citation.contentHash === citation.contentRef.hash
  const liveRelation = citation.verification === 'live'
    && citation.snapshotId === null && citation.contentRef === null
  if (!isSafeKnowledgeLocator(citation.locator) || !stable
      || (!snapshotRelation && !liveRelation)) {
    context.addIssue({ code: 'custom', message: 'invalid citation relation' })
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const item of Object.values(value)) deepFreeze(item)
  return value
}

function isSafeKnowledgeLocator(value) {
  if (typeof value !== 'string' || !value || value.length > 2048
      || value.includes('\0') || value.includes('\\') || value.startsWith('/')
      || /^[A-Za-z]:/.test(value)) return false
  const segments = value.split('/')
  return segments.every(segment => segment && segment !== '.' && segment !== '..'
    && !/[\u0000-\u001f\u007f]/.test(segment))
}

function normalizeKnowledgeConnectorInstance(input, expectedConnectorId = '') {
  const result = instanceInputSchema.safeParse(input)
  if (!result.success || (expectedConnectorId && result.data.connectorId !== expectedConnectorId)) {
    fail('KNOWLEDGE_CONNECTOR_INSTANCE_INVALID')
  }
  return JSON.parse(canonicalJson(result.data))
}

function publicKnowledgeConnectorInstance(input, authorized = true) {
  const instance = normalizeKnowledgeConnectorInstance(input)
  return deepFreeze(JSON.parse(canonicalJson({
    contractVersion: KNOWLEDGE_CONNECTOR_CONTRACT_VERSION,
    instanceId: instance.instanceId,
    connectorId: instance.connectorId,
    accountId: instance.accountId,
    label: instance.label,
    scope: instance.scope,
    accessMode: instance.accessMode,
    snapshotCapability: instance.snapshotCapability,
    egressLimit: instance.egressLimit,
    credentialLifecycle: instance.credentialLifecycle,
    credentialConfigured: Boolean(instance.credentialRef),
    authorized: Boolean(authorized),
  })))
}

function parsePublicKnowledgeConnectorInstance(input) {
  const result = publicInstanceSchema.safeParse(input)
  if (!result.success) fail('KNOWLEDGE_CONNECTOR_PUBLIC_INSTANCE_INVALID')
  return JSON.parse(canonicalJson(result.data))
}

function normalizeProbeResult(input, expectedInstance = null) {
  const result = probeResultSchema.safeParse(input)
  let expectedPublic = null
  if (expectedInstance) {
    try {
      expectedPublic = Object.hasOwn(expectedInstance, 'credentialRef')
        ? publicKnowledgeConnectorInstance(expectedInstance)
        : parsePublicKnowledgeConnectorInstance(expectedInstance)
    } catch {
      fail('KNOWLEDGE_PROBE_RESULT_INVALID')
    }
  }
  if (!result.success || (expectedPublic
      && canonicalJson(result.data.instance) !== canonicalJson(expectedPublic))) {
    fail('KNOWLEDGE_PROBE_RESULT_INVALID')
  }
  return JSON.parse(canonicalJson(result.data))
}

function stableKnowledgeSourceId(connectorId, scopeId, locator) {
  if (!PUBLIC_ID.test(String(connectorId || '')) || !PUBLIC_ID.test(String(scopeId || ''))
      || !isSafeKnowledgeLocator(locator)) fail('KNOWLEDGE_SOURCE_ID_INPUT_INVALID')
  const hash = crypto.createHash('sha256').update(canonicalJson({
    connectorId,
    locator,
    scopeId,
  })).digest('hex')
  return `knowledge-source-${hash}`
}

function normalizeSourceDescriptor(input) {
  const result = sourceDescriptorSchema.safeParse(input)
  if (!result.success) fail('KNOWLEDGE_SOURCE_DESCRIPTOR_INVALID')
  return JSON.parse(canonicalJson(result.data))
}

function normalizeSearchRequest(input, egressLimit) {
  if (!isPlainObject(input) || Object.keys(input).sort().join(',') !== 'limit,query'
      || typeof input.query !== 'string' || !egressLimit
      || !Number.isInteger(egressLimit.maxResults)) {
    fail('KNOWLEDGE_SEARCH_REQUEST_INVALID')
  }
  const query = input.query.trim()
  const limit = Number(input.limit)
  if (!query || query.length > MAX_QUERY_CHARS || /[\u0000-\u001f\u007f]/.test(query)
      || !Number.isInteger(limit) || limit < 1
      || limit > Math.min(MAX_KNOWLEDGE_RESULTS, egressLimit.maxResults)) {
    fail('KNOWLEDGE_SEARCH_REQUEST_INVALID')
  }
  return { query, limit }
}

function normalizeSourceRequest(input) {
  if (!isPlainObject(input) || Object.keys(input).sort().join(',') !== 'locator,sourceId'
      || typeof input.sourceId !== 'string' || !SOURCE_ID.test(input.sourceId)
      || !isSafeKnowledgeLocator(input.locator)) fail('KNOWLEDGE_SOURCE_REQUEST_INVALID')
  return { locator: input.locator, sourceId: input.sourceId }
}

function normalizeKnowledgeContent(input, maxBytes = MAX_KNOWLEDGE_CONTENT_BYTES) {
  let bytes
  if (typeof input === 'string') bytes = Buffer.from(input, 'utf8')
  else if (Buffer.isBuffer(input) || input instanceof Uint8Array) bytes = Buffer.from(input)
  else fail('KNOWLEDGE_CONTENT_INVALID')
  if (!bytes.length || bytes.length > maxBytes
      || !Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)
      || bytes.includes(0)) fail('KNOWLEDGE_CONTENT_INVALID')
  return {
    content: bytes.toString('utf8'),
    contentHash: crypto.createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  }
}

function assertSourceOwnership(source, instance, code) {
  if (!instance || source.connectorId !== instance.connectorId
      || source.scopeId !== instance.scope?.scopeId
      || source.size > instance.egressLimit?.maxContentBytes) {
    fail(code)
  }
}

function normalizeSearchResults(input, instance, limit) {
  if (!Array.isArray(input) || !Number.isInteger(limit) || limit < 1
      || input.length > limit) fail('KNOWLEDGE_SEARCH_RESULT_INVALID')
  const results = input.map(normalizeSourceDescriptor)
  const sourceIds = new Set()
  const locators = new Set()
  for (const source of results) {
    assertSourceOwnership(source, instance, 'KNOWLEDGE_SEARCH_RESULT_INVALID')
    if (sourceIds.has(source.sourceId) || locators.has(source.locator)) {
      fail('KNOWLEDGE_SEARCH_RESULT_INVALID')
    }
    sourceIds.add(source.sourceId)
    locators.add(source.locator)
  }
  return results
}

function normalizeFetchResult(input, maxBytes, expectedInstance = null) {
  if (!isPlainObject(input) || Object.keys(input).sort().join(',') !== 'content,source') {
    fail('KNOWLEDGE_FETCH_RESULT_INVALID')
  }
  const source = normalizeSourceDescriptor(input.source)
  const content = normalizeKnowledgeContent(input.content, maxBytes)
  if (content.contentHash !== source.contentHash || content.size !== source.size) {
    fail('KNOWLEDGE_FETCH_RESULT_INVALID')
  }
  if (expectedInstance) {
    assertSourceOwnership(source, expectedInstance, 'KNOWLEDGE_FETCH_RESULT_INVALID')
  }
  return { content: content.content, source }
}

function normalizeCitationRequest(input) {
  if (!isPlainObject(input)) fail('KNOWLEDGE_CITATION_REQUEST_INVALID')
  const keys = Object.keys(input).sort().join(',')
  if (keys === 'snapshot') {
    return {
      verification: 'snapshot',
      snapshot: parseKnowledgeSnapshotRecord(input.snapshot),
    }
  }
  if (keys === 'contentHash,locator,sourceId' && typeof input.contentHash === 'string'
      && SHA256.test(input.contentHash)) {
    return {
      verification: 'live',
      ...normalizeSourceRequest({ sourceId: input.sourceId, locator: input.locator }),
      contentHash: input.contentHash,
    }
  }
  fail('KNOWLEDGE_CITATION_REQUEST_INVALID')
}

function normalizeCitationResult(input, maxBytes, expectedInstance = null) {
  if (!isPlainObject(input) || Object.keys(input).sort().join(',') !== 'citation,content') {
    fail('KNOWLEDGE_CITATION_RESULT_INVALID')
  }
  let citation
  try { citation = parseKnowledgeCitationRecord(input.citation) } catch {
    fail('KNOWLEDGE_CITATION_RESULT_INVALID')
  }
  const content = normalizeKnowledgeContent(input.content, maxBytes)
  if (content.contentHash !== citation.contentHash
      || (citation.contentRef && content.size !== citation.contentRef.size)) {
    fail('KNOWLEDGE_CITATION_RESULT_INVALID')
  }
  if (expectedInstance && (
    citation.connectorId !== expectedInstance.connectorId
    || citation.instanceId !== expectedInstance.instanceId
    || citation.scopeId !== expectedInstance.scope?.scopeId
  )) {
    fail('KNOWLEDGE_CITATION_RESULT_INVALID')
  }
  return { citation, content: content.content }
}

function deriveRecordId(prefix, body) {
  return `${prefix}-${crypto.createHash('sha256').update(canonicalJson(body)).digest('hex')}`
}

function createKnowledgeSnapshotRecord(input) {
  const result = snapshotInputSchema.safeParse(input)
  if (!result.success) fail('KNOWLEDGE_SNAPSHOT_SCHEMA_INVALID')
  const body = {
    version: KNOWLEDGE_RECORD_VERSION,
    recordType: 'knowledge-snapshot',
    ...result.data,
  }
  return JSON.parse(canonicalJson({ snapshotId: deriveRecordId('knowledge-snapshot', body), ...body }))
}

function parseKnowledgeSnapshotRecord(input) {
  const result = snapshotRecordSchema.safeParse(input)
  if (!result.success) fail('KNOWLEDGE_SNAPSHOT_SCHEMA_INVALID')
  const { snapshotId, ...body } = result.data
  if (deriveRecordId('knowledge-snapshot', body) !== snapshotId) {
    fail('KNOWLEDGE_SNAPSHOT_ID_MISMATCH')
  }
  return JSON.parse(canonicalJson(result.data))
}

function createKnowledgeCitationRecord(input) {
  const result = citationInputSchema.safeParse(input)
  if (!result.success) fail('KNOWLEDGE_CITATION_SCHEMA_INVALID')
  const body = {
    version: KNOWLEDGE_RECORD_VERSION,
    recordType: 'knowledge-citation',
    ...result.data,
  }
  return JSON.parse(canonicalJson({ citationId: deriveRecordId('knowledge-citation', body), ...body }))
}

function parseKnowledgeCitationRecord(input) {
  const result = citationRecordSchema.safeParse(input)
  if (!result.success) fail('KNOWLEDGE_CITATION_SCHEMA_INVALID')
  const { citationId, ...body } = result.data
  if (deriveRecordId('knowledge-citation', body) !== citationId) {
    fail('KNOWLEDGE_CITATION_ID_MISMATCH')
  }
  return JSON.parse(canonicalJson(result.data))
}

function normalizeBlobRef(input) {
  try { return normalizeContentBlobRef(input) } catch {
    fail('KNOWLEDGE_CONTENT_REF_INVALID')
  }
}

function assertKnowledgeConnector(connector) {
  const methods = ['authorize', 'revoke', 'probe', 'search', 'fetch', 'snapshot', 'citation']
  if (!connector || typeof connector !== 'object'
      || connector.contractVersion !== KNOWLEDGE_CONNECTOR_CONTRACT_VERSION
      || typeof connector.connectorId !== 'string' || !PUBLIC_ID.test(connector.connectorId)
      || methods.some(method => typeof connector[method] !== 'function')) {
    fail('KNOWLEDGE_CONNECTOR_CONTRACT_INVALID')
  }
  return connector
}

module.exports = {
  KNOWLEDGE_CONNECTOR_CONTRACT_VERSION,
  KNOWLEDGE_RECORD_VERSION,
  MAX_KNOWLEDGE_CONTENT_BYTES,
  MAX_KNOWLEDGE_RESULTS,
  assertKnowledgeConnector,
  createKnowledgeCitationRecord,
  createKnowledgeSnapshotRecord,
  isSafeKnowledgeLocator,
  normalizeBlobRef,
  normalizeCitationRequest,
  normalizeCitationResult,
  normalizeFetchResult,
  normalizeKnowledgeConnectorInstance,
  normalizeKnowledgeContent,
  normalizeProbeResult,
  normalizeSearchRequest,
  normalizeSearchResults,
  normalizeSourceDescriptor,
  normalizeSourceRequest,
  parseKnowledgeCitationRecord,
  parseKnowledgeSnapshotRecord,
  parsePublicKnowledgeConnectorInstance,
  publicKnowledgeConnectorInstance,
  stableKnowledgeSourceId,
}
