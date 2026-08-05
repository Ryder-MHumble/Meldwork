const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { LocalWorkspace } = require('../src/local-workspace.cjs')
const { RunLedger } = require('../src/run-ledger.cjs')
const { fixture } = require('./local-workspace-test-helpers.cjs')

function pendingGate(workspace, timeoutMs = 2000) {
  const current = workspace.listHumanGates({ pendingOnly: true })[0]
  if (current) return Promise.resolve(current)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      workspace.off('changed', changed)
      reject(new Error('TEST_HUMAN_GATE_TIMEOUT'))
    }, timeoutMs)
    const changed = () => {
      const gate = workspace.listHumanGates({ pendingOnly: true })[0]
      if (!gate) return
      clearTimeout(timer)
      workspace.off('changed', changed)
      resolve(gate)
    }
    workspace.on('changed', changed)
  })
}

async function waitForRunStatus(ledger, runId, status, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const record = ledger.get(runId)
    if (record?.status === status) return record
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`TEST_RUN_STATUS_TIMEOUT:${runId}:${status}`)
}

async function stoppedBudgetGate(options, directory, text) {
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: text, agentKinds: ['codex'], workdir: directory,
  })
  const gatePromise = pendingGate(workspace)
  const send = workspace.sendMessage({
    groupId: group.id,
    text,
    targetKinds: ['codex'],
    budget: {
      limits: { costMicros: 100 },
      enforcement: { costMicros: 'hard' },
    },
  })
  const pending = await gatePromise
  await workspace.stopAll()
  await send
  return { workspace, pending }
}

function approveGate(store, gateId) {
  return store.decide(gateId, {
    status: 'approved',
    optionId: 'continue-unmetered',
    actorId: 'local-user',
    decidedAt: '2026-07-28T00:00:00.000Z',
  })
}

function removeContextPack(workspace, contextPackId) {
  const hash = contextPackId.slice(contextPackId.lastIndexOf('-') + 1)
  fs.rmSync(path.join(
    workspace.contextPackStore.rootPath,
    'context-packs',
    hash.slice(0, 2),
    `${contextPackId}.json`,
  ))
}

test('restart resumes a durable Gate decision whose continuation checkpoint stayed pending once', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const ledger = new RunLedger({ storagePath: ledgerPath })
  let invocations = 0
  options.runLedger = ledger
  options.runAgent = async () => {
    invocations += 1
    return { text: 'Recovered approved result', sessionRef: 'codex-recovered-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Decision checkpoint crash', agentKinds: ['codex'], workdir: directory,
  })
  const gatePromise = pendingGate(workspace)
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Resume the already approved Gate after restart',
    targetKinds: ['codex'],
    budget: {
      limits: { costMicros: 100 },
      enforcement: { costMicros: 'hard' },
    },
  })
  const pending = await gatePromise
  await workspace.stopAll()
  await send

  approveGate(workspace.humanGateStore, pending.gateId)
  assert.equal(ledger.get(pending.runId).continuation.state, 'pending')
  assert.equal(invocations, 0)

  const restartedLedger = new RunLedger({ storagePath: ledgerPath })
  const restarted = new LocalWorkspace({ ...options, runLedger: restartedLedger })
  await restarted.refreshAgents()
  const completed = await waitForRunStatus(restartedLedger, pending.runId, 'completed')

  assert.equal(invocations, 1)
  assert.equal(completed.continuation.state, 'completed')
  assert.equal(restarted.snapshot().messages.some(message => (
    message.role === 'agent'
      && message.content === 'Recovered approved result'
      && message.trace?.runId === pending.runId
  )), true)

  const secondRestart = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath }),
  })
  await secondRestart.refreshAgents()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(invocations, 1)
})

