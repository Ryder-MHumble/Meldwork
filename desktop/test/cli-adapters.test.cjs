const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const {
  detectAgents,
  imageAttachmentLimit,
  invocation,
  normalizeOutput,
  parseCodexOutput,
  parseGeminiOutput,
  parseKimiOutput,
  parseMimoOutput,
  parseOpenCodeOutput,
  parseWorkBuddyOutput,
  prepareCommand,
  readHermesFinalResponse,
  readHermesMessageWatermark,
  resolveExecutable,
  runAgent,
  runtimeCommandSummary,
  searchPath,
} = require('../src/cli-adapters.cjs')
const { managedOpenClawOptions } = require('../src/openclaw-runtime.cjs')
const {
  executable,
  readJsonWhenReady,
  readWhenReady,
  waitForExit,
  within,
} = require('./cli-adapters-test-helpers.cjs')

test('new Codex sessions persist and default to the read-only sandbox', (t) => {
  const previous = process.env.ROUNDRELAY_CODEX_SANDBOX
  delete process.env.ROUNDRELAY_CODEX_SANDBOX
  t.after(() => {
    if (previous == null) delete process.env.ROUNDRELAY_CODEX_SANDBOX
    else process.env.ROUNDRELAY_CODEX_SANDBOX = previous
  })
  const spec = invocation('codex', '/tmp/codex', '/tmp/work')
  assert.equal(spec.stdin, true)
  assert.deepEqual(spec.args.slice(0, 2), ['exec', '--json'])
  assert.equal(spec.args.includes('--ephemeral'), false)
  assert.ok(spec.args.includes('read-only'))
  assert.equal(spec.args.at(-1), '-')
})

test('Codex accepts workspace-write only as an explicit per-call sandbox', () => {
  const spec = invocation('codex', '/tmp/codex', '/tmp/work', '', {
    sandbox: 'workspace-write',
  })
  assert.ok(spec.args.includes('workspace-write'))
  assert.throws(
    () => invocation('codex', '/tmp/codex', '/tmp/work', '', { sandbox: 'danger-full-access' }),
    { message: 'CODEX_SANDBOX_UNSUPPORTED' },
  )
})

test('unsafe Codex sandbox environment values fall back to read-only', (t) => {
  const previous = process.env.ROUNDRELAY_CODEX_SANDBOX
  process.env.ROUNDRELAY_CODEX_SANDBOX = 'danger-full-access'
  t.after(() => {
    if (previous == null) delete process.env.ROUNDRELAY_CODEX_SANDBOX
    else process.env.ROUNDRELAY_CODEX_SANDBOX = previous
  })
  const spec = invocation('codex', '/tmp/codex', '/tmp/work')
  assert.ok(spec.args.includes('read-only'))
  assert.equal(spec.args.includes('danger-full-access'), false)
})

test('Codex resume uses the native session id with the current sandbox', () => {
  const spec = invocation('codex', '/tmp/codex', '/tmp/work', 'thread-123')
  assert.deepEqual(spec.args, [
    'exec', 'resume', '--json', '--skip-git-repo-check',
    '-c', 'sandbox_mode="read-only"', 'thread-123', '-',
  ])

  const writable = invocation('codex', '/tmp/codex', '/tmp/work', 'thread-123', {
    sandbox: 'workspace-write',
  })
  assert.deepEqual(writable.args, [
    'exec', 'resume', '--json', '--skip-git-repo-check',
    '-c', 'sandbox_mode="workspace-write"', 'thread-123', '-',
  ])
})

test('Codex forwards every validated image to new and resumed sessions', () => {
  const first = path.resolve('diagram-one.png')
  const second = path.resolve('diagram-two.jpg')
  const created = invocation('codex', '/tmp/codex', '/tmp/work', '', {
    attachments: [first, second],
  })
  assert.deepEqual(created.args, [
    'exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only',
    '-C', '/tmp/work', '--image', first, '--image', second, '-',
  ])

  const resumed = invocation('codex', '/tmp/codex', '/tmp/work', 'thread-123', {
    attachments: [first],
  })
  assert.deepEqual(resumed.args, [
    'exec', 'resume', '--json', '--skip-git-repo-check',
    '-c', 'sandbox_mode="read-only"', '--image', first, 'thread-123', '-',
  ])
})

