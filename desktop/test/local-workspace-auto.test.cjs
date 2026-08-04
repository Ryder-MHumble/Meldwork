const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { LocalWorkspace } = require('../src/local-workspace.cjs')
const { RunLedger } = require('../src/run-ledger.cjs')
const { deferred, fixture } = require('./local-workspace-test-helpers.cjs')
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
  assert.deepEqual(calls[1].runOptions.skills, ['research'])
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

test('auto send rejects failed preflight without persisting a root or starting an Agent', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.validateSkillSelections = () => { throw new Error('LOCAL_SKILL_SELECTION_INVALID') }
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
  assert.deepEqual(kimiCalls.map(call => call.runOptions.sessionRef), ['', 'kimi-acp-session'])
  assert.deepEqual(kimiCalls.map(call => call.runOptions.sessionTransport), ['', 'acp'])
  assert.equal(workspace.state.sessions[workspace.sessionKey(group.id, 'kimi')], 'kimi-acp-session')
  assert.equal(workspace.state.sessionMeta[workspace.sessionKey(group.id, 'kimi')].transport, 'acp')
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
  assert.deepEqual(hermesCalls.map(call => call.runOptions.sessionRef), ['', 'hermes-legacy-session'])
  assert.deepEqual(hermesCalls.map(call => call.runOptions.sessionTransport), ['', 'legacy'])
  assert.deepEqual(hermesCalls.map(call => call.runOptions.hermesAcpAvailable), [false, false])
  assert.equal(workspace.state.sessions[workspace.sessionKey(group.id, 'hermes')], 'hermes-legacy-session')
  assert.equal(workspace.state.sessionMeta[workspace.sessionKey(group.id, 'hermes')].transport, 'legacy')
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

test('automatic dialogue carries root images until delivery and preloads Hermes root skills', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
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
  const attachment = {
    id: 'attachment-auto', name: 'architecture.png', mimeType: 'image/png', size: 128,
  }
  const skill = {
    targetKind: 'hermes', namespace: 'global', slug: 'research', name: 'Research',
  }
  workspace.addMessage(group.id, 'user', '审查这张架构图', '', '', null, {
    attachments: [attachment], skillHints: [skill],
  })

  workspace.startAuto({ groupId: group.id, maxRounds: 2 })
  await workspace.activeRuns.get(group.id).promise

  const attachmentPath = path.join(directory, 'attachments', 'attachment-auto.png')
  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes', 'codex', 'hermes'])
  assert.deepEqual(calls.map(call => call.runOptions.attachments), [
    [attachmentPath], [attachmentPath], [], [attachmentPath],
  ])
  assert.deepEqual(calls.filter(call => call.agent.kind === 'hermes')
    .map(call => call.runOptions.skills), [['research'], ['research']])
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

test('stopping during a 401 retry cancels recovery without removing the Agent', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const retryStarted = deferred()
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind !== 'hermes') {
      return {
        text: 'codex agrees\n[[ROUNDRELAY_CONSENSUS:agree]]',
        sessionRef: runOptions.sessionRef || 'codex-session',
      }
    }
    if (calls.length === 1) throw new Error('HTTP 401: Invalid token')
    retryStarted.resolve()
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
    name: '401 retry stop', agentKinds: ['hermes', 'codex'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', 'Stop cleanly during auth recovery')

  workspace.startAuto({ groupId: group.id, unlimitedRounds: true })
  const active = workspace.activeRuns.get(group.id)
  await retryStarted.promise
  assert.equal(workspace.stop(group.id, active.runId), true)
  await active.promise

  assert.deepEqual(calls.map(call => call.agent.kind), ['hermes', 'hermes'])
  assert.deepEqual(workspace.getGroup(group.id).agentKinds, ['hermes', 'codex'])
  assert.equal(calls.some(call => call.prompt.includes('Harness recovery task')), false)
  assert.equal(workspace.snapshot().messages.some(message => (
    message.system?.key === 'system.autoTimeout'
  )), false)
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'stopped')
})

