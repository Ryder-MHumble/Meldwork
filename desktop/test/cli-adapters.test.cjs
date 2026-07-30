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
  searchPath,
} = require('../src/cli-adapters.cjs')

function executable(directory, name, source) {
  const filename = path.join(directory, name)
  fs.writeFileSync(filename, `#!/usr/bin/env node\n${source}`)
  fs.chmodSync(filename, 0o755)
  return filename
}

async function readWhenReady(filename, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const value = fs.readFileSync(filename, 'utf8')
      if (value) return value
    } catch {
      // Wait for the writer to create the file.
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${filename}`)
}

async function readJsonWhenReady(filename, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const value = fs.readFileSync(filename, 'utf8')
      if (value) return JSON.parse(value)
    } catch { /* wait for the writer to finish */ }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for complete JSON in ${filename}`)
}

async function within(promise, timeoutMs = 3000) {
  let timeout
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Agent cancellation did not settle.')), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

async function waitForExit(pid, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error.code === 'ESRCH') return
      throw error
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Process ${pid} did not exit.`)
}

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

test('Hermes uses quiet query mode and resumes the native session id without a shell', () => {
  const spec = invocation('hermes', '/tmp/hermes', '/tmp', 'hermes-session-123')
  assert.equal(spec.promptArg, true)
  assert.deepEqual(spec.args, [
    'chat', '--quiet', '--resume', 'hermes-session-123', '--query',
  ])
  assert.equal(spec.args.includes('-z'), false)
  assert.equal(spec.args.includes('--yolo'), false)
})

test('Hermes normalizes official quiet stdout as the fallback reply', () => {
  assert.deepEqual(normalizeOutput(
    'hermes',
    '\u001b[32mHermes process output\u001b[0m\n',
    'hermes-session-123',
  ), {
    text: 'Hermes process output',
    sessionRef: 'hermes-session-123',
  })
})

test('Hermes accepts an explicit OpenAI-compatible provider without exposing its key in arguments', () => {
  const spec = invocation('hermes', '/tmp/hermes', '/tmp', '', {
    provider: { id: 'openai-api', model: 'glm' },
  })
  assert.deepEqual(spec.args, [
    'chat', '--quiet', '--provider', 'openai-api', '--model', 'glm', '--query',
  ])
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

test('runAgent forces Hermes execution confirmation even when callers request yolo mode', async (t) => {
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
      env: { HERMES_EXEC_ASK: '0', HERMES_YOLO_MODE: '1' },
      hermesMessageWatermarkFn: () => 0,
      hermesFinalResponseFn: (sessionRef, lookupOptions) => {
        finalLookup = { sessionRef, lookupOptions }
        return fs.readFileSync(resultFile, 'utf8')
      },
    },
  )

  assert.deepEqual(JSON.parse(result.text), { ask: '1', yolo: '' })
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
      hermesMessageWatermarkFn: () => 23,
      hermesFinalResponseFn: () => 'Hermes reply',
    },
  )

  assert.deepEqual(result, {
    text: 'Hermes reply',
    sessionRef: 'hermes-session-123',
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
  })
  assert.equal(finalLookupCount, 0)
})

test('OpenClaw JSON output is reduced to reply text', () => {
  const raw = JSON.stringify({ payloads: [{ text: '第一段' }, { text: '第二段' }] })
  assert.deepEqual(normalizeOutput('openclaw', raw, 'agent:main:desktop-roundrelay-group-openclaw'), {
    text: '第一段\n第二段',
    sessionRef: 'agent:main:desktop-roundrelay-group-openclaw',
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

test('runAgent forces every OpenClaw invocation into the selected workspace', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-openclaw-workspace-'))
  const cli = executable(directory, 'openclaw-workspace.cjs', `
process.stdout.write(JSON.stringify({
  payloads: [{ text: process.env.OPENCLAW_WORKSPACE_DIR }],
}))
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const result = await runAgent(
    { kind: 'openclaw', executable: cli, name: 'OpenClaw' },
    'hello',
    directory,
    { env: { OPENCLAW_WORKSPACE_DIR: '/tmp/caller-supplied-workspace' } },
  )

  assert.equal(result.text, directory)
})

test('WorkBuddy uses non-interactive output and resumes its native session', () => {
  const spec = invocation('workbuddy', '/tmp/codebuddy', '/tmp/work', 'workbuddy-session')
  assert.equal(spec.promptArg, true)
  assert.deepEqual(spec.args, [
    '--print', '--output-format', 'json', '--permission-mode', 'plan',
    '--max-turns', '20', '--resume', 'workbuddy-session',
  ])
})

test('WorkBuddy configuration enables edits only after explicit authorization', () => {
  const spec = invocation('workbuddy', '/tmp/codebuddy', '/tmp/work', '', {
    sandbox: 'workspace-write',
  })
  assert.equal(spec.args[spec.args.indexOf('--permission-mode') + 1], 'acceptEdits')
})

test('WorkBuddy JSON output returns the final reply and session id', () => {
  const raw = JSON.stringify([
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'draft' }] },
    { type: 'result', result: 'final reply', session_id: 'workbuddy-session' },
  ])
  assert.deepEqual(parseWorkBuddyOutput(raw), {
    text: 'final reply',
    sessionRef: 'workbuddy-session',
  })
})

test('Kimi uses ACP plan mode by default and prompt mode only after write authorization', () => {
  const chat = invocation('kimi', '/tmp/kimi', '/tmp/work')
  assert.deepEqual(chat.args, ['acp'])
  assert.equal(chat.acpMode, 'plan')
  assert.equal(chat.promptArg, undefined)

  const resumed = invocation('kimi', '/tmp/kimi', '/tmp/work', 'kimi-session')
  assert.deepEqual(resumed.args, ['acp'])
  assert.equal(resumed.acpMode, 'plan')

  const writable = invocation('kimi', '/tmp/kimi', '/tmp/work', 'kimi-session', {
    sandbox: 'workspace-write',
  })
  assert.deepEqual(writable.args, [
    '--output-format', 'stream-json', '--session', 'kimi-session', '--prompt',
  ])
  assert.equal(writable.args.includes('--plan'), false)
  assert.equal(writable.args.includes('--auto'), false)
})

test('Kimi stream JSON output returns assistant text and the native session id', () => {
  const raw = [
    JSON.stringify({ role: 'assistant', content: '第一段' }),
    JSON.stringify({ role: 'tool', tool_call_id: 'tool-1', content: 'ignored' }),
    JSON.stringify({ role: 'assistant', content: '第二段' }),
    JSON.stringify({
      role: 'meta',
      type: 'session.resume_hint',
      session_id: '64741dae-cecb-4540-9356-6dc10a5cca47',
    }),
  ].join('\n')
  assert.deepEqual(parseKimiOutput(raw), {
    text: '第一段\n第二段',
    sessionRef: '64741dae-cecb-4540-9356-6dc10a5cca47',
  })
})

