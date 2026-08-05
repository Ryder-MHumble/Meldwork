const assert = require('node:assert/strict')
const test = require('node:test')

const {
  createRunEventState,
  parseConnectorRunEvent,
  parseRunEvent,
  parseRunEventState,
  reduceRunEvent,
  reduceRunEvents,
  serializeRunEvent,
  serializeRunEventState,
} = require('../src/run-event-protocol.cjs')

const MANIFEST_ID = `connector-manifest-${'a'.repeat(64)}`
const ARTIFACT_ID = `artifact-${'b'.repeat(64)}`
const EVIDENCE_ID = `evidence-${'c'.repeat(64)}`

const PROVENANCE = {
  protocolVersion: 1,
  connectorId: 'external.review-agent',
  connectorVersion: '1.0.0',
  manifestId: MANIFEST_ID,
  instanceId: 'review-account-a',
  upstreamId: 'review-service',
  upstreamVersion: '3.2.0',
  runId: 'run-1',
  agentRunId: 'agent-run-1',
}

function event(sequence, type, fields = {}) {
  return {
    ...PROVENANCE,
    eventId: `event-${sequence}`,
    cursor: `cursor-${sequence}`,
    sequence,
    type,
    ...fields,
  }
}

function sampleEvents() {
  return [
    event(0, 'SourceUsed', {
      sourceId: 'source-1',
      sourceType: 'workspace-file',
      contentHash: 'd'.repeat(64),
      citation: 'src/index.js:10',
    }),
    event(1, 'Artifact', { artifactId: ARTIFACT_ID }),
    event(2, 'Evidence', { evidenceId: EVIDENCE_ID }),
    event(3, 'Usage', {
      mode: 'delta',
      usage: { inputTokens: 10, toolCalls: 1 },
    }),
    event(4, 'Permission', {
      requestId: 'permission-1',
      permission: 'workspace-write',
      decision: 'requested',
      summary: 'Apply the reviewed change.',
    }),
    event(5, 'Permission', {
      requestId: 'permission-1',
      permission: 'workspace-write',
      decision: 'approved',
      summary: 'The user approved this operation.',
    }),
    event(6, 'WaitingInput', {
      requestId: 'question-1',
      prompt: 'Which target branch should receive the result?',
    }),
    event(7, 'Usage', {
      mode: 'cumulative',
      usage: { inputTokens: 12, outputTokens: 5, toolCalls: 2, elapsedMs: 900 },
    }),
    event(8, 'Completed', {
      outcome: 'completed',
      summary: 'The external Connector completed the review.',
    }),
  ]
}

test('round-trips every supported discriminated Run Event without field loss', () => {
  const events = [
    ...sampleEvents(),
    event(20, 'Failed', {
      code: 'LOCAL_AGENT_AUTH_REQUIRED',
      category: 'authentication',
      retryable: false,
      summary: 'Authentication is required.',
    }),
    event(21, 'Cancelled', {
      reason: 'user',
      summary: 'The user cancelled the run.',
    }),
  ]
  for (const input of events) {
    const parsed = parseRunEvent(JSON.stringify(input))
    assert.deepEqual(parsed, input)
    assert.deepEqual(parseRunEvent(serializeRunEvent(parsed)), input)
  }
})

test('rejects unknown fields, unsupported event types, and secret-like summaries', () => {
  assert.throws(
    () => parseRunEvent({ ...sampleEvents()[0], rawOutput: 'private' }),
    { message: 'RUN_EVENT_SCHEMA_INVALID' },
  )
  assert.throws(
    () => parseRunEvent(event(0, 'Progress', { summary: 'Working' })),
    { message: 'RUN_EVENT_SCHEMA_INVALID' },
  )
  assert.throws(
    () => parseRunEvent(event(0, 'Completed', {
      outcome: 'completed',
      summary: 'sk-abcdefghijklmnopqrstuvwxyz',
    })),
    { message: 'RUN_EVENT_SCHEMA_INVALID' },
  )
})