test('Codex JSONL output returns the reply and session id', () => {
  const output = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-123' }),
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: '第一段' },
    }),
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: '第二段' },
    }),
  ].join('\n')
  assert.deepEqual(parseCodexOutput(output), {
    text: '第一段\n第二段',
    sessionRef: 'thread-123',
  })
})

test('runtime command summaries unwrap one shell layer without exposing arguments', () => {
  assert.equal(
    runtimeCommandSummary('zsh -lc "ls /Users/private/workspace | head -5"'),
    'ls (1 hidden argument) | head -5',
  )
  assert.equal(
    runtimeCommandSummary("/bin/bash -c 'git status --short'"),
    'git status --short',
  )
  assert.equal(runtimeCommandSummary('zsh -c pwd'), 'pwd')
  const secretSummary = runtimeCommandSummary(
    "sh -c 'curl --header \"Authorization: Bearer private-token\" https://user:pass@example.test/private'",
  )
  assert.equal(secretSummary, 'curl --header (2 hidden arguments)')
  assert.doesNotMatch(secretSummary, /private-token|user|pass|example|private/i)

  const assignmentSummary = runtimeCommandSummary(
    'API_KEY="top secret value" TOKEN=unquoted-secret curl https://example.test',
  )
  assert.equal(assignmentSummary, 'curl (1 hidden argument)')
  assert.doesNotMatch(assignmentSummary, /top|secret|value|example/i)

  assert.equal(
    runtimeCommandSummary('printf one\nrm -rf /tmp/private'),
    'printf (1 hidden argument) ; rm (2 hidden arguments)',
  )
  assert.equal(
    runtimeCommandSummary('printf one > /tmp/out && curl https://example.test'),
    'printf (1 hidden argument) && curl (1 hidden argument)',
  )
})

