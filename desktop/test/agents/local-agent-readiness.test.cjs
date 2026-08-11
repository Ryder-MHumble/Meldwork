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
  resolveNativeShellEnvironment,
} = require('../../src/agents/local-agent-readiness.cjs')

function openClawModelsCatalog(apiKey, baseUrl = 'https://provider.example/v1') {
  return JSON.stringify({
    providers: {
      provider: {
        baseUrl,
        api: 'openai-completions',
        apiKey,
        models: [{ id: 'model', name: 'Model', input: ['text'] }],
      },
    },
  })
}

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

test('custom Provider config is recognized while unresolved Env references remain unverified', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-custom-provider-readiness-'))
  const config = path.join(home, '.hermes', 'config.yaml')
  fs.mkdirSync(path.dirname(config), { recursive: true })
  try {
    fs.writeFileSync(config, [
      'provider: custom',
      'base_url: https://gateway.example/v1',
      'model: local-model',
      'api_key: sk-custom-provider',
    ].join('\n'))
    assert.deepEqual(nativeCredentialState('hermes', { home, env: {} }), {
      state: 'ready', source: 'native-credential',
    })

    fs.writeFileSync(config, 'api_key: ${OPENROUTER_API_KEY}\n')
    assert.deepEqual(nativeCredentialState('hermes', { home, env: {} }), {
      state: 'unknown', source: 'unverified',
    })
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('login shell discovery returns only allowlisted Agent Provider values', async () => {
  const calls = []
  const result = await resolveNativeShellEnvironment({
    cache: false,
    platform: 'darwin',
    home: '/Users/Ryder',
    shell: '/bin/zsh',
    env: {
      PATH: '/usr/bin',
      GITHUB_TOKEN: 'ambient-secret',
      ROUNDRELAY_PRIVATE_VALUE: 'desktop-private-value',
    },
    execFileFn: async (command, args, options) => {
      calls.push({ command, args, options })
      return {
        stdout: [
          'shell startup banner\n__ROUNDRELAY_NATIVE_ENV_V1__',
          'PATH=/opt/custom/bin:/usr/bin',
          'OPENROUTER_API_KEY=openrouter-secret',
          'OPENAI_BASE_URL=https://openrouter.ai/api/v1',
          'OPENAI_MODEL=openrouter/model',
          'GITHUB_TOKEN=must-not-be-read',
          '',
        ].join('\u0000'),
      }
    },
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, '/bin/zsh')
  assert.equal(calls[0].args[0], '-lic')
  assert.equal(calls[0].options.env.GITHUB_TOKEN, undefined)
  assert.equal(calls[0].options.env.ROUNDRELAY_PRIVATE_VALUE, undefined)
  assert.equal(calls[0].args[1].includes('ambient-secret'), false)
  assert.deepEqual(result, {
    source: 'native-shell',
    env: {
      PATH: '/opt/custom/bin:/usr/bin',
      OPENROUTER_API_KEY: 'openrouter-secret',
      OPENAI_BASE_URL: 'https://openrouter.ai/api/v1',
      OPENAI_MODEL: 'openrouter/model',
    },
  })
})

test('shell discovery failure falls back to allowlisted process Provider values', async () => {
  const result = await resolveNativeShellEnvironment({
    cache: false,
    platform: 'darwin',
    shell: '/bin/zsh',
    env: {
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'process-provider-key',
      OPENAI_BASE_URL: 'https://gateway.example/v1',
      ROUNDRELAY_PRIVATE_VALUE: 'desktop-private-value',
    },
    execFileFn: async () => { throw new Error('shell unavailable') },
  })

  assert.deepEqual(result, {
    source: 'process',
    env: {
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'process-provider-key',
      OPENAI_BASE_URL: 'https://gateway.example/v1',
    },
  })
})

test('OpenRouter credentials loaded from the native shell mark Hermes ready', async () => {
  const result = await resolveNativeCredentialState('hermes', {
    env: {
      OPENROUTER_API_KEY: 'openrouter-key',
      OPENAI_BASE_URL: 'https://openrouter.ai/api/v1',
      OPENAI_MODEL: 'openrouter/model',
    },
    credentialSource: 'native-shell',
  })

  assert.deepEqual(result, { state: 'ready', source: 'native-shell' })
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
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      provider: {
        baseUrl: 'https://provider.example/v1',
        api: 'openai-completions',
        apiKey: 'native-openclaw-secret',
        models: [{ id: 'model', name: 'Model', input: ['text'] }],
      },
    },
  }))
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

test('OpenClaw native runtime resolves allowlisted Env SecretRefs from the shell environment', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-openclaw-env-runtime-'))
  const agentDir = path.join(home, '.openclaw', 'agents', 'main', 'agent')
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(path.join(agentDir, 'models.json'), openClawModelsCatalog({
    source: 'env', provider: 'default', id: 'OPENROUTER_API_KEY',
  }, 'https://openrouter.ai/api/v1'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))

  const runtime = await resolveNativeOpenClawRuntime({
    home,
    env: { OPENROUTER_API_KEY: 'openrouter-native-key' },
    executable: '/tmp/openclaw',
    execFileFn: async () => ({ stdout: JSON.stringify({
      resolvedDefault: 'provider/model', agentDir,
      auth: { missingProvidersInUse: [] },
    }) }),
  })

  assert.equal(runtime.provider.apiKey, 'openrouter-native-key')
  assert.equal(JSON.stringify(runtime).includes('OPENROUTER_API_KEY'), false)
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

test('OpenClaw native runtime rejects every structured and string SecretRef marker', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-openclaw-secretrefs-'))
  const agentDir = path.join(home, '.openclaw', 'agents', 'main', 'agent')
  fs.mkdirSync(agentDir, { recursive: true })
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const refs = [
    { source: 'env', provider: 'default', id: 'GITHUB_TOKEN' },
    { source: 'file', provider: 'default', id: '/tmp/secret' },
    { source: 'exec', provider: 'default', id: 'secret-command' },
    { source: 'env', id: 'GITHUB_TOKEN' },
    '$GITHUB_TOKEN',
    '${GITHUB_TOKEN}',
    'secretref-env:GITHUB_TOKEN',
    '__env__:GITHUB_TOKEN',
    'secretref-managed',
    'GITHUB_TOKEN',
    'AWS_PROFILE',
    'oauth:github',
    'custom-local',
    'gcp-vertex-credentials',
  ]

  for (const apiKey of refs) {
    fs.writeFileSync(path.join(agentDir, 'models.json'), openClawModelsCatalog(apiKey))
    await assert.rejects(resolveNativeOpenClawRuntime({
      home,
      env: {
        PATH: '/usr/bin',
        GITHUB_TOKEN: 'must-not-leave-process',
        AWS_PROFILE: 'must-not-leave-process',
      },
      executable: '/tmp/openclaw',
      execFileFn: async (_command, _args, options) => {
        assert.equal(options.env.GITHUB_TOKEN, undefined)
        assert.equal(options.env.AWS_PROFILE, undefined)
        return { stdout: JSON.stringify({
          resolvedDefault: 'provider/model', agentDir,
          auth: { missingProvidersInUse: [] },
        }) }
      },
    }), { message: 'OPENCLAW_NATIVE_RUNTIME_UNAVAILABLE' })
  }
})

test('OpenClaw native runtime rejects ancestor path changes while reading models', {
  skip: process.platform === 'win32',
}, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-openclaw-model-path-'))
  const agentDir = path.join(home, '.openclaw', 'agents', 'main', 'agent')
  const external = path.join(home, 'external-agent')
  fs.mkdirSync(agentDir, { recursive: true })
  fs.mkdirSync(external)
  fs.writeFileSync(path.join(agentDir, 'models.json'), openClawModelsCatalog('inside-key'))
  fs.writeFileSync(path.join(external, 'models.json'), openClawModelsCatalog('outside-key'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))

  const canonicalAgentDir = fs.realpathSync(agentDir)
  const modelsPath = path.join(canonicalAgentDir, 'models.json')
  const originalLstat = fs.lstatSync
  let redirected = false
  fs.lstatSync = function guardedLstat(filename, ...args) {
    const stat = originalLstat.call(this, filename, ...args)
    if (!redirected && String(filename) === modelsPath) {
      redirected = true
      fs.renameSync(agentDir, `${agentDir}.original`)
      fs.symlinkSync(external, agentDir, 'dir')
    }
    return stat
  }

  try {
    await assert.rejects(resolveNativeOpenClawRuntime({
      home,
      env: {},
      executable: '/tmp/openclaw',
      execFileFn: async () => ({ stdout: JSON.stringify({
        resolvedDefault: 'provider/model', agentDir,
        auth: { missingProvidersInUse: [] },
      }) }),
    }), { message: 'OPENCLAW_NATIVE_RUNTIME_UNAVAILABLE' })
  } finally {
    fs.lstatSync = originalLstat
  }
})

