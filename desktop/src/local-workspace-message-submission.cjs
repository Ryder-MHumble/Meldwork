const path = require('node:path')
const {
  KNOWLEDGE_BASE_KINDS,
  MAX_KNOWLEDGE_BASE_HINTS,
  MAX_MESSAGE_ATTACHMENTS,
  MAX_SKILL_HINTS,
  USER_ATTACHMENT_MIME_TYPES,
  abortableOperation,
  attachmentLimitError,
  attachmentType,
  cleanInline,
  cleanText,
  normalizeAttachmentMetadata,
  normalizeAutoRounds,
  normalizeKnowledgeBaseHint,
  normalizeSkillHint,
  normalizeTargetKinds,
} = require('./local-workspace-inputs.cjs')
const { mediaGenerationRequest } = require('./media-generation-request.cjs')

class LocalWorkspaceMessageSubmission {
  constructor(options) {
    this.state = options.state
    this.detectedAgents = options.detectedAgents
    this.isShuttingDown = options.isShuttingDown
    this.resolveAttachmentsFn = options.resolveAttachments
    this.attachmentSupport = options.attachmentSupport
    this.validateSkillSelections = options.validateSkillSelections
    this.validateKnowledgeBaseSelections = options.validateKnowledgeBaseSelections
    this.getGroup = options.getGroup
    this.isGroupBusy = options.isGroupBusy
    this.reserveRun = options.reserveRun
    this.bindRunTask = options.bindRunTask
    this.releasePreparation = options.releasePreparation
    this.addMessage = options.addMessage
    this.rollbackAddedMessage = options.rollbackAddedMessage
    this.startAutoRunner = options.startAutoRunner
    this.beginRun = options.beginRun
    this.invokeAgent = options.invokeAgent
    this.invokeWithRecovery = options.invokeWithRecovery
    this.recordAgentInterruption = options.recordAgentInterruption
    this.recordAgentFailure = options.recordAgentFailure
    this.emitChanged = options.emitChanged
    this.snapshot = options.snapshot
    this.finishRun = options.finishRun
    this.createContextPack = options.createContextPack
    this.configureRunBudget = options.configureRunBudget
    this.resetAgentSession = options.resetAgentSession
    this.refreshAgents = options.refreshAgents
    this.consumeAgentControl = options.consumeAgentControl
    this.checkpointRun = options.checkpointRun
    this.hasRunLedger = options.hasRunLedger || (() => false)
  }

  async resolveAttachments(attachmentRefs, signal) {
    if (!Array.isArray(attachmentRefs)) throw new Error('LOCAL_ATTACHMENT_REFERENCE_INVALID')
    if (attachmentRefs.length > MAX_MESSAGE_ATTACHMENTS) {
      throw new Error('LOCAL_ATTACHMENT_COUNT_LIMIT')
    }
    const resolved = attachmentRefs.length
      ? await abortableOperation(() => this.resolveAttachmentsFn(attachmentRefs), signal)
      : []
    if (!Array.isArray(resolved) || resolved.length !== attachmentRefs.length) {
      throw new Error('LOCAL_ATTACHMENT_REFERENCE_INVALID')
    }
    return resolved.map((attachment) => {
      const metadata = normalizeAttachmentMetadata(attachment)
      if (!metadata || typeof attachment.path !== 'string' || !path.isAbsolute(attachment.path)) {
        throw new Error('LOCAL_ATTACHMENT_REFERENCE_INVALID')
      }
      if (!USER_ATTACHMENT_MIME_TYPES.has(metadata.mimeType)) {
        throw new Error('LOCAL_ATTACHMENT_REFERENCE_INVALID')
      }
      return { ...metadata, path: path.normalize(attachment.path) }
    })
  }

