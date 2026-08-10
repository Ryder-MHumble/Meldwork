const FAILURE_CATEGORIES = Object.freeze([
  'authentication',
  'compatibility',
  'session',
  'rate_limit',
  'network',
  'provider',
  'timeout',
  'cancellation',
  'permission',
  'budget',
  'protocol',
  'execution',
])

const FAILURE_CATEGORY_SET = new Set(FAILURE_CATEGORIES)
const ATTEMPT_PHASES = Object.freeze([
  'initial',
  'automatic_retry',
  'transient_retry',
  'recovery_agent',
  'post_recovery_verify',
  'manual_retry',
])
const ATTEMPT_POLICY_ACTIONS = Object.freeze([
  'complete',
  'retry',
  'refresh_session',
  'recover',
  'verify',
  'remove_agent',
  'replace_agent',
  'human_gate',
  'fail',
  'cancel',
])
const ATTEMPT_FINAL_OUTCOMES = Object.freeze([
  'succeeded',
  'failed',
  'cancelled',
  'removed',
  'replaced',
])
const ATTEMPT_PHASE_SET = new Set(ATTEMPT_PHASES)
const ATTEMPT_POLICY_ACTION_SET = new Set(ATTEMPT_POLICY_ACTIONS)
const ATTEMPT_FINAL_OUTCOME_SET = new Set(ATTEMPT_FINAL_OUTCOMES)
const FAILURE_OUTCOME_CERTAINTIES = Object.freeze([
  'not_started',
  'known_failed',
  'unknown_outcome',
])
const FAILURE_OUTCOME_CERTAINTY_SET = new Set(FAILURE_OUTCOME_CERTAINTIES)
const IDEMPOTENCY_MODES = Object.freeze(['none', 'durable'])
const IDEMPOTENCY_MODE_SET = new Set(IDEMPOTENCY_MODES)
const ATTEMPT_PUBLIC_ID = /^[A-Za-z0-9._:-]{1,120}$/
const MAX_ATTEMPT_HISTORY = 256
const NETWORK_CODES = new Set([
  'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETDOWN',
  'ENETUNREACH', 'ENOTFOUND', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN',
])

function boundedInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return fallback
  return Math.min(maximum, Math.floor(number))
}

function failureCode(error) {
  const candidates = [error?.failure?.code, error?.code, error?.message]
  for (const candidate of candidates) {
    const value = String(candidate || '')
    if (/^[A-Z][A-Z0-9_]{1,119}$/.test(value)) return value
  }
  return 'LOCAL_AGENT_UNKNOWN_FAILURE'
}

function httpStatus(error) {
  for (const candidate of [
    error?.statusCode,
    error?.status,
    error?.response?.status,
    error?.cause?.statusCode,
    error?.cause?.status,
  ]) {
    const value = Number(candidate)
    if (Number.isInteger(value) && value >= 100 && value <= 599) return value
  }
  return null
}

function headerValue(headers, name) {
  if (!headers) return null
  if (typeof headers.get === 'function') {
    const value = headers.get(name)
    return value == null ? null : value
  }
  const requested = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === requested) return value
  }
  return null
}

function parseRetryAfter(value, now = Date.now()) {
  const candidate = Array.isArray(value) ? value[0] : value
  if (candidate == null || candidate === '') return null
  const text = String(candidate).trim()
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    return boundedInteger(Number(text) * 1000, null)
  }
  const timestamp = Date.parse(text)
  if (!Number.isFinite(timestamp)) return null
  return Math.max(0, Math.floor(timestamp - Number(now)))
}

function retryAfterMs(error, now) {
  const direct = Number(error?.retryAfterMs)
  if (Number.isFinite(direct) && direct >= 0) return Math.floor(direct)
  for (const headers of [error?.response?.headers, error?.headers, error?.cause?.headers]) {
    const parsed = parseRetryAfter(headerValue(headers, 'retry-after'), now)
    if (parsed != null) return parsed
  }
  return null
}

