export function publicAsset(path) {
  return `./${String(path || '').replace(/^\/+/, '')}`
}

export const AGENTS = Object.freeze([
  { kind: 'codex', label: 'Codex', logo: publicAsset('agent-logos/codex.svg'), providerMode: 'responses', imageLimit: 4, attachmentTypes: ['file'] },
  {
    kind: 'hermes',
    label: 'Hermes',
    logo: publicAsset('agent-logos/hermes.svg'),
    darkLogo: publicAsset('agent-logos/hermes.png'),
    providerMode: 'compatible',
    imageLimit: 1,
    attachmentTypes: ['file'],
  },
  { kind: 'openclaw', label: 'OpenClaw', logo: publicAsset('agent-logos/openclaw-transparent.png'), providerMode: 'compatible', imageLimit: 0, attachmentTypes: ['file'] },
  { kind: 'workbuddy', label: 'WorkBuddy', logo: publicAsset('agent-logos/workbuddy.png'), providerMode: 'experimental', imageLimit: 0, attachmentTypes: ['file'] },
  { kind: 'kimi', label: 'Kimi Code', logo: publicAsset('agent-logos/kimi.png'), providerMode: 'native', imageLimit: 0, attachmentTypes: ['file'] },
  { kind: 'mimo', label: 'MiMo Code', logo: publicAsset('agent-logos/mimo.svg'), providerMode: 'native', imageLimit: 0, attachmentTypes: ['file'] },
  { kind: 'claude', label: 'Claude Code', logo: publicAsset('agent-logos/claude.png'), providerMode: 'anthropic', imageLimit: 0, attachmentTypes: ['file'] },
  { kind: 'gemini', label: 'Gemini CLI', logo: publicAsset('agent-logos/gemini.svg'), providerMode: 'native', imageLimit: 0, attachmentTypes: ['file'] },
  { kind: 'opencode', label: 'OpenCode', logo: publicAsset('agent-logos/opencode.svg'), providerMode: 'native', imageLimit: 4, attachmentTypes: ['file'] },
  { kind: 'opencodereview', label: 'OpenCodeReview', logo: publicAsset('agent-logos/opencodereview.svg'), providerMode: 'compatible', imageLimit: 0 },
  { kind: 'qwen', label: 'Qwen Code', logo: publicAsset('agent-logos/qwen.svg'), providerMode: 'compatible', imageLimit: 0, attachmentTypes: ['file'] },
])

const BY_KIND = new Map(AGENTS.map(agent => [agent.kind, agent]))
const CUSTOM_BY_KIND = new Map()
const CUSTOM_AGENT_KIND = /^custom-[a-f0-9]{16}$/
const CUSTOM_AGENT_LOGO = publicAsset('agent-logos/custom-agent.svg')

export function setCustomAgentProfiles(profiles = []) {
  CUSTOM_BY_KIND.clear()
  for (const profile of Array.isArray(profiles) ? profiles : []) {
    const kind = String(profile?.kind || '')
    const label = String(profile?.label || '').trim().slice(0, 60)
    if (!CUSTOM_AGENT_KIND.test(kind) || !label || profile?.custom !== true) continue
    CUSTOM_BY_KIND.set(kind, {
      kind,
      label,
      logo: CUSTOM_AGENT_LOGO,
      providerMode: 'custom',
      imageLimit: 0,
      custom: true,
      description: String(profile?.description || '').trim().slice(0, 240),
      commandName: String(profile?.commandName || '').trim().slice(0, 160),
      promptMode: ['stdin', 'argument'].includes(profile?.promptMode) ? profile.promptMode : 'stdin',
    })
  }
}

function agentProfile(kind) {
  return BY_KIND.get(kind) || CUSTOM_BY_KIND.get(kind)
    || { kind, label: kind || 'Agent', logo: CUSTOM_AGENT_LOGO, providerMode: 'native' }
}

export function agentLabel(kind) {
  return agentProfile(kind).label
}

export function agentLogo(kind, displayTheme = '') {
  const profile = agentProfile(kind)
  return displayTheme === 'dark' && profile.darkLogo ? profile.darkLogo : profile.logo
}
