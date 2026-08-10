const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { runAgent } = require('../src/cli-adapters.cjs')
const { LocalWorkspace } = require('../src/local-workspace.cjs')
const { createLegacyOutboundPayload } = require('../src/outbound-payload.cjs')
const { RunLedger } = require('../src/run-ledger.cjs')
const { RunScheduler } = require('../src/run-scheduler.cjs')
const { executable, within } = require('./cli-adapters-test-helpers.cjs')
const { deferred, fixture } = require('./local-workspace-test-helpers.cjs')

function waitForAgentAbort(signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED'))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

function pendingGate(workspace) {
  const seen = deferred()
  const listener = (snapshot) => {
    const gate = snapshot.humanGates.find(candidate => candidate.status === 'pending')
    if (gate) seen.resolve(gate)
  }
  workspace.on('changed', listener)
  return {
    promise: within(seen.promise),
    close: () => workspace.off('changed', listener),
  }
}

async function waitForRunStatus(ledger, runId, statuses, timeoutMs = 5000) {
  const accepted = new Set(Array.isArray(statuses) ? statuses : [statuses])
  const deadline = Date.now() + timeoutMs
  let record = null
  while (Date.now() < deadline) {
    record = ledger.get(runId)
    if (record && accepted.has(record.status)) return record
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`TEST_RUN_STATUS_TIMEOUT:${runId}:${record?.status || 'missing'}:${record?.reason || ''}`)
}

async function waitForCondition(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`TEST_CONDITION_TIMEOUT:${label}`)
}

function acpPermissionExecutable(directory) {
  return executable(directory, 'kimi-acp-workspace-permission.cjs', `
const readline = require('node:readline')
const input = readline.createInterface({ input: process.stdin })
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
let promptRequest
input.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'workspace-permission' } })
  } else if (message.method === 'session/resume') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/prompt') {
    promptRequest = message
    send({
      jsonrpc: '2.0', id: 77, method: 'session/request_permission',
      params: {
        sessionId: 'workspace-permission',
        toolCall: {
          toolCallId: 'tool-1',
          title: 'write /Users/private/workspace api_key=sk-testpermissionsecret123456789',
          kind: 'edit',
          status: 'pending',
          rawInput: { command: 'touch /Users/private/workspace/private.txt' },
        },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
        ],
      },
    })
  } else if (message.id === 77) {
    const outcome = message.result.outcome
    const text = outcome.outcome + '|' + (outcome.optionId || '')
    send({
      jsonrpc: '2.0', method: 'session/update',
      params: {
        sessionId: 'workspace-permission',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
      },
    })
    send({ jsonrpc: '2.0', id: promptRequest.id, result: { stopReason: 'end_turn' } })
  } else if (message.method === 'session/cancel') {
    process.exit(0)
  }
})
`)
}

test('manual per-Agent retry restarts only the interrupted attempt', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const firstAttempt = deferred()
  let codexAttempts = 0
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'codex' && ++codexAttempts === 1) {
      firstAttempt.resolve()
      await waitForAgentAbort(runOptions.signal)
    }
    return {
      text: `${agent.kind} completed`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', event => finished.push(event))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Manual retry', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Retry only the interrupted manual Agent',
    targetKinds: ['codex', 'hermes'],
  })
  await within(firstAttempt.promise)
  const active = workspace.activeRuns.get(group.id)
  assert.equal(workspace.controlAgent(group.id, active.runId, 'codex', 'retry'), true)
  await within(send)

  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'codex', 'hermes'])
  assert.deepEqual(
    workspace.snapshot().messages.filter(message => message.role === 'agent')
      .map(message => message.content),
    ['codex completed', 'hermes completed'],
  )
  assert.equal(workspace.snapshot().messages.some(message => (
    message.system?.key === 'system.agentCallFailed'
      || message.system?.key === 'system.agentStopped'
  )), false)
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'completed')
  assert.deepEqual(finished[0].failedKinds, [])
})

