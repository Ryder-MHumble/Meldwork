const test = require('node:test')
const assert = require('node:assert/strict')
const {
  AGENT_OUTCOMES,
  AGENT_RUNTIME_CAPABILITIES,
  agentRuntimeError,
  agentRuntimeFailure,
  isCodeReviewAgentKind,
  isReviewOnlyAgentKind,
  normalizeExternalRunRef,
  outcomeForAcpStopReason,
  requireTerminalAgentResult,
  terminalAuthenticationDiagnostic,
} = require('../../src/agents/agent-runtime-contract.cjs')
const { ALLOWED_KINDS } = require('../../src/agents/cli/cli-discovery.cjs')

test('runtime capabilities cover every supported built-in Agent', () => {
  assert.deepEqual(Object.keys(AGENT_RUNTIME_CAPABILITIES).sort(), [...ALLOWED_KINDS].sort())
  for (const kind of ALLOWED_KINDS) {
    const capabilities = AGENT_RUNTIME_CAPABILITIES[kind]
    assert.ok(['general', 'code_review'].includes(capabilities.task), kind)
    assert.ok(capabilities.domains.length, kind)
    assert.ok(capabilities.inputTypes.includes('text'), kind)
    assert.ok(capabilities.outputTypes.includes('text'), kind)
    assert.ok(capabilities.toolClasses.length, kind)
    assert.ok(capabilities.permissionModes.length, kind)
    assert.ok(['low', 'medium', 'high', 'unknown'].includes(capabilities.latencyBand), kind)
    assert.ok(['low', 'medium', 'high', 'unknown'].includes(capabilities.costBand), kind)
    assert.ok(Number.isSafeInteger(capabilities.contextLimitChars), kind)
    assert.equal(typeof capabilities.resumable, 'boolean', kind)
  }
  assert.equal(isCodeReviewAgentKind('opencodereview'), true)
  assert.equal(isReviewOnlyAgentKind('opencodereview'), false)
  assert.equal(AGENT_RUNTIME_CAPABILITIES.opencodereview.resumable, false)
})

test('the runtime contract exposes explicit terminal and non-terminal outcomes', () => {
  assert.deepEqual(AGENT_OUTCOMES, [
    'accepted', 'running', 'waiting_input', 'waiting_permission',
    'partial', 'completed', 'failed', 'cancelled',
  ])
  assert.equal(requireTerminalAgentResult({ outcome: 'completed', text: 'done' }).outcome, 'completed')
  assert.equal(requireTerminalAgentResult({ outcome: 'partial', text: 'bounded' }).outcome, 'partial')
  for (const outcome of ['accepted', 'running', 'waiting_input', 'waiting_permission']) {
    assert.throws(
      () => requireTerminalAgentResult({ outcome, text: 'not final' }),
      { message: 'LOCAL_AGENT_OUTCOME_NON_TERMINAL' },
      outcome,
    )
  }
})

test('external run references use one bounded opaque contract', () => {
  const maximum = `ocr+${'a'.repeat(252)}`
  assert.equal(maximum.length, 256)
  assert.equal(normalizeExternalRunRef(maximum), maximum)
  assert.equal(normalizeExternalRunRef('ocr/review'), '')
  assert.equal(normalizeExternalRunRef(`ocr-${'a'.repeat(253)}`), '')
})

test('ACP stop reasons map to typed terminal outcomes', () => {
  assert.deepEqual(outcomeForAcpStopReason('end_turn'), { outcome: 'completed' })
  assert.deepEqual(outcomeForAcpStopReason('max_tokens'), { outcome: 'partial' })
  assert.deepEqual(outcomeForAcpStopReason('max_turn_requests'), { outcome: 'partial' })
  assert.deepEqual(outcomeForAcpStopReason('cancelled'), { outcome: 'cancelled' })
  assert.equal(outcomeForAcpStopReason('refusal').failure.code, 'LOCAL_AGENT_REFUSED')
  assert.equal(outcomeForAcpStopReason('unknown').failure.code, 'LOCAL_AGENT_OUTCOME_INVALID')
})

test('typed failures preserve retry and Session invalidation semantics', () => {
  const failure = agentRuntimeFailure('LOCAL_AGENT_SESSION_INVALID')
  assert.deepEqual(failure, {
    code: 'LOCAL_AGENT_SESSION_INVALID',
    category: 'session',
    retryable: true,
    sessionInvalid: true,
  })
  const error = agentRuntimeError(failure.code, 'Session expired')
  assert.equal(error.code, failure.code)
  assert.deepEqual(error.failure, failure)
  assert.equal(error.diagnostic, 'Session expired')
  assert.equal(Object.prototype.propertyIsEnumerable.call(error, 'failure'), false)
  assert.equal(Object.prototype.propertyIsEnumerable.call(error, 'diagnostic'), false)
})

test('failed and cancelled outcomes do not become successful results', () => {
  assert.throws(
    () => requireTerminalAgentResult({
      outcome: 'failed',
      failure: agentRuntimeFailure('LOCAL_AGENT_AUTH_REQUIRED'),
      diagnostic: 'Unauthorized',
    }),
    (error) => error.message === 'LOCAL_AGENT_AUTH_REQUIRED'
      && error.failure.category === 'authentication',
  )
  assert.throws(
    () => requireTerminalAgentResult({ outcome: 'cancelled' }),
    (error) => error.message === 'LOCAL_AGENT_EXECUTION_STOPPED'
      && error.failure.category === 'cancellation',
  )
})

test('short terminal HTTP credential diagnostics cannot become successful results', () => {
  const diagnostic = 'HTTP 401: Invalid token (request id: request-1)'
  assert.equal(terminalAuthenticationDiagnostic(diagnostic), diagnostic)
  assert.equal(
    terminalAuthenticationDiagnostic('HTTP 403: Forbidden'),
    'HTTP 403: Forbidden',
  )
  assert.throws(
    () => requireTerminalAgentResult({ outcome: 'completed', text: diagnostic }),
    error => error.message === 'LOCAL_AGENT_AUTH_REQUIRED'
      && error.failure.category === 'authentication'
      && error.diagnostic === diagnostic,
  )
  assert.equal(terminalAuthenticationDiagnostic(
    'When an API returns HTTP 401: Invalid token, refresh the configured credential.',
  ), '')
})
