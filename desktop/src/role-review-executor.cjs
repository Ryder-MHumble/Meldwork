const {
  canonicalJson,
} = require('./outcome-records.cjs')
const {
  parseWorkflowDefinition,
  runnableWorkflowNodes,
} = require('./orchestration-records.cjs')
const { evaluateRoleReviewWorkflow } = require('./workflow-evaluator.cjs')
const {
  createWorkflowOutcome,
  serializeWorkflowOutcome,
} = require('./workflow-output.cjs')

const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const ARTIFACT_ID = /^artifact-[a-f0-9]{64}$/
const EVIDENCE_ID = /^evidence-[a-f0-9]{64}$/
const MAX_EVIDENCE_IDS = 64
const MAX_REVIEW_ARTIFACT_TEXT_BYTES = 2 * 1024 * 1024
const REVIEW_TEXT_MEDIA_TYPES = new Set([
  'application/javascript',
  'application/json',
  'application/sql',
  'application/xml',
  'application/x-ndjson',
])

function executorError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function fail(code) {
  throw executorError(code)
}

function requireMethod(value, method, code) {
  if (!value || typeof value[method] !== 'function') fail(code)
}

function normalizeIds(values, pattern, max, code) {
  if (!Array.isArray(values) || values.length > max
      || values.some(value => typeof value !== 'string' || !pattern.test(value))
      || new Set(values).size !== values.length) {
    fail(code)
  }
  return [...values]
}

function normalizeOptionalArtifactId(value) {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string' || !ARTIFACT_ID.test(value)) {
    fail('ROLE_REVIEW_ARTIFACT_INVALID')
  }
  return value
}

function normalizeGroupId(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !PUBLIC_ID.test(value)) {
    fail('ROLE_REVIEW_GROUP_INVALID')
  }
  return value
}

function ensureActive(signal) {
  if (signal?.aborted) fail('ROLE_REVIEW_EXECUTION_ABORTED')
}

function source(type, sourceId, contentRef, targetKind) {
  return {
    type,
    sourceId,
    contentRef,
    contentHash: contentRef.hash,
    targetKinds: [targetKind],
    captureMode: 'snapshot',
  }
}

function roleOutputContract(role, artifactId, criterionIds, evidenceIds) {
  return {
    version: 1,
    kind: role === 'arbiter' ? 'arbitration' : 'review',
    artifactId,
    decision: ['accept', 'revise', 'reject'],
    summary: 'required',
    criteria: criterionIds.map(criterionId => ({
      criterionId,
      status: ['pass', 'fail'],
      summary: 'required',
      evidenceIds: evidenceIds,
    })),
  }
}

function reviewPrompt(role, preview, artifactId, criterionIds, evidenceIds) {
  const instruction = role === 'arbiter'
    ? 'Resolve the supplied review findings against the acceptance criteria.'
    : 'Review the Artifact independently against the acceptance criteria.'
  return [
    instruction,
    'Use only the supplied immutable context. Return exactly one JSON object without Markdown or consensus markers.',
    canonicalJson({
      context: preview,
      outputContract: roleOutputContract(role, artifactId, criterionIds, evidenceIds),
    }),
  ].join('\n')
}

class RoleReviewExecutor {
  constructor({ contentBlobStore, contextPackStore, outcomeStore, invokeNode } = {}) {
    requireMethod(contentBlobStore, 'put', 'ROLE_REVIEW_CONTENT_STORE_REQUIRED')
    requireMethod(contentBlobStore, 'read', 'ROLE_REVIEW_CONTENT_STORE_REQUIRED')
    requireMethod(contextPackStore, 'put', 'ROLE_REVIEW_CONTEXT_STORE_REQUIRED')
    requireMethod(outcomeStore, 'getArtifact', 'ROLE_REVIEW_OUTCOME_STORE_REQUIRED')
    requireMethod(outcomeStore, 'getEvidence', 'ROLE_REVIEW_OUTCOME_STORE_REQUIRED')
    requireMethod(outcomeStore, 'putArtifact', 'ROLE_REVIEW_OUTCOME_STORE_REQUIRED')
    requireMethod(outcomeStore, 'putEvidence', 'ROLE_REVIEW_OUTCOME_STORE_REQUIRED')
    requireMethod(outcomeStore, 'putReviewerFinding', 'ROLE_REVIEW_OUTCOME_STORE_REQUIRED')
    requireMethod(outcomeStore, 'putAdoption', 'ROLE_REVIEW_OUTCOME_STORE_REQUIRED')
    if (typeof invokeNode !== 'function') fail('ROLE_REVIEW_INVOKER_REQUIRED')
    this.contentBlobStore = contentBlobStore
    this.contextPackStore = contextPackStore
    this.outcomeStore = outcomeStore
    this.invokeNode = invokeNode
  }

