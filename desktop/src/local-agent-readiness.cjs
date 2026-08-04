const { execFile } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { promisify } = require('node:util')
const { prepareCommand, searchPath } = require('./cli-adapters.cjs')
const { isOpenClawSecretReference } = require('./openclaw-runtime.cjs')

const execFileAsync = promisify(execFile)

const CREDENTIAL_FIELD = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|credential)$/i
const OPENCLAW_MODEL_REF = /^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,239}$/
const OPENCLAW_PROVIDER_ID = /^[a-z][a-z0-9_-]{0,63}$/
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
const OPENCLAW_MODEL_INPUTS = new Set(['text', 'image', 'audio', 'video'])
const MAX_CREDENTIAL_FILE_BYTES = 2 * 1024 * 1024
const CREDENTIAL_ENV_KEYS = Object.freeze({
  codex: ['OPENAI_API_KEY'],
  hermes: ['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY'],
  openclaw: ['OPENAI_API_KEY', 'OPENROUTER_API_KEY'],
  workbuddy: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
  kimi: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
  mimo: [],
  claude: ['ANTHROPIC_API_KEY'],
  qwen: ['DASHSCOPE_API_KEY', 'OPENAI_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  opencode: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY'],
  opencodereview: ['OCR_LLM_TOKEN', 'OPENAI_API_KEY'],
})

function readCredentialFile(filename) {
  try {
    const stat = fs.statSync(filename)
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CREDENTIAL_FILE_BYTES) return ''
    return fs.readFileSync(filename, 'utf8')
  } catch {
    return ''
  }
}

function containsCredential(value) {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(containsCredential)
  return Object.entries(value).some(([key, child]) => {
    if (CREDENTIAL_FIELD.test(key) && typeof child === 'string' && child.trim()) return true
    return child && typeof child === 'object' && containsCredential(child)
  })
}

function jsonContainsCredential(filename) {
  try {
    const contents = readCredentialFile(filename)
    return Boolean(contents) && containsCredential(JSON.parse(contents))
  } catch {
    return false
  }
}

