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

  decision(dimension, nextUsed, source) {
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
      throw exhaustedError({
        ...base,
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
    return this.decision(dimension, nextUsed, source)
  }

  setUsed(dimensionValue, value, options = {}) {
    const dimension = dimensionName(dimensionValue)
    const nextUsed = nonnegativeInteger(value, 'RUN_BUDGET_USAGE_INVALID')
    const source = sourceName(options.source, this.source[dimension])
    const decision = this.decision(dimension, nextUsed, source)
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
    return this.setUsed(dimension, this.used[dimension] + increment, { source })
  }

  updateElapsed() {
    const elapsed = Math.max(0, Math.floor(this.now() - this.startedAt))
    return this.setUsed('elapsedMs', elapsed, { source: 'reported' })
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
    }
  }
}

module.exports = {
  BUDGET_DIMENSIONS,
  BUDGET_ENFORCEMENTS,
  BUDGET_SOURCES,
  RunBudget,
  normalizeRunBudgetConfiguration,
}
