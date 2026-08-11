const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { prepareCommand, searchPath } = require('../agents/cli/cli-adapters.cjs')

const execFileAsync = promisify(execFile)
const EXEC_TIMEOUT_MS = 4500
const KNOWLEDGE_PROBE_ENV_KEYS = Object.freeze([
  'HOME', 'USER', 'LOGNAME', 'SHELL',
  'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'TERM', 'COLORTERM', 'NO_COLOR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME',
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
  'OS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'NUMBER_OF_PROCESSORS',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
])

function runtimeOptions(options = {}) {
  const platform = options.platform || process.platform
  return {
    platform,
    env: options.env || process.env,
    home: options.home || os.homedir(),
    accessFn: options.accessFn || fs.promises.access,
    statFn: options.statFn || fs.promises.stat,
    execFileFn: options.execFileFn || execFileAsync,
    pathApi: platform === 'win32' ? path.win32 : path.posix,
  }
}

function splitSearchPath(options) {
  const { platform, pathApi } = runtimeOptions(options)
  return String(searchPath(options) || '')
    .split(pathApi.delimiter)
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => platform === 'win32' ? value.toLowerCase() : value)
}

function environmentValue(env, name) {
  const match = Object.keys(env || {}).find(key => key.toLowerCase() === name.toLowerCase())
  return match ? env[match] : ''
}

function knowledgeProbeEnvironment(options = {}) {
  const { platform, env, home } = runtimeOptions(options)
  const childEnv = {}
  for (const name of KNOWLEDGE_PROBE_ENV_KEYS) {
    const value = environmentValue(env, name)
    if (typeof value === 'string' && value) childEnv[name] = value
  }
  if (platform === 'win32') childEnv.USERPROFILE ||= home
  else childEnv.HOME ||= home
  childEnv.PATH = searchPath(options)
  return childEnv
}

