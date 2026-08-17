const { redactSecrets } = require('../security/secret-redaction.cjs')
const { normalizeExternalRunRef } = require('../agents/agent-runtime-contract.cjs')
const { parseConnectorRunSnapshot } = require('../agents/connectors/agent-connector-registry.cjs')
const { parseRunEventState } = require('./run-event-protocol.cjs')
const {
  canonicalJson,
  normalizeContextPackId,
  normalizeDeliveryRecordId,
  normalizeSessionProvenance,
} = require('../collaboration/context-pack-records.cjs')
const {
  DEFAULT_MAX_EVENTS_PER_AGENT,
  DEFAULT_MAX_OUTPUT_CHARS,
  normalizeOutcomeRefs,
  normalizeRunEvent,
  normalizeTraceCapsule,
} = require('./run-harness.cjs')
const {
  BUDGET_DIMENSIONS,
  BUDGET_ENFORCEMENTS,
  BUDGET_SOURCES,
  normalizeBudgetExhaustion,
} = require('./run-budget.cjs')
const {
  MAX_ATTEMPT_HISTORY,
  normalizeAttemptHistory,
} = require('./failure-policy.cjs')
const { parseCollaborationState } = require('../collaboration/collaboration-records.cjs')
const { parseTaskGraphCursor } = require('../collaboration/task-graph-records.cjs')
const { parseOrchestrationV4 } = require('../collaboration/orchestration-v4-records.cjs')

const DEFAULT_MAX_DURABLE_AGENT_RUNS = 256
const MAX_TARGET_KINDS = 32
const MAX_REASON_CHARS = 240
const PUBLIC_ID = /^[A-Za-z0-9._:-]{1,120}$/
const PUBLIC_GROUP_ID = /^[^\u0000-\u001f\u007f]{1,100}$/u
const OPAQUE_REMOTE_VALUE = /^[A-Za-z0-9._:+/=\-]{1,240}$/
const REMOTE_JOB_FIELDS = new Set([
  'connectorId', 'jobId', 'cursor', 'recoveryOwnerId',
])
const CONTEXT_FIELDS = new Set([
  'includedCount', 'omittedCount', 'charCount', 'sessionRotated', 'externalRunRef',
  'contextMode', 'promptChars', 'contextPackId', 'contextPackState', 'deliveryRecordIds',
  'sessionProvenance', 'outcomeRefs', 'sourceCount', 'sourceHash', 'promptBytes',
  'promptHash', 'wirePayloadBytes', 'wirePayloadHash',
  'connector', 'connectorEventState',
])
const CONTEXT_PACK_STATES = new Set(['captured', 'legacy-unavailable'])
const REQUIRED_BUDGET_FIELDS = new Set(['limits', 'used', 'source', 'enforcement', 'startedAt'])
const BUDGET_FIELDS = new Set([...REQUIRED_BUDGET_FIELDS, 'exhaustion'])
const BUDGET_DIMENSION_SET = new Set(BUDGET_DIMENSIONS)
const BUDGET_SOURCE_SET = new Set(BUDGET_SOURCES)
const BUDGET_ENFORCEMENT_SET = new Set(BUDGET_ENFORCEMENTS)
const HUMAN_GATE_ID = /^human-gate-[a-f0-9]{64}$/
const SHA256 = /^[a-f0-9]{64}$/
const CONTINUATION_FIELDS = new Set([
  'gateId', 'gateType', 'resumeKind', 'state', 'agentRunId', 'agentKind',
  'publicAgentRunId',
  'round', 'createdAt', 'updatedAt', 'requestId', 'requestHash',
  'sessionRefHash', 'sessionProvenanceHash', 'stateEpoch',
  'phase', 'slotId', 'operationId', 'snapshotHash',
])
const CONTINUATION_INVOCATION_FIELDS = ['phase', 'slotId', 'operationId', 'snapshotHash']
const CONTINUATION_V4_PHASES = new Set([
  'proposal', 'challenge', 'work', 'synthesis', 'verification',
])
const CONTINUATION_GATE_TYPES = new Set(['permission', 'budget', 'decision', 'retry', 'input'])
const CONTINUATION_RESUME_KINDS = new Set([
  'agent_slot', 'role_review_decision', 'v4_human_gate', 'v4_synthesis_recovery',
])
const CONTINUATION_STATES = new Set([
  'pending', 'ready', 'resuming', 'completed', 'failed', 'cancelled',
])
const ACTIVE_CONTINUATION_STATES = new Set(['pending', 'ready', 'resuming'])
const ORCHESTRATION_FIELDS = new Set([
  'version', 'workflow', 'currentKind', 'pendingKinds', 'activeKinds',
  'successfulKinds', 'agreementKinds', 'attachmentRecipients',
  'totalSuccesses', 'terminalFailureOccurred', 'collaboration', 'template', 'taskGraph',
  'phase', 'batchId', 'round', 'currentKinds', 'snapshotHash', 'snapshot', 'plan',
  'slots', 'deliveryWatermarks', 'deliveryState', 'commitState', 'challengeBindings', 'synthesisBinding',
  'synthesisRecovery', 'convergence', 'coordinationPlan', 'workReceipts', 'candidateCommit',
])
const ORCHESTRATION_WORKFLOWS = new Set(['manual', 'auto'])

const RUN_STATUSES = new Set([
  'preparing', 'queued', 'running', 'waiting', 'reconciling',
  'completed', 'partial', 'failed', 'stopped', 'timeout', 'round-limit', 'interrupted',
  'budget-exhausted', 'circuit-breaker',
])
const AGENT_STATUSES = new Set([
  'queued', 'running', 'waiting',
  'completed', 'partial', 'failed', 'stopped', 'timeout', 'interrupted',
])
const EVENT_STATUSES = new Set([
  'queued', 'running', 'waiting',
  'completed', 'partial', 'failed', 'stopped', 'timeout', 'interrupted',
])
const TERMINAL_STATUSES = new Set([
  'completed', 'partial', 'failed', 'stopped', 'timeout', 'round-limit', 'interrupted',
  'budget-exhausted', 'circuit-breaker',
])
const MODES = new Set(['manual', 'auto'])
const PERMISSION_MODES = new Set(['read-only', 'workspace-write'])

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function cleanId(value) {
  const id = String(value || '')
  return PUBLIC_ID.test(id) ? id : ''
}

