const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { RunLedger } = require('../../src/runs/run-ledger.cjs')
const { RunScheduler } = require('../../src/runs/run-scheduler.cjs')
const { deferred, fixture } = require('../support/local-workspace-test-helpers.cjs')

function pendingGate(workspace, timeoutMs = 3000) {
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

async function waitFor(predicate, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`TEST_TIMEOUT:${label}`)
}

function proposalReceipt(agentKind, summary) {
  return {
    version: 1,
    phase: 'proposal',
    summary,
    capabilities: [`${agentKind} capability`],
    intendedWork: [`${agentKind} intended work`],
    deliverables: [`${agentKind} proposal Artifact`],
    dependencies: [],
  }
}

test('V4 parallel permission Gate pauses queued same-task Agents until approval', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runScheduler = new RunScheduler({ taskLimit: 2, workspaceLimit: 2, globalLimit: 2 })
  const peerRelease = deferred()
  const peerFinished = deferred()
  const started = []
  const completed = []
  options.runAgent = async (agent, _prompt, _workdir, runOptions) => {
    started.push(agent.kind)
    if (agent.kind === 'codex') {
      const decision = await runOptions.onPermissionRequest({
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
        ],
        operation: { kind: 'write', path: 'proposal.txt' },
      }, { signal: runOptions.signal })
      assert.equal(decision.optionId, 'allow-once')
    } else if (agent.kind === 'hermes') {
      await peerRelease.promise
      peerFinished.resolve()
    }
    completed.push(agent.kind)
    return {
      text: `${agent.kind} proposal`,
      sessionRef: `${agent.kind}-session`,
      collaboration: proposalReceipt(agent.kind, `${agent.kind} independent proposal`),
    }
  }

  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'V4 Gate pause',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: false,
  })
  const gatePromise = pendingGate(workspace)
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Produce independent proposals without dispatching past a Gate.',
    mode: 'manual',
    targetKinds: ['codex', 'hermes', 'workbuddy'],
    protocol: 'v4',
  })
  const gate = await gatePromise

  peerRelease.resolve()
  await peerFinished.promise
  await new Promise(resolve => setImmediate(resolve))
  const startedBeforeDecision = [...started]
  const completedBeforeDecision = [...completed]

  workspace.decideHumanGate(gate.gateId, {
    status: 'approved', optionId: 'allow-once', actorId: 'local-user',
  })
  await send

  assert.deepEqual(startedBeforeDecision, ['codex', 'hermes'])
  assert.deepEqual(completedBeforeDecision, ['hermes'])
  assert.deepEqual(started, ['codex', 'hermes', 'workbuddy'])
  assert.equal(options.runScheduler.snapshot().active.global, 0)
  assert.deepEqual(options.runScheduler.snapshot().queued, [])
})

