const crypto = require('node:crypto')
const { z } = require('zod')

const { canonicalJson } = require('./outcome-records.cjs')
const { redactSecrets } = require('./secret-redaction.cjs')

const WORKFLOW_DEFINITION_VERSION = 1
const MAX_WORKFLOW_RECORD_BYTES = 256 * 1024
const MAX_PARTICIPANTS = 32
const MAX_CRITERIA = 32
const MAX_NODES = 64
const MAX_NODE_DEPENDENCIES = 32
const MAX_DESCRIPTION_CHARS = 1200

const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const WORKFLOW_ID = /^workflow-[a-f0-9]{64}$/
const EVIDENCE_LEVELS = Object.freeze([
  'declared',
  'observed',
  'reproduced',
  'human-accepted',
])
const EVIDENCE_LEVEL_RANK = new Map(EVIDENCE_LEVELS.map((level, index) => [level, index]))
const CRITERION_MINIMUM_LEVEL = Object.freeze({
  artifact: 'observed',
  evidence: 'declared',
  test: 'reproduced',
  human: 'human-accepted',
})

function workflowError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function fail(code) {
  throw workflowError(code)
}

function safeTextSchema(max = MAX_DESCRIPTION_CHARS) {
  return z.string().min(1).max(max).superRefine((value, context) => {
    if (redactSecrets(value) !== value) {
      context.addIssue({ code: 'custom', message: 'secret-like value rejected' })
    }
  })
}

function uniqueArray(schema, max, message, min = 0) {
  return z.array(schema).min(min).max(max).superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', message })
    }
  })
}

const publicIdSchema = z.string().min(1).max(120).regex(PUBLIC_ID)
const workflowIdSchema = z.string().regex(WORKFLOW_ID)
const agentKindsSchema = uniqueArray(
  publicIdSchema,
  MAX_PARTICIPANTS,
  'duplicate participant Agent',
  2,
)
const roleSchema = z.enum(['primary', 'reviewer', 'arbiter'])
const evidenceLevelSchema = z.enum(EVIDENCE_LEVELS)

const roleAssignmentsSchema = z.strictObject({
  primary: publicIdSchema,
  reviewer: publicIdSchema,
  arbiter: publicIdSchema.optional(),
}).superRefine((roles, context) => {
  const values = [roles.primary, roles.reviewer, roles.arbiter].filter(Boolean)
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: 'custom', message: 'workflow roles require independent Agents' })
  }
})

const criterionSchema = z.strictObject({
  criterionId: publicIdSchema,
  kind: z.enum(['artifact', 'evidence', 'test', 'human']),
  description: safeTextSchema(),
  required: z.boolean().default(true),
  requiredEvidenceLevel: evidenceLevelSchema,
}).superRefine((criterion, context) => {
  const minimum = CRITERION_MINIMUM_LEVEL[criterion.kind]
  if (EVIDENCE_LEVEL_RANK.get(criterion.requiredEvidenceLevel)
      < EVIDENCE_LEVEL_RANK.get(minimum)) {
    context.addIssue({
      code: 'custom',
      path: ['requiredEvidenceLevel'],
      message: `criterion kind requires at least ${minimum}`,
    })
  }
})

const workflowNodeSchema = z.strictObject({
  nodeId: publicIdSchema,
  role: roleSchema,
  agentKind: publicIdSchema,
  dependsOn: uniqueArray(
    publicIdSchema,
    MAX_NODE_DEPENDENCIES,
    'duplicate workflow dependency',
  ).default([]),
  parallelSafe: z.boolean().default(false),
  criterionIds: uniqueArray(
    publicIdSchema,
    MAX_CRITERIA,
    'duplicate criterion reference',
  ).default([]),
})

const roundRobinContentSchema = z.strictObject({
  taskId: publicIdSchema,
  template: z.literal('round-robin'),
  participantKinds: agentKindsSchema,
  maxRounds: z.number().int().min(0).max(10).default(6),
  unlimitedRounds: z.boolean().default(false),
}).superRefine((workflow, context) => {
  if (workflow.unlimitedRounds && workflow.maxRounds !== 0) {
    context.addIssue({ code: 'custom', path: ['maxRounds'], message: 'unlimited workflow has no cap' })
  }
  if (!workflow.unlimitedRounds && workflow.maxRounds < 1) {
    context.addIssue({ code: 'custom', path: ['maxRounds'], message: 'round cap required' })
  }
})

