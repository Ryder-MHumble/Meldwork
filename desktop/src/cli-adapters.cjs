const { execFile, spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { promisify } = require('node:util')

const execFileAsync = promisify(execFile)
const AGENT_PROFILES = {
  codex: { label: 'Codex', commands: ['codex'] },
  hermes: { label: 'Hermes', commands: ['hermes'] },
  openclaw: { label: 'OpenClaw', commands: ['openclaw'] },
  workbuddy: {
    label: 'WorkBuddy',
    commands: ['codebuddy'],
  },
  kimi: { label: 'Kimi', commands: ['kimi'] },
  claude: { label: 'Claude', commands: ['claude'] },
  qwen: { label: 'Qwen', commands: ['qwen'] },
  gemini: { label: 'Gemini', commands: ['gemini'] },
  opencode: { label: 'OpenCode', commands: ['opencode'] },
}
const ALLOWED_KINDS = Object.keys(AGENT_PROFILES)
const CODEX_SANDBOXES = new Set(['read-only', 'workspace-write'])
const TERMINATE_GRACE_MS = 500
const KILL_SETTLE_MS = 500
const DEFAULT_WINDOWS_PATHEXT = ['.COM', '.EXE', '.BAT', '.CMD']
const VERSION_LINE = /\bv?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?\b/
const SYSTEM_CHILD_ENV_KEYS = Object.freeze([
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
const OPENCODE_READ_ONLY_PERMISSION = JSON.stringify({
  '*': 'deny',
  read: 'allow',
  glob: 'allow',
  grep: 'allow',
  list: 'allow',
  webfetch: 'allow',
  websearch: 'allow',
})

function envValue(env, name) {
  const match = Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase())
  return match ? env[match] : ''
}

function systemChildEnvironment(sourceEnv = process.env, platform = process.platform) {
  const env = {}
  for (const name of SYSTEM_CHILD_ENV_KEYS) {
    const value = envValue(sourceEnv, name)
    if (typeof value === 'string' && value) env[name] = value
  }
  if (platform === 'win32') env.USERPROFILE ||= os.homedir()
  else env.HOME ||= os.homedir()
  return env
}

function runtimeOptions(options = {}) {
  const platform = options.platform || process.platform
  return {
    platform,
    env: options.env ?? process.env,
    home: options.home || os.homedir(),
    pathApi: platform === 'win32' ? path.win32 : path.posix,
    accessFn: options.accessFn || fs.promises.access,
    execFileFn: options.execFileFn || execFileAsync,
  }
}

function uniquePaths(values, platform) {
  const seen = new Set()
  return values.filter(Boolean).filter((value) => {
    const key = platform === 'win32' ? value.toLowerCase() : value
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function versionManagerBins(root, suffix, options = {}) {
  if (!root) return []
  const { pathApi } = runtimeOptions(options)
  const readdirFn = options.readdirFn || fs.readdirSync
  let entries
  try {
    entries = readdirFn(root, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter(entry => entry?.name
      && (typeof entry.isDirectory !== 'function'
        || entry.isDirectory()
        || entry.isSymbolicLink?.()))
    .map(entry => entry.name)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
    .map(name => pathApi.join(root, name, ...suffix))
}

function searchDirectories(options = {}) {
  const { platform, env, home, pathApi } = runtimeOptions(options)
  const configured = String(envValue(env, 'PATH') || '').split(pathApi.delimiter)
  const pnpmHome = envValue(env, 'PNPM_HOME')
  if (platform !== 'win32') {
    const fnmMultishellPath = envValue(env, 'FNM_MULTISHELL_PATH')
    const fnmDataRoots = [
      pathApi.join(home, '.local', 'share', 'fnm', 'node-versions'),
      platform === 'darwin'
        ? pathApi.join(home, 'Library', 'Application Support', 'fnm', 'node-versions')
        : '',
    ]
    return uniquePaths([
      ...configured,
      pnpmHome,
      envValue(env, 'NVM_BIN'),
      envValue(env, 'BUN_INSTALL') && pathApi.join(envValue(env, 'BUN_INSTALL'), 'bin'),
      envValue(env, 'ASDF_DATA_DIR') && pathApi.join(envValue(env, 'ASDF_DATA_DIR'), 'shims'),
      envValue(env, 'MISE_DATA_DIR') && pathApi.join(envValue(env, 'MISE_DATA_DIR'), 'shims'),
      envValue(env, 'NODENV_ROOT') && pathApi.join(envValue(env, 'NODENV_ROOT'), 'shims'),
      fnmMultishellPath && pathApi.join(fnmMultishellPath, 'bin'),
      pathApi.join(home, '.volta', 'bin'),
      platform === 'darwin' && pathApi.join(home, 'Library', 'pnpm'),
      pathApi.join(home, '.local', 'share', 'pnpm'),
      pathApi.join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
      ...fnmDataRoots.flatMap(root => versionManagerBins(root, ['installation', 'bin'], options)),
      pathApi.join(home, '.nvm', 'current', 'bin'),
      ...versionManagerBins(pathApi.join(home, '.nvm', 'versions', 'node'), ['bin'], options),
      pathApi.join(home, '.asdf', 'shims'),
      pathApi.join(home, '.local', 'share', 'mise', 'shims'),
      pathApi.join(home, '.nodenv', 'shims'),
      pathApi.join(home, '.bun', 'bin'),
      pathApi.join(home, '.local', 'bin'),
      pathApi.join(home, '.local', 'opt', 'npm-global', 'bin'),
      pathApi.join(home, '.npm-global', 'bin'),
      pathApi.join(home, '.kimi-code', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
    ], platform)
  }

  const appData = envValue(env, 'APPDATA')
  const localAppData = envValue(env, 'LOCALAPPDATA')
  const programFiles = envValue(env, 'ProgramFiles')
  const programFilesX86 = envValue(env, 'ProgramFiles(x86)')
  const programData = envValue(env, 'ProgramData')
  const chocolatey = envValue(env, 'ChocolateyInstall')
  const scoop = envValue(env, 'SCOOP')
  const nvmHome = envValue(env, 'NVM_HOME')
  const nvmSymlink = envValue(env, 'NVM_SYMLINK')
  const workBuddyCli = base => base && pathApi.join(
    base, 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'bin',
  )
  return uniquePaths([
    ...configured,
    pathApi.join(home, '.local', 'bin'),
    pathApi.join(home, '.local', 'opt', 'npm-global', 'bin'),
    pathApi.join(home, '.npm-global', 'bin'),
    pathApi.join(home, '.kimi-code', 'bin'),
    pnpmHome,
    appData && pathApi.join(appData, 'npm'),
    localAppData && pathApi.join(localAppData, 'npm'),
    localAppData && pathApi.join(localAppData, 'pnpm'),
    localAppData && pathApi.join(localAppData, 'Programs', 'nodejs'),
    localAppData && pathApi.join(localAppData, 'Microsoft', 'WindowsApps'),
    localAppData && workBuddyCli(pathApi.join(localAppData, 'Programs')),
    nvmSymlink,
    nvmHome,
    programFiles && pathApi.join(programFiles, 'nodejs'),
    programFiles && workBuddyCli(programFiles),
    programFilesX86 && pathApi.join(programFilesX86, 'nodejs'),
    programFilesX86 && workBuddyCli(programFilesX86),
    chocolatey && pathApi.join(chocolatey, 'bin'),
    programData && pathApi.join(programData, 'chocolatey', 'bin'),
    scoop && pathApi.join(scoop, 'shims'),
    pathApi.join(home, 'scoop', 'shims'),
  ], platform)
}

function searchPath(options = {}) {
  const { pathApi } = runtimeOptions(options)
  return searchDirectories(options).join(pathApi.delimiter)
}

function agentCommands(kind, options = {}) {
  const { platform, home, pathApi } = runtimeOptions(options)
  const commands = [...AGENT_PROFILES[kind].commands]
  if (kind === 'workbuddy' && platform === 'darwin') {
    commands.push('/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy')
    commands.push(pathApi.join(
      home, 'Applications', 'WorkBuddy.app', 'Contents', 'Resources',
      'app.asar.unpacked', 'cli', 'bin', 'codebuddy',
    ))
  }
  return commands
}

function executableExtensions(options = {}) {
  const { platform, env } = runtimeOptions(options)
  if (platform !== 'win32') return ['']
  const configured = String(envValue(env, 'PATHEXT') || '')
    .split(';')
    .map(extension => extension.trim())
    .filter(Boolean)
    .map(extension => extension.startsWith('.') ? extension : `.${extension}`)
  return ['', ...(configured.length ? configured : DEFAULT_WINDOWS_PATHEXT)]
}

function executableCandidates(command, options = {}) {
  const { platform, pathApi } = runtimeOptions(options)
  const names = platform === 'win32' && !pathApi.extname(command)
    ? executableExtensions(options).map(extension => `${command}${extension}`)
    : [command]
  if (pathApi.isAbsolute(command)) return names
  return searchDirectories(options).flatMap(directory => names.map(name => pathApi.join(directory, name)))
}

async function resolveExecutable(kind, options = {}) {
  if (!ALLOWED_KINDS.includes(kind)) return null
  const runtime = runtimeOptions(options)
  const { platform, env, pathApi, accessFn, execFileFn } = runtime
  const commands = agentCommands(kind, options)
  const lookupEnv = {
    ...systemChildEnvironment(env, platform),
    PATH: searchPath(options),
  }
  for (const command of commands) {
    for (const candidate of executableCandidates(command, options)) {
      try {
        await accessFn(candidate, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK)
        return candidate
      } catch { /* keep searching */ }
    }
  }
  for (const command of commands.filter(candidate => !pathApi.isAbsolute(candidate))) {
    try {
      const lookupCommand = platform === 'win32'
        ? 'where.exe'
        : (platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
      const lookupArgs = platform === 'win32' ? [command] : ['-lc', `command -v -- ${command}`]
      const { stdout } = await execFileFn(lookupCommand, lookupArgs, {
        timeout: 5000,
        windowsHide: true,
        env: lookupEnv,
      })
      for (const line of String(stdout || '').split(/\r?\n/)) {
        const candidate = line.trim().replace(/^"|"$/g, '')
        if (!candidate || !pathApi.isAbsolute(candidate)) continue
        try {
          await accessFn(candidate, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK)
          return candidate
        } catch { /* keep checking lookup results */ }
      }
    } catch { /* keep searching */ }
  }
  return null
}

function npmShimTarget(executable, options = {}) {
  const readFileFn = options.readFileFn || (filename => fs.readFileSync(filename, 'utf8'))
  let source
  try {
    source = String(readFileFn(executable))
  } catch {
    return ''
  }
  const matches = [...source.matchAll(/"([^"\r\n]+)"\s+%\*/gi)]
  for (const match of matches.reverse()) {
    const token = match[1]
    if (!/^%(?:dp0%|~dp0)[\\/]/i.test(token)) continue
    const relative = token.replace(/^%(?:dp0%|~dp0)[\\/]+/i, '')
    const shimDirectory = path.win32.dirname(executable)
    const target = path.win32.resolve(shimDirectory, relative)
    const nestedPath = path.win32.relative(shimDirectory, target)
    const remainsBeneathShim = nestedPath
      && !path.win32.isAbsolute(nestedPath)
      && nestedPath !== '..'
      && !nestedPath.startsWith(`..${path.win32.sep}`)
    const isNodeModuleBin = nestedPath.split(/[\\/]+/)
      .some(segment => segment.toLowerCase() === 'node_modules')
    const extension = path.win32.extname(relative).toLowerCase()
    const supportedTarget = !extension
      || ['.cjs', '.mjs', '.js', '.com', '.exe'].includes(extension)
    if (remainsBeneathShim && isNodeModuleBin && supportedTarget) return target
  }
  return ''
}

function prepareCommand(command, args, options = {}) {
  const { platform } = runtimeOptions(options)
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(command)) return { command, args }
  const target = npmShimTarget(command, options)
  if (!target) {
    throw new Error('LOCAL_CLI_WRAPPER_UNSUPPORTED')
  }
  const existsFn = options.existsFn || fs.existsSync
  if (/\.(?:com|exe)$/i.test(target)) {
    if (!existsFn(target)) {
      throw new Error('LOCAL_CLI_WRAPPER_UNSUPPORTED')
    }
    return { command: target, args }
  }
  const bundledNode = path.win32.join(path.win32.dirname(command), 'node.exe')
  return {
    command: existsFn(bundledNode) ? bundledNode : 'node.exe',
    args: [target, ...args],
  }
}

async function detectAgents(options = {}) {
  const runtime = runtimeOptions(options)
  const { env, execFileFn, platform } = runtime
  const resolveExecutableFn = options.resolveExecutableFn
    || (kind => resolveExecutable(kind, options))
  const prepareCommandFn = options.prepareCommandFn || prepareCommand
  const childEnv = {
    ...systemChildEnvironment(env, platform),
    PATH: searchPath(options),
  }
  const found = []
  for (const kind of ALLOWED_KINDS) {
    const executable = await resolveExecutableFn(kind)
    if (!executable) continue
    let version = ''
    try {
      const versionCommand = prepareCommandFn(executable, ['--version'], options)
      const result = await execFileFn(versionCommand.command, versionCommand.args, {
        timeout: 8000,
        windowsHide: true,
        env: childEnv,
      })
      const lines = [result.stdout, result.stderr]
        .flatMap(output => String(output || '').split(/\r?\n/))
        .map(line => line.trim())
        .filter(Boolean)
      version = lines.find(line => VERSION_LINE.test(line)) || ''
    } catch { /* a broken shim is not a usable CLI */ }
    if (!version) continue
    found.push({
      kind,
      name: `${AGENT_PROFILES[kind].label} CLI`,
      executable,
      version,
    })
  }
  return found
}

function codexSandbox(requested) {
  if (requested != null) {
    if (!CODEX_SANDBOXES.has(requested)) throw new Error('CODEX_SANDBOX_UNSUPPORTED')
    return requested
  }
  const configured = process.env.ROUNDRELAY_CODEX_SANDBOX || 'read-only'
  return CODEX_SANDBOXES.has(configured) ? configured : 'read-only'
}

function invocation(kind, executable, workdir, sessionRef = '', options = {}) {
  if (kind === 'codex') {
    const sandbox = codexSandbox(options.sandbox)
    if (sessionRef) {
      return {
        command: executable,
        args: [
          'exec', 'resume', '--json', '--skip-git-repo-check',
          '-c', `sandbox_mode="${sandbox}"`, sessionRef, '-',
        ],
        stdin: true,
      }
    }
    return {
      command: executable,
      args: ['exec', '--json', '--skip-git-repo-check', '--sandbox',
        sandbox, '-C', workdir, '-'],
      stdin: true,
    }
  }
  if (kind === 'hermes') {
    return {
      command: executable,
      args: [
        'chat',
        '--quiet',
        ...(options.provider?.id ? ['--provider', options.provider.id] : []),
        ...(options.provider?.model ? ['--model', options.provider.model] : []),
        ...(sessionRef ? ['--resume', sessionRef] : []),
        '--query',
      ],
      promptArg: true,
    }
  }
  if (kind === 'openclaw') {
    return {
      command: executable,
      args: [
        'agent', '--local', '--agent', 'main',
        ...(sessionRef ? ['--session-key', sessionRef] : []),
        '--message',
      ],
      suffixArgs: ['--json'],
      promptArg: true,
    }
  }
  if (kind === 'workbuddy') {
    return {
      command: executable,
      args: [
        '--print',
        '--output-format', 'json',
        '--permission-mode', options.sandbox === 'workspace-write' ? 'acceptEdits' : 'plan',
        '--max-turns', '20',
        ...(sessionRef ? ['--resume', sessionRef] : []),
      ],
      promptArg: true,
    }
  }
  if (kind === 'kimi') {
    return {
      command: executable,
      args: [
        '--output-format', 'stream-json',
        ...(options.sandbox === 'workspace-write' ? [] : ['--plan']),
        ...(sessionRef ? ['--session', sessionRef] : []),
        '--prompt',
      ],
      promptArg: true,
    }
  }
  if (kind === 'claude') {
    return {
      command: executable,
      args: [
        '--print',
        '--output-format', 'json',
        '--permission-mode', options.sandbox === 'workspace-write' ? 'acceptEdits' : 'plan',
        ...(sessionRef ? ['--resume', sessionRef] : []),
      ],
      promptArg: true,
    }
  }
  if (kind === 'qwen') {
    return {
      command: executable,
      args: [
        '--output-format', 'json',
        '--approval-mode', options.sandbox === 'workspace-write' ? 'auto-edit' : 'plan',
        ...(options.provider?.id === 'openai' ? ['--auth-type', 'openai'] : []),
        ...(options.provider?.model ? ['--model', options.provider.model] : []),
        ...(sessionRef ? ['--resume', sessionRef] : []),
      ],
      promptArg: true,
    }
  }
  if (kind === 'gemini') {
    return {
      command: executable,
      args: [
        '--output-format', 'stream-json',
        '--approval-mode', options.sandbox === 'workspace-write' ? 'auto_edit' : 'plan',
        ...(sessionRef ? ['--resume', sessionRef] : []),
        '--prompt',
      ],
      promptArg: true,
    }
  }
  if (kind === 'opencode') {
    return {
      command: executable,
      args: [
        'run', '--format', 'json',
        ...(options.sandbox === 'workspace-write' ? [] : ['--agent', 'plan']),
        ...(sessionRef ? ['--session', sessionRef] : []),
      ],
      promptArg: true,
    }
  }
  throw new Error('LOCAL_AGENT_KIND_UNSUPPORTED')
}

function parseCodexOutput(stdout) {
  let sessionRef = ''
  const texts = []
  for (const line of String(stdout || '').split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
        sessionRef = event.thread_id
      }
      if (event.type === 'item.completed' && event.item?.type === 'agent_message'
          && typeof event.item.text === 'string') {
        texts.push(event.item.text)
      }
    } catch { /* ignore non-JSON diagnostics */ }
  }
  return { text: texts.join('\n').trim(), sessionRef }
}

function normalizeOpenClawOutput(stdout) {
  const raw = String(stdout || '').trim()
  if (!raw) return ''
  try {
    const value = JSON.parse(raw)
    const texts = []
    const visit = (node) => {
      if (!node) return
      if (typeof node === 'string') texts.push(node)
      else if (Array.isArray(node)) node.forEach(visit)
      else if (typeof node === 'object') {
        if (typeof node.text === 'string') texts.push(node.text)
        else if (typeof node.content === 'string') texts.push(node.content)
        else for (const key of ['payloads', 'messages', 'result', 'response']) visit(node[key])
      }
    }
    visit(value)
    return texts.filter(Boolean).join('\n').trim() || raw
  } catch {
    return raw
  }
}

function parseResultOutput(stdout) {
  const raw = String(stdout || '').trim()
  if (!raw) return { text: '', sessionRef: '' }
  try {
    const value = JSON.parse(raw)
    const events = Array.isArray(value) ? value : [value]
    const result = events.findLast(event => event?.type === 'result')
    if (result && typeof result.result === 'string') {
      return {
        text: result.result.trim(),
        sessionRef: typeof result.session_id === 'string' ? result.session_id : '',
      }
    }
  } catch { /* fall back to raw output */ }
  return { text: raw, sessionRef: '' }
}

function parseWorkBuddyOutput(stdout) {
  return parseResultOutput(stdout)
}

function parseKimiOutput(stdout) {
  const raw = String(stdout || '').trim()
  if (!raw) return { text: '', sessionRef: '' }
  const texts = []
  let parsedLine = false
  let sessionRef = ''
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      parsedLine = true
      if (event?.role === 'assistant' && typeof event.content === 'string') {
        texts.push(event.content)
      }
      if (event?.type === 'session.resume_hint' && typeof event.session_id === 'string') {
        sessionRef = event.session_id
      }
    } catch { /* fall back to raw output when the CLI did not emit JSONL */ }
  }
  return {
    text: texts.join('\n').trim() || (parsedLine ? '' : raw),
    sessionRef,
  }
}

function parseGeminiOutput(stdout) {
  const raw = String(stdout || '').trim()
  if (!raw) return { text: '', sessionRef: '' }
  const texts = []
  let parsedLine = false
  let sessionRef = ''
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      parsedLine = true
      if (event?.type === 'init' && typeof event.session_id === 'string') {
        sessionRef = event.session_id
      }
      if (event?.type === 'message' && event.role === 'assistant'
          && typeof event.content === 'string') {
        texts.push(event.content)
      }
    } catch { /* fall back to raw output when the CLI did not emit JSONL */ }
  }
  return {
    text: texts.join('').trim() || (parsedLine ? '' : raw),
    sessionRef,
  }
}

function parseOpenCodeOutput(stdout) {
  const raw = String(stdout || '').trim()
  if (!raw) return { text: '', sessionRef: '' }
  const texts = []
  let parsedLine = false
  let sessionRef = ''
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      parsedLine = true
      if (typeof event?.sessionID === 'string') sessionRef = event.sessionID
      if (event?.type === 'text' && event.part?.type === 'text'
          && typeof event.part.text === 'string') {
        texts.push(event.part.text)
      }
    } catch { /* fall back to raw output when the CLI did not emit JSONL */ }
  }
  return {
    text: texts.join('\n').trim() || (parsedLine ? '' : raw),
    sessionRef,
  }
}

