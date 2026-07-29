const { execFile, spawn } = require('node:child_process')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const https = require('node:https')
const os = require('node:os')
const path = require('node:path')
const { promisify } = require('node:util')
const { randomUUID } = require('node:crypto')
const { searchPath } = require('./cli-adapters.cjs')

const execFileAsync = promisify(execFile)
const MAX_SCRIPT_BYTES = 4 * 1024 * 1024
const TERMINATE_GRACE_MS = 500
const KILL_SETTLE_MS = 500
const DETECTION_CACHE_TTL_MS = 3000
const SENSITIVE_INSTALL_ENV_KEY = /api[_-]?key|token|secret|password|passwd|credential|authorization|cookie|prompt/i
const ALLOWED_SCRIPT_HOSTS = new Set([
  'hermes-agent.nousresearch.com',
  'code.kimi.com',
  'cdn.kimi.com',
])

const AGENT_CATALOG = Object.freeze([
  {
    kind: 'hermes', label: 'Hermes', recommended: true, providerCompatible: true,
    providerSupport: 'supported',
  },
  {
    kind: 'openclaw', label: 'OpenClaw', recommended: true, providerCompatible: true,
    providerSupport: 'supported',
  },
  {
    kind: 'workbuddy', label: 'WorkBuddy', recommended: true, providerCompatible: true,
    providerSupport: 'experimental',
  },
  {
    kind: 'kimi', label: 'Kimi Code', recommended: false, providerCompatible: false,
    providerSupport: 'native-config',
  },
  {
    kind: 'codex', label: 'Codex', recommended: false, providerCompatible: false,
    providerSupport: 'responses-required',
  },
  {
    kind: 'claude', label: 'Claude Code', recommended: false, providerCompatible: false,
    providerSupport: 'anthropic-required',
  },
  {
    kind: 'qwen', label: 'Qwen Code', recommended: false, providerCompatible: true,
    providerSupport: 'supported',
  },
  {
    kind: 'gemini', label: 'Gemini CLI', recommended: false, providerCompatible: false,
    providerSupport: 'native-config',
  },
  {
    kind: 'opencode', label: 'OpenCode', recommended: false, providerCompatible: false,
    providerSupport: 'native-config',
  },
])

function installRecipe(kind, platform) {
  if (!['darwin', 'win32'].includes(platform)) return null
  if (kind === 'hermes') {
    return platform === 'win32'
      ? {
          type: 'script',
          url: 'https://hermes-agent.nousresearch.com/install.ps1',
          interpreter: 'powershell.exe',
          args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '$SCRIPT',
            '-NonInteractive', '-SkipSetup'],
        }
      : {
          type: 'script',
          url: 'https://hermes-agent.nousresearch.com/install.sh',
          interpreter: '/bin/bash',
          args: ['$SCRIPT', '--non-interactive', '--skip-setup'],
        }
  }
  if (kind === 'kimi') {
    return platform === 'win32'
      ? {
          type: 'script',
          url: 'https://code.kimi.com/kimi-code/install.ps1',
          interpreter: 'powershell.exe',
          args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '$SCRIPT'],
        }
      : {
          type: 'script',
          url: 'https://code.kimi.com/kimi-code/install.sh',
          interpreter: '/bin/bash',
          args: ['$SCRIPT'],
        }
  }
  const packages = {
    codex: '@openai/codex@latest',
    claude: '@anthropic-ai/claude-code@latest',
    openclaw: 'openclaw@latest',
    qwen: '@qwen-code/qwen-code@latest',
    workbuddy: '@tencent-ai/codebuddy-code@2.115.0',
    gemini: '@google/gemini-cli@latest',
    opencode: 'opencode-ai@latest',
  }
  return packages[kind] ? { type: 'npm', packageName: packages[kind] } : null
}

function publicState(state) {
  return {
    taskId: state.taskId || '',
    kind: state.kind || '',
    phase: state.phase || 'idle',
    canCancel: Boolean(state.canCancel),
    errorCode: state.errorCode || '',
  }
}

function installerError(code) {
  return Object.assign(new Error(code), { code })
}

function abortError() {
  return Object.assign(new Error('cancelled'), { name: 'AbortError' })
}

function validateScriptUrl(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw installerError('INSTALL_AGENT_DOWNLOAD_BLOCKED')
  }
  if (parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.port
    || !ALLOWED_SCRIPT_HOSTS.has(parsed.hostname)) {
    throw installerError('INSTALL_AGENT_DOWNLOAD_BLOCKED')
  }
  return parsed
}

