const {
  normalizeChannelConnector,
  normalizeChannelEnvelope,
  normalizeChannelOutboundResult,
  normalizeChannelTaskResult,
  normalizeVerifiedChannelEvent,
} = require('./channel-ingress-contract.cjs')
const { ChannelInboxStore } = require('./channel-inbox-store.cjs')
const { canonicalJson } = require('./outcome-records.cjs')

const DEFAULT_MAX_EVENT_AGE_MS = 5 * 60 * 1000
const MAX_EVENT_AGE_MS = 60 * 60 * 1000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/

function runtimeError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function fail(code) {
  throw runtimeError(code)
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function clone(value) {
  return JSON.parse(canonicalJson(value))
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value) || ArrayBuffer.isView(value)) {
    return value
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) return value
  Object.freeze(value)
  for (const item of Object.values(value)) deepFreeze(item)
  return value
}

function safeErrorCode(error, fallback) {
  const code = String(error?.code || error?.message || '')
  return /^[A-Z][A-Z0-9_]{0,119}$/.test(code) ? code : fallback
}

function normalizeTaskSink(input, required = false) {
  if (input == null && !required) return null
  if (!isRecord(input) || typeof input.upsert !== 'function') {
    fail('CHANNEL_TASK_SINK_INVALID')
  }
  return Object.freeze({ upsert: request => input.upsert(request) })
}

function normalizeReceiverStop(value) {
  if (typeof value === 'function') return value
  if (isRecord(value) && typeof value.stop === 'function') return () => value.stop()
  fail('CHANNEL_RECEIVER_START_RESULT_INVALID')
}

class ChannelIngressRuntime {
  constructor(options = {}) {
    if (!(options.store instanceof ChannelInboxStore)) fail('CHANNEL_INBOX_STORE_REQUIRED')
    if (options.connectors !== undefined && !Array.isArray(options.connectors)) {
      fail('CHANNEL_CONNECTORS_INVALID')
    }
    this.store = options.store
    this.taskSink = normalizeTaskSink(options.taskSink)
    this.now = typeof options.now === 'function' ? options.now : Date.now
    const requestedAge = Number(options.maxEventAgeMs)
    this.maxEventAgeMs = Number.isFinite(requestedAge)
      ? Math.max(1000, Math.min(MAX_EVENT_AGE_MS, Math.floor(requestedAge)))
      : DEFAULT_MAX_EVENT_AGE_MS
    const requestedShutdownTimeout = Number(options.shutdownTimeoutMs)
    this.shutdownTimeoutMs = Number.isFinite(requestedShutdownTimeout)
      ? Math.max(100, Math.min(30_000, Math.floor(requestedShutdownTimeout)))
      : DEFAULT_SHUTDOWN_TIMEOUT_MS
    this.connectors = new Map()
    this.receiverStops = []
    this.deliveryInflight = new Map()
    this.outboundInflight = new Map()
    this.started = false
    this.stopping = false
    this.abortController = null
    for (const connector of options.connectors || []) this.registerConnector(connector)
  }

  timestamp() {
    const value = Number(this.now())
    return Number.isSafeInteger(value) && value >= 0 ? value : Date.now()
  }

  registerConnector(input) {
    const connector = normalizeChannelConnector(input)
    if (this.started || this.connectors.has(connector.connectorId)) {
      fail('CHANNEL_CONNECTOR_CONFLICT')
    }
    this.connectors.set(connector.connectorId, connector)
    return Object.freeze({
      contractVersion: connector.contractVersion,
      connectorId: connector.connectorId,
      receiver: typeof connector.startReceiver === 'function',
      outbound: typeof connector.sendReply === 'function',
    })
  }

  setTaskSink(input) {
    this.taskSink = normalizeTaskSink(input, true)
    return true
  }

  connector(connectorId) {
    const id = String(connectorId || '')
    const connector = PUBLIC_ID.test(id) ? this.connectors.get(id) : null
    if (!connector) fail('CHANNEL_CONNECTOR_UNAVAILABLE')
    return connector
  }

