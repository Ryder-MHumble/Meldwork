const { EventEmitter } = require('node:events')
const { randomUUID } = require('node:crypto')
const path = require('node:path')
const { ContentBlobStore } = require('./content-blob-store.cjs')
const { ContextPackStore } = require('./context-pack-store.cjs')
const { HumanGateCoordinator } = require('./human-gate-coordinator.cjs')
const { HumanGateStore } = require('./human-gate-store.cjs')
const { OutcomeStore } = require('./outcome-store.cjs')
const { normalizeOutcomeRefs, normalizeSessionMeta } = require('./run-harness.cjs')
const { LocalWorkspaceRunLedger } = require('./local-workspace-ledger.cjs')
const { LocalWorkspaceAgentCatalog } = require('./local-workspace-agent-catalog.cjs')
const { LocalWorkspaceAgentInvocation } = require('./local-workspace-agent-invocation.cjs')
const { LocalWorkspaceAutoRunner } = require('./local-workspace-auto-runner.cjs')
const { LocalWorkspaceConversations } = require('./local-workspace-conversations.cjs')
const { LocalWorkspaceContextPacks } = require('./local-workspace-context-packs.cjs')
const { LocalWorkspaceMessageSubmission } = require('./local-workspace-message-submission.cjs')
const { LocalWorkspaceRunCoordinator } = require('./local-workspace-run-coordinator.cjs')
const { LocalWorkspaceRunMessages } = require('./local-workspace-run-messages.cjs')
const {
  clearSessionState,
  openClawSessionRef,
  packedPromptContext,
  promptFor,
  promptMessageText,
  recentTranscriptEntries,
  resolveSessionState,
  sessionKey,
  stableUserInstructions,
  stableUserMessages,
} = require('./local-workspace-context.cjs')
const {
  DEFAULT_RUN_ABORT_GRACE_MS,
  DEFAULT_RUN_AGENT_TIMEOUT_MS,
  DEFAULT_RUN_SILENCE_WARNING_MS,
  SESSION_KEY,
  cleanInline,
  defaultAgentLabel,
  normalizeSessionRef,
} = require('./local-workspace-inputs.cjs')
const {
  loadWorkspaceState,
  saveWorkspaceState,
  workspaceSnapshot,
} = require('./local-workspace-state.cjs')

const MAX_AGENT_OUTCOME_ARTIFACTS = 16
const OUTCOME_RECORDER = Object.freeze({ kind: 'system', actorId: 'meldwork-main' })

