const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { agentRuntimeError } = require('../../src/agents/agent-runtime-contract.cjs')
const { MAX_RUN_AGENT_ATTEMPTS } = require('../../src/runs/failure-policy.cjs')
const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { RunLedger } = require('../../src/runs/run-ledger.cjs')
const { deferred, fixture } = require('../support/local-workspace-test-helpers.cjs')

function pendingHumanGate(workspace, timeoutMs = 2000) {
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

function graphNode(overrides = {}) {
  return {
    nodeId: 'primary-codex', role: 'primary', agentKind: 'codex',
    dependsOn: [], inputNodeIds: [], expectedOutput: 'Produce one durable conclusion.',
    acceptance: { requireConclusion: true, minArtifactRefs: 1, minEvidenceRefs: 1 },
    terminal: false, parallel: false, decisionOptions: [],
    ...overrides,
  }
}

function evidenceTaskGraph() {
  return {
    template: 'task-graph',
    nodes: [
      graphNode({ parallel: true }),
      graphNode({ nodeId: 'primary-hermes', agentKind: 'hermes', parallel: true }),
      graphNode({
        nodeId: 'review-workbuddy', role: 'reviewer', agentKind: 'workbuddy',
        dependsOn: ['primary-codex', 'primary-hermes'],
        inputNodeIds: ['primary-codex', 'primary-hermes'],
        expectedOutput: 'Review both Primary results independently.',
      }),
      graphNode({
        nodeId: 'decide-kimi', role: 'arbiter', agentKind: 'kimi',
        dependsOn: ['review-workbuddy'], inputNodeIds: ['review-workbuddy'],
        expectedOutput: 'Resolve the reviewed conflict using typed Evidence.',
        terminal: true,
      }),
    ],
  }
}

test('task graph runs independent branches in parallel and completes from typed Evidence', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  const primaryBarrier = deferred()
  let activePrimaries = 0
  let maxActivePrimaries = 0
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (['codex', 'hermes'].includes(agent.kind)) {
      activePrimaries += 1
      maxActivePrimaries = Math.max(maxActivePrimaries, activePrimaries)
      if (activePrimaries === 2) primaryBarrier.resolve()
      await primaryBarrier.promise
      activePrimaries -= 1
    }
    return {
      text: agent.kind === 'codex'
        ? 'Release is ready.'
        : (agent.kind === 'hermes' ? 'Release is blocked.' : `${agent.kind} typed decision.`),
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Evidence task graph',
    agentKinds: ['codex', 'hermes', 'workbuddy', 'kimi'],
    workdir: directory,
    allowWrite: false,
  })

  const started = await workspace.sendMessage({
    groupId: group.id,
    text: 'Assess release readiness with independent review.',
    mode: 'auto',
    maxRounds: 6,
    targetKinds: ['codex', 'hermes', 'workbuddy', 'kimi'],
    workflow: evidenceTaskGraph(),
  })
  await workspace.activeRuns.get(group.id).promise

  assert.equal(maxActivePrimaries, 2)
  assert.deepEqual(calls.map(call => call.agent.kind), [
    'codex', 'hermes', 'workbuddy', 'kimi',
  ])
  assert.equal(calls.every(call => !call.prompt.includes('ROUNDRELAY_CONSENSUS')), true)
  assert.equal(calls[2].runOptions.sessionRef, '')
  assert.match(calls[2].prompt, /ROUNDRELAY_TASK_GRAPH_V1/)
  assert.match(calls[2].prompt, /\[conflict\]/)
  assert.equal(calls[3].runOptions.sessionRef, '')

  const durable = ledger.list(group.id)[0]
  assert.equal(durable.status, 'completed')
  assert.equal(durable.orchestration.version, 3)
  assert.equal(durable.orchestration.taskGraph.terminalState, 'accepted')
  const states = Object.fromEntries(durable.orchestration.taskGraph.nodeStates.map(state => (
    [state.nodeId, state]
  )))
  assert.equal(states['review-workbuddy'].attention, 'review')
  assert.equal(states['decide-kimi'].attention, 'decision')
  assert.equal(durable.orchestration.taskGraph.nodeStates.every(state => (
    state.status === 'accepted'
  )), true)
  assert.equal(durable.orchestration.collaboration.entries.some(entry => (
    entry.entryType === 'decision'
    && entry.refs.some(reference => durable.orchestration.collaboration.entries.some(
      candidate => candidate.entryId === reference && candidate.entryType === 'conflict',
    ))
  )), true)
  assert.equal(workspace.snapshot().messages.filter(message => (
    message.threadRootId === started.threadRootId && message.role === 'agent'
  )).length, 4)
})

