const fs = require('node:fs')

const { atomicWritePrivateFile } = require('./private-file.cjs')

const STORE_VERSION = 2
const LEGACY_STORE_VERSION = 1
const PROVIDER_KIND = /^[a-z0-9][a-z0-9-]{0,31}$/
const EMPTY_METADATA = Object.freeze({ provider: '', baseUrl: '', model: '' })

function normalizeMetadata(input) {
  const provider = String(input?.provider || '').trim()
  const baseUrl = String(input?.baseUrl || '').trim().replace(/\/+$/, '')
  const model = String(input?.model || '').trim()
  if (!provider || provider.length > 80 || !baseUrl || baseUrl.length > 300
      || !model || model.length > 160) {
    throw new Error('PROVIDER_INVALID_METADATA')
  }
  let parsed
  try { parsed = new URL(baseUrl) } catch { throw new Error('PROVIDER_INVALID_METADATA') }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error('PROVIDER_INSECURE_BASE_URL')
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('PROVIDER_INVALID_METADATA')
  }
  return { provider, baseUrl, model }
}

function sortedKeys(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Reflect.ownKeys(value).sort().join(',')
    : ''
}

class ProviderStore {
  constructor({ storagePath, safeStorage, allowedKinds = [] }) {
    if (typeof storagePath !== 'string' || !storagePath) {
      throw new Error('PROVIDER_STORAGE_PATH_REQUIRED')
    }
    const normalizedKinds = [...new Set(allowedKinds.map(kind => String(kind || '').trim()))]
    if (!normalizedKinds.length || normalizedKinds.some(kind => !PROVIDER_KIND.test(kind))) {
      throw new Error('PROVIDER_AGENT_KINDS_REQUIRED')
    }
    this.storagePath = storagePath
    this.safeStorage = safeStorage
    this.allowedKinds = new Set(normalizedKinds)
  }

  encryptionAvailable() {
    try {
      return Boolean(this.safeStorage?.isEncryptionAvailable?.())
    } catch {
      return false
    }
  }

  status(kind, { probeEncryption = false } = {}) {
    const targetKind = this.normalizeKind(kind)
    const credentialStored = fs.existsSync(this.storagePath)
    if (!credentialStored && !probeEncryption) {
      return {
        provider: '',
        baseUrl: '',
        model: '',
        encryptionAvailable: null,
        configured: false,
      }
    }

    const encryptionAvailable = this.encryptionAvailable()
    let metadata = EMPTY_METADATA
    let configured = false
    if (encryptionAvailable && credentialStored) {
      try {
        const entry = this.readDocument().agents[targetKind]
        if (entry) {
          this.decryptEntry(entry)
          metadata = entry
          configured = true
        }
      } catch { /* unreadable credentials stay unavailable */ }
    }
    return {
      provider: metadata.provider,
      baseUrl: metadata.baseUrl,
      model: metadata.model,
      encryptionAvailable,
      configured,
    }
  }

  save(kind, input) {
    const targetKind = this.normalizeKind(kind)
    if (sortedKeys(input) !== 'apiKey,baseUrl,model,provider'
        || typeof input.apiKey !== 'string' || !input.apiKey.trim()
        || input.apiKey.trim().length > 8192) {
      throw new Error('PROVIDER_INVALID_CREDENTIAL')
    }
    this.requireEncryption()

    const apiKey = input.apiKey.trim()
    const metadata = normalizeMetadata(input)
    let encrypted
    try {
      encrypted = this.safeStorage.encryptString(apiKey)
      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0
          || this.safeStorage.decryptString(encrypted) !== apiKey) {
        throw new Error('invalid encryption result')
      }
    } catch {
      throw new Error('PROVIDER_ENCRYPTION_FAILED')
    }