class LocalWorkspace extends EventEmitter {
  constructor(options) {
    super()
    this.storagePath = options.storagePath
    this.detectAgentsFn = options.detectAgents
    this.runAgentFn = options.runAgent
    this.generateMediaFn = options.generateMedia || null
    this.resolveAttachmentsFn = options.resolveAttachments || (async (attachments) => {
      if (attachments?.length) throw new Error('LOCAL_ATTACHMENT_STORAGE_UNAVAILABLE')
      return []
    })
    this.captureAgentOutputsFn = options.captureAgentOutputs || (async () => null)
    this.importAgentOutputsFn = options.importAgentOutputs || (async () => [])
    this.captureArtifactOutputsFn = options.captureArtifactOutputs || (async () => null)
    this.captureAgentOutcomeDescriptorsFn = options.captureAgentOutcomeDescriptors
      || (async () => [])
    this.validateSkillSelectionsFn = options.validateSkillSelections || ((_kind, selections) => selections)
    this.validateKnowledgeBaseSelectionsFn = options.validateKnowledgeBaseSelections || ((_kinds, selections) => selections)
    this.imageAttachmentLimitFn = options.imageAttachmentLimit || (() => 0)
    this.attachmentSupportFn = options.attachmentSupport || (kind => ({
      image: this.imageAttachmentLimitFn(kind),
    }))
    this.credentialStateFn = options.credentialState || (async () => ({ state: 'unknown', source: 'unverified' }))
    this.sharedProviderReadyFn = options.sharedProviderReady || (() => false)
    this.agentLabelFn = options.agentLabel || defaultAgentLabel
    this.runSilenceWarningMs = Number.isFinite(options.runSilenceWarningMs)
      && options.runSilenceWarningMs > 0
      ? options.runSilenceWarningMs
      : DEFAULT_RUN_SILENCE_WARNING_MS
    this.runAgentTimeoutMs = Number.isFinite(options.runAgentTimeoutMs)
      && options.runAgentTimeoutMs > 0
      ? options.runAgentTimeoutMs
      : DEFAULT_RUN_AGENT_TIMEOUT_MS
    this.runAbortGraceMs = Number.isFinite(options.runAbortGraceMs)
      && options.runAbortGraceMs > 0
      ? options.runAbortGraceMs
      : DEFAULT_RUN_ABORT_GRACE_MS
    this.runBudgetDefaults = options.runBudgetDefaults || {}
    this.now = options.now || (() => new Date().toISOString())
    this.createId = options.createId || randomUUID
    this.createRunId = options.createRunId || randomUUID
    this.runLedger = options.runLedger || null
    this.workspaceRecovery = this.load()
    this.state = this.workspaceRecovery.state
    const privateRoot = path.join(path.dirname(this.storagePath), 'roundrelay-private')
    this.contentBlobStore = options.contentBlobStore || new ContentBlobStore({
      rootPath: path.join(privateRoot, 'content-blobs'),
    })
    this.contextPackStore = options.contextPackStore || new ContextPackStore({
      rootPath: path.join(privateRoot, 'context-packs'),
    })
    this.outcomeStore = options.outcomeStore || new OutcomeStore({
      rootPath: path.join(privateRoot, 'outcomes'),
      contentBlobStore: this.contentBlobStore,
    })
    this.humanGateStore = options.humanGateStore || new HumanGateStore({
      storagePath: path.join(privateRoot, 'human-gates.json'),
      contentBlobStore: this.contentBlobStore,
    })
    this.humanGateCoordinator = options.humanGateCoordinator || new HumanGateCoordinator({
      store: this.humanGateStore,
      now: () => this.now(),
      onChanged: () => this.emitChanged(),
      onWaiting: (record, continuation) => this.markHumanGateWaiting(record, continuation),
      onResumed: record => this.markHumanGateResumed(record),
      canResume: record => this.canResumeHumanGate(record),
      onOrphanDecision: (record, decision) => this.resumeHumanGateDecision(record, decision),
      onResumeFailed: (record, error) => this.failHumanGateContinuation(record, error),
    })
    this.contextPacks = new LocalWorkspaceContextPacks({
      contentBlobStore: this.contentBlobStore,
      contextPackStore: this.contextPackStore,
    })
    if (this.workspaceRecovery.trusted) {
      this.runLedger?.reconcileContextPacks?.(
        contextPackId => this.contextPackStore.get(contextPackId),
      )
    }
    this.detectedAgents = []
    this.preparingRuns = new Map()
    this.activeRuns = new Map()
    this.runCheckpointTimers = new Map()
    this.humanGateWaitTails = new Map()
    this.shuttingDown = false
    this.agentCatalog = new LocalWorkspaceAgentCatalog({
      state: () => this.state,
      detectedAgents: () => this.detectedAgents,
      setDetectedAgents: agents => { this.detectedAgents = agents },
      detectAgents: () => this.detectAgentsFn(),
      credentialState: (...args) => this.credentialStateFn(...args),
      sharedProviderReady: kind => this.sharedProviderReadyFn(kind),
      save: () => this.save(),
      emitChanged: () => this.emitChanged(),
      snapshot: () => this.snapshot(),
      now: () => this.now(),
    })
    this.runLedgerCoordinator = new LocalWorkspaceRunLedger({
      runLedger: this.runLedger,
      state: () => this.state,
      save: () => this.save(),
      createId: () => this.createId(),
      now: () => this.now(),
      agentLabel: kind => this.agentLabel(kind),
      preserveWaitingRun: record => this.canResumeHumanGateRecord(record),
      preparingRuns: this.preparingRuns,
      timers: this.runCheckpointTimers,
    })
    this.runCoordinator = new LocalWorkspaceRunCoordinator({
      preparingRuns: this.preparingRuns,
      activeRuns: this.activeRuns,
      createRunId: () => this.createRunId(),
      getRunSilenceWarningMs: () => this.runSilenceWarningMs,
      isShuttingDown: () => this.shuttingDown,
      setShuttingDown: value => { this.shuttingDown = value },
      checkpointRun: (...args) => this.checkpointRun(...args),
      hasRunLedger: () => Boolean(this.runLedger),
      validateContextPack: (contextPackId, taskId) => {
        const pack = this.contextPackStore.get(contextPackId)
        return pack.contextPackId === contextPackId && pack.taskId === taskId
      },
      finishRunCheckpoint: (...args) => this.finishRunCheckpoint(...args),
      scheduleRunCheckpoint: (...args) => this.scheduleRunCheckpoint(...args),
      emitChanged: () => this.emitChanged(),
      emit: (...args) => this.emit(...args),
      runBudgetDefaults: this.runBudgetDefaults,
    })
    this.conversations = new LocalWorkspaceConversations({
      state: () => this.state,
      detectedAgents: () => this.detectedAgents,
      save: () => this.save(),
      emitChanged: () => this.emitChanged(),
      isGroupBusy: groupId => this.isGroupBusy(groupId),
      clearSessionState: groupId => this.clearSessionState(groupId),
      runLedger: this.runLedger,
      agentLabel: kind => this.agentLabel(kind),
      createId: () => this.createId(),
      now: () => this.now(),
    })
    this.runMessages = new LocalWorkspaceRunMessages({
      state: () => this.state,
      activeRuns: this.activeRuns,
      agentLabel: kind => this.agentLabel(kind),
      checkpointRun: (...args) => this.checkpointRun(...args),
      addMessage: (...args) => this.addMessage(...args),
    })
    this.agentInvocation = new LocalWorkspaceAgentInvocation({
      state: () => this.state,
      detectedAgents: () => this.detectedAgents,
      activeRuns: this.activeRuns,
      runAgentTimeoutMs: this.runAgentTimeoutMs,
      runAbortGraceMs: this.runAbortGraceMs,
      captureAgentOutputs: (...args) => this.captureAgentOutputsFn(...args),
      captureArtifactOutputs: (...args) => this.captureArtifactOutputsFn(...args),
      captureAgentOutcomeDescriptors: (...args) => (
        this.captureAgentOutcomeDescriptorsFn(...args)
      ),
      runAgent: (...args) => this.runAgentFn(...args),
      importAgentOutputs: (...args) => this.importAgentOutputsFn(...args),
      recordAgentOutcomes: (...args) => this.recordAgentOutcomes(...args),
      sessionKey: (...args) => this.sessionKey(...args),
      sessionState: (...args) => this.sessionState(...args),
      openClawSessionRef: (...args) => this.openClawSessionRef(...args),
      save: () => this.save(),
      packedPromptContext: (...args) => this.packedPromptContext(...args),
      ensureRunHarness: (...args) => this.ensureRunHarness(...args),
      emitRunEvent: event => this.emitRunEvent(event),
      armAgentSilence: (...args) => this.armAgentSilence(...args),
      clearAgentSilence: (...args) => this.clearAgentSilence(...args),
      checkpointRun: (...args) => this.checkpointRun(...args),
      scheduleRunCheckpoint: (...args) => this.scheduleRunCheckpoint(...args),
      emitChanged: () => this.emitChanged(),
      promptFor: (...args) => this.promptFor(...args),
      persistSessionState: (...args) => this.persistSessionState(...args),
      createAttemptContextPack: (...args) => this.createAttemptContextPack(...args),
      recordContextDelivery: (...args) => this.recordContextDelivery(...args),
      markRuntimeCredential: (...args) => this.markRuntimeCredential(...args),
      addMessage: (...args) => this.addMessage(...args),
      runScheduler: options.runScheduler,
      registerAgentController: (...args) => this.runCoordinator.registerAgentController(...args),
      unregisterAgentController: (...args) => this.runCoordinator.unregisterAgentController(...args),
      requestHumanGate: (...args) => this.requestHumanGate(...args),
      completeHumanGateContinuation: (...args) => this.completeHumanGateContinuation(...args),
      connectorRuntime: options.connectorRuntime,
      attachmentSupport: (...args) => this.attachmentSupportFn(...args),
      generateMedia: (...args) => this.generateMediaFn?.(...args),
    })
    this.autoRunner = new LocalWorkspaceAutoRunner({
      state: () => this.state,
      beginRun: (...args) => this.beginRun(...args),
      resolveAttachments: (...args) => this.resolveAttachments(...args),
      validateSkillSelections: (...args) => this.validateSkillSelectionsFn(...args),
      validateKnowledgeBaseSelections: (...args) => this.validateKnowledgeBaseSelectionsFn(...args),
      invokeAgent: (...args) => this.invokeAgent(...args),
      resetAgentSession: (...args) => this.resetAgentSession(...args),
      refreshAgents: () => this.refreshAgents(),
      consumeAgentControl: (...args) => this.runCoordinator.consumeAgentControl(...args),
      markRuntimeCredential: (...args) => this.markRuntimeCredential(...args),
      agentLabel: kind => this.agentLabel(kind),
      recordAgentFailure: (...args) => this.recordAgentFailure(...args),
      recordAgentInterruption: (...args) => this.recordAgentInterruption(...args),
      addMessage: (...args) => this.addMessage(...args),
      emitChanged: () => this.emitChanged(),
      finishRun: (...args) => this.finishRun(...args),
      checkpointRun: (...args) => this.checkpointRun(...args),
      hasRunLedger: () => Boolean(this.runLedger),
      retryBaseDelayMs: options.retryBaseDelayMs,
      retryMaxDelayMs: options.retryMaxDelayMs,
      retrySleep: options.retrySleep,
    })
    this.messageSubmission = new LocalWorkspaceMessageSubmission({
      state: () => this.state,
      detectedAgents: () => this.detectedAgents,
      isShuttingDown: () => this.shuttingDown,
      resolveAttachments: (...args) => this.resolveAttachmentsFn(...args),
      attachmentSupport: (...args) => this.attachmentSupportFn(...args),
      validateSkillSelections: (...args) => this.validateSkillSelectionsFn(...args),
      validateKnowledgeBaseSelections: (...args) => this.validateKnowledgeBaseSelectionsFn(...args),
      getGroup: (...args) => this.getGroup(...args),
      isGroupBusy: (...args) => this.isGroupBusy(...args),
      reserveRun: (...args) => this.reserveRun(...args),
      bindRunTask: (...args) => this.bindRunTask(...args),
      releasePreparation: (...args) => this.releasePreparation(...args),
      addMessage: (...args) => this.addMessage(...args),
      rollbackAddedMessage: (...args) => this.conversations.rollbackAddedMessage(...args),
      startAutoRunner: (...args) => this.startAutoRunner(...args),
      beginRun: (...args) => this.beginRun(...args),
      invokeAgent: (...args) => this.invokeAgent(...args),
      invokeWithRecovery: input => this.autoRunner.invokeWithUnauthorizedRecovery({
        ...input,
        mode: 'manual',
      }),
      recordAgentInterruption: (...args) => this.recordAgentInterruption(...args),
      recordAgentFailure: (...args) => this.recordAgentFailure(...args),
      emitChanged: () => this.emitChanged(),
      snapshot: () => this.snapshot(),
      finishRun: (...args) => this.finishRun(...args),
      createContextPack: (...args) => this.createContextPack(...args),
      configureRunBudget: (...args) => this.runCoordinator.configureBudget(...args),
      resetAgentSession: (...args) => this.resetAgentSession(...args),
      refreshAgents: () => this.refreshAgents(),
      consumeAgentControl: (...args) => this.runCoordinator.consumeAgentControl(...args),
      checkpointRun: (...args) => this.checkpointRun(...args),
      hasRunLedger: () => Boolean(this.runLedger),
    })
    if (this.workspaceRecovery.trusted) {
      this.humanGateCoordinator.reconcileDecisions?.()
      this.restoreInterruptedRuns()
      this.humanGateCoordinator.reconcileOrphans?.()
      this.resumeReadyHumanGates()
    }
  }