test('manual per-Agent cancel preserves the Task and continues later Agents', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const firstAttempt = deferred()
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'codex') {
      firstAttempt.resolve()
      await waitForAgentAbort(runOptions.signal)
    }
    return { text: `${agent.kind} completed`, sessionRef: `${agent.kind}-session` }
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', event => finished.push(event))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Manual cancel', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Keep this Task after cancelling one Agent',
    targetKinds: ['codex', 'hermes'],
  })
  await within(firstAttempt.promise)
  const active = workspace.activeRuns.get(group.id)
  assert.equal(workspace.controlAgent(group.id, active.runId, 'codex', 'cancel'), true)
  await within(send)

  const messages = workspace.snapshot().messages
  const task = messages.find(message => message.role === 'user')
  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes'])
  assert.equal(messages.filter(message => message.role === 'user').length, 1)
  assert.equal(messages.some(message => (
    message.agentKind === 'codex' && message.system?.key === 'system.agentStopped'
  )), true)
  assert.equal(messages.some(message => (
    message.role === 'agent' && message.agentKind === 'hermes'
      && message.content === 'hermes completed' && message.threadRootId === task.id
  )), true)
  assert.equal(finished[0].taskId, task.id)
  assert.equal(finished[0].status, 'partial')
  assert.equal(finished[0].failedKinds.includes('codex'), true)
})

test('manual per-Agent replace executes the replacement in the interrupted slot', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const firstAttempt = deferred()
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'codex') {
      firstAttempt.resolve()
      await waitForAgentAbort(runOptions.signal)
    }
    return { text: `${agent.kind} completed`, sessionRef: `${agent.kind}-session` }
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', event => finished.push(event))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Manual replace',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
  })

  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Let another Agent take over this interrupted slot',
    targetKinds: ['codex', 'hermes', 'workbuddy'],
  })
  await within(firstAttempt.promise)
  const active = workspace.activeRuns.get(group.id)
  assert.equal(
    workspace.controlAgent(group.id, active.runId, 'codex', 'replace', 'hermes'),
    true,
  )
  await within(send)

  const messages = workspace.snapshot().messages
  const task = messages.find(message => message.role === 'user')
  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes', 'workbuddy'])
  assert.match(calls[1].prompt, /Harness recovery task:\nYou are replacing Codex CLI/i)
  assert.equal(messages.filter(message => message.role === 'user').length, 1)
  assert.deepEqual(
    messages.filter(message => message.role === 'agent').map(message => message.agentKind),
    ['hermes', 'workbuddy'],
  )
  assert.equal(messages.filter(message => message.role !== 'user').every(message => (
    message.threadRootId === task.id
  )), true)
  assert.equal(finished[0].taskId, task.id)
  assert.equal(finished[0].status, 'completed')
  assert.equal(finished[0].failedKinds.includes('codex'), true)
})

test('manual cancel removes a globally queued Agent without aborting the active lease', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const scheduler = new RunScheduler({ taskLimit: 2, workspaceLimit: 2, globalLimit: 1 })
  const activeStarted = deferred()
  const releaseActive = deferred()
  t.after(() => releaseActive.resolve())
  let activeSignal = null
  options.runScheduler = scheduler
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'codex') {
      activeSignal = runOptions.signal
      activeStarted.resolve()
      await releaseActive.promise
    }
    return { text: `${agent.kind} completed`, sessionRef: `${agent.kind}-session` }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const activeGroup = workspace.createGroup({
    name: 'Active global lease', agentKinds: ['codex'], workdir: directory,
  })
  const queuedGroup = workspace.createGroup({
    name: 'Queued cancel', agentKinds: ['hermes', 'workbuddy'], workdir: directory,
  })

  const activeSend = workspace.sendMessage({
    groupId: activeGroup.id,
    text: 'Hold the only global Agent lease',
    targetKinds: ['codex'],
  })
  await within(activeStarted.promise)
  const queuedSend = workspace.sendMessage({
    groupId: queuedGroup.id,
    text: 'Cancel Hermes while it is globally queued',
    targetKinds: ['hermes', 'workbuddy'],
  })
  await waitForCondition(
    () => scheduler.snapshot().queued.length === 1,
    'hermes queued behind active lease',
  )
  const queuedRun = workspace.activeRuns.get(queuedGroup.id)

  assert.equal(
    workspace.controlAgent(queuedGroup.id, queuedRun.runId, 'hermes', 'cancel'),
    true,
  )
  assert.equal(activeSignal.aborted, false)
  await waitForCondition(
    () => queuedRun.agentControllers.has('workbuddy'),
    'remaining WorkBuddy queued after Hermes cancellation',
  )
  assert.equal(calls.some(call => call.agent.kind === 'hermes'), false)

  releaseActive.resolve()
  await Promise.all([within(activeSend), within(queuedSend)])

  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'workbuddy'])
  assert.equal(workspace.snapshot().messages.some(message => (
    message.role === 'agent' && message.agentKind === 'workbuddy'
      && message.content === 'workbuddy completed'
  )), true)
  assert.equal(activeSignal.aborted, false)
  assert.equal(queuedRun.agentControllers.size, 0)
  assert.equal(scheduler.snapshot().active.global, 0)
  assert.equal(scheduler.snapshot().queued.length, 0)
})

