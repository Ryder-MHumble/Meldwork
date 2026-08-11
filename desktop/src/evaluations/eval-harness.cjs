const {
  EVAL_RESULT_VERSION,
  FIT_MATRIX_VERSION,
  createEvalCase,
  createEvalResult,
  createFitMatrix,
  normalizeEvalObservation,
  normalizeEvalTarget,
  parseEvalCase,
  parseEvalResult,
} = require('./eval-records.cjs')

const MIN_ROUTING_SAMPLE_SIZE = 3
const MIN_ROUTING_CONFIDENCE = 0.6

function rounded(value, digits = 2) {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function countType(items, type) {
  return items.filter(item => item.type === type).length
}

function deterministicScore(evalCase, observation) {
  const artifacts = new Map(evalCase.expectedArtifacts.map(item => [item.id, item]))
  const evidence = new Map(evalCase.evidenceRequirements.map(item => [item.id, item]))
  const signals = new Map(observation.signals.map(item => [item.name, item.value]))
  const checks = evalCase.rubric.checks.map((check) => {
    let passed = false
    if (check.type === 'artifact-requirement') {
      const requirement = artifacts.get(check.requirementId)
      passed = countType(observation.artifacts, requirement.type) >= requirement.minCount
    } else if (check.type === 'evidence-requirement') {
      const requirement = evidence.get(check.requirementId)
      passed = countType(observation.evidence, requirement.type) >= requirement.minCount
    } else if (check.type === 'signal-equals') {
      passed = signals.has(check.signal) && Object.is(signals.get(check.signal), check.expected)
    } else {
      const value = signals.get(check.signal)
      passed = typeof value === 'number' && value >= check.minimum
    }
    return Object.freeze({
      checkId: check.id,
      passed,
      awarded: passed ? check.weight : 0,
      possible: check.weight,
    })
  })
  const score = checks.reduce((total, check) => total + check.awarded, 0)
  return Object.freeze({ score: rounded(score), checks: Object.freeze(checks) })
}

function scoringFor(evalCase, observation) {
  const deterministic = deterministicScore(evalCase, observation)
  const externalReviews = observation.reviews.filter(review => review.reviewerKind !== 'deterministic')
  const reviewScore = externalReviews.length
    ? rounded(externalReviews.reduce((total, review) => total + review.score, 0)
      / externalReviews.length)
    : null
  const overallScore = reviewScore === null
    ? deterministic.score
    : rounded((deterministic.score * 0.7) + (reviewScore * 0.3))
  return Object.freeze({
    deterministicScore: deterministic.score,
    reviewScore,
    overallScore,
    checks: deterministic.checks,
  })
}

function deterministicReview(scoring) {
  return Object.freeze({
    reviewerKind: 'deterministic',
    reviewerId: 'meldwork-eval-v1',
    blinded: false,
    score: scoring.deterministicScore,
    evidenceRefs: scoring.checks.filter(check => check.passed).map(check => check.checkId),
    summary: 'Deterministic rubric checks completed.',
  })
}

function safeExecutionFailure(error) {
  const candidate = String(error?.code || error?.message || '')
  const code = /^[A-Z][A-Z0-9_]{2,119}$/.test(candidate) ? candidate : 'EVAL_EXECUTION_FAILED'
  return {
    status: 'failed',
    usage: {
      inputTokens: null,
      outputTokens: null,
      toolCalls: null,
      estimatedCostUsd: null,
    },
    failures: [{
      code,
      stage: 'execution',
      retryable: false,
      summary: 'Evaluation target execution failed.',
    }],
    artifacts: [],
    evidence: [],
    signals: [],
    reviews: [],
  }
}

class EvalHarness {
  constructor({ store = null, clock = () => Date.now() } = {}) {
    if (store !== null && (
      typeof store.putCase !== 'function' || typeof store.putResult !== 'function'
    )) {
      throw new Error('EVAL_HARNESS_STORE_INVALID')
    }
    if (typeof clock !== 'function') throw new Error('EVAL_HARNESS_CLOCK_INVALID')
    this.store = store
    this.clock = clock
  }

  async runCase(caseInput, targetInput, execute, options = {}) {
    const evalCase = Object.hasOwn(caseInput || {}, 'evalCaseId')
      ? parseEvalCase(caseInput)
      : createEvalCase(caseInput)
    const target = normalizeEvalTarget(targetInput)
    if (typeof execute !== 'function') throw new Error('EVAL_HARNESS_EXECUTOR_REQUIRED')
    const promptVersion = String(options.promptVersion || evalCase.rubric.version)
    const startedAt = this.clock()
    let rawObservation
    try {
      rawObservation = await execute(Object.freeze({ evalCase, target }))
    } catch (error) {
      rawObservation = safeExecutionFailure(error)
    }
    const endedAt = this.clock()
    if (!Number.isSafeInteger(startedAt) || !Number.isSafeInteger(endedAt) || endedAt < startedAt) {
      throw new Error('EVAL_HARNESS_CLOCK_INVALID')
    }
    const observation = normalizeEvalObservation(rawObservation)
    const scoring = scoringFor(evalCase, observation)
    const result = createEvalResult({
      schemaVersion: EVAL_RESULT_VERSION,
      evalCaseId: evalCase.evalCaseId,
      caseVersion: evalCase.caseVersion,
      target,
      promptVersion,
      contextVersion: evalCase.input.contextVersion,
      durationMs: endedAt - startedAt,
      status: observation.status,
      usage: observation.usage,
      failures: observation.failures,
      artifacts: observation.artifacts,
      evidence: observation.evidence,
      signals: observation.signals,
      reviewerEvidence: [deterministicReview(scoring), ...observation.reviews],
      scoring,
    })
    if (this.store) {
      this.store.putCase(evalCase)
      return this.store.putResult(result)
    }
    return result
  }

  async runTargets(caseInput, targets, execute, options = {}) {
    if (!Array.isArray(targets) || !targets.length || targets.length > 32) {
      throw new Error('EVAL_HARNESS_TARGETS_INVALID')
    }
    const results = []
    for (const targetSpec of targets) {
      const target = targetSpec?.target || targetSpec
      results.push(await this.runCase(
        caseInput,
        target,
        context => execute({ ...context, targetId: targetSpec?.targetId || '' }),
        options,
      ))
    }
    return Object.freeze(results)
  }
}

function matrixStatistics(results) {
  const scores = results.map(result => result.scoring.overallScore)
  const score = scores.reduce((total, value) => total + value, 0) / scores.length
  const successRate = results.filter(result => result.status === 'completed').length / results.length
  const variance = scores.reduce((total, value) => total + ((value - score) ** 2), 0)
    / scores.length
  const spreadPenalty = Math.min(0.5, Math.sqrt(variance) / 100)
  const sampleFactor = Math.min(1, results.length / MIN_ROUTING_SAMPLE_SIZE)
  const confidence = rounded(Math.min(0.95, sampleFactor * successRate * (1 - spreadPenalty)), 3)
  const qualified = results.length >= MIN_ROUTING_SAMPLE_SIZE
    && confidence >= MIN_ROUTING_CONFIDENCE
  return {
    score: rounded(score),
    confidence,
    sampleSize: results.length,
    qualification: qualified ? 'qualified' : 'insufficient-evidence',
    resultIds: results.map(result => result.evalResultId).sort(),
  }
}

function groupedResults(cases, results) {
  const agentGroups = new Map()
  const workflowGroups = new Map()
  for (const result of results) {
    const evalCase = cases.get(result.evalCaseId)
    if (!evalCase || evalCase.caseVersion !== result.caseVersion) {
      throw new Error('FIT_MATRIX_CASE_REFERENCE_INVALID')
    }
    for (const domain of evalCase.routingDomains) {
      if (result.target.mode === 'single-agent') {
        const kind = result.target.participants[0].kind
        const key = `${kind}\u0000${domain}`
        if (!agentGroups.has(key)) agentGroups.set(key, { kind, domain, results: [] })
        agentGroups.get(key).results.push(result)
      } else {
        const workflow = result.target.workflow
        const key = `${workflow.id}\u0000${workflow.version}\u0000${domain}`
        if (!workflowGroups.has(key)) {
          workflowGroups.set(key, {
            workflowId: workflow.id,
            workflowVersion: workflow.version,
            domain,
            results: [],
          })
        }
        workflowGroups.get(key).results.push(result)
      }
    }
  }
  return { agentGroups, workflowGroups }
}

function buildFitMatrix({ cases: caseInputs, results: resultInputs, corpusVersion }) {
  if (!Array.isArray(caseInputs) || !caseInputs.length
      || !Array.isArray(resultInputs) || !resultInputs.length) {
    throw new Error('FIT_MATRIX_EVIDENCE_REQUIRED')
  }
  const cases = new Map(caseInputs.map((input) => {
    const evalCase = Object.hasOwn(input || {}, 'evalCaseId') ? parseEvalCase(input) : createEvalCase(input)
    return [evalCase.evalCaseId, evalCase]
  }))
  const results = resultInputs.map(parseEvalResult)
  if (new Set(results.map(result => result.evalResultId)).size !== results.length) {
    throw new Error('FIT_MATRIX_RESULT_DUPLICATE')
  }
  const { agentGroups, workflowGroups } = groupedResults(cases, results)
  const entries = [...agentGroups.values()].map(group => {
    const statistics = matrixStatistics(group.results)
    return {
      kind: group.kind,
      domains: [group.domain],
      ...statistics,
      routingEligible: statistics.qualification === 'qualified',
    }
  }).sort((left, right) => left.kind.localeCompare(right.kind)
    || left.domains[0].localeCompare(right.domains[0]))
  const workflowEntries = [...workflowGroups.values()].map(group => ({
    workflowId: group.workflowId,
    workflowVersion: group.workflowVersion,
    domains: [group.domain],
    ...matrixStatistics(group.results),
  })).sort((left, right) => left.workflowId.localeCompare(right.workflowId)
    || left.workflowVersion.localeCompare(right.workflowVersion)
    || left.domains[0].localeCompare(right.domains[0]))
  const matrix = createFitMatrix({
    schemaVersion: FIT_MATRIX_VERSION,
    corpusVersion,
    resultIds: results.map(result => result.evalResultId).sort(),
    entries,
    workflowEntries,
  })
  return Object.freeze(matrix)
}

module.exports = {
  EvalHarness,
  MIN_ROUTING_CONFIDENCE,
  MIN_ROUTING_SAMPLE_SIZE,
  buildFitMatrix,
  deterministicScore,
}
