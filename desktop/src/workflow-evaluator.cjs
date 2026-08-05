const {
  EVIDENCE_LEVEL_RANK,
  parseWorkflowDefinition,
} = require('./orchestration-records.cjs')
const {
  createAdoptionRecord,
  createReviewerFindingRecord,
} = require('./outcome-records.cjs')
const {
  parseArbiterOutput,
  parseReviewerOutput,
} = require('./workflow-output.cjs')

const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const ARTIFACT_ID = /^artifact-[a-f0-9]{64}$/
const EVIDENCE_ID = /^evidence-[a-f0-9]{64}$/
const MAX_EVIDENCE_IDS = 64

function evaluationError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function fail(code) {
  throw evaluationError(code)
}

function normalizeEvidenceLevels(value) {
  let entries
  if (value instanceof Map) entries = [...value.entries()]
  else if (value && typeof value === 'object' && !Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      fail('WORKFLOW_EVALUATION_EVIDENCE_INVALID')
    }
    entries = Object.entries(value)
  } else fail('WORKFLOW_EVALUATION_EVIDENCE_INVALID')

  if (entries.length > MAX_EVIDENCE_IDS) fail('WORKFLOW_EVALUATION_EVIDENCE_INVALID')
  const levels = new Map()
  for (const [evidenceId, level] of entries) {
    if (typeof evidenceId !== 'string' || !EVIDENCE_ID.test(evidenceId)
        || !EVIDENCE_LEVEL_RANK.has(level) || levels.has(evidenceId)) {
      fail('WORKFLOW_EVALUATION_EVIDENCE_INVALID')
    }
    levels.set(evidenceId, level)
  }
  return levels
}

function validateActor(actor, expectedAgentKind) {
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)
      || Object.keys(actor).sort().join(',') !== 'agentKind,agentRunId,kind,runId'
      || actor.kind !== 'agent'
      || actor.agentKind !== expectedAgentKind
      || !PUBLIC_ID.test(String(actor.runId || ''))
      || !PUBLIC_ID.test(String(actor.agentRunId || ''))) {
    fail('WORKFLOW_EVALUATION_ACTOR_INVALID')
  }
  return { ...actor }
}

function runtimeRoleAgentKinds(input, workflow) {
  if (input?.roleAgentKinds === undefined) return { ...workflow.roles }
  const roles = input.roleAgentKinds
  const expectedKeys = workflow.roles.arbiter
    ? ['arbiter', 'reviewer']
    : ['reviewer']
  if (!roles || typeof roles !== 'object' || Array.isArray(roles)
      || Object.keys(roles).sort().join(',') !== expectedKeys.join(',')
      || expectedKeys.some(role => !PUBLIC_ID.test(String(roles[role] || '')))) {
    fail('WORKFLOW_EVALUATION_ACTOR_INVALID')
  }
  const actual = {
    primary: workflow.roles.primary,
    reviewer: roles.reviewer,
    ...(workflow.roles.arbiter ? { arbiter: roles.arbiter } : {}),
  }
  if (new Set(Object.values(actual)).size !== Object.values(actual).length) {
    fail('WORKFLOW_EVALUATION_ACTOR_INVALID')
  }
  return actual
}

function outputEvidenceIds(output) {
  return [...new Set(output.criteria.flatMap(criterion => criterion.evidenceIds))].sort()
}

function outputAccepted(output, criteria, evidenceLevels) {
  if (output.decision !== 'accept') return false
  const results = new Map(output.criteria.map(result => [result.criterionId, result]))
  return criteria.filter(criterion => criterion.required).every((criterion) => {
    const result = results.get(criterion.criterionId)
    if (!result || result.status !== 'pass') return false
    const requiredRank = EVIDENCE_LEVEL_RANK.get(criterion.requiredEvidenceLevel)
    return result.evidenceIds.some((evidenceId) => {
      const actualRank = EVIDENCE_LEVEL_RANK.get(evidenceLevels.get(evidenceId))
      return Number.isInteger(actualRank) && actualRank >= requiredRank
    })
  })
}

function findingFor(artifactId, output, actor, accepted) {
  return createReviewerFindingRecord({
    artifactId,
    relation: accepted ? 'support' : 'contradict',
    summary: output.summary,
    reviewer: actor,
    evidenceIds: outputEvidenceIds(output),
  })
}

function completedResult({ artifactId, output, actor, findingRecords }) {
  const adoptionRecord = createAdoptionRecord({
    artifactId,
    status: 'accepted',
    actor,
    summary: output.summary,
    evidenceIds: outputEvidenceIds(output),
    findingIds: findingRecords.map(finding => finding.reviewerFindingId),
    previousAdoptionId: null,
  })
  return {
    status: 'completed',
    decision: 'accepted',
    findingRecords,
    adoptionRecord,
  }
}

function evaluateRoleReviewWorkflow(input) {
  const workflow = parseWorkflowDefinition(input?.workflow)
  if (workflow.template !== 'role-review') fail('WORKFLOW_EVALUATION_TEMPLATE_INVALID')
  const artifactId = input?.artifactId
  if (typeof artifactId !== 'string' || !ARTIFACT_ID.test(artifactId)) {
    fail('WORKFLOW_EVALUATION_ARTIFACT_INVALID')
  }
  const evidenceLevels = normalizeEvidenceLevels(input?.evidenceLevels)
  const criterionIds = workflow.criteria.map(criterion => criterion.criterionId)
  const outputOptions = {
    artifactId,
    criterionIds,
    evidenceIds: [...evidenceLevels.keys()],
  }
  const roleAgentKinds = runtimeRoleAgentKinds(input, workflow)
  const reviewerOutput = parseReviewerOutput(input?.reviewerOutput, outputOptions)
  const reviewerActor = validateActor(input?.reviewerActor, roleAgentKinds.reviewer)
  const reviewerAccepted = outputAccepted(reviewerOutput, workflow.criteria, evidenceLevels)
  const findingRecords = [findingFor(
    artifactId,
    reviewerOutput,
    reviewerActor,
    reviewerAccepted,
  )]

  if (input?.arbiterOutput === undefined && input?.arbiterActor !== undefined) {
    fail('WORKFLOW_EVALUATION_ARBITER_INVALID')
  }
  if (input?.arbiterOutput !== undefined && !workflow.roles.arbiter) {
    fail('WORKFLOW_EVALUATION_ARBITER_INVALID')
  }
  if (input?.arbiterOutput !== undefined) {
    const arbiterOutput = parseArbiterOutput(input.arbiterOutput, outputOptions)
    const arbiterActor = validateActor(input.arbiterActor, roleAgentKinds.arbiter)
    const arbiterAccepted = outputAccepted(arbiterOutput, workflow.criteria, evidenceLevels)
    findingRecords.push(findingFor(
      artifactId,
      arbiterOutput,
      arbiterActor,
      arbiterAccepted,
    ))
    if (arbiterAccepted) {
      return completedResult({
        artifactId,
        output: arbiterOutput,
        actor: arbiterActor,
        findingRecords,
      })
    }
    return { status: 'decision-required', findingRecords }
  }

  if (reviewerAccepted) {
    return completedResult({
      artifactId,
      output: reviewerOutput,
      actor: reviewerActor,
      findingRecords,
    })
  }
  if (workflow.roles.arbiter) return { status: 'arbiter-required', findingRecords }
  return { status: 'decision-required', findingRecords }
}

module.exports = { evaluateRoleReviewWorkflow }
