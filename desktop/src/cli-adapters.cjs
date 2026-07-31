const { execFile, spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Readable, Writable } = require('node:stream')
const { StringDecoder } = require('node:string_decoder')
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
  mimo: { label: 'MiMo', commands: ['mimo'] },
  claude: { label: 'Claude', commands: ['claude'] },
  gemini: { label: 'Gemini', commands: ['gemini'] },
  opencode: { label: 'OpenCode', commands: ['opencode'] },
  qwen: { label: 'Qwen', commands: ['qwen'] },
}
const ALLOWED_KINDS = Object.keys(AGENT_PROFILES)
const CODEX_SANDBOXES = new Set(['read-only', 'workspace-write'])
const IMAGE_ATTACHMENT_LIMITS = Object.freeze({
  codex: 4,
  hermes: 1,
  opencode: 4,
})
const MAX_NATIVE_SKILLS = 4
const NATIVE_SKILL_NAME = /^[\p{L}\p{N}._-]{1,100}$/u
const MAX_PROGRESS_STEPS = 8
const RUNTIME_EVENT_TYPES = new Set([
  'status',
  'answer_delta',
  'reasoning_summary',
  'plan',
  'tool_start',
  'tool_update',
  'tool_result_summary',
  'warning',
])
const RUNTIME_EVENT_STATUSES = new Set([
  'queued', 'running', 'waiting', 'completed', 'partial', 'failed', 'stopped', 'timeout',
])
const RUNTIME_EVENT_LIMITS = Object.freeze({
  id: 100,
  status: 24,
  title: 120,
  summary: 2000,
  detail: 4000,
  delta: 4000,
})
const TERMINATE_GRACE_MS = 500
const KILL_SETTLE_MS = 500
const ACP_CANCEL_GRACE_MS = 250
const ACP_MAX_LINE_BYTES = 1024 * 1024
const ACP_MAX_INPUT_BYTES = 16 * 1024 * 1024
const ACP_MAX_REPLY_BYTES = 10 * 1024 * 1024
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
let acpSdkPromise

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
      pathApi.join(home, '.mimocode', 'bin'),
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
    pathApi.join(home, '.mimocode', 'bin'),
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

function imageAttachmentLimit(kind) {
  return IMAGE_ATTACHMENT_LIMITS[kind] || 0
}

function attachmentPaths(kind, value) {
  if (value == null) return []
  if (!Array.isArray(value)) throw new Error('LOCAL_ATTACHMENT_REFERENCE_INVALID')
  const limit = imageAttachmentLimit(kind)
  if (value.length && !limit) throw new Error('LOCAL_AGENT_IMAGE_UNSUPPORTED')
  if (value.length > limit) throw new Error('LOCAL_AGENT_IMAGE_LIMIT')
  const normalized = value.map((filename) => {
    if (typeof filename !== 'string' || !filename || filename.length > 4096
        || !path.isAbsolute(filename) || /[\u0000-\u001f\u007f]/.test(filename)) {
      throw new Error('LOCAL_ATTACHMENT_REFERENCE_INVALID')
    }
    return path.normalize(filename)
  })
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('LOCAL_ATTACHMENT_REFERENCE_INVALID')
  }
  return normalized
}

function hermesSkillNames(value) {
  if (value == null) return []
  if (!Array.isArray(value)) throw new Error('LOCAL_SKILL_SELECTION_INVALID')
  if (value.length > MAX_NATIVE_SKILLS) throw new Error('LOCAL_SKILL_LIMIT')
  const normalized = value.map((skill) => {
    if (typeof skill !== 'string' || !NATIVE_SKILL_NAME.test(skill)) {
      throw new Error('LOCAL_SKILL_SELECTION_INVALID')
    }
    return skill
  })
  return [...new Set(normalized)]
}

