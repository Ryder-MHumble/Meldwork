const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const {
  detectAgents,
  invocation,
  normalizeOutput,
  parseCodexOutput,
  parseGeminiOutput,
  parseKimiOutput,
  parseOpenCodeOutput,
  parseWorkBuddyOutput,
  prepareCommand,
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
      return fs.readFileSync(filename, 'utf8')
    } catch {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
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

test('Hermes accepts an explicit OpenAI-compatible provider without exposing its key in arguments', () => {
  const spec = invocation('hermes', '/tmp/hermes', '/tmp', '', {
    provider: { id: 'openai-api', model: 'glm' },
  })
  assert.deepEqual(spec.args, [
    'chat', '--quiet', '--provider', 'openai-api', '--model', 'glm', '--query',
  ])
  assert.equal(spec.args.some(value => value.includes('test-secret')), false)
})

test('runAgent forces Hermes execution confirmation even when callers request yolo mode', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-hermes-env-'))
  const cli = executable(directory, 'hermes-env.cjs', `
process.stdout.write(JSON.stringify({
  ask: process.env.HERMES_EXEC_ASK,
  yolo: process.env.HERMES_YOLO_MODE,
}))
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const result = await runAgent(
    { kind: 'hermes', executable: cli, name: 'Hermes' },
    'hello',
    directory,
    { env: { HERMES_EXEC_ASK: '0', HERMES_YOLO_MODE: '1' } },
  )

  assert.deepEqual(JSON.parse(result.text), { ask: '1', yolo: '' })
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
  )

  assert.deepEqual(result, {
    text: 'Hermes reply',
    sessionRef: 'hermes-session-123',
  })
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

test('Kimi uses stream JSON prompt mode and resumes its native session', () => {
  const chat = invocation('kimi', '/tmp/kimi', '/tmp/work')
  assert.deepEqual(chat.args, ['--output-format', 'stream-json', '--plan', '--prompt'])
  assert.equal(chat.promptArg, true)

  const resumed = invocation('kimi', '/tmp/kimi', '/tmp/work', 'kimi-session', {
    sandbox: 'workspace-write',
  })
  assert.deepEqual(resumed.args, [
    '--output-format', 'stream-json', '--session', 'kimi-session', '--prompt',
  ])
  assert.equal(resumed.args.includes('--plan'), false)
  assert.equal(resumed.args.includes('--auto'), false)
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

test('Claude uses JSON output and resumes its native session', () => {
  const spec = invocation('claude', '/tmp/claude', '/tmp/work', 'claude-session')
  assert.deepEqual(spec.args, [
    '--print', '--output-format', 'json', '--permission-mode', 'plan',
    '--resume', 'claude-session',
  ])
  assert.equal(spec.promptArg, true)
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
    { signal: controller.signal },
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
    { signal: controller.signal },
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
