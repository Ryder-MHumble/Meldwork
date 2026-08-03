const { EventEmitter } = require('node:events')
const { randomUUID } = require('node:crypto')
const { normalizeSessionMeta } = require('./run-harness.cjs')
const { LocalWorkspaceRunLedger } = require('./local-workspace-ledger.cjs')
const { LocalWorkspaceAgentCatalog } = require('./local-workspace-agent-catalog.cjs')
const { LocalWorkspaceAgentInvocation } = require('./local-workspace-agent-invocation.cjs')
const { LocalWorkspaceAutoRunner } = require('./local-workspace-auto-runner.cjs')
const { LocalWorkspaceConversations } = require('./local-workspace-conversations.cjs')
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
  resolveSessionRef,
  sessionKey,
  stableUserInstructions,
  stableUserMessages,
} = require('./local-workspace-context.cjs')
const {
  DEFAULT_AUTO_RUN_TIMEOUT_MS,
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


class LocalWorkspace extends EventEmitter {
  constructor(options) {
    super()
    this.storagePath = options.storagePath
    this.detectAgentsFn = options.detectAgents
    this.runAgentFn = options.runAgent
    this.resolveAttachmentsFn = options.resolveAttachments || (async (attachments) => {
      if (attachments?.length) throw new Error('LOCAL_ATTACHMENT_STORAGE_UNAVAILABLE')
      return []
    })
    this.captureAgentOutputsFn = options.captureAgentOutputs || (async () => null)
    this.importAgentOutputsFn = options.importAgentOutputs || (async () => [])
    this.validateSkillSelectionsFn = options.validateSkillSelections || ((_kind, selections) => selections)
    this.validateKnowledgeBaseSelectionsFn = options.validateKnowledgeBaseSelections || ((_kinds, selections) => selections)
    this.imageAttachmentLimitFn = options.imageAttachmentLimit || (() => 0)
    this.attachmentSupportFn = options.attachmentSupport || (kind => ({
      image: this.imageAttachmentLimitFn(kind),
    }))
    this.credentialStateFn = options.credentialState || (async () => ({ state: 'unknown', source: 'unverified' }))
    this.sharedProviderReadyFn = options.sharedProviderReady || (() => false)
    this.agentLabelFn = options.agentLabel || defaultAgentLabel
    this.autoRunTimeoutMs = Number.isFinite(options.autoRunTimeoutMs)
      && options.autoRunTimeoutMs > 0
      ? options.autoRunTimeoutMs
      : DEFAULT_AUTO_RUN_TIMEOUT_MS
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
    this.now = options.now || (() => new Date().toISOString())
    this.createId = options.createId || randomUUID
    this.createRunId = options.createRunId || randomUUID
    this.runLedger = options.runLedger || null
    this.detectedAgents = []
    this.preparingRuns = new Map()
    this.activeRuns = new Map()
    this.runCheckpointTimers = new Map()
    this.shuttingDown = false
    this.state = this.load()
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
      finishRunCheckpoint: (...args) => this.finishRunCheckpoint(...args),
      scheduleRunCheckpoint: (...args) => this.scheduleRunCheckpoint(...args),
      emitChanged: () => this.emitChanged(),
      emit: (...args) => this.emit(...args),
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
      runAgent: (...args) => this.runAgentFn(...args),
      importAgentOutputs: (...args) => this.importAgentOutputsFn(...args),
      sessionKey: (...args) => this.sessionKey(...args),
      sessionRef: (...args) => this.sessionRef(...args),
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
      persistSessionRef: (...args) => this.persistSessionRef(...args),
      persistSessionMeta: (...args) => this.persistSessionMeta(...args),
      markRuntimeCredential: (...args) => this.markRuntimeCredential(...args),
      addMessage: (...args) => this.addMessage(...args),
    })
    this.autoRunner = new LocalWorkspaceAutoRunner({
      state: () => this.state,
      autoRunTimeoutMs: this.autoRunTimeoutMs,
      beginRun: (...args) => this.beginRun(...args),
      resolveAttachments: (...args) => this.resolveAttachments(...args),
      validateSkillSelections: (...args) => this.validateSkillSelectionsFn(...args),
      validateKnowledgeBaseSelections: (...args) => this.validateKnowledgeBaseSelectionsFn(...args),
      invokeAgent: (...args) => this.invokeAgent(...args),
      recordAgentFailure: (...args) => this.recordAgentFailure(...args),
      recordAgentInterruption: (...args) => this.recordAgentInterruption(...args),
      addMessage: (...args) => this.addMessage(...args),
      emitChanged: () => this.emitChanged(),
      finishRun: (...args) => this.finishRun(...args),
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
      releasePreparation: (...args) => this.releasePreparation(...args),
      addMessage: (...args) => this.addMessage(...args),
      rollbackAddedMessage: (...args) => this.conversations.rollbackAddedMessage(...args),
      startAutoRunner: (...args) => this.startAutoRunner(...args),
      beginRun: (...args) => this.beginRun(...args),
      invokeAgent: (...args) => this.invokeAgent(...args),
      recordAgentInterruption: (...args) => this.recordAgentInterruption(...args),
      recordAgentFailure: (...args) => this.recordAgentFailure(...args),
      emitChanged: () => this.emitChanged(),
      snapshot: () => this.snapshot(),
      finishRun: (...args) => this.finishRun(...args),
    })
    this.restoreInterruptedRuns()
  }

  agentLabel(kind) {
    return cleanInline(this.agentLabelFn(kind), 60) || defaultAgentLabel(kind)
  }

  load() {
    return loadWorkspaceState(this.storagePath)
  }

  save() {
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
    return this.runCoordinator.isGroupBusy(groupId)
  }

  reserveRun(
    groupId, mode, targetKinds, threadRootId = '', maxRounds = 0, unlimitedRounds = false,
  ) {
    return this.runCoordinator.reserve(
      groupId, mode, targetKinds, threadRootId, maxRounds, unlimitedRounds,
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

  sessionKey(groupId, kind) {
    return sessionKey(groupId, kind)
  }

  clearSessionState(groupId) {
    clearSessionState(this.state, groupId)
  }

  openClawSessionRef(group, generation = '') {
    return openClawSessionRef(group, generation)
  }

  sessionRef(group, kind, threadRootId = '') {
    return resolveSessionRef({
      state: this.state,
      group,
      kind,
      threadRootId,
      save: () => this.save(),
    })
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

  promptMessageText(message, limit = 20000) {
    return promptMessageText(message, limit)
  }

  stableUserInstructions(groupId, threadRootId = '') {
    return stableUserInstructions(this.state, groupId, threadRootId)
  }

  stableUserMessages(groupId, threadRootId = '') {
    return stableUserMessages(this.state, groupId, threadRootId)
  }

  recentTranscriptEntries(groupId, afterAgentKind = '') {
    return recentTranscriptEntries(this.state, groupId, afterAgentKind)
  }

  recentTranscript(groupId, afterAgentKind = '') {
    return this.packedPromptContext(groupId, afterAgentKind).recentText
  }

  packedPromptContext(groupId, afterAgentKind = '', threadRootId = '') {
    return packedPromptContext({
      state: this.state,
      groupId,
      afterAgentKind,
      threadRootId,
      agentLabel: kind => this.agentLabel(kind),
    })
  }

  promptFor(
    group, kind, mode, threadRootId = '', skillHints = [], knowledgeBaseHints = [],
    transcriptAfterKind = '', contextPackage = null,
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
    return this.messageSubmission.send(input)
  }

  startAuto(input) {
    return this.messageSubmission.startAuto(input)
  }

  stop(groupId, runId) {
    return this.runCoordinator.stop(groupId, runId)
  }

  async stopAll() {
    return this.runCoordinator.stopAll()
  }
}

module.exports = { LocalWorkspace }
