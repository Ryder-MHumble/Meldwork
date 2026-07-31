const fs = require('node:fs')

const { atomicWritePrivateFile } = require('./private-file.cjs')

const STORE_VERSION = 3
const SINGLE_PROFILE_STORE_VERSION = 2
const LEGACY_STORE_VERSION = 1
const PROVIDER_KIND = /^[a-z0-9][a-z0-9-]{0,31}$/
const PROVIDER_PRESETS = new Set(['official', 'openrouter', 'custom'])
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

function inferStoredPreset(entry) {
  const provider = String(entry?.provider || '').toLowerCase()
  const baseUrl = String(entry?.baseUrl || '')
  return /openrouter/i.test(provider) || /(^|\.)openrouter\.ai$/i.test(hostname(baseUrl))
    ? 'openrouter'
    : 'custom'
}

function hostname(value) {
  try { return new URL(value).hostname } catch { return '' }
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
        activePreset: 'official',
        profiles: {},
        encryptionAvailable: null,
        configured: false,
      }
    }

    const encryptionAvailable = this.encryptionAvailable()
    let metadata = EMPTY_METADATA
    let configured = false
    let activePreset = 'official'
    const profiles = {}
    if (encryptionAvailable && credentialStored) {
      try {
        const agent = this.readDocument().agents[targetKind]
        if (agent) {
          activePreset = agent.activePreset
          for (const [preset, entry] of Object.entries(agent.profiles)) {
            try {
              this.decryptEntry(entry)
              profiles[preset] = {
                provider: entry.provider,
                baseUrl: entry.baseUrl,
                model: entry.model,
                configured: true,
              }
            } catch { /* keep an unreadable profile unavailable */ }
          }
          const activeEntry = profiles[activePreset]
          if (activeEntry) {
            metadata = activeEntry
            configured = true
          }
        }
      } catch { /* unreadable credentials stay unavailable */ }
    }
    return {
      provider: metadata.provider,
      baseUrl: metadata.baseUrl,
      model: metadata.model,
      activePreset,
      profiles,
      encryptionAvailable,
      configured,
    }
  }

  save(kind, input) {
    const targetKind = this.normalizeKind(kind)
    if (sortedKeys(input) !== 'apiKey,baseUrl,model,preset,provider'
        || typeof input.apiKey !== 'string' || !input.apiKey.trim()
        || input.apiKey.trim().length > 8192) {
      throw new Error('PROVIDER_INVALID_CREDENTIAL')
    }
    this.requireEncryption()

    const apiKey = input.apiKey.trim()
    const preset = this.normalizePreset(input.preset)
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
    const agent = document.agents[targetKind] || { activePreset: 'official', profiles: {} }
    agent.profiles[preset] = {
      ...metadata,
      encrypted: encrypted.toString('base64'),
    }
    agent.activePreset = preset
    document.agents[targetKind] = agent
    atomicWritePrivateFile(this.storagePath, JSON.stringify(document))
    return this.status(targetKind)
  }

  activate(kind, preset) {
    const targetKind = this.normalizeKind(kind)
    const targetPreset = this.normalizePreset(preset)
    if (!fs.existsSync(this.storagePath)) {
      if (targetPreset !== 'official') throw new Error('PROVIDER_PROFILE_UNAVAILABLE')
      return this.status(targetKind, { probeEncryption: true })
    }
    this.requireEncryption()
    const document = this.readDocument()
    const agent = document.agents[targetKind] || { activePreset: 'official', profiles: {} }
    if (targetPreset !== 'official' && !agent.profiles[targetPreset]) {
      throw new Error('PROVIDER_PROFILE_UNAVAILABLE')
    }
    if (agent.profiles[targetPreset]) this.decryptEntry(agent.profiles[targetPreset])
    agent.activePreset = targetPreset
    document.agents[targetKind] = agent
    atomicWritePrivateFile(this.storagePath, JSON.stringify(document))
    return this.status(targetKind)
  }

  delete(kind, preset = '') {
    const targetKind = this.normalizeKind(kind)
    if (fs.existsSync(this.storagePath)) {
      const document = this.readDocument()
      if (preset) {
        const targetPreset = this.normalizePreset(preset)
        const agent = document.agents[targetKind]
        if (agent) {
          delete agent.profiles[targetPreset]
          if (agent.activePreset === targetPreset) agent.activePreset = 'official'
          if (Object.keys(agent.profiles).length) document.agents[targetKind] = agent
          else delete document.agents[targetKind]
        }
      } else {
        delete document.agents[targetKind]
      }
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
    const agent = this.readDocument().agents[targetKind]
    const entry = agent?.profiles?.[agent.activePreset]
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

  normalizePreset(preset) {
    const normalized = String(preset || '').trim().toLowerCase()
    if (!PROVIDER_PRESETS.has(normalized)) throw new Error('PROVIDER_PRESET_UNSUPPORTED')
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
      const preset = inferStoredPreset(entry)
      return {
        version: STORE_VERSION,
        agents: Object.fromEntries([...this.allowedKinds].map(kind => [kind, {
          activePreset: preset,
          profiles: { [preset]: { ...entry } },
        }])),
      }
    }
    if (payload?.version === SINGLE_PROFILE_STORE_VERSION) {
      if (sortedKeys(payload) !== 'agents,version'
          || !payload.agents || typeof payload.agents !== 'object'
          || Array.isArray(payload.agents)) {
        throw new Error('PROVIDER_CREDENTIAL_UNAVAILABLE')
      }
      const agents = {}
      for (const [kind, rawEntry] of Object.entries(payload.agents)) {
        if (!this.allowedKinds.has(kind)) throw new Error('PROVIDER_CREDENTIAL_UNAVAILABLE')
        const entry = this.normalizeEntry(rawEntry)
        const preset = inferStoredPreset(entry)
        agents[kind] = { activePreset: preset, profiles: { [preset]: entry } }
      }
      return { version: STORE_VERSION, agents }
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
      agents[kind] = this.normalizeAgentEntry(entry)
    }
    return { version: STORE_VERSION, agents }
  }

  normalizeAgentEntry(entry) {
    try {
      if (sortedKeys(entry) !== 'activePreset,profiles'
          || !entry.profiles || typeof entry.profiles !== 'object'
          || Array.isArray(entry.profiles)) {
        throw new Error('invalid agent entry')
      }
      const activePreset = this.normalizePreset(entry.activePreset)
      const profiles = {}
      for (const [preset, profile] of Object.entries(entry.profiles)) {
        const normalizedPreset = this.normalizePreset(preset)
        profiles[normalizedPreset] = this.normalizeEntry(profile)
      }
      if (activePreset !== 'official' && !profiles[activePreset]) {
        throw new Error('missing active profile')
      }
      return { activePreset, profiles }
    } catch {
      throw new Error('PROVIDER_CREDENTIAL_UNAVAILABLE')
    }
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
