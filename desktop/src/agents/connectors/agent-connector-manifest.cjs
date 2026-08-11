const crypto = require('node:crypto')
const { z } = require('zod')

const { canonicalJson } = require('../../collaboration/outcome-records.cjs')
const { redactSecrets } = require('../../security/secret-redaction.cjs')

const AGENT_CONNECTOR_MANIFEST_VERSION = 1
const MAX_MANIFEST_BYTES = 256 * 1024
const MAX_LIST_ITEMS = 32

const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const MANIFEST_ID = /^connector-manifest-[a-f0-9]{64}$/
const SPDX_ID = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,79}$/

const RUN_EVENT_TYPES = Object.freeze([
  'Permission',
  'SourceUsed',
  'Artifact',
  'Evidence',
  'Usage',
  'WaitingInput',
  'Completed',
  'Failed',
  'Cancelled',
])
const REQUIRED_TERMINAL_EVENTS = Object.freeze(['Completed', 'Failed', 'Cancelled'])

function manifestError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function fail(code) {
  throw manifestError(code)
}

function safeTextSchema(max) {
  return z.string().min(1).max(max).superRefine((value, context) => {
    if (/[\u0000-\u001f\u007f]/.test(value) || redactSecrets(value) !== value) {
      context.addIssue({ code: 'custom', message: 'unsafe manifest text' })
    }
  })
}

function uniqueArray(schema, max = MAX_LIST_ITEMS, minimum = 0) {
  return z.array(schema).min(minimum).max(max).superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', message: 'duplicate manifest value' })
    }
  })
}

const publicIdSchema = z.string().min(1).max(120).regex(PUBLIC_ID)
const semverSchema = z.string().min(5).max(120).superRefine((value, context) => {
  if (!isSemanticVersion(value)) {
    context.addIssue({ code: 'custom', message: 'invalid semantic version' })
  }
})
const manifestIdSchema = z.string().regex(MANIFEST_ID)
const labelSchema = safeTextSchema(120)
const descriptionSchema = safeTextSchema(1000)

const transportSchema = z.strictObject({
  type: z.enum(['cli', 'acp', 'http', 'a2a']),
  protocol: z.enum(['text', 'json', 'jsonl', 'acp', 'event-stream']),
}).superRefine((transport, context) => {
  const protocols = {
    cli: new Set(['text', 'json', 'jsonl']),
    acp: new Set(['acp']),
    http: new Set(['json', 'event-stream']),
    a2a: new Set(['json', 'event-stream']),
  }
  if (!protocols[transport.type].has(transport.protocol)) {
    context.addIssue({ code: 'custom', path: ['protocol'], message: 'transport mismatch' })
  }
})

const upstreamSchema = z.strictObject({
  id: publicIdSchema,
  minVersion: semverSchema,
  maxVersion: semverSchema,
})

const sessionSchema = z.strictObject({
  supported: z.boolean(),
  resume: z.boolean(),
  cancel: z.boolean(),
  checkpoint: z.boolean(),
}).superRefine((session, context) => {
  if (!session.supported && (session.resume || session.checkpoint)) {
    context.addIssue({ code: 'custom', message: 'stateless connector cannot resume or checkpoint' })
  }
})

const usageSchema = z.strictObject({
  inputTokens: z.boolean(),
  outputTokens: z.boolean(),
  costMicros: z.boolean(),
  toolCalls: z.boolean(),
  outboundBytes: z.boolean(),
  elapsedMs: z.boolean(),
})

const credentialSlotSchema = z.strictObject({
  slotId: publicIdSchema,
  type: z.enum(['api-key', 'oauth', 'token', 'provider-profile']),
  required: z.boolean(),
})

const credentialsSchema = z.strictObject({
  mode: z.enum(['none', 'credential-ref']),
  slots: z.array(credentialSlotSchema).max(16),
}).superRefine((credentials, context) => {
  const slotIds = credentials.slots.map(slot => slot.slotId)
  if (new Set(slotIds).size !== slotIds.length) {
    context.addIssue({ code: 'custom', path: ['slots'], message: 'duplicate credential slot' })
  }
  if ((credentials.mode === 'none') !== (credentials.slots.length === 0)) {
    context.addIssue({ code: 'custom', path: ['mode'], message: 'credential mode mismatch' })
  }
})

const outboundDestinationSchema = z.string().min(9).max(2048).superRefine((value, context) => {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password
        || parsed.pathname !== '/' || parsed.search || parsed.hash
        || parsed.origin !== value) {
      context.addIssue({ code: 'custom', message: 'HTTPS origin required' })
    }
  } catch {
    context.addIssue({ code: 'custom', message: 'HTTPS origin required' })
  }
})

const manifestContentFields = {
  connectorId: publicIdSchema,
  connectorVersion: semverSchema,
  kind: z.literal('agent'),
  label: labelSchema,
  description: descriptionSchema,
  transport: transportSchema,
  upstream: upstreamSchema,
  invocation: z.strictObject({
    recipeId: publicIdSchema,
    idempotencyMode: z.enum(['none', 'durable']).optional(),
  }),
  domains: uniqueArray(publicIdSchema, MAX_LIST_ITEMS, 1),
  session: sessionSchema,
  inputTypes: uniqueArray(z.enum([
    'text', 'image', 'audio', 'video', 'file', 'structured-data',
  ]), 16, 1),
  permissionModes: uniqueArray(z.enum(['read-only', 'workspace-write']), 2, 1),
  eventProtocolVersion: z.literal(1),
  eventTypes: uniqueArray(z.enum(RUN_EVENT_TYPES), RUN_EVENT_TYPES.length, 3),
  usage: usageSchema,
  outboundDestinations: uniqueArray(outboundDestinationSchema, 16),
  credentials: credentialsSchema,
  license: z.string().min(1).max(80).regex(SPDX_ID),
}