test('task graph Human node uses a typed decision instead of Agent consensus', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Human decision graph', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const graph = {
    template: 'task-graph',
    nodes: [
      graphNode(),
      graphNode({
        nodeId: 'human-release', role: 'human', agentKind: null,
        dependsOn: ['primary-codex'], inputNodeIds: ['primary-codex'],
        expectedOutput: 'Approve or reject the release decision.',
        acceptance: { requireConclusion: false, minArtifactRefs: 0, minEvidenceRefs: 0 },
        terminal: true,
        decisionOptions: [
          { optionId: 'approve-release', name: 'Approve release', kind: 'allow_once' },
          { optionId: 'reject-release', name: 'Reject release', kind: 'reject_once' },
        ],
      }),
    ],
  }

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Prepare a release decision.',
    mode: 'auto', maxRounds: 4, targetKinds: ['codex', 'hermes'], workflow: graph,
  })
  const gate = await pendingHumanGate(workspace)
  assert.equal(gate.type, 'decision')
  assert.equal(ledger.get(gate.runId).orchestration.taskGraph.nodeStates[1].status, 'waiting')
  workspace.decideHumanGate(gate.gateId, {
    status: 'approved', optionId: 'approve-release', actorId: 'local-user',
  })
  await workspace.activeRuns.get(group.id).promise

  const durable = ledger.get(gate.runId)
  assert.equal(durable.status, 'completed')
  assert.equal(durable.continuation.state, 'completed')
  assert.equal(durable.orchestration.taskGraph.nodeStates[1].decisionOptionId, 'approve-release')
  assert.equal(calls.length, 1)
})
test('auto send preflights atomically, persists one root, and starts at round one', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const firstCallEntered = deferred()
  const firstCallGate = deferred()
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (calls.length === 1) {
      firstCallEntered.resolve()
      await firstCallGate.promise
    }
    return {
      text: `${agent.kind} agrees\n[[ROUNDRELAY_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  options.validateKnowledgeBaseSelections = (_targetKinds, selections) => selections.map(selection => ({
    ...selection,
    name: 'DingTalk',
    accessMode: 'cli',
    commandName: 'dws',
  }))
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '原子自动讨论', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const attachment = {
    id: 'auto-send-image', name: 'context.png', mimeType: 'image/png', size: 20,
  }
  const skill = {
    targetKind: 'hermes', namespace: 'global', slug: 'research', name: 'Research',
  }
  const knowledgeBase = { kind: 'dingtalk', targetKinds: ['hermes'] }

  const started = await workspace.sendMessage({
    groupId: group.id,
    text: '直接开始自动讨论',
    mode: 'auto',
    maxRounds: 2,
    targetKinds: ['codex', 'hermes'],
    attachments: [attachment],
    skillHints: [skill],
    knowledgeBaseHints: [knowledgeBase],
  })
  await firstCallEntered.promise

  const active = workspace.snapshot()
  const root = active.messages.find(message => message.role === 'user')
  assert.deepEqual(started, { started: true, maxRounds: 2, threadRootId: root.id })
  assert.equal(active.messages.filter(message => message.role === 'user').length, 1)
  assert.equal(root.threadRootId, undefined)
  assert.deepEqual(root.targetKinds, ['codex', 'hermes'])
  assert.deepEqual(root.knowledgeBaseHints, [{
    kind: 'dingtalk', name: 'DingTalk', accessMode: 'cli',
    commandName: 'dws', targetKinds: ['hermes'],
  }])
  assert.deepEqual(active.runs.map(run => ({
    mode: run.mode,
    currentRound: run.currentRound,
    maxRounds: run.maxRounds,
    threadRootId: run.threadRootId,
  })), [{ mode: 'auto', currentRound: 1, maxRounds: 2, threadRootId: root.id }])
  assert.equal(calls.length, 1)
  assert.match(calls[0].prompt, /ROUNDRELAY_CONSENSUS/)
  assert.doesNotMatch(JSON.stringify(active), /sessionRef/)

  const pending = workspace.activeRuns.get(group.id).promise
  firstCallGate.resolve()
  await pending

  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes'])
  assert.equal(calls.every(call => call.prompt.includes('ROUNDRELAY_CONSENSUS')), true)
  assert.deepEqual(calls.map(call => call.runOptions.attachments), [
    [path.join(directory, 'attachments', 'auto-send-image.png')],
    [path.join(directory, 'attachments', 'auto-send-image.png')],
  ])
  assert.equal(calls[1].runOptions.skills, undefined)
  assert.match(calls[1].prompt, /global\/research: Research/)
  assert.doesNotMatch(calls[0].prompt, /configured dws command-line connection/)
  assert.match(calls[1].prompt, /configured dws command-line connection/)
  assert.deepEqual(
    workspace.snapshot().messages.filter(message => message.role === 'agent')
      .map(message => message.threadRootId),
    [root.id, root.id],
  )
  assert.equal(finished.length, 1)
  assert.equal(finished[0].mode, 'auto')
  assert.equal(finished[0].status, 'completed')
})

test('automatic Primary Reviewer Arbiter flow uses selective typed collaboration state', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  const conclusions = {
    codex: 'The release is ready after tests.',
    hermes: 'The release is blocked by missing package proof.',
    workbuddy: 'The release is ready because package proof is present.',
  }
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return {
      text: `${conclusions[agent.kind]}\n[[ROUNDRELAY_CONSENSUS:agree]]`,
      sessionRef: `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Typed collaboration',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
  })

  const started = await workspace.sendMessage({
    groupId: group.id,
    text: 'Assess release readiness using the available evidence.',
    mode: 'auto',
    maxRounds: 2,
    targetKinds: ['codex', 'hermes', 'workbuddy'],
  })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes', 'workbuddy'])
  assert.match(calls[0].prompt, /Role: primary/)
  assert.match(calls[0].prompt, /Selected blackboard entries: \(none\)/)
  assert.match(calls[1].prompt, /Role: reviewer/)
  assert.match(calls[1].prompt, /The release is ready after tests\./)
  assert.match(calls[2].prompt, /Role: arbiter/)
  assert.match(calls[2].prompt, /\[conflict\]/)
  assert.match(calls[2].prompt, /missing package proof/)
  assert.doesNotMatch(calls[2].prompt, /Recent conversation across the group:\n(?:Codex|Hermes):/)

  const messages = workspace.snapshot().messages.filter(message => message.role === 'agent')
  const arbiterMessage = messages.find(message => message.agentKind === 'workbuddy')
  const transcriptOnly = workspace.packedPromptContext(group.id, '', started.threadRootId, {
    beforeMessageId: arbiterMessage.id,
    focusUserMessageId: started.threadRootId,
  })
  assert.ok(transcriptOnly.context.includedCount > arbiterMessage.trace.context.includedCount)
  assert.ok(transcriptOnly.context.charCount > arbiterMessage.trace.context.charCount)
  assert.deepEqual(arbiterMessage.trace.sourceMessageIds, [started.threadRootId])

  const durable = ledger.list(group.id)[0]
  assert.equal(durable.orchestration.version, 2)
  assert.deepEqual(durable.orchestration.collaboration.handoffs.map(handoff => (
    handoff.destination.role
  )), ['primary', 'reviewer', 'arbiter'])
  assert.equal(durable.orchestration.collaboration.entries.some(entry => (
    entry.entryType === 'conflict'
  )), true)
})

test('unlimited automatic discussion continues past a finite cap until consensus', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const firstCallEntered = deferred()
  const firstCallGate = deferred()
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (calls.length === 1) {
      firstCallEntered.resolve()
      await firstCallGate.promise
    }
    const agreed = calls.length > 2
    return {
      text: `${agent.kind} response\n[[ROUNDRELAY_CONSENSUS:${agreed ? 'agree' : 'continue'}]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '不限轮次讨论', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  const started = await workspace.sendMessage({
    groupId: group.id,
    text: '讨论到达成共识',
    mode: 'auto',
    maxRounds: 1,
    unlimitedRounds: true,
  })
  await firstCallEntered.promise

  const active = workspace.snapshot().runs[0]
  assert.deepEqual(started, {
    started: true,
    maxRounds: 0,
    threadRootId: active.threadRootId,
    unlimitedRounds: true,
  })
  assert.equal(active.currentRound, 1)
  assert.equal(active.maxRounds, 0)
  assert.equal(active.unlimitedRounds, true)

  const pending = workspace.activeRuns.get(group.id).promise
  firstCallGate.resolve()
  await pending

  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes', 'codex', 'hermes'])
  assert.equal(finished[0].status, 'completed')
  assert.equal(workspace.snapshot().messages.some(message => (
    message.system?.key === 'system.autoRoundLimit'
  )), false)
})

test('unlimited automatic discussion stops at the mandatory Agent-attempt circuit breaker', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return {
      text: `${agent.kind} keeps going\n[[ROUNDRELAY_CONSENSUS:continue]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Mandatory circuit breaker', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  const root = workspace.addMessage(group.id, 'user', 'Continue forever')
  workspace.startAuto({ groupId: group.id, threadRootId: root.id, unlimitedRounds: true })
  await workspace.activeRuns.get(group.id).promise

  assert.equal(calls.length, MAX_RUN_AGENT_ATTEMPTS)
  assert.equal(finished[0].status, 'circuit-breaker')
  const terminal = ledger.list(group.id)[0]
  assert.equal(terminal.status, 'circuit-breaker')
  assert.equal(terminal.reason, 'circuit_breaker')
  assert.equal(terminal.attemptHistory.length, MAX_RUN_AGENT_ATTEMPTS)
  assert.equal(workspace.snapshot().messages.some(message => (
    message.system?.key === 'system.runCircuitBreaker'
      && message.system.params.maxAttempts === MAX_RUN_AGENT_ATTEMPTS
  )), true)

  const storedWorkspace = JSON.parse(fs.readFileSync(options.storagePath, 'utf8'))
  storedWorkspace.messages = storedWorkspace.messages.filter(message => (
    message.system?.key !== 'system.runCircuitBreaker'
  ))
  fs.writeFileSync(options.storagePath, JSON.stringify(storedWorkspace), 'utf8')
  const restarted = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') }),
  })
  assert.equal(restarted.snapshot().messages.some(message => (
    message.system?.key === 'system.runCircuitBreaker'
  )), true)
})

test('transient retries cannot exceed the mandatory Agent-attempt circuit breaker', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const firstCallEntered = deferred()
  const releaseFirstCall = deferred()
  options.retrySleep = async () => {}
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    firstCallEntered.resolve()
    await releaseFirstCall.promise
    throw Object.assign(new Error('Provider temporarily unavailable'), { statusCode: 503 })
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Retry circuit breaker', agentKinds: ['hermes', 'codex'], workdir: directory,
    allowWrite: false,
  })
  workspace.addMessage(group.id, 'user', 'Do not exceed the retry ceiling')

  workspace.startAuto({ groupId: group.id, unlimitedRounds: true })
  const active = workspace.activeRuns.get(group.id)
  await firstCallEntered.promise
  active.attemptHistory = Array.from({ length: MAX_RUN_AGENT_ATTEMPTS - 1 }, (_, index) => ({
    sequence: index + 1,
  }))
  releaseFirstCall.resolve()
  await active.promise

  assert.equal(calls.length, 1)
  assert.equal(active.attemptHistory.length, MAX_RUN_AGENT_ATTEMPTS)
  assert.equal(finished[0].status, 'circuit-breaker')
  assert.equal(workspace.snapshot().messages.some(message => (
    message.system?.key === 'system.runCircuitBreaker'
  )), true)
})

