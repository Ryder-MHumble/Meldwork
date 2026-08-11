const crypto = require('node:crypto')
const path = require('node:path')
const { z } = require('zod')

const {
  AGENT_INPUT_TYPES,
  AGENT_PERMISSION_MODES,
  AGENT_TOOL_CLASSES,
} = require('../agents/agent-runtime-contract.cjs')
const {
  compareSemanticVersions,
  isSemanticVersion,
} = require('../agents/connectors/agent-connector-manifest.cjs')
const { canonicalJson } = require('../collaboration/outcome-records.cjs')
const { redactSecrets } = require('../security/secret-redaction.cjs')

const LOCAL_SKILL_MANIFEST_FILENAME = 'meldwork.skill.json'
const LOCAL_SKILL_MANIFEST_VERSION = 1
const LOCAL_SKILL_PROVENANCE_VERSION = 1
const MAX_MANIFEST_BYTES = 256 * 1024
const SHA256 = /^[a-f0-9]{64}$/
const TRUST_DECISION_ID = /^skill-trust-decision-[a-f0-9]{64}$/
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/

function skillContractError(code) {
  return Object.assign(new Error(code), { code })
}

function fail(code) {
  throw skillContractError(code)
}

function safeText(max) {
  return z.string().min(1).max(max).superRefine((value, context) => {
    if (value !== value.trim() || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)) {
      context.addIssue({ code: 'custom', message: 'unsafe text' })
    }
    if (path.isAbsolute(value) || path.win32.isAbsolute(value) || redactSecrets(value) !== value) {
      context.addIssue({ code: 'custom', message: 'private text' })
    }
  })
}

function uniqueArray(schema, max, minimum = 0) {
  return z.array(schema).min(minimum).max(max).superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', message: 'duplicate value' })
    }
  })
}

const semverSchema = z.string().min(5).max(120).superRefine((value, context) => {
  if (!isSemanticVersion(value)) context.addIssue({ code: 'custom', message: 'invalid version' })
})
const agentCompatibilitySchema = z.strictObject({
  kind: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  minVersion: semverSchema,
  maxVersion: semverSchema,
}).superRefine((value, context) => {
  if (compareSemanticVersions(value.minVersion, value.maxVersion) > 0) {
    context.addIssue({ code: 'custom', message: 'invalid version range' })
  }
})
const destinationSchema = z.string().min(9).max(2048).superRefine((value, context) => {
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
const credentialSchema = z.strictObject({
  credentialId: z.string().min(1).max(120).regex(PUBLIC_ID),
  type: z.enum(['api-key', 'oauth', 'token', 'provider-profile']),
})
const manifestSchema = z.strictObject({
  schemaVersion: z.literal(LOCAL_SKILL_MANIFEST_VERSION),
  recordType: z.literal('meldwork-skill-manifest'),
  identity: z.strictObject({
    id: safeText(240),
    version: semverSchema,
  }),
  origin: z.strictObject({
    type: z.literal('local-unsigned'),
    publisher: safeText(160),
  }),
  agents: z.array(agentCompatibilitySchema).min(1).max(32),
  inputTypes: uniqueArray(z.enum(AGENT_INPUT_TYPES), AGENT_INPUT_TYPES.length, 1),
  tools: uniqueArray(z.enum(AGENT_TOOL_CLASSES), AGENT_TOOL_CLASSES.length),
  credentials: z.array(credentialSchema).max(16),
  permissionMode: z.enum(AGENT_PERMISSION_MODES),
  networkDestinations: uniqueArray(destinationSchema, 16),
  sideEffectClass: z.enum(['none', 'local-write', 'external-write']),
}).superRefine((manifest, context) => {
  const agentKinds = manifest.agents.map(agent => agent.kind)
  if (new Set(agentKinds).size !== agentKinds.length) {
    context.addIssue({ code: 'custom', path: ['agents'], message: 'duplicate Agent' })
  }
  const credentialIds = manifest.credentials.map(item => item.credentialId)
  if (new Set(credentialIds).size !== credentialIds.length) {
    context.addIssue({ code: 'custom', path: ['credentials'], message: 'duplicate credential' })
  }
  if (manifest.sideEffectClass !== 'none' && manifest.permissionMode !== 'workspace-write') {
    context.addIssue({ code: 'custom', path: ['permissionMode'], message: 'write permission required' })
  }
  if (manifest.sideEffectClass === 'external-write' && !manifest.networkDestinations.length) {
    context.addIssue({ code: 'custom', path: ['networkDestinations'], message: 'destination required' })
  }
  if (manifest.networkDestinations.length
      && !manifest.tools.some(tool => ['network', 'browser'].includes(tool))) {
    context.addIssue({ code: 'custom', path: ['tools'], message: 'network tool required' })
  }
})

function parseJson(input) {
  const bytes = Buffer.isBuffer(input) || input instanceof Uint8Array
    ? Buffer.from(input)
    : Buffer.from(String(input || ''), 'utf8')
  if (!bytes.length || bytes.length > MAX_MANIFEST_BYTES
      || !Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) {
    fail('LOCAL_SKILL_MANIFEST_JSON_INVALID')
  }
  try { return JSON.parse(bytes.toString('utf8')) } catch {
    fail('LOCAL_SKILL_MANIFEST_JSON_INVALID')
  }
}

function normalizeLocalSkillManifest(input) {
  const parsed = Buffer.isBuffer(input) || input instanceof Uint8Array || typeof input === 'string'
    ? parseJson(input)
    : input
  const result = manifestSchema.safeParse(parsed)
  if (!result.success) fail('LOCAL_SKILL_MANIFEST_INVALID')
  const canonical = canonicalJson(result.data)
  if (Buffer.byteLength(canonical) > MAX_MANIFEST_BYTES) fail('LOCAL_SKILL_MANIFEST_INVALID')
  return Object.freeze(JSON.parse(canonical))
}

function localSkillContractHash(manifest) {
  const normalized = normalizeLocalSkillManifest(manifest)
  return crypto.createHash('sha256').update(canonicalJson(normalized)).digest('hex')
}

function assertManifestIdentity(manifest, coordinates) {
  const normalized = normalizeLocalSkillManifest(manifest)
  if (normalized.identity.id !== `${coordinates.namespace}/${coordinates.slug}`) {
    fail('LOCAL_SKILL_MANIFEST_IDENTITY_MISMATCH')
  }
  return normalized
}

function createLocalSkillSnapshotProvenance({
  manifest,
  contentHash,
  trustDecisionId,
  approvedAt,
}) {
  const approvedManifest = normalizeLocalSkillManifest(manifest)
  if (!SHA256.test(String(contentHash || ''))
      || !TRUST_DECISION_ID.test(String(trustDecisionId || ''))
      || !Number.isFinite(Date.parse(String(approvedAt || '')))) {
    fail('LOCAL_SKILL_PROVENANCE_INVALID')
  }
  return Object.freeze({
    schemaVersion: LOCAL_SKILL_PROVENANCE_VERSION,
    recordType: 'local-skill-snapshot-provenance',
    contractHash: localSkillContractHash(approvedManifest),
    contentHash,
    trustDecisionId,
    trustScope: 'agent-content',
    approvedAt,
    approvedManifest,
  })
}

function normalizeLocalSkillSnapshotProvenance(input, expectedContentHash = '') {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).sort().join(',') !== [
        'approvedAt', 'approvedManifest', 'contentHash', 'contractHash', 'recordType',
        'schemaVersion', 'trustDecisionId', 'trustScope',
      ].sort().join(',')) {
    fail('LOCAL_SKILL_PROVENANCE_INVALID')
  }
  const value = createLocalSkillSnapshotProvenance({
    manifest: input.approvedManifest,
    contentHash: input.contentHash,
    trustDecisionId: input.trustDecisionId,
    approvedAt: input.approvedAt,
  })
  if (input.schemaVersion !== value.schemaVersion || input.recordType !== value.recordType
      || input.contractHash !== value.contractHash || input.trustScope !== value.trustScope
      || (expectedContentHash && value.contentHash !== expectedContentHash)) {
    fail('LOCAL_SKILL_PROVENANCE_INVALID')
  }
  return value
}

