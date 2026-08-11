const test = require('node:test')
const assert = require('node:assert/strict')

const {
  EVAL_CASE_VERSION,
  EVAL_RESULT_VERSION,
  FIT_MATRIX_VERSION,
  createEvalCase,
  createEvalResult,
  createFitMatrix,
  normalizeEvalObservation,
  normalizeEvalTarget,
  parseEvalCase,
  parseEvalResult,
  parseFitMatrix,
} = require('../../src/evaluations/eval-records.cjs')

function caseInput(overrides = {}) {
  return {
    schemaVersion: EVAL_CASE_VERSION,
    caseKey: 'research-synthesis',
    caseVersion: '1.0.0',
    title: 'Research synthesis with source evidence',
    domain: 'research',
    routingDomains: ['research'],
    input: { prompt: 'Synthesize the supplied facts.', contextVersion: 'context-v1' },
    constraints: [{ id: 'local-only', statement: 'Do not use external state.' }],
    expectedArtifacts: [{ id: 'report', type: 'document', minCount: 1 }],
    evidenceRequirements: [{ id: 'citations', type: 'citation', minCount: 2 }],
    rubric: {
      version: 'rubric-v1',
      checks: [
        { id: 'artifact', type: 'artifact-requirement', requirementId: 'report', weight: 25 },
        { id: 'evidence', type: 'evidence-requirement', requirementId: 'citations', weight: 25 },
        { id: 'facts', type: 'signal-equals', signal: 'facts-supported', expected: true, weight: 25 },
        { id: 'coverage', type: 'signal-at-least', signal: 'source-count', minimum: 2, weight: 25 },
      ],
    },
    ...overrides,
  }
}

function target() {
  return {
    mode: 'single-agent',
    participants: [{
      kind: 'codex',
      connectorId: 'builtin.codex',
      connectorVersion: '0.1.0',
      provider: null,
      model: null,
    }],
    workflow: null,
  }
}

function resultInput(evalCase) {
  return {
    schemaVersion: EVAL_RESULT_VERSION,
    evalCaseId: evalCase.evalCaseId,
    caseVersion: evalCase.caseVersion,
    target: target(),
    promptVersion: 'rubric-v1',
    contextVersion: 'context-v1',
    durationMs: 12,
    status: 'completed',
    usage: { inputTokens: 10, outputTokens: 20, toolCalls: 0, estimatedCostUsd: null },
    failures: [],
    artifacts: [{ type: 'document', artifactId: null }],
    evidence: [
      { type: 'citation', evidenceId: null },
      { type: 'citation', evidenceId: null },
    ],
    signals: [
      { name: 'facts-supported', value: true },
      { name: 'source-count', value: 2 },
    ],
    reviewerEvidence: [{
      reviewerKind: 'deterministic',
      reviewerId: 'meldwork-eval-v1',
      blinded: false,
      score: 100,
      evidenceRefs: ['artifact', 'evidence', 'facts', 'coverage'],
      summary: 'Deterministic rubric checks completed.',
    }],
    scoring: {
      deterministicScore: 100,
      reviewScore: null,
      overallScore: 100,
      checks: [
        { checkId: 'artifact', passed: true, awarded: 25, possible: 25 },
        { checkId: 'evidence', passed: true, awarded: 25, possible: 25 },
        { checkId: 'facts', passed: true, awarded: 25, possible: 25 },
        { checkId: 'coverage', passed: true, awarded: 25, possible: 25 },
      ],
    },
  }
}

test('Eval records are strict, versioned, content-addressed, and canonical', () => {
  const evalCase = createEvalCase(caseInput())
  const reordered = createEvalCase({
    rubric: caseInput().rubric,
    evidenceRequirements: caseInput().evidenceRequirements,
    expectedArtifacts: caseInput().expectedArtifacts,
    constraints: caseInput().constraints,
    input: caseInput().input,
    routingDomains: ['research'],
    domain: 'research',
    title: 'Research synthesis with source evidence',
    caseVersion: '1.0.0',
    caseKey: 'research-synthesis',
    schemaVersion: EVAL_CASE_VERSION,
  })
  assert.deepEqual(reordered, evalCase)
  assert.deepEqual(parseEvalCase(JSON.stringify(evalCase)), evalCase)
  assert.throws(() => parseEvalCase({ ...evalCase, title: 'forged' }), {
    message: 'EVAL_CASE_ID_MISMATCH',
  })
  assert.throws(() => createEvalCase({ ...caseInput(), executablePath: '/bin/tool' }), {
    message: 'EVAL_CASE_FORBIDDEN_FIELD',
  })
  assert.throws(() => createEvalCase({
    ...caseInput(),
    input: { ...caseInput().input, prompt: 'Authorization: Bearer example-secret' },
  }), { message: 'EVAL_CASE_FORBIDDEN_VALUE' })
})

test('targets and observations capture observable runtime facts without raw execution state', () => {
  assert.deepEqual(normalizeEvalTarget(target()), target())
  assert.throws(() => normalizeEvalTarget({
    ...target(),
    participants: [...target().participants, target().participants[0]],
  }), { message: 'EVAL_TARGET_SCHEMA_INVALID' })
  assert.throws(() => normalizeEvalObservation({
    status: 'completed',
    usage: { inputTokens: null, outputTokens: null, toolCalls: null, estimatedCostUsd: null },
    failures: [], artifacts: [], evidence: [], signals: [], reviews: [],
    rawOutput: 'unbounded output',
  }), { message: 'EVAL_OBSERVATION_FORBIDDEN_FIELD' })
})

test('result and frozen matrix records preserve identified review evidence and sample confidence', () => {
  const evalCase = createEvalCase(caseInput())
  const result = createEvalResult(resultInput(evalCase))
  assert.deepEqual(parseEvalResult(JSON.stringify(result)), result)
  assert.throws(() => createEvalResult({
    ...resultInput(evalCase),
    scoring: { ...resultInput(evalCase).scoring, overallScore: 99 },
  }), { message: 'EVAL_RESULT_SCHEMA_INVALID' })
  const matrix = createFitMatrix({
    schemaVersion: FIT_MATRIX_VERSION,
    corpusVersion: 'deterministic-v1',
    resultIds: [result.evalResultId],
    entries: [{
      kind: 'codex',
      domains: ['research'],
      score: 100,
      confidence: 0.317,
      sampleSize: 1,
      routingEligible: false,
      qualification: 'insufficient-evidence',
      resultIds: [result.evalResultId],
    }],
    workflowEntries: [],
  })
  assert.deepEqual(parseFitMatrix(JSON.stringify(matrix)), matrix)
  assert.throws(() => createFitMatrix({
    ...matrix,
    entries: [{ ...matrix.entries[0], routingEligible: true }],
    matrixId: undefined,
  }), { message: 'FIT_MATRIX_SCHEMA_INVALID' })
})
