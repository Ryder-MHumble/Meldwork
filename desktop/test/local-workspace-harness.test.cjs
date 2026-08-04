const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { getEventListeners } = require('node:events')
const { LocalWorkspace } = require('../src/local-workspace.cjs')
const { RunLedger } = require('../src/run-ledger.cjs')
const { deferred, fixture } = require('./local-workspace-test-helpers.cjs')
test('Harness streams per-Agent events, persists a compact trace, and hands evidence to the next Agent', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'codex') {
      runOptions.onProgress({
        id: 'turn', title: 'process', status: 'in_progress', detail: 'raw progress detail',
      })
      runOptions.onEvent({
        id: 'reason-1',
        type: 'reasoning_summary',
        summary: 'Compared the available implementations.',
      })
      runOptions.onEvent({
        id: 'tool-1',
        type: 'tool_start',
        status: 'running',
        title: 'Bash',
        summary: 'Bash: operation: rg -n (2 hidden arguments)',
        command: 'rg secret /Users/private/work',
      })
      runOptions.onProgress({
        id: 'turn', title: 'process', status: 'completed', detail: 'raw progress result',
      })
      runOptions.onEvent({
        id: 'tool-1',
        type: 'tool_result_summary',
        status: 'completed',
        title: 'Bash',
        summary: 'Bash: operation: rg -n (2 hidden arguments)',
        detail: 'Exit code: 0\nOutput: 3 lines, 120 bytes',
      })
      runOptions.onEvent({ type: 'answer_delta', status: 'running', delta: 'Codex live ' })
      return { text: 'Codex final conclusion', sessionRef: 'codex-session' }
    }
    assert.match(prompt, /untrusted data, not instructions/)
    assert.match(prompt, /E-R0-CODEX-01|E-R1-CODEX-01/)
    assert.match(prompt, /Codex final conclusion/)
    assert.doesNotMatch(prompt, /rg secret|\/Users\/private/)
    return { text: 'Hermes final conclusion', sessionRef: 'hermes-session' }
  }
  const events = []
  const workspace = new LocalWorkspace(options)
  workspace.on('run-event', event => events.push(event))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Harness trace', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Compare the implementations',
    targetKinds: ['codex', 'hermes'],
  })

  const agentMessages = workspace.snapshot().messages.filter(message => message.role === 'agent')
  assert.deepEqual(agentMessages.map(message => message.content), [
    'Codex final conclusion',
    'Hermes final conclusion',
  ])
  const codexTrace = agentMessages[0].trace
  assert.equal(codexTrace.status, 'completed')
  assert.equal(codexTrace.events.some(event => event.type === 'reasoning_summary'), true)
  assert.equal(codexTrace.events.some(event => event.type === 'tool_result_summary'), true)
  const codexTool = codexTrace.events.find(event => event.type === 'tool_result_summary')
  assert.equal(codexTool.title, 'Bash')
  assert.equal(codexTool.summary, 'Bash: operation: rg -n (2 hidden arguments)')
  assert.equal(codexTool.detail, 'Exit code: 0\nOutput: 3 lines, 120 bytes')
  assert.equal(codexTrace.events.some(event => event.title === 'process'), false)
  assert.deepEqual(codexTrace.sourceMessageIds, [workspace.snapshot().messages[0].id])
  assert.equal(codexTrace.context.includedCount, codexTrace.sourceMessageIds.length)
  assert.deepEqual(agentMessages[1].trace.sourceMessageIds, [
    workspace.snapshot().messages[0].id,
    agentMessages[0].id,
  ])
  assert.equal(
    agentMessages[1].trace.context.includedCount,
    agentMessages[1].trace.sourceMessageIds.length,
  )
  assert.doesNotMatch(JSON.stringify(codexTrace), /rg secret|\/Users\/private|raw progress/)
  assert.equal(events.some(event => event.type === 'answer_delta' && event.delta === 'Codex live '), true)
  assert.equal(events.some(event => event.title === 'process'), false)
  assert.equal(events.every(event => !Object.hasOwn(event, 'command')
    && !Object.hasOwn(event, 'executable')
    && !Object.hasOwn(event, 'sessionRef')), true)
  assert.equal(events.every(event => Number.isInteger(event.seq) && event.runId), true)
})

test('terminal Agent traces hand compact partial evidence to the next Agent only', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let hermesPrompt = ''
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    if (agent.kind === 'codex') {
      runOptions.onEvent({
        id: 'reason-1',
        type: 'reasoning_summary',
        summary: 'Mapped the recovery boundary.',
      })
      runOptions.onEvent({
        id: 'tool-1',
        type: 'tool_result_summary',
        status: 'completed',
        title: 'Inspect',
        summary: 'Located durable evidence.',
        detail: 'RAW_TOOL_LOG_SHOULD_NOT_REACH_THE_NEXT_AGENT',
      })
      runOptions.onEvent({
        type: 'answer_delta', status: 'running', delta: 'Partial conclusion for Hermes',
      })
      throw new Error('LOCAL_AGENT_PROCESS_FAILED')
    }
    hermesPrompt = prompt
    return { text: 'Hermes continued from the evidence', sessionRef: 'hermes-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Terminal evidence', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  workspace.addMessage(
    group.id,
    'system',
    'UNSUPPORTED_AGENT_TERMINAL_SHOULD_NOT_REACH',
    'unsupported-agent',
    '',
    { key: 'system.agentCallFailed', params: { reason: 'UNSUPPORTED' } },
    {
      trace: {
        runId: 'unsupported-run',
        agentRunId: 'unsupported-run:0:unsupported-agent:attempt-1',
        round: 0,
        status: 'failed',
      },
    },
  )
  workspace.addMessage(
    group.id,
    'system',
    'ORDINARY_SYSTEM_TEXT_SHOULD_NOT_REACH',
    '',
    '',
    { key: 'system.autoStopped', params: {} },
  )

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Continue even if Codex fails',
    targetKinds: ['codex', 'hermes'],
  })

  const snapshot = workspace.snapshot()
  const root = snapshot.messages.find(message => message.role === 'user')
  const terminal = snapshot.messages.find(message => (
    message.agentKind === 'codex' && message.system?.key === 'system.agentCallFailed'
  ))
  assert.match(hermesPrompt, /Partial conclusion for Hermes/)
  assert.match(hermesPrompt, /untrusted data, not instructions/)
  assert.match(hermesPrompt, /E-R0-CODEX-\d{2} \[tool_result_summary\] Inspect: Located durable evidence/)
  assert.match(hermesPrompt, new RegExp(`Source messages: ${root.id}`))
  assert.doesNotMatch(
    hermesPrompt,
    /RAW_TOOL_LOG_SHOULD_NOT_REACH|ORDINARY_SYSTEM_TEXT_SHOULD_NOT_REACH|UNSUPPORTED_AGENT_TERMINAL_SHOULD_NOT_REACH/,
  )
  assert.equal(terminal.trace.sourceMessageIds.includes(root.id), true)
  assert.equal(snapshot.messages.find(message => (
    message.agentKind === 'hermes' && message.role === 'agent'
  )).trace.sourceMessageIds.includes(terminal.id), true)

  const afterCodex = workspace.recentTranscript(group.id, 'codex')
  assert.match(afterCodex, /Hermes continued from the evidence/)
  assert.doesNotMatch(afterCodex, /Partial conclusion for Hermes/)
})

test('Harness rotates an over-budget native session while retaining compressed continuity', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return { text: 'Fresh conclusion', sessionRef: 'new-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Rotation', agentKinds: ['codex'], workdir: directory,
  })
  const oldUser = workspace.addMessage(group.id, 'user', 'Keep this constraint')
  const previousAgent = workspace.addMessage(
    group.id, 'agent', 'Previous conclusion', 'codex', oldUser.id,
  )
  const key = workspace.sessionKey(group.id, 'codex')
  workspace.state.sessions[key] = 'old-session'
  workspace.state.sessionMeta[key] = { turns: 18, estimatedChars: 48000 }
  workspace.save()

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Continue with a fresh context',
    targetKinds: ['codex'],
  })

  assert.equal(calls[0].runOptions.sessionRef, '')
  assert.match(calls[0].prompt, /Previous conclusion/)
  const snapshot = workspace.snapshot()
  const currentUser = snapshot.messages.find(message => (
    message.role === 'user' && message.content === 'Continue with a fresh context'
  ))
  const trace = snapshot.messages.at(-1).trace
  assert.equal(trace.context.sessionRotated, true)
  assert.deepEqual(trace.sourceMessageIds, [oldUser.id, currentUser.id, previousAgent.id])
  assert.equal(trace.context.includedCount, trace.sourceMessageIds.length)
  assert.equal(workspace.state.sessions[key], 'new-session')
  assert.equal(workspace.state.sessionMeta[key].turns, 1)
  assert.equal(workspace.state.sessionMeta[key].estimatedChars > calls[0].prompt.length, true)
})