  validateAttachmentSupport(targetKinds, attachments) {
    const values = Array.isArray(attachments) ? attachments : []
    for (const kind of targetKinds) {
      const support = this.attachmentSupport(kind) || {}
      const counts = new Map()
      for (const attachment of values) {
        const type = attachmentType(attachment?.mimeType)
        if (!type) throw new Error('LOCAL_ATTACHMENT_REFERENCE_INVALID')
        const count = (counts.get(type) || 0) + 1
        counts.set(type, count)
        const nativeLimit = Math.max(0, Math.min(
          MAX_MESSAGE_ATTACHMENTS,
          Math.floor(Number(support[type]) || 0),
        ))
        const fileFallbackLimit = Math.max(0, Math.min(
          MAX_MESSAGE_ATTACHMENTS,
          Math.floor(Number(support.file) || 0),
        ))
        const limit = Math.max(nativeLimit, fileFallbackLimit)
        if (!limit) throw new Error(attachmentLimitError(type))
        if (count > limit) throw new Error(attachmentLimitError(type, true))
      }
    }
  }

  async preflight(targetKinds, input, reservation) {
    const text = cleanText(input.text)
    const attachments = await this.resolveAttachments(input.attachments || [], reservation.signal)
    if (reservation.signal.aborted || this.isShuttingDown()) {
      throw new Error('LOCAL_AGENT_EXECUTION_STOPPED')
    }
    if (!text && !attachments.length) throw new Error('LOCAL_MESSAGE_REQUIRED')
    this.validateAttachmentSupport(targetKinds, attachments)

    const requestedSkillHints = input.skillHints || []
    const skillHintsByKind = new Map()
    const publicSkillHintsByKind = new Map()
    for (const kind of targetKinds) {
      const scoped = requestedSkillHints.filter(skill => skill?.targetKind === kind)
      const validated = await abortableOperation(
        () => this.validateSkillSelections(kind, scoped),
        reservation.signal,
      )
      if (reservation.signal.aborted || this.isShuttingDown()) {
        throw new Error('LOCAL_AGENT_EXECUTION_STOPPED')
      }
      if (!Array.isArray(validated) || validated.some(skill => skill?.targetKind !== kind)) {
        throw new Error('LOCAL_SKILL_SELECTION_INVALID')
      }
      const publicHints = validated.map(normalizeSkillHint).filter(Boolean)
      if (publicHints.length !== validated.length) {
        throw new Error('LOCAL_SKILL_SELECTION_INVALID')
      }
      skillHintsByKind.set(kind, validated)
      publicSkillHintsByKind.set(kind, publicHints)
    }
    const requestedKnowledgeBaseHints = input.knowledgeBaseHints || []
    const validatedKnowledgeBaseHints = await abortableOperation(
      () => this.validateKnowledgeBaseSelections(targetKinds, requestedKnowledgeBaseHints),
      reservation.signal,
    )
    if (reservation.signal.aborted || this.isShuttingDown()) {
      throw new Error('LOCAL_AGENT_EXECUTION_STOPPED')
    }
    const knowledgeBaseHints = (Array.isArray(validatedKnowledgeBaseHints)
      ? validatedKnowledgeBaseHints
      : []).map((source) => {
      const publicHint = normalizeKnowledgeBaseHint(source)
      if (!publicHint) return null
      return source?.connectorSource
        ? { ...publicHint, connectorSource: source.connectorSource }
        : publicHint
    }).filter(Boolean)
    if (knowledgeBaseHints.length !== requestedKnowledgeBaseHints.length
        || knowledgeBaseHints.some(source => (
          source.targetKinds.some(kind => !targetKinds.includes(kind))
        ))) {
      throw new Error('LOCAL_KNOWLEDGE_BASE_SELECTION_INVALID')
    }
    const knowledgeBaseHintsByKind = new Map(targetKinds.map(kind => [
      kind,
      knowledgeBaseHints.filter(source => source.targetKinds.includes(kind)),
    ]))
    return {
      text,
      mediaRequest: mediaGenerationRequest(text),
      attachments,
      skillHintsByKind,
      skillHints: targetKinds.flatMap(kind => publicSkillHintsByKind.get(kind) || []),
      knowledgeBaseHintsByKind,
      knowledgeBaseHints,
      storedKnowledgeBaseHints: knowledgeBaseHints.filter(source => !source.connectorSource),
    }
  }

