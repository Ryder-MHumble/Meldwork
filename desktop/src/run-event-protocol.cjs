const crypto = require('node:crypto')
const { z } = require('zod')

const { isSemanticVersion, RUN_EVENT_TYPES } = require('./agent-connector-manifest.cjs')
const { canonicalJson } = require('./outcome-records.cjs')
const { redactSecrets } = require('./secret-redaction.cjs')

const RUN_EVENT_PROTOCOL_VERSION = 1
const RUN_EVENT_STATE_VERSION = 1
const MAX_RUN_EVENT_BYTES = 256 * 1024
const MAX_RUN_EVENTS = 512
const MAX_SUMMARY_CHARS = 4000

const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const OPAQUE_REF = /^[A-Za-z0-9][A-Za-z0-9._:+/=\-]{0,239}$/
const MANIFEST_ID = /^connector-manifest-[a-f0-9]{64}$/
const ARTIFACT_ID = /^artifact-[a-f0-9]{64}$/
const EVIDENCE_ID = /^evidence-[a-f0-9]{64}$/
const SHA256 = /^[a-f0-9]{64}$/

const USAGE_FIELDS = Object.freeze([
  'inputTokens',
  'outputTokens',
  'costMicros',
  'toolCalls',
  'outboundBytes',
  'elapsedMs',
])
const TERMINAL_TYPES = new Set(['Completed', 'Failed', 'Cancelled'])
const KNOWN_RUN_EVENT_TYPES = new Set(RUN_EVENT_TYPES)

function protocolError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function fail(code) {
  throw protocolError(code)
}

function safeTextSchema(max = MAX_SUMMARY_CHARS) {
  return z.string().min(1).max(max).superRefine((value, context) => {
    if (redactSecrets(value) !== value) {
      context.addIssue({ code: 'custom', message: 'secret-like event text' })
    }
  })
}

function safePublicIdSchema() {
  return z.string().min(1).max(120).regex(PUBLIC_ID).superRefine((value, context) => {
    if (redactSecrets(value) !== value) {
      context.addIssue({ code: 'custom', message: 'secret-like public ID' })
    }
  })
}

function safeOpaqueRefSchema() {
  return z.string().min(1).max(240).regex(OPAQUE_REF).superRefine((value, context) => {
    if (redactSecrets(value) !== value) {
      context.addIssue({ code: 'custom', message: 'secret-like opaque reference' })
    }
  })
}

const publicIdSchema = safePublicIdSchema()
const opaqueRefSchema = safeOpaqueRefSchema()
const semanticVersionSchema = z.string().min(5).max(120).superRefine((value, context) => {
  if (!isSemanticVersion(value)) context.addIssue({ code: 'custom', message: 'invalid version' })
})
const nonnegativeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const usageValuesSchema = z.strictObject(Object.fromEntries(
  USAGE_FIELDS.map(field => [field, nonnegativeInteger.optional()]),
)).superRefine((usage, context) => {
  if (!USAGE_FIELDS.some(field => usage[field] !== undefined)) {
    context.addIssue({ code: 'custom', message: 'usage value required' })
  }
})

const eventCommonFields = {
  protocolVersion: z.literal(RUN_EVENT_PROTOCOL_VERSION),
  connectorId: publicIdSchema,
  connectorVersion: semanticVersionSchema,
  manifestId: z.string().regex(MANIFEST_ID),
  instanceId: publicIdSchema,
  upstreamId: publicIdSchema,
  upstreamVersion: semanticVersionSchema,
  runId: publicIdSchema,
  agentRunId: publicIdSchema,
  eventId: opaqueRefSchema,
  cursor: opaqueRefSchema,
  sequence: z.number().int().nonnegative().max(1_000_000_000),
}

const permissionEventSchema = z.strictObject({
  ...eventCommonFields,
  type: z.literal('Permission'),
  requestId: publicIdSchema,
  permission: z.enum([
    'workspace-read', 'workspace-write', 'network', 'browser', 'external-message',
  ]),
  decision: z.enum(['requested', 'approved', 'rejected']),
  summary: safeTextSchema().optional(),
})

const sourceUsedEventSchema = z.strictObject({
  ...eventCommonFields,
  type: z.literal('SourceUsed'),
  sourceId: publicIdSchema,
  sourceType: z.enum([
    'message', 'attachment', 'knowledge', 'skill', 'workspace-file', 'other',
  ]),
  contentHash: z.string().regex(SHA256).nullable(),
  citation: safeTextSchema(1000).optional(),
})

