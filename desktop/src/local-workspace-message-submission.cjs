const path = require('node:path')
const {
  KNOWLEDGE_BASE_KINDS,
  MAX_KNOWLEDGE_BASE_HINTS,
  MAX_MESSAGE_ATTACHMENTS,
  MAX_SKILL_HINTS,
  USER_ATTACHMENT_MIME_TYPES,
  attachmentLimitError,
  attachmentType,
  cleanInline,
  cleanText,
  normalizeAttachmentMetadata,
  normalizeAutoRounds,
  normalizeKnowledgeBaseHint,
  normalizeTargetKinds,
} = require('./local-workspace-inputs.cjs')

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
    this.releasePreparation = options.releasePreparation
    this.addMessage = options.addMessage
    this.rollbackAddedMessage = options.rollbackAddedMessage
    this.startAutoRunner = options.startAutoRunner
    this.beginRun = options.beginRun
    this.invokeAgent = options.invokeAgent
    this.recordAgentInterruption = options.recordAgentInterruption
    this.recordAgentFailure = options.recordAgentFailure
    this.emitChanged = options.emitChanged
    this.snapshot = options.snapshot
    this.finishRun = options.finishRun
  }

  async resolveAttachments(attachmentRefs) {
    if (!Array.isArray(attachmentRefs)) throw new Error('LOCAL_ATTACHMENT_REFERENCE_INVALID')
    if (attachmentRefs.length > MAX_MESSAGE_ATTACHMENTS) {
      throw new Error('LOCAL_ATTACHMENT_COUNT_LIMIT')
    }
    const resolved = attachmentRefs.length
      ? await this.resolveAttachmentsFn(attachmentRefs)
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
        const limit = Math.max(0, Math.min(
          MAX_MESSAGE_ATTACHMENTS,
          Math.floor(Number(support[type]) || 0),
        ))
        if (!limit) throw new Error(attachmentLimitError(type))
        if (count > limit) throw new Error(attachmentLimitError(type, true))
      }
    }
  }

  async preflight(targetKinds, input, reservation) {
    const text = cleanText(input.text)
    const attachments = await this.resolveAttachments(input.attachments || [])
    if (reservation.signal.aborted || this.isShuttingDown()) {
      throw new Error('LOCAL_AGENT_EXECUTION_STOPPED')
    }
    if (!text && !attachments.length) throw new Error('LOCAL_MESSAGE_REQUIRED')
    this.validateAttachmentSupport(targetKinds, attachments)

    const requestedSkillHints = input.skillHints || []
    const skillHintsByKind = new Map()
    for (const kind of targetKinds) {
      const scoped = requestedSkillHints.filter(skill => skill?.targetKind === kind)
      const validated = await this.validateSkillSelections(kind, scoped)
      if (reservation.signal.aborted || this.isShuttingDown()) {
        throw new Error('LOCAL_AGENT_EXECUTION_STOPPED')
      }
      if (!Array.isArray(validated) || validated.some(skill => skill?.targetKind !== kind)) {
        throw new Error('LOCAL_SKILL_SELECTION_INVALID')
      }
      skillHintsByKind.set(kind, validated)
    }
    const requestedKnowledgeBaseHints = input.knowledgeBaseHints || []
    const validatedKnowledgeBaseHints = await this.validateKnowledgeBaseSelections(
      targetKinds,
      requestedKnowledgeBaseHints,
    )
    if (reservation.signal.aborted || this.isShuttingDown()) {
      throw new Error('LOCAL_AGENT_EXECUTION_STOPPED')
    }
    const knowledgeBaseHints = (Array.isArray(validatedKnowledgeBaseHints)
      ? validatedKnowledgeBaseHints
      : []).map(normalizeKnowledgeBaseHint).filter(Boolean)
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
      attachments,
      skillHintsByKind,
      skillHints: targetKinds.flatMap(kind => skillHintsByKind.get(kind) || []),
      knowledgeBaseHintsByKind,
      knowledgeBaseHints,
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
    return { mode, targetKinds, unlimitedRounds, maxRounds, requestedThreadRootId }
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
    } = this.validateInput(group, input)
    const reservation = this.reserveRun(
      group.id, mode, targetKinds, '', maxRounds, unlimitedRounds,
    )
    const promise = (async () => {
      let controller = null
      let autoStarted = false
      let successCount = 0
      let runStatus = 'failed'
      try {
        const prepared = await this.preflight(targetKinds, input, reservation)
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
              knowledgeBaseHints: prepared.knowledgeBaseHints,
              targetKinds,
            },
          )
          try {
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

        controller = this.beginRun(group.id, 'manual', targetKinds, '', reservation)
        if (controller.signal.aborted) throw new Error('LOCAL_AGENT_EXECUTION_STOPPED')
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
            knowledgeBaseHints: prepared.knowledgeBaseHints,
            targetKinds: group.conversationType === 'direct' ? [] : targetKinds,
          },
        )
        const threadRootId = group.conversationType === 'direct' ? '' : userMessage.id
        controller.threadRootId = threadRootId
        for (const kind of targetKinds) {
          if (controller.signal.aborted) break
          controller.currentKind = kind
          controller.progress = []
          this.emitChanged()
          try {
            await this.invokeAgent(group, kind, 'manual', controller.signal, threadRootId, {
              skillHints: prepared.skillHintsByKind.get(kind) || [],
              knowledgeBaseHints: prepared.knowledgeBaseHintsByKind.get(kind) || [],
              attachments: prepared.attachments.map(attachment => attachment.path),
              sessionThreadRootId: requestedThreadRootId || threadRootId,
            })
            successCount += 1
          } catch (error) {
            if (controller.signal.aborted) {
              this.recordAgentInterruption(
                group.id,
                kind,
                error,
                threadRootId,
                controller.stopReason === 'shutdown' ? 'interrupted' : 'stopped',
              )
              controller.completedKinds.push(kind)
              break
            }
            this.recordAgentFailure(group.id, kind, error, threadRootId)
            controller.failedKinds.push(kind)
            if (error?.message === 'LOCAL_AGENT_TIMEOUT') runStatus = 'timeout'
          }
          controller.completedKinds.push(kind)
          controller.currentKind = ''
          controller.progress = []
          this.emitChanged()
        }
        if (controller.signal.aborted) {
          runStatus = controller.stopReason === 'shutdown' ? 'interrupted' : 'stopped'
          return this.snapshot()
        }
        if (!successCount) return this.snapshot()
        runStatus = successCount === targetKinds.length ? 'completed' : 'partial'
        return this.snapshot()
      } finally {
        if (mode === 'auto') {
          if (!autoStarted) this.releasePreparation(group.id, reservation)
        } else if (controller) {
          controller.currentKind = ''
          controller.progress = []
          if (controller.signal.aborted) {
            runStatus = controller.stopReason === 'shutdown' ? 'interrupted' : 'stopped'
          } else if (runStatus === 'failed' && successCount > 0) runStatus = 'partial'
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
    this.startAutoRunner(group, targetKinds, threadRootId, maxRounds, null, null, unlimitedRounds)
    return { started: true, maxRounds, ...(unlimitedRounds ? { unlimitedRounds: true } : {}) }
  }
}

module.exports = { LocalWorkspaceMessageSubmission }