test('runAgent streams sanitized Codex operations and result summaries before the final reply', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-codex-progress-'))
  const cli = executable(directory, 'codex-progress.cjs', `
const events = [
  { type: 'thread.started', thread_id: 'thread-progress' },
  { type: 'turn.started' },
  {
    type: 'item.started',
    item: {
      id: 'item-search', type: 'command_execution',
      command: 'rg -n -pSuperSecret targetKinds /Users/private/workspace', status: 'in_progress',
    },
  },
  {
    type: 'item.completed',
    item: {
      id: 'item-search', type: 'command_execution',
      command: 'rg -n -pSuperSecret targetKinds /Users/private/workspace',
      aggregated_output: 'frontend/src/App.vue:2652: targetKinds\\nAWS_ACCESS_KEY_ID=AKIA1234567890ABCDEF\\n',
      exit_code: 0, status: 'completed',
    },
  },
  {
    type: 'item.started',
    item: {
      id: 'item-shell', type: 'command_execution', command: 'zsh -c pwd', status: 'in_progress',
    },
  },
  {
    type: 'item.completed',
    item: {
      id: 'item-shell', type: 'command_execution', command: 'zsh -c pwd',
      aggregated_output: '/Users/private/workspace\\n', exit_code: 0, status: 'completed',
    },
  },
  {
    type: 'item.started',
    item: { id: 'item-image', type: 'image_generation', status: 'in_progress' },
  },
  {
    type: 'item.completed',
    item: { id: 'item-image', type: 'image_generation', status: 'completed' },
  },
  {
    type: 'item.completed',
    item: { id: 'item-message', type: 'agent_message', text: 'final reply' },
  },
  { type: 'turn.completed' },
]
let index = 0
function send() {
  if (index >= events.length) return
  const line = JSON.stringify(events[index++]) + '\\n'
  const split = Math.max(1, Math.floor(line.length / 2))
  process.stdout.write(line.slice(0, split))
  setTimeout(() => {
    process.stdout.write(line.slice(split))
    if (index >= events.length) return setTimeout(() => process.exit(0), 25)
    setTimeout(send, 25)
  }, 10)
}
send()
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const progress = []
  const events = []
  let firstProgressResolve
  const firstProgress = new Promise(resolve => { firstProgressResolve = resolve })
  let answerEventResolve
  const answerEvent = new Promise(resolve => { answerEventResolve = resolve })
  let resultResolved = false
  const resultPromise = runAgent(
    { kind: 'codex', executable: cli, name: 'Codex' },
    'hello',
    directory,
    {
      onProgress: step => {
        progress.push(step)
        firstProgressResolve()
      },
      onEvent: event => {
        events.push(event)
        if (event.type === 'answer_delta') answerEventResolve()
      },
    },
  ).then((result) => {
    resultResolved = true
    return result
  })

  await within(firstProgress)
  assert.equal(progress.length > 0, true)
  await within(answerEvent)
  assert.equal(resultResolved, false)
  const result = await resultPromise

  assert.equal(result.text, 'final reply')
  assert.equal(result.sessionRef, 'thread-progress')
  assert.deepEqual(result.progress, [
    { id: 'turn', title: 'process', status: 'completed' },
    { id: 'item-search', title: 'search', status: 'completed' },
    { id: 'item-shell', title: 'Bash', status: 'completed' },
    { id: 'item-image', title: 'image_generation', status: 'completed' },
  ])
  assert.equal(progress.some(step => step.id === 'item-search' && step.status === 'in_progress'), true)
  assert.equal(progress.some(step => step.id === 'item-search' && step.status === 'completed'), true)
  assert.doesNotMatch(JSON.stringify(progress), /Users|workspace|rg -n/)
  assert.deepEqual(events.map(event => [event.type, event.status]), [
    ['tool_start', 'running'],
    ['tool_result_summary', 'completed'],
    ['tool_start', 'running'],
    ['tool_result_summary', 'completed'],
    ['tool_start', 'running'],
    ['tool_result_summary', 'completed'],
    ['answer_delta', 'running'],
  ])
  assert.equal(events.some(event => event.type === 'status' || event.title === 'process'), false)
  assert.equal(events.find(event => event.type === 'answer_delta')?.delta, 'final reply')
  const commandResult = events.find(event => (
    event.type === 'tool_result_summary' && event.id === 'item-search'
  ))
  assert.equal(commandResult.summary, 'Bash: operation: rg -n (3 hidden arguments)')
  assert.match(commandResult.detail, /Exit code: 0/)
  assert.match(commandResult.detail, /Output: 2 lines/)
  assert.doesNotMatch(commandResult.detail, /frontend\/src\/App\.vue/)
  assert.doesNotMatch(commandResult.detail, /AKIA1234567890ABCDEF/)
  const shellResult = events.find(event => (
    event.type === 'tool_result_summary' && event.id === 'item-shell'
  ))
  assert.equal(shellResult.title, 'Bash')
  assert.equal(shellResult.summary, 'Bash: operation: pwd')
  assert.match(shellResult.detail, /Exit code: 0/)
  assert.doesNotMatch(shellResult.detail, /Users|private|workspace/)
  assert.equal(events.every(event => Object.keys(event).every(key => (
    ['id', 'type', 'status', 'title', 'summary', 'detail', 'delta'].includes(key)
  ))), true)
  assert.doesNotMatch(
    JSON.stringify(events),
    /Users|private\/workspace|AKIA1234567890ABCDEF|SuperSecret/,
  )
})

test('Hermes starts ACP sessions but keeps unmarked historical sessions on the legacy transport', () => {
  const created = invocation('hermes', '/tmp/hermes', '/tmp')
  assert.deepEqual(created.args, ['acp'])
  assert.equal(created.acpMode, 'default')
  assert.equal(created.promptArg, undefined)

  const resumed = invocation('hermes', '/tmp/hermes', '/tmp', 'hermes-session-123', {
    sessionTransport: 'acp',
  })
  assert.deepEqual(resumed.args, ['acp'])
  assert.equal(resumed.acpMode, 'default')

  const legacy = invocation('hermes', '/tmp/hermes', '/tmp', 'hermes-session-123')
  assert.deepEqual(legacy.args, [
    'chat', '--quiet', '--resume', 'hermes-session-123', '--query',
  ])

  const writable = invocation('hermes', '/tmp/hermes', '/tmp', 'hermes-session-123', {
    sandbox: 'workspace-write',
    sessionTransport: 'acp',
  })
  assert.deepEqual(writable.args, ['acp'])
  assert.equal(writable.acpMode, 'accept_edits')
})

test('Hermes falls back to legacy quiet mode when ACP startup fails before the prompt', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-hermes-acp-fallback-'))
  const cli = executable(directory, 'hermes-acp-fallback.cjs', `
if (process.argv[2] !== 'chat' || !process.argv.includes('--quiet') || process.argv.includes('acp')) {
  process.stderr.write('expected legacy quiet mode')
  process.exit(2)
}
process.stdout.write('\\u001b[36mHermes legacy fallback\\u001b[0m\\n')
process.stderr.write('session_id: hermes-fallback-session\\n')
`)
  const events = []
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const result = await runAgent(
    { kind: 'hermes', executable: cli, name: 'Hermes' },
    'hello',
    directory,
    {
      loadAcpSdkFn: async () => { throw new Error('ACP SDK unavailable') },
      hermesMessageWatermarkFn: () => null,
      onEvent: event => events.push(event),
    },
  )

  assert.deepEqual(result, {
    text: 'Hermes legacy fallback',
    sessionRef: 'hermes-fallback-session',
    outcome: 'completed',
  })
  assert.deepEqual(events[0], {
    id: 'hermes-acp-fallback',
    type: 'warning',
    status: 'waiting',
    title: 'connector_fallback',
  })
  assert.deepEqual(events[1], {
    id: 'hermes-connector',
    type: 'warning',
    status: 'waiting',
    title: 'connector_limited',
  })
})

test('Hermes invalidates a stale ACP session and rebuilds the legacy fallback prompt', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-hermes-acp-resume-fallback-'))
  const cli = executable(directory, 'hermes-acp-resume-fallback.cjs', `
if (process.argv[2] === 'acp') {
  const readline = require('node:readline')
  const input = readline.createInterface({ input: process.stdin })
  const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
  input.on('line', (line) => {
    const message = JSON.parse(line)
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
    } else if (message.method === 'session/resume') {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'session missing' } })
    }
  })
} else {
  if (process.argv[2] !== 'chat' || !process.argv.includes('--quiet') || process.argv.includes('--resume')) {
    process.stderr.write('expected a fresh legacy session')
    process.exit(2)
  }
  process.stdout.write(process.argv.at(-1) + '\\n')
  process.stderr.write('session_id: hermes-recovered-session\\n')
}
`)
  const invalidations = []
  const events = []
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const result = await runAgent(
    { kind: 'hermes', executable: cli, name: 'Hermes' },
    'incremental prompt',
    directory,
    {
      sessionRef: 'hermes-stale-session',
      sessionTransport: 'acp',
      hermesMessageWatermarkFn: () => null,
      onSessionInvalidated: (metadata) => {
        invalidations.push(metadata)
        return { prompt: 'rebuilt full context' }
      },
      onEvent: event => events.push(event),
    },
  )

  assert.deepEqual(result, {
    text: 'rebuilt full context',
    sessionRef: 'hermes-recovered-session',
    outcome: 'completed',
  })
  assert.deepEqual(invalidations, [{
    kind: 'hermes',
    sessionRef: 'hermes-stale-session',
    transport: 'acp',
  }])
  assert.equal(events.some(event => event.title === 'connector_fallback'), true)
})

test('Hermes ACP streams only the current turn after resume history replay', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-hermes-acp-'))
  const modeFile = path.join(directory, 'mode.txt')
  const cli = executable(directory, 'hermes-acp.cjs', `
