const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { ContentBlobStore } = require('../src/content-blob-store.cjs')
const { ContextPackStore } = require('../src/context-pack-store.cjs')
const { createWorkflowDefinition } = require('../src/orchestration-records.cjs')
const { OutcomeStore } = require('../src/outcome-store.cjs')
const { RoleReviewExecutor } = require('../src/role-review-executor.cjs')
const { parseWorkflowOutcome } = require('../src/workflow-output.cjs')

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-role-review-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const contentBlobStore = new ContentBlobStore({
    rootPath: path.join(directory, 'private', 'blobs'),
  })
  const contextPackStore = new ContextPackStore({
    rootPath: path.join(directory, 'private', 'contexts'),
  })
  const outcomeStore = new OutcomeStore({
    rootPath: path.join(directory, 'private', 'outcomes'),
    contentBlobStore,
  })
  const artifactContent = contentBlobStore.put('reviewed Artifact', { mediaType: 'text/plain' })
  const artifact = outcomeStore.putArtifact({
    type: 'document',
    name: 'result.txt',
    producedBy: {
      runId: 'run-primary',
      agentRunId: 'agent-run-primary',
      agentKind: 'codex',
    },
    contentRef: artifactContent,
    contentHash: artifactContent.hash,
  })
  const observed = outcomeStore.putEvidence({
    kind: 'observation',
    level: 'observed',
    subject: { type: 'artifact', artifactId: artifact.artifactId },
    summary: 'The Artifact was captured.',
    recordedBy: { kind: 'system', actorId: 'meldwork' },
    refs: [
      { type: 'artifact', artifactId: artifact.artifactId },
      {
        type: 'blob',
        contentRef: artifactContent,
        contentHash: artifactContent.hash,
      },
    ],
  })
  const reproduced = outcomeStore.putEvidence({
    kind: 'test-result',
    level: 'reproduced',
    subject: { type: 'artifact', artifactId: artifact.artifactId },
    summary: 'The focused test was reproduced.',
    recordedBy: { kind: 'system', actorId: 'meldwork' },
    refs: [{ type: 'evidence', evidenceId: observed.evidenceId }],
  })
  return {
    artifact,
    contentBlobStore,
    contextPackStore,
    evidence: [observed, reproduced],
    outcomeStore,
  }
}

function workflow({ arbiter = false, primaryNodes = null } = {}) {
  const primaries = primaryNodes || [{
    nodeId: 'primary',
    role: 'primary',
    agentKind: 'codex',
    dependsOn: [],
    parallelSafe: false,
    criterionIds: [],
  }]
  const roles = { primary: 'codex', reviewer: 'claude' }
  const nodes = [
    ...primaries,
    {
      nodeId: 'review',
      role: 'reviewer',
      agentKind: 'claude',
      dependsOn: primaries.map(node => node.nodeId),
      parallelSafe: false,
      criterionIds: ['artifact-ready', 'tests-pass'],
    },
  ]
  if (arbiter) {
    roles.arbiter = 'gemini'
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
    taskId: 'task-role-review',
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
    runId: 'run-review',
    agentRunId: `agent-run-${suffix}`,
    agentKind,
  }
}

function reviewOutput(fixtureValue, kind = 'review', decision = 'accept', artifactId = '') {
  return {
    version: 1,
    kind,
    artifactId: artifactId || fixtureValue.artifact.artifactId,
    decision,
    summary: decision === 'accept'
      ? 'The Artifact satisfies the acceptance criteria.'
      : 'The Artifact requires a decision.',
    criteria: [
      {
        criterionId: 'artifact-ready',
        status: decision === 'accept' ? 'pass' : 'fail',
        summary: 'The Artifact was inspected.',
        evidenceIds: [fixtureValue.evidence[0].evidenceId],
      },
      {
        criterionId: 'tests-pass',
        status: decision === 'accept' ? 'pass' : 'fail',
        summary: 'The focused test Evidence was inspected.',
        evidenceIds: [fixtureValue.evidence[1].evidenceId],
      },
    ],
  }
}

function readPreview(fixtureValue, contextPackId) {
  const pack = fixtureValue.contextPackStore.get(contextPackId)
  return {
    pack,
    preview: JSON.parse(
      fixtureValue.contentBlobStore.read(pack.approvedPreviewRef).toString('utf8'),
    ),
  }
}