function structuredCliError(stdout) {
  try {
    const value = JSON.parse(String(stdout || '').trim())
    const events = Array.isArray(value) ? value : [value]
    const failed = events.findLast(event => event?.is_error || event?.subtype?.startsWith('error'))
    return String(failed?.error?.message || failed?.result || '').trim()
  } catch {
    return ''
  }
}

function hermesSessionRef(stderr) {
  const matches = [...String(stderr || '').matchAll(/\bsession_id:\s*([^\s]+)/gi)]
  return matches.at(-1)?.[1] || ''
}

function redactChildSecrets(value, env) {
  let result = String(value || '')
  for (const [name, secret] of Object.entries(env)) {
    if (!/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION)/i.test(name)
        || typeof secret !== 'string' || secret.length < 8) continue
    result = result.split(secret).join('[redacted]')
  }
  return result
}

function agentExecutionError(code, diagnostic = '') {
  const error = new Error(code)
  const detail = String(diagnostic || '').trim()
  if (detail) {
    Object.defineProperty(error, 'diagnostic', {
      value: detail,
      enumerable: false,
    })
  }
  return error
}

function authConfigurationFailure(detail) {
  return /api[ _-]?key|access[ _-]?token|refresh[ _-]?token|auth[ _-]?token|credential|auth(?:entication|orization)?|log(?:ged)?[ -]?in|sign(?:ed)?[ -]?in|unauthorized|forbidden|\b(?:401|403)\b|select an auth type|(?:provider|model).{0,80}(?:reject|configur|missing|invalid)|(?:reject|configur|missing|invalid).{0,80}(?:provider|model)|令牌|凭据|登录|认证|鉴权|(?:提供商|供应商|模型).{0,40}(?:配置|拒绝|缺失|无效)|(?:配置|拒绝|缺失|无效).{0,40}(?:提供商|供应商|模型)/i
    .test(String(detail || ''))
}

