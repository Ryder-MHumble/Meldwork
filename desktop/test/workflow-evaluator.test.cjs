const assert = require('node:assert/strict')
const test = require('node:test')

const { createWorkflowDefinition } = require('../src/orchestration-records.cjs')
const { evaluateRoleReviewWorkflow } = require('../src/workflow-evaluator.cjs')

const ARTIFACT_ID = `artifact-${'a'.repeat(64)}`
const EVIDENCE_OBSERVED = `evidence-${'b'.repeat(64)}`
const EVIDENCE_REPRODUCED = `evidence-${'c'.repeat(64)}`

function workflow({ arbiter = true } = {}) {
  const roles = { primary: 'codex', reviewer: 'claude' }
  if (arbiter) roles.arbiter = 'gemini'
  const nodes = [
    {
      nodeId: 'primary',
      role: 'primary',
      agentKind: 'codex',
      dependsOn: [],
      parallelSafe: false,
      criterionIds: [],
    },
    {
      nodeId: 'review',
      role: 'reviewer',
      agentKind: 'claude',
      dependsOn: ['primary'],
      parallelSafe: false,
      criterionIds: ['artifact-ready', 'tests-pass'],
    },
  ]
  if (arbiter) {
    nodes.push({
      nodeId: 'arbitrate',
      role: 'arbiter',
      agentKind: 'gemini',
      dependsOn: ['review'],
      parallelSafe: false,
      criterionIds: ['artifact-ready', 'tests-pass'],
    })
  }
  return createWorkflowDefinition({
    taskId: 'task-1',
    template: 'role-review',
    roles,
    criteria: [
      {
        criterionId: 'artifact-ready',
        kind: 'artifact',
        description: 'The requested Artifact is complete.',
        required: true,
        requiredEvidenceLevel: 'observed',
      },
      {
        criterionId: 'tests-pass',
        kind: 'test',
        description: 'The focused tests pass.',
        required: true,
        requiredEvidenceLevel: 'reproduced',
      },
    ],
    nodes,
  })
}

function actor(agentKind, suffix) {
  return {
    kind: 'agent',
    runId: 'run-1',
    agentRunId: `agent-run-${suffix}`,
    agentKind,
  }
}

function output(kind = 'review', overrides = {}) {
  return {
    version: 1,
    kind,
    artifactId: ARTIFACT_ID,
    decision: 'accept',
    summary: kind === 'review' ? 'Reviewer accepts the Artifact.' : 'Arbiter accepts the Artifact.',
    criteria: [
      {
        criterionId: 'artifact-ready',
        status: 'pass',
        summary: 'The Artifact was observed.',
        evidenceIds: [EVIDENCE_OBSERVED],
      },
      {
        criterionId: 'tests-pass',
        status: 'pass',
        summary: 'The tests were reproduced.',
        evidenceIds: [EVIDENCE_REPRODUCED],
      },
    ],
    ...overrides,
  }
}

function baseInput(overrides = {}) {
  return {
    workflow: workflow(),
    artifactId: ARTIFACT_ID,
    reviewerOutput: output(),
    reviewerActor: actor('claude', 'reviewer'),
    evidenceLevels: new Map([
      [EVIDENCE_OBSERVED, 'observed'],
      [EVIDENCE_REPRODUCED, 'reproduced'],
    ]),
    ...overrides,
  }
}

test('accepts a complete Reviewer decision and emits deterministic Finding and Adoption records', () => {
  const input = baseInput()
  const result = evaluateRoleReviewWorkflow(input)
  assert.equal(result.status, 'completed')
  assert.equal(result.decision, 'accepted')
  assert.equal(result.findingRecords.length, 1)
  assert.equal(result.findingRecords[0].relation, 'support')
  assert.match(result.findingRecords[0].reviewerFindingId, /^reviewer-finding-[a-f0-9]{64}$/)
  assert.equal(result.adoptionRecord.status, 'accepted')
  assert.equal(result.adoptionRecord.actor.agentKind, 'claude')
  assert.deepEqual(result.adoptionRecord.findingIds, [
    result.findingRecords[0].reviewerFindingId,
  ])
  assert.deepEqual(evaluateRoleReviewWorkflow(input), result)
})