const roleReviewContentSchema = z.strictObject({
  taskId: publicIdSchema,
  template: z.literal('role-review'),
  roles: roleAssignmentsSchema,
  criteria: z.array(criterionSchema).min(1).max(MAX_CRITERIA),
  nodes: z.array(workflowNodeSchema).min(2).max(MAX_NODES),
}).superRefine(validateRoleReviewDefinition)

const definitionInputSchema = z.discriminatedUnion('template', [
  roundRobinContentSchema,
  roleReviewContentSchema,
])

const roundRobinRecordSchema = z.strictObject({
  workflowId: workflowIdSchema,
  version: z.literal(WORKFLOW_DEFINITION_VERSION),
  recordType: z.literal('workflow-definition'),
  taskId: publicIdSchema,
  template: z.literal('round-robin'),
  participantKinds: agentKindsSchema,
  maxRounds: z.number().int().min(0).max(10),
  unlimitedRounds: z.boolean(),
}).superRefine((workflow, context) => {
  if (workflow.unlimitedRounds && workflow.maxRounds !== 0) {
    context.addIssue({ code: 'custom', path: ['maxRounds'], message: 'unlimited workflow has no cap' })
  }
  if (!workflow.unlimitedRounds && workflow.maxRounds < 1) {
    context.addIssue({ code: 'custom', path: ['maxRounds'], message: 'round cap required' })
  }
})

const roleReviewRecordSchema = z.strictObject({
  workflowId: workflowIdSchema,
  version: z.literal(WORKFLOW_DEFINITION_VERSION),
  recordType: z.literal('workflow-definition'),
  taskId: publicIdSchema,
  template: z.literal('role-review'),
  roles: roleAssignmentsSchema,
  criteria: z.array(criterionSchema).min(1).max(MAX_CRITERIA),
  nodes: z.array(workflowNodeSchema).min(2).max(MAX_NODES),
}).superRefine(validateRoleReviewDefinition)

const definitionRecordSchema = z.discriminatedUnion('template', [
  roundRobinRecordSchema,
  roleReviewRecordSchema,
])