  agentLabel(kind) {
    return cleanInline(this.agentLabelFn(kind), 60) || defaultAgentLabel(kind)
  }

  load() {
    return loadWorkspaceState(this.storagePath)
  }

  save() {
    if (!this.workspaceRecovery.trusted) {
      throw new Error(this.workspaceRecovery.diagnostic || 'LOCAL_WORKSPACE_STATE_UNTRUSTED')
    }
    saveWorkspaceState(this.storagePath, this.state)
  }

  restoreInterruptedRuns() {
    this.runLedgerCoordinator.restoreInterruptedRuns()
  }

  runLedgerRecord(groupId, controller, status = '') {
    return this.runLedgerCoordinator.record(groupId, controller, status)
  }

  checkpointRun(groupId, controller, status = '') {
    return this.runLedgerCoordinator.checkpoint(groupId, controller, status)
  }

  scheduleRunCheckpoint(groupId, controller) {
    this.runLedgerCoordinator.schedule(groupId, controller)
  }

  finishRunCheckpoint(groupId, controller, status) {
    this.runLedgerCoordinator.finish(groupId, controller, status)
  }

  snapshot() {
    return workspaceSnapshot(this)
  }

  emitChanged() {
    this.emit('changed', this.snapshot())
  }

  createRunController(mode, targetKinds, threadRootId, maxRounds = 0, unlimitedRounds = false) {
    return this.runCoordinator.createController(
      mode, targetKinds, threadRootId, maxRounds, unlimitedRounds,
    )
  }

  isGroupBusy(groupId) {
    if (this.runCoordinator.isGroupBusy(groupId)) return true
    try {
      return (this.runLedger?.list?.(groupId) || []).some(record => (
        record.status === 'waiting' && this.canResumeHumanGateRecord(record)
      ))
    } catch {
      return false
    }
  }

  reserveRun(
    groupId, mode, targetKinds, threadRootId = '', maxRounds = 0, unlimitedRounds = false,
  ) {
    return this.runCoordinator.reserve(
      groupId, mode, targetKinds, threadRootId, maxRounds, unlimitedRounds,
    )
  }

  bindRunTask(groupId, controller, taskId, threadRootId = '', contextPackId = '') {
    return this.runCoordinator.bindTask(
      groupId, controller, taskId, threadRootId, contextPackId,
    )
  }

  releasePreparation(groupId, controller) {
    return this.runCoordinator.releasePreparation(groupId, controller)
  }

