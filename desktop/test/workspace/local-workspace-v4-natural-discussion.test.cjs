const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { RunLedger } = require('../../src/runs/run-ledger.cjs')
const { RunScheduler } = require('../../src/runs/run-scheduler.cjs')
const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { deferred, fixture } = require('../support/local-workspace-test-helpers.cjs')

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function naturalPhase(prompt) {
  if (prompt.includes('Work independently on the user task')) return 'proposal'
  if (prompt.includes('Continue from the available peer responses')) return 'discussion'
  return ''
}

async function runDiscussion(workspace, group, input) {
  await workspace.sendMessage({
    groupId: group.id,
    text: 'Discuss the implementation direction.',
    mode: 'auto',
    targetKinds: group.agentKinds,
    protocol: 'v4',
    ...input,
  })
  const controller = workspace.activeRuns.get(group.id)
  assert.ok(controller)
  await controller.promise
  return controller
}

function assertTurnParity(record, messages) {
  const messageTurns = messages.map(message => `${message.trace.round}:${message.agentKind}`)
  const agentRunTurns = record.agentRuns.map(run => `${run.round}:${run.kind}`)
  assert.equal(new Set(messageTurns).size, messageTurns.length)
  assert.equal(new Set(agentRunTurns).size, agentRunTurns.length)
  assert.deepEqual(agentRunTurns, messageTurns)
  for (const message of messages) {
    assert.equal(record.agentRuns.some(run => (
      run.agentRunId === message.trace.agentRunId
      && run.round === message.trace.round
      && run.kind === message.agentKind
    )), true)
  }
}

test('Natural sequential V4 runs every Agent once per round in configured CLI order', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  options.runScheduler = new RunScheduler({ taskLimit: 8, workspaceLimit: 8, globalLimit: 8 })
  options.naturalAgentResponses = true
  const calls = []
  let running = 0
  let maxRunning = 0
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    running += 1
    maxRunning = Math.max(maxRunning, running)
    calls.push({
      kind: agent.kind,
      phase: naturalPhase(prompt),
      sessionRef: runOptions.sessionRef,
    })
    await delay(5)
    running -= 1
    return {
      text: agent.kind === 'codex'
        ? 'Codex discusses @hermes in the body.\n\n@所有人'
        : `${agent.kind} continues without a routing instruction.`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-task-session`,
    }
  }

  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Natural sequential discussion',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: false,
  })
  const controller = await runDiscussion(workspace, group, {
    discussionStyle: 'sequential',
    maxRounds: 3,
  })

  assert.deepEqual(calls.map(call => call.kind), [
    'codex', 'hermes', 'workbuddy',
    'codex', 'hermes', 'workbuddy',
    'codex', 'hermes', 'workbuddy',
  ])
  assert.equal(maxRunning, 1)
  assert.equal(calls.every(call => call.phase === 'discussion'), true)
  for (const kind of group.agentKinds) {
    const refs = calls.filter(call => call.kind === kind).map(call => call.sessionRef)
    assert.deepEqual(refs, ['', `${kind}-task-session`, `${kind}-task-session`])
  }

  const messages = workspace.snapshot().messages.filter(message => (
    message.role === 'agent' && message.threadRootId === controller.threadRootId
  ))
  assert.deepEqual(messages.map(message => `${message.trace.round}:${message.agentKind}`), [
    '1:codex', '1:hermes', '1:workbuddy',
    '2:codex', '2:hermes', '2:workbuddy',
    '3:codex', '3:hermes', '3:workbuddy',
  ])
  const record = ledger.get(controller.runId)
  assert.equal(record.status, 'completed', record.reason)
  assert.equal(record.orchestration.discussionStyle, 'sequential')
})

test('Natural Agent-led V4 uses the full first-round transcript and final-line mentions', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  options.runScheduler = new RunScheduler({ taskLimit: 8, workspaceLimit: 8, globalLimit: 8 })
  options.naturalAgentResponses = true
  const tails = new Map([
    ['codex', 'CODEX_SENTINEL_AFTER_800'],
    ['hermes', 'HERMES_SENTINEL_AFTER_800'],
    ['workbuddy', 'WORKBUDDY_SENTINEL_AFTER_800'],
  ])
  const calls = []
  let proposalRunning = 0
  let routedRunning = 0
  let maxProposalRunning = 0
  let maxRoutedRunning = 0
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const phase = naturalPhase(prompt)
    calls.push({ kind: agent.kind, phase, prompt, sessionRef: runOptions.sessionRef })
    if (phase === 'proposal') {
      proposalRunning += 1
      maxProposalRunning = Math.max(maxProposalRunning, proposalRunning)
      await delay(15)
      proposalRunning -= 1
      return {
        text: `# ${agent.kind}\n\n${'x'.repeat(9000)}\n\n${tails.get(agent.kind)}`,
        sessionRef: `${agent.kind}-task-session`,
      }
    }

    routedRunning += 1
    maxRoutedRunning = Math.max(maxRoutedRunning, routedRunning)
    await delay(15)
    routedRunning -= 1
    if (agent.kind === 'codex') {
      return {
        text: 'The body quotes @hermes but routing is decided only below.\n\n@hermes @workbuddy',
        sessionRef: runOptions.sessionRef,
      }
    }
    return {
      text: `${agent.kind} agrees with the current direction.`,
      sessionRef: runOptions.sessionRef,
    }
  }

  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Natural Agent-led discussion',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: false,
  })
  const controller = await runDiscussion(workspace, group, {
    discussionStyle: 'agent-led',
    maxRounds: 5,
  })

  assert.deepEqual(calls.map(call => `${call.phase}:${call.kind}`), [
    'proposal:codex', 'proposal:hermes', 'proposal:workbuddy',
    'discussion:codex',
    'discussion:hermes', 'discussion:workbuddy',
  ])
  assert.equal(maxProposalRunning, 3)
  assert.equal(maxRoutedRunning, 2)
  const coordinator = calls[3]
  for (const sentinel of tails.values()) assert.match(coordinator.prompt, new RegExp(sentinel))
  assert.ok(coordinator.prompt.length > 24000)
  assert.equal(coordinator.sessionRef, 'codex-task-session')
  assert.equal(calls[4].sessionRef, 'hermes-task-session')
  assert.equal(calls[5].sessionRef, 'workbuddy-task-session')
  assert.doesNotMatch(
    coordinator.prompt,
    /current collaboration phase|your role|reviewer|arbiter|Receipt JSON shape|MELDWORK_/iu,
  )

  const messages = workspace.snapshot().messages.filter(message => (
    message.role === 'agent' && message.threadRootId === controller.threadRootId
  ))
  assert.deepEqual(messages.map(message => `${message.trace.round}:${message.agentKind}`), [
    '1:codex', '1:hermes', '1:workbuddy',
    '2:codex',
    '3:hermes', '3:workbuddy',
  ])
  assert.equal(ledger.get(controller.runId).status, 'completed')
})

