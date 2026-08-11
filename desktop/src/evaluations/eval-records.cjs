const crypto = require('node:crypto')
const { z } = require('zod')

const { AGENT_CAPABILITY_DOMAINS } = require('../agents/agent-runtime-contract.cjs')
const { isSupportedAgentKind } = require('../workspace/local-workspace-contracts.cjs')
const { canonicalJson } = require('../collaboration/outcome-records.cjs')
const { redactSecrets } = require('../security/secret-redaction.cjs')

const EVAL_CASE_VERSION = 1
const EVAL_RESULT_VERSION = 1
const FIT_MATRIX_VERSION = 1
const MAX_EVAL_RECORD_BYTES = 512 * 1024
const MAX_CASE_REQUIREMENTS = 32
const MAX_RESULT_ITEMS = 64
const MAX_MATRIX_RESULTS = 4096
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const EVAL_CASE_ID = /^eval-case-[a-f0-9]{64}$/
const EVAL_RESULT_ID = /^eval-result-[a-f0-9]{64}$/
const FIT_MATRIX_ID = /^fit-matrix-[a-f0-9]{64}$/
const FORBIDDEN_FIELD = /(?:^|[_-])(?:api-?key|authorization|chain-?of-?thought|commands?|credentials?|env|executable(?:-?path)?|password|private-?key|raw-?output|reasoning|secret|session-?ref|token|tool-?output)(?:$|[_-])/i

function evalRecordError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function fail(code) {
  throw evalRecordError(code)
}

function plainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertSafeContent(value, prefix, seen = new Set()) {
  if (typeof value === 'string') {
    if (redactSecrets(value) !== value) fail(`${prefix}_FORBIDDEN_VALUE`)
    return
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return
  if (!value || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') fail(`${prefix}_SCHEMA_INVALID`)
    const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    if (FORBIDDEN_FIELD.test(normalizedKey)) fail(`${prefix}_FORBIDDEN_FIELD`)
    assertSafeContent(value[key], prefix, seen)
  }
}

function parseInput(value, prefix) {
  if (typeof value === 'string' || Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
    if (!bytes.length || bytes.length > MAX_EVAL_RECORD_BYTES) fail(`${prefix}_SCHEMA_INVALID`)
    try { return JSON.parse(bytes.toString('utf8')) } catch { fail(`${prefix}_SCHEMA_INVALID`) }
  }
  return value
}

function validated(schema, value, prefix) {
  assertSafeContent(value, prefix)
  const result = schema.safeParse(value)
  if (!result.success) fail(`${prefix}_SCHEMA_INVALID`)
  return result.data
}

function deriveId(prefix, body) {
  return `${prefix}-${crypto.createHash('sha256').update(canonicalJson(body)).digest('hex')}`
}

function createRecord(input, schema, idKey, idPrefix, errorPrefix) {
  const body = validated(schema, input, errorPrefix)
  const record = { ...body, [idKey]: deriveId(idPrefix, body) }
  return Object.freeze(record)
}

function parseRecord(input, schema, idKey, idPrefix, idPattern, errorPrefix) {
  const candidate = parseInput(input, errorPrefix)
  assertSafeContent(candidate, errorPrefix)
  if (!plainRecord(candidate) || !Object.hasOwn(candidate, idKey)) {
    fail(`${errorPrefix}_SCHEMA_INVALID`)
  }
  const { [idKey]: actualId, ...rawBody } = candidate
  if (typeof actualId !== 'string' || !idPattern.test(actualId)) {
    fail(`${errorPrefix}_SCHEMA_INVALID`)
  }
  const body = validated(schema, rawBody, errorPrefix)
  if (actualId !== deriveId(idPrefix, body)) fail(`${errorPrefix}_ID_MISMATCH`)
  return Object.freeze({ ...body, [idKey]: actualId })
}

const publicId = z.string().regex(PUBLIC_ID)
const boundedText = max => z.string().trim().min(1).max(max)
const primitive = z.union([z.string().max(2000), z.number().finite(), z.boolean()])
const routingDomain = z.enum(AGENT_CAPABILITY_DOMAINS)

const requirementSchema = z.strictObject({
  id: publicId,
  type: publicId,
  minCount: z.number().int().min(1).max(64),
})

const rubricCheckSchema = z.discriminatedUnion('type', [
  z.strictObject({
    id: publicId,
    type: z.literal('artifact-requirement'),
    requirementId: publicId,
    weight: z.number().int().min(1).max(100),
  }),
  z.strictObject({
    id: publicId,
    type: z.literal('evidence-requirement'),
    requirementId: publicId,
    weight: z.number().int().min(1).max(100),
  }),
  z.strictObject({
    id: publicId,
    type: z.literal('signal-equals'),
    signal: publicId,
    expected: primitive,
    weight: z.number().int().min(1).max(100),
  }),
  z.strictObject({
    id: publicId,
    type: z.literal('signal-at-least'),
    signal: publicId,
    minimum: z.number().finite(),
    weight: z.number().int().min(1).max(100),
  }),
])

const evalCaseBodySchema = z.strictObject({
  schemaVersion: z.literal(EVAL_CASE_VERSION),
  caseKey: publicId,
  caseVersion: publicId,
  title: boundedText(160),
  domain: publicId,
  routingDomains: z.array(routingDomain).min(1).max(8),
  input: z.strictObject({
    prompt: boundedText(20000),
    contextVersion: publicId,
  }),
  constraints: z.array(z.strictObject({
    id: publicId,
    statement: boundedText(1000),
  })).min(1).max(MAX_CASE_REQUIREMENTS),
  expectedArtifacts: z.array(requirementSchema).min(1).max(MAX_CASE_REQUIREMENTS),
  evidenceRequirements: z.array(requirementSchema).min(1).max(MAX_CASE_REQUIREMENTS),
  rubric: z.strictObject({
    version: publicId,
    checks: z.array(rubricCheckSchema).min(1).max(MAX_CASE_REQUIREMENTS),
  }),
}).superRefine((value, context) => {
  for (const values of [
    value.routingDomains,
    value.constraints.map(item => item.id),
    value.expectedArtifacts.map(item => item.id),
    value.evidenceRequirements.map(item => item.id),
    value.rubric.checks.map(item => item.id),
  ]) {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', message: 'duplicate value' })
    }
  }
  if (value.rubric.checks.reduce((total, check) => total + check.weight, 0) !== 100) {
    context.addIssue({ code: 'custom', message: 'rubric weights must total 100' })
  }
  const artifactIds = new Set(value.expectedArtifacts.map(item => item.id))
  const evidenceIds = new Set(value.evidenceRequirements.map(item => item.id))
  for (const check of value.rubric.checks) {
    if (check.type === 'artifact-requirement' && !artifactIds.has(check.requirementId)) {
      context.addIssue({ code: 'custom', message: 'unknown artifact requirement' })
    }
    if (check.type === 'evidence-requirement' && !evidenceIds.has(check.requirementId)) {
      context.addIssue({ code: 'custom', message: 'unknown evidence requirement' })
    }
  }
})

const participantSchema = z.strictObject({
  kind: publicId.refine(isSupportedAgentKind),
  connectorId: publicId,
  connectorVersion: publicId.nullable(),
  provider: publicId.nullable(),
  model: publicId.nullable(),
})

const targetSchema = z.strictObject({
  mode: z.enum(['single-agent', 'workflow']),
  participants: z.array(participantSchema).min(1).max(16),
  workflow: z.strictObject({ id: publicId, version: publicId }).nullable(),
}).superRefine((value, context) => {
  if (new Set(value.participants.map(item => item.kind)).size !== value.participants.length) {
    context.addIssue({ code: 'custom', message: 'duplicate participant' })
  }
  if (value.mode === 'single-agent' && (value.participants.length !== 1 || value.workflow !== null)) {
    context.addIssue({ code: 'custom', message: 'invalid single Agent target' })
  }
  if (value.mode === 'workflow' && value.workflow === null) {
    context.addIssue({ code: 'custom', message: 'workflow identity required' })
  }
})

