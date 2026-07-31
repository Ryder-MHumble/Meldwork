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

function credential(apiKey = 'test-provider-key', metadata = PROVIDER) {
  return { ...metadata, apiKey }
}

function encryptedSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: value => Buffer.from(value, 'utf8').map(byte => byte ^ 0xaa),
    decryptString: value => Buffer.from(value).map(byte => byte ^ 0xaa).toString('utf8'),
  }
}

function fixture(safeStorage = encryptedSafeStorage()) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-provider-'))
  const storagePath = path.join(directory, 'roundrelay-provider.json')
  return {
    directory,
    storagePath,
    store: new ProviderStore({ storagePath, safeStorage, allowedKinds: ['hermes', 'qwen'] }),
  }
}

test('status exposes user-configured metadata without the API key', (t) => {
  const { directory, store } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  assert.deepEqual(store.status('hermes'), {
    provider: '', baseUrl: '', model: '', encryptionAvailable: null, configured: false,
  })

  store.save('hermes', credential())
  const status = store.status('hermes')
  assert.deepEqual(status, { ...PROVIDER, encryptionAvailable: true, configured: true })
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

  assert.deepEqual(store.save('hermes', credential(apiKey)), {
    ...PROVIDER, encryptionAvailable: true, configured: true,
  })
  const stored = fs.readFileSync(storagePath, 'utf8')
  assert.equal(stored.includes(apiKey), false)
  assert.equal(fs.statSync(storagePath).mode & 0o777, 0o600)
  assert.deepEqual(
    fs.readdirSync(directory).filter(name => name !== path.basename(storagePath)),
    [],
  )
})

test('save accepts only the complete four-field Provider payload', (t) => {
  const { directory, store } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  assert.throws(() => store.save('hermes', {}), { message: 'PROVIDER_INVALID_CREDENTIAL' })
  assert.throws(() => store.save('hermes', credential('')), { message: 'PROVIDER_INVALID_CREDENTIAL' })
  assert.throws(
    () => store.save('hermes', { ...credential(), extra: true }),
    { message: 'PROVIDER_INVALID_CREDENTIAL' },
  )
  assert.throws(
    () => store.save('hermes', { apiKey: 'key', provider: 'Example', baseUrl: '', model: 'model' }),
    { message: 'PROVIDER_INVALID_METADATA' },
  )
})

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

test('encryption unavailability fails closed for status, save, and reads', (t) => {
  const { directory, storagePath, store } = fixture(encryptedSafeStorage(false))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  assert.deepEqual(store.status('hermes', { probeEncryption: true }), {
    provider: '', baseUrl: '', model: '', encryptionAvailable: false, configured: false,
  })
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

  assert.deepEqual(store.status('hermes'), {
    provider: '', baseUrl: '', model: '', encryptionAvailable: true, configured: false,
  })
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

  assert.deepEqual(store.delete('hermes'), {
    provider: '', baseUrl: '', model: '', encryptionAvailable: false, configured: false,
  })
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

  store.save('qwen', credential('new-qwen-key', { ...PROVIDER, model: 'new-qwen-model' }))
  const migrated = JSON.parse(fs.readFileSync(storagePath, 'utf8'))
  assert.equal(migrated.version, 2)
  assert.deepEqual(Object.keys(migrated.agents).sort(), ['hermes', 'qwen'])
  assert.equal(store.envForAgent('hermes').OPENAI_API_KEY, 'legacy-key')
  assert.equal(store.envForAgent('qwen').OPENAI_API_KEY, 'new-qwen-key')
})

test('Provider operations reject unsupported Agent kinds', (t) => {
  const { directory, store } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  assert.throws(() => store.status('codex'), { message: 'PROVIDER_AGENT_UNSUPPORTED' })
  assert.throws(() => store.save('../hermes', credential()), { message: 'PROVIDER_AGENT_UNSUPPORTED' })
  assert.throws(() => store.delete(''), { message: 'PROVIDER_AGENT_UNSUPPORTED' })
})