test('later group rounds use a compact Harness continuation instead of the bootstrap template', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    const consensus = calls.length > 2 ? 'agree' : 'continue'
    return {
      text: `${agent.kind} round ${calls.length}\n[[ROUNDRELAY_CONSENSUS:${consensus}]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '续接上下文',
    topic: '固定主题不应在每一轮重复发送',
    agentKinds: ['codex', 'hermes'],
    workdir: directory,
  })

  const started = await workspace.sendMessage({
    groupId: group.id,
    text: '请围绕这个主题进行两轮讨论',
    mode: 'auto',
    maxRounds: 2,
  })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes', 'codex', 'hermes'])
  assert.match(calls[0].prompt, /You are participating in the local/)
  assert.match(calls[0].prompt, /Group topic: 固定主题/)
  assert.match(calls[2].prompt, /Harness-compressed shared context/)
  assert.doesNotMatch(calls[2].prompt, /You are participating in the local|Group topic:/)
  assert.doesNotMatch(calls[2].prompt, /Deliverable capture contract|Stable user instructions and constraints:/)
  assert.match(calls[2].prompt, /\[claim\].*hermes round 2/)
  assert.match(calls[2].prompt, /请围绕这个主题进行两轮讨论/)
  assert.ok(calls[2].prompt.length < 12000)
  assert.equal(calls[2].runOptions.sessionRef, 'codex-session')
  assert.equal(calls[3].runOptions.sessionRef, 'hermes-session')

  const root = workspace.snapshot().messages.find(message => message.id === started.threadRootId)
  const codexReplies = workspace.snapshot().messages.filter(message => (
    message.role === 'agent' && message.agentKind === 'codex'
  ))
  assert.equal(root.content, '请围绕这个主题进行两轮讨论')
  assert.equal(codexReplies.at(-1).trace.context.contextMode, 'continuation')
  assert.equal(codexReplies.at(-1).trace.context.promptChars, calls[2].prompt.length)
})

test('auto send rejects failed preflight without persisting a root or starting an Agent', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.validateSkillSelections = () => { throw new Error('LOCAL_SKILL_SELECTION_INVALID') }
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '自动预检失败', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  await assert.rejects(workspace.sendMessage({
    groupId: group.id,
    text: '不应持久化',
    mode: 'auto',
    targetKinds: ['codex', 'hermes'],
    skillHints: [{
      targetKind: 'hermes', namespace: 'global', slug: 'research', name: 'Research',
    }],
  }), { message: 'LOCAL_SKILL_SELECTION_INVALID' })

  assert.equal(calls.length, 0)
  assert.equal(workspace.snapshot().messages.length, 0)
  assert.deepEqual(workspace.snapshot().runningGroupIds, [])
  assert.deepEqual(workspace.snapshot().runs, [])
  assert.deepEqual(ledger.list(group.id), [])
  assert.deepEqual(finished, [])
})

test('auto send rolls back its root when the reserved run is cancelled during handoff', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  const finished = []
  let stopped = false
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '自动交接取消', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  workspace.on('changed', (snapshot) => {
    if (stopped || !snapshot.messages.some(message => message.role === 'user')) return
    if (!snapshot.runs.some(run => run.groupId === group.id && run.phase === 'preparing')) return
    stopped = true
    const run = snapshot.runs.find(item => item.groupId === group.id)
    workspace.stop(group.id, run.runId)
  })

  await assert.rejects(workspace.sendMessage({
    groupId: group.id,
    text: '取消时不应留下消息',
    mode: 'auto',
    maxRounds: 2,
  }), { message: 'LOCAL_AGENT_EXECUTION_STOPPED' })

  assert.equal(stopped, true)
  assert.equal(calls.length, 0)
  assert.equal(workspace.snapshot().messages.length, 0)
  assert.deepEqual(workspace.snapshot().runningGroupIds, [])
  assert.deepEqual(finished, [])
})

test('auto handoff rollback keeps memory and disk aligned when its save fails', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  let stopped = false
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '自动交接回滚失败', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  workspace.on('changed', (snapshot) => {
    if (stopped || !snapshot.messages.some(message => message.role === 'user')) return
    const run = snapshot.runs.find(item => item.groupId === group.id && item.phase === 'preparing')
    if (!run) return
    stopped = true
    workspace.stop(group.id, run.runId)
  })

  const originalSave = workspace.conversations.save
  let conversationSaveCalls = 0
  workspace.conversations.save = () => {
    conversationSaveCalls += 1
    if (conversationSaveCalls === 2) throw new Error('ROLLBACK_SAVE_FAILED')
    return originalSave()
  }

  let failure
  try {
    await workspace.sendMessage({
      groupId: group.id,
      text: '回滚失败时保留已落盘的消息',
      mode: 'auto',
      maxRounds: 2,
    })
  } catch (error) {
    failure = error
  }

  assert.equal(failure?.message, 'LOCAL_AGENT_EXECUTION_STOPPED')
  assert.equal(failure?.rollbackError?.message, 'ROLLBACK_SAVE_FAILED')
  assert.equal(stopped, true)
  assert.equal(calls.length, 0)
  assert.equal(conversationSaveCalls, 2)
  assert.equal(workspace.snapshot().messages.length, 1)
  assert.deepEqual(workspace.snapshot().runningGroupIds, [])

  const reloaded = new LocalWorkspace(options)
  assert.equal(reloaded.snapshot().messages.length, 1)
  assert.equal(reloaded.snapshot().messages[0].content, '回滚失败时保留已落盘的消息')
})

test('automatic dialogue continues complete rounds until every Agent agrees', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const replies = [
    'Codex still has one edge case.\n[[ROUNDRELAY_CONSENSUS:continue]]',
    'Hermes agrees that clarification is needed.\n[[ROUNDRELAY_CONSENSUS:continue]]',
    'Codex accepts the current conclusion.\n[[ROUNDRELAY_CONSENSUS:agree]]',
    'Hermes accepts the current conclusion.\n[[ROUNDRELAY_CONSENSUS:agree]]',
  ]
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return {
      text: replies[calls.length - 1],
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '自动讨论', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const root = workspace.addMessage(group.id, 'user', '讨论本地 Agent 架构')
  workspace.startAuto({ groupId: group.id, maxRounds: 4 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes', 'codex', 'hermes'])
  assert.deepEqual(calls.map(call => call.runOptions.sessionRef), [
    '', '', 'codex-session', 'hermes-session',
  ])
  assert.equal(calls.every(call => call.prompt.includes('[[ROUNDRELAY_CONSENSUS:agree]]')), true)
  assert.deepEqual(
    workspace.snapshot().messages.filter(message => message.role === 'agent')
      .map(message => message.threadRootId),
    [root.id, root.id, root.id, root.id],
  )
  assert.deepEqual(
    workspace.snapshot().messages.filter(message => message.role === 'agent')
      .map(message => message.content),
    [
      'Codex still has one edge case.',
      'Hermes agrees that clarification is needed.',
      'Codex accepts the current conclusion.',
      'Hermes accepts the current conclusion.',
    ],
  )
  assert.deepEqual(
    workspace.snapshot().messages.filter(message => message.role === 'agent')
      .map(message => message.trace.round),
    [1, 1, 2, 2],
  )
  const reloaded = new LocalWorkspace(options)
  await reloaded.refreshAgents()
  assert.deepEqual(
    reloaded.snapshot().messages.filter(message => message.role === 'agent')
      .map(message => message.trace.round),
    [1, 1, 2, 2],
  )
  assert.deepEqual(workspace.snapshot().runningGroupIds, [])
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'completed')
  assert.equal(finished[0].mode, 'auto')
})

test('automatic dialogue persists attempts beyond the live Harness window', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  options.runLedger = new RunLedger({ storagePath: ledgerPath })
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    const consensus = calls.length > 60 ? 'agree' : 'continue'
    return {
      text: `${agent.kind} round result\n[[ROUNDRELAY_CONSENSUS:${consensus}]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Durable automatic history',
    agentKinds: ['codex', 'hermes', 'workbuddy', 'kimi', 'openclaw'],
    workdir: directory,
  })
  workspace.addMessage(group.id, 'user', 'Keep every automatic attempt durable')

  workspace.startAuto({ groupId: group.id, unlimitedRounds: true })
  const runId = workspace.activeRuns.get(group.id).runId
  await workspace.activeRuns.get(group.id).promise

  assert.equal(calls.length, 65)
  const restored = new RunLedger({ storagePath: ledgerPath }).get(runId)
  assert.equal(restored.agentRuns.length, 65)
  assert.equal(restored.agentRuns[0].round, 1)
  assert.equal(restored.agentRuns[0].kind, 'codex')
  assert.equal(restored.agentRuns.at(-1).round, 13)
  assert.equal(restored.agentRuns.at(-1).kind, 'openclaw')
})

