const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  nativeCredentialEnvironment,
  nativeCredentialState,
  resolveNativeOpenClawRuntime,
  resolveNativeCredentialState,
} = require('../src/local-agent-readiness.cjs')

test('Hermes readiness detects a native credential without returning its value', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-hermes-readiness-'))
  const secret = 'hermes-secret-value'
  fs.mkdirSync(path.join(home, '.hermes'), { recursive: true })
  fs.writeFileSync(path.join(home, '.hermes', '.env'), `OPENAI_API_KEY=${secret}\n`)

  try {
    const result = nativeCredentialState('hermes', { home })
    assert.deepEqual(result, { state: 'ready', source: 'native-credential' })
    assert.equal(JSON.stringify(result).includes(secret), false)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('WorkBuddy readiness checks configured model keys without exposing them', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-workbuddy-readiness-'))
  const secret = 'workbuddy-secret-value'
  fs.mkdirSync(path.join(home, '.workbuddy'), { recursive: true })
  fs.writeFileSync(path.join(home, '.workbuddy', 'models.json'), JSON.stringify([
    { id: 'glm', apiKey: secret },
  ]))

  try {
    const result = nativeCredentialState('workbuddy', { home })
    assert.deepEqual(result, { state: 'ready', source: 'native-credential' })
    assert.equal(JSON.stringify(result).includes(secret), false)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('native readiness recognizes credential files for every supported CLI', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-native-readiness-'))
  const fixtures = [
    ['codex', ['.codex', 'auth.json'], { tokens: { access_token: 'codex-secret' } }],
    ['hermes', ['.hermes', 'auth.json'], { access_token: 'hermes-secret' }],
    ['openclaw', ['.openclaw', 'openclaw.json'], { gateway: { auth: { token: 'claw-secret' } } }],
    ['workbuddy', ['.workbuddy', 'models.json'], [{ apiKey: 'workbuddy-secret' }]],
    ['kimi', ['.kimi-code', 'credentials', 'kimi-code.json'], { refresh_token: 'kimi-secret' }],
    ['claude', ['.claude', '.credentials.json'], { oauth: { accessToken: 'claude-secret' } }],
    ['qwen', ['.qwen', 'oauth_creds.json'], { access_token: 'qwen-secret' }],
    ['gemini', ['.gemini', 'oauth_creds.json'], { refresh_token: 'gemini-secret' }],
    ['opencode', ['.local', 'share', 'opencode', 'auth.json'], { openai: { token: 'opencode-secret' } }],
    ['opencodereview', ['.opencodereview', 'config.json'], { llm: { auth_token: 'ocr-secret' } }],
  ]
  try {
    for (const [, segments, value] of fixtures) {
      const filename = path.join(home, ...segments)
      fs.mkdirSync(path.dirname(filename), { recursive: true })
      fs.writeFileSync(filename, JSON.stringify(value))
    }
    for (const [kind] of fixtures) {
      assert.deepEqual(nativeCredentialState(kind, { home, env: {} }), {
        state: 'ready', source: 'native-credential',
      })
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('Claude readiness uses the official auth status without exposing OAuth data', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-claude-readiness-'))
  const calls = []
  try {
    const result = await resolveNativeCredentialState('claude', {
      home,
      env: { PATH: '/usr/bin', ROUNDRELAY_PRIVATE_VALUE: 'desktop-private-value' },
      executable: '/tmp/claude',
      execFileFn: async (command, args, options) => {
        calls.push({ command, args, env: options.env })
        return { stdout: JSON.stringify({ loggedIn: true, authMethod: 'oauth_token' }) }
      },
    })

    assert.deepEqual(result, { state: 'ready', source: 'native-auth-status' })
    assert.deepEqual(calls[0].args, ['auth', 'status', '--json'])
    assert.equal(calls[0].env.ROUNDRELAY_PRIVATE_VALUE, undefined)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('OpenClaw readiness uses the official model status when auth is stored outside its config', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-openclaw-readiness-'))
  const agentDir = path.join(home, '.openclaw', 'agents', 'main', 'agent')
  fs.mkdirSync(agentDir, { recursive: true })
  const calls = []
  try {
    const result = await resolveNativeCredentialState('openclaw', {
      home,
      env: { PATH: '/usr/bin', ROUNDRELAY_PRIVATE_VALUE: 'desktop-private-value' },
      executable: '/tmp/openclaw',
      execFileFn: async (command, args, options) => {
        calls.push({ command, args, env: options.env })
        return {
          stdout: JSON.stringify({
            defaultModel: 'provider/model',
            resolvedDefault: 'provider/model',
            agentDir,
            auth: { missingProvidersInUse: [], unusableProfiles: ['unused-expired-profile'] },
          }),
        }
      },
    })

    assert.deepEqual(result, { state: 'ready', source: 'native-auth-status' })
    assert.deepEqual(calls[0].args, ['models', 'status', '--check', '--json'])
    assert.equal(calls[0].env.ROUNDRELAY_PRIVATE_VALUE, undefined)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('OpenClaw native runtime extracts only the current validated Provider', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-openclaw-runtime-status-'))
  const agentDir = path.join(home, '.openclaw', 'agents', 'main', 'agent')
  fs.mkdirSync(agentDir, { recursive: true })
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const secret = 'native-openclaw-secret'
  const calls = []
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      provider: {
        baseUrl: 'https://provider.example/v1/',
        api: 'openai-completions',
        apiKey: secret,
        headers: { Authorization: 'must-not-copy' },
        tools: { allow: ['exec'] },
        models: [
          { id: 'other', name: 'Other' },
          {
            id: 'model-v1',
            name: 'Model V1',
            input: ['text'],
            contextWindow: 128000,
            maxTokens: 4096,
            reasoning: false,
            cost: { input: 0, output: 0, unsafe: 1 },
            params: { unsafe: true },
          },
        ],
      },
    },
  }))

  const runtime = await resolveNativeOpenClawRuntime({
    home,
    env: {},
    executable: '/tmp/openclaw',
    execFileFn: async (_command, args, options) => {
      calls.push({ args, env: options.env })
      return { stdout: JSON.stringify({
        resolvedDefault: 'provider/model-v1',
        agentDir,
        auth: { missingProvidersInUse: [], profiles: [{ token: 'ignored' }] },
      }) }
    },
  })

  assert.deepEqual(runtime, {
    model: 'provider/model-v1',
    provider: {
      id: 'provider',
      baseUrl: 'https://provider.example/v1',
      api: 'openai-completions',
      apiKey: secret,
      model: {
        id: 'model-v1',
        name: 'Model V1',
        input: ['text'],
        contextWindow: 128000,
        maxTokens: 4096,
        reasoning: false,
        cost: { input: 0, output: 0 },
      },
    },
  })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args, ['models', 'status', '--check', '--json'])
  assert.equal(Object.hasOwn(runtime, 'auth'), false)
  assert.equal(Object.hasOwn(runtime, 'agentDir'), false)
  assert.equal(Object.hasOwn(runtime.provider, 'headers'), false)
  assert.equal(Object.hasOwn(runtime.provider.model, 'params'), false)
})

test('OpenClaw native runtime rejects Env SecretRefs without reading unrelated process secrets', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-openclaw-runtime-env-'))
  const agentDir = path.join(home, '.openclaw', 'agents', 'main', 'agent')
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      provider: {
        baseUrl: 'https://attacker.example/v1',
        api: 'openai-responses',
        apiKey: { source: 'env', provider: 'default', id: 'GITHUB_TOKEN' },
        models: [{ id: 'model', name: 'Model', input: ['text'] }],
      },
    },
  }))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const calls = []
  await assert.rejects(resolveNativeOpenClawRuntime({
    home,
    env: { PATH: '/usr/bin', GITHUB_TOKEN: 'must-not-leave-process' },
    executable: '/tmp/openclaw',
    execFileFn: async (_command, args, options) => {
      calls.push({ args, env: options.env })
      return { stdout: JSON.stringify({
        resolvedDefault: 'provider/model', agentDir,
        auth: { missingProvidersInUse: [] },
      }) }
    },
  }), { message: 'OPENCLAW_NATIVE_RUNTIME_UNAVAILABLE' })

  assert.equal(calls[0].env.GITHUB_TOKEN, undefined)
})

