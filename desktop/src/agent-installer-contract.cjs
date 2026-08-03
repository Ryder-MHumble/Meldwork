const { execFile } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { promisify } = require('node:util')
const { searchPath } = require('./cli-adapters.cjs')

const execFileAsync = promisify(execFile)
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
    kind: 'mimo', label: 'MiMo Code', recommended: false, providerCompatible: false,
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
    kind: 'gemini', label: 'Gemini CLI', recommended: false, providerCompatible: false,
    providerSupport: 'native-config',
  },
  {
    kind: 'opencode', label: 'OpenCode', recommended: false, providerCompatible: false,
    providerSupport: 'native-config',
  },
  {
    kind: 'qwen', label: 'Qwen Code', recommended: false, providerCompatible: true,
    providerSupport: 'supported',
  },
  {
    kind: 'opencodereview', label: 'OpenCodeReview', recommended: false, providerCompatible: true,
    providerSupport: 'supported',
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
    mimo: '@mimo-ai/cli@latest',
    opencodereview: '@alibaba-group/open-code-review@latest',
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

function abortable(task, signal) {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (callback) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      callback()
    }
    const abort = () => settle(() => reject(abortError()))
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(task).then(
      value => settle(() => resolve(value)),
      error => settle(() => reject(error)),
    )
    if (signal.aborted) abort()
  })
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

module.exports = {
  AGENT_CATALOG,
  DETECTION_CACHE_TTL_MS,
  abortError,
  abortable,
  defaultFindCommand,
  installEnvironment,
  installRecipe,
  installerError,
  prepareInstallCommand,
  publicState,
  validateInstallCommand,
  validateScriptUrl,
  verifiedAgent,
}
