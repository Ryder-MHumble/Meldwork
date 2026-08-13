const { createHash, randomUUID } = require('node:crypto')
const {
  isCodeReviewAgentKind,
  requireTerminalAgentResult,
} = require('../agents/agent-runtime-contract.cjs')
const {
  nextSessionMeta,
  normalizeOutcomeRefs,
  normalizeSessionMeta,
  shouldRotateSession,
} = require('../runs/run-harness.cjs')
const {
  canonicalJson,
  normalizeContextPackId,
} = require('../collaboration/context-pack-records.cjs')
const {
  HERMES_WORKSPACE_ACP_ENABLED,
  MAX_MESSAGE_ATTACHMENTS,
  abortableOperation,
  agentStoppedError,
  attachmentType,
  cleanText,
  cleanProgressSteps,
  credentialFailure,
  normalizeAttachmentMetadata,
  parseAutoReply,
  settleWithin,
} = require('./local-workspace-inputs.cjs')
const { assertLocalSkillExecution } = require('../skills/local-skill-contract.cjs')
const { outboundWirePayloadBytes } = require('../collaboration/outbound-payload.cjs')
const { processRunScheduler } = require('../runs/run-scheduler.cjs')
const {
  cleanupStagedAgentInputs,
  stageAgentInputs,
  stagedAgentInputPrompt,
} = require('../agents/agent-input-staging.cjs')

const MAX_INHERITED_TASK_IDS = 64
const MAX_ISOLATED_PROMPT_BYTES = 4 * 1024 * 1024

function canUseNativeMediaFallback(error) {
  const code = String(error?.code || error?.message || '')
  return /^(?:MEDIA_GENERATION_(?:PROVIDER_UNAVAILABLE|MODEL_UNAVAILABLE|NETWORK_FAILED|INVALID_RESPONSE|FAILED|DOWNLOAD_FAILED)|MEDIA_GENERATION_(?:HTTP|DOWNLOAD_HTTP)_\d+)$/.test(code)
}

function agentReturnedMediaProviderFailure(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return false
  return /configured providers do not offer the required media model/i.test(normalized)
    || /use a provider credential with access to (?:that|the) image, audio, or video model/i.test(normalized)
    || /provider.+(?:does not|do not).+(?:offer|support).+(?:media|image|audio|video).+model/i.test(normalized)
}
const OPERATION_ID = /^[A-Za-z0-9._:-]{1,120}$/

function attachInvocationFailure(error, input) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return error
  const existing = error.invocationFailure && typeof error.invocationFailure === 'object'
    ? error.invocationFailure
    : {}
  Object.defineProperty(error, 'invocationFailure', {
    value: Object.freeze({
      outcomeCertainty: existing.outcomeCertainty || input.outcomeCertainty,
      sideEffectsPossible: existing.sideEffectsPossible === true || input.sideEffectsPossible === true,
      operationId: existing.operationId || input.operationId,
      idempotencyMode: existing.idempotencyMode || input.idempotencyMode,
    }),
    enumerable: false,
    configurable: true,
  })
  return error
}

function isolatedInvocationContext(context) {
  if (context?.sessionPolicy !== 'isolated') return null
  const promptOverride = typeof context.promptOverride === 'string'
    ? context.promptOverride
    : ''
  const contextPackId = normalizeContextPackId(context.contextPackId)
  if (!promptOverride || promptOverride.includes('\u0000')
      || Buffer.byteLength(promptOverride) > MAX_ISOLATED_PROMPT_BYTES
      || !contextPackId) {
    throw new Error('LOCAL_RUN_ISOLATED_CONTEXT_INVALID')
  }
  return { promptOverride, contextPackId }
}

function createdSessionProvenance(group, taskId, stateless = false) {
  if (stateless) {
    return {
      scope: 'none', reuse: false, origin: 'none', originTaskId: null,
      inheritedTaskIds: [], completeness: 'complete',
    }
  }
  return {
    scope: group.conversationType === 'direct' ? 'conversation' : 'task',
    reuse: false,
    origin: 'created',
    originTaskId: taskId || null,
    inheritedTaskIds: [],
    completeness: 'complete',
  }
}

function provenanceMeta(provenance) {
  if (provenance.scope === 'unknown-legacy') {
    return {
      sessionScope: 'unknown-legacy',
      originTaskId: '',
      inheritedTaskIds: [],
      provenanceCompleteness: 'unknown-legacy',
    }
  }
  if (provenance.scope === 'none') return {}
  return {
    sessionScope: provenance.scope,
    originTaskId: provenance.originTaskId || '',
    inheritedTaskIds: provenance.inheritedTaskIds || [],
    provenanceCompleteness: provenance.completeness,
  }
}

function completedSessionMeta(meta, provenance, taskId, usage) {
  let inheritedTaskIds = [...(provenance.inheritedTaskIds || [])]
  let completeness = provenance.completeness
  if (provenance.scope === 'conversation' && taskId
      && taskId !== provenance.originTaskId && !inheritedTaskIds.includes(taskId)) {
    inheritedTaskIds.push(taskId)
    if (inheritedTaskIds.length > MAX_INHERITED_TASK_IDS) {
      inheritedTaskIds = inheritedTaskIds.slice(-MAX_INHERITED_TASK_IDS)
      completeness = 'partial'
    }
  }
  return nextSessionMeta(meta, {
    ...usage,
    ...provenanceMeta({ ...provenance, inheritedTaskIds, completeness }),
  })
}

function matchesResumedPermission(request, resumedGate) {
  if (!request || !resumedGate?.request) return false
  try {
    if (canonicalJson(request) !== canonicalJson(resumedGate.request)) return false
  } catch {
    return false
  }
  const selected = request.options?.find(option => option.optionId === resumedGate.optionId)
  if (!selected) return false
  return resumedGate.status === 'approved'
    ? selected.kind.startsWith('allow_')
    : selected.kind.startsWith('reject_')
}

function sha256(value) {
  return createHash('sha256').update(String(value || '')).digest('hex')
}

function deliveredPackedContext(packedContext, promptMode) {
  if (promptMode !== 'continuation') return packedContext
  return {
    ...packedContext,
    sourceMessageIds: packedContext.continuationSourceMessageIds || [],
    sourceEntries: packedContext.continuationSourceEntries || [],
    context: packedContext.continuationContext || {
      includedCount: 0,
      omittedCount: 0,
      charCount: 0,
    },
  }
}

function withCollaborationPackage(packedContext, collaborationPackage) {
  if (!collaborationPackage) return packedContext
  const text = typeof collaborationPackage.text === 'string'
    ? collaborationPackage.text
    : ''
  if (!text || text.length > 128000 || text.includes('\u0000')) {
    throw new Error('LOCAL_RUN_COLLABORATION_PACKAGE_INVALID')
  }
  return { ...packedContext, collaborationText: text }
}

