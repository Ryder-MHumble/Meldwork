const { z } = require('zod')

const {
  isSemanticVersion,
  isUpstreamVersionCompatible,
  parseAgentConnectorManifest,
  RUN_EVENT_TYPES,
} = require('./agent-connector-manifest.cjs')
const { canonicalJson } = require('./outcome-records.cjs')
const { redactSecrets } = require('./secret-redaction.cjs')

const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const CREDENTIAL_REF = /^credential-ref:[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const MAX_REGISTRY_ITEMS = 128
const CONNECTOR_RUN_SNAPSHOT_VERSION = 1
const MAX_CONNECTOR_RUN_SNAPSHOT_BYTES = 256 * 1024

function registryError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function fail(code) {
  throw registryError(code)
}

function strictIdList(value, code) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_REGISTRY_ITEMS
      || value.some(item => typeof item !== 'string' || !PUBLIC_ID.test(item))
      || new Set(value).size !== value.length) {
    fail(code)
  }
  return [...value]
}

function strictManifestIdList(value) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_REGISTRY_ITEMS
      || value.some(item => !/^connector-manifest-[a-f0-9]{64}$/.test(String(item || '')))
      || new Set(value).size !== value.length) {
    fail('AGENT_CONNECTOR_REGISTRY_APPROVALS_INVALID')
  }
  return [...value]
}

function deepClone(value) {
  return JSON.parse(canonicalJson(value))
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const item of Object.values(value)) deepFreeze(item)
  return value
}

function uniqueList(schema, max = 32) {
  return z.array(schema).max(max).superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', message: 'duplicate connector capability' })
    }
  })
}

const publicIdSchema = z.string().min(1).max(120).regex(PUBLIC_ID)
const semanticVersionSchema = z.string().min(5).max(120).superRefine((value, context) => {
  if (!isSemanticVersion(value)) context.addIssue({ code: 'custom', message: 'invalid version' })
})
const credentialRefSchema = z.string().regex(CREDENTIAL_REF).superRefine((value, context) => {
  const opaqueId = value.slice('credential-ref:'.length)
  if (redactSecrets(opaqueId) !== opaqueId) {
    context.addIssue({ code: 'custom', message: 'secret value is not a CredentialRef' })
  }
})
const transportSchema = z.strictObject({
  type: z.enum(['cli', 'acp', 'http', 'a2a']),
  protocol: z.enum(['text', 'json', 'jsonl', 'acp', 'event-stream']),
})
const sessionSchema = z.strictObject({
  supported: z.boolean(),
  resume: z.boolean(),
  cancel: z.boolean(),
  checkpoint: z.boolean(),
})
const usageSchema = z.strictObject({
  inputTokens: z.boolean(),
  outputTokens: z.boolean(),
  costMicros: z.boolean(),
  toolCalls: z.boolean(),
  outboundBytes: z.boolean(),
  elapsedMs: z.boolean(),
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
const connectorRunSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(CONNECTOR_RUN_SNAPSHOT_VERSION),
  connectorId: publicIdSchema,
  connectorVersion: semanticVersionSchema,
  manifestId: z.string().regex(/^connector-manifest-[a-f0-9]{64}$/),
  instanceId: publicIdSchema,
  upstreamId: publicIdSchema,
  upstreamVersion: semanticVersionSchema,
  recipeId: publicIdSchema,
  transport: transportSchema,
  capabilities: z.strictObject({
    domains: uniqueList(publicIdSchema),
    session: sessionSchema,
    inputTypes: uniqueList(z.enum([
      'text', 'image', 'audio', 'video', 'file', 'structured-data',
    ]), 16),
    permissionModes: uniqueList(z.enum(['read-only', 'workspace-write']), 2),
    eventProtocolVersion: z.literal(1),
    eventTypes: uniqueList(z.enum(RUN_EVENT_TYPES), RUN_EVENT_TYPES.length),
    usage: usageSchema,
    outboundDestinations: uniqueList(outboundDestinationSchema, 16),
    idempotencyMode: z.enum(['none', 'durable']).optional(),
  }),
})

function parseConnectorRunSnapshot(input) {
  let value = input
  let serialized = null
  if (Buffer.isBuffer(input) || input instanceof Uint8Array || typeof input === 'string') {
    const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input)
    if (!bytes.length || bytes.length > MAX_CONNECTOR_RUN_SNAPSHOT_BYTES
        || !Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) {
      fail('AGENT_CONNECTOR_RUN_SNAPSHOT_INVALID')
    }
    serialized = bytes.toString('utf8')
    try {
      value = JSON.parse(serialized)
    } catch {
      fail('AGENT_CONNECTOR_RUN_SNAPSHOT_INVALID')
    }
  }
  const result = connectorRunSnapshotSchema.safeParse(value)
  if (!result.success) fail('AGENT_CONNECTOR_RUN_SNAPSHOT_INVALID')
  const canonical = canonicalJson(result.data)
  if (Buffer.byteLength(canonical) > MAX_CONNECTOR_RUN_SNAPSHOT_BYTES
      || (serialized !== null && serialized !== canonical)) {
    fail('AGENT_CONNECTOR_RUN_SNAPSHOT_INVALID')
  }
  return deepFreeze(JSON.parse(canonical))
}

