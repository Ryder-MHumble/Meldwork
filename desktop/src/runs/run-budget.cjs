const BUDGET_DIMENSIONS = Object.freeze([
  'inputTokens',
  'outputTokens',
  'costMicros',
  'toolCalls',
  'outboundBytes',
  'elapsedMs',
])

const BUDGET_DIMENSION_SET = new Set(BUDGET_DIMENSIONS)
const BUDGET_SOURCES = Object.freeze(['reported', 'estimated', 'unknown'])
const BUDGET_SOURCE_SET = new Set(BUDGET_SOURCES)
const BUDGET_ENFORCEMENTS = Object.freeze(['hard', 'soft'])
const BUDGET_ENFORCEMENT_SET = new Set(BUDGET_ENFORCEMENTS)
const BUDGET_EXHAUSTION_FIELDS = new Set([
  'dimension', 'limit', 'priorUsed', 'attemptedUsage', 'used',
  'source', 'enforcement', 'reason',
])

function budgetError(code) {
  return Object.assign(new Error(code), { code })
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function dimensionName(value) {
  const dimension = String(value || '')
  if (!BUDGET_DIMENSION_SET.has(dimension)) throw budgetError('RUN_BUDGET_DIMENSION_INVALID')
  return dimension
}

function nonnegativeInteger(value, code) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw budgetError(code)
  return number
}

function sourceName(value, fallback = 'unknown') {
  const source = String(value || fallback)
  if (!BUDGET_SOURCE_SET.has(source)) throw budgetError('RUN_BUDGET_SOURCE_INVALID')
  return source
}

function enforcementName(value, fallback = 'hard') {
  const enforcement = String(value || fallback)
  if (!BUDGET_ENFORCEMENT_SET.has(enforcement)) {
    throw budgetError('RUN_BUDGET_ENFORCEMENT_INVALID')
  }
  return enforcement
}

function combinedSource(current, next, currentUsed) {
  if (!currentUsed) return next
  if (current === 'unknown' || next === 'unknown') return 'unknown'
  if (current === 'estimated' || next === 'estimated') return 'estimated'
  return 'reported'
}

function normalizeBudgetExhaustion(input) {
  if (input == null) return null
  if (!isRecord(input)
      || Object.keys(input).length !== BUDGET_EXHAUSTION_FIELDS.size
      || Object.keys(input).some(field => !BUDGET_EXHAUSTION_FIELDS.has(field))) {
    throw budgetError('RUN_BUDGET_EXHAUSTION_INVALID')
  }
  const dimension = dimensionName(input.dimension)
  const limit = nonnegativeInteger(input.limit, 'RUN_BUDGET_EXHAUSTION_INVALID')
  const priorUsed = nonnegativeInteger(input.priorUsed, 'RUN_BUDGET_EXHAUSTION_INVALID')
  const attemptedUsage = nonnegativeInteger(
    input.attemptedUsage, 'RUN_BUDGET_EXHAUSTION_INVALID',
  )
  const used = nonnegativeInteger(input.used, 'RUN_BUDGET_EXHAUSTION_INVALID')
  const source = sourceName(input.source)
  const enforcement = enforcementName(input.enforcement)
  if (enforcement !== 'hard' || input.reason !== 'BUDGET_LIMIT_EXCEEDED'
      || used !== priorUsed + attemptedUsage || used <= limit) {
    throw budgetError('RUN_BUDGET_EXHAUSTION_INVALID')
  }
  return Object.freeze({
    dimension,
    limit,
    priorUsed,
    attemptedUsage,
    used,
    source,
    enforcement,
    reason: 'BUDGET_LIMIT_EXCEEDED',
  })
}

function normalizeRunBudgetConfiguration(input = {}) {
  if (!isRecord(input)) throw budgetError('RUN_BUDGET_CONFIGURATION_INVALID')
  const allowedFields = new Set(['limits', 'enforcement'])
  if (Object.keys(input).some(field => !allowedFields.has(field))) {
    throw budgetError('RUN_BUDGET_CONFIGURATION_INVALID')
  }
  const limits = {}
  const enforcement = {}
  for (const [field, target] of [['limits', limits], ['enforcement', enforcement]]) {
    const value = input[field]
    if (value == null) continue
    if (!isRecord(value) || Object.keys(value).some(key => !BUDGET_DIMENSION_SET.has(key))) {
      throw budgetError('RUN_BUDGET_CONFIGURATION_INVALID')
    }
    for (const [dimension, requested] of Object.entries(value)) {
      target[dimension] = field === 'limits'
        ? (requested == null ? null : nonnegativeInteger(requested, 'RUN_BUDGET_LIMIT_INVALID'))
        : enforcementName(requested)
    }
  }
  return Object.freeze({
    limits: Object.freeze(limits),
    enforcement: Object.freeze(enforcement),
  })
}

