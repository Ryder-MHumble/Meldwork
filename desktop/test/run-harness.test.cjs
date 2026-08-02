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
    summary: 'Read [path] and credential=[redacted]',
    detail: 'Bearer [redacted]',
  })
  assert.equal(normalizeRawEvent({ type: 'raw_stdout', detail: 'private' }), null)

  const credentials = normalizeRawEvent({
    type: 'tool_result_summary',
    detail: JSON.stringify({
      env: {
        AWS_ACCESS_KEY_ID: 'AKIA1234567890ABCDEF',
        AWS_SECRET_ACCESS_KEY: 'aws-secret-value',
        DATABASE_URL: 'postgres://dbuser:dbpass@localhost/db',
        password: 'hunter2',
        certificate: '-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----',
      },
    }),
  })
  assert.doesNotMatch(JSON.stringify(credentials), /AKIA|aws-secret-value|dbuser|dbpass|hunter2|private-material/)
  assert.match(credentials.detail, /redacted/)
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
    summary: 'Read [path] with credential=[redacted]',
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

test('rejects stale callbacks after a newer Agent run starts for the same kind and round', () => {
  const harness = fixture()
  const first = harness.beginAgent('codex', 1)
  const second = harness.beginAgent('codex', 1)

  assert.equal(harness.ingest('codex', 1, {
    id: 'stale-tool', type: 'tool_start', status: 'running', title: 'search',
  }, first.agentRunId), null)
  assert.equal(harness.markSilent('codex', 1, first.agentRunId), null)
  assert.throws(
    () => harness.finishAgent('codex', 1, 'completed', 'stale', {}, first.agentRunId),
    { message: 'RUN_HARNESS_AGENT_NOT_FOUND' },
  )

  const current = harness.ingest('codex', 1, {
    id: 'current-tool', type: 'tool_start', status: 'running', title: 'search',
  }, second.agentRunId)
  assert.equal(current.agentRunId, second.agentRunId)
  assert.equal(harness.snapshot().at(-1).events.some(event => event.id === 'stale-tool'), false)
})

test('rejects Agent activity outside the declared target kinds', () => {
  const harness = fixture({ targetKinds: ['codex'] })

  assert.throws(
    () => harness.beginAgent('hermes', 1),
    { message: 'RUN_HARNESS_AGENT_NOT_TARGETED' },
  )

  const codex = harness.beginAgent('codex', 1)
  assert.equal(harness.ingest('hermes', 1, {
    id: 'cross-target-tool', type: 'tool_start', status: 'running', title: 'search',
  }, codex.agentRunId), null)
  assert.deepEqual(harness.snapshot().map(run => run.kind), ['codex'])
  assert.equal(harness.snapshot()[0].events.some(event => event.id === 'cross-target-tool'), false)
})

test('deduplicates identical live tool events without dropping lifecycle updates', () => {
  const harness = fixture()
  const started = harness.beginAgent('codex', 1)
  const toolStarted = harness.ingest('codex', 1, {
    id: 'tool-1', type: 'tool_start', status: 'running', title: 'search',
  })
  const duplicate = harness.ingest('codex', 1, {
    id: 'tool-1', type: 'tool_start', status: 'running', title: 'search',
  })
  const richer = harness.ingest('codex', 1, {
    id: 'tool-1', type: 'tool_start', status: 'running', title: 'search',
    summary: 'Searching the workspace',
  })
  const completed = harness.ingest('codex', 1, {
    id: 'tool-1', type: 'tool_result_summary', status: 'completed', title: 'search',
    summary: '3 matches',
  })

  assert.equal(duplicate, null)
  assert.equal(richer.seq, toolStarted.seq + 1)
  assert.equal(completed.seq, richer.seq + 1)
  const run = harness.snapshot()[0]
  assert.deepEqual(run.seenSeqs, [started.seq, toolStarted.seq, richer.seq, completed.seq])
  assert.equal(run.events.filter(event => event.id === 'tool-1').length, 1)
  assert.equal(run.events.find(event => event.id === 'tool-1').status, 'completed')
  assert.equal(run.events.find(event => event.id === 'tool-1').summary, '3 matches')
})

