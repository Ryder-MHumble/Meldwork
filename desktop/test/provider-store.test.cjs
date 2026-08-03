const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { ProviderStore } = require('../src/provider-store.cjs')

const PROVIDER = Object.freeze({
  provider: 'OpenAI Compatible',
  baseUrl: 'https://api.example.com/v1',
  model: 'example-model',
})
const OPENROUTER_PROVIDER = Object.freeze({
  provider: 'OpenRouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  model: 'openrouter/example-model',
})
const HERMES_OFFICIAL_PROVIDER = Object.freeze({
  provider: 'OpenAI API',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-5',
})
const QWEN_OFFICIAL_PROVIDER = Object.freeze({
  provider: 'DashScope',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model: 'qwen3-coder-plus',
})
const OCR_OFFICIAL_PROVIDER = Object.freeze({
  provider: 'OpenAI API',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-5',
})

function credential(apiKey = 'test-provider-key', metadata = PROVIDER, preset = 'custom') {
  return { ...metadata, apiKey, preset }
}

function emptyStatus(encryptionAvailable) {
  return {
    provider: '', baseUrl: '', model: '', activePreset: 'official', profiles: {},
    encryptionAvailable, configured: false,
  }
}

function configuredStatus(metadata = PROVIDER, preset = 'custom') {
  return {
    ...metadata,
    activePreset: preset,
    profiles: { [preset]: { ...metadata, configured: true } },
    encryptionAvailable: true,
    configured: true,
  }
}

function encryptedSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: value => Buffer.from(value, 'utf8').map(byte => byte ^ 0xaa),
    decryptString: value => Buffer.from(value).map(byte => byte ^ 0xaa).toString('utf8'),
  }
}

function fixture(safeStorage = encryptedSafeStorage(), allowedKinds = ['hermes', 'qwen', 'opencodereview']) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-provider-'))
  const storagePath = path.join(directory, 'roundrelay-provider.json')
  return {
    directory,
    storagePath,
    store: new ProviderStore({ storagePath, safeStorage, allowedKinds }),
  }
}

test('status exposes user-configured metadata without the API key', (t) => {
  const { directory, store } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  assert.deepEqual(store.status('hermes'), emptyStatus(null))

  store.save('hermes', credential())
  const status = store.status('hermes')
  assert.deepEqual(status, configuredStatus())
  assert.equal('apiKey' in status, false)
})

test('status defers safeStorage until explicitly requested when no credential exists', (t) => {
  let encryptionChecks = 0
  const safeStorage = encryptedSafeStorage()
  safeStorage.isEncryptionAvailable = () => {
    encryptionChecks += 1
    return true
  }
  const { directory, store } = fixture(safeStorage)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  assert.equal(store.status('hermes').encryptionAvailable, null)
  assert.equal(encryptionChecks, 0)
  assert.equal(store.status('hermes', { probeEncryption: true }).encryptionAvailable, true)
  assert.equal(encryptionChecks, 1)
})

test('save encrypts the API key, writes atomically, and restricts file permissions', (t) => {
  const { directory, storagePath, store } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const apiKey = 'test-key-never-plaintext'

  assert.deepEqual(store.save('hermes', credential(apiKey)), configuredStatus())
  const stored = fs.readFileSync(storagePath, 'utf8')
  assert.equal(stored.includes(apiKey), false)
  assert.equal(fs.statSync(storagePath).mode & 0o777, 0o600)
  assert.deepEqual(
    fs.readdirSync(directory).filter(name => name !== path.basename(storagePath)),
    [],
  )
})

test('save accepts only the complete five-field Provider payload', (t) => {
  const { directory, store } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  assert.throws(() => store.save('hermes', {}), { message: 'PROVIDER_INVALID_CREDENTIAL' })
  assert.throws(() => store.save('hermes', credential('')), { message: 'PROVIDER_INVALID_CREDENTIAL' })
  assert.throws(
    () => store.save('hermes', { ...credential(), extra: true }),
    { message: 'PROVIDER_INVALID_CREDENTIAL' },
  )
  assert.throws(
    () => store.save('hermes', {
      apiKey: 'key', provider: 'Example', baseUrl: '', model: 'model', preset: 'custom',
    }),
    { message: 'PROVIDER_INVALID_METADATA' },
  )
  assert.throws(
    () => store.save('hermes', credential('key', PROVIDER, 'unknown')),
    { message: 'PROVIDER_PRESET_UNSUPPORTED' },
  )
})