test('Natural Agent-led routing reads only canonical mentions on the final non-empty line', () => {
  const { directory, options } = fixture()
  const workspace = new LocalWorkspace(options)
  try {
    const activeKinds = ['codex', 'hermes', 'workbuddy']
    assert.deepEqual(workspace.autoRunner.v4MentionedNextKinds(
      'Body mentions @hermes and quotes `@workbuddy`.\n\n@codex',
      activeKinds,
    ), ['codex'])
    assert.deepEqual(workspace.autoRunner.v4MentionedNextKinds(
      'Body mention only: @hermes\n\nDiscussion complete.',
      activeKinds,
    ), [])
    assert.deepEqual(workspace.autoRunner.v4MentionedNextKinds(
      'Discussion complete.\n\n@所有人',
      activeKinds,
    ), [])
    assert.deepEqual(workspace.autoRunner.v4MentionedNextKinds(
      'Continue.\n\n@hermes @workbuddy @hermes',
      activeKinds,
    ), ['hermes', 'workbuddy'])
    assert.deepEqual(workspace.autoRunner.v4MentionedNextKinds(
      'Continue.\n\nPlease ask @hermes next.',
      activeKinds,
    ), [])
    assert.deepEqual(workspace.autoRunner.v4MentionedNextKinds(
      'Continue.\n\n@HERMES',
      activeKinds,
    ), [])
    assert.equal(workspace.autoRunner.v4NaturalRouteDecision(
      'Continue.\n\n@hermes @ghost',
      activeKinds,
    ).status, 'invalid')
    assert.deepEqual(workspace.autoRunner.v4MentionedNextKinds(
      'Continue.\n\n@hermes，@workbuddy；@hermes',
      activeKinds,
    ), ['hermes', 'workbuddy'])
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('Natural Agent-led V4 reuses partially committed routed results after restart', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  const recoveryLedger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger-recovery.json'),
  })
  const recoveryStoragePath = path.join(directory, 'workspace-recovery.json')
  const crashCheckpoint = deferred()
  const initialCalls = []
  options.runLedger = ledger
  options.runScheduler = new RunScheduler({ taskLimit: 8, workspaceLimit: 8, globalLimit: 8 })
  options.naturalAgentResponses = true
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const phase = naturalPhase(prompt)
    initialCalls.push({ kind: agent.kind, phase, sessionRef: runOptions.sessionRef })
    return {
      text: phase === 'discussion' && agent.kind === 'codex'
        ? 'Hermes and WorkBuddy should validate this together.\n\n@hermes @workbuddy'
        : `${agent.kind} completes ${phase}.`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-task-session`,
    }
  }

  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Natural Agent-led restart',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: false,
  })
  const commitV4AgentMessage = workspace.commitV4AgentMessage.bind(workspace)
  let crashCaptured = false
  workspace.commitV4AgentMessage = (input) => {
    const message = commitV4AgentMessage(input)
    const durable = ledger.list(group.id)[0]
    if (!crashCaptured
        && input.agentKind === 'hermes'
        && Number(input.metadata?.trace?.round) === 3
        && durable?.orchestration?.phase === 'discussion'
        && durable.orchestration.round === 3
        && durable.orchestration.currentKinds.join(',') === 'hermes,workbuddy'
        && durable.orchestration.pendingKinds.join(',') === 'hermes,workbuddy') {
      crashCaptured = true
      recoveryLedger.checkpoint(durable)
      fs.copyFileSync(options.storagePath, recoveryStoragePath)
      crashCheckpoint.resolve(structuredClone(durable))
    }
    return message
  }

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Recover the Agent-led routing batch.',
    mode: 'auto',
    discussionStyle: 'agent-led',
    targetKinds: group.agentKinds,
    maxRounds: 5,
    protocol: 'v4',
  })
  const initialController = workspace.activeRuns.get(group.id)
  const crashRecord = await crashCheckpoint.promise
  await initialController.promise

  assert.deepEqual(initialCalls.map(call => `${call.phase}:${call.kind}`), [
    'proposal:codex', 'proposal:hermes', 'proposal:workbuddy',
    'discussion:codex',
    'discussion:hermes', 'discussion:workbuddy',
  ])
  assert.deepEqual(crashRecord.orchestration.pendingKinds, ['hermes', 'workbuddy'])

  const recoveryCalls = []
  let recoveryRunning = 0
  let maxRecoveryRunning = 0
  const recovered = new LocalWorkspace({
    ...options,
    storagePath: recoveryStoragePath,
    runLedger: recoveryLedger,
    runAgent: async (agent, prompt, _workdir, runOptions) => {
      recoveryRunning += 1
      maxRecoveryRunning = Math.max(maxRecoveryRunning, recoveryRunning)
      recoveryCalls.push({
        kind: agent.kind,
        phase: naturalPhase(prompt),
        sessionRef: runOptions.sessionRef,
      })
      await delay(10)
      recoveryRunning -= 1
      return {
        text: `${agent.kind} completes the routed validation.`,
        sessionRef: runOptions.sessionRef,
        outcome: 'completed',
      }
    },
  })
  const recoveredController = recovered.activeRuns.get(group.id)
  assert.ok(recoveredController)
  await recovered.refreshAgents()
  await recoveredController.done

  const recoveredRecord = recoveryLedger.get(crashRecord.runId)
  assert.equal(recoveredRecord.status, 'completed', recoveredRecord.reason)
  assert.deepEqual(recoveryCalls, [])
  assert.equal(maxRecoveryRunning, 0)
  const messages = recovered.snapshot().messages.filter(message => (
    message.role === 'agent' && message.threadRootId === crashRecord.threadRootId
  ))
  assert.deepEqual(messages.map(message => `${message.trace.round}:${message.agentKind}`), [
    '1:codex', '1:hermes', '1:workbuddy',
    '2:codex',
    '3:hermes', '3:workbuddy',
  ])
  assertTurnParity(recoveredRecord, messages)
})

async function assertSequentialRecoveryWindow(t, crashWindow) {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  const recoveryLedger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger-recovery.json'),
  })
  const recoveryStoragePath = path.join(directory, 'workspace-recovery.json')
  const crashCheckpoint = deferred()
  const initialCalls = []
  options.runLedger = ledger
  options.runScheduler = new RunScheduler({ taskLimit: 8, workspaceLimit: 8, globalLimit: 8 })
  options.naturalAgentResponses = true
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const phase = naturalPhase(prompt)
    initialCalls.push(`${phase}:${agent.kind}`)
    return {
      text: `${phase}-${agent.kind}-${initialCalls.length}`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-task-session`,
    }
  }

  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: `Natural sequential ${crashWindow}`,
    agentKinds: ['codex', 'hermes'],
    workdir: directory,
    allowWrite: false,
  })
  let crashCaptured = false
  const capture = () => {
    if (crashCaptured) return
    const durable = ledger.list(group.id)[0]
    if (durable?.orchestration?.phase !== 'discussion'
        || durable.orchestration.round !== 2
        || durable.orchestration.pendingKinds.join(',') !== 'codex,hermes') return
    crashCaptured = true
    recoveryLedger.checkpoint(durable)
    fs.copyFileSync(options.storagePath, recoveryStoragePath)
    crashCheckpoint.resolve(structuredClone(durable))
  }
  if (crashWindow === 'after-harness') {
    const checkpointRun = workspace.checkpointRun.bind(workspace)
    workspace.checkpointRun = (...args) => {
      const persisted = checkpointRun(...args)
      const durable = ledger.list(group.id)[0]
      const completed = durable?.agentRuns?.some(run => (
        run.round === 2 && run.kind === 'codex' && run.status === 'completed'
      ))
      const hasMessage = workspace.snapshot().messages.some(message => (
        message.role === 'agent' && message.threadRootId === durable?.threadRootId
        && message.trace?.round === 2 && message.agentKind === 'codex'
      ))
      if (completed && !hasMessage) capture()
      return persisted
    }
  } else {
    const commitV4AgentMessage = workspace.commitV4AgentMessage.bind(workspace)
    workspace.commitV4AgentMessage = (input) => {
      const message = commitV4AgentMessage(input)
      if (input.agentKind === 'codex' && Number(input.metadata?.trace?.round) === 2) capture()
      return message
    }
  }

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Recover the sequential turn exactly once.',
    mode: 'auto',
    discussionStyle: 'sequential',
    targetKinds: group.agentKinds,
    maxRounds: 2,
    protocol: 'v4',
  })
  const initialController = workspace.activeRuns.get(group.id)
  const crashRecord = await crashCheckpoint.promise
  await initialController.promise

  const recoveryCalls = []
  const recovered = new LocalWorkspace({
    ...options,
    storagePath: recoveryStoragePath,
    runLedger: recoveryLedger,
    runAgent: async (agent, prompt, _workdir, runOptions) => {
      recoveryCalls.push(`${naturalPhase(prompt)}:${agent.kind}`)
      return {
        text: `recovered-${agent.kind}`,
        sessionRef: runOptions.sessionRef || `${agent.kind}-task-session`,
        outcome: 'completed',
      }
    },
  })
  const recoveredController = recovered.activeRuns.get(group.id)
  assert.ok(recoveredController)
  await recovered.refreshAgents()
  await recoveredController.done

  const recoveredRecord = recoveryLedger.get(crashRecord.runId)
  assert.equal(recoveredRecord.status, 'completed', recoveredRecord.reason)
  assert.deepEqual(recoveryCalls, ['discussion:hermes'])
  const messages = recovered.snapshot().messages.filter(message => (
    message.role === 'agent' && message.threadRootId === crashRecord.threadRootId
  ))
  assert.deepEqual(messages.map(message => `${message.trace.round}:${message.agentKind}`), [
    '1:codex', '1:hermes', '2:codex', '2:hermes',
  ])
  assertTurnParity(recoveredRecord, messages)
}

