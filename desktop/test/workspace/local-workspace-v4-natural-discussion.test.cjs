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

function decisionReply(text, status = 'completed', extra = {}) {
  return `${text}\n\n[[MELDWORK_COLLABORATION:${JSON.stringify({
    summary: 'Task progress judged by the delivery owner.',
    taskDecision: {
      status, reason: text,
      deliverables: status === 'completed' ? ['The requested answer in this response.'] : [],
      ...extra,
    },
  })}]]`
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

test('Natural V4 bounds oversized peer context while persisting full answers and the original task', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  const longAnswer = `OPENING_FINDING\n${'x'.repeat(100000)}\nCLOSING_EVIDENCE`
  let discussionPrompt = ''
  const workspace = new LocalWorkspace({
    ...options, runLedger: ledger, naturalAgentResponses: true,
    runAgent: async (_agent, prompt) => {
      if (naturalPhase(prompt) === 'proposal') {
        return { outcome: 'completed', text: longAnswer, sessionRef: 'natural-long-session' }
      }
      discussionPrompt = prompt
      return { outcome: 'completed', text: decisionReply('The task remains blocked on missing evidence.', 'blocked') }
    },
  })
  await workspace.refreshAgents()
  const group = workspace.createGroup({ name: 'Bounded transcript', agentKinds: ['codex'], workdir: directory, allowWrite: false })
  const controller = await runDiscussion(workspace, group, { discussionStyle: 'agent-led', maxRounds: 3 })
  assert.match(discussionPrompt, /Discuss the implementation direction\./u)
  assert.match(discussionPrompt, /OPENING_FINDING/u)
  assert.match(discussionPrompt, /CLOSING_EVIDENCE/u)
  assert.match(discussionPrompt, /This transcript is partial/u)
  assert.ok(discussionPrompt.length < 60000)
  const proposal = workspace.snapshot().messages.find(message => message.trace?.phase === 'proposal')
  assert.equal(workspace.autoRunner.v4NaturalMessageContent(proposal).text, longAnswer)
  assert.equal(ledger.get(controller.runId).status, 'partial')
  const reopened = new LocalWorkspace({ ...options, naturalAgentResponses: true })
  const restored = reopened.snapshot().messages.find(message => message.id === proposal.id)
  assert.equal(reopened.autoRunner.v4NaturalMessageContent(restored).text, longAnswer)
})

test('Natural routing retains a request beyond the stored message excerpt', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const turns = []
  const workspace = new LocalWorkspace({
    ...options, naturalAgentResponses: true,
    runAgent: async (agent, prompt) => {
      if (naturalPhase(prompt) === 'proposal') return { outcome: 'completed', text: 'Initial contribution.' }
      turns.push(agent.kind)
      return { outcome: 'completed', text: turns.length === 1
        ? `${'x'.repeat(21000)}\n@hermes Please verify the missing evidence.`
        : turns.length === 2 ? 'The evidence is unavailable.'
          : decisionReply('Required evidence is unavailable.', 'blocked') }
    },
  })
  await workspace.refreshAgents()
  const group = workspace.createGroup({ name: 'Long route', agentKinds: ['codex', 'hermes'], workdir: directory, allowWrite: false })
  await runDiscussion(workspace, group, { discussionStyle: 'agent-led', maxRounds: 4 })
  assert.deepEqual(turns, ['codex', 'hermes', 'codex'])
})

for (const status of ['completed', 'blocked', 'needs-human']) {
  test(`Natural single-Agent task persists the owner's ${status} judgment`, async (t) => {
    const { directory, options } = fixture()
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
    const calls = []
    const workspace = new LocalWorkspace({
      ...options, runLedger: ledger, naturalAgentResponses: true,
      runAgent: async (agent, prompt) => {
        calls.push(`${naturalPhase(prompt)}:${agent.kind}`)
        return { outcome: 'completed', sessionRef: `${agent.kind}-task-session`, text: naturalPhase(prompt) === 'proposal'
          ? 'Initial answer.' : decisionReply('Owner judgment with supporting output.', status) }
      },
    })
    await workspace.refreshAgents()
    const group = workspace.createGroup({ name: 'Single owner', agentKinds: ['codex'], workdir: directory, allowWrite: false })
    await runDiscussion(workspace, group, { discussionStyle: 'agent-led', maxRounds: 4 })
    const record = ledger.list(group.id)[0]
    assert.equal(record.status, status === 'completed' ? 'completed' : 'partial')
    assert.deepEqual(calls, ['proposal:codex', 'discussion:codex'])
    assert.equal(record.agentRuns.at(-1).context.taskDecision.status, status)
    const restarted = new RunLedger({ storagePath: ledger.storagePath })
    assert.equal(restarted.get(record.runId).agentRuns.at(-1).context.taskDecision.status, status)
  })
}