const usageSchema = z.strictObject({
  inputTokens: z.number().int().min(0).nullable(),
  outputTokens: z.number().int().min(0).nullable(),
  toolCalls: z.number().int().min(0).nullable(),
  estimatedCostUsd: z.number().min(0).finite().nullable(),
})

const failureSchema = z.strictObject({
  code: publicId,
  stage: publicId,
  retryable: z.boolean(),
  summary: boundedText(1000),
})

const observedArtifactSchema = z.strictObject({
  type: publicId,
  artifactId: publicId.nullable(),
})

const observedEvidenceSchema = z.strictObject({
  type: publicId,
  evidenceId: publicId.nullable(),
})

const signalSchema = z.strictObject({ name: publicId, value: primitive })

const reviewSchema = z.strictObject({
  reviewerKind: z.enum(['deterministic', 'model', 'human']),
  reviewerId: publicId,
  blinded: z.boolean(),
  score: z.number().min(0).max(100).finite(),
  evidenceRefs: z.array(publicId).max(64),
  summary: boundedText(2000),
}).superRefine((value, context) => {
  if (value.reviewerKind === 'deterministic' && value.blinded) {
    context.addIssue({ code: 'custom', message: 'deterministic review cannot be blinded' })
  }
  if (new Set(value.evidenceRefs).size !== value.evidenceRefs.length) {
    context.addIssue({ code: 'custom', message: 'duplicate review evidence' })
  }
})

const scoreCheckSchema = z.strictObject({
  checkId: publicId,
  passed: z.boolean(),
  awarded: z.number().min(0).max(100).finite(),
  possible: z.number().min(1).max(100).finite(),
})

const scoringSchema = z.strictObject({
  deterministicScore: z.number().min(0).max(100).finite(),
  reviewScore: z.number().min(0).max(100).finite().nullable(),
  overallScore: z.number().min(0).max(100).finite(),
  checks: z.array(scoreCheckSchema).min(1).max(MAX_CASE_REQUIREMENTS),
})

const evalObservationSchema = z.strictObject({
  status: z.enum(['completed', 'partial', 'failed']),
  usage: usageSchema,
  failures: z.array(failureSchema).max(MAX_RESULT_ITEMS),
  artifacts: z.array(observedArtifactSchema).max(MAX_RESULT_ITEMS),
  evidence: z.array(observedEvidenceSchema).max(MAX_RESULT_ITEMS),
  signals: z.array(signalSchema).max(MAX_RESULT_ITEMS),
  reviews: z.array(reviewSchema).max(MAX_RESULT_ITEMS),
}).superRefine((value, context) => {
  if (new Set(value.signals.map(item => item.name)).size !== value.signals.length) {
    context.addIssue({ code: 'custom', message: 'duplicate signal' })
  }
  if (value.status === 'failed' && value.failures.length === 0) {
    context.addIssue({ code: 'custom', message: 'failed result requires a failure' })
  }
})