test('restart fails a non-final Agent Gate closed instead of completing the remaining slots', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const ledger = new RunLedger({ storagePath: ledgerPath })
  const invokedKinds = []
  options.runLedger = ledger
  options.runAgent = async (agent, _prompt, _workdir, runOptions) => {
    invokedKinds.push(agent.kind)
    assert.equal(agent.kind, 'codex')
    await runOptions.onSessionRef('codex-non-final-session', { transport: 'acp' })
    const decision = await runOptions.onPermissionRequest({
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
      ],
      operation: { kind: 'write', path: 'first-slot.txt' },
    }, { signal: runOptions.signal })
    return { text: `decision:${decision.optionId}`, sessionRef: 'codex-non-final-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Non-final Gate recovery',
    agentKinds: ['codex', 'hermes'],
    workdir: directory,
    allowWrite: true,
  })
  const gatePromise = pendingGate(workspace)
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Do not skip the second Agent slot after restart',
    targetKinds: ['codex', 'hermes'],
  })
  const pending = await gatePromise
  await workspace.stopAll()
  await send

  const restartedLedger = new RunLedger({ storagePath: ledgerPath })
  const restarted = new LocalWorkspace({ ...options, runLedger: restartedLedger })
  await restarted.refreshAgents()
  restarted.decideHumanGate(pending.gateId, {
    status: 'approved', optionId: 'allow-once', actorId: 'local-user',
  })
  const failed = await waitForRunStatus(restartedLedger, pending.runId, 'failed')

  assert.deepEqual(invokedKinds, ['codex'])
  assert.equal(failed.reason, 'LOCAL_RUN_ORCHESTRATION_RESUME_UNAVAILABLE')
  assert.equal(failed.continuation.state, 'failed')
  assert.equal(restarted.snapshot().messages.some(message => (
    message.role === 'agent' && message.agentKind === 'hermes'
  )), false)
})

test('a failed Gate resume checkpoint restores live continuation state for retry', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    await runOptions.onSessionRef('codex-checkpoint-retry-session', { transport: 'acp' })
    const decision = await runOptions.onPermissionRequest({
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
      ],
      operation: { kind: 'write', path: 'retry-after-checkpoint.txt' },
    }, { signal: runOptions.signal })
    return { text: `decision:${decision.optionId}`, sessionRef: 'codex-checkpoint-retry-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Gate checkpoint retry', agentKinds: ['codex'], workdir: directory, allowWrite: true,
  })
  const gatePromise = pendingGate(workspace)
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Retry the same decision after a transient checkpoint failure',
    targetKinds: ['codex'],
  })
  const pending = await gatePromise
  const controller = workspace.activeRuns.get(group.id)
  const originalCheckpointRun = workspace.checkpointRun.bind(workspace)
  let rejectNextCheckpoint = true
  workspace.checkpointRun = (...args) => {
    if (rejectNextCheckpoint) {
      rejectNextCheckpoint = false
      return false
    }
    return originalCheckpointRun(...args)
  }

  assert.throws(() => workspace.decideHumanGate(pending.gateId, {
    status: 'approved', optionId: 'allow-once', actorId: 'local-user',
  }), /LOCAL_RUN_PERSIST_FAILED/u)
  assert.equal(controller.waitingGateIds.has(pending.gateId), true)
  assert.equal(controller.continuation.gateId, pending.gateId)
  assert.equal(controller.continuation.state, 'pending')
  assert.equal(workspace.listHumanGates({ pendingOnly: true })[0].gateId, pending.gateId)

  workspace.decideHumanGate(pending.gateId, {
    status: 'approved', optionId: 'allow-once', actorId: 'local-user',
  })
  await send
  const completed = await waitForRunStatus(ledger, pending.runId, 'completed')

  assert.equal(completed.continuation.state, 'completed')
  assert.equal(workspace.snapshot().messages.some(message => (
    message.role === 'agent' && message.content === 'decision:allow-once'
  )), true)
})

