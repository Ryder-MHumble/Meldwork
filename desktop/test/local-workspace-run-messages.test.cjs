const assert = require('node:assert/strict')
const test = require('node:test')

const messagesApi = require('../src/local-workspace-run-messages.cjs')
const { LocalWorkspaceRunMessages } = messagesApi

function fixture() {
  const state = { messages: [] }
  const activeRuns = new Map()
  const calls = []
  const messages = new LocalWorkspaceRunMessages({
    state: () => state,
    activeRuns,
    agentLabel: kind => kind === 'custom-0123456789abcdef' ? 'Custom Reviewer' : 'Codex',
    checkpointRun: (...args) => calls.push(['checkpoint', ...args]),
    addMessage: (...args) => calls.push(['message', ...args]),
  })
  return { activeRuns, calls, messages, state }
}

function trace(overrides = {}) {
  return {
    runId: 'run-1',
    agentRunId: 'run-1:0:codex:attempt-1',
    status: 'failed',
    summary: 'summary',
    ...overrides,
  }
}

test('run messages module exposes only its coordinator', () => {
  assert.deepEqual(Object.keys(messagesApi), ['LocalWorkspaceRunMessages'])
})

test('failure records its reason before checkpointing and persists streamed output', () => {
  const { activeRuns, calls, messages } = fixture()
  const controller = {
    agentFailureReasons: new Map(),
    harness: { snapshot: () => [{ agentRunId: trace().agentRunId, output: 'streamed answer' }] },
  }
  activeRuns.set('group-1', controller)

  assert.deepEqual(messages.recordFailure(
    'group-1', 'codex', { message: 'LOCAL_AGENT_FAILED', runTrace: trace() }, 'root-1',
  ), { label: 'Codex', reason: 'LOCAL_AGENT_FAILED' })

  assert.equal(controller.agentFailureReasons.get(trace().agentRunId), 'LOCAL_AGENT_FAILED')
  assert.deepEqual(calls.map(call => call[0]), ['checkpoint', 'message'])
  assert.equal(calls[1][3], 'Codex failed: LOCAL_AGENT_FAILED\nstreamed answer')
})

test('failure deduplication includes streamed output and still checkpoints duplicates', () => {
  const { activeRuns, calls, messages } = fixture()
  let output = 'first conclusion'
  const controller = {
    agentFailureReasons: new Map(),
    harness: { snapshot: () => [{ agentRunId: trace().agentRunId, output }] },
  }
  activeRuns.set('group-1', controller)
  const reported = new Set()
  const error = { message: 'LOCAL_AGENT_FAILED', runTrace: trace() }

  messages.recordFailure('group-1', 'codex', error, 'root-1', reported)
  messages.recordFailure('group-1', 'codex', error, 'root-1', reported)
  output = 'second conclusion'
  messages.recordFailure('group-1', 'codex', error, 'root-1', reported)

  assert.equal(calls.filter(call => call[0] === 'checkpoint').length, 3)
  assert.deepEqual(
    calls.filter(call => call[0] === 'message').map(call => call[3]),
    [
      'Codex failed: LOCAL_AGENT_FAILED\nfirst conclusion',
      'Codex failed: LOCAL_AGENT_FAILED\nsecond conclusion',
    ],
  )
})

test('failure falls back to the stable reason and keeps current custom label behavior', () => {
  const { calls, messages } = fixture()
  const kind = 'custom-0123456789abcdef'
  assert.deepEqual(messages.recordFailure('group-1', kind, '', 'root-1'), {
    label: 'Custom Reviewer', reason: 'LOCAL_AGENT_UNKNOWN_FAILURE',
  })
  assert.equal(calls[0][3], 'Custom Reviewer failed: LOCAL_AGENT_UNKNOWN_FAILURE')
})

test('interruption overrides trace status, deduplicates globally, and retains streamed output', () => {
  const { activeRuns, calls, messages, state } = fixture()
  const runTrace = trace({ status: 'running' })
  activeRuns.set('group-1', {
    harness: { snapshot: () => [{ agentRunId: runTrace.agentRunId, output: 'partial answer' }] },
  })
  const reported = new Set()

  const normalized = messages.recordInterruption(
    'group-1', 'codex', { runTrace }, 'root-1', 'interrupted', reported,
  )
  assert.equal(normalized.status, 'interrupted')
  assert.equal(calls[0][3], 'Codex was interrupted when Meldwork closed.\npartial answer')
  assert.equal(calls[0][6].key, 'system.agentInterrupted')

  state.messages.push({ trace: { agentRunId: 'other-run' } })
  messages.recordInterruption(
    'group-1', 'codex', { runTrace }, 'root-1', 'interrupted', reported,
  )
  assert.equal(calls.length, 1)
})

test('persisted interruption trace updates the external dedupe set without adding a message', () => {
  const { calls, messages, state } = fixture()
  const runTrace = trace()
  state.messages.push({ trace: { agentRunId: runTrace.agentRunId } })
  const reported = new Set()

  const normalized = messages.recordInterruption(
    'group-1', 'codex', { runTrace }, 'root-1', 'stopped', reported,
  )
  assert.equal(normalized.status, 'stopped')
  assert.equal(reported.has(`codex:${runTrace.agentRunId}:stopped`), true)
  assert.deepEqual(calls, [])
})

test('invalid interruption traces have no side effects', () => {
  const { calls, messages } = fixture()
  const reported = new Set()
  assert.equal(messages.recordInterruption(
    'group-1', 'codex', { runTrace: { status: 'running' } }, 'root-1', 'stopped', reported,
  ), null)
  assert.equal(reported.size, 0)
  assert.deepEqual(calls, [])
})