  validateInput(group, input) {
    const mode = input.mode === 'auto' && group.conversationType !== 'direct'
      ? 'auto'
      : 'manual'
    if (input.targetKinds != null && !Array.isArray(input.targetKinds)) {
      throw new Error('LOCAL_MESSAGE_TARGET_REQUIRED')
    }
    const requested = Array.isArray(input.targetKinds) && input.targetKinds.length
      ? normalizeTargetKinds(input.targetKinds)
      : group.agentKinds
    const targetKinds = [...new Set(requested.filter(kind => group.agentKinds.includes(kind)))]
    if (!targetKinds.length) throw new Error('LOCAL_MESSAGE_TARGET_REQUIRED')
    if (mode === 'auto' && targetKinds.length < 2) throw new Error('LOCAL_AUTO_AGENT_COUNT')
    if (input.mentionedAgentKinds != null && !Array.isArray(input.mentionedAgentKinds)) {
      throw new Error('LOCAL_MESSAGE_TARGET_REQUIRED')
    }
    const mentionedAgentKinds = normalizeTargetKinds(input.mentionedAgentKinds)
    if (mentionedAgentKinds.some(kind => !targetKinds.includes(kind))) {
      throw new Error('LOCAL_MESSAGE_TARGET_REQUIRED')
    }
    if (mode === 'auto' && targetKinds.some(kind => (
      !this.detectedAgents().some(agent => agent.kind === kind && agent.available)
    ))) {
      throw new Error('LOCAL_AGENT_UNAVAILABLE')
    }
    if (input.skillHints != null && !Array.isArray(input.skillHints)) {
      throw new Error('LOCAL_SKILL_SELECTION_INVALID')
    }
    const requestedSkillHints = input.skillHints || []
    if (requestedSkillHints.length > MAX_SKILL_HINTS) throw new Error('LOCAL_SKILL_LIMIT')
    if (requestedSkillHints.some(skill => !targetKinds.includes(String(skill?.targetKind || '')))) {
      throw new Error('LOCAL_SKILL_SELECTION_INVALID')
    }
    if (input.knowledgeBaseHints != null && !Array.isArray(input.knowledgeBaseHints)) {
      throw new Error('LOCAL_KNOWLEDGE_BASE_SELECTION_INVALID')
    }
    const requestedKnowledgeBaseHints = input.knowledgeBaseHints || []
    if (requestedKnowledgeBaseHints.length > MAX_KNOWLEDGE_BASE_HINTS) {
      throw new Error('LOCAL_KNOWLEDGE_BASE_SELECTION_INVALID')
    }
    const requestedKnowledgeKinds = new Set()
    for (const source of requestedKnowledgeBaseHints) {
      const kind = cleanInline(source?.kind, 40)
      const sourceTargets = normalizeTargetKinds(source?.targetKinds)
      if (!KNOWLEDGE_BASE_KINDS.has(kind) || requestedKnowledgeKinds.has(kind)
          || !sourceTargets.length || sourceTargets.some(target => !targetKinds.includes(target))) {
        throw new Error('LOCAL_KNOWLEDGE_BASE_SELECTION_INVALID')
      }
      requestedKnowledgeKinds.add(kind)
    }
    const unlimitedRounds = mode === 'auto' && input.unlimitedRounds === true
    const maxRounds = mode === 'auto' && !unlimitedRounds
      ? normalizeAutoRounds(input.maxRounds ?? input.maxTurns)
      : 0
    const requestedThreadRootId = mode === 'manual' ? cleanText(input.threadRootId, 100) : ''
    const regenerateMessageId = cleanText(input.regenerateMessageId, 100)
    if (input.regenerateMessageId != null && !regenerateMessageId) {
      throw new Error('LOCAL_MESSAGE_REGENERATION_INVALID')
    }
    if (regenerateMessageId && (mode !== 'manual' || targetKinds.length !== 1)) {
      throw new Error('LOCAL_MESSAGE_REGENERATION_INVALID')
    }
    return {
      mode,
      targetKinds,
      unlimitedRounds,
      maxRounds,
      requestedThreadRootId,
      regenerateMessageId,
    }
  }