    const document = fs.existsSync(this.storagePath)
      ? this.readDocument()
      : { version: STORE_VERSION, agents: {} }
    document.agents[targetKind] = {
      ...metadata,
      encrypted: encrypted.toString('base64'),
    }
    atomicWritePrivateFile(this.storagePath, JSON.stringify(document))
    return this.status(targetKind)
  }

  delete(kind) {
    const targetKind = this.normalizeKind(kind)
    if (fs.existsSync(this.storagePath)) {
      const document = this.readDocument()
      delete document.agents[targetKind]
      if (Object.keys(document.agents).length) {
        atomicWritePrivateFile(this.storagePath, JSON.stringify(document))
      } else {
        fs.unlinkSync(this.storagePath)
      }
    }
    return this.status(targetKind, { probeEncryption: true })
  }

  envForAgent(kind) {
    const targetKind = this.normalizeKind(kind)
    this.requireEncryption()
    const entry = this.readDocument().agents[targetKind]
    if (!entry) throw new Error('PROVIDER_CREDENTIAL_UNAVAILABLE')
    return {
      OPENAI_API_KEY: this.decryptEntry(entry),
      OPENAI_BASE_URL: entry.baseUrl,
      OPENAI_MODEL: entry.model,
    }
  }

  requireEncryption() {
    if (!this.encryptionAvailable()) throw new Error('PROVIDER_ENCRYPTION_UNAVAILABLE')
  }

  normalizeKind(kind) {
    const normalized = String(kind || '').trim()
    if (!PROVIDER_KIND.test(normalized) || !this.allowedKinds.has(normalized)) {
      throw new Error('PROVIDER_AGENT_UNSUPPORTED')
    }
    return normalized
  }

  decryptEntry(entry) {
    this.requireEncryption()
    try {
      const encrypted = Buffer.from(entry.encrypted, 'base64')
      if (!encrypted.length || encrypted.toString('base64') !== entry.encrypted) {
        throw new Error('invalid ciphertext')
      }
      const apiKey = this.safeStorage.decryptString(encrypted)
      if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('invalid credential')
      return apiKey
    } catch {
      throw new Error('PROVIDER_CREDENTIAL_UNAVAILABLE')
    }
  }

  readDocument() {
    let payload
    try {
      payload = JSON.parse(fs.readFileSync(this.storagePath, 'utf8'))
    } catch {
      throw new Error('PROVIDER_CREDENTIAL_UNAVAILABLE')
    }
    if (payload?.version === LEGACY_STORE_VERSION) {
      if (sortedKeys(payload) !== 'baseUrl,encrypted,model,provider,version'
          || typeof payload.encrypted !== 'string') {
        throw new Error('PROVIDER_CREDENTIAL_UNAVAILABLE')
      }
      const entry = this.normalizeEntry({
        provider: payload.provider,
        baseUrl: payload.baseUrl,
        model: payload.model,
        encrypted: payload.encrypted,
      })
      return {
        version: STORE_VERSION,
        agents: Object.fromEntries([...this.allowedKinds].map(kind => [kind, { ...entry }])),
      }
    }
    if (sortedKeys(payload) !== 'agents,version'
        || payload.version !== STORE_VERSION
        || !payload.agents || typeof payload.agents !== 'object'
        || Array.isArray(payload.agents)) {
      throw new Error('PROVIDER_CREDENTIAL_UNAVAILABLE')
    }
    const agents = {}
    for (const [kind, entry] of Object.entries(payload.agents)) {
      if (!this.allowedKinds.has(kind)) throw new Error('PROVIDER_CREDENTIAL_UNAVAILABLE')
      agents[kind] = this.normalizeEntry(entry)
    }
    return { version: STORE_VERSION, agents }
  }

  normalizeEntry(entry) {
    if (sortedKeys(entry) !== 'baseUrl,encrypted,model,provider'
        || typeof entry.encrypted !== 'string') {
      throw new Error('PROVIDER_CREDENTIAL_UNAVAILABLE')
    }
    const encrypted = Buffer.from(entry.encrypted, 'base64')
    if (!encrypted.length || encrypted.toString('base64') !== entry.encrypted) {
      throw new Error('PROVIDER_CREDENTIAL_UNAVAILABLE')
    }
    return { ...normalizeMetadata(entry), encrypted: entry.encrypted }
  }
}

module.exports = { ProviderStore }
