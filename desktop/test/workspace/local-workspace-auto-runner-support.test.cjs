const assert = require('node:assert/strict')
const test = require('node:test')

const support = require('../../src/workspace/local-workspace-auto-runner-support.cjs')
const { LocalWorkspaceAutoRunner } = require('../../src/workspace/local-workspace-auto-runner.cjs')

test('auto runner support keeps authentication failures sanitized and non-retryable', () => {
  const original = Object.assign(new Error('Forbidden'), { statusCode: 403 })
  const sanitized = support.sanitizedAuthenticationError(original)

  assert.equal(sanitized.code, 'LOCAL_AGENT_AUTH_REQUIRED')
  assert.equal(sanitized.statusCode, 403)
  assert.equal(sanitized.failure.retryable, false)
  assert.match(sanitized.message, /authentication failed/)
})

test('auto runner support abortable delay settles immediately when stopped', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    support.abortableDelay(10, controller.signal),
    { message: 'LOCAL_AGENT_EXECUTION_STOPPED' },
  )
})

test('auto runner exposes extracted v4 outcome helpers through the runner prototype', () => {
  const runner = new LocalWorkspaceAutoRunner({
    state: () => ({ messages: [] }),
    beginRun: () => {},
    resolveAttachments: () => {},
    validateSkillSelections: () => {},
    validateKnowledgeBaseSelections: () => {},
    invokeAgent: () => {},
    resetAgentSession: () => {},
    refreshAgents: () => {},
    consumeAgentControl: () => {},
    markRuntimeCredential: () => {},
    agentLabel: kind => kind,
    recordAgentFailure: () => {},
    recordAgentInterruption: () => {},
    addMessage: () => {},
    emitChanged: () => {},
    finishRun: () => {},
    checkpointRun: () => true,
  })
  const records = [
    { receipt: { phase: 'proposal', agentKind: 'openclaw', receiptId: 'old' } },
    { receipt: { phase: 'proposal', agentKind: 'openclaw', receiptId: 'new' } },
  ]

  assert.equal(runner.v4LatestReceipt(records, 'proposal', 'openclaw').receipt.receiptId, 'new')
  assert.equal(typeof runner.v4Acceptance, 'function')
})
