const { execFile } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { promisify } = require('node:util')
const { prepareCommand, searchPath } = require('./cli-adapters.cjs')

const execFileAsync = promisify(execFile)

const CREDENTIAL_FIELD = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|credential)$/i
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

async function resolveNativeCredentialState(kind, options = {}) {
  if (kind === 'mimo') return { state: 'ready', source: 'native-cli' }
  const current = nativeCredentialState(kind, options)
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
  resolveNativeCredentialState,
}