const fs = require('node:fs')
const readline = require('node:readline')
const input = readline.createInterface({ input: process.stdin })
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
const update = (sessionId, value) => send({
  jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value },
})
input.on('line', (line) => {
  const message = JSON.parse(line)
  const sessionId = message.params?.sessionId || 'hermes-session'
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  } else if (message.method === 'session/resume') {
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'previous answer' },
    })
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/set_mode') {
    fs.writeFileSync(process.env.ROUNDRELAY_TEST_MODE_FILE, message.params.modeId)
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/prompt') {
    update(sessionId, {
      sessionUpdate: 'plan',
      entries: [{ content: 'Inspect workspace', priority: 'medium', status: 'in_progress' }],
    })
    update(sessionId, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'PRIVATE_REASONING' },
    })
    update(sessionId, {
      sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'search',
      kind: 'search', status: 'in_progress',
      rawInput: { query: 'targetKinds', AWS_SECRET_ACCESS_KEY: 'aws-secret-value' },
    })
    update(sessionId, {
      sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', title: 'search',
      kind: 'search', status: 'completed', rawOutput: { matches: 2, password: 'hunter2' },
    })
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'current ' },
    })
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' },
    })
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late replay' },
    })
  }
})
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const events = []
  const sessionMetadata = []

  const result = await runAgent(
    { kind: 'hermes', executable: cli, name: 'Hermes' },
    'current prompt',
    directory,
    {
      sessionRef: 'hermes-session',
      sessionTransport: 'acp',
      env: { ROUNDRELAY_TEST_MODE_FILE: modeFile },
      onEvent: event => events.push(event),
      onSessionRef: (sessionRef, metadata) => sessionMetadata.push({ sessionRef, metadata }),
    },
  )

  assert.equal(result.text, 'current answer')
  assert.equal(result.sessionRef, 'hermes-session')
  assert.equal(result.outcome, 'completed')
  assert.equal(fs.readFileSync(modeFile, 'utf8'), 'default')
  assert.equal(events.filter(event => event.type === 'answer_delta')
    .map(event => event.delta).join(''), 'current answer')
  assert.deepEqual(events.slice(0, 3).map(event => [event.type, event.status]), [
    ['plan', 'running'],
    ['tool_start', 'running'],
    ['tool_result_summary', 'completed'],
  ])
  assert.match(events.find(event => event.type === 'plan')?.summary || '', /Inspect workspace/)
  const toolResult = events.find(event => event.type === 'tool_result_summary')
  assert.match(toolResult.summary, /query: text \(11 chars\)/)
  assert.match(toolResult.detail, /matches/)
  assert.doesNotMatch(
    JSON.stringify(events),
    /previous answer|late replay|PRIVATE_REASONING|targetKinds|aws-secret-value|hunter2/,
  )
  assert.deepEqual(sessionMetadata, [{
    sessionRef: 'hermes-session', metadata: { transport: 'acp' },
  }])
})