  resolveRegeneration(group, messageId, targetKinds) {
    if (!messageId) return null
    const messages = this.state().messages
    const sourceIndex = messages.findIndex(message => (
      message.id === messageId && message.groupId === group.id
    ))
    const sourceMessage = messages[sourceIndex]
    const targetKind = targetKinds[0]
    if (sourceIndex < 0 || sourceMessage?.role !== 'agent'
        || sourceMessage.agentKind !== targetKind) {
      throw new Error('LOCAL_MESSAGE_REGENERATION_INVALID')
    }
    let userMessage = null
    if (sourceMessage.threadRootId) {
      userMessage = messages.find(message => (
        message.id === sourceMessage.threadRootId
        && message.groupId === group.id
        && message.role === 'user'
      ))
    } else if (group.conversationType === 'direct') {
      for (let index = sourceIndex - 1; index >= 0; index -= 1) {
        const message = messages[index]
        if (message.groupId === group.id && message.role === 'user' && !message.threadRootId) {
          userMessage = message
          break
        }
      }
    }
    if (!userMessage) throw new Error('LOCAL_MESSAGE_REGENERATION_INVALID')
    return {
      sourceMessage,
      userMessage,
      responseVersionRootId: cleanText(
        sourceMessage.responseVersionRootId || sourceMessage.id,
        100,
      ),
    }
  }

  regenerationInput(input, regeneration, targetKind) {
    const message = regeneration.userMessage
    return {
      ...input,
      text: message.content,
      attachments: Array.isArray(message.attachments) ? message.attachments : [],
      skillHints: (Array.isArray(message.skillHints) ? message.skillHints : [])
        .filter(skill => skill.targetKind === targetKind),
      knowledgeBaseHints: (Array.isArray(message.knowledgeBaseHints)
        ? message.knowledgeBaseHints
        : []).filter(source => source.targetKinds?.includes(targetKind)).map(source => ({
        ...source,
        targetKinds: [targetKind],
      })),
    }
  }

  regenerationInstruction() {
    return [
      'Produce a fresh alternative response to the user request.',
      'Re-evaluate the task independently and return the best complete answer.',
      'Do not mention response versions, regeneration, or the previous answer.',
    ].join('\n')
  }

  replacementInstruction(failedKind) {
    const agent = this.detectedAgents().find(candidate => candidate.kind === failedKind)
    const label = cleanInline(agent?.name, 60) || failedKind
    return [
      `You are replacing ${label} for this turn.`,
      'Complete the interrupted Agent slot using the shared task context, then return your own conclusion.',
      'Do not claim that the interrupted Agent completed this work.',
    ].join('\n')
  }