test('executes distinct-Agent Primary branches in parallel and bundles them before review', async (t) => {
  const value = fixture(t)
  const definition = workflow({
    primaryNodes: [
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
    ],
  })
  const secondContent = value.contentBlobStore.put('second reviewed Artifact', {
    mediaType: 'text/plain',
  })
  const secondArtifact = value.outcomeStore.putArtifact({
    type: 'document',
    name: 'second-result.txt',
    producedBy: {
      runId: 'run-primary',
      agentRunId: 'agent-run-primary-b',
      agentKind: 'workbuddy',
    },
    contentRef: secondContent,
    contentHash: secondContent.hash,
  })
  const secondEvidence = value.outcomeStore.putEvidence({
    kind: 'observation',
    level: 'observed',
    subject: { type: 'artifact', artifactId: secondArtifact.artifactId },
    summary: 'The second Artifact was captured.',
    recordedBy: { kind: 'system', actorId: 'meldwork' },
    refs: [
      { type: 'artifact', artifactId: secondArtifact.artifactId },
      { type: 'blob', contentRef: secondContent, contentHash: secondContent.hash },
    ],
  })
  let activePrimaries = 0
  let maxActivePrimaries = 0
  let primaryStarts = 0
  let releasePrimaries
  let rejectPrimaries
  const primaryGate = new Promise((resolve, reject) => {
    releasePrimaries = resolve
    rejectPrimaries = reject
  })
  const primaryTimer = setTimeout(() => {
    rejectPrimaries(new Error('Primary branches did not overlap'))
  }, 1000)
  t.after(() => clearTimeout(primaryTimer))
  const calls = []
  const executor = new RoleReviewExecutor({
    ...value,
    invokeNode: async (call) => {
      calls.push(call)
      if (call.role === 'primary') {
        activePrimaries += 1
        primaryStarts += 1
        maxActivePrimaries = Math.max(maxActivePrimaries, activePrimaries)
        if (primaryStarts === 2) {
          clearTimeout(primaryTimer)
          releasePrimaries()
        }
        await primaryGate
        activePrimaries -= 1
        const second = call.nodeId === 'primary-b'
        return {
          status: 'completed',
          artifactId: second ? secondArtifact.artifactId : value.artifact.artifactId,
          evidenceIds: second
            ? [secondEvidence.evidenceId]
            : value.evidence.map(record => record.evidenceId),
        }
      }
      assert.equal(activePrimaries, 0)
      const contract = JSON.parse(call.promptOverride.slice(
        call.promptOverride.lastIndexOf('\n') + 1,
      )).outputContract
      return {
        output: reviewOutput(value, 'review', 'accept', contract.artifactId),
        actor: actor('claude', 'reviewer'),
      }
    },
  })

  const result = await executor.execute({
    workflow: definition,
    groupId: 'group-1',
    primaryPermissionMode: 'workspace-write',
  })

  assert.equal(maxActivePrimaries, 2)
  assert.deepEqual(calls.map(call => call.nodeId), ['primary-a', 'primary-b', 'review'])
  assert.deepEqual(result.completedNodeIds, ['primary-a', 'primary-b', 'review'])
  assert.equal(result.status, 'completed')
  assert.equal(result.decision, 'accepted')
  assert.equal(result.primaryOutcomes.length, 2)
  assert.equal(result.primaryBundle.artifactId, result.workflowOutcome.artifactId)
  const bundle = value.outcomeStore.getArtifact(result.primaryBundle.artifactId)
  assert.equal(bundle.type, 'bundle')
  const bundleContent = JSON.parse(value.contentBlobStore.read(bundle.contentRef).toString('utf8'))
  assert.deepEqual(bundleContent.composedBy, { kind: 'system', actorId: 'meldwork' })
  assert.deepEqual(bundleContent.children, [
    {
      nodeId: 'primary-a',
      agentKind: 'codex',
      artifactId: value.artifact.artifactId,
      evidenceIds: value.evidence.map(record => record.evidenceId).sort(),
    },
    {
      nodeId: 'primary-b',
      agentKind: 'workbuddy',
      artifactId: secondArtifact.artifactId,
      evidenceIds: [secondEvidence.evidenceId],
    },
  ])
  const bundleEvidence = value.outcomeStore.getEvidence(result.primaryBundle.evidenceIds[0])
  assert.equal(bundleEvidence.subject.artifactId, bundle.artifactId)
  assert.deepEqual(bundleEvidence.recordedBy, { kind: 'system', actorId: 'meldwork' })
  assert.equal(bundleEvidence.refs.some(ref => (
    ref.type === 'artifact' && ref.artifactId === secondArtifact.artifactId
  )), true)
  assert.equal(bundleEvidence.refs.some(ref => (
    ref.type === 'evidence' && ref.evidenceId === secondEvidence.evidenceId
  )), true)
  assert.equal(result.adoptionRecord.status, 'accepted')
  assert.deepEqual(
    value.outcomeStore.getAdoption(result.adoptionRecord.adoptionId),
    result.adoptionRecord,
  )
  assert.deepEqual(
    parseWorkflowOutcome(value.contentBlobStore.read(result.workflowOutcomeRef)),
    result.workflowOutcome,
  )

  const reviewerCall = calls[2]
  assert.equal(reviewerCall.taskType, 'code_review')
  assert.equal(reviewerCall.permissionMode, 'read-only')
  assert.equal(reviewerCall.sessionPolicy, 'isolated')
  assert.equal(reviewerCall.groupId, 'group-1')
  assert.equal(reviewerCall.promptOverride.includes('[[ROUNDRELAY_CONSENSUS:'), false)
  assert.equal(reviewerCall.promptOverride.includes('role-review-primary-bundle'), true)
  assert.equal(Object.hasOwn(reviewerCall, 'prompt'), false)
  const { pack, preview } = readPreview(value, reviewerCall.contextPackId)
  assert.equal(pack.parentPackId, null)
  assert.equal(pack.permissionMode, 'read-only')
  assert.deepEqual(pack.targetKinds, ['claude'])
  assert.deepEqual(Object.keys(preview).sort(), [
    'artifact', 'artifactContent', 'criteria', 'evidence',
  ])
  assert.equal(preview.artifact.type, 'bundle')
  assert.deepEqual(JSON.parse(preview.artifactContent.text).children, bundleContent.children)
  assert.equal(pack.sources.every(item => (
    /^(?:artifact-(?:content|record)|criteria|evidence-record):/.test(item.sourceId)
  )), true)
})