test('preset metadata must match canonical OpenRouter and Agent official Providers', (t) => {
  const { directory, store } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  assert.deepEqual(
    store.save('hermes', credential('openrouter-key', {
      ...OPENROUTER_PROVIDER,
      baseUrl: `${OPENROUTER_PROVIDER.baseUrl}/`,
    }, 'openrouter')),
    configuredStatus(OPENROUTER_PROVIDER, 'openrouter'),
  )
  assert.throws(
    () => store.save('hermes', credential('key', {
      ...OPENROUTER_PROVIDER,
      provider: 'OpenRouter proxy',
    }, 'openrouter')),
    { message: 'PROVIDER_INVALID_METADATA' },
  )
  assert.throws(
    () => store.save('hermes', credential('key', {
      ...OPENROUTER_PROVIDER,
      baseUrl: 'https://gateway.example/v1',
    }, 'openrouter')),
    { message: 'PROVIDER_INVALID_METADATA' },
  )
  store.delete('hermes', 'openrouter')

  assert.deepEqual(
    store.save('hermes', credential('official-key', HERMES_OFFICIAL_PROVIDER, 'official')),
    configuredStatus(HERMES_OFFICIAL_PROVIDER, 'official'),
  )
  assert.deepEqual(
    store.save('qwen', credential('official-key', QWEN_OFFICIAL_PROVIDER, 'official')),
    configuredStatus(QWEN_OFFICIAL_PROVIDER, 'official'),
  )
  assert.deepEqual(
    store.save('opencodereview', credential('official-key', OCR_OFFICIAL_PROVIDER, 'official')),
    configuredStatus(OCR_OFFICIAL_PROVIDER, 'official'),
  )
  assert.throws(
    () => store.save('hermes', credential('key', {
      ...HERMES_OFFICIAL_PROVIDER,
      provider: 'OpenAI',
    }, 'official')),
    { message: 'PROVIDER_INVALID_METADATA' },
  )
  assert.throws(
    () => store.save('qwen', credential('key', {
      ...QWEN_OFFICIAL_PROVIDER,
      baseUrl: 'https://api.openai.com/v1',
    }, 'official')),
    { message: 'PROVIDER_INVALID_METADATA' },
  )
  const workbuddy = fixture(encryptedSafeStorage(), ['workbuddy'])
  t.after(() => fs.rmSync(workbuddy.directory, { recursive: true, force: true }))
  assert.throws(
    () => workbuddy.store.save('workbuddy', credential('key', {
      provider: 'WorkBuddy Official',
      baseUrl: 'https://api.example.com/v1',
      model: 'workbuddy-model',
    }, 'official')),
    { message: 'PROVIDER_INVALID_METADATA' },
  )
})

test('custom preset keeps accepting secure arbitrary and loopback endpoints', (t) => {
  const { directory, store } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  assert.doesNotThrow(() => store.save('hermes', credential('key', {
    provider: 'Private OpenRouter proxy',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'local-model',
  }, 'custom')))
})

for (const kind of [
  'codex', 'hermes', 'openclaw', 'workbuddy', 'kimi', 'mimo',
  'claude', 'gemini', 'opencode', 'qwen', 'opencodereview',
]) {
  test(`${kind} Provider endpoints are stored as API roots`, (t) => {
    const { directory, store } = fixture(encryptedSafeStorage(), [kind])
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

    const status = store.save(kind, credential(`${kind}-key`, {
      ...PROVIDER,
      baseUrl: 'https://api.example.com/v1/chat/completions/',
    }))

    assert.equal(status.baseUrl, 'https://api.example.com/v1')
    assert.equal(status.profiles.custom.baseUrl, 'https://api.example.com/v1')
    assert.equal(store.envForAgent(kind).OPENAI_BASE_URL, 'https://api.example.com/v1')
  })

  test(`legacy ${kind} profiles normalize duplicated chat completion endpoints on read`, (t) => {
    const { directory, storagePath, store } = fixture(encryptedSafeStorage(), [kind])
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const encrypted = encryptedSafeStorage().encryptString(`legacy-${kind}-key`).toString('base64')
    fs.writeFileSync(storagePath, JSON.stringify({
      version: 2,
      agents: {
        [kind]: {
          ...PROVIDER,
          baseUrl: 'https://api.example.com/v1/chat/completions',
          encrypted,
        },
      },
    }), { mode: 0o600 })

    assert.equal(store.status(kind).baseUrl, 'https://api.example.com/v1')
    assert.equal(store.envForAgent(kind).OPENAI_BASE_URL, 'https://api.example.com/v1')
  })
}