function contextSourceProof(contextPack) {
  const sources = (Array.isArray(contextPack?.sources) ? contextPack.sources : []).map(source => ({
    type: source.type,
    sourceId: source.sourceId,
    contentHash: source.contentHash,
    targetKinds: source.targetKinds,
    captureMode: source.captureMode,
  }))
  return {
    sourceCount: sources.length,
    sourceHash: sha256(canonicalJson(sources)),
  }
}

function assertRequiredContextFits(packedContext) {
  if (!packedContext?.requiredContextOverflow) return
  const error = new Error('LOCAL_RUN_REQUIRED_CONTEXT_OVERFLOW')
  error.code = 'LOCAL_RUN_REQUIRED_CONTEXT_OVERFLOW'
  error.contextOverflow = { ...packedContext.requiredContextOverflow }
  throw error
}

function connectorSessionBinding(sessionRef, sessionProvenance) {
  const stableProvenance = {
    scope: String(sessionProvenance?.scope || 'none'),
    originTaskId: String(sessionProvenance?.originTaskId || ''),
    inheritedTaskIds: Array.isArray(sessionProvenance?.inheritedTaskIds)
      ? [...sessionProvenance.inheritedTaskIds]
      : [],
    completeness: String(sessionProvenance?.completeness || 'complete'),
  }
  return {
    sessionRefHash: sha256(sessionRef),
    sessionProvenanceHash: sha256(canonicalJson(stableProvenance)),
  }
}

class LocalWorkspaceAgentInvocation {
  constructor(options) {
    this.state = options.state
    this.detectedAgents = options.detectedAgents
    this.activeRuns = options.activeRuns
    this.runAgentTimeoutMs = options.runAgentTimeoutMs
    this.runAbortGraceMs = options.runAbortGraceMs
    this.captureAgentOutputs = options.captureAgentOutputs
    this.captureArtifactOutputs = options.captureArtifactOutputs
    this.captureAgentOutcomeDescriptors = options.captureAgentOutcomeDescriptors
    this.runAgent = options.runAgent
    this.importAgentOutputs = options.importAgentOutputs
    this.recordAgentOutcomes = options.recordAgentOutcomes
    this.sessionKey = options.sessionKey
    this.sessionState = options.sessionState
    this.openClawSessionRef = options.openClawSessionRef
    this.save = options.save
    this.packedPromptContext = options.packedPromptContext
    this.ensureRunHarness = options.ensureRunHarness
    this.emitRunEvent = options.emitRunEvent
    this.armAgentSilence = options.armAgentSilence
    this.clearAgentSilence = options.clearAgentSilence
    this.checkpointRun = options.checkpointRun
    this.scheduleRunCheckpoint = options.scheduleRunCheckpoint
    this.emitChanged = options.emitChanged
    this.promptFor = options.promptFor
    this.persistSessionState = options.persistSessionState
    this.createAttemptContextPack = options.createAttemptContextPack
    this.recordContextDelivery = options.recordContextDelivery
    this.markRuntimeCredential = options.markRuntimeCredential
    this.addMessage = options.addMessage
    this.runScheduler = options.runScheduler || processRunScheduler
    this.registerAgentController = options.registerAgentController
    this.unregisterAgentController = options.unregisterAgentController
    this.requestHumanGate = options.requestHumanGate
    this.completeHumanGateContinuation = options.completeHumanGateContinuation
    this.connectorRuntime = options.connectorRuntime || null
    this.attachmentSupport = options.attachmentSupport || (() => ({}))
    this.generateMedia = typeof options.generateMedia === 'function' ? options.generateMedia : null
  }

  commitSessionState(mutator) {
    const state = this.state()
    const previousSessions = { ...state.sessions }
    const previousSessionMeta = { ...state.sessionMeta }
    try {
      const result = mutator(state)
      if (result !== false) this.save()
      return result
    } catch (error) {
      state.sessions = previousSessions
      state.sessionMeta = previousSessionMeta
      throw error
    }
  }

  async invoke(group, kind, mode, signal, threadRootId = '', context = {}) {
    const activeRun = this.activeRuns.get(group.id)
    const taskId = cleanText(activeRun?.taskId || context.taskId || threadRootId, 120)
    if (!taskId) throw new Error('LOCAL_RUN_TASK_INVALID')
    const workspaceKey = createHash('sha256')
      .update(String(group.workdir || group.id))
      .digest('hex')
    const agentController = new AbortController()
    const registration = { agentRunId: '' }
    let queuedAbortHandler = null
    this.registerAgentController?.(activeRun, kind, registration.agentRunId, agentController)
    if (signal) {
      queuedAbortHandler = () => agentController.abort()
      if (signal.aborted) queuedAbortHandler()
      else signal.addEventListener('abort', queuedAbortHandler, { once: true })
    }
    try {
      return await this.runScheduler.withLease({
        taskId,
        workspaceKey,
        signal: agentController.signal,
      }, (lease) => {
        if (signal && queuedAbortHandler) {
          signal.removeEventListener('abort', queuedAbortHandler)
          queuedAbortHandler = null
        }
        return this.invokeLeased(
          group,
          kind,
          mode,
          signal,
          threadRootId,
          context,
          { agentController, registration, lease },
        )
      })
    } finally {
      if (signal && queuedAbortHandler) {
        signal.removeEventListener('abort', queuedAbortHandler)
      }
      this.unregisterAgentController?.(
        activeRun, kind, registration.agentRunId, agentController,
      )
    }
  }