test('automatic dialogue reuses Kimi ACP sessions across rounds', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    const agentCallCount = calls.filter(call => call.agent.kind === agent.kind).length
    const consensus = agentCallCount > 1 ? 'agree' : 'continue'
    const sessionRef = agent.kind === 'kimi'
      ? (runOptions.sessionRef || 'kimi-acp-session')
      : (runOptions.sessionRef || `${agent.kind}-session`)
    if (agent.kind === 'kimi') {
      await runOptions.onSessionRef(sessionRef, { transport: 'acp' })
    }
    return {
      text: `${agent.kind} ${consensus}\n[[ROUNDRELAY_CONSENSUS:${consensus}]]`,
      sessionRef,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Kimi ACP discussion', agentKinds: ['codex', 'kimi'], workdir: directory,
  })

  const started = await workspace.sendMessage({
    groupId: group.id,
    text: 'Check ACP session continuity',
    mode: 'auto',
    maxRounds: 2,
  })
  assert.equal(started.started, true)
  await workspace.activeRuns.get(group.id).promise

  const kimiCalls = calls.filter(call => call.agent.kind === 'kimi')
  const kimiSessionKey = workspace.sessionKey(group.id, 'kimi', started.threadRootId)
  assert.deepEqual(kimiCalls.map(call => call.runOptions.sessionRef), ['', 'kimi-acp-session'])
  assert.deepEqual(kimiCalls.map(call => call.runOptions.sessionTransport), ['', 'acp'])
  assert.equal(workspace.state.sessions[kimiSessionKey], 'kimi-acp-session')
  assert.equal(workspace.state.sessionMeta[kimiSessionKey].transport, 'acp')
})

test('automatic dialogue keeps Hermes on one legacy session across rounds', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    const agentCallCount = calls.filter(call => call.agent.kind === agent.kind).length
    const consensus = agentCallCount > 1 ? 'agree' : 'continue'
    const sessionRef = agent.kind === 'hermes'
      ? (runOptions.sessionRef || 'hermes-legacy-session')
      : (runOptions.sessionRef || `${agent.kind}-session`)
    if (agent.kind === 'hermes') {
      await runOptions.onSessionRef(sessionRef, { transport: 'legacy' })
    }
    return {
      text: `${agent.kind} ${consensus}\n[[ROUNDRELAY_CONSENSUS:${consensus}]]`,
      sessionRef,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Hermes legacy discussion', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  const started = await workspace.sendMessage({
    groupId: group.id,
    text: 'Check Hermes session continuity',
    mode: 'auto',
    maxRounds: 2,
  })
  assert.equal(started.started, true)
  await workspace.activeRuns.get(group.id).promise

  const hermesCalls = calls.filter(call => call.agent.kind === 'hermes')
  const hermesSessionKey = workspace.sessionKey(group.id, 'hermes', started.threadRootId)
  assert.deepEqual(hermesCalls.map(call => call.runOptions.sessionRef), ['', 'hermes-legacy-session'])
  assert.deepEqual(hermesCalls.map(call => call.runOptions.sessionTransport), ['', 'legacy'])
  assert.deepEqual(hermesCalls.map(call => call.runOptions.hermesAcpAvailable), [false, false])
  assert.equal(workspace.state.sessions[hermesSessionKey], 'hermes-legacy-session')
  assert.equal(workspace.state.sessionMeta[hermesSessionKey].transport, 'legacy')
})

test('automatic dialogue queues only the explicitly targeted group members', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return {
      text: `${agent.kind} agrees\n[[ROUNDRELAY_CONSENSUS:agree]]`,
      sessionRef: `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  const runFinished = deferred()
  workspace.on('run-finished', (result) => {
    finished.push(result)
    runFinished.resolve()
  })
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '定向自动讨论',
    agentKinds: ['codex', 'hermes', 'workbuddy', 'kimi', 'openclaw'],
    workdir: directory,
  })

  await assert.rejects(workspace.sendMessage({
    groupId: group.id,
    text: 'Only Codex',
    mode: 'auto',
    targetKinds: ['codex'],
    maxRounds: 1,
  }), { message: 'LOCAL_AUTO_AGENT_COUNT' })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Codex、Hermes 和 Kimi 讨论',
    mode: 'auto',
    targetKinds: ['codex', 'hermes', 'kimi'],
    mentionedAgentKinds: ['codex', 'hermes', 'kimi'],
    maxRounds: 1,
  })
  await runFinished.promise

  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes', 'kimi'])
  assert.deepEqual(
    workspace.snapshot().messages.find(message => message.role === 'user')?.targetKinds,
    ['codex', 'hermes', 'kimi'],
  )
  assert.deepEqual(finished[0].targetKinds, ['codex', 'hermes', 'kimi'])

  calls.length = 0
  const nextRoot = workspace.addMessage(group.id, 'user', '另一组继续讨论')
  workspace.startAuto({
    groupId: group.id,
    threadRootId: nextRoot.id,
    targetKinds: ['workbuddy', 'openclaw'],
    maxRounds: 1,
  })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), ['workbuddy', 'openclaw'])
  assert.deepEqual(finished[1].targetKinds, ['workbuddy', 'openclaw'])
})

test('automatic dialogue falls back to staged image files beyond native limits', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const attachmentRoot = path.join(directory, 'attachments')
  fs.mkdirSync(attachmentRoot)
  fs.writeFileSync(path.join(attachmentRoot, 'attachment-auto.png'), Buffer.alloc(128))
  fs.writeFileSync(path.join(attachmentRoot, 'attachment-detail.png'), Buffer.alloc(64))
  options.attachmentSupport = kind => ({
    image: options.imageAttachmentLimit(kind),
    file: 4,
  })
  let hermesAttempts = 0
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'hermes' && hermesAttempts++ === 0) {
      throw new Error('LOCAL_AGENT_PROCESS_FAILED')
    }
    const consensus = calls.length >= 4 ? 'agree' : 'continue'
    return {
      text: `${agent.kind} reply\n[[ROUNDRELAY_CONSENSUS:${consensus}]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '附件自动讨论', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const attachments = [
    { id: 'attachment-auto', name: 'architecture.png', mimeType: 'image/png', size: 128 },
    { id: 'attachment-detail', name: 'detail.png', mimeType: 'image/png', size: 64 },
  ]
  const skill = {
    targetKind: 'hermes', namespace: 'global', slug: 'research', name: 'Research',
  }
  workspace.addMessage(group.id, 'user', '审查这张架构图', '', '', null, {
    attachments, skillHints: [skill],
  })

  workspace.startAuto({ groupId: group.id, maxRounds: 2 })
  await workspace.activeRuns.get(group.id).promise

  const attachmentPath = path.join(directory, 'attachments', 'attachment-auto.png')
  const detailPath = path.join(directory, 'attachments', 'attachment-detail.png')
  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes', 'codex', 'hermes'])
  assert.deepEqual(calls.map(call => call.runOptions.attachments), [
    [attachmentPath, detailPath], [attachmentPath], [], [attachmentPath],
  ])
  const hermesCalls = calls.filter(call => call.agent.kind === 'hermes')
  assert.equal(hermesCalls.every(call => call.runOptions.skills === undefined), true)
  assert.equal(hermesCalls.every(call => /global\/research: Research/.test(call.prompt)), true)
  assert.equal(hermesCalls.every(call => /\.meldwork-input\/\.run-[^/]+\/1-detail\.png/.test(call.prompt)), true)
})

test('automatic dialogue rejects unequal image context before starting any Agent', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '附件能力预检', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', '比较两张图', '', '', null, {
    attachments: [
      { id: 'attachment-a', name: 'a.png', mimeType: 'image/png', size: 128 },
      { id: 'attachment-b', name: 'b.png', mimeType: 'image/png', size: 128 },
    ],
  })

  assert.throws(
    () => workspace.startAuto({ groupId: group.id, maxRounds: 2 }),
    { message: 'LOCAL_AGENT_IMAGE_LIMIT' },
  )
  assert.deepEqual(workspace.snapshot().runningGroupIds, [])
  assert.equal(calls.length, 0)
})