test('injects trusted provenance and durably summarizes unsupported Connector events', () => {
  const known = parseConnectorRunEvent({
    eventId: 'connector-event-1',
    cursor: 'connector-cursor-1',
    sequence: 1,
    type: 'Usage',
    mode: 'delta',
    usage: { inputTokens: 4 },
  }, PROVENANCE)
  assert.deepEqual(known, {
    ...PROVENANCE,
    eventId: 'connector-event-1',
    cursor: 'connector-cursor-1',
    sequence: 1,
    type: 'Usage',
    mode: 'delta',
    usage: { inputTokens: 4 },
  })

  const unknown = parseConnectorRunEvent({
    eventId: 'connector-event-2',
    cursor: 'connector-cursor-2',
    sequence: 2,
    type: 'Progress',
    rawOutput: 'Bearer private-connector-value',
    command: '/Users/private/connector --unsafe',
  }, PROVENANCE)
  assert.equal(unknown.type, 'Unknown')
  assert.equal(unknown.originalType, 'Progress')
  assert.match(unknown.payloadHash, /^[a-f0-9]{64}$/)
  assert.equal(Object.hasOwn(unknown, 'rawOutput'), false)
  assert.equal(Object.hasOwn(unknown, 'command'), false)
  assert.doesNotMatch(JSON.stringify(unknown), /private-connector-value|\/Users\/private/)

  const state = reduceRunEvents(createRunEventState(PROVENANCE), [unknown, known])
  const restarted = parseRunEventState(serializeRunEventState(state))
  assert.deepEqual(restarted, state)
  assert.equal(restarted.events[1].type, 'Unknown')
  assert.throws(
    () => parseConnectorRunEvent({
      ...known,
      runId: 'forged-run',
    }, PROVENANCE),
    { message: 'RUN_EVENT_PROVENANCE_MISMATCH' },
  )
  assert.throws(
    () => parseConnectorRunEvent({
      eventId: 'connector-event-3',
      cursor: 'connector-cursor-3',
      sequence: 3,
      type: 'Usage',
      mode: 'delta',
      usage: { inputTokens: 1 },
      rawOutput: 'unsupported known field',
    }, PROVENANCE),
    { message: 'RUN_EVENT_SCHEMA_INVALID' },
  )
})

test('reduces duplicate and out-of-order events to the same restart-stable state', () => {
  const events = sampleEvents()
  const initial = createRunEventState(PROVENANCE)
  const ordered = reduceRunEvents(initial, events)
  const outOfOrder = reduceRunEvents(initial, [
    events[8], events[3], events[6], events[0], events[5],
    events[2], events[7], events[1], events[4],
  ])
  assert.deepEqual(outOfOrder, ordered)
  assert.equal(ordered.status, 'completed')
  assert.equal(ordered.lastSequence, 8)
  assert.equal(ordered.cursor, 'cursor-8')
  assert.deepEqual(ordered.sourceIds, ['source-1'])
  assert.deepEqual(ordered.artifactIds, [ARTIFACT_ID])
  assert.deepEqual(ordered.evidenceIds, [EVIDENCE_ID])
  assert.deepEqual(ordered.usage, {
    inputTokens: 12,
    outputTokens: 5,
    costMicros: 0,
    toolCalls: 2,
    outboundBytes: 0,
    elapsedMs: 900,
  })
  assert.deepEqual(reduceRunEvent(ordered, events[3]), ordered)

  const beforeRestart = reduceRunEvents(initial, events.slice(0, 5))
  assert.equal(beforeRestart.status, 'waiting_permission')
  const restarted = parseRunEventState(serializeRunEventState(beforeRestart))
  const afterRestart = reduceRunEvents(restarted, events.slice(5))
  assert.deepEqual(afterRestart, ordered)
})

test('fails closed on conflicting identities, sequences, provenance, and post-terminal events', () => {
  const events = sampleEvents()
  const initial = createRunEventState(PROVENANCE)
  const first = reduceRunEvent(initial, events[0])
  assert.throws(
    () => reduceRunEvent(first, { ...events[0], cursor: 'cursor-conflict' }),
    { message: 'RUN_EVENT_ID_CONFLICT' },
  )
  assert.throws(
    () => reduceRunEvent(first, { ...events[1], sequence: 0 }),
    { message: 'RUN_EVENT_SEQUENCE_CONFLICT' },
  )
  assert.throws(
    () => reduceRunEvent(first, { ...events[1], runId: 'run-other' }),
    { message: 'RUN_EVENT_PROVENANCE_MISMATCH' },
  )
  const completed = reduceRunEvents(initial, events)
  assert.throws(
    () => reduceRunEvent(completed, event(9, 'Usage', {
      mode: 'delta', usage: { inputTokens: 1 },
    })),
    { message: 'RUN_EVENT_AFTER_TERMINAL' },
  )
  assert.throws(
    () => parseRunEventState({
      ...completed,
      usage: { ...completed.usage, inputTokens: 999 },
    }),
    { message: 'RUN_EVENT_STATE_MISMATCH' },
  )
})

test('derives typed Failed and Cancelled terminal states', () => {
  const initial = createRunEventState(PROVENANCE)
  const failed = reduceRunEvent(initial, event(0, 'Failed', {
    code: 'LOCAL_AGENT_PROCESS_FAILED',
    category: 'execution',
    retryable: false,
  }))
  assert.equal(failed.status, 'failed')
  const cancelled = reduceRunEvent(initial, event(0, 'Cancelled', { reason: 'user' }))
  assert.equal(cancelled.status, 'cancelled')
})