test('Manual V4 restart approval resumes only the bound gated slot with its operation ID', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const ledger = new RunLedger({ storagePath: ledgerPath, now: () => Date.now() })
  options.runLedger = ledger
  options.runScheduler = new RunScheduler({ taskLimit: 3, workspaceLimit: 3, globalLimit: 3 })
  const invocations = []
  const permissionRequest = {
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
    ],
    operation: { kind: 'write', path: 'writer-result.txt' },
  }
  options.runAgent = async (agent, _prompt, _workdir, runOptions) => {
    invocations.push({
      kind: agent.kind,
      operationId: runOptions.operationId,
      sandbox: runOptions.sandbox,
    })
    if (runOptions.sandbox === 'workspace-write') {
      await runOptions.onSessionRef(`${agent.kind}-v4-gate-session`, { transport: 'acp' })
      const decision = await runOptions.onPermissionRequest(
        permissionRequest,
        { signal: runOptions.signal },
      )
      assert.equal(decision.optionId, 'allow-once')
    }
    return {
      text: `${agent.kind} gated proposal`,
      sessionRef: `${agent.kind}-v4-gate-session`,
      collaboration: proposalReceipt(agent.kind, `${agent.kind} gated summary`),
    }
  }

  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Manual V4 Gate restart',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: true,
  })
  const gatePromise = pendingGate(workspace)
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Resume only the exact gated writer slot.',
    mode: 'manual',
    targetKinds: ['codex', 'hermes', 'workbuddy'],
    protocol: 'v4',
  })
  const gate = await gatePromise
  const beforeRestart = await waitFor(() => {
    const record = ledger.get(gate.runId)
    const settledPeers = record?.orchestration?.slots.filter(slot => (
      slot.agentKind !== gate.agentKind && slot.status === 'completed'
    ))
    return settledPeers?.length === 2 ? record : null
  }, 'settled V4 Gate peers')
  const writerSlot = beforeRestart.orchestration.slots.find(slot => (
    slot.agentKind === gate.agentKind
  ))
  assert.ok(writerSlot)

  await workspace.stopAll()
  await send
  assert.equal(ledger.get(gate.runId).status, 'waiting')

  const restartedLedger = new RunLedger({ storagePath: ledgerPath, now: () => Date.now() })
  const restarted = new LocalWorkspace({ ...options, runLedger: restartedLedger })
  await restarted.refreshAgents()
  restarted.decideHumanGate(gate.gateId, {
    status: 'approved', optionId: 'allow-once', actorId: 'local-user',
  })
  const completed = await waitFor(() => {
    const record = restartedLedger.get(gate.runId)
    return record?.status === 'completed' ? record : null
  }, 'completed Manual V4 Gate restart')

  const counts = new Map(['codex', 'hermes', 'workbuddy'].map(kind => [
    kind, invocations.filter(call => call.kind === kind).length,
  ]))
  assert.equal(counts.get(gate.agentKind), 2)
  for (const kind of ['codex', 'hermes', 'workbuddy'].filter(kind => kind !== gate.agentKind)) {
    assert.equal(counts.get(kind), 1)
  }
  assert.deepEqual(
    invocations.filter(call => call.kind === gate.agentKind).map(call => call.operationId),
    [writerSlot.operationId, writerSlot.operationId],
  )
  assert.equal(completed.continuation.state, 'completed')
  assert.deepEqual(completed.orchestration.commitState.committedKinds, [
    'codex', 'hermes', 'workbuddy',
  ])
})

test('Manual V4 Gate restart runs untouched safe peers before the stable barrier', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const ledger = new RunLedger({ storagePath: ledgerPath, now: () => Date.now() })
  options.runLedger = ledger
  options.runScheduler = new RunScheduler({ taskLimit: 1, workspaceLimit: 1, globalLimit: 1 })
  const invocations = []
  const permissionRequest = {
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
    ],
    operation: { kind: 'write', path: 'capacity-one-writer.txt' },
  }
  options.runAgent = async (agent, _prompt, _workdir, runOptions) => {
    invocations.push({
      kind: agent.kind,
      operationId: runOptions.operationId,
      sandbox: runOptions.sandbox,
    })
    if (runOptions.sandbox === 'workspace-write') {
      await runOptions.onSessionRef(`${agent.kind}-capacity-one-session`, { transport: 'acp' })
      const decision = await runOptions.onPermissionRequest(
        permissionRequest,
        { signal: runOptions.signal },
      )
      assert.equal(decision.optionId, 'allow-once')
    }
    return {
      text: `${agent.kind} capacity-one proposal`,
      sessionRef: `${agent.kind}-capacity-one-session`,
      collaboration: proposalReceipt(agent.kind, `${agent.kind} capacity-one summary`),
    }
  }

  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Manual V4 Gate capacity one',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: true,
  })
  const gatePromise = pendingGate(workspace)
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Resume the writer, then run every untouched peer.',
    mode: 'manual',
    targetKinds: ['codex', 'hermes', 'workbuddy'],
    protocol: 'v4',
  })
  const gate = await gatePromise
  const beforeRestart = ledger.get(gate.runId)
  const operations = new Map(beforeRestart.orchestration.slots.map(slot => [
    slot.agentKind, slot.operationId,
  ]))
  assert.deepEqual(invocations.map(call => call.kind), [gate.agentKind])

  await workspace.stopAll()
  await send
  assert.equal(ledger.get(gate.runId).status, 'waiting')

  const restartedLedger = new RunLedger({ storagePath: ledgerPath, now: () => Date.now() })
  const restarted = new LocalWorkspace({
    ...options,
    runLedger: restartedLedger,
    runScheduler: new RunScheduler({ taskLimit: 1, workspaceLimit: 1, globalLimit: 1 }),
  })
  await restarted.refreshAgents()
  restarted.decideHumanGate(gate.gateId, {
    status: 'approved', optionId: 'allow-once', actorId: 'local-user',
  })
  const terminal = await waitFor(() => {
    const record = restartedLedger.get(gate.runId)
    return ['completed', 'partial', 'failed'].includes(record?.status) ? record : null
  }, 'terminal capacity-one Gate restart')

  assert.equal(terminal.status, 'completed')
  assert.deepEqual(invocations.map(call => call.kind), [
    gate.agentKind,
    gate.agentKind,
    ...['codex', 'hermes', 'workbuddy'].filter(kind => kind !== gate.agentKind),
  ])
  assert.equal(invocations.filter(call => call.kind === gate.agentKind).length, 2)
  for (const call of invocations) {
    assert.equal(call.operationId, operations.get(call.kind))
  }
  assert.deepEqual(terminal.orchestration.commitState.committedKinds, [
    'codex', 'hermes', 'workbuddy',
  ])
})