test('Kimi ACP plan mode creates and resumes sessions while reporting incomplete turns', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-kimi-acp-'))
  const workdir = fs.realpathSync(directory)
  const lifecycleFile = path.join(directory, 'lifecycle.log')
  const cli = executable(directory, 'kimi-acp.cjs', `
const fs = require('node:fs')
if (process.argv.includes('--prompt')) {
  process.stderr.write('legacy prompt mode used')
  process.exit(2)
}
const readline = require('node:readline')
const input = readline.createInterface({ input: process.stdin })
const record = value => fs.appendFileSync(process.env.ROUNDRELAY_TEST_LIFECYCLE_FILE, value + '\\n')
process.on('SIGTERM', () => {
  record('sigterm')
  process.exit(0)
})
input.on('close', () => record('stdin-close'))
let setup = ''
let sessionId = ''
let mode = ''
let promptRequest = null
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
input.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  } else if (message.method === 'session/new') {
    setup = 'new'
    sessionId = process.env.ROUNDRELAY_TEST_SECRET || 'kimi-acp-session'
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId } })
  } else if (message.method === 'session/resume') {
    setup = 'resume'
    sessionId = message.params.sessionId
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/set_mode') {
    if (message.params.sessionId !== sessionId) process.exit(3)
    mode = message.params.modeId
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/prompt') {
    if (message.params.sessionId !== sessionId) process.exit(4)
    promptRequest = message
    send({
      jsonrpc: '2.0', id: 99, method: 'session/request_permission',
      params: { sessionId, toolCall: { toolCallId: 'tool-1', title: 'write' }, options: [] },
    })
  } else if (message.id === 99) {
    const text = [
      setup,
      mode,
      message.result.outcome.outcome,
      promptRequest.params.prompt[0].text,
      process.cwd(),
    ].join('|')
    send({
      jsonrpc: '2.0', method: 'session/update',
      params: {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
      },
    })
    const stopReason = promptRequest.params.prompt[0].text === 'cancelled prompt'
      ? 'cancelled'
      : 'end_turn'
    send({ jsonrpc: '2.0', id: promptRequest.id, result: { stopReason } })
  }
})
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const env = { ROUNDRELAY_TEST_LIFECYCLE_FILE: lifecycleFile }
  const createdSessionRefs = []

  const created = await runAgent(
    { kind: 'kimi', executable: cli, name: 'Kimi' },
    'first prompt',
    workdir,
    { env, onSessionRef: sessionRef => createdSessionRefs.push(sessionRef) },
  )
  assert.equal(created.text, `new|plan|cancelled|first prompt|${workdir}`)
  assert.equal(created.sessionRef, 'kimi-acp-session')
  assert.equal(created.completed, true)
  assert.deepEqual(createdSessionRefs, ['kimi-acp-session'])

  const resumedSessionRefs = []
  const resumed = await runAgent(
    { kind: 'kimi', executable: cli, name: 'Kimi' },
    'next prompt',
    workdir,
    {
      sessionRef: created.sessionRef,
      env,
      onSessionRef: sessionRef => resumedSessionRefs.push(sessionRef),
    },
  )
  assert.equal(resumed.text, `resume|plan|cancelled|next prompt|${workdir}`)
  assert.equal(resumed.sessionRef, 'kimi-acp-session')
  assert.deepEqual(resumedSessionRefs, ['kimi-acp-session'])

  const cancelled = await runAgent(
    { kind: 'kimi', executable: cli, name: 'Kimi' },
    'cancelled prompt',
    workdir,
    { sessionRef: created.sessionRef, env },
  )
  assert.equal(cancelled.text, `resume|plan|cancelled|cancelled prompt|${workdir}`)
  assert.equal(cancelled.completed, false)

  const privateSessionRefs = []
  const privateSessionId = 'private-session-reference'
  const privateSession = await runAgent(
    { kind: 'kimi', executable: cli, name: 'Kimi' },
    'private session prompt',
    workdir,
    {
      env: { ...env, ROUNDRELAY_TEST_SECRET: privateSessionId },
      onSessionRef: sessionRef => privateSessionRefs.push(sessionRef),
    },
  )
  assert.equal(privateSession.text, `new|plan|cancelled|private session prompt|${workdir}`)
  assert.equal(privateSession.sessionRef, '')
  assert.deepEqual(privateSessionRefs, [])
  assert.deepEqual(
    fs.readFileSync(lifecycleFile, 'utf8').trim().split('\n'),
    ['stdin-close', 'stdin-close', 'stdin-close', 'stdin-close'],
  )
})

test('Kimi ACP preserves new sessions across failures and keeps diagnostics private', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-kimi-acp-session-ref-'))
  const promptFailureCli = executable(directory, 'kimi-acp-prompt-failure.cjs', `
const readline = require('node:readline')
const input = readline.createInterface({ input: process.stdin })
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
input.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'kimi-prompt-failure-session' } })
  } else if (message.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/prompt') {
    send({
      jsonrpc: '2.0', id: message.id,
      error: {
        code: -32000,
        message: 'prompt failed in /private/roundrelay-agent with ' + process.env.ROUNDRELAY_TEST_SECRET,
      },
    })
  }
})
`)
  const processExitCli = executable(directory, 'kimi-acp-process-exit.cjs', `
const readline = require('node:readline')
const input = readline.createInterface({ input: process.stdin })
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
input.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'kimi-process-exit-session' } })
  } else if (message.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/prompt') {
    process.stderr.write('process exited after creating the session')
    process.exit(7)
  }
})
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const promptFailureSessionRefs = []
  const secret = 'private-provider-secret'
  await assert.rejects(
    runAgent(
      { kind: 'kimi', executable: promptFailureCli, name: 'Kimi' },
      'fail prompt',
      directory,
      {
        env: { ROUNDRELAY_TEST_SECRET: secret },
        onSessionRef: sessionRef => promptFailureSessionRefs.push(sessionRef),
      },
    ),
    (error) => {
      assert.equal(error.message, 'LOCAL_AGENT_PROCESS_FAILED')
      assert.match(error.diagnostic, /prompt failed in \/private\/roundrelay-agent with \[redacted\]/)
      assert.equal(error.diagnostic.includes(secret), false)
      assert.equal(Object.prototype.propertyIsEnumerable.call(error, 'diagnostic'), false)
      assert.doesNotMatch(error.message, /private|redacted|secret/i)
      return true
    },
  )
  assert.deepEqual(promptFailureSessionRefs, ['kimi-prompt-failure-session'])

  const processExitSessionRefs = []
  await assert.rejects(
    runAgent(
      { kind: 'kimi', executable: processExitCli, name: 'Kimi' },
      'exit during prompt',
      directory,
      { onSessionRef: sessionRef => processExitSessionRefs.push(sessionRef) },
    ),
    (error) => {
      assert.equal(error.message, 'LOCAL_AGENT_PROCESS_FAILED')
      assert.equal(Object.prototype.propertyIsEnumerable.call(error, 'diagnostic'), false)
      return true
    },
  )
  assert.deepEqual(processExitSessionRefs, ['kimi-process-exit-session'])
})