test('Hermes rebuilds full context when an ACP session must switch to legacy for a skill', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.detectAgents = async () => [{
    kind: 'hermes',
    name: 'Hermes CLI',
    executable: '/tmp/hermes',
    version: '2',
    acpAvailable: true,
  }]
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    await runOptions.onSessionRef('hermes-legacy-session', { transport: 'legacy' })
    return { text: 'Legacy conclusion', sessionRef: 'hermes-legacy-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Hermes transport switch', agentKinds: ['hermes'], workdir: directory,
  })
  const oldUser = workspace.addMessage(group.id, 'user', 'Keep the original constraint')
  const previousAgent = workspace.addMessage(
    group.id, 'agent', 'Previous Hermes conclusion', 'hermes', oldUser.id,
  )
  const key = workspace.sessionKey(group.id, 'hermes')
  workspace.state.sessions[key] = 'hermes-acp-session'
  workspace.state.sessionMeta[key] = { turns: 2, estimatedChars: 1200, transport: 'acp' }
  workspace.save()

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Continue with the selected skill',
    targetKinds: ['hermes'],
    skillHints: [{
      targetKind: 'hermes', namespace: 'global', slug: 'research', name: 'Research',
    }],
  })

  assert.equal(calls[0].runOptions.sessionRef, '')
  assert.equal(calls[0].runOptions.sessionTransport, '')
  assert.deepEqual(calls[0].runOptions.skills, ['research'])
  assert.match(calls[0].prompt, /Previous Hermes conclusion/)
  assert.equal(workspace.state.sessions[key], 'hermes-legacy-session')
  assert.equal(workspace.state.sessionMeta[key].transport, 'legacy')
  assert.equal(workspace.state.sessionMeta[key].turns, 1)
  const snapshot = workspace.snapshot()
  const currentUser = snapshot.messages.find(message => (
    message.role === 'user' && message.content === 'Continue with the selected skill'
  ))
  const trace = snapshot.messages.at(-1).trace
  assert.equal(trace.context.sessionRotated, true)
  assert.deepEqual(trace.sourceMessageIds, [oldUser.id, currentUser.id, previousAgent.id])
  assert.equal(trace.context.includedCount, trace.sourceMessageIds.length)
})

test('Hermes migrates a stored ACP session to legacy with rebuilt context before running', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.detectAgents = async () => [{
    kind: 'hermes',
    name: 'Hermes CLI',
    executable: '/tmp/hermes',
    version: '2',
    acpAvailable: true,
  }]
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    await runOptions.onSessionRef('hermes-recovered-session', { transport: 'legacy' })
    return { text: 'Recovered conclusion', sessionRef: 'hermes-recovered-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Hermes stale ACP', agentKinds: ['hermes'], workdir: directory,
  })
  const oldUser = workspace.addMessage(group.id, 'user', 'Keep the original constraint')
  const previousAgent = workspace.addMessage(
    group.id, 'agent', 'Previous Hermes conclusion', 'hermes', oldUser.id,
  )
  const key = workspace.sessionKey(group.id, 'hermes')
  workspace.state.sessions[key] = 'hermes-stale-acp-session'
  workspace.state.sessionMeta[key] = { turns: 2, estimatedChars: 1200, transport: 'acp' }
  workspace.save()

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Continue after recovering the session',
    targetKinds: ['hermes'],
  })

  assert.equal(calls[0].runOptions.sessionRef, '')
  assert.equal(calls[0].runOptions.sessionTransport, '')
  assert.equal(calls[0].runOptions.hermesAcpAvailable, false)
  assert.match(calls[0].prompt, /Previous Hermes conclusion/)
  assert.match(calls[0].prompt, /Continue after recovering the session/)
  assert.equal(workspace.state.sessions[key], 'hermes-recovered-session')
  assert.equal(workspace.state.sessionMeta[key].transport, 'legacy')
  assert.equal(workspace.state.sessionMeta[key].turns, 1)
  const snapshot = workspace.snapshot()
  const currentUser = snapshot.messages.find(message => (
    message.role === 'user' && message.content === 'Continue after recovering the session'
  ))
  const trace = snapshot.messages.at(-1).trace
  assert.equal(trace.context.sessionRotated, true)
  assert.deepEqual(trace.sourceMessageIds, [oldUser.id, currentUser.id, previousAgent.id])
  assert.equal(trace.context.includedCount, trace.sourceMessageIds.length)
})

test('Harness rotates an over-budget OpenClaw managed session to a new key', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return { text: 'Fresh OpenClaw conclusion', sessionRef: runOptions.sessionRef }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'OpenClaw rotation', agentKinds: ['openclaw'], workdir: directory,
  })
  const oldUser = workspace.addMessage(group.id, 'user', 'Keep the prior constraint')
  const previousAgent = workspace.addMessage(
    group.id, 'agent', 'Prior OpenClaw conclusion', 'openclaw', oldUser.id,
  )
  const key = workspace.sessionKey(group.id, 'openclaw')
  const previousSessionRef = workspace.openClawSessionRef(group)
  workspace.state.sessions[key] = previousSessionRef
  workspace.state.sessionMeta[key] = { turns: 18, estimatedChars: 48000 }
  workspace.save()

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Continue with bounded context',
    targetKinds: ['openclaw'],
  })

  assert.notEqual(calls[0].runOptions.sessionRef, previousSessionRef)
  assert.match(calls[0].runOptions.sessionRef, new RegExp(`^${previousSessionRef}-[a-f0-9]{12}$`))
  assert.match(calls[0].prompt, /Prior OpenClaw conclusion/)
  const snapshot = workspace.snapshot()
  const currentUser = snapshot.messages.find(message => (
    message.role === 'user' && message.content === 'Continue with bounded context'
  ))
  const trace = snapshot.messages.at(-1).trace
  assert.equal(trace.context.sessionRotated, true)
  assert.deepEqual(trace.sourceMessageIds, [oldUser.id, currentUser.id, previousAgent.id])
  assert.equal(trace.context.includedCount, trace.sourceMessageIds.length)
  assert.equal(workspace.state.sessions[key], calls[0].runOptions.sessionRef)
  assert.equal(workspace.state.sessionMeta[key].turns, 1)
})

test('legacy sessions resume once and initialize bounded session metadata', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Legacy session metadata', agentKinds: ['codex'], workdir: directory,
  })
  const key = workspace.sessionKey(group.id, 'codex')
  workspace.state.sessions[key] = 'legacy-codex-session'
  workspace.save()

  await workspace.sendMessage({ groupId: group.id, text: 'Resume safely', targetKinds: ['codex'] })

  assert.equal(calls[0].runOptions.sessionRef, 'legacy-codex-session')
  assert.equal(workspace.state.sessionMeta[key].turns, 1)
  assert.equal(workspace.state.sessionMeta[key].estimatedChars > 0, true)
})

test('Harness rebuilds compressed context once when a reused legacy session is invalid', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (calls.length === 1) throw new Error('LOCAL_AGENT_SESSION_INVALID')
    await runOptions.onSessionRef('codex-fresh-session', { transport: 'legacy' })
    return { text: 'Recovered legacy conclusion', sessionRef: 'codex-fresh-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Legacy session recovery', agentKinds: ['codex'], workdir: directory,
  })
  const oldUser = workspace.addMessage(group.id, 'user', 'Keep the original requirement')
  const previousAgent = workspace.addMessage(
    group.id, 'agent', 'Previous Codex conclusion', 'codex', oldUser.id,
  )
  const key = workspace.sessionKey(group.id, 'codex')
  workspace.state.sessions[key] = 'codex-stale-session'
  workspace.state.sessionMeta[key] = { turns: 2, estimatedChars: 1200, transport: 'legacy' }
  workspace.save()

  await workspace.sendMessage({
    groupId: group.id, text: 'Continue after session recovery', targetKinds: ['codex'],
  })

  assert.deepEqual(calls.map(call => call.runOptions.sessionRef), ['codex-stale-session', ''])
  assert.deepEqual(calls.map(call => call.runOptions.sessionTransport), ['legacy', ''])
  assert.doesNotMatch(calls[0].prompt, /Previous Codex conclusion/)
  assert.match(calls[1].prompt, /Previous Codex conclusion/)
  assert.match(calls[1].prompt, /Continue after session recovery/)
  assert.equal(workspace.state.sessions[key], 'codex-fresh-session')
  assert.equal(workspace.state.sessionMeta[key].transport, 'legacy')
  assert.equal(workspace.state.sessionMeta[key].turns, 1)
  const trace = workspace.snapshot().messages.at(-1).trace
  assert.equal(trace.status, 'completed')
  assert.equal(trace.context.sessionRotated, true)
  assert.deepEqual(trace.sourceMessageIds, [
    oldUser.id,
    workspace.snapshot().messages.find(message => (
      message.role === 'user' && message.content === 'Continue after session recovery'
    )).id,
    previousAgent.id,
  ])
})