test('Hermes normalizes official quiet stdout as the fallback reply', () => {
  assert.deepEqual(normalizeOutput(
    'hermes',
    '\u001b[32mHermes process output\u001b[0m\n',
    'hermes-session-123',
  ), {
    text: 'Hermes process output',
    sessionRef: 'hermes-session-123',
    outcome: 'completed',
  })
})

test('Hermes ACP keeps explicit Provider credentials out of process arguments', () => {
  const spec = invocation('hermes', '/tmp/hermes', '/tmp', '', {
    provider: { id: 'openai-api', model: 'glm' },
  })
  assert.deepEqual(spec.args, ['acp'])
  assert.equal(spec.acpMode, 'default')
  assert.equal(spec.args.some(value => value.includes('test-secret')), false)
})

test('Hermes preloads validated selected skills through its native CLI flags', () => {
  const spec = invocation('hermes', '/tmp/hermes', '/tmp', 'hermes-session-123', {
    skills: ['research', 'code-review', 'research'],
  })
  assert.deepEqual(spec.args, [
    'chat', '--quiet',
    '--skills', 'research',
    '--skills', 'code-review',
    '--resume', 'hermes-session-123',
    '--query',
  ])
  assert.throws(
    () => invocation('hermes', '/tmp/hermes', '/tmp', '', { skills: ['../private'] }),
    { message: 'LOCAL_SKILL_SELECTION_INVALID' },
  )
  assert.throws(
    () => invocation('hermes', '/tmp/hermes', '/tmp', '', {
      skills: ['one', 'two', 'three', 'four', 'five'],
    }),
    { message: 'LOCAL_SKILL_LIMIT' },
  )
})

test('Hermes forwards one image and rejects additional images instead of dropping them', () => {
  const first = path.resolve('diagram-one.png')
  const second = path.resolve('diagram-two.png')
  const spec = invocation('hermes', '/tmp/hermes', '/tmp', '', {
    attachments: [first],
  })
  assert.deepEqual(spec.args, [
    'chat', '--quiet', '--image', first, '--query',
  ])
  assert.throws(
    () => invocation('hermes', '/tmp/hermes', '/tmp', '', {
      attachments: [first, second],
    }),
    { message: 'LOCAL_AGENT_IMAGE_LIMIT' },
  )
})