  beginRun(
    groupId, mode, targetKinds, threadRootId, reservation = null, maxRounds = 0,
    unlimitedRounds = false,
  ) {
    return this.runCoordinator.begin(
      groupId, mode, targetKinds, threadRootId, reservation, maxRounds, unlimitedRounds,
    )
  }

  finishRun(groupId, controller, status) {
    return this.runCoordinator.finish(groupId, controller, status)
  }

  configureRunBudget(controller, input = {}) {
    return this.runCoordinator.configureBudget(controller, input)
  }

  controllerForRunId(runId) {
    return [...this.activeRuns.entries()].find(([, controller]) => controller.runId === runId) || null
  }

  continuationTimestamp() {
    const timestamp = Date.parse(this.now())
    return Number.isFinite(timestamp) ? timestamp : Date.now()
  }

  markHumanGateWaiting(record, input) {
    const match = this.controllerForRunId(record?.runId)
    if (!match || !input || typeof input !== 'object') {
      throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
    }
    const [groupId, controller] = match
    const previousWaitingGateIds = new Set(controller.waitingGateIds)
    const previousContinuation = controller.continuation
    const timestamp = this.continuationTimestamp()
    try {
      controller.continuation = {
        gateId: record.gateId,
        gateType: record.type,
        resumeKind: input.resumeKind,
        state: 'pending',
        agentRunId: input.agentRunId,
        agentKind: input.agentKind,
        round: input.round || 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      controller.waitingGateIds.add(record.gateId)
      if (this.runLedger && this.checkpointRun(groupId, controller, 'waiting') !== true) {
        throw new Error('LOCAL_RUN_PERSIST_FAILED')
      }
    } catch (error) {
      controller.waitingGateIds.clear()
      for (const gateId of previousWaitingGateIds) controller.waitingGateIds.add(gateId)
      controller.continuation = previousContinuation
      throw error
    }
    return true
  }

  markHumanGateResumed(record) {
    const match = this.controllerForRunId(record?.runId)
    if (!match) {
      const durable = this.runLedger?.get?.(record?.runId)
      if (!durable?.continuation || durable.continuation.gateId !== record.gateId) return false
      this.runLedger.checkpoint({
        runId: durable.runId,
        continuation: {
          ...durable.continuation,
          state: 'ready',
          updatedAt: this.continuationTimestamp(),
        },
      })
      return true
    }
    const [groupId, controller] = match
    const previousWaitingGateIds = new Set(controller.waitingGateIds)
    const previousContinuation = controller.continuation
    try {
      controller.waitingGateIds.delete(record.gateId)
      if (controller.continuation?.gateId === record.gateId) {
        controller.continuation = {
          ...controller.continuation,
          state: 'ready',
          updatedAt: this.continuationTimestamp(),
        }
      }
      if (this.runLedger && this.checkpointRun(
        groupId, controller, controller.waitingGateIds.size ? 'waiting' : 'running',
      ) !== true) throw new Error('LOCAL_RUN_PERSIST_FAILED')
    } catch (error) {
      controller.waitingGateIds.clear()
      for (const gateId of previousWaitingGateIds) controller.waitingGateIds.add(gateId)
      controller.continuation = previousContinuation
      throw error
    }
    return true
  }

  async requestHumanGate(input, options = {}) {
    const runId = String(input?.runId || '')
    const previous = this.humanGateWaitTails.get(runId) || Promise.resolve()
    let release
    const current = new Promise((resolve) => { release = resolve })
    this.humanGateWaitTails.set(runId, current)
    let gateId = ''
    try {
      await previous
      if (options.signal?.aborted) throw new Error('LOCAL_AGENT_EXECUTION_STOPPED')
      const decision = await this.humanGateCoordinator.wait(input, {
        ...options,
        onCreated: record => { gateId = record.gateId },
      })
      return { ...decision, gateId }
    } finally {
      release()
      if (this.humanGateWaitTails.get(runId) === current) {
        this.humanGateWaitTails.delete(runId)
      }
    }
  }

  listHumanGates(options = {}) {
    return this.humanGateCoordinator.list(options)
  }

  decideHumanGate(gateId, decision) {
    return this.humanGateCoordinator.decide(gateId, decision)
  }

  canResumeHumanGateRecord(runRecord, gateRecord = null) {
    const continuation = runRecord?.continuation
    if (!continuation || continuation.gateId !== gateRecord?.gateId && gateRecord) return false
    if (!['pending', 'ready', 'resuming'].includes(continuation.state)) return false
    let gate = gateRecord
    try { gate ||= this.humanGateStore.get(continuation.gateId) } catch { return false }
    if (gate.runId !== runRecord.runId || gate.type !== continuation.gateType
        || gate.agentRunId !== continuation.agentRunId
        || gate.agentKind !== continuation.agentKind) return false
    if (continuation.state !== 'pending' && gate.status === 'pending') return false
    try {
      const pack = this.contextPackStore.get(runRecord.contextPackId)
      return pack.taskId === runRecord.taskId
        && this.state.groups.some(group => group.id === runRecord.groupId)
        && Boolean(this.humanGateStore.request(gate.gateId))
    } catch {
      return false
    }
  }

  canResumeHumanGate(gateRecord) {
    const runRecord = this.runLedger?.get?.(gateRecord?.runId)
    return this.canResumeHumanGateRecord(runRecord, gateRecord)
  }

  completeHumanGateContinuation(runId, gateId, state = 'completed') {
    const match = this.controllerForRunId(runId)
    if (!match) return false
    const [groupId, controller] = match
    if (controller.continuation?.gateId !== gateId) return false
    controller.waitingGateIds.delete(gateId)
    controller.continuation = {
      ...controller.continuation,
      state: ['completed', 'failed', 'cancelled'].includes(state) ? state : 'completed',
      updatedAt: this.continuationTimestamp(),
    }
    return this.checkpointRun(groupId, controller) === true || !this.runLedger
  }

  canFinalizeReplayedAgentSlot(durable) {
    const continuation = durable?.continuation
    const targetKinds = Array.isArray(durable?.targetKinds) ? durable.targetKinds : []
    if (durable?.mode !== 'manual' || continuation?.resumeKind !== 'agent_slot'
        || targetKinds.length !== 1 || targetKinds[0] !== continuation.agentKind) return false
    return !durable.threadRootId || durable.taskId === durable.threadRootId
  }

  canResumeOrchestration(durable, workflow) {
    const cursor = durable?.orchestration
    const continuation = durable?.continuation
    if (durable?.mode !== workflow || cursor?.version !== 1 || cursor.workflow !== workflow
        || cursor.currentKind !== continuation?.agentKind
        || !cursor.activeKinds.includes(cursor.currentKind)) return false
    const targetKinds = Array.isArray(durable.targetKinds) ? durable.targetKinds : []
    if (workflow === 'auto' && (
      durable.currentRound < 1 || continuation?.round !== durable.currentRound
    )) return false
    if (workflow === 'manual' && continuation?.round !== 0) return false
    return cursor.activeKinds.length > 0
      && cursor.activeKinds.every(kind => targetKinds.includes(kind))
      && cursor.pendingKinds.every(kind => cursor.activeKinds.includes(kind))
      && !cursor.pendingKinds.includes(cursor.currentKind)
      && !cursor.successfulKinds.includes(cursor.currentKind)
      && cursor.successfulKinds.every(kind => cursor.activeKinds.includes(kind))
      && cursor.pendingKinds.every(kind => !cursor.successfulKinds.includes(kind))
      && cursor.agreementKinds.every(kind => cursor.successfulKinds.includes(kind))
  }

  canResumeManualOrchestration(durable) {
    return this.canResumeOrchestration(durable, 'manual')
  }

  canResumeAutoOrchestration(durable) {
    return this.canResumeOrchestration(durable, 'auto')
  }

  async replayAgentSlot(group, durable, controller, gate, decision, request) {
    if (!['budget', 'permission'].includes(gate?.type)) {
      throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
    }
    const message = this.state.messages.find(candidate => (
      candidate.groupId === group.id
      && candidate.role === 'user'
      && [durable.taskId, durable.threadRootId].includes(candidate.id)
    ))
    if (!message) throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
    const attachments = await this.resolveAttachments(message.attachments || [])
    const skills = await this.validateSkillSelectionsFn(
      durable.continuation.agentKind,
      (message.skillHints || []).filter(skill => (
        skill.targetKind === durable.continuation.agentKind
      )),
    )
    const knowledge = await this.validateKnowledgeBaseSelectionsFn(
      [durable.continuation.agentKind], message.knowledgeBaseHints || [],
    )
    const activeKinds = controller.orchestration?.activeKinds || durable.targetKinds
    const recovered = await this.autoRunner.invokeWithUnauthorizedRecovery({
      group,
      kind: durable.continuation.agentKind,
      controller,
      activeKinds,
      threadRootId: durable.threadRootId,
      context: {
        attachments: attachments.map(attachment => attachment.path),
        attachmentSnapshots: attachments,
        skillHints: skills,
        knowledgeBaseHints: knowledge,
        resumedGate: {
          gateId: gate.gateId,
          type: gate.type,
          status: decision.status,
          optionId: decision.optionId,
          ...(gate.type === 'permission' ? { request } : {}),
          used: false,
        },
        runtimeInstruction: gate.type === 'permission'
          ? [
              'Resume the existing Agent Session at its pending permission request.',
              'Do not repeat actions completed before that request.',
              'Continue only after the Harness applies the persisted decision to the exact reissued request.',
            ].join(' ')
          : '',
      },
      reportedFailures: new Set(),
      mode: durable.mode,
    })
    if (!recovered?.result) throw recovered?.error || new Error('LOCAL_RUN_CONTINUATION_FAILED')
    if (!controller.completedKinds.includes(durable.continuation.agentKind)) {
      controller.completedKinds.push(durable.continuation.agentKind)
    }
    return recovered.result
  }

  async continueManualOrchestration(group, durable, controller) {
    const cursor = controller.orchestration
    const message = this.state.messages.find(candidate => (
      candidate.groupId === group.id
      && candidate.role === 'user'
      && [durable.taskId, durable.threadRootId].includes(candidate.id)
    ))
    if (!message || cursor?.version !== 1 || cursor.workflow !== 'manual'
        || cursor.currentKind || cursor.pendingKinds.some(kind => !cursor.activeKinds.includes(kind))) {
      throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
    }
    const attachments = await this.resolveAttachments(message.attachments || [])
    const activeKinds = [...cursor.activeKinds]
    const successfulKinds = new Set(cursor.successfulKinds)
    const pendingKinds = [...cursor.pendingKinds]
    const reportedFailures = new Set()

    while (pendingKinds.length) {
      const kind = pendingKinds.shift()
      if (!activeKinds.includes(kind) || controller.signal.aborted) continue
      controller.currentKind = kind
      controller.progress = []
      controller.orchestration = {
        ...controller.orchestration,
        currentKind: kind,
        pendingKinds: [...pendingKinds],
        successfulKinds: [...successfulKinds],
      }
      if (this.checkpointRun(group.id, controller) !== true) {
        throw new Error('LOCAL_RUN_PERSIST_FAILED')
      }
      this.emitChanged()
      try {
        const skills = await this.validateSkillSelectionsFn(
          kind,
          (message.skillHints || []).filter(skill => skill.targetKind === kind),
        )
        const knowledge = await this.validateKnowledgeBaseSelectionsFn(
          [kind],
          (message.knowledgeBaseHints || []).filter(source => source.targetKinds?.includes(kind))
            .map(source => ({ ...source, targetKinds: [kind] })),
        )
        const invocation = await this.autoRunner.invokeWithUnauthorizedRecovery({
          group,
          kind,
          controller,
          activeKinds,
          threadRootId: durable.threadRootId,
          context: {
            attachments: attachments.map(attachment => attachment.path),
            attachmentSnapshots: attachments,
            skillHints: skills,
            knowledgeBaseHints: knowledge,
            contextOptions: { focusUserMessageId: message.id },
          },
          reportedFailures,
          mode: 'manual',
        })
        if (!invocation?.result) throw invocation?.error || new Error('LOCAL_AGENT_UNKNOWN_FAILURE')
        successfulKinds.add(kind)
      } catch (error) {
        if (controller.signal.aborted) {
          this.recordAgentInterruption(
            group.id,
            kind,
            error,
            durable.threadRootId,
            controller.stopReason === 'shutdown' ? 'interrupted' : 'stopped',
            reportedFailures,
          )
          if (!controller.completedKinds.includes(kind)) controller.completedKinds.push(kind)
          break
        }
        this.recordAgentFailure(group.id, kind, error, durable.threadRootId, reportedFailures)
        if (!controller.failedKinds.includes(kind)) controller.failedKinds.push(kind)
        successfulKinds.delete(kind)
      }
      if (!controller.completedKinds.includes(kind)) controller.completedKinds.push(kind)
      controller.currentKind = ''
      controller.progress = []
      controller.orchestration = {
        ...controller.orchestration,
        currentKind: '',
        pendingKinds: [...pendingKinds],
        successfulKinds: [...successfulKinds],
      }
      if (this.checkpointRun(group.id, controller) !== true) {
        throw new Error('LOCAL_RUN_PERSIST_FAILED')
      }
      this.emitChanged()
    }

    if (controller.signal.aborted) {
      return controller.stopReason === 'shutdown' ? 'interrupted' : 'stopped'
    }
    const successCount = activeKinds.filter(kind => successfulKinds.has(kind)).length
    if (!successCount) return 'failed'
    return successCount === activeKinds.length ? 'completed' : 'partial'
  }

  async resumeHumanGateDecision(gate, decision) {
    const durable = this.runLedger?.get?.(gate.runId)
    if (!this.canResumeHumanGateRecord(durable, gate)) {
      return this.failHumanGateContinuation(gate, new Error('LOCAL_RUN_CONTINUATION_INVALID'))
    }
    let controller = null
    try {
      controller = this.runCoordinator.resume(durable)
      const group = this.getGroup(durable.groupId)
      const resumableManual = this.canResumeManualOrchestration(durable)
      const resumableAuto = this.canResumeAutoOrchestration(durable)
      if (durable.continuation.resumeKind === 'agent_slot'
          && decision.status === 'approved'
          && !this.canFinalizeReplayedAgentSlot(durable)
          && !resumableManual
          && !resumableAuto) {
        throw new Error('LOCAL_RUN_ORCHESTRATION_RESUME_UNAVAILABLE')
      }
      if (durable.continuation.resumeKind === 'role_review_decision') {
        throw new Error('LOCAL_WORKFLOW_UNSUPPORTED')
      }
      const request = this.humanGateStore.request(gate.gateId)
      let replayedResult = null
      if (gate.type === 'permission') {
        if (decision.status === 'rejected') {
          this.resetAgentSession(group, durable.continuation.agentKind, true, durable.taskId)
          if (!controller.completedKinds.includes(durable.continuation.agentKind)) {
            controller.completedKinds.push(durable.continuation.agentKind)
          }
          this.completeHumanGateContinuation(durable.runId, gate.gateId, 'cancelled')
          this.finishRun(durable.groupId, controller, 'stopped')
          return
        }
        replayedResult = await this.replayAgentSlot(
          group, durable, controller, gate, decision, request,
        )
      } else if (gate.type === 'budget' && decision.status !== 'approved') {
        throw new Error('LOCAL_BUDGET_REJECTED')
      } else {
        replayedResult = await this.replayAgentSlot(
          group, durable, controller, gate, decision, request,
        )
      }
      if (resumableManual || resumableAuto) {
        const successfulKinds = new Set(controller.orchestration.successfulKinds)
        successfulKinds.add(durable.continuation.agentKind)
        controller.currentKind = ''
        controller.orchestration = {
          ...controller.orchestration,
          currentKind: '',
          successfulKinds: [...successfulKinds],
          ...(resumableAuto ? {
            agreementKinds: replayedResult?.consensus
              ? [...new Set([
                  ...controller.orchestration.agreementKinds,
                  durable.continuation.agentKind,
                ])]
              : controller.orchestration.agreementKinds.filter(
                  kind => kind !== durable.continuation.agentKind,
                ),
            attachmentRecipients: [...new Set([
              ...controller.orchestration.attachmentRecipients,
              durable.continuation.agentKind,
            ])],
          } : {}),
        }
      }
      if (!this.completeHumanGateContinuation(durable.runId, gate.gateId, 'completed')) {
        throw new Error('LOCAL_RUN_PERSIST_FAILED')
      }
      const finalStatus = resumableManual
        ? await this.continueManualOrchestration(group, durable, controller)
        : (resumableAuto
            ? await this.autoRunner.resume(group, durable, controller)
            : 'completed')
      this.finishRun(durable.groupId, controller, finalStatus)
    } catch (error) {
      if (controller) {
        if (controller.signal.aborted && controller.stopReason === 'shutdown') {
          this.finishRun(durable.groupId, controller, 'interrupted')
          return
        }
        if (durable.continuation.resumeKind === 'agent_slot'
            && decision.status !== 'rejected') {
          if (!controller.failedKinds.includes(durable.continuation.agentKind)) {
            controller.failedKinds.push(durable.continuation.agentKind)
          }
          this.recordAgentFailure(
            durable.groupId,
            durable.continuation.agentKind,
            error,
            durable.threadRootId,
            new Set(),
          )
          controller.stopReason = String(error?.message || 'human_gate_continuation_failed')
        }
        if (durable.continuation.resumeKind === 'role_review_decision') {
          controller.stopReason = 'LOCAL_WORKFLOW_UNSUPPORTED'
        }
        this.completeHumanGateContinuation(
          durable.runId, gate.gateId,
          decision.status === 'rejected' ? 'cancelled' : 'failed',
        )
        this.finishRun(durable.groupId, controller, decision.status === 'rejected' ? 'stopped' : 'failed')
      } else {
        this.failHumanGateContinuation(gate, error)
      }
    }
  }

  failHumanGateContinuation(gate) {
    const gateId = String(gate?.gateId || '')
    const durable = (this.runLedger?.list?.() || []).find(record => (
      record.continuation?.gateId === gateId
        && ['pending', 'ready', 'resuming'].includes(record.continuation.state)
    ))
    if (!durable) return false
    try {
      if (durable.continuation?.gateId === gate.gateId) {
        this.runLedger.checkpoint({
          runId: durable.runId,
          continuation: {
            ...durable.continuation,
            state: 'failed',
            updatedAt: this.continuationTimestamp(),
          },
        })
      }
      this.runLedger.finish(durable.runId, 'failed', 'human_gate_continuation_invalid')
      return true
    } catch {
      return false
    }
  }

  resumeReadyHumanGates() {
    for (const durable of this.runLedger?.list?.() || []) {
      if (!['ready', 'resuming'].includes(durable.continuation?.state)) continue
      let gate
      try { gate = this.humanGateStore.get(durable.continuation.gateId) } catch { continue }
      if (!gate.decision) continue
      queueMicrotask(() => this.resumeHumanGateDecision(gate, gate.decision))
    }
  }

  recordAgentFailure(groupId, kind, error, threadRootId, reportedFailures = null) {
    return this.runMessages.recordFailure(
      groupId, kind, error, threadRootId, reportedFailures,
    )
  }

  streamedAgentConclusion(groupId, agentRunId) {
    return this.runMessages.streamedConclusion(groupId, agentRunId)
  }

  recordAgentInterruption(
    groupId, kind, error, threadRootId, status = 'stopped', reportedFailures = null,
  ) {
    return this.runMessages.recordInterruption(
      groupId, kind, error, threadRootId, status, reportedFailures,
    )
  }

  async refreshAgents() {
    return this.agentCatalog.refresh()
  }

  setSidebarVisibility(kind, visible) {
    return this.agentCatalog.setSidebarVisibility(kind, visible)
  }

  markRuntimeCredential(kind, credentialState) {
    return this.agentCatalog.markRuntimeCredential(kind, credentialState)
  }

  clearRuntimeCredentialFailures() {
    return this.agentCatalog.clearRuntimeCredentialFailures()
  }

  createGroup(input) {
    return this.conversations.createGroup(input)
  }

  updateGroup(groupId, input) {
    return this.conversations.updateGroup(groupId, input)
  }

  deleteGroup(groupId) {
    return this.conversations.deleteGroup(groupId)
  }

  deleteMessage(groupId, messageId) {
    return this.conversations.deleteMessage(groupId, messageId)
  }

  getGroup(groupId) {
    return this.conversations.getGroup(groupId)
  }

  addMessage(
    groupId, role, content, agentKind = '', threadRootId = '', system = null, metadata = {},
  ) {
    return this.conversations.addMessage(
      groupId, role, content, agentKind, threadRootId, system, metadata,
    )
  }

  sessionKey(groupId, kind, taskId = '') {
    return sessionKey(groupId, kind, taskId)
  }

  clearSessionState(groupId) {
    clearSessionState(this.state, groupId)
  }

  openClawSessionRef(group, generation = '', taskId = '') {
    return openClawSessionRef(group, generation, taskId)
  }

  sessionState(group, kind, threadRootId = '', taskId = '') {
    const previousSessions = { ...this.state.sessions }
    const previousSessionMeta = { ...this.state.sessionMeta }
    try {
      return resolveSessionState({
        state: this.state,
        group,
        kind,
        threadRootId,
        taskId,
        save: () => this.save(),
      })
    } catch (error) {
      this.state.sessions = previousSessions
      this.state.sessionMeta = previousSessionMeta
      throw error
    }
  }

  sessionRef(group, kind, threadRootId = '', taskId = '') {
    return this.sessionState(group, kind, threadRootId, taskId).sessionRef
  }

  persistSessionState(key, sessionRef, meta) {
    const nextRef = normalizeSessionRef(sessionRef)
    if (!SESSION_KEY.test(String(key || '')) || !nextRef) return false
    const hadSession = Object.hasOwn(this.state.sessions, key)
    const hadMeta = Object.hasOwn(this.state.sessionMeta, key)
    const previousSession = this.state.sessions[key]
    const previousMeta = this.state.sessionMeta[key]
    this.state.sessions[key] = nextRef
    this.state.sessionMeta[key] = normalizeSessionMeta(meta)
    try {
      this.save()
    } catch (error) {
      if (hadSession) this.state.sessions[key] = previousSession
      else delete this.state.sessions[key]
      if (hadMeta) this.state.sessionMeta[key] = previousMeta
      else delete this.state.sessionMeta[key]
      throw error
    }
    return true
  }

  persistSessionRef(key, sessionRef) {
    const next = normalizeSessionRef(sessionRef)
    if (!SESSION_KEY.test(String(key || '')) || !next || next === this.state.sessions[key]) return false
    this.state.sessions[key] = next
    this.save()
    return true
  }

  persistSessionMeta(key, meta) {
    const next = normalizeSessionMeta(meta)
    if (!this.state.sessionMeta || typeof this.state.sessionMeta !== 'object') {
      this.state.sessionMeta = {}
    }
    this.state.sessionMeta[key] = next
    this.save()
    return next
  }

  createContextPack(input) {
    return this.contextPacks.basePack(input)
  }

  createAttemptContextPack(input) {
    return this.contextPacks.attemptPack(input)
  }

  recordContextDelivery(input) {
    return this.contextPacks.delivery(input)
  }

  recordAgentOutcomes(input = {}) {
    const controller = this.activeRuns.get(String(input.groupId || ''))
    const runId = String(input.runId || '')
    const agentRunId = String(input.agentRunId || '')
    const agentKind = String(input.agentKind || '')
    const round = Number(input.round)
    const harnessRun = controller?.harness?.current(agentKind, round, agentRunId)
    if (!controller || controller.runId !== runId || !harnessRun
        || harnessRun.agentRunId !== agentRunId || harnessRun.kind !== agentKind) return {}

    const conclusion = String(input.conclusion || '').trim()
    const descriptors = Array.isArray(input.descriptors) ? input.descriptors : []
    const candidates = [
      ...(conclusion ? [{
        type: 'document',
        name: `${agentKind}-conclusion.txt`,
        content: Buffer.from(conclusion, 'utf8'),
        mediaType: 'text/plain',
      }] : []),
      ...descriptors,
    ].slice(0, MAX_AGENT_OUTCOME_ARTIFACTS)
    const refs = { artifactIds: [], evidenceIds: [] }
    const producedBy = { runId, agentRunId, agentKind }

    for (const descriptor of candidates) {
      if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) continue
      try {
        const artifactInput = {
          type: descriptor.type,
          name: descriptor.name,
          producedBy,
        }
        if (Buffer.isBuffer(descriptor.content) || descriptor.content instanceof Uint8Array) {
          const mediaType = String(descriptor.mediaType || '')
          const contentRef = this.contentBlobStore.put(
            descriptor.content,
            mediaType ? { mediaType } : undefined,
          )
          if (descriptor.contentHash && descriptor.contentHash !== contentRef.hash) continue
          artifactInput.contentRef = contentRef
          artifactInput.contentHash = contentRef.hash
        } else if (descriptor.contentHash) {
          artifactInput.contentHash = descriptor.contentHash
        }
        if (descriptor.locationRef) artifactInput.locationRef = descriptor.locationRef

        const artifact = this.outcomeStore.putArtifact(artifactInput)
        const evidenceRefs = [{ type: 'artifact', artifactId: artifact.artifactId }]
        if (artifact.contentRef) {
          evidenceRefs.push({
            type: 'blob',
            contentRef: artifact.contentRef,
            contentHash: artifact.contentHash,
          })
        } else if (artifact.locationRef) {
          evidenceRefs.push({
            type: 'location',
            locationRef: artifact.locationRef,
            ...(artifact.contentHash ? { contentHash: artifact.contentHash } : {}),
          })
        }
        const evidence = this.outcomeStore.putEvidence({
          kind: 'observation',
          level: 'observed',
          subject: { type: 'artifact', artifactId: artifact.artifactId },
          summary: 'Meldwork captured the concrete Agent output.',
          recordedBy: OUTCOME_RECORDER,
          refs: evidenceRefs,
        })
        refs.artifactIds.push(artifact.artifactId)
        refs.evidenceIds.push(evidence.evidenceId)
      } catch { /* invalid or unavailable outcome capture must not discard the Agent reply */ }
    }
    return normalizeOutcomeRefs(refs)
  }

