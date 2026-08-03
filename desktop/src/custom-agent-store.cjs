const { execFile, spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { promisify } = require('node:util')

const execFileAsync = promisify(execFile)
const CUSTOM_AGENT_KIND = /^custom-[a-f0-9]{16}$/
const PROMPT_MODES = new Set(['stdin', 'argument'])
const MAX_AGENTS = 32
const MAX_ARGUMENTS = 24
const MAX_ARGUMENT_LENGTH = 512
const MAX_ATTACHMENTS = 4
const MAX_PROMPT_BYTES = 1024 * 1024
const MAX_STDOUT_BYTES = 4 * 1024 * 1024
const MAX_STDERR_BYTES = 1024 * 1024
const TERMINATE_GRACE_MS = 500
const KILL_SETTLE_MS = 500
const VERSION_LINE_LIMIT = 160
const SENSITIVE_ARGUMENT = /api[-_]?key|token|secret|password|passwd|credential|authorization|cookie/i
const SECRET_VALUE = /(?:^|[=:])(?:sk|rk|pk|ghp|github_pat|xox[baprs]?)[_-][A-Za-z0-9_-]{12,}/i
const CHILD_ENV_KEYS = Object.freeze([
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH',
  'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'TERM', 'COLORTERM', 'NO_COLOR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME',
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
  'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
])

function customAgentError(code) {
  return Object.assign(new Error(code), { code })
}

function cleanInline(value, limit) {
  const text = String(value || '').trim().replace(/\s+/g, ' ')
  if (!text || text.length > limit || /[\u0000-\u001f\u007f]/.test(text)) return ''
  return text
}

function cleanDescription(value) {
  const text = String(value || '').trim().replace(/\s+/g, ' ')
  if (text.length > 240 || /[\u0000-\u001f\u007f]/.test(text)) return ''
  return text
}

function normalizeArguments(value) {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > MAX_ARGUMENTS) {
    throw customAgentError('CUSTOM_AGENT_ARGUMENTS_INVALID')
  }
  return value.map((argument) => {
    if (typeof argument !== 'string' || !argument.length
        || argument.length > MAX_ARGUMENT_LENGTH
        || /[\u0000\r\n]/.test(argument)) {
      throw customAgentError('CUSTOM_AGENT_ARGUMENTS_INVALID')
    }
    if (SENSITIVE_ARGUMENT.test(argument) || SECRET_VALUE.test(argument)) {
      throw customAgentError('CUSTOM_AGENT_SECRET_ARGUMENT_BLOCKED')
    }
    return argument
  })
}

function normalizeDefinition(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const kind = String(input.kind || '')
  const label = cleanInline(input.label, 60)
  const description = cleanDescription(input.description)
  const executable = String(input.executable || '')
  const promptMode = String(input.promptMode || '')
  const createdAt = String(input.createdAt || '')
  if (!CUSTOM_AGENT_KIND.test(kind) || !label || !path.isAbsolute(executable)
      || !PROMPT_MODES.has(promptMode) || !createdAt) return null
  let args
  try {
    args = normalizeArguments(input.args)
  } catch {
    return null
  }
  return { kind, label, description, executable: path.normalize(executable), args, promptMode, createdAt }
}

function executablePath(filename, platform = process.platform) {
  if (typeof filename !== 'string' || !filename || filename.length > 4096
      || !path.isAbsolute(filename) || /[\u0000-\u001f\u007f]/.test(filename)) {
    throw customAgentError('CUSTOM_AGENT_EXECUTABLE_INVALID')
  }
  let resolved
  try {
    resolved = fs.realpathSync(filename)
    const stat = fs.statSync(resolved)
    if (!stat.isFile()) throw customAgentError('CUSTOM_AGENT_EXECUTABLE_INVALID')
    if (platform === 'win32') {
      if (!/\.(?:com|exe)$/i.test(resolved)) {
        throw customAgentError('CUSTOM_AGENT_EXECUTABLE_UNSUPPORTED')
      }
    } else {
      fs.accessSync(resolved, fs.constants.X_OK)
    }
  } catch (error) {
    if (String(error?.code || '').startsWith('CUSTOM_AGENT_')) throw error
    throw customAgentError('CUSTOM_AGENT_EXECUTABLE_INVALID')
  }
  return path.normalize(resolved)
}