  async send(input) {
    const group = this.getGroup(input.groupId)
    if (this.isGroupBusy(group.id)) throw new Error('LOCAL_GROUP_RUNNING')
    const {
      mode,
      targetKinds,
      unlimitedRounds,
      maxRounds,
      requestedThreadRootId,
      regenerateMessageId,
    } = this.validateInput(group, input)
    const regeneration = this.resolveRegeneration(group, regenerateMessageId, targetKinds)
    const reservation = this.reserveRun(
      group.id,
      mode,
      targetKinds,
      regeneration?.userMessage.id || '',
      maxRounds,
      unlimitedRounds,
    )
    try {
      if (regeneration) reservation.responseVersionRootId = regeneration.responseVersionRootId
      this.configureRunBudget(reservation, input.budget || {})
      if (regeneration) this.emitChanged()
    } catch (error) {
      this.releasePreparation(group.id, reservation)
      throw error
    }
    const promise = (async () => {
      let controller = null
      let autoStarted = false
      const successfulKinds = new Set()
      let runStatus = 'failed'
      const reportedFailures = new Set()
      try {
        const prepared = await this.preflight(
          targetKinds,
          regeneration ? this.regenerationInput(input, regeneration, targetKinds[0]) : input,
          reservation,
        )
        if (mode === 'auto') {
          const previousUpdatedAt = group.updatedAt
          const userMessage = this.addMessage(
            group.id,
            'user',
            prepared.text,
            '',
            '',
            null,
            {
              attachments: prepared.attachments.map(({ path: _path, ...metadata }) => metadata),
              skillHints: prepared.skillHints,
              knowledgeBaseHints: prepared.storedKnowledgeBaseHints,
              targetKinds,
            },
          )
          try {
            const contextPack = this.createContextPack({
              group,
              taskId: userMessage.id,
              mode: 'auto',
              targetKinds,
              message: userMessage,
              prepared,
            })
            this.bindRunTask(
              group.id, reservation, userMessage.id, userMessage.id, contextPack.contextPackId,
            )
            controller = this.startAutoRunner(
              group, targetKinds, userMessage.id, maxRounds, reservation, prepared, unlimitedRounds,
            )
          } catch (error) {
            try {
              this.rollbackAddedMessage(group.id, userMessage.id, previousUpdatedAt)
            } catch (rollbackError) {
              if (error && typeof error === 'object') error.rollbackError = rollbackError
            }
            throw error
          }
          autoStarted = true
          return {
            started: true,
            maxRounds,
            threadRootId: userMessage.id,
            ...(unlimitedRounds ? { unlimitedRounds: true } : {}),
          }
        }

        const previousUpdatedAt = group.updatedAt
        const userMessage = regeneration?.userMessage || this.addMessage(
          group.id,
          'user',
          prepared.text,
          '',
          '',
          null,
          {
            attachments: prepared.attachments.map(({ path: _path, ...metadata }) => metadata),
            skillHints: prepared.skillHints,
            knowledgeBaseHints: prepared.storedKnowledgeBaseHints,
            targetKinds: group.conversationType === 'direct' ? [] : targetKinds,
          },
        )
        const threadRootId = regeneration
          ? userMessage.id
          : (group.conversationType === 'direct' ? '' : userMessage.id)
        try {
          const contextPack = this.createContextPack({
            group,
            taskId: userMessage.id,
            mode: group.conversationType === 'direct' ? 'direct' : 'manual',
            targetKinds,
            message: userMessage,
            prepared,
          })
          this.bindRunTask(
            group.id, reservation, userMessage.id, threadRootId, contextPack.contextPackId,
          )
          if (regeneration) {
            this.resetAgentSession(group, targetKinds[0], true, userMessage.id)
          }
          reservation.orchestration = {
            version: 1,
            workflow: 'manual',
            currentKind: '',
            pendingKinds: [...targetKinds],
            activeKinds: [...targetKinds],
            successfulKinds: [],
            agreementKinds: [],
            attachmentRecipients: [],
            totalSuccesses: 0,
            terminalFailureOccurred: false,
          }
          controller = this.beginRun(
            group.id, 'manual', targetKinds, threadRootId, reservation,
          )
        } catch (error) {
          if (!regeneration) {
            try {
              this.rollbackAddedMessage(group.id, userMessage.id, previousUpdatedAt)
            } catch (rollbackError) {
              if (error && typeof error === 'object') error.rollbackError = rollbackError
            }
          }
          throw error
        }
        if (controller.signal.aborted) throw new Error('LOCAL_AGENT_EXECUTION_STOPPED')
        let activeKinds = [...targetKinds]
        const pendingKinds = [...targetKinds]
        const replacementInstructions = new Map()
        const mediaOwnerKind = prepared.mediaRequest ? targetKinds[0] : ''
        while (pendingKinds.length) {
          const kind = pendingKinds.shift()
          if (!activeKinds.includes(kind)) continue
          if (controller.signal.aborted) break
          controller.currentKind = kind
          controller.progress = []
          controller.orchestration = {
            ...controller.orchestration,
            currentKind: kind,
            pendingKinds: [...pendingKinds],
            activeKinds: [...activeKinds],
            successfulKinds: [...successfulKinds],
          }
          if (this.hasRunLedger() && this.checkpointRun(group.id, controller) !== true) {
            throw new Error('LOCAL_RUN_PERSIST_FAILED')
          }
          this.emitChanged()
          try {
            const invocation = await this.invokeWithRecovery({
              group,
              kind,
              controller,
              activeKinds,
              threadRootId,
              context: {
                skillHints: prepared.skillHintsByKind.get(kind) || [],
                knowledgeBaseHints: prepared.knowledgeBaseHintsByKind.get(kind) || [],
                attachments: prepared.attachments.map(attachment => attachment.path),
                attachmentSnapshots: prepared.attachments,
                sessionThreadRootId: requestedThreadRootId || threadRootId,
                runtimeInstruction: replacementInstructions.get(kind) || '',
                mediaRequest: kind === mediaOwnerKind ? prepared.mediaRequest : null,
                responseVersionRootId: regeneration?.responseVersionRootId || '',
                regenerationInstruction: regeneration ? this.regenerationInstruction() : '',
                contextOptions: regeneration
                  ? {
                      beforeMessageId: regeneration.sourceMessage.id,
                      excludeResponseVersionRootId: regeneration.responseVersionRootId,
                      focusUserMessageId: regeneration.userMessage.id,
                    }
                  : { focusUserMessageId: userMessage.id },
              },
              reportedFailures,
            })
            replacementInstructions.delete(kind)
            if (invocation.control?.action === 'replace') {
              this.recordAgentInterruption(
                group.id, kind, invocation.error, threadRootId, 'stopped', reportedFailures,
              )
              if (!controller.failedKinds.includes(kind)) controller.failedKinds.push(kind)
              if (!controller.completedKinds.includes(kind)) controller.completedKinds.push(kind)
              successfulKinds.delete(kind)
              const replacementKind = invocation.control.replacementKind
              activeKinds = activeKinds.filter(activeKind => activeKind !== kind)
              replacementInstructions.set(
                replacementKind,
                this.replacementInstruction(kind),
              )
              if (!pendingKinds.includes(replacementKind)) pendingKinds.unshift(replacementKind)
              controller.currentKind = ''
              controller.progress = []
              this.emitChanged()
              continue
            }
            if (invocation.control?.action === 'cancel') {
              this.recordAgentInterruption(
                group.id, kind, invocation.error, threadRootId, 'stopped', reportedFailures,
              )
              if (!controller.failedKinds.includes(kind)) controller.failedKinds.push(kind)
              if (!controller.completedKinds.includes(kind)) controller.completedKinds.push(kind)
              successfulKinds.delete(kind)
              controller.currentKind = ''
              controller.progress = []
              this.emitChanged()
              continue
            }
            if (!invocation.result) {
              throw invocation.error || new Error('LOCAL_AGENT_UNKNOWN_FAILURE')
            }
            successfulKinds.add(kind)
          } catch (error) {
            if (controller.signal.aborted) {
              this.recordAgentInterruption(
                group.id,
                kind,
                error,
                threadRootId,
                controller.stopReason === 'shutdown' ? 'interrupted' : 'stopped',
              )
              if (!controller.completedKinds.includes(kind)) controller.completedKinds.push(kind)
              break
            }
            this.recordAgentFailure(group.id, kind, error, threadRootId, reportedFailures)
            successfulKinds.delete(kind)
            if (!controller.failedKinds.includes(kind)) controller.failedKinds.push(kind)
            if (error?.message === 'LOCAL_AGENT_TIMEOUT') runStatus = 'timeout'
          }
          if (!controller.completedKinds.includes(kind)) controller.completedKinds.push(kind)
          controller.currentKind = ''
          controller.progress = []
          controller.orchestration = {
            ...controller.orchestration,
            currentKind: '',
            pendingKinds: [...pendingKinds],
            activeKinds: [...activeKinds],
            successfulKinds: [...successfulKinds],
          }
          if (this.hasRunLedger() && this.checkpointRun(group.id, controller) !== true) {
            throw new Error('LOCAL_RUN_PERSIST_FAILED')
          }
          this.emitChanged()
        }
        if (controller.signal.aborted) {
          runStatus = controller.stopReason === 'shutdown' ? 'interrupted' : 'stopped'
          return this.snapshot()
        }
        const successCount = activeKinds.filter(kind => successfulKinds.has(kind)).length
        if (!successCount) return this.snapshot()
        runStatus = successCount === activeKinds.length
          ? 'completed'
          : 'partial'
        return this.snapshot()
      } finally {
        if (mode === 'auto') {
          if (!autoStarted) this.releasePreparation(group.id, reservation)
        } else if (controller) {
          controller.currentKind = ''
          controller.progress = []
          if (controller.signal.aborted) {
            runStatus = controller.stopReason === 'shutdown' ? 'interrupted' : 'stopped'
          } else if (runStatus === 'failed' && successfulKinds.size > 0) runStatus = 'partial'
          this.finishRun(group.id, controller, runStatus)
        } else {
          this.releasePreparation(group.id, reservation)
        }
      }
    })()
    reservation.promise = promise
    return await promise
  }