test('Natural sequential V4 recovers a finished harness turn before message commit', async (t) => {
  await assertSequentialRecoveryWindow(t, 'after-harness')
})

test('Natural sequential V4 recovers a committed message before cursor checkpoint', async (t) => {
  await assertSequentialRecoveryWindow(t, 'after-message')
})

test('Natural V4 recovery rejects stale operation or snapshot bindings', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.naturalAgentResponses = true
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Natural stale recovery binding',
    agentKinds: ['codex', 'hermes'],
    workdir: directory,
    allowWrite: false,
  })
  const threadRootId = 'message-natural-stale-binding'
  const operationId = `operation-${'1'.repeat(64)}`
  const snapshotHash = '2'.repeat(64)
  const trace = {
    runId: 'run-natural-stale-binding',
    agentRunId: 'agent-run-natural-stale-binding',
    round: 2,
    phase: 'discussion',
    status: 'completed',
    summary: '',
    events: [],
    sourceMessageIds: [],
    truncated: false,
    context: { operationId, snapshotHash },
  }
  const controller = {
    currentRound: 2,
    runId: trace.runId,
    harness: { snapshot: () => [] },
  }
  const slot = { operationId, snapshotHash }
  const message = {
    id: 'message-natural-stale-binding-result',
    groupId: group.id,
    threadRootId,
    role: 'agent',
    agentKind: 'codex',
    content: 'stale message output',
    trace,
  }

  workspace.state.messages.push(message)
  message.trace.context.operationId = `operation-${'3'.repeat(64)}`
  assert.throws(() => workspace.autoRunner.v4NaturalRecoveredDiscussionResult(
    group, controller, threadRootId, 'codex', slot,
  ), /LOCAL_RUN_COLLABORATION_SCOPE_INVALID/u)
  message.trace.context.operationId = operationId
  message.trace.context.snapshotHash = '4'.repeat(64)
  assert.throws(() => workspace.autoRunner.v4NaturalRecoveredDiscussionResult(
    group, controller, threadRootId, 'codex', slot,
  ), /LOCAL_RUN_COLLABORATION_SCOPE_INVALID/u)

  workspace.state.messages.pop()
  controller.harness.snapshot = () => [{
    agentRunId: trace.agentRunId,
    kind: 'codex',
    round: 2,
    status: 'completed',
    output: 'stale harness output',
    events: [],
    sourceMessageIds: [],
    context: { operationId: `operation-${'5'.repeat(64)}`, snapshotHash },
  }]
  assert.throws(() => workspace.autoRunner.v4NaturalRecoveredDiscussionResult(
    group, controller, threadRootId, 'codex', slot,
  ), /LOCAL_RUN_COLLABORATION_SCOPE_INVALID/u)
  controller.harness.snapshot = () => [{
    agentRunId: trace.agentRunId,
    kind: 'codex',
    round: 2,
    status: 'completed',
    output: 'stale harness output',
    events: [],
    sourceMessageIds: [],
    context: { operationId, snapshotHash: '6'.repeat(64) },
  }]
  assert.throws(() => workspace.autoRunner.v4NaturalRecoveredDiscussionResult(
    group, controller, threadRootId, 'codex', slot,
  ), /LOCAL_RUN_COLLABORATION_SCOPE_INVALID/u)

  controller.taskId = threadRootId
  controller.orchestration = {
    snapshotHash,
    slots: [{ agentKind: 'codex', slotId: 'slot-1-codex' }],
  }
  message.trace.context = {
    operationId: `operation-${'7'.repeat(64)}`,
    snapshotHash,
  }
  workspace.state.messages.push(message)
  assert.deepEqual(workspace.autoRunner.v4NaturalDiscussionRoundMessages(
    group, controller, threadRootId, 2,
  ), [])
  assert.doesNotMatch(
    workspace.autoRunner.v4NaturalThreadTranscript(group, threadRootId, { controller }),
    /stale message output/u,
  )
  message.trace.context.operationId = workspace.autoRunner.v4OperationId(
    controller, 'codex', 'discussion:2', 'slot-1-codex', 2,
  )
  assert.equal(workspace.autoRunner.v4NaturalDiscussionRoundMessages(
    group, controller, threadRootId, 2,
  ).length, 1)
  assert.match(
    workspace.autoRunner.v4NaturalThreadTranscript(group, threadRootId, { controller }),
    /stale message output/u,
  )
  workspace.state.messages.pop()
})