function invocation(kind, executable, workdir, sessionRef = '', options = {}) {
  const attachments = attachmentPaths(kind, options.attachments)
  if (kind === 'codex') {
    const sandbox = codexSandbox(options.sandbox)
    const imageArgs = attachments.flatMap(filename => ['--image', filename])
    if (sessionRef) {
      return {
        command: executable,
        args: [
          'exec', 'resume', '--json', '--skip-git-repo-check',
          '-c', `sandbox_mode="${sandbox}"`, ...imageArgs, sessionRef, '-',
        ],
        stdin: true,
      }
    }
    return {
      command: executable,
      args: ['exec', '--json', '--skip-git-repo-check', '--sandbox',
        sandbox, '-C', workdir, ...imageArgs, '-'],
      stdin: true,
    }
  }
  if (kind === 'hermes') {
    const skills = hermesSkillNames(options.skills)
    return {
      command: executable,
      args: [
        'chat',
        '--quiet',
        ...(options.sandbox === 'workspace-write' ? ['--yolo'] : []),
        ...(options.provider?.id ? ['--provider', options.provider.id] : []),
        ...(options.provider?.model ? ['--model', options.provider.model] : []),
        ...skills.flatMap(skill => ['--skills', skill]),
        ...(sessionRef ? ['--resume', sessionRef] : []),
        ...(attachments[0] ? ['--image', attachments[0]] : []),
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
    if (options.sandbox !== 'workspace-write') {
      return {
        command: executable,
        args: ['acp'],
        acpMode: 'plan',
      }
    }
    return {
      command: executable,
      args: [
        '--output-format', 'stream-json',
        '--auto',
        ...(sessionRef ? ['--session', sessionRef] : []),
        '--prompt',
      ],
      promptArg: true,
    }
  }
  if (kind === 'mimo') {
    return {
      command: executable,
      args: [
        'run', '--pure', '--agent', options.sandbox === 'workspace-write' ? 'build' : 'plan',
        '--format', 'json', '--dir', workdir,
        ...(sessionRef ? ['--session', sessionRef] : []),
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
        '--agent', options.sandbox === 'workspace-write' ? 'build' : 'plan',
        ...(sessionRef ? ['--session', sessionRef] : []),
        ...attachments.flatMap(filename => ['--file', filename]),
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

function codexProgressTitle(item) {
  const type = String(item?.type || '').toLowerCase()
  const descriptor = [type, item?.name, item?.tool, item?.command]
    .map(value => String(value || '').toLowerCase())
    .join(' ')
  if (/image[_ -]?(?:generation|gen)|imagegen|generate[_ -]?image/.test(descriptor)) return 'image_generation'
  if (/audio[_ -]?(?:generation|gen)|generate[_ -]?audio|text[_ -]?to[_ -]?speech/.test(descriptor)) {
    return 'audio_generation'
  }
  if (/video[_ -]?(?:generation|gen)|generate[_ -]?video/.test(descriptor)) return 'video_generation'
  if (type === 'reasoning' || /\breasoning\b/.test(descriptor)) return 'reasoning'
  if (/apply_patch|write[_ -]?file|edit[_ -]?file|create[_ -]?file|\b(?:mkdir|tee|cp|mv)\b/.test(descriptor)) {
    return 'write_file'
  }
  if (/\b(?:rg|grep|find|search|glob)\b/.test(descriptor)) return 'search'
  if (/read[_ -]?file|\b(?:cat|sed|head|tail|ls|stat|file|ffprobe)\b|git (?:show|diff)/.test(descriptor)) {
    return 'read_file'
  }
  if (/tool|mcp/.test(type)) return 'tool'
  return 'process'
}

function codexProgressEvent(event) {
  if (event?.type === 'turn.started') {
    return { id: 'turn', title: 'process', status: 'in_progress' }
  }
  if (event?.type === 'turn.completed') {
    return { id: 'turn', title: 'process', status: 'completed' }
  }
  if (!['item.started', 'item.completed'].includes(event?.type)
      || !event.item || event.item.type === 'agent_message') {
    return null
  }
  const rawId = String(event.item.id || '')
  const id = /^[A-Za-z0-9._:-]{1,100}$/.test(rawId) ? rawId : ''
  const failed = event.item.status === 'failed'
    || (Number.isInteger(event.item.exit_code) && event.item.exit_code !== 0)
  return {
    ...(id ? { id } : {}),
    title: codexProgressTitle(event.item),
    status: failed
      ? 'failed'
      : event.type === 'item.started' ? 'in_progress' : 'completed',
  }
}

function createJsonLineParser(onEvent) {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  const consume = (flush = false) => {
    const lines = pending.split(/\r?\n/)
    pending = flush ? '' : (lines.pop() || '')
    if (flush && lines.length === 1 && !lines[0]) return
    for (const line of lines) {
      if (!line.trim()) continue
      try { onEvent(JSON.parse(line)) } catch { /* ignore non-JSON diagnostics */ }
    }
    if (flush && pending.trim()) {
      try { onEvent(JSON.parse(pending)) } catch { /* ignore incomplete diagnostics */ }
      pending = ''
    }
  }
  return {
    write(chunk) {
      pending += decoder.write(chunk)
      consume(false)
    },
    end() {
      pending += decoder.end()
      consume(true)
    },
  }
}

function parseMimoOutput(stdout) {
  let sessionRef = ''
  const texts = []
  const errors = []
  for (const line of String(stdout || '').split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      if (typeof event.sessionID === 'string') sessionRef = event.sessionID
      if (event.type === 'text' && typeof event.part?.text === 'string') {
        texts.push(event.part.text)
      }
      if (event.type === 'error') {
        const detail = event.error?.data?.message || event.error?.message || event.error?.name
        if (detail) errors.push(String(detail))
      }
    } catch { /* ignore non-JSON diagnostics */ }
  }
  return { text: texts.join('\n').trim(), sessionRef, error: errors.join('\n').trim() }
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

function stripAnsi(value) {
  return String(value || '').replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
}

function queryHermesState(databasePath, sql, params, options = {}) {
  if (typeof options.queryFn === 'function') {
    return options.queryFn({ databasePath, sql, params, readOnly: true })
  }
  let database
  try {
    const { DatabaseSync } = require('node:sqlite')
    database = new DatabaseSync(databasePath, { readOnly: true })
    return database.prepare(sql).get(...params)
  } finally {
    try { database?.close() } catch { /* database was already closed */ }
  }
}

function readHermesMessageWatermark(options = {}) {
  const databasePath = path.join(options.home || os.homedir(), '.hermes', 'state.db')
  const existsFn = options.existsFn || fs.existsSync
  if (!existsFn(databasePath)) return 0
  try {
    const row = queryHermesState(databasePath, `
      SELECT COALESCE(MAX(id), 0) AS max_id
      FROM messages
    `, [], options)
    const watermark = Number(row?.max_id)
    return Number.isSafeInteger(watermark) && watermark >= 0 ? watermark : null
  } catch {
    return null
  }
}

function readHermesFinalResponse(sessionRef, options = {}) {
  const afterMessageId = Number(options.afterMessageId)
  if (!sessionRef || !Number.isSafeInteger(afterMessageId) || afterMessageId < 0) return ''
  const databasePath = path.join(options.home || os.homedir(), '.hermes', 'state.db')
  const existsFn = options.existsFn || fs.existsSync
  if (!existsFn(databasePath)) return ''
  try {
    const row = queryHermesState(databasePath, `
      SELECT content
      FROM messages
      WHERE session_id = ?
        AND id > ?
        AND role = 'assistant'
        AND finish_reason IN ('stop', 'length')
        AND length(trim(content)) > 0
      ORDER BY id DESC
      LIMIT 1
    `, [sessionRef, afterMessageId], options)
    return String(row?.content || '').trim()
  } catch {
    return ''
  }
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

function runtimeEventStatus(value, fallback = '') {
  const normalized = String(value || '').toLowerCase()
  const aliases = {
    pending: 'queued',
    in_progress: 'running',
    cancelled: 'stopped',
    canceled: 'stopped',
    success: 'completed',
    error: 'failed',
  }
  const status = aliases[normalized] || normalized
  return RUNTIME_EVENT_STATUSES.has(status) ? status : fallback
}

function sanitizeRuntimeEventText(value, childEnv, limit, singleLine = false, trim = true) {
  let text = stripAnsi(redactChildSecrets(value, childEnv))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/file:\/\/\/[^\s"'`<>|,;)}\]]+/gi, '[path]')
    .replace(/(?<![A-Za-z0-9:])(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`<>|,;)}\]]+/g, '[path]')
    .replace(/(?<![A-Za-z0-9:])\/(?!\/)[^\s"'`<>|,;)}\]]+/g, '[path]')
    .replace(/(["']?)(?:[A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|authorization)[A-Za-z0-9_.-]*)\1\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]]+)/gi, 'credential=[redacted]')
    .replace(/\bbearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .replace(/(["']?)(?:command|cmd)\1\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]+)/gi, '[operation hidden]')
    .replace(/(["']?)stderr\1\s*[:=]\s*[^\r\n]*/gi, '[diagnostic hidden]')
  if (singleLine) text = text.replace(/\s+/g, ' ')
  return (trim ? text.trim() : text).slice(0, limit)
}

function createRuntimeEventEmitter(options, childEnv) {
  const callback = typeof options.onEvent === 'function' ? options.onEvent : null
  let emittedAnswerDelta = false
  const deliver = (event) => {
    if (!callback) return
    try {
      const pending = callback(event)
      if (pending && typeof pending.catch === 'function') pending.catch(() => {})
    } catch { /* runtime events are best-effort */ }
  }
  const emit = (input) => {
    if (!callback || !input || !RUNTIME_EVENT_TYPES.has(input.type)) return
    const base = { type: input.type }
    const rawId = sanitizeRuntimeEventText(input.id, childEnv, RUNTIME_EVENT_LIMITS.id, true)
    if (/^[A-Za-z0-9._:-]{1,100}$/.test(rawId)) base.id = rawId
    const status = runtimeEventStatus(input.status)
    if (status) base.status = status
    for (const field of ['title', 'summary', 'detail']) {
      const text = sanitizeRuntimeEventText(
        input[field],
        childEnv,
        RUNTIME_EVENT_LIMITS[field],
        field === 'title',
      )
      if (text) base[field] = text
    }
    if (input.type !== 'answer_delta') {
      deliver(base)
      return
    }
    const delta = sanitizeRuntimeEventText(
      input.delta,
      childEnv,
      Number.MAX_SAFE_INTEGER,
      false,
      false,
    )
    if (!delta) return
    emittedAnswerDelta = true
    for (let offset = 0; offset < delta.length; offset += RUNTIME_EVENT_LIMITS.delta) {
      deliver({
        ...base,
        delta: delta.slice(offset, offset + RUNTIME_EVENT_LIMITS.delta),
      })
    }
  }
  return {
    emit,
    emitFinalAnswer(text) {
      if (!emittedAnswerDelta) {
        emit({ type: 'answer_delta', status: 'completed', delta: text })
      }
    },
  }
}

function runtimeToolTitle(event) {
  const part = event?.part && typeof event.part === 'object' ? event.part : {}
  const classified = codexProgressTitle({
    type: [event?.type, event?.sessionUpdate, part.type, event?.kind, part.kind]
      .filter(Boolean).join(' '),
    name: event?.name || event?.toolName || part.name,
    tool: event?.tool || event?.tool_name || part.tool,
  })
  return classified === 'process' ? 'tool' : classified
}

function runtimeEventId(event) {
  const part = event?.part && typeof event.part === 'object' ? event.part : {}
  return event?.toolCallId || event?.tool_call_id || event?.id
    || part.toolCallId || part.tool_call_id || part.id || ''
}

function codexRuntimeEvents(event) {
  if (event?.type === 'turn.started') {
    return [{ id: 'turn', type: 'status', title: 'process', status: 'running' }]
  }
  if (event?.type === 'turn.completed') {
    return [{ id: 'turn', type: 'status', title: 'process', status: 'completed' }]
  }
  if (!['item.started', 'item.completed'].includes(event?.type) || !event.item) return []
  const item = event.item
  if (event.type === 'item.completed' && item.type === 'agent_message'
      && typeof item.text === 'string') {
    return [{ type: 'answer_delta', status: 'running', delta: item.text }]
  }
  if (event.type === 'item.completed' && item.type === 'reasoning') {
    return [{
      type: 'reasoning_summary',
      title: 'reasoning',
      status: 'completed',
      ...(typeof item.summary === 'string' ? { summary: item.summary } : {}),
    }]
  }
  if (event.type === 'item.completed' && item.type === 'plan') {
    const summary = typeof item.summary === 'string' ? item.summary : item.text
    return typeof summary === 'string'
      ? [{ type: 'plan', title: 'plan', summary }]
      : []
  }
  const progress = codexProgressEvent(event)
  if (!progress) return []
  return [{
    ...progress,
    type: event.type === 'item.started' ? 'tool_start' : 'tool_result_summary',
    status: runtimeEventStatus(progress.status, 'completed'),
  }]
}

function jsonCliRuntimeEvents(kind, event) {
  if (!event || typeof event !== 'object') return []
  if (kind === 'kimi' && event.role === 'assistant' && typeof event.content === 'string') {
    return [{ type: 'answer_delta', status: 'running', delta: event.content }]
  }
  if (kind === 'gemini' && event.type === 'message' && event.role === 'assistant'
      && typeof event.content === 'string') {
    return [{ type: 'answer_delta', status: 'running', delta: event.content }]
  }
  if (kind === 'mimo' && event.type === 'text' && typeof event.part?.text === 'string') {
    return [{ type: 'answer_delta', status: 'running', delta: event.part.text }]
  }
  if (kind === 'opencode' && event.type === 'text' && event.part?.type === 'text'
      && typeof event.part.text === 'string') {
    return [{ type: 'answer_delta', status: 'running', delta: event.part.text }]
  }

  const type = String(event.type || event.part?.type || '').toLowerCase()
  if (/\bplan(?:_update|_removed)?\b/.test(type)) {
    const summary = typeof event.summary === 'string'
      ? event.summary
      : typeof event.content === 'string' ? event.content : event.text
    return [{
      id: runtimeEventId(event),
      type: 'plan',
      title: 'plan',
      status: /removed/.test(type) ? 'stopped' : runtimeEventStatus(event.status),
      ...(typeof summary === 'string' ? { summary } : {}),
    }]
  }
  if (!/tool|function_call/.test(type)) return []
  const status = runtimeEventStatus(
    event.status || event.part?.status || event.part?.state?.status,
  )
  const completed = ['completed', 'failed', 'stopped', 'timeout'].includes(status)
    || /result|complete|finish|end/.test(type)
  const update = /update|progress/.test(type)
  return [{
    id: runtimeEventId(event),
    type: completed ? 'tool_result_summary' : update ? 'tool_update' : 'tool_start',
    title: runtimeToolTitle(event),
    status: status || (completed ? 'completed' : 'running'),
  }]
}

function acpPlanSummary(update) {
  const plan = update.sessionUpdate === 'plan_update' ? update.plan : update
  if (Array.isArray(plan?.entries)) {
    return plan.entries.slice(0, 12).map(entry => {
      const status = runtimeEventStatus(entry?.status)
      return `${status ? `[${status}] ` : ''}${String(entry?.content || '')}`
    }).filter(Boolean).join('\n')
  }
  return typeof plan?.content === 'string' ? plan.content : ''
}

function acpRuntimeEvents(update) {
  if (!update || typeof update !== 'object') return []
  if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
    return [{ type: 'answer_delta', status: 'running', delta: update.content.text }]
  }
  if (update.sessionUpdate === 'agent_thought_chunk' && update.content?.type === 'text') {
    return [{ type: 'reasoning_summary', title: 'reasoning', status: 'running' }]
  }
  if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
    const status = runtimeEventStatus(update.status)
    const completed = ['completed', 'failed', 'stopped', 'timeout'].includes(status)
    return [{
      id: update.toolCallId,
      type: completed
        ? 'tool_result_summary'
        : update.sessionUpdate === 'tool_call' ? 'tool_start' : 'tool_update',
      title: runtimeToolTitle(update),
      status: status || (update.sessionUpdate === 'tool_call' ? 'running' : 'waiting'),
    }]
  }
  if (['plan', 'plan_update', 'plan_removed'].includes(update.sessionUpdate)) {
    const summary = acpPlanSummary(update)
    return [{
      id: update.id || update.plan?.id,
      type: 'plan',
      title: 'plan',
      status: update.sessionUpdate === 'plan_removed' ? 'stopped' : 'running',
      ...(summary ? { summary } : {}),
    }]
  }
  return []
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
  if (kind === 'hermes') return { text: stripAnsi(stdout).trim(), sessionRef }
  if (kind === 'workbuddy') {
    const parsed = parseWorkBuddyOutput(stdout)
    return { text: parsed.text, sessionRef: parsed.sessionRef || sessionRef }
  }
  if (kind === 'kimi') {
    const parsed = parseKimiOutput(stdout)
    return { text: parsed.text, sessionRef: parsed.sessionRef || sessionRef }
  }
  if (kind === 'mimo') return parseMimoOutput(stdout)
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

function loadAcpSdk() {
  acpSdkPromise ||= Promise.all([
    import('@agentclientprotocol/sdk'),
    import('@agentclientprotocol/sdk/dist/schema/zod.gen.js'),
  ]).then(([sdk, validators]) => ({ ...sdk, validators }))
  return acpSdkPromise
}

function acpTransportError(diagnostic) {
  return agentExecutionError('LOCAL_AGENT_PROCESS_FAILED', diagnostic)
}

function validateAcpInboundMessage(message, validators, replyState) {
  if (!message || typeof message !== 'object' || Array.isArray(message)
      || message.jsonrpc !== '2.0') {
    throw acpTransportError('Kimi ACP returned an invalid protocol message.')
  }

  const hasId = Object.hasOwn(message, 'id')
  if (typeof message.method === 'string') {
    if (message.method === 'session/update' && !hasId) {
      const parsed = validators.zSessionNotification.safeParse(message.params)
      if (!parsed.success) {
        throw acpTransportError('Kimi ACP returned invalid session update parameters.')
      }
      const update = parsed.data.update
      if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
        replyState.bytes += Buffer.byteLength(update.content.text, 'utf8')
        if (replyState.bytes > ACP_MAX_REPLY_BYTES) {
          throw acpTransportError('Kimi ACP reply exceeded the safe output limit.')
        }
      }
      return message
    }
    if (message.method === 'session/request_permission' && hasId) {
      const validId = typeof message.id === 'string'
        || (Number.isInteger(message.id) && message.id >= 0)
      if (!validId || !validators.zRequestPermissionRequest.safeParse(message.params).success) {
        throw acpTransportError('Kimi ACP returned an invalid permission request.')
      }
      return message
    }
    throw acpTransportError('Kimi ACP requested an unsupported client method.')
  }

  if (!Number.isInteger(message.id) || message.id < 0) {
    throw acpTransportError('Kimi ACP returned an invalid response identifier.')
  }
  const hasResult = Object.hasOwn(message, 'result')
  const hasError = Object.hasOwn(message, 'error')
  if (hasResult === hasError) {
    throw acpTransportError('Kimi ACP returned an invalid response payload.')
  }
  if (hasError) {
    const error = message.error
    if (!error || typeof error !== 'object' || Array.isArray(error)
        || !Number.isFinite(error.code) || typeof error.message !== 'string') {
      throw acpTransportError('Kimi ACP returned an invalid error response.')
    }
  }
  return message
}

function boundedAcpStream(output, input, validators) {
  const textEncoder = new TextEncoder()
  const replyState = { bytes: 0 }
  const readable = new ReadableStream({
    async start(controller) {
      const reader = input.getReader()
      let pending = Buffer.alloc(0)
      let inputBytes = 0
      const parseLine = (line) => {
        const text = line.toString('utf8').trim()
        if (!text) return
        let message
        try {
          message = JSON.parse(text)
        } catch {
          throw acpTransportError('Kimi ACP returned malformed JSON.')
        }
        controller.enqueue(validateAcpInboundMessage(message, validators, replyState))
      }
      const append = (left, right) => {
        const size = left.length + right.length
        if (size > ACP_MAX_LINE_BYTES) {
          throw acpTransportError('Kimi ACP message exceeded the safe line limit.')
        }
        return left.length ? Buffer.concat([left, right], size) : Buffer.from(right)
      }
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          if (!value?.byteLength) continue
          const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
          inputBytes += chunk.length
          if (inputBytes > ACP_MAX_INPUT_BYTES) {
            throw acpTransportError('Kimi ACP input exceeded the safe total limit.')
          }
          let offset = 0
          while (offset < chunk.length) {
            const newline = chunk.indexOf(0x0a, offset)
            if (newline === -1) {
              pending = append(pending, chunk.subarray(offset))
              break
            }
            const line = append(pending, chunk.subarray(offset, newline))
            pending = Buffer.alloc(0)
            parseLine(line)
            offset = newline + 1
          }
        }
        if (pending.length) parseLine(pending)
        controller.close()
      } catch (error) {
        controller.error(error)
      } finally {
        reader.releaseLock()
      }
    },
  })
  const writable = new WritableStream({
    async write(message) {
      const writer = output.getWriter()
      try {
        await writer.write(textEncoder.encode(`${JSON.stringify(message)}\n`))
      } finally {
        writer.releaseLock()
      }
    },
  })
  return { readable, writable }
}

function childEnvironment(agent, workdir, options, platform) {
  const hermesSafetyEnv = agent.kind === 'hermes'
    ? options.sandbox === 'workspace-write'
      ? { HERMES_EXEC_ASK: '', HERMES_YOLO_MODE: '1' }
      : { HERMES_EXEC_ASK: '1', HERMES_YOLO_MODE: '' }
    : {}
  const openCodeSafetyEnv = agent.kind === 'opencode'
      && options.sandbox !== 'workspace-write'
    ? { OPENCODE_PERMISSION: OPENCODE_READ_ONLY_PERMISSION }
    : {}
  const openClawWorkspaceEnv = agent.kind === 'openclaw'
    ? { OPENCLAW_WORKSPACE_DIR: path.resolve(workdir) }
    : {}
  return {
    ...systemChildEnvironment(process.env, platform),
    ...options.env,
    ...hermesSafetyEnv,
    ...openCodeSafetyEnv,
    ...openClawWorkspaceEnv,
    PATH: searchPath({ platform }),
  }
}

function permissionRejection(options) {
  return (options || []).find(option => (
    ['reject_once', 'reject_always'].includes(option.kind)
      || /reject|deny/i.test(`${option.optionId || ''} ${option.name || ''}`)
  ))
}

function destroyChildPipes(child) {
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    if (!stream?.destroyed) stream?.destroy()
  }
}

async function terminateChild(child, platform, spawnFn) {
  if (child.exitCode != null || child.signalCode != null) return
  await new Promise((resolve) => {
    let settled = false
    let forceKillTimeout
    let forceSettleTimeout
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(forceKillTimeout)
      clearTimeout(forceSettleTimeout)
      child.removeListener('close', finish)
      child.removeListener('error', finish)
      resolve()
    }
    child.once('close', finish)
    child.once('error', finish)
    if (platform === 'win32' && child.pid) {
      const killer = spawnFn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true,
      })
      killer.on('error', () => {})
      killer.unref()
      forceSettleTimeout = setTimeout(finish, TERMINATE_GRACE_MS + KILL_SETTLE_MS)
      return
    }
    const signalTree = (signal) => {
      if (child.pid) {
        try {
          process.kill(-child.pid, signal)
          return
        } catch { /* fall back to the direct child */ }
      }
      try {
        child.kill(signal)
      } catch { /* the process has already exited */ }
    }
    signalTree('SIGTERM')
    forceKillTimeout = setTimeout(() => signalTree('SIGKILL'), TERMINATE_GRACE_MS)
    forceSettleTimeout = setTimeout(finish, TERMINATE_GRACE_MS + KILL_SETTLE_MS)
  })
}

async function settleWithin(promise, timeoutMs) {
  let timeout
  await Promise.race([
    Promise.resolve(promise).catch(() => {}),
    new Promise((resolve) => {
      timeout = setTimeout(resolve, timeoutMs)
      timeout.unref?.()
    }),
  ])
  clearTimeout(timeout)
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode != null || child.signalCode != null) return true
  return new Promise((resolve) => {
    let timeout
    const finish = (exited) => {
      clearTimeout(timeout)
      child.removeListener('close', onExit)
      child.removeListener('error', onExit)
      resolve(exited)
    }
    const onExit = () => finish(true)
    child.once('close', onExit)
    child.once('error', onExit)
    timeout = setTimeout(() => finish(false), timeoutMs)
    timeout.unref?.()
  })
}

async function closeAcpChild(child, platform, spawnFn) {
  if (child.exitCode != null || child.signalCode != null) return
  if (!child.stdin?.destroyed && !child.stdin?.writableEnded) {
    try { child.stdin.end() } catch { /* the process has already closed its input */ }
  }
  if (await waitForChildExit(child, TERMINATE_GRACE_MS)) return
  await terminateChild(child, platform, spawnFn)
  destroyChildPipes(child)
}

function acpProtocolError(error, childEnv) {
  if (/^LOCAL_AGENT_[A-Z_]+$/.test(String(error?.message || ''))) return error
  const detail = redactChildSecrets(error?.diagnostic || error?.message || error, childEnv).trim()
  return detail
    ? failedAgentProcessError(detail)
    : agentExecutionError('LOCAL_AGENT_PROCESS_FAILED')
}

async function runKimiAcp(agent, prompt, workdir, options, spec) {
  const platform = options.platform || process.platform
  const spawnFn = options.spawnFn || spawn
  const prepared = prepareCommand(spec.command, spec.args, { platform })
  const childEnv = childEnvironment(agent, workdir, options, platform)
  const runtimeEvents = createRuntimeEventEmitter(options, childEnv)
  let sdk
  try {
    sdk = await loadAcpSdk()
  } catch (error) {
    throw acpProtocolError(error, childEnv)
  }
  if (options.signal?.aborted) throw agentExecutionError('LOCAL_AGENT_EXECUTION_STOPPED')

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
    throw agentExecutionError(
      'LOCAL_AGENT_SPAWN_FAILED',
      redactChildSecrets(error?.message || error, childEnv),
    )
  }

  const { ClientSideConnection, PROTOCOL_VERSION, validators } = sdk
  const stderr = []
  let stderrBytes = 0
  let connection
  let sessionRef = String(options.sessionRef || '')
  let ending = false
  let abortRequested = false
  let cancelPromise = Promise.resolve()
  let stopPromise
  let rejectAbort
  let timeout
  const reply = []
  const abortPromise = new Promise((_, reject) => { rejectAbort = reject })
  const stopChild = () => {
    stopPromise ||= closeAcpChild(child, platform, spawnFn)
    return stopPromise
  }
  const abort = () => {
    if (ending || abortRequested) return
    abortRequested = true
    if (connection && sessionRef) {
      try {
        cancelPromise = Promise.resolve(connection.cancel({ sessionId: sessionRef }))
          .catch(() => {})
      } catch { /* the ACP stream has already closed */ }
    }
    rejectAbort(agentExecutionError('LOCAL_AGENT_EXECUTION_STOPPED'))
  }
  const childFailure = new Promise((_, reject) => {
    child.once('error', (error) => {
      reject(abortRequested
        ? agentExecutionError('LOCAL_AGENT_EXECUTION_STOPPED')
        : agentExecutionError(
            'LOCAL_AGENT_SPAWN_FAILED',
            redactChildSecrets(error?.message || error, childEnv),
          ))
    })
    child.once('close', () => {
      if (ending) return
      if (abortRequested) {
        reject(agentExecutionError('LOCAL_AGENT_EXECUTION_STOPPED'))
        return
      }
      const detail = redactChildSecrets(Buffer.concat(stderr).toString('utf8').trim(), childEnv)
      reject(failedAgentProcessError(detail))
    })
  })
  child.stderr.on('data', (chunk) => {
    stderrBytes += chunk.length
    if (stderrBytes <= 1024 * 1024) stderr.push(chunk)
  })
  timeout = setTimeout(abort, 2 * 60 * 60 * 1000)
  if (options.signal?.aborted) abort()
  else options.signal?.addEventListener('abort', abort, { once: true })

  const client = {
    async requestPermission(params) {
      const denied = permissionRejection(params.options)
      return denied
        ? { outcome: { outcome: 'selected', optionId: denied.optionId } }
        : { outcome: { outcome: 'cancelled' } }
    },
    async sessionUpdate(params) {
      const update = params.update
      if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
        reply.push(update.content.text)
      }
      for (const event of acpRuntimeEvents(update)) runtimeEvents.emit(event)
    },
  }
  const protocol = (async () => {
    const stream = boundedAcpStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout),
      validators,
    )
    connection = new ClientSideConnection(() => client, stream)
    await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    if (sessionRef) {
      await connection.resumeSession({ sessionId: sessionRef, cwd: workdir, mcpServers: [] })
    } else {
      const session = await connection.newSession({ cwd: workdir, mcpServers: [] })
      sessionRef = session.sessionId
    }
    const safeSessionRef = redactChildSecrets(sessionRef, childEnv)
    const publicSessionRef = safeSessionRef.includes('[redacted]') ? '' : safeSessionRef
    if (publicSessionRef && typeof options.onSessionRef === 'function') {
      await options.onSessionRef(publicSessionRef)
    }
    await connection.setSessionMode({ sessionId: sessionRef, modeId: spec.acpMode })
    const promptResult = await connection.prompt({
      sessionId: sessionRef,
      prompt: [{ type: 'text', text: prompt }],
    })
    const text = redactChildSecrets(reply.join('').trim(), childEnv)
    if (!text) throw agentExecutionError('LOCAL_AGENT_EMPTY_RESPONSE')
    runtimeEvents.emitFinalAnswer(text)
    return {
      text,
      sessionRef: publicSessionRef,
      completed: promptResult?.stopReason === 'end_turn',
    }
  })().catch((error) => { throw acpProtocolError(error, childEnv) })

  try {
    return await Promise.race([protocol, abortPromise, childFailure])
  } finally {
    ending = true
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
    if (abortRequested) await settleWithin(cancelPromise, ACP_CANCEL_GRACE_MS)
    await stopChild()
  }
}

async function runAgent(agent, prompt, workdir, options = {}) {
  if (options.signal?.aborted) throw agentExecutionError('LOCAL_AGENT_EXECUTION_STOPPED')
  const platform = options.platform || process.platform
  const spawnFn = options.spawnFn || spawn
  const sessionRef = String(options.sessionRef || '')
  const spec = invocation(agent.kind, agent.executable, workdir, sessionRef, {
    sandbox: options.sandbox,
    provider: options.provider,
    attachments: options.attachments,
    skills: options.skills,
  })
  if (spec.acpMode) return runKimiAcp(agent, prompt, workdir, options, spec)
  const args = [...spec.args]
  if (spec.promptArg) args.push(prompt)
  if (spec.suffixArgs) args.push(...spec.suffixArgs)
  const prepared = prepareCommand(spec.command, args, { platform })
  const childEnv = childEnvironment(agent, workdir, options, platform)
  const runtimeEvents = createRuntimeEventEmitter(options, childEnv)
  let hermesMessageWatermark = null
  if (agent.kind === 'hermes') {
    const watermarkFn = options.hermesMessageWatermarkFn || readHermesMessageWatermark
    try {
      const watermark = watermarkFn({
        home: options.home,
        existsFn: options.hermesStateExistsFn,
        queryFn: options.hermesStateQueryFn,
      })
      if (Number.isSafeInteger(watermark) && watermark >= 0) {
        hermesMessageWatermark = watermark
      }
    } catch { /* a missing pre-run watermark makes final lookup ineligible */ }
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
    const progress = []
    const progressIndexes = new Map()
    let anonymousProgressId = 0
    const emitProgress = (input) => {
      const event = {
        ...(input?.id ? { id: String(input.id) } : {}),
        title: String(input?.title || 'process'),
        status: ['completed', 'failed', 'in_progress'].includes(input?.status)
          ? input.status
          : 'completed',
      }
      const progressId = event.id || `anonymous-${++anonymousProgressId}`
      const existingIndex = progressIndexes.get(progressId)
      if (existingIndex != null) {
        progress[existingIndex] = event
      } else {
        if (progress.length >= MAX_PROGRESS_STEPS) return
        progressIndexes.set(progressId, progress.length)
        progress.push(event)
      }
      try { options.onProgress?.(event) } catch { /* progress is best-effort */ }
    }
    const hermesProgressBuffers = { stdout: '', stderr: '' }
    const hermesProgressDecoders = { stdout: new TextDecoder(), stderr: new TextDecoder() }
    const emitHermesProgress = (source, chunk, flush = false) => {
      if (agent.kind !== 'hermes') return
      const decoder = hermesProgressDecoders[source]
      hermesProgressBuffers[source] += decoder.decode(chunk || undefined, { stream: !flush })
      const lines = hermesProgressBuffers[source].split(/\r?\n/)
      hermesProgressBuffers[source] = flush ? '' : (lines.pop() || '')
      for (const line of lines) {
        if (!/^┊\s*review diff$/i.test(stripAnsi(line).trim())) continue
        emitProgress({ title: 'write_file', status: 'completed' })
      }
    }
    const runtimeStreamParser = ['codex', 'kimi', 'mimo', 'gemini', 'opencode'].includes(agent.kind)
      ? createJsonLineParser((event) => {
          if (agent.kind === 'codex') {
            const progressEvent = codexProgressEvent(event)
            if (progressEvent) emitProgress(progressEvent)
          }
          const events = agent.kind === 'codex'
            ? codexRuntimeEvents(event)
            : jsonCliRuntimeEvents(agent.kind, event)
          for (const runtimeEvent of events) runtimeEvents.emit(runtimeEvent)
        })
      : null
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
      runtimeStreamParser?.write(chunk)
      emitHermesProgress('stdout', chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length
      if (stderrBytes <= 1024 * 1024) stderr.push(chunk)
      emitHermesProgress('stderr', chunk)
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
      void (async () => {
        emitHermesProgress('stdout', null, true)
        emitHermesProgress('stderr', null, true)
        runtimeStreamParser?.end()
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
        if (result.error) {
          reject(failedAgentProcessError(redactChildSecrets(result.error, childEnv)))
          return
        }
        const redactedSessionRef = redactChildSecrets(result.sessionRef, childEnv)
        const publicSessionRef = redactedSessionRef.includes('[redacted]')
          ? ''
          : redactedSessionRef
        if (agent.kind === 'hermes') {
          if (publicSessionRef && typeof options.onSessionRef === 'function') {
            await options.onSessionRef(publicSessionRef)
          }
          const finalResponseFn = options.hermesFinalResponseFn || readHermesFinalResponse
          let finalResponse = ''
          if (publicSessionRef && Number.isSafeInteger(hermesMessageWatermark)) {
            try {
              finalResponse = finalResponseFn(publicSessionRef, {
                home: options.home,
                afterMessageId: hermesMessageWatermark,
                existsFn: options.hermesStateExistsFn,
                queryFn: options.hermesStateQueryFn,
              })
            } catch { /* fall back to the official --quiet stdout */ }
          }
          const storedResponse = typeof finalResponse === 'string' ? finalResponse.trim() : ''
          if (storedResponse) result.text = storedResponse
        }
        if (progress.length) result.progress = progress
        const redactedText = redactChildSecrets(result.text, childEnv)
        if (!redactedText) {
          reject(agentExecutionError('LOCAL_AGENT_EMPTY_RESPONSE'))
          return
        }
        const output = { text: redactedText, sessionRef: publicSessionRef }
        if (result.progress?.length) output.progress = result.progress
        runtimeEvents.emitFinalAnswer(redactedText)
        resolve(output)
      })().catch(error => reject(error))
    }))
    if (spec.stdin) child.stdin.end(prompt)
    else child.stdin.end()
  })
}

module.exports = {
  ALLOWED_KINDS,
  detectAgents,
  imageAttachmentLimit,
  invocation,
  normalizeOutput,
  parseCodexOutput,
  parseGeminiOutput,
  parseKimiOutput,
  parseMimoOutput,
  parseOpenCodeOutput,
  parseWorkBuddyOutput,
  prepareCommand,
  readHermesFinalResponse,
  readHermesMessageWatermark,
  resolveExecutable,
  runAgent,
  searchPath,
}
