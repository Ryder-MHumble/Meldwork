const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  CHANNEL_INGRESS_CONTRACT_VERSION,
} = require('../src/channel-ingress-contract.cjs')
const { ChannelInboxStore } = require('../src/channel-inbox-store.cjs')
const { ChannelIngressRuntime } = require('../src/channel-ingress-runtime.cjs')

function fixture(t, Store = ChannelInboxStore) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-channel-runtime-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let now = 10_000
  const storagePath = path.join(directory, 'private', 'channel-inbox.json')
  return {
    directory,
    storagePath,
    store: new Store({ storagePath, now: () => now }),
    now: () => now,
    setNow(value) { now = value },
  }
}

function configure(store) {
  store.putConnection({
    connectionId: 'connection-1', connectorId: 'channel.mock',
    workspaceId: 'workspace-local', label: 'Mock tasks',
    credentialRef: 'credential-ref:channel-1', enabled: true,
  })
  store.putExternalActor({
    actorId: 'actor-1', connectionId: 'connection-1', workspaceId: 'workspace-local',
    externalActorRef: 'actor-ref-1', displayName: 'Issue bot', actorType: 'service',
  })
  store.putSubscription({
    subscriptionId: 'subscription-1', connectionId: 'connection-1',
    workspaceId: 'workspace-local', externalScopeRef: 'repo-ref-1',
    targetGroupId: 'group-1', eventKinds: ['task.created', 'task.updated'], enabled: true,
  })
}