test('manual replace redirects a globally queued Agent without invoking the original', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const scheduler = new RunScheduler({ taskLimit: 2, workspaceLimit: 2, globalLimit: 1 })
  const activeStarted = deferred()
  const releaseActive = deferred()
  t.after(() => releaseActive.resolve())
  let activeSignal = null
  options.runScheduler = scheduler
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'codex') {
      activeSignal = runOptions.signal
      activeStarted.resolve()
      await releaseActive.promise
    }
    return { text: `${agent.kind} completed`, sessionRef: `${agent.kind}-session` }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const activeGroup = workspace.createGroup({
    name: 'Active replacement lease', agentKinds: ['codex'], workdir: directory,
  })
  const queuedGroup = workspace.createGroup({
    name: 'Queued replace', agentKinds: ['hermes', 'workbuddy'], workdir: directory,
  })

  const activeSend = workspace.sendMessage({
    groupId: activeGroup.id,
    text: 'Hold the global lease during replacement',
    targetKinds: ['codex'],
  })
  await within(activeStarted.promise)
  const queuedSend = workspace.sendMessage({
    groupId: queuedGroup.id,
    text: 'Replace Hermes while it is globally queued',
    targetKinds: ['hermes', 'workbuddy'],
  })
  await waitForCondition(
    () => scheduler.snapshot().queued.length === 1,
    'Hermes queued before replacement',
  )
  const queuedRun = workspace.activeRuns.get(queuedGroup.id)

  assert.equal(
    workspace.controlAgent(
      queuedGroup.id, queuedRun.runId, 'hermes', 'replace', 'workbuddy',
    ),
    true,
  )
  assert.equal(activeSignal.aborted, false)
  await waitForCondition(
    () => queuedRun.agentControllers.has('workbuddy'),
    'replacement WorkBuddy queued after Hermes replacement',
  )
  assert.equal(calls.some(call => call.agent.kind === 'hermes'), false)

  releaseActive.resolve()
  await Promise.all([within(activeSend), within(queuedSend)])

  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'workbuddy'])
  const workbuddyCall = calls.find(call => call.agent.kind === 'workbuddy')
  assert.match(workbuddyCall.prompt, /Harness recovery task:\nYou are replacing Hermes CLI/i)
  assert.equal(activeSignal.aborted, false)
  assert.equal(queuedRun.agentControllers.size, 0)
  assert.equal(scheduler.snapshot().active.global, 0)
  assert.equal(scheduler.snapshot().queued.length, 0)
})

test('LocalWorkspace persists and resumes ACP permission approval and rejection Gates', async (t) => {
  for (const scenario of [
    { status: 'approved', optionId: 'allow-once' },
    { status: 'rejected', optionId: 'reject-once' },
  ]) {
    await t.test(scenario.status, async (subtest) => {
      const { directory, options } = fixture()
      subtest.after(() => fs.rmSync(directory, { recursive: true, force: true }))
      const cli = acpPermissionExecutable(directory)
      const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
      options.runLedger = ledger
      options.detectAgents = async () => [{
        kind: 'kimi', name: 'Kimi CLI', executable: cli, version: '1', acpAvailable: true,
      }]
      options.runAgent = runAgent
      const workspace = new LocalWorkspace(options)
      await workspace.refreshAgents()
      const group = workspace.createGroup({
        name: `ACP permission ${scenario.status}`, agentKinds: ['kimi'], workdir: directory,
      })
      const gate = pendingGate(workspace)

      const send = workspace.sendMessage({
        groupId: group.id,
        text: `Exercise the ACP ${scenario.status} permission path`,
        targetKinds: ['kimi'],
      })
      const pending = await gate.promise
      gate.close()
      assert.equal(pending.type, 'permission')
      assert.equal(ledger.get(pending.runId).status, 'waiting')
      assert.equal(workspace.snapshot().runs[0].waitingGateIds.includes(pending.gateId), true)
      const request = workspace.humanGateStore.request(pending.gateId)
      assert.deepEqual(request.options, [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
      ])
      assert.doesNotMatch(
        JSON.stringify(request),
        /rawInput|Users|private|sk-testpermissionsecret|api_key/i,
      )

      workspace.decideHumanGate(pending.gateId, {
        ...scenario,
        actorId: 'local-user',
      })
      await within(send, 5000)

      const completedGate = workspace.listHumanGates()
        .find(candidate => candidate.gateId === pending.gateId)
      assert.equal(completedGate.status, scenario.status)
      assert.equal(completedGate.decision.optionId, scenario.optionId)
      assert.equal(workspace.snapshot().humanGates.length, 0)
      assert.equal(
        workspace.snapshot().messages.some(message => (
          message.role === 'agent' && message.content === `selected|${scenario.optionId}`
        )),
        true,
      )
      assert.equal(ledger.get(pending.runId).status, 'completed')
    })
  }
})