test('a failed initial Gate checkpoint clears its waiter and restores the live Run for retry', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runLedger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Initial Gate checkpoint retry', agentKinds: ['codex'], workdir: directory,
  })
  const controller = workspace.createRunController('manual', ['codex'], 'task-gate-retry')
  controller.groupId = group.id
  workspace.activeRuns.set(group.id, controller)
  const input = {
    type: 'permission',
    runId: controller.runId,
    agentRunId: 'agent-run-gate-retry',
    agentKind: 'codex',
    summary: 'Agent requests permission to retry a tool action.',
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
    ],
    request: { operation: { kind: 'write', path: 'retry.txt' } },
  }
  const gateOptions = {
    continuation: {
      resumeKind: 'agent_slot',
      agentRunId: 'agent-run-gate-retry',
      agentKind: 'codex',
      round: 0,
    },
  }

  workspace.checkpointRun = () => false
  await assert.rejects(
    workspace.requestHumanGate(input, gateOptions),
    { message: 'LOCAL_RUN_PERSIST_FAILED' },
  )
  assert.equal(workspace.humanGateCoordinator.waiters.size, 0)
  assert.equal(workspace.humanGateWaitTails.size, 0)
  assert.equal(controller.continuation, null)
  assert.equal(controller.waitingGateIds.size, 0)
  assert.equal(workspace.listHumanGates({ pendingOnly: true }).length, 1)

  workspace.checkpointRun = () => true
  const retry = workspace.requestHumanGate(input, gateOptions)
  await new Promise(resolve => setImmediate(resolve))
  const [pending] = workspace.listHumanGates({ pendingOnly: true })
  assert.equal(workspace.humanGateCoordinator.waiters.size, 1)
  workspace.decideHumanGate(pending.gateId, { optionId: 'allow-once' })
  assert.equal((await retry).status, 'approved')
  assert.equal(workspace.humanGateCoordinator.waiters.size, 0)

  workspace.activeRuns.delete(group.id)
  controller.resolveDone()
})

test('parallel Agent gates are exposed one at a time without overwriting continuation', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Parallel Gate queue', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const controller = workspace.createRunController(
    'manual', ['codex', 'hermes'], 'parallel-gate-thread',
  )
  controller.groupId = group.id
  workspace.activeRuns.set(group.id, controller)
  const gateInput = (agentKind, suffix) => ({
    type: 'permission',
    runId: controller.runId,
    agentRunId: `agent-run-${suffix}`,
    agentKind,
    summary: 'Agent requests permission to continue a tool action.',
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
    ],
    request: {
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
      ],
      operation: { kind: 'write', path: `${suffix}.txt` },
    },
  })
  const gateOptions = (agentKind, suffix) => ({
    continuation: {
      resumeKind: 'agent_slot',
      agentRunId: `agent-run-${suffix}`,
      agentKind,
      round: 0,
    },
  })

  const firstDecision = workspace.requestHumanGate(
    gateInput('codex', 'first'), gateOptions('codex', 'first'),
  )
  const firstGate = await pendingGate(workspace)
  const secondDecision = workspace.requestHumanGate(
    gateInput('hermes', 'second'), gateOptions('hermes', 'second'),
  )
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(workspace.listHumanGates({ pendingOnly: true }).length, 1)
  assert.equal(controller.continuation.gateId, firstGate.gateId)
  assert.equal(controller.continuation.agentKind, 'codex')
  workspace.decideHumanGate(firstGate.gateId, {
    status: 'approved', optionId: 'allow-once', actorId: 'local-user',
  })
  await firstDecision

  const secondGate = await pendingGate(workspace)
  assert.notEqual(secondGate.gateId, firstGate.gateId)
  assert.equal(workspace.listHumanGates({ pendingOnly: true }).length, 1)
  assert.equal(controller.continuation.gateId, secondGate.gateId)
  assert.equal(controller.continuation.agentKind, 'hermes')
  workspace.decideHumanGate(secondGate.gateId, {
    status: 'approved', optionId: 'allow-once', actorId: 'local-user',
  })
  await secondDecision

  assert.equal(workspace.listHumanGates({ pendingOnly: true }).length, 0)
  workspace.activeRuns.delete(group.id)
})

