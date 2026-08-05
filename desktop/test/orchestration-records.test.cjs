const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const test = require('node:test')

const {
  createWorkflowDefinition,
  parseWorkflowDefinition,
  runnableWorkflowNodes,
  serializeWorkflowDefinition,
} = require('../src/orchestration-records.cjs')
const { canonicalJson } = require('../src/outcome-records.cjs')

function roleReviewInput(overrides = {}) {
  return {
    taskId: 'task-1',
    template: 'role-review',
    roles: { primary: 'codex', reviewer: 'claude', arbiter: 'gemini' },
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
    nodes: [
      {
        nodeId: 'primary-a',
        role: 'primary',
        agentKind: 'codex',
        dependsOn: [],
        parallelSafe: true,
        criterionIds: [],
      },
      {
        nodeId: 'primary-b',
        role: 'primary',
        agentKind: 'workbuddy',
        dependsOn: [],
        parallelSafe: true,
        criterionIds: [],
      },
      {
        nodeId: 'review',
        role: 'reviewer',
        agentKind: 'claude',
        dependsOn: ['primary-a', 'primary-b'],
        parallelSafe: false,
        criterionIds: ['artifact-ready', 'tests-pass'],
      },
      {
        nodeId: 'arbitrate',
        role: 'arbiter',
        agentKind: 'gemini',
        dependsOn: ['review'],
        parallelSafe: false,
        criterionIds: ['artifact-ready', 'tests-pass'],
      },
    ],
    ...overrides,
  }
}

test('creates content-addressed role-review and bounded round-robin definitions', () => {
  const workflow = createWorkflowDefinition(roleReviewInput())
  const { workflowId, ...body } = workflow
  const expected = crypto.createHash('sha256').update(canonicalJson(body)).digest('hex')
  assert.equal(workflowId, `workflow-${expected}`)
  assert.deepEqual(parseWorkflowDefinition(serializeWorkflowDefinition(workflow)), workflow)

  const roundRobin = createWorkflowDefinition({
    taskId: 'task-2',
    template: 'round-robin',
    participantKinds: ['codex', 'hermes'],
    maxRounds: 6,
    unlimitedRounds: false,
  })
  assert.equal(roundRobin.template, 'round-robin')
  assert.throws(
    () => createWorkflowDefinition({
      taskId: 'task-2',
      template: 'round-robin',
      participantKinds: ['codex', 'hermes'],
      maxRounds: 6,
      unlimitedRounds: true,
    }),
    { message: 'WORKFLOW_DEFINITION_SCHEMA_INVALID' },
  )
})

test('rejects forged, non-canonical, cyclic, and role-inconsistent definitions', () => {
  const workflow = createWorkflowDefinition(roleReviewInput())
  assert.throws(
    () => parseWorkflowDefinition({ ...workflow, taskId: 'task-forged' }),
    { message: 'WORKFLOW_DEFINITION_ID_MISMATCH' },
  )
  assert.throws(
    () => parseWorkflowDefinition(` ${serializeWorkflowDefinition(workflow)}`),
    { message: 'WORKFLOW_DEFINITION_JSON_NOT_CANONICAL' },
  )
  assert.throws(
    () => createWorkflowDefinition(roleReviewInput({
      roles: { primary: 'codex', reviewer: 'codex', arbiter: 'gemini' },
    })),
    { message: 'WORKFLOW_DEFINITION_SCHEMA_INVALID' },
  )
  assert.throws(
    () => createWorkflowDefinition(roleReviewInput({
      roles: { primary: 'hermes', reviewer: 'claude', arbiter: 'gemini' },
    })),
    { message: 'WORKFLOW_DEFINITION_SCHEMA_INVALID' },
  )
  assert.throws(
    () => createWorkflowDefinition(roleReviewInput({
      nodes: roleReviewInput().nodes.map(node => (
        node.nodeId === 'primary-b' ? { ...node, agentKind: 'claude' } : node
      )),
    })),
    { message: 'WORKFLOW_DEFINITION_SCHEMA_INVALID' },
  )
  assert.throws(
    () => createWorkflowDefinition(roleReviewInput({
      nodes: roleReviewInput().nodes.map(node => (
        node.nodeId === 'review' ? { ...node, dependsOn: ['primary-a'] } : node
      )),
    })),
    { message: 'WORKFLOW_DEFINITION_SCHEMA_INVALID' },
  )
  assert.throws(
    () => createWorkflowDefinition(roleReviewInput({
      nodes: roleReviewInput().nodes.map(node => (
        node.nodeId === 'primary-a' ? { ...node, dependsOn: ['review'] } : node
      )),
    })),
    { message: 'WORKFLOW_DEFINITION_SCHEMA_INVALID' },
  )
})

