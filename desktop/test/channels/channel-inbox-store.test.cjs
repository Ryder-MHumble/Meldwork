const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { ChannelInboxStore } = require('../../src/channels/channel-inbox-store.cjs')

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-channel-inbox-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let now = 1000
  const storagePath = path.join(directory, 'private', 'channel-inbox.json')
  const store = new ChannelInboxStore({ storagePath, now: () => now })
  return {
    directory,
    storagePath,
    store,
    setNow(value) { now = value },
  }
}

function configure(store) {
  const connection = store.putConnection({
    connectionId: 'connection-1',
    connectorId: 'channel.mock',
    workspaceId: 'workspace-local',
    label: 'Mock task channel',
    credentialRef: 'credential-ref:channel-1',
    enabled: true,
  })
  const actor = store.putExternalActor({
    actorId: 'actor-1',
    connectionId: connection.connectionId,
    workspaceId: connection.workspaceId,
    externalActorRef: 'actor-ref-1',
    displayName: 'Release automation',
    actorType: 'service',
  })
  const subscription = store.putSubscription({
    subscriptionId: 'subscription-1',
    connectionId: connection.connectionId,
    workspaceId: connection.workspaceId,
    externalScopeRef: 'repository-1',
    targetGroupId: 'group-1',
    eventKinds: ['task.created', 'task.updated'],
    enabled: true,
  })
  return { connection, actor, subscription }
}

function event(overrides = {}) {
  return {
    eventId: 'event-1',
    idempotencyKey: 'idempotency-1',
    subscriptionId: 'subscription-1',
    externalActorRef: 'actor-ref-1',
    eventKind: 'task.created',
    signedAt: 1000,
    cursor: 'cursor-1',
    replyRef: 'reply-thread-1',
    task: {
      taskKey: 'issue-42',
      title: 'Fix the build',
      request: 'Diagnose the failure and report the verified result.',
      context: [{ label: 'branch', value: 'feature/harness-runtime-trace' }],
    },
    ...overrides,
  }
}

test('persists scoped Channel configuration privately and rejects scope reassignment', (t) => {
  const value = fixture(t)
  configure(value.store)

  assert.equal(fs.statSync(value.storagePath).mode & 0o777, 0o600)
  assert.throws(
    () => value.store.putExternalActor({
      actorId: 'actor-2', connectionId: 'connection-1', workspaceId: 'workspace-other',
      externalActorRef: 'actor-ref-2', displayName: 'Other actor', actorType: 'human',
    }),
    { message: 'CHANNEL_EXTERNAL_ACTOR_SCOPE_MISMATCH' },
  )
  assert.throws(
    () => value.store.putConnection({
      connectionId: 'connection-1', connectorId: 'channel.mock',
      workspaceId: 'workspace-other', label: 'Moved', credentialRef: null, enabled: true,
    }),
    { message: 'CHANNEL_CONFIGURATION_SCOPE_CONFLICT' },
  )

  const restarted = new ChannelInboxStore({ storagePath: value.storagePath, now: () => 1200 })
  assert.equal(restarted.connection('connection-1').workspaceId, 'workspace-local')
  assert.equal(restarted.actorFor('connection-1', 'actor-ref-1').actorId, 'actor-1')
  assert.equal(restarted.subscription('subscription-1').targetGroupId, 'group-1')
})