test('restart approval resumes the exact permission request without replaying prior side effects', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const ledger = new RunLedger({ storagePath: ledgerPath })
  let invocations = 0
  let preGateSideEffects = 0
  const permissionRequest = {
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
    ],
    operation: { kind: 'write', path: 'already-touched.txt' },
  }
  options.runLedger = ledger
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    invocations += 1
    await runOptions.onSessionRef('codex-side-effect-session', { transport: 'acp' })
    if (invocations === 1) preGateSideEffects += 1
    const decision = await runOptions.onPermissionRequest(
      permissionRequest,
      { signal: runOptions.signal },
    )
    return { text: `decision:${decision.optionId}`, sessionRef: 'codex-side-effect-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Permission replay guard', agentKinds: ['codex'], workdir: directory, allowWrite: true,
  })
  const gatePromise = pendingGate(workspace)
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Do not replay work completed before the permission request',
    targetKinds: ['codex'],
  })
  const pending = await gatePromise
  await workspace.stopAll()
  await send

  const restartedLedger = new RunLedger({ storagePath: ledgerPath })
  const restarted = new LocalWorkspace({ ...options, runLedger: restartedLedger })
  await restarted.refreshAgents()
  const waitingSnapshot = restarted.snapshot()
  assert.equal(waitingSnapshot.humanGates[0].gateId, pending.gateId)
  assert.equal(waitingSnapshot.runs[0].runId, pending.runId)

  restarted.decideHumanGate(pending.gateId, {
    status: 'approved', optionId: 'allow-once', actorId: 'local-user',
  })
  const completed = await waitForRunStatus(restartedLedger, pending.runId, 'completed')

  assert.equal(invocations, 2)
  assert.equal(preGateSideEffects, 1)
  assert.equal(completed.continuation.state, 'completed')
  assert.equal(restarted.snapshot().messages.some(message => (
    message.role === 'agent' && message.content === 'decision:allow-once'
  )), true)
  assert.equal(restarted.snapshot().messages.some(message => (
    message.role === 'system'
      && message.agentKind === 'codex'
      && message.system?.key === 'system.agentCallFailed'
  )), false)
})

test('restart approval fails closed when a permission continuation has no persisted Session', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const ledger = new RunLedger({ storagePath: ledgerPath })
  let invocations = 0
  options.runLedger = ledger
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    invocations += 1
    const decision = await runOptions.onPermissionRequest({
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
      ],
      operation: { kind: 'write', path: 'must-not-replay.txt' },
    }, { signal: runOptions.signal })
    return { text: `decision:${decision.optionId}`, sessionRef: 'late-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Missing permission Session', agentKinds: ['codex'], workdir: directory, allowWrite: true,
  })
  const gatePromise = pendingGate(workspace)
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Never replay a permission continuation without a persisted Session',
    targetKinds: ['codex'],
  })
  const pending = await gatePromise
  await workspace.stopAll()
  await send

  const restartedLedger = new RunLedger({ storagePath: ledgerPath })
  const restarted = new LocalWorkspace({ ...options, runLedger: restartedLedger })
  await restarted.refreshAgents()
  restarted.decideHumanGate(pending.gateId, {
    status: 'approved', optionId: 'allow-once', actorId: 'local-user',
  })
  const failed = await waitForRunStatus(restartedLedger, pending.runId, 'failed')

  assert.equal(invocations, 1)
  assert.equal(failed.reason, 'LOCAL_RUN_PERMISSION_RESUME_UNAVAILABLE')
  assert.equal(failed.continuation.state, 'failed')
  assert.equal(restarted.snapshot().messages.some(message => (
    message.role === 'agent' && message.content === 'decision:allow-once'
  )), false)
})