  promptMessageText(message, limit = 20000) {
    return promptMessageText(message, limit)
  }

  stableUserInstructions(groupId, threadRootId = '', contextOptions = {}) {
    return stableUserInstructions(this.state, groupId, threadRootId, contextOptions)
  }

  stableUserMessages(groupId, threadRootId = '', contextOptions = {}) {
    return stableUserMessages(this.state, groupId, threadRootId, contextOptions)
  }

  recentTranscriptEntries(groupId, afterAgentKind = '', contextOptions = {}) {
    return recentTranscriptEntries(this.state, groupId, afterAgentKind, contextOptions)
  }

  recentTranscript(groupId, afterAgentKind = '') {
    return this.packedPromptContext(groupId, afterAgentKind).recentText
  }

  packedPromptContext(groupId, afterAgentKind = '', threadRootId = '', contextOptions = {}) {
    return packedPromptContext({
      state: this.state,
      groupId,
      afterAgentKind,
      threadRootId,
      agentLabel: kind => this.agentLabel(kind),
      ...contextOptions,
    })
  }

  promptFor(
    group, kind, mode, threadRootId = '', skillHints = [], knowledgeBaseHints = [],
    transcriptAfterKind = '', contextPackage = null, promptMode = 'bootstrap',
  ) {
    const packed = contextPackage || this.packedPromptContext(group.id, transcriptAfterKind, threadRootId)
    return promptFor({
      group,
      kind,
      mode,
      skillHints,
      knowledgeBaseHints,
      packed,
      agentLabel: agentKind => this.agentLabel(agentKind),
      promptMode,
    })
  }