test('accepts an explicit independent runtime Reviewer replacement', () => {
  const result = evaluateRoleReviewWorkflow(baseInput({
    reviewerActor: actor('kimi', 'replacement-reviewer'),
    roleAgentKinds: { reviewer: 'kimi', arbiter: 'gemini' },
  }))

  assert.equal(result.status, 'completed')
  assert.equal(result.findingRecords[0].reviewer.agentKind, 'kimi')
  assert.equal(result.adoptionRecord.actor.agentKind, 'kimi')
  assert.throws(
    () => evaluateRoleReviewWorkflow(baseInput({
      reviewerActor: actor('codex', 'conflicting-reviewer'),
      roleAgentKinds: { reviewer: 'codex', arbiter: 'gemini' },
    })),
    { message: 'WORKFLOW_EVALUATION_ACTOR_INVALID' },
  )
})

test('requires an Arbiter after Reviewer rejection or insufficient required Evidence', () => {
  const rejected = evaluateRoleReviewWorkflow(baseInput({
    reviewerOutput: output('review', { decision: 'reject' }),
  }))
  assert.equal(rejected.status, 'arbiter-required')
  assert.equal(rejected.findingRecords[0].relation, 'contradict')

  const insufficient = evaluateRoleReviewWorkflow(baseInput({
    evidenceLevels: {
      [EVIDENCE_OBSERVED]: 'declared',
      [EVIDENCE_REPRODUCED]: 'observed',
    },
  }))
  assert.equal(insufficient.status, 'arbiter-required')
  assert.equal(insufficient.findingRecords[0].relation, 'contradict')
})

test('lets a configured Arbiter resolve a failed review with sufficient Evidence', () => {
  const result = evaluateRoleReviewWorkflow(baseInput({
    reviewerOutput: output('review', { decision: 'revise' }),
    arbiterOutput: output('arbitration'),
    arbiterActor: actor('gemini', 'arbiter'),
  }))
  assert.equal(result.status, 'completed')
  assert.equal(result.decision, 'accepted')
  assert.deepEqual(result.findingRecords.map(finding => finding.relation), [
    'contradict',
    'support',
  ])
  assert.equal(result.adoptionRecord.actor.agentKind, 'gemini')
  assert.deepEqual(result.adoptionRecord.findingIds, result.findingRecords.map(
    finding => finding.reviewerFindingId,
  ))
})

test('produces a decision state for unresolved or conflicting findings', () => {
  const unresolved = evaluateRoleReviewWorkflow(baseInput({
    reviewerOutput: output('review', { decision: 'reject' }),
    arbiterOutput: output('arbitration', { decision: 'revise' }),
    arbiterActor: actor('gemini', 'arbiter'),
  }))
  assert.equal(unresolved.status, 'decision-required')
  assert.deepEqual(unresolved.findingRecords.map(finding => finding.relation), [
    'contradict',
    'contradict',
  ])
  assert.equal(Object.hasOwn(unresolved, 'adoptionRecord'), false)

  const noArbiter = evaluateRoleReviewWorkflow(baseInput({
    workflow: workflow({ arbiter: false }),
    reviewerOutput: output('review', { decision: 'reject' }),
  }))
  assert.equal(noArbiter.status, 'decision-required')
})

test('rejects actor-role mismatches and unexpected Arbiter output', () => {
  assert.throws(
    () => evaluateRoleReviewWorkflow(baseInput({
      arbiterActor: actor('gemini', 'arbiter'),
    })),
    { message: 'WORKFLOW_EVALUATION_ARBITER_INVALID' },
  )
  assert.throws(
    () => evaluateRoleReviewWorkflow(baseInput({ reviewerActor: actor('gemini', 'wrong') })),
    { message: 'WORKFLOW_EVALUATION_ACTOR_INVALID' },
  )
  assert.throws(
    () => evaluateRoleReviewWorkflow(baseInput({
      workflow: workflow({ arbiter: false }),
      arbiterOutput: output('arbitration'),
      arbiterActor: actor('gemini', 'arbiter'),
    })),
    { message: 'WORKFLOW_EVALUATION_ARBITER_INVALID' },
  )
})
