const fs = require('node:fs')

const { atomicWritePrivateFile } = require('./private-file.cjs')

const STORE_VERSION = 1
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
  constructor({ storagePath, safeStorage }) {
    if (typeof storagePath !== 'string' || !storagePath) {
      throw new Error('PROVIDER_STORAGE_PATH_REQUIRED')
    }
    this.storagePath = storagePath
    this.safeStorage = safeStorage
  }

  encryptionAvailable() {
    try {
      return Boolean(this.safeStorage?.isEncryptionAvailable?.())
    } catch {
      return false
    }
  }

  status({ probeEncryption = false } = {}) {
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
        const entry = this.readDocument()
        this.decryptEntry(entry)
        metadata = entry
        configured = true
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

  save(input) {
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

    atomicWritePrivateFile(this.storagePath, JSON.stringify({
      version: STORE_VERSION,
      ...metadata,
      encrypted: encrypted.toString('base64'),
    }))
    return this.status()
  }

  delete() {
    try { fs.unlinkSync(this.storagePath) } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    return this.status({ probeEncryption: true })
  }

  envForAgent() {
    this.requireEncryption()
    const entry = this.readDocument()
    return {
      OPENAI_API_KEY: this.decryptEntry(entry),
      OPENAI_BASE_URL: entry.baseUrl,
      OPENAI_MODEL: entry.model,
    }
  }

  requireEncryption() {
    if (!this.encryptionAvailable()) throw new Error('PROVIDER_ENCRYPTION_UNAVAILABLE')
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
    if (sortedKeys(payload) !== 'baseUrl,encrypted,model,provider,version'
        || payload.version !== STORE_VERSION || typeof payload.encrypted !== 'string') {
      throw new Error('PROVIDER_CREDENTIAL_UNAVAILABLE')
    }
    const encrypted = Buffer.from(payload.encrypted, 'base64')
    if (!encrypted.length || encrypted.toString('base64') !== payload.encrypted) {
      throw new Error('PROVIDER_CREDENTIAL_UNAVAILABLE')
    }
    return { ...normalizeMetadata(payload), encrypted: payload.encrypted }
  }
}

module.exports = { ProviderStore }