test('ACP permission Gate survives shutdown and resumes the persisted Session after approval', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const cli = acpPermissionExecutable(directory)
  const ledger = new RunLedger({ storagePath: ledgerPath })
  options.runLedger = ledger
  options.detectAgents = async () => [{
    kind: 'kimi', name: 'Kimi CLI', executable: cli, version: '1', acpAvailable: true,
  }]
  options.runAgent = runAgent
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Restarted ACP permission', agentKinds: ['kimi'], workdir: directory,
  })
  const gateWatcher = pendingGate(workspace)

  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Resume this ACP permission after restart',
    targetKinds: ['kimi'],
  })
  const pending = await gateWatcher.promise
  gateWatcher.close()
  const runId = pending.runId
  await within(workspace.stopAll(), 5000)
  await within(send, 5000)

  assert.equal(ledger.get(runId).status, 'waiting')
  assert.equal(workspace.listHumanGates({ pendingOnly: true })[0].gateId, pending.gateId)

  const restartedLedger = new RunLedger({ storagePath: ledgerPath })
  const restarted = new LocalWorkspace({ ...options, runLedger: restartedLedger })
  const finished = deferred()
  restarted.once('run-finished', event => finished.resolve(event))
  await restarted.refreshAgents()
  assert.equal(restarted.listHumanGates({ pendingOnly: true })[0].gateId, pending.gateId)
  const waitingSnapshot = restarted.snapshot()
  assert.equal(waitingSnapshot.humanGates[0].gateId, pending.gateId)
  assert.equal(waitingSnapshot.runs[0].runId, runId)
  assert.deepEqual(waitingSnapshot.runs[0].waitingGateIds, [pending.gateId])
  assert.equal(waitingSnapshot.runningGroupIds.includes(group.id), true)
  assert.equal(Object.values(restarted.state.sessions).includes('workspace-permission'), true)
  await assert.rejects(
    restarted.sendMessage({
      groupId: group.id,
      text: 'Do not start beside a durable waiting Run',
      targetKinds: ['kimi'],
    }),
    /LOCAL_GROUP_RUNNING/,
  )

  restarted.decideHumanGate(pending.gateId, {
    status: 'approved', optionId: 'allow-once', actorId: 'local-user',
  })
  const terminal = await waitForRunStatus(restartedLedger, runId, 'completed')
  const event = await within(finished.promise, 5000)

  assert.equal(terminal.runId, runId)
  assert.equal(event.runId, runId)
  assert.deepEqual(event.completedKinds, ['kimi'])
  assert.deepEqual(event.failedKinds, [])
  assert.equal(terminal.continuation.state, 'completed')
  assert.equal(Object.values(restarted.state.sessions).includes('workspace-permission'), true)
  assert.equal(restarted.snapshot().messages.some(message => (
    message.role === 'agent' && message.content === 'selected|allow-once'
  )), true)
  assert.equal(restarted.snapshot().messages.some(message => (
    message.role === 'system'
      && message.agentKind === 'kimi'
      && message.system?.key === 'system.agentCallFailed'
  )), false)
})

test('restart rejection cancels a permission continuation without replaying the Agent', async (t) => {
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
      operation: { kind: 'write', path: 'blocked.txt' },
    }, { signal: runOptions.signal })
    return { text: `decision:${decision.optionId}`, sessionRef: 'rejected-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Rejected permission restart',
    agentKinds: ['codex'],
    workdir: directory,
    allowWrite: true,
  })
  const gateWatcher = pendingGate(workspace)
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Reject this permission after restart',
    targetKinds: ['codex'],
  })
  const pending = await gateWatcher.promise
  gateWatcher.close()
  await within(workspace.stopAll(), 5000)
  await within(send, 5000)

  const restartedLedger = new RunLedger({ storagePath: ledgerPath })
  const restarted = new LocalWorkspace({ ...options, runLedger: restartedLedger })
  const finished = deferred()
  restarted.once('run-finished', event => finished.resolve(event))
  await restarted.refreshAgents()
  restarted.decideHumanGate(pending.gateId, {
    status: 'rejected', optionId: 'reject-once', actorId: 'local-user',
  })
  const terminal = await waitForRunStatus(restartedLedger, pending.runId, 'stopped')
  const event = await within(finished.promise, 5000)

  assert.equal(invocations, 1)
  assert.equal(terminal.continuation.state, 'cancelled')
  assert.equal(event.status, 'stopped')
  assert.equal(restarted.snapshot().messages.some(message => (
    message.role === 'agent' && message.content === 'decision:reject-once'
  )), false)
})