function validateInstallCommand(command, recipe, platform) {
  let allowed = false
  if (recipe.type === 'script') {
    const expected = platform === 'win32' ? 'powershell.exe' : '/bin/bash'
    allowed = recipe.interpreter === expected && command === expected
  } else if (recipe.type === 'npm') {
    const pathApi = platform === 'win32' ? path.win32 : path.posix
    const expected = platform === 'win32' ? 'npm.cmd' : 'npm'
    const basename = pathApi.basename(command)
    allowed = pathApi.isAbsolute(command)
      && (platform === 'win32'
        ? basename.toLowerCase() === expected
        : basename === expected)
  }
  if (!allowed) throw installerError('INSTALL_AGENT_COMMAND_BLOCKED')
}

function prepareInstallCommand(command, args, {
  platform = process.platform,
  readFileFn = filename => fs.readFileSync(filename, 'utf8'),
  existsFn = fs.existsSync,
} = {}) {
  if (platform !== 'win32') return { command, args }
  if (!path.win32.isAbsolute(command)
    || path.win32.basename(command).toLowerCase() !== 'npm.cmd') {
    throw installerError('INSTALL_AGENT_COMMAND_BLOCKED')
  }

  let source
  try {
    source = String(readFileFn(command))
  } catch {
    throw installerError('INSTALL_AGENT_COMMAND_BLOCKED')
  }
  if (!/%(?:dp0%|~dp0)[\\/]?node_modules[\\/]npm[\\/]bin[\\/]npm-cli\.js/i
    .test(source)) {
    throw installerError('INSTALL_AGENT_COMMAND_BLOCKED')
  }

  const directory = path.win32.dirname(command)
  const npmCli = path.win32.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const bundledNode = path.win32.join(directory, 'node.exe')
  if (!existsFn(npmCli)) throw installerError('INSTALL_AGENT_COMMAND_BLOCKED')
  return {
    command: existsFn(bundledNode) ? bundledNode : 'node.exe',
    args: [npmCli, ...args],
  }
}

function installEnvironment(platform, sourceEnv, home) {
  const env = Object.fromEntries(
    Object.entries(sourceEnv).filter(([key]) => (
      key.toLowerCase() !== 'path' && !SENSITIVE_INSTALL_ENV_KEY.test(key)
    )),
  )
  env.PATH = searchPath({ platform, env: sourceEnv, home })
  return env
}

function defaultFindCommand(command, platform = process.platform, options = {}) {
  const executable = platform === 'win32' ? 'where.exe' : '/usr/bin/which'
  const sourceEnv = options.env || process.env
  const lookup = options.execFileFn || execFileAsync
  return lookup(executable, [command], {
    timeout: 5000,
    windowsHide: true,
    env: installEnvironment(platform, sourceEnv, options.home),
  })
    .then(({ stdout }) => String(stdout || '').trim().split(/\r?\n/)[0] || '')
    .catch(() => '')
}

function verifiedAgent(agent) {
  return Boolean(agent?.kind && String(agent.version || '').trim())
}

function downloadResponse(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const parsed = validateScriptUrl(url)
    const request = https.get(parsed, { timeout: 30000 }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume()
        if (redirects >= 3 || !response.headers.location) {
          reject(installerError('INSTALL_AGENT_DOWNLOAD_FAILED'))
          return
        }
        let next
        try {
          next = new URL(response.headers.location, parsed).toString()
        } catch {
          reject(installerError('INSTALL_AGENT_DOWNLOAD_FAILED'))
          return
        }
        downloadResponse(next, redirects + 1).then(resolve, reject)
        return
      }
      if (response.statusCode !== 200) {
        response.resume()
        reject(installerError('INSTALL_AGENT_DOWNLOAD_FAILED'))
        return
      }
      resolve(response)
    })
    request.on('timeout', () => request.destroy(installerError('INSTALL_AGENT_DOWNLOAD_FAILED')))
    request.on('error', error => reject(
      String(error?.code || '').startsWith('INSTALL_AGENT_')
        ? error
        : installerError('INSTALL_AGENT_DOWNLOAD_FAILED'),
    ))
  })
}

