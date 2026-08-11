const fs = require('node:fs')
const path = require('node:path')
const { atomicWritePrivateFile } = require('../security/private-file.cjs')

const STORE_VERSION = 1
const DEFAULT_STATE = Object.freeze({
  version: STORE_VERSION,
  obsidianVaultPath: '',
})

function normalizeVaultPath(value) {
  const normalized = String(value || '').trim()
  if (!normalized) return ''
  return path.isAbsolute(normalized) ? normalized : ''
}

class KnowledgeBaseStore {
  constructor({ storagePath }) {
    if (typeof storagePath !== 'string' || !storagePath) {
      throw new Error('KNOWLEDGE_BASE_STORAGE_PATH_REQUIRED')
    }
    this.storagePath = storagePath
  }

  state() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.storagePath, 'utf8'))
      if (parsed?.version !== STORE_VERSION || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return this.defaultState()
      }
      return {
        version: STORE_VERSION,
        obsidianVaultPath: normalizeVaultPath(parsed.obsidianVaultPath),
      }
    } catch {
      return this.defaultState()
    }
  }

  defaultState() {
    return { ...DEFAULT_STATE }
  }

  saveObsidianVaultPath(value) {
    const next = {
      version: STORE_VERSION,
      obsidianVaultPath: normalizeVaultPath(value),
    }
    if (!next.obsidianVaultPath) {
      try { fs.unlinkSync(this.storagePath) } catch { /* nothing persisted yet */ }
      return next
    }
    atomicWritePrivateFile(this.storagePath, JSON.stringify(next))
    return next
  }
}

module.exports = { KnowledgeBaseStore }
