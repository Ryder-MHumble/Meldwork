const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { RunLedger } = require('../src/run-ledger.cjs')

test('keeps the ledger facade limited to RunLedger', () => {
  assert.deepEqual(Object.keys(require('../src/run-ledger.cjs')), ['RunLedger'])
})

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-run-ledger-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return {
    directory,
    storagePath: path.join(directory, 'private', 'run-ledger.json'),
  }
}

function runRecord(runId, groupId, status = 'running', agentRuns = []) {
  return {
    runId,
    taskId: `${groupId}-task`,
    groupId,
    threadRootId: `${groupId}-root`,
    mode: 'manual',
    targetKinds: ['codex'],
    status,
    permissionMode: 'read-only',
    agentRuns,
  }
}

function storedTraceRecord(
  runId = 'run-stored', groupId = 'group-stored', agentRunId = 'agent-stored',
) {
  return {
    ...runRecord(runId, groupId, 'completed', [{
      agentRunId,
      kind: 'codex',
      round: 1,
      status: 'completed',
      output: 'Done',
      events: [{
        runId,
        agentRunId,
        groupId,
        threadRootId: `${groupId}-root`,
        agentKind: 'codex',
        round: 1,
        seq: 1,
        timestamp: 1000,
        status: 'completed',
        type: 'warning',
        summary: 'Summary',
      }],
      sourceMessageIds: [`${runId}-message`],
      startedAt: 1000,
      lastActivityAt: 1000,
      finishedAt: 1000,
      silent: false,
      truncated: false,
      context: {
        includedCount: 1,
        omittedCount: 0,
        charCount: 100,
        sessionRotated: false,
      },
    }]),
    mode: 'auto',
    permissionMode: 'read-only',
    createdAt: 1000,
    startedAt: 1000,
    updatedAt: 1000,
    finishedAt: 1000,
    currentRound: 1,
    maxRounds: 2,
    unlimitedRounds: false,
  }
}

function failNextPersist(ledger) {
  const persist = ledger.persist.bind(ledger)
  let failed = false
  ledger.persist = (runs) => {
    if (!failed) {
      failed = true
      throw new Error('RUN_LEDGER_WRITE_FAILED')
    }
    return persist(runs)
  }
}

test('roundtrips sanitized bounded run and Agent snapshots', (t) => {
  const { storagePath } = fixture(t)
  const events = Array.from({ length: 85 }, (_, index) => ({
    id: `event-${index}`,
    type: 'warning',
    status: 'waiting',
    seq: index + 1,
    timestamp: 1100 + index,
    title: `Warning ${index}`,
    summary: `Summary ${index}`,
    command: `cat /Users/private/${index}`,
  }))
  const sourceMessageIds = Array.from({ length: 40 }, (_, index) => `message-${index}`)
  const extraAgentRuns = Array.from({ length: 260 }, (_, index) => ({
    agentRunId: `extra-agent-${index}`,
    kind: 'codex',
    status: 'completed',
  }))
  const ledger = new RunLedger({ storagePath, now: () => 2000 })
  const saved = ledger.checkpoint({
    runId: 'run-1',
    taskId: 'task-1',
    groupId: 'group-1',
    threadRootId: 'root-1',
    mode: 'auto',
    targetKinds: ['codex', 'hermes', 'codex', '../../private'],
    status: 'running',
    startedAt: '1970-01-01T00:00:01.000Z',
    permissionMode: 'workspace-write',
    currentRound: 12,
    maxRounds: 8,
    arbitrary: 'drop-me',
    agentRuns: [...extraAgentRuns, {
      agentRunId: 'agent-1',
      kind: 'codex',
      round: 2,
      status: 'running',
      output: `Final output ${'x'.repeat(21000)}`,
      events,
      sourceMessageIds,
      startedAt: 1050,
      lastActivityAt: 1200,
      silent: true,
      context: {
        includedCount: 2000,
        omittedCount: -4,
        charCount: 2000000,
        sessionRotated: true,
      },
      seenSeqs: [1, 2, 3],
    }],
  })

  assert.deepEqual(saved.targetKinds, ['codex', 'hermes'])
  assert.equal(saved.taskId, 'task-1')
  assert.equal(saved.currentRound, 8)
  assert.equal(saved.startedAt, 1000)
  assert.equal('arbitrary' in saved, false)
  assert.equal(saved.agentRuns.length, 256)
  const boundedAgent = saved.agentRuns.at(-1)
  assert.equal(boundedAgent.output.length, 20000)
  assert.equal(boundedAgent.events.length, 80)
  assert.equal(boundedAgent.events[0].id, 'event-5')
  assert.equal(boundedAgent.sourceMessageIds.length, 32)
  assert.deepEqual(boundedAgent.context, {
    includedCount: 1000,
    omittedCount: 0,
    charCount: 1000000,
    sessionRotated: true,
  })
  assert.equal(boundedAgent.truncated, true)
  assert.equal('seenSeqs' in boundedAgent, false)

  const restored = new RunLedger({ storagePath, now: () => 3000 })
  assert.deepEqual(restored.get('run-1'), saved)
  const detached = restored.list()
  detached[0].agentRuns.at(-1).context.charCount = 1
  assert.equal(restored.get('run-1').agentRuns.at(-1).context.charCount, 1000000)
})