function cleanGroupId(value) {
  const id = String(value || '')
  return PUBLIC_GROUP_ID.test(id) ? id : ''
}

function cleanOpaqueRemoteValue(value) {
  const text = String(value || '')
  return OPAQUE_REMOTE_VALUE.test(text) ? text : ''
}

function boundedNumber(value, fallback = 0, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return fallback
  return Math.min(max, Math.floor(number))
}

function safeTimestamp(value, fallback = 0) {
  if (Number.isFinite(value) && value >= 0) return Math.floor(value)
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : fallback
}

function redactPaths(value) {
  return String(value || '')
    .replace(/\bfile:\/\/\/[^\s"'`<>]+/gi, '[path]')
    .replace(/(^|[\s("'`])\/(?!\/)[^\s"'`<>)]*/g, '$1[path]')
    .replace(/\b[A-Za-z]:\\(?:[^\s"'`<>]+\\)*[^\s"'`<>]*/g, '[path]')
}

function cleanText(value, limit, options = {}) {
  let text = redactPaths(redactSecrets(value))
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  if (options.inline) text = text.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ')
  return text.trim().slice(0, limit)
}

function cleanStatus(value, fallback = 'running', statuses = RUN_STATUSES) {
  const status = String(value || '').toLowerCase()
  return statuses.has(status) ? status : fallback
}

function normalizeKinds(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map(cleanId)
    .filter(Boolean))]
    .slice(0, MAX_TARGET_KINDS)
}

function cleanEventDetail(value) {
  return cleanText(value, 1600)
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => (
      /^Exit code: -?\d+$/u.test(line)
      || /^Output: \d+ lines?, \d+ bytes$/u.test(line)
      || /^Result: (?:-?\d+(?:\.\d+)?|true|false|\d+ items?|\d+ fields?)$/u.test(line)
    ))
    .slice(0, 4)
    .join('\n')
}

function normalizeAgentEvents(value, parent, fallbackTimestamp) {
  return (Array.isArray(value) ? value : [])
    .slice(-DEFAULT_MAX_EVENTS_PER_AGENT)
    .map((input, index) => {
      if (!isRecord(input) || input.type === 'answer_delta') return null
      const normalized = normalizeRunEvent({
        ...input,
        runId: parent.runId,
        agentRunId: parent.agentRunId,
        groupId: parent.groupId,
        threadRootId: parent.threadRootId,
        agentKind: parent.kind,
        round: parent.round,
        seq: boundedNumber(input.seq, index + 1, 1000000000) || index + 1,
        timestamp: safeTimestamp(input.timestamp, fallbackTimestamp),
      })
      if (!normalized || normalized.type === 'answer_delta') return null
      const event = {
        runId: normalized.runId,
        agentRunId: normalized.agentRunId,
        groupId: normalized.groupId,
        threadRootId: normalized.threadRootId,
        agentKind: normalized.agentKind,
        round: normalized.round,
        seq: normalized.seq,
        timestamp: normalized.timestamp,
        status: cleanStatus(input.status, normalized.status, EVENT_STATUSES),
        type: normalized.type,
      }
      if (normalized.id) event.id = normalized.id
      if (normalized.title) event.title = cleanText(normalized.title, 120, { inline: true })
      if (normalized.summary) event.summary = cleanText(normalized.summary, 800)
      const detail = cleanEventDetail(normalized.detail)
      if (detail) event.detail = detail
      return event
    })
    .filter(Boolean)
}

function normalizeAgentRun(input, parent, fallbackTimestamp) {
  if (!isRecord(input)) return null
  const agentRunId = cleanId(input.agentRunId)
  const kind = cleanId(input.kind)
  if (!agentRunId || !kind || !parent.targetKinds.includes(kind)) return null
  const round = boundedNumber(input.round, 0, 100000)
  const status = cleanStatus(input.status, 'running', AGENT_STATUSES)
  const outputSource = String(input.output || '')
  const output = cleanText(outputSource, DEFAULT_MAX_OUTPUT_CHARS)
  const startedAt = safeTimestamp(input.startedAt, fallbackTimestamp)
  const lastActivityAt = safeTimestamp(input.lastActivityAt, startedAt)
  const capsule = normalizeTraceCapsule({
    runId: parent.runId,
    agentRunId,
    round,
    status: TERMINAL_STATUSES.has(status) ? 'completed' : status,
    sourceMessageIds: input.sourceMessageIds,
    context: input.context,
  })
  const hasContext = isRecord(input.context) && [
    'includedCount', 'omittedCount', 'charCount', 'sessionRotated', 'externalRunRef',
    'contextMode', 'promptChars', 'contextPackId', 'deliveryRecordIds', 'sessionProvenance', 'outcomeRefs',
    'sourceCount', 'sourceHash', 'promptBytes', 'promptHash', 'wirePayloadBytes', 'wirePayloadHash',
    'connector', 'connectorEventState',
  ].some(key => hasOwn(input.context, key))
  const rawEvents = Array.isArray(input.events) ? input.events : []
  const rawSourceIds = Array.isArray(input.sourceMessageIds) ? input.sourceMessageIds : []
  const eventCursor = Math.max(
    boundedNumber(input.eventCursor, 0, 1000000000),
    ...rawEvents.map(event => boundedNumber(event?.seq, 0, 1000000000)),
    ...(Array.isArray(input.seenSeqs)
      ? input.seenSeqs.map(seq => boundedNumber(seq, 0, 1000000000))
      : []),
  )
  const outputChars = boundedNumber(input.outputChars, outputSource.length, 1000000)
  const agentRun = {
    agentRunId,
    kind,
    round,
    status,
    output,
    events: normalizeAgentEvents(rawEvents, {
      ...parent, agentRunId, kind, round,
    }, lastActivityAt),
    sourceMessageIds: capsule?.sourceMessageIds || [],
    startedAt,
    lastActivityAt,
    silent: input.silent === true,
    truncated: input.truncated === true
      || outputSource.length > DEFAULT_MAX_OUTPUT_CHARS
      || rawEvents.length > DEFAULT_MAX_EVENTS_PER_AGENT
      || rawSourceIds.length > 32,
    context: hasContext ? (capsule?.context || {}) : {},
    eventCursor,
    outputChars,
  }
  const reason = cleanText(input.reason, MAX_REASON_CHARS, { inline: true })
  if (reason) agentRun.reason = reason
  if (TERMINAL_STATUSES.has(status) && hasOwn(input, 'finishedAt')) {
    agentRun.finishedAt = safeTimestamp(input.finishedAt, lastActivityAt)
  }
  return agentRun
}

function hasStoredFieldTypes(input, fields, type) {
  return fields.every(field => !hasOwn(input, field) || typeof input[field] === type)
}

function hasStoredEnum(input, field, values) {
  return !hasOwn(input, field)
    || (typeof input[field] === 'string' && values.has(input[field].toLowerCase()))
}

function hasStoredBoundedInteger(input, field, min, max) {
  return !hasOwn(input, field)
    || (Number.isInteger(input[field]) && input[field] >= min && input[field] <= max)
}

function isStoredTimestamp(value) {
  return (
    (typeof value === 'number' && Number.isFinite(value) && value >= 0)
    || (typeof value === 'string' && Number.isFinite(Date.parse(value)))
  )
}

function hasStoredTimestamps(input, fields) {
  return fields.every(field => !hasOwn(input, field) || isStoredTimestamp(input[field]))
}

function hasExactBudgetDimensions(value) {
  return isRecord(value)
    && Object.keys(value).length === BUDGET_DIMENSIONS.length
    && Object.keys(value).every(field => BUDGET_DIMENSION_SET.has(field))
}

function hasValidStoredBudgetSnapshot(input) {
  if (!isRecord(input)
      || Object.keys(input).some(field => !BUDGET_FIELDS.has(field))
      || [...REQUIRED_BUDGET_FIELDS].some(field => !hasOwn(input, field))
      || !Number.isSafeInteger(input.startedAt)
      || input.startedAt < 0
      || !hasExactBudgetDimensions(input.limits)
      || !hasExactBudgetDimensions(input.used)
      || !hasExactBudgetDimensions(input.source)
      || !hasExactBudgetDimensions(input.enforcement)) return false
  const dimensionsValid = BUDGET_DIMENSIONS.every(dimension => (
    (input.limits[dimension] === null
      || (Number.isSafeInteger(input.limits[dimension]) && input.limits[dimension] >= 0))
    && Number.isSafeInteger(input.used[dimension])
    && input.used[dimension] >= 0
    && BUDGET_SOURCE_SET.has(input.source[dimension])
    && BUDGET_ENFORCEMENT_SET.has(input.enforcement[dimension])
  ))
  if (!dimensionsValid || !hasOwn(input, 'exhaustion')) return dimensionsValid
  try {
    const exhaustion = normalizeBudgetExhaustion(input.exhaustion)
    return canonicalJson(exhaustion) === canonicalJson(input.exhaustion)
  } catch {
    return false
  }
}

function hasValidStoredAttemptHistory(input) {
  if (!Array.isArray(input) || input.length > MAX_ATTEMPT_HISTORY) return false
  const normalized = normalizeAttemptHistory(input)
  return normalized !== null && canonicalJson(normalized) === canonicalJson(input)
}

function normalizeBudgetSnapshot(input) {
  if (!hasValidStoredBudgetSnapshot(input)) return null
  const budget = {
    limits: Object.fromEntries(BUDGET_DIMENSIONS.map(dimension => [
      dimension, input.limits[dimension],
    ])),
    used: Object.fromEntries(BUDGET_DIMENSIONS.map(dimension => [
      dimension, input.used[dimension],
    ])),
    source: Object.fromEntries(BUDGET_DIMENSIONS.map(dimension => [
      dimension, input.source[dimension],
    ])),
    enforcement: Object.fromEntries(BUDGET_DIMENSIONS.map(dimension => [
      dimension, input.enforcement[dimension],
    ])),
    startedAt: input.startedAt,
  }
  if (hasOwn(input, 'exhaustion')) {
    budget.exhaustion = input.exhaustion ? { ...input.exhaustion } : null
  }
  return budget
}

function normalizeContinuation(input) {
  if (input == null) return null
  if (!isRecord(input) || Object.keys(input).some(field => !CONTINUATION_FIELDS.has(field))) {
    return undefined
  }
  const gateId = String(input.gateId || '')
  const gateType = String(input.gateType || '')
  const resumeKind = String(input.resumeKind || '')
  const state = String(input.state || '')
  const agentRunId = cleanId(input.agentRunId)
  const hasPublicAgentRunId = hasOwn(input, 'publicAgentRunId')
  const publicAgentRunId = cleanId(input.publicAgentRunId)
  const agentKind = cleanId(input.agentKind)
  const round = boundedNumber(input.round, 0, 100000)
  const createdAt = safeTimestamp(input.createdAt, 0)
  const updatedAt = safeTimestamp(input.updatedAt, createdAt)
  const requestId = cleanId(input.requestId)
  const requestHash = String(input.requestHash || '')
  const sessionRefHash = String(input.sessionRefHash || '')
  const sessionProvenanceHash = String(input.sessionProvenanceHash || '')
  const hasStateEpoch = hasOwn(input, 'stateEpoch')
  const stateEpoch = boundedNumber(input.stateEpoch, 0, 1000000)
  const invocationFieldCount = CONTINUATION_INVOCATION_FIELDS
    .filter(field => hasOwn(input, field)).length
  const hasInvocationBinding = invocationFieldCount === CONTINUATION_INVOCATION_FIELDS.length
  const phase = String(input.phase || '')
  const slotId = cleanId(input.slotId)
  const operationId = cleanId(input.operationId)
  const snapshotHash = String(input.snapshotHash || '')
  const hasRequestBinding = requestId && SHA256.test(requestHash)
    && SHA256.test(sessionRefHash) && SHA256.test(sessionProvenanceHash)
  if (!HUMAN_GATE_ID.test(gateId) || !CONTINUATION_GATE_TYPES.has(gateType)
      || !CONTINUATION_RESUME_KINDS.has(resumeKind)
      || !CONTINUATION_STATES.has(state) || !agentRunId || !agentKind
      || (hasPublicAgentRunId && !publicAgentRunId)
      || (resumeKind === 'role_review_decision' && gateType !== 'decision')
      || (resumeKind === 'v4_human_gate'
        && (gateType !== 'decision' || !hasStateEpoch || stateEpoch < 1))
      || (resumeKind === 'v4_synthesis_recovery'
        && (gateType !== 'decision' || !hasStateEpoch))
      || (!['v4_human_gate', 'v4_synthesis_recovery'].includes(resumeKind) && hasStateEpoch)
      || (invocationFieldCount > 0 && !hasInvocationBinding)
      || (hasInvocationBinding && (resumeKind !== 'agent_slot'
        || !CONTINUATION_V4_PHASES.has(phase) || !slotId || !operationId
        || !SHA256.test(snapshotHash)))
      || (gateType === 'input' && !hasRequestBinding)
      || (!hasRequestBinding && [requestId, requestHash, sessionRefHash, sessionProvenanceHash]
        .some(Boolean))) return undefined
  return {
    gateId, gateType, resumeKind, state, agentRunId,
    ...(hasPublicAgentRunId ? { publicAgentRunId } : {}),
    agentKind,
    round, createdAt, updatedAt,
    ...(hasStateEpoch ? { stateEpoch } : {}),
    ...(hasInvocationBinding ? { phase, slotId, operationId, snapshotHash } : {}),
    ...(hasRequestBinding ? {
      requestId, requestHash, sessionRefHash, sessionProvenanceHash,
    } : {}),
  }
}

function continuationBindingMatchesOrchestration(continuation, orchestration) {
  if (continuation?.publicAgentRunId && ACTIVE_CONTINUATION_STATES.has(continuation.state)) {
    if (orchestration?.version !== 4) return false
    const slots = orchestration.slots.filter(slot => (
      slot.agentKind === continuation.agentKind
        && slot.agentRunId === continuation.publicAgentRunId
    ))
    if (slots.length !== 1) return false
    if (continuation.resumeKind === 'agent_slot'
        && slots[0].slotId !== continuation.slotId) return false
  }
  const hasBinding = CONTINUATION_INVOCATION_FIELDS.every(field => hasOwn(continuation || {}, field))
  if (!hasBinding) return true
  if (continuation.resumeKind !== 'agent_slot' || orchestration?.version !== 4) return false
  if (!['pending', 'ready', 'resuming'].includes(continuation.state)) return true
  const slots = orchestration.slots.filter(slot => slot.slotId === continuation.slotId)
  const orchestrationRound = orchestration.workflow === 'manual'
    ? (orchestration.snapshot?.round || 0)
    : orchestration.round
  return orchestration.phase === continuation.phase
    && orchestrationRound === continuation.round
    && orchestration.snapshotHash === continuation.snapshotHash
    && slots.length === 1
    && slots[0].agentKind === continuation.agentKind
    && slots[0].phase === continuation.phase
    && slots[0].operationId === continuation.operationId
    && slots[0].snapshotHash === continuation.snapshotHash
}

function continuationPublicAttemptMatches(continuation, agentRuns) {
  if (!continuation?.publicAgentRunId
      || !ACTIVE_CONTINUATION_STATES.has(continuation.state)) return true
  return agentRuns.filter(agentRun => (
    agentRun?.agentRunId === continuation.publicAgentRunId
      && agentRun?.kind === continuation.agentKind
  )).length === 1
}

function normalizeOrchestration(input) {
  if (input == null) return null
  if (!isRecord(input) || Object.keys(input).some(field => !ORCHESTRATION_FIELDS.has(field))) {
    return undefined
  }
  const version = boundedNumber(input.version, 0, 100)
  if (version === 4) {
    try {
      const parsed = parseOrchestrationV4(input)
      if (hasOwn(parsed, 'collaboration')) parseCollaborationState(parsed.collaboration)
      return parsed
    } catch {
      return undefined
    }
  }
  const workflow = String(input.workflow || '')
  const currentKind = cleanId(input.currentKind)
  const pendingKinds = normalizeKinds(input.pendingKinds)
  const activeKinds = normalizeKinds(input.activeKinds)
  const successfulKinds = normalizeKinds(input.successfulKinds)
  const agreementKinds = normalizeKinds(input.agreementKinds)
  const attachmentRecipients = normalizeKinds(input.attachmentRecipients)
  const totalSuccesses = boundedNumber(input.totalSuccesses, 0, 1000000)
  const v4OnlyFields = [
    'phase', 'batchId', 'round', 'currentKinds', 'snapshotHash', 'snapshot', 'plan',
    'slots', 'deliveryWatermarks', 'deliveryState', 'commitState', 'challengeBindings',
    'synthesisBinding', 'synthesisRecovery', 'convergence', 'candidateCommit',
  ]
  if (![1, 2, 3].includes(version) || !ORCHESTRATION_WORKFLOWS.has(workflow)
      || (version === 1 && hasOwn(input, 'collaboration'))
      || (version === 2 && workflow !== 'auto')
      || (version < 3 && (hasOwn(input, 'template') || hasOwn(input, 'taskGraph')))
      || (version < 4 && v4OnlyFields.some(field => hasOwn(input, field)))
      || (version === 3 && (workflow !== 'auto' || input.template !== 'task-graph'))) {
    return undefined
  }
  let collaboration
  if (version >= 2) {
    try {
      collaboration = parseCollaborationState(input.collaboration)
    } catch {
      return undefined
    }
  }
  let taskGraph
  if (version === 3) {
    try {
      taskGraph = parseTaskGraphCursor(input.taskGraph)
    } catch {
      return undefined
    }
  }
  return {
    version,
    workflow,
    currentKind,
    pendingKinds,
    activeKinds,
    successfulKinds,
    agreementKinds,
    attachmentRecipients,
    totalSuccesses,
    terminalFailureOccurred: input.terminalFailureOccurred === true,
    ...(version >= 2 ? { collaboration } : {}),
    ...(version === 3 ? { template: 'task-graph', taskGraph } : {}),
  }
}

function orchestrationKinds(orchestration) {
  if (!orchestration) return []
  return [
    orchestration.currentKind,
    ...(orchestration.currentKinds || []),
    ...(orchestration.pendingKinds || []),
    ...(orchestration.activeKinds || []),
    ...(orchestration.successfulKinds || []),
    ...(orchestration.agreementKinds || []),
    ...(orchestration.attachmentRecipients || []),
    ...(orchestration.taskGraph?.graph.nodes.map(node => node.agentKind) || []),
    ...(orchestration.plan?.assignments?.map(assignment => assignment.agentKind) || []),
    ...(orchestration.slots?.map(slot => slot.agentKind) || []),
    ...(orchestration.deliveryWatermarks?.map(watermark => watermark.agentKind) || []),
    ...(orchestration.commitState?.committedKinds || []),
    ...(orchestration.commitState?.pendingKinds || []),
    ...(orchestration.commitState?.writerKind ? [orchestration.commitState.writerKind] : []),
    ...(orchestration.candidateCommit?.writerKind ? [orchestration.candidateCommit.writerKind] : []),
    ...(orchestration.synthesisBinding?.candidates?.map(candidate => candidate.kind) || []),
    ...(orchestration.synthesisBinding ? [
      orchestration.synthesisBinding.writerKind,
      ...orchestration.synthesisBinding.verificationKinds,
    ] : []),
    ...(orchestration.synthesisRecovery ? [
      orchestration.synthesisRecovery.originalWriterKind,
      orchestration.synthesisRecovery.activeWriterKind,
      ...orchestration.synthesisRecovery.verificationKinds,
      ...orchestration.synthesisRecovery.rankedKinds,
      ...orchestration.synthesisRecovery.triedWriters,
      ...orchestration.synthesisRecovery.attempts.map(attempt => attempt.writerKind),
    ] : []),
  ].filter(Boolean)
}

function hasValidStoredRecordShape(input) {
  if (!isRecord(input)) return false
  if (!hasStoredFieldTypes(input, [
    'runId', 'taskId', 'contextPackId', 'contextPackState', 'groupId', 'threadRootId', 'reason',
  ], 'string')) return false
  if (hasOwn(input, 'contextPackId') && input.contextPackId
      && normalizeContextPackId(input.contextPackId) !== input.contextPackId) return false
  if (hasOwn(input, 'contextPackState')
      && !CONTEXT_PACK_STATES.has(input.contextPackState)) return false
  if (input.contextPackState === 'captured' && !normalizeContextPackId(input.contextPackId)) {
    return false
  }
  if (input.contextPackState === 'legacy-unavailable' && input.contextPackId) return false
  if (!hasStoredEnum(input, 'mode', MODES)) return false
  if (!hasStoredEnum(input, 'status', RUN_STATUSES)) return false
  if (!hasStoredEnum(input, 'permissionMode', PERMISSION_MODES)) return false
  if (!hasStoredBoundedInteger(input, 'currentRound', 0, 100000)) return false
  if (!hasStoredBoundedInteger(input, 'maxRounds', 0, 100000)) return false
  if (!hasStoredFieldTypes(input, ['unlimitedRounds'], 'boolean')) return false
  if (hasOwn(input, 'budget') && !hasValidStoredBudgetSnapshot(input.budget)) return false
  if (hasOwn(input, 'attemptHistory')
      && !hasValidStoredAttemptHistory(input.attemptHistory)) return false
  const continuation = hasOwn(input, 'continuation')
    ? normalizeContinuation(input.continuation)
    : null
  if (hasOwn(input, 'continuation')) {
    if (continuation === undefined
        || canonicalJson(continuation) !== canonicalJson(input.continuation)) return false
  }
  const storedOrchestration = hasOwn(input, 'orchestration')
    ? normalizeOrchestration(input.orchestration)
    : null
  if (hasOwn(input, 'orchestration')) {
    if (storedOrchestration === undefined
        || canonicalJson(storedOrchestration) !== canonicalJson(input.orchestration)) return false
  }
  if (!continuationBindingMatchesOrchestration(continuation, storedOrchestration)) return false
  if (hasOwn(input, 'remoteJob')) {
    if (!isRecord(input.remoteJob)
        || Object.keys(input.remoteJob).some(field => !REMOTE_JOB_FIELDS.has(field))
        || !hasStoredFieldTypes(input.remoteJob, [
          'connectorId', 'jobId', 'cursor', 'recoveryOwnerId',
        ], 'string')
        || !cleanId(input.remoteJob.connectorId)
        || !cleanOpaqueRemoteValue(input.remoteJob.jobId)
        || (hasOwn(input.remoteJob, 'cursor')
          && input.remoteJob.cursor && !cleanOpaqueRemoteValue(input.remoteJob.cursor))
        || (hasOwn(input.remoteJob, 'recoveryOwnerId')
          && input.remoteJob.recoveryOwnerId && !cleanId(input.remoteJob.recoveryOwnerId))) {
      return false
    }
  }
  if (!hasStoredTimestamps(input, [
    'createdAt', 'startedAt', 'updatedAt', 'finishedAt',
  ])) return false
  const mode = hasOwn(input, 'mode') ? input.mode.toLowerCase() : 'manual'
  if (mode !== 'auto' && (
    input.unlimitedRounds === true
    || (hasOwn(input, 'currentRound') && input.currentRound !== 0)
    || (hasOwn(input, 'maxRounds') && input.maxRounds !== 0)
  )) return false
  if (mode === 'auto' && input.unlimitedRounds === true
      && hasOwn(input, 'maxRounds') && input.maxRounds !== 0) return false
  if (mode === 'auto' && input.unlimitedRounds !== true
      && input.maxRounds > 0 && input.currentRound > input.maxRounds) return false
  if (hasOwn(input, 'targetKinds') && (
    !Array.isArray(input.targetKinds)
    || input.targetKinds.some(kind => typeof kind !== 'string' || !cleanId(kind))
  )) return false
  if (!hasOwn(input, 'agentRuns')) return !continuation?.publicAgentRunId
    || !ACTIVE_CONTINUATION_STATES.has(continuation.state)
  if (!Array.isArray(input.agentRuns)) return false

  const targetKinds = normalizeKinds(input.targetKinds)
  const orchestration = normalizeOrchestration(input.orchestration)
  if (orchestration && orchestrationKinds(orchestration)
    .some(kind => !targetKinds.includes(kind))) return false
  const parent = {
    runId: cleanId(input.runId),
    groupId: cleanGroupId(input.groupId),
    threadRootId: cleanId(input.threadRootId),
    targetKinds,
  }
  const candidateCommit = orchestration?.candidateCommit
  if (candidateCommit && (
    candidateCommit.runId !== parent.runId
      || candidateCommit.taskId !== cleanId(input.taskId)
      || candidateCommit.groupId !== parent.groupId
      || candidateCommit.threadRootId !== parent.threadRootId
  )) return false
  const fallbackTimestamp = safeTimestamp(input.startedAt, 0)
  const validAgentRuns = input.agentRuns.every(agentRun => {
    if (!isRecord(agentRun)) return false
    if (!hasStoredFieldTypes(agentRun, [
      'agentRunId', 'kind', 'output', 'reason',
    ], 'string')) return false
    if (!hasStoredEnum(agentRun, 'status', AGENT_STATUSES)) return false
    if (!hasStoredBoundedInteger(agentRun, 'round', 0, 100000)) return false
    if (!hasStoredBoundedInteger(agentRun, 'eventCursor', 0, 1000000000)) return false
    if (!hasStoredBoundedInteger(agentRun, 'outputChars', 0, 1000000)) return false
    if (!hasStoredFieldTypes(agentRun, ['silent', 'truncated'], 'boolean')) return false
    if (!hasStoredTimestamps(agentRun, [
      'startedAt', 'lastActivityAt', 'finishedAt',
    ])) return false
    if (hasOwn(agentRun, 'context')) {
      if (!isRecord(agentRun.context)) return false
      if (Object.keys(agentRun.context).some(field => !CONTEXT_FIELDS.has(field))) return false
      if (!hasStoredBoundedInteger(agentRun.context, 'includedCount', 0, 1000)) return false
      if (!hasStoredBoundedInteger(agentRun.context, 'omittedCount', 0, 100000)) return false
      if (!hasStoredBoundedInteger(agentRun.context, 'charCount', 0, 1000000)) return false
      if (!hasStoredFieldTypes(agentRun.context, ['sessionRotated'], 'boolean')) return false
      if (hasOwn(agentRun.context, 'contextMode')
          && !['bootstrap', 'continuation'].includes(agentRun.context.contextMode)) return false
      if (hasOwn(agentRun.context, 'promptChars')
          && !hasStoredBoundedInteger(agentRun.context, 'promptChars', 0, 10000000)) {
        return false
      }
      for (const field of ['sourceCount', 'promptBytes', 'wirePayloadBytes']) {
        if (hasOwn(agentRun.context, field)
            && !hasStoredBoundedInteger(agentRun.context, field, 0, 10000000)) return false
      }
      for (const field of ['sourceHash', 'promptHash', 'wirePayloadHash']) {
        if (hasOwn(agentRun.context, field)
            && (typeof agentRun.context[field] !== 'string'
              || !SHA256.test(agentRun.context[field]))) return false
      }
      if (hasOwn(agentRun.context, 'contextPackId')
          && normalizeContextPackId(agentRun.context.contextPackId)
            !== agentRun.context.contextPackId) return false
      if (hasOwn(agentRun.context, 'contextPackState')
          && !CONTEXT_PACK_STATES.has(agentRun.context.contextPackState)) return false
      if (agentRun.context.contextPackState === 'captured'
          && !normalizeContextPackId(agentRun.context.contextPackId)) return false
      if (agentRun.context.contextPackState === 'legacy-unavailable'
          && agentRun.context.contextPackId) return false
      if (hasOwn(agentRun.context, 'deliveryRecordIds') && (
        !Array.isArray(agentRun.context.deliveryRecordIds)
        || agentRun.context.deliveryRecordIds.length > 8
        || new Set(agentRun.context.deliveryRecordIds).size
          !== agentRun.context.deliveryRecordIds.length
        || agentRun.context.deliveryRecordIds.some(id => (
          typeof id !== 'string' || normalizeDeliveryRecordId(id) !== id
        ))
      )) return false
      if (hasOwn(agentRun.context, 'sessionProvenance')) {
        if (!isRecord(agentRun.context.sessionProvenance)) return false
        const normalizedProvenance = normalizeSessionProvenance(
          agentRun.context.sessionProvenance,
        )
        if (!normalizedProvenance
            || canonicalJson(normalizedProvenance)
              !== canonicalJson(agentRun.context.sessionProvenance)) return false
      }
      if (hasOwn(agentRun.context, 'outcomeRefs')) {
        if (!isRecord(agentRun.context.outcomeRefs)) return false
        const normalizedOutcomeRefs = normalizeOutcomeRefs(agentRun.context.outcomeRefs)
        if (!Object.keys(normalizedOutcomeRefs).length
            || canonicalJson(normalizedOutcomeRefs)
              !== canonicalJson(agentRun.context.outcomeRefs)) return false
      }
      if (hasOwn(agentRun.context, 'connector')
          || hasOwn(agentRun.context, 'connectorEventState')) {
        if (!hasOwn(agentRun.context, 'connector')
            || !hasOwn(agentRun.context, 'connectorEventState')) return false
        let connector
        let connectorEventState
        try {
          connector = parseConnectorRunSnapshot(agentRun.context.connector)
          connectorEventState = parseRunEventState(agentRun.context.connectorEventState)
        } catch {
          return false
        }
        if (canonicalJson(connector) !== canonicalJson(agentRun.context.connector)
            || canonicalJson(connectorEventState)
              !== canonicalJson(agentRun.context.connectorEventState)) return false
        const fields = [
          'connectorId', 'connectorVersion', 'manifestId', 'instanceId',
          'upstreamId', 'upstreamVersion',
        ]
        if (fields.some(field => connector[field] !== connectorEventState[field])
            || connector.capabilities.eventProtocolVersion
              !== connectorEventState.protocolVersion) return false
      }
      if (hasOwn(agentRun.context, 'externalRunRef') && (
        typeof agentRun.context.externalRunRef !== 'string'
        || normalizeExternalRunRef(redactSecrets(agentRun.context.externalRunRef))
          !== agentRun.context.externalRunRef
      )) return false
    }
    if (hasOwn(agentRun, 'sourceMessageIds') && (
      !Array.isArray(agentRun.sourceMessageIds)
      || agentRun.sourceMessageIds.some(id => typeof id !== 'string' || !cleanId(id))
    )) return false
    if (hasOwn(agentRun, 'events') && !Array.isArray(agentRun.events)) return false

    const normalized = normalizeAgentRun(agentRun, parent, fallbackTimestamp)
    if (!normalized) return false
    return !hasOwn(agentRun, 'events') || agentRun.events.every(event => (
      isRecord(event)
      && hasStoredFieldTypes(event, [
        'runId', 'agentRunId', 'groupId', 'threadRootId', 'agentKind',
        'type', 'id', 'title', 'summary', 'detail', 'delta',
      ], 'string')
      && hasStoredEnum(event, 'status', EVENT_STATUSES)
      && hasStoredBoundedInteger(event, 'round', 0, 100000)
      && hasStoredBoundedInteger(event, 'seq', 1, 1000000000)
      && hasStoredTimestamps(event, ['timestamp'])
      && (!hasOwn(event, 'runId') || event.runId === parent.runId)
      && (!hasOwn(event, 'agentRunId') || event.agentRunId === normalized.agentRunId)
      && (!hasOwn(event, 'groupId') || event.groupId === parent.groupId)
      && (!hasOwn(event, 'threadRootId') || event.threadRootId === parent.threadRootId)
      && (!hasOwn(event, 'agentKind') || event.agentKind === normalized.kind)
      && (!hasOwn(event, 'round') || event.round === normalized.round)
      && normalizeAgentEvents([event], {
        ...parent,
        agentRunId: normalized.agentRunId,
        kind: normalized.kind,
        round: normalized.round,
      }, normalized.lastActivityAt).length === 1
    ))
  })
  return validAgentRuns && continuationPublicAttemptMatches(continuation, input.agentRuns)
}

function selectedValue(input, existing, key) {
  return hasOwn(input, key) ? input[key] : existing?.[key]
}

function normalizeRemoteJob(input, existing) {
  if (!isRecord(input) && !isRecord(existing)) return null
  const current = isRecord(input) ? input : {}
  const previous = isRecord(existing) ? existing : {}
  const connectorId = cleanId(hasOwn(current, 'connectorId')
    ? current.connectorId
    : previous.connectorId)
  const jobId = cleanOpaqueRemoteValue(hasOwn(current, 'jobId')
    ? current.jobId
    : previous.jobId)
  if (!connectorId || !jobId) return null
  const cursor = cleanOpaqueRemoteValue(hasOwn(current, 'cursor')
    ? current.cursor
    : previous.cursor)
  const recoveryOwnerId = cleanId(hasOwn(current, 'recoveryOwnerId')
    ? current.recoveryOwnerId
    : previous.recoveryOwnerId)
  return { connectorId, jobId, cursor, recoveryOwnerId }
}

function normalizeRecord(input, options = {}) {
  if (!isRecord(input)) return null
  const existing = options.existing || null
  const now = safeTimestamp(options.now, 0)
  const runId = cleanId(selectedValue(input, existing, 'runId'))
  const groupId = cleanGroupId(selectedValue(input, existing, 'groupId'))
  if (!runId || !groupId) return null

  const modeValue = String(selectedValue(input, existing, 'mode') || '').toLowerCase()
  const mode = MODES.has(modeValue) ? modeValue : (existing?.mode || 'manual')
  const fallbackStatus = existing?.status || 'preparing'
  const status = cleanStatus(selectedValue(input, existing, 'status'), fallbackStatus)
  const targetKinds = normalizeKinds(selectedValue(input, existing, 'targetKinds'))
  const taskId = cleanId(selectedValue(input, existing, 'taskId'))
  const contextPackId = normalizeContextPackId(
    selectedValue(input, existing, 'contextPackId'),
  )
  const existingContextPackState = existing?.contextPackState
  const contextPackState = contextPackId
    ? 'captured'
    : (options.allowLegacyContext === true
        || existingContextPackState === 'legacy-unavailable'
      ? 'legacy-unavailable'
      : '')
  if (!contextPackState) return null
  const threadRootId = cleanId(selectedValue(input, existing, 'threadRootId'))
  const remoteJob = normalizeRemoteJob(
    selectedValue(input, null, 'remoteJob'),
    existing?.remoteJob,
  )
  const permissionValue = String(
    selectedValue(input, existing, 'permissionMode') || '',
  ).toLowerCase()
  const permissionMode = PERMISSION_MODES.has(permissionValue)
    ? permissionValue
    : (existing?.permissionMode || 'read-only')
  const startedAt = safeTimestamp(
    selectedValue(input, existing, 'startedAt'),
    safeTimestamp(selectedValue(input, existing, 'createdAt'), now),
  )
  const createdAt = safeTimestamp(selectedValue(input, existing, 'createdAt'), startedAt)
  const updatedAt = options.touch === true
    ? now
    : safeTimestamp(selectedValue(input, existing, 'updatedAt'), startedAt)
  const unlimitedRounds = mode === 'auto'
    && selectedValue(input, existing, 'unlimitedRounds') === true
  const maxRounds = mode === 'auto' && !unlimitedRounds
    ? boundedNumber(selectedValue(input, existing, 'maxRounds'), 0, 100000)
    : 0
  const requestedRound = mode === 'auto'
    ? boundedNumber(selectedValue(input, existing, 'currentRound'), 0, 100000)
    : 0
  const currentRound = maxRounds ? Math.min(requestedRound, maxRounds) : requestedRound
  const reason = cleanText(
    selectedValue(input, existing, 'reason'), MAX_REASON_CHARS, { inline: true },
  )
  const parent = { runId, groupId, threadRootId, targetKinds }
  const rawAgentRuns = selectedValue(input, existing, 'agentRuns')
  const agentRuns = (Array.isArray(rawAgentRuns) ? rawAgentRuns : [])
    .slice(-DEFAULT_MAX_DURABLE_AGENT_RUNS)
    .map(agentRun => normalizeAgentRun(agentRun, parent, startedAt))
    .filter(Boolean)
  const rawBudget = selectedValue(input, existing, 'budget')
  const budget = rawBudget == null ? null : normalizeBudgetSnapshot(rawBudget)
  if (rawBudget != null && !budget) return null
  const attemptHistory = normalizeAttemptHistory(
    selectedValue(input, existing, 'attemptHistory'),
  )
  if (!attemptHistory) return null
  const rawContinuation = selectedValue(input, existing, 'continuation')
  const continuation = normalizeContinuation(rawContinuation)
  if (continuation === undefined) return null
  const rawOrchestration = selectedValue(input, existing, 'orchestration')
  const orchestration = normalizeOrchestration(rawOrchestration)
  if (orchestration === undefined) return null
  if (!continuationBindingMatchesOrchestration(continuation, orchestration)) return null
  if (!continuationPublicAttemptMatches(continuation, agentRuns)) return null
  if (orchestration && orchestration.version < 4 && orchestration.workflow !== mode) return null
  if (orchestration && orchestration.version === 4) {
    const expectedWorkflow = orchestration.template === 'discussion' ? 'auto' : 'manual'
    if (![expectedWorkflow, orchestration.template].includes(orchestration.workflow)) return null
  }
  if (orchestration && orchestrationKinds(orchestration)
    .some(kind => !targetKinds.includes(kind))) return null

  const record = {
    runId,
    taskId,
    contextPackId,
    contextPackState,
    groupId,
    threadRootId,
    mode,
    targetKinds,
    status,
    createdAt,
    startedAt,
    updatedAt,
    reason,
    permissionMode,
    currentRound,
    maxRounds,
    unlimitedRounds,
    attemptHistory,
    agentRuns,
  }
  if (budget) record.budget = budget
  if (continuation) record.continuation = continuation
  if (orchestration) record.orchestration = orchestration
  if (remoteJob) record.remoteJob = remoteJob
  if (TERMINAL_STATUSES.has(status)) {
    record.finishedAt = safeTimestamp(
      selectedValue(input, existing, 'finishedAt'),
      options.touch === true ? now : updatedAt,
    )
  }
  return record
}

function recordTimestamp(record) {
  return record.updatedAt || record.finishedAt || record.startedAt || record.createdAt || 0
}

function oldestTimestamp(record) {
  return record.finishedAt || record.updatedAt || record.startedAt || record.createdAt || 0
}

function pruneRecords(value, maxRuns) {
  const records = [...value]
  const removeCount = records.length - maxRuns
  if (removeCount <= 0) return records
  const terminalIndexes = records
    .map((record, index) => ({ index, timestamp: oldestTimestamp(record) }))
    .filter(({ index }) => TERMINAL_STATUSES.has(records[index].status))
    .sort((left, right) => left.timestamp - right.timestamp || left.index - right.index)
  const nonterminalCount = records.length - terminalIndexes.length
  const terminalFloor = nonterminalCount >= maxRuns && terminalIndexes.length ? 1 : 0
  const terminalRemoveCount = Math.min(removeCount, terminalIndexes.length - terminalFloor)
  terminalIndexes.splice(terminalRemoveCount)
  if (!terminalIndexes.length) return records
  const removed = new Set(terminalIndexes.map(item => item.index))
  return records.filter((_record, index) => !removed.has(index))
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function newestFirst(records) {
  return records
    .map((record, index) => ({ record, index }))
    .sort((left, right) => (
      recordTimestamp(right.record) - recordTimestamp(left.record)
      || right.index - left.index
    ))
    .map(({ record }) => record)
}

module.exports = {
  DEFAULT_MAX_DURABLE_AGENT_RUNS,
  RUN_STATUSES,
  TERMINAL_STATUSES,
  boundedNumber,
  cleanGroupId,
  cleanId,
  cleanOpaqueRemoteValue,
  clone,
  hasValidStoredRecordShape,
  isRecord,
  newestFirst,
  normalizeRecord,
  pruneRecords,
  safeTimestamp,
}
