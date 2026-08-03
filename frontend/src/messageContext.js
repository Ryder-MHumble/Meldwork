import { parseAgentRoutingPrefix } from './agent-routing.js'

export function messageSkills(message) {
  return Array.isArray(message?.skillHints) ? message.skillHints : []
}

export function messageKnowledgeBases(message) {
  const seen = new Set()
  return (Array.isArray(message?.knowledgeBaseHints) ? message.knowledgeBaseHints : []).filter((source) => {
    const kind = String(source?.kind || '')
    if (!kind || seen.has(kind)) return false
    seen.add(kind)
    return true
  })
}

export function messageTargetKinds(message) {
  return [...new Set((Array.isArray(message?.targetKinds) ? message.targetKinds : [])
    .map(kind => String(kind || ''))
    .filter(Boolean))]
}

export function messageScopedTargetKinds(message, group, catalog) {
  if (!message || !group || !Array.isArray(group.agentKinds)) return []
  const explicit = messageTargetKinds(message)
  const mentioned = Array.isArray(message?.mentionedAgentKinds) ? message.mentionedAgentKinds : []
  const natural = parseAgentRoutingPrefix(message.content, catalog, group.agentKinds).targetKinds
  const requested = explicit.length ? explicit : mentioned.length ? mentioned : natural
  const selected = new Set(requested.map(kind => String(kind || '')))
  return group.agentKinds.filter(kind => selected.has(kind))
}
