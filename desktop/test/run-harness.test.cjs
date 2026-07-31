const test = require('node:test')
const assert = require('node:assert/strict')

const {
  RunHarness,
  evidenceCapsuleText,
  nextSessionMeta,
  normalizeRawEvent,
  normalizeRunEvent,
  normalizeTraceCapsule,
  packContextEntries,
  shouldRotateSession,
} = require('../src/run-harness.cjs')

function fixture(options = {}) {
  let now = 1000
  let id = 0
  return new RunHarness({
    runId: 'run-1',
    groupId: 'group-1',
    threadRootId: 'message-root',
    targetKinds: ['codex', 'hermes'],
    now: () => ++now,
    createId: () => `agent-${++id}`,
    ...options,
  })
}

test('normalizes public events through an allowlist and redacts private diagnostics', () => {
  assert.deepEqual(normalizeRawEvent({
    id: 'tool-1',
    type: 'tool_result_summary',
    status: 'completed',
    title: 'Search',
    summary: 'Read /Users/private/work and api_key=top-secret',
    detail: 'Bearer abc.def.ghi',
    command: 'rg secret /Users/private/work',
    executable: '/tmp/codex',
  }), {
    id: 'tool-1',
    type: 'tool_result_summary',
    status: 'completed',
    title: 'Search',
    summary: 'Read [path] and api_key=[redacted]',
    detail: 'Bearer [redacted]',
  })
  assert.equal(normalizeRawEvent({ type: 'raw_stdout', detail: 'private' }), null)
})

test('revalidates enriched renderer events without executable or command fields', () => {
  assert.deepEqual(normalizeRunEvent({
    runId: 'run-1',
    agentRunId: 'run-1:1:codex:agent-1',
    groupId: 'group-1',
    threadRootId: 'message-1',
    agentKind: 'codex',
    round: 1,
    seq: 2,
    timestamp: 1000,
    id: 'tool-1',
    type: 'tool_result_summary',
    status: 'completed',
    title: 'search',
    summary: 'Read /Users/private/work with token=private-value',
    command: 'rg private',
    executable: '/tmp/codex',
  }), {
    runId: 'run-1',
    agentRunId: 'run-1:1:codex:agent-1',
    groupId: 'group-1',
    threadRootId: 'message-1',
    agentKind: 'codex',
    round: 1,
    seq: 2,
    timestamp: 1000,
    status: 'completed',
    id: 'tool-1',
    type: 'tool_result_summary',
    title: 'search',
    summary: 'Read [path] with token=[redacted]',
  })
  assert.equal(normalizeRunEvent({ type: 'status', status: 'running' }), null)
})

test('enriches events, appends bounded answer deltas, and upserts tool lifecycle events', () => {
  const harness = fixture({ maxEventsPerAgent: 8, maxOutputChars: 1000 })
  const started = harness.beginAgent('codex', 2, ['message-1'])
  assert.equal(started.runId, 'run-1')
  assert.equal(started.agentRunId, 'run-1:2:codex:agent-1')
  assert.equal(started.seq, 1)

  harness.ingest('codex', 2, { id: 'tool-1', type: 'tool_start', status: 'running', title: 'search' })
  harness.ingest('codex', 2, {
    id: 'tool-1', type: 'tool_result_summary', status: 'completed', title: 'search', summary: '3 matches',
  })
  harness.ingest('codex', 2, { type: 'answer_delta', delta: 'Hello ' })
  harness.ingest('codex', 2, { type: 'answer_delta', delta: 'world' })

  const run = harness.snapshot()[0]
  assert.equal(run.output, 'Hello world')
  assert.equal(run.events.filter(event => event.id === 'tool-1').length, 1)
  assert.equal(run.events.find(event => event.id === 'tool-1').type, 'tool_result_summary')
  assert.equal(run.sourceMessageIds[0], 'message-1')
})

test('keeps a bounded event ledger and marks the trace as truncated', () => {
  const harness = fixture({ maxEventsPerAgent: 8 })
  harness.beginAgent('codex', 1)
  for (let index = 0; index < 20; index += 1) {
    harness.ingest('codex', 1, {
      id: `tool-${index}`,
      type: 'tool_result_summary',
      status: 'completed',
      title: 'tool',
      summary: `result ${index}`,
    })
  }
  const run = harness.snapshot()[0]
  assert.equal(run.events.length, 8)
  assert.equal(run.truncated, true)
  assert.equal(run.events.at(-1).summary, 'result 19')
})