test('rejects replayed deliveries and atomically commits Task mapping with Cursor', (t) => {
  const value = fixture(t)
  const { actor } = configure(value.store)
  const delivery = value.store.enqueueDelivery({
    connectionId: 'connection-1', actorId: actor.actorId, event: event(), receivedAt: 1000,
  })

  assert.equal(delivery.state, 'queued')
  assert.equal(value.store.beginDeliveryAttempt(delivery.deliveryId).attempts, 1)
  assert.equal(
    value.store.recordDeliveryFailure(delivery.deliveryId, 'TASK_SINK_TEMPORARY').lastError,
    'TASK_SINK_TEMPORARY',
  )
  assert.throws(
    () => value.store.enqueueDelivery({
      connectionId: 'connection-1', actorId: actor.actorId, event: event(), receivedAt: 1050,
    }),
    { message: 'CHANNEL_EVENT_REPLAYED' },
  )
  assert.throws(
    () => value.store.enqueueDelivery({
      connectionId: 'connection-1', actorId: actor.actorId,
      event: event({ idempotencyKey: 'idempotency-forged' }), receivedAt: 1050,
    }),
    { message: 'CHANNEL_EVENT_REPLAYED' },
  )

  value.setNow(1100)
  const completed = value.store.completeDelivery(delivery.deliveryId, {
    taskId: 'task-local-42', action: 'created',
  })
  assert.equal(completed.state, 'delivered')
  assert.equal(value.store.taskMapping(completed).taskId, 'task-local-42')
  assert.deepEqual(value.store.cursorFor('subscription-1'), {
    subscriptionId: 'subscription-1',
    workspaceId: 'workspace-local',
    value: 'cursor-1',
    deliveryId: delivery.deliveryId,
    receivedAt: 1000,
    updatedAt: 1100,
  })

  const restarted = new ChannelInboxStore({ storagePath: value.storagePath, now: () => 1200 })
  assert.equal(restarted.pendingDeliveries().length, 0)
  assert.equal(restarted.delivery(delivery.deliveryId).taskId, 'task-local-42')
})

test('updates the same mapped Task and never regresses a Cursor on out-of-order completion', (t) => {
  const value = fixture(t)
  const { actor } = configure(value.store)
  const older = value.store.enqueueDelivery({
    connectionId: 'connection-1', actorId: actor.actorId,
    event: event({ eventId: 'event-old', idempotencyKey: 'delivery-old', cursor: 'cursor-old' }),
    receivedAt: 1000,
  })
  const newer = value.store.enqueueDelivery({
    connectionId: 'connection-1', actorId: actor.actorId,
    event: event({
      eventId: 'event-new', idempotencyKey: 'delivery-new', eventKind: 'task.updated',
      cursor: 'cursor-new', task: { ...event().task, request: 'Use the new reproduction.' },
    }),
    receivedAt: 1100,
  })

  value.setNow(1200)
  value.store.completeDelivery(newer.deliveryId, { taskId: 'task-local-42', action: 'created' })
  value.store.completeDelivery(older.deliveryId, { taskId: 'task-local-42', action: 'updated' })

  assert.equal(value.store.cursorFor('subscription-1').value, 'cursor-new')
  assert.equal(value.store.taskMapping(older).taskId, 'task-local-42')
})

test('same-timestamp Deliveries advance Cursor by durable enqueue order', (t) => {
  const value = fixture(t)
  const { actor } = configure(value.store)
  const first = value.store.enqueueDelivery({
    connectionId: 'connection-1', actorId: actor.actorId,
    event: event({
      eventId: 'event-same-first',
      idempotencyKey: 'delivery-same-first',
      cursor: 'cursor-same-first',
    }),
    receivedAt: 1000,
  })
  const second = value.store.enqueueDelivery({
    connectionId: 'connection-1', actorId: actor.actorId,
    event: event({
      eventId: 'event-same-second',
      idempotencyKey: 'delivery-same-second',
      eventKind: 'task.updated',
      cursor: 'cursor-same-second',
      task: { ...event().task, request: 'Use the later same-timestamp event.' },
    }),
    receivedAt: 1000,
  })

  value.setNow(1100)
  const completedSecond = value.store.completeDelivery(second.deliveryId, {
    taskId: 'task-local-42', action: 'created',
  })
  assert.equal(value.store.cursorFor('subscription-1').deliveryId, second.deliveryId)
  assert.deepEqual(
    value.store.completeDelivery(second.deliveryId, {
      taskId: 'task-local-42', action: 'created',
    }),
    completedSecond,
  )
  assert.throws(
    () => value.store.enqueueDelivery({
      connectionId: 'connection-1', actorId: actor.actorId,
      event: event({
        eventId: 'event-same-second', idempotencyKey: 'delivery-same-second',
      }),
      receivedAt: 1000,
    }),
    { message: 'CHANNEL_EVENT_REPLAYED' },
  )

  const restarted = new ChannelInboxStore({ storagePath: value.storagePath, now: () => 1200 })
  restarted.completeDelivery(first.deliveryId, { taskId: 'task-local-42', action: 'updated' })

  assert.deepEqual(restarted.cursorFor('subscription-1'), {
    subscriptionId: 'subscription-1',
    workspaceId: 'workspace-local',
    value: 'cursor-same-second',
    deliveryId: second.deliveryId,
    receivedAt: 1000,
    updatedAt: 1100,
  })
  assert.equal(restarted.pendingDeliveries().length, 0)
})