test('hard unobservable cost budget waits for a Human Gate before execution', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return { text: 'Approved unmetered result', sessionRef: 'codex-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Budget Gate', agentKinds: ['codex'], workdir: directory,
  })
  const gate = pendingGate(workspace)

  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Wait for explicit unmetered cost approval',
    targetKinds: ['codex'],
    budget: {
      limits: { costMicros: 100 },
      enforcement: { costMicros: 'hard' },
    },
  })
  const pending = await gate.promise
  gate.close()
  assert.equal(pending.type, 'budget')
  assert.equal(calls.length, 0)
  assert.equal(ledger.get(pending.runId).status, 'waiting')
  assert.equal(workspace.humanGateStore.request(pending.gateId).reason, 'BUDGET_USAGE_UNOBSERVABLE')

  workspace.decideHumanGate(pending.gateId, {
    status: 'approved', optionId: 'continue-unmetered', actorId: 'local-user',
  })
  await within(send)

  const terminal = ledger.get(pending.runId)
  assert.equal(calls.length, 1)
  assert.equal(terminal.status, 'completed')
  assert.equal(terminal.budget.source.costMicros, 'estimated')
  assert.equal(terminal.budget.enforcement.costMicros, 'soft')
  assert.equal(workspace.snapshot().messages.some(message => (
    message.role === 'agent' && message.content === 'Approved unmetered result'
  )), true)
})

test('budget Gate survives shutdown and resumes Agent execution after restart', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const ledger = new RunLedger({ storagePath: ledgerPath })
  options.runLedger = ledger
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return { text: 'Restarted unmetered result', sessionRef: 'codex-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Restarted budget Gate', agentKinds: ['codex'], workdir: directory,
  })
  const gateWatcher = pendingGate(workspace)

  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Resume this budget Gate after restart',
    targetKinds: ['codex'],
    budget: {
      limits: { costMicros: 100 },
      enforcement: { costMicros: 'hard' },
    },
  })
  const pending = await gateWatcher.promise
  gateWatcher.close()
  const runId = pending.runId
  await within(workspace.stopAll(), 5000)
  await within(send, 5000)

  assert.equal(calls.length, 0)
  assert.equal(ledger.get(runId).status, 'waiting')

  const restartedLedger = new RunLedger({ storagePath: ledgerPath })
  const restarted = new LocalWorkspace({ ...options, runLedger: restartedLedger })
  const finished = deferred()
  restarted.once('run-finished', event => finished.resolve(event))
  await restarted.refreshAgents()
  assert.equal(restarted.listHumanGates({ pendingOnly: true })[0].gateId, pending.gateId)
  const waitingSnapshot = restarted.snapshot()
  assert.equal(waitingSnapshot.humanGates[0].gateId, pending.gateId)
  assert.equal(waitingSnapshot.runs[0].runId, runId)
  assert.deepEqual(waitingSnapshot.runs[0].waitingGateIds, [pending.gateId])
  assert.equal(waitingSnapshot.runningGroupIds.includes(group.id), true)

  restarted.decideHumanGate(pending.gateId, {
    status: 'approved', optionId: 'continue-unmetered', actorId: 'local-user',
  })
  const terminal = await waitForRunStatus(restartedLedger, runId, 'completed')
  const event = await within(finished.promise, 5000)

  assert.equal(calls.length, 1)
  assert.equal(terminal.budget.enforcement.costMicros, 'soft')
  assert.equal(event.runId, runId)
  assert.deepEqual(event.completedKinds, ['codex'])
  assert.equal(restarted.snapshot().messages.some(message => (
    message.role === 'agent' && message.content === 'Restarted unmetered result'
      && message.trace?.runId === runId
  )), true)
})