test('Manual V4 read-only Gate restart preserves a queued writer through the stable barrier', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const ledger = new RunLedger({ storagePath: ledgerPath, now: () => Date.now() })
  options.runLedger = ledger
  options.runScheduler = new RunScheduler({ taskLimit: 1, workspaceLimit: 1, globalLimit: 1 })
  const invocations = []
  const permissionRequest = {
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
    ],
    operation: { kind: 'read', path: 'read-only-evidence.txt' },
  }
  options.runAgent = async (agent, _prompt, _workdir, runOptions) => {
    invocations.push({
      kind: agent.kind,
      operationId: runOptions.operationId,
      sandbox: runOptions.sandbox,
    })
    if (agent.kind === 'codex') {
      assert.equal(runOptions.sandbox, 'read-only')
      await runOptions.onSessionRef(`${agent.kind}-read-only-gate-session`, { transport: 'acp' })
      const decision = await runOptions.onPermissionRequest(
        permissionRequest,
        { signal: runOptions.signal },
      )
      assert.equal(decision.optionId, 'allow-once')
    }
    return {
      text: `${agent.kind} read-only Gate proposal`,
      sessionRef: `${agent.kind}-read-only-gate-session`,
      collaboration: proposalReceipt(agent.kind, `${agent.kind} read-only Gate summary`),
    }
  }

  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Manual V4 read-only Gate queued writer',
    agentKinds: ['codex', 'workbuddy', 'hermes'],
    workdir: directory,
    allowWrite: true,
  })
  const gatePromise = pendingGate(workspace)
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Resume the read-only Gate, then run the queued writer and remaining peer.',
    mode: 'manual',
    targetKinds: ['codex', 'workbuddy', 'hermes'],
    protocol: 'v4',
  })
  const gate = await gatePromise
  const beforeRestart = ledger.get(gate.runId)
  const operations = new Map(beforeRestart.orchestration.slots.map(slot => [
    slot.agentKind, slot.operationId,
  ]))
  const gatedSlot = beforeRestart.orchestration.slots.find(slot => (
    slot.agentKind === gate.agentKind
  ))
  const writerKind = beforeRestart.orchestration.commitState.writerKind
  const writerSlot = beforeRestart.orchestration.slots.find(slot => (
    slot.agentKind === writerKind
  ))
  assert.equal(gate.agentKind, 'codex')
  assert.equal(gatedSlot.permission, 'read-only')
  assert.equal(writerKind, 'workbuddy')
  assert.equal(writerSlot.permission, 'workspace-write')
  assert.equal(writerSlot.status, 'queued')
  assert.deepEqual(invocations, [{
    kind: 'codex',
    operationId: operations.get('codex'),
    sandbox: 'read-only',
  }])

  await workspace.stopAll()
  await send
  const waiting = ledger.get(gate.runId)
  assert.equal(waiting.status, 'waiting')
  assert.equal(
    waiting.orchestration.slots.find(slot => slot.agentKind === writerKind).status,
    'queued',
  )

  const restartedLedger = new RunLedger({ storagePath: ledgerPath, now: () => Date.now() })
  const restarted = new LocalWorkspace({
    ...options,
    runLedger: restartedLedger,
    runScheduler: new RunScheduler({ taskLimit: 1, workspaceLimit: 1, globalLimit: 1 }),
  })
  await restarted.refreshAgents()
  restarted.decideHumanGate(gate.gateId, {
    status: 'approved', optionId: 'allow-once', actorId: 'local-user',
  })
  const terminal = await waitFor(() => {
    const record = restartedLedger.get(gate.runId)
    return ['completed', 'partial', 'failed'].includes(record?.status) ? record : null
  }, 'terminal read-only Gate queued-writer restart')

  assert.equal(terminal.status, 'completed')
  assert.deepEqual(invocations.map(call => call.kind), [
    'codex', 'codex', 'workbuddy', 'hermes',
  ])
  for (const call of invocations) {
    assert.equal(call.operationId, operations.get(call.kind))
    assert.equal(call.sandbox, call.kind === writerKind ? 'workspace-write' : 'read-only')
  }
  assert.deepEqual(terminal.orchestration.commitState.committedKinds, [
    'codex', 'workbuddy', 'hermes',
  ])
})