test('Natural sequential V4 recovers its unfinished cursor without duplicate rounds', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  const recoveryLedger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger-recovery.json'),
  })
  const recoveryStoragePath = path.join(directory, 'workspace-recovery.json')
  const crashCheckpoint = deferred()
  const initialCalls = []
  options.runLedger = ledger
  options.runScheduler = new RunScheduler({ taskLimit: 8, workspaceLimit: 8, globalLimit: 8 })
  options.naturalAgentResponses = true
  options.runAgent = async (agent, _prompt, _workdir, runOptions) => {
    initialCalls.push({ kind: agent.kind, sessionRef: runOptions.sessionRef })
    return {
      text: `${agent.kind} continues before restart.`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-task-session`,
    }
  }

  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Natural sequential restart',
    agentKinds: ['codex', 'hermes'],
    workdir: directory,
    allowWrite: false,
  })
  const checkpointRun = workspace.checkpointRun.bind(workspace)
  let crashCaptured = false
  workspace.checkpointRun = (...args) => {
    const persisted = checkpointRun(...args)
    const durable = ledger.list(group.id)[0]
    const committedTurns = workspace.snapshot().messages.filter(message => (
      message.role === 'agent' && message.threadRootId === durable?.threadRootId
    )).map(message => `${message.trace.round}:${message.agentKind}`)
    if (!crashCaptured
        && durable?.orchestration?.phase === 'discussion'
        && durable.orchestration.round === 2
        && durable.orchestration.currentKinds.length === 0
        && durable.orchestration.pendingKinds.length === 1
        && durable.orchestration.pendingKinds[0] === 'hermes'
        && committedTurns.join(',') === '1:codex,1:hermes,2:codex') {
      crashCaptured = true
      recoveryLedger.checkpoint(durable)
      fs.copyFileSync(options.storagePath, recoveryStoragePath)
      crashCheckpoint.resolve(structuredClone(durable))
      throw new Error('TEST_CRASH:SEQUENTIAL_CURSOR')
    }
    return persisted
  }

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Recover the sequential cursor.',
    mode: 'auto',
    discussionStyle: 'sequential',
    targetKinds: group.agentKinds,
    maxRounds: 3,
    protocol: 'v4',
  })
  const initialController = workspace.activeRuns.get(group.id)
  const crashRecord = await crashCheckpoint.promise
  await initialController.promise

  assert.deepEqual(initialCalls.map(call => call.kind), ['codex', 'hermes', 'codex'])
  assert.deepEqual(initialCalls.map(call => call.sessionRef), [
    '', '', 'codex-task-session',
  ])
  assert.deepEqual(crashRecord.orchestration.pendingKinds, ['hermes'])

  const recoveryCalls = []
  const recovered = new LocalWorkspace({
    ...options,
    storagePath: recoveryStoragePath,
    runLedger: recoveryLedger,
    runAgent: async (agent, _prompt, _workdir, runOptions) => {
      recoveryCalls.push({ kind: agent.kind, sessionRef: runOptions.sessionRef })
      return {
        text: `${agent.kind} continues after restart.`,
        sessionRef: runOptions.sessionRef || `${agent.kind}-task-session`,
        outcome: 'completed',
      }
    },
  })
  const recoveredController = recovered.activeRuns.get(group.id)
  assert.ok(recoveredController)
  await recovered.refreshAgents()
  await recoveredController.done

  const recoveredRecord = recoveryLedger.get(crashRecord.runId)
  assert.equal(recoveredRecord.status, 'completed', recoveredRecord.reason)
  assert.deepEqual(recoveryCalls.map(call => call.kind), ['hermes', 'codex', 'hermes'])
  assert.deepEqual(recoveryCalls.map(call => call.sessionRef), [
    'hermes-task-session', 'codex-task-session', 'hermes-task-session',
  ])
  const turns = recovered.snapshot().messages.filter(message => (
    message.role === 'agent' && message.threadRootId === crashRecord.threadRootId
  )).map(message => `${message.trace.round}:${message.agentKind}`)
  assert.deepEqual(turns, [
    '1:codex', '1:hermes', '2:codex',
    '2:hermes', '3:codex', '3:hermes',
  ])
  assert.equal(new Set(turns).size, turns.length)
})

test('Natural sequential V4 does not rotate an Agent Session during one group task', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.naturalAgentResponses = true
  const refsByKind = new Map([['codex', []], ['hermes', []]])
  options.runAgent = async (agent, _prompt, _workdir, runOptions) => {
    refsByKind.get(agent.kind).push(runOptions.sessionRef)
    return {
      text: `${agent.kind} continues the same task.`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-task-session`,
    }
  }

  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Long natural sequential discussion',
    agentKinds: ['codex', 'hermes'],
    workdir: directory,
    allowWrite: false,
  })
  await runDiscussion(workspace, group, {
    discussionStyle: 'sequential',
    maxRounds: 20,
  })

  for (const [kind, refs] of refsByKind) {
    assert.equal(refs.length, 10)
    assert.equal(refs[0], '')
    assert.equal(refs.slice(1).every(ref => ref === `${kind}-task-session`), true)
  }
})