function validateRoleReviewDefinition(workflow, context) {
  const criterionIds = workflow.criteria.map(criterion => criterion.criterionId)
  if (new Set(criterionIds).size !== criterionIds.length) {
    context.addIssue({ code: 'custom', path: ['criteria'], message: 'duplicate criterion ID' })
  }
  if (!workflow.criteria.some(criterion => criterion.required)) {
    context.addIssue({ code: 'custom', path: ['criteria'], message: 'required criterion missing' })
  }

  const nodeIds = workflow.nodes.map(node => node.nodeId)
  if (new Set(nodeIds).size !== nodeIds.length) {
    context.addIssue({ code: 'custom', path: ['nodes'], message: 'duplicate node ID' })
    return
  }
  const nodeIdSet = new Set(nodeIds)
  const criterionIdSet = new Set(criterionIds)
  const nodesById = new Map(workflow.nodes.map(node => [node.nodeId, node]))
  const rolesPresent = new Set()
  const primaryKinds = new Set(workflow.nodes
    .filter(node => node.role === 'primary')
    .map(node => node.agentKind))

  workflow.nodes.forEach((node, index) => {
    rolesPresent.add(node.role)
    if (node.role !== 'primary' && workflow.roles[node.role] !== node.agentKind) {
      context.addIssue({
        code: 'custom',
        path: ['nodes', index, 'agentKind'],
        message: 'node Agent does not match role assignment',
      })
    }
    if (node.role === 'primary'
        && [workflow.roles.reviewer, workflow.roles.arbiter].filter(Boolean).includes(node.agentKind)) {
      context.addIssue({
        code: 'custom',
        path: ['nodes', index, 'agentKind'],
        message: 'Primary Agents must be independent from Reviewer and Arbiter',
      })
    }
    if (node.dependsOn.includes(node.nodeId)
        || node.dependsOn.some(dependency => !nodeIdSet.has(dependency))) {
      context.addIssue({
        code: 'custom',
        path: ['nodes', index, 'dependsOn'],
        message: 'unknown or self workflow dependency',
      })
    }
    if (node.criterionIds.some(criterionId => !criterionIdSet.has(criterionId))) {
      context.addIssue({
        code: 'custom',
        path: ['nodes', index, 'criterionIds'],
        message: 'unknown criterion reference',
      })
    }
    if (node.role === 'primary' && node.criterionIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['nodes', index, 'criterionIds'],
        message: 'Primary nodes produce Artifacts and do not evaluate criteria',
      })
    }
    if (node.role !== 'primary' && !node.criterionIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['nodes', index, 'criterionIds'],
        message: 'review nodes require criteria',
      })
    }
  })

  if (!rolesPresent.has('primary') || !rolesPresent.has('reviewer')) {
    context.addIssue({ code: 'custom', path: ['nodes'], message: 'Primary and Reviewer nodes required' })
  }
  if (!primaryKinds.has(workflow.roles.primary)) {
    context.addIssue({
      code: 'custom', path: ['roles', 'primary'], message: 'lead Primary Agent requires a node',
    })
  }
  const reviewerNodeCount = workflow.nodes.filter(node => node.role === 'reviewer').length
  if (reviewerNodeCount !== 1) {
    context.addIssue({ code: 'custom', path: ['nodes'], message: 'exactly one Reviewer node required' })
  }
  const arbiterNodeCount = workflow.nodes.filter(node => node.role === 'arbiter').length
  if (arbiterNodeCount > 1) {
    context.addIssue({ code: 'custom', path: ['nodes'], message: 'at most one Arbiter node allowed' })
  }
  if (Boolean(workflow.roles.arbiter) !== rolesPresent.has('arbiter')) {
    context.addIssue({ code: 'custom', path: ['nodes'], message: 'Arbiter role and node must agree' })
  }

  const visiting = new Set()
  const visited = new Set()
  let cycle = false
  const visit = (nodeId) => {
    if (visiting.has(nodeId)) {
      cycle = true
      return
    }
    if (visited.has(nodeId) || !nodesById.has(nodeId)) return
    visiting.add(nodeId)
    for (const dependency of nodesById.get(nodeId).dependsOn) visit(dependency)
    visiting.delete(nodeId)
    visited.add(nodeId)
  }
  for (const nodeId of nodeIds) visit(nodeId)
  if (cycle) {
    context.addIssue({ code: 'custom', path: ['nodes'], message: 'workflow dependency cycle' })
    return
  }

  const ancestorNodes = (nodeId, seen = new Set()) => {
    if (!nodesById.has(nodeId)) return seen
    for (const dependency of nodesById.get(nodeId).dependsOn) {
      if (!nodesById.has(dependency) || seen.has(dependency)) continue
      seen.add(dependency)
      ancestorNodes(dependency, seen)
    }
    return seen
  }
  const primaryNodeIds = workflow.nodes
    .filter(node => node.role === 'primary')
    .map(node => node.nodeId)
  workflow.nodes.forEach((node, index) => {
    const ancestorIds = ancestorNodes(node.nodeId)
    const ancestorRoles = new Set([...ancestorIds].map(nodeId => nodesById.get(nodeId)?.role))
    if (node.role === 'reviewer' && primaryNodeIds.some(nodeId => !ancestorIds.has(nodeId))) {
      context.addIssue({
        code: 'custom', path: ['nodes', index, 'dependsOn'], message: 'Reviewer requires every Primary output',
      })
    }
    if (node.role === 'arbiter' && !ancestorRoles.has('reviewer')) {
      context.addIssue({
        code: 'custom', path: ['nodes', index, 'dependsOn'], message: 'Arbiter requires Reviewer finding',
      })
    }
  })

  const reviewedCriteria = new Set(workflow.nodes
    .filter(node => node.role === 'reviewer')
    .flatMap(node => node.criterionIds))
  if (criterionIds.some(criterionId => !reviewedCriteria.has(criterionId))) {
    context.addIssue({
      code: 'custom', path: ['criteria'], message: 'every criterion requires Reviewer coverage',
    })
  }
}