test('merges sliding live Agent snapshots into durable history across restart', (t) => {
  const { storagePath } = fixture(t)
  let now = 1000
  const ledger = new RunLedger({ storagePath, now: () => now })
  const attempts = Array.from({ length: 65 }, (_, index) => ({
    agentRunId: `agent-${index + 1}`,
    kind: 'codex',
    round: index + 1,
    status: 'completed',
    output: `Output ${index + 1}`,
  }))

  const first = ledger.checkpoint(runRecord(
    'run-sliding', 'group-sliding', 'running', attempts.slice(0, 64),
  ))
  assert.deepEqual(
    first.agentRuns.map(agentRun => agentRun.agentRunId),
    attempts.slice(0, 64).map(attempt => attempt.agentRunId),
  )

  now = 2000
  const nextSnapshot = attempts.slice(1).map(attempt => (
    attempt.agentRunId === 'agent-32'
      ? { ...attempt, status: 'failed', output: 'Fresh terminal output', reason: 'updated' }
      : attempt
  ))
  const second = ledger.checkpoint(runRecord(
    'run-sliding', 'group-sliding', 'running', nextSnapshot,
  ))

  assert.equal(second.agentRuns.length, 65)
  assert.equal(second.agentRuns[0].agentRunId, 'agent-1')
  assert.equal(second.agentRuns.at(-1).agentRunId, 'agent-65')
  const updated = second.agentRuns.find(agentRun => agentRun.agentRunId === 'agent-32')
  assert.equal(updated.status, 'failed')
  assert.equal(updated.output, 'Fresh terminal output')
  assert.equal(updated.reason, 'updated')

  const restored = new RunLedger({ storagePath, now: () => 3000 }).get('run-sliding')
  assert.deepEqual(restored.agentRuns, second.agentRuns)
})

test('writer normalizes invalid Agent and event statuses before restart', (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  const saved = ledger.checkpoint(runRecord('run-status-domains', 'group-status-domains', 'running', [{
    agentRunId: 'agent-status-domains',
    kind: 'codex',
    status: 'round-limit',
    events: [{
      type: 'warning',
      status: 'preparing',
      seq: 1,
      summary: 'Waiting for valid status normalization.',
    }],
  }]))

  assert.equal(saved.agentRuns[0].status, 'running')
  assert.equal(saved.agentRuns[0].events[0].status, 'running')

  const restored = new RunLedger({ storagePath, now: () => 2000 })
  assert.equal(restored.loadError, null)
  assert.deepEqual(restored.get('run-status-domains'), saved)
})