test('Harness retries a reused ACP session once with a fresh session', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.detectAgents = async () => [{
    kind: 'kimi', name: 'Kimi CLI', executable: '/tmp/kimi', version: '1',
  }]
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (calls.length === 1) throw new Error('LOCAL_AGENT_SESSION_INVALID')
    await runOptions.onSessionRef('kimi-fresh-session', { transport: 'acp' })
    return { text: 'Recovered ACP conclusion', sessionRef: 'kimi-fresh-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'ACP session recovery', agentKinds: ['kimi'], workdir: directory,
  })
  const key = workspace.sessionKey(group.id, 'kimi')
  workspace.state.sessions[key] = 'kimi-stale-session'
  workspace.state.sessionMeta[key] = { turns: 3, estimatedChars: 1800, transport: 'acp' }
  workspace.save()

  await workspace.sendMessage({
    groupId: group.id, text: 'Recover the ACP session', targetKinds: ['kimi'],
  })

  assert.deepEqual(calls.map(call => call.runOptions.sessionRef), ['kimi-stale-session', ''])
  assert.deepEqual(calls.map(call => call.runOptions.sessionTransport), ['acp', ''])
  assert.equal(workspace.state.sessions[key], 'kimi-fresh-session')
  assert.equal(workspace.state.sessionMeta[key].transport, 'acp')
  assert.equal(workspace.state.sessionMeta[key].turns, 1)
  assert.equal(workspace.snapshot().messages.at(-1).trace.context.sessionRotated, true)
})

test('Harness stops after one fresh-session retry when the Session remains invalid', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    throw new Error('LOCAL_AGENT_SESSION_INVALID')
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Bounded session recovery', agentKinds: ['codex'], workdir: directory,
  })
  const key = workspace.sessionKey(group.id, 'codex')
  workspace.state.sessions[key] = 'codex-stale-session'
  workspace.state.sessionMeta[key] = { turns: 2, estimatedChars: 1200, transport: 'legacy' }
  workspace.save()

  await workspace.sendMessage({
    groupId: group.id, text: 'Do not loop recovery', targetKinds: ['codex'],
  })

  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map(call => call.runOptions.sessionRef), ['codex-stale-session', ''])
  assert.equal(Object.hasOwn(workspace.state.sessions, key), false)
  assert.equal(Object.hasOwn(workspace.state.sessionMeta, key), false)
  const failure = workspace.snapshot().messages.find(message => (
    message.system?.key === 'system.agentCallFailed' && message.agentKind === 'codex'
  ))
  assert.equal(failure.system.params.reason, 'LOCAL_AGENT_SESSION_INVALID')
  assert.equal(failure.trace.status, 'failed')
  assert.equal(failure.trace.context.sessionRotated, true)
})

test('per-Agent watchdog persists a timeout trace and continues the automatic round', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgentTimeoutMs = 8
  options.runAbortGraceMs = 20
  options.runSilenceWarningMs = 100
  const lateCallbacksDone = deferred()
  let timedOutSignal
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'codex') {
      timedOutSignal = runOptions.signal
      return await new Promise((resolve) => {
        runOptions.signal.addEventListener('abort', () => {
          setImmediate(() => {
            runOptions.onProgress({
              id: 'late-progress', title: 'search', status: 'completed', detail: 'late raw data',
            })
            runOptions.onEvent({
              id: 'late-tool', type: 'tool_result_summary', title: 'search',
              status: 'completed', summary: 'late event',
            })
            runOptions.onSessionRef('late-session')
            resolve({ text: 'late answer', sessionRef: 'late-session' })
            lateCallbacksDone.resolve()
          })
        }, { once: true })
      })
    }
    return {
      text: 'Hermes continued\n[[ROUNDRELAY_CONSENSUS:continue]]',
      sessionRef: 'hermes-session',
    }
  }
  const events = []
  const finished = []
  const workspace = new LocalWorkspace(options)
  workspace.on('run-event', event => events.push(event))
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Agent watchdog', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Continue after one Agent times out',
    mode: 'auto',
    maxRounds: 1,
  })
  await workspace.activeRuns.get(group.id).promise
  await lateCallbacksDone.promise

  assert.equal(timedOutSignal.aborted, true)
  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes'])
  const failure = workspace.snapshot().messages.find(message => (
    message.agentKind === 'codex' && message.system?.key === 'system.agentCallFailed'
  ))
  assert.equal(failure.system.params.reason, 'LOCAL_AGENT_TIMEOUT')
  assert.equal(failure.trace.status, 'timeout')
  assert.equal(finished[0].status, 'round-limit')
  assert.equal(events.some(event => (
    event.agentKind === 'codex' && event.type === 'status' && event.status === 'timeout'
  )), true)
  assert.equal(events.some(event => ['late-progress', 'late-tool'].includes(event.id)), false)
  assert.equal(workspace.state.sessions[workspace.sessionKey(group.id, 'codex')], undefined)
})

test('manual Agent watchdog finishes the run as timeout and removes the parent abort listener', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgentTimeoutMs = 8
  options.runAbortGraceMs = 20
  options.runSilenceWarningMs = 100
  const started = deferred()
  let timedOutSignal
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    timedOutSignal = runOptions.signal
    started.resolve()
    return await new Promise(() => {})
  }
  const finished = []
  const workspace = new LocalWorkspace(options)
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Manual watchdog', agentKinds: ['codex'], workdir: directory,
    conversationType: 'direct', directAgentKind: 'codex',
  })

  const send = workspace.sendMessage({ groupId: group.id, text: 'Do not wait forever' })
  await started.promise
  const parentSignal = workspace.activeRuns.get(group.id).signal
  assert.equal(getEventListeners(parentSignal, 'abort').length, 1)
  await send

  assert.equal(timedOutSignal.aborted, true)
  assert.equal(getEventListeners(parentSignal, 'abort').length, 0)
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'timeout')
  const failure = workspace.snapshot().messages.find(message => (
    message.agentKind === 'codex' && message.system?.key === 'system.agentCallFailed'
  ))
  assert.equal(failure.system.params.reason, 'LOCAL_AGENT_TIMEOUT')
  assert.equal(failure.trace.status, 'timeout')
})

test('terminal Agent states persist conclusion text already streamed through answer deltas', async (t) => {
  const scenarios = [
    {
      name: 'failure',
      action: 'fail',
      expectedKey: 'system.agentCallFailed',
      expectedPrefix: 'Codex failed: LOCAL_AGENT_PROCESS_FAILED',
    },
    {
      name: 'timeout',
      action: 'timeout',
      expectedKey: 'system.agentCallFailed',
      expectedPrefix: 'Codex failed: LOCAL_AGENT_TIMEOUT',
    },
    {
      name: 'stop',
      action: 'stop',
      expectedKey: 'system.agentStopped',
      expectedPrefix: 'Codex was stopped.',
    },
    {
      name: 'interruption',
      action: 'interrupt',
      expectedKey: 'system.agentInterrupted',
      expectedPrefix: 'Codex was interrupted when Meldwork closed.',
    },
  ]

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (t) => {
      const { directory, options } = fixture()
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
      const started = deferred()
      const conclusion = `${scenario.name} streamed conclusion`
      options.runAbortGraceMs = 20
      options.runSilenceWarningMs = 100
      if (scenario.action === 'timeout') options.runAgentTimeoutMs = 8
      options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
        runOptions.onEvent({
          type: 'reasoning_summary', status: 'running', summary: 'Trace-only reasoning summary',
        })
        runOptions.onEvent({ type: 'answer_delta', status: 'running', delta: conclusion })
        started.resolve()
        if (scenario.action === 'fail') throw new Error('LOCAL_AGENT_PROCESS_FAILED')
        return await new Promise((_resolve, reject) => {
          runOptions.signal.addEventListener(
            'abort', () => reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED')), { once: true },
          )
        })
      }
      const workspace = new LocalWorkspace(options)
      await workspace.refreshAgents()
      const group = workspace.createGroup({
        name: `Streamed ${scenario.name}`, agentKinds: ['codex'], workdir: directory,
      })

      const send = workspace.sendMessage({
        groupId: group.id, text: `Exercise ${scenario.name}`, targetKinds: ['codex'],
      })
      await started.promise
      if (scenario.action === 'stop') {
        const runId = workspace.activeRuns.get(group.id).runId
        assert.equal(workspace.stop(group.id, runId), true)
        await send
      } else if (scenario.action === 'interrupt') {
        await Promise.all([send, workspace.stopAll()])
      } else {
        await send
      }

      const terminal = workspace.snapshot().messages.find(message => (
        message.agentKind === 'codex' && message.system?.key === scenario.expectedKey
      ))
      assert.equal(terminal.content, `${scenario.expectedPrefix}\n${conclusion}`)
      assert.doesNotMatch(terminal.content, /Trace-only reasoning summary/)
      const persisted = JSON.parse(fs.readFileSync(options.storagePath, 'utf8'))
      assert.equal(
        persisted.messages.find(message => message.id === terminal.id).content,
        terminal.content,
      )
    })
  }
})