test('image capability rejects unsupported Agents and malformed paths before spawning', () => {
  assert.equal(imageAttachmentLimit('codex'), 4)
  assert.equal(imageAttachmentLimit('hermes'), 1)
  assert.equal(imageAttachmentLimit('opencode'), 4)
  assert.equal(imageAttachmentLimit('claude'), 0)
  assert.throws(
    () => invocation('claude', '/tmp/claude', '/tmp', '', {
      attachments: [path.resolve('diagram.png')],
    }),
    { message: 'LOCAL_AGENT_IMAGE_UNSUPPORTED' },
  )
  assert.throws(
    () => invocation('codex', '/tmp/codex', '/tmp', '', {
      attachments: ['relative.png'],
    }),
    { message: 'LOCAL_ATTACHMENT_REFERENCE_INVALID' },
  )
})

test('runAgent enables Hermes non-interactive execution only for workspace write mode', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-hermes-env-'))
  const resultFile = path.join(directory, 'hermes-env-result.json')
  const cli = executable(directory, 'hermes-env.cjs', `
const fs = require('node:fs')
fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({
  ask: process.env.HERMES_EXEC_ASK,
  yolo: process.env.HERMES_YOLO_MODE,
}))
process.stderr.write('session_id: hermes-env-session\\n')
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let finalLookup

  const result = await runAgent(
    { kind: 'hermes', executable: cli, name: 'Hermes' },
    'hello',
    directory,
    {
      home: directory,
      sandbox: 'workspace-write',
      skills: ['legacy-test'],
      env: { HERMES_EXEC_ASK: '0', HERMES_YOLO_MODE: '1' },
      hermesMessageWatermarkFn: () => 0,
      hermesFinalResponseFn: (sessionRef, lookupOptions) => {
        finalLookup = { sessionRef, lookupOptions }
        return fs.readFileSync(resultFile, 'utf8')
      },
    },
  )

  assert.deepEqual(JSON.parse(result.text), { ask: '', yolo: '1' })
  assert.equal(finalLookup.sessionRef, 'hermes-env-session')
  assert.equal(finalLookup.lookupOptions.afterMessageId, 0)
})

test('runAgent restores the Hermes session id reported on successful stderr', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-hermes-session-'))
  const cli = executable(directory, 'hermes-session.cjs', `
process.stdout.write('Hermes reply')
process.stderr.write('diagnostic\\nsession_id: hermes-session-123\\n')
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const result = await runAgent(
    { kind: 'hermes', executable: cli, name: 'Hermes' },
    'hello',
    directory,
    {
      home: directory,
      skills: ['legacy-test'],
      hermesMessageWatermarkFn: () => 23,
      hermesFinalResponseFn: () => 'Hermes reply',
    },
  )

  assert.deepEqual(result, {
    text: 'Hermes reply',
    sessionRef: 'hermes-session-123',
    outcome: 'completed',
  })
})

test('runAgent prefers the authoritative Hermes reply and keeps stderr progress out of content', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-hermes-final-'))
  const cli = executable(directory, 'hermes-final.cjs', `
process.stdout.write('┊ planning\\nnoisy stdout fallback')
process.stderr.write('┊ review diff\\na//tmp/report.py → b//tmp/report.py\\n@@ -0,0 +1 @@\\n+tool trace\\nsession_id: hermes-session-final\\n')
  `)
  const progress = []
  let finalLookup
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const result = await runAgent(
    { kind: 'hermes', executable: cli, name: 'Hermes' },
    'hello',
    directory,
    {
      env: { OPENAI_API_KEY: 'test-secret-value' },
      skills: ['legacy-test'],
      onProgress: step => progress.push(step),
      hermesMessageWatermarkFn: () => 41,
      hermesFinalResponseFn: (sessionRef, lookupOptions) => {
        finalLookup = { sessionRef, lookupOptions }
        return sessionRef === 'hermes-session-final'
          ? 'Hermes authoritative final test-secret-value'
          : ''
      },
    },
  )

  assert.deepEqual(result, {
    text: 'Hermes authoritative final [redacted]',
    sessionRef: 'hermes-session-final',
    outcome: 'completed',
    progress: [{ title: 'write_file', status: 'completed' }],
  })
  assert.deepEqual(progress, [{ title: 'write_file', status: 'completed' }])
  assert.equal(finalLookup.sessionRef, 'hermes-session-final')
  assert.equal(finalLookup.lookupOptions.afterMessageId, 41)
  assert.doesNotMatch(result.text, /review diff|tool trace|noisy stdout|test-secret-value/)
})

