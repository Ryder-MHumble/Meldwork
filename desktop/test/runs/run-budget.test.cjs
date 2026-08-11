const test = require('node:test')
const assert = require('node:assert/strict')

const {
  BUDGET_DIMENSIONS,
  RunBudget,
  normalizeRunBudgetConfiguration,
} = require('../../src/runs/run-budget.cjs')

test('tracks every supported dimension with explicit limits, usage, source, and enforcement', () => {
  const budget = new RunBudget({
    startedAt: 100,
    limits: Object.fromEntries(BUDGET_DIMENSIONS.map(dimension => [dimension, 1000])),
    used: { inputTokens: 10, costMicros: 20 },
    source: { inputTokens: 'reported', costMicros: 'estimated' },
    enforcement: { costMicros: 'soft' },
  })
  const snapshot = budget.snapshot()

  assert.deepEqual(Object.keys(snapshot.limits), BUDGET_DIMENSIONS)
  assert.equal(snapshot.used.inputTokens, 10)
  assert.equal(snapshot.source.inputTokens, 'reported')
  assert.equal(snapshot.source.costMicros, 'estimated')
  assert.equal(snapshot.enforcement.inputTokens, 'hard')
  assert.equal(snapshot.enforcement.costMicros, 'soft')
  assert.equal(snapshot.exhaustion, null)
})

test('commits attempted usage before throwing a typed hard budget failure', () => {
  const budget = new RunBudget({
    startedAt: 0,
    limits: { outboundBytes: 10 },
    source: { outboundBytes: 'reported' },
  })
  assert.equal(budget.addUsage('outboundBytes', 10).action, 'allow')

  assert.throws(() => budget.addUsage('outboundBytes', 1), error => (
    error.code === 'LOCAL_BUDGET_EXHAUSTED'
      && error.failure.category === 'budget'
      && error.failure.retryable === false
      && error.decision.action === 'terminal'
      && error.decision.dimension === 'outboundBytes'
      && error.decision.limit === 10
      && error.decision.priorUsed === 10
      && error.decision.attemptedUsage === 1
      && error.decision.used === 11
  ))
  assert.equal(budget.snapshot().used.outboundBytes, 11)
  assert.deepEqual(budget.snapshot().exhaustion, {
    dimension: 'outboundBytes',
    limit: 10,
    priorUsed: 10,
    attemptedUsage: 1,
    used: 11,
    source: 'reported',
    enforcement: 'hard',
    reason: 'BUDGET_LIMIT_EXCEEDED',
  })
})

test('atomically records every dimension from the action that breached a hard budget', () => {
  const budget = new RunBudget({
    startedAt: 0,
    limits: { toolCalls: 0 },
    source: { toolCalls: 'estimated' },
  })

  assert.throws(() => budget.addUsageBatch([
    { dimension: 'outputTokens', amount: 12, source: 'reported' },
    { dimension: 'toolCalls', amount: 1, source: 'estimated' },
    { dimension: 'costMicros', amount: 25, source: 'reported' },
  ]), { message: 'LOCAL_BUDGET_EXHAUSTED' })

  const snapshot = budget.snapshot()
  assert.equal(snapshot.used.outputTokens, 12)
  assert.equal(snapshot.used.toolCalls, 1)
  assert.equal(snapshot.used.costMicros, 25)
  assert.equal(snapshot.exhaustion.dimension, 'toolCalls')
})

test('returns a Human Gate decision when a hard budget is not observable', () => {
  const budget = new RunBudget({
    startedAt: 0,
    limits: { costMicros: 5000 },
  })
  const decision = budget.check('costMicros')

  assert.deepEqual(decision, {
    dimension: 'costMicros',
    limit: 5000,
    used: 0,
    source: 'unknown',
    enforcement: 'hard',
    action: 'human_gate',
    gateType: 'budget',
    reason: 'BUDGET_USAGE_UNOBSERVABLE',
    exhausted: null,
  })
  assert.deepEqual(budget.setUsed('costMicros', 100, { source: 'unknown' }), {
    ...decision,
    used: 100,
  })
  assert.equal(budget.snapshot().used.costMicros, 0)

  assert.deepEqual(budget.approveUnobservable('costMicros'), {
    dimension: 'costMicros',
    limit: 5000,
    used: 0,
    source: 'estimated',
    enforcement: 'soft',
    action: 'allow',
    exhausted: false,
    approvedByHuman: true,
  })
  assert.equal(budget.snapshot().source.costMicros, 'estimated')
  assert.equal(budget.snapshot().enforcement.costMicros, 'soft')
})

test('accepts only bounded public Task budget configuration fields', () => {
  assert.deepEqual(normalizeRunBudgetConfiguration({
    limits: { outputTokens: 5000, elapsedMs: null },
    enforcement: { outputTokens: 'hard' },
  }), {
    limits: { outputTokens: 5000, elapsedMs: null },
    enforcement: { outputTokens: 'hard' },
  })
  assert.throws(
    () => normalizeRunBudgetConfiguration({ used: { outputTokens: 1 } }),
    { message: 'RUN_BUDGET_CONFIGURATION_INVALID' },
  )
  assert.throws(
    () => normalizeRunBudgetConfiguration({ limits: { unknown: 1 } }),
    { message: 'RUN_BUDGET_CONFIGURATION_INVALID' },
  )
})

test('allows soft exhaustion and preserves the weakest aggregate measurement source', () => {
  const budget = new RunBudget({
    startedAt: 0,
    limits: { inputTokens: 5 },
    source: { inputTokens: 'reported' },
    enforcement: { inputTokens: 'soft' },
  })
  budget.addUsage('inputTokens', 3, { source: 'reported' })
  const decision = budget.addUsage('inputTokens', 3, { source: 'estimated' })

  assert.equal(decision.action, 'allow')
  assert.equal(decision.exhausted, true)
  assert.equal(decision.source, 'estimated')
  assert.equal(budget.snapshot().used.inputTokens, 6)
  assert.equal(budget.snapshot().source.inputTokens, 'estimated')
})

test('uses a fake clock for elapsed usage and has no elapsed limit by default', () => {
  let now = 1000
  const unlimited = new RunBudget({ startedAt: now, now: () => now })
  now = 10_000_000
  assert.deepEqual(unlimited.updateElapsed(), {
    dimension: 'elapsedMs',
    limit: null,
    used: 9_999_000,
    source: 'reported',
    enforcement: 'soft',
    action: 'allow',
    exhausted: false,
  })

  now = 2000
  const limited = new RunBudget({
    startedAt: now,
    now: () => now,
    limits: { elapsedMs: 100 },
    source: { elapsedMs: 'reported' },
  })
  now = 2101
  assert.throws(() => limited.updateElapsed(), { message: 'LOCAL_BUDGET_EXHAUSTED' })
  assert.equal(limited.snapshot().used.elapsedMs, 101)
  assert.equal(limited.snapshot().exhaustion.attemptedUsage, 101)
})