function failedAgentProcessError(detail) {
  if (!detail) return agentExecutionError('LOCAL_AGENT_EXITED')
  return agentExecutionError(
    authConfigurationFailure(detail)
      ? 'LOCAL_AGENT_AUTH_REQUIRED'
      : 'LOCAL_AGENT_PROCESS_FAILED',
    detail,
  )
}

function normalizeOutput(kind, stdout, sessionRef = '') {
  if (kind === 'codex') {
    const parsed = parseCodexOutput(stdout)
    return { text: parsed.text, sessionRef: parsed.sessionRef || sessionRef }
  }
  if (kind === 'openclaw') {
    return { text: normalizeOpenClawOutput(stdout), sessionRef }
  }
  if (kind === 'workbuddy') {
    const parsed = parseWorkBuddyOutput(stdout)
    return { text: parsed.text, sessionRef: parsed.sessionRef || sessionRef }
  }
  if (kind === 'kimi') {
    const parsed = parseKimiOutput(stdout)
    return { text: parsed.text, sessionRef: parsed.sessionRef || sessionRef }
  }
  if (kind === 'gemini') {
    const parsed = parseGeminiOutput(stdout)
    return { text: parsed.text, sessionRef: parsed.sessionRef || sessionRef }
  }
  if (kind === 'opencode') {
    const parsed = parseOpenCodeOutput(stdout)
    return { text: parsed.text, sessionRef: parsed.sessionRef || sessionRef }
  }
  if (['claude', 'qwen'].includes(kind)) {
    const parsed = parseResultOutput(stdout)
    return { text: parsed.text, sessionRef: parsed.sessionRef || sessionRef }
  }
  return { text: String(stdout || '').trim(), sessionRef }
}

