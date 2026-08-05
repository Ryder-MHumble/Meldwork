const crypto = require('node:crypto')
const fs = require('node:fs')

const {
  normalizeChannelConnection,
  normalizeChannelSubscription,
  normalizeExternalActor,
  normalizeVerifiedChannelEvent,
} = require('./channel-ingress-contract.cjs')
const { canonicalJson } = require('./outcome-records.cjs')
const { atomicWritePrivateFile } = require('./private-file.cjs')
const { redactSecrets } = require('./secret-redaction.cjs')

const STORE_VERSION = 1
const MAX_STORE_BYTES = 8 * 1024 * 1024
const MAX_CONNECTIONS = 64
const MAX_ACTORS = 2048
const MAX_SUBSCRIPTIONS = 512
const MAX_DELIVERIES = 4096
const MAX_OUTBOUND = 4096
const MAX_TASK_MAPPINGS = 4096
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const OPAQUE_REF = /^[A-Za-z0-9][A-Za-z0-9._:+/=\-]{0,239}$/
const CONTENT_ID = /^(?:channel-delivery|channel-task|channel-outbound)-[a-f0-9]{64}$/
const DELIVERY_STATES = new Set(['queued', 'delivered'])
const OUTBOUND_STATES = new Set(['queued', 'sent'])

function storeError(code, cause) {
  const error = new Error(code)
  error.code = code
  if (cause) error.cause = cause
  return error
}