  putJson(value) {
    return this.contentBlobStore.put(
      Buffer.from(canonicalJson(value), 'utf8'),
      { mediaType: 'application/json' },
    )
  }

  reviewMaterial(workflow, node, artifactId, evidenceIds) {
    if (!artifactId) fail('ROLE_REVIEW_ARTIFACT_REQUIRED')
    const artifact = this.outcomeStore.getArtifact(artifactId)
    const evidence = [...evidenceIds].sort().map(id => this.outcomeStore.getEvidence(id))
    const criterionIds = new Set(node.criterionIds)
    const criteria = workflow.criteria.filter(criterion => criterionIds.has(criterion.criterionId))
    if (criteria.length !== node.criterionIds.length) fail('ROLE_REVIEW_CRITERIA_INVALID')
    return { artifact, criteria, evidence }
  }

  artifactContentPreview(artifact) {
    if (!artifact.contentRef) fail('ROLE_REVIEW_ARTIFACT_CONTENT_REQUIRED')
    const mediaType = String(artifact.contentRef.mediaType || '')
    if (!mediaType.startsWith('text/') && !REVIEW_TEXT_MEDIA_TYPES.has(mediaType)) {
      fail('ROLE_REVIEW_ARTIFACT_CONTENT_UNSUPPORTED')
    }
    if (artifact.contentRef.size > MAX_REVIEW_ARTIFACT_TEXT_BYTES) {
      fail('ROLE_REVIEW_ARTIFACT_CONTENT_TOO_LARGE')
    }
    const bytes = this.contentBlobStore.read(artifact.contentRef)
    const text = bytes.toString('utf8')
    if (!Buffer.from(text, 'utf8').equals(bytes)) {
      fail('ROLE_REVIEW_ARTIFACT_CONTENT_UNSUPPORTED')
    }
    return {
      mediaType,
      contentHash: artifact.contentHash,
      text,
    }
  }

  createReviewContextPack({
    workflow,
    node,
    artifactId,
    evidenceIds,
    groupId,
    reviewerFindings = [],
  }) {
    const material = this.reviewMaterial(workflow, node, artifactId, evidenceIds)
    const preview = {
      artifact: material.artifact,
      artifactContent: this.artifactContentPreview(material.artifact),
      criteria: material.criteria,
      evidence: material.evidence,
      ...(node.role === 'arbiter' ? { findings: reviewerFindings } : {}),
    }
    const sources = []
    const artifactRecordRef = this.putJson(material.artifact)
    sources.push(source(
      'other', `artifact-record:${artifactId}`, artifactRecordRef, node.agentKind,
    ))
    if (material.artifact.contentRef) {
      sources.push(source(
        'other', `artifact-content:${artifactId}`, material.artifact.contentRef, node.agentKind,
      ))
    }
    const criteriaRef = this.putJson(material.criteria)
    sources.push(source(
      'other', `criteria:${workflow.workflowId.slice(-64)}`, criteriaRef, node.agentKind,
    ))
    for (const evidence of material.evidence) {
      const evidenceRef = this.putJson(evidence)
      sources.push(source(
        'other', `evidence-record:${evidence.evidenceId}`, evidenceRef, node.agentKind,
      ))
    }
    for (const finding of reviewerFindings) {
      const findingRef = this.putJson(finding)
      sources.push(source(
        'other', `finding-record:${finding.reviewerFindingId}`, findingRef, node.agentKind,
      ))
    }
    const approvedPreviewRef = this.putJson(preview)
    const record = this.contextPackStore.put({
      parentPackId: null,
      taskId: workflow.taskId,
      groupId,
      mode: 'auto',
      permissionMode: 'read-only',
      targetKinds: [node.agentKind],
      sources,
      approvedPreviewRef,
      approvedPreviewHash: approvedPreviewRef.hash,
    })
    return { record, preview }
  }