test('OpenClaw native runtime rejects unsafe status and Provider descriptors', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-openclaw-runtime-invalid-'))
  const agentDir = path.join(home, '.openclaw', 'agents', 'main', 'agent')
  fs.mkdirSync(agentDir, { recursive: true })
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const validStatus = {
    resolvedDefault: 'provider/model', agentDir,
    auth: { missingProvidersInUse: [] },
  }
  const validProvider = {
    baseUrl: 'https://provider.example/v1',
    api: 'openai-completions',
    apiKey: 'secret',
    models: [{ id: 'model', name: 'Model', input: ['text'] }],
  }
  const outsideAgentDir = path.join(home, 'outside-agent')
  fs.mkdirSync(outsideAgentDir)
  fs.writeFileSync(path.join(outsideAgentDir, 'models.json'), JSON.stringify({
    providers: { provider: validProvider },
  }))
  const invalid = [
    [{ resolvedDefault: 'provider/model', auth: { missingProvidersInUse: [] } }, validProvider],
    [{ ...validStatus, agentDir: 'relative' }, validProvider],
    [{ ...validStatus, resolvedDefault: 'provider.id/model' }, validProvider],
    [{ ...validStatus, agentDir: path.join(home, 'missing') }, validProvider],
    [{ ...validStatus, agentDir: outsideAgentDir }, validProvider],
    [validStatus, { ...validProvider, baseUrl: 'http://provider.example/v1' }],
    [validStatus, { ...validProvider, api: 'unknown-api' }],
    [validStatus, { ...validProvider, apiKey: '' }],
    [validStatus, { ...validProvider, models: [{ id: 'other', name: 'Other', input: ['text'] }] }],
    [validStatus, {
      ...validProvider,
      apiKey: { source: 'file', provider: 'default', id: '/tmp/secret' },
    }],
  ]

  for (const [status, provider] of invalid) {
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
      providers: { provider },
    }))
    await assert.rejects(
      resolveNativeOpenClawRuntime({
        home,
        env: {},
        executable: '/tmp/openclaw',
        execFileFn: async () => ({ stdout: JSON.stringify(status) }),
      }),
      { message: 'OPENCLAW_NATIVE_RUNTIME_UNAVAILABLE' },
    )
  }

  if (process.platform !== 'win32') {
    const outsideModels = path.join(home, 'outside-models.json')
    fs.writeFileSync(outsideModels, JSON.stringify({ providers: { provider: validProvider } }))
    fs.rmSync(path.join(agentDir, 'models.json'), { force: true })
    fs.symlinkSync(outsideModels, path.join(agentDir, 'models.json'))
    await assert.rejects(resolveNativeOpenClawRuntime({
      home,
      env: {},
      executable: '/tmp/openclaw',
      execFileFn: async () => ({ stdout: JSON.stringify(validStatus) }),
    }), { message: 'OPENCLAW_NATIVE_RUNTIME_UNAVAILABLE' })
  }
})