async function pathExists(filename, options = {}) {
  if (!filename) return false
  try {
    await (options.accessFn || fs.promises.access)(filename, fs.constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function pathDetails(filename, options = {}) {
  if (!filename) return { exists: false, directory: false, readable: false, writable: false }
  const { accessFn, statFn } = runtimeOptions(options)
  try {
    const info = await statFn(filename)
    const directory = typeof info?.isDirectory === 'function' ? info.isDirectory() : false
    if (!directory) return { exists: true, directory: false, readable: false, writable: false }
    let readable = true
    let writable = true
    try { await accessFn(filename, fs.constants.R_OK) } catch { readable = false }
    try { await accessFn(filename, fs.constants.W_OK) } catch { writable = false }
    return { exists: true, directory: true, readable, writable }
  } catch {
    return { exists: false, directory: false, readable: false, writable: false }
  }
}

async function resolveCommandPath(candidates, options = {}) {
  const { platform, pathApi } = runtimeOptions(options)
  const accessMode = platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK
  const searchDirectories = splitSearchPath(options)
  const extensions = platform === 'win32'
    ? ['', '.exe', '.cmd', '.bat']
    : ['']
  const accessFn = options.accessFn || fs.promises.access
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue
    const trimmed = candidate.trim()
    if (pathApi.isAbsolute(trimmed)) {
      if (await pathExists(trimmed, options)) return trimmed
      continue
    }
    const names = platform === 'win32' && !pathApi.extname(trimmed)
      ? extensions.map(extension => `${trimmed}${extension}`)
      : [trimmed]
    for (const directory of searchDirectories) {
      for (const name of names) {
        const resolved = pathApi.join(directory, name)
        try {
          await accessFn(resolved, accessMode)
          return resolved
        } catch {
          /* continue */
        }
      }
    }
  }
  return ''
}

async function runProbe(command, args, options = {}) {
  const { platform, pathApi } = runtimeOptions(options)
  try {
    const prepared = prepareCommand(command, args, { platform })
    const childEnv = knowledgeProbeEnvironment(options)
    const result = await (options.execFileFn || execFileAsync)(prepared.command, prepared.args, {
      timeout: EXEC_TIMEOUT_MS,
      windowsHide: true,
      env: childEnv,
    })
    return {
      command: prepared.command,
      args: prepared.args,
      ok: true,
      code: 0,
      stdout: String(result?.stdout || ''),
      stderr: String(result?.stderr || ''),
      pathApi,
    }
  } catch (error) {
    return {
      command: String(command || ''),
      args: Array.isArray(args) ? args : [],
      ok: false,
      code: Number.isInteger(error?.code) ? error.code : -1,
      stdout: String(error?.stdout || ''),
      stderr: String(error?.stderr || ''),
      message: String(error?.message || ''),
      errorCode: stableProbeErrorCode(error),
      pathApi,
    }
  }
}

function stableProbeErrorCode(error) {
  const code = error?.code
  if (typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code)) return code
  if (Number.isInteger(code)) return 'PROBE_EXITED'
  return 'PROBE_FAILED'
}

function reportedProbeErrorCode(output) {
  const parsed = parseProbeJson(output)
  return parsed && (parsed.ok === false || parsed.success === false)
    ? 'PROBE_REPORTED_FAILURE'
    : ''
}

function classifyLoginState(output, code, diagnostics = '') {
  const text = `${String(output || '')}\n${String(diagnostics || '')}`.toLowerCase()
  const parsed = parseProbeJson(output)
  if (parsed && (parsed.authenticated === false || parsed.token_valid === false)) return 'missing'
  if (parsed && (parsed.authenticated === true || parsed.token_valid === true || parsed.ok === true)) return 'ready'
  if (parsed?.identities?.bot?.status === 'ready' || parsed?.identities?.user?.status === 'ready') return 'ready'
  if (parsed?.identities?.bot?.status === 'missing' && parsed?.identities?.user?.status === 'missing') return 'missing'
  if (!text && code === 0) return 'unknown'
  if (/not\s+logged\s+in|未登录|please\s+login|need\s+login|登录失败|登录过期|auth\s+required|unauthorized|forbidden|\b401\b|\b403\b/.test(text)) {
    return 'missing'
  }
  if (/logged\s+in|login\s+success|已登录|authenticated|whoami|当前用户|当前账号|current\s+account|current\s+user/.test(text)) {
    return 'ready'
  }
  return 'unknown'
}

function classifyPermissionState(output, code, loginState, diagnostics = '') {
  if (loginState === 'missing') return 'unknown'
  const text = `${String(output || '')}\n${String(diagnostics || '')}`.toLowerCase()
  const parsed = parseProbeJson(output)
  const permissionFlags = [
    parsed?.permissionGranted,
    parsed?.permission_granted,
    parsed?.hasPermission,
    parsed?.has_permission,
    parsed?.scopeGranted,
    parsed?.scope_granted,
    parsed?.permission?.granted,
    parsed?.scope?.granted,
  ].filter(value => typeof value === 'boolean')
  const permissionStatuses = [
    parsed?.permissionState,
    parsed?.permission_state,
    parsed?.permission?.status,
    parsed?.scope?.status,
  ]
    .filter(value => typeof value === 'string')
    .map(value => value.trim().toLowerCase())
  if (permissionFlags.includes(false) || permissionStatuses.some(status => /^(?:missing|required|needed|denied|needs-grant)$/.test(status))) {
    return 'needs-grant'
  }
  if (permissionFlags.includes(true) || permissionStatuses.some(status => /^(?:ready|granted|available)$/.test(status))) return 'ready'
  if (parsed && (parsed.ok === true || parsed.success === true)) return 'ready'
  if (!text && code === 0) return 'unknown'
  if (/permission.*(missing|required|needed|denied)|scope.*(missing|required|denied)|权限.*(缺失|不足|未授予|需要)|授权失败|需要授权|access\s+denied/.test(text)) {
    return 'needs-grant'
  }
  if (/permission.*(granted|ready|available)|scope.*(granted)|权限.*(已授予|已开启|已配置)/.test(text)) {
    return 'ready'
  }
  return 'unknown'
}

function parseProbeJson(output) {
  const value = String(output || '').trim()
  if (!value || (!value.startsWith('{') && !value.startsWith('['))) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function commandBaseName(commandPath, options = {}) {
  const { pathApi } = runtimeOptions(options)
  return pathApi.basename(String(commandPath || ''))
    .replace(/\.(?:exe|cmd|bat)$/i, '')
    .toLowerCase()
}

function probeArgsFor(source, commandPath, probe, options = {}) {
  if (source.kind === 'feishu') {
    if (commandBaseName(commandPath, options) === 'opdev') {
      return probe === 'login' ? ['whoami'] : []
    }
    return probe === 'login'
      ? ['auth', 'status']
      : ['docs', '+search', '--query', '.', '--page-size', '1', '--as', 'user']
  }
  if (source.kind === 'dingtalk') {
    return probe === 'login' ? ['auth', 'status'] : ['doc', 'list', '--page-size', '1']
  }
  if (source.kind === 'obsidian' && probe === 'version') return ['version']
  return []
}

function sourceCommandDetails(source, commandPath, options = {}) {
  const command = commandBaseName(commandPath, options)
  if (source.kind === 'feishu' && command === 'opdev') {
    return {
      commandName: 'opdev',
      loginCommand: 'opdev whoami',
      statusCommand: 'opdev whoami',
      permissionCommand: '',
    }
  }
  return {
    commandName: command || String(source.commandCandidates?.[0] || ''),
    loginCommand: source.loginCommand || '',
    statusCommand: source.statusCommand || '',
    permissionCommand: source.permissionCommand || '',
  }
}

module.exports = {
  classifyLoginState,
  classifyPermissionState,
  commandBaseName,
  parseProbeJson,
  pathDetails,
  pathExists,
  probeArgsFor,
  reportedProbeErrorCode,
  resolveCommandPath,
  runProbe,
  runtimeOptions,
  sourceCommandDetails,
  stableProbeErrorCode,
}