  async invokePrimary(workflow, node, input, signal) {
    ensureActive(signal)
    const result = await this.invokeNode({
      workflowId: workflow.workflowId,
      taskId: workflow.taskId,
      groupId: input.groupId,
      nodeId: node.nodeId,
      role: node.role,
      agentKind: node.agentKind,
      taskType: 'workflow_task',
      permissionMode: input.primaryPermissionMode,
      sessionPolicy: 'task',
      contextPackId: null,
      signal,
    })
    ensureActive(signal)
    if (!result || typeof result !== 'object' || Array.isArray(result)
        || (result.status !== undefined && result.status !== 'completed')) {
      fail('ROLE_REVIEW_PRIMARY_RESULT_INVALID')
    }
    return result
  }

  async invokeReview(workflow, node, state, input, signal) {
    ensureActive(signal)
    const context = this.createReviewContextPack({
      workflow,
      node,
      artifactId: state.artifactId,
      evidenceIds: state.evidenceIds,
      groupId: input.groupId,
      reviewerFindings: node.role === 'arbiter' ? state.reviewerFindings : [],
    })
    const criterionIds = node.criterionIds
    const evidenceIds = [...state.evidenceIds].sort()
    const result = await this.invokeNode({
      workflowId: workflow.workflowId,
      taskId: workflow.taskId,
      groupId: input.groupId,
      nodeId: node.nodeId,
      role: node.role,
      agentKind: node.agentKind,
      taskType: 'code_review',
      permissionMode: 'read-only',
      sessionPolicy: 'isolated',
      contextPackId: context.record.contextPackId,
      promptOverride: reviewPrompt(
        node.role, context.preview, state.artifactId, criterionIds, evidenceIds,
      ),
      signal,
    })
    ensureActive(signal)
    if (!result || typeof result !== 'object' || Array.isArray(result)
        || !Object.hasOwn(result, 'output') || !Object.hasOwn(result, 'actor')) {
      fail('ROLE_REVIEW_AGENT_RESULT_INVALID')
    }
    return { ...result, contextPackId: context.record.contextPackId }
  }

  mergePrimaryResult(state, node, result) {
    const artifactId = normalizeOptionalArtifactId(result.artifactId)
    if (!artifactId) fail('ROLE_REVIEW_ARTIFACT_REQUIRED')
    const agentKind = String(result.agentKind || node.agentKind)
    if (!PUBLIC_ID.test(agentKind)) fail('ROLE_REVIEW_AGENT_RESULT_INVALID')
    const evidenceIds = normalizeIds(
      result.evidenceIds || [], EVIDENCE_ID, MAX_EVIDENCE_IDS, 'ROLE_REVIEW_EVIDENCE_INVALID',
    )
    for (const evidenceId of evidenceIds) state.evidenceIds.add(evidenceId)
    if (state.evidenceIds.size > MAX_EVIDENCE_IDS) fail('ROLE_REVIEW_EVIDENCE_INVALID')
    state.primaryOutcomes.push({
      nodeId: node.nodeId,
      agentKind,
      artifactId,
      evidenceIds: [...evidenceIds],
    })
  }

  createPrimaryBundle(workflow, state) {
    const children = [...state.primaryOutcomes]
      .sort((left, right) => {
        if (left.nodeId < right.nodeId) return -1
        if (left.nodeId > right.nodeId) return 1
        return 0
      })
      .map(outcome => ({
        nodeId: outcome.nodeId,
        agentKind: outcome.agentKind,
        artifactId: outcome.artifactId,
        evidenceIds: [...outcome.evidenceIds].sort(),
      }))
    if (state.evidenceIds.size >= MAX_EVIDENCE_IDS) fail('ROLE_REVIEW_EVIDENCE_INVALID')
    const refs = []
    const seenRefs = new Set()
    const addRef = (key, value) => {
      const token = `${key}:${value}`
      if (seenRefs.has(token)) return
      seenRefs.add(token)
      refs.push(key === 'artifact'
        ? { type: 'artifact', artifactId: value }
        : { type: 'evidence', evidenceId: value })
    }
    for (const child of children) {
      addRef('artifact', child.artifactId)
      for (const evidenceId of child.evidenceIds) addRef('evidence', evidenceId)
    }
    if (refs.length > MAX_EVIDENCE_IDS) fail('ROLE_REVIEW_EVIDENCE_INVALID')

    const contentRef = this.contentBlobStore.put(Buffer.from(canonicalJson({
      version: 1,
      kind: 'role-review-primary-bundle',
      workflowId: workflow.workflowId,
      taskId: workflow.taskId,
      composedBy: { kind: 'system', actorId: 'meldwork' },
      children,
    }), 'utf8'), { mediaType: 'application/json' })
    const lead = children.find(child => child.agentKind === workflow.roles.primary) || children[0]
    const firstArtifact = this.outcomeStore.getArtifact(lead.artifactId)
    const artifact = this.outcomeStore.putArtifact({
      type: 'bundle',
      name: 'role-review-primary-bundle.json',
      producedBy: firstArtifact.producedBy,
      contentRef,
      contentHash: contentRef.hash,
    })
    const evidence = this.outcomeStore.putEvidence({
      kind: 'source-snapshot',
      level: 'observed',
      subject: { type: 'artifact', artifactId: artifact.artifactId },
      summary: 'Meldwork captured the ordered Primary Artifact bundle.',
      recordedBy: { kind: 'system', actorId: 'meldwork' },
      refs,
    })
    state.artifactId = artifact.artifactId
    state.evidenceIds.add(evidence.evidenceId)
    state.primaryBundle = {
      artifactId: artifact.artifactId,
      evidenceIds: [evidence.evidenceId],
    }
  }