test('Natural Agent-led V4 asks a different peer to confirm a coordinator with no mention', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  options.runScheduler = new RunScheduler({ taskLimit: 8, workspaceLimit: 8, globalLimit: 8 })
  options.naturalAgentResponses = true
  const calls = []
  let proposalRunning = 0
  let routedRunning = 0
  let maxProposalRunning = 0
  let maxRoutedRunning = 0
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const phase = naturalPhase(prompt)
    calls.push({ kind: agent.kind, phase, prompt })
    if (phase === 'proposal') {
      proposalRunning += 1
      maxProposalRunning = Math.max(maxProposalRunning, proposalRunning)
      await delay(15)
      proposalRunning -= 1
    } else {
      routedRunning += 1
      maxRoutedRunning = Math.max(maxRoutedRunning, routedRunning)
      await delay(5)
      routedRunning -= 1
    }
    return {
      text: `${agent.kind} accepts the current result without changes.`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-task-session`,
    }
  }

  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Natural coordinator confirmation',
    agentKinds: ['codex', 'hermes'],
    workdir: directory,
    allowWrite: false,
  })
  const controller = await runDiscussion(workspace, group, {
    discussionStyle: 'agent-led',
    maxRounds: 4,
  })

  assert.deepEqual(calls.map(call => `${call.phase}:${call.kind}`), [
    'proposal:codex', 'proposal:hermes',
    'discussion:codex', 'discussion:hermes',
  ])
  assert.equal(maxProposalRunning, 2)
  assert.equal(maxRoutedRunning, 1)
  assert.match(
    calls.find(call => call.phase === 'discussion').prompt,
    /End without any Agent mention only when you accept the current result and made no substantive change\./u,
  )
  const messages = workspace.snapshot().messages.filter(message => (
    message.role === 'agent' && message.threadRootId === controller.threadRootId
  ))
  assert.deepEqual(messages.map(message => `${message.trace.round}:${message.agentKind}`), [
    '1:codex', '1:hermes', '2:codex', '3:hermes',
  ])
  assert.equal(ledger.get(controller.runId).status, 'completed')
})

test('Natural Agent-led V4 routes a single mention serially and completes after peer review', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runScheduler = new RunScheduler({ taskLimit: 8, workspaceLimit: 8, globalLimit: 8 })
  options.naturalAgentResponses = true
  const calls = []
  let routedRunning = 0
  let maxRoutedRunning = 0
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const phase = naturalPhase(prompt)
    calls.push(`${phase}:${agent.kind}`)
    if (phase === 'discussion') {
      routedRunning += 1
      maxRoutedRunning = Math.max(maxRoutedRunning, routedRunning)
      await delay(10)
      routedRunning -= 1
    }
    return {
      text: phase === 'discussion' && agent.kind === 'codex'
        ? 'Hermes should review the current result.\n\n@hermes'
        : `${agent.kind} accepts the current result without changes.`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-task-session`,
    }
  }

  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Natural single mention routing',
    agentKinds: ['codex', 'hermes'],
    workdir: directory,
    allowWrite: false,
  })
  const controller = await runDiscussion(workspace, group, {
    discussionStyle: 'agent-led',
    maxRounds: 4,
  })

  assert.deepEqual(calls, [
    'proposal:codex', 'proposal:hermes',
    'discussion:codex', 'discussion:hermes',
  ])
  assert.equal(maxRoutedRunning, 1)
  const messages = workspace.snapshot().messages.filter(message => (
    message.role === 'agent' && message.threadRootId === controller.threadRootId
  ))
  assert.deepEqual(messages.map(message => `${message.trace.round}:${message.agentKind}`), [
    '1:codex', '1:hermes', '2:codex', '3:hermes',
  ])
})

