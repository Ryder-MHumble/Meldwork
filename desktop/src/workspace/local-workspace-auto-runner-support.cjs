const { terminalRunStatusForReason } = require('./local-workspace-inputs.cjs')
const {
  normalizeFailure,
} = require('../runs/failure-policy.cjs')

function authenticationFailureText(error) {
  return [
    error?.diagnostic,
    error?.message,
    error?.cause?.diagnostic,
    error?.cause?.message,
  ].filter(Boolean).join('\n')
}

function unauthorizedFailure(error) {
  return normalizeFailure(error).category === 'authentication'
}

function hardBudgetFailure(error) {
  return error?.code === 'LOCAL_BUDGET_EXHAUSTED'
    || error?.message === 'LOCAL_BUDGET_EXHAUSTED'
}

function circuitBreakerFailure(error) {
  return error?.code === 'LOCAL_RUN_CIRCUIT_BREAKER'
    || error?.message === 'LOCAL_RUN_CIRCUIT_BREAKER'
}

function circuitBreakerError() {
  return Object.assign(new Error('LOCAL_RUN_CIRCUIT_BREAKER'), {
    code: 'LOCAL_RUN_CIRCUIT_BREAKER',
  })
}

function authenticationFailureStatus(error) {
  const status = normalizeFailure(error).httpStatus
  if ([401, 403].includes(status)) return status
  const message = authenticationFailureText(error)
  if (/(?:\bHTTP\s*)?\b403\b|forbidden/i.test(message)) return 403
  return 401
}

function sanitizedAuthenticationError(error) {
  const statusCode = authenticationFailureStatus(error)
  const sanitized = Object.assign(
    new Error(`HTTP ${statusCode}; authentication failed; Agent retained`),
    {
      code: 'LOCAL_AGENT_AUTH_REQUIRED',
      statusCode,
      failure: Object.freeze({
        code: 'LOCAL_AGENT_AUTH_REQUIRED',
        category: 'authentication',
        retryable: false,
      }),
    },
  )
  if (error?.runTrace) {
    Object.defineProperty(sanitized, 'runTrace', {
      value: error.runTrace,
      enumerable: false,
      configurable: true,
    })
  }
  return sanitized
}

function abortableDelay(delayMs, signal) {
  if (!delayMs) return Promise.resolve()
  if (signal?.aborted) return Promise.reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abortHandler)
      resolve()
    }, delayMs)
    const abortHandler = () => {
      clearTimeout(timer)
      reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED'))
    }
    signal?.addEventListener('abort', abortHandler, { once: true })
  })
}

function stalePermissionResumeFailure(error, resumedGate) {
  const code = String(error?.code || error?.message || '')
  return resumedGate?.type === 'permission'
    && ['LOCAL_RUN_PERMISSION_RESUME_UNAVAILABLE', 'LOCAL_AGENT_SESSION_INVALID'].includes(code)
}

module.exports = {
  abortableDelay,
  authenticationFailureStatus,
  authenticationFailureText,
  circuitBreakerError,
  circuitBreakerFailure,
  hardBudgetFailure,
  sanitizedAuthenticationError,
  stalePermissionResumeFailure,
  terminalRunStatusForReason,
  unauthorizedFailure,
}