test('Kimi ACP rejects unsafe protocol input without logging secret-bearing messages', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-kimi-acp-invalid-'))
  const secret = 'private-kimi-transport-secret'
  const cli = executable(directory, 'kimi-acp-invalid.cjs', `
const readline = require('node:readline')
const input = readline.createInterface({ input: process.stdin })
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
input.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'kimi-invalid-session' } })
  } else if (message.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/prompt') {
    if (process.env.ROUNDRELAY_TEST_CASE === 'malformed') {
      process.stdout.write('{"secret":"' + process.env.ROUNDRELAY_TEST_SECRET + '"\\n')
    } else {
      send({
        jsonrpc: '2.0', method: 'unsupported/client_method',
        params: { secret: process.env.ROUNDRELAY_TEST_SECRET },
      })
    }
  }
})
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const logged = []
  const originalConsoleError = console.error
  console.error = (...args) => logged.push(args.map(String).join(' '))
  t.after(() => { console.error = originalConsoleError })

  for (const testCase of ['malformed', 'unsupported']) {
    await assert.rejects(
      runAgent(
        { kind: 'kimi', executable: cli, name: 'Kimi' },
        'validate transport',
        directory,
        { env: { ROUNDRELAY_TEST_CASE: testCase, ROUNDRELAY_TEST_SECRET: secret } },
      ),
      (error) => {
        assert.equal(error.message, 'LOCAL_AGENT_PROCESS_FAILED')
        assert.equal(error.diagnostic.includes(secret), false)
        assert.equal(Object.prototype.propertyIsEnumerable.call(error, 'diagnostic'), false)
        return true
      },
    )
  }

  assert.deepEqual(logged, [])
})

test('Kimi ACP bounds unframed input, cumulative reply text, and total protocol traffic', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-kimi-acp-limits-'))
  const cli = executable(directory, 'kimi-acp-limits.cjs', `
const readline = require('node:readline')
const input = readline.createInterface({ input: process.stdin })
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
input.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'kimi-limit-session' } })
  } else if (message.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/prompt') {
    const testCase = process.env.ROUNDRELAY_TEST_CASE
    if (testCase === 'line') {
      process.stdout.write('x'.repeat(1024 * 1024 + 1))
      return
    }
    const update = testCase === 'reply' ? 'agent_message_chunk' : 'agent_thought_chunk'
    const size = testCase === 'reply' ? 512 * 1024 : 960 * 1024
    const count = testCase === 'reply' ? 21 : 18
    const text = 'x'.repeat(size)
    for (let index = 0; index < count; index += 1) {
      send({
        jsonrpc: '2.0', method: 'session/update',
        params: {
          sessionId: 'kimi-limit-session',
          update: { sessionUpdate: update, content: { type: 'text', text } },
        },
      })
    }
  }
})
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  for (const [testCase, diagnostic] of [
    ['line', /line limit/],
    ['reply', /output limit/],
    ['total', /total limit/],
  ]) {
    await assert.rejects(
      runAgent(
        { kind: 'kimi', executable: cli, name: 'Kimi' },
        'validate bounds',
        directory,
        { env: { ROUNDRELAY_TEST_CASE: testCase } },
      ),
      (error) => {
        assert.equal(error.message, 'LOCAL_AGENT_PROCESS_FAILED')
        assert.match(error.diagnostic, diagnostic)
        return true
      },
    )
  }
})