function exhaustedError(decision) {
  const error = budgetError('LOCAL_BUDGET_EXHAUSTED')
  Object.defineProperty(error, 'failure', {
    value: Object.freeze({
      code: error.code,
      category: 'budget',
      retryable: false,
      sessionInvalid: false,
    }),
    enumerable: false,
  })
  Object.defineProperty(error, 'decision', {
    value: Object.freeze({ ...decision }),
    enumerable: false,
  })
  return error
}

class RunBudget {
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.startedAt = nonnegativeInteger(
      options.startedAt == null ? this.now() : options.startedAt,
      'RUN_BUDGET_STARTED_AT_INVALID',
    )
    this.limits = {}
    this.used = {}
    this.source = {}
    this.enforcement = {}
    this.exhaustion = normalizeBudgetExhaustion(options.exhaustion)
    for (const dimension of BUDGET_DIMENSIONS) {
      const requestedLimit = options.limits?.[dimension]
      this.limits[dimension] = requestedLimit == null
        ? null
        : nonnegativeInteger(requestedLimit, 'RUN_BUDGET_LIMIT_INVALID')
      this.used[dimension] = nonnegativeInteger(
        options.used?.[dimension] ?? 0,
        'RUN_BUDGET_USAGE_INVALID',
      )
      this.source[dimension] = sourceName(options.source?.[dimension])
      this.enforcement[dimension] = enforcementName(
        options.enforcement?.[dimension],
        this.limits[dimension] == null ? 'soft' : 'hard',
      )
    }
  }

  decision(dimension, nextUsed, source, attemptedUsage = null) {
    const limit = this.limits[dimension]
    const enforcement = this.enforcement[dimension]
    const base = {
      dimension,
      limit,
      used: nextUsed,
      source,
      enforcement,
    }
    if (limit == null) return Object.freeze({ ...base, action: 'allow', exhausted: false })
    if (enforcement === 'hard' && source === 'unknown') {
      return Object.freeze({
        ...base,
        action: 'human_gate',
        gateType: 'budget',
        reason: 'BUDGET_USAGE_UNOBSERVABLE',
        exhausted: null,
      })
    }
    const exhausted = nextUsed > limit
    if (enforcement === 'hard' && exhausted) {
      const priorUsed = this.used[dimension]
      return Object.freeze({
        ...base,
        priorUsed,
        attemptedUsage: attemptedUsage == null
          ? Math.max(0, nextUsed - priorUsed)
          : nonnegativeInteger(attemptedUsage, 'RUN_BUDGET_USAGE_INVALID'),
        action: 'terminal',
        reason: 'BUDGET_LIMIT_EXCEEDED',
        exhausted: true,
      })
    }
    return Object.freeze({ ...base, action: 'allow', exhausted })
  }

  check(dimensionValue, nextUsedValue = null, options = {}) {
    const dimension = dimensionName(dimensionValue)
    const nextUsed = nextUsedValue == null
      ? this.used[dimension]
      : nonnegativeInteger(nextUsedValue, 'RUN_BUDGET_USAGE_INVALID')
    const source = sourceName(options.source, this.source[dimension])
    const decision = this.decision(dimension, nextUsed, source)
    if (decision.action === 'terminal') throw exhaustedError(decision)
    return decision
  }

  setUsed(dimensionValue, value, options = {}) {
    const dimension = dimensionName(dimensionValue)
    const nextUsed = nonnegativeInteger(value, 'RUN_BUDGET_USAGE_INVALID')
    const source = sourceName(options.source, this.source[dimension])
    const decision = this.decision(dimension, nextUsed, source, options.attemptedUsage)
    if (decision.action === 'terminal') {
      this.used[dimension] = nextUsed
      this.source[dimension] = source
      this.exhaustion = normalizeBudgetExhaustion({
        dimension,
        limit: decision.limit,
        priorUsed: decision.priorUsed,
        attemptedUsage: decision.attemptedUsage,
        used: nextUsed,
        source,
        enforcement: decision.enforcement,
        reason: decision.reason,
      })
      throw exhaustedError(decision)
    }
    if (decision.action !== 'allow') return decision
    this.used[dimension] = nextUsed
    this.source[dimension] = source
    return decision
  }

  addUsage(dimensionValue, amount, options = {}) {
    const dimension = dimensionName(dimensionValue)
    const increment = nonnegativeInteger(amount, 'RUN_BUDGET_USAGE_INVALID')
    const nextSource = sourceName(options.source, 'reported')
    const source = combinedSource(this.source[dimension], nextSource, this.used[dimension])
    return this.setUsed(dimension, this.used[dimension] + increment, {
      source,
      attemptedUsage: increment,
    })
  }

  addUsageBatch(entries) {
    if (!Array.isArray(entries) || !entries.length) {
      throw budgetError('RUN_BUDGET_USAGE_INVALID')
    }
    const updates = entries.map((entry) => {
      if (!isRecord(entry)) throw budgetError('RUN_BUDGET_USAGE_INVALID')
      const dimension = dimensionName(entry.dimension)
      const hasAmount = Object.hasOwn(entry, 'amount')
      const hasValue = Object.hasOwn(entry, 'value')
      if (hasAmount === hasValue) throw budgetError('RUN_BUDGET_USAGE_INVALID')
      const priorUsed = this.used[dimension]
      const nextUsed = hasAmount
        ? priorUsed + nonnegativeInteger(entry.amount, 'RUN_BUDGET_USAGE_INVALID')
        : nonnegativeInteger(entry.value, 'RUN_BUDGET_USAGE_INVALID')
      if (!Number.isSafeInteger(nextUsed)) throw budgetError('RUN_BUDGET_USAGE_INVALID')
      const nextSource = sourceName(entry.source, 'reported')
      const source = combinedSource(this.source[dimension], nextSource, priorUsed)
      return {
        dimension,
        priorUsed,
        nextUsed,
        source,
        attemptedUsage: Math.max(0, nextUsed - priorUsed),
      }
    })
    if (new Set(updates.map(update => update.dimension)).size !== updates.length) {
      throw budgetError('RUN_BUDGET_USAGE_INVALID')
    }
    const decisions = updates.map(update => this.decision(
      update.dimension,
      update.nextUsed,
      update.source,
      update.attemptedUsage,
    ))
    const pendingGate = decisions.find(decision => decision.action === 'human_gate')
    if (pendingGate) return pendingGate
    for (const update of updates) {
      this.used[update.dimension] = update.nextUsed
      this.source[update.dimension] = update.source
    }
    const terminal = decisions.find(decision => decision.action === 'terminal')
    if (terminal) {
      this.exhaustion = normalizeBudgetExhaustion({
        dimension: terminal.dimension,
        limit: terminal.limit,
        priorUsed: terminal.priorUsed,
        attemptedUsage: terminal.attemptedUsage,
        used: terminal.used,
        source: terminal.source,
        enforcement: terminal.enforcement,
        reason: terminal.reason,
      })
      throw exhaustedError(terminal)
    }
    return Object.freeze(decisions)
  }

  elapsedValue() {
    return Math.max(0, Math.floor(this.now() - this.startedAt))
  }

  updateElapsed() {
    return this.setUsed('elapsedMs', this.elapsedValue(), { source: 'reported' })
  }

  approveUnobservable(dimensionValue) {
    const dimension = dimensionName(dimensionValue)
    const decision = this.check(dimension)
    if (decision.action !== 'human_gate') {
      throw budgetError('RUN_BUDGET_GATE_NOT_REQUIRED')
    }
    this.source[dimension] = 'estimated'
    this.enforcement[dimension] = 'soft'
    return Object.freeze({
      ...this.decision(dimension, this.used[dimension], 'estimated'),
      approvedByHuman: true,
    })
  }

  snapshot() {
    return {
      limits: { ...this.limits },
      used: { ...this.used },
      source: { ...this.source },
      enforcement: { ...this.enforcement },
      startedAt: this.startedAt,
      exhaustion: this.exhaustion ? { ...this.exhaustion } : null,
    }
  }
}

module.exports = {
  BUDGET_DIMENSIONS,
  BUDGET_ENFORCEMENTS,
  BUDGET_SOURCES,
  RunBudget,
  normalizeBudgetExhaustion,
  normalizeRunBudgetConfiguration,
}