function event(overrides = {}) {
  return {
    eventId: 'event-1',
    idempotencyKey: 'delivery-1',
    subscriptionId: 'subscription-1',
    externalActorRef: 'actor-ref-1',
    eventKind: 'task.created',
    signedAt: 10_000,
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

function envelope(overrides = {}) {
  return {
    connectionId: 'connection-1',
    headers: { 'x-channel-signature': 'valid-signature' },
    body: Buffer.from('{"task":"issue-42"}'),
    receivedAt: 10_000,
    ...overrides,
  }
}

function connector(options = {}) {
  const calls = { receiver: [], verify: [], stop: 0, send: [] }
  let receive
  const value = {
    contractVersion: CHANNEL_INGRESS_CONTRACT_VERSION,
    connectorId: 'channel.mock',
    async verifyEvent(request) {
      calls.verify.push(request)
      if (request.envelope.headers['x-channel-signature'] !== 'valid-signature') {
        throw new Error('signature mismatch containing private details')
      }
      return typeof options.event === 'function' ? options.event(request) : event()
    },
  }
  if (options.receiver !== false) {
    value.startReceiver = async (request) => {
      calls.receiver.push(request)
      receive = request.receive
      return async () => { calls.stop += 1 }
    }
  }
  if (options.sendReply) {
    value.sendReply = async (request) => {
      calls.send.push(request)
      return options.sendReply(request, calls.send.length)
    }
  }
  return {
    connector: value,
    calls,
    receive: input => receive(input),
  }
}

test('does not start a background receiver when no Channel connection is configured', async (t) => {
  const value = fixture(t)
  const mock = connector()
  const runtime = new ChannelIngressRuntime({
    store: value.store, connectors: [mock.connector], now: value.now,
  })

  const status = await runtime.start()
  assert.equal(status.started, true)
  assert.equal(status.receiverCount, 0)
  assert.equal(mock.calls.receiver.length, 0)
  await runtime.shutdown()
})

test('queues a verified Inbox item while no renderer or Task sink exists', async (t) => {
  const value = fixture(t)
  configure(value.store)
  const mock = connector()
  const runtime = new ChannelIngressRuntime({
    store: value.store, connectors: [mock.connector], now: value.now,
  })

  const status = await runtime.start()
  assert.equal(status.receiverCount, 1)
  assert.equal(mock.calls.receiver[0].connections[0].workspaceId, 'workspace-local')
  const accepted = await mock.receive(envelope())
  assert.equal(accepted.state, 'queued')
  assert.equal(value.store.pendingDeliveries().length, 1)
  assert.equal(value.store.pendingDeliveries()[0].task.request, event().task.request)

  const persisted = fs.readFileSync(value.storagePath, 'utf8')
  assert.equal(persisted.includes('valid-signature'), false)
  assert.equal(persisted.includes('x-channel-signature'), false)
  assert.equal(persisted.includes('credential-ref:channel-1'), true)
  await runtime.shutdown()
  assert.equal(mock.calls.stop, 1)
})

test('rejects invalid, stale, cross-scope, and replayed signed events', async (t) => {
  const value = fixture(t)
  configure(value.store)
  const mock = connector()
  const taskCalls = []
  const runtime = new ChannelIngressRuntime({
    store: value.store,
    connectors: [mock.connector],
    taskSink: {
      upsert(request) {
        taskCalls.push(request)
        return { taskId: 'task-local-42', action: 'created' }
      },
    },
    now: value.now,
  })
  await runtime.start()

  await assert.rejects(
    runtime.receive('channel.mock', envelope({ headers: { 'x-channel-signature': 'invalid' } })),
    { message: 'CHANNEL_EVENT_AUTHENTICATION_FAILED' },
  )
  value.setNow(500_000)
  await assert.rejects(
    runtime.receive('channel.mock', envelope()),
    { message: 'CHANNEL_EVENT_EXPIRED' },
  )
  value.setNow(10_000)
  const accepted = await runtime.receive('channel.mock', envelope())
  assert.equal(accepted.state, 'delivered')
  assert.equal(taskCalls.length, 1)
  assert.deepEqual(Object.keys(taskCalls[0]).sort(), [
    'actor', 'deliveryId', 'existingTaskId', 'idempotencyKey', 'signal',
    'subscriptionId', 'targetGroupId', 'task', 'workspaceId',
  ])
  assert.equal(JSON.stringify(taskCalls[0]).includes('history'), false)
  await assert.rejects(
    runtime.receive('channel.mock', envelope()),
    { message: 'CHANNEL_EVENT_REPLAYED' },
  )
  await runtime.shutdown()
})

test('recovers a persisted Delivery with one Task creation after a completion crash', async (t) => {
  class CrashAfterTaskStore extends ChannelInboxStore {
    completeDelivery() {
      const error = new Error('SIMULATED_COMPLETION_CRASH')
      error.code = 'SIMULATED_COMPLETION_CRASH'
      throw error
    }
  }
  const value = fixture(t, CrashAfterTaskStore)
  configure(value.store)
  const mock = connector({ receiver: false })
  const tasks = new Map()
  let creates = 0
  let upserts = 0
  const taskSink = {
    upsert(request) {
      upserts += 1
      const existing = tasks.get(request.idempotencyKey)
      if (existing) return { taskId: existing, action: 'updated' }
      creates += 1
      tasks.set(request.idempotencyKey, 'task-local-42')
      return { taskId: 'task-local-42', action: 'created' }
    },
  }
  const first = new ChannelIngressRuntime({
    store: value.store, connectors: [mock.connector], taskSink, now: value.now,
  })
  await first.start()
  const queued = await first.receive('channel.mock', envelope())
  assert.equal(queued.state, 'queued')
  assert.equal(creates, 1)
  await first.shutdown()

  const restartedStore = new ChannelInboxStore({
    storagePath: value.storagePath, now: value.now,
  })
  const restarted = new ChannelIngressRuntime({
    store: restartedStore, connectors: [mock.connector], taskSink, now: value.now,
  })
  await restarted.start()
  assert.equal(creates, 1)
  assert.equal(upserts, 2)
  assert.equal(restartedStore.pendingDeliveries().length, 0)
  assert.equal(restartedStore.snapshot().taskMappings.length, 1)
  assert.equal(restartedStore.snapshot().taskMappings[0].taskId, 'task-local-42')
  await restarted.shutdown()
})

test('bounds shutdown when a receiver ignores AbortSignal and never stops', async (t) => {
  const value = fixture(t)
  configure(value.store)
  let receiverSignal
  const stubbornConnector = {
    contractVersion: CHANNEL_INGRESS_CONTRACT_VERSION,
    connectorId: 'channel.mock',
    verifyEvent: () => event(),
    startReceiver(request) {
      receiverSignal = request.signal
      return () => new Promise(() => {})
    },
  }
  const runtime = new ChannelIngressRuntime({
    store: value.store,
    connectors: [stubbornConnector],
    now: value.now,
    shutdownTimeoutMs: 100,
  })
  await runtime.start()

  const startedAt = Date.now()
  assert.equal(await runtime.shutdown(), true)
  const elapsedMs = Date.now() - startedAt
  assert.equal(receiverSignal.aborted, true)
  assert.equal(elapsedMs >= 80, true)
  assert.equal(elapsedMs < 1000, true)
  assert.equal(runtime.status().started, false)
})

test('retries an audited outbound reply after restart with the same idempotency key', async (t) => {
  const value = fixture(t)
  configure(value.store)
  let failFirst = true
  const mock = connector({
    receiver: false,
    sendReply(request) {
      if (failFirst) {
        failFirst = false
        const error = new Error('temporary')
        error.code = 'CHANNEL_TEMPORARY'
        throw error
      }
      return { externalRef: 'external-message-1' }
    },
  })
  const runtime = new ChannelIngressRuntime({
    store: value.store,
    connectors: [mock.connector],
    taskSink: { upsert: () => ({ taskId: 'task-local-42', action: 'created' }) },
    now: value.now,
  })
  await runtime.start()
  const received = await runtime.receive('channel.mock', envelope())
  const queued = await runtime.sendReply({
    originDeliveryId: received.delivery.deliveryId,
    replyKey: 'final-result-v1',
    approvalRef: 'approval-1',
    body: 'The build now passes all focused checks.',
  })
  assert.equal(queued.state, 'queued')
  assert.equal(mock.calls.send.length, 1)
  await runtime.shutdown()

  const restartedStore = new ChannelInboxStore({ storagePath: value.storagePath, now: value.now })
  const restarted = new ChannelIngressRuntime({
    store: restartedStore, connectors: [mock.connector], now: value.now,
  })
  await restarted.start()
  assert.equal(mock.calls.send.length, 2)
  assert.equal(mock.calls.send[0].idempotencyKey, mock.calls.send[1].idempotencyKey)
  assert.equal(mock.calls.send[1].originDeliveryId, received.delivery.deliveryId)
  assert.equal(mock.calls.send[1].approvalRef, 'approval-1')
  assert.equal(restartedStore.pendingOutbound().length, 0)
  assert.equal(restartedStore.snapshot().outbound[0].state, 'sent')
  await restarted.shutdown()
})