for (const handoffTo of [undefined, 'hermes', 'ghost']) {
  test(`Natural task continuation validates owner handoff ${handoffTo || 'to self'}`, async (t) => {
    const { directory, options } = fixture()
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
    const turns = []
    const workspace = new LocalWorkspace({
      ...options, runLedger: ledger, naturalAgentResponses: true,
      runAgent: async (agent, prompt) => {
        if (naturalPhase(prompt) === 'proposal') return { outcome: 'completed', text: 'Initial answer.', sessionRef: `${agent.kind}-task-session` }
        turns.push(agent.kind)
        return { outcome: 'completed', sessionRef: `${agent.kind}-task-session`, text: turns.length === 1
          ? decisionReply('More work remains.', 'continue', handoffTo ? { handoffTo } : {})
          : decisionReply('The requested work is complete.') }
      },
    })
    await workspace.refreshAgents()
    const group = workspace.createGroup({ name: 'Owner continuation', agentKinds: ['codex', 'hermes'], workdir: directory, allowWrite: false })
    await runDiscussion(workspace, group, { discussionStyle: 'agent-led', maxRounds: 5 })
    const record = ledger.list(group.id)[0]
    assert.equal(record.status, handoffTo === 'ghost' ? 'partial' : 'completed', record.reason)
    assert.deepEqual(turns, handoffTo === 'ghost' ? ['codex'] : ['codex', handoffTo || 'codex'])
  })
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
  assert.equal(record.status, 'round-limit', record.reason)
  assert.equal(record.orchestration.discussionStyle, 'sequential')
  assert.equal(workspace.snapshot().messages.filter(message => (
    message.threadRootId === controller.threadRootId
      && message.system?.key === 'system.autoRoundLimit'
  )).length, 1)
})

for (const discussionStyle of ['sequential', 'agent-led']) {
  test(`Natural ${discussionStyle} V4 reports a one-round budget stop without claiming delivery`, async (t) => {
    const { directory, options } = fixture()
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
    options.runLedger = ledger
    options.naturalAgentResponses = true
    const calls = []
    options.runAgent = async (agent) => {
      calls.push(agent.kind)
      return { text: 'The requested deliverable is still missing. More work is needed.' }
    }
    const workspace = new LocalWorkspace(options)
    await workspace.refreshAgents()
    const group = workspace.createGroup({
      name: 'Unfinished delivery', agentKinds: ['codex', 'hermes'],
      workdir: directory, allowWrite: false,
    })
    const controller = await runDiscussion(workspace, group, { discussionStyle, maxRounds: 1 })
    const record = ledger.get(controller.runId)
    assert.equal(record.status, 'round-limit', record.reason)
    assert.deepEqual([...calls].sort(), ['codex', 'hermes'])
    assert.equal(workspace.snapshot().messages.filter(message => (
      message.threadRootId === controller.threadRootId
        && message.system?.key === 'system.autoRoundLimit'
    )).length, 1)
  })
}

test('Natural Agent-led V4 uses the full first-round transcript and inline mentions', async (t) => {
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
    if (agent.kind === 'codex' && calls.filter(call => call.kind === 'codex' && call.phase === 'discussion').length === 1) {
      return {
        text: '@hermes please validate the proposal; @workbuddy check the implementation risks.\n\nBoth findings will inform our decision.',
        sessionRef: runOptions.sessionRef,
      }
    }
    return {
      text: decisionReply(`${agent.kind} agrees with the current direction.`),
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
    'discussion:codex',
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
    /current collaboration phase|your role|arbiter|Receipt JSON shape/iu,
  )

  const messages = workspace.snapshot().messages.filter(message => (
    message.role === 'agent' && message.threadRootId === controller.threadRootId
  ))
  assert.deepEqual(messages.map(message => `${message.trace.round}:${message.agentKind}`), [
    '1:codex', '1:hermes', '1:workbuddy',
    '2:codex',
    '3:hermes', '3:workbuddy',
    '4:codex',
  ])
  assert.equal(ledger.get(controller.runId).status, 'completed')
})