function textContainsCredential(filename) {
  try {
    return readCredentialFile(filename).split(/\r?\n/).some((line) => {
      const match = line.match(/^\s*([A-Za-z][A-Za-z0-9_-]*)\s*[:=]\s*(.+?)\s*$/)
      if (!match || !CREDENTIAL_FIELD.test(match[1])) return false
      const value = match[2].replace(/^['"]|['"]$/g, '').trim()
      return Boolean(value && !/^\$\{[^}]+\}$/.test(value))
    })
  } catch {
    return false
  }
}

function nativeCredentialEnvironment(kind, env = process.env) {
  const result = {}
  for (const key of CREDENTIAL_ENV_KEYS[kind] || []) {
    if (typeof env[key] === 'string' && env[key].trim()) result[key] = env[key]
  }
  return result
}

function nativeCredentialState(kind, options = {}) {
  const home = options.home || os.homedir()
  const env = options.env || process.env
  if (Object.keys(nativeCredentialEnvironment(kind, env)).length) {
    return { state: 'ready', source: 'native-credential' }
  }

  const jsonFiles = {
    codex: [path.join(home, '.codex', 'auth.json')],
    hermes: [path.join(home, '.hermes', 'auth.json')],
    openclaw: [path.join(home, '.openclaw', 'openclaw.json')],
    workbuddy: [path.join(home, '.workbuddy', 'models.json')],
    kimi: [path.join(home, '.kimi-code', 'credentials', 'kimi-code.json')],
    claude: [path.join(home, '.claude', '.credentials.json')],
    qwen: [path.join(home, '.qwen', 'oauth_creds.json')],
    gemini: [path.join(home, '.gemini', 'oauth_creds.json')],
    opencode: [path.join(home, '.local', 'share', 'opencode', 'auth.json')],
    opencodereview: [path.join(home, '.opencodereview', 'config.json')],
  }[kind] || []
  if (jsonFiles.some(jsonContainsCredential)) {
    return { state: 'ready', source: 'native-credential' }
  }

  const textFiles = {
    hermes: [path.join(home, '.hermes', '.env')],
    kimi: [
      path.join(home, '.kimi', 'config.toml'),
      path.join(home, '.kimi-code', 'config.toml'),
    ],
  }[kind] || []
  if (textFiles.some(textContainsCredential)) {
    return { state: 'ready', source: 'native-credential' }
  }

  return { state: 'unknown', source: 'unverified' }
}

function probeEnvironment(options = {}) {
  const source = options.env || process.env
  const platform = options.platform || process.platform
  const home = options.home || os.homedir()
  const env = {}
  for (const key of [
    'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP',
    'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE',
    'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME',
    'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
    'APPDATA', 'LOCALAPPDATA',
  ]) {
    if (typeof source[key] === 'string' && source[key]) env[key] = source[key]
  }
  if (platform === 'win32') env.USERPROFILE ||= home
  else env.HOME = home
  env.PATH = searchPath({ platform, env: source, home })
  return env
}

function claudeAuthState(output) {
  try {
    const status = JSON.parse(String(output || '').trim())
    if (status?.loggedIn === true) return { state: 'ready', source: 'native-auth-status' }
    if (status?.loggedIn === false) return { state: 'missing', source: 'native-auth-status' }
  } catch { /* keep the file-based result */ }
  return null
}

function mimoAuthState(output) {
  const lines = String(output || '')
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
    .split(/\r?\n/)
    .map(line => line.replace(/^[^A-Za-z0-9]+/, '').trim())
    .filter(Boolean)
  if (lines.some(line => (
    /^Not logged in(?:\.|$)/i.test(line) && /\bmimo auth login\b/i.test(line)
  ))) {
    return { state: 'missing', source: 'native-auth-status' }
  }
  const providerReady = lines.some(line => /^Provider\s*:\s*MiMo\s*$/i.test(line))
  const identityReady = lines.some(line => (
    /^(?:User ID|Type)\s*:\s*[A-Za-z0-9]/i.test(line)
  ))
  return providerReady && identityReady
    ? { state: 'ready', source: 'native-auth-status' }
    : null
}

function pathInside(parent, child) {
  const relative = path.relative(parent, child)
  return Boolean(relative) && relative !== '..'
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function identityValue(value) {
  return typeof value === 'bigint' ? value.toString() : String(value)
}

function sameFilesystemIdentity(stat, expected) {
  return identityValue(stat.dev) === expected.dev && identityValue(stat.ino) === expected.ino
}

function fileVersion(stat) {
  return {
    dev: identityValue(stat.dev),
    ino: identityValue(stat.ino),
    size: identityValue(stat.size),
    mtime: identityValue(stat.mtimeNs ?? stat.mtimeMs),
    ctime: identityValue(stat.ctimeNs ?? stat.ctimeMs),
  }
}

function sameFileVersion(stat, expected) {
  const current = fileVersion(stat)
  return current.dev === expected.dev && current.ino === expected.ino
    && current.size === expected.size && current.mtime === expected.mtime
    && current.ctime === expected.ctime
}

function openClawDirectoryIdentity(filename) {
  const resolved = path.resolve(filename)
  const stat = fs.lstatSync(resolved)
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(resolved) !== resolved) {
    throw new Error('OPENCLAW_NATIVE_RUNTIME_UNSAFE_PATH')
  }
  return { path: resolved, dev: identityValue(stat.dev), ino: identityValue(stat.ino) }
}

function validateOpenClawDirectoryIdentities(identities) {
  for (const expected of identities) {
    const current = openClawDirectoryIdentity(expected.path)
    if (current.dev !== expected.dev || current.ino !== expected.ino) {
      throw new Error('OPENCLAW_NATIVE_RUNTIME_UNSAFE_PATH')
    }
  }
}

function parseOpenClawStatus(output, options = {}) {
  try {
    const status = JSON.parse(String(output || '').trim())
    const auth = status?.auth
    const resolvedModel = String(status?.resolvedDefault || status?.defaultModel || '').trim()
    if (!auth || !OPENCLAW_MODEL_REF.test(resolvedModel)) return null
    if (Array.isArray(auth.missingProvidersInUse) && auth.missingProvidersInUse.length) {
      return { credentialState: { state: 'missing', source: 'native-auth-status' } }
    }
    const requestedAgentDir = String(status?.agentDir || '').trim()
    if (!path.isAbsolute(requestedAgentDir)) {
      return { credentialState: { state: 'ready', source: 'native-auth-status' } }
    }
    const resolvedHome = fs.realpathSync(path.resolve(options.home || os.homedir()))
    const nativeRoot = path.join(resolvedHome, '.openclaw')
    const nativeRootIdentity = openClawDirectoryIdentity(nativeRoot)
    const agentDir = fs.realpathSync(requestedAgentDir)
    if (!fs.statSync(agentDir).isDirectory() || !pathInside(nativeRoot, agentDir)) {
      return { credentialState: { state: 'ready', source: 'native-auth-status' } }
    }
    const directoryIdentities = [nativeRootIdentity]
    let current = nativeRoot
    for (const segment of path.relative(nativeRoot, agentDir).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment)
      directoryIdentities.push(openClawDirectoryIdentity(current))
    }
    return {
      credentialState: { state: 'ready', source: 'native-auth-status' },
      runtime: {
        model: resolvedModel,
        agentDir: path.normalize(agentDir),
        directoryIdentities,
      },
    }
  } catch {
    return null
  }
}