test('Kimi ACP cancellation notifies the session and terminates the child process', {
  skip: process.platform === 'win32',
}, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-kimi-acp-abort-'))
  const readyFile = path.join(directory, 'ready')
  const cancelFile = path.join(directory, 'cancel.json')
  const lifecycleFile = path.join(directory, 'lifecycle.log')
  const cli = executable(directory, 'kimi-acp-abort.cjs', `
const fs = require('node:fs')
const readline = require('node:readline')
const input = readline.createInterface({ input: process.stdin })
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
const record = value => fs.appendFileSync(process.env.ROUNDRELAY_TEST_LIFECYCLE_FILE, value + '\\n')
process.on('SIGTERM', () => record('sigterm'))
input.on('close', () => record('stdin-close'))
input.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'kimi-cancel-session' } })
  } else if (message.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/prompt') {
    fs.writeFileSync(process.env.ROUNDRELAY_TEST_READY_FILE, String(process.pid))
  } else if (message.method === 'session/cancel') {
    record('cancel')
    fs.writeFileSync(process.env.ROUNDRELAY_TEST_CANCEL_FILE, JSON.stringify(message.params))
  }
})
setInterval(() => {}, 1000)
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const controller = new AbortController()
  const outcome = runAgent(
    { kind: 'kimi', executable: cli, name: 'Kimi' },
    'keep discussing',
    directory,
    {
      signal: controller.signal,
      env: {
        ROUNDRELAY_TEST_READY_FILE: readyFile,
        ROUNDRELAY_TEST_CANCEL_FILE: cancelFile,
        ROUNDRELAY_TEST_LIFECYCLE_FILE: lifecycleFile,
      },
    },
  ).then(value => ({ value }), error => ({ error }))
  const pid = Number(await readWhenReady(readyFile))

  controller.abort()

  const result = await within(outcome)
  assert.equal(result.error?.message, 'LOCAL_AGENT_EXECUTION_STOPPED')
  assert.deepEqual(await readJsonWhenReady(cancelFile), { sessionId: 'kimi-cancel-session' })
  await waitForExit(pid)
  assert.deepEqual(
    fs.readFileSync(lifecycleFile, 'utf8').trim().split('\n'),
    ['cancel', 'stdin-close', 'sigterm'],
  )
})

test('Claude uses JSON output and resumes its native session', () => {
  const spec = invocation('claude', '/tmp/claude', '/tmp/work', 'claude-session')
  assert.deepEqual(spec.args, [
    '--print', '--output-format', 'json', '--permission-mode', 'plan',
    '--resume', 'claude-session',
  ])
  assert.equal(spec.promptArg, true)
})

test('MiMo uses its read-only plan Agent and resumes its native session', () => {
  const spec = invocation('mimo', '/tmp/mimo', '/tmp/work', 'mimo-session', {
    sandbox: 'workspace-write',
  })
  assert.deepEqual(spec.args, [
    'run', '--pure', '--agent', 'plan', '--format', 'json', '--dir', '/tmp/work',
    '--session', 'mimo-session',
  ])
  assert.equal(spec.promptArg, true)
})

test('MiMo JSON output returns final text and session id', () => {
  const raw = [
    JSON.stringify({
      type: 'text', sessionID: 'mimo-session',
      part: { type: 'text', text: 'MiMo reply' },
    }),
  ].join('\n')
  assert.deepEqual(parseMimoOutput(raw), {
    text: 'MiMo reply', sessionRef: 'mimo-session', error: '',
  })
  assert.deepEqual(normalizeOutput('mimo', raw), {
    text: 'MiMo reply', sessionRef: 'mimo-session', error: '',
  })
})

test('Claude JSON output returns the final reply and session id', () => {
  const raw = JSON.stringify({
    type: 'result', result: 'Claude reply', session_id: 'claude-session',
  })
  assert.deepEqual(normalizeOutput('claude', raw), {
    text: 'Claude reply',
    sessionRef: 'claude-session',
  })
})

test('Qwen uses plan mode by default and auto-edit after authorization', () => {
  const chat = invocation('qwen', '/tmp/qwen', '/tmp/work', 'qwen-session')
  assert.deepEqual(chat.args, [
    '--output-format', 'json', '--approval-mode', 'plan', '--resume', 'qwen-session',
  ])

  const configure = invocation('qwen', '/tmp/qwen', '/tmp/work', '', {
    sandbox: 'workspace-write',
  })
  assert.deepEqual(configure.args, [
    '--output-format', 'json', '--approval-mode', 'auto-edit',
  ])
})

test('Qwen selects OpenAI auth when the shared provider is enabled', () => {
  const spec = invocation('qwen', '/tmp/qwen', '/tmp/work', '', {
    provider: { id: 'openai', model: 'glm' },
  })
  assert.deepEqual(spec.args, [
    '--output-format', 'json', '--approval-mode', 'plan',
    '--auth-type', 'openai', '--model', 'glm',
  ])
})

test('Gemini uses stream JSON with explicit approval modes and resumes its native session', () => {
  const chat = invocation('gemini', '/tmp/gemini', '/tmp/work', 'gemini-session')
  assert.deepEqual(chat.args, [
    '--output-format', 'stream-json', '--approval-mode', 'plan',
    '--resume', 'gemini-session', '--prompt',
  ])
  assert.equal(chat.promptArg, true)

  const configure = invocation('gemini', '/tmp/gemini', '/tmp/work', '', {
    sandbox: 'workspace-write',
  })
  assert.deepEqual(configure.args, [
    '--output-format', 'stream-json', '--approval-mode', 'auto_edit', '--prompt',
  ])
})

test('Gemini stream JSON output returns assistant chunks and the native session id', () => {
  const raw = [
    JSON.stringify({ type: 'init', session_id: 'gemini-session', model: 'gemini-2.5-pro' }),
    JSON.stringify({ type: 'message', role: 'user', content: 'hello' }),
    JSON.stringify({ type: 'message', role: 'assistant', content: '第一段', delta: true }),
    JSON.stringify({ type: 'message', role: 'assistant', content: '第二段', delta: true }),
    JSON.stringify({ type: 'result', status: 'success' }),
  ].join('\n')
  assert.deepEqual(parseGeminiOutput(raw), {
    text: '第一段第二段',
    sessionRef: 'gemini-session',
  })
})

test('OpenCode uses JSON events and resumes the requested session without auto approval', () => {
  const chat = invocation('opencode', '/tmp/opencode', '/tmp/work', 'opencode-session')
  assert.deepEqual(chat.args, [
    'run', '--format', 'json', '--agent', 'plan', '--session', 'opencode-session',
  ])
  assert.equal(chat.promptArg, true)
  assert.equal(chat.args.includes('--auto'), false)

  const configure = invocation('opencode', '/tmp/opencode', '/tmp/work', '', {
    sandbox: 'workspace-write',
  })
  assert.deepEqual(configure.args, ['run', '--format', 'json'])

  const first = path.resolve('diagram-one.png')
  const second = path.resolve('diagram-two.jpg')
  const withImages = invocation('opencode', '/tmp/opencode', '/tmp/work', 'opencode-session', {
    attachments: [first, second],
  })
  assert.deepEqual(withImages.args, [
    'run', '--format', 'json', '--agent', 'plan', '--session', 'opencode-session',
    '--file', first, '--file', second,
  ])
})

test('OpenCode JSONL output returns completed text and the native session id', () => {
  const raw = [
    JSON.stringify({
      type: 'tool_use', sessionID: 'opencode-session',
      part: { type: 'tool', tool: 'read' },
    }),
    JSON.stringify({
      type: 'text', sessionID: 'opencode-session',
      part: { type: 'text', text: 'OpenCode reply' },
    }),
  ].join('\n')
  assert.deepEqual(parseOpenCodeOutput(raw), {
    text: 'OpenCode reply',
    sessionRef: 'opencode-session',
  })
})

test('supported local CLIs run in the selected workdir and return native session ids', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-cli-workdir-'))
  const workdir = fs.realpathSync(directory)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const fixtures = [
    {
      kind: 'workbuddy',
      source: `process.stdout.write(JSON.stringify({
        type: 'result', result: process.cwd(), session_id: 'workbuddy-session',
      }))`,
    },
    {
      kind: 'kimi',
      options: { sandbox: 'workspace-write' },
      source: `process.stdout.write([
        JSON.stringify({ role: 'assistant', content: process.cwd() }),
        JSON.stringify({ type: 'session.resume_hint', session_id: 'kimi-session' }),
      ].join('\\n'))`,
    },
    {
      kind: 'claude',
      source: `process.stdout.write(JSON.stringify({
        type: 'result', result: process.cwd(), session_id: 'claude-session',
      }))`,
    },
    {
      kind: 'qwen',
      source: `process.stdout.write(JSON.stringify({
        type: 'result', result: process.cwd(), session_id: 'qwen-session',
      }))`,
    },
    {
      kind: 'gemini',
      source: `process.stdout.write([
        JSON.stringify({ type: 'init', session_id: 'gemini-session' }),
        JSON.stringify({ type: 'message', role: 'assistant', content: process.cwd() }),
      ].join('\\n'))`,
    },
    {
      kind: 'opencode',
      source: `process.stdout.write(JSON.stringify({
        type: 'text', sessionID: 'opencode-session',
        part: { type: 'text', text: process.cwd() },
      }) + '\\n')`,
    },
  ]

  for (const fixture of fixtures) {
    const cli = executable(directory, `${fixture.kind}.cjs`, fixture.source)
    const result = await runAgent(
      { kind: fixture.kind, executable: cli, name: fixture.kind },
      'hello',
      workdir,
      fixture.options,
    )
    assert.equal(result.text, workdir, fixture.kind)
    assert.equal(result.sessionRef, `${fixture.kind}-session`, fixture.kind)
  }
})

test('runAgent forces OpenCode read-only permissions without changing user configuration', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-opencode-permission-'))
  const cli = executable(directory, 'opencode-permission.cjs', `
process.stdout.write(JSON.stringify({
  type: 'text',
  sessionID: 'opencode-session',
  part: { type: 'text', text: process.env.OPENCODE_PERMISSION },
}) + '\\n')
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const result = await runAgent(
    { kind: 'opencode', executable: cli, name: 'OpenCode' },
    'hello',
    directory,
    { env: { OPENCODE_PERMISSION: JSON.stringify({ edit: 'allow' }) } },
  )

  assert.deepEqual(JSON.parse(result.text), {
    '*': 'deny',
    read: 'allow',
    glob: 'allow',
    grep: 'allow',
    list: 'allow',
    webfetch: 'allow',
    websearch: 'allow',
  })
  assert.equal(result.sessionRef, 'opencode-session')
})