const instanceSchema = z.strictObject({
  instanceId: z.string().min(1).max(120).regex(PUBLIC_ID),
  connectorId: z.string().min(1).max(120).regex(PUBLIC_ID),
  connectorVersion: z.string().min(5).max(120),
  upstreamVersion: z.string().min(5).max(120),
  label: z.string().min(1).max(120).superRefine((value, context) => {
    if (/[\u0000-\u001f\u007f]/.test(value) || redactSecrets(value) !== value) {
      context.addIssue({ code: 'custom', message: 'unsafe instance label' })
    }
  }),
  credentialRef: z.string().regex(CREDENTIAL_REF).nullable().superRefine((value, context) => {
    const opaqueId = value ? value.slice('credential-ref:'.length) : ''
    if (opaqueId && redactSecrets(opaqueId) !== opaqueId) {
      context.addIssue({ code: 'custom', message: 'secret value is not a CredentialRef' })
    }
  }),
}).superRefine((instance, context) => {
  if (!isSemanticVersion(instance.connectorVersion)
      || !isSemanticVersion(instance.upstreamVersion)) {
    context.addIssue({ code: 'custom', message: 'invalid instance version' })
  }
})

class AgentConnectorRegistry {
  constructor(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)
        || Object.keys(options).some(key => ![
          'approvedRecipeIds', 'approvedExternalManifestIds',
        ].includes(key))) {
      fail('AGENT_CONNECTOR_REGISTRY_OPTIONS_INVALID')
    }
    this.approvedRecipeIds = new Set(strictIdList(
      options.approvedRecipeIds,
      'AGENT_CONNECTOR_REGISTRY_RECIPES_INVALID',
    ))
    this.approvedExternalManifestIds = new Set(strictManifestIdList(
      options.approvedExternalManifestIds,
    ))
    this.manifests = new Map()
    this.instances = new Map()
  }

  manifestKey(connectorId, connectorVersion) {
    return `${connectorId}@${connectorVersion}`
  }

  registerBuiltin(input) {
    return this.registerManifest(input, 'builtin')
  }

  registerExternal(input) {
    return this.registerManifest(input, 'external')
  }

  registerManifest(input, trust) {
    const manifest = parseAgentConnectorManifest(input)
    if (!this.approvedRecipeIds.has(manifest.invocation.recipeId)) {
      fail('AGENT_CONNECTOR_RECIPE_UNAPPROVED')
    }
    if (trust === 'external' && !this.approvedExternalManifestIds.has(manifest.manifestId)) {
      fail('AGENT_CONNECTOR_MANIFEST_UNTRUSTED')
    }
    if (trust !== 'builtin' && trust !== 'external') {
      fail('AGENT_CONNECTOR_MANIFEST_UNTRUSTED')
    }
    if (this.manifests.size >= MAX_REGISTRY_ITEMS) fail('AGENT_CONNECTOR_REGISTRY_LIMIT')
    const key = this.manifestKey(manifest.connectorId, manifest.connectorVersion)
    const existing = this.manifests.get(key)
    if (existing) {
      if (existing.manifest.manifestId === manifest.manifestId && existing.trust === trust) {
        return deepFreeze(deepClone(existing.manifest))
      }
      fail('AGENT_CONNECTOR_MANIFEST_CONFLICT')
    }
    this.manifests.set(key, {
      manifest: deepFreeze(deepClone(manifest)),
      trust,
    })
    return deepFreeze(deepClone(manifest))
  }

  registerInstance(input) {
    const result = instanceSchema.safeParse(input)
    if (!result.success) fail('AGENT_CONNECTOR_INSTANCE_INVALID')
    const instance = result.data
    if (this.instances.has(instance.instanceId)) fail('AGENT_CONNECTOR_INSTANCE_CONFLICT')
    if (this.instances.size >= MAX_REGISTRY_ITEMS) fail('AGENT_CONNECTOR_REGISTRY_LIMIT')
    const registration = this.manifests.get(this.manifestKey(
      instance.connectorId,
      instance.connectorVersion,
    ))
    if (!registration) fail('AGENT_CONNECTOR_MANIFEST_NOT_REGISTERED')
    const { manifest } = registration
    if (!isUpstreamVersionCompatible(manifest, instance.upstreamVersion)) {
      fail('AGENT_CONNECTOR_UPSTREAM_INCOMPATIBLE')
    }
    const requiresCredential = manifest.credentials.mode === 'credential-ref'
    if (requiresCredential !== Boolean(instance.credentialRef)) {
      fail('AGENT_CONNECTOR_CREDENTIAL_REF_INVALID')
    }
    const stored = deepFreeze({
      ...deepClone(instance),
      manifestId: manifest.manifestId,
      upstreamId: manifest.upstream.id,
      trust: registration.trust,
    })
    this.instances.set(stored.instanceId, stored)
    return deepFreeze(deepClone(stored))
  }

  listManifests() {
    return [...this.manifests.values()]
      .map(({ manifest, trust }) => ({ ...deepClone(manifest), trust }))
      .sort((left, right) => (
        left.connectorId.localeCompare(right.connectorId)
        || left.connectorVersion.localeCompare(right.connectorVersion)
      ))
      .map(deepFreeze)
  }

  listInstances() {
    return [...this.instances.values()]
      .map(deepClone)
      .sort((left, right) => left.instanceId.localeCompare(right.instanceId))
      .map(deepFreeze)
  }

  resolveInstance(instanceId) {
    if (typeof instanceId !== 'string' || !PUBLIC_ID.test(instanceId)) {
      fail('AGENT_CONNECTOR_INSTANCE_INVALID')
    }
    const instance = this.instances.get(instanceId)
    if (!instance) fail('AGENT_CONNECTOR_INSTANCE_NOT_FOUND')
    const registration = this.manifests.get(this.manifestKey(
      instance.connectorId,
      instance.connectorVersion,
    ))
    if (!registration || registration.manifest.manifestId !== instance.manifestId) {
      fail('AGENT_CONNECTOR_MANIFEST_NOT_REGISTERED')
    }
    return deepFreeze({
      instance: deepClone(instance),
      manifest: deepClone(registration.manifest),
    })
  }

  runProvenance(instanceId) {
    const { instance, manifest } = this.resolveInstance(instanceId)
    return deepFreeze({
      protocolVersion: manifest.eventProtocolVersion,
      connectorId: manifest.connectorId,
      connectorVersion: manifest.connectorVersion,
      manifestId: manifest.manifestId,
      instanceId: instance.instanceId,
      upstreamId: manifest.upstream.id,
      upstreamVersion: instance.upstreamVersion,
    })
  }

  runSnapshot(instanceId) {
    const { instance, manifest } = this.resolveInstance(instanceId)
    return parseConnectorRunSnapshot({
      schemaVersion: CONNECTOR_RUN_SNAPSHOT_VERSION,
      connectorId: manifest.connectorId,
      connectorVersion: manifest.connectorVersion,
      manifestId: manifest.manifestId,
      instanceId: instance.instanceId,
      upstreamId: manifest.upstream.id,
      upstreamVersion: instance.upstreamVersion,
      recipeId: manifest.invocation.recipeId,
      transport: manifest.transport,
      capabilities: {
        domains: manifest.domains,
        session: manifest.session,
        inputTypes: manifest.inputTypes,
        permissionModes: manifest.permissionModes,
        eventProtocolVersion: manifest.eventProtocolVersion,
        eventTypes: manifest.eventTypes,
        usage: manifest.usage,
        outboundDestinations: manifest.outboundDestinations,
        idempotencyMode: manifest.invocation.idempotencyMode || 'none',
      },
    })
  }

  resolveExecution(instanceId) {
    const { instance, manifest } = this.resolveInstance(instanceId)
    return deepFreeze({
      recipeId: manifest.invocation.recipeId,
      transport: deepClone(manifest.transport),
      credentialRef: instance.credentialRef,
      provenance: this.runProvenance(instanceId),
      runtimeProvenance: {
        connectorId: manifest.connectorId,
        connectorVersion: manifest.connectorVersion,
        manifestId: manifest.manifestId,
        manifestSchemaVersion: manifest.schemaVersion,
        instanceId: instance.instanceId,
        recipeId: manifest.invocation.recipeId,
        upstreamId: manifest.upstream.id,
        upstreamVersion: instance.upstreamVersion,
        credentialRefId: instance.credentialRef,
      },
    })
  }
}

module.exports = {
  AgentConnectorRegistry,
  CONNECTOR_RUN_SNAPSHOT_VERSION,
  MAX_CONNECTOR_RUN_SNAPSHOT_BYTES,
  MAX_REGISTRY_ITEMS,
  parseConnectorRunSnapshot,
}