function classifiedCategory(error, code, status) {
  const explicit = String(error?.failure?.category || '')
  if (FAILURE_CATEGORY_SET.has(explicit)) return explicit
  const detail = String(error?.diagnostic || error?.message || '')
  if (code === 'LOCAL_BUDGET_EXHAUSTED') return 'budget'
  if (/PERMISSION/.test(code)) return 'permission'
  if (code === 'LOCAL_AGENT_EXECUTION_STOPPED' || /CANCEL|ABORT/.test(code)) {
    return 'cancellation'
  }
  if (code === 'LOCAL_AGENT_SESSION_INVALID') return 'session'
  if (status === 401 || status === 403 || code === 'LOCAL_AGENT_AUTH_REQUIRED'
      || /unauthori[sz]ed|forbidden|invalid token/i.test(detail)) return 'authentication'
  if (status === 429 || /RATE_LIMIT|TOO_MANY_REQUESTS/.test(code)
      || /rate limit|too many requests/i.test(detail)) return 'rate_limit'
  if (NETWORK_CODES.has(code) || /NETWORK|CONNECTION/.test(code)
      || /socket hang up|temporary failure|network error/i.test(detail)) return 'network'
  if (status != null && status >= 500) return 'provider'
  if (code === 'LOCAL_AGENT_TIMEOUT' || code === 'ETIMEDOUT' || /TIMEOUT/.test(code)) {
    return 'timeout'
  }
  if (/INCOMPAT|UNSUPPORTED|PROTOCOL_UNAVAILABLE|REVIEW_ONLY|VERSION_MISMATCH/.test(code)) {
    return 'compatibility'
  }
  if (/SPAWN|EXITED|PROCESS|PROTOCOL|OUTCOME|OUTPUT_LIMIT|EMPTY_RESPONSE/.test(code)) {
    return 'protocol'
  }
  return 'execution'
}

function retryability(category, error) {
  if (category === 'session') return 'refresh_session'
  if (category === 'authentication') return 'never'
  if (category === 'compatibility') return 'never'
  if (['rate_limit', 'network', 'provider'].includes(category)) return 'retry'
  if (error?.failure?.retryable === true) return 'retry'
  return 'never'
}

function normalizeFailure(error, options = {}) {
  const now = typeof options.now === 'function' ? options.now() : (options.now ?? Date.now())
  const code = failureCode(error)
  const status = httpStatus(error)
  const category = classifiedCategory(error, code, status)
  const normalized = {
    code,
    category,
    retryability: retryability(category, error),
    httpStatus: status,
    retryAfterMs: retryAfterMs(error, now),
    fingerprint: `${category}:${code}:${status || 0}`,
  }
  return Object.freeze(normalized)
}

function normalizeFailureOutcome(error, options = {}) {
  const explicit = error?.invocationFailure && typeof error.invocationFailure === 'object'
    ? error.invocationFailure
    : (error?.failure && typeof error.failure === 'object' ? error.failure : {})
  const category = options.category || normalizeFailure(error, options).category
  const requestedCertainty = String(
    explicit.outcomeCertainty || options.outcomeCertainty || '',
  )
  const outcomeCertainty = FAILURE_OUTCOME_CERTAINTY_SET.has(requestedCertainty)
    ? requestedCertainty
    : (['rate_limit', 'network', 'provider', 'timeout'].includes(category)
        ? 'unknown_outcome'
        : 'known_failed')
  const operationId = String(explicit.operationId || options.operationId || '')
  const requestedMode = String(explicit.idempotencyMode || options.idempotencyMode || '')
  return Object.freeze({
    outcomeCertainty,
    sideEffectsPossible: outcomeCertainty === 'not_started'
      ? false
      : (explicit.sideEffectsPossible === true || options.sideEffectsPossible === true),
    operationId: ATTEMPT_PUBLIC_ID.test(operationId) ? operationId : '',
    idempotencyMode: IDEMPOTENCY_MODE_SET.has(requestedMode) ? requestedMode : 'none',
  })
}

function boundedBackoffDelay(failedAttempt, options = {}) {
  const attempt = Math.max(1, boundedInteger(failedAttempt, 1, 1000))
  const baseDelayMs = Math.max(1, boundedInteger(options.baseDelayMs, 250, 60 * 60 * 1000))
  const maxDelayMs = Math.max(
    baseDelayMs,
    boundedInteger(options.maxDelayMs, 10 * 1000, 24 * 60 * 60 * 1000),
  )
  const exponent = Math.min(30, attempt - 1)
  const rawDelay = Math.min(maxDelayMs, baseDelayMs * (2 ** exponent))
  if (typeof options.jitter !== 'function') return Math.floor(rawDelay)
  const jittered = Number(options.jitter(rawDelay, { attempt, baseDelayMs, maxDelayMs }))
  if (!Number.isFinite(jittered) || jittered < 0) return Math.floor(rawDelay)
  return Math.min(maxDelayMs, Math.floor(jittered))
}

