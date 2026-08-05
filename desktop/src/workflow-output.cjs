const crypto = require('node:crypto')
const { z } = require('zod')

const { canonicalJson } = require('./outcome-records.cjs')
const { redactSecrets } = require('./secret-redaction.cjs')

const WORKFLOW_OUTPUT_VERSION = 1
const WORKFLOW_OUTCOME_VERSION = 1
const MAX_WORKFLOW_OUTPUT_BYTES = 256 * 1024
const MAX_WORKFLOW_OUTCOME_BYTES = 256 * 1024
const MAX_CRITERIA = 32
const MAX_EVIDENCE_IDS = 64
const MAX_WORKFLOW_NODES = 64
const MAX_SUMMARY_CHARS = 4000

const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const ARTIFACT_ID = /^artifact-[a-f0-9]{64}$/
const EVIDENCE_ID = /^evidence-[a-f0-9]{64}$/
const WORKFLOW_ID = /^workflow-[a-f0-9]{64}$/
const CONTEXT_PACK_ID = /^context-pack-[a-f0-9]{64}$/
const REVIEWER_FINDING_ID = /^reviewer-finding-[a-f0-9]{64}$/
const ADOPTION_ID = /^adoption-[a-f0-9]{64}$/
const WORKFLOW_OUTCOME_ID = /^workflow-outcome-[a-f0-9]{64}$/
const FORBIDDEN_OUTPUT_FORMAT = /```|~~~|\[\[ROUNDRELAY_CONSENSUS:[^\]]*\]\]/i

function outputError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function fail(code) {
  throw outputError(code)
}

function safeSummarySchema() {
  return z.string().min(1).max(MAX_SUMMARY_CHARS).superRefine((value, context) => {
    if (FORBIDDEN_OUTPUT_FORMAT.test(value) || redactSecrets(value) !== value) {
      context.addIssue({ code: 'custom', message: 'unsafe workflow output summary' })
    }
  })
}

function uniqueArray(schema, max, message) {
  return z.array(schema).max(max).superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', message })
    }
  })
}

const publicIdSchema = z.string().min(1).max(120).regex(PUBLIC_ID)
const artifactIdSchema = z.string().regex(ARTIFACT_ID)
const evidenceIdSchema = z.string().regex(EVIDENCE_ID)
const workflowIdSchema = z.string().regex(WORKFLOW_ID)
const contextPackIdSchema = z.string().regex(CONTEXT_PACK_ID)
const reviewerFindingIdSchema = z.string().regex(REVIEWER_FINDING_ID)
const adoptionIdSchema = z.string().regex(ADOPTION_ID)
const workflowOutcomeIdSchema = z.string().regex(WORKFLOW_OUTCOME_ID)
const evidenceIdsSchema = uniqueArray(evidenceIdSchema, MAX_EVIDENCE_IDS, 'duplicate Evidence ID')
const criterionResultSchema = z.strictObject({
  criterionId: publicIdSchema,
  status: z.enum(['pass', 'fail']),
  summary: safeSummarySchema(),
  evidenceIds: evidenceIdsSchema,
})
const criterionResultsSchema = z.array(criterionResultSchema).min(1).max(MAX_CRITERIA)

const reviewerOutputSchema = z.strictObject({
  version: z.literal(WORKFLOW_OUTPUT_VERSION),
  kind: z.literal('review'),
  artifactId: artifactIdSchema,
  decision: z.enum(['accept', 'revise', 'reject']),
  summary: safeSummarySchema(),
  criteria: criterionResultsSchema,
})

const arbiterOutputSchema = z.strictObject({
  version: z.literal(WORKFLOW_OUTPUT_VERSION),
  kind: z.literal('arbitration'),
  artifactId: artifactIdSchema,
  decision: z.enum(['accept', 'revise', 'reject']),
  summary: safeSummarySchema(),
  criteria: criterionResultsSchema,
})

const workflowOutcomeContentFields = {
  workflowId: workflowIdSchema,
  taskId: publicIdSchema,
  artifactId: artifactIdSchema,
  status: z.enum(['accepted', 'rejected', 'reopened', 'decision-required']),
  completedNodeIds: uniqueArray(
    publicIdSchema,
    MAX_WORKFLOW_NODES,
    'duplicate completed workflow node',
  ),
  findingIds: uniqueArray(
    reviewerFindingIdSchema,
    MAX_WORKFLOW_NODES,
    'duplicate workflow Finding ID',
  ),
  adoptionId: adoptionIdSchema.nullable(),
  reviewerContextPackId: contextPackIdSchema,
  arbiterContextPackId: contextPackIdSchema.nullable(),
}

function validateWorkflowOutcome(outcome, context) {
  if (outcome.completedNodeIds.length < 1 || outcome.findingIds.length < 1) {
    context.addIssue({ code: 'custom', message: 'workflow outcome references required' })
  }
  if ((outcome.status !== 'decision-required') !== Boolean(outcome.adoptionId)) {
    context.addIssue({ code: 'custom', path: ['adoptionId'], message: 'Adoption must match outcome' })
  }
}

const workflowOutcomeInputSchema = z.strictObject(workflowOutcomeContentFields)
  .superRefine(validateWorkflowOutcome)
const workflowOutcomeRecordSchema = z.strictObject({
  workflowOutcomeId: workflowOutcomeIdSchema,
  version: z.literal(WORKFLOW_OUTCOME_VERSION),
  recordType: z.literal('workflow-outcome'),
  ...workflowOutcomeContentFields,
}).superRefine(validateWorkflowOutcome)

function assertPlainJson(value, seen = new Set()) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('WORKFLOW_OUTPUT_JSON_INVALID')
    return
  }
  if (!value || typeof value !== 'object' || seen.has(value)) {
    fail('WORKFLOW_OUTPUT_JSON_INVALID')
  }
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value)
      if (keys.length !== value.length
          || keys.some((key, index) => key !== String(index))) {
        fail('WORKFLOW_OUTPUT_JSON_INVALID')
      }
      for (const item of value) assertPlainJson(item, seen)
      return
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      fail('WORKFLOW_OUTPUT_JSON_INVALID')
    }
    const descriptors = Object.getOwnPropertyDescriptors(value)
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !descriptors[key].enumerable
          || typeof descriptors[key].get === 'function'
          || typeof descriptors[key].set === 'function') {
        fail('WORKFLOW_OUTPUT_JSON_INVALID')
      }
      assertPlainJson(value[key], seen)
    }
  } finally {
    seen.delete(value)
  }
}

function assertNoForbiddenFormat(value, seen = new Set()) {
  if (typeof value === 'string') {
    if (FORBIDDEN_OUTPUT_FORMAT.test(value)) fail('WORKFLOW_OUTPUT_FORMAT_FORBIDDEN')
    return
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  try {
    for (const item of Array.isArray(value) ? value : Object.values(value)) {
      assertNoForbiddenFormat(item, seen)
    }
  } finally {
    seen.delete(value)
  }
}

function parseJsonInput(input) {
  let parsed
  if (Buffer.isBuffer(input) || input instanceof Uint8Array || typeof input === 'string') {
    const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input)
    if (!bytes.length || bytes.length > MAX_WORKFLOW_OUTPUT_BYTES
        || !Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) {
      fail('WORKFLOW_OUTPUT_JSON_INVALID')
    }
    const text = bytes.toString('utf8')
    if (FORBIDDEN_OUTPUT_FORMAT.test(text)) fail('WORKFLOW_OUTPUT_FORMAT_FORBIDDEN')
    try { parsed = JSON.parse(text) } catch { fail('WORKFLOW_OUTPUT_JSON_INVALID') }
  } else {
    assertPlainJson(input)
    parsed = input
  }
  assertPlainJson(parsed)
  assertNoForbiddenFormat(parsed)
  return parsed
}

function normalizeAllowlist(values, pattern, max, code, minimum = 1) {
  if (!Array.isArray(values) || values.length < minimum || values.length > max
      || values.some(value => typeof value !== 'string' || !pattern.test(value))
      || new Set(values).size !== values.length) {
    fail(code)
  }
  return [...values]
}

function normalizeOptions(options) {
  const artifactId = options?.artifactId
  if (typeof artifactId !== 'string' || !ARTIFACT_ID.test(artifactId)) {
    fail('WORKFLOW_OUTPUT_CONSTRAINTS_INVALID')
  }
  return {
    artifactId,
    criterionIds: normalizeAllowlist(
      options?.criterionIds,
      PUBLIC_ID,
      MAX_CRITERIA,
      'WORKFLOW_OUTPUT_CONSTRAINTS_INVALID',
    ),
    evidenceIds: new Set(normalizeAllowlist(
      options?.evidenceIds,
      EVIDENCE_ID,
      MAX_EVIDENCE_IDS,
      'WORKFLOW_OUTPUT_CONSTRAINTS_INVALID',
      0,
    )),
  }
}

function normalizeOutput(input, schema, expectedKind, options) {
  const constraints = normalizeOptions(options)
  const parsed = parseJsonInput(input)
  if (parsed?.kind !== expectedKind) fail('WORKFLOW_OUTPUT_KIND_INVALID')
  const result = schema.safeParse(parsed)
  if (!result.success) fail('WORKFLOW_OUTPUT_SCHEMA_INVALID')
  const output = result.data
  if (output.artifactId !== constraints.artifactId) {
    fail('WORKFLOW_OUTPUT_ARTIFACT_MISMATCH')
  }
  const resultsById = new Map()
  for (const criterion of output.criteria) {
    if (resultsById.has(criterion.criterionId)) fail('WORKFLOW_OUTPUT_CRITERIA_MISMATCH')
    if (criterion.evidenceIds.some(id => !constraints.evidenceIds.has(id))) {
      fail('WORKFLOW_OUTPUT_EVIDENCE_UNKNOWN')
    }
    resultsById.set(criterion.criterionId, criterion)
  }
  if (resultsById.size !== constraints.criterionIds.length
      || constraints.criterionIds.some(id => !resultsById.has(id))) {
    fail('WORKFLOW_OUTPUT_CRITERIA_MISMATCH')
  }
  return {
    ...output,
    criteria: constraints.criterionIds.map((criterionId) => {
      const criterion = resultsById.get(criterionId)
      return { ...criterion, evidenceIds: [...criterion.evidenceIds].sort() }
    }),
  }
}

function parseReviewerOutput(input, options) {
  return normalizeOutput(input, reviewerOutputSchema, 'review', options)
}

function parseArbiterOutput(input, options) {
  return normalizeOutput(input, arbiterOutputSchema, 'arbitration', options)
}

function parseWorkflowOutput(input, options) {
  const parsed = parseJsonInput(input)
  if (parsed?.kind === 'review') return parseReviewerOutput(parsed, options)
  if (parsed?.kind === 'arbitration') return parseArbiterOutput(parsed, options)
  fail('WORKFLOW_OUTPUT_KIND_INVALID')
}

function workflowOutcomeId(body) {
  const hash = crypto.createHash('sha256').update(canonicalJson(body)).digest('hex')
  return `workflow-outcome-${hash}`
}

function canonicalWorkflowOutcome(record) {
  const serialized = canonicalJson(record)
  if (Buffer.byteLength(serialized) > MAX_WORKFLOW_OUTCOME_BYTES) {
    fail('WORKFLOW_OUTCOME_SCHEMA_INVALID')
  }
  return serialized
}

function createWorkflowOutcome(input) {
  assertPlainJson(input)
  const result = workflowOutcomeInputSchema.safeParse(input)
  if (!result.success) fail('WORKFLOW_OUTCOME_SCHEMA_INVALID')
  const body = {
    version: WORKFLOW_OUTCOME_VERSION,
    recordType: 'workflow-outcome',
    ...result.data,
  }
  const record = { workflowOutcomeId: workflowOutcomeId(body), ...body }
  return JSON.parse(canonicalWorkflowOutcome(record))
}

function parseWorkflowOutcome(input) {
  let serialized = null
  if (Buffer.isBuffer(input) || input instanceof Uint8Array || typeof input === 'string') {
    const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input)
    if (!bytes.length || bytes.length > MAX_WORKFLOW_OUTCOME_BYTES
        || !Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) {
      fail('WORKFLOW_OUTCOME_JSON_INVALID')
    }
    serialized = bytes.toString('utf8')
    try { input = JSON.parse(serialized) } catch { fail('WORKFLOW_OUTCOME_JSON_INVALID') }
  }
  assertPlainJson(input)
  const result = workflowOutcomeRecordSchema.safeParse(input)
  if (!result.success) fail('WORKFLOW_OUTCOME_SCHEMA_INVALID')
  const record = result.data
  const { workflowOutcomeId: id, ...body } = record
  if (workflowOutcomeId(body) !== id) fail('WORKFLOW_OUTCOME_ID_MISMATCH')
  const canonical = canonicalWorkflowOutcome(record)
  if (serialized !== null && serialized !== canonical) {
    fail('WORKFLOW_OUTCOME_JSON_NOT_CANONICAL')
  }
  return JSON.parse(canonical)
}

function serializeWorkflowOutcome(input) {
  return canonicalJson(parseWorkflowOutcome(input))
}

module.exports = {
  MAX_WORKFLOW_OUTCOME_BYTES,
  MAX_WORKFLOW_OUTPUT_BYTES,
  WORKFLOW_OUTCOME_VERSION,
  WORKFLOW_OUTPUT_VERSION,
  createWorkflowOutcome,
  parseArbiterOutput,
  parseReviewerOutput,
  parseWorkflowOutcome,
  parseWorkflowOutput,
  serializeWorkflowOutcome,
}