function openClawModelParts(modelRef) {
  const separator = modelRef.indexOf('/')
  if (separator <= 0 || separator === modelRef.length - 1) return null
  const providerId = modelRef.slice(0, separator)
  const modelId = modelRef.slice(separator + 1)
  if (!OPENCLAW_PROVIDER_ID.test(providerId) || !OPENCLAW_MODEL_REF.test(modelId)) return null
  return { providerId, modelId }
}

function openClawBaseUrl(value) {
  const baseUrl = String(value || '').trim().replace(/\/+$/, '')
  let parsed
  try { parsed = new URL(baseUrl) } catch { return '' }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  if ((parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback))
      || parsed.username || parsed.password || parsed.search || parsed.hash) return ''
  return baseUrl
}

function boundedPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1_000_000_000
    ? value
    : null
}

function sanitizedOpenClawModel(input, modelId) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || String(input.id || '').trim() !== modelId) return null
  const requestedName = String(input.name || '').trim()
  if (requestedName.length > 240) return null
  const model = { id: modelId, name: requestedName || modelId }
  if (Array.isArray(input.input)) {
    const values = [...new Set(input.input.map(value => String(value || '').trim()))]
    if (!values.length || values.some(value => !OPENCLAW_MODEL_INPUTS.has(value))) return null
    model.input = values
  } else {
    model.input = ['text']
  }
  for (const key of ['contextWindow', 'contextTokens', 'maxTokens']) {
    const value = boundedPositiveNumber(input[key])
    if (value !== null) model[key] = value
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

function openClawApiKey(input) {
  if (typeof input !== 'string' || isOpenClawSecretReference(input)) return ''
  const value = input.trim()
  return value && value.length <= 8192 ? value : ''
}

function parseOpenClawModelsFile(output, modelRef) {
  try {
    const parts = openClawModelParts(modelRef)
    const catalog = JSON.parse(String(output || '').trim())
    const provider = catalog?.providers?.[parts?.providerId]
    if (!parts || !provider || typeof provider !== 'object' || Array.isArray(provider)) return null
    const baseUrl = openClawBaseUrl(provider.baseUrl)
    const api = String(provider.api || '').trim()
    const apiKey = openClawApiKey(provider.apiKey)
    const model = Array.isArray(provider.models)
      ? provider.models.map(candidate => sanitizedOpenClawModel(candidate, parts.modelId)).find(Boolean)
      : null
    if (!baseUrl || !OPENCLAW_PROVIDER_APIS.has(api) || !apiKey || !model) return null
    return {
      model: modelRef,
      provider: { id: parts.providerId, baseUrl, api, apiKey, model },
    }
  } catch {
    return null
  }
}

function readOpenClawModelsFile(runtime) {
  validateOpenClawDirectoryIdentities(runtime.directoryIdentities)
  const modelsPath = path.join(runtime.agentDir, 'models.json')
  const resolvedModelsPath = path.resolve(modelsPath)
  const entry = fs.lstatSync(modelsPath, { bigint: true })
  if (!entry.isFile() || entry.isSymbolicLink()
      || fs.realpathSync(resolvedModelsPath) !== resolvedModelsPath) return ''
  const noFollow = fs.constants.O_NOFOLLOW || 0
  const descriptor = fs.openSync(resolvedModelsPath, fs.constants.O_RDONLY | noFollow)
  try {
    const before = fs.fstatSync(descriptor, { bigint: true })
    if (!before.isFile() || before.size <= 0n || before.size > BigInt(MAX_CREDENTIAL_FILE_BYTES)
        || !sameFilesystemIdentity(before, {
          dev: identityValue(entry.dev), ino: identityValue(entry.ino),
        })) return ''
    const expectedVersion = fileVersion(before)
    const contents = fs.readFileSync(descriptor, 'utf8')
    const after = fs.fstatSync(descriptor, { bigint: true })
    validateOpenClawDirectoryIdentities(runtime.directoryIdentities)
    const current = fs.lstatSync(resolvedModelsPath, { bigint: true })
    if (!sameFileVersion(after, expectedVersion)
        || !current.isFile() || current.isSymbolicLink()
        || !sameFileVersion(current, expectedVersion)
        || fs.realpathSync(resolvedModelsPath) !== resolvedModelsPath) {
      throw new Error('OPENCLAW_NATIVE_RUNTIME_UNSAFE_PATH')
    }
    return contents
  } finally {
    fs.closeSync(descriptor)
  }
}

async function queryOpenClawStatus(options = {}) {
  if (!options.executable) return null
  const platform = options.platform || process.platform
  const prepareCommandFn = options.prepareCommandFn || prepareCommand
  const execFileFn = options.execFileFn || execFileAsync
  const prepared = prepareCommandFn(
    options.executable,
    ['models', 'status', '--check', '--json'],
    { platform },
  )
  try {
    const result = await execFileFn(prepared.command, prepared.args, {
      timeout: 7000,
      windowsHide: true,
      env: probeEnvironment(options),
    })
    return parseOpenClawStatus(result.stdout, options)
  } catch (error) {
    return parseOpenClawStatus(error?.stdout, options)
  }
}

async function resolveNativeOpenClawRuntime(options = {}) {
  const status = await queryOpenClawStatus(options)
  if (!status?.runtime || status.credentialState?.state !== 'ready') {
    throw new Error('OPENCLAW_NATIVE_RUNTIME_UNAVAILABLE')
  }
  const parts = openClawModelParts(status.runtime.model)
  if (!parts) throw new Error('OPENCLAW_NATIVE_RUNTIME_UNAVAILABLE')
  try {
    const runtime = parseOpenClawModelsFile(
      readOpenClawModelsFile(status.runtime),
      status.runtime.model,
    )
    if (runtime) return runtime
  } catch { /* fail closed below */ }
  throw new Error('OPENCLAW_NATIVE_RUNTIME_UNAVAILABLE')
}

async function queryMimoAuthState(options = {}) {
  if (!options.executable) return null
  const platform = options.platform || process.platform
  const prepareCommandFn = options.prepareCommandFn || prepareCommand
  const execFileFn = options.execFileFn || execFileAsync
  const prepared = prepareCommandFn(options.executable, ['providers', 'whoami'], { platform })
  try {
    const result = await execFileFn(prepared.command, prepared.args, {
      timeout: 5000,
      windowsHide: true,
      env: probeEnvironment(options),
    })
    return mimoAuthState(result.stdout)
  } catch (error) {
    return mimoAuthState(error?.stdout)
  }
}

async function resolveNativeCredentialState(kind, options = {}) {
  if (kind === 'mimo') {
    return await queryMimoAuthState(options) || { state: 'unknown', source: 'unverified' }
  }
  const current = nativeCredentialState(kind, options)
  if (kind === 'openclaw') {
    const status = await queryOpenClawStatus(options)
    return status?.credentialState || current
  }
  if (kind !== 'claude' || !options.executable
      || Object.keys(nativeCredentialEnvironment(kind, options.env)).length) return current

  const platform = options.platform || process.platform
  const prepareCommandFn = options.prepareCommandFn || prepareCommand
  const execFileFn = options.execFileFn || execFileAsync
  const prepared = prepareCommandFn(options.executable, ['auth', 'status', '--json'], { platform })
  try {
    const result = await execFileFn(prepared.command, prepared.args, {
      timeout: 5000,
      windowsHide: true,
      env: probeEnvironment(options),
    })
    return claudeAuthState(result.stdout) || current
  } catch (error) {
    return claudeAuthState(error?.stdout) || current
  }
}

module.exports = {
  nativeCredentialEnvironment,
  nativeCredentialState,
  resolveNativeOpenClawRuntime,
  resolveNativeCredentialState,
}