function retryDecision(input, options = {}) {
  const failure = input?.category ? input : normalizeFailure(input, options)
  const attempt = Math.max(1, boundedInteger(options.attempt, 1, 1000))
  const defaultMaxAttempts = failure.retryability === 'refresh_session' ? 2 : 4
  const maxAttempts = Math.max(1, boundedInteger(
    options.maxAttempts, defaultMaxAttempts, 100,
  ))
  const base = {
    failure,
    attempt,
    maxAttempts,
    delayMs: 0,
  }
  if (failure.retryability === 'never') {
    return Object.freeze({ ...base, action: 'fail', exhausted: true })
  }
  if (attempt >= maxAttempts) {
    return Object.freeze({ ...base, action: 'fail', exhausted: true })
  }
  if (failure.retryability === 'refresh_session') {
    return Object.freeze({ ...base, action: 'refresh_session', exhausted: false })
  }
  const safety = options.safety
  if (safety?.sideEffectsPossible === true && safety.idempotencyMode !== 'durable') {
    return Object.freeze({ ...base, action: 'human_gate', exhausted: false })
  }
  const maxDelayMs = Math.max(1, boundedInteger(
    options.maxDelayMs, 10 * 1000, 24 * 60 * 60 * 1000,
  ))
  const backoff = boundedBackoffDelay(attempt, { ...options, maxDelayMs })
  const requestedDelay = failure.retryAfterMs == null
    ? 0
    : Math.min(maxDelayMs, boundedInteger(failure.retryAfterMs, 0, maxDelayMs))
  return Object.freeze({
    ...base,
    action: 'retry',
    exhausted: false,
    delayMs: Math.max(backoff, requestedDelay),
  })
}

function normalizeAttemptHistoryEntry(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const sequence = boundedInteger(input.sequence, 0, 1000000000)
  const agentKind = String(input.agentKind || '')
  const phase = String(input.phase || '')
  const attempt = boundedInteger(input.attempt, 0, 1000)
  const failureCategory = input.failureCategory == null
    ? null
    : String(input.failureCategory)
  const policyAction = String(input.policyAction || '')
  const backoffMs = boundedInteger(input.backoffMs, 0, 24 * 60 * 60 * 1000)
  const recoveryAgentKind = String(input.recoveryAgentKind || '')
  const finalOutcome = String(input.finalOutcome || '')
  const timestamp = boundedInteger(input.timestamp, 0)
  const hasOutcomeCertainty = Object.hasOwn(input, 'outcomeCertainty')
  const outcomeCertainty = hasOutcomeCertainty ? String(input.outcomeCertainty || '') : ''
  const hasSideEffectsPossible = Object.hasOwn(input, 'sideEffectsPossible')
  const hasOperationId = Object.hasOwn(input, 'operationId')
  const operationId = hasOperationId ? String(input.operationId || '') : ''
  const hasIdempotencyMode = Object.hasOwn(input, 'idempotencyMode')
  const idempotencyMode = hasIdempotencyMode ? String(input.idempotencyMode || '') : ''
  if (!sequence || !ATTEMPT_PUBLIC_ID.test(agentKind)
      || !ATTEMPT_PHASE_SET.has(phase) || !attempt
      || (failureCategory !== null && !FAILURE_CATEGORY_SET.has(failureCategory))
      || !ATTEMPT_POLICY_ACTION_SET.has(policyAction)
      || (recoveryAgentKind && !ATTEMPT_PUBLIC_ID.test(recoveryAgentKind))
      || !ATTEMPT_FINAL_OUTCOME_SET.has(finalOutcome)
      || (hasOutcomeCertainty && !FAILURE_OUTCOME_CERTAINTY_SET.has(outcomeCertainty))
      || (hasSideEffectsPossible && typeof input.sideEffectsPossible !== 'boolean')
      || (hasOperationId && !ATTEMPT_PUBLIC_ID.test(operationId))
      || (hasIdempotencyMode && !IDEMPOTENCY_MODE_SET.has(idempotencyMode))) return null
  const normalized = {
    sequence,
    agentKind,
    phase,
    attempt,
    failureCategory,
    policyAction,
    backoffMs,
    recoveryAgentKind,
    finalOutcome,
    timestamp,
  }
  if (hasOutcomeCertainty) normalized.outcomeCertainty = outcomeCertainty
  if (hasSideEffectsPossible) normalized.sideEffectsPossible = input.sideEffectsPossible
  if (hasOperationId) normalized.operationId = operationId
  if (hasIdempotencyMode) normalized.idempotencyMode = idempotencyMode
  return Object.freeze(normalized)
}

function normalizeAttemptHistory(value) {
  const entries = (Array.isArray(value) ? value : [])
    .slice(-MAX_ATTEMPT_HISTORY)
    .map(normalizeAttemptHistoryEntry)
  if (entries.some(entry => !entry)) return null
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index].sequence <= entries[index - 1].sequence) return null
  }
  return entries
}

module.exports = {
  ATTEMPT_FINAL_OUTCOMES,
  ATTEMPT_PHASES,
  ATTEMPT_POLICY_ACTIONS,
  FAILURE_CATEGORIES,
  FAILURE_OUTCOME_CERTAINTIES,
  IDEMPOTENCY_MODES,
  MAX_ATTEMPT_HISTORY,
  boundedBackoffDelay,
  normalizeFailure,
  normalizeFailureOutcome,
  normalizeAttemptHistory,
  normalizeAttemptHistoryEntry,
  parseRetryAfter,
  retryDecision,
}