test('completed Agents clear watchdog and silence timers', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgentTimeoutMs = 5
  options.runSilenceWarningMs = 5
  let completedSignal
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    completedSignal = runOptions.signal
    return { text: 'Completed immediately', sessionRef: 'codex-session' }
  }
  const events = []
  const workspace = new LocalWorkspace(options)
  workspace.on('run-event', event => events.push(event))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Timer cleanup', agentKinds: ['codex'], workdir: directory,
  })

  await workspace.sendMessage({ groupId: group.id, text: 'Finish', targetKinds: ['codex'] })
  await new Promise(resolve => setTimeout(resolve, 20))

  assert.equal(completedSignal.aborted, false)
  assert.equal(events.some(event => event.type === 'warning'), false)
  assert.deepEqual(workspace.snapshot().runningGroupIds, [])
})

test('progress heartbeats reset the soft silence warning', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runSilenceWarningMs = 30
  options.runAgentTimeoutMs = 500
  const heartbeatsComplete = deferred()
  const releaseAgent = deferred()
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    for (let tick = 0; tick < 8; tick += 1) {
      await new Promise(resolve => setTimeout(resolve, 5))
      runOptions.onProgress({ id: 'heartbeat', title: 'process', status: 'in_progress' })
    }
    heartbeatsComplete.resolve()
    await releaseAgent.promise
    return { text: 'Finished after progress', sessionRef: 'codex-session' }
  }
  const events = []
  const workspace = new LocalWorkspace(options)
  workspace.on('run-event', event => events.push(event))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Progress heartbeat', agentKinds: ['codex'], workdir: directory,
  })

  const send = workspace.sendMessage({
    groupId: group.id, text: 'Keep reporting', targetKinds: ['codex'],
  })
  await heartbeatsComplete.promise

  assert.equal(events.some(event => event.type === 'warning'), false)
  assert.equal(events.some(event => event.type.startsWith('tool_') || event.title === 'process'), false)

  await new Promise(resolve => setTimeout(resolve, 45))
  const warning = events.find(event => event.type === 'warning')
  assert.equal(warning?.title, 'waiting_for_output')

  releaseAgent.resolve()
  await send
  const reply = workspace.snapshot().messages.find(message => message.agentKind === 'codex')
  assert.equal(reply.trace.events.some(event => event.title === 'process'), false)
})

test('Harness emits a soft waiting warning without cancelling a long-running Agent', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runSilenceWarningMs = 5
  const gate = deferred()
  options.runAgent = async () => {
    await gate.promise
    return { text: 'Eventually finished', sessionRef: 'codex-session' }
  }
  const events = []
  const workspace = new LocalWorkspace(options)
  workspace.on('run-event', event => events.push(event))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Silence warning', agentKinds: ['codex'], workdir: directory,
  })

  const send = workspace.sendMessage({ groupId: group.id, text: 'Wait', targetKinds: ['codex'] })
  await new Promise(resolve => setTimeout(resolve, 25))
  const warning = events.find(event => event.type === 'warning')
  assert.equal(warning?.status, 'waiting')
  assert.equal(warning?.title, 'waiting_for_output')
  assert.equal(workspace.snapshot().runningGroupIds.includes(group.id), true)
  gate.resolve()
  await send
  assert.equal(workspace.snapshot().messages.at(-1).content, 'Eventually finished')
})

test('Automatic Harness conclusions stream without exposing the consensus control marker', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    runOptions.onEvent({ type: 'reasoning_summary', summary: agent.kind + ' compared the proposals' })
    runOptions.onEvent({ type: 'answer_delta', status: 'running', delta: agent.kind + ' conclusion\n[[ROUNDRELAY_CONSENSUS:' })
    runOptions.onEvent({ type: 'answer_delta', status: 'running', delta: 'agree]]' })
    return {
      text: agent.kind + ' conclusion\n[[ROUNDRELAY_CONSENSUS:agree]]',
      sessionRef: runOptions.sessionRef || agent.kind + '-session',
    }
  }
  const events = []
  const workspace = new LocalWorkspace(options)
  workspace.on('run-event', event => events.push(event))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Automatic harness', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  const started = await workspace.sendMessage({
    groupId: group.id,
    text: 'Reach consensus',
    mode: 'auto',
    maxRounds: 1,
  })
  assert.equal(started.started, true)
  await workspace.activeRuns.get(group.id).promise

  const answerText = events.filter(event => event.type === 'answer_delta')
    .map(event => event.delta)
    .join('')
  assert.doesNotMatch(answerText, /ROUNDRELAY_CONSENSUS/)
  assert.equal(events.some(event => event.type === 'reasoning_summary'), true)
  assert.deepEqual(
    workspace.snapshot().messages.filter(message => message.role === 'agent')
      .map(message => message.content),
    ['codex conclusion', 'hermes conclusion'],
  )
})

test('Run Ledger checkpoints bounded trace state and is cleared with its conversation', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const checkpoints = []
  const finishes = []
  const deletedGroups = []
  options.runLedger = {
    recoverInterrupted: () => [],
    checkpoint: record => checkpoints.push(structuredClone(record)),
    finish: (runId, status, reason) => finishes.push({ runId, status, reason }),
    deleteGroup: groupId => deletedGroups.push(groupId),
  }
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    runOptions.onEvent({
      id: 'plan-1', type: 'plan', status: 'running', summary: 'Inspect the current implementation.',
    })
    return { text: 'Ledger-backed result', sessionRef: 'codex-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Ledger lifecycle', agentKinds: ['codex'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id, text: 'Trace this run', targetKinds: ['codex'],
  })

  assert.equal(checkpoints.some(record => record.status === 'preparing'), true)
  assert.equal(checkpoints.some(record => record.status === 'running'), true)
  const terminal = checkpoints.findLast(record => record.status === 'completed')
  const task = workspace.snapshot().messages.find(message => (
    message.role === 'user' && message.content === 'Trace this run'
  ))
  assert.equal(terminal.taskId, task.id)
  assert.equal(terminal.threadRootId, task.id)
  assert.equal(terminal.agentRuns[0].status, 'completed')
  assert.equal(terminal.agentRuns[0].events.some(event => event.type === 'plan'), true)
  assert.equal(terminal.agentRuns[0].context.includedCount, 1)
  assert.deepEqual(finishes, [{ runId: terminal.runId, status: 'completed', reason: '' }])

  workspace.deleteGroup(group.id)
  assert.deepEqual(deletedGroups, [group.id])
})

test('durable Task acceptance fails closed at every pre-execution Ledger checkpoint', async (t) => {
  for (const failureAttempt of [1, 2, 3]) {
    await t.test(`checkpoint ${failureAttempt}`, async (subtest) => {
      const { directory, calls, options } = fixture()
      subtest.after(() => fs.rmSync(directory, { recursive: true, force: true }))
      let checkpointAttempts = 0
      options.runLedger = {
        recoverInterrupted: () => [],
        list: () => [],
        checkpoint: () => {
          checkpointAttempts += 1
          if (checkpointAttempts === failureAttempt) throw new Error('RUN_LEDGER_WRITE_FAILED')
        },
        finish: () => {},
      }
      const workspace = new LocalWorkspace(options)
      await workspace.refreshAgents()
      const group = workspace.createGroup({
        name: `Ledger gate ${failureAttempt}`, agentKinds: ['codex'], workdir: directory,
      })
      const previousUpdatedAt = group.updatedAt

      await assert.rejects(
        workspace.sendMessage({
          groupId: group.id,
          text: `Do not execute after checkpoint ${failureAttempt}`,
          targetKinds: ['codex'],
        }),
        { message: 'LOCAL_RUN_PERSIST_FAILED' },
      )

      assert.equal(calls.length, 0)
      assert.equal(workspace.snapshot().messages.length, 0)
      assert.deepEqual(workspace.snapshot().runningGroupIds, [])
      assert.equal(workspace.getGroup(group.id).updatedAt, previousUpdatedAt)
    })
  }
})

