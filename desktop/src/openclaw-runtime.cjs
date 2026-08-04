const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { atomicWritePrivateFile } = require('./private-file.cjs')

const MANAGED_OPENCLAW_PROVIDER_ID = 'roundrelay-desktop'
const READ_ONLY_TOOLS = [
  'read', 'web_search', 'web_fetch', 'memory_search', 'memory_get', 'session_status',
]
const WRITE_TOOLS = ['write', 'edit', 'apply_patch']
const DENIED_TOOLS = [
  'exec', 'process', 'code_execution', 'browser', 'canvas', 'gateway', 'nodes', 'cron',
  'message', 'sessions_send', 'sessions_spawn', 'subagents',
]
const OPENCLAW_MODEL_REF = /^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,239}$/
const NATIVE_OPENCLAW_PROVIDER_ID = /^[a-z][a-z0-9_-]{0,63}$/
const NATIVE_OPENCLAW_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,239}$/
const NATIVE_OPENCLAW_MODEL_INPUTS = new Set(['text', 'image', 'audio', 'video'])
const OPENCLAW_PROVIDER_APIS = new Set([
  'openai-completions',
  'openai-responses',
  'openai-chatgpt-responses',
  'anthropic-messages',
  'google-generative-ai',
  'google-vertex',
  'github-copilot',
  'bedrock-converse-stream',
  'ollama',
  'azure-openai-responses',
])

function normalizeProvider(input) {
  const apiKey = String(input?.OPENAI_API_KEY || '').trim()
  const baseUrl = String(input?.OPENAI_BASE_URL || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
  const model = String(input?.OPENAI_MODEL || '').trim()
  let parsed
  try { parsed = new URL(baseUrl) } catch { throw new Error('OPENCLAW_PROVIDER_INVALID') }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  if (!apiKey || apiKey.length > 8192 || !model || model.length > 120
      || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback))
      || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('OPENCLAW_PROVIDER_INVALID')
  }
  return { apiKey, baseUrl, model }
}

function runtimePaths({ storageRoot, workdir, sessionRef, configName }) {
  if (!path.isAbsolute(storageRoot) || !path.isAbsolute(workdir)) {
    throw new Error('OPENCLAW_RUNTIME_INVALID_SCOPE')
  }
  let resolvedStorageRoot
  try {
    resolvedStorageRoot = fs.realpathSync(path.resolve(storageRoot))
    if (!fs.statSync(resolvedStorageRoot).isDirectory()) throw new Error('invalid')
  } catch {
    throw new Error('OPENCLAW_RUNTIME_INVALID_SCOPE')
  }
  const resolvedWorkdir = path.resolve(workdir)
  const scope = crypto.createHash('sha256')
    .update(`${sessionRef || 'configure'}\0${resolvedWorkdir}`)
    .digest('hex')
    .slice(0, 24)
  const runtimeRoot = path.join(resolvedStorageRoot, 'openclaw-managed', scope)
  const home = path.join(runtimeRoot, 'home')
  const state = path.join(runtimeRoot, 'state')
  const configPath = path.join(runtimeRoot, configName)
  for (const directory of [
    path.join(resolvedStorageRoot, 'openclaw-managed'),
    runtimeRoot,
    home,
    state,
  ]) {
    try {
      fs.mkdirSync(directory, { mode: 0o700 })
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()
        || fs.realpathSync(directory) !== directory) {
      throw new Error('OPENCLAW_RUNTIME_UNSAFE_PATH')
    }
    if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700) {
      fs.chmodSync(directory, 0o700)
    }
  }
  return { resolvedWorkdir, home, state, configPath }
}

function toolPolicy(allowWrite) {
  const allowedTools = allowWrite
    ? [...READ_ONLY_TOOLS, ...WRITE_TOOLS]
    : READ_ONLY_TOOLS
  return {
    allow: allowedTools,
    deny: DENIED_TOOLS,
    fs: { workspaceOnly: true },
    exec: { security: 'deny', ask: 'always' },
    elevated: { enabled: false },
  }
}

function writeRuntimeConfig(configPath, config) {
  const contents = `${JSON.stringify(config, null, 2)}\n`
  atomicWritePrivateFile(configPath, contents)
}

function normalizedNativeModel(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const id = String(input.id || '').trim()
  const name = String(input.name || '').trim()
  if (!NATIVE_OPENCLAW_MODEL_ID.test(id) || !name || name.length > 240) return null
  const model = { id, name }
  if (!Array.isArray(input.input) || !input.input.length
      || input.input.some(value => !NATIVE_OPENCLAW_MODEL_INPUTS.has(value))) return null
  model.input = [...new Set(input.input)]
  for (const key of ['contextWindow', 'contextTokens', 'maxTokens']) {
    const value = input[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1_000_000_000) {
      model[key] = value
    }
  }
  if (typeof input.reasoning === 'boolean') model.reasoning = input.reasoning
  if (input.cost && typeof input.cost === 'object' && !Array.isArray(input.cost)) {
    const cost = {}
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
      const value = input.cost[key]
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000) {
        cost[key] = value
      }
    }
    if (Object.keys(cost).length) model.cost = cost
  }
  return model
}

