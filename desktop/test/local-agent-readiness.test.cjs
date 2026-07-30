const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  nativeCredentialEnvironment,
  nativeCredentialState,
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