test('Natural Agent-led routing reads inline canonical mentions but excludes quoted examples', () => {
  const { directory, options } = fixture()
  const workspace = new LocalWorkspace(options)
  try {
    const activeKinds = ['codex', 'hermes', 'workbuddy']
    assert.deepEqual(workspace.autoRunner.v4MentionedNextKinds(
      'Body mentions @hermes and quotes `@workbuddy`.\n\n@codex',
      activeKinds,
    ), ['codex', 'hermes'])
    assert.deepEqual(workspace.autoRunner.v4MentionedNextKinds(
      'Body mention only: @hermes\n\nDiscussion complete.',
      activeKinds,
    ), ['hermes'])
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
    ), ['hermes'])
    assert.deepEqual(workspace.autoRunner.v4MentionedNextKinds(
      'Continue.\n\n@HERMES',
      activeKinds,
    ), ['hermes'])
    assert.equal(workspace.autoRunner.v4NaturalRouteDecision(
      'Continue.\n\n@hermes @ghost',
      activeKinds,
    ).status, 'invalid')
    assert.deepEqual(workspace.autoRunner.v4MentionedNextKinds(
      'Continue.\n\n@hermes check the result; @ghost is unavailable.',
      activeKinds,
    ), ['hermes'])
    assert.deepEqual(workspace.autoRunner.v4MentionedNextKinds(
      'Continue.\n\n@hermes，@workbuddy；@hermes',
      activeKinds,
    ), ['hermes', 'workbuddy'])
    assert.deepEqual(workspace.autoRunner.v4MentionedNextKinds(
      '> Historical request: @codex\n\n```text\n@workbuddy\n```\n\nPlease review this, @hermes.',
      activeKinds,
    ), ['hermes'])
    assert.deepEqual(workspace.autoRunner.v4MentionedNextKinds(
      'Contact me@hermes.example; install @codex/package; escape \\@workbuddy; quote `@codex`; [@codex](https://example.test).',
      activeKinds,
    ), [])
    assert.equal(workspace.autoRunner.v4NaturalRouteDecision(
      'Please review @所有人', activeKinds,
    ).status, 'invalid')
    workspace.autoRunner.agentLabel = kind => ({
      codex: 'Codex CLI', hermes: 'Custom Reviewer', workbuddy: 'Pi Agent',
    })[kind]
    assert.deepEqual(workspace.autoRunner.v4MentionedNextKinds(
      '@Custom Reviewer check this; @Pi Agent reproduce the problem; @Codex finalize it.',
      activeKinds,
    ), activeKinds)
    assert.deepEqual(workspace.autoRunner.v4MentionedNextKinds('@Pi check this.', activeKinds), ['workbuddy'])
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('Natural Agent-led V4 preserves chosen peers without forced participation and supplies recent context', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.naturalAgentResponses = true
  const calls = []
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const phase = naturalPhase(prompt)
    calls.push({ kind: agent.kind, phase, prompt })
    return {
      text: phase === 'proposal' ? `${agent.kind} proposes an independent approach.`
        : agent.kind === 'codex' ? '@hermes please validate the remaining issue.\nCodex evidence.'
          : agent.kind === 'hermes' ? '@codex please check this finding.\nHermes evidence.'
            : 'WorkBuddy finds an additional implementation constraint.',
      sessionRef: runOptions.sessionRef || `${agent.kind}-task-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Agent-selected routing', agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory, allowWrite: false,
  })
  await runDiscussion(workspace, group, { discussionStyle: 'agent-led', maxRounds: 5 })
  assert.equal(calls.some(call => call.kind === 'workbuddy' && call.phase === 'discussion'), false)
  const peer = calls.at(-1)
  assert.equal(peer.kind, 'hermes')
  const firstPeerTurn = calls.find(call => call.kind === 'hermes' && call.phase === 'discussion')
  assert.match(firstPeerTurn.prompt, /Round 2 - @codex/)
  assert.match(firstPeerTurn.prompt, /workbuddy proposes an independent approach/)
  assert.doesNotMatch(peer.prompt, /Round 2 - @codex/)
  assert.match(peer.prompt, /Previously delivered turns are not repeated/)
  assert.match(peer.prompt, /Round 3 - @hermes/)
  assert.match(peer.prompt, /Round 4 - @codex/)
  assert.match(peer.prompt, /beside its concrete question/)
  assert.doesNotMatch(peer.prompt, /final non-empty line/)
})

test('Natural Agent-led V4 keeps a peer request when another concurrent peer accepts', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.naturalAgentResponses = true
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  const calls = []
  let codexTurns = 0
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const phase = naturalPhase(prompt)
    calls.push(`${phase}:${agent.kind}`)
    if (phase === 'discussion' && agent.kind === 'codex') codexTurns += 1
    return {
      text: phase === 'proposal' ? `${agent.kind} proposal.`
        : agent.kind === 'codex' && codexTurns === 1 ? '@hermes assess feasibility; @workbuddy validate risks.'
          : agent.kind === 'workbuddy' ? '@codex address this remaining risk before proceeding.'
            : decisionReply('I accept the current result without changes.'),
      sessionRef: runOptions.sessionRef || `${agent.kind}-task-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Pending peer request', agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory, allowWrite: false,
  })
  const controller = await runDiscussion(workspace, group, {
    discussionStyle: 'agent-led', maxRounds: 5,
  })
  assert.deepEqual(calls, [
    'proposal:codex', 'proposal:hermes', 'proposal:workbuddy',
    'discussion:codex', 'discussion:hermes', 'discussion:workbuddy', 'discussion:codex',
  ])
  assert.equal(ledger.get(controller.runId).status, 'completed')
})

