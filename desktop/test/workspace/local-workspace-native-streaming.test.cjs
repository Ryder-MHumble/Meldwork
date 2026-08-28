const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const {
  createRuntimeEventEmitter,
} = require('../../src/agents/cli/cli-runtime-event-sanitizer.cjs')
const { fixture } = require('../support/local-workspace-test-helpers.cjs')

test('direct Hermes conversations reuse one persistent ACP runtime key across messages', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.detectAgents = async () => [{
    kind: 'hermes', name: 'Hermes CLI', executable: '/tmp/hermes', version: '2',
    acpAvailable: true,
  }]
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    const sessionRef = runOptions.sessionRef || 'hermes-acp-session'
    await runOptions.onSessionRef(sessionRef, { transport: 'acp' })
    return { text: `reply ${calls.length}`, sessionRef, outcome: 'completed' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Hermes ACP direct', agentKinds: ['hermes'], workdir: directory,
    conversationType: 'direct', directAgentKind: 'hermes',
  })

  await workspace.sendMessage({ groupId: group.id, text: 'first' })
  await workspace.sendMessage({ groupId: group.id, text: 'second' })

  assert.deepEqual(calls.map(call => call.runOptions.sessionRef), ['', 'hermes-acp-session'])
  assert.deepEqual(calls.map(call => call.runOptions.sessionTransport), ['', 'acp'])
  assert.deepEqual(calls.map(call => call.runOptions.hermesAcpAvailable), [true, true])
  assert.equal(typeof calls[0].runOptions.acpPersistenceKey, 'string')
  assert.equal(calls[0].runOptions.acpPersistenceKey.length > 0, true)
  assert.equal(calls[1].runOptions.acpPersistenceKey, calls[0].runOptions.acpPersistenceKey)
})

test('group OpenCode conversations reuse one persistent ACP runtime key across rounds', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.detectAgents = async () => [
    { kind: 'codex', name: 'Codex CLI', executable: '/tmp/codex', version: '1' },
    { kind: 'opencode', name: 'OpenCode CLI', executable: '/tmp/opencode', version: '1' },
  ]
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    const sessionRef = runOptions.sessionRef || `${agent.kind}-acp-session`
    if (agent.kind === 'opencode') {
      await runOptions.onSessionRef(sessionRef, { transport: 'acp' })
    }
    return { text: `reply ${calls.length}`, sessionRef, outcome: 'completed' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'OpenCode ACP group', agentKinds: ['codex', 'opencode'], workdir: directory,
  })

  await workspace.sendMessage({ groupId: group.id, text: 'first', mode: 'auto', maxRounds: 2 })
  await workspace.activeRuns.get(group.id)?.promise

  const opencodeCalls = calls.filter(call => call.agent.kind === 'opencode')
  assert.deepEqual(opencodeCalls.map(call => call.runOptions.sessionRef), ['', 'opencode-acp-session'])
  assert.deepEqual(opencodeCalls.map(call => call.runOptions.sessionTransport), ['', 'acp'])
  assert.equal(typeof opencodeCalls[0].runOptions.acpPersistenceKey, 'string')
  assert.equal(opencodeCalls[1].runOptions.acpPersistenceKey, opencodeCalls[0].runOptions.acpPersistenceKey)
})

test('Workspace stream bridge redacts split credentials and paths while preserving tools', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const credential = 'workspace-stream-secret-value'
  const privatePath = '/Users/private/workspace/result.txt'
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    const runtimeEvents = createRuntimeEventEmitter(
      { onEvent: runOptions.onEvent },
      { WORKSPACE_STREAM_API_KEY: credential },
    )
    runtimeEvents.emit({
      type: 'answer_delta', status: 'running', delta: 'Credential workspace-stream-sec',
    })
    runtimeEvents.emit({
      type: 'answer_delta', status: 'running',
      delta: 'ret-value stored at /Users/private/work',
    })
    runtimeEvents.emit({
      type: 'answer_delta', status: 'running', delta: 'space/result.txt ready',
    })
    runtimeEvents.emit({
      id: 'workspace-tool', type: 'tool_start', status: 'running', title: 'Inspect',
      summary: `credential=${credential}`, detail: `Opening ${privatePath}`,
    })
    runtimeEvents.emit({
      id: 'workspace-tool', type: 'tool_update', status: 'running', title: 'Inspect',
      summary: `Reading ${privatePath}`,
    })
    runtimeEvents.emit({
      id: 'workspace-tool', type: 'tool_result_summary', status: 'completed', title: 'Inspect',
      summary: 'Inspection complete', detail: `credential=${credential}\nSaved ${privatePath}`,
    })
    runtimeEvents.emitFinalAnswer(
      `Credential ${credential} stored at ${privatePath} ready`,
    )
    return { text: 'Streaming review complete', sessionRef: 'codex-session', outcome: 'completed' }
  }
  const liveEvents = []
  const workspace = new LocalWorkspace(options)
  workspace.on('run-event', event => liveEvents.push(event))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Native stream bridge', agentKinds: ['codex'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id, text: 'Inspect the streamed output', targetKinds: ['codex'],
  })

  const streamed = liveEvents.filter(event => event.type === 'answer_delta')
    .reduce(
      (answer, event) => event.replace === true ? event.delta : answer + event.delta,
      '',
    )
  assert.equal(streamed, 'Credential [redacted] stored at [path] ready')
  assert.deepEqual(
    liveEvents.filter(event => event.id === 'workspace-tool').map(event => event.type),
    ['tool_start', 'tool_update', 'tool_result_summary'],
  )
  const message = workspace.snapshot().messages.find(item => item.role === 'agent')
  const traceTools = message.trace.events.filter(event => event.type.startsWith('tool_'))
  assert.deepEqual(
    traceTools.map(event => event.type),
    ['tool_result_summary'],
  )
  assert.equal(traceTools.every(event => /^E-R0-CODEX-\d{2}$/.test(event.evidenceId)), true)
  const exposed = JSON.stringify({ liveEvents, trace: message.trace })
  assert.doesNotMatch(exposed, /workspace-stream-secret-value|\/Users\/private\/workspace/)
  assert.match(exposed, /\[redacted\]/)
  assert.match(exposed, /\[path\]/)
})
