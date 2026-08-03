export const PROVIDER_PRESETS = Object.freeze(['official', 'openrouter', 'custom'])

const OPENROUTER = Object.freeze({
  id: 'openrouter',
  provider: 'OpenRouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  model: '',
})

const CUSTOM = Object.freeze({
  id: 'custom',
  provider: 'Custom Provider',
  baseUrl: '',
  model: '',
})

const OFFICIAL = Object.freeze({
  codex: { provider: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: '' },
  hermes: { provider: 'OpenAI API', baseUrl: 'https://api.openai.com/v1', model: '' },
  openclaw: { provider: 'OpenAI API', baseUrl: 'https://api.openai.com/v1', model: '' },
  workbuddy: { provider: 'WorkBuddy Official', baseUrl: '', model: '' },
  kimi: { provider: 'Moonshot AI', baseUrl: 'https://api.moonshot.cn/v1', model: '' },
  mimo: { provider: 'MiMo Native', baseUrl: '', model: '' },
  claude: { provider: 'Anthropic', baseUrl: 'https://api.anthropic.com', model: '' },
  gemini: { provider: 'Google AI Studio', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: '' },
  opencode: { provider: 'OpenCode Provider', baseUrl: '', model: '' },
  qwen: { provider: 'DashScope', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: '' },
  opencodereview: { provider: 'OpenAI API', baseUrl: 'https://api.openai.com/v1', model: '' },
})

const RUNTIME_KEYS = Object.freeze({
  codex: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'],
  hermes: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'HERMES_INFERENCE_MODEL'],
  openclaw: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'],
  workbuddy: ['CODEBUDDY_API_KEY', 'CODEBUDDY_BASE_URL', 'CODEBUDDY_MODEL'],
  kimi: ['KIMI_MODEL_API_KEY', 'KIMI_MODEL_BASE_URL', 'KIMI_MODEL_NAME'],
  mimo: ['MIMO_API_KEY', 'MIMO_BASE_URL', 'MIMO_MODEL'],
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_MODEL'],
  opencode: ['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'],
  qwen: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'],
  opencodereview: ['OCR_LLM_URL', 'OCR_LLM_TOKEN', 'OCR_LLM_MODEL', 'OCR_USE_ANTHROPIC'],
})

const CONFIG_FILES = Object.freeze({
  codex: '~/.codex/config.toml',
  hermes: '~/.hermes/.env',
  openclaw: '~/.openclaw/openclaw.json',
  workbuddy: '~/.workbuddy/models.json',
  kimi: '~/.kimi-code/config.toml',
  mimo: 'MiMo CLI native config',
  claude: '~/.claude/settings.json',
  gemini: '~/.gemini/settings.json',
  opencode: '~/.local/share/opencode/auth.json',
  qwen: '~/.qwen/oauth_creds.json',
  opencodereview: '~/.opencodereview/config.json',
})

const PROFILES = Object.freeze(Object.fromEntries(Object.keys(OFFICIAL).map(kind => [kind, {
  kind,
  docsKey: `provider.docs.${kind}`,
  configFile: CONFIG_FILES[kind] || '',
  runtimeKeys: RUNTIME_KEYS[kind] || [],
  presets: PROVIDER_PRESETS.map(id => ({
    id,
    ...(id === 'official' ? OFFICIAL[kind] : id === 'openrouter' ? OPENROUTER : CUSTOM),
  })),
}])))

const FALLBACK_PROFILE = Object.freeze({
  kind: '',
  docsKey: 'provider.docs.custom',
  configFile: '',
  runtimeKeys: ['API_KEY', 'BASE_URL', 'MODEL'],
  presets: [
    { id: 'official', provider: 'Official Provider', baseUrl: '', model: '' },
    OPENROUTER,
    CUSTOM,
  ],
})

export function providerProfile(kind) {
  return PROFILES[String(kind || '').trim()] || FALLBACK_PROFILE
}

export function inferProviderPreset(kind, status) {
  const profile = providerProfile(kind)
  const baseUrl = String(status?.baseUrl || '').trim().replace(/\/+$/, '')
  const provider = String(status?.provider || '').trim().toLowerCase()
  if (!baseUrl && !provider) return 'official'
  if (/openrouter/i.test(provider) || /(^|\.)openrouter\.ai$/i.test(hostname(baseUrl))) return 'openrouter'
  const official = profile.presets.find(preset => preset.id === 'official')
  if (official && baseUrl && baseUrl === String(official.baseUrl || '').replace(/\/+$/, '')) return 'official'
  return 'custom'
}

function hostname(value) {
  try { return new URL(value).hostname } catch { return '' }
}
