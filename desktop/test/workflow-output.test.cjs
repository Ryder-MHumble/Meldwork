const assert = require('node:assert/strict')
const test = require('node:test')

const {
  createWorkflowOutcome,
  parseArbiterOutput,
  parseReviewerOutput,
  parseWorkflowOutcome,
  parseWorkflowOutput,
  serializeWorkflowOutcome,
} = require('../src/workflow-output.cjs')

const ARTIFACT_ID = `artifact-${'a'.repeat(64)}`
const EVIDENCE_A = `evidence-${'b'.repeat(64)}`
const EVIDENCE_B = `evidence-${'c'.repeat(64)}`
const OPTIONS = {
  artifactId: ARTIFACT_ID,
  criterionIds: ['artifact-ready', 'tests-pass'],
  evidenceIds: [EVIDENCE_A, EVIDENCE_B],
}

function reviewerOutput(overrides = {}) {
  return {
    version: 1,
    kind: 'review',
    artifactId: ARTIFACT_ID,
    decision: 'accept',
    summary: 'The Artifact satisfies the requested criteria.',
    criteria: [
      {
        criterionId: 'tests-pass',
        status: 'pass',
        summary: 'The focused tests were reproduced.',
        evidenceIds: [EVIDENCE_B, EVIDENCE_A],
      },
      {
        criterionId: 'artifact-ready',
        status: 'pass',
        summary: 'The Artifact exists and is inspectable.',
        evidenceIds: [EVIDENCE_A],
      },
    ],
    ...overrides,
  }
}

test('parses only a complete strict Reviewer JSON object and normalizes set ordering', () => {
  const output = parseReviewerOutput(JSON.stringify(reviewerOutput()), OPTIONS)
  assert.equal(output.kind, 'review')
  assert.deepEqual(output.criteria.map(result => result.criterionId), OPTIONS.criterionIds)
  assert.deepEqual(output.criteria[1].evidenceIds, [EVIDENCE_A, EVIDENCE_B])
  assert.deepEqual(parseWorkflowOutput(output, OPTIONS), output)
  assert.throws(
    () => parseReviewerOutput(`${JSON.stringify(reviewerOutput())}\nextra`, OPTIONS),
    { message: 'WORKFLOW_OUTPUT_JSON_INVALID' },
  )
})

test('parses strict Arbiter output through the shared dispatcher', () => {
  const input = {
    ...reviewerOutput({ kind: 'arbitration', decision: 'revise' }),
    kind: 'arbitration',
  }
  const output = parseArbiterOutput(input, OPTIONS)
  assert.equal(output.kind, 'arbitration')
  assert.equal(output.decision, 'revise')
  assert.deepEqual(parseWorkflowOutput(input, OPTIONS), output)
})

test('rejects Markdown fences, legacy consensus markers, and unknown fields', () => {
  assert.throws(
    () => parseReviewerOutput(`\`\`\`json\n${JSON.stringify(reviewerOutput())}\n\`\`\``, OPTIONS),
    { message: 'WORKFLOW_OUTPUT_FORMAT_FORBIDDEN' },
  )
  assert.throws(
    () => parseReviewerOutput(reviewerOutput({
      summary: 'Accepted [[ROUNDRELAY_CONSENSUS:agree]]',
    }), OPTIONS),
    { message: 'WORKFLOW_OUTPUT_FORMAT_FORBIDDEN' },
  )
  assert.throws(
    () => parseReviewerOutput({ ...reviewerOutput(), extra: true }, OPTIONS),
    { message: 'WORKFLOW_OUTPUT_SCHEMA_INVALID' },
  )
})

test('rejects wrong Artifacts and incomplete, duplicate, or unknown criterion results', () => {
  assert.throws(
    () => parseReviewerOutput(reviewerOutput({
      artifactId: `artifact-${'d'.repeat(64)}`,
    }), OPTIONS),
    { message: 'WORKFLOW_OUTPUT_ARTIFACT_MISMATCH' },
  )
  assert.throws(
    () => parseReviewerOutput(reviewerOutput({
      criteria: reviewerOutput().criteria.slice(0, 1),
    }), OPTIONS),
    { message: 'WORKFLOW_OUTPUT_CRITERIA_MISMATCH' },
  )
  assert.throws(
    () => parseReviewerOutput(reviewerOutput({
      criteria: [reviewerOutput().criteria[0], reviewerOutput().criteria[0]],
    }), OPTIONS),
    { message: 'WORKFLOW_OUTPUT_CRITERIA_MISMATCH' },
  )
  assert.throws(
    () => parseReviewerOutput(reviewerOutput({
      criteria: [
        reviewerOutput().criteria[0],
        { ...reviewerOutput().criteria[1], criterionId: 'unknown-criterion' },
      ],
    }), OPTIONS),
    { message: 'WORKFLOW_OUTPUT_CRITERIA_MISMATCH' },
  )
})

test('rejects Evidence IDs outside the approved allowlist', () => {
  assert.throws(
    () => parseReviewerOutput(reviewerOutput({
      criteria: [
        reviewerOutput().criteria[0],
        {
          ...reviewerOutput().criteria[1],
          evidenceIds: [`evidence-${'d'.repeat(64)}`],
        },
      ],
    }), OPTIONS),
    { message: 'WORKFLOW_OUTPUT_EVIDENCE_UNKNOWN' },
  )
})

test('creates a canonical typed workflow Outcome tied to Findings and Adoption', () => {
  const input = {
    workflowId: `workflow-${'d'.repeat(64)}`,
    taskId: 'task-1',
    artifactId: ARTIFACT_ID,
    status: 'accepted',
    completedNodeIds: ['primary', 'review'],
    findingIds: [`reviewer-finding-${'e'.repeat(64)}`],
    adoptionId: `adoption-${'f'.repeat(64)}`,
    reviewerContextPackId: `context-pack-${'1'.repeat(64)}`,
    arbiterContextPackId: null,
  }
  const outcome = createWorkflowOutcome(input)

  assert.match(outcome.workflowOutcomeId, /^workflow-outcome-[a-f0-9]{64}$/)
  assert.deepEqual(parseWorkflowOutcome(serializeWorkflowOutcome(outcome)), outcome)
  assert.throws(
    () => parseWorkflowOutcome({ ...outcome, status: 'decision-required' }),
    { message: 'WORKFLOW_OUTCOME_SCHEMA_INVALID' },
  )
  assert.throws(
    () => createWorkflowOutcome({ ...input, adoptionId: null }),
    { message: 'WORKFLOW_OUTCOME_SCHEMA_INVALID' },
  )
})

test('records rejected and reopened human workflow outcomes with an Adoption', () => {
  const base = {
    workflowId: `workflow-${'d'.repeat(64)}`,
    taskId: 'task-1',
    artifactId: ARTIFACT_ID,
    completedNodeIds: ['primary', 'review'],
    findingIds: [`reviewer-finding-${'e'.repeat(64)}`],
    adoptionId: `adoption-${'f'.repeat(64)}`,
    reviewerContextPackId: `context-pack-${'1'.repeat(64)}`,
    arbiterContextPackId: null,
  }
  for (const status of ['rejected', 'reopened']) {
    const outcome = createWorkflowOutcome({ ...base, status })
    assert.equal(parseWorkflowOutcome(serializeWorkflowOutcome(outcome)).status, status)
  }
  assert.throws(
    () => createWorkflowOutcome({ ...base, status: 'rejected', adoptionId: null }),
    { message: 'WORKFLOW_OUTCOME_SCHEMA_INVALID' },
  )
})