test('automatic dialogue retries an HTTP 401 three times before continuing', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let hermesAttempts = 0
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'hermes' && ++hermesAttempts < 4) {
      throw new Error('HTTP 401: Invalid token')
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
    'hermes', 'hermes', 'hermes', 'hermes', 'codex',
  ])
  assert.deepEqual(workspace.getGroup(group.id).agentKinds, ['hermes', 'codex'])
  assert.equal(workspace.snapshot().messages.some(message => (
    message.system?.key === 'system.agentCallFailed'
  )), false)
  assert.equal(finished[0].status, 'completed')
})

test('automatic dialogue hands exhausted 401 recovery to the next Agent', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let hermesAttempts = 0
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'hermes') {
      hermesAttempts += 1
      if (hermesAttempts === 1) await runOptions.onSessionRef('stale-hermes-session')
      if (hermesAttempts <= 4) throw new Error('HTTP 401: Invalid token')
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
    'hermes', 'hermes', 'hermes', 'hermes', 'codex', 'hermes', 'codex',
  ])
  const recoveryCall = calls[4]
  assert.match(recoveryCall.prompt, /Harness recovery task/)
  assert.match(recoveryCall.prompt, /Hermes returned HTTP 401 Unauthorized/)
  assert.doesNotMatch(recoveryCall.prompt, /Invalid token/)
  assert.equal(calls[5].runOptions.sessionRef, '')
  assert.deepEqual(workspace.getGroup(group.id).agentKinds, ['hermes', 'codex'])
  assert.equal(finished[0].status, 'completed')
})

test('automatic dialogue removes an Agent after post-repair 401 verification fails', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'hermes') {
      await runOptions.onSessionRef('unusable-hermes-session')
      throw new Error('HTTP 401: Invalid token')
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
  workspace.addMessage(group.id, 'user', 'Remove unrecoverable participants and continue')

  workspace.startAuto({ groupId: group.id, maxRounds: 1 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), [
    'hermes', 'hermes', 'hermes', 'hermes',
    'codex',
    'hermes', 'hermes', 'hermes',
    'codex', 'workbuddy',
  ])
  assert.deepEqual(workspace.getGroup(group.id).agentKinds, ['codex', 'workbuddy'])
  assert.equal(workspace.state.sessions[workspace.sessionKey(group.id, 'hermes')], undefined)
  assert.equal(
    workspace.snapshot().agents.find(agent => agent.kind === 'hermes').credentialState,
    'missing',
  )
  const failure = workspace.snapshot().messages.find(message => (
    message.agentKind === 'hermes' && message.system?.key === 'system.agentCallFailed'
  ))
  assert.equal(failure.system.params.reason, 'HTTP 401; removed after recovery failed')
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'partial')
  assert.equal(finished[0].failedKinds.includes('hermes'), true)
  assert.equal(finished[0].completedKinds.includes('hermes'), true)
})

test('automatic dialogue treats HTTP 403 as authoritative and removes the Agent after recovery', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'hermes') {
      throw Object.assign(new Error('Provider rejected the request'), { statusCode: 403 })
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
    'hermes', 'hermes', 'hermes', 'hermes',
    'codex',
    'hermes', 'hermes', 'hermes',
  ])
  assert.match(calls[4].prompt, /Hermes returned HTTP 403 Forbidden/)
  assert.deepEqual(workspace.getGroup(group.id).agentKinds, ['codex'])
  assert.equal(
    workspace.snapshot().agents.find(agent => agent.kind === 'hermes').credentialState,
    'missing',
  )
  const failure = workspace.snapshot().messages.find(message => (
    message.agentKind === 'hermes' && message.system?.key === 'system.agentCallFailed'
  ))
  assert.equal(failure.system.params.reason, 'HTTP 403; removed after recovery failed')
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
    if (emitCount === 3) throw new Error(`/private/workspace/${group.id}`)
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
