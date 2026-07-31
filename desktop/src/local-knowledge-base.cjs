const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { prepareCommand, searchPath } = require('./cli-adapters.cjs')

const execFileAsync = promisify(execFile)
const EXEC_TIMEOUT_MS = 4500

const KNOWLEDGE_BASE_SOURCES = Object.freeze([
  {
    kind: 'feishu',
    label: '飞书文档',
    badge: '飞书',
    type: 'cloud',
    commandCandidates: ['lark-cli', 'opdev'],
    installUrl: 'https://open.feishu.cn/document/no_class/mcp-archive/feishu-cli-installation-guide',
    loginUrl: 'https://open.feishu.cn/document/mcp_open_tools/feishu-cli-let-ai-actually-do-your-work-in-feishu',
    permissionUrl: 'https://open.feishu.cn/document/mcp_open_tools/feishu-cli-let-ai-actually-do-your-work-in-feishu',
    installCommand: 'npm install -g @lark-opdev/cli@latest -f',
    loginCommand: 'lark-cli auth login',
    statusCommand: 'lark-cli auth status',
    permissionCommand: 'lark-cli auth check',
    fallbackLoginCommand: 'opdev whoami',
  },
  {
    kind: 'dingtalk',
    label: '钉钉文档',
    badge: '钉',
    type: 'cloud',
    commandCandidates: ['dws'],
    installUrl: 'https://open.dingtalk.com/document/development/dingtalk-cli-performing-tasks-within',
    loginUrl: 'https://open.dingtalk.com/document/development/dingtalk-cli-performing-tasks-within',
    permissionUrl: 'https://open.dingtalk.com/document/development/dingtalk-cli-performing-tasks-within',
    installCommand: 'npm install -g dingtalk-workspace-cli --registry=https://registry.npmmirror.com',
    loginCommand: 'dws auth login',
    statusCommand: 'dws auth status',
    permissionCommand: 'dws auth status',
  },
  {
    kind: 'obsidian',
    label: 'Obsidian',
    badge: 'OB',
    type: 'local',
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
])

function runtimeOptions(options = {}) {
  const platform = options.platform || process.platform
  return {
    platform,
    env: options.env || process.env,
    home: options.home || os.homedir(),
    accessFn: options.accessFn || fs.promises.access,
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

async function pathExists(filename, options = {}) {
  if (!filename) return false
  try {
    await (options.accessFn || fs.promises.access)(filename, fs.constants.F_OK)
    return true
  } catch {
    return false
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
  const { platform, env, pathApi } = runtimeOptions(options)
  const prepared = prepareCommand(command, args, { platform })
  const childEnv = {
    ...env,
    PATH: searchPath(options),
  }
  if (platform === 'win32') childEnv.USERPROFILE ||= os.homedir()
  else childEnv.HOME ||= os.homedir()
  try {
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
      command: prepared.command,
      args: prepared.args,
      ok: false,
      code: Number.isInteger(error?.code) ? error.code : -1,
      stdout: String(error?.stdout || ''),
      stderr: String(error?.stderr || ''),
      message: String(error?.message || ''),
      pathApi,
    }
  }
}

function combinedProbeText(probe) {
  return `${String(probe?.stdout || '')}\n${String(probe?.stderr || '')}`.trim()
}

function classifyLoginState(output, code) {
  const text = String(output || '').toLowerCase()
  if (!text && code === 0) return 'ready'
  if (/not\s+logged\s+in|未登录|please\s+login|need\s+login|登录失败|登录过期|auth\s+required|unauthorized|forbidden|\b401\b|\b403\b/.test(text)) {
    return 'missing'
  }
  if (/logged\s+in|login\s+success|已登录|authenticated|whoami|当前用户|当前账号|current\s+account|current\s+user/.test(text)) {
    return 'ready'
  }
  return code === 0 ? 'ready' : 'unknown'
}

function classifyPermissionState(output, code, loginState) {
  if (loginState === 'missing') return 'unknown'
  const text = String(output || '').toLowerCase()
  if (!text && code === 0) return 'ready'
  if (/permission.*(missing|required|needed|denied)|scope.*(missing|required|denied)|权限.*(缺失|不足|未授予|需要)|授权失败|需要授权|access\s+denied/.test(text)) {
    return 'needs-grant'
  }
  if (/permission.*(granted|ready|available)|scope.*(granted)|权限.*(已授予|已开启|已配置)/.test(text)) {
    return 'ready'
  }
  return code === 0 ? 'ready' : 'unknown'
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
    return probe === 'login' ? ['auth', 'status'] : ['auth', 'check']
  }
  if (source.kind === 'dingtalk') return ['auth', 'status']
  return []
}

async function probeCloudSource(source, options = {}) {
  const commandPath = await resolveCommandPath(source.commandCandidates, options)
  if (!commandPath) {
    return {
      kind: source.kind,
      label: source.label,
      badge: source.badge,
      type: source.type,
      commandPath: '',
      installed: false,
      loginState: 'missing',
      permissionState: 'unknown',
    }
  }
  const primaryProbe = await runProbe(commandPath, probeArgsFor(source, commandPath, 'login', options), options)
  const loginState = classifyLoginState(combinedProbeText(primaryProbe), primaryProbe.code)
  let permissionState = loginState === 'ready' ? 'ready' : 'unknown'
  const permissionArgs = probeArgsFor(source, commandPath, 'permission', options)
  if (loginState === 'ready' && permissionArgs.length) {
    const permissionProbe = await runProbe(commandPath, permissionArgs, options)
    permissionState = classifyPermissionState(
      combinedProbeText(permissionProbe),
      permissionProbe.code,
      loginState,
    )
  }
  return {
    kind: source.kind,
    label: source.label,
    badge: source.badge,
    type: source.type,
    commandPath,
    installed: true,
    loginState,
    permissionState,
  }
}

async function probeObsidianSource(source, options = {}) {
  const commandPath = await resolveCommandPath(source.commandCandidates, options)
  let appPath = ''
  if (!commandPath) {
    for (const candidate of source.appCandidates || []) {
      if (await pathExists(candidate, options)) {
        appPath = candidate
        break
      }
    }
  }
  return {
    kind: source.kind,
    label: source.label,
    badge: source.badge,
    type: source.type,
    commandPath: commandPath || appPath,
    installed: Boolean(commandPath || appPath),
    loginState: 'ready',
    permissionState: 'ready',
  }
}

async function resolveKnowledgeBaseSources(options = {}) {
  const storeState = options.store?.state?.() || { obsidianVaultPath: '' }
  const sources = []
  for (const source of KNOWLEDGE_BASE_SOURCES) {
    const resolved = source.kind === 'obsidian'
      ? await probeObsidianSource(source, options)
      : await probeCloudSource(source, options)
    sources.push({
      ...source,
      ...resolved,
      vaultPath: source.kind === 'obsidian' ? String(storeState.obsidianVaultPath || '') : '',
      ready: source.kind === 'obsidian'
        ? Boolean(resolved.installed && storeState.obsidianVaultPath)
        : Boolean(resolved.installed && resolved.loginState === 'ready' && resolved.permissionState !== 'needs-grant'),
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