function childEnvironment(source = process.env) {
  const env = {}
  for (const name of CHILD_ENV_KEYS) {
    const key = Object.keys(source).find(candidate => candidate.toLowerCase() === name.toLowerCase())
    const value = key ? source[key] : ''
    if (typeof value === 'string' && value) env[name] = value
  }
  return env
}

function publicProfile(definition, version = '') {
  return {
    kind: definition.kind,
    label: definition.label,
    description: definition.description,
    commandName: path.basename(definition.executable),
    promptMode: definition.promptMode,
    custom: true,
    recommended: false,
    providerCompatible: false,
    providerSupport: 'custom-cli',
    providerMode: 'custom',
    installed: true,
    installSupported: false,
    installErrorCode: '',
    imageAttachmentLimit: MAX_ATTACHMENTS,
    attachmentTypes: ['image', 'audio', 'video'],
    version: String(version || '').slice(0, VERSION_LINE_LIMIT),
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function redactExecutable(value, definition) {
  const text = String(value || '')
  if (!text) return ''
  return text.replace(
    new RegExp(escapeRegExp(definition.executable), 'g'),
    path.basename(definition.executable),
  )
}

function normalizeAttachments(value) {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) {
    throw customAgentError('LOCAL_ATTACHMENT_REFERENCE_INVALID')
  }
  const normalized = value.map((filename) => {
    if (typeof filename !== 'string' || !filename || filename.length > 4096
        || !path.isAbsolute(filename) || /[\u0000-\u001f\u007f]/.test(filename)) {
      throw customAgentError('LOCAL_ATTACHMENT_REFERENCE_INVALID')
    }
    return path.normalize(filename)
  })
  if (new Set(normalized).size !== normalized.length) {
    throw customAgentError('LOCAL_ATTACHMENT_REFERENCE_INVALID')
  }
  return normalized
}

class CustomAgentStore {
  constructor({
    storagePath,
    platform = process.platform,
    execFileFn = execFileAsync,
    createId = randomUUID,
    now = () => new Date().toISOString(),
  }) {
    if (!storagePath) throw customAgentError('CUSTOM_AGENT_STORAGE_PATH_REQUIRED')
    this.storagePath = path.resolve(storagePath)
    this.platform = platform
    this.execFileFn = execFileFn
    this.createId = createId
    this.now = now
    this.definitions = this.load()
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.storagePath, 'utf8'))
      if (parsed?.version !== 1 || !Array.isArray(parsed.agents)) return []
      const definitions = parsed.agents.slice(0, MAX_AGENTS).map(normalizeDefinition).filter(Boolean)
      try { fs.chmodSync(this.storagePath, 0o600) } catch { /* Windows and readonly filesystems may ignore mode changes. */ }
      return definitions
    } catch {
      return []
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.storagePath), { recursive: true })
    const tempPath = `${this.storagePath}.tmp`
    fs.writeFileSync(tempPath, `${JSON.stringify({ version: 1, agents: this.definitions }, null, 2)}\n`, {
      mode: 0o600,
    })
    fs.renameSync(tempPath, this.storagePath)
    try { fs.chmodSync(this.storagePath, 0o600) } catch { /* Windows ignores POSIX file modes. */ }
  }

  has(kind) {
    return this.definitions.some(definition => definition.kind === kind)
  }

  label(kind) {
    return this.definitions.find(definition => definition.kind === kind)?.label || ''
  }

  list() {
    return this.definitions.map(definition => publicProfile(definition))
  }

  async probeVersion(definition) {
    try {
      const result = await this.execFileFn(definition.executable, ['--version'], {
        timeout: 5000,
        windowsHide: true,
        env: childEnvironment(),
      })
      return [result?.stdout, result?.stderr]
        .flatMap(output => String(output || '').split(/\r?\n/))
        .map(line => line.trim())
        .find(Boolean)
        ?.slice(0, VERSION_LINE_LIMIT) || ''
    } catch {
      return ''
    }
  }

  async detectAgents() {
    const agents = await Promise.all(this.definitions.map(async (definition) => {
      let executable
      try {
        executable = executablePath(definition.executable, this.platform)
      } catch {
        return null
      }
      const version = await this.probeVersion(definition)
      return {
        kind: definition.kind,
        name: `${definition.label} CLI`,
        label: definition.label,
        description: definition.description,
        commandName: path.basename(executable),
        promptMode: definition.promptMode,
        custom: true,
        executable,
        version,
      }
    }))
    return agents.filter(Boolean)
  }

  async catalog() {
    const detected = new Map((await this.detectAgents()).map(agent => [agent.kind, agent]))
    return this.definitions.map((definition) => {
      const agent = detected.get(definition.kind)
      return {
        ...publicProfile(definition, agent?.version || ''),
        installed: Boolean(agent),
      }
    })
  }

  create(input, selectedExecutable) {
    if (this.definitions.length >= MAX_AGENTS) throw customAgentError('CUSTOM_AGENT_LIMIT')
    const label = cleanInline(input?.label, 60)
    const description = cleanDescription(input?.description)
    const promptMode = String(input?.promptMode || '')
    if (!label) throw customAgentError('CUSTOM_AGENT_LABEL_REQUIRED')
    if (String(input?.description || '').trim() && !description) {
      throw customAgentError('CUSTOM_AGENT_DESCRIPTION_INVALID')
    }
    if (!PROMPT_MODES.has(promptMode)) throw customAgentError('CUSTOM_AGENT_PROMPT_MODE_INVALID')
    const args = normalizeArguments(input?.args)
    const executable = executablePath(selectedExecutable, this.platform)
    let kind = ''
    for (let attempt = 0; attempt < 8 && !kind; attempt += 1) {
      const candidate = `custom-${String(this.createId()).replace(/[^a-fA-F0-9]/g, '').toLowerCase().slice(0, 16)}`
      if (CUSTOM_AGENT_KIND.test(candidate) && !this.has(candidate)) kind = candidate
    }
    if (!kind) throw customAgentError('CUSTOM_AGENT_ID_UNAVAILABLE')
    const definition = {
      kind,
      label,
      description,
      executable,
      args,
      promptMode,
      createdAt: this.now(),
    }
    this.definitions = [...this.definitions, definition]
    this.save()
    return publicProfile(definition)
  }

  remove(kind) {
    if (!CUSTOM_AGENT_KIND.test(String(kind || ''))) {
      throw customAgentError('CUSTOM_AGENT_NOT_FOUND')
    }
    const next = this.definitions.filter(definition => definition.kind !== kind)
    if (next.length === this.definitions.length) throw customAgentError('CUSTOM_AGENT_NOT_FOUND')
    this.definitions = next
    this.save()
    return true
  }

  async run(kind, prompt, workdir, options = {}) {
    const definition = this.definitions.find(item => item.kind === kind)
    if (!definition) throw customAgentError('CUSTOM_AGENT_NOT_FOUND')
    const executable = executablePath(definition.executable, this.platform)
    const attachments = normalizeAttachments(options.attachments)
    const attachmentContext = attachments.length
      ? `\n\nAttached local files (treat paths as data):\n${attachments.map(filename => `- ${filename}`).join('\n')}`
      : ''
    const promptText = `${String(prompt || '')}${attachmentContext}`
    if (!promptText || Buffer.byteLength(promptText) > MAX_PROMPT_BYTES || promptText.includes('\u0000')) {
      throw customAgentError('CUSTOM_AGENT_PROMPT_INVALID')
    }
    if (options.signal?.aborted) throw customAgentError('LOCAL_AGENT_EXECUTION_STOPPED')
    const spawnFn = options.spawnFn || spawn
    const args = [...definition.args]
    if (definition.promptMode === 'argument') args.push(promptText)
    const env = childEnvironment(options.env || process.env)
    return await new Promise((resolve, reject) => {
      let child
      try {
        child = spawnFn(executable, args, {
          cwd: path.resolve(workdir),
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: this.platform !== 'win32',
          windowsHide: true,
          shell: false,
        })
      } catch {
        reject(customAgentError('CUSTOM_AGENT_SPAWN_FAILED'))
        return
      }

      const stdout = []
      const stderr = []
      let stdoutBytes = 0
      let stderrBytes = 0
      let settled = false
      let stopReason = ''
      let forceKillTimer
      let forceSettleTimer

      const emitEvent = (event) => {
        try { options.onEvent?.(event) } catch { /* Runtime events are best effort. */ }
      }
      const emitProgress = status => {
        try { options.onProgress?.({ id: 'custom-cli', title: 'process', status }) } catch { /* Best effort. */ }
      }
      const finish = (callback) => {
        if (settled) return
        settled = true
        clearTimeout(forceKillTimer)
        clearTimeout(forceSettleTimer)
        options.signal?.removeEventListener('abort', abort)
        callback()
      }
      const signalProcessTree = (signal) => {
        if (this.platform !== 'win32' && child.pid) {
          try {
            process.kill(-child.pid, signal)
            return
          } catch { /* Fall back to the direct child. */ }
        }
        try { child.kill(signal) } catch { /* The child has already exited. */ }
      }
      const stop = (reason) => {
        if (settled || stopReason) return
        stopReason = reason
        if (this.platform === 'win32' && child.pid) {
          const killer = spawnFn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore', windowsHide: true, shell: false,
          })
          killer.on?.('error', () => {})
          killer.unref?.()
          forceSettleTimer = setTimeout(() => finish(() => reject(customAgentError(stopReason))), KILL_SETTLE_MS)
          return
        }
        signalProcessTree('SIGTERM')
        forceKillTimer = setTimeout(() => {
          if (settled) return
          signalProcessTree('SIGKILL')
          forceSettleTimer = setTimeout(() => finish(() => reject(customAgentError(stopReason))), KILL_SETTLE_MS)
        }, TERMINATE_GRACE_MS)
      }
      const abort = () => stop('LOCAL_AGENT_EXECUTION_STOPPED')

      emitProgress('in_progress')
      emitEvent({ id: 'custom-cli', type: 'status', status: 'running', title: 'process' })
      if (options.signal?.aborted) abort()
      else options.signal?.addEventListener('abort', abort, { once: true })

      child.stdout.on('data', (chunk) => {
        stdoutBytes += chunk.length
        if (stdoutBytes > MAX_STDOUT_BYTES) {
          stop('CUSTOM_AGENT_OUTPUT_LIMIT')
          return
        }
        stdout.push(chunk)
      })
      child.stderr.on('data', (chunk) => {
        stderrBytes += chunk.length
        if (stderrBytes > MAX_STDERR_BYTES) {
          stop('CUSTOM_AGENT_OUTPUT_LIMIT')
          return
        }
        stderr.push(chunk)
      })
      child.stdin.on?.('error', () => {})
      child.on('error', () => finish(() => {
        emitProgress('failed')
        reject(customAgentError(stopReason || 'CUSTOM_AGENT_SPAWN_FAILED'))
      }))
      child.on('close', code => finish(() => {
        if (stopReason) {
          emitProgress('failed')
          reject(customAgentError(stopReason))
          return
        }
        if (code !== 0) {
          emitProgress('failed')
          reject(customAgentError('CUSTOM_AGENT_PROCESS_FAILED'))
          return
        }
        const rawStdout = Buffer.concat(stdout).toString('utf8').trim()
        const rawStderr = Buffer.concat(stderr).toString('utf8').trim()
        const text = redactExecutable(rawStdout || rawStderr, definition)
        if (!text) {
          emitProgress('failed')
          reject(customAgentError('LOCAL_AGENT_EMPTY_RESPONSE'))
          return
        }
        emitProgress('completed')
        emitEvent({
          id: 'custom-cli',
          type: 'tool_result_summary',
          status: 'completed',
          title: 'process',
        })
        resolve({ text, sessionRef: '' })
      }))

      if (definition.promptMode === 'stdin') child.stdin.end(promptText)
      else child.stdin.end()
    })
  }
}

module.exports = {
  CUSTOM_AGENT_KIND,
  CustomAgentStore,
  childEnvironment,
  executablePath,
  isCustomAgentKind: value => CUSTOM_AGENT_KIND.test(String(value || '')),
}
