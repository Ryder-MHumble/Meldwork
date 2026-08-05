const { canonicalJson } = require('./outcome-records.cjs')
const { redactSecrets } = require('./secret-redaction.cjs')

const CHANNEL_INGRESS_CONTRACT_VERSION = 1
const MAX_CHANNEL_EVENT_BYTES = 1024 * 1024
const MAX_CHANNEL_HEADERS = 64
const MAX_TASK_REQUEST_CHARS = 24_000
const MAX_TASK_CONTEXT_ITEMS = 12
const MAX_TASK_CONTEXT_CHARS = 2_000

const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const OPAQUE_REF = /^[A-Za-z0-9][A-Za-z0-9._:+/=\-]{0,239}$/
const CREDENTIAL_REF = /^credential-ref:[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const HEADER_NAME = /^[a-z0-9][a-z0-9-]{0,126}$/
const EVENT_KINDS = new Set(['task.created', 'task.updated'])
const CONNECTOR_FIELDS = new Set([
  'contractVersion', 'connectorId', 'verifyEvent', 'startReceiver', 'sendReply',
])

function contractError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function fail(code) {
  throw contractError(code)
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactKeys(value, allowed) {
  return isRecord(value)
    && Reflect.ownKeys(value).every(key => typeof key === 'string' && allowed.has(key))
}

function clone(value) {
  return JSON.parse(canonicalJson(value))
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const item of Object.values(value)) deepFreeze(item)
  return value
}

function cleanPublicId(value) {
  const text = String(value || '')
  return PUBLIC_ID.test(text) ? text : ''
}

function cleanOpaqueRef(value, required = true) {
  const text = String(value || '')
  if ((!text && !required) || OPAQUE_REF.test(text)) return text
  return ''
}

function cleanText(value, max, required = true) {
  const text = String(value || '').trim()
  if ((!text && !required) || (text && text.length <= max
      && !/[\u0000-\u001f\u007f]/.test(text) && redactSecrets(text) === text)) {
    return text
  }
  return ''
}

function normalizeCredentialRef(value) {
  if (value === null) return null
  const text = String(value || '')
  const opaque = text.startsWith('credential-ref:') ? text.slice('credential-ref:'.length) : ''
  if (!CREDENTIAL_REF.test(text) || redactSecrets(opaque) !== opaque) {
    fail('CHANNEL_CONNECTION_CREDENTIAL_REF_INVALID')
  }
  return text
}

function normalizeChannelConnection(input) {
  if (!exactKeys(input, new Set([
    'connectionId', 'connectorId', 'workspaceId', 'label', 'credentialRef', 'enabled',
  ]))) fail('CHANNEL_CONNECTION_INVALID')
  const connection = {
    connectionId: cleanPublicId(input.connectionId),
    connectorId: cleanPublicId(input.connectorId),
    workspaceId: cleanPublicId(input.workspaceId),
    label: cleanText(input.label, 120),
    credentialRef: normalizeCredentialRef(input.credentialRef ?? null),
    enabled: input.enabled === true,
  }
  if (!connection.connectionId || !connection.connectorId || !connection.workspaceId
      || !connection.label || typeof input.enabled !== 'boolean') {
    fail('CHANNEL_CONNECTION_INVALID')
  }
  return deepFreeze(connection)
}

function normalizeExternalActor(input) {
  if (!exactKeys(input, new Set([
    'actorId', 'connectionId', 'workspaceId', 'externalActorRef', 'displayName', 'actorType',
  ]))) fail('CHANNEL_EXTERNAL_ACTOR_INVALID')
  const actor = {
    actorId: cleanPublicId(input.actorId),
    connectionId: cleanPublicId(input.connectionId),
    workspaceId: cleanPublicId(input.workspaceId),
    externalActorRef: cleanOpaqueRef(input.externalActorRef),
    displayName: cleanText(input.displayName, 120),
    actorType: String(input.actorType || ''),
  }
  if (!actor.actorId || !actor.connectionId || !actor.workspaceId || !actor.externalActorRef
      || !actor.displayName || !['human', 'service'].includes(actor.actorType)) {
    fail('CHANNEL_EXTERNAL_ACTOR_INVALID')
  }
  return deepFreeze(actor)
}

function normalizeEventKinds(input) {
  if (!Array.isArray(input) || !input.length || input.length > EVENT_KINDS.size
      || input.some(kind => !EVENT_KINDS.has(kind)) || new Set(input).size !== input.length) {
    fail('CHANNEL_SUBSCRIPTION_INVALID')
  }
  return [...input].sort()
}

function normalizeChannelSubscription(input) {
  if (!exactKeys(input, new Set([
    'subscriptionId', 'connectionId', 'workspaceId', 'externalScopeRef',
    'targetGroupId', 'eventKinds', 'enabled',
  ]))) fail('CHANNEL_SUBSCRIPTION_INVALID')
  const subscription = {
    subscriptionId: cleanPublicId(input.subscriptionId),
    connectionId: cleanPublicId(input.connectionId),
    workspaceId: cleanPublicId(input.workspaceId),
    externalScopeRef: cleanOpaqueRef(input.externalScopeRef),
    targetGroupId: cleanPublicId(input.targetGroupId),
    eventKinds: normalizeEventKinds(input.eventKinds),
    enabled: input.enabled === true,
  }
  if (!subscription.subscriptionId || !subscription.connectionId || !subscription.workspaceId
      || !subscription.externalScopeRef || !subscription.targetGroupId
      || typeof input.enabled !== 'boolean') {
    fail('CHANNEL_SUBSCRIPTION_INVALID')
  }
  return deepFreeze(subscription)
}

function normalizeHeaders(input) {
  if (!isRecord(input) || Reflect.ownKeys(input).length > MAX_CHANNEL_HEADERS) {
    fail('CHANNEL_EVENT_ENVELOPE_INVALID')
  }
  const headers = {}
  for (const [rawName, rawValue] of Object.entries(input)) {
    const name = String(rawName).toLowerCase()
    const value = String(rawValue || '')
    if (!HEADER_NAME.test(name) || !value || value.length > 8192
        || /[\r\n\u0000]/.test(value) || Object.hasOwn(headers, name)) {
      fail('CHANNEL_EVENT_ENVELOPE_INVALID')
    }
    headers[name] = value
  }
  return Object.freeze(headers)
}

function normalizeChannelEnvelope(input) {
  if (!exactKeys(input, new Set(['connectionId', 'headers', 'body', 'receivedAt']))) {
    fail('CHANNEL_EVENT_ENVELOPE_INVALID')
  }
  const connectionId = cleanPublicId(input.connectionId)
  const receivedAt = Number(input.receivedAt)
  let body
  if (typeof input.body === 'string') body = Buffer.from(input.body, 'utf8')
  else if (Buffer.isBuffer(input.body) || input.body instanceof Uint8Array) body = Buffer.from(input.body)
  else fail('CHANNEL_EVENT_ENVELOPE_INVALID')
  if (!connectionId || !body.length || body.length > MAX_CHANNEL_EVENT_BYTES
      || !Number.isSafeInteger(receivedAt) || receivedAt < 0) {
    fail('CHANNEL_EVENT_ENVELOPE_INVALID')
  }
  return Object.freeze({
    connectionId,
    headers: normalizeHeaders(input.headers),
    body,
    receivedAt,
  })
}

function normalizeTaskContext(input) {
  if (input === undefined) return []
  if (!Array.isArray(input) || input.length > MAX_TASK_CONTEXT_ITEMS) {
    fail('CHANNEL_VERIFIED_EVENT_INVALID')
  }
  const context = input.map((entry) => {
    if (!exactKeys(entry, new Set(['label', 'value']))) {
      fail('CHANNEL_VERIFIED_EVENT_INVALID')
    }
    const normalized = {
      label: cleanText(entry.label, 120),
      value: cleanText(entry.value, MAX_TASK_CONTEXT_CHARS),
    }
    if (!normalized.label || !normalized.value) fail('CHANNEL_VERIFIED_EVENT_INVALID')
    return normalized
  })
  if (new Set(context.map(entry => entry.label)).size !== context.length) {
    fail('CHANNEL_VERIFIED_EVENT_INVALID')
  }
  return context
}

function normalizeTaskRequest(input) {
  if (!exactKeys(input, new Set(['taskKey', 'title', 'request', 'context']))) {
    fail('CHANNEL_VERIFIED_EVENT_INVALID')
  }
  const task = {
    taskKey: cleanOpaqueRef(input.taskKey),
    title: cleanText(input.title, 240),
    request: cleanText(input.request, MAX_TASK_REQUEST_CHARS),
    context: normalizeTaskContext(input.context),
  }
  if (!task.taskKey || !task.title || !task.request) fail('CHANNEL_VERIFIED_EVENT_INVALID')
  return task
}

function normalizeVerifiedChannelEvent(input) {
  if (!exactKeys(input, new Set([
    'eventId', 'idempotencyKey', 'subscriptionId', 'externalActorRef',
    'eventKind', 'signedAt', 'cursor', 'replyRef', 'task',
  ]))) fail('CHANNEL_VERIFIED_EVENT_INVALID')
  const event = {
    eventId: cleanOpaqueRef(input.eventId),
    idempotencyKey: cleanOpaqueRef(input.idempotencyKey),
    subscriptionId: cleanPublicId(input.subscriptionId),
    externalActorRef: cleanOpaqueRef(input.externalActorRef),
    eventKind: String(input.eventKind || ''),
    signedAt: Number(input.signedAt),
    cursor: cleanOpaqueRef(input.cursor, false),
    replyRef: cleanOpaqueRef(input.replyRef, false),
    task: normalizeTaskRequest(input.task),
  }
  if (!event.eventId || !event.idempotencyKey || !event.subscriptionId
      || !event.externalActorRef || !EVENT_KINDS.has(event.eventKind)
      || !Number.isSafeInteger(event.signedAt) || event.signedAt < 0) {
    fail('CHANNEL_VERIFIED_EVENT_INVALID')
  }
  return deepFreeze(event)
}

function normalizeChannelTaskResult(input) {
  if (!exactKeys(input, new Set(['taskId', 'action']))) {
    fail('CHANNEL_TASK_RESULT_INVALID')
  }
  const result = {
    taskId: cleanPublicId(input.taskId),
    action: String(input.action || ''),
  }
  if (!result.taskId || !['created', 'updated'].includes(result.action)) {
    fail('CHANNEL_TASK_RESULT_INVALID')
  }
  return deepFreeze(result)
}

function normalizeChannelOutboundResult(input) {
  if (!exactKeys(input, new Set(['externalRef']))) {
    fail('CHANNEL_OUTBOUND_RESULT_INVALID')
  }
  const result = { externalRef: cleanOpaqueRef(input.externalRef) }
  if (!result.externalRef) fail('CHANNEL_OUTBOUND_RESULT_INVALID')
  return deepFreeze(result)
}

function normalizeChannelConnector(input) {
  if (!isRecord(input)
      || Reflect.ownKeys(input).some(key => typeof key !== 'string' || !CONNECTOR_FIELDS.has(key))
      || input.contractVersion !== CHANNEL_INGRESS_CONTRACT_VERSION
      || !cleanPublicId(input.connectorId)
      || typeof input.verifyEvent !== 'function'
      || (input.startReceiver !== undefined && typeof input.startReceiver !== 'function')
      || (input.sendReply !== undefined && typeof input.sendReply !== 'function')) {
    fail('CHANNEL_CONNECTOR_INVALID')
  }
  const connector = {
    contractVersion: CHANNEL_INGRESS_CONTRACT_VERSION,
    connectorId: input.connectorId,
    verifyEvent: request => input.verifyEvent(request),
  }
  if (input.startReceiver) connector.startReceiver = request => input.startReceiver(request)
  if (input.sendReply) connector.sendReply = request => input.sendReply(request)
  return deepFreeze(connector)
}

module.exports = {
  CHANNEL_INGRESS_CONTRACT_VERSION,
  MAX_CHANNEL_EVENT_BYTES,
  MAX_TASK_CONTEXT_ITEMS,
  MAX_TASK_REQUEST_CHARS,
  normalizeChannelConnection,
  normalizeChannelConnector,
  normalizeChannelEnvelope,
  normalizeChannelOutboundResult,
  normalizeChannelSubscription,
  normalizeChannelTaskResult,
  normalizeExternalActor,
  normalizeVerifiedChannelEvent,
}