  async start() {
    if (this.started) return this.status()
    this.started = true
    this.stopping = false
    this.abortController = new AbortController()
    try {
      await this.drainInbox()
      await this.flushOutbound()
      for (const connector of this.connectors.values()) {
        if (typeof connector.startReceiver !== 'function') continue
        const connections = this.store.listConnections(connector.connectorId)
          .filter(connection => connection.enabled)
        if (!connections.length) continue
        const connectionIds = new Set(connections.map(connection => connection.connectionId))
        const subscriptions = this.store.listSubscriptions()
          .filter(subscription => subscription.enabled
            && connectionIds.has(subscription.connectionId))
        const cursors = subscriptions
          .map(subscription => this.store.cursorFor(subscription.subscriptionId))
          .filter(Boolean)
        const stop = normalizeReceiverStop(await connector.startReceiver(deepFreeze({
          connections: clone(connections),
          subscriptions: clone(subscriptions),
          cursors: clone(cursors),
          signal: this.abortController.signal,
          receive: envelope => this.receive(connector.connectorId, envelope),
        })))
        this.receiverStops.push(stop)
      }
      return this.status()
    } catch (error) {
      await this.shutdown()
      throw error
    }
  }

  async shutdown() {
    if (!this.started && !this.receiverStops.length) return false
    this.stopping = true
    this.abortController?.abort()
    const stops = this.receiverStops.splice(0).reverse()
    const pending = Promise.allSettled([
      ...stops.map(stop => Promise.resolve().then(() => stop())),
      ...this.deliveryInflight.values(),
      ...this.outboundInflight.values(),
    ])
    let timer
    await Promise.race([
      pending,
      new Promise(resolve => { timer = setTimeout(resolve, this.shutdownTimeoutMs) }),
    ])
    if (timer) clearTimeout(timer)
    this.deliveryInflight.clear()
    this.outboundInflight.clear()
    this.started = false
    this.stopping = false
    this.abortController = null
    return true
  }

  status() {
    return Object.freeze({
      started: this.started,
      connectorIds: [...this.connectors.keys()].sort(),
      receiverCount: this.receiverStops.length,
      queuedDeliveries: this.store.pendingDeliveries().length,
      queuedOutbound: this.store.pendingOutbound().length,
    })
  }

  assertRunning() {
    if (!this.started || this.stopping) fail('CHANNEL_INGRESS_NOT_RUNNING')
  }

  async receive(connectorId, input) {
    this.assertRunning()
    const connector = this.connector(connectorId)
    const envelope = normalizeChannelEnvelope(input)
    const connection = this.store.connection(envelope.connectionId)
    if (!connection || !connection.enabled || connection.connectorId !== connector.connectorId) {
      fail('CHANNEL_CONNECTION_UNAVAILABLE')
    }
    let event
    try {
      event = normalizeVerifiedChannelEvent(await connector.verifyEvent(deepFreeze({
        connection: clone(connection),
        envelope,
        signal: this.abortController.signal,
      })))
    } catch {
      fail('CHANNEL_EVENT_AUTHENTICATION_FAILED')
    }
    const now = this.timestamp()
    if (Math.abs(now - event.signedAt) > this.maxEventAgeMs
        || Math.abs(now - envelope.receivedAt) > this.maxEventAgeMs
        || Math.abs(envelope.receivedAt - event.signedAt) > this.maxEventAgeMs) {
      fail('CHANNEL_EVENT_EXPIRED')
    }
    const subscription = this.store.subscription(event.subscriptionId)
    const actor = this.store.actorFor(connection.connectionId, event.externalActorRef)
    if (!subscription || !subscription.enabled || !actor
        || subscription.connectionId !== connection.connectionId
        || subscription.workspaceId !== connection.workspaceId) {
      fail('CHANNEL_EVENT_SCOPE_MISMATCH')
    }
    const delivery = this.store.enqueueDelivery({
      connectionId: connection.connectionId,
      actorId: actor.actorId,
      event,
      receivedAt: envelope.receivedAt,
    })
    if (!this.taskSink) return deepFreeze({ accepted: true, state: 'queued', delivery })
    try {
      const processed = await this.processDelivery(delivery.deliveryId)
      return deepFreeze({ accepted: true, state: processed.state, delivery: processed })
    } catch (error) {
      return deepFreeze({
        accepted: true,
        state: 'queued',
        delivery: this.store.delivery(delivery.deliveryId),
        errorCode: safeErrorCode(error, 'CHANNEL_TASK_DELIVERY_FAILED'),
      })
    }
  }

  processDelivery(deliveryId) {
    const existing = this.deliveryInflight.get(deliveryId)
    if (existing) return existing
    const pending = this.processDeliveryOnce(deliveryId)
      .finally(() => this.deliveryInflight.delete(deliveryId))
    this.deliveryInflight.set(deliveryId, pending)
    return pending
  }

