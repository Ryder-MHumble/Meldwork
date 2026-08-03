const {
  cleanText,
  normalizeKnowledgeBaseHint,
} = require('./local-workspace-inputs.cjs')

class LocalWorkspaceAutoRunner {
  constructor(options) {
    this.state = options.state
    this.autoRunTimeoutMs = options.autoRunTimeoutMs
    this.beginRun = options.beginRun
    this.resolveAttachments = options.resolveAttachments
    this.validateSkillSelections = options.validateSkillSelections
    this.validateKnowledgeBaseSelections = options.validateKnowledgeBaseSelections
    this.invokeAgent = options.invokeAgent
    this.recordAgentFailure = options.recordAgentFailure
    this.recordAgentInterruption = options.recordAgentInterruption
    this.addMessage = options.addMessage
    this.emitChanged = options.emitChanged
    this.finishRun = options.finishRun
  }

  start(
    group, targetKinds, threadRootId, maxRounds, reservation = null, preparedContext = null,
    unlimitedRounds = false,
  ) {
    const controller = this.beginRun(
      group.id, 'auto', targetKinds, threadRootId, reservation, maxRounds, unlimitedRounds,
    )
    const timeout = setTimeout(() => {
      if (controller.signal.aborted) return
      controller.stopReason = 'timeout'
      controller.abort()
    }, this.autoRunTimeoutMs)
    const promise = (async () => {
      let runStatus = 'failed'
      let totalSuccesses = 0
      try {
        let rootAttachments = preparedContext?.attachments
        let rootSkillsByKind = preparedContext?.skillHintsByKind
        let rootKnowledgeBasesByKind = preparedContext?.knowledgeBaseHintsByKind
        if (!rootAttachments || !rootSkillsByKind || !rootKnowledgeBasesByKind) {
          const rootMessage = this.state().messages.find(message => (
            message.id === threadRootId && message.groupId === group.id && message.role === 'user'
          ))
          rootAttachments = await this.resolveAttachments(rootMessage?.attachments || [])
          rootSkillsByKind = new Map()
          for (const kind of controller.targetKinds) {
            const scoped = (rootMessage?.skillHints || []).filter(skill => skill.targetKind === kind)
            if (!scoped.length) {
              rootSkillsByKind.set(kind, [])
              continue
            }
            try {
              const validated = await this.validateSkillSelections(kind, scoped)
              rootSkillsByKind.set(
                kind,
                Array.isArray(validated) && validated.every(skill => skill?.targetKind === kind)
                  ? validated
                  : [],
              )
            } catch {
              rootSkillsByKind.set(kind, [])
            }
          }
          let storedKnowledgeBaseHints = []
          try {
            const validated = await this.validateKnowledgeBaseSelections(
              controller.targetKinds,
              rootMessage?.knowledgeBaseHints || [],
            )
            storedKnowledgeBaseHints = (Array.isArray(validated) ? validated : [])
              .map(normalizeKnowledgeBaseHint)
              .filter(Boolean)
          } catch { /* unavailable knowledge bases are omitted when resuming */ }
          rootKnowledgeBasesByKind = new Map(controller.targetKinds.map(kind => [
            kind,
            storedKnowledgeBaseHints.filter(source => source.targetKinds.includes(kind)),
          ]))
        }
        const attachmentRecipients = new Set()
        let consensusReached = false
        const reportedFailures = new Set()
        for (
          let round = 0;
          (controller.unlimitedRounds || round < maxRounds) && !controller.signal.aborted;
          round += 1
        ) {
          let agreements = 0
          let successes = 0
          controller.currentRound = round + 1
          controller.completedKinds = []
          controller.failedKinds = []
          this.emitChanged()
          for (const kind of controller.targetKinds) {
            if (controller.signal.aborted) break
            controller.currentKind = kind
            controller.progress = []
            this.emitChanged()
            try {
              const attachments = attachmentRecipients.has(kind)
                ? []
                : rootAttachments.map(attachment => attachment.path)
              const result = await this.invokeAgent(
                group, kind, 'auto', controller.signal, threadRootId, {
                  attachments,
                  skillHints: rootSkillsByKind.get(kind) || [],
                  knowledgeBaseHints: rootKnowledgeBasesByKind.get(kind) || [],
                },
              )
              if (attachments.length) attachmentRecipients.add(kind)
              successes += 1
              if (result.consensus) agreements += 1
            } catch (error) {
              if (controller.signal.aborted) {
                if (controller.stopReason === 'timeout' && error?.runTrace) {
                  this.recordAgentFailure(
                    group.id, kind, error, threadRootId, reportedFailures,
                  )
                  controller.failedKinds.push(kind)
                  controller.completedKinds.push(kind)
                  controller.currentKind = ''
                  controller.progress = []
                  this.emitChanged()
                } else if (error?.runTrace) {
                  this.recordAgentInterruption(
                    group.id,
                    kind,
                    error,
                    threadRootId,
                    controller.stopReason === 'shutdown' ? 'interrupted' : 'stopped',
                    reportedFailures,
                  )
                  controller.completedKinds.push(kind)
                  controller.currentKind = ''
                  controller.progress = []
                  this.emitChanged()
                }
                break
              }
              this.recordAgentFailure(
                group.id, kind, error, threadRootId, reportedFailures,
              )
              controller.failedKinds.push(kind)
            }
            controller.completedKinds.push(kind)
            controller.currentKind = ''
            controller.progress = []
            this.emitChanged()
          }
          totalSuccesses += successes
          if (controller.signal.aborted) break
          if (successes === controller.targetKinds.length
              && agreements === controller.targetKinds.length) {
            consensusReached = true
            break
          }
        }
        if (controller.stopReason === 'timeout') runStatus = 'timeout'
        else if (controller.signal.aborted) {
          runStatus = controller.stopReason === 'shutdown' ? 'interrupted' : 'stopped'
        } else if (consensusReached) runStatus = 'completed'
        else runStatus = totalSuccesses > 0 ? 'round-limit' : 'failed'
        if (runStatus === 'timeout') {
          this.addMessage(
            group.id,
            'system',
            'Automatic discussion reached its runtime limit without consensus.',
            '',
            threadRootId,
            { key: 'system.autoTimeout', params: {} },
          )
        } else if (!controller.unlimitedRounds && (runStatus === 'round-limit' || runStatus === 'failed')) {
          this.addMessage(
            group.id,
            'system',
            `Automatic discussion reached the ${maxRounds}-round safety limit without consensus.`,
            '',
            threadRootId,
            { key: 'system.autoRoundLimit', params: { rounds: maxRounds } },
          )
        }
      } catch (error) {
        runStatus = controller.signal.aborted
          ? (controller.stopReason === 'timeout'
              ? 'timeout'
              : (controller.stopReason === 'shutdown' ? 'interrupted' : 'stopped'))
          : 'failed'
        if (!controller.signal.aborted) {
          const rawReason = cleanText(error?.message || error, 2000)
          const reason = /^[A-Z][A-Z0-9_]+$/.test(rawReason)
            ? rawReason
            : 'LOCAL_AGENT_UNKNOWN_FAILURE'
          try {
            this.addMessage(
              group.id,
              'system',
              `Automatic discussion stopped: ${reason}`,
              '',
              threadRootId,
              { key: 'system.autoStopped', params: { reason } },
            )
          } catch { /* persistence failures cannot be reported through the same store */ }
        }
      } finally {
        clearTimeout(timeout)
        controller.currentKind = ''
        controller.progress = []
        if (controller.stopReason === 'timeout') runStatus = 'timeout'
        else if (controller.signal.aborted) {
          runStatus = controller.stopReason === 'shutdown' ? 'interrupted' : 'stopped'
        }
        this.finishRun(group.id, controller, runStatus)
      }
    })()
    controller.promise = promise
    return controller
  }
}

module.exports = { LocalWorkspaceAutoRunner }