test('runs Arbiter after rejection and persists both Findings plus accepted Adoption', async (t) => {
  const value = fixture(t)
  const definition = workflow({ arbiter: true })
  const calls = []
  const executor = new RoleReviewExecutor({
    ...value,
    invokeNode: async (call) => {
      calls.push(call)
      if (call.role === 'reviewer') {
        return {
          output: reviewOutput(value, 'review', 'reject'),
          actor: actor('claude', 'reviewer'),
        }
      }
      return {
        output: reviewOutput(value, 'arbitration', 'accept'),
        actor: actor('gemini', 'arbiter'),
      }
    },
  })

  const result = await executor.execute({
    workflow: definition,
    artifactId: value.artifact.artifactId,
    evidenceIds: value.evidence.map(record => record.evidenceId),
    completedNodeIds: ['primary'],
  })

  assert.deepEqual(calls.map(call => call.role), ['reviewer', 'arbiter'])
  assert.equal(calls.every(call => (
    call.taskType === 'code_review'
      && call.permissionMode === 'read-only'
      && call.sessionPolicy === 'isolated'
  )), true)
  assert.equal(result.status, 'completed')
  assert.deepEqual(result.findingRecords.map(record => record.relation), [
    'contradict',
    'support',
  ])
  result.findingRecords.forEach(record => {
    assert.deepEqual(value.outcomeStore.getReviewerFinding(record.reviewerFindingId), record)
  })
  assert.equal(result.adoptionRecord.actor.agentKind, 'gemini')
  assert.deepEqual(result.adoptionRecord.findingIds, result.findingRecords.map(
    record => record.reviewerFindingId,
  ))
  const arbiterContext = readPreview(value, calls[1].contextPackId)
  assert.deepEqual(Object.keys(arbiterContext.preview).sort(), [
    'artifact',
    'artifactContent',
    'criteria',
    'evidence',
    'findings',
  ])
  assert.equal(arbiterContext.preview.findings.length, 1)
})

test('persists a decision-required Outcome without false consensus or Adoption', async (t) => {
  const value = fixture(t)
  const executor = new RoleReviewExecutor({
    ...value,
    invokeNode: async () => ({
      output: reviewOutput(value, 'review', 'reject'),
      actor: actor('claude', 'reviewer'),
    }),
  })

  const result = await executor.execute({
    workflow: workflow(),
    artifactId: value.artifact.artifactId,
    evidenceIds: value.evidence.map(record => record.evidenceId),
    completedNodeIds: ['primary'],
  })

  assert.equal(result.status, 'decision-required')
  assert.equal(result.decision, 'decision-required')
  assert.equal(result.adoptionRecord, null)
  assert.equal(result.workflowOutcome.status, 'decision-required')
  assert.equal(result.workflowOutcome.adoptionId, null)
  assert.equal(result.findingRecords[0].relation, 'contradict')
  assert.deepEqual(
    parseWorkflowOutcome(value.contentBlobStore.read(result.workflowOutcomeRef)),
    result.workflowOutcome,
  )
})

test('does not overlap a serial Primary node with another ready branch', async (t) => {
  const value = fixture(t)
  const definition = workflow({
    primaryNodes: [
      {
        nodeId: 'primary-serial',
        role: 'primary',
        agentKind: 'codex',
        dependsOn: [],
        parallelSafe: false,
        criterionIds: [],
      },
      {
        nodeId: 'primary-later',
        role: 'primary',
        agentKind: 'codex',
        dependsOn: [],
        parallelSafe: true,
        criterionIds: [],
      },
    ],
  })
  const calls = []
  const executor = new RoleReviewExecutor({
    ...value,
    invokeNode: async (call) => {
      calls.push(call.nodeId)
      if (call.role === 'primary') {
        return {
          artifactId: value.artifact.artifactId,
          evidenceIds: value.evidence.map(record => record.evidenceId),
        }
      }
      const contract = JSON.parse(call.promptOverride.slice(
        call.promptOverride.lastIndexOf('\n') + 1,
      )).outputContract
      return {
        output: reviewOutput(value, 'review', 'accept', contract.artifactId),
        actor: actor('claude', 'reviewer'),
      }
    },
  })

  await executor.execute({ workflow: definition })

  assert.deepEqual(calls, ['primary-serial', 'primary-later', 'review'])
})