  ensureRunHarness(group, controller, threadRootId = '') {
    return this.runCoordinator.ensureHarness(group, controller, threadRootId)
  }

  emitRunEvent(event) {
    return this.runCoordinator.emitRunEvent(event)
  }

  clearAgentSilence(controller, kind, round, agentRunId = '') {
    return this.runCoordinator.clearAgentSilence(controller, kind, round, agentRunId)
  }

  armAgentSilence(controller, kind, round, agentRunId = '') {
    return this.runCoordinator.armAgentSilence(controller, kind, round, agentRunId)
  }

  clearRunSilence(controller) {
    return this.runCoordinator.clearRunSilence(controller)
  }

  async invokeAgent(group, kind, mode, signal, threadRootId = '', context = {}) {
    return this.agentInvocation.invoke(group, kind, mode, signal, threadRootId, context)
  }

  resetAgentSession(group, kind, rotateOpenClaw = true, taskId = '') {
    return this.agentInvocation.resetSession(group, kind, rotateOpenClaw, taskId)
  }

  async resolveAttachments(attachmentRefs) {
    return this.messageSubmission.resolveAttachments(attachmentRefs)
  }

  validateAttachmentSupport(targetKinds, attachments) {
    return this.messageSubmission.validateAttachmentSupport(targetKinds, attachments)
  }