function managedOpenClawOptions({
  storageRoot, workdir, sessionRef = '', allowWrite = false, provider,
}) {
  const normalized = normalizeProvider(provider)
  const configName = allowWrite
    ? 'openclaw.provider.workspace-write.json'
    : 'openclaw.provider.read-only.json'
  const { resolvedWorkdir, home, state, configPath } = runtimePaths({
    storageRoot, workdir, sessionRef, configName,
  })

  const modelRef = `${MANAGED_OPENCLAW_PROVIDER_ID}/${normalized.model}`
  const config = {
    agents: {
      defaults: {
        workspace: resolvedWorkdir,
        model: { primary: modelRef },
        skipBootstrap: true,
      },
    },
    models: {
      mode: 'replace',
      providers: {
        [MANAGED_OPENCLAW_PROVIDER_ID]: {
          baseUrl: normalized.baseUrl,
          apiKey: {
            source: 'env', provider: 'default', id: 'ROUNDRELAY_OPENCLAW_API_KEY',
          },
          api: 'openai-completions',
          models: [{ id: normalized.model, name: normalized.model, input: ['text'] }],
        },
      },
    },
    tools: toolPolicy(allowWrite),
  }
  writeRuntimeConfig(configPath, config)

  return {
    env: {
      OPENCLAW_HOME: home,
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_WORKSPACE_DIR: resolvedWorkdir,
      ROUNDRELAY_OPENCLAW_API_KEY: normalized.apiKey,
    },
  }
}

function nativeOpenClawOptions({
  storageRoot, workdir, sessionRef = '', allowWrite = false, runtime,
}) {
  const modelRef = String(runtime?.model || '').trim()
  const provider = runtime?.provider
  const providerId = String(provider?.id || '').trim()
  const apiKey = String(provider?.apiKey || '').trim()
  const baseUrl = String(provider?.baseUrl || '').trim()
  const api = String(provider?.api || '').trim()
  const model = normalizedNativeModel(provider?.model)
  if (!OPENCLAW_MODEL_REF.test(modelRef)
      || !NATIVE_OPENCLAW_PROVIDER_ID.test(providerId)
      || !apiKey || apiKey.length > 8192
      || !OPENCLAW_PROVIDER_APIS.has(api)
      || !model || typeof model !== 'object' || Array.isArray(model)
      || String(model.id || '').trim() === ''
      || modelRef !== `${providerId}/${model.id}`) {
    throw new Error('OPENCLAW_NATIVE_RUNTIME_INVALID')
  }
  let parsedBaseUrl
  try { parsedBaseUrl = new URL(baseUrl) } catch { /* handled below */ }
  const loopback = parsedBaseUrl
    && ['localhost', '127.0.0.1', '[::1]'].includes(parsedBaseUrl.hostname)
  if (!parsedBaseUrl
      || (parsedBaseUrl.protocol !== 'https:' && !(parsedBaseUrl.protocol === 'http:' && loopback))
      || parsedBaseUrl.username || parsedBaseUrl.password
      || parsedBaseUrl.search || parsedBaseUrl.hash) {
    throw new Error('OPENCLAW_NATIVE_RUNTIME_INVALID')
  }
  const configName = allowWrite
    ? 'openclaw.native.workspace-write.json'
    : 'openclaw.native.read-only.json'
  const { resolvedWorkdir, home, state, configPath } = runtimePaths({
    storageRoot, workdir, sessionRef, configName,
  })
  const modelConfig = { primary: modelRef }
  const config = {
    agents: {
      defaults: {
        workspace: resolvedWorkdir,
        model: modelConfig,
        skipBootstrap: true,
      },
    },
    models: {
      mode: 'replace',
      providers: {
        [providerId]: {
          baseUrl: baseUrl.replace(/\/+$/, ''),
          apiKey: {
            source: 'env', provider: 'default', id: 'ROUNDRELAY_OPENCLAW_NATIVE_API_KEY',
          },
          api,
          models: [model],
        },
      },
    },
    tools: toolPolicy(allowWrite),
  }
  writeRuntimeConfig(configPath, config)
  return {
    env: {
      OPENCLAW_HOME: home,
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_WORKSPACE_DIR: resolvedWorkdir,
      ROUNDRELAY_OPENCLAW_NATIVE_API_KEY: apiKey,
    },
  }
}

module.exports = { managedOpenClawOptions, nativeOpenClawOptions }