const artifactEventSchema = z.strictObject({
  ...eventCommonFields,
  type: z.literal('Artifact'),
  artifactId: z.string().regex(ARTIFACT_ID),
})

const evidenceEventSchema = z.strictObject({
  ...eventCommonFields,
  type: z.literal('Evidence'),
  evidenceId: z.string().regex(EVIDENCE_ID),
})

const usageEventSchema = z.strictObject({
  ...eventCommonFields,
  type: z.literal('Usage'),
  mode: z.enum(['delta', 'cumulative']),
  usage: usageValuesSchema,
})

const waitingInputEventSchema = z.strictObject({
  ...eventCommonFields,
  type: z.literal('WaitingInput'),
  requestId: publicIdSchema,
  prompt: safeTextSchema(),
})

const completedEventSchema = z.strictObject({
  ...eventCommonFields,
  type: z.literal('Completed'),
  outcome: z.enum(['completed', 'partial']),
  summary: safeTextSchema().optional(),
})

const failedEventSchema = z.strictObject({
  ...eventCommonFields,
  type: z.literal('Failed'),
  code: publicIdSchema,
  category: z.enum([
    'authentication', 'compatibility', 'network', 'rate-limit', 'timeout',
    'permission', 'budget', 'protocol', 'execution', 'unknown',
  ]),
  retryable: z.boolean(),
  summary: safeTextSchema().optional(),
})

const cancelledEventSchema = z.strictObject({
  ...eventCommonFields,
  type: z.literal('Cancelled'),
  reason: z.enum([
    'user', 'timeout', 'shutdown', 'replaced', 'budget', 'permission-denied', 'other',
  ]),
  summary: safeTextSchema().optional(),
})

const unknownEventSchema = z.strictObject({
  ...eventCommonFields,
  type: z.literal('Unknown'),
  originalType: publicIdSchema,
  payloadHash: z.string().regex(SHA256),
  summary: safeTextSchema(240),
})

const runEventSchema = z.discriminatedUnion('type', [
  permissionEventSchema,
  sourceUsedEventSchema,
  artifactEventSchema,
  evidenceEventSchema,
  usageEventSchema,
  waitingInputEventSchema,
  completedEventSchema,
  failedEventSchema,
  cancelledEventSchema,
  unknownEventSchema,
])

const provenanceFields = {
  protocolVersion: z.literal(RUN_EVENT_PROTOCOL_VERSION),
  connectorId: publicIdSchema,
  connectorVersion: semanticVersionSchema,
  manifestId: z.string().regex(MANIFEST_ID),
  instanceId: publicIdSchema,
  upstreamId: publicIdSchema,
  upstreamVersion: semanticVersionSchema,
  runId: publicIdSchema,
  agentRunId: publicIdSchema,
}
const provenanceSchema = z.strictObject(provenanceFields)
const zeroUsage = Object.freeze(Object.fromEntries(USAGE_FIELDS.map(field => [field, 0])))

const runEventStateSchema = z.strictObject({
  stateVersion: z.literal(RUN_EVENT_STATE_VERSION),
  ...provenanceFields,
  status: z.enum([
    'running', 'waiting_input', 'waiting_permission',
    'partial', 'completed', 'failed', 'cancelled',
  ]),
  lastSequence: z.number().int().min(-1).max(1_000_000_000),
  cursor: z.string().max(240),
  events: z.array(runEventSchema).max(MAX_RUN_EVENTS),
  sourceIds: z.array(publicIdSchema).max(MAX_RUN_EVENTS),
  artifactIds: z.array(z.string().regex(ARTIFACT_ID)).max(MAX_RUN_EVENTS),
  evidenceIds: z.array(z.string().regex(EVIDENCE_ID)).max(MAX_RUN_EVENTS),
  usage: z.strictObject(Object.fromEntries(
    USAGE_FIELDS.map(field => [field, nonnegativeInteger]),
  )),
})