  async invokeLeased(
    group, kind, mode, signal, threadRootId = '', context = {}, invocation = {},
  ) {
    const agent = this.detectedAgents().find(item => item.kind === kind && item.available)
    if (!agent) throw new Error('LOCAL_AGENT_UNAVAILABLE')
    const reviewOnly = isCodeReviewAgentKind(kind)
    const isolated = isolatedInvocationContext(context)
    const internal = context.internal === true
    if (internal && !isolated) throw new Error('LOCAL_RUN_INTERNAL_CONTEXT_INVALID')
    const allowWrite = group.allowWrite === true && !reviewOnly && !isolated
    const skillInputTypes = new Set(['text'])
    for (const attachment of context.attachmentSnapshots || []) {
      const type = attachmentType(attachment?.mimeType)
      if (type) skillInputTypes.add(type)
    }
    for (const skill of context.skillHints || []) {
      if (!skill?.approvedSkillManifest) continue
      assertLocalSkillExecution(skill.approvedSkillManifest, {
        kind,
        version: agent.resolvedVersion || agent.version,
        inputTypes: [...skillInputTypes],
        capabilities: agent.capabilities,
        permissionMode: allowWrite ? 'workspace-write' : 'read-only',
        credentialIds: [],
      })
    }
    const state = this.state()
    const activeRun = this.activeRuns.get(group.id)
    const taskId = cleanText(activeRun?.taskId || context.taskId || threadRootId, 120)
    const responseVersionRootId = cleanText(context.responseVersionRootId, 100)
    const round = mode === 'auto' ? (activeRun?.currentRound || 1) : 0
    if (!isolated) {
      const requiredContext = this.packedPromptContext(
        group.id, '', threadRootId, context.contextOptions || {},
      )
      assertRequiredContextFits(requiredContext)
    }
    const requestedOperationId = String(context.operationId || '')
    const operationId = OPERATION_ID.test(requestedOperationId)
      ? requestedOperationId
      : `agent-operation-${createHash('sha256').update(JSON.stringify({
          runId: activeRun?.runId || taskId,
          kind,
          mode,
          round,
        })).digest('hex')}`
    const idempotencyMode = agent.idempotencyMode === 'durable' ? 'durable' : 'none'
    const resolvedSession = reviewOnly || isolated
      ? {
          key: this.sessionKey(group.id, kind, group.conversationType === 'direct' ? '' : taskId),
          sessionRef: '',
          sessionMeta: {},
          provenance: createdSessionProvenance(group, taskId, true),
        }
      : this.sessionState(
          group, kind, context.sessionThreadRootId || threadRootId, taskId,
        )
    const key = resolvedSession.key
    const storedSessionRef = String(resolvedSession.sessionRef || '')
    let sessionRef = storedSessionRef
    let sessionMeta = normalizeSessionMeta(resolvedSession.sessionMeta)
    let sessionProvenance = resolvedSession.provenance
    let sessionRotated = resolvedSession.sessionReset === true
    const resumedConnectorGate = ['input', 'permission'].includes(context.resumedGate?.type)
      && context.resumedGate?.request?.source === 'connector'
      ? context.resumedGate
      : null
    const resumedPermission = context.resumedGate?.type === 'permission'
      && !resumedConnectorGate
      ? context.resumedGate
      : null
    const sessionNeedsRotation = sessionRef && shouldRotateSession(sessionMeta)
    if (resumedPermission && (!sessionRef || sessionNeedsRotation)) {
      throw new Error('LOCAL_RUN_PERMISSION_RESUME_UNAVAILABLE')
    }
    if (sessionNeedsRotation) {
      sessionMeta = {}
      sessionProvenance = createdSessionProvenance(group, taskId)
      this.commitSessionState((nextState) => {
        delete nextState.sessions[key]
        delete nextState.sessionMeta[key]
        if (kind === 'openclaw') {
          const generation = randomUUID().replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'session'
          sessionRef = this.openClawSessionRef(
            group, generation, group.conversationType === 'direct' ? '' : taskId,
          )
          nextState.sessions[key] = sessionRef
          nextState.sessionMeta[key] = normalizeSessionMeta(
            provenanceMeta(sessionProvenance),
          )
        } else {
          sessionRef = ''
        }
      })
      sessionRotated = true
    }
    let sessionTransport = sessionRef ? String(sessionMeta.transport || '') : ''
    const hermesNeedsLegacy = kind === 'hermes' && sessionTransport === 'acp'
      && (!HERMES_WORKSPACE_ACP_ENABLED
        || agent.acpAvailable === false
        || (context.attachments || []).length > 0)
    if (resumedPermission && hermesNeedsLegacy) {
      throw new Error('LOCAL_RUN_PERMISSION_RESUME_UNAVAILABLE')
    }
    if (sessionRef && hermesNeedsLegacy) {
      this.commitSessionState((nextState) => {
        delete nextState.sessions[key]
        delete nextState.sessionMeta[key]
      })
      sessionRef = ''
      sessionMeta = {}
      sessionProvenance = createdSessionProvenance(group, taskId)
      sessionTransport = ''
      sessionRotated = true
    }
    let transcriptAfterKind = !sessionRotated && storedSessionRef && storedSessionRef === sessionRef
      ? kind
      : ''
    // Group Sessions already contain the immutable bootstrap instructions after
    // a successful turn. Keep direct chat unchanged and send only the compact
    // Harness context on later group turns.
    let promptMode = group.conversationType !== 'direct'
      && Boolean(sessionRef)
      && !sessionRotated
      && sessionMeta.turns > 0
      ? 'continuation'
      : 'bootstrap'
    let packedContext = isolated
      ? {
          text: '',
          sourceMessageIds: [],
          sourceEntries: [],
          omittedCount: 0,
          charCount: isolated.promptOverride.length,
          context: {
            includedCount: 0,
            omittedCount: 0,
            charCount: isolated.promptOverride.length,
            contextPackId: isolated.contextPackId,
            contextPackState: 'captured',
          },
        }
      : this.packedPromptContext(
          group.id, transcriptAfterKind, threadRootId, context.contextOptions || {},
        )
    if (!isolated) {
      packedContext = withCollaborationPackage(
        packedContext, context.collaborationPackage,
      )
    }
    if (!isolated) assertRequiredContextFits(packedContext)
    let deliveredContext = deliveredPackedContext(packedContext, promptMode)
    const harness = this.ensureRunHarness(group, activeRun, threadRootId)
    const harnessRun = harness?.beginAgent(kind, round, deliveredContext.sourceMessageIds)
    let deliveryContext = {
      contextPackId: isolated?.contextPackId || activeRun?.contextPackId || '',
      deliveryRecordIds: [],
      sessionProvenance,
    }
    if (harnessRun) {
      const liveHarnessRun = harness.current(kind, round, harnessRun.agentRunId)
      if (liveHarnessRun) {
        liveHarnessRun.context = {
          ...deliveredContext.context,
          contextMode: promptMode,
          sessionRotated,
          ...deliveryContext,
        }
      }
      this.emitRunEvent(harnessRun)
      this.armAgentSilence(activeRun, kind, round, harnessRun.agentRunId)
      this.checkpointRun(group.id, activeRun)
      this.emitChanged()
    }
    const agentController = invocation.agentController instanceof AbortController
      ? invocation.agentController
      : new AbortController()
    const registration = invocation.registration || { agentRunId: '' }
    registration.agentRunId = harnessRun?.agentRunId || ''
    this.registerAgentController?.(
      activeRun, kind, registration.agentRunId, agentController,
    )
    let watchdogTimedOut = false
    let watchdogError = null
    let parentAbortObserved = false
    let agentCallbacksClosed = false
    let watchdogTimer = null
    let watchdogPromise = null
    let watchdogReject = null
    let watchdogLastProgressAt = Date.now()
    let watchdogPaused = false
    let parentAbortHandler = null
    let parentAbortPromise = null
    let capturePromise = null
    let artifactCapturePromise = null
    let runPromise = null
    let importPromise = null
    let outcomeCapturePromise = null
    let attemptProgress = []
    const resolvedGateIds = []
    let resumedPermissionUsed = false
    let resumedPermissionError = null
    const startedAt = Date.now()
    if (signal) {
      parentAbortPromise = new Promise((_, reject) => {
        parentAbortHandler = () => {
          parentAbortObserved = true
          agentController.abort()
          reject(agentStoppedError())
        }
      })
      parentAbortPromise.catch(() => {})
      if (signal.aborted) parentAbortHandler()
      else signal.addEventListener('abort', parentAbortHandler, { once: true })
    }
    const armWatchdog = () => {
      if (watchdogTimer || watchdogPaused || agentController.signal.aborted
          || !Number.isFinite(this.runAgentTimeoutMs) || this.runAgentTimeoutMs <= 0) return
      const elapsedSinceProgress = Date.now() - watchdogLastProgressAt
      const remainingMs = Math.max(0, this.runAgentTimeoutMs - elapsedSinceProgress)
      watchdogTimer = setTimeout(() => {
        watchdogTimer = null
        if (parentAbortObserved || signal?.aborted || watchdogPaused
            || agentController.signal.aborted) return
        // This is an inactivity/stall timeout. Any progress signal refreshes the
        // window, so a slow tool or streamed response can run indefinitely.
        watchdogTimedOut = true
        watchdogError = new Error('LOCAL_AGENT_TIMEOUT')
        agentController.abort()
        watchdogReject(watchdogError)
      }, remainingMs)
    }
    const pauseWatchdog = () => {
      watchdogPaused = true
      clearTimeout(watchdogTimer)
      watchdogTimer = null
    }
    const noteWatchdogProgress = () => {
      if (agentCallbacksClosed || agentController.signal.aborted) return
      watchdogLastProgressAt = Date.now()
      if (!watchdogPaused) {
        clearTimeout(watchdogTimer)
        watchdogTimer = null
        armWatchdog()
      }
    }
    const resumeWatchdog = () => {
      watchdogPaused = false
      watchdogLastProgressAt = Date.now()
      armWatchdog()
    }
    watchdogPromise = new Promise((_, reject) => {
      watchdogReject = reject
    })
    watchdogPromise.catch(() => {})
    armWatchdog()
    const waitForHumanGate = async (operation) => {
      pauseWatchdog()
      try {
        return invocation.lease?.suspend
          ? await invocation.lease.suspend(operation)
          : await operation()
      } finally {
        if (!agentController.signal.aborted) resumeWatchdog()
      }
    }
    const onProgress = (step) => {
      if (agentCallbacksClosed || agentController.signal.aborted
          || !activeRun || this.activeRuns.get(group.id) !== activeRun) return
      noteWatchdogProgress()
      const next = [...attemptProgress]
      const progressId = typeof step?.id === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(step.id)
        ? step.id
        : ''
      const existingIndex = progressId
        ? next.findIndex(item => item?.id === progressId)
        : -1
      if (existingIndex >= 0) next[existingIndex] = { ...step, id: progressId }
      else next.push(progressId ? { ...step, id: progressId } : step)
      attemptProgress = next.slice(-8)
      if (activeRun.currentKind === kind) activeRun.progress = attemptProgress
      this.armAgentSilence(activeRun, kind, round, harnessRun?.agentRunId)
    }
    let autoDeltaBuffer = ''
    const consensusMarkers = [
      '[[ROUNDRELAY_CONSENSUS:agree]]',
      '[[ROUNDRELAY_CONSENSUS:continue]]',
    ]
    const emitHarnessEvent = (rawEvent) => {
      if (agentCallbacksClosed || agentController.signal.aborted
          || this.activeRuns.get(group.id) !== activeRun
          || !harness || !harnessRun || !rawEvent) return
      const event = harness.ingest(kind, round, rawEvent, harnessRun.agentRunId)
      if (!event) return
      this.emitRunEvent(event)
      this.armAgentSilence(activeRun, kind, round, harnessRun.agentRunId)
      if (event.type !== 'answer_delta' || event.seq % 8 === 0) {
        this.scheduleRunCheckpoint(group.id, activeRun)
        this.emitChanged()
      }
    }
    const emitRuntimeEvent = (rawEvent) => {
      if (agentCallbacksClosed || agentController.signal.aborted) return
      noteWatchdogProgress()
      if (!rawEvent || rawEvent.type !== 'answer_delta') {
        emitHarnessEvent(rawEvent)
        return
      }
      if (mode !== 'auto') {
        emitHarnessEvent(rawEvent)
        return
      }
      autoDeltaBuffer += String(rawEvent.delta || '')
      for (const marker of consensusMarkers) {
        autoDeltaBuffer = autoDeltaBuffer.split(marker).join('')
      }
      let hold = 0
      for (const marker of consensusMarkers) {
        for (let size = 1; size < marker.length; size += 1) {
          if (autoDeltaBuffer.endsWith(marker.slice(0, size))) hold = Math.max(hold, size)
        }
      }
      const safe = hold ? autoDeltaBuffer.slice(0, -hold) : autoDeltaBuffer
      autoDeltaBuffer = hold ? autoDeltaBuffer.slice(-hold) : ''
      if (safe) emitHarnessEvent({ ...rawEvent, delta: safe })
    }
    const flushRuntimeEvent = () => {
      if (!autoDeltaBuffer) return
      const safe = consensusMarkers.reduce(
        (value, marker) => value.split(marker).join(''),
        autoDeltaBuffer,
      )
      autoDeltaBuffer = ''
      if (safe) emitHarnessEvent({ type: 'answer_delta', status: 'running', delta: safe })
    }
    let outputBaseline = null
    let artifactOutputBaseline = null
    let stagedInputs = null
    let generatedMedia = null
    let nativeMediaFallback = false
    let result
    let operationStarted = false
    let sideEffectsStarted = false
    let terminalFailureKnown = false
    let harnessFinished = false
    let connectorContext = {}
    let connectorResume = null
    if (resumedConnectorGate) {
      const request = resumedConnectorGate.request
      const binding = connectorSessionBinding(sessionRef, sessionProvenance)
      const requestHash = sha256(canonicalJson(request))
      if (!agent.connectorInstanceId
          || request.connectorInstanceId !== agent.connectorInstanceId
          || request.connectorId !== agent.connectorId
          || request.connectorVersion !== agent.connectorVersion
          || request.runId !== activeRun?.runId
          || request.agentRunId !== resumedConnectorGate.agentRunId
          || request.operationId !== operationId
          || request.requestId !== resumedConnectorGate.request?.requestId
          || requestHash !== resumedConnectorGate.requestHash
          || binding.sessionRefHash !== request.sessionRefHash
          || binding.sessionProvenanceHash !== request.sessionProvenanceHash) {
        throw new Error('LOCAL_RUN_CONNECTOR_REQUEST_MISMATCH')
      }
      connectorResume = {
        type: resumedConnectorGate.type,
        requestId: request.requestId,
        requestHash,
        ...binding,
        ...(resumedConnectorGate.type === 'input'
          ? { response: resumedConnectorGate.response }
          : {
              status: resumedConnectorGate.status,
              optionId: resumedConnectorGate.optionId,
            }),
      }
    }
    const finishHarness = (status, finalText = '', runtimeContext = {}) => {
      if (!harness || !harnessRun || harnessFinished) return null
      flushRuntimeEvent()
      agentCallbacksClosed = true
      this.clearAgentSilence(activeRun, kind, round, harnessRun.agentRunId)
      const finished = harness.finishAgent(kind, round, status, finalText, {
        ...deliveredContext.context,
        contextMode: promptMode,
        sessionRotated,
        ...runtimeContext,
        ...deliveryContext,
        ...connectorContext,
      }, harnessRun.agentRunId)
      harnessFinished = true
      this.emitRunEvent(finished.event)
      this.checkpointRun(group.id, activeRun)
      this.emitChanged()
      return finished.capsule
    }
    try {
      if (allowWrite) {
        artifactCapturePromise = Promise.resolve().then(() => this.captureArtifactOutputs(
          group.workdir,
          { signal: agentController.signal },
        ))
        artifactCapturePromise.catch(() => {})
        try {
          capturePromise = Promise.resolve().then(() => this.captureAgentOutputs(
            group.workdir,
            { signal: agentController.signal },
          ))
          capturePromise.catch(() => {})
          outputBaseline = await abortableOperation(
            () => capturePromise,
            agentController.signal,
          )
        } catch (error) {
          if (agentController.signal.aborted) throw error
          /* output capture is best effort */
        }
        try {
          artifactOutputBaseline = await abortableOperation(
            () => artifactCapturePromise,
            agentController.signal,
          )
        } catch (error) {
          if (agentController.signal.aborted) throw error
          /* artifact output capture is best effort */
        }
      }
      if (allowWrite && context.mediaRequest && this.generateMedia) {
        sideEffectsStarted = true
        try {
          generatedMedia = await abortableOperation(() => this.generateMedia({
            kind,
            request: context.mediaRequest,
            workdir: group.workdir,
            signal: agentController.signal,
            onEvent: emitRuntimeEvent,
          }), agentController.signal)
        } catch (error) {
          if (agentController.signal.aborted || !canUseNativeMediaFallback(error)) throw error
          nativeMediaFallback = true
        }
      }
      const nativeImageLimit = Math.max(
        0,
        Math.floor(Number(this.attachmentSupport(kind)?.image) || 0),
      )
      stagedInputs = isolated
        ? null
        : stageAgentInputs(group.workdir, context.attachmentSnapshots || [], nativeImageLimit)
      const runtimeInstruction = cleanText(context.runtimeInstruction, 3000)
      const regenerationInstruction = cleanText(context.regenerationInstruction, 3000)
      const responseScopeInstruction = group.conversationType === 'direct'
        ? ''
        : [
            'Final response scope:',
            'Answer only the current user task labeled authoritative above.',
            'Use earlier messages only as supporting evidence when they help answer that current task.',
            'Do not separately mention, summarize, continue, or complete any previous user task.',
            'Do not append an answer to an older task after the current-task conclusion.',
          ].join('\n')
      const buildPrompt = (afterKind, contextPackage) => isolated
        ? isolated.promptOverride
        : [
            this.promptFor(
              group, kind, context.completionPolicy === 'typed' ? 'manual' : mode,
              threadRootId, context.skillHints || [],
              context.knowledgeBaseHints || [], afterKind, contextPackage, promptMode,
              activeRun?.unlimitedRounds === true,
            ),
            stagedAgentInputPrompt(stagedInputs),
            generatedMedia
              ? `Meldwork generated and will attach ${generatedMedia.filename}. Confirm the delivered media briefly; do not claim a different file was created.`
              : '',
            nativeMediaFallback
              ? [
                  'Meldwork shared media generator was unavailable. Use your native media-generation tools or installed local skills to fulfill the current request.',
                  'Write or copy every real generated media file into .meldwork-output/ so Meldwork can validate and attach it to the reply.',
                  'Do not return only a prompt and do not claim success unless a real media file was created. If no native media tool is available, explain that accurately.',
                ].join('\n')
              : '',
            runtimeInstruction ? `Harness recovery task:\n${runtimeInstruction}` : '',
            regenerationInstruction
              ? `Fresh response instruction:\n${regenerationInstruction}`
              : '',
            responseScopeInstruction,
          ].filter(Boolean).join('\n')
      let prompt = buildPrompt(transcriptAfterKind, packedContext)
      const recordOutboundPayload = (outbound = {}) => {
        noteWatchdogProgress()
        if (activeRun?.budget) {
          const bytes = outboundWirePayloadBytes(outbound)
          activeRun.budget.addUsageBatch([
            { dimension: 'outboundBytes', amount: bytes.length, source: 'reported' },
            {
              dimension: 'inputTokens',
              amount: Math.ceil(bytes.length / 4),
              source: 'estimated',
            },
          ])
        }
        const baseContextPackId = isolated?.contextPackId || activeRun?.contextPackId || ''
        if (!baseContextPackId || !harness || !harnessRun) return
        const deliveredPrompt = typeof outbound?.prompt === 'string' ? outbound.prompt : prompt
        const attempt = this.createAttemptContextPack({
          baseContextPackId,
          group,
          taskId,
          mode: group.conversationType === 'direct' ? 'direct' : mode,
          kind,
          packedContext: deliveredContext,
          attachments: isolated ? [] : (context.attachmentSnapshots || []),
          skillHints: isolated ? [] : (context.skillHints || []),
          knowledgeBaseHints: isolated ? [] : (context.knowledgeBaseHints || []),
          // The prompt is context-budgeted, so delivery verification must use
          // the exact prompt scheduled for this Agent rather than the raw turn.
          // Verify against the prompt actually reported by the transport. This
          // remains correct when a recovery path rebuilds a prompt mid-attempt.
          approvedPrompt: deliveredPrompt,
          forceReadOnly: Boolean(isolated),
        })
        const delivery = this.recordContextDelivery({
          contextPackId: attempt.record.contextPackId,
          runId: activeRun.runId,
          agentRunId: harnessRun.agentRunId,
          kind,
          outbound,
          permissionMode: allowWrite ? 'workspace-write' : 'read-only',
          skills: isolated ? [] : (context.skillHints || []),
          runtimeAdditions: attempt.runtimeAdditions,
          sessionProvenance,
        })
        deliveryContext = {
          contextPackId: attempt.record.contextPackId,
          deliveryRecordIds: [
            ...deliveryContext.deliveryRecordIds,
            delivery.deliveryRecordId,
          ].slice(-8),
          sessionProvenance,
          ...contextSourceProof(attempt.record),
          promptChars: deliveredPrompt.length,
          promptBytes: Buffer.byteLength(deliveredPrompt),
          promptHash: sha256(deliveredPrompt),
          wirePayloadBytes: delivery.wirePayloadBytes,
          wirePayloadHash: delivery.wirePayloadHash,
        }
        const liveHarnessRun = harness.current(kind, round, harnessRun.agentRunId)
        if (liveHarnessRun) {
          liveHarnessRun.context = {
            ...deliveredContext.context,
            contextMode: promptMode,
            sessionRotated,
            ...deliveryContext,
            ...connectorContext,
          }
        }
        this.checkpointRun(group.id, activeRun)
        this.emitChanged()
      }
      const rebuildFreshSession = () => {
        sessionMeta = {}
        sessionProvenance = createdSessionProvenance(group, taskId)
        promptMode = 'bootstrap'
        deliveryContext = { ...deliveryContext, sessionProvenance }
        this.commitSessionState((nextState) => {
          delete nextState.sessions[key]
          delete nextState.sessionMeta[key]
          if (kind === 'openclaw') {
            const generation = randomUUID().replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'session'
            sessionRef = this.openClawSessionRef(
              group, generation, group.conversationType === 'direct' ? '' : taskId,
            )
            nextState.sessions[key] = sessionRef
            nextState.sessionMeta[key] = normalizeSessionMeta(
              provenanceMeta(sessionProvenance),
            )
          } else {
            sessionRef = ''
          }
        })
        sessionTransport = ''
        transcriptAfterKind = ''
        sessionRotated = true
        packedContext = this.packedPromptContext(
          group.id, '', threadRootId, context.contextOptions || {},
        )
        packedContext = withCollaborationPackage(
          packedContext, context.collaborationPackage,
        )
        assertRequiredContextFits(packedContext)
        deliveredContext = deliveredPackedContext(packedContext, promptMode)
        const liveHarnessRun = harness?.current(
          kind, round, harnessRun?.agentRunId || '',
        )
        if (liveHarnessRun) {
          liveHarnessRun.sourceMessageIds = [...deliveredContext.sourceMessageIds]
          liveHarnessRun.context = {
            ...deliveredContext.context,
            contextMode: promptMode,
            sessionRotated,
            ...deliveryContext,
            ...connectorContext,
          }
        }
        prompt = buildPrompt('', packedContext)
        this.scheduleRunCheckpoint(group.id, activeRun)
        this.emitChanged()
        return prompt
      }
      const runOptions = {
        sessionRef,
        onSessionRef: (nextSessionRef, metadata = {}) => {
          if (agentCallbacksClosed || agentController.signal.aborted) return
          noteWatchdogProgress()
          if (reviewOnly || isolated) return
          const transport = ['legacy', 'acp'].includes(metadata?.transport)
            ? metadata.transport
            : ''
          if (transport) sessionTransport = transport
          this.persistSessionState(key, nextSessionRef, normalizeSessionMeta({
            ...sessionMeta,
            ...provenanceMeta(sessionProvenance),
            ...(sessionTransport ? { transport: sessionTransport } : {}),
          }))
        },
        onSessionInvalidated: () => {
          if (kind !== 'hermes' || isolated || resumedPermission) return null
          return { prompt: rebuildFreshSession() }
        },
        signal: agentController.signal,
        sandbox: allowWrite ? 'workspace-write' : 'read-only',
        operationId,
        onActivity: noteWatchdogProgress,
        onProgress,
        onEvent: emitRuntimeEvent,
        onOutboundPayload: recordOutboundPayload,
        onPermissionRequest: async (request, permissionContext = {}) => {
          if (resumedPermission && !resumedPermissionUsed) {
            if (!matchesResumedPermission(request, resumedPermission)) {
              resumedPermissionError = new Error('LOCAL_RUN_PERMISSION_REQUEST_MISMATCH')
              throw resumedPermissionError
            }
            resumedPermissionUsed = true
            return {
              status: resumedPermission.status,
              optionId: resumedPermission.optionId,
            }
          }
          const decision = await waitForHumanGate(() => this.requestHumanGate({
            type: 'permission',
            runId: activeRun.runId,
            agentRunId: harnessRun.agentRunId,
            agentKind: kind,
            summary: 'Agent requests permission to continue a tool action.',
            options: request.options,
            request,
          }, {
            signal: permissionContext.signal || agentController.signal,
            preserveOnAbort: () => activeRun.stopReason === 'shutdown',
            continuation: {
              resumeKind: 'agent_slot',
              agentRunId: harnessRun.agentRunId,
              agentKind: kind,
              round,
            },
          }))
          if (decision.gateId) resolvedGateIds.push(decision.gateId)
          return { status: decision.status, optionId: decision.optionId }
        },
        sessionTransport,
        attachments: isolated ? [] : (stagedInputs?.nativeImagePaths || []),
        ...(kind === 'hermes'
          ? {
              hermesAcpAvailable: HERMES_WORKSPACE_ACP_ENABLED && agent.acpAvailable !== false,
            }
          : {}),
      }
      const runCurrentSession = () => {
        const currentRunOptions = { ...runOptions, sessionRef, sessionTransport }
        if (!agent.connectorInstanceId) {
          return this.runAgent(agent, prompt, group.workdir, currentRunOptions)
        }
        if (!this.connectorRuntime || typeof this.connectorRuntime.run !== 'function') {
          throw new Error('AGENT_CONNECTOR_RUNTIME_UNAVAILABLE')
        }
        if (!activeRun?.runId || !harnessRun?.agentRunId) {
          throw new Error('AGENT_CONNECTOR_RUN_ID_INVALID')
        }
        return this.connectorRuntime.run(agent, prompt, group.workdir, {
          ...currentRunOptions,
          runId: activeRun.runId,
          agentRunId: harnessRun.agentRunId,
          onActivity: noteWatchdogProgress,
          onConnectorState: (nextContext) => {
            noteWatchdogProgress()
            connectorContext = nextContext
            const liveHarnessRun = harness.current(kind, round, harnessRun.agentRunId)
            if (liveHarnessRun) {
              liveHarnessRun.context = {
                ...deliveredContext.context,
                contextMode: promptMode,
                sessionRotated,
                ...deliveryContext,
                ...connectorContext,
              }
            }
            this.checkpointRun(group.id, activeRun)
            this.emitChanged()
          },
          connectorResume,
        })
      }
      const costDecision = activeRun?.budget?.check('costMicros')
      if (costDecision?.action === 'human_gate') {
        const resumed = context.resumedGate
        const decision = resumed?.type === 'budget'
          ? resumed
          : await waitForHumanGate(() => this.requestHumanGate({
          type: 'budget',
          runId: activeRun.runId,
          agentRunId: harnessRun.agentRunId,
          agentKind: kind,
          summary: 'Cost usage is unavailable for this Agent attempt.',
          options: [
            { optionId: 'continue-unmetered', name: 'Continue', kind: 'allow_once' },
            { optionId: 'cancel-attempt', name: 'Cancel', kind: 'reject_once' },
          ],
          request: costDecision,
          }, {
            signal: agentController.signal,
            preserveOnAbort: () => activeRun.stopReason === 'shutdown',
            continuation: {
              resumeKind: 'agent_slot',
              agentRunId: harnessRun.agentRunId,
              agentKind: kind,
              round,
            },
          }))
        if (decision.gateId && resumed?.type !== 'budget') resolvedGateIds.push(decision.gateId)
        if (decision.status !== 'approved') throw new Error('LOCAL_BUDGET_REJECTED')
        activeRun.budget.approveUnobservable('costMicros')
        this.checkpointRun(group.id, activeRun)
      }
      if (agentController.signal.aborted) throw agentStoppedError()
      const executeCurrentSession = async () => {
        const reusedSessionRef = sessionRef
        try {
          operationStarted = true
          if (allowWrite) sideEffectsStarted = true
          return await runCurrentSession()
        } catch (error) {
          if (agentController.signal.aborted || !reusedSessionRef
              || resumedPermission || resumedConnectorGate
              || error?.message !== 'LOCAL_AGENT_SESSION_INVALID') throw error
          rebuildFreshSession()
          operationStarted = true
          if (allowWrite) sideEffectsStarted = true
          return await runCurrentSession()
        }
      }
      const raceCurrentSession = async () => {
        runPromise = Promise.resolve().then(executeCurrentSession)
        runPromise.catch(() => {})
        const pending = [runPromise, watchdogPromise]
        if (parentAbortPromise) pending.push(parentAbortPromise)
        return Promise.race(pending)
      }
      result = await raceCurrentSession()
      if (['waiting_input', 'waiting_permission'].includes(result?.outcome)) {
        if (!agent.connectorInstanceId || resumedConnectorGate) {
          throw new Error('LOCAL_RUN_CONNECTOR_WAITING_INVALID')
        }
        const waiting = result.waitingRequest
        const waitingSessionRef = String(result.sessionRef || '')
        if (waitingSessionRef && waitingSessionRef !== sessionRef) {
          runOptions.onSessionRef(waitingSessionRef)
          sessionRef = waitingSessionRef
        }
        const binding = connectorSessionBinding(sessionRef, sessionProvenance)
        const request = {
          version: 1,
          source: 'connector',
          outcome: result.outcome,
          requestId: waiting?.requestId,
          runId: activeRun.runId,
          agentRunId: harnessRun.agentRunId,
          ...(result.outcome === 'waiting_input'
            ? { prompt: waiting?.prompt }
            : {
                permission: waiting?.permission,
                ...(waiting?.summary ? { summary: waiting.summary } : {}),
              }),
          connectorInstanceId: agent.connectorInstanceId,
          connectorId: result.connector?.connectorId,
          connectorVersion: result.connector?.connectorVersion,
          operationId,
          cursor: waiting?.cursor,
          ...binding,
        }
        const requestHash = sha256(canonicalJson(request))
        const gateType = result.outcome === 'waiting_input' ? 'input' : 'permission'
        const decision = await waitForHumanGate(() => this.requestHumanGate({
          type: gateType,
          runId: activeRun.runId,
          agentRunId: harnessRun.agentRunId,
          agentKind: kind,
          summary: gateType === 'input'
            ? String(waiting?.prompt || '').trim().replace(/\s+/g, ' ').slice(0, 500)
            : String(waiting?.summary || 'Connector requests permission to continue.').slice(0, 500),
          options: gateType === 'input'
            ? [
                { optionId: 'submit-input', name: 'Submit', kind: 'respond' },
                { optionId: 'cancel-input', name: 'Cancel', kind: 'reject' },
              ]
            : [
                { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
                { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
              ],
          request,
        }, {
          signal: agentController.signal,
          preserveOnAbort: () => activeRun.stopReason === 'shutdown',
          continuation: {
            resumeKind: 'agent_slot',
            agentRunId: harnessRun.agentRunId,
            agentKind: kind,
            round,
            requestId: request.requestId,
            requestHash,
            ...binding,
          },
        }))
        if (decision.gateId) resolvedGateIds.push(decision.gateId)
        if (decision.status !== 'approved') throw new Error(
          gateType === 'input' ? 'LOCAL_INPUT_REJECTED' : 'LOCAL_PERMISSION_REJECTED',
        )
        connectorResume = {
          type: gateType,
          requestId: request.requestId,
          requestHash,
          ...binding,
          ...(gateType === 'input'
            ? { response: decision.response }
            : { status: decision.status, optionId: decision.optionId }),
        }
        result = await raceCurrentSession()
      }
      terminalFailureKnown = ['failed', 'cancelled']
        .includes(String(result?.outcome || ''))
      if (agentController.signal.aborted) throw agentStoppedError()
      if (resumedPermissionError) throw resumedPermissionError
      if (resumedPermission && !resumedPermissionUsed) {
        throw new Error('LOCAL_RUN_PERMISSION_REQUEST_NOT_REISSUED')
      }
      result = requireTerminalAgentResult(result)
      this.markRuntimeCredential(kind, 'ready')

      const reply = mode === 'auto' && context.completionPolicy !== 'typed'
        ? parseAutoReply(result.text)
        : { text: result.text, consensus: false }
      if (!reply.text) throw new Error('LOCAL_AGENT_EMPTY_RESPONSE')
      if (allowWrite && context.mediaRequest && this.generateMedia && nativeMediaFallback
          && !generatedMedia && agentReturnedMediaProviderFailure(reply.text)) {
        sideEffectsStarted = true
        generatedMedia = await abortableOperation(() => this.generateMedia({
          kind,
          request: context.mediaRequest,
          workdir: group.workdir,
          signal: agentController.signal,
          onEvent: emitRuntimeEvent,
        }), agentController.signal)
        reply.text = `Meldwork generated and attached ${generatedMedia.filename}.`
      }
      const progress = attemptProgress.length ? attemptProgress : result.progress
      const toolCalls = cleanProgressSteps(progress).map(step => ({
        ...step,
        status: step.status === 'in_progress' ? 'completed' : step.status,
      }))
      if (activeRun) activeRun.progress = toolCalls
      if (activeRun?.budget) {
        const reportedOutputTokens = Number(result.usage?.outputTokens)
        const hasReportedOutputTokens = Number.isSafeInteger(reportedOutputTokens)
          && reportedOutputTokens >= 0
        const reportedCostMicros = Number(result.usage?.costMicros)
        activeRun.budget.addUsageBatch([
          {
            dimension: 'outputTokens',
            amount: hasReportedOutputTokens
              ? reportedOutputTokens
              : Math.ceil(reply.text.length / 4),
            source: hasReportedOutputTokens ? 'reported' : 'estimated',
          },
          { dimension: 'toolCalls', amount: toolCalls.length, source: 'estimated' },
          ...(Number.isSafeInteger(reportedCostMicros) && reportedCostMicros >= 0
            ? [{ dimension: 'costMicros', amount: reportedCostMicros, source: 'reported' }]
            : []),
          {
            dimension: 'elapsedMs',
            value: activeRun.budget.elapsedValue(),
            source: 'reported',
          },
        ])
        this.checkpointRun(group.id, activeRun)
      }
      let attachments = []
      if (allowWrite) {
        try {
          importPromise = Promise.resolve().then(() => this.importAgentOutputs({
            workdir: group.workdir,
            baseline: outputBaseline,
            startedAt,
            agentKind: kind,
            signal: agentController.signal,
          }))
          importPromise.catch(() => {})
          const imported = await abortableOperation(
            () => importPromise,
            agentController.signal,
          )
          attachments = (Array.isArray(imported) ? imported : [])
            .slice(0, MAX_MESSAGE_ATTACHMENTS)
            .map(normalizeAttachmentMetadata)
            .filter(Boolean)
        } catch (error) {
          if (agentController.signal.aborted) throw error
          /* the reply remains available when no valid media was produced */
        }
      }
      if (agentController.signal.aborted) throw agentStoppedError()
      let descriptors = []
      if (allowWrite && artifactOutputBaseline) {
        try {
          outcomeCapturePromise = Promise.resolve().then(() => (
            this.captureAgentOutcomeDescriptors({
              workdir: group.workdir,
              baseline: artifactOutputBaseline,
              startedAt,
              agentKind: kind,
              runId: activeRun?.runId,
              agentRunId: harnessRun?.agentRunId,
              signal: agentController.signal,
            })
          ))
          outcomeCapturePromise.catch(() => {})
          const captured = await abortableOperation(
            () => outcomeCapturePromise,
            agentController.signal,
          )
          descriptors = Array.isArray(captured) ? captured : []
        } catch (error) {
          if (agentController.signal.aborted) throw error
          /* the conclusion remains durable when explicit outputs cannot be captured */
        }
      }
      if (agentController.signal.aborted) throw agentStoppedError()
      const capturedOutcomeRefs = internal
        ? { artifactIds: [], evidenceIds: [] }
        : this.recordAgentOutcomes({
            groupId: group.id,
            runId: activeRun?.runId,
            agentRunId: harnessRun?.agentRunId,
            agentKind: kind,
            round,
            conclusion: reply.text,
            descriptors,
          })
      const requestedOutcomeRefs = !internal && context.outcomeRefs
        && typeof context.outcomeRefs === 'object'
        && !Array.isArray(context.outcomeRefs)
        ? context.outcomeRefs
        : {}
      const outcomeRefs = normalizeOutcomeRefs({
        ...requestedOutcomeRefs,
        artifactIds: [
          ...(Array.isArray(requestedOutcomeRefs.artifactIds)
            ? requestedOutcomeRefs.artifactIds
            : []),
          ...(capturedOutcomeRefs.artifactIds || []),
        ],
        evidenceIds: [
          ...(Array.isArray(requestedOutcomeRefs.evidenceIds)
            ? requestedOutcomeRefs.evidenceIds
            : []),
          ...(capturedOutcomeRefs.evidenceIds || []),
        ],
      })
      const finalStatus = result.outcome
      const trace = finishHarness(finalStatus, reply.text, {
        promptChars: prompt.length,
        externalRunRef: result.externalRunRef,
        outcomeRefs,
      })
      const message = internal
        ? null
        : this.addMessage(
            group.id,
            'agent',
            reply.text,
            kind,
            threadRootId,
            null,
            {
              elapsedMs: Date.now() - startedAt,
              toolCalls,
              attachments,
              trace,
              responseVersionRootId,
            },
          )
      if (!reviewOnly && !isolated) {
        this.persistSessionState(key, result.sessionRef || sessionRef, completedSessionMeta(
          sessionMeta, sessionProvenance, taskId, {
          promptChars: prompt.length,
          replyChars: reply.text.length,
          rotated: sessionRotated,
          transport: sessionTransport,
          },
        ))
      }
      return {
        message,
        outcomeRefs,
        consensus: reply.consensus && result.outcome === 'completed',
      }
    } catch (caughtError) {
      const parentTimedOut = Boolean(signal?.aborted && activeRun?.stopReason === 'timeout')
      const parentStopped = Boolean(signal?.aborted || parentAbortObserved)
      const parentInterrupted = parentStopped && activeRun?.stopReason === 'shutdown'
      const agentCancelled = agentController.signal.aborted
        && !parentStopped && !watchdogTimedOut
      if (parentStopped || watchdogTimedOut || agentCancelled) {
        const cleanupPromises = [
          capturePromise,
          artifactCapturePromise,
          runPromise,
          importPromise,
          outcomeCapturePromise,
        ].filter(Boolean)
        if (cleanupPromises.length) {
          await settleWithin(Promise.allSettled(cleanupPromises), this.runAbortGraceMs)
        }
      }
      const error = parentTimedOut
        ? new Error('LOCAL_AGENT_TIMEOUT')
        : parentStopped
          ? (caughtError?.message === 'LOCAL_AGENT_EXECUTION_STOPPED'
              ? caughtError
              : agentStoppedError())
          : watchdogTimedOut
            ? (watchdogError || new Error('LOCAL_AGENT_TIMEOUT'))
            : agentCancelled
              ? agentStoppedError()
              : caughtError
      if (credentialFailure(error) && context.deferCredentialFailure !== true) {
        this.markRuntimeCredential(kind, 'missing')
      }
      const status = parentTimedOut
        ? 'timeout'
        : parentInterrupted
          ? 'interrupted'
          : parentStopped
            ? 'stopped'
            : watchdogTimedOut
              ? 'timeout'
              : agentCancelled
                ? 'stopped'
                : 'failed'
      const trace = finishHarness(status)
      if (trace && error && (typeof error === 'object' || typeof error === 'function')) {
        Object.defineProperty(error, 'runTrace', {
          value: trace,
          enumerable: false,
          configurable: true,
        })
      }
      throw attachInvocationFailure(error, {
        outcomeCertainty: terminalFailureKnown
          ? 'known_failed'
          : (operationStarted || sideEffectsStarted ? 'unknown_outcome' : 'not_started'),
        sideEffectsPossible: allowWrite && sideEffectsStarted,
        operationId,
        idempotencyMode,
      })
    } finally {
      agentCallbacksClosed = true
      clearTimeout(watchdogTimer)
      watchdogTimer = null
      if (signal && parentAbortHandler) {
        signal.removeEventListener('abort', parentAbortHandler)
      }
      this.unregisterAgentController?.(
        activeRun, kind, registration.agentRunId, agentController,
      )
      if (activeRun?.stopReason !== 'shutdown') {
        for (const gateId of resolvedGateIds) {
          this.completeHumanGateContinuation?.(activeRun.runId, gateId, 'completed')
        }
      }
      cleanupStagedAgentInputs(stagedInputs)
    }
  }

  resetSession(group, kind, rotateOpenClaw = true, taskId = '') {
    const scopedTaskId = group.conversationType === 'direct' ? '' : cleanText(taskId, 120)
    const key = this.sessionKey(group.id, kind, scopedTaskId)
    const legacyPrefix = `${group.id}:${kind}:thread:`
    return this.commitSessionState((state) => {
      let changed = false
      for (const candidate of Object.keys(state.sessions)) {
        if (candidate !== key && !candidate.startsWith(legacyPrefix)) continue
        delete state.sessions[candidate]
        changed = true
      }
      for (const candidate of Object.keys(state.sessionMeta)) {
        if (candidate !== key && !candidate.startsWith(legacyPrefix)) continue
        delete state.sessionMeta[candidate]
        changed = true
      }
      if (kind === 'openclaw' && rotateOpenClaw) {
        const generation = randomUUID().replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'session'
        const provenance = createdSessionProvenance(group, cleanText(taskId, 120))
        state.sessions[key] = this.openClawSessionRef(group, generation, scopedTaskId)
        state.sessionMeta[key] = normalizeSessionMeta(provenanceMeta(provenance))
        changed = true
      }
      return changed
    })
  }
}

module.exports = { LocalWorkspaceAgentInvocation }