test('runAgent injects Provider secrets through the child environment only', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-cli-provider-'))
  const cli = executable(directory, 'provider-env.cjs', `
process.stdout.write([
  process.env.KIMI_MODEL_NAME,
  process.env.KIMI_MODEL_BASE_URL,
  process.env.KIMI_MODEL_API_KEY,
].join('|'))
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const result = await runAgent(
    { kind: 'kimi', executable: cli, name: 'Kimi' },
    'hello',
    directory,
    {
      env: {
        KIMI_MODEL_NAME: 'glm',
        KIMI_MODEL_BASE_URL: 'https://api.example.com/v1',
        KIMI_MODEL_API_KEY: 'test-secret-env-only',
      },
      sandbox: 'workspace-write',
    },
  )
  assert.equal(result.text, 'glm|https://api.example.com/v1|[redacted]')
})

test('runAgent never exposes unrelated RoundRelay process values to local CLIs', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-cli-private-'))
  const cli = executable(directory, 'token-env.cjs', `
process.stdout.write(JSON.stringify({
  type: 'result',
  result: process.env.ROUNDRELAY_PRIVATE_VALUE || 'not-exposed',
  session_id: 'claude-session',
}))
`)
  const previous = process.env.ROUNDRELAY_PRIVATE_VALUE
  process.env.ROUNDRELAY_PRIVATE_VALUE = 'test-private-value'
  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true })
    if (previous == null) delete process.env.ROUNDRELAY_PRIVATE_VALUE
    else process.env.ROUNDRELAY_PRIVATE_VALUE = previous
  })

  const result = await runAgent(
    { kind: 'claude', executable: cli, name: 'Claude' },
    'hello',
    directory,
  )

  assert.equal(result.text, 'not-exposed')
})

test('runAgent scopes the child environment and redacts current Agent secrets from output', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-cli-env-scope-'))
  const cli = executable(directory, 'env-scope.cjs', `
process.stdout.write(JSON.stringify({
  type: 'result',
  result: JSON.stringify({
    ambientOpenAi: process.env.OPENAI_API_KEY || '',
    ambientPrivate: process.env.UNRELATED_PRIVATE_VALUE || '',
    explicitAnthropic: process.env.ANTHROPIC_API_KEY || '',
    hasHome: Boolean(process.env.HOME || process.env.USERPROFILE),
  }),
  session_id: 'claude-session',
}))
`)
  const previousOpenAi = process.env.OPENAI_API_KEY
  const previousPrivate = process.env.UNRELATED_PRIVATE_VALUE
  process.env.OPENAI_API_KEY = 'ambient-openai-secret'
  process.env.UNRELATED_PRIVATE_VALUE = 'ambient-private-secret'
  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true })
    if (previousOpenAi == null) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousOpenAi
    if (previousPrivate == null) delete process.env.UNRELATED_PRIVATE_VALUE
    else process.env.UNRELATED_PRIVATE_VALUE = previousPrivate
  })

  const result = await runAgent(
    { kind: 'claude', executable: cli, name: 'Claude' },
    'hello',
    directory,
    { env: { ANTHROPIC_API_KEY: 'current-agent-secret' } },
  )

  assert.deepEqual(JSON.parse(result.text), {
    ambientOpenAi: '',
    ambientPrivate: '',
    explicitAnthropic: '[redacted]',
    hasHome: true,
  })
})

test('runAgent keeps redacted Provider diagnostics out of renderer-visible errors', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-cli-error-secret-'))
  const cli = executable(directory, 'error-secret.cjs', `
process.stderr.write('Provider rejected ' + process.env.OPENAI_API_KEY)
process.exit(1)
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const secret = 'test-provider-secret-value'

  await assert.rejects(
    runAgent(
      { kind: 'qwen', executable: cli, name: 'Qwen' },
      'hello',
      directory,
      { env: { OPENAI_API_KEY: secret } },
    ),
    (error) => {
      assert.equal(error.message, 'LOCAL_AGENT_AUTH_REQUIRED')
      assert.equal(error.diagnostic, 'Provider rejected [redacted]')
      assert.equal(error.diagnostic.includes(secret), false)
      assert.equal(Object.prototype.propertyIsEnumerable.call(error, 'diagnostic'), false)
      assert.doesNotMatch(error.message, /Provider|redacted/)
      return true
    },
  )
})

test('structured CLI authentication failures expose only a stable error code', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-cli-error-'))
  const cli = executable(directory, 'structured-error.cjs', `
process.stderr.write('startup warning')
process.stdout.write(JSON.stringify([{ type: 'result', subtype: 'error_during_execution',
  is_error: true, error: { message: 'Select an auth type first.' } }]))
process.exit(1)
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  await assert.rejects(
    runAgent({ kind: 'qwen', executable: cli, name: 'Qwen' }, 'hello', directory),
    (error) => {
      assert.equal(error.message, 'LOCAL_AGENT_AUTH_REQUIRED')
      assert.equal(error.diagnostic, 'startup warning\nSelect an auth type first.')
      assert.equal(Object.prototype.propertyIsEnumerable.call(error, 'diagnostic'), false)
      return true
    },
  )
})

test('generic CLI failures keep executable paths in main-process diagnostics only', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-cli-process-error-'))
  const cli = executable(directory, 'process-error.cjs', `
process.stderr.write('Agent crashed in /private/agents/qwen: upstream failure')
process.exit(1)
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  await assert.rejects(
    runAgent({ kind: 'qwen', executable: cli, name: 'Qwen' }, 'hello', directory),
    (error) => {
      assert.equal(error.message, 'LOCAL_AGENT_PROCESS_FAILED')
      assert.equal(error.diagnostic, 'Agent crashed in /private/agents/qwen: upstream failure')
      assert.equal(Object.prototype.propertyIsEnumerable.call(error, 'diagnostic'), false)
      assert.doesNotMatch(error.message, /private|qwen|upstream/i)
      return true
    },
  )
})