test('queues approved outbound replies against the originating Delivery and audits retries', (t) => {
  const value = fixture(t)
  const { actor } = configure(value.store)
  const delivery = value.store.enqueueDelivery({
    connectionId: 'connection-1', actorId: actor.actorId, event: event(), receivedAt: 1000,
  })
  value.store.completeDelivery(delivery.deliveryId, {
    taskId: 'task-local-42', action: 'created',
  })
  value.setNow(1200)
  const outbound = value.store.queueOutbound({
    originDeliveryId: delivery.deliveryId,
    replyKey: 'final-result-v1',
    approvalRef: 'approval-1',
    body: 'The build now passes all focused tests.',
  })
  assert.equal(outbound.originDeliveryId, delivery.deliveryId)
  assert.equal(outbound.state, 'queued')
  assert.deepEqual(value.store.queueOutbound({
    originDeliveryId: delivery.deliveryId,
    replyKey: 'final-result-v1',
    approvalRef: 'approval-1',
    body: 'The build now passes all focused tests.',
  }), outbound)
  assert.equal(value.store.beginOutboundAttempt(outbound.outboundId).attempts, 1)
  assert.equal(
    value.store.recordOutboundFailure(outbound.outboundId, 'CHANNEL_TEMPORARY').lastError,
    'CHANNEL_TEMPORARY',
  )
  value.setNow(1300)
  const sent = value.store.completeOutbound(outbound.outboundId, 'external-message-1')
  assert.equal(sent.state, 'sent')
  assert.equal(sent.externalRef, 'external-message-1')
  assert.equal(sent.approvalRef, 'approval-1')
  assert.throws(
    () => value.store.queueOutbound({
      originDeliveryId: delivery.deliveryId, replyKey: 'secret-result',
      approvalRef: 'approval-2', body: 'authorization=sk-abcdefghijklmnopqrstuvwxyz',
    }),
    { message: 'CHANNEL_OUTBOUND_INVALID' },
  )
})

test('keeps a malformed Inbox unavailable instead of overwriting it', (t) => {
  const value = fixture(t)
  fs.mkdirSync(path.dirname(value.storagePath), { recursive: true })
  fs.writeFileSync(value.storagePath, '{"version":1,"connections":[{"raw":"secret"}]}')
  fs.chmodSync(value.storagePath, 0o600)
  const store = new ChannelInboxStore({ storagePath: value.storagePath })

  assert.equal(store.loadError instanceof Error, true)
  assert.throws(
    () => store.putConnection({
      connectionId: 'connection-1', connectorId: 'channel.mock',
      workspaceId: 'workspace-local', label: 'Mock', credentialRef: null, enabled: true,
    }),
    { message: 'CHANNEL_INBOX_STORE_UNAVAILABLE' },
  )
  assert.match(fs.readFileSync(value.storagePath, 'utf8'), /"raw":"secret"/)
})