test('bounds the default live output and seen sequence snapshot', () => {
  const harness = fixture()
  harness.beginAgent('codex', 1)
  for (let index = 0; index < 520; index += 1) {
    harness.ingest('codex', 1, { type: 'answer_delta', delta: 'x'.repeat(40) })
  }

  const run = harness.snapshot()[0]
  assert.equal(run.output.length, 20000)
  assert.equal(run.seenSeqs.length, 501)
  assert.equal(run.seenSeqs.at(-1), 501)
  assert.equal(run.truncated, true)
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

test('upserts repeated reasoning lifecycle events without evicting useful evidence', () => {
  const harness = fixture()
  harness.beginAgent('hermes', 1)
  harness.ingest('hermes', 1, {
    id: 'plan', type: 'plan', status: 'running', summary: 'Inspect both implementations.',
  })
  harness.ingest('hermes', 1, {
    id: 'tool-1', type: 'tool_result_summary', status: 'completed',
    title: 'search', summary: 'Found the routing boundary.',
  })
  for (let index = 0; index < 100; index += 1) {
    harness.ingest('hermes', 1, {
      id: 'reasoning', type: 'reasoning_summary', status: 'running', title: 'reasoning',
    })
  }

  const live = harness.snapshot()[0]
  assert.equal(live.events.filter(event => event.id === 'reasoning').length, 1)
  assert.equal(live.events.some(event => event.summary === 'Found the routing boundary.'), true)
  assert.equal(live.truncated, false)

  const { capsule } = harness.finishAgent('hermes', 1, 'completed', 'Final answer')
  assert.equal(capsule.events.some(event => event.type === 'reasoning_summary'), false)
  assert.equal(capsule.events.some(event => event.summary === 'Found the routing boundary.'), true)
  assert.equal(capsule.summary, 'Inspect both implementations.')
})

test('rebuilds tool indexes after a silence warning shifts a full ledger', () => {
  const harness = fixture({ maxEventsPerAgent: 8 })
  harness.beginAgent('codex', 1)
  harness.ingest('codex', 1, {
    id: 'tool-keep', type: 'tool_start', status: 'running', title: 'search',
  })
  for (let index = 0; index < 6; index += 1) {
    harness.ingest('codex', 1, {
      id: `reason-${index}`, type: 'reasoning_summary', summary: `step ${index}`,
    })
  }

  const warning = harness.markSilent('codex', 1)
  harness.ingest('codex', 1, {
    id: 'tool-keep', type: 'tool_result_summary', status: 'completed',
    title: 'search', summary: 'finished safely',
  })

  const run = harness.snapshot()[0]
  assert.equal(run.events.filter(event => event.id === 'tool-keep').length, 1)
  assert.equal(run.events.find(event => event.id === 'tool-keep').type, 'tool_result_summary')
  assert.equal(run.events.find(event => event.id === 'tool-keep').summary, 'finished safely')
  assert.equal(run.seenSeqs.includes(warning.seq), true)
})

test('bounds live Agent runs even when none have completed yet', () => {
  const harness = fixture({ maxAgentRuns: 2 })
  harness.beginAgent('codex', 1)
  harness.beginAgent('hermes', 1)
  harness.beginAgent('codex', 2)

  assert.deepEqual(harness.snapshot().map(run => [run.kind, run.round]), [
    ['hermes', 1],
    ['codex', 2],
  ])
})

test('tracks answer delta sequences even though deltas stay outside the event ledger', () => {
  const harness = fixture()
  const started = harness.beginAgent('codex', 1)
  const delta = harness.ingest('codex', 1, { type: 'answer_delta', delta: 'streamed' })

  const run = harness.snapshot()[0]
  assert.deepEqual(run.seenSeqs, [started.seq, delta.seq])
  assert.equal(run.events.some(event => event.type === 'answer_delta'), false)
  assert.equal(run.output, 'streamed')
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
      detail: `Exit code: 0\nOutput: ${index + 1} lines, ${(index + 1) * 10} bytes`,
    })
  }
  const { capsule } = harness.finishAgent('hermes', 1, 'completed', 'Authoritative final', {
    includedCount: 5, omittedCount: 2, charCount: 9000, sessionRotated: true,
  })
  assert.equal(harness.snapshot()[0].output, 'Authoritative final')
  assert.equal(harness.snapshot()[0].events.find(event => event.summary === 'Evidence 15')?.detail,
    'Exit code: 0\nOutput: 16 lines, 160 bytes')
  assert.equal(capsule.events.length, 12)
  assert.equal(capsule.round, 1)
  assert.equal(capsule.summary, 'Compared the two implementations.')
  assert.deepEqual(capsule.sourceMessageIds, ['message-a', 'message-b'])
  assert.equal(capsule.context.sessionRotated, true)
  assert.equal(capsule.events.at(-1).detail, 'Exit code: 0\nOutput: 16 lines, 160 bytes')
})

