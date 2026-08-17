const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { CloudAgentOperationStore } = require('../../../src/agents/cloud/cloud-agent-operation-store.cjs')
const { canonicalJson } = require('../../../src/collaboration/outcome-records.cjs')

const MAX_STORE_BYTES = 4 * 1024 * 1024
const MAX_OPERATIONS = 2048

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-cloud-operations-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return path.join(directory, 'private', 'cloud-agent-operations.json')
}

function storedOperation(input, state = 'pending', timestamp = 1000) {
  const identity = {
    type: input.type,
    runId: input.runId,
    connectorId: input.connectorId,
    jobId: input.jobId,
    requestId: input.requestId,
  }
  return {
    operationId: `cloud-operation-${crypto.createHash('sha256')
      .update(canonicalJson(identity)).digest('hex')}`,
    type: input.type,
    runId: input.runId,
    agentRunId: '',
    connectorId: input.connectorId,
    jobId: input.jobId,
    requestId: input.requestId,
    state,
    payload: input.payload,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function cancelInput(index) {
  return {
    type: 'cancel', runId: `run-${index}`, connectorId: 'cloud.mock',
    jobId: `job-${index}`, requestId: '', payload: {},
  }
}

function largeInput(index, value) {
  return {
    type: 'input', runId: 'run-large', connectorId: 'cloud.mock', jobId: 'job-large',
    requestId: `request-${index}`, payload: { value },
  }
}

function serializedSize(operations) {
  return Buffer.byteLength(`${JSON.stringify({ version: 1, operations }, null, 2)}\n`)
}

test('persists private idempotent input and replayable cancel operations across restart', (t) => {
  const storagePath = fixture(t)
  let now = 1000
  const store = new CloudAgentOperationStore({ storagePath, now: () => now })
  const input = {
    type: 'input', runId: 'run-1', connectorId: 'cloud.mock', jobId: 'job-1',
    requestId: 'question-1', payload: { value: 'Use the release branch.' },
  }
  const first = store.put(input)
  assert.equal(first.state, 'pending')
  assert.deepEqual(store.put(input), first)
  assert.throws(
    () => store.put({ ...input, payload: { value: 'Use main.' } }),
    { message: 'CLOUD_AGENT_OPERATION_CONFLICT' },
  )
  now = 1100
  store.update(first.operationId, 'delivered')
  const cancel = store.put({
    type: 'cancel', runId: 'run-1', connectorId: 'cloud.mock', jobId: 'job-1',
    requestId: '', payload: {},
  }, 'dispatched')

  assert.equal(fs.statSync(storagePath).mode & 0o777, 0o600)
  const restarted = new CloudAgentOperationStore({ storagePath, now: () => 1200 })
  assert.equal(restarted.list().length, 2)
  assert.equal(restarted.list().find(item => item.operationId === first.operationId).state, 'delivered')
  assert.equal(restarted.list().find(item => item.operationId === cancel.operationId).state, 'dispatched')
  assert.deepEqual(restarted.pendingForRun('run-1'), [cancel])
})

test('persists a bounded submit intent without storing its prompt inline', (t) => {
  const storagePath = fixture(t)
  const store = new CloudAgentOperationStore({ storagePath, now: () => 1000 })
  const promptRef = {
    algorithm: 'sha256', hash: 'a'.repeat(64), size: 42, mediaType: 'text/plain',
  }
  const resultRef = {
    algorithm: 'sha256', hash: 'b'.repeat(64), size: 84, mediaType: 'application/json',
  }
  const intent = store.put({
    type: 'submit', runId: 'run-1', agentRunId: 'agent-1', connectorId: 'cloud.mock',
    jobId: '', requestId: '', payload: { promptRef, permissionMode: 'read-only' },
  })

  assert.equal(intent.state, 'pending')
  assert.equal(intent.jobId, '')
  assert.deepEqual(store.submissionIntents(), [intent])
  assert.equal(fs.readFileSync(storagePath, 'utf8').includes('private prompt'), false)
  const dispatched = store.recordSubmitResult(intent.operationId, {
    jobId: 'job-1', resultRef,
  })
  assert.equal(dispatched.operationId, intent.operationId)
  assert.equal(dispatched.state, 'dispatched')
  assert.equal(dispatched.jobId, 'job-1')
  assert.deepEqual(store.recordSubmitResult(intent.operationId, {
    jobId: 'job-1', resultRef,
  }), dispatched)

  const restarted = new CloudAgentOperationStore({ storagePath, now: () => 1200 })
  assert.equal(restarted.submissionIntents()[0].operationId, intent.operationId)
  restarted.update(intent.operationId, 'delivered')
  assert.deepEqual(restarted.submissionIntents(), [])
  assert.throws(
    () => store.put({
      type: 'submit', runId: 'run-1', agentRunId: 'agent-2', connectorId: 'cloud.mock',
      jobId: '', requestId: '', payload: { promptRef, permissionMode: 'read-only' },
    }),
    { message: 'CLOUD_AGENT_OPERATION_CONFLICT' },
  )
})

test('evicts the oldest delivered records instead of locking at the operation limit', (t) => {
  const storagePath = fixture(t)
  const store = new CloudAgentOperationStore({ storagePath, now: () => 5000 })
  const delivered = Array.from({ length: MAX_OPERATIONS }, (_value, index) => (
    storedOperation(cancelInput(index), 'delivered', index + 1)
  ))
  store.operations = store.persist(delivered)

  const pending = store.put(cancelInput('pending'))
  assert.equal(pending.state, 'pending')
  assert.equal(store.list().length, MAX_OPERATIONS)
  assert.equal(store.list().some(operation => operation.runId === 'run-0'), false)
  assert.equal(store.list().some(operation => operation.operationId === pending.operationId), true)
  assert.equal(fs.statSync(storagePath).size <= MAX_STORE_BYTES, true)

  const restarted = new CloudAgentOperationStore({ storagePath })
  assert.equal(restarted.loadError, null)
  assert.equal(restarted.list().length, MAX_OPERATIONS)
  assert.equal(restarted.pendingForRun('run-pending')[0].operationId, pending.operationId)
})

test('compacts delivered bytes and preserves the last readable store on unresolved overflow', (t) => {
  const deliveredPath = fixture(t)
  const largeValue = 'x'.repeat(64 * 1024)
  const deliveredStore = new CloudAgentOperationStore({ storagePath: deliveredPath })
  const delivered = Array.from({ length: 70 }, (_value, index) => (
    storedOperation(largeInput(index, largeValue), 'delivered', index + 1)
  ))
  deliveredStore.operations = deliveredStore.persist(delivered)

  assert.equal(deliveredStore.list().length < delivered.length, true)
  assert.equal(fs.statSync(deliveredPath).size <= MAX_STORE_BYTES, true)
  const deliveredRestart = new CloudAgentOperationStore({ storagePath: deliveredPath })
  assert.equal(deliveredRestart.loadError, null)
  assert.equal(deliveredRestart.list().length, deliveredStore.list().length)

  const unresolvedPath = fixture(t)
  const unresolvedStore = new CloudAgentOperationStore({
    storagePath: unresolvedPath,
    now: () => 10_000,
  })
  const candidates = Array.from({ length: 70 }, (_value, index) => (
    storedOperation(largeInput(index, largeValue), 'pending', index + 1)
  ))
  const overflowIndex = candidates.findIndex((_operation, index) => (
    serializedSize(candidates.slice(0, index + 1)) > MAX_STORE_BYTES
  ))
  assert.equal(overflowIndex > 0, true)
  const base = candidates.slice(0, overflowIndex)
  unresolvedStore.operations = unresolvedStore.persist(base)
  const before = fs.readFileSync(unresolvedPath)

  assert.throws(
    () => unresolvedStore.put(largeInput(overflowIndex, largeValue)),
    { message: 'CLOUD_AGENT_OPERATION_STORE_LIMIT' },
  )
  assert.deepEqual(fs.readFileSync(unresolvedPath), before)
  assert.equal(unresolvedStore.list().length, base.length)
  const unresolvedRestart = new CloudAgentOperationStore({ storagePath: unresolvedPath })
  assert.equal(unresolvedRestart.loadError, null)
  assert.equal(unresolvedRestart.list().length, base.length)
})

test('preserves every unresolved record when the count limit rejects a new operation', (t) => {
  const storagePath = fixture(t)
  const store = new CloudAgentOperationStore({ storagePath, now: () => 10_000 })
  const unresolved = Array.from({ length: MAX_OPERATIONS }, (_value, index) => (
    storedOperation(cancelInput(index), 'pending', index + 1)
  ))
  store.operations = store.persist(unresolved)
  const before = fs.readFileSync(storagePath)

  assert.throws(
    () => store.put(cancelInput('overflow')),
    { message: 'CLOUD_AGENT_OPERATION_STORE_LIMIT' },
  )
  assert.deepEqual(fs.readFileSync(storagePath), before)
  assert.equal(store.list().length, MAX_OPERATIONS)
  const restarted = new CloudAgentOperationStore({ storagePath })
  assert.equal(restarted.loadError, null)
  assert.equal(restarted.list().length, MAX_OPERATIONS)
  assert.equal(restarted.list().every(operation => operation.state === 'pending'), true)
})

test('keeps a malformed operation store unavailable instead of overwriting it', (t) => {
  const storagePath = fixture(t)
  fs.mkdirSync(path.dirname(storagePath), { recursive: true })
  fs.writeFileSync(storagePath, '{"version":1,"operations":[{"raw":"secret"}]}')
  fs.chmodSync(storagePath, 0o600)
  const store = new CloudAgentOperationStore({ storagePath })

  assert.equal(store.loadError instanceof Error, true)
  assert.throws(
    () => store.list(),
    { message: 'CLOUD_AGENT_OPERATION_STORE_UNAVAILABLE' },
  )
  assert.throws(
    () => store.put({
      type: 'cancel', runId: 'run-1', connectorId: 'cloud.mock', jobId: 'job-1',
      requestId: '', payload: {},
    }, 'dispatched'),
    { message: 'CLOUD_AGENT_OPERATION_STORE_UNAVAILABLE' },
  )
  assert.match(fs.readFileSync(storagePath, 'utf8'), /"raw":"secret"/)
})
