const AGENT_OUTCOMES = Object.freeze([
  'accepted',
  'running',
  'waiting_input',
  'waiting_permission',
  'partial',
  'completed',
  'failed',
  'cancelled',
])

const OUTCOME_SET = new Set(AGENT_OUTCOMES)
const NON_TERMINAL_OUTCOMES = new Set([
  'accepted', 'running', 'waiting_input', 'waiting_permission',
])
const SUCCESSFUL_OUTCOMES = new Set(['partial', 'completed'])
const EXTERNAL_RUN_REF = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,255}$/

const AGENT_RUNTIME_CAPABILITIES = Object.freeze({
  codex: { task: 'general', resumable: true },
  hermes: { task: 'general', resumable: true },
  openclaw: { task: 'general', resumable: true },
  workbuddy: { task: 'general', resumable: true },
  kimi: { task: 'general', resumable: true },
  mimo: { task: 'general', resumable: true },
  claude: { task: 'general', resumable: true },
  gemini: { task: 'general', resumable: true },
  opencode: { task: 'general', resumable: true },
  qwen: { task: 'general', resumable: true },
  opencodereview: { task: 'code_review', resumable: false },
})

function normalizeOutcome(value) {
  const outcome = String(value || '')
  return OUTCOME_SET.has(outcome) ? outcome : ''
}

function normalizeExternalRunRef(value) {
  const ref = String(value || '')
  return EXTERNAL_RUN_REF.test(ref) ? ref : ''
}

function failureCategory(code) {
  const value = String(code || '')
  if (value === 'LOCAL_AGENT_SESSION_INVALID') return 'session'
  if (value === 'LOCAL_AGENT_AUTH_REQUIRED') return 'authentication'
  if (value === 'LOCAL_AGENT_TIMEOUT') return 'timeout'
  if (value === 'LOCAL_AGENT_EXECUTION_STOPPED') return 'cancellation'
  if (value === 'LOCAL_AGENT_REFUSED') return 'refusal'
  if (/SPAWN|EXITED|PROCESS|OUTCOME|PROTOCOL|EMPTY_RESPONSE/.test(value)) return 'protocol'
  return 'execution'
}

function agentRuntimeFailure(code, options = {}) {
  const normalizedCode = String(code || 'LOCAL_AGENT_UNKNOWN_FAILURE')
  const category = String(options.category || failureCategory(normalizedCode))
  return Object.freeze({
    code: normalizedCode,
    category,
    retryable: options.retryable === true
      || normalizedCode === 'LOCAL_AGENT_SESSION_INVALID',
    sessionInvalid: normalizedCode === 'LOCAL_AGENT_SESSION_INVALID',
  })
}

function agentRuntimeError(code, diagnostic = '', options = {}) {
  const failure = agentRuntimeFailure(code, options)
  const error = Object.assign(new Error(failure.code), { code: failure.code })
  Object.defineProperty(error, 'failure', {
    value: failure,
    enumerable: false,
    configurable: true,
  })
  const detail = String(diagnostic || '').trim()
  if (detail) {
    Object.defineProperty(error, 'diagnostic', {
      value: detail,
      enumerable: false,
      configurable: true,
    })
  }
  return error
}

function outcomeForAcpStopReason(stopReason) {
  if (stopReason === 'end_turn') return { outcome: 'completed' }
  if (['max_tokens', 'max_turn_requests'].includes(stopReason)) {
    return { outcome: 'partial' }
  }
  if (stopReason === 'cancelled') return { outcome: 'cancelled' }
  if (stopReason === 'refusal') {
    return {
      outcome: 'failed',
      failure: agentRuntimeFailure('LOCAL_AGENT_REFUSED'),
    }
  }
  return {
    outcome: 'failed',
    failure: agentRuntimeFailure('LOCAL_AGENT_OUTCOME_INVALID'),
  }
}

function normalizeAgentResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw agentRuntimeError('LOCAL_AGENT_OUTCOME_INVALID')
  }
  const outcome = normalizeOutcome(result.outcome)
  if (!outcome) throw agentRuntimeError('LOCAL_AGENT_OUTCOME_MISSING')
  return { ...result, outcome }
}

function requireTerminalAgentResult(result) {
  const normalized = normalizeAgentResult(result)
  if (NON_TERMINAL_OUTCOMES.has(normalized.outcome)) {
    throw agentRuntimeError('LOCAL_AGENT_OUTCOME_NON_TERMINAL', normalized.outcome)
  }
  if (normalized.outcome === 'cancelled') {
    throw agentRuntimeError('LOCAL_AGENT_EXECUTION_STOPPED')
  }
  if (normalized.outcome === 'failed') {
    const failure = normalized.failure?.code
      ? normalized.failure
      : agentRuntimeFailure('LOCAL_AGENT_PROCESS_FAILED')
    throw agentRuntimeError(
      failure.code,
      normalized.diagnostic || normalized.text,
      failure,
    )
  }
  return normalized
}

function agentRuntimeCapabilities(kind) {
  return AGENT_RUNTIME_CAPABILITIES[kind]
    || { task: 'general', resumable: false }
}

function isReviewOnlyAgentKind(kind) {
  return agentRuntimeCapabilities(kind).task === 'code_review'
}

module.exports = {
  AGENT_OUTCOMES,
  AGENT_RUNTIME_CAPABILITIES,
  NON_TERMINAL_OUTCOMES,
  SUCCESSFUL_OUTCOMES,
  agentRuntimeCapabilities,
  agentRuntimeError,
  agentRuntimeFailure,
  isReviewOnlyAgentKind,
  normalizeAgentResult,
  normalizeExternalRunRef,
  normalizeOutcome,
  outcomeForAcpStopReason,
  requireTerminalAgentResult,
}