test('Manual V4 rejects approved Gate continuations with mismatched slot bindings', async (t) => {
  for (const tamper of ['operation', 'slot', 'round']) {
    await t.test(tamper, async (subtest) => {
      const { directory, options } = fixture()
      subtest.after(() => fs.rmSync(directory, { recursive: true, force: true }))
      const ledgerPath = path.join(directory, 'run-ledger.json')
      const ledger = new RunLedger({ storagePath: ledgerPath, now: () => Date.now() })
      options.runLedger = ledger
      options.runScheduler = new RunScheduler({ taskLimit: 3, workspaceLimit: 3, globalLimit: 3 })
      const invocations = []
      const permissionRequest = {
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
        ],
        operation: { kind: 'write', path: 'bound-writer-result.txt' },
      }
      options.runAgent = async (agent, _prompt, _workdir, runOptions) => {
        invocations.push(agent.kind)
        if (runOptions.sandbox === 'workspace-write') {
          await runOptions.onSessionRef(`${agent.kind}-binding-session`, { transport: 'acp' })
          await runOptions.onPermissionRequest(permissionRequest, { signal: runOptions.signal })
        }
        return {
          text: `${agent.kind} binding proposal`,
          sessionRef: `${agent.kind}-binding-session`,
          collaboration: proposalReceipt(agent.kind, `${agent.kind} binding summary`),
        }
      }

      const workspace = new LocalWorkspace(options)
      await workspace.refreshAgents()
      const group = workspace.createGroup({
        name: `Manual V4 Gate binding ${tamper}`,
        agentKinds: ['codex', 'hermes', 'workbuddy'],
        workdir: directory,
        allowWrite: true,
      })
      const gatePromise = pendingGate(workspace)
      const send = workspace.sendMessage({
        groupId: group.id,
        text: 'Reject any mismatched gated slot binding.',
        mode: 'manual',
        targetKinds: ['codex', 'hermes', 'workbuddy'],
        protocol: 'v4',
      })
      const gate = await gatePromise
      await waitFor(() => {
        const record = ledger.get(gate.runId)
        return record?.orchestration?.slots.filter(slot => (
          slot.agentKind !== gate.agentKind && slot.status === 'completed'
        )).length === 2
      }, `settled ${tamper} binding peers`)
      await workspace.stopAll()
      await send

      const durable = ledger.get(gate.runId)
      const update = { runId: durable.runId }
      if (tamper === 'round') {
        update.continuation = { ...durable.continuation, round: durable.continuation.round + 1 }
      } else {
        const orchestration = structuredClone(durable.orchestration)
        const slot = orchestration.slots.find(item => item.agentKind === gate.agentKind)
        const assignment = orchestration.plan.assignments.find(item => (
          item.agentKind === gate.agentKind
        ))
        if (tamper === 'operation') {
          const operationId = `agent-operation-${'a'.repeat(64)}`
          slot.operationId = operationId
          assignment.operationId = operationId
          orchestration.deliveryWatermarks.find(item => (
            item.agentKind === gate.agentKind
          )).operationId = operationId
        } else {
          const slotId = `slot-tampered-${gate.agentKind}`
          slot.slotId = slotId
          assignment.slotId = slotId
        }
        update.orchestration = orchestration
      }
      ledger.checkpoint(update)
      const beforeDecisionCalls = invocations.length

      const restartedLedger = new RunLedger({ storagePath: ledgerPath, now: () => Date.now() })
      const restarted = new LocalWorkspace({ ...options, runLedger: restartedLedger })
      await restarted.refreshAgents()
      restarted.decideHumanGate(gate.gateId, {
        status: 'approved', optionId: 'allow-once', actorId: 'local-user',
      })
      const failed = await waitFor(() => {
        const record = restartedLedger.get(gate.runId)
        return record?.status === 'failed' ? record : null
      }, `rejected ${tamper} binding`)

      assert.equal(invocations.length, beforeDecisionCalls)
      assert.equal(failed.reason, 'LOCAL_RUN_ORCHESTRATION_RESUME_UNAVAILABLE')
      assert.equal(failed.continuation.state, 'failed')
    })
  }
})