  async processDeliveryOnce(deliveryId) {
    const delivery = this.store.delivery(deliveryId)
    if (!delivery) fail('CHANNEL_DELIVERY_NOT_FOUND')
    if (delivery.state === 'delivered' || !this.taskSink) return delivery
    const subscription = this.store.subscription(delivery.subscriptionId)
    const actor = this.store.snapshot().actors.find(item => item.actorId === delivery.actorId)
    if (!subscription || !actor || !subscription.enabled) fail('CHANNEL_DELIVERY_SCOPE_MISMATCH')
    const mapping = this.store.taskMapping(delivery)
    this.store.beginDeliveryAttempt(delivery.deliveryId)
    try {
      const result = normalizeChannelTaskResult(await this.taskSink.upsert(deepFreeze({
        deliveryId: delivery.deliveryId,
        idempotencyKey: delivery.deliveryId,
        workspaceId: delivery.workspaceId,
        subscriptionId: delivery.subscriptionId,
        targetGroupId: subscription.targetGroupId,
        actor: {
          actorId: actor.actorId,
          displayName: actor.displayName,
          actorType: actor.actorType,
        },
        existingTaskId: mapping?.taskId || '',
        task: clone(delivery.task),
        signal: this.abortController?.signal,
      })))
      return this.store.completeDelivery(delivery.deliveryId, result)
    } catch (error) {
      const code = safeErrorCode(error, 'CHANNEL_TASK_DELIVERY_FAILED')
      try { this.store.recordDeliveryFailure(delivery.deliveryId, code) } catch { /* retain original */ }
      throw runtimeError(code)
    }
  }

  async drainInbox() {
    const results = []
    if (!this.taskSink) return results
    for (const delivery of this.store.pendingDeliveries()) {
      try {
        results.push(await this.processDelivery(delivery.deliveryId))
      } catch {
        results.push(this.store.delivery(delivery.deliveryId))
      }
    }
    return results
  }

  async sendReply(input) {
    this.assertRunning()
    if (!isRecord(input)) fail('CHANNEL_OUTBOUND_INVALID')
    const delivery = this.store.delivery(input.originDeliveryId)
    if (!delivery) fail('CHANNEL_DELIVERY_NOT_FOUND')
    const connector = this.connector(delivery.connectorId)
    if (typeof connector.sendReply !== 'function') fail('CHANNEL_OUTBOUND_UNSUPPORTED')
    const outbound = this.store.queueOutbound(input)
    if (outbound.state === 'sent') return outbound
    try {
      return await this.deliverOutbound(outbound.outboundId)
    } catch {
      return this.store.outbound(outbound.outboundId)
    }
  }

  deliverOutbound(outboundId) {
    const existing = this.outboundInflight.get(outboundId)
    if (existing) return existing
    const pending = this.deliverOutboundOnce(outboundId)
      .finally(() => this.outboundInflight.delete(outboundId))
    this.outboundInflight.set(outboundId, pending)
    return pending
  }

  async deliverOutboundOnce(outboundId) {
    const outbound = this.store.outbound(outboundId)
    if (!outbound) fail('CHANNEL_OUTBOUND_NOT_FOUND')
    if (outbound.state === 'sent') return outbound
    const delivery = this.store.delivery(outbound.originDeliveryId)
    const connection = this.store.connection(outbound.connectionId)
    const connector = this.connector(outbound.connectorId)
    if (!delivery || delivery.state !== 'delivered' || !connection || !connection.enabled
        || typeof connector.sendReply !== 'function') fail('CHANNEL_OUTBOUND_UNAVAILABLE')
    this.store.beginOutboundAttempt(outbound.outboundId)
    try {
      const result = normalizeChannelOutboundResult(await connector.sendReply(deepFreeze({
        connection: clone(connection),
        outboundId: outbound.outboundId,
        idempotencyKey: outbound.outboundId,
        originDeliveryId: delivery.deliveryId,
        replyRef: delivery.replyRef,
        taskId: outbound.taskId,
        approvalRef: outbound.approvalRef,
        body: outbound.body,
        signal: this.abortController?.signal,
      })))
      return this.store.completeOutbound(outbound.outboundId, result.externalRef)
    } catch (error) {
      const code = safeErrorCode(error, 'CHANNEL_OUTBOUND_DELIVERY_FAILED')
      try { this.store.recordOutboundFailure(outbound.outboundId, code) } catch { /* retain original */ }
      throw runtimeError(code)
    }
  }

  async flushOutbound() {
    const results = []
    for (const outbound of this.store.pendingOutbound()) {
      try {
        results.push(await this.deliverOutbound(outbound.outboundId))
      } catch {
        results.push(this.store.outbound(outbound.outboundId))
      }
    }
    return results
  }
}

module.exports = {
  ChannelIngressRuntime,
  DEFAULT_MAX_EVENT_AGE_MS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
}