async function runAgent(agent, prompt, workdir, options = {}) {
  if (options.signal?.aborted) throw new Error('LOCAL_AGENT_EXECUTION_STOPPED')
  const platform = options.platform || process.platform
  const spawnFn = options.spawnFn || spawn
  const sessionRef = String(options.sessionRef || '')
  const spec = invocation(agent.kind, agent.executable, workdir, sessionRef, {
    sandbox: options.sandbox,
    provider: options.provider,
  })
  const args = [...spec.args]
  if (spec.promptArg) args.push(prompt)
  if (spec.suffixArgs) args.push(...spec.suffixArgs)
  const prepared = prepareCommand(spec.command, args, { platform })
  const hermesSafetyEnv = agent.kind === 'hermes'
    ? { HERMES_EXEC_ASK: '1', HERMES_YOLO_MODE: '' }
    : {}
  const openCodeSafetyEnv = agent.kind === 'opencode'
      && options.sandbox !== 'workspace-write'
    ? { OPENCODE_PERMISSION: OPENCODE_READ_ONLY_PERMISSION }
    : {}
  const openClawWorkspaceEnv = agent.kind === 'openclaw'
    ? { OPENCLAW_WORKSPACE_DIR: path.resolve(workdir) }
    : {}
  const childEnv = {
    ...systemChildEnvironment(process.env, platform),
    ...options.env,
    ...hermesSafetyEnv,
    ...openCodeSafetyEnv,
    ...openClawWorkspaceEnv,
    PATH: searchPath({ platform }),
  }
  return await new Promise((resolve, reject) => {
    let child
    try {
      child = spawnFn(prepared.command, prepared.args, {
        cwd: workdir,
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: platform !== 'win32',
        windowsHide: true,
      })
    } catch (error) {
      reject(agentExecutionError(
        'LOCAL_AGENT_SPAWN_FAILED',
        redactChildSecrets(error?.message || error, childEnv),
      ))
      return
    }
    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    let stopRequested = false
    let timeout
    let forceKillTimeout
    let forceSettleTimeout
    const finish = (callback) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearTimeout(forceKillTimeout)
      clearTimeout(forceSettleTimeout)
      options.signal?.removeEventListener('abort', abort)
      callback()
    }
    const signalProcessTree = (signal) => {
      if (platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, signal)
          return
        } catch { /* fall back to the direct child */ }
      }
      try {
        child.kill(signal)
      } catch { /* the process has already exited */ }
    }
    const abort = () => {
      if (settled || stopRequested) return
      stopRequested = true
      if (platform === 'win32' && child.pid) {
        const killer = spawnFn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore', windowsHide: true,
        })
        killer.on('error', () => {})
        killer.unref()
        forceSettleTimeout = setTimeout(() => finish(() => {
          child.stdin.destroy()
          child.stdout.destroy()
          child.stderr.destroy()
          reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED'))
        }), KILL_SETTLE_MS)
        return
      }
      signalProcessTree('SIGTERM')
      forceKillTimeout = setTimeout(() => {
        if (settled) return
        signalProcessTree('SIGKILL')
        forceSettleTimeout = setTimeout(() => finish(() => {
          child.stdin.destroy()
          child.stdout.destroy()
          child.stderr.destroy()
          reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED'))
        }), KILL_SETTLE_MS)
      }, TERMINATE_GRACE_MS)
    }
    timeout = setTimeout(abort, 2 * 60 * 60 * 1000)
    if (options.signal?.aborted) abort()
    else options.signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length
      if (stdoutBytes <= 10 * 1024 * 1024) stdout.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length
      if (stderrBytes <= 1024 * 1024) stderr.push(chunk)
    })
    child.on('error', error => finish(() => reject(
      stopRequested
        ? agentExecutionError('LOCAL_AGENT_EXECUTION_STOPPED')
        : agentExecutionError(
            'LOCAL_AGENT_SPAWN_FAILED',
            redactChildSecrets(error?.message || error, childEnv),
          ),
    )))
    child.on('close', (code, signal) => finish(() => {
      if (stopRequested || options.signal?.aborted) {
        reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED'))
        return
      }
      if (code !== 0) {
        const rawStdout = Buffer.concat(stdout).toString('utf8')
        const rawStderr = Buffer.concat(stderr).toString('utf8').trim()
        const structuredDetail = structuredCliError(rawStdout)
        const detail = redactChildSecrets(
          [rawStderr, structuredDetail].filter(Boolean).join('\n'),
          childEnv,
        )
        reject(failedAgentProcessError(detail))
        return
      }
      const rawStderr = Buffer.concat(stderr).toString('utf8')
      const nextSessionRef = agent.kind === 'hermes'
        ? hermesSessionRef(rawStderr) || sessionRef
        : sessionRef
      const result = normalizeOutput(
        agent.kind,
        Buffer.concat(stdout).toString('utf8'),
        nextSessionRef,
      )
      const redactedText = redactChildSecrets(result.text, childEnv)
      const redactedSessionRef = redactChildSecrets(result.sessionRef, childEnv)
      if (!redactedText) {
        reject(new Error('LOCAL_AGENT_EMPTY_RESPONSE'))
        return
      }
      resolve({
        text: redactedText,
        sessionRef: redactedSessionRef.includes('[redacted]') ? '' : redactedSessionRef,
      })
    }))
    if (spec.stdin) child.stdin.end(prompt)
    else child.stdin.end()
  })
}

module.exports = {
  ALLOWED_KINDS,
  detectAgents,
  invocation,
  normalizeOutput,
  parseCodexOutput,
  parseGeminiOutput,
  parseKimiOutput,
  parseOpenCodeOutput,
  parseWorkBuddyOutput,
  prepareCommand,
  resolveExecutable,
  runAgent,
  searchPath,
}