async function defaultDownloadScript(url, signal) {
  if (signal?.aborted) throw abortError()
  const parsed = validateScriptUrl(url)
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'roundrelay-agent-install-'))
  const extension = parsed.pathname.endsWith('.ps1') ? '.ps1' : '.sh'
  const target = path.join(directory, `installer${extension}`)
  let bytes = 0
  const chunks = []
  let response
  const abort = () => response?.destroy(abortError())
  try {
    response = await downloadResponse(url)
    if (signal?.aborted) throw abortError()
    signal?.addEventListener('abort', abort, { once: true })
    for await (const chunk of response) {
      bytes += chunk.length
      if (bytes > MAX_SCRIPT_BYTES) throw installerError('INSTALL_AGENT_DOWNLOAD_FAILED')
      chunks.push(chunk)
    }
    await fs.promises.writeFile(target, Buffer.concat(chunks), { mode: 0o700 })
    return target
  } catch (error) {
    await fs.promises.rm(directory, { recursive: true, force: true })
    if (error?.name === 'AbortError'
      || String(error?.code || '').startsWith('INSTALL_AGENT_')) throw error
    throw installerError('INSTALL_AGENT_DOWNLOAD_FAILED')
  } finally {
    signal?.removeEventListener('abort', abort)
  }
}

async function defaultRemoveDownload(target) {
  if (!target) return
  const directory = path.dirname(target)
  if (!path.basename(directory).startsWith('roundrelay-agent-install-')) return
  await fs.promises.rm(directory, { recursive: true, force: true })
}

function defaultRunProcess(command, args, {
  signal,
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  spawnFn = spawn,
} = {}) {
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, args, {
      env: installEnvironment(platform, env, home),
      shell: false,
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
      detached: platform !== 'win32',
    })
    let settled = false
    let stopRequested = false
    let forceKillTimeout
    let forceSettleTimeout
    const finish = callback => {
      if (settled) return
      settled = true
      clearTimeout(forceKillTimeout)
      clearTimeout(forceSettleTimeout)
      signal?.removeEventListener('abort', abort)
      callback()
    }
    const rejectCancelled = () => finish(() => reject(abortError()))
    const signalProcessTree = processSignal => {
      if (platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, processSignal)
          return
        } catch { /* fall back to the direct child */ }
      }
      try {
        child.kill(processSignal)
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
        forceSettleTimeout = setTimeout(rejectCancelled, KILL_SETTLE_MS)
        return
      }
      signalProcessTree('SIGTERM')
      forceKillTimeout = setTimeout(() => {
        if (settled) return
        signalProcessTree('SIGKILL')
        forceSettleTimeout = setTimeout(rejectCancelled, KILL_SETTLE_MS)
      }, TERMINATE_GRACE_MS)
    }
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    child.on('error', error => finish(() => reject(signal?.aborted ? abortError() : error)))
    child.on('close', code => finish(() => {
      if (signal?.aborted) reject(abortError())
      else if (code === 0) resolve()
      else reject(installerError('INSTALL_AGENT_PROCESS_FAILED'))
    }))
  })
}

class AgentInstaller extends EventEmitter {
  constructor({
    platform = process.platform,
    detectAgents,
    findCommand = command => defaultFindCommand(command, platform),
    downloadScript = defaultDownloadScript,
    removeDownload = defaultRemoveDownload,
    runProcess = defaultRunProcess,
    readCommandFile = filename => fs.readFileSync(filename, 'utf8'),
    commandPathExists = fs.existsSync,
    createId = randomUUID,
    now = Date.now,
  }) {
    super()
    this.platform = platform
    this.detectAgents = detectAgents
    this.findCommand = findCommand
    this.downloadScript = downloadScript
    this.removeDownload = removeDownload
    this.runProcess = runProcess
    this.readCommandFile = readCommandFile
    this.commandPathExists = commandPathExists
    this.createId = createId
    this.now = now
    this.current = publicState({})
    this.controller = null
    this.running = null
    this.detectionCache = null
    this.detectionCacheExpiresAt = 0
    this.detectionGeneration = 0
    this.detectionTask = null
  }

  state() {
    return publicState(this.current)
  }

  setState(next) {
    this.current = publicState({ ...this.current, ...next })
    this.emit('changed', this.state())
  }

  invalidateDetectionCache() {
    this.detectionGeneration += 1
    this.detectionCache = null
    this.detectionCacheExpiresAt = 0
    this.detectionTask = null
  }

  detectedAgents() {
    if (this.detectionCache && this.now() < this.detectionCacheExpiresAt) {
      return Promise.resolve(this.detectionCache)
    }
    if (this.detectionTask) return this.detectionTask

    const generation = this.detectionGeneration
    const task = Promise.resolve().then(() => this.detectAgents()).then((agents) => {
      if (this.detectionGeneration !== generation) return this.detectedAgents()
      this.detectionCache = agents
      this.detectionCacheExpiresAt = this.now() + DETECTION_CACHE_TTL_MS
      return agents
    }).finally(() => {
      if (this.detectionTask === task) this.detectionTask = null
    })
    this.detectionTask = task
    return task
  }