function parseInput(input) {
  if (Buffer.isBuffer(input) || input instanceof Uint8Array || typeof input === 'string') {
    const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input)
    if (!bytes.length || bytes.length > MAX_WORKFLOW_RECORD_BYTES
        || !Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) {
      fail('WORKFLOW_DEFINITION_JSON_INVALID')
    }
    try {
      return { parsed: JSON.parse(bytes.toString('utf8')), serialized: bytes.toString('utf8') }
    } catch {
      fail('WORKFLOW_DEFINITION_JSON_INVALID')
    }
  }
  return { parsed: input, serialized: null }
}

function validated(schema, value) {
  const result = schema.safeParse(value)
  if (!result.success) fail('WORKFLOW_DEFINITION_SCHEMA_INVALID')
  return result.data
}

function recordId(body) {
  return `workflow-${crypto.createHash('sha256').update(canonicalJson(body)).digest('hex')}`
}

function canonicalRecord(record) {
  const serialized = canonicalJson(record)
  if (Buffer.byteLength(serialized) > MAX_WORKFLOW_RECORD_BYTES) {
    fail('WORKFLOW_DEFINITION_SCHEMA_INVALID')
  }
  return serialized
}

function createWorkflowDefinition(input) {
  const content = validated(definitionInputSchema, input)
  const body = {
    version: WORKFLOW_DEFINITION_VERSION,
    recordType: 'workflow-definition',
    ...content,
  }
  const record = { workflowId: recordId(body), ...body }
  return JSON.parse(canonicalRecord(record))
}

function parseWorkflowDefinition(input) {
  const { parsed, serialized } = parseInput(input)
  const record = validated(definitionRecordSchema, parsed)
  const { workflowId, ...body } = record
  if (recordId(body) !== workflowId) fail('WORKFLOW_DEFINITION_ID_MISMATCH')
  const canonical = canonicalRecord(record)
  if (serialized !== null && serialized !== canonical) {
    fail('WORKFLOW_DEFINITION_JSON_NOT_CANONICAL')
  }
  return JSON.parse(canonical)
}

function serializeWorkflowDefinition(input) {
  return canonicalJson(parseWorkflowDefinition(input))
}

function runnableWorkflowNodes(input, completedNodeIds = [], activeNodeIds = []) {
  const workflow = parseWorkflowDefinition(input)
  if (workflow.template !== 'role-review') return []
  if (!Array.isArray(completedNodeIds) || !Array.isArray(activeNodeIds)
      || new Set(completedNodeIds).size !== completedNodeIds.length
      || new Set(activeNodeIds).size !== activeNodeIds.length) {
    fail('WORKFLOW_NODE_STATE_INVALID')
  }
  const known = new Set(workflow.nodes.map(node => node.nodeId))
  const completed = new Set(completedNodeIds)
  const active = new Set(activeNodeIds)
  if ([...completed, ...active].some(nodeId => !known.has(nodeId))
      || [...completed].some(nodeId => active.has(nodeId))) {
    fail('WORKFLOW_NODE_STATE_INVALID')
  }
  const activeKinds = new Set(workflow.nodes
    .filter(node => active.has(node.nodeId))
    .map(node => node.agentKind))
  const ready = workflow.nodes.filter(node => (
    !completed.has(node.nodeId)
    && !active.has(node.nodeId)
    && !activeKinds.has(node.agentKind)
    && node.dependsOn.every(dependency => completed.has(dependency))
  ))
  if (!ready.length) return []
  if (!ready[0].parallelSafe) return [ready[0]]
  const selectedKinds = new Set()
  return ready.filter((node) => {
    if (!node.parallelSafe || node.role !== ready[0].role || selectedKinds.has(node.agentKind)) {
      return false
    }
    selectedKinds.add(node.agentKind)
    return true
  })
}

module.exports = {
  CRITERION_MINIMUM_LEVEL,
  EVIDENCE_LEVELS,
  EVIDENCE_LEVEL_RANK,
  MAX_WORKFLOW_RECORD_BYTES,
  WORKFLOW_DEFINITION_VERSION,
  createWorkflowDefinition,
  parseWorkflowDefinition,
  runnableWorkflowNodes,
  serializeWorkflowDefinition,
}