function assertLocalSkillExecution(manifest, execution = {}) {
  const value = normalizeLocalSkillManifest(manifest)
  const kind = String(execution.kind || '')
  const version = String(execution.version || '')
  const compatibility = value.agents.find(agent => agent.kind === kind)
  if (!compatibility || !isSemanticVersion(version)
      || compareSemanticVersions(version, compatibility.minVersion) < 0
      || compareSemanticVersions(version, compatibility.maxVersion) > 0) {
    fail('LOCAL_SKILL_AGENT_INCOMPATIBLE')
  }
  const inputTypes = new Set(Array.isArray(execution.inputTypes) ? execution.inputTypes : [])
  if (value.inputTypes.some(type => !inputTypes.has(type))) {
    fail('LOCAL_SKILL_INPUT_INCOMPATIBLE')
  }
  const capabilities = execution.capabilities || {}
  const toolClasses = new Set(Array.isArray(capabilities.toolClasses) ? capabilities.toolClasses : [])
  if (value.tools.some(tool => !toolClasses.has(tool))) {
    fail('LOCAL_SKILL_TOOL_INCOMPATIBLE')
  }
  const permissionModes = new Set(
    Array.isArray(capabilities.permissionModes) ? capabilities.permissionModes : [],
  )
  if (!permissionModes.has(value.permissionMode)
      || execution.permissionMode !== value.permissionMode) {
    fail('LOCAL_SKILL_PERMISSION_ESCALATION')
  }
  const credentials = new Set(Array.isArray(execution.credentialIds) ? execution.credentialIds : [])
  if (value.credentials.some(item => !credentials.has(item.credentialId))) {
    fail('LOCAL_SKILL_CREDENTIAL_UNAVAILABLE')
  }
  return value
}

module.exports = {
  LOCAL_SKILL_MANIFEST_FILENAME,
  LOCAL_SKILL_MANIFEST_VERSION,
  LOCAL_SKILL_PROVENANCE_VERSION,
  assertLocalSkillExecution,
  assertManifestIdentity,
  createLocalSkillSnapshotProvenance,
  localSkillContractHash,
  normalizeLocalSkillManifest,
  normalizeLocalSkillSnapshotProvenance,
}