test('Hermes final lookup accepts post-watermark stop and length rows through a read-only query seam', () => {
  const rows = [
    {
      id: 40, session_id: 'session-1', role: 'assistant',
      content: 'previous turn final', finish_reason: 'stop',
    },
    {
      id: 41, session_id: 'session-1', role: 'assistant',
      content: 'current process draft', finish_reason: 'tool_calls',
    },
  ]
  const queries = []
  const queryFn = (query) => {
    queries.push(query)
    if (/MAX\(id\)/.test(query.sql)) return { max_id: 40 }
    const [sessionRef, afterMessageId] = query.params
    return rows
      .filter(row => row.session_id === sessionRef
        && row.id > afterMessageId
        && row.role === 'assistant'
        && ['stop', 'length'].includes(row.finish_reason)
        && row.content.trim())
      .sort((left, right) => right.id - left.id)[0]
  }
  const stateOptions = {
    home: '/virtual/hermes-home',
    existsFn: () => true,
    queryFn,
  }

  const watermark = readHermesMessageWatermark(stateOptions)
  assert.equal(watermark, 40)
  assert.equal(readHermesFinalResponse('session-1', {
    ...stateOptions, afterMessageId: watermark,
  }), '')

  rows.push({
    id: 42, session_id: 'session-1', role: 'assistant',
    content: 'token-limited current final', finish_reason: 'length',
  })
  assert.equal(readHermesFinalResponse('session-1', {
    ...stateOptions, afterMessageId: watermark,
  }), 'token-limited current final')
  rows.push({
    id: 43, session_id: 'session-1', role: 'assistant',
    content: 'authoritative current final', finish_reason: 'stop',
  })
  assert.equal(readHermesFinalResponse('session-1', {
    ...stateOptions, afterMessageId: watermark,
  }), 'authoritative current final')
  assert.equal(queries.every(query => query.readOnly === true), true)
  assert.match(queries.at(-1).sql, /id > \?/)
  assert.match(queries.at(-1).sql, /finish_reason IN \('stop', 'length'\)/)
  assert.deepEqual(queries.at(-1).params, ['session-1', 40])

  const failedQuery = () => { throw new Error('schema changed') }
  assert.equal(readHermesMessageWatermark({
    ...stateOptions, queryFn: failedQuery,
  }), null)
  assert.equal(readHermesFinalResponse('session-1', {
    ...stateOptions, afterMessageId: 40, queryFn: failedQuery,
  }), '')
  assert.equal(readHermesMessageWatermark({
    ...stateOptions, existsFn: () => false,
  }), 0)
})

test('runAgent falls back to Hermes quiet stdout when no post-watermark final exists', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-hermes-no-final-'))
  const processProgress = Array.from({ length: 10 }, () => '┊ review diff').join('\n')
  const cli = executable(directory, 'hermes-no-final.cjs', `
process.stdout.write('Hermes quiet fallback')
process.stderr.write(${JSON.stringify(`${processProgress}\nsession_id: hermes-session-no-final\n`)})
  `)
  const progress = []
  let finalLookup
  const lifecycle = []
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const result = await runAgent(
    { kind: 'hermes', executable: cli, name: 'Hermes' },
    'hello',
    directory,
    {
      onProgress: step => progress.push(step),
      skills: ['legacy-test'],
      onSessionRef: async (sessionRef) => {
        await new Promise(resolve => setImmediate(resolve))
        lifecycle.push(`session:${sessionRef}`)
      },
      hermesMessageWatermarkFn: () => 52,
      hermesFinalResponseFn: (sessionRef, lookupOptions) => {
        lifecycle.push('final-lookup')
        finalLookup = { sessionRef, lookupOptions }
        return ''
      },
    },
  )
  assert.equal(result.text, 'Hermes quiet fallback')
  assert.equal(result.sessionRef, 'hermes-session-no-final')
  assert.equal(finalLookup.sessionRef, 'hermes-session-no-final')
  assert.equal(finalLookup.lookupOptions.afterMessageId, 52)
  assert.deepEqual(lifecycle, [
    'session:hermes-session-no-final',
    'final-lookup',
  ])
  assert.equal(progress.length, 8)
  assert.deepEqual(progress.at(-1), { title: 'write_file', status: 'completed' })
})