test('automatic dialogue requires one final standalone consensus marker', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const replies = [
    [
      'Codex quoted [[ROUNDRELAY_CONSENSUS:agree]] but still has a reservation.',
      '[[ROUNDRELAY_CONSENSUS:agree]]',
    ].join('\n'),
    'Hermes accepts the current conclusion.\n[[ROUNDRELAY_CONSENSUS:agree]]',
    'Codex has resolved the reservation.\n[[ROUNDRELAY_CONSENSUS:agree]]',
    'Hermes confirms the final conclusion.\n[[ROUNDRELAY_CONSENSUS:agree]]',
  ]
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return {
      text: replies[calls.length - 1],
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '严格共识', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', '避免引用标记造成误判')

  workspace.startAuto({ groupId: group.id, maxRounds: 2 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes', 'codex', 'hermes'])
  assert.equal(workspace.snapshot().messages.some(message => (
    message.content.includes('[[ROUNDRELAY_CONSENSUS:')
  )), false)
  assert.equal(workspace.snapshot().messages.some(message => (
    message.system?.key === 'system.autoRoundLimit'
  )), false)
})

test('automatic dialogue does not count an incomplete Agent turn as agreement', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return {
      text: `${agent.kind} agrees.\n[[ROUNDRELAY_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
      outcome: calls.length !== 1 ? 'completed' : 'partial',
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '完整回复', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', '截断回复不能作为共识')

  workspace.startAuto({ groupId: group.id, maxRounds: 2 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes', 'codex', 'hermes'])
  assert.equal(workspace.snapshot().messages.some(message => (
    message.system?.key === 'system.autoRoundLimit'
  )), false)
})

test('stopping automatic dialogue cancels the active round without a limit message', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let activeSignal
  let secondRoundStarted
  const secondRound = new Promise(resolve => { secondRoundStarted = resolve })
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (calls.length < 3) {
      return {
        text: `${agent.kind} continue\n[[ROUNDRELAY_CONSENSUS:continue]]`,
        sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
      }
    }
    activeSignal = runOptions.signal
    secondRoundStarted()
    await new Promise((resolve, reject) => {
      if (runOptions.signal.aborted) {
        reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED'))
        return
      }
      runOptions.signal.addEventListener(
        'abort', () => reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED')), { once: true },
      )
    })
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '停止自动讨论', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', '讨论到手动停止为止')

  workspace.startAuto({ groupId: group.id, maxRounds: 4 })
  const pending = workspace.activeRuns.get(group.id).promise
  const runId = workspace.activeRuns.get(group.id).runId
  await secondRound

  assert.equal(workspace.stop(group.id, 'stale-run'), false)
  assert.equal(activeSignal.aborted, false)
  assert.equal(workspace.stop(group.id, runId), true)
  await pending

  assert.equal(activeSignal.aborted, true)
  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes', 'codex'])
  assert.equal(workspace.stop(group.id, runId), false)
  assert.deepEqual(workspace.snapshot().runningGroupIds, [])
  assert.equal(workspace.snapshot().messages.some(message => (
    ['system.autoRoundLimit', 'system.autoTimeout'].includes(message.system?.key)
  )), false)
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'stopped')
})

test('automatic HTTP 401 completes without a retry delay or recovery handoff', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const delays = []
  options.retrySleep = async delayMs => { delays.push(delayMs) }
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind !== 'hermes') {
      return {
        text: 'codex agrees\n[[ROUNDRELAY_CONSENSUS:agree]]',
        sessionRef: runOptions.sessionRef || 'codex-session',
      }
    }
    throw new Error('HTTP 401: Invalid token')
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '401 retry stop', agentKinds: ['hermes', 'codex'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', 'Fail authentication without repeating it')

  workspace.startAuto({ groupId: group.id, unlimitedRounds: true })
  const active = workspace.activeRuns.get(group.id)
  await active.promise

  assert.deepEqual(calls.map(call => call.agent.kind), ['hermes', 'codex'])
  assert.deepEqual(delays, [])
  assert.deepEqual(workspace.getGroup(group.id).agentKinds, ['hermes', 'codex'])
  assert.equal(calls.some(call => call.prompt.includes('Harness recovery task')), false)
  assert.equal(workspace.snapshot().messages.some(message => (
    message.system?.key === 'system.autoTimeout'
  )), false)
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'partial')
})

test('per-Agent retry restarts only the interrupted Agent attempt', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  const firstAttempt = deferred()
  let codexAttempts = 0
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'codex' && ++codexAttempts === 1) {
      firstAttempt.resolve()
      await new Promise((resolve, reject) => {
        const abort = () => reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED'))
        if (runOptions.signal.aborted) abort()
        else runOptions.signal.addEventListener('abort', abort, { once: true })
      })
    }
    return {
      text: `${agent.kind} agrees\n[[ROUNDRELAY_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Retry one Agent', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', 'Retry only the interrupted Agent')

  workspace.startAuto({ groupId: group.id, maxRounds: 1 })
  const active = workspace.activeRuns.get(group.id)
  await firstAttempt.promise
  assert.equal(workspace.controlAgent(group.id, active.runId, 'codex', 'retry'), true)
  await active.promise

  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'codex', 'hermes'])
  assert.equal(workspace.snapshot().messages.some(message => (
    message.agentKind === 'codex' && message.system?.key === 'system.agentCallFailed'
  )), false)
  assert.deepEqual(ledger.list(group.id)[0].attemptHistory.find(entry => (
    entry.phase === 'manual_retry'
  )), {
    sequence: 1,
    agentKind: 'codex',
    phase: 'manual_retry',
    attempt: 1,
    failureCategory: 'cancellation',
    policyAction: 'retry',
    backoffMs: 1,
    recoveryAgentKind: '',
    finalOutcome: 'failed',
    timestamp: ledger.list(group.id)[0].attemptHistory[0].timestamp,
  })
})

test('per-Agent cancel preserves the Task and lets later Agents continue', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  const firstAttempt = deferred()
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'codex') {
      firstAttempt.resolve()
      await new Promise((resolve, reject) => {
        const abort = () => reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED'))
        if (runOptions.signal.aborted) abort()
        else runOptions.signal.addEventListener('abort', abort, { once: true })
      })
    }
    return {
      text: `${agent.kind} agrees\n[[ROUNDRELAY_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Cancel one Agent', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', 'Cancel one Agent without stopping the Task')

  workspace.startAuto({ groupId: group.id, maxRounds: 1 })
  const active = workspace.activeRuns.get(group.id)
  await firstAttempt.promise
  assert.equal(workspace.controlAgent(group.id, active.runId, 'codex', 'cancel'), true)
  await active.promise

  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes'])
  assert.equal(finished[0].status, 'round-limit')
  assert.equal(finished[0].failedKinds.includes('codex'), true)
  assert.equal(ledger.list(group.id)[0].attemptHistory.some(entry => (
    entry.phase === 'manual_retry'
    && entry.policyAction === 'cancel'
    && entry.finalOutcome === 'cancelled'
  )), true)
})

test('per-Agent replace makes the selected Agent take over the interrupted slot', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  const firstAttempt = deferred()
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'codex') {
      firstAttempt.resolve()
      await new Promise((resolve, reject) => {
        const abort = () => reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED'))
        if (runOptions.signal.aborted) abort()
        else runOptions.signal.addEventListener('abort', abort, { once: true })
      })
    }
    return {
      text: `${agent.kind} agrees\n[[ROUNDRELAY_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Replace one Agent',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
  })
  workspace.addMessage(group.id, 'user', 'Replace the interrupted Agent')

  workspace.startAuto({ groupId: group.id, maxRounds: 1 })
  const active = workspace.activeRuns.get(group.id)
  await firstAttempt.promise
  assert.equal(
    workspace.controlAgent(group.id, active.runId, 'codex', 'replace', 'hermes'),
    true,
  )
  await active.promise

  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes', 'workbuddy'])
  assert.match(calls[1].prompt, /replacing Codex/i)
  assert.equal(finished[0].status, 'completed')
  assert.equal(finished[0].failedKinds.includes('codex'), true)
  assert.equal(ledger.list(group.id)[0].attemptHistory.some(entry => (
    entry.phase === 'manual_retry'
    && entry.policyAction === 'replace_agent'
    && entry.recoveryAgentKind === 'hermes'
    && entry.finalOutcome === 'replaced'
  )), true)
})