const evalResultBodySchema = z.strictObject({
  schemaVersion: z.literal(EVAL_RESULT_VERSION),
  evalCaseId: z.string().regex(EVAL_CASE_ID),
  caseVersion: publicId,
  target: targetSchema,
  promptVersion: publicId,
  contextVersion: publicId,
  durationMs: z.number().int().min(0).max(7 * 24 * 60 * 60 * 1000),
  status: z.enum(['completed', 'partial', 'failed']),
  usage: usageSchema,
  failures: z.array(failureSchema).max(MAX_RESULT_ITEMS),
  artifacts: z.array(observedArtifactSchema).max(MAX_RESULT_ITEMS),
  evidence: z.array(observedEvidenceSchema).max(MAX_RESULT_ITEMS),
  signals: z.array(signalSchema).max(MAX_RESULT_ITEMS),
  reviewerEvidence: z.array(reviewSchema).min(1).max(MAX_RESULT_ITEMS),
  scoring: scoringSchema,
}).superRefine((value, context) => {
  if (new Set(value.signals.map(item => item.name)).size !== value.signals.length) {
    context.addIssue({ code: 'custom', message: 'duplicate result signal' })
  }
  if (value.status === 'failed' && value.failures.length === 0) {
    context.addIssue({ code: 'custom', message: 'failed result requires a failure' })
  }
  const checks = value.scoring.checks
  if (new Set(checks.map(check => check.checkId)).size !== checks.length
      || checks.reduce((total, check) => total + check.possible, 0) !== 100
      || checks.some(check => check.awarded !== (check.passed ? check.possible : 0))) {
    context.addIssue({ code: 'custom', message: 'invalid deterministic scoring' })
  }
  const deterministicScore = checks.reduce((total, check) => total + check.awarded, 0)
  const deterministicReviews = value.reviewerEvidence.filter(
    review => review.reviewerKind === 'deterministic',
  )
  const reviewerKeys = value.reviewerEvidence.map(
    review => `${review.reviewerKind}:${review.reviewerId}`,
  )
  const passedCheckIds = new Set(checks.filter(check => check.passed).map(check => check.checkId))
  if (deterministicReviews.length !== 1
      || deterministicReviews[0].score !== deterministicScore
      || deterministicReviews[0].evidenceRefs.some(id => !passedCheckIds.has(id))
      || new Set(reviewerKeys).size !== reviewerKeys.length
      || value.scoring.deterministicScore !== deterministicScore) {
    context.addIssue({ code: 'custom', message: 'deterministic review mismatch' })
  }
  const externalReviews = value.reviewerEvidence.filter(
    review => review.reviewerKind !== 'deterministic',
  )
  const expectedReviewScore = externalReviews.length
    ? Math.round((externalReviews.reduce((total, review) => total + review.score, 0)
      / externalReviews.length) * 100) / 100
    : null
  const expectedOverall = expectedReviewScore === null
    ? deterministicScore
    : Math.round(((deterministicScore * 0.7) + (expectedReviewScore * 0.3)) * 100) / 100
  if (value.scoring.reviewScore !== expectedReviewScore
      || value.scoring.overallScore !== expectedOverall) {
    context.addIssue({ code: 'custom', message: 'review scoring mismatch' })
  }
})

const fitEntrySchema = z.strictObject({
  kind: publicId.refine(isSupportedAgentKind),
  domains: z.array(routingDomain).min(1).max(8),
  score: z.number().min(0).max(100).finite(),
  confidence: z.number().min(0).max(1).finite(),
  sampleSize: z.number().int().min(1).max(MAX_MATRIX_RESULTS),
  routingEligible: z.boolean(),
  qualification: z.enum(['qualified', 'insufficient-evidence']),
  resultIds: z.array(z.string().regex(EVAL_RESULT_ID)).min(1).max(MAX_MATRIX_RESULTS),
})

const workflowFitEntrySchema = z.strictObject({
  workflowId: publicId,
  workflowVersion: publicId,
  domains: z.array(routingDomain).min(1).max(8),
  score: z.number().min(0).max(100).finite(),
  confidence: z.number().min(0).max(1).finite(),
  sampleSize: z.number().int().min(1).max(MAX_MATRIX_RESULTS),
  qualification: z.enum(['qualified', 'insufficient-evidence']),
  resultIds: z.array(z.string().regex(EVAL_RESULT_ID)).min(1).max(MAX_MATRIX_RESULTS),
})