function parseJsonInput(input, prefix, maxBytes = MAX_RUN_EVENT_BYTES) {
  if (Buffer.isBuffer(input) || input instanceof Uint8Array || typeof input === 'string') {
    const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input)
    if (!bytes.length || bytes.length > maxBytes
        || !Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) {
      fail(`${prefix}_JSON_INVALID`)
    }
    try {
      return { parsed: JSON.parse(bytes.toString('utf8')), serialized: bytes.toString('utf8') }
    } catch {
      fail(`${prefix}_JSON_INVALID`)
    }
  }
  return { parsed: input, serialized: null }
}

function validated(schema, value, prefix) {
  const result = schema.safeParse(value)
  if (!result.success) fail(`${prefix}_SCHEMA_INVALID`)
  return result.data
}

function parseRunEvent(input) {
  const { parsed } = parseJsonInput(input, 'RUN_EVENT')
  const event = validated(runEventSchema, parsed, 'RUN_EVENT')
  const serialized = canonicalJson(event)
  if (Buffer.byteLength(serialized) > MAX_RUN_EVENT_BYTES) fail('RUN_EVENT_SCHEMA_INVALID')
  return JSON.parse(serialized)
}

function parseConnectorRunEvent(input, provenanceInput) {
  const provenance = validated(provenanceSchema, provenanceInput, 'RUN_EVENT_STATE')
  const { parsed } = parseJsonInput(input, 'RUN_EVENT')
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('RUN_EVENT_SCHEMA_INVALID')
  }
  for (const field of Object.keys(provenanceFields)) {
    if (Object.prototype.hasOwnProperty.call(parsed, field)
        && parsed[field] !== provenance[field]) {
      fail('RUN_EVENT_PROVENANCE_MISMATCH')
    }
  }
  if (KNOWN_RUN_EVENT_TYPES.has(parsed.type)) {
    return parseRunEvent({ ...parsed, ...provenance })
  }
  const envelope = z.strictObject({
    eventId: opaqueRefSchema,
    cursor: opaqueRefSchema,
    sequence: z.number().int().nonnegative().max(1_000_000_000),
  }).safeParse({
    eventId: parsed.eventId,
    cursor: parsed.cursor,
    sequence: parsed.sequence,
  })
  if (!envelope.success) fail('RUN_EVENT_SCHEMA_INVALID')
  const candidateType = typeof parsed.type === 'string' ? parsed.type : ''
  const originalType = PUBLIC_ID.test(candidateType) && redactSecrets(candidateType) === candidateType
    ? candidateType
    : 'unknown'
  let payloadHash
  try {
    payloadHash = crypto.createHash('sha256').update(canonicalJson(parsed)).digest('hex')
  } catch {
    fail('RUN_EVENT_SCHEMA_INVALID')
  }
  return parseRunEvent({
    ...provenance,
    ...envelope.data,
    type: 'Unknown',
    originalType,
    payloadHash,
    summary: `Unsupported connector event: ${originalType}`,
  })
}

function serializeRunEvent(input) {
  return canonicalJson(parseRunEvent(input))
}

function provenanceFrom(value) {
  return Object.fromEntries(Object.keys(provenanceFields).map(key => [key, value[key]]))
}

function sameProvenance(left, right) {
  return Object.keys(provenanceFields).every(key => left[key] === right[key])
}

function addUnique(values, value) {
  if (!values.includes(value)) values.push(value)
}

function safeUsageAdd(left, right) {
  const total = left + right
  if (!Number.isSafeInteger(total) || total < 0) fail('RUN_EVENT_USAGE_OVERFLOW')
  return total
}