  finalizePrimaryArtifacts(workflow, state) {
    if (state.primaryFinalized) return
    const primaryCount = workflow.nodes.filter(node => node.role === 'primary').length
    if (!state.primaryOutcomes.length) {
      if (!state.artifactId) fail('ROLE_REVIEW_ARTIFACT_REQUIRED')
    } else if (state.primaryOutcomes.length !== primaryCount) {
      fail('ROLE_REVIEW_NODE_STATE_INVALID')
    } else if (state.primaryOutcomes.length === 1) {
      state.artifactId = state.primaryOutcomes[0].artifactId
    } else {
      this.createPrimaryBundle(workflow, state)
    }
    state.primaryFinalized = true
  }

  persistFindings(records, state) {
    for (const record of records) {
      const stored = this.outcomeStore.putReviewerFinding(record)
      state.findings.set(stored.reviewerFindingId, stored)
    }
    return [...state.findings.values()]
  }

  complete(workflow, state, evaluation) {
    const findingRecords = this.persistFindings(evaluation.findingRecords, state)
    const adoptionRecord = evaluation.adoptionRecord
      ? this.outcomeStore.putAdoption(evaluation.adoptionRecord)
      : null
    const workflowOutcome = createWorkflowOutcome({
      workflowId: workflow.workflowId,
      taskId: workflow.taskId,
      artifactId: state.artifactId,
      status: evaluation.status === 'completed' ? 'accepted' : 'decision-required',
      completedNodeIds: state.completedNodeIds,
      findingIds: findingRecords.map(record => record.reviewerFindingId),
      adoptionId: adoptionRecord?.adoptionId || null,
      reviewerContextPackId: state.reviewerContextPackId,
      arbiterContextPackId: state.arbiterContextPackId,
    })
    const workflowOutcomeRef = this.contentBlobStore.put(
      Buffer.from(serializeWorkflowOutcome(workflowOutcome), 'utf8'),
      { mediaType: 'application/json' },
    )
    return {
      status: evaluation.status,
      decision: evaluation.status === 'completed' ? 'accepted' : 'decision-required',
      workflowOutcome,
      workflowOutcomeRef,
      findingRecords,
      adoptionRecord,
      completedNodeIds: [...state.completedNodeIds],
      contextPackIds: {
        reviewer: state.reviewerContextPackId,
        arbiter: state.arbiterContextPackId,
      },
      primaryOutcomes: state.primaryOutcomes.map(outcome => ({
        ...outcome,
        evidenceIds: [...outcome.evidenceIds],
      })),
      primaryBundle: state.primaryBundle ? {
        artifactId: state.primaryBundle.artifactId,
        evidenceIds: [...state.primaryBundle.evidenceIds],
      } : null,
    }
  }

  evaluate(workflow, state, arbiter = null) {
    return evaluateRoleReviewWorkflow({
      workflow,
      artifactId: state.artifactId,
      evidenceLevels: Object.fromEntries(state.evidenceRecords.map(record => (
        [record.evidenceId, record.level]
      ))),
      reviewerOutput: state.reviewerOutput,
      reviewerActor: state.reviewerActor,
      roleAgentKinds: {
        reviewer: state.reviewerAgentKind || workflow.roles.reviewer,
        ...(workflow.roles.arbiter ? {
          arbiter: arbiter?.agentKind || state.arbiterAgentKind || workflow.roles.arbiter,
        } : {}),
      },
      ...(arbiter ? {
        arbiterOutput: arbiter.output,
        arbiterActor: arbiter.actor,
      } : {}),
    })
  }