test('Manual V4 requires a Gate before retrying an unknown writable outcome', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger.json'),
    now: () => Date.now(),
  })
  options.runLedger = ledger
  options.runScheduler = new RunScheduler({ taskLimit: 3, workspaceLimit: 3, globalLimit: 3 })
  const invocations = []
  let writerFailures = 0
  options.runAgent = async (agent, _prompt, _workdir, runOptions) => {
    invocations.push({
      kind: agent.kind,
      operationId: runOptions.operationId,
      sandbox: runOptions.sandbox,
    })
    if (runOptions.sandbox === 'workspace-write' && writerFailures === 0) {
      writerFailures += 1
      throw Object.assign(new Error('socket reset after write'), { code: 'ECONNRESET' })
    }
    return {
      text: `${agent.kind} retry-safe proposal`,
      sessionRef: `${agent.kind}-retry-session`,
      collaboration: proposalReceipt(agent.kind, `${agent.kind} retry-safe summary`),
    }
  }

  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Manual V4 unknown writable outcome',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: true,
  })
  const gatePromise = pendingGate(workspace)
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Gate any retry whose write outcome is unknown.',
    mode: 'manual',
    targetKinds: ['codex', 'hermes', 'workbuddy'],
    protocol: 'v4',
  })
  const gate = await gatePromise
  assert.equal(gate.type, 'retry')
  const request = workspace.humanGateStore.request(gate.gateId)
  assert.equal(request.outcomeCertainty, 'unknown_outcome')
  assert.equal(request.sideEffectsPossible, true)
  await new Promise(resolve => setImmediate(resolve))

  const beforeApproval = invocations.filter(call => call.kind === gate.agentKind)
  assert.equal(beforeApproval.length, 1)
  assert.equal(beforeApproval[0].sandbox, 'workspace-write')
  assert.equal(invocations.filter(call => call.sandbox === 'workspace-write')
    .every(call => call.kind === gate.agentKind), true)

  workspace.decideHumanGate(gate.gateId, {
    status: 'approved', optionId: 'retry-once', actorId: 'local-user',
  })
  await send

  const writerCalls = invocations.filter(call => call.kind === gate.agentKind)
  assert.equal(writerCalls.length, 2)
  assert.deepEqual(writerCalls.map(call => call.operationId), [request.operationId, request.operationId])
  for (const kind of ['codex', 'hermes', 'workbuddy'].filter(kind => kind !== gate.agentKind)) {
    assert.equal(invocations.filter(call => call.kind === kind).length, 1)
    assert.equal(invocations.find(call => call.kind === kind).sandbox, 'read-only')
  }
  assert.deepEqual(ledger.get(gate.runId).orchestration.commitState.committedKinds, [
    'codex', 'hermes', 'workbuddy',
  ])
})