  async catalog() {
    const installed = new Map((await this.detectedAgents())
      .filter(verifiedAgent).map(agent => [agent.kind, agent]))
    const npm = await this.findCommand(this.platform === 'win32' ? 'npm.cmd' : 'npm')
    return {
      platform: this.platform,
      agents: AGENT_CATALOG.map(profile => {
        const agent = installed.get(profile.kind)
        const recipe = installRecipe(profile.kind, this.platform)
        let installSupported = Boolean(recipe)
        let installErrorCode = ''
        if (!recipe) {
          installSupported = false
          installErrorCode = 'INSTALL_AGENT_PLATFORM_UNSUPPORTED'
        } else if (recipe.type === 'npm' && !npm) {
          installSupported = false
          installErrorCode = 'INSTALL_AGENT_NODE_REQUIRED'
        }
        return {
          ...profile,
          installed: Boolean(agent),
          version: agent?.version || '',
          installSupported,
          installErrorCode,
        }
      }),
    }
  }

  async start(kind) {
    if (this.running) throw installerError('INSTALL_AGENT_BUSY')
    const profile = AGENT_CATALOG.find(agent => agent.kind === kind)
    if (!profile) throw installerError('INSTALL_AGENT_UNSUPPORTED')
    const recipe = installRecipe(kind, this.platform)
    if (!recipe) {
      throw installerError('INSTALL_AGENT_PLATFORM_UNSUPPORTED')
    }
    const installed = await this.detectAgents()
    if (installed.some(agent => agent.kind === kind && verifiedAgent(agent))) {
      throw installerError('INSTALL_AGENT_ALREADY_INSTALLED')
    }
    let command = recipe.interpreter || ''
    if (recipe.type === 'npm') {
      command = await this.findCommand(this.platform === 'win32' ? 'npm.cmd' : 'npm')
      if (!command) throw installerError('INSTALL_AGENT_NODE_REQUIRED')
    }
    validateInstallCommand(command, recipe, this.platform)

    const taskId = this.createId()
    this.controller = new AbortController()
    this.setState({ taskId, kind, phase: 'checking', canCancel: true, errorCode: '' })
    this.running = this.runInstall({ profile, recipe, command, signal: this.controller.signal })
      .finally(() => {
        this.controller = null
        this.running = null
      })
    return this.state()
  }

  async runInstall({ profile, recipe, command, signal }) {
    let downloaded = ''
    try {
      let args
      if (recipe.type === 'script') {
        this.setState({ phase: 'downloading' })
        validateScriptUrl(recipe.url)
        try {
          downloaded = await this.downloadScript(recipe.url, signal)
        } catch (error) {
          if (signal.aborted || error?.name === 'AbortError') throw error
          if (['INSTALL_AGENT_DOWNLOAD_BLOCKED', 'INSTALL_AGENT_DOWNLOAD_FAILED']
            .includes(error?.code)) throw error
          throw installerError('INSTALL_AGENT_DOWNLOAD_FAILED')
        }
        args = recipe.args.map(value => value === '$SCRIPT' ? downloaded : value)
      } else {
        args = ['install', '--global', recipe.packageName]
      }
      const prepared = recipe.type === 'npm'
        ? prepareInstallCommand(command, args, {
            platform: this.platform,
            readFileFn: this.readCommandFile,
            existsFn: this.commandPathExists,
          })
        : { command, args }
      this.setState({ phase: 'installing' })
      await this.runProcess(prepared.command, prepared.args, { signal, platform: this.platform })
      this.setState({ phase: 'verifying', canCancel: false })
      const installed = await this.detectAgents()
      if (!installed.some(agent => agent.kind === profile.kind && verifiedAgent(agent))) {
        throw installerError('INSTALL_AGENT_VERIFY_FAILED')
      }
      this.invalidateDetectionCache()
      this.setState({ phase: 'completed', canCancel: false })
    } catch (error) {
      if (signal.aborted || error?.name === 'AbortError') {
        this.setState({ phase: 'cancelled', canCancel: false, errorCode: '' })
      } else {
        this.setState({
          phase: 'failed',
          canCancel: false,
          errorCode: String(error?.code || '').startsWith('INSTALL_AGENT_')
            ? error.code
            : 'INSTALL_AGENT_FAILED',
        })
      }
    } finally {
      await this.removeDownload(downloaded).catch(() => {})
    }
  }

  cancel(taskId) {
    if (!this.running || !this.controller || taskId !== this.current.taskId) return false
    this.controller.abort()
    return true
  }

  waitForIdle() {
    return this.running || Promise.resolve()
  }
}

module.exports = {
  AgentInstaller,
  defaultFindCommand,
  defaultRunProcess,
  installRecipe,
  prepareInstallCommand,
  validateScriptUrl,
}
