const path = require('node:path')
const { KNOWLEDGE_BASE_SOURCES } = require('./local-knowledge-base-catalog.cjs')
const { resolveCommandPath } = require('./local-knowledge-base-probe-runtime.cjs')
const { resolveKnowledgeBaseSources } = require('./local-knowledge-base-probes.cjs')

const MENTIONABLE_KNOWLEDGE_BASE_KINDS = new Set(['feishu', 'dingtalk', 'obsidian'])

function knowledgeBaseSelectionHint(source, targetKinds) {
  const kind = String(source?.kind || '')
  const targets = [...new Set((Array.isArray(targetKinds) ? targetKinds : [])
    .map(value => String(value || '').trim())
    .filter(Boolean))]
  if (!MENTIONABLE_KNOWLEDGE_BASE_KINDS.has(kind) || !targets.length
      || source?.probeState !== 'ready' || source?.readable !== true) return null
  const hint = {
    kind,
    name: String(source.label || kind).trim().slice(0, 100),
    accessMode: String(source.accessMode || '').trim(),
    targetKinds: targets,
  }
  if (hint.accessMode === 'vault') {
    const location = String(source.vaultPath || '')
    if (!source.installed || !source.configured || !path.isAbsolute(location)) return null
    hint.location = path.normalize(location)
    return hint
  }
  if (hint.accessMode === 'cli') {
    const commandName = String(source.commandName || '').trim()
    if (!source.installed || source.loginState !== 'ready' || source.permissionState !== 'ready'
        || !/^[A-Za-z0-9._-]{1,80}$/.test(commandName)) return null
    hint.commandName = commandName
    return hint
  }
  return null
}

function knowledgeBaseGuideUrl(kind, action) {
  const source = KNOWLEDGE_BASE_SOURCES.find(item => item.kind === kind)
  if (!source) return ''
  if (kind === 'obsidian') {
    if (action === 'install') return source.installUrl
    return source.installUrl
  }
  if (['notion', 'confluence', 'googledrive', 'sharepoint'].includes(kind)) {
    if (action === 'install') return source.installUrl
    if (action === 'login' || action === 'permission') return source.permissionUrl || source.loginUrl || source.installUrl
    return source.installUrl
  }
  if (action === 'install') return source.installUrl
  if (action === 'login' || action === 'permission') return source.loginUrl
  return source.installUrl
}

module.exports = {
  KNOWLEDGE_BASE_SOURCES,
  knowledgeBaseSelectionHint,
  knowledgeBaseGuideUrl,
  resolveKnowledgeBaseSources,
  resolveCommandPath,
}