test('OpenClaw model status overrides a stale gateway token without exposing auth details', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-openclaw-stale-auth-'))
  const configPath = path.join(home, '.openclaw', 'openclaw.json')
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify({ gateway: { auth: { token: 'gateway-only-token' } } }))
  try {
    const error = Object.assign(new Error('missing provider auth'), {
      stdout: JSON.stringify({
        defaultModel: 'provider/model',
        resolvedDefault: 'provider/model',
        auth: { missingProvidersInUse: ['provider'], unusableProfiles: [] },
      }),
    })
    const result = await resolveNativeCredentialState('openclaw', {
      home,
      env: {},
      executable: '/tmp/openclaw',
      execFileFn: async () => { throw error },
    })

    assert.deepEqual(result, { state: 'missing', source: 'native-auth-status' })
    assert.equal(JSON.stringify(result).includes('gateway-only-token'), false)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('MiMo readiness relies on the installed CLI and does not inspect private auth storage', async () => {
  assert.deepEqual(await resolveNativeCredentialState('mimo', {}), {
    state: 'ready', source: 'native-cli',
  })
})

test('Claude auth status overrides a stale credential file', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-claude-stale-auth-'))
  const credentialPath = path.join(home, '.claude', '.credentials.json')
  fs.mkdirSync(path.dirname(credentialPath), { recursive: true })
  fs.writeFileSync(credentialPath, JSON.stringify({ oauth: { accessToken: 'expired-token' } }))
  let calls = 0
  try {
    const result = await resolveNativeCredentialState('claude', {
      home,
      env: {},
      executable: '/tmp/claude',
      execFileFn: async () => {
        calls += 1
        return { stdout: JSON.stringify({ loggedIn: false }) }
      },
    })

    assert.deepEqual(result, { state: 'missing', source: 'native-auth-status' })
    assert.equal(calls, 1)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('an installed Agent without credential evidence remains unverified', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-missing-readiness-'))
  try {
    assert.deepEqual(nativeCredentialState('workbuddy', { home }), {
      state: 'unknown', source: 'unverified',
    })
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('native environment forwarding includes only the current Agent credential keys', () => {
  assert.deepEqual(nativeCredentialEnvironment('claude', {
    ANTHROPIC_API_KEY: 'claude-key',
    OPENAI_API_KEY: 'unrelated-openai-key',
    ROUNDRELAY_PRIVATE_VALUE: 'desktop-private-value',
  }), {
    ANTHROPIC_API_KEY: 'claude-key',
  })
})