test('automatic dialogue honors bounded Retry-After backoff and recovers', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const delays = []
  let hermesAttempts = 0
  options.retrySleep = async delayMs => { delays.push(delayMs) }
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'hermes' && ++hermesAttempts < 4) {
      throw Object.assign(new Error('Too many requests'), {
        statusCode: 429,
        retryAfterMs: 10,
      })
    }
    return {
      text: `${agent.kind} agrees\n[[ROUNDRELAY_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Rate limit recovery', agentKinds: ['hermes', 'codex'], workdir: directory,
    allowWrite: false,
  })
  workspace.addMessage(group.id, 'user', 'Recover from a temporary rate limit')

  workspace.startAuto({ groupId: group.id, maxRounds: 1 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), [
    'hermes', 'hermes', 'hermes', 'hermes', 'codex',
  ])
  assert.deepEqual(delays, [4, 4, 4])
  assert.equal(new Set(calls.slice(0, 4).map(call => call.runOptions.operationId)).size, 1)
  assert.equal(finished[0].status, 'completed')
})

test('write-capable unknown outcomes wait for approval before replaying', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  const outputPath = path.join(directory, 'write-attempts.txt')
  let codexAttempts = 0
  options.runLedger = ledger
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'codex') {
      codexAttempts += 1
      fs.appendFileSync(outputPath, `attempt-${codexAttempts}\n`)
      if (codexAttempts === 1) {
        throw Object.assign(new Error('socket reset after write'), { code: 'ECONNRESET' })
      }
    }
    return {
      text: `${agent.kind} agrees\n[[ROUNDRELAY_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Ambiguous write retry',
    agentKinds: ['codex', 'hermes'],
    workdir: directory,
    allowWrite: true,
  })
  workspace.addMessage(group.id, 'user', 'Write exactly once unless I approve a retry')
  const gatePromise = pendingHumanGate(workspace)

  workspace.startAuto({ groupId: group.id, maxRounds: 1 })
  const active = workspace.activeRuns.get(group.id)
  const gate = await gatePromise

  assert.equal(gate.type, 'retry')
  assert.equal(codexAttempts, 1)
  assert.equal(fs.readFileSync(outputPath, 'utf8'), 'attempt-1\n')
  const waiting = ledger.get(gate.runId)
  const ambiguous = waiting.attemptHistory.at(-1)
  assert.deepEqual({
    policyAction: ambiguous.policyAction,
    outcomeCertainty: ambiguous.outcomeCertainty,
    sideEffectsPossible: ambiguous.sideEffectsPossible,
    idempotencyMode: ambiguous.idempotencyMode,
  }, {
    policyAction: 'human_gate',
    outcomeCertainty: 'unknown_outcome',
    sideEffectsPossible: true,
    idempotencyMode: 'none',
  })
  assert.match(ambiguous.operationId, /^agent-operation-[a-f0-9]{64}$/)

  workspace.decideHumanGate(gate.gateId, { optionId: 'retry-once' })
  await active.promise

  assert.equal(codexAttempts, 2)
  assert.equal(calls[0].runOptions.operationId, calls[1].runOptions.operationId)
  assert.equal(fs.readFileSync(outputPath, 'utf8'), 'attempt-1\nattempt-2\n')
})

test('automatic dialogue exhausts bounded transient retries before continuing', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const delays = []
  options.retrySleep = async delayMs => { delays.push(delayMs) }
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'hermes') {
      throw Object.assign(new Error('Provider temporarily unavailable'), { statusCode: 503 })
    }
    return {
      text: `${agent.kind} agrees\n[[ROUNDRELAY_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Transient retry exhaustion', agentKinds: ['hermes', 'codex'], workdir: directory,
    allowWrite: false,
  })
  workspace.addMessage(group.id, 'user', 'Continue after retry exhaustion')

  workspace.startAuto({ groupId: group.id, maxRounds: 1 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), [
    'hermes', 'hermes', 'hermes', 'hermes', 'codex',
  ])
  assert.deepEqual(delays, [1, 2, 4])
  assert.equal(finished[0].status, 'round-limit')
  assert.equal(workspace.snapshot().messages.filter(message => (
    message.agentKind === 'hermes' && message.system?.key === 'system.agentCallFailed'
  )).length, 1)
})

test('automatic dialogue fails HTTP 401 once, retains the Agent, and continues healthy slots', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let hermesAttempts = 0
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'hermes' && ++hermesAttempts < 4) {
      throw agentRuntimeError('LOCAL_AGENT_AUTH_REQUIRED', 'HTTP 401: Invalid token')
    }
    return {
      text: `${agent.kind} agrees\n[[ROUNDRELAY_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '401 retry recovery', agentKinds: ['hermes', 'codex'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', 'Retry transient unauthorized failures')

  workspace.startAuto({ groupId: group.id, maxRounds: 1 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), [
    'hermes', 'codex',
  ])
  assert.deepEqual(workspace.getGroup(group.id).agentKinds, ['hermes', 'codex'])
  assert.equal(workspace.snapshot().messages.some(message => (
    message.system?.key === 'system.agentCallFailed'
  )), true)
  assert.equal(finished[0].status, 'partial')
})

test('direct dialogue reports HTTP 401 once without removing its Agent', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    throw agentRuntimeError('LOCAL_AGENT_AUTH_REQUIRED', 'HTTP 401: Invalid token')
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const direct = workspace.createGroup({
    name: 'Hermes',
    conversationType: 'direct',
    directAgentKind: 'hermes',
    agentKinds: ['hermes'],
    workdir: directory,
  })

  await workspace.sendMessage({ groupId: direct.id, text: 'Retry Hermes safely' })

  assert.equal(calls.length, 1)
  assert.deepEqual(workspace.getGroup(direct.id).agentKinds, ['hermes'])
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'failed')
  assert.deepEqual(finished[0].failedKinds, ['hermes'])
  const failures = workspace.snapshot().messages.filter(message => (
    message.agentKind === 'hermes' && message.system?.key === 'system.agentCallFailed'
  ))
  assert.equal(failures.length, 1)
  assert.equal(failures[0].system.params.reason, 'HTTP 401; authentication failed; Agent retained')
})