test('enforces typed criteria, dependency ancestry, and complete Reviewer coverage', () => {
  assert.throws(
    () => createWorkflowDefinition(roleReviewInput({
      criteria: roleReviewInput().criteria.map(criterion => ({ ...criterion, required: false })),
    })),
    { message: 'WORKFLOW_DEFINITION_SCHEMA_INVALID' },
  )
  assert.throws(
    () => createWorkflowDefinition(roleReviewInput({
      criteria: [{
        criterionId: 'tests-pass',
        kind: 'test',
        description: 'Tests pass.',
        required: true,
        requiredEvidenceLevel: 'observed',
      }],
    })),
    { message: 'WORKFLOW_DEFINITION_SCHEMA_INVALID' },
  )
  assert.throws(
    () => createWorkflowDefinition(roleReviewInput({
      nodes: roleReviewInput().nodes.map(node => (
        node.nodeId === 'review'
          ? { ...node, dependsOn: [], criterionIds: ['artifact-ready'] }
          : node
      )),
    })),
    { message: 'WORKFLOW_DEFINITION_SCHEMA_INVALID' },
  )
  assert.throws(
    () => createWorkflowDefinition(roleReviewInput({
      nodes: roleReviewInput().nodes.map(node => (
        node.nodeId === 'review' ? { ...node, criterionIds: ['artifact-ready'] } : node
      )),
    })),
    { message: 'WORKFLOW_DEFINITION_SCHEMA_INVALID' },
  )
  assert.throws(
    () => createWorkflowDefinition(roleReviewInput({
      nodes: [
        ...roleReviewInput().nodes,
        {
          nodeId: 'review-second',
          role: 'reviewer',
          agentKind: 'claude',
          dependsOn: ['primary-a', 'primary-b'],
          parallelSafe: true,
          criterionIds: ['artifact-ready', 'tests-pass'],
        },
      ],
    })),
    { message: 'WORKFLOW_DEFINITION_SCHEMA_INVALID' },
  )
})

test('selects deterministic serial and parallel-safe runnable nodes', () => {
  const workflow = createWorkflowDefinition(roleReviewInput())
  assert.deepEqual(
    runnableWorkflowNodes(workflow).map(node => node.nodeId),
    ['primary-a', 'primary-b'],
  )
  assert.deepEqual(
    runnableWorkflowNodes(workflow, [], ['primary-a']).map(node => node.nodeId),
    ['primary-b'],
  )
  assert.deepEqual(
    runnableWorkflowNodes(workflow, ['primary-a', 'primary-b']).map(node => node.nodeId),
    ['review'],
  )
  assert.deepEqual(
    runnableWorkflowNodes(workflow, ['primary-a', 'primary-b', 'review']).map(node => node.nodeId),
    ['arbitrate'],
  )
  assert.throws(
    () => runnableWorkflowNodes(workflow, ['unknown']),
    { message: 'WORKFLOW_NODE_STATE_INVALID' },
  )
  assert.throws(
    () => runnableWorkflowNodes(workflow, ['primary-a'], ['primary-a']),
    { message: 'WORKFLOW_NODE_STATE_INVALID' },
  )

  const sameAgent = createWorkflowDefinition(roleReviewInput({
    nodes: roleReviewInput().nodes.map(node => (
      node.nodeId === 'primary-b' ? { ...node, agentKind: 'codex' } : node
    )),
  }))
  assert.deepEqual(
    runnableWorkflowNodes(sameAgent).map(node => node.nodeId),
    ['primary-a'],
  )
  assert.deepEqual(runnableWorkflowNodes(sameAgent, [], ['primary-a']), [])
  assert.deepEqual(
    runnableWorkflowNodes(sameAgent, ['primary-a']).map(node => node.nodeId),
    ['primary-b'],
  )
})