test('OpenClaw native runtime rejects models file identity changes after opening', {
  skip: process.platform === 'win32',
}, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-openclaw-model-inode-'))
  const agentDir = path.join(home, '.openclaw', 'agents', 'main', 'agent')
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(path.join(agentDir, 'models.json'), openClawModelsCatalog('inside-key'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))

  const modelsPath = path.join(fs.realpathSync(agentDir), 'models.json')
  const originalOpen = fs.openSync
  let replaced = false
  fs.openSync = function guardedOpen(filename, ...args) {
    const descriptor = originalOpen.call(this, filename, ...args)
    if (!replaced && String(filename) === modelsPath) {
      replaced = true
      fs.renameSync(modelsPath, `${modelsPath}.original`)
      fs.writeFileSync(modelsPath, openClawModelsCatalog('replacement-key'))
    }
    return descriptor
  }

  try {
    await assert.rejects(resolveNativeOpenClawRuntime({
      home,
      env: {},
      executable: '/tmp/openclaw',
      execFileFn: async () => ({ stdout: JSON.stringify({
        resolvedDefault: 'provider/model', agentDir,
        auth: { missingProvidersInUse: [] },
      }) }),
    }), { message: 'OPENCLAW_NATIVE_RUNTIME_UNAVAILABLE' })
  } finally {
    fs.openSync = originalOpen
  }
})

