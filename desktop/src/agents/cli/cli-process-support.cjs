const path = require('node:path')
const { searchPath, systemChildEnvironment } = require('./cli-discovery.cjs')
const { networkEnvironment } = require('./cli-network-environment.cjs')
const { redactChildSecrets } = require('./cli-runtime-events.cjs')
const { agentRuntimeError, terminalAuthenticationDiagnostic } = require('../agent-runtime-contract.cjs')
const { validateOpenClawRuntimeGuard } = require('./openclaw-runtime.cjs')

const TERMINATE_GRACE_MS = 500
const KILL_SETTLE_MS = 500
const OPENCODE_READ_ONLY_PERMISSION = JSON.stringify({
  '*': 'deny',
  read: 'allow',
  glob: 'allow',
  grep: 'allow',
  list: 'allow',
  webfetch: 'allow',
  websearch: 'allow',
})
const OPENCLAW_RUNTIME_PATH_KEYS = Object.freeze([
  'OPENCLAW_HOME',
  'OPENCLAW_STATE_DIR',
  'OPENCLAW_CONFIG_PATH',
  'OPENCLAW_WORKSPACE_DIR',
])

function agentExecutionError(code, diagnostic = '') {
  return agentRuntimeError(code, diagnostic)
}

function authConfigurationFailure(detail) {
  return String(detail || '').split(/\r?\n/).some((line) => {
    const text = line.trim().replace(/^(?:error|fatal)\s*:\s*/i, '')
    return Boolean(terminalAuthenticationDiagnostic(text))
      || /^(?:(?:invalid|expired|missing|incorrect)\s+(?:api[ _-]?key|(?:access|refresh|auth)[ _-]?token|credentials?)\b|(?:authentication|authorization)\s+(?:failed|required)\b|(?:please\s+)?(?:log|sign)\s+in\b|not\s+logged\s+in\b|select an auth type\b|provider rejected\b)/i.test(text)
      || /^(?:认证|鉴权|登录)(?:失败|过期)|^(?:令牌|凭据|密钥)(?:无效|缺失|已过期)|^请(?:先|重新)登录/.test(text)
  })
}

function invalidSessionFailure(detail) {
  const text = String(detail || '').trim()
  if (!text || authConfigurationFailure(text)
      || /\b(?:api|access|refresh|auth|session)[ _-]?token\b/i.test(text)) return false
  return /\b(?:no|unknown|invalid|expired|missing|stale)\s+(?:saved\s+)?(?:session|conversation|thread)\b|\b(?:session|conversation|thread)(?:\s+(?:id|key|reference))?\b[^\n]{0,100}\b(?:not found|does not exist|no longer exists|invalid|unknown|expired|has expired|was deleted|cannot be resumed)\b/i
    .test(text)
}

function failedAgentProcessError(detail, options = {}) {
  if (!detail) return agentExecutionError('LOCAL_AGENT_EXITED')
  return agentExecutionError(
    options.sessionRef && invalidSessionFailure(detail)
      ? 'LOCAL_AGENT_SESSION_INVALID'
      : authConfigurationFailure(detail)
        ? 'LOCAL_AGENT_AUTH_REQUIRED'
        : 'LOCAL_AGENT_PROCESS_FAILED',
    detail,
  )
}

function openClawChildEnvironment(workdir, options, platform) {
  const source = options.env || {}
  const guard = options.openClawRuntimeGuard
  if (!guard) throw new Error('OPENCLAW_RUNTIME_GUARD_REQUIRED')
  validateOpenClawRuntimeGuard(guard, source)
  if (source.OPENCLAW_WORKSPACE_DIR !== path.resolve(workdir)) {
    throw new Error('OPENCLAW_RUNTIME_UNSAFE_PATH')
  }

  const env = {
    ...systemChildEnvironment(process.env, platform),
    ...networkEnvironment(source, platform),
  }
  for (const key of [
    'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME',
    'XDG_RUNTIME_DIR', 'APPDATA', 'LOCALAPPDATA',
  ]) {
    delete env[key]
  }

  for (const key of OPENCLAW_RUNTIME_PATH_KEYS) env[key] = source[key]
  for (const key of guard.credentialKeys) env[key] = source[key]
  const isolatedHome = source.OPENCLAW_HOME
  env.HOME = isolatedHome
  env.USERPROFILE = isolatedHome
  env.XDG_CONFIG_HOME = path.join(isolatedHome, '.config')
  env.XDG_DATA_HOME = path.join(isolatedHome, '.local', 'share')
  env.XDG_STATE_HOME = path.join(isolatedHome, '.local', 'state')
  env.XDG_CACHE_HOME = path.join(isolatedHome, '.cache')
  env.XDG_RUNTIME_DIR = path.join(isolatedHome, '.runtime')
  env.TMPDIR = env.XDG_RUNTIME_DIR
  env.TMP = env.XDG_RUNTIME_DIR
  env.TEMP = env.XDG_RUNTIME_DIR
  env.OPENCLAW_DISABLE_BONJOUR = '1'
  env.APPDATA = path.join(isolatedHome, 'AppData', 'Roaming')
  env.LOCALAPPDATA = path.join(isolatedHome, 'AppData', 'Local')
  env.PATH = searchPath({ platform })
  return env
}

function childEnvironment(agent, workdir, options, platform) {
  if (agent.kind === 'openclaw') {
    return openClawChildEnvironment(workdir, options, platform)
  }
  const hermesSafetyEnv = agent.kind === 'hermes'
    ? options.sandbox === 'workspace-write'
      ? { HERMES_EXEC_ASK: '', HERMES_YOLO_MODE: '1' }
      : { HERMES_EXEC_ASK: '1', HERMES_YOLO_MODE: '' }
    : {}
  const openCodeSafetyEnv = agent.kind === 'opencode'
      && options.sandbox !== 'workspace-write'
    ? { OPENCODE_PERMISSION: OPENCODE_READ_ONLY_PERMISSION }
    : {}
  const source = { ...process.env, ...options.env }
  return {
    ...systemChildEnvironment(process.env, platform),
    ...options.env,
    ...hermesSafetyEnv,
    ...openCodeSafetyEnv,
    PATH: searchPath({ platform, env: source }),
  }
}

module.exports = {
  KILL_SETTLE_MS,
  TERMINATE_GRACE_MS,
  agentExecutionError,
  childEnvironment,
  failedAgentProcessError,
  invalidSessionFailure,
}