function fail(code) {
  throw storeError(code)
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

function cleanPublicId(value) {
  const text = String(value || '')
  return PUBLIC_ID.test(text) ? text : ''
}

function cleanOpaqueRef(value, required = true) {
  const text = String(value || '')
  if ((!text && !required) || OPAQUE_REF.test(text)) return text
  return ''
}

function validTimestamp(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum
}

function cleanErrorCode(value) {
  const text = String(value || '')
  return /^[A-Z][A-Z0-9_]{0,119}$/.test(text) ? text : 'CHANNEL_TASK_DELIVERY_FAILED'
}

function stableId(prefix, value) {
  return `${prefix}-${crypto.createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

function deliveryIdFor(connectionId, idempotencyKey) {
  return stableId('channel-delivery', { connectionId, idempotencyKey })
}

function taskMappingIdFor(connectionId, subscriptionId, taskKey) {
  return stableId('channel-task', { connectionId, subscriptionId, taskKey })
}

function outboundIdFor(deliveryId, replyKey) {
  return stableId('channel-outbound', { deliveryId, replyKey })
}

function advancesCursor(deliveries, current, candidate, candidateIndex) {
  if (!current || current.receivedAt < candidate.receivedAt) return true
  if (current.receivedAt > candidate.receivedAt) return false
  const currentIndex = deliveries.findIndex(item => item.deliveryId === current.deliveryId)
  return currentIndex < candidateIndex
}

function lifecycleRecord(input, normalized, code) {
  const createdAt = Number(input.createdAt)
  const updatedAt = Number(input.updatedAt)
  if (!validTimestamp(createdAt) || !validTimestamp(updatedAt, createdAt)) fail(code)
  return { ...normalized, createdAt, updatedAt }
}

function parseStoredConnection(input) {
  if (!exactKeys(input, new Set([
    'connectionId', 'connectorId', 'workspaceId', 'label', 'credentialRef', 'enabled',
    'createdAt', 'updatedAt',
  ]))) fail('CHANNEL_INBOX_STORE_INVALID')
  return lifecycleRecord(input, normalizeChannelConnection({
    connectionId: input.connectionId,
    connectorId: input.connectorId,
    workspaceId: input.workspaceId,
    label: input.label,
    credentialRef: input.credentialRef,
    enabled: input.enabled,
  }), 'CHANNEL_INBOX_STORE_INVALID')
}

function parseStoredActor(input) {
  if (!exactKeys(input, new Set([
    'actorId', 'connectionId', 'workspaceId', 'externalActorRef', 'displayName', 'actorType',
    'createdAt', 'updatedAt',
  ]))) fail('CHANNEL_INBOX_STORE_INVALID')
  return lifecycleRecord(input, normalizeExternalActor({
    actorId: input.actorId,
    connectionId: input.connectionId,
    workspaceId: input.workspaceId,
    externalActorRef: input.externalActorRef,
    displayName: input.displayName,
    actorType: input.actorType,
  }), 'CHANNEL_INBOX_STORE_INVALID')
}

function parseStoredSubscription(input) {
  if (!exactKeys(input, new Set([
    'subscriptionId', 'connectionId', 'workspaceId', 'externalScopeRef',
    'targetGroupId', 'eventKinds', 'enabled', 'createdAt', 'updatedAt',
  ]))) fail('CHANNEL_INBOX_STORE_INVALID')
  return lifecycleRecord(input, normalizeChannelSubscription({
    subscriptionId: input.subscriptionId,
    connectionId: input.connectionId,
    workspaceId: input.workspaceId,
    externalScopeRef: input.externalScopeRef,
    targetGroupId: input.targetGroupId,
    eventKinds: input.eventKinds,
    enabled: input.enabled,
  }), 'CHANNEL_INBOX_STORE_INVALID')
}

function parseTaskMapping(input) {
  if (!exactKeys(input, new Set([
    'mappingId', 'connectionId', 'subscriptionId', 'workspaceId', 'taskKey', 'taskId',
    'createdAt', 'updatedAt',
  ]))) fail('CHANNEL_INBOX_STORE_INVALID')
  const mapping = {
    mappingId: String(input.mappingId || ''),
    connectionId: cleanPublicId(input.connectionId),
    subscriptionId: cleanPublicId(input.subscriptionId),
    workspaceId: cleanPublicId(input.workspaceId),
    taskKey: cleanOpaqueRef(input.taskKey),
    taskId: cleanPublicId(input.taskId),
    createdAt: Number(input.createdAt),
    updatedAt: Number(input.updatedAt),
  }
  if (!CONTENT_ID.test(mapping.mappingId) || !mapping.connectionId || !mapping.subscriptionId
      || !mapping.workspaceId || !mapping.taskKey || !mapping.taskId
      || mapping.mappingId !== taskMappingIdFor(
        mapping.connectionId, mapping.subscriptionId, mapping.taskKey,
      ) || !validTimestamp(mapping.createdAt)
      || !validTimestamp(mapping.updatedAt, mapping.createdAt)) {
    fail('CHANNEL_INBOX_STORE_INVALID')
  }
  return mapping
}

function parseCursor(input) {
  if (!exactKeys(input, new Set([
    'subscriptionId', 'workspaceId', 'value', 'deliveryId', 'receivedAt', 'updatedAt',
  ]))) fail('CHANNEL_INBOX_STORE_INVALID')
  const cursor = {
    subscriptionId: cleanPublicId(input.subscriptionId),
    workspaceId: cleanPublicId(input.workspaceId),
    value: cleanOpaqueRef(input.value),
    deliveryId: String(input.deliveryId || ''),
    receivedAt: Number(input.receivedAt),
    updatedAt: Number(input.updatedAt),
  }
  if (!cursor.subscriptionId || !cursor.workspaceId || !cursor.value
      || !/^channel-delivery-[a-f0-9]{64}$/.test(cursor.deliveryId)
      || !validTimestamp(cursor.receivedAt) || !validTimestamp(cursor.updatedAt)) {
    fail('CHANNEL_INBOX_STORE_INVALID')
  }
  return cursor
}

function parseDelivery(input) {
  if (!exactKeys(input, new Set([
    'deliveryId', 'connectionId', 'connectorId', 'workspaceId', 'subscriptionId', 'actorId',
    'eventId', 'idempotencyKey', 'eventKind', 'cursor', 'replyRef', 'task', 'state',
    'attempts', 'taskId', 'taskAction', 'lastError', 'receivedAt', 'updatedAt', 'deliveredAt',
  ]))) fail('CHANNEL_INBOX_STORE_INVALID')
  const verified = normalizeVerifiedChannelEvent({
    eventId: input.eventId,
    idempotencyKey: input.idempotencyKey,
    subscriptionId: input.subscriptionId,
    externalActorRef: 'stored-actor-ref',
    eventKind: input.eventKind,
    signedAt: 0,
    cursor: input.cursor,
    replyRef: input.replyRef,
    task: input.task,
  })
  const delivery = {
    deliveryId: String(input.deliveryId || ''),
    connectionId: cleanPublicId(input.connectionId),
    connectorId: cleanPublicId(input.connectorId),
    workspaceId: cleanPublicId(input.workspaceId),
    subscriptionId: cleanPublicId(input.subscriptionId),
    actorId: cleanPublicId(input.actorId),
    eventId: verified.eventId,
    idempotencyKey: verified.idempotencyKey,
    eventKind: verified.eventKind,
    cursor: verified.cursor,
    replyRef: verified.replyRef,
    task: clone(verified.task),
    state: String(input.state || ''),
    attempts: Number(input.attempts),
    taskId: cleanPublicId(input.taskId),
    taskAction: String(input.taskAction || ''),
    lastError: String(input.lastError || ''),
    receivedAt: Number(input.receivedAt),
    updatedAt: Number(input.updatedAt),
    deliveredAt: Number(input.deliveredAt),
  }
  const delivered = delivery.state === 'delivered'
  if (!/^channel-delivery-[a-f0-9]{64}$/.test(delivery.deliveryId)
      || delivery.deliveryId !== deliveryIdFor(delivery.connectionId, delivery.idempotencyKey)
      || !delivery.connectionId || !delivery.connectorId || !delivery.workspaceId
      || !delivery.subscriptionId || !delivery.actorId || !DELIVERY_STATES.has(delivery.state)
      || !Number.isSafeInteger(delivery.attempts) || delivery.attempts < 0
      || (delivered !== Boolean(delivery.taskId))
      || (delivered !== ['created', 'updated'].includes(delivery.taskAction))
      || (delivery.lastError && cleanErrorCode(delivery.lastError) !== delivery.lastError)
      || !validTimestamp(delivery.receivedAt)
      || !validTimestamp(delivery.updatedAt, delivery.receivedAt)
      || (delivered ? !validTimestamp(delivery.deliveredAt, delivery.receivedAt)
        : delivery.deliveredAt !== 0)) {
    fail('CHANNEL_INBOX_STORE_INVALID')
  }
  return delivery
}

function parseOutbound(input) {
  if (!exactKeys(input, new Set([
    'outboundId', 'originDeliveryId', 'connectionId', 'connectorId', 'workspaceId',
    'taskId', 'replyKey', 'approvalRef', 'body', 'state', 'attempts', 'externalRef',
    'lastError', 'createdAt', 'updatedAt', 'sentAt',
  ]))) fail('CHANNEL_INBOX_STORE_INVALID')
  const outbound = {
    outboundId: String(input.outboundId || ''),
    originDeliveryId: String(input.originDeliveryId || ''),
    connectionId: cleanPublicId(input.connectionId),
    connectorId: cleanPublicId(input.connectorId),
    workspaceId: cleanPublicId(input.workspaceId),
    taskId: cleanPublicId(input.taskId),
    replyKey: cleanOpaqueRef(input.replyKey),
    approvalRef: cleanPublicId(input.approvalRef),
    body: String(input.body || ''),
    state: String(input.state || ''),
    attempts: Number(input.attempts),
    externalRef: cleanOpaqueRef(input.externalRef, false),
    lastError: String(input.lastError || ''),
    createdAt: Number(input.createdAt),
    updatedAt: Number(input.updatedAt),
    sentAt: Number(input.sentAt),
  }
  const sent = outbound.state === 'sent'
  if (!/^channel-outbound-[a-f0-9]{64}$/.test(outbound.outboundId)
      || outbound.outboundId !== outboundIdFor(outbound.originDeliveryId, outbound.replyKey)
      || !/^channel-delivery-[a-f0-9]{64}$/.test(outbound.originDeliveryId)
      || !outbound.connectionId || !outbound.connectorId || !outbound.workspaceId
      || !outbound.taskId || !outbound.replyKey || !outbound.approvalRef
      || !outbound.body || outbound.body.length > 24_000
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(outbound.body)
      || redactSecrets(outbound.body) !== outbound.body || !OUTBOUND_STATES.has(outbound.state)
      || !Number.isSafeInteger(outbound.attempts) || outbound.attempts < 0
      || (sent !== Boolean(outbound.externalRef))
      || (outbound.lastError && cleanErrorCode(outbound.lastError) !== outbound.lastError)
      || !validTimestamp(outbound.createdAt)
      || !validTimestamp(outbound.updatedAt, outbound.createdAt)
      || (sent ? !validTimestamp(outbound.sentAt, outbound.createdAt) : outbound.sentAt !== 0)) {
    fail('CHANNEL_INBOX_STORE_INVALID')
  }
  return outbound
}

function emptyState() {
  return {
    version: STORE_VERSION,
    connections: [],
    actors: [],
    subscriptions: [],
    cursors: [],
    taskMappings: [],
    deliveries: [],
    outbound: [],
  }
}

function parseState(input) {
  if (!exactKeys(input, new Set(Object.keys(emptyState()))) || input.version !== STORE_VERSION) {
    fail('CHANNEL_INBOX_STORE_INVALID')
  }
  const limits = [
    ['connections', MAX_CONNECTIONS, parseStoredConnection],
    ['actors', MAX_ACTORS, parseStoredActor],
    ['subscriptions', MAX_SUBSCRIPTIONS, parseStoredSubscription],
    ['cursors', MAX_SUBSCRIPTIONS, parseCursor],
    ['taskMappings', MAX_TASK_MAPPINGS, parseTaskMapping],
    ['deliveries', MAX_DELIVERIES, parseDelivery],
    ['outbound', MAX_OUTBOUND, parseOutbound],
  ]
  const state = { version: STORE_VERSION }
  for (const [field, limit, parser] of limits) {
    if (!Array.isArray(input[field]) || input[field].length > limit) {
      fail('CHANNEL_INBOX_STORE_INVALID')
    }
    state[field] = input[field].map(parser)
  }
  const uniqueFields = [
    ['connections', 'connectionId'], ['actors', 'actorId'],
    ['subscriptions', 'subscriptionId'], ['cursors', 'subscriptionId'],
    ['taskMappings', 'mappingId'], ['deliveries', 'deliveryId'], ['outbound', 'outboundId'],
  ]
  for (const [field, id] of uniqueFields) {
    if (new Set(state[field].map(record => record[id])).size !== state[field].length) {
      fail('CHANNEL_INBOX_STORE_INVALID')
    }
  }
  return state
}

class ChannelInboxStore {
  constructor(options = {}) {
    this.storagePath = typeof options.storagePath === 'string' ? options.storagePath.trim() : ''
    if (!this.storagePath) fail('CHANNEL_INBOX_STORE_PATH_REQUIRED')
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.loadError = null
    this.state = this.load()
  }

  timestamp() {
    const value = Number(this.now())
    return Number.isSafeInteger(value) && value >= 0 ? value : Date.now()
  }

  load() {
    try {
      if (!fs.existsSync(this.storagePath)) return emptyState()
      const stat = fs.lstatSync(this.storagePath)
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0 || stat.size > MAX_STORE_BYTES
          || (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600)) {
        fail('CHANNEL_INBOX_STORE_INVALID')
      }
      return parseState(JSON.parse(fs.readFileSync(this.storagePath, 'utf8')))
    } catch (error) {
      this.loadError = error instanceof Error ? error : storeError('CHANNEL_INBOX_STORE_INVALID')
      return emptyState()
    }
  }

  assertLoaded() {
    if (this.loadError) fail('CHANNEL_INBOX_STORE_UNAVAILABLE')
  }

  persist(next) {
    this.assertLoaded()
    const validated = parseState(next)
    const serialized = `${JSON.stringify(validated, null, 2)}\n`
    if (Buffer.byteLength(serialized) > MAX_STORE_BYTES) fail('CHANNEL_INBOX_STORE_LIMIT')
    try {
      atomicWritePrivateFile(this.storagePath, serialized)
    } catch (error) {
      throw storeError('CHANNEL_INBOX_STORE_UNAVAILABLE', error)
    }
    this.state = validated
  }

  upsertConfiguration(field, normalized, idField, fixedFields, limit) {
    this.assertLoaded()
    const now = this.timestamp()
    const index = this.state[field].findIndex(item => item[idField] === normalized[idField])
    if (index < 0) {
      if (this.state[field].length >= limit) fail('CHANNEL_INBOX_STORE_LIMIT')
      const next = clone(this.state)
      const record = { ...clone(normalized), createdAt: now, updatedAt: now }
      next[field].push(record)
      this.persist(next)
      return clone(record)
    }
    const current = this.state[field][index]
    if (fixedFields.some(key => current[key] !== normalized[key])) {
      fail('CHANNEL_CONFIGURATION_SCOPE_CONFLICT')
    }
    const currentConfiguration = Object.fromEntries(
      Object.keys(normalized).map(key => [key, current[key]]),
    )
    if (canonicalJson(currentConfiguration) === canonicalJson(normalized)) return clone(current)
    const next = clone(this.state)
    next[field][index] = { ...clone(normalized), createdAt: current.createdAt, updatedAt: now }
    this.persist(next)
    return clone(next[field][index])
  }

  putConnection(input) {
    return this.upsertConfiguration(
      'connections', normalizeChannelConnection(input), 'connectionId',
      ['connectionId', 'connectorId', 'workspaceId'], MAX_CONNECTIONS,
    )
  }

  putExternalActor(input) {
    const actor = normalizeExternalActor(input)
    const connection = this.connection(actor.connectionId)
    if (!connection || connection.workspaceId !== actor.workspaceId) {
      fail('CHANNEL_EXTERNAL_ACTOR_SCOPE_MISMATCH')
    }
    return this.upsertConfiguration(
      'actors', actor, 'actorId',
      ['actorId', 'connectionId', 'workspaceId', 'externalActorRef'], MAX_ACTORS,
    )
  }

  putSubscription(input) {
    const subscription = normalizeChannelSubscription(input)
    const connection = this.connection(subscription.connectionId)
    if (!connection || connection.workspaceId !== subscription.workspaceId) {
      fail('CHANNEL_SUBSCRIPTION_SCOPE_MISMATCH')
    }
    return this.upsertConfiguration(
      'subscriptions', subscription, 'subscriptionId',
      ['subscriptionId', 'connectionId', 'workspaceId', 'externalScopeRef'], MAX_SUBSCRIPTIONS,
    )
  }

  connection(connectionId) {
    const id = cleanPublicId(connectionId)
    const value = id ? this.state.connections.find(item => item.connectionId === id) : null
    return value ? clone(value) : null
  }

  subscription(subscriptionId) {
    const id = cleanPublicId(subscriptionId)
    const value = id ? this.state.subscriptions.find(item => item.subscriptionId === id) : null
    return value ? clone(value) : null
  }

  actorFor(connectionId, externalActorRef) {
    const value = this.state.actors.find(actor => (
      actor.connectionId === connectionId && actor.externalActorRef === externalActorRef
    ))
    return value ? clone(value) : null
  }

  listConnections(connectorId = '') {
    const id = connectorId ? cleanPublicId(connectorId) : ''
    return this.state.connections
      .filter(connection => !connectorId || connection.connectorId === id)
      .map(clone)
  }

  listSubscriptions(connectionId = '') {
    const id = connectionId ? cleanPublicId(connectionId) : ''
    return this.state.subscriptions
      .filter(subscription => !connectionId || subscription.connectionId === id)
      .map(clone)
  }

  cursorFor(subscriptionId) {
    const value = this.state.cursors.find(cursor => cursor.subscriptionId === subscriptionId)
    return value ? clone(value) : null
  }

  enqueueDelivery(input) {
    this.assertLoaded()
    if (!isRecord(input) || Reflect.ownKeys(input).some(key => ![
      'connectionId', 'actorId', 'event', 'receivedAt',
    ].includes(key))) fail('CHANNEL_DELIVERY_INVALID')
    const connection = this.connection(input.connectionId)
    const actor = this.state.actors.find(item => item.actorId === input.actorId)
    const event = normalizeVerifiedChannelEvent(input.event)
    const subscription = this.subscription(event.subscriptionId)
    const receivedAt = Number(input.receivedAt)
    if (!connection || !connection.enabled || !actor || !subscription || !subscription.enabled
        || actor.connectionId !== connection.connectionId
        || actor.workspaceId !== connection.workspaceId
        || actor.externalActorRef !== event.externalActorRef
        || subscription.connectionId !== connection.connectionId
        || subscription.workspaceId !== connection.workspaceId
        || !subscription.eventKinds.includes(event.eventKind)
        || !validTimestamp(receivedAt)) fail('CHANNEL_DELIVERY_SCOPE_MISMATCH')
    if (this.state.deliveries.some(delivery => (
      delivery.connectionId === connection.connectionId
      && (delivery.idempotencyKey === event.idempotencyKey || delivery.eventId === event.eventId)
    ))) fail('CHANNEL_EVENT_REPLAYED')
    if (this.state.deliveries.length >= MAX_DELIVERIES) fail('CHANNEL_INBOX_STORE_LIMIT')
    const delivery = {
      deliveryId: deliveryIdFor(connection.connectionId, event.idempotencyKey),
      connectionId: connection.connectionId,
      connectorId: connection.connectorId,
      workspaceId: connection.workspaceId,
      subscriptionId: subscription.subscriptionId,
      actorId: actor.actorId,
      eventId: event.eventId,
      idempotencyKey: event.idempotencyKey,
      eventKind: event.eventKind,
      cursor: event.cursor,
      replyRef: event.replyRef,
      task: clone(event.task),
      state: 'queued',
      attempts: 0,
      taskId: '',
      taskAction: '',
      lastError: '',
      receivedAt,
      updatedAt: receivedAt,
      deliveredAt: 0,
    }
    const next = clone(this.state)
    next.deliveries.push(delivery)
    this.persist(next)
    return clone(delivery)
  }

  delivery(deliveryId) {
    const value = this.state.deliveries.find(item => item.deliveryId === deliveryId)
    return value ? clone(value) : null
  }

  pendingDeliveries() {
    return this.state.deliveries
      .filter(delivery => delivery.state === 'queued')
      .sort((left, right) => left.receivedAt - right.receivedAt)
      .map(clone)
  }

  beginDeliveryAttempt(deliveryId) {
    return this.updateDelivery(deliveryId, (delivery, now) => ({
      ...delivery,
      attempts: delivery.attempts + 1,
      lastError: '',
      updatedAt: now,
    }))
  }

  recordDeliveryFailure(deliveryId, code) {
    return this.updateDelivery(deliveryId, (delivery, now) => ({
      ...delivery,
      lastError: cleanErrorCode(code),
      updatedAt: now,
    }))
  }

  updateDelivery(deliveryId, mutator) {
    this.assertLoaded()
    const index = this.state.deliveries.findIndex(item => item.deliveryId === deliveryId)
    if (index < 0) fail('CHANNEL_DELIVERY_NOT_FOUND')
    if (this.state.deliveries[index].state !== 'queued') {
      return clone(this.state.deliveries[index])
    }
    const next = clone(this.state)
    next.deliveries[index] = mutator(
      next.deliveries[index], Math.max(this.timestamp(), next.deliveries[index].receivedAt),
    )
    this.persist(next)
    return clone(next.deliveries[index])
  }

  taskMapping(delivery) {
    const value = this.state.taskMappings.find(mapping => (
      mapping.connectionId === delivery.connectionId
      && mapping.subscriptionId === delivery.subscriptionId
      && mapping.taskKey === delivery.task.taskKey
    ))
    return value ? clone(value) : null
  }

  completeDelivery(deliveryId, result) {
    this.assertLoaded()
    if (!isRecord(result) || Reflect.ownKeys(result).some(key => !['taskId', 'action'].includes(key))) {
      fail('CHANNEL_TASK_RESULT_INVALID')
    }
    const taskId = cleanPublicId(result.taskId)
    const action = String(result.action || '')
    if (!taskId || !['created', 'updated'].includes(action)) fail('CHANNEL_TASK_RESULT_INVALID')
    const next = clone(this.state)
    const index = next.deliveries.findIndex(item => item.deliveryId === deliveryId)
    if (index < 0) fail('CHANNEL_DELIVERY_NOT_FOUND')
    const delivery = next.deliveries[index]
    if (delivery.state === 'delivered') {
      if (delivery.taskId !== taskId) fail('CHANNEL_TASK_MAPPING_CONFLICT')
      return clone(delivery)
    }
    const mappingId = taskMappingIdFor(
      delivery.connectionId, delivery.subscriptionId, delivery.task.taskKey,
    )
    const mappingIndex = next.taskMappings.findIndex(item => item.mappingId === mappingId)
    const now = Math.max(this.timestamp(), delivery.receivedAt)
    if (mappingIndex >= 0 && next.taskMappings[mappingIndex].taskId !== taskId) {
      fail('CHANNEL_TASK_MAPPING_CONFLICT')
    }
    if (mappingIndex < 0) {
      if (next.taskMappings.length >= MAX_TASK_MAPPINGS) fail('CHANNEL_INBOX_STORE_LIMIT')
      next.taskMappings.push({
        mappingId,
        connectionId: delivery.connectionId,
        subscriptionId: delivery.subscriptionId,
        workspaceId: delivery.workspaceId,
        taskKey: delivery.task.taskKey,
        taskId,
        createdAt: now,
        updatedAt: now,
      })
    } else {
      next.taskMappings[mappingIndex].updatedAt = now
    }
    next.deliveries[index] = {
      ...delivery,
      state: 'delivered',
      taskId,
      taskAction: action,
      lastError: '',
      updatedAt: now,
      deliveredAt: now,
    }
    if (delivery.cursor) {
      const cursorIndex = next.cursors.findIndex(item => (
        item.subscriptionId === delivery.subscriptionId
      ))
      const current = cursorIndex >= 0 ? next.cursors[cursorIndex] : null
      if (advancesCursor(next.deliveries, current, delivery, index)) {
        const cursor = {
          subscriptionId: delivery.subscriptionId,
          workspaceId: delivery.workspaceId,
          value: delivery.cursor,
          deliveryId: delivery.deliveryId,
          receivedAt: delivery.receivedAt,
          updatedAt: now,
        }
        if (cursorIndex < 0) next.cursors.push(cursor)
        else next.cursors[cursorIndex] = cursor
      }
    }
    this.persist(next)
    return clone(next.deliveries[index])
  }

  queueOutbound(input) {
    this.assertLoaded()
    if (!exactKeys(input, new Set([
      'originDeliveryId', 'replyKey', 'approvalRef', 'body',
    ]))) fail('CHANNEL_OUTBOUND_INVALID')
    const delivery = this.delivery(input.originDeliveryId)
    const replyKey = cleanOpaqueRef(input.replyKey)
    const approvalRef = cleanPublicId(input.approvalRef)
    const body = String(input.body || '').trim()
    if (!delivery || delivery.state !== 'delivered' || !delivery.replyRef || !replyKey
        || !approvalRef || !body || body.length > 24_000
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body)
        || redactSecrets(body) !== body) fail('CHANNEL_OUTBOUND_INVALID')
    const outboundId = outboundIdFor(delivery.deliveryId, replyKey)
    const existing = this.state.outbound.find(item => item.outboundId === outboundId)
    if (existing) {
      if (existing.body !== body || existing.approvalRef !== approvalRef) {
        fail('CHANNEL_OUTBOUND_CONFLICT')
      }
      return clone(existing)
    }
    if (this.state.outbound.length >= MAX_OUTBOUND) fail('CHANNEL_INBOX_STORE_LIMIT')
    const now = this.timestamp()
    const outbound = {
      outboundId,
      originDeliveryId: delivery.deliveryId,
      connectionId: delivery.connectionId,
      connectorId: delivery.connectorId,
      workspaceId: delivery.workspaceId,
      taskId: delivery.taskId,
      replyKey,
      approvalRef,
      body,
      state: 'queued',
      attempts: 0,
      externalRef: '',
      lastError: '',
      createdAt: now,
      updatedAt: now,
      sentAt: 0,
    }
    const next = clone(this.state)
    next.outbound.push(outbound)
    this.persist(next)
    return clone(outbound)
  }

  outbound(outboundId) {
    const value = this.state.outbound.find(item => item.outboundId === outboundId)
    return value ? clone(value) : null
  }

  pendingOutbound() {
    return this.state.outbound
      .filter(item => item.state === 'queued')
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(clone)
  }

  beginOutboundAttempt(outboundId) {
    return this.updateOutbound(outboundId, (outbound, now) => ({
      ...outbound,
      attempts: outbound.attempts + 1,
      lastError: '',
      updatedAt: now,
    }))
  }

  recordOutboundFailure(outboundId, code) {
    return this.updateOutbound(outboundId, (outbound, now) => ({
      ...outbound,
      lastError: cleanErrorCode(code || 'CHANNEL_OUTBOUND_DELIVERY_FAILED'),
      updatedAt: now,
    }))
  }

  completeOutbound(outboundId, externalRef) {
    const normalizedRef = cleanOpaqueRef(externalRef)
    if (!normalizedRef) fail('CHANNEL_OUTBOUND_RESULT_INVALID')
    return this.updateOutbound(outboundId, (outbound, now) => ({
      ...outbound,
      state: 'sent',
      externalRef: normalizedRef,
      lastError: '',
      updatedAt: now,
      sentAt: now,
    }))
  }

  updateOutbound(outboundId, mutator) {
    this.assertLoaded()
    const index = this.state.outbound.findIndex(item => item.outboundId === outboundId)
    if (index < 0) fail('CHANNEL_OUTBOUND_NOT_FOUND')
    if (this.state.outbound[index].state === 'sent') return clone(this.state.outbound[index])
    const next = clone(this.state)
    next.outbound[index] = mutator(
      next.outbound[index], Math.max(this.timestamp(), next.outbound[index].createdAt),
    )
    this.persist(next)
    return clone(next.outbound[index])
  }

  snapshot() {
    this.assertLoaded()
    return clone(this.state)
  }
}

module.exports = {
  ChannelInboxStore,
  deliveryIdFor,
  outboundIdFor,
  taskMappingIdFor,
}
