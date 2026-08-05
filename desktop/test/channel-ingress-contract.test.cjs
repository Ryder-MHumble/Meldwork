const assert = require('node:assert/strict')
const test = require('node:test')

const {
  CHANNEL_INGRESS_CONTRACT_VERSION,
  MAX_CHANNEL_EVENT_BYTES,
  MAX_TASK_CONTEXT_ITEMS,
  normalizeChannelConnection,
  normalizeChannelConnector,
  normalizeChannelEnvelope,
  normalizeChannelSubscription,
  normalizeExternalActor,
  normalizeVerifiedChannelEvent,
} = require('../src/channel-ingress-contract.cjs')

function verifiedEvent(overrides = {}) {
  return {
    eventId: 'event-123',
    idempotencyKey: 'delivery-123',
    subscriptionId: 'subscription-1',
    externalActorRef: 'actor-ref-1',
    eventKind: 'task.created',
    signedAt: 1000,
    cursor: 'cursor-1',
    replyRef: 'thread-1',
    task: {
      taskKey: 'issue-42',
      title: 'Fix the failing build',
      request: 'Diagnose the build failure and report the verified result.',
      context: [{ label: 'repository', value: 'Ryder-MHumble/Meldwork' }],
    },
    ...overrides,
  }
}

test('normalizes explicitly scoped Channel connection, actor, and subscription records', () => {
  const connection = normalizeChannelConnection({
    connectionId: 'connection-1',
    connectorId: 'channel.mock',
    workspaceId: 'workspace-local',
    label: 'Mock tasks',
    credentialRef: 'credential-ref:channel-1',
    enabled: true,
  })
  const actor = normalizeExternalActor({
    actorId: 'actor-1',
    connectionId: connection.connectionId,
    workspaceId: connection.workspaceId,
    externalActorRef: 'actor-ref-1',
    displayName: 'Release automation',
    actorType: 'service',
  })
  const subscription = normalizeChannelSubscription({
    subscriptionId: 'subscription-1',
    connectionId: connection.connectionId,
    workspaceId: connection.workspaceId,
    externalScopeRef: 'repo-ref-1',
    targetGroupId: 'group-1',
    eventKinds: ['task.updated', 'task.created'],
    enabled: true,
  })

  assert.equal(connection.credentialRef, 'credential-ref:channel-1')
  assert.equal(actor.workspaceId, connection.workspaceId)
  assert.deepEqual(subscription.eventKinds, ['task.created', 'task.updated'])
  assert.equal(Object.isFrozen(subscription), true)
  assert.throws(
    () => normalizeChannelConnection({
      ...connection,
      credentialRef: 'credential-ref:sk-abcdefghijklmnopqrstuvwxyz',
    }),
    { message: 'CHANNEL_CONNECTION_CREDENTIAL_REF_INVALID' },
  )
})

test('bounds raw signed envelopes without interpreting or persisting signature headers', () => {
  const envelope = normalizeChannelEnvelope({
    connectionId: 'connection-1',
    headers: { 'X-Channel-Signature': 'sha256=opaque-signature' },
    body: Buffer.from('{"action":"created"}'),
    receivedAt: 1000,
  })

  assert.deepEqual(Object.keys(envelope.headers), ['x-channel-signature'])
  assert.equal(envelope.body.toString(), '{"action":"created"}')
  assert.throws(
    () => normalizeChannelEnvelope({
      connectionId: 'connection-1', headers: {},
      body: Buffer.alloc(MAX_CHANNEL_EVENT_BYTES + 1), receivedAt: 1000,
    }),
    { message: 'CHANNEL_EVENT_ENVELOPE_INVALID' },
  )
  assert.throws(
    () => normalizeChannelEnvelope({
      connectionId: 'connection-1', headers: { 'x-test': 'ok\r\nforged: true' },
      body: 'payload', receivedAt: 1000,
    }),
    { message: 'CHANNEL_EVENT_ENVELOPE_INVALID' },
  )
})

test('accepts only bounded Task requests and rejects copied IM history shapes', () => {
  const event = normalizeVerifiedChannelEvent(verifiedEvent())
  assert.equal(event.task.request, verifiedEvent().task.request)
  assert.equal(Object.hasOwn(event.task, 'history'), false)

  assert.throws(
    () => normalizeVerifiedChannelEvent(verifiedEvent({
      task: { ...verifiedEvent().task, history: [{ role: 'user', content: 'entire chat' }] },
    })),
    { message: 'CHANNEL_VERIFIED_EVENT_INVALID' },
  )
  assert.throws(
    () => normalizeVerifiedChannelEvent(verifiedEvent({
      task: {
        ...verifiedEvent().task,
        context: Array.from({ length: MAX_TASK_CONTEXT_ITEMS + 1 }, (_, index) => ({
          label: `item-${index}`,
          value: 'bounded',
        })),
      },
    })),
    { message: 'CHANNEL_VERIFIED_EVENT_INVALID' },
  )
})

test('requires a main-process connector to verify events and keeps receiver/outbound optional', () => {
  const connector = normalizeChannelConnector({
    contractVersion: CHANNEL_INGRESS_CONTRACT_VERSION,
    connectorId: 'channel.mock',
    verifyEvent: request => request,
  })

  assert.equal(connector.connectorId, 'channel.mock')
  assert.equal(connector.startReceiver, undefined)
  assert.throws(
    () => normalizeChannelConnector({
      contractVersion: CHANNEL_INGRESS_CONTRACT_VERSION,
      connectorId: 'channel.mock',
      verifyEvent: null,
    }),
    { message: 'CHANNEL_CONNECTOR_INVALID' },
  )
})