test('nonzero CLI exits without diagnostics retain the stable exited code', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-cli-empty-error-'))
  const cli = executable(directory, 'empty-error.cjs', 'process.exit(1)')
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  await assert.rejects(
    runAgent({ kind: 'qwen', executable: cli, name: 'Qwen' }, 'hello', directory),
    (error) => {
      assert.equal(error.message, 'LOCAL_AGENT_EXITED')
      assert.equal(error.diagnostic, undefined)
      return true
    },
  )
})

test('search path includes common user CLI locations', () => {
  assert.match(searchPath(), /\.local\/bin/)
  assert.match(searchPath(), /\.kimi-code\/bin/)
  assert.match(searchPath(), /\.mimocode\/bin/)
})

test('macOS Finder cold starts include common Node version manager paths', () => {
  const roots = {
    '/Users/Ryder/.nvm/versions/node': ['v20.12.0', 'v22.5.1'],
    '/Users/Ryder/.local/share/fnm/node-versions': ['v21.1.0'],
    '/Users/Ryder/Library/Application Support/fnm/node-versions': ['v22.4.0'],
  }
  const value = searchPath({
    platform: 'darwin',
    home: '/Users/Ryder',
    env: {
      PATH: '/usr/bin:/bin',
      PNPM_HOME: '/Users/Ryder/Custom/pnpm',
      FNM_MULTISHELL_PATH: '/Users/Ryder/Library/Application Support/fnm/session',
      NVM_BIN: '/Users/Ryder/.nvm/versions/node/v23.0.0/bin',
      BUN_INSTALL: '/Users/Ryder/.custom-bun',
      ASDF_DATA_DIR: '/Users/Ryder/.custom-asdf',
      MISE_DATA_DIR: '/Users/Ryder/.custom-mise',
      NODENV_ROOT: '/Users/Ryder/.custom-nodenv',
    },
    readdirFn: root => (roots[root] || []).map(name => ({
      name,
      isDirectory: () => true,
      isSymbolicLink: () => false,
    })),
  }).split(':')

  assert.ok(value.includes('/Users/Ryder/.volta/bin'))
  assert.ok(value.includes('/Users/Ryder/Custom/pnpm'))
  assert.ok(value.includes('/Users/Ryder/Library/pnpm'))
  assert.ok(value.includes('/Users/Ryder/.local/share/pnpm'))
  assert.ok(value.includes('/Users/Ryder/.nvm/versions/node/v23.0.0/bin'))
  assert.ok(value.includes('/Users/Ryder/.nvm/versions/node/v22.5.1/bin'))
  assert.ok(value.includes('/Users/Ryder/.nvm/versions/node/v20.12.0/bin'))
  assert.ok(value.indexOf('/Users/Ryder/.nvm/versions/node/v22.5.1/bin')
    < value.indexOf('/Users/Ryder/.nvm/versions/node/v20.12.0/bin'))
  assert.ok(value.includes('/Users/Ryder/Library/Application Support/fnm/session/bin'))
  assert.ok(value.includes('/Users/Ryder/.local/share/fnm/aliases/default/bin'))
  assert.ok(value.includes('/Users/Ryder/.local/share/fnm/node-versions/v21.1.0/installation/bin'))
  assert.ok(value.includes('/Users/Ryder/Library/Application Support/fnm/node-versions/v22.4.0/installation/bin'))
  assert.ok(value.includes('/Users/Ryder/.asdf/shims'))
  assert.ok(value.includes('/Users/Ryder/.custom-asdf/shims'))
  assert.ok(value.includes('/Users/Ryder/.local/share/mise/shims'))
  assert.ok(value.includes('/Users/Ryder/.custom-mise/shims'))
  assert.ok(value.includes('/Users/Ryder/.nodenv/shims'))
  assert.ok(value.includes('/Users/Ryder/.custom-nodenv/shims'))
  assert.ok(value.includes('/Users/Ryder/.bun/bin'))
  assert.ok(value.includes('/Users/Ryder/.custom-bun/bin'))
})

test('Windows search path includes npm, app, and user CLI locations', () => {
  const value = searchPath({
    platform: 'win32',
    home: 'C:\\Users\\Ryder',
    env: {
      Path: 'C:\\Tools;C:\\Windows\\System32',
      APPDATA: 'C:\\Users\\Ryder\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\Ryder\\AppData\\Local',
      PNPM_HOME: 'D:\\Tools\\pnpm',
      NVM_HOME: 'D:\\Tools\\nvm',
      NVM_SYMLINK: 'D:\\Tools\\nodejs',
      ProgramFiles: 'C:\\Program Files',
      ProgramData: 'C:\\ProgramData',
    },
  }).split(';')

  assert.ok(value.includes('C:\\Users\\Ryder\\AppData\\Roaming\\npm'))
  assert.ok(value.includes('D:\\Tools\\pnpm'))
  assert.ok(value.includes('C:\\Users\\Ryder\\AppData\\Local\\pnpm'))
  assert.ok(value.includes('C:\\Users\\Ryder\\AppData\\Local\\Microsoft\\WindowsApps'))
  assert.ok(value.includes('C:\\Users\\Ryder\\AppData\\Local\\Programs\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin'))
  assert.ok(value.includes('C:\\Users\\Ryder\\.kimi-code\\bin'))
  assert.ok(value.includes('D:\\Tools\\nvm'))
  assert.ok(value.includes('D:\\Tools\\nodejs'))
  assert.ok(value.includes('C:\\Program Files\\nodejs'))
  assert.ok(value.includes('C:\\ProgramData\\chocolatey\\bin'))
})

test('Windows executable resolution honors PATHEXT', async () => {
  const expected = 'C:\\Tools\\codex.CMD'
  const executable = await resolveExecutable('codex', {
    platform: 'win32',
    home: 'C:\\Users\\Ryder',
    env: {
      Path: 'C:\\Tools',
      PATHEXT: '.EXE;.CMD',
    },
    accessFn: async (candidate) => {
      if (candidate !== expected) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    },
    execFileFn: async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    },
  })

  assert.equal(executable, expected)
})

test('Windows executable resolution falls back to where.exe', async () => {
  const expected = 'D:\\Agent Tools\\qwen.cmd'
  const executable = await resolveExecutable('qwen', {
    platform: 'win32',
    home: 'C:\\Users\\Ryder',
    env: {
      Path: 'C:\\Windows\\System32',
      PATHEXT: '.EXE;.CMD',
    },
    accessFn: async (candidate) => {
      if (candidate !== expected) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    },
    execFileFn: async (command, args) => {
      assert.equal(command, 'where.exe')
      assert.deepEqual(args, ['qwen'])
      return { stdout: `${expected}\r\n`, stderr: '' }
    },
  })

  assert.equal(executable, expected)
})

