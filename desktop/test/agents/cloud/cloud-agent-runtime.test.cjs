const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { RUN_EVENT_TYPES } = require('../../../src/agents/connectors/agent-connector-manifest.cjs')
const { CloudAgentOperationStore } = require('../../../src/agents/cloud/cloud-agent-operation-store.cjs')
const {
  CloudAgentRuntime,
  createCloudAgentStartRetry,
} = require('../../../src/agents/cloud/cloud-agent-runtime.cjs')
const { ContentBlobStore } = require('../../../src/attachments/content-blob-store.cjs')
const { createArtifactRecord } = require('../../../src/collaboration/outcome-records.cjs')
const { OutcomeStore } = require('../../../src/collaboration/outcome-store.cjs')
const { RunLedger } = require('../../../src/runs/run-ledger.cjs')

function connectorSnapshot() {
  return {
    schemaVersion: 1,
    connectorId: 'cloud.mock',
    connectorVersion: '1.0.0',
    manifestId: `connector-manifest-${'a'.repeat(64)}`,
    instanceId: 'cloud.mock.account',
    upstreamId: 'mock-cloud-service',
    upstreamVersion: '2.0.0',
    recipeId: 'cloud.mock.recipe',
    transport: { type: 'http', protocol: 'event-stream' },
    capabilities: {
      domains: ['coding'],
      session: { supported: true, resume: true, cancel: true, checkpoint: true },
      inputTypes: ['text'],
      permissionModes: ['read-only', 'workspace-write'],
      eventProtocolVersion: 1,
      eventTypes: [...RUN_EVENT_TYPES],
      usage: {
        inputTokens: true, outputTokens: true, costMicros: true,
        toolCalls: true, outboundBytes: true, elapsedMs: true,
      },
      outboundDestinations: ['https://cloud.example'],
    },
  }
}

function event(sequence, type, fields = {}) {
  return {
    eventId: `remote-event-${sequence}`,
    cursor: `event-cursor-${sequence}`,
    sequence,
    type,
    ...fields,
  }
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-cloud-runtime-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const contentBlobStore = new ContentBlobStore({
    rootPath: path.join(directory, 'private', 'content-blobs'),
  })
  return {
    directory,
    ledgerPath: path.join(directory, 'private', 'run-ledger.json'),
    operationPath: path.join(directory, 'private', 'cloud-agent-operations.json'),
    contentBlobStore,
    outcomeStore: new OutcomeStore({
      rootPath: path.join(directory, 'private', 'outcomes'),
      contentBlobStore,
    }),
  }
}

function seedRun(ledger, runId = 'run-cloud', agentRunId = 'agent-cloud') {
  return ledger.checkpoint({
    runId,
    taskId: `${runId}-task`,
    contextPackId: `context-pack-${'b'.repeat(64)}`,
    contextPackState: 'captured',
    groupId: 'group-cloud',
    threadRootId: 'thread-cloud',
    mode: 'manual',
    targetKinds: ['cloud-agent'],
    status: 'running',
    permissionMode: 'read-only',
    agentRuns: [{
      agentRunId, kind: 'cloud-agent', round: 1, status: 'running',
    }],
  })
}

function mockConnector(overrides = {}) {
  const calls = {
    submit: [], observe: [], reconcile: [], input: [], permission: [], cancel: [], artifacts: [],
  }
  const observations = []
  const nextObservation = request => observations.shift() || { cursor: request.cursor, events: [] }
  return {
    calls,
    observations,
    connector: {
      snapshot: connectorSnapshot(),
      submit: async request => {
        calls.submit.push(request)
        return overrides.submit ? overrides.submit(request) : { jobId: 'job-cloud-1', cursor: 'poll-cursor-0' }
      },
      observe: async request => {
        calls.observe.push(request)
        return overrides.observe ? overrides.observe(request) : nextObservation(request)
      },
      reconcile: async request => {
        calls.reconcile.push(request)
        return overrides.reconcile ? overrides.reconcile(request) : nextObservation(request)
      },
      provideInput: async request => {
        calls.input.push(request)
        return overrides.provideInput?.(request)
      },
      decidePermission: async request => {
        calls.permission.push(request)
        return overrides.decidePermission?.(request)
      },
      cancel: async request => {
        calls.cancel.push(request)
        return overrides.cancel?.(request)
      },
      fetchArtifacts: async request => {
        calls.artifacts.push(request)
        return overrides.fetchArtifacts ? overrides.fetchArtifacts(request) : []
      },
    },
  }
}

function runtimeFor(value, ledger, connector, options = {}) {
  return new CloudAgentRuntime({
    runLedger: ledger,
    outcomeStore: value.outcomeStore,
    contentBlobStore: value.contentBlobStore,
    operationStore: new CloudAgentOperationStore({ storagePath: value.operationPath }),
    connectors: connector ? [connector] : [],
    autoObserve: false,
    ...options,
  })
}

