export function publicAsset(path) {
  return `./${String(path || '').replace(/^\/+/, '')}`
}

export const AGENTS = Object.freeze([
  { kind: 'codex', label: 'Codex', logo: publicAsset('agent-logos/codex.png'), providerMode: 'responses', imageLimit: 4 },
  { kind: 'hermes', label: 'Hermes', logo: publicAsset('agent-logos/hermes.png'), providerMode: 'compatible', imageLimit: 1 },
  { kind: 'openclaw', label: 'OpenClaw', logo: publicAsset('agent-logos/openclaw.png'), providerMode: 'compatible', imageLimit: 0 },
  { kind: 'workbuddy', label: 'WorkBuddy', logo: publicAsset('agent-logos/workbuddy.png'), providerMode: 'experimental', imageLimit: 0 },
  { kind: 'kimi', label: 'Kimi Code', logo: publicAsset('agent-logos/kimi.png'), providerMode: 'native', imageLimit: 0 },
  { kind: 'claude', label: 'Claude Code', logo: publicAsset('agent-logos/claude.png'), providerMode: 'anthropic', imageLimit: 0 },
  { kind: 'qwen', label: 'Qwen Code', logo: publicAsset('agent-logos/qwen.svg'), providerMode: 'compatible', imageLimit: 0 },
  { kind: 'gemini', label: 'Gemini CLI', logo: publicAsset('agent-logos/gemini.svg'), providerMode: 'native', imageLimit: 0 },
  { kind: 'opencode', label: 'OpenCode', logo: publicAsset('agent-logos/opencode.svg'), providerMode: 'native', imageLimit: 4 },
])

const BY_KIND = new Map(AGENTS.map(agent => [agent.kind, agent]))

function agentProfile(kind) {
  return BY_KIND.get(kind) || { kind, label: kind || 'Agent', logo: '', providerMode: 'native' }
}

export function agentLabel(kind) {
  return agentProfile(kind).label
}

export function agentLogo(kind) {
  return agentProfile(kind).logo
}