  startAuto(input) {
    const group = this.getGroup(input.groupId)
    if (this.isGroupBusy(group.id)) throw new Error('LOCAL_GROUP_RUNNING')
    if (input.targetKinds != null && !Array.isArray(input.targetKinds)) {
      throw new Error('LOCAL_MESSAGE_TARGET_REQUIRED')
    }
    const requested = Array.isArray(input.targetKinds) && input.targetKinds.length
      ? normalizeTargetKinds(input.targetKinds)
      : group.agentKinds
    const targetKinds = [...new Set(requested.filter(kind => group.agentKinds.includes(kind)))]
    if (targetKinds.length < 2) throw new Error('LOCAL_AUTO_AGENT_COUNT')
    const unlimitedRounds = input.unlimitedRounds === true
    const maxRounds = unlimitedRounds
      ? 0
      : normalizeAutoRounds(input.maxRounds ?? input.maxTurns)
    const state = this.state()
    const latestRoot = state.messages.findLast(message => (
      message.groupId === group.id && message.role === 'user' && !message.threadRootId
    ))
    const threadRootId = cleanText(input.threadRootId, 100) || latestRoot?.id || ''
    if (!threadRootId) throw new Error('LOCAL_AUTO_THREAD_REQUIRED')
    const rootMessage = state.messages.find(message => (
      message.id === threadRootId && message.groupId === group.id && message.role === 'user'
    ))
    const rootAttachments = (Array.isArray(rootMessage?.attachments) ? rootMessage.attachments : [])
      .map(normalizeAttachmentMetadata)
      .filter(Boolean)
    this.validateAttachmentSupport(targetKinds, rootAttachments)
    const reservation = this.reserveRun(
      group.id, 'auto', targetKinds, threadRootId, maxRounds, unlimitedRounds,
    )
    try {
      this.configureRunBudget(reservation, input.budget || {})
      const contextPack = this.createContextPack({
        group,
        taskId: threadRootId,
        mode: 'auto',
        targetKinds,
        message: rootMessage,
      })
      this.bindRunTask(
        group.id, reservation, threadRootId, threadRootId, contextPack.contextPackId,
      )
      this.startAutoRunner(
        group, targetKinds, threadRootId, maxRounds, reservation, null, unlimitedRounds,
      )
    } catch (error) {
      this.releasePreparation(group.id, reservation)
      throw error
    }
    return { started: true, maxRounds, ...(unlimitedRounds ? { unlimitedRounds: true } : {}) }
  }
}

module.exports = { LocalWorkspaceMessageSubmission }