const fitMatrixBodySchema = z.strictObject({
  schemaVersion: z.literal(FIT_MATRIX_VERSION),
  corpusVersion: publicId,
  resultIds: z.array(z.string().regex(EVAL_RESULT_ID)).min(1).max(MAX_MATRIX_RESULTS),
  entries: z.array(fitEntrySchema).max(512),
  workflowEntries: z.array(workflowFitEntrySchema).max(512),
}).superRefine((value, context) => {
  const resultIds = new Set(value.resultIds)
  if (resultIds.size !== value.resultIds.length) {
    context.addIssue({ code: 'custom', message: 'duplicate matrix result' })
  }
  for (const entry of [...value.entries, ...value.workflowEntries]) {
    if (new Set(entry.domains).size !== entry.domains.length
        || new Set(entry.resultIds).size !== entry.resultIds.length
        || entry.resultIds.some(id => !resultIds.has(id))) {
      context.addIssue({ code: 'custom', message: 'invalid matrix evidence reference' })
    }
  }
  for (const entry of value.entries) {
    if ((entry.qualification === 'qualified') !== entry.routingEligible) {
      context.addIssue({ code: 'custom', message: 'matrix qualification mismatch' })
    }
  }
  for (const entry of [...value.entries, ...value.workflowEntries]) {
    const qualified = entry.sampleSize >= 3 && entry.confidence >= 0.6
    if ((entry.qualification === 'qualified') !== qualified) {
      context.addIssue({ code: 'custom', message: 'matrix evidence threshold mismatch' })
    }
  }
  const agentDomainKeys = value.entries.flatMap(entry => (
    entry.domains.map(domain => `${entry.kind}:${domain}`)
  ))
  const workflowDomainKeys = value.workflowEntries.flatMap(entry => (
    entry.domains.map(domain => `${entry.workflowId}:${entry.workflowVersion}:${domain}`)
  ))
  if (new Set(agentDomainKeys).size !== agentDomainKeys.length
      || new Set(workflowDomainKeys).size !== workflowDomainKeys.length) {
    context.addIssue({ code: 'custom', message: 'duplicate matrix fit entry' })
  }
})

function createEvalCase(input) {
  return createRecord(
    input, evalCaseBodySchema, 'evalCaseId', 'eval-case', 'EVAL_CASE',
  )
}

function parseEvalCase(input) {
  return parseRecord(
    input, evalCaseBodySchema, 'evalCaseId', 'eval-case', EVAL_CASE_ID, 'EVAL_CASE',
  )
}

function normalizeEvalTarget(input) {
  return Object.freeze(validated(targetSchema, input, 'EVAL_TARGET'))
}

function normalizeEvalObservation(input) {
  return Object.freeze(validated(evalObservationSchema, input, 'EVAL_OBSERVATION'))
}

function createEvalResult(input) {
  return createRecord(
    input, evalResultBodySchema, 'evalResultId', 'eval-result', 'EVAL_RESULT',
  )
}

function parseEvalResult(input) {
  return parseRecord(
    input, evalResultBodySchema, 'evalResultId', 'eval-result', EVAL_RESULT_ID, 'EVAL_RESULT',
  )
}

function createFitMatrix(input) {
  return createRecord(
    input, fitMatrixBodySchema, 'matrixId', 'fit-matrix', 'FIT_MATRIX',
  )
}

function parseFitMatrix(input) {
  return parseRecord(
    input, fitMatrixBodySchema, 'matrixId', 'fit-matrix', FIT_MATRIX_ID, 'FIT_MATRIX',
  )
}

module.exports = {
  EVAL_CASE_VERSION,
  EVAL_RESULT_VERSION,
  FIT_MATRIX_VERSION,
  MAX_EVAL_RECORD_BYTES,
  createEvalCase,
  createEvalResult,
  createFitMatrix,
  normalizeEvalObservation,
  normalizeEvalTarget,
  parseEvalCase,
  parseEvalResult,
  parseFitMatrix,
}