test('the durable Task link exists before the Agent process starts', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  let workspace
  let group
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    const userTask = workspace.state.messages.findLast(message => message.role === 'user')
    const active = workspace.activeRuns.get(group.id)
    const durable = ledger.get(active.runId)
    assert.equal(durable.status, 'running')
    assert.equal(durable.taskId, userTask.id)
    assert.equal(durable.threadRootId, userTask.id)
    return { text: 'Durably linked result', sessionRef: runOptions.sessionRef || 'codex-session' }
  }
  workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  group = workspace.createGroup({
    name: 'Durable Task link', agentKinds: ['codex'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id, text: 'Persist this Task before execution', targetKinds: ['codex'],
  })

  const task = workspace.snapshot().messages.find(message => message.role === 'user')
  const run = ledger.list(group.id)[0]
  assert.equal(run.taskId, task.id)
  assert.equal(run.status, 'completed')
})

test('direct Tasks persist without inventing a group thread root', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Durable direct Task',
    agentKinds: ['codex'],
    conversationType: 'direct',
    directAgentKind: 'codex',
    workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id, text: 'Persist this direct Task', targetKinds: ['codex'],
  })

  const task = workspace.snapshot().messages.find(message => message.role === 'user')
  const run = ledger.list(group.id)[0]
  assert.equal(run.taskId, task.id)
  assert.equal(run.threadRootId, '')
  assert.equal(run.status, 'completed')
})