test('envForAgent decrypts the configured Provider', (t) => {
  const { directory, store } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  store.save('hermes', credential('test-key-env'))

  assert.deepEqual(store.envForAgent('hermes'), {
    OPENAI_API_KEY: 'test-key-env',
    OPENAI_BASE_URL: PROVIDER.baseUrl,
    OPENAI_MODEL: PROVIDER.model,
  })
})

test('multiple Provider profiles stay encrypted and can be activated independently', (t) => {
  const { directory, store } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  store.save('hermes', credential('openrouter-key', OPENROUTER_PROVIDER, 'openrouter'))
  store.save('hermes', credential('custom-key', PROVIDER, 'custom'))

  assert.deepEqual(store.status('hermes'), {
    ...PROVIDER,
    activePreset: 'custom',
    profiles: {
      openrouter: { ...OPENROUTER_PROVIDER, configured: true },
      custom: { ...PROVIDER, configured: true },
    },
    encryptionAvailable: true,
    configured: true,
  })

  store.activate('hermes', 'openrouter')
  assert.equal(store.status('hermes').activePreset, 'openrouter')
  assert.deepEqual(store.envForAgent('hermes'), {
    OPENAI_API_KEY: 'openrouter-key',
    OPENAI_BASE_URL: OPENROUTER_PROVIDER.baseUrl,
    OPENAI_MODEL: OPENROUTER_PROVIDER.model,
  })

  const afterDelete = store.delete('hermes', 'openrouter')
  assert.equal(afterDelete.activePreset, 'official')
  assert.equal(afterDelete.configured, false)
  assert.deepEqual(afterDelete.profiles, {
    custom: { ...PROVIDER, configured: true },
  })
  store.activate('hermes', 'custom')
  assert.equal(store.envForAgent('hermes').OPENAI_API_KEY, 'custom-key')
})

test('encryption unavailability fails closed for status, save, and reads', (t) => {
  const { directory, storagePath, store } = fixture(encryptedSafeStorage(false))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  assert.deepEqual(store.status('hermes', { probeEncryption: true }), emptyStatus(false))
  assert.throws(() => store.save('hermes', credential()), {
    message: 'PROVIDER_ENCRYPTION_UNAVAILABLE',
  })
  assert.throws(() => store.envForAgent('hermes'), {
    message: 'PROVIDER_ENCRYPTION_UNAVAILABLE',
  })
  assert.equal(fs.existsSync(storagePath), false)
})

test('safeStorage encryption failures do not leave a credential file', (t) => {
  const { directory, storagePath, store } = fixture({
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value),
    decryptString: () => { throw new Error('keychain unavailable') },
  })
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  assert.throws(() => store.save('hermes', credential()), {
    message: 'PROVIDER_ENCRYPTION_FAILED',
  })
  assert.equal(fs.existsSync(storagePath), false)
})

test('corrupt credentials stay unavailable and are never returned', (t) => {
  const { directory, storagePath, store } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(storagePath, JSON.stringify({ version: 1, encrypted: 'broken' }), {
    mode: 0o600,
  })

  assert.deepEqual(store.status('hermes'), emptyStatus(true))
  assert.throws(() => store.envForAgent('hermes'), {
    message: 'PROVIDER_CREDENTIAL_UNAVAILABLE',
  })
})

test('delete removes the local credential even when encryption is unavailable', (t) => {
  const safeStorage = encryptedSafeStorage()
  const { directory, storagePath, store } = fixture(safeStorage)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  store.save('hermes', credential())
  safeStorage.isEncryptionAvailable = () => false

  assert.deepEqual(store.delete('hermes'), emptyStatus(false))
  assert.equal(fs.existsSync(storagePath), false)
  assert.doesNotThrow(() => store.delete('hermes'))
})