test('automatic dialogue does not send an authentication recovery handoff to another Agent', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let hermesAttempts = 0
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'hermes') {
      hermesAttempts += 1
      if (hermesAttempts === 1) await runOptions.onSessionRef('stale-hermes-session')
      if (hermesAttempts <= 4) {
        throw agentRuntimeError('LOCAL_AGENT_AUTH_REQUIRED', 'HTTP 401: Invalid token')
      }
    }
    return {
      text: `${agent.kind} ${prompt.includes('Harness recovery task') ? 'repaired auth' : 'agrees'}\n[[ROUNDRELAY_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '401 Agent handoff', agentKinds: ['hermes', 'codex'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', 'Repair the failing Agent and continue')

  workspace.startAuto({ groupId: group.id, maxRounds: 1 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), [
    'hermes', 'codex',
  ])
  assert.doesNotMatch(calls[1].prompt, /Harness recovery task|Invalid token/)
  assert.deepEqual(workspace.getGroup(group.id).agentKinds, ['hermes', 'codex'])
  assert.equal(finished[0].status, 'partial')
})

test('automatic dialogue keeps a failed authentication slot out of later group context', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let hermesAttempts = 0
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'hermes' && ++hermesAttempts <= 4) {
      throw agentRuntimeError('LOCAL_AGENT_AUTH_REQUIRED', 'HTTP 401: Invalid token')
    }
    const recovery = prompt.includes('Harness recovery task')
    return {
      text: `${agent.kind} ${recovery ? 'repaired auth' : 'agrees'}\n[[ROUNDRELAY_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-task-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Isolated 401 repair', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const root = workspace.addMessage(group.id, 'user', 'Repair auth without polluting the task')

  workspace.startAuto({ groupId: group.id, maxRounds: 1 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), [
    'codex', 'hermes',
  ])
  const normalCodexCall = calls[0]
  assert.equal(normalCodexCall.runOptions.sessionRef, '')
  const codexSessionKey = workspace.sessionKey(group.id, 'codex', root.id)
  assert.equal(workspace.state.sessions[codexSessionKey], 'codex-task-session')
  const agentMessages = workspace.snapshot().messages.filter(message => message.role === 'agent')
  assert.equal(agentMessages.some(message => /repaired auth/.test(message.content)), false)
  assert.equal(agentMessages.filter(message => message.agentKind === 'codex').length, 1)
  const packedContext = workspace.packedPromptContext(group.id, '', root.id)
  const persistedContext = `${packedContext.stableText}\n${packedContext.recentText}`
  assert.doesNotMatch(persistedContext, /Harness recovery task|repaired auth/)
})

test('automatic dialogue persists one failed 401 attempt without removing the Agent', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  options.runLedger = new RunLedger({ storagePath: ledgerPath })
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'hermes') {
      await runOptions.onSessionRef('unusable-hermes-session')
      throw agentRuntimeError('LOCAL_AGENT_AUTH_REQUIRED', 'HTTP 401: Invalid token')
    }
    return {
      text: `${agent.kind} ${prompt.includes('Harness recovery task') ? 'checked auth' : 'agrees'}\n[[ROUNDRELAY_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '401 removal', agentKinds: ['hermes', 'codex', 'workbuddy'], workdir: directory,
  })
  const root = workspace.addMessage(
    group.id, 'user', 'Remove unrecoverable participants and continue',
  )

  workspace.startAuto({ groupId: group.id, maxRounds: 1 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), [
    'hermes', 'codex', 'workbuddy',
  ])
  assert.deepEqual(workspace.getGroup(group.id).agentKinds, ['hermes', 'codex', 'workbuddy'])
  assert.equal(
    workspace.state.sessions[workspace.sessionKey(group.id, 'hermes', root.id)],
    undefined,
  )
  assert.equal(
    workspace.snapshot().agents.find(agent => agent.kind === 'hermes').credentialState,
    'missing',
  )
  const failure = workspace.snapshot().messages.find(message => (
    message.agentKind === 'hermes' && message.system?.key === 'system.agentCallFailed'
  ))
  assert.equal(failure.system.params.reason, 'HTTP 401; authentication failed; Agent retained')
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'partial')
  assert.equal(finished[0].failedKinds.includes('hermes'), true)
  assert.equal(finished[0].completedKinds.includes('hermes'), true)
  const history = new RunLedger({ storagePath: ledgerPath }).list(group.id)[0].attemptHistory
    .filter(entry => entry.agentKind === 'hermes')
  assert.deepEqual(history.map(entry => [
    entry.phase,
    entry.attempt,
    entry.failureCategory,
    entry.policyAction,
    entry.recoveryAgentKind,
    entry.finalOutcome,
  ]), [
    ['initial', 1, 'authentication', 'fail', '', 'failed'],
  ])
  assert.doesNotMatch(
    fs.readFileSync(ledgerPath, 'utf8'),
    /Invalid token|unusable-hermes-session|command|\/Users\//i,
  )
})

test('automatic dialogue treats HTTP 403 as terminal without removing the Agent', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'hermes') {
      throw agentRuntimeError('LOCAL_AGENT_AUTH_REQUIRED', 'HTTP 403: Provider rejected the request')
    }
    return {
      text: `${agent.kind} agrees\n[[ROUNDRELAY_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '403 removal', agentKinds: ['hermes', 'codex'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', 'Handle forbidden credentials')

  workspace.startAuto({ groupId: group.id, maxRounds: 1 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), [
    'hermes', 'codex',
  ])
  assert.deepEqual(workspace.getGroup(group.id).agentKinds, ['hermes', 'codex'])
  assert.equal(
    workspace.snapshot().agents.find(agent => agent.kind === 'hermes').credentialState,
    'missing',
  )
  const failure = workspace.snapshot().messages.find(message => (
    message.agentKind === 'hermes' && message.system?.key === 'system.agentCallFailed'
  ))
  assert.equal(failure.system.params.reason, 'HTTP 403; authentication failed; Agent retained')
})

test('automatic dialogue isolates duplicate failures and retries every Agent next round', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  options.runLedger = new RunLedger({ storagePath: ledgerPath })
  let hermesAttempts = 0
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'hermes' && hermesAttempts++ < 2) {
      throw new Error('LOCAL_AGENT_PROCESS_FAILED')
    }
    const consensus = calls.length >= 7 ? 'agree' : 'continue'
    return {
      text: `${agent.kind} reply\n[[ROUNDRELAY_CONSENSUS:${consensus}]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '失败恢复', agentKinds: ['codex', 'hermes', 'workbuddy'], workdir: directory,
  })
  const root = workspace.addMessage(group.id, 'user', '继续讨论直至共识')

  workspace.startAuto({ groupId: group.id, maxRounds: 3 })
  const runId = workspace.activeRuns.get(group.id).runId
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), [
    'codex', 'hermes', 'workbuddy',
    'codex', 'hermes', 'workbuddy',
    'codex', 'hermes', 'workbuddy',
  ])
  assert.deepEqual(
    workspace.snapshot().messages.filter(message => message.role === 'system')
      .map(message => ({
        agentKind: message.agentKind,
        content: message.content,
        threadRootId: message.threadRootId,
        system: message.system,
      })),
    [{
      agentKind: 'hermes',
      content: 'Hermes failed: LOCAL_AGENT_PROCESS_FAILED',
      threadRootId: root.id,
      system: {
        key: 'system.agentCallFailed',
        params: { agent: 'Hermes', reason: 'LOCAL_AGENT_PROCESS_FAILED' },
      },
    }],
  )
  assert.equal(options.runLedger.get(runId).agentRuns.filter(agentRun => (
    agentRun.kind === 'hermes' && agentRun.status === 'failed'
  )).length, 2)

  const recovered = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath }),
  })
  assert.equal(recovered.snapshot().messages.filter(message => (
    message.agentKind === 'hermes'
      && message.system?.key === 'system.agentCallFailed'
  )).length, 1)

  const repeated = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath }),
  })
  assert.equal(repeated.snapshot().messages.filter(message => (
    message.agentKind === 'hermes'
      && message.system?.key === 'system.agentCallFailed'
  )).length, 1)
  assert.equal(new RunLedger({ storagePath: ledgerPath }).get(runId).agentRuns.filter(agentRun => (
    agentRun.kind === 'hermes' && agentRun.status === 'failed'
  )).length, 2)
})

test('automatic dialogue retains distinct streamed conclusions for the same failure', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  options.runLedger = new RunLedger({ storagePath: ledgerPath })
  let hermesAttempts = 0
  options.runAgent = async (agent, _prompt, _workdir, runOptions) => {
    if (agent.kind === 'hermes') {
      hermesAttempts += 1
      runOptions.onEvent({
        type: 'answer_delta',
        status: 'running',
        delta: `Hermes partial conclusion ${hermesAttempts}`,
      })
      throw new Error('LOCAL_AGENT_PROCESS_FAILED')
    }
    return {
      text: `${agent.kind} continue\n[[ROUNDRELAY_CONSENSUS:continue]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Distinct failure evidence', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', 'Preserve distinct partial conclusions')

  workspace.startAuto({ groupId: group.id, maxRounds: 2 })
  await workspace.activeRuns.get(group.id).promise

  const liveFailures = workspace.snapshot().messages.filter(message => (
    message.agentKind === 'hermes' && message.system?.key === 'system.agentCallFailed'
  ))
  assert.equal(liveFailures.length, 2)
  assert.match(liveFailures[0].content, /Hermes partial conclusion 1/)
  assert.match(liveFailures[1].content, /Hermes partial conclusion 2/)

  const restored = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath }),
  })
  const restoredFailures = restored.snapshot().messages.filter(message => (
    message.agentKind === 'hermes' && message.system?.key === 'system.agentCallFailed'
  ))
  assert.equal(restoredFailures.length, 2)
  assert.deepEqual(restoredFailures.map(message => message.content), liveFailures.map(message => message.content))
})