function deriveRunEventState(provenanceInput, eventInputs) {
  const provenance = validated(provenanceSchema, provenanceInput, 'RUN_EVENT_STATE')
  if (!Array.isArray(eventInputs) || eventInputs.length > MAX_RUN_EVENTS) {
    fail('RUN_EVENT_STATE_SCHEMA_INVALID')
  }
  const events = eventInputs.map(parseRunEvent).sort((left, right) => (
    left.sequence - right.sequence || left.eventId.localeCompare(right.eventId)
  ))
  const eventIds = new Set()
  const sequences = new Set()
  let terminal = null
  let status = 'running'
  let cursor = ''
  let lastSequence = -1
  const sourceIds = []
  const artifactIds = []
  const evidenceIds = []
  const usage = { ...zeroUsage }

  for (const event of events) {
    if (!sameProvenance(provenance, event)) fail('RUN_EVENT_PROVENANCE_MISMATCH')
    if (eventIds.has(event.eventId)) fail('RUN_EVENT_ID_CONFLICT')
    if (sequences.has(event.sequence)) fail('RUN_EVENT_SEQUENCE_CONFLICT')
    eventIds.add(event.eventId)
    sequences.add(event.sequence)
    if (terminal) fail('RUN_EVENT_AFTER_TERMINAL')

    cursor = event.cursor
    lastSequence = event.sequence
    if (event.type === 'Permission') {
      status = event.decision === 'requested' ? 'waiting_permission' : 'running'
    } else if (event.type === 'WaitingInput') {
      status = 'waiting_input'
    } else if (event.type === 'SourceUsed') {
      addUnique(sourceIds, event.sourceId)
      status = 'running'
    } else if (event.type === 'Artifact') {
      addUnique(artifactIds, event.artifactId)
      status = 'running'
    } else if (event.type === 'Evidence') {
      addUnique(evidenceIds, event.evidenceId)
      status = 'running'
    } else if (event.type === 'Usage') {
      for (const field of USAGE_FIELDS) {
        if (event.usage[field] === undefined) continue
        usage[field] = event.mode === 'delta'
          ? safeUsageAdd(usage[field], event.usage[field])
          : event.usage[field]
      }
      status = 'running'
    } else if (event.type === 'Completed') {
      status = event.outcome
      terminal = event
    } else if (event.type === 'Failed') {
      status = 'failed'
      terminal = event
    } else if (event.type === 'Cancelled') {
      status = 'cancelled'
      terminal = event
    }
  }

  return JSON.parse(canonicalJson({
    stateVersion: RUN_EVENT_STATE_VERSION,
    ...provenance,
    status,
    lastSequence,
    cursor,
    events,
    sourceIds,
    artifactIds,
    evidenceIds,
    usage,
  }))
}

function createRunEventState(input) {
  return deriveRunEventState(input, [])
}

function parseRunEventState(input) {
  const { parsed, serialized } = parseJsonInput(
    input,
    'RUN_EVENT_STATE',
    MAX_RUN_EVENT_BYTES * 4,
  )
  const state = validated(runEventStateSchema, parsed, 'RUN_EVENT_STATE')
  const derived = deriveRunEventState(provenanceFrom(state), state.events)
  if (canonicalJson(derived) !== canonicalJson(state)) fail('RUN_EVENT_STATE_MISMATCH')
  const canonical = canonicalJson(derived)
  if (serialized !== null && serialized !== canonical) {
    fail('RUN_EVENT_STATE_JSON_NOT_CANONICAL')
  }
  return JSON.parse(canonical)
}

function serializeRunEventState(input) {
  return canonicalJson(parseRunEventState(input))
}

function reduceRunEvent(stateInput, eventInput) {
  const state = parseRunEventState(stateInput)
  const event = parseRunEvent(eventInput)
  if (!sameProvenance(state, event)) fail('RUN_EVENT_PROVENANCE_MISMATCH')
  const duplicate = state.events.find(existing => existing.eventId === event.eventId)
  if (duplicate) {
    if (canonicalJson(duplicate) !== canonicalJson(event)) fail('RUN_EVENT_ID_CONFLICT')
    return state
  }
  if (state.events.some(existing => existing.sequence === event.sequence)) {
    fail('RUN_EVENT_SEQUENCE_CONFLICT')
  }
  if (state.events.length >= MAX_RUN_EVENTS) fail('RUN_EVENT_STATE_LIMIT')
  return deriveRunEventState(provenanceFrom(state), [...state.events, event])
}

function reduceRunEvents(stateInput, eventInputs) {
  if (!Array.isArray(eventInputs)) fail('RUN_EVENT_BATCH_INVALID')
  return eventInputs.reduce((state, event) => reduceRunEvent(state, event), stateInput)
}

module.exports = {
  MAX_RUN_EVENTS,
  RUN_EVENT_PROTOCOL_VERSION,
  RUN_EVENT_STATE_VERSION,
  RUN_EVENT_TYPES,
  USAGE_FIELDS,
  createRunEventState,
  parseRunEvent,
  parseConnectorRunEvent,
  parseRunEventState,
  reduceRunEvent,
  reduceRunEvents,
  serializeRunEvent,
  serializeRunEventState,
}