test('Provider base URL must use HTTPS or loopback HTTP without embedded data', (t) => {
  const { directory, store } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  assert.throws(
    () => store.save('hermes', credential('key', { ...PROVIDER, baseUrl: 'http://provider.example/v1' })),
    { message: 'PROVIDER_INSECURE_BASE_URL' },
  )
  assert.doesNotThrow(() => store.save('hermes', credential('key', {
    ...PROVIDER, baseUrl: 'http://127.0.0.1:11434/v1',
  })))
  assert.throws(
    () => store.save('hermes', credential('key', { ...PROVIDER, baseUrl: 'https://user@api.example/v1' })),
    { message: 'PROVIDER_INVALID_METADATA' },
  )
})

test('Provider credentials are isolated per Agent', (t) => {
  const { directory, store } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  store.save('hermes', credential('hermes-key'))
  store.save('qwen', credential('qwen-key', { ...PROVIDER, model: 'qwen-model' }))

  assert.equal(store.status('hermes').model, PROVIDER.model)
  assert.equal(store.status('qwen').model, 'qwen-model')
  assert.equal(store.envForAgent('hermes').OPENAI_API_KEY, 'hermes-key')
  assert.equal(store.envForAgent('qwen').OPENAI_API_KEY, 'qwen-key')

  store.delete('hermes')
  assert.equal(store.status('hermes').configured, false)
  assert.equal(store.status('qwen').configured, true)
})

test('legacy shared credentials migrate into independent Agent entries on mutation', (t) => {
  const { directory, storagePath, store } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const encrypted = encryptedSafeStorage().encryptString('legacy-key').toString('base64')
  fs.writeFileSync(storagePath, JSON.stringify({
    version: 1,
    ...PROVIDER,
    encrypted,
  }), { mode: 0o600 })

  assert.equal(store.status('hermes').configured, true)
  assert.equal(store.status('qwen').configured, true)
  assert.equal(store.status('opencodereview').configured, true)

  store.save('qwen', credential('new-qwen-key', { ...PROVIDER, model: 'new-qwen-model' }))
  const migrated = JSON.parse(fs.readFileSync(storagePath, 'utf8'))
  assert.equal(migrated.version, 3)
  assert.deepEqual(Object.keys(migrated.agents).sort(), ['hermes', 'opencodereview', 'qwen'])
  assert.equal(store.envForAgent('hermes').OPENAI_API_KEY, 'legacy-key')
  assert.equal(store.envForAgent('qwen').OPENAI_API_KEY, 'new-qwen-key')
})

test('single-profile Agent credentials migrate to multi-profile storage on mutation', (t) => {
  const { directory, storagePath, store } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const encrypted = encryptedSafeStorage().encryptString('stored-openrouter-key').toString('base64')
  fs.writeFileSync(storagePath, JSON.stringify({
    version: 2,
    agents: {
      hermes: { ...OPENROUTER_PROVIDER, encrypted },
    },
  }), { mode: 0o600 })

  assert.equal(store.status('hermes').activePreset, 'openrouter')
  assert.equal(store.envForAgent('hermes').OPENAI_API_KEY, 'stored-openrouter-key')

  store.save('qwen', credential('new-qwen-key', { ...PROVIDER, model: 'qwen-model' }))
  const migrated = JSON.parse(fs.readFileSync(storagePath, 'utf8'))
  assert.equal(migrated.version, 3)
  assert.equal(migrated.agents.hermes.activePreset, 'openrouter')
  assert.equal(migrated.agents.qwen.activePreset, 'custom')
})

test('malformed multi-profile documents fail as unavailable credentials', (t) => {
  const { directory, storagePath, store } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(storagePath, JSON.stringify({
    version: 3,
    agents: {
      hermes: { activePreset: 'unknown', profiles: {} },
    },
  }), { mode: 0o600 })

  assert.throws(() => store.envForAgent('hermes'), {
    message: 'PROVIDER_CREDENTIAL_UNAVAILABLE',
  })
})

test('Provider operations reject unsupported Agent kinds', (t) => {
  const { directory, store } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  assert.throws(() => store.status('codex'), { message: 'PROVIDER_AGENT_UNSUPPORTED' })
  assert.throws(() => store.save('../hermes', credential()), { message: 'PROVIDER_AGENT_UNSUPPORTED' })
  assert.throws(() => store.delete(''), { message: 'PROVIDER_AGENT_UNSUPPORTED' })
})
