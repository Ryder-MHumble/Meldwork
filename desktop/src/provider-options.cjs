const { managedOpenClawOptions, nativeOpenClawOptions } = require('./openclaw-runtime.cjs')

const EXTERNAL_PROVIDER_KINDS = new Set([
  'codex', 'hermes', 'openclaw', 'workbuddy', 'kimi', 'mimo', 'claude', 'gemini', 'opencode', 'qwen',
  'opencodereview',
])

const OFFICIAL_PROVIDER_BASE_URLS = Object.freeze({
  codex: 'https://api.openai.com/v1',
  hermes: 'https://api.openai.com/v1',
  openclaw: 'https://api.openai.com/v1',
  workbuddy: '',
  kimi: 'https://api.moonshot.cn/v1',
  mimo: '',
  claude: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  opencode: '',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  opencodereview: 'https://api.openai.com/v1',
})

function chatCompletionsUrl(baseUrl) {
  const normalized = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!normalized) return ''
  return /\/chat\/completions$/i.test(normalized)
    ? normalized
    : `${normalized}/chat/completions`
}

function providerPresetFromStatus(kind, status = {}) {
  if (['official', 'openrouter', 'custom'].includes(status.activePreset)) {
    return status.activePreset
  }
  const provider = String(status.provider || '').trim().toLowerCase()
  const baseUrl = String(status.baseUrl || '').trim().replace(/\/+$/, '')
  if (/openrouter/i.test(provider) || /openrouter\.ai$/i.test(new URL(baseUrl || 'https://example.com').hostname)) {
    return 'openrouter'
  }
  if (OFFICIAL_PROVIDER_BASE_URLS[kind]
      && baseUrl
      && baseUrl === OFFICIAL_PROVIDER_BASE_URLS[kind]) {
    return 'official'
  }
  return 'custom'
}

function providerOptionsFor(kind, generic, context = {}, status = {}) {
  const preset = providerPresetFromStatus(kind, status)
  if (kind === 'codex') return { env: generic }
  if (kind === 'hermes') {
    return {
      provider: { id: 'openai-api', model: generic.OPENAI_MODEL },
      env: {
        ...generic,
        HERMES_INFERENCE_PROVIDER: 'openai-api',
        HERMES_INFERENCE_MODEL: generic.OPENAI_MODEL,
      },
    }
  }
  if (kind === 'workbuddy') {
    return {
      env: {
        ...generic,
        CODEBUDDY_MODEL: generic.OPENAI_MODEL,
        CODEBUDDY_API_KEY: generic.OPENAI_API_KEY,
        CODEBUDDY_BASE_URL: generic.OPENAI_BASE_URL,
      },
    }
  }
  if (kind === 'kimi') {
    return {
      env: {
        ...generic,
        MOONSHOT_API_KEY: generic.OPENAI_API_KEY,
        KIMI_API_KEY: generic.OPENAI_API_KEY,
        KIMI_MODEL_API_KEY: generic.OPENAI_API_KEY,
        KIMI_MODEL_BASE_URL: generic.OPENAI_BASE_URL,
        KIMI_MODEL_NAME: generic.OPENAI_MODEL,
      },
    }
  }
  if (kind === 'mimo') {
    return {
      env: {
        ...generic,
        MIMO_API_KEY: generic.OPENAI_API_KEY,
        MIMO_BASE_URL: generic.OPENAI_BASE_URL,
        MIMO_MODEL: generic.OPENAI_MODEL,
      },
    }
  }
  if (kind === 'claude') {
    return {
      env: {
        ...generic,
        ANTHROPIC_API_KEY: generic.OPENAI_API_KEY,
        ANTHROPIC_BASE_URL: generic.OPENAI_BASE_URL,
        ANTHROPIC_MODEL: generic.OPENAI_MODEL,
      },
    }
  }
  if (kind === 'gemini') {
    return {
      env: {
        ...generic,
        GEMINI_API_KEY: generic.OPENAI_API_KEY,
        GOOGLE_API_KEY: generic.OPENAI_API_KEY,
        GEMINI_MODEL: generic.OPENAI_MODEL,
      },
    }
  }
  if (kind === 'qwen') {
    return {
      provider: { id: 'openai', model: generic.OPENAI_MODEL },
      env: {
        ...generic,
        DASHSCOPE_API_KEY: generic.OPENAI_API_KEY,
      },
    }
  }
  if (kind === 'opencode') {
    return {
      env: {
        ...generic,
        ...(preset === 'openrouter' ? { OPENROUTER_API_KEY: generic.OPENAI_API_KEY } : {}),
      },
    }
  }
  if (kind === 'opencodereview') {
    return {
      env: {
        ...generic,
        OCR_LLM_URL: chatCompletionsUrl(generic.OPENAI_BASE_URL),
        OCR_LLM_TOKEN: generic.OPENAI_API_KEY,
        OCR_LLM_MODEL: generic.OPENAI_MODEL,
        OCR_USE_ANTHROPIC: 'false',
      },
    }
  }
  if (kind === 'openclaw' && context.storageRoot && context.workdir) {
    if (!generic?.OPENAI_API_KEY) {
      return nativeOpenClawOptions({
        storageRoot: context.storageRoot,
        workdir: context.workdir,
        sessionRef: context.sessionRef,
        allowWrite: context.sandbox === 'workspace-write',
        runtime: context.nativeRuntime,
      })
    }
    return managedOpenClawOptions({
      storageRoot: context.storageRoot,
      workdir: context.workdir,
      sessionRef: context.sessionRef,
      allowWrite: context.sandbox === 'workspace-write',
      provider: generic,
    })
  }
  return {}
}

function providerAgentKind(value) {
  const kind = String(value || '').trim()
  if (!EXTERNAL_PROVIDER_KINDS.has(kind)) throw new Error('PROVIDER_AGENT_UNSUPPORTED')
  return kind
}

module.exports = {
  EXTERNAL_PROVIDER_KINDS,
  providerAgentKind,
  providerOptionsFor,
}