test('runAgent persists the Hermes session before falling back from a throwing final lookup', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-hermes-lookup-failure-'))
  const cli = executable(directory, 'hermes-lookup-failure.cjs', `
process.stdout.write('process output only')
process.stderr.write('session_id: hermes-session-lookup-failure\\n')
`)
  const lifecycle = []
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const result = await runAgent(
    { kind: 'hermes', executable: cli, name: 'Hermes' },
    'hello',
    directory,
    {
      onSessionRef: async (sessionRef) => {
        await new Promise(resolve => setImmediate(resolve))
        lifecycle.push(`session:${sessionRef}`)
      },
      skills: ['legacy-test'],
      hermesMessageWatermarkFn: () => 61,
      hermesFinalResponseFn: () => {
        lifecycle.push('final-lookup')
        throw new Error('schema changed')
      },
    },
  )
  assert.equal(result.text, 'process output only')
  assert.equal(result.sessionRef, 'hermes-session-lookup-failure')
  assert.deepEqual(lifecycle, [
    'session:hermes-session-lookup-failure',
    'final-lookup',
  ])
})

test('runAgent still starts Hermes and uses quiet stdout when the pre-run watermark is unavailable', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-hermes-no-watermark-'))
  const cli = executable(directory, 'hermes-no-watermark.cjs', `
process.stdout.write('\\u001b[36mHermes quiet fallback\\u001b[0m\\n')
process.stderr.write('session_id: hermes-session-no-watermark\\n')
  `)
  let finalLookupCount = 0
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const result = await runAgent(
    { kind: 'hermes', executable: cli, name: 'Hermes' },
    'hello',
    directory,
    {
      skills: ['legacy-test'],
      hermesMessageWatermarkFn: () => null,
      hermesFinalResponseFn: () => {
        finalLookupCount += 1
        return 'previous turn final'
      },
    },
  )
  assert.deepEqual(result, {
    text: 'Hermes quiet fallback',
    sessionRef: 'hermes-session-no-watermark',
    outcome: 'completed',
  })
  assert.equal(finalLookupCount, 0)
})

test('OpenClaw JSON output is reduced to reply text', () => {
  const raw = JSON.stringify({
    payloads: [{ text: '第一段' }, { text: '第二段' }],
    meta: { aborted: false, completion: { stopReason: 'stop' } },
  })
  assert.deepEqual(normalizeOutput('openclaw', raw, 'agent:main:desktop-roundrelay-group-openclaw'), {
    text: '第一段\n第二段',
    sessionRef: 'agent:main:desktop-roundrelay-group-openclaw',
    outcome: 'completed',
  })
})

test('OpenClaw uses a stable session key for group isolation', () => {
  const spec = invocation(
    'openclaw', '/tmp/openclaw', '/tmp/work', 'agent:main:desktop-roundrelay-group-openclaw',
  )
  assert.deepEqual(spec.args, [
    'agent', '--local', '--agent', 'main',
    '--session-key', 'agent:main:desktop-roundrelay-group-openclaw', '--message',
  ])
  assert.deepEqual(spec.suffixArgs, ['--json'])
})

test('runAgent uses the app-signed OpenClaw workspace', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-openclaw-workspace-'))
  const workdir = path.join(directory, 'workspace')
  fs.mkdirSync(workdir)
  const cli = executable(directory, 'openclaw-workspace.cjs', `
process.stdout.write(JSON.stringify({
  payloads: [{ text: process.env.OPENCLAW_WORKSPACE_DIR }],
}))
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const runtime = managedOpenClawOptions({
    storageRoot: directory,
    workdir,
    sessionRef: 'agent:main:adapter-workspace',
    provider: {
      OPENAI_API_KEY: 'adapter-openclaw-key',
      OPENAI_BASE_URL: 'https://api.example.com/v1',
      OPENAI_MODEL: 'adapter-model',
    },
  })

  const events = []
  const result = await runAgent(
    { kind: 'openclaw', executable: cli, name: 'OpenClaw' },
    'hello',
    workdir,
    {
      ...runtime,
      onEvent: event => events.push(event),
    },
  )

  assert.equal(result.text, workdir)
  assert.deepEqual(events[0], {
    id: 'openclaw-connector',
    type: 'warning',
    status: 'waiting',
    title: 'connector_limited',
  })
})