test('restart approval fails closed when the resumed Session reissues a different permission request', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const ledger = new RunLedger({ storagePath: ledgerPath })
  let invocations = 0
  const originalRequest = {
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
    ],
    operation: { kind: 'write', path: 'approved-target.txt' },
  }
  options.runLedger = ledger
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    invocations += 1
    await runOptions.onSessionRef('codex-mismatched-session', { transport: 'acp' })
    const request = invocations === 1
      ? originalRequest
      : { ...originalRequest, operation: { kind: 'write', path: 'different-target.txt' } }
    const decision = await runOptions.onPermissionRequest(request, { signal: runOptions.signal })
    return { text: `decision:${decision.optionId}`, sessionRef: 'codex-mismatched-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Mismatched permission request',
    agentKinds: ['codex'],
    workdir: directory,
    allowWrite: true,
  })
  const gatePromise = pendingGate(workspace)
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Apply approval only to the exact persisted permission request',
    targetKinds: ['codex'],
  })
  const pending = await gatePromise
  await workspace.stopAll()
  await send

  const restartedLedger = new RunLedger({ storagePath: ledgerPath })
  const restarted = new LocalWorkspace({ ...options, runLedger: restartedLedger })
  await restarted.refreshAgents()
  restarted.decideHumanGate(pending.gateId, {
    status: 'approved', optionId: 'allow-once', actorId: 'local-user',
  })
  const failed = await waitForRunStatus(restartedLedger, pending.runId, 'failed')

  assert.equal(invocations, 2)
  assert.equal(failed.reason, 'LOCAL_RUN_PERMISSION_REQUEST_MISMATCH')
  assert.equal(failed.continuation.state, 'failed')
  assert.equal(restarted.listHumanGates({ pendingOnly: true }).length, 0)
  assert.equal(restarted.snapshot().messages.some(message => (
    message.role === 'agent' && message.content === 'decision:allow-once'
  )), false)
})

test('restart fails an approved continuation closed when its Context Pack is missing', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const ledger = new RunLedger({ storagePath: ledgerPath })
  let invocations = 0
  options.runLedger = ledger
  options.runAgent = async () => {
    invocations += 1
    return { text: 'Must not execute', sessionRef: 'codex-invalid-session' }
  }
  const { workspace, pending } = await stoppedBudgetGate(
    options, directory, 'Reject an approved Gate without immutable context',
  )
  approveGate(workspace.humanGateStore, pending.gateId)
  removeContextPack(workspace, ledger.get(pending.runId).contextPackId)

  const restartedLedger = new RunLedger({ storagePath: ledgerPath })
  const restarted = new LocalWorkspace({ ...options, runLedger: restartedLedger })
  await restarted.refreshAgents()
  const failed = await waitForRunStatus(restartedLedger, pending.runId, 'failed')

  assert.equal(invocations, 0)
  assert.equal(failed.reason, 'human_gate_continuation_invalid')
  assert.equal(failed.continuation.state, 'failed')
})

test('restart fails an approved Gate that belongs to a different Run closed', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const ledger = new RunLedger({ storagePath: ledgerPath })
  let invocations = 0
  options.runLedger = ledger
  options.runAgent = async () => {
    invocations += 1
    return { text: 'Must not execute', sessionRef: 'codex-cross-run-session' }
  }
  const { workspace, pending } = await stoppedBudgetGate(
    options, directory, 'Reject a cross-Run Gate decision',
  )
  const originalRequest = workspace.humanGateStore.request(pending.gateId)
  const crossRunGate = workspace.humanGateStore.create({
    type: pending.type,
    runId: 'run-from-another-task',
    agentRunId: pending.agentRunId,
    agentKind: pending.agentKind,
    summary: pending.summary,
    options: pending.options,
    request: originalRequest,
    createdAt: '2026-07-28T00:00:00.000Z',
  })
  const durable = ledger.get(pending.runId)
  ledger.checkpoint({
    runId: durable.runId,
    continuation: { ...durable.continuation, gateId: crossRunGate.gateId },
  })
  approveGate(workspace.humanGateStore, crossRunGate.gateId)

  const restartedLedger = new RunLedger({ storagePath: ledgerPath })
  const restarted = new LocalWorkspace({ ...options, runLedger: restartedLedger })
  await restarted.refreshAgents()
  const failed = await waitForRunStatus(restartedLedger, pending.runId, 'failed')

  assert.equal(invocations, 0)
  assert.equal(failed.reason, 'human_gate_continuation_invalid')
  assert.equal(failed.continuation.state, 'failed')
})