  refreshEvidence(state) {
    state.evidenceRecords = [...state.evidenceIds].sort().map(
      evidenceId => this.outcomeStore.getEvidence(evidenceId),
    )
  }

  async execute(input = {}) {
    const workflow = parseWorkflowDefinition(input.workflow)
    if (workflow.template !== 'role-review') fail('ROLE_REVIEW_TEMPLATE_INVALID')
    const knownNodes = new Map(workflow.nodes.map(node => [node.nodeId, node]))
    const completedNodeIds = normalizeIds(
      input.completedNodeIds || [], PUBLIC_ID, workflow.nodes.length,
      'ROLE_REVIEW_NODE_STATE_INVALID',
    )
    if (completedNodeIds.some(nodeId => (
      !knownNodes.has(nodeId) || knownNodes.get(nodeId).role !== 'primary'
    ))) {
      fail('ROLE_REVIEW_NODE_STATE_INVALID')
    }
    const completedNodeSet = new Set(completedNodeIds)
    if (completedNodeIds.some(nodeId => (
      knownNodes.get(nodeId).dependsOn.some(dependency => !completedNodeSet.has(dependency))
    ))) {
      fail('ROLE_REVIEW_NODE_STATE_INVALID')
    }
    const primaryPermissionMode = input.primaryPermissionMode === 'workspace-write'
      ? 'workspace-write'
      : 'read-only'
    const state = {
      artifactId: normalizeOptionalArtifactId(input.artifactId),
      evidenceIds: new Set(normalizeIds(
        input.evidenceIds || [], EVIDENCE_ID, MAX_EVIDENCE_IDS, 'ROLE_REVIEW_EVIDENCE_INVALID',
      )),
      evidenceRecords: [],
      completedNodeIds: [...completedNodeIds],
      findings: new Map(),
      reviewerFindings: [],
      reviewerOutput: null,
      reviewerActor: null,
      reviewerAgentKind: '',
      reviewerContextPackId: '',
      arbiterAgentKind: '',
      arbiterContextPackId: null,
      primaryOutcomes: [],
      primaryBundle: null,
      primaryFinalized: false,
    }
    const executionInput = {
      groupId: normalizeGroupId(input.groupId),
      primaryPermissionMode,
    }
    ensureActive(input.signal)

    while (state.completedNodeIds.length < workflow.nodes.length) {
      const ready = runnableWorkflowNodes(workflow, state.completedNodeIds)
      if (!ready.length) fail('ROLE_REVIEW_WORKFLOW_STALLED')
      const role = ready[0].role
      if (ready.some(node => node.role !== role)) fail('ROLE_REVIEW_WORKFLOW_INVALID')

      if (role === 'primary') {
        const settled = await Promise.allSettled(ready.map(node => (
          this.invokePrimary(workflow, node, executionInput, input.signal)
        )))
        const failed = settled.find(result => result.status === 'rejected')
        if (failed) throw failed.reason
        const results = settled.map(result => result.value)
        results.forEach((result, index) => this.mergePrimaryResult(state, ready[index], result))
        state.completedNodeIds.push(...ready.map(node => node.nodeId))
        continue
      }

      this.finalizePrimaryArtifacts(workflow, state)
      this.refreshEvidence(state)
      if (role === 'reviewer') {
        const result = await this.invokeReview(
          workflow, ready[0], state, executionInput, input.signal,
        )
        state.reviewerOutput = result.output
        state.reviewerActor = result.actor
        state.reviewerAgentKind = result.agentKind
        state.reviewerContextPackId = result.contextPackId
        state.completedNodeIds.push(ready[0].nodeId)
        const evaluation = this.evaluate(workflow, state)
        state.reviewerFindings = this.persistFindings(evaluation.findingRecords, state)
        if (evaluation.status === 'arbiter-required') continue
        return this.complete(workflow, state, evaluation)
      }

      if (role === 'arbiter') {
        if (!state.reviewerOutput || !state.reviewerActor) {
          fail('ROLE_REVIEW_ARBITER_STATE_INVALID')
        }
        const result = await this.invokeReview(
          workflow, ready[0], state, executionInput, input.signal,
        )
        state.arbiterAgentKind = result.agentKind
        state.arbiterContextPackId = result.contextPackId
        state.completedNodeIds.push(ready[0].nodeId)
        return this.complete(workflow, state, this.evaluate(workflow, state, result))
      }

      fail('ROLE_REVIEW_ROLE_INVALID')
    }

    fail('ROLE_REVIEW_WORKFLOW_STALLED')
  }
}

module.exports = { RoleReviewExecutor }