test('automatic dialogue keeps the round-limit diagnostic when every Agent fails', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    throw new Error('LOCAL_AGENT_PROCESS_FAILED')
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '全员失败', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const root = workspace.addMessage(group.id, 'user', '失败也要保留终止诊断')

  workspace.startAuto({ groupId: group.id, maxRounds: 2 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), [
    'codex', 'hermes', 'codex', 'hermes',
  ])
  const limit = workspace.snapshot().messages.find(message => (
    message.system?.key === 'system.autoRoundLimit'
  ))
  assert.equal(limit.threadRootId, root.id)
  assert.deepEqual(limit.system.params, { rounds: 2 })
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'failed')
})

test('automatic dialogue resumes a session captured before a failed turn', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let kimiAttempts = 0
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'kimi' && kimiAttempts++ === 0) {
      await runOptions.onSessionRef('kimi-created-before-failure')
      throw new Error('LOCAL_AGENT_PROCESS_FAILED')
    }
    return {
      text: `${agent.kind} reply\n[[ROUNDRELAY_CONSENSUS:${calls.length > 2 ? 'agree' : 'continue'}]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '失败后复用会话', agentKinds: ['kimi', 'codex'], workdir: directory,
  })
  const root = workspace.addMessage(group.id, 'user', '失败重试不能创建新会话')

  workspace.startAuto({ groupId: group.id, maxRounds: 2 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), ['kimi', 'codex', 'kimi', 'codex'])
  assert.equal(calls[0].runOptions.sessionRef, '')
  assert.equal(calls[2].runOptions.sessionRef, 'kimi-created-before-failure')
  assert.equal(
    workspace.state.sessions[workspace.sessionKey(group.id, 'kimi', root.id)],
    'kimi-created-before-failure',
  )
})

test('automatic dialogue defaults to six rounds and hides consensus markers at the cap', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return {
      text: `${agent.kind} has not agreed.\n[[ROUNDRELAY_CONSENSUS:continue]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '安全上限', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const root = workspace.addMessage(group.id, 'user', '讨论一个无法快速收敛的问题')

  const started = workspace.startAuto({ groupId: group.id })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(started, { started: true, maxRounds: 6 })
  assert.deepEqual(calls.map(call => call.agent.kind), [
    'codex', 'hermes', 'codex', 'hermes', 'codex', 'hermes',
    'codex', 'hermes', 'codex', 'hermes', 'codex', 'hermes',
  ])
  assert.equal(workspace.snapshot().messages.some(message => (
    message.content.includes('[[ROUNDRELAY_CONSENSUS:')
  )), false)
  const limit = workspace.snapshot().messages.find(message => (
    message.system?.key === 'system.autoRoundLimit'
  ))
  assert.equal(limit.threadRootId, root.id)
  assert.deepEqual(limit.system.params, { rounds: 6 })
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'round-limit')
  assert.equal(finished[0].threadRootId, root.id)
  assert.doesNotMatch(
    fs.readFileSync(options.storagePath, 'utf8'),
    /"status"\s*:\s*"round-limit"|run-finished/,
  )
})

test('automatic dialogue accepts legacy maxTurns as a round limit', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return {
      text: `${agent.kind} continue\n[[ROUNDRELAY_CONSENSUS:continue]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '旧参数', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', '兼容旧参数')

  const started = workspace.startAuto({ groupId: group.id, maxTurns: 2 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(started, { started: true, maxRounds: 2 })
  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes', 'codex', 'hermes'])
})

test('automatic dialogue caps both round parameters at ten', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return {
      text: `${agent.kind} agrees\n[[ROUNDRELAY_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '十轮上限', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', '上限测试')

  const started = workspace.startAuto({ groupId: group.id, maxTurns: 999 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(started, { started: true, maxRounds: 10 })
  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes'])
})

test('automatic dialogue has no total runtime limit', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.autoRunTimeoutMs = 5
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (calls.length === 1) await new Promise(resolve => setTimeout(resolve, 20))
    return {
      text: `${agent.kind} agrees\n[[ROUNDRELAY_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '无整体时限', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const root = workspace.addMessage(group.id, 'user', '只限制单个 Agent 的运行时间')

  workspace.startAuto({ groupId: group.id, maxRounds: 1 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes'])
  assert.equal(workspace.snapshot().messages.some(message => (
    message.system?.key === 'system.autoTimeout'
  )), false)
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'completed')
  assert.equal(finished[0].threadRootId, root.id)
})

test('automatic dialogue keeps its stable diagnostic and emits a failed terminal event', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '异常兜底', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const root = workspace.addMessage(group.id, 'user', '内部异常不能形成未处理拒绝')
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  const emitChanged = workspace.emitChanged.bind(workspace)
  let emitCount = 0
  workspace.emitChanged = () => {
    emitCount += 1
    if (emitCount === 4) throw new Error(`/private/workspace/${group.id}`)
    emitChanged()
  }

  workspace.startAuto({ groupId: group.id, maxRounds: 2 })
  await workspace.activeRuns.get(group.id).promise

  const stopped = workspace.snapshot().messages.find(message => (
    message.system?.key === 'system.autoStopped'
  ))
  assert.equal(stopped.threadRootId, root.id)
  assert.equal(stopped.content, 'Automatic discussion stopped: LOCAL_AGENT_UNKNOWN_FAILURE')
  assert.deepEqual(stopped.system.params, { reason: 'LOCAL_AGENT_UNKNOWN_FAILURE' })
  assert.deepEqual(workspace.snapshot().runningGroupIds, [])
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'failed')
  assert.equal(finished[0].threadRootId, root.id)
})

test('automatic dialogue requires a topic root and accepts an explicit one', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => ({
    text: `${agent.kind} agrees.\n[[ROUNDRELAY_CONSENSUS:agree]]`,
    sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
  })
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '话题要求', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  assert.throws(
    () => workspace.startAuto({ groupId: group.id, maxRounds: 1 }),
    { message: 'LOCAL_AUTO_THREAD_REQUIRED' },
  )

  workspace.startAuto({ groupId: group.id, maxRounds: 1, threadRootId: 'topic-root' })
  await workspace.activeRuns.get(group.id).promise
  assert.deepEqual(
    workspace.snapshot().messages.filter(message => message.role === 'agent')
      .map(message => message.threadRootId),
    ['topic-root', 'topic-root'],
  )
})
