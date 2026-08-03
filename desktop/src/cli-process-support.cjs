const path = require('node:path')
const { searchPath, systemChildEnvironment } = require('./cli-discovery.cjs')
const { redactChildSecrets } = require('./cli-runtime-events.cjs')

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

module.exports = {
  KILL_SETTLE_MS,
  TERMINATE_GRACE_MS,
  agentExecutionError,
  childEnvironment,
  failedAgentProcessError,
}