test('Linux executable resolution uses an allowlisted environment in the fallback shell', async () => {
  const expected = '/opt/agents/kimi'
  const executable = await resolveExecutable('kimi', {
    platform: 'linux',
    home: '/home/ryder',
    env: {
      HOME: '/home/ryder',
      LANG: 'zh_CN.UTF-8',
      PATH: '/usr/bin:/bin',
      ROUNDRELAY_PRIVATE_VALUE: 'desktop-private-value',
      OPENAI_API_KEY: 'provider-secret',
    },
    accessFn: async (candidate) => {
      if (candidate !== expected) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    },
    execFileFn: async (command, args, options) => {
      assert.equal(command, '/bin/sh')
      assert.deepEqual(args, ['-lc', 'command -v -- kimi'])
      assert.equal(options.env.HOME, '/home/ryder')
      assert.equal(options.env.LANG, 'zh_CN.UTF-8')
      assert.match(options.env.PATH, /\/usr\/bin:\/bin/)
      assert.equal(options.env.ROUNDRELAY_PRIVATE_VALUE, undefined)
      assert.equal(options.env.OPENAI_API_KEY, undefined)
      return { stdout: `${expected}\n`, stderr: '' }
    },
  })

  assert.equal(executable, expected)
})

test('macOS WorkBuddy detection keeps the application-bundled CLI path', async () => {
  const expected = '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy'
  const executable = await resolveExecutable('workbuddy', {
    platform: 'darwin',
    home: '/Users/ryder',
    env: { PATH: '' },
    accessFn: async (candidate) => {
      if (candidate !== expected) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    },
    execFileFn: async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    },
  })

  assert.equal(executable, expected)
})

test('macOS WorkBuddy detection also checks the per-user Applications folder', async () => {
  const expected = '/Users/ryder/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy'
  const executable = await resolveExecutable('workbuddy', {
    platform: 'darwin',
    home: '/Users/ryder',
    env: { PATH: '' },
    accessFn: async (candidate) => {
      if (candidate !== expected) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    },
    execFileFn: async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    },
  })

  assert.equal(executable, expected)
})

test('WorkBuddy detection does not mistake the generic cbc solver for WorkBuddy', async () => {
  const probed = []
  const lookups = []
  const executable = await resolveExecutable('workbuddy', {
    platform: 'darwin',
    home: '/Users/Ryder',
    env: { PATH: '/tools' },
    accessFn: async (candidate) => {
      probed.push(candidate)
      if (candidate === '/tools/cbc') return
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    },
    execFileFn: async (_command, args) => {
      lookups.push(args.at(-1))
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    },
  })

  assert.equal(executable, null)
  assert.equal(probed.includes('/tools/cbc'), false)
  assert.equal(lookups.some(value => value.includes('cbc')), false)
})

test('Windows npm command shims launch Node directly without reparsing prompt text', () => {
  const executable = 'C:\\Users\\Ryder\\AppData\\Roaming\\npm\\codex.cmd'
  const prompt = 'compare A & B, then echo %PATH% and !tokens!'
  const shim = [
    '@ECHO off',
    'SETLOCAL',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    ')',
    '"%_prog%" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
  ].join('\r\n')

  const spec = prepareCommand(executable, [prompt], {
    platform: 'win32',
    env: {},
    readFileFn: () => shim,
    existsFn: () => false,
  })

  assert.equal(spec.command, 'node.exe')
  assert.deepEqual(spec.args, [
    'C:\\Users\\Ryder\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js',
    prompt,
  ])
})

test('Windows WorkBuddy npm shims accept an extensionless node_modules target', () => {
  const executable = 'C:\\Users\\Ryder\\AppData\\Roaming\\npm\\codebuddy.cmd'
  const shim = [
    '@ECHO off',
    '"%dp0%\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy" %*',
  ].join('\r\n')

  const spec = prepareCommand(executable, ['hello'], {
    platform: 'win32',
    env: {},
    readFileFn: () => shim,
    existsFn: () => false,
  })

  assert.equal(spec.command, 'node.exe')
  assert.deepEqual(spec.args, [
    'C:\\Users\\Ryder\\AppData\\Roaming\\npm\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy',
    'hello',
  ])
})

test('Windows OpenCode npm shims launch the packaged native executable directly', () => {
  const executable = 'C:\\Users\\Ryder\\AppData\\Roaming\\npm\\opencode.cmd'
  const native = 'C:\\Users\\Ryder\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe'
  const shim = [
    '@ECHO off',
    '"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe" %*',
  ].join('\r\n')

  const spec = prepareCommand(executable, ['run', '--format', 'json'], {
    platform: 'win32',
    env: {},
    readFileFn: () => shim,
    existsFn: filename => filename === native,
  })

  assert.equal(spec.command, native)
  assert.deepEqual(spec.args, ['run', '--format', 'json'])
})

test('Windows extensionless npm shims reject traversal and non-node_modules targets', () => {
  const executable = 'C:\\Users\\Ryder\\AppData\\Roaming\\npm\\codebuddy.cmd'
  const options = {
    platform: 'win32',
    env: {},
    existsFn: () => false,
  }

  assert.throws(
    () => prepareCommand(executable, [], {
      ...options,
      readFileFn: () => '"%dp0%\\..\\outside\\node_modules\\codebuddy" %*',
    }),
    { message: 'LOCAL_CLI_WRAPPER_UNSUPPORTED' },
  )
  assert.throws(
    () => prepareCommand(executable, [], {
      ...options,
      readFileFn: () => '"%dp0%\\bin\\codebuddy" %*',
    }),
    { message: 'LOCAL_CLI_WRAPPER_UNSUPPORTED' },
  )
})

test('Windows Agent detection reads versions through the portable command launcher', async () => {
  const executable = 'C:\\Users\\Ryder\\AppData\\Roaming\\npm\\claude.cmd'
  const calls = []
  const found = await detectAgents({
    platform: 'win32',
    env: {},
    resolveExecutableFn: async kind => kind === 'claude' ? executable : null,
    prepareCommandFn: (command, args) => ({ command: 'node.exe', args: ['claude.js', ...args] }),
    execFileFn: async (command, args) => {
      calls.push({ command, args })
      return { stdout: '2.1.0\r\nbuild metadata\r\n', stderr: '' }
    },
  })

  assert.deepEqual(calls, [{ command: 'node.exe', args: ['claude.js', '--version'] }])
  assert.deepEqual(found, [{
    kind: 'claude',
    name: 'Claude CLI',
    executable,
    version: '2.1.0',
  }])
})