test('rejects paths, credentials, session references, raw commands, and arbitrary reasoning fields', (t) => {
  const { storagePath } = fixture(t)
  const googleKey = 'AIza12345678901234567890123456789012345'
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
  const basicCredential = 'dXNlcjpwYXNz'
  const legitimateText = 'Basic authentication is enabled. customer.platform.internal deadbeef.cafebabe.feedface'
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  const saved = ledger.checkpoint({
    runId: 'run-secure',
    groupId: 'group-secure',
    targetKinds: ['codex'],
    status: 'running',
    reason: `token=run-secret /Users/alice/project ${googleKey} ${jwt}`,
    executable: '/Applications/Agent.app',
    sessionRef: 'session-ref-secret',
    credentials: { apiKey: 'root-secret' },
    privateChainOfThought: 'hidden-run-reasoning',
    agentRuns: [{
      agentRunId: 'agent-secure',
      kind: 'codex',
      status: 'running',
      output: `Bearer abcdefghijklmnop Authorization: Basic ${basicCredential} /Users/alice/private-output https://url-user:url-pass@example.com ${googleKey} ${jwt} ${legitimateText}`,
      command: 'cat /Users/alice/private-command',
      sessionRef: 'agent-session-secret',
      privateReasoning: 'hidden-agent-reasoning',
      events: [{
        id: 'tool-1',
        type: 'tool_result_summary',
        status: 'completed',
        seq: 1,
        title: '/Users/alice/result',
        summary: `apiKey=event-secret ${googleKey} ${jwt} ${legitimateText}`,
        detail: 'Output: 2 lines, 30 bytes from /Users/alice/result',
        command: 'rg secret /Users/alice',
        chainOfThought: 'hidden-event-reasoning',
      }],
    }],
  })

  const serialized = fs.readFileSync(storagePath, 'utf8')
  for (const forbidden of [
    '/Users/alice', '/Applications/Agent.app', 'run-secret', 'root-secret',
    'session-ref-secret', 'agent-session-secret', 'event-secret', 'url-user', 'url-pass',
    'private-command', 'hidden-run-reasoning', 'hidden-agent-reasoning',
    'hidden-event-reasoning', googleKey, jwt, basicCredential,
  ]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.match(saved.reason, /\[redacted\]/)
  assert.match(saved.reason, /\[path\]/)
  assert.match(saved.agentRuns[0].output, /Bearer \[redacted\]/)
  assert.match(saved.agentRuns[0].output, new RegExp(legitimateText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(saved.agentRuns[0].events[0].summary, new RegExp(legitimateText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.equal('command' in saved.agentRuns[0].events[0], false)
  assert.equal('detail' in saved.agentRuns[0].events[0], false)
})

test('writes atomically with private file and directory permissions', (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })

  ledger.checkpoint(runRecord('run-1', 'group-1'))
  ledger.checkpoint({ runId: 'run-1', currentRound: 1 })
  ledger.checkpoint(runRecord('run-2', 'group-1'))

  assert.equal(fs.statSync(storagePath).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.dirname(storagePath)).mode & 0o777, 0o700)
  assert.deepEqual(fs.readdirSync(path.dirname(storagePath)), ['run-ledger.json'])
  assert.equal(JSON.parse(fs.readFileSync(storagePath, 'utf8')).version, 1)
  assert.deepEqual(ledger.list().map(record => record.runId), ['run-2', 'run-1'])
})

test('finish preserves Agent snapshots and records a terminal reason', (t) => {
  const { storagePath } = fixture(t)
  let now = 1000
  const ledger = new RunLedger({ storagePath, now: () => now })
  const active = ledger.checkpoint(runRecord('run-1', 'group-1', 'running', [{
    agentRunId: 'agent-1',
    kind: 'codex',
    status: 'completed',
    output: 'Done',
    context: { includedCount: 2, omittedCount: 1, charCount: 200 },
  }]))

  now = 2000
  const finished = ledger.finish('run-1', 'completed', 'user')

  assert.equal(finished.status, 'completed')
  assert.equal(finished.reason, 'user')
  assert.equal(finished.finishedAt, 2000)
  assert.deepEqual(finished.agentRuns, active.agentRuns)
})

test('recovers interrupted runs and Agent attempts once', (t) => {
  const { storagePath } = fixture(t)
  let now = 1000
  const ledger = new RunLedger({ storagePath, now: () => now })
  ledger.checkpoint(runRecord('run-active', 'group-1', 'preparing', [{
    agentRunId: 'agent-running',
    kind: 'codex',
    status: 'running',
    context: { includedCount: 3, omittedCount: 2, charCount: 400 },
  }, {
    agentRunId: 'agent-complete',
    kind: 'codex',
    status: 'completed',
  }]))
  ledger.checkpoint(runRecord('run-terminal', 'group-2', 'completed', [{
    agentRunId: 'agent-waiting',
    kind: 'codex',
    status: 'waiting',
    context: { includedCount: 1, omittedCount: 0, charCount: 50 },
  }]))

  now = 5000
  const restored = new RunLedger({ storagePath, now: () => now })
  const changed = restored.recoverInterrupted()

  assert.equal(changed.length, 2)
  const active = restored.get('run-active')
  assert.equal(active.status, 'interrupted')
  assert.equal(active.reason, 'app_restart')
  assert.equal(active.agentRuns[0].status, 'interrupted')
  assert.equal(active.agentRuns[0].reason, 'app_restart')
  assert.deepEqual(active.agentRuns[0].context, {
    includedCount: 3, omittedCount: 2, charCount: 400,
  })
  assert.equal(active.agentRuns[1].status, 'completed')
  const terminal = restored.get('run-terminal')
  assert.equal(terminal.status, 'completed')
  assert.equal(terminal.agentRuns[0].status, 'interrupted')
  assert.equal(terminal.agentRuns[0].reason, 'app_restart')

  const persisted = fs.readFileSync(storagePath, 'utf8')
  assert.deepEqual(restored.recoverInterrupted(), [])
  assert.equal(fs.readFileSync(storagePath, 'utf8'), persisted)
})

test('retention evicts the oldest terminal record before active records', (t) => {
  const { storagePath } = fixture(t)
  let now = 0
  const ledger = new RunLedger({ storagePath, maxRuns: 3, now: () => now })
  const add = (runId, status) => {
    now += 10
    ledger.checkpoint(runRecord(runId, 'group-1', status))
  }

  add('active-old', 'running')
  add('terminal-old', 'completed')
  add('terminal-new', 'failed')
  add('active-new', 'running')
  assert.deepEqual(ledger.list().map(record => record.runId), [
    'active-new', 'terminal-new', 'active-old',
  ])

  add('active-next', 'running')
  assert.deepEqual(ledger.list().map(record => record.runId), [
    'active-next', 'active-new', 'active-old',
  ])

  add('active-last', 'running')
  assert.deepEqual(ledger.list().map(record => record.runId), [
    'active-last', 'active-next', 'active-new',
  ])
})

test('deleteGroup removes only matching records and persists the result', (t) => {
  const { storagePath } = fixture(t)
  let now = 0
  const ledger = new RunLedger({ storagePath, now: () => ++now })
  ledger.checkpoint(runRecord('run-a1', 'group-a'))
  ledger.checkpoint(runRecord('run-b1', 'group-b'))
  ledger.checkpoint(runRecord('run-a2', 'group-a'))

  assert.equal(ledger.deleteGroup('group-a'), 2)
  assert.deepEqual(ledger.list('group-a'), [])
  assert.deepEqual(ledger.list().map(record => record.runId), ['run-b1'])
  assert.deepEqual(
    new RunLedger({ storagePath }).list().map(record => record.runId),
    ['run-b1'],
  )
})

test('checkpoint remains retryable when persistence fails', (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  ledger.checkpoint(runRecord('run-1', 'group-1'))
  const beforeMemory = ledger.list()
  const beforeDisk = fs.readFileSync(storagePath, 'utf8')
  const next = runRecord('run-2', 'group-2')
  failNextPersist(ledger)

  assert.throws(() => ledger.checkpoint(next), { message: 'RUN_LEDGER_WRITE_FAILED' })
  assert.deepEqual(ledger.list(), beforeMemory)
  assert.equal(fs.readFileSync(storagePath, 'utf8'), beforeDisk)

  assert.equal(ledger.checkpoint(next).runId, 'run-2')
  assert.deepEqual(new RunLedger({ storagePath }).list().map(record => record.runId), [
    'run-2', 'run-1',
  ])
})

test('finish remains retryable when persistence fails', (t) => {
  const { storagePath } = fixture(t)
  let now = 1000
  const ledger = new RunLedger({ storagePath, now: () => now })
  ledger.checkpoint(runRecord('run-1', 'group-1'))
  const beforeMemory = ledger.list()
  const beforeDisk = fs.readFileSync(storagePath, 'utf8')
  now = 2000
  failNextPersist(ledger)

  assert.throws(
    () => ledger.finish('run-1', 'completed', 'done'),
    { message: 'RUN_LEDGER_WRITE_FAILED' },
  )
  assert.deepEqual(ledger.list(), beforeMemory)
  assert.equal(fs.readFileSync(storagePath, 'utf8'), beforeDisk)

  assert.equal(ledger.finish('run-1', 'completed', 'done').status, 'completed')
  assert.equal(new RunLedger({ storagePath }).get('run-1').status, 'completed')
})

test('interruption recovery remains retryable without mutating nested Agent state', (t) => {
  const { storagePath } = fixture(t)
  let now = 1000
  const ledger = new RunLedger({ storagePath, now: () => now })
  ledger.checkpoint(runRecord('run-1', 'group-1', 'running', [{
    agentRunId: 'agent-1',
    kind: 'codex',
    status: 'running',
    output: 'Work in progress',
  }]))
  const beforeMemory = ledger.list()
  const beforeDisk = fs.readFileSync(storagePath, 'utf8')
  now = 2000
  failNextPersist(ledger)

  assert.throws(() => ledger.recoverInterrupted(), { message: 'RUN_LEDGER_WRITE_FAILED' })
  assert.deepEqual(ledger.list(), beforeMemory)
  assert.equal(ledger.get('run-1').agentRuns[0].status, 'running')
  assert.equal(fs.readFileSync(storagePath, 'utf8'), beforeDisk)

  assert.equal(ledger.recoverInterrupted()[0].status, 'interrupted')
  const restored = new RunLedger({ storagePath }).get('run-1')
  assert.equal(restored.status, 'interrupted')
  assert.equal(restored.agentRuns[0].status, 'interrupted')
})

test('group deletion remains retryable when persistence fails', (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  ledger.checkpoint(runRecord('run-a', 'group-a'))
  ledger.checkpoint(runRecord('run-b', 'group-b'))
  const beforeMemory = ledger.list()
  const beforeDisk = fs.readFileSync(storagePath, 'utf8')
  failNextPersist(ledger)

  assert.throws(() => ledger.deleteGroup('group-a'), { message: 'RUN_LEDGER_WRITE_FAILED' })
  assert.deepEqual(ledger.list(), beforeMemory)
  assert.equal(fs.readFileSync(storagePath, 'utf8'), beforeDisk)

  assert.equal(ledger.deleteGroup('group-a'), 1)
  assert.deepEqual(new RunLedger({ storagePath }).list().map(record => record.runId), ['run-b'])
})

test('accepts bounded Unicode group identifiers without relaxing run identifiers', (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  const groupId = '历史群聊 1'

  assert.equal(ledger.checkpoint(runRecord('run-unicode', groupId)).groupId, groupId)
  assert.equal(ledger.list(groupId)[0].groupId, groupId)
  assert.throws(
    () => ledger.checkpoint(runRecord('运行-1', groupId)),
    { message: 'RUN_LEDGER_RECORD_INVALID' },
  )
  assert.throws(
    () => ledger.checkpoint(runRecord('run-control', 'group\ninvalid')),
    { message: 'RUN_LEDGER_RECORD_INVALID' },
  )
  assert.equal(ledger.deleteGroup(groupId), 1)
})

test('corrupt or malformed stores stay read-only without deleting unrelated data', (t) => {
  const { directory, storagePath } = fixture(t)
  fs.mkdirSync(path.dirname(storagePath), { recursive: true })
  const sibling = path.join(path.dirname(storagePath), 'keep.txt')
  fs.writeFileSync(sibling, 'keep', 'utf8')

  for (const [name, contents] of [
    ['corrupt', '{not-json'],
    ['malformed', JSON.stringify({ version: 1, runs: {} })],
    ['invalid-record', JSON.stringify({ version: 1, runs: [{ runId: 'run-bad' }] })],
    ['invalid-target-kinds', JSON.stringify({
      version: 1,
      runs: [{ ...runRecord('run-bad-kinds', 'group-bad'), targetKinds: {} }],
    })],
    ['invalid-target-kind-element', JSON.stringify({
      version: 1,
      runs: [{ ...runRecord('run-bad-kind-element', 'group-bad'), targetKinds: [null] }],
    })],
    ['invalid-target-kind-value', JSON.stringify({
      version: 1,
      runs: [{ ...runRecord('run-bad-kind-value', 'group-bad'), targetKinds: ['../codex'] }],
    })],
    ['invalid-agent-runs', JSON.stringify({
      version: 1,
      runs: [{ ...runRecord('run-bad-agents', 'group-bad'), agentRuns: {} }],
    })],
    ['invalid-agent-run-element', JSON.stringify({
      version: 1,
      runs: [{ ...runRecord('run-bad-agent-element', 'group-bad'), agentRuns: [null] }],
    })],
    ['invalid-agent-run-record', JSON.stringify({
      version: 1,
      runs: [{ ...runRecord('run-bad-agent-record', 'group-bad'), agentRuns: [{}] }],
    })],
    ['invalid-agent-events', JSON.stringify({
      version: 1,
      runs: [runRecord('run-bad-events', 'group-bad', 'running', [{
        agentRunId: 'agent-bad-events',
        kind: 'codex',
        events: {},
      }])],
    })],
    ['invalid-agent-event-element', JSON.stringify({
      version: 1,
      runs: [runRecord('run-bad-event-element', 'group-bad', 'running', [{
        agentRunId: 'agent-bad-event-element',
        kind: 'codex',
        events: [null],
      }])],
    })],
    ['invalid-agent-event-record', JSON.stringify({
      version: 1,
      runs: [runRecord('run-bad-event-record', 'group-bad', 'running', [{
        agentRunId: 'agent-bad-event-record',
        kind: 'codex',
        events: [{}],
      }])],
    })],
    ['invalid-agent-source-ids', JSON.stringify({
      version: 1,
      runs: [runRecord('run-bad-source-ids', 'group-bad', 'running', [{
        agentRunId: 'agent-bad-source-ids',
        kind: 'codex',
        sourceMessageIds: {},
      }])],
    })],
    ['invalid-agent-source-id-element', JSON.stringify({
      version: 1,
      runs: [runRecord('run-bad-source-id-element', 'group-bad', 'running', [{
        agentRunId: 'agent-bad-source-id-element',
        kind: 'codex',
        sourceMessageIds: [null],
      }])],
    })],
    ['invalid-agent-source-id-value', JSON.stringify({
      version: 1,
      runs: [runRecord('run-bad-source-id-value', 'group-bad', 'running', [{
        agentRunId: 'agent-bad-source-id-value',
        kind: 'codex',
        sourceMessageIds: ['../message'],
      }])],
    })],
    ['invalid-agent-context', JSON.stringify({
      version: 1,
      runs: [runRecord('run-bad-context', 'group-bad', 'running', [{
        agentRunId: 'agent-bad-context',
        kind: 'codex',
        context: [],
      }])],
    })],
  ]) {
    const candidatePath = name === 'corrupt'
      ? storagePath
      : path.join(directory, `${name}.json`)
    fs.writeFileSync(candidatePath, contents, 'utf8')
    const ledger = new RunLedger({ storagePath: candidatePath, now: () => 1000 })

    assert.deepEqual(ledger.list(), [])
    assert.equal(ledger.loadError instanceof Error, true)
    for (const mutation of [
      () => ledger.checkpoint(runRecord('run-new', 'group-new')),
      () => ledger.finish('missing', 'failed'),
      () => ledger.recoverInterrupted(),
      () => ledger.deleteGroup('missing'),
    ]) {
      assert.throws(mutation, { message: 'RUN_LEDGER_LOAD_FAILED' })
    }
    assert.equal(fs.readFileSync(candidatePath, 'utf8'), contents)
    assert.equal(fs.readFileSync(sibling, 'utf8'), 'keep')
  }
})

test('rejects coercible persisted scalar containers at every nested level', (t) => {
  const { directory, storagePath } = fixture(t)
  fs.mkdirSync(path.dirname(storagePath), { recursive: true })
  const baseline = {
    ...runRecord('run-scalars', 'group-scalars', 'completed', [{
      agentRunId: 'agent-scalars',
      kind: 'codex',
      round: 1,
      status: 'completed',
      output: 'Done',
      events: [{
        runId: 'run-scalars',
        agentRunId: 'agent-scalars',
        groupId: 'group-scalars',
        threadRootId: 'group-scalars-root',
        agentKind: 'codex',
        round: 1,
        seq: 1,
        timestamp: 1000,
        status: 'completed',
        type: 'warning',
        id: 'event-scalars',
        title: 'Warning',
        summary: 'Summary',
        detail: 'Result: 1 item',
        delta: 'legacy delta',
      }],
      sourceMessageIds: ['message-scalars'],
      startedAt: 1000,
      lastActivityAt: 1000,
      finishedAt: 1000,
      silent: false,
      truncated: false,
      reason: 'done',
      context: {
        includedCount: 1,
        omittedCount: 0,
        charCount: 100,
        sessionRotated: false,
      },
    }]),
    mode: 'auto',
    permissionMode: 'read-only',
    createdAt: 1000,
    startedAt: 1000,
    updatedAt: 1000,
    finishedAt: 1000,
    currentRound: 1,
    maxRounds: 2,
    unlimitedRounds: false,
    reason: 'done',
  }
  const scalarPaths = [
    ['runId'], ['taskId'], ['groupId'], ['threadRootId'], ['mode'], ['status'], ['reason'],
    ['permissionMode'], ['createdAt'], ['startedAt'], ['updatedAt'], ['finishedAt'],
    ['currentRound'], ['maxRounds'], ['unlimitedRounds'],
    ['agentRuns', 0, 'agentRunId'], ['agentRuns', 0, 'kind'],
    ['agentRuns', 0, 'round'], ['agentRuns', 0, 'status'],
    ['agentRuns', 0, 'output'], ['agentRuns', 0, 'startedAt'],
    ['agentRuns', 0, 'lastActivityAt'], ['agentRuns', 0, 'finishedAt'],
    ['agentRuns', 0, 'silent'], ['agentRuns', 0, 'truncated'],
    ['agentRuns', 0, 'reason'],
    ['agentRuns', 0, 'events', 0, 'runId'],
    ['agentRuns', 0, 'events', 0, 'agentRunId'],
    ['agentRuns', 0, 'events', 0, 'groupId'],
    ['agentRuns', 0, 'events', 0, 'threadRootId'],
    ['agentRuns', 0, 'events', 0, 'agentKind'],
    ['agentRuns', 0, 'events', 0, 'round'],
    ['agentRuns', 0, 'events', 0, 'seq'],
    ['agentRuns', 0, 'events', 0, 'timestamp'],
    ['agentRuns', 0, 'events', 0, 'status'],
    ['agentRuns', 0, 'events', 0, 'type'],
    ['agentRuns', 0, 'events', 0, 'id'],
    ['agentRuns', 0, 'events', 0, 'title'],
    ['agentRuns', 0, 'events', 0, 'summary'],
    ['agentRuns', 0, 'events', 0, 'detail'],
    ['agentRuns', 0, 'events', 0, 'delta'],
    ['agentRuns', 0, 'context', 'includedCount'],
    ['agentRuns', 0, 'context', 'omittedCount'],
    ['agentRuns', 0, 'context', 'charCount'],
    ['agentRuns', 0, 'context', 'sessionRotated'],
  ]
  const scalarCases = [
    ...scalarPaths.map(scalarPath => [scalarPath, value => [value]]),
    ...[
      ['reason'],
      ['agentRuns', 0, 'output'],
      ['agentRuns', 0, 'events', 0, 'summary'],
      ['agentRuns', 0, 'context', 'includedCount'],
    ].map(scalarPath => [scalarPath, value => ({ value })]),
  ]

  for (const [index, [scalarPath, corrupt]] of scalarCases.entries()) {
    const record = JSON.parse(JSON.stringify(baseline))
    let container = record
    for (const field of scalarPath.slice(0, -1)) container = container[field]
    const field = scalarPath.at(-1)
    container[field] = corrupt(container[field])
    const candidatePath = index === 0
      ? storagePath
      : path.join(directory, `scalar-${index}.json`)
    const contents = JSON.stringify({ version: 1, runs: [record] })
    fs.writeFileSync(candidatePath, contents, 'utf8')

    const ledger = new RunLedger({ storagePath: candidatePath, now: () => 2000 })

    assert.equal(ledger.loadError instanceof Error, true, scalarPath.join('.'))
    assert.throws(
      () => ledger.checkpoint(runRecord('run-new', 'group-new')),
      { message: 'RUN_LEDGER_LOAD_FAILED' },
      scalarPath.join('.'),
    )
    assert.equal(fs.readFileSync(candidatePath, 'utf8'), contents)
  }
})

test('rejects persisted enums and bounded numbers that normalization would change', (t) => {
  const { directory, storagePath } = fixture(t)
  fs.mkdirSync(path.dirname(storagePath), { recursive: true })
  const cases = [
    ['mode', record => { record.mode = 'bogus' }],
    ['run-status', record => { record.status = 'bogus' }],
    ['permission', record => { record.permissionMode = 'bogus' }],
    ['manual-rounds', record => { record.mode = 'manual' }],
    ['unlimited-max', record => { record.unlimitedRounds = true }],
    ['round-over-max', record => { record.maxRounds = 1; record.currentRound = 2 }],
    ['current-negative', record => { record.currentRound = -1 }],
    ['current-fractional', record => { record.currentRound = 1.5 }],
    ['current-overflow', record => { record.currentRound = 100001 }],
    ['max-negative', record => { record.maxRounds = -1 }],
    ['max-overflow', record => { record.maxRounds = 100001 }],
    ['agent-status', record => { record.agentRuns[0].status = 'bogus' }],
    ['agent-run-only-status', record => { record.agentRuns[0].status = 'round-limit' }],
    ['agent-preparing-status', record => { record.agentRuns[0].status = 'preparing' }],
    ['agent-round-negative', record => { record.agentRuns[0].round = -1 }],
    ['agent-round-overflow', record => { record.agentRuns[0].round = 100001 }],
    ['event-status', record => { record.agentRuns[0].events[0].status = 'bogus' }],
    ['event-run-only-status', record => { record.agentRuns[0].events[0].status = 'round-limit' }],
    ['event-preparing-status', record => { record.agentRuns[0].events[0].status = 'preparing' }],
    ['event-round-negative', record => { record.agentRuns[0].events[0].round = -1 }],
    ['event-round-overflow', record => { record.agentRuns[0].events[0].round = 100001 }],
    ['event-seq-zero', record => { record.agentRuns[0].events[0].seq = 0 }],
    ['event-seq-overflow', record => { record.agentRuns[0].events[0].seq = 1000000001 }],
    ['included-negative', record => { record.agentRuns[0].context.includedCount = -1 }],
    ['included-overflow', record => { record.agentRuns[0].context.includedCount = 1001 }],
    ['omitted-negative', record => { record.agentRuns[0].context.omittedCount = -1 }],
    ['omitted-overflow', record => { record.agentRuns[0].context.omittedCount = 100001 }],
    ['chars-negative', record => { record.agentRuns[0].context.charCount = -1 }],
    ['chars-overflow', record => { record.agentRuns[0].context.charCount = 1000001 }],
  ]

  for (const [index, [name, mutate]] of cases.entries()) {
    const record = storedTraceRecord()
    mutate(record)
    const candidatePath = index === 0 ? storagePath : path.join(directory, `${name}.json`)
    const contents = JSON.stringify({ version: 1, runs: [record] })
    fs.writeFileSync(candidatePath, contents, 'utf8')

    const ledger = new RunLedger({ storagePath: candidatePath, now: () => 2000 })

    assert.equal(ledger.loadError instanceof Error, true, name)
    assert.throws(
      () => ledger.checkpoint(runRecord('run-new', 'group-new')),
      { message: 'RUN_LEDGER_LOAD_FAILED' },
      name,
    )
    assert.equal(fs.readFileSync(candidatePath, 'utf8'), contents, name)
  }
})

test('rejects explicit event provenance that disagrees with its parent', (t) => {
  const { directory, storagePath } = fixture(t)
  fs.mkdirSync(path.dirname(storagePath), { recursive: true })
  const cases = [
    ['runId', 'run-other'],
    ['agentRunId', 'agent-other'],
    ['groupId', 'group-other'],
    ['threadRootId', 'root-other'],
    ['agentKind', 'hermes'],
    ['round', 2],
  ]

  for (const [index, [field, value]] of cases.entries()) {
    const record = storedTraceRecord()
    record.agentRuns[0].events[0][field] = value
    const candidatePath = index === 0
      ? storagePath
      : path.join(directory, `provenance-${field}.json`)
    const contents = JSON.stringify({ version: 1, runs: [record] })
    fs.writeFileSync(candidatePath, contents, 'utf8')

    const ledger = new RunLedger({ storagePath: candidatePath, now: () => 2000 })

    assert.equal(ledger.loadError instanceof Error, true, field)
    assert.throws(
      () => ledger.finish('run-stored', 'failed'),
      { message: 'RUN_LEDGER_LOAD_FAILED' },
      field,
    )
    assert.equal(fs.readFileSync(candidatePath, 'utf8'), contents, field)
  }

  const legacyPath = path.join(directory, 'legacy-event.json')
  const legacy = storedTraceRecord()
  for (const field of [
    'runId', 'agentRunId', 'groupId', 'threadRootId', 'agentKind', 'round',
  ]) delete legacy.agentRuns[0].events[0][field]
  fs.writeFileSync(legacyPath, JSON.stringify({ version: 1, runs: [legacy] }), 'utf8')
  const restored = new RunLedger({ storagePath: legacyPath })

  assert.equal(restored.loadError, null)
  assert.deepEqual(
    Object.fromEntries([
      'runId', 'agentRunId', 'groupId', 'threadRootId', 'agentKind', 'round',
    ].map(field => [field, restored.get('run-stored').agentRuns[0].events[0][field]])),
    {
      runId: 'run-stored',
      agentRunId: 'agent-stored',
      groupId: 'group-stored',
      threadRootId: 'group-stored-root',
      agentKind: 'codex',
      round: 1,
    },
  )
})

test('rejects duplicate run and Agent run identities across the complete store', (t) => {
  const { directory, storagePath } = fixture(t)
  fs.mkdirSync(path.dirname(storagePath), { recursive: true })
  const duplicateAgent = storedTraceRecord()
  duplicateAgent.agentRuns.push(JSON.parse(JSON.stringify(duplicateAgent.agentRuns[0])))
  const outsideWindow = [
    storedTraceRecord('run-edge-first', 'group-edge', 'agent-global-duplicate'),
    ...Array.from({ length: 2047 }, (_, index) => (
      runRecord(`run-unique-${index}`, 'group-edge')
    )),
    storedTraceRecord('run-edge-last', 'group-edge', 'agent-global-duplicate'),
  ]
  const cases = [
    ['duplicate-run', [
      storedTraceRecord('run-duplicate', 'group-first', 'agent-first'),
      storedTraceRecord('run-duplicate', 'group-second', 'agent-second'),
    ]],
    ['duplicate-agent', [duplicateAgent]],
    ['duplicate-agent-across-runs', [
      storedTraceRecord('run-first', 'group-first', 'agent-duplicate'),
      storedTraceRecord('run-second', 'group-second', 'agent-duplicate'),
    ]],
    ['duplicate-agent-outside-window', outsideWindow],
  ]

  for (const [index, [name, runs]] of cases.entries()) {
    const candidatePath = index === 0 ? storagePath : path.join(directory, `${name}.json`)
    const contents = JSON.stringify({ version: 1, runs })
    fs.writeFileSync(candidatePath, contents, 'utf8')

    const ledger = new RunLedger({ storagePath: candidatePath, now: () => 2000 })

    assert.deepEqual(ledger.list(), [], name)
    assert.equal(ledger.loadError instanceof Error, true, name)
    assert.throws(
      () => ledger.deleteGroup('group-first'),
      { message: 'RUN_LEDGER_LOAD_FAILED' },
      name,
    )
    assert.equal(fs.readFileSync(candidatePath, 'utf8'), contents, name)
  }
})

test('validates malformed records before applying the retention window', (t) => {
  const { storagePath } = fixture(t)
  fs.mkdirSync(path.dirname(storagePath), { recursive: true })
  const contents = JSON.stringify({
    version: 1,
    runs: [
      null,
      ...Array.from({ length: 2048 }, (_, index) => (
        runRecord(`run-window-${index}`, 'group-window')
      )),
    ],
  })
  fs.writeFileSync(storagePath, contents, 'utf8')

  const ledger = new RunLedger({ storagePath, now: () => 1000 })

  assert.deepEqual(ledger.list(), [])
  assert.equal(ledger.loadError instanceof Error, true)
  assert.throws(
    () => ledger.checkpoint(runRecord('run-new', 'group-new')),
    { message: 'RUN_LEDGER_LOAD_FAILED' },
  )
  assert.equal(fs.readFileSync(storagePath, 'utf8'), contents)
})

test('loads legacy records with omitted nested arrays and remains writable', (t) => {
  const { storagePath } = fixture(t)
  fs.mkdirSync(path.dirname(storagePath), { recursive: true })
  fs.writeFileSync(storagePath, JSON.stringify({
    version: 1,
    runs: [{
      runId: 'run-legacy',
      groupId: 'group-legacy',
      status: 'running',
    }, {
      runId: 'run-legacy-agent',
      groupId: 'group-legacy',
      targetKinds: ['codex'],
      status: 'running',
      agentRuns: [{
        agentRunId: 'agent-legacy',
        kind: 'codex',
        status: 'running',
      }],
    }],
  }), 'utf8')

  const ledger = new RunLedger({ storagePath, now: () => 1000 })

  assert.equal(ledger.loadError, null)
  assert.equal(ledger.get('run-legacy').taskId, '')
  assert.deepEqual(ledger.get('run-legacy').targetKinds, [])
  assert.deepEqual(ledger.get('run-legacy').agentRuns, [])
  assert.deepEqual(ledger.get('run-legacy-agent').agentRuns[0].events, [])
  assert.deepEqual(ledger.get('run-legacy-agent').agentRuns[0].sourceMessageIds, [])
  assert.deepEqual(ledger.get('run-legacy-agent').agentRuns[0].context, {})
  assert.equal(ledger.finish('run-legacy', 'completed').status, 'completed')
})