  async preflightMessage(targetKinds, input, reservation) {
    return this.messageSubmission.preflight(targetKinds, input, reservation)
  }

  startAutoRunner(
    group, targetKinds, threadRootId, maxRounds, reservation = null, preparedContext = null,
    unlimitedRounds = false,
  ) {
    return this.autoRunner.start(
      group, targetKinds, threadRootId, maxRounds, reservation, preparedContext, unlimitedRounds,
    )
  }

  async sendMessage(input) {
    if (input?.workflow) throw new Error('LOCAL_WORKFLOW_UNSUPPORTED')
    return this.messageSubmission.send(input)
  }

  startAuto(input) {
    return this.messageSubmission.startAuto(input)
  }

  stop(groupId, runId) {
    return this.runCoordinator.stop(groupId, runId)
  }

  controlAgent(groupId, runId, kind, action, replacementKind = '') {
    const group = this.getGroup(groupId)
    if (!group.agentKinds.includes(kind)) return false
    if (action === 'replace') {
      const controller = this.activeRuns.get(groupId)
      const replacement = this.detectedAgents.find(agent => (
        agent.kind === replacementKind && agent.available && group.agentKinds.includes(agent.kind)
          && controller?.targetKinds?.includes(agent.kind)
      ))
      if (!replacement) return false
    }
    return this.runCoordinator.controlAgent(
      groupId, runId, kind, action, replacementKind,
    )
  }

  async stopAll() {
    return this.runCoordinator.stopAll()
  }
}

module.exports = { LocalWorkspace }