test('OpenClaw native runtime rejects in-place models changes while reading', {
  skip: process.platform === 'win32',
}, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-openclaw-model-content-'))
  const agentDir = path.join(home, '.openclaw', 'agents', 'main', 'agent')
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(path.join(agentDir, 'models.json'), openClawModelsCatalog('inside-key'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))

  const modelsPath = path.join(fs.realpathSync(agentDir), 'models.json')
  const originalReadFile = fs.readFileSync
  const originalIdentity = fs.statSync(modelsPath).ino
  let modified = false
  fs.readFileSync = function guardedReadFile(filename, ...args) {
    const contents = originalReadFile.call(this, filename, ...args)
    if (!modified && typeof filename === 'number') {
      modified = true
      fs.writeFileSync(modelsPath, openClawModelsCatalog('edited-key'))
      assert.equal(fs.statSync(modelsPath).ino, originalIdentity)
    }
    return contents
  }

  try {
    await assert.rejects(resolveNativeOpenClawRuntime({
      home,
      env: {},
      executable: '/tmp/openclaw',
      execFileFn: async () => ({ stdout: JSON.stringify({
        resolvedDefault: 'provider/model', agentDir,
        auth: { missingProvidersInUse: [] },
      }) }),
    }), { message: 'OPENCLAW_NATIVE_RUNTIME_UNAVAILABLE' })
  } finally {
    fs.readFileSync = originalReadFile
  }
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
    assert.deepEqual(await resolveNativeCredentialState('openclaw', {
      home,
      env: {},
      executable: '/tmp/openclaw',
      execFileFn: async () => ({ stdout: JSON.stringify(status) }),
    }), {
      state: 'unknown', source: 'native-runtime-unavailable',
    })
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

test('MiMo readiness uses the installed CLI identity without forwarding private values', async () => {
  const calls = []
  for (const stdout of [
    '\u001b[32mProvider: MiMo\u001b[0m\nUser ID: user-123',
    'Provider: MiMo\nType: OAuth',
  ]) {
    const result = await resolveNativeCredentialState('mimo', {
      env: { PATH: '/usr/bin', ROUNDRELAY_PRIVATE_VALUE: 'desktop-private-value' },
      executable: '/tmp/mimo',
      execFileFn: async (command, args, options) => {
        calls.push({ command, args, env: options.env })
        return { stdout }
      },
    })

    assert.deepEqual(result, { state: 'ready', source: 'native-auth-status' })
  }
  assert.deepEqual(calls.map(call => call.args), [
    ['providers', 'whoami'],
    ['providers', 'whoami'],
  ])
  assert.equal(calls.every(call => call.env.ROUNDRELAY_PRIVATE_VALUE === undefined), true)
})

test('MiMo readiness recognizes ANSI-colored logged-out output even when the CLI exits zero', async () => {
  const result = await resolveNativeCredentialState('mimo', {
    env: {},
    executable: '/tmp/mimo',
    execFileFn: async () => ({
      stdout: '\u001b[0m\n\u001b[31mNot logged in. Run `mimo auth login` to log in.\u001b[0m',
    }),
  })

  assert.deepEqual(result, { state: 'missing', source: 'native-auth-status' })
})

test('MiMo readiness remains unknown for missing or malformed identity output', async () => {
  assert.deepEqual(await resolveNativeCredentialState('mimo', {}), {
    state: 'unknown', source: 'unverified',
  })

  for (const stdout of [
    '',
    'Provider: MiMo\nUser ID:',
    'Provider: Other\nUser ID: user-123',
    'User ID: user-123',
    'Authentication status unavailable',
  ]) {
    const result = await resolveNativeCredentialState('mimo', {
      env: {},
      executable: '/tmp/mimo',
      execFileFn: async () => ({ stdout }),
    })
    assert.deepEqual(result, { state: 'unknown', source: 'unverified' })
  }
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

  assert.deepEqual(nativeCredentialEnvironment('hermes', {
    OPENROUTER_API_KEY: 'openrouter-key',
    OPENAI_BASE_URL: 'https://openrouter.ai/api/v1',
    OPENAI_MODEL: 'openrouter/model',
    GITHUB_TOKEN: 'unrelated-secret',
  }), {
    OPENROUTER_API_KEY: 'openrouter-key',
    OPENAI_BASE_URL: 'https://openrouter.ai/api/v1',
    OPENAI_MODEL: 'openrouter/model',
  })
})