test('Agent detection ignores blank output and startup warnings before the version line', async () => {
  const found = await detectAgents({
    platform: 'darwin',
    env: {},
    resolveExecutableFn: async kind => kind === 'kimi' ? '/tmp/kimi' : null,
    execFileFn: async () => ({
      stdout: '  \n',
      stderr: 'experimental startup warning\nKimi Code 0.19.2\n',
    }),
  })

  assert.deepEqual(found, [{
    kind: 'kimi',
    name: 'Kimi CLI',
    executable: '/tmp/kimi',
    version: 'Kimi Code 0.19.2',
  }])
})

test('Agent detection rejects login prompts and other non-version output', async () => {
  const found = await detectAgents({
    platform: 'darwin',
    env: {},
    resolveExecutableFn: async kind => kind === 'kimi' ? '/tmp/kimi' : null,
    execFileFn: async () => ({ stdout: 'Please log in first\n', stderr: '' }),
  })

  assert.deepEqual(found, [])
})

test('Agent detection passes only allowlisted system environment to version commands', async () => {
  const calls = []
  const found = await detectAgents({
    platform: 'darwin',
    home: '/Users/Ryder',
    env: {
      HOME: '/Users/Ryder',
      LANG: 'zh_CN.UTF-8',
      PATH: '/custom/bin',
      ROUNDRELAY_PRIVATE_VALUE: 'desktop-private-value',
      OPENAI_API_KEY: 'provider-secret',
    },
    resolveExecutableFn: async kind => kind === 'kimi' ? '/tmp/kimi' : null,
    execFileFn: async (_command, _args, options) => {
      calls.push(options.env)
      return { stdout: '0.19.2\n', stderr: '' }
    },
  })

  assert.equal(found.length, 1)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].HOME, '/Users/Ryder')
  assert.equal(calls[0].LANG, 'zh_CN.UTF-8')
  assert.match(calls[0].PATH, /\/custom\/bin/)
  assert.equal(calls[0].ROUNDRELAY_PRIVATE_VALUE, undefined)
  assert.equal(calls[0].OPENAI_API_KEY, undefined)
})

test('Agent detection excludes executable shims that cannot report a version', async () => {
  const found = await detectAgents({
    platform: 'darwin',
    env: {},
    resolveExecutableFn: async kind => kind === 'codex' ? '/tmp/codex' : null,
    execFileFn: async () => { throw new Error('broken shim') },
  })

  assert.deepEqual(found, [])
})

test('runAgent hides executable paths from spawn failures', async () => {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => true
  const outcome = runAgent(
    { kind: 'codex', executable: '/private/agents/codex', name: 'Codex' },
    'hello',
    '/private/workspace',
    { spawnFn: () => child },
  )

  child.emit('error', new Error('spawn /private/agents/codex ENOENT'))

  await assert.rejects(outcome, (error) => {
    assert.equal(error.message, 'LOCAL_AGENT_SPAWN_FAILED')
    assert.doesNotMatch(error.message, /private|codex/)
    assert.equal(error.diagnostic, 'spawn /private/agents/codex ENOENT')
    assert.equal(Object.prototype.propertyIsEnumerable.call(error, 'diagnostic'), false)
    return true
  })

  await assert.rejects(
    runAgent(
      { kind: 'codex', executable: '/private/agents/codex', name: 'Codex' },
      'hello',
      '/private/workspace',
      { spawnFn: () => { throw new Error('spawn /private/agents/codex ENOENT') } },
    ),
    (error) => {
      assert.equal(error.message, 'LOCAL_AGENT_SPAWN_FAILED')
      assert.equal(error.diagnostic, 'spawn /private/agents/codex ENOENT')
      assert.equal(Object.prototype.propertyIsEnumerable.call(error, 'diagnostic'), false)
      return true
    },
  )
})

test('runAgent escalates cancellation when the CLI ignores SIGTERM', {
  skip: process.platform === 'win32',
}, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-cli-abort-'))
  const readyFile = path.join(directory, 'ready')
  const cli = executable(directory, 'ignore-term.cjs', `
const fs = require('node:fs')
fs.writeFileSync(process.argv.at(-1), String(process.pid))
process.on('SIGTERM', () => {})
setInterval(() => {}, 1000)
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const controller = new AbortController()
  const outcome = runAgent(
    { kind: 'hermes', executable: cli, name: 'Hermes' },
    readyFile,
    directory,
    { signal: controller.signal, hermesMessageWatermarkFn: () => 0 },
  ).then(value => ({ value }), error => ({ error }))
  const pid = Number(await readWhenReady(readyFile))

  controller.abort()

  const result = await within(outcome)
  assert.equal(result.error?.message, 'LOCAL_AGENT_EXECUTION_STOPPED')
  await waitForExit(pid)
})

test('runAgent cancellation closes pipes inherited by a descendant process', {
  skip: process.platform === 'win32',
}, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-cli-tree-'))
  const readyFile = path.join(directory, 'ready.json')
  const cli = executable(directory, 'spawn-descendant.cjs', `
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const descendant = spawn(process.execPath, ['-e', [
  "process.on('SIGTERM', () => {})",
  'setInterval(() => {}, 1000)',
].join(';')], { stdio: ['ignore', 'inherit', 'inherit'] })
fs.writeFileSync(process.argv.at(-1), JSON.stringify({ parent: process.pid, descendant: descendant.pid }))
setInterval(() => {}, 1000)
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const controller = new AbortController()
  const outcome = runAgent(
    { kind: 'hermes', executable: cli, name: 'Hermes' },
    readyFile,
    directory,
    { signal: controller.signal, hermesMessageWatermarkFn: () => 0 },
  ).then(value => ({ value }), error => ({ error }))
  const pids = await readJsonWhenReady(readyFile)

  controller.abort()

  const result = await within(outcome)
  assert.equal(result.error?.message, 'LOCAL_AGENT_EXECUTION_STOPPED')
  await Promise.all([waitForExit(pids.parent), waitForExit(pids.descendant)])
})

test('Windows Agent cancellation terminates the full process tree with taskkill', async () => {
  const controller = new AbortController()
  const child = new EventEmitter()
  child.pid = 4321
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => true
  const killer = new EventEmitter()
  killer.unref = () => {}
  const calls = []
  const outcome = runAgent(
    { kind: 'codex', executable: 'C:\\Tools\\codex.exe', name: 'Codex' },
    'hello',
    'C:\\work',
    {
      platform: 'win32',
      signal: controller.signal,
      spawnFn: (command, args, options) => {
        calls.push({ command, args, options })
        return calls.length === 1 ? child : killer
      },
    },
  )

  controller.abort()
  child.emit('close', 1, 'SIGTERM')

  await assert.rejects(outcome, { message: 'LOCAL_AGENT_EXECUTION_STOPPED' })
  assert.equal(calls[1].command, 'taskkill.exe')
  assert.deepEqual(calls[1].args, ['/PID', '4321', '/T', '/F'])
})