test('restart rejects a Gate with a missing Context Pack and fails its Run closed', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const ledger = new RunLedger({ storagePath: ledgerPath })
  options.runLedger = ledger
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return { text: 'Must not execute', sessionRef: 'codex-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Corrupt continuation', agentKinds: ['codex'], workdir: directory,
  })
  const gateWatcher = pendingGate(workspace)

  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Fail closed when durable context disappears',
    targetKinds: ['codex'],
    budget: {
      limits: { costMicros: 100 },
      enforcement: { costMicros: 'hard' },
    },
  })
  const pending = await gateWatcher.promise
  gateWatcher.close()
  const runId = pending.runId
  await within(workspace.stopAll(), 5000)
  await within(send, 5000)

  const durable = ledger.get(runId)
  const contextHash = durable.contextPackId.slice(durable.contextPackId.lastIndexOf('-') + 1)
  fs.rmSync(path.join(
    workspace.contextPackStore.rootPath,
    'context-packs',
    contextHash.slice(0, 2),
    `${durable.contextPackId}.json`,
  ))

  const restartedLedger = new RunLedger({ storagePath: ledgerPath })
  const restarted = new LocalWorkspace({ ...options, runLedger: restartedLedger })
  await restarted.refreshAgents()
  const rejected = restarted.listHumanGates()
    .find(candidate => candidate.gateId === pending.gateId)
  const terminal = await waitForRunStatus(restartedLedger, runId, 'failed')

  assert.equal(calls.length, 0)
  assert.equal(rejected.status, 'rejected')
  assert.equal(rejected.decision.actorId, 'meldwork-system')
  assert.equal(terminal.reason, 'human_gate_continuation_invalid')
})

test('hard budget exhaustion is terminal and is not retried', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  const attempts = []
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    attempts.push(agent.kind)
    await runOptions.onOutboundPayload(createLegacyOutboundPayload({
      prompt,
      command: '/tmp/mock-agent',
      args: ['--prompt'],
      cwd: workdir,
      stdin: prompt,
      promptMode: 'stdin',
    }))
    if (agent.kind === 'hermes') {
      runOptions.onProgress({ id: 'write-1', title: 'write_file', status: 'completed' })
    }
    return { text: `${agent.kind} result`, sessionRef: `${agent.kind}-session` }
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', event => finished.push(event))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Hard budget terminal',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: true,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Exceed the outbound budget once',
    targetKinds: ['codex', 'hermes', 'workbuddy'],
    budget: {
      limits: { toolCalls: 0 },
      enforcement: { toolCalls: 'hard' },
    },
  })

  const terminal = ledger.list(group.id)[0]
  assert.deepEqual(attempts, ['codex', 'hermes'])
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'budget-exhausted')
  assert.equal(terminal.status, 'budget-exhausted')
  assert.equal(terminal.reason, 'hard_budget')
  assert.equal(terminal.permissionMode, 'workspace-write')
  assert.equal(terminal.agentRuns.length, 2)
  assert.equal(terminal.agentRuns[0].status, 'completed')
  assert.equal(terminal.agentRuns[1].reason, 'LOCAL_BUDGET_EXHAUSTED')
  assert.equal(terminal.budget.used.toolCalls, 1)
  assert.deepEqual(terminal.budget.exhaustion, {
    dimension: 'toolCalls',
    limit: 0,
    priorUsed: 0,
    attemptedUsage: 1,
    used: 1,
    source: 'estimated',
    enforcement: 'hard',
    reason: 'BUDGET_LIMIT_EXCEEDED',
  })
  assert.equal(workspace.snapshot().humanGates.length, 0)
  assert.equal(workspace.snapshot().messages.some(message => (
    message.role === 'agent' && message.agentKind === 'codex'
  )), true)
  assert.equal(workspace.snapshot().messages.some(message => (
    message.agentKind === 'workbuddy'
  )), false)
  assert.equal(workspace.snapshot().messages.some(message => (
    message.system?.key === 'system.agentBudgetExhausted'
      && message.system.params.dimension === 'toolCalls'
  )), true)

  const storedWorkspace = JSON.parse(fs.readFileSync(options.storagePath, 'utf8'))
  storedWorkspace.messages = storedWorkspace.messages.filter(message => (
    message.system?.key !== 'system.agentBudgetExhausted'
  ))
  fs.writeFileSync(options.storagePath, JSON.stringify(storedWorkspace), 'utf8')
  const restarted = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') }),
  })
  assert.equal(restarted.snapshot().messages.some(message => (
    message.system?.key === 'system.agentBudgetExhausted'
      && message.system.params.attemptedUsage === 1
  )), true)
})
