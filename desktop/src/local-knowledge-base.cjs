const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { prepareCommand, searchPath } = require('./cli-adapters.cjs')

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

const KNOWLEDGE_BASE_SOURCES = Object.freeze([
  {
    kind: 'feishu',
    label: '飞书文档',
    badge: '飞书',
    type: 'cloud',
    accessMode: 'cli',
    commandCandidates: ['lark-cli', 'opdev'],
    installUrl: 'https://open.feishu.cn/document/no_class/mcp-archive/feishu-cli-installation-guide',
    loginUrl: 'https://open.feishu.cn/document/mcp_open_tools/feishu-cli-let-ai-actually-do-your-work-in-feishu',
    permissionUrl: 'https://open.feishu.cn/document/mcp_open_tools/feishu-cli-let-ai-actually-do-your-work-in-feishu',
    installCommand: 'npm install -g @larksuite/cli@latest',
    loginCommand: 'lark-cli auth login',
    statusCommand: 'lark-cli auth status',
    permissionCommand: 'lark-cli docs +search --query . --page-size 1 --as user',
    fallbackLoginCommand: 'opdev whoami',
  },
  {
    kind: 'dingtalk',
    label: '钉钉文档',
    badge: '钉',
    type: 'cloud',
    accessMode: 'cli',
    commandCandidates: ['dws'],
    installUrl: 'https://open.dingtalk.com/document/development/dingtalk-cli-performing-tasks-within',
    loginUrl: 'https://open.dingtalk.com/document/development/dingtalk-cli-performing-tasks-within',
    permissionUrl: 'https://open.dingtalk.com/document/development/dingtalk-cli-performing-tasks-within',
    installCommand: 'npm install -g dingtalk-workspace-cli --registry=https://registry.npmmirror.com',
    loginCommand: 'dws auth login',
    statusCommand: 'dws auth status',
    permissionCommand: 'dws doc list --page-size 1',
  },
  {
    kind: 'obsidian',
    label: 'Obsidian',
    badge: 'OB',
    type: 'local',
    accessMode: 'vault',
    commandCandidates: ['obsidian'],
    appCandidates: [
      '/Applications/Obsidian.app',
      path.join(os.homedir(), 'Applications', 'Obsidian.app'),
      path.win32.join('C:\\', 'Program Files', 'Obsidian', 'Obsidian.exe'),
      path.win32.join('C:\\', 'Program Files (x86)', 'Obsidian', 'Obsidian.exe'),
    ],
    installUrl: 'https://obsidian.md/download',
    loginUrl: 'https://obsidian.md/help/install',
    permissionUrl: 'https://obsidian.md/help/install',
    installCommand: '',
    loginCommand: '',
    statusCommand: '',
    permissionCommand: '',
  },
  {
    kind: 'notion',
    label: 'Notion',
    badge: 'N',
    type: 'remote',
    accessMode: 'oauth',
    installUrl: 'https://developers.notion.com/docs/create-a-notion-integration',
    loginUrl: 'https://developers.notion.com/',
    permissionUrl: 'https://developers.notion.com/docs/create-a-notion-integration',
  },
  {
    kind: 'confluence',
    label: 'Confluence',
    badge: 'CF',
    type: 'remote',
    accessMode: 'oauth',
    installUrl: 'https://developer.atlassian.com/cloud/confluence/rest/',
    loginUrl: 'https://developer.atlassian.com/cloud/confluence/rest/',
    permissionUrl: 'https://developer.atlassian.com/cloud/confluence/rest/',
  },
  {
    kind: 'googledrive',
    label: 'Google Drive',
    badge: 'GD',
    type: 'remote',
    accessMode: 'oauth',
    installUrl: 'https://developers.google.com/workspace/drive/api',
    loginUrl: 'https://developers.google.com/workspace/drive/api',
    permissionUrl: 'https://developers.google.com/workspace/drive/api',
  },
  {
    kind: 'sharepoint',
    label: 'SharePoint',
    badge: 'SP',
    type: 'remote',
    accessMode: 'oauth',
    installUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/sharepoint?view=graph-rest-1.0',
    loginUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/sharepoint?view=graph-rest-1.0',
    permissionUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/sharepoint?view=graph-rest-1.0',
  },
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

async function probeCloudSource(source, options = {}) {
  const commandPath = await resolveCommandPath(source.commandCandidates, options)
  if (!commandPath) {
    return {
      kind: source.kind,
      label: source.label,
      badge: source.badge,
      type: source.type,
      installed: false,
      configured: false,
      connected: false,
      loginState: 'missing',
      permissionState: 'unknown',
      readable: false,
      writable: false,
      probeState: 'ready',
      errorCode: '',
    }
  }
  const primaryProbe = await runProbe(commandPath, probeArgsFor(source, commandPath, 'login', options), options)
  const primaryOutput = String(primaryProbe.stdout || '')
  const primaryJson = parseProbeJson(primaryOutput)
  const loginState = source.kind === 'feishu'
    && commandBaseName(commandPath, options) === 'lark-cli'
    && primaryJson?.identities?.user?.status === 'missing'
    ? 'missing'
    : classifyLoginState(primaryOutput, primaryProbe.code, primaryProbe.stderr)
  const primaryProbeErrorCode = primaryProbe.errorCode || reportedProbeErrorCode(primaryOutput)
  const primaryErrorCode = primaryProbeErrorCode && loginState !== 'missing'
    ? primaryProbeErrorCode
    : ''
  let permissionState = 'unknown'
  let permissionProbe = null
  const permissionArgs = probeArgsFor(source, commandPath, 'permission', options)
  if (loginState === 'ready' && permissionArgs.length) {
    permissionProbe = await runProbe(commandPath, permissionArgs, options)
    permissionState = classifyPermissionState(
      permissionProbe.stdout,
      permissionProbe.code,
      loginState,
      permissionProbe.stderr,
    )
  }
  const permissionProbeErrorCode = permissionProbe
    ? permissionProbe.errorCode || reportedProbeErrorCode(permissionProbe.stdout)
    : ''
  const permissionErrorCode = permissionProbeErrorCode && permissionState !== 'needs-grant'
    ? permissionProbeErrorCode
    : ''
  const probeState = primaryErrorCode || permissionErrorCode ? 'error' : 'ready'
  const configured = loginState === 'ready'
  const connected = configured && probeState === 'ready'
  const readable = connected && permissionState === 'ready'
  return {
    kind: source.kind,
    label: source.label,
    badge: source.badge,
      type: source.type,
    installed: true,
    configured,
    connected,
    loginState,
    permissionState,
    readable,
    writable: false,
    ...sourceCommandDetails(source, commandPath, options),
    probeState,
    errorCode: primaryErrorCode || permissionErrorCode,
  }
}

async function probeObsidianSource(source, options = {}) {
  const commandPath = await resolveCommandPath(source.commandCandidates, options)
  const versionProbe = commandPath
    ? await runProbe(commandPath, probeArgsFor(source, commandPath, 'version', options), options)
    : null
  let appPath = ''
  if (!commandPath || !versionProbe?.ok) {
    const { platform, home, pathApi } = runtimeOptions(options)
    const appCandidates = platform === 'darwin'
      ? [
          '/Applications/Obsidian.app',
          pathApi.join(home, 'Applications', 'Obsidian.app'),
        ]
      : platform === 'win32'
        ? [
            path.win32.join('C:\\', 'Program Files', 'Obsidian', 'Obsidian.exe'),
            path.win32.join('C:\\', 'Program Files (x86)', 'Obsidian', 'Obsidian.exe'),
          ]
        : []
    for (const candidate of appCandidates) {
      if (await pathExists(candidate, options)) {
        appPath = candidate
        break
      }
    }
  }
  const installed = Boolean(appPath || (commandPath && versionProbe?.ok))
  const probeErrorCode = versionProbe?.errorCode && !appPath ? versionProbe.errorCode : ''
  return {
    kind: source.kind,
    label: source.label,
    badge: source.badge,
    type: source.type,
    installed,
    loginState: 'ready',
    permissionState: 'ready',
    commandName: commandPath ? commandBaseName(commandPath, options) : 'Obsidian app',
    probeState: probeErrorCode ? 'error' : 'ready',
    errorCode: probeErrorCode,
  }
}

async function probeRemoteSource(source, options = {}) {
  const storeState = options.store?.state?.() || {}
  const remoteState = storeState.knowledgeBases?.[source.kind] || {}
  const configured = Boolean(remoteState.configured || remoteState.connected)
  return {
    kind: source.kind,
    label: source.label,
    badge: source.badge,
    type: source.type,
    accessMode: source.accessMode,
    installed: configured,
    configured,
    connected: Boolean(remoteState.connected || remoteState.ready || configured),
    authState: configured ? (remoteState.authState || 'ready') : 'missing',
    permissionState: configured ? (remoteState.permissionState || 'ready') : 'unknown',
    readable: Boolean(remoteState.readable ?? configured),
    writable: Boolean(remoteState.writable ?? configured),
    vaultPath: String(remoteState.vaultPath || ''),
    probeState: 'ready',
    errorCode: '',
  }
}

async function resolveKnowledgeBaseSources(options = {}) {
  const storeState = options.store?.state?.() || { obsidianVaultPath: '' }
  const sources = []
  const targetKind = String(options.kind || '').trim()
  const catalog = targetKind
    ? KNOWLEDGE_BASE_SOURCES.filter(source => source.kind === targetKind)
    : KNOWLEDGE_BASE_SOURCES
  for (const source of catalog) {
    let resolved
    try {
      resolved = source.accessMode === 'vault'
        ? await probeObsidianSource(source, options)
        : source.accessMode === 'cli'
          ? await probeCloudSource(source, options)
          : await probeRemoteSource(source, options)
    } catch (error) {
      resolved = {
        kind: source.kind,
        label: source.label,
        badge: source.badge,
        type: source.type,
        accessMode: source.accessMode,
        installed: false,
        configured: false,
        connected: false,
        loginState: 'unknown',
        permissionState: 'unknown',
        readable: false,
        writable: false,
        probeState: 'error',
        errorCode: stableProbeErrorCode(error),
      }
    }
    const vaultPath = source.kind === 'obsidian' ? String(storeState.obsidianVaultPath || '') : ''
    const vaultDetails = source.kind === 'obsidian'
      ? await pathDetails(vaultPath, options)
      : null
    const probeReady = resolved.probeState === 'ready'
    const configured = source.accessMode === 'vault'
      ? Boolean(resolved.installed && vaultPath && vaultDetails?.directory)
      : Boolean(resolved.configured)
    const connected = source.accessMode === 'vault'
      ? Boolean(configured && probeReady)
      : Boolean(resolved.connected)
    const readable = source.accessMode === 'vault'
      ? Boolean(connected && vaultDetails?.readable)
      : Boolean(resolved.readable)
    const writable = source.accessMode === 'vault'
      ? Boolean(connected && vaultDetails?.writable)
      : Boolean(resolved.writable)
    const ready = probeReady && (source.accessMode === 'vault'
      ? Boolean(readable && writable)
      : source.accessMode === 'cli'
        ? Boolean(resolved.installed && resolved.loginState === 'ready' && resolved.permissionState === 'ready')
        : Boolean(resolved.configured && resolved.authState === 'ready' && resolved.permissionState === 'ready'))
    sources.push({
      kind: source.kind,
      label: source.label,
      badge: source.badge,
      type: source.type,
      accessMode: source.accessMode,
      installCommand: source.installCommand || '',
      loginCommand: resolved.loginCommand || source.loginCommand || '',
      statusCommand: resolved.statusCommand || source.statusCommand || '',
      permissionCommand: resolved.permissionCommand || source.permissionCommand || '',
      commandName: resolved.commandName || '',
      installed: Boolean(resolved.installed),
      configured,
      connected,
      loginState: resolved.loginState || 'unknown',
      permissionState: resolved.permissionState || 'unknown',
      authState: resolved.authState || 'unknown',
      readable,
      writable,
      probeState: resolved.probeState || 'ready',
      errorCode: resolved.errorCode || '',
      vaultPath,
      vaultDetails,
      ready,
    })
  }
  return sources
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
  knowledgeBaseGuideUrl,
  resolveKnowledgeBaseSources,
  resolveCommandPath,
}