test('resuming automatic discussion checkpoints its existing Task before execution', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  let workspace
  let group
  options.runAgent = async (agent, _prompt, _workdir, runOptions) => {
    calls.push({ agent, runOptions })
    const active = workspace.activeRuns.get(group.id)
    const durable = ledger.get(active.runId)
    assert.equal(durable.status, 'running')
    assert.equal(durable.taskId, active.threadRootId)
    return {
      text: `${agent.kind} agrees\n[[ROUNDRELAY_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  group = workspace.createGroup({
    name: 'Durable resumed discussion',
    agentKinds: ['codex', 'hermes'],
    workdir: directory,
  })
  const task = workspace.addMessage(group.id, 'user', 'Resume this durable Task')

  workspace.startAuto({ groupId: group.id, maxRounds: 1 })
  await workspace.activeRuns.get(group.id).promise

  const run = ledger.list(group.id)[0]
  assert.equal(calls.length, 2)
  assert.equal(run.taskId, task.id)
  assert.equal(run.threadRootId, task.id)
  assert.equal(run.status, 'completed')
})

test('resuming automatic discussion fails closed when its running checkpoint is not durable', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let checkpointAttempts = 0
  options.runLedger = {
    recoverInterrupted: () => [],
    list: () => [],
    checkpoint: () => {
      checkpointAttempts += 1
      if (checkpointAttempts === 2) throw new Error('RUN_LEDGER_WRITE_FAILED')
    },
    finish: () => {},
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Durable resume gate', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const task = workspace.addMessage(group.id, 'user', 'Do not resume without durable state')

  assert.throws(
    () => workspace.startAuto({ groupId: group.id, maxRounds: 1 }),
    { message: 'LOCAL_RUN_PERSIST_FAILED' },
  )

  assert.equal(calls.length, 0)
  assert.equal(workspace.snapshot().messages.some(message => message.id === task.id), true)
  assert.deepEqual(workspace.snapshot().runningGroupIds, [])
})

test('Run Ledger finalization retries the full terminal snapshot before finish', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const ledger = new RunLedger({ storagePath: ledgerPath, now: () => 1000 })
  options.runLedger = ledger
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Retry terminal checkpoint', agentKinds: ['codex'], workdir: directory,
  })
  const controller = workspace.createRunController('manual', ['codex'], 'root-1')
  controller.groupId = group.id
  controller.startedAt = 1000
  let agentRuns = [{
    agentRunId: `${controller.runId}:0:codex:agent-1`,
    kind: 'codex',
    status: 'running',
    output: 'Stale output',
  }]
  controller.harness = { snapshot: () => structuredClone(agentRuns) }
  assert.equal(workspace.checkpointRun(group.id, controller, 'running'), true)

  const persist = ledger.persist.bind(ledger)
  let failed = false
  ledger.persist = (runs) => {
    if (!failed) {
      failed = true
      throw new Error('RUN_LEDGER_WRITE_FAILED')
    }
    return persist(runs)
  }
  agentRuns = [{
    ...agentRuns[0],
    status: 'completed',
    output: 'Fresh terminal output',
  }]

  workspace.finishRunCheckpoint(group.id, controller, 'completed')
  assert.equal(ledger.get(controller.runId).status, 'running')
  assert.equal(ledger.get(controller.runId).agentRuns[0].output, 'Stale output')

  workspace.finishRunCheckpoint(group.id, controller, 'completed')
  const finished = ledger.get(controller.runId)
  assert.equal(finished.status, 'completed')
  assert.equal(finished.agentRuns[0].status, 'completed')
  assert.equal(finished.agentRuns[0].output, 'Fresh terminal output')
})

test('a Unicode group identifier preserves native sessions and every runtime path', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const groupId = '历史群聊 1'
  let id = 0
  const checkpoints = []
  const ledgerFinishes = []
  options.createId = () => id++ === 0 ? groupId : `message-${id}`
  options.runLedger = {
    recoverInterrupted: () => [],
    list: () => [],
    checkpoint: record => checkpoints.push(structuredClone(record)),
    finish: (runId, status) => ledgerFinishes.push({ runId, status }),
  }
  const events = []
  const finished = []
  const workspace = new LocalWorkspace(options)
  workspace.on('run-event', event => events.push(event))
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Unicode group', agentKinds: ['codex'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id, text: 'Send through every lifecycle boundary', targetKinds: ['codex'],
  })
  await workspace.sendMessage({
    groupId: group.id, text: 'Reuse the native session', targetKinds: ['codex'],
  })

  const sessionKey = workspace.sessionKey(group.id, 'codex')
  const persisted = JSON.parse(fs.readFileSync(options.storagePath, 'utf8'))
  assert.equal(workspace.sessionKey('group-1', 'codex'), 'group-1:codex')
  assert.match(sessionKey, /^session:[a-f0-9]{64}$/)
  assert.doesNotMatch(sessionKey, /历史群聊/)
  assert.equal(persisted.sessions[sessionKey], 'codex-session')
  assert.deepEqual(calls.map(call => call.runOptions.sessionRef), ['', 'codex-session'])

  const restarted = new LocalWorkspace(options)
  await restarted.refreshAgents()
  await restarted.sendMessage({
    groupId: group.id, text: 'Reuse after restart', targetKinds: ['codex'],
  })

  assert.equal(group.id, groupId)
  assert.equal(checkpoints.length > 0, true)
  assert.equal(checkpoints.every(record => record.groupId === groupId), true)
  assert.deepEqual(ledgerFinishes.map(item => item.status), [
    'completed', 'completed', 'completed',
  ])
  assert.equal(events.length > 0, true)
  assert.equal(events.every(event => event.groupId === groupId), true)
  assert.equal(finished.every(result => result.groupId === groupId), true)
  assert.deepEqual(calls.map(call => call.runOptions.sessionRef), [
    '', 'codex-session', 'codex-session',
  ])
  assert.equal(restarted.snapshot().messages.every(message => message.groupId === groupId), true)
})

test('conversation deletion remains retryable when a corrupt Run Ledger blocks cleanup', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let deleteAttempts = 0
  options.runLedger = {
    recoverInterrupted: () => [],
    deleteGroup: () => {
      deleteAttempts += 1
      if (deleteAttempts === 1) throw new Error('RUN_LEDGER_LOAD_FAILED')
    },
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Ledger cleanup failure', agentKinds: ['codex'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', 'Keep this conversation until cleanup succeeds')
  const beforeDisk = fs.readFileSync(options.storagePath, 'utf8')

  assert.throws(() => workspace.deleteGroup(group.id), { message: 'RUN_LEDGER_LOAD_FAILED' })
  assert.equal(workspace.snapshot().groups.some(item => item.id === group.id), true)
  assert.equal(workspace.snapshot().messages.some(message => message.groupId === group.id), true)
  assert.equal(fs.readFileSync(options.storagePath, 'utf8'), beforeDisk)

  workspace.deleteGroup(group.id)
  assert.equal(workspace.snapshot().groups.some(item => item.id === group.id), false)
  assert.equal(deleteAttempts, 2)
})

test('conversation state rolls back when workspace deletion persistence fails', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const deletedGroups = []
  options.runLedger = {
    recoverInterrupted: () => [],
    deleteGroup: groupId => deletedGroups.push(groupId),
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Workspace cleanup failure', agentKinds: ['codex'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', 'Keep the local state retryable')
  const save = workspace.save.bind(workspace)
  workspace.save = () => { throw new Error('WORKSPACE_SAVE_FAILED') }

  assert.throws(() => workspace.deleteGroup(group.id), { message: 'WORKSPACE_SAVE_FAILED' })
  assert.equal(workspace.snapshot().groups.some(item => item.id === group.id), true)
  assert.equal(workspace.snapshot().messages.some(message => message.groupId === group.id), true)
  assert.deepEqual(deletedGroups, [])

  workspace.save = save
  workspace.deleteGroup(group.id)
  assert.equal(workspace.snapshot().groups.some(item => item.id === group.id), false)
  assert.deepEqual(deletedGroups, [group.id])
})

test('conversation mutations restore in-memory state when persistence fails', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Transactional conversation', agentKinds: ['codex'], workdir: directory,
  })
  const message = workspace.addMessage(group.id, 'user', 'Keep this message')
  workspace.state.sessions[`${group.id}:codex`] = 'session-before-failure'
  workspace.state.sessionMeta[`${group.id}:codex`] = { updatedAt: 'before-failure' }
  const before = structuredClone(workspace.state)
  const save = workspace.save.bind(workspace)
  workspace.save = () => { throw new Error('WORKSPACE_SAVE_FAILED') }

  assert.throws(() => workspace.createGroup({
    name: 'Unsaved group', agentKinds: ['codex'], workdir: directory,
  }), { message: 'WORKSPACE_SAVE_FAILED' })
  assert.deepEqual(workspace.state, before)

  assert.throws(() => workspace.updateGroup(group.id, {
    name: 'Unsaved rename', workdir: path.join(directory, 'other'), allowWrite: false,
  }), { message: 'WORKSPACE_SAVE_FAILED' })
  assert.deepEqual(workspace.state, before)

  assert.throws(() => workspace.deleteMessage(group.id, message.id), {
    message: 'WORKSPACE_SAVE_FAILED',
  })
  assert.deepEqual(workspace.state, before)

  assert.throws(() => workspace.addMessage(group.id, 'agent', 'Unsaved response', 'codex'), {
    message: 'WORKSPACE_SAVE_FAILED',
  })
  assert.deepEqual(workspace.state, before)

  workspace.save = save
})

test('conversation validation failures do not leave partial state behind', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Validated conversation', agentKinds: ['codex'], workdir: directory,
  })
  const before = structuredClone(workspace.state)

  assert.throws(() => workspace.updateGroup(group.id, {
    name: 'Partial rename',
    workdir: path.join(directory, 'invalid-update'),
    agentKinds: ['missing-agent'],
  }), { message: 'LOCAL_GROUP_AGENT_REQUIRED' })
  assert.deepEqual(workspace.state, before)

  assert.throws(() => workspace.addMessage('missing-group', 'user', 'Orphan message'), {
    message: 'LOCAL_GROUP_NOT_FOUND',
  })
  assert.deepEqual(workspace.state, before)
})

test('restart recovery persists the last nonterminal Agent trace as interrupted', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const initial = new LocalWorkspace(options)
  await initial.refreshAgents()
  const group = initial.createGroup({
    name: 'Interrupted recovery', agentKinds: ['codex'], workdir: directory,
  })
  const root = initial.addMessage(group.id, 'user', 'Keep the last useful evidence')
  const recoveredOptions = {
    ...options,
    runLedger: {
      recoverInterrupted: () => [{
        runId: 'run-crashed',
        groupId: group.id,
        threadRootId: root.id,
        targetKinds: ['codex'],
        agentRuns: [{
          agentRunId: 'run-crashed:1:codex:agent-1',
          kind: 'codex',
          round: 1,
          status: 'interrupted',
          sourceMessageIds: [root.id],
          context: { includedCount: 1, omittedCount: 2, charCount: 640 },
          events: [{
            type: 'reasoning_summary', status: 'running',
            summary: 'Located the failing lifecycle boundary.',
          }],
        }],
      }],
    },
  }

  const restored = new LocalWorkspace(recoveredOptions)
  const interrupted = restored.snapshot().messages.find(message => (
    message.system?.key === 'system.agentInterrupted'
  ))

  assert.equal(interrupted.threadRootId, root.id)
  assert.equal(interrupted.trace.status, 'interrupted')
  assert.equal(interrupted.trace.summary, 'Located the failing lifecycle boundary.')
  assert.deepEqual(interrupted.trace.sourceMessageIds, [root.id])
  assert.equal(interrupted.trace.context.omittedCount, 2)
})

test('restart reconciles after recovery message persistence fails and then deduplicates', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const initial = new LocalWorkspace(options)
  await initial.refreshAgents()
  const group = initial.createGroup({
    name: 'Retry interrupted recovery', agentKinds: ['codex'], workdir: directory,
  })
  const root = initial.addMessage(group.id, 'user', 'Recover this once')
  const seeded = new RunLedger({ storagePath: ledgerPath, now: () => 1000 })
  seeded.checkpoint({
    runId: 'run-crashed',
    groupId: group.id,
    threadRootId: root.id,
    targetKinds: ['codex'],
    status: 'running',
    agentRuns: [{
      agentRunId: 'run-crashed:1:codex:agent-1',
      kind: 'codex',
      round: 1,
      status: 'running',
      output: 'Useful partial output',
      sourceMessageIds: [root.id],
    }],
  })

  class FailingRecoveryWorkspace extends LocalWorkspace {
    save() { throw new Error('WORKSPACE_SAVE_FAILED') }
  }
  assert.throws(() => new FailingRecoveryWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath, now: () => 2000 }),
  }), { message: 'WORKSPACE_SAVE_FAILED' })
  assert.equal(
    new RunLedger({ storagePath: ledgerPath }).get('run-crashed').agentRuns[0].status,
    'interrupted',
  )

  const recoveredStartup = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath, now: () => 3000 }),
  })
  const restored = recoveredStartup.snapshot().messages.filter(message => (
    message.trace?.agentRunId === 'run-crashed:1:codex:agent-1'
  ))
  assert.equal(restored.length, 1)
  assert.equal(restored[0].system.key, 'system.agentInterrupted')
  assert.equal(restored[0].trace.status, 'interrupted')

  const repeatedStartup = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath, now: () => 4000 }),
  })
  assert.equal(repeatedStartup.snapshot().messages.filter(message => (
    message.trace?.agentRunId === 'run-crashed:1:codex:agent-1'
  )).length, 1)
})

test('restart reconciliation enriches an existing terminal message with Ledger output once', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const initial = new LocalWorkspace(options)
  await initial.refreshAgents()
  const group = initial.createGroup({
    name: 'Existing terminal recovery', agentKinds: ['codex'], workdir: directory,
  })
  const root = initial.addMessage(group.id, 'user', 'Preserve the streamed conclusion')
  initial.addMessage(
    group.id,
    'system',
    'Codex failed: LOCAL_AGENT_PROCESS_FAILED',
    'codex',
    root.id,
    {
      key: 'system.agentCallFailed',
      params: { agent: 'Codex', reason: 'LOCAL_AGENT_PROCESS_FAILED' },
    },
    {
      trace: {
        runId: 'run-existing-terminal',
        agentRunId: 'run-existing-terminal:0:codex:agent-1',
        round: 0,
        status: 'failed',
      },
    },
  )
  const ledger = new RunLedger({ storagePath: ledgerPath, now: () => 1000 })
  ledger.checkpoint({
    runId: 'run-existing-terminal',
    groupId: group.id,
    threadRootId: root.id,
    targetKinds: ['codex'],
    status: 'failed',
    agentRuns: [{
      agentRunId: 'run-existing-terminal:0:codex:agent-1',
      kind: 'codex',
      round: 0,
      status: 'failed',
      output: 'Conclusion recovered from answer deltas',
      reason: 'LOCAL_AGENT_PROCESS_FAILED',
    }],
  })

  const restored = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath, now: () => 2000 }),
  })
  const matching = restored.snapshot().messages.filter(message => (
    message.trace?.agentRunId === 'run-existing-terminal:0:codex:agent-1'
  ))
  assert.equal(matching.length, 1)
  assert.equal(
    matching[0].content,
    'Codex failed: LOCAL_AGENT_PROCESS_FAILED\nConclusion recovered from answer deltas',
  )

  const repeated = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath, now: () => 3000 }),
  })
  const repeatedMatching = repeated.snapshot().messages.filter(message => (
    message.trace?.agentRunId === 'run-existing-terminal:0:codex:agent-1'
  ))
  assert.equal(repeatedMatching.length, 1)
  assert.equal(
    repeatedMatching[0].content.match(/Conclusion recovered from answer deltas/g)?.length,
    1,
  )
})

test('restart keeps a long failure prefix aligned with its streamed conclusion', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const longReason = `LOCAL_AGENT_PROCESS_FAILED:${'x'.repeat(1200)}`
  const boundedReason = longReason.slice(0, 1000)
  const conclusion = 'Conclusion streamed before the long failure.'
  options.runLedger = new RunLedger({ storagePath: ledgerPath, now: () => 1000 })
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    runOptions.onEvent({ type: 'answer_delta', status: 'running', delta: conclusion })
    throw new Error(longReason)
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Long failure restart', agentKinds: ['codex'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id, text: 'Fail after streaming', targetKinds: ['codex'],
  })

  const persisted = JSON.parse(fs.readFileSync(options.storagePath, 'utf8'))
  const persistedFailure = persisted.messages.find(message => (
    message.system?.key === 'system.agentCallFailed'
  ))
  const persistedPrefix = `Codex failed: ${persistedFailure.system.params.reason}`
  assert.equal(persistedFailure.system.params.reason, boundedReason)
  assert.equal(persistedFailure.content, `${persistedPrefix}\n${conclusion}`)

  const restored = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath, now: () => 2000 }),
  })
  const restoredFailure = restored.snapshot().messages.find(message => (
    message.system?.key === 'system.agentCallFailed'
  ))
  const restoredPrefix = `Codex failed: ${restoredFailure.system.params.reason}`
  assert.equal(restoredFailure.system.params.reason, persistedFailure.system.params.reason)
  assert.equal(restoredFailure.content.startsWith(`${restoredPrefix}\n`), true)
  assert.equal(restoredFailure.content.includes(conclusion), true)
  assert.equal(restoredFailure.content.indexOf(conclusion), restoredFailure.content.lastIndexOf(conclusion))
})

test('maximum Harness conclusion survives terminal persistence and authoritative restart repair', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const conclusion = 'x'.repeat(20000)
  const prefix = 'Codex failed: LOCAL_AGENT_PROCESS_FAILED'
  options.runLedger = new RunLedger({ storagePath: ledgerPath, now: () => 1000 })
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    for (let offset = 0; offset < conclusion.length; offset += 4000) {
      runOptions.onEvent({
        type: 'answer_delta', status: 'running', delta: conclusion.slice(offset, offset + 4000),
      })
    }
    throw new Error('LOCAL_AGENT_PROCESS_FAILED')
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Maximum terminal conclusion', agentKinds: ['codex'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id, text: 'Stream the maximum output', targetKinds: ['codex'],
  })

  const liveFailure = workspace.snapshot().messages.find(message => (
    message.system?.key === 'system.agentCallFailed'
  ))
  assert.equal(liveFailure.content, `${prefix}\n${conclusion}`)
  const persisted = JSON.parse(fs.readFileSync(options.storagePath, 'utf8'))
  const persistedFailure = persisted.messages.find(message => message.id === liveFailure.id)
  assert.equal(persistedFailure.content, liveFailure.content)

  persistedFailure.content = `${prefix}\n${conclusion.slice(0, 250)}`
  fs.writeFileSync(options.storagePath, `${JSON.stringify(persisted, null, 2)}\n`)

  const restored = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath, now: () => 2000 }),
  })
  const restoredFailure = restored.snapshot().messages.find(message => (
    message.trace?.agentRunId === liveFailure.trace.agentRunId
  ))
  assert.equal(restoredFailure.content, `${prefix}\n${conclusion}`)
  const repaired = JSON.parse(fs.readFileSync(options.storagePath, 'utf8'))
  assert.equal(
    repaired.messages.find(message => message.id === liveFailure.id).content,
    restoredFailure.content,
  )

  const repeated = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath, now: () => 3000 }),
  })
  assert.equal(
    repeated.snapshot().messages.find(message => message.id === liveFailure.id).content,
    `${prefix}\n${conclusion}`,
  )
})

test('restart reconciles every terminal Agent checkpoint with its real status and output', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const initial = new LocalWorkspace(options)
  await initial.refreshAgents()
  const group = initial.createGroup({
    name: 'Terminal checkpoint recovery', agentKinds: ['codex'], workdir: directory,
  })
  const root = initial.addMessage(group.id, 'user', 'Restore terminal attempts')
  const ledger = new RunLedger({ storagePath: ledgerPath, now: () => 1000 })
  ledger.checkpoint({
    runId: 'run-terminal',
    groupId: group.id,
    threadRootId: root.id,
    targetKinds: ['codex'],
    status: 'completed',
    agentRuns: [
      { agentRunId: 'agent-completed', kind: 'codex', status: 'completed', output: 'Completed output' },
      { agentRunId: 'agent-partial', kind: 'codex', status: 'partial', output: 'Partial output' },
      { agentRunId: 'agent-failed', kind: 'codex', status: 'failed', output: 'Failure output', reason: 'LOCAL_AGENT_UNKNOWN_FAILURE' },
      { agentRunId: 'agent-failed-other-output', kind: 'codex', status: 'failed', output: 'Distinct failure output', reason: 'LOCAL_AGENT_UNKNOWN_FAILURE' },
      { agentRunId: 'agent-failed-other-reason', kind: 'codex', status: 'failed', reason: 'LOCAL_AGENT_AUTH_FAILED' },
      { agentRunId: 'agent-timeout', kind: 'codex', status: 'timeout', output: 'Timeout output', reason: 'LOCAL_AGENT_TIMEOUT' },
      { agentRunId: 'agent-stopped', kind: 'codex', status: 'stopped', output: 'Stopped output' },
      { agentRunId: 'agent-interrupted', kind: 'codex', status: 'interrupted', output: 'Interrupted output' },
    ],
  })

  const restored = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath, now: () => 2000 }),
  })
  const byAgentRunId = new Map(restored.snapshot().messages
    .filter(message => message.trace?.agentRunId)
    .map(message => [message.trace.agentRunId, message]))

  assert.equal(byAgentRunId.get('agent-completed').role, 'agent')
  assert.equal(byAgentRunId.get('agent-completed').content, 'Completed output')
  assert.equal(byAgentRunId.get('agent-completed').trace.status, 'completed')
  assert.equal(byAgentRunId.get('agent-partial').role, 'agent')
  assert.equal(byAgentRunId.get('agent-partial').content, 'Partial output')
  assert.equal(byAgentRunId.get('agent-partial').trace.status, 'partial')
  assert.equal(byAgentRunId.get('agent-failed').system.key, 'system.agentCallFailed')
  assert.match(byAgentRunId.get('agent-failed').content, /Failure output/)
  assert.equal(byAgentRunId.get('agent-failed').trace.status, 'failed')
  assert.match(byAgentRunId.get('agent-failed-other-output').content, /Distinct failure output/)
  assert.equal(
    byAgentRunId.get('agent-failed-other-reason').system.params.reason,
    'LOCAL_AGENT_AUTH_FAILED',
  )
  assert.equal(byAgentRunId.get('agent-timeout').system.params.reason, 'LOCAL_AGENT_TIMEOUT')
  assert.match(byAgentRunId.get('agent-timeout').content, /Timeout output/)
  assert.equal(byAgentRunId.get('agent-timeout').trace.status, 'timeout')
  assert.equal(byAgentRunId.get('agent-stopped').system.key, 'system.agentStopped')
  assert.equal(byAgentRunId.get('agent-stopped').trace.status, 'stopped')
  assert.equal(byAgentRunId.get('agent-interrupted').system.key, 'system.agentInterrupted')
  assert.equal(byAgentRunId.get('agent-interrupted').trace.status, 'interrupted')

  const repeated = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath, now: () => 3000 }),
  })
  assert.equal(repeated.snapshot().messages.filter(message => (
    message.trace?.runId === 'run-terminal'
  )).length, 8)
})

test('stopping during output capture prevents the Agent from launching', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const captureEntered = deferred()
  const captureGate = deferred()
  options.runAbortGraceMs = 20
  let captureSignal
  options.captureAgentOutputs = async (_workdir, captureOptions) => {
    captureSignal = captureOptions.signal
    captureEntered.resolve()
    return await captureGate.promise
  }
  const finished = []
  const workspace = new LocalWorkspace(options)
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Stop during capture', agentKinds: ['codex'], workdir: directory,
  })

  const send = workspace.sendMessage({ groupId: group.id, text: 'Generate a file' })
  await captureEntered.promise
  const runId = workspace.activeRuns.get(group.id).runId
  assert.equal(workspace.stop(group.id, runId), true)
  await send

  assert.equal(captureSignal.aborted, true)
  assert.equal(calls.length, 0)
  assert.equal(finished[0].status, 'stopped')
  assert.equal(workspace.snapshot().messages.some(message => message.role === 'agent'), false)
  const stoppedTrace = workspace.snapshot().messages.find(message => (
    message.system?.key === 'system.agentStopped' && message.agentKind === 'codex'
  ))
  assert.equal(stoppedTrace.trace.status, 'stopped')
  assert.equal(stoppedTrace.trace.agentRunId.includes(runId), true)
  captureGate.resolve({ marker: 'late capture' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(workspace.snapshot().messages.some(message => message.role === 'agent'), false)
})

test('stopping during output import never persists the late completed reply', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const importEntered = deferred()
  const importGate = deferred()
  options.runAbortGraceMs = 20
  let importSignal
  options.importAgentOutputs = async (input) => {
    importSignal = input.signal
    importEntered.resolve()
    return await importGate.promise
  }
  const finished = []
  const workspace = new LocalWorkspace(options)
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Stop during import', agentKinds: ['codex'], workdir: directory,
  })

  const send = workspace.sendMessage({ groupId: group.id, text: 'Generate a file' })
  await importEntered.promise
  const runId = workspace.activeRuns.get(group.id).runId
  assert.equal(workspace.stop(group.id, runId), true)
  await send

  assert.equal(importSignal.aborted, true)
  assert.equal(finished[0].status, 'stopped')
  assert.equal(workspace.snapshot().messages.some(message => message.role === 'agent'), false)
  importGate.resolve([
    { id: 'late-image', name: 'late.png', mimeType: 'image/png', size: 10 },
  ])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(workspace.snapshot().messages.some(message => message.role === 'agent'), false)
})

test('a stopped run keeps the group lock until the Agent cleanup settles', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAbortGraceMs = 100
  const firstStarted = deferred()
  let attempts = 0
  let cleanupFinished = false
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    attempts += 1
    if (attempts > 1) return { text: 'Second run', sessionRef: 'codex-session-2' }
    return await new Promise((resolve, reject) => {
      runOptions.signal.addEventListener('abort', () => {
        setTimeout(() => {
          cleanupFinished = true
          reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED'))
        }, 30)
      }, { once: true })
      firstStarted.resolve()
    })
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Cleanup lock', agentKinds: ['codex'], workdir: directory,
  })

  const firstSend = workspace.sendMessage({ groupId: group.id, text: 'First run' })
  await firstStarted.promise
  const runId = workspace.activeRuns.get(group.id).runId
  assert.equal(workspace.stop(group.id, runId), true)
  await assert.rejects(
    workspace.sendMessage({ groupId: group.id, text: 'Too early' }),
    { message: 'LOCAL_GROUP_RUNNING' },
  )
  await firstSend

  assert.equal(cleanupFinished, true)
  await workspace.sendMessage({ groupId: group.id, text: 'Second run' })
  assert.equal(workspace.snapshot().messages.at(-1).content, 'Second run')
})

test('a stop acknowledgement keeps deletion blocked until run cleanup settles', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const started = deferred()
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => await new Promise((resolve, reject) => {
    started.resolve()
    runOptions.signal.addEventListener('abort', () => {
      setImmediate(() => reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED')))
    }, { once: true })
  })
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Stop then delete', agentKinds: ['codex'], workdir: directory,
  })

  const send = workspace.sendMessage({ groupId: group.id, text: 'Stop this run' })
  await started.promise
  const runId = workspace.activeRuns.get(group.id).runId
  assert.equal(workspace.stop(group.id, runId), true)
  assert.throws(() => workspace.deleteGroup(group.id), { message: 'LOCAL_GROUP_RUNNING' })

  await send
  assert.doesNotThrow(() => workspace.deleteGroup(group.id))
  assert.equal(workspace.snapshot().groups.some(item => item.id === group.id), false)
})

test('a stopped run keeps the group lock until output import cleanup settles', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAbortGraceMs = 100
  const importStarted = deferred()
  let attempts = 0
  let importCleanupFinished = false
  options.importAgentOutputs = async (input) => {
    attempts += 1
    if (attempts > 1) return []
    return await new Promise((resolve) => {
      input.signal.addEventListener('abort', () => {
        setTimeout(() => {
          importCleanupFinished = true
          resolve([])
        }, 30)
      }, { once: true })
      importStarted.resolve()
    })
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Import cleanup lock', agentKinds: ['codex'], workdir: directory,
  })

  const firstSend = workspace.sendMessage({ groupId: group.id, text: 'First import' })
  await importStarted.promise
  const runId = workspace.activeRuns.get(group.id).runId
  assert.equal(workspace.stop(group.id, runId), true)
  await assert.rejects(
    workspace.sendMessage({ groupId: group.id, text: 'Too early' }),
    { message: 'LOCAL_GROUP_RUNNING' },
  )
  await firstSend

  assert.equal(importCleanupFinished, true)
  await workspace.sendMessage({ groupId: group.id, text: 'After cleanup' })
  assert.equal(workspace.snapshot().messages.some(message => (
    message.role === 'user' && message.content === 'After cleanup'
  )), true)
})

test('the Agent watchdog covers output capture and import phases', async (t) => {
  const phases = ['capture', 'import']
  for (const phase of phases) {
    await t.test(phase, async (subtest) => {
      const { directory, calls, options } = fixture()
      subtest.after(() => fs.rmSync(directory, { recursive: true, force: true }))
      options.runAgentTimeoutMs = 8
      options.runAbortGraceMs = 20
      if (phase === 'capture') options.captureAgentOutputs = async () => await new Promise(() => {})
      else options.importAgentOutputs = async () => await new Promise(() => {})
      const finished = []
      const workspace = new LocalWorkspace(options)
      workspace.on('run-finished', result => finished.push(result))
      await workspace.refreshAgents()
      const group = workspace.createGroup({
        name: `Watchdog ${phase}`, agentKinds: ['codex'], workdir: directory,
      })

      await workspace.sendMessage({ groupId: group.id, text: 'Do not hang' })

      assert.equal(calls.length, phase === 'capture' ? 0 : 1)
      assert.equal(finished[0].status, 'timeout')
      const failure = workspace.snapshot().messages.find(message => (
        message.system?.key === 'system.agentCallFailed'
      ))
      assert.equal(failure.system.params.reason, 'LOCAL_AGENT_TIMEOUT')
      assert.equal(failure.trace.status, 'timeout')
      assert.equal(workspace.snapshot().messages.some(message => message.role === 'agent'), false)
    })
  }
})

test('session references stay opaque and OpenClaw group scopes do not collide', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const privateSessionRef = '/Users/private/token=secret'
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    runOptions.onSessionRef(privateSessionRef)
    return { text: 'Safe reply', sessionRef: privateSessionRef }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Opaque sessions', agentKinds: ['codex'], workdir: directory,
  })

  await workspace.sendMessage({ groupId: group.id, text: 'Keep the session private' })

  assert.equal(workspace.state.sessions[workspace.sessionKey(group.id, 'codex')], undefined)
  assert.doesNotMatch(fs.readFileSync(options.storagePath, 'utf8'), /Users\/private|token=secret/)
  assert.equal(workspace.persistSessionRef(
    workspace.sessionKey(group.id, 'codex'),
    'sk-abcdefghijklmnop1234',
  ), false)
  const first = workspace.openClawSessionRef({ id: 'group-abcdefghijkl-1' })
  const second = workspace.openClawSessionRef({ id: 'group-abcdefghijkl-2' })
  assert.notEqual(first, second)
  assert.match(first, /^agent:main:desktop-roundrelay-[a-f0-9]{20}-openclaw$/)
  assert.match(second, /^agent:main:desktop-roundrelay-[a-f0-9]{20}-openclaw$/)

  const legacyGroup = { id: 'group-abcdefghijkl-1' }
  const legacyKey = workspace.sessionKey(legacyGroup.id, 'openclaw')
  workspace.state.sessions[legacyKey] = 'agent:main:desktop-roundrelay-groupabcdefg-openclaw'
  workspace.state.sessionMeta[legacyKey] = { turns: 4, estimatedChars: 1200 }
  assert.equal(workspace.sessionRef(legacyGroup, 'openclaw'), first)
  assert.equal(workspace.state.sessionMeta[legacyKey], undefined)
})