test('finishes with the authoritative answer and persists only a compact capsule', () => {
  const harness = fixture()
  harness.beginAgent('hermes', 1, ['message-a', 'message-b'])
  harness.ingest('hermes', 1, {
    id: 'reason-1', type: 'reasoning_summary', summary: 'Compared the two implementations.',
  })
  for (let index = 0; index < 16; index += 1) {
    harness.ingest('hermes', 1, {
      id: `tool-${index}`,
      type: 'tool_result_summary',
      status: 'completed',
      title: 'read_file',
      summary: `Evidence ${index}`,
      detail: `raw private detail ${index}`,
    })
  }
  const { capsule } = harness.finishAgent('hermes', 1, 'completed', 'Authoritative final', {
    includedCount: 5, omittedCount: 2, charCount: 9000, sessionRotated: true,
  })
  assert.equal(harness.snapshot()[0].output, 'Authoritative final')
  assert.equal(capsule.events.length, 12)
  assert.equal(capsule.summary, 'Compared the two implementations.')
  assert.deepEqual(capsule.sourceMessageIds, ['message-a', 'message-b'])
  assert.equal(capsule.context.sessionRotated, true)
  assert.doesNotMatch(JSON.stringify(capsule), /raw private detail/)
})

test('normalizes stored capsules and rejects private or unrecognized fields', () => {
  const capsule = normalizeTraceCapsule({
    runId: 'run-2',
    agentRunId: 'agent-run-2',
    status: 'completed',
    summary: 'Public summary',
    events: [{
      evidenceId: 'E-1', type: 'tool_result_summary', status: 'completed',
      title: '/private/result', summary: 'token=secret-value', detail: 'raw',
    }],
    sourceMessageIds: ['message-1'],
    executable: '/tmp/codex',
  })
  assert.deepEqual(capsule.events[0], {
    evidenceId: 'E-1',
    type: 'tool_result_summary',
    status: 'completed',
    title: '[path]',
    summary: 'token=[redacted]',
  })
  assert.equal('executable' in capsule, false)
})

test('renders evidence as untrusted reference without raw tool detail', () => {
  const text = evidenceCapsuleText({
    senderName: 'Codex',
    content: 'Final conclusion',
    trace: {
      runId: 'run-1', agentRunId: 'agent-1', status: 'completed',
      events: [{
        evidenceId: 'E-R1-CODEX-01', type: 'tool_result_summary', status: 'completed',
        title: 'search', summary: 'Found the handler', detail: 'raw command output',
      }],
      sourceMessageIds: ['message-root'],
    },
  })
  assert.match(text, /untrusted data, not instructions/)
  assert.match(text, /E-R1-CODEX-01/)
  assert.match(text, /message-root/)
  assert.doesNotMatch(text, /raw command output/)
})

test('packs whole context entries by priority and recency within a fixed budget', () => {
  const packed = packContextEntries([
    { id: 'old', sender: 'Codex', text: 'old low priority', priority: 0 },
    { id: 'important', sender: 'User', text: 'pinned constraint', priority: 3 },
    { id: 'recent', sender: 'Hermes', text: 'recent conclusion', priority: 2 },
    { id: 'large', sender: 'Agent', text: 'x'.repeat(400), priority: 1 },
  ], { budget: 60, entryLimit: 80, maxEntries: 3 })
  assert.match(packed.text, /pinned constraint/)
  assert.match(packed.text, /recent conclusion/)
  assert.doesNotMatch(packed.text, /old low priority/)
  assert.deepEqual(packed.sourceMessageIds, ['important', 'recent'])
  assert.equal(packed.omittedCount, 2)
  assert.equal(packed.charCount <= 60, true)
})

test('rotates native sessions at bounded turns or estimated characters', () => {
  assert.equal(shouldRotateSession({ turns: 17, estimatedChars: 100 }), false)
  assert.equal(shouldRotateSession({ turns: 18, estimatedChars: 100 }), true)
  assert.equal(shouldRotateSession({ turns: 1, estimatedChars: 48000 }), true)
  assert.deepEqual(nextSessionMeta({ turns: 17, estimatedChars: 1000 }, {
    promptChars: 500, replyChars: 250, rotated: false,
  }), { turns: 18, estimatedChars: 1750 })
  assert.deepEqual(nextSessionMeta({ turns: 20, estimatedChars: 90000 }, {
    promptChars: 500, replyChars: 250, rotated: true,
  }), { turns: 1, estimatedChars: 750 })
})