async function waitFor(predicate, timeoutMs = 2000) {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('WAIT_FOR_TIMEOUT')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('submits durably, resumes cursor recovery, and persists input and permission answers', async (t) => {
  const value = fixture(t)
  const mock = mockConnector()
  const ledger = new RunLedger({ storagePath: value.ledgerPath })
  seedRun(ledger)
  const runtime = runtimeFor(value, ledger, mock.connector)

  const submitted = await runtime.submit({
    connectorId: 'cloud.mock', runId: 'run-cloud', agentRunId: 'agent-cloud',
    prompt: 'Review the release.', permissionMode: 'read-only',
  })
  assert.equal(submitted.status, 'running')
  assert.equal(submitted.jobId, 'job-cloud-1')
  assert.equal(mock.calls.observe.length, 0)
  assert.equal(ledger.get('run-cloud').remoteJob.jobId, 'job-cloud-1')

  mock.observations.push({
    cursor: 'poll-cursor-1',
    events: [event(0, 'WaitingInput', {
      requestId: 'question-1', prompt: 'Which branch should receive the result?',
    })],
  })
  const waitingInput = await runtime.observeNow('run-cloud')
  assert.equal(waitingInput.status, 'waiting_input')
  await runtime.provideInput('run-cloud', 'question-1', 'release/next')
  assert.equal(mock.calls.input.length, 1)
  assert.equal(mock.calls.input[0].idempotencyKey.startsWith('cloud-operation-'), true)

  mock.observations.push({
    cursor: 'poll-cursor-2',
    events: [event(1, 'Permission', {
      requestId: 'permission-1', permission: 'workspace-write', decision: 'requested',
      summary: 'Apply the reviewed patch.',
    })],
  })
  const waitingPermission = await runtime.observeNow('run-cloud')
  assert.equal(waitingPermission.status, 'waiting_permission')
  await runtime.shutdown()

  const restartedLedger = new RunLedger({ storagePath: value.ledgerPath })
  const restarted = runtimeFor(value, restartedLedger, mock.connector)
  restarted.workspaceLedger().recoverInterrupted()
  const recoveries = await restarted.start()
  assert.equal(recoveries[0].jobId, 'job-cloud-1')
  assert.equal(recoveries[0].cursor, 'poll-cursor-2')
  assert.equal(restartedLedger.get('run-cloud').status, 'reconciling')

  await restarted.decidePermission('run-cloud', 'permission-1', 'approved')
  assert.equal(mock.calls.permission.length, 1)
  mock.observations.push({
    cursor: 'poll-cursor-3',
    events: [
      event(2, 'Permission', {
        requestId: 'permission-1', permission: 'workspace-write', decision: 'approved',
      }),
      event(3, 'Completed', { outcome: 'completed', summary: 'Cloud review completed.' }),
    ],
  })
  const completed = await restarted.observeNow('run-cloud', { reconcile: true })
  assert.equal(completed.status, 'completed')
  assert.equal(mock.calls.reconcile[0].cursor, 'poll-cursor-2')
  assert.equal(restartedLedger.get('run-cloud').remoteJob.recoveryOwnerId, '')

  const operations = new CloudAgentOperationStore({ storagePath: value.operationPath }).list()
  assert.deepEqual(operations.map(item => [item.type, item.state]), [
    ['submit', 'delivered'], ['input', 'delivered'], ['permission', 'delivered'],
  ])
})

test('recovers the same submitted job when its Run Ledger checkpoint fails', async (t) => {
  const value = fixture(t)
  const mock = mockConnector({
    submit: () => ({
      jobId: 'job-cloud-durable',
      cursor: 'poll-cursor-durable',
      events: [event(0, 'Usage', { mode: 'delta', usage: { inputTokens: 7 } })],
    }),
  })
  const ledger = new RunLedger({ storagePath: value.ledgerPath })
  seedRun(ledger)
  const checkpoint = ledger.checkpoint.bind(ledger)
  let failRemoteCheckpoint = true
  ledger.checkpoint = (record) => {
    if (record.remoteJob && failRemoteCheckpoint) {
      failRemoteCheckpoint = false
      throw new Error('SIMULATED_CRASH_BEFORE_REMOTE_JOB_CHECKPOINT')
    }
    return checkpoint(record)
  }
  const runtime = runtimeFor(value, ledger, mock.connector)
  const prompt = 'Private release plan that must not enter the operation journal.'

  await assert.rejects(
    runtime.submit({
      connectorId: 'cloud.mock', runId: 'run-cloud', agentRunId: 'agent-cloud', prompt,
    }),
    { message: 'SIMULATED_CRASH_BEFORE_REMOTE_JOB_CHECKPOINT' },
  )
  assert.equal(mock.calls.submit.length, 1)
  assert.equal(ledger.get('run-cloud').remoteJob, undefined)
  assert.equal(fs.readFileSync(value.operationPath, 'utf8').includes(prompt), false)
  const [intent] = new CloudAgentOperationStore({
    storagePath: value.operationPath,
  }).submissionIntents()
  assert.equal(intent.state, 'dispatched')
  assert.equal(intent.jobId, 'job-cloud-durable')
  assert.equal(mock.calls.submit[0].idempotencyKey, intent.operationId)
  await runtime.shutdown()

  const restartedLedger = new RunLedger({ storagePath: value.ledgerPath })
  const restarted = runtimeFor(value, restartedLedger, mock.connector)
  assert.deepEqual(restarted.workspaceLedger().recoverInterrupted(), [])
  assert.equal(restartedLedger.get('run-cloud').status, 'running')
  assert.equal(restartedLedger.get('run-cloud').agentRuns[0].status, 'running')

  const [recovery] = await restarted.start()
  assert.equal(mock.calls.submit.length, 1)
  assert.equal(recovery.jobId, 'job-cloud-durable')
  assert.equal(restartedLedger.get('run-cloud').status, 'reconciling')
  assert.equal(
    restartedLedger.get('run-cloud').agentRuns[0].context.connectorEventState.lastSequence,
    0,
  )
  assert.equal(new CloudAgentOperationStore({
    storagePath: value.operationPath,
  }).list().find(operation => operation.operationId === intent.operationId).state, 'delivered')
  await restarted.shutdown()
})

test('retries a pending submit with the same idempotency key after result journaling fails', async (t) => {
  const value = fixture(t)
  const mock = mockConnector({
    submit: () => ({ jobId: 'job-cloud-idempotent', cursor: 'poll-cursor-idempotent' }),
  })
  const ledger = new RunLedger({ storagePath: value.ledgerPath })
  seedRun(ledger)
  const runtime = runtimeFor(value, ledger, mock.connector)
  const recordSubmitResult = runtime.operationStore.recordSubmitResult.bind(runtime.operationStore)
  let failResultJournal = true
  runtime.operationStore.recordSubmitResult = (...args) => {
    if (failResultJournal) {
      failResultJournal = false
      throw new Error('SIMULATED_CRASH_AFTER_REMOTE_SUBMIT')
    }
    return recordSubmitResult(...args)
  }

  await assert.rejects(
    runtime.submit({
      connectorId: 'cloud.mock', runId: 'run-cloud', agentRunId: 'agent-cloud',
      prompt: 'Replay the persisted submission intent.',
    }),
    { message: 'SIMULATED_CRASH_AFTER_REMOTE_SUBMIT' },
  )
  const [intent] = new CloudAgentOperationStore({
    storagePath: value.operationPath,
  }).submissionIntents()
  assert.equal(intent.state, 'pending')
  await runtime.shutdown()

  const restarted = runtimeFor(
    value,
    new RunLedger({ storagePath: value.ledgerPath }),
    mock.connector,
  )
  const [recovery] = await restarted.start()
  assert.equal(recovery.jobId, 'job-cloud-idempotent')
  assert.equal(mock.calls.submit.length, 2)
  assert.equal(mock.calls.submit[0].idempotencyKey, intent.operationId)
  assert.equal(mock.calls.submit[1].idempotencyKey, intent.operationId)
  assert.equal(new CloudAgentOperationStore({
    storagePath: value.operationPath,
  }).list().find(operation => operation.operationId === intent.operationId).state, 'delivered')
  await restarted.shutdown()
})

test('completes a submit intent after the ledger persisted and initial events stay idempotent', async (t) => {
  const value = fixture(t)
  const mock = mockConnector({
    submit: () => ({
      jobId: 'job-cloud-checkpointed',
      cursor: 'poll-cursor-checkpointed',
      events: [event(0, 'Usage', { mode: 'delta', usage: { outputTokens: 5 } })],
    }),
  })
  const ledger = new RunLedger({ storagePath: value.ledgerPath })
  seedRun(ledger)
  const runtime = runtimeFor(value, ledger, mock.connector)
  const update = runtime.operationStore.update.bind(runtime.operationStore)
  let failDeliveryAck = true
  runtime.operationStore.update = (operationId, state) => {
    const operation = runtime.operationStore.list()
      .find(item => item.operationId === operationId)
    if (operation?.type === 'submit' && state === 'delivered' && failDeliveryAck) {
      failDeliveryAck = false
      throw new Error('SIMULATED_CRASH_AFTER_REMOTE_JOB_CHECKPOINT')
    }
    return update(operationId, state)
  }

  await assert.rejects(
    runtime.submit({
      connectorId: 'cloud.mock', runId: 'run-cloud', agentRunId: 'agent-cloud',
      prompt: 'Keep the initial event batch idempotent.',
    }),
    { message: 'SIMULATED_CRASH_AFTER_REMOTE_JOB_CHECKPOINT' },
  )
  const beforeRestart = ledger.get('run-cloud')
  assert.equal(beforeRestart.remoteJob.jobId, 'job-cloud-checkpointed')
  assert.equal(beforeRestart.agentRuns[0].context.connectorEventState.events.length, 1)
  const [intent] = new CloudAgentOperationStore({
    storagePath: value.operationPath,
  }).submissionIntents()
  assert.equal(intent.state, 'dispatched')
  await runtime.shutdown()

  const restartedLedger = new RunLedger({ storagePath: value.ledgerPath })
  const restarted = runtimeFor(value, restartedLedger, mock.connector)
  const [recovery] = await restarted.start()

  assert.equal(recovery.jobId, 'job-cloud-checkpointed')
  assert.equal(mock.calls.submit.length, 1)
  assert.equal(
    restartedLedger.get('run-cloud').agentRuns[0].context.connectorEventState.events.length,
    1,
  )
  assert.equal(new CloudAgentOperationStore({
    storagePath: value.operationPath,
  }).list().find(operation => operation.operationId === intent.operationId).state, 'delivered')
  await restarted.shutdown()
})

test('retries the second ledger reconciliation phase before delivering a submit intent', async (t) => {
  const value = fixture(t)
  const mock = mockConnector({
    submit: () => ({
      jobId: 'job-cloud-terminal',
      cursor: 'poll-cursor-terminal',
      events: [event(0, 'Completed', { outcome: 'completed' })],
    }),
  })
  const ledger = new RunLedger({ storagePath: value.ledgerPath })
  seedRun(ledger)
  const reconcileRemote = ledger.reconcileRemote.bind(ledger)
  let failReconcile = true
  ledger.reconcileRemote = (...args) => {
    if (failReconcile) {
      failReconcile = false
      throw new Error('SIMULATED_SECOND_PHASE_RECONCILE_FAILURE')
    }
    return reconcileRemote(...args)
  }
  const runtime = runtimeFor(value, ledger, mock.connector)

  await assert.rejects(
    runtime.submit({
      connectorId: 'cloud.mock', runId: 'run-cloud', agentRunId: 'agent-cloud',
      prompt: 'Finish only after both ledger phases persist.',
    }),
    { message: 'SIMULATED_SECOND_PHASE_RECONCILE_FAILURE' },
  )
  assert.equal(ledger.get('run-cloud').status, 'running')
  assert.equal(ledger.get('run-cloud').agentRuns[0].status, 'completed')
  const [intent] = new CloudAgentOperationStore({
    storagePath: value.operationPath,
  }).submissionIntents()
  assert.equal(intent.state, 'dispatched')
  await runtime.shutdown()

  const restartedLedger = new RunLedger({ storagePath: value.ledgerPath })
  const restarted = runtimeFor(value, restartedLedger, mock.connector)
  assert.deepEqual(await restarted.start(), [])

  assert.equal(mock.calls.submit.length, 1)
  assert.equal(restartedLedger.get('run-cloud').status, 'completed')
  assert.equal(new CloudAgentOperationStore({
    storagePath: value.operationPath,
  }).list().find(operation => operation.operationId === intent.operationId).state, 'delivered')
  await restarted.shutdown()
})

test('main-owned observation continues after its renderer-style subscriber detaches', async (t) => {
  const value = fixture(t)
  let resolveObservation
  let observationStarted
  const observationStartedPromise = new Promise(resolve => { observationStarted = resolve })
  const mock = mockConnector({
    observe: request => {
      observationStarted(request)
      return new Promise(resolve => { resolveObservation = resolve })
    },
  })
  const ledger = new RunLedger({ storagePath: value.ledgerPath })
  seedRun(ledger)
  const runtime = runtimeFor(value, ledger, mock.connector, {
    autoObserve: true,
    pollIntervalMs: 5,
    setTimer: (callback, delay) => ({ handle: setTimeout(callback, delay) }),
    clearTimer: timer => clearTimeout(timer.handle),
  })
  const observed = []
  const detach = runtime.subscribe(snapshot => observed.push(snapshot))

  const submitted = await runtime.submit({
    connectorId: 'cloud.mock', runId: 'run-cloud', agentRunId: 'agent-cloud',
    prompt: 'Finish later.',
  })
  assert.equal(submitted.status, 'running')
  const request = await observationStartedPromise
  assert.equal(request.jobId, 'job-cloud-1')
  detach()
  resolveObservation({
    cursor: 'poll-cursor-1',
    events: [event(0, 'Completed', { outcome: 'completed' })],
  })
  await waitFor(() => ledger.get('run-cloud').status === 'completed')

  assert.equal(runtime.publicSnapshot('run-cloud').status, 'completed')
  assert.equal(observed.at(-1).status, 'running')
  await runtime.shutdown()
})

test('shutdown stays bounded when a Cloud Connector ignores cancellation', async (t) => {
  const value = fixture(t)
  let observedSignal = null
  let observationStarted
  const observationStartedPromise = new Promise(resolve => { observationStarted = resolve })
  const mock = mockConnector({
    observe: request => {
      observedSignal = request.signal
      observationStarted()
      return new Promise(() => {})
    },
  })
  const ledger = new RunLedger({ storagePath: value.ledgerPath })
  seedRun(ledger)
  const runtime = runtimeFor(value, ledger, mock.connector, { shutdownGraceMs: 10 })
  await runtime.submit({
    connectorId: 'cloud.mock', runId: 'run-cloud', agentRunId: 'agent-cloud',
    prompt: 'Ignore cancellation for this test.',
  })
  runtime.observeNow('run-cloud')
  await observationStartedPromise

  const startedAt = Date.now()
  await runtime.shutdown()

  assert.equal(observedSignal.aborted, true)
  assert.equal(Date.now() - startedAt < 500, true)
})

test('deduplicates out-of-order callbacks, Artifacts, and terminal transitions', async (t) => {
  const value = fixture(t)
  const artifact = createArtifactRecord({
    type: 'link',
    name: 'Remote review report',
    producedBy: { runId: 'run-cloud', agentRunId: 'agent-cloud', agentKind: 'cloud-agent' },
    locationRef: { kind: 'uri', uri: 'https://cloud.example/reports/1' },
  })
  const mock = mockConnector({ fetchArtifacts: async () => [artifact] })
  const ledger = new RunLedger({ storagePath: value.ledgerPath })
  seedRun(ledger)
  const reconcileRemote = ledger.reconcileRemote.bind(ledger)
  let terminalTransitions = 0
  ledger.reconcileRemote = (runId, ownerId, update) => {
    if (update.status === 'completed') terminalTransitions += 1
    return reconcileRemote(runId, ownerId, update)
  }
  const runtime = runtimeFor(value, ledger, mock.connector)
  await runtime.submit({
    connectorId: 'cloud.mock', runId: 'run-cloud', agentRunId: 'agent-cloud',
    prompt: 'Produce a report.',
  })
  const terminalBatch = {
    cursor: 'poll-cursor-2',
    events: [
      event(2, 'Completed', { outcome: 'completed' }),
      event(1, 'Artifact', { artifactId: artifact.artifactId }),
      event(1, 'Artifact', { artifactId: artifact.artifactId }),
    ],
  }
  mock.observations.push(terminalBatch)
  const observed = await runtime.observeNow('run-cloud')
  assert.equal(observed.status, 'completed')
  assert.equal(mock.calls.artifacts.length, 1)
  assert.equal(terminalTransitions, 1)
  assert.deepEqual(value.outcomeStore.getArtifact(artifact.artifactId), artifact)

  await runtime.handleCallback('cloud.mock', 'job-cloud-1', terminalBatch)
  await runtime.handleCallback('cloud.mock', 'job-cloud-1', {
    cursor: 'older-cursor',
    events: [event(0, 'Usage', { mode: 'delta', usage: { inputTokens: 4 } })],
  })
  const state = ledger.get('run-cloud').agentRuns[0].context.connectorEventState
  assert.equal(state.events.length, 3)
  assert.deepEqual(state.artifactIds, [artifact.artifactId])
  assert.equal(mock.calls.artifacts.length, 1)
  assert.equal(terminalTransitions, 1)
  assert.equal(ledger.get('run-cloud').remoteJob.cursor, 'poll-cursor-2')
})

test('explicit cancel calls the remote connector at most once across restart', async (t) => {
  const value = fixture(t)
  const mock = mockConnector()
  const ledger = new RunLedger({ storagePath: value.ledgerPath })
  seedRun(ledger)
  const runtime = runtimeFor(value, ledger, mock.connector)
  await runtime.submit({
    connectorId: 'cloud.mock', runId: 'run-cloud', agentRunId: 'agent-cloud',
    prompt: 'Long-running job.',
  })
  assert.equal(await runtime.cancel('run-cloud'), true)
  assert.equal(mock.calls.cancel.length, 1)
  await runtime.shutdown()

  const restartedLedger = new RunLedger({ storagePath: value.ledgerPath })
  const restarted = runtimeFor(value, restartedLedger, mock.connector)
  restarted.workspaceLedger().recoverInterrupted()
  await restarted.start()
  assert.equal(await restarted.cancel('run-cloud'), false)
  assert.equal(mock.calls.cancel.length, 1)
})

test('replays a dispatched cancel after crash with the same idempotency key', async (t) => {
  const value = fixture(t)
  const mock = mockConnector()
  const ledger = new RunLedger({ storagePath: value.ledgerPath })
  seedRun(ledger)
  const runtime = runtimeFor(value, ledger, mock.connector)
  await runtime.submit({
    connectorId: 'cloud.mock', runId: 'run-cloud', agentRunId: 'agent-cloud',
    prompt: 'Cancel idempotently after restart.',
  })
  const update = runtime.operationStore.update.bind(runtime.operationStore)
  let failDeliveryAck = true
  runtime.operationStore.update = (operationId, state) => {
    if (state === 'delivered' && failDeliveryAck) {
      failDeliveryAck = false
      throw new Error('SIMULATED_CRASH_AFTER_CANCEL_DISPATCH')
    }
    return update(operationId, state)
  }

  await assert.rejects(
    runtime.cancel('run-cloud'),
    { message: 'SIMULATED_CRASH_AFTER_CANCEL_DISPATCH' },
  )
  assert.equal(mock.calls.cancel.length, 1)
  const [dispatched] = new CloudAgentOperationStore({
    storagePath: value.operationPath,
  }).list().filter(operation => operation.type === 'cancel')
  assert.equal(dispatched.state, 'dispatched')
  assert.equal(mock.calls.cancel[0].idempotencyKey, dispatched.operationId)
  await runtime.shutdown()

  const restartedLedger = new RunLedger({ storagePath: value.ledgerPath })
  const restarted = runtimeFor(value, restartedLedger, mock.connector)
  await restarted.start()

  assert.equal(mock.calls.cancel.length, 2)
  assert.equal(mock.calls.cancel[1].idempotencyKey, dispatched.operationId)
  assert.equal(new CloudAgentOperationStore({
    storagePath: value.operationPath,
  }).list().find(operation => operation.operationId === dispatched.operationId).state, 'delivered')
  await restarted.shutdown()
})

test('start remains retryable when Run recovery fails', async (t) => {
  const value = fixture(t)
  const ledger = new RunLedger({ storagePath: value.ledgerPath })
  const runtime = runtimeFor(value, ledger, null)
  const recoverInterrupted = ledger.recoverInterrupted.bind(ledger)
  let failRecovery = true
  ledger.recoverInterrupted = (options) => {
    if (failRecovery) throw new Error('SIMULATED_CLOUD_RECOVERY_FAILURE')
    return recoverInterrupted(options)
  }

  await assert.rejects(
    runtime.start(),
    { message: 'SIMULATED_CLOUD_RECOVERY_FAILURE' },
  )
  assert.equal(runtime.started, false)
  assert.equal(runtime.stopping, true)
  assert.equal(runtime.timers.size, 0)

  failRecovery = false
  assert.deepEqual(await runtime.start(), [])
  assert.equal(runtime.started, true)
  assert.equal(runtime.stopping, false)
  await runtime.shutdown()
  assert.equal(runtime.started, false)
  assert.equal(runtime.stopping, true)
})

test('start retries failed operation replay and restores observation', async (t) => {
  const value = fixture(t)
  const initialMock = mockConnector()
  const ledger = new RunLedger({ storagePath: value.ledgerPath })
  seedRun(ledger)
  const initial = runtimeFor(value, ledger, initialMock.connector)
  await initial.submit({
    connectorId: 'cloud.mock', runId: 'run-cloud', agentRunId: 'agent-cloud',
    prompt: 'Recover a pending cancellation.',
  })
  initial.operationStore.put({
    type: 'cancel', runId: 'run-cloud', connectorId: 'cloud.mock',
    jobId: 'job-cloud-1', requestId: '', payload: {},
  }, 'dispatched')
  await initial.shutdown()

  let failReplay = true
  const mock = mockConnector({
    cancel() {
      if (failReplay) throw new Error('SIMULATED_CLOUD_REPLAY_FAILURE')
    },
  })
  const scheduled = []
  const restarted = runtimeFor(
    value,
    new RunLedger({ storagePath: value.ledgerPath }),
    mock.connector,
    {
      autoObserve: true,
      setTimer(callback, delay) {
        const timer = { callback, delay, unref() {} }
        scheduled.push(timer)
        return timer
      },
      clearTimer(timer) { timer.cleared = true },
    },
  )

  await assert.rejects(
    restarted.start(),
    { message: 'SIMULATED_CLOUD_REPLAY_FAILURE' },
  )
  assert.equal(restarted.started, false)
  assert.equal(restarted.stopping, true)
  assert.equal(restarted.timers.size, 0)

  failReplay = false
  const recoveries = await restarted.start()
  assert.equal(recoveries.length, 1)
  assert.equal(restarted.started, true)
  assert.equal(restarted.stopping, false)
  assert.equal(restarted.timers.size, 1)
  assert.equal(mock.calls.cancel.length, 2)
  assert.equal(mock.calls.cancel[0].idempotencyKey, mock.calls.cancel[1].idempotencyKey)

  await scheduled[0].callback()
  assert.equal(mock.calls.reconcile.length, 1)
  await restarted.shutdown()
  assert.equal(restarted.started, false)
  assert.equal(restarted.stopping, true)
  assert.equal(restarted.timers.size, 0)
})

test('start clears partial recovery state when observation scheduling fails', async (t) => {
  const value = fixture(t)
  const mock = mockConnector()
  const ledger = new RunLedger({ storagePath: value.ledgerPath })
  seedRun(ledger)
  const initial = runtimeFor(value, ledger, mock.connector)
  await initial.submit({
    connectorId: 'cloud.mock', runId: 'run-cloud', agentRunId: 'agent-cloud',
    prompt: 'Retry recovery scheduling.',
  })
  await initial.shutdown()

  let failSchedule = true
  const restarted = runtimeFor(
    value,
    new RunLedger({ storagePath: value.ledgerPath }),
    mock.connector,
    {
      autoObserve: true,
      setTimer(callback, delay) {
        if (failSchedule) throw new Error('SIMULATED_CLOUD_SCHEDULE_FAILURE')
        return { callback, delay, unref() {} }
      },
      clearTimer() {},
    },
  )

  await assert.rejects(
    restarted.start(),
    { message: 'SIMULATED_CLOUD_SCHEDULE_FAILURE' },
  )
  assert.equal(restarted.started, false)
  assert.equal(restarted.stopping, true)
  assert.equal(restarted.timers.size, 0)

  failSchedule = false
  assert.equal((await restarted.start()).length, 1)
  assert.equal(restarted.started, true)
  assert.equal(restarted.stopping, false)
  assert.equal(restarted.timers.size, 1)
  await restarted.shutdown()
  assert.equal(restarted.started, false)
  assert.equal(restarted.stopping, true)
  assert.equal(restarted.timers.size, 0)
})

test('rejects a persisted Connector event state bound to another Run', async (t) => {
  const value = fixture(t)
  const mock = mockConnector()
  const ledger = new RunLedger({ storagePath: value.ledgerPath })
  seedRun(ledger)
  const runtime = runtimeFor(value, ledger, mock.connector)
  await runtime.submit({
    connectorId: 'cloud.mock', runId: 'run-cloud', agentRunId: 'agent-cloud',
    prompt: 'Keep provenance bound.',
  })
  const record = ledger.get('run-cloud')
  const agentRun = record.agentRuns[0]
  ledger.checkpoint({
    runId: record.runId,
    agentRuns: [{
      ...agentRun,
      context: {
        ...agentRun.context,
        connectorEventState: {
          ...agentRun.context.connectorEventState,
          runId: 'run-forged',
        },
      },
    }],
  })

  await assert.rejects(
    runtime.observeNow('run-cloud'),
    { message: 'CLOUD_AGENT_RUN_PROVENANCE_MISMATCH' },
  )
})

test('local-only recovery remains available with no configured Cloud Connector', async (t) => {
  const value = fixture(t)
  const ledger = new RunLedger({ storagePath: value.ledgerPath })
  seedRun(ledger, 'run-local', 'agent-local')
  const runtime = runtimeFor(value, ledger, null)

  const changed = runtime.workspaceLedger().recoverInterrupted()
  assert.equal(changed[0].status, 'interrupted')
  assert.equal(changed[0].agentRuns[0].status, 'interrupted')
  assert.deepEqual(await runtime.start(), [])
  assert.equal(runtime.connectorIds().length, 0)
})

test('Cloud startup preserves a local Human Gate validated by workspace recovery', async (t) => {
  const value = fixture(t)
  const ledger = new RunLedger({ storagePath: value.ledgerPath })
  ledger.checkpoint({
    runId: 'run-local-gate',
    taskId: 'task-local-gate',
    contextPackId: `context-pack-${'b'.repeat(64)}`,
    contextPackState: 'captured',
    groupId: 'group-local-gate',
    threadRootId: 'task-local-gate',
    mode: 'manual',
    targetKinds: ['codex'],
    status: 'waiting',
    reason: 'human_gate_pending',
    permissionMode: 'read-only',
    agentRuns: [{
      agentRunId: 'agent-local-gate', kind: 'codex', round: 0, status: 'interrupted',
    }],
    continuation: {
      gateId: `human-gate-${'c'.repeat(64)}`,
      gateType: 'permission',
      resumeKind: 'agent_slot',
      state: 'pending',
      agentRunId: 'agent-local-gate',
      agentKind: 'codex',
      round: 0,
      createdAt: 1000,
      updatedAt: 1000,
    },
  })
  ledger.checkpoint({
    runId: 'run-forged-local-gate',
    taskId: 'task-forged-local-gate',
    contextPackId: `context-pack-${'d'.repeat(64)}`,
    contextPackState: 'captured',
    groupId: 'group-forged-local-gate',
    threadRootId: 'task-forged-local-gate',
    mode: 'manual',
    targetKinds: ['codex'],
    status: 'waiting',
    reason: 'human_gate_pending',
    permissionMode: 'read-only',
    agentRuns: [{
      agentRunId: 'agent-forged-local-gate',
      kind: 'codex',
      round: 0,
      status: 'interrupted',
    }],
    continuation: {
      gateId: `human-gate-${'e'.repeat(64)}`,
      gateType: 'permission',
      resumeKind: 'agent_slot',
      state: 'pending',
      agentRunId: 'agent-forged-local-gate',
      agentKind: 'codex',
      round: 0,
      createdAt: 1000,
      updatedAt: 1000,
    },
  })
  const runtime = runtimeFor(value, ledger, null)

  runtime.workspaceLedger().recoverInterrupted({
    preserveWaitingRun: record => record.runId === 'run-local-gate',
  })
  assert.equal(ledger.get('run-local-gate').status, 'waiting')
  assert.equal(ledger.get('run-forged-local-gate').status, 'interrupted')

  assert.deepEqual(await runtime.start(), [])
  const recovered = ledger.get('run-local-gate')
  assert.equal(recovered.status, 'waiting')
  assert.equal(recovered.reason, 'human_gate_pending')
  assert.equal(recovered.continuation.state, 'pending')
  assert.equal(recovered.agentRuns[0].status, 'interrupted')
  await runtime.shutdown()
})

test('Cloud runtime startup retry is capped, deduplicated, identity-bound, and cancellable', async () => {
  const scheduled = []
  let attempts = 0
  let active = true
  const runtime = {
    async start() {
      attempts += 1
      if (attempts < 3) throw new Error(`START_FAILURE_${attempts}`)
      return []
    },
  }
  const retry = createCloudAgentStartRetry({
    runtime,
    isActive: candidate => active && candidate === runtime,
    baseDelayMs: 10,
    maxDelayMs: 15,
    setTimer(callback, delay) {
      const timer = { callback, delay, unrefCalled: false, unref() { this.unrefCalled = true } }
      scheduled.push(timer)
      return timer
    },
    clearTimer(timer) { timer.cleared = true },
  })

  assert.equal(await retry.start(), false)
  assert.equal(attempts, 1)
  assert.equal(scheduled[0].delay, 10)
  assert.equal(scheduled[0].unrefCalled, true)
  assert.equal(await retry.start(), false)
  assert.equal(attempts, 1)
  await scheduled[0].callback()
  assert.equal(attempts, 2)
  assert.equal(scheduled[1].delay, 15)
  await scheduled[1].callback()
  assert.equal(attempts, 3)
  assert.equal(scheduled.length, 2)
  assert.equal(await retry.start(), true)
  assert.equal(attempts, 3)

  const staleTimers = []
  let staleAttempts = 0
  const staleRuntime = {
    async start() {
      staleAttempts += 1
      throw new Error('STALE_RUNTIME_FAILURE')
    },
  }
  const staleRetry = createCloudAgentStartRetry({
    runtime: staleRuntime,
    isActive: () => active,
    baseDelayMs: 5,
    setTimer(callback, delay) {
      const timer = { callback, delay, unref() {} }
      staleTimers.push(timer)
      return timer
    },
    clearTimer(timer) { timer.cleared = true },
  })
  assert.equal(await staleRetry.start(), false)
  active = false
  await staleTimers[0].callback()
  assert.equal(staleAttempts, 1)

  active = true
  const cancelledTimers = []
  const cancelledRetry = createCloudAgentStartRetry({
    runtime: staleRuntime,
    isActive: () => active,
    baseDelayMs: 5,
    setTimer(callback, delay) {
      const timer = { callback, delay, unref() {} }
      cancelledTimers.push(timer)
      return timer
    },
    clearTimer(timer) { timer.cleared = true },
  })
  assert.equal(await cancelledRetry.start(), false)
  cancelledRetry.cancel()
  assert.equal(cancelledTimers[0].cleared, true)
  await cancelledTimers[0].callback()
  assert.equal(staleAttempts, 2)
})