function validateManifestRelations(manifest, context) {
  if (compareSemanticVersions(manifest.upstream.minVersion, manifest.upstream.maxVersion) > 0) {
    context.addIssue({ code: 'custom', path: ['upstream'], message: 'invalid version range' })
  }
  if (REQUIRED_TERMINAL_EVENTS.some(type => !manifest.eventTypes.includes(type))) {
    context.addIssue({ code: 'custom', path: ['eventTypes'], message: 'terminal events required' })
  }
}

const manifestInputSchema = z.strictObject(manifestContentFields)
  .superRefine(validateManifestRelations)
const manifestRecordSchema = z.strictObject({
  manifestId: manifestIdSchema,
  schemaVersion: z.literal(AGENT_CONNECTOR_MANIFEST_VERSION),
  recordType: z.literal('agent-connector-manifest'),
  ...manifestContentFields,
}).superRefine(validateManifestRelations)

function semanticVersionParts(value) {
  const match = String(value || '').match(SEMVER)
  if (!match) return null
  const prerelease = match[4] ? match[4].split('.') : []
  if (prerelease.some(identifier => /^\d+$/.test(identifier)
      && identifier.length > 1 && identifier.startsWith('0'))) return null
  return {
    core: match.slice(1, 4),
    prerelease,
  }
}

function compareNumericIdentifiers(left, right) {
  if (left.length !== right.length) return left.length - right.length
  if (left === right) return 0
  return left < right ? -1 : 1
}

function comparePrerelease(left, right) {
  if (!left.length && !right.length) return 0
  if (!left.length) return 1
  if (!right.length) return -1
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    if (left[index] === undefined) return -1
    if (right[index] === undefined) return 1
    if (left[index] === right[index]) continue
    const leftNumeric = /^\d+$/.test(left[index])
    const rightNumeric = /^\d+$/.test(right[index])
    if (leftNumeric && rightNumeric) {
      return compareNumericIdentifiers(left[index], right[index])
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return left[index] < right[index] ? -1 : 1
  }
  return 0
}

function compareSemanticVersions(left, right) {
  const leftParts = semanticVersionParts(left)
  const rightParts = semanticVersionParts(right)
  if (!leftParts || !rightParts) return null
  for (let index = 0; index < leftParts.core.length; index += 1) {
    const comparison = compareNumericIdentifiers(leftParts.core[index], rightParts.core[index])
    if (comparison) return comparison
  }
  return comparePrerelease(leftParts.prerelease, rightParts.prerelease)
}

function isSemanticVersion(value) {
  return semanticVersionParts(value) !== null
}

function isUpstreamVersionCompatible(manifest, upstreamVersion) {
  const record = parseAgentConnectorManifest(manifest)
  if (!isSemanticVersion(upstreamVersion)) return false
  return compareSemanticVersions(upstreamVersion, record.upstream.minVersion) >= 0
    && compareSemanticVersions(upstreamVersion, record.upstream.maxVersion) <= 0
}

function parseInput(input) {
  if (Buffer.isBuffer(input) || input instanceof Uint8Array || typeof input === 'string') {
    const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input)
    if (!bytes.length || bytes.length > MAX_MANIFEST_BYTES
        || !Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) {
      fail('AGENT_CONNECTOR_MANIFEST_JSON_INVALID')
    }
    try {
      return { parsed: JSON.parse(bytes.toString('utf8')), serialized: bytes.toString('utf8') }
    } catch {
      fail('AGENT_CONNECTOR_MANIFEST_JSON_INVALID')
    }
  }
  return { parsed: input, serialized: null }
}

function validated(schema, value) {
  const result = schema.safeParse(value)
  if (!result.success) fail('AGENT_CONNECTOR_MANIFEST_SCHEMA_INVALID')
  return result.data
}

function manifestId(body) {
  return `connector-manifest-${crypto.createHash('sha256').update(canonicalJson(body)).digest('hex')}`
}

function canonicalRecord(record) {
  const serialized = canonicalJson(record)
  if (Buffer.byteLength(serialized) > MAX_MANIFEST_BYTES) {
    fail('AGENT_CONNECTOR_MANIFEST_SCHEMA_INVALID')
  }
  return serialized
}

function createAgentConnectorManifest(input) {
  const content = validated(manifestInputSchema, input)
  const body = {
    schemaVersion: AGENT_CONNECTOR_MANIFEST_VERSION,
    recordType: 'agent-connector-manifest',
    ...content,
  }
  const record = { manifestId: manifestId(body), ...body }
  return JSON.parse(canonicalRecord(record))
}

function parseAgentConnectorManifest(input) {
  const { parsed, serialized } = parseInput(input)
  const record = validated(manifestRecordSchema, parsed)
  const { manifestId: id, ...body } = record
  if (manifestId(body) !== id) fail('AGENT_CONNECTOR_MANIFEST_ID_MISMATCH')
  const canonical = canonicalRecord(record)
  if (serialized !== null && serialized !== canonical) {
    fail('AGENT_CONNECTOR_MANIFEST_JSON_NOT_CANONICAL')
  }
  return JSON.parse(canonical)
}

function serializeAgentConnectorManifest(input) {
  return canonicalJson(parseAgentConnectorManifest(input))
}

module.exports = {
  AGENT_CONNECTOR_MANIFEST_VERSION,
  MAX_MANIFEST_BYTES,
  RUN_EVENT_TYPES,
  compareSemanticVersions,
  createAgentConnectorManifest,
  isSemanticVersion,
  isUpstreamVersionCompatible,
  parseAgentConnectorManifest,
  serializeAgentConnectorManifest,
}