test('Natural Agent-led V4 terminates repeated handoffs even with unlimited rounds', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.naturalAgentResponses = true
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  let calls = 0
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    calls += 1
    assert.ok(calls < 20, 'An unchanged reciprocal handoff must stop')
    return {
      text: naturalPhase(prompt) === 'proposal' ? `${agent.kind} initial proposal.`
        : `Please review the same unresolved question, @${agent.kind === 'codex' ? 'hermes' : 'codex'}.`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-task-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Repeated handoff stop', agentKinds: ['codex', 'hermes'],
    workdir: directory, allowWrite: false,
  })
  const controller = await runDiscussion(workspace, group, {
    discussionStyle: 'agent-led', unlimitedRounds: true,
  })
  assert.equal(ledger.get(controller.runId).status, 'partial')
  assert.equal(workspace.snapshot().messages.some(message => (
    message.threadRootId === controller.threadRootId
      && message.system?.key === 'system.autoDiscussionStalled'
  )), true)
  assert.ok(calls < 20)
})

test('Natural Agent-led repetition detection reads a bounded history window and preceding replies', () => {
  const { directory, options } = fixture()
  const workspace = new LocalWorkspace(options)
  try {
    let contentReads = 0
    const messages = Array.from({ length: 1000 }, (_, index) => ({
      groupId: 'group', threadRootId: 'thread', role: 'agent',
      agentKind: index % 2 ? 'hermes' : 'codex',
      trace: { phase: 'discussion', runId: 'run', round: index + 1 },
      get content() {
        contentReads += 1
        assert.ok(index >= 994, 'Old rounds should not be reprocessed once each baseline is found')
        return 'The same unresolved contribution.'
      },
    }))
    workspace.autoRunner.state = () => ({ messages })
    workspace.autoRunner.v4NaturalMessageMatchesBinding = () => true
    assert.equal(workspace.autoRunner.v4NaturalDiscussionIsRepeating(
      { id: 'group' }, { runId: 'run' }, 'thread', 1000, ['codex', 'hermes'],
    ), true)
    assert.equal(contentReads, 6)
    messages[999] = { ...messages[999], content: 'New evidence changes the decision.' }
    assert.equal(workspace.autoRunner.v4NaturalDiscussionIsRepeating(
      { id: 'group' }, { runId: 'run' }, 'thread', 1000, ['codex', 'hermes'],
    ), false)
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
        ? initialCalls.filter(call => call.kind === 'codex' && call.phase === 'discussion').length === 1
          ? 'Hermes and WorkBuddy should validate this together.\n\n@hermes @workbuddy'
          : decisionReply('The requested validation is complete.')
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
    'discussion:codex',
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
        text: decisionReply(`${agent.kind} completes the routed validation.`),
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
  assert.deepEqual(recoveryCalls.map(call => `${call.phase}:${call.kind}`), ['discussion:codex'])
  assert.equal(maxRecoveryRunning, 1)
  const messages = recovered.snapshot().messages.filter(message => (
    message.role === 'agent' && message.threadRootId === crashRecord.threadRootId
  ))
  assert.deepEqual(messages.map(message => `${message.trace.round}:${message.agentKind}`), [
    '1:codex', '1:hermes', '1:workbuddy',
    '2:codex',
    '3:hermes', '3:workbuddy',
    '4:codex',
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
      text: decisionReply(`${phase}-${agent.kind}-${initialCalls.length}`, 'continue'),
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
        text: decisionReply(`recovered-${agent.kind}`, 'continue'),
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
  assert.equal(recoveredRecord.status, 'round-limit', recoveredRecord.reason)
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
      text: decisionReply(`${agent.kind} continues before restart.`, 'continue'),
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
    runAgent: async (agent, prompt, _workdir, runOptions) => {
      recoveryCalls.push({ kind: agent.kind, sessionRef: runOptions.sessionRef, prompt })
      return {
        text: decisionReply(`${agent.kind} continues after restart.`, 'continue'),
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
  assert.equal(recoveredRecord.status, 'round-limit', recoveredRecord.reason)
  assert.deepEqual(recoveryCalls.map(call => call.kind), ['hermes', 'codex', 'hermes'])
  assert.deepEqual(recoveryCalls.map(call => call.sessionRef), [
    'hermes-task-session', 'codex-task-session', 'hermes-task-session',
  ])
  assert.doesNotMatch(recoveryCalls[0].prompt, /Round 1 - @codex/)
  assert.match(recoveryCalls[0].prompt, /Round 1 - @hermes/)
  assert.match(recoveryCalls[0].prompt, /Round 2 - @codex/)
  assert.doesNotMatch(recoveryCalls[1].prompt, /Round 1 - @codex|Round 1 - @hermes/)
  assert.match(recoveryCalls[1].prompt, /Round 2 - @hermes/)
  assert.doesNotMatch(recoveryCalls[2].prompt, /Round 1 - @codex|Round 2 - @codex/)
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
      text: decisionReply(`${agent.kind} continues the same task.`, 'continue'),
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

test('Natural Agent-led V4 does not fabricate completion or force a peer review after silence', async (t) => {
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
    'discussion:codex',
  ])
  assert.equal(maxProposalRunning, 2)
  assert.equal(maxRoutedRunning, 1)
  assert.match(
    calls.find(call => call.phase === 'discussion').prompt,
    /Silence from peers is not evidence of completion/u,
  )
  const messages = workspace.snapshot().messages.filter(message => (
    message.role === 'agent' && message.threadRootId === controller.threadRootId
  ))
  assert.deepEqual(messages.map(message => `${message.trace.round}:${message.agentKind}`), [
    '1:codex', '1:hermes', '2:codex',
  ])
  assert.equal(ledger.get(controller.runId).status, 'partial')
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
        ? calls.filter(call => call === 'discussion:codex').length === 1
          ? 'Hermes should review the current result.\n\n@hermes'
          : decisionReply('The deliverable incorporates the completed peer review.')
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
    'discussion:codex',
  ])
  assert.equal(maxRoutedRunning, 1)
  const messages = workspace.snapshot().messages.filter(message => (
    message.role === 'agent' && message.threadRootId === controller.threadRootId
  ))
  assert.deepEqual(messages.map(message => `${message.trace.round}:${message.agentKind}`), [
    '1:codex', '1:hermes', '2:codex', '3:hermes', '4:codex',
  ])
})

test('Natural Agent-led V4 does not accept a self-only route without a task decision', async (t) => {
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
    'discussion:codex',
  ])
  const messages = workspace.snapshot().messages.filter(message => (
    message.role === 'agent' && message.threadRootId === controller.threadRootId
  ))
  assert.deepEqual(messages.map(message => `${message.trace.round}:${message.agentKind}`), [
    '1:codex', '1:hermes', '2:codex',
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
    'discussion:codex',
  ])
  const messages = workspace.snapshot().messages.filter(message => (
    message.role === 'agent' && message.threadRootId === controller.threadRootId
  ))
  assert.deepEqual(messages.map(message => `${message.trace.round}:${message.agentKind}`), [
    '1:codex', '1:hermes', '1:workbuddy',
    '2:codex', '3:hermes', '3:workbuddy',
    '4:codex',
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
    'discussion:codex',
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
  assert.equal(recoveredRecord.status, 'round-limit', recoveredRecord.reason)
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

test('Natural Agent-led V4 recovers the bound owner decision after a stale message without another call', async (t) => {
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
    text: naturalPhase(prompt) === 'discussion'
      ? decisionReply(`${agent.kind} accepts the current result without changes.`)
      : `${agent.kind} proposes an answer.`,
    sessionRef: runOptions.sessionRef || `${agent.kind}-task-session`,
  })

  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Natural owner decision recovery',
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
    text: 'Recover the owner completion decision.',
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
  assert.deepEqual(recoveryCalls, [])
  const messages = recovered.snapshot().messages.filter(message => (
    message.role === 'agent' && message.threadRootId === crashRecord.threadRootId
  ))
  assert.deepEqual(messages.map(message => `${message.trace.round}:${message.agentKind}`), [
    '1:codex', '1:hermes', '2:codex',
  ])
  const coordinatorMessage = messages.find(message => (
    message.trace.round === 2 && message.agentKind === 'codex'
  ))
  assert.equal(coordinatorMessage.trace.agentRunId, originalCoordinatorRun.agentRunId)
  assertTurnParity(recoveredRecord, messages)
})