test('persists only result metadata in capsule details and rejects unrecognized fields', () => {
  const capsule = normalizeTraceCapsule({
    runId: 'run-2',
    agentRunId: 'agent-run-2',
    status: 'completed',
    summary: 'Public summary',
    events: [{
      evidenceId: 'E-1', type: 'tool_result_summary', status: 'completed',
      title: '/private/result', summary: 'token=secret-value',
      detail: 'Output: 2 lines, 30 bytes\n/private/result token=secret-value',
    }],
    sourceMessageIds: ['message-1'],
    executable: '/tmp/codex',
  })
  assert.deepEqual(capsule.events[0], {
    evidenceId: 'E-1',
    type: 'tool_result_summary',
    status: 'completed',
    title: '[path]',
    summary: 'credential=[redacted]',
    detail: 'Output: 2 lines, 30 bytes',
  })
  assert.equal('executable' in capsule, false)
})

test('recovers a legacy capsule round from its generated Agent run id', () => {
  const inferred = normalizeTraceCapsule({
    runId: 'run-legacy',
    agentRunId: 'run-legacy:4:claude:agent-1',
    status: 'completed',
  })
  const explicit = normalizeTraceCapsule({
    runId: 'run-legacy',
    agentRunId: 'run-legacy:4:claude:agent-1',
    round: 2,
    status: 'completed',
  })

  assert.equal(inferred.round, 4)
  assert.equal(explicit.round, 2)
})

test('does not infer a legacy round from invalid explicit values or malformed Agent run ids', () => {
  for (const round of [true, '4', -1, 100001, null, undefined]) {
    const capsule = normalizeTraceCapsule({
      runId: 'run-legacy',
      agentRunId: 'run-legacy:4:claude:agent-1',
      round,
      status: 'completed',
    })
    assert.equal('round' in capsule, false)
  }

  for (const agentRunId of [
    'run-legacy:4',
    'run-legacy:4:anything',
    'run-legacy:4:claude:agent-1:extra',
    'run-legacy:4:claude:',
    'run-legacy:100001:claude:agent-1',
  ]) {
    const capsule = normalizeTraceCapsule({
      runId: 'run-legacy',
      agentRunId,
      status: 'completed',
    })
    assert.equal('round' in capsule, false)
  }
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

test('reserves context space for both evidence and a long Agent conclusion', () => {
  const text = evidenceCapsuleText({
    senderName: 'Claude',
    content: `Conclusion starts here. ${'x'.repeat(4000)}`,
    trace: {
      runId: 'run-long', agentRunId: 'agent-long', status: 'completed',
      events: [{
        evidenceId: 'E-R1-CLAUDE-01', type: 'tool_result_summary', status: 'completed',
        title: 'search', summary: 'Confirmed the targeted routing implementation.',
      }],
      sourceMessageIds: ['message-root'],
    },
  })

  assert.equal(text.length <= 3000, true)
  assert.match(text, /E-R1-CLAUDE-01/)
  assert.match(text, /Source messages: message-root/)
  assert.match(text, /Claude: Conclusion starts here/)
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

test('skips an oversized high-priority entry and still packs later smaller entries', () => {
  const packed = packContextEntries([
    { id: 'small-old', sender: 'Codex', text: 'usable evidence', priority: 1 },
    { id: 'small-new', sender: 'Hermes', text: 'compact conclusion', priority: 2 },
    { id: 'oversized', sender: 'User', text: 'x'.repeat(200), priority: 3 },
  ], { budget: 35, entryLimit: 300, maxEntries: 3 })

  assert.doesNotMatch(packed.text, /x{20}/)
  assert.match(packed.text, /compact conclusion/)
  assert.deepEqual(packed.sourceMessageIds, ['small-new'])
  assert.equal(packed.omittedCount, 2)
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
  assert.deepEqual(nextSessionMeta({ turns: 2, estimatedChars: 1000, transport: 'acp' }, {
    promptChars: 500, replyChars: 250,
  }), { turns: 3, estimatedChars: 1750, transport: 'acp' })
  assert.deepEqual(nextSessionMeta({ turns: 20, estimatedChars: 90000, transport: 'acp' }, {
    promptChars: 500, replyChars: 250, rotated: true, transport: 'legacy',
  }), { turns: 1, estimatedChars: 750, transport: 'legacy' })
})