test('Natural Agent-led V4 does not accept a self-only route without peer confirmation', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runScheduler = new RunScheduler({ taskLimit: 8, workspaceLimit: 8, globalLimit: 8 })
  options.naturalAgentResponses = true
  const calls = []
  let codexDiscussionTurns = 0
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const phase = naturalPhase(prompt)
    calls.push(`${phase}:${agent.kind}`)
    if (phase === 'discussion' && agent.kind === 'codex') codexDiscussionTurns += 1
    return {
      text: phase === 'discussion' && agent.kind === 'codex' && codexDiscussionTurns === 1
        ? 'Codex will inspect this once more.\n\n@codex'
        : `${agent.kind} accepts the current result without changes.`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-task-session`,
    }
  }

  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Natural self-only routing',
    agentKinds: ['codex', 'hermes'],
    workdir: directory,
    allowWrite: false,
  })
  const controller = await runDiscussion(workspace, group, {
    discussionStyle: 'agent-led',
    maxRounds: 5,
  })

  assert.deepEqual(calls, [
    'proposal:codex', 'proposal:hermes',
    'discussion:codex', 'discussion:codex', 'discussion:hermes',
  ])
  const messages = workspace.snapshot().messages.filter(message => (
    message.role === 'agent' && message.threadRootId === controller.threadRootId
  ))
  assert.deepEqual(messages.map(message => `${message.trace.round}:${message.agentKind}`), [
    '1:codex', '1:hermes', '2:codex', '3:codex', '4:hermes',
  ])
})

test('Natural Agent-led V4 does not treat concurrent self-routes as peer confirmation', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runScheduler = new RunScheduler({ taskLimit: 8, workspaceLimit: 8, globalLimit: 8 })
  options.naturalAgentResponses = true
  const calls = []
  const discussionTurns = new Map()
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const phase = naturalPhase(prompt)
    calls.push(`${phase}:${agent.kind}`)
    const turn = (discussionTurns.get(agent.kind) || 0) + (phase === 'discussion' ? 1 : 0)
    discussionTurns.set(agent.kind, turn)
    let text = `${agent.kind} accepts the current result without changes.`
    if (phase === 'discussion' && agent.kind === 'codex' && turn === 1) {
      text = 'Hermes and WorkBuddy should review together.\n\n@hermes @workbuddy'
    } else if (phase === 'discussion' && ['hermes', 'workbuddy'].includes(agent.kind)
        && turn === 1) {
      text = `${agent.kind} will inspect its own notes once more.\n\n@${agent.kind}`
    }
    return { text, sessionRef: runOptions.sessionRef || `${agent.kind}-task-session` }
  }

  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Natural concurrent self-routing',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: false,
  })
  const controller = await runDiscussion(workspace, group, {
    discussionStyle: 'agent-led',
    maxRounds: 6,
  })

  assert.deepEqual(calls, [
    'proposal:codex', 'proposal:hermes', 'proposal:workbuddy',
    'discussion:codex',
    'discussion:hermes', 'discussion:workbuddy',
    'discussion:hermes', 'discussion:workbuddy',
    'discussion:codex',
  ])
  const messages = workspace.snapshot().messages.filter(message => (
    message.role === 'agent' && message.threadRootId === controller.threadRootId
  ))
  assert.deepEqual(messages.map(message => `${message.trace.round}:${message.agentKind}`), [
    '1:codex', '1:hermes', '1:workbuddy',
    '2:codex', '3:hermes', '3:workbuddy',
    '4:hermes', '4:workbuddy', '5:codex',
  ])
})

test('Natural Agent-led V4 does not treat an invalid route as acceptance', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runScheduler = new RunScheduler({ taskLimit: 8, workspaceLimit: 8, globalLimit: 8 })
  options.naturalAgentResponses = true
  const calls = []
  let codexTurns = 0
  let hermesTurns = 0
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const phase = naturalPhase(prompt)
    calls.push(`${phase}:${agent.kind}`)
    if (phase === 'discussion' && agent.kind === 'codex') codexTurns += 1
    if (phase === 'discussion' && agent.kind === 'hermes') hermesTurns += 1
    let text = `${agent.kind} accepts the current result without changes.`
    if (phase === 'discussion' && agent.kind === 'codex' && codexTurns === 1) {
      text = 'Hermes should review next.\n\n@hermes'
    } else if (phase === 'discussion' && agent.kind === 'hermes' && hermesTurns === 1) {
      text = 'This route is malformed.\n\n@codex @ghost'
    }
    return { text, sessionRef: runOptions.sessionRef || `${agent.kind}-task-session` }
  }

  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Natural invalid routing',
    agentKinds: ['codex', 'hermes'],
    workdir: directory,
    allowWrite: false,
  })
  await runDiscussion(workspace, group, {
    discussionStyle: 'agent-led',
    maxRounds: 6,
  })

  assert.deepEqual(calls, [
    'proposal:codex', 'proposal:hermes',
    'discussion:codex', 'discussion:hermes',
    'discussion:codex', 'discussion:hermes',
  ])
})

test('Natural Agent-led V4 recovers a completed proposal harness run before message commit', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  const recoveryLedger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger-recovery.json'),
  })
  const recoveryStoragePath = path.join(directory, 'workspace-recovery.json')
  const crashCheckpoint = deferred()
  options.runLedger = ledger
  options.runScheduler = new RunScheduler({ taskLimit: 1, workspaceLimit: 1, globalLimit: 1 })
  options.naturalAgentResponses = true
  options.runAgent = async (agent, prompt, _workdir, runOptions) => ({
    text: `${naturalPhase(prompt)}-${agent.kind}-original`,
    sessionRef: runOptions.sessionRef || `${agent.kind}-task-session`,
  })

  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Natural proposal harness recovery',
    agentKinds: ['codex', 'hermes'],
    workdir: directory,
    allowWrite: false,
  })
  const checkpointRun = workspace.checkpointRun.bind(workspace)
  let crashCaptured = false
  workspace.checkpointRun = (...args) => {
    const persisted = checkpointRun(...args)
    const durable = ledger.list(group.id)[0]
    const completedCodex = durable?.agentRuns?.find(run => (
      run.round === 1 && run.kind === 'codex' && run.status === 'completed'
    ))
    const hasCodexMessage = workspace.snapshot().messages.some(message => (
      message.role === 'agent'
      && message.threadRootId === durable?.threadRootId
      && message.trace?.round === 1
      && message.agentKind === 'codex'
    ))
    if (!crashCaptured && durable?.orchestration?.phase === 'proposal'
        && completedCodex && !hasCodexMessage) {
      crashCaptured = true
      recoveryLedger.checkpoint(durable)
      fs.copyFileSync(options.storagePath, recoveryStoragePath)
      crashCheckpoint.resolve(structuredClone(durable))
    }
    return persisted
  }

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Recover the completed proposal harness run.',
    mode: 'auto',
    discussionStyle: 'agent-led',
    targetKinds: group.agentKinds,
    maxRounds: 1,
    protocol: 'v4',
  })
  const initialController = workspace.activeRuns.get(group.id)
  const crashRecord = await crashCheckpoint.promise
  await initialController.promise
  const originalCodexRun = crashRecord.agentRuns.find(run => (
    run.round === 1 && run.kind === 'codex' && run.status === 'completed'
  ))
  assert.ok(originalCodexRun)

  const recoveryCalls = []
  const recovered = new LocalWorkspace({
    ...options,
    storagePath: recoveryStoragePath,
    runLedger: recoveryLedger,
    runScheduler: new RunScheduler({ taskLimit: 1, workspaceLimit: 1, globalLimit: 1 }),
    runAgent: async (agent, prompt, _workdir, runOptions) => {
      recoveryCalls.push(`${naturalPhase(prompt)}:${agent.kind}`)
      return {
        text: `${naturalPhase(prompt)}-${agent.kind}-recovered`,
        sessionRef: runOptions.sessionRef || `${agent.kind}-task-session`,
        outcome: 'completed',
      }
    },
  })
  const recoveredController = recovered.activeRuns.get(group.id)
  assert.ok(recoveredController)
  await recovered.refreshAgents()
  await recoveredController.done

  const recoveredRecord = recoveryLedger.get(crashRecord.runId)
  assert.equal(recoveredRecord.status, 'completed', recoveredRecord.reason)
  assert.deepEqual(recoveryCalls, ['proposal:hermes'])
  const messages = recovered.snapshot().messages.filter(message => (
    message.role === 'agent' && message.threadRootId === crashRecord.threadRootId
  ))
  assert.deepEqual(messages.map(message => `${message.trace.round}:${message.agentKind}`), [
    '1:codex', '1:hermes',
  ])
  assert.equal(messages[0].content, 'proposal-codex-original')
  assert.equal(messages[0].trace.agentRunId, originalCodexRun.agentRunId)
  assert.deepEqual(recoveredRecord.agentRuns.map(run => `${run.round}:${run.kind}`), [
    '1:codex', '1:hermes',
  ])
  assertTurnParity(recoveredRecord, messages)
})

test('Natural Agent-led V4 does not rerun a proposal with a stale harness binding', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  const recoveryLedger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger-recovery.json'),
  })
  const recoveryStoragePath = path.join(directory, 'workspace-recovery.json')
  const crashCheckpoint = deferred()
  options.runLedger = ledger
  options.runScheduler = new RunScheduler({ taskLimit: 1, workspaceLimit: 1, globalLimit: 1 })
  options.naturalAgentResponses = true
  options.runAgent = async (agent, prompt, _workdir, runOptions) => ({
    text: `${naturalPhase(prompt)}-${agent.kind}-original`,
    sessionRef: runOptions.sessionRef || `${agent.kind}-task-session`,
  })

  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Natural stale proposal harness',
    agentKinds: ['codex', 'hermes'],
    workdir: directory,
    allowWrite: false,
  })
  const checkpointRun = workspace.checkpointRun.bind(workspace)
  let crashCaptured = false
  workspace.checkpointRun = (...args) => {
    const persisted = checkpointRun(...args)
    const durable = ledger.list(group.id)[0]
    const completedCodex = durable?.agentRuns?.find(run => (
      run.round === 1 && run.kind === 'codex' && run.status === 'completed'
    ))
    const hasCodexMessage = workspace.snapshot().messages.some(message => (
      message.role === 'agent'
      && message.threadRootId === durable?.threadRootId
      && message.trace?.round === 1
      && message.agentKind === 'codex'
    ))
    if (!crashCaptured && durable?.orchestration?.phase === 'proposal'
        && completedCodex && !hasCodexMessage) {
      crashCaptured = true
      const stale = structuredClone(durable)
      stale.agentRuns.find(run => (
        run.round === 1 && run.kind === 'codex'
      )).context.operationId = `operation-${'8'.repeat(64)}`
      recoveryLedger.checkpoint(stale)
      fs.copyFileSync(options.storagePath, recoveryStoragePath)
      crashCheckpoint.resolve(stale)
    }
    return persisted
  }

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Reject a stale proposal harness binding.',
    mode: 'auto',
    discussionStyle: 'agent-led',
    targetKinds: group.agentKinds,
    maxRounds: 1,
    protocol: 'v4',
  })
  const initialController = workspace.activeRuns.get(group.id)
  const crashRecord = await crashCheckpoint.promise
  await initialController.promise

  const recoveryCalls = []
  const recovered = new LocalWorkspace({
    ...options,
    storagePath: recoveryStoragePath,
    runLedger: recoveryLedger,
    runScheduler: new RunScheduler({ taskLimit: 1, workspaceLimit: 1, globalLimit: 1 }),
    runAgent: async (agent, prompt, _workdir, runOptions) => {
      recoveryCalls.push(`${naturalPhase(prompt)}:${agent.kind}`)
      return {
        text: `${naturalPhase(prompt)}-${agent.kind}-recovered`,
        sessionRef: runOptions.sessionRef || `${agent.kind}-task-session`,
        outcome: 'completed',
      }
    },
  })
  const recoveredController = recovered.activeRuns.get(group.id)
  assert.ok(recoveredController)
  await recovered.refreshAgents()
  await recoveredController.done

  assert.deepEqual(recoveryCalls, ['proposal:hermes'])
  const recoveredRecord = recoveryLedger.get(crashRecord.runId)
  assert.equal(recoveredRecord.agentRuns.filter(run => run.kind === 'codex').length, 1)
  assert.equal(recoveredRecord.agentRuns.some(run => (
    run.kind === 'codex'
      && run.context.operationId !== `operation-${'8'.repeat(64)}`
  )), false)
})

test('Natural Agent-led V4 filters a stale coordinator message before confirmation handoff', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  const recoveryLedger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger-recovery.json'),
  })
  const recoveryStoragePath = path.join(directory, 'workspace-recovery.json')
  const crashCheckpoint = deferred()
  options.runLedger = ledger
  options.runScheduler = new RunScheduler({ taskLimit: 8, workspaceLimit: 8, globalLimit: 8 })
  options.naturalAgentResponses = true
  options.runAgent = async (agent, prompt, _workdir, runOptions) => ({
    text: `${agent.kind} accepts the current result without changes.`,
    sessionRef: runOptions.sessionRef || `${agent.kind}-task-session`,
  })

  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Natural confirmation handoff recovery',
    agentKinds: ['codex', 'hermes'],
    workdir: directory,
    allowWrite: false,
  })
  const commitV4AgentMessage = workspace.commitV4AgentMessage.bind(workspace)
  let crashCaptured = false
  workspace.commitV4AgentMessage = (input) => {
    const message = commitV4AgentMessage(input)
    const durable = ledger.list(group.id)[0]
    if (!crashCaptured
        && input.agentKind === 'codex'
        && input.metadata?.trace?.phase === 'discussion'
        && Number(input.metadata?.trace?.round) === 2
        && durable?.orchestration?.phase === 'discussion'
        && durable.orchestration.round === 2
        && durable.orchestration.pendingKinds.join(',') === 'codex') {
      crashCaptured = true
      recoveryLedger.checkpoint(durable)
      fs.copyFileSync(options.storagePath, recoveryStoragePath)
      crashCheckpoint.resolve(structuredClone(durable))
    }
    return message
  }

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Recover the peer confirmation handoff.',
    mode: 'auto',
    discussionStyle: 'agent-led',
    targetKinds: group.agentKinds,
    maxRounds: 4,
    protocol: 'v4',
  })
  const initialController = workspace.activeRuns.get(group.id)
  const crashRecord = await crashCheckpoint.promise
  await initialController.promise
  const originalCoordinatorRun = crashRecord.agentRuns.find(run => (
    run.round === 2 && run.kind === 'codex' && run.status === 'completed'
  ))
  assert.ok(originalCoordinatorRun)
  const recoveryState = JSON.parse(fs.readFileSync(recoveryStoragePath, 'utf8'))
  const staleCoordinatorMessage = recoveryState.messages.find(message => (
    message.role === 'agent'
    && message.threadRootId === crashRecord.threadRootId
    && message.trace?.round === 2
    && message.agentKind === 'codex'
  ))
  assert.ok(staleCoordinatorMessage)
  staleCoordinatorMessage.trace.context.operationId = `operation-${'9'.repeat(64)}`
  fs.writeFileSync(recoveryStoragePath, JSON.stringify(recoveryState))

  const recoveryCalls = []
  const recovered = new LocalWorkspace({
    ...options,
    storagePath: recoveryStoragePath,
    runLedger: recoveryLedger,
    runAgent: async (agent, prompt, _workdir, runOptions) => {
      recoveryCalls.push(`${naturalPhase(prompt)}:${agent.kind}`)
      return {
        text: `${agent.kind} accepts the current result without changes.`,
        sessionRef: runOptions.sessionRef || `${agent.kind}-task-session`,
        outcome: 'completed',
      }
    },
  })
  const recoveredController = recovered.activeRuns.get(group.id)
  assert.ok(recoveredController)
  await recovered.refreshAgents()
  await recoveredController.done

  const recoveredRecord = recoveryLedger.get(crashRecord.runId)
  assert.equal(recoveredRecord.status, 'completed', recoveredRecord.reason)
  assert.deepEqual(recoveryCalls, ['discussion:hermes'])
  const messages = recovered.snapshot().messages.filter(message => (
    message.role === 'agent' && message.threadRootId === crashRecord.threadRootId
  ))
  assert.deepEqual(messages.map(message => `${message.trace.round}:${message.agentKind}`), [
    '1:codex', '1:hermes', '2:codex', '3:hermes',
  ])
  const coordinatorMessage = messages.find(message => (
    message.trace.round === 2 && message.agentKind === 'codex'
  ))
  assert.equal(coordinatorMessage.trace.agentRunId, originalCoordinatorRun.agentRunId)
  assertTurnParity(recoveredRecord, messages)
})
