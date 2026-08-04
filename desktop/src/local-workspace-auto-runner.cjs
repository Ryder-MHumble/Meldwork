const {
  cleanText,
  normalizeKnowledgeBaseHint,
} = require('./local-workspace-inputs.cjs')

const UNAUTHORIZED_RETRY_COUNT = 3
const POST_RECOVERY_VERIFY_COUNT = 3

function unauthorizedFailure(error) {
  const status = Number(error?.statusCode || error?.status || error?.response?.status)
  if ([401, 403].includes(status)) return true
  return /(?:\bHTTP\s*)?\b(?:401|403)\b|unauthori[sz]ed|forbidden|invalid token/i
    .test(String(error?.message || error || ''))
}

function authenticationFailureStatus(error) {
  const status = Number(error?.statusCode || error?.status || error?.response?.status)
  if ([401, 403].includes(status)) return status
  const message = String(error?.message || error || '')
  if (/(?:\bHTTP\s*)?\b403\b|forbidden/i.test(message)) return 403
  return 401
}

function sanitizedUnauthorizedError(error) {
  const sanitized = new Error(
    `HTTP ${authenticationFailureStatus(error)}; removed after recovery failed`,
  )
  if (error?.runTrace) {
    Object.defineProperty(sanitized, 'runTrace', {
      value: error.runTrace,
      enumerable: false,
      configurable: true,
    })
  }
  return sanitized
}

class LocalWorkspaceAutoRunner {
  constructor(options) {
    this.state = options.state
    this.beginRun = options.beginRun
    this.resolveAttachments = options.resolveAttachments
    this.validateSkillSelections = options.validateSkillSelections
    this.validateKnowledgeBaseSelections = options.validateKnowledgeBaseSelections
    this.invokeAgent = options.invokeAgent
    this.resetAgentSession = options.resetAgentSession
    this.removeAgentFromGroup = options.removeAgentFromGroup
    this.markRuntimeCredential = options.markRuntimeCredential
    this.agentLabel = options.agentLabel
    this.recordAgentFailure = options.recordAgentFailure
    this.recordAgentInterruption = options.recordAgentInterruption
    this.addMessage = options.addMessage
    this.emitChanged = options.emitChanged
    this.finishRun = options.finishRun
  }

  setCurrentAgent(controller, kind) {
    controller.currentKind = kind
    controller.progress = []
    this.emitChanged()
  }

  nextRecoveryKind(activeKinds, failedKind) {
    if (activeKinds.length < 2) return ''
    const failedIndex = activeKinds.indexOf(failedKind)
    for (let offset = 1; offset < activeKinds.length; offset += 1) {
      const candidate = activeKinds[(failedIndex + offset + activeKinds.length) % activeKinds.length]
      if (candidate && candidate !== failedKind) return candidate
    }
    return ''
  }

  recoveryInstruction(failedKind, error) {
    const label = this.agentLabel(failedKind)
    const status = authenticationFailureStatus(error)
    const statusLabel = status === 403 ? 'Forbidden' : 'Unauthorized'
    return [
      `This is an infrastructure recovery turn. ${label} returned HTTP ${status} ${statusLabel} after the original call and ${UNAUTHORIZED_RETRY_COUNT} automatic retries.`,
      'Do not answer the original group topic during this turn.',
      'Inspect the local Agent, Provider, transport, and session configuration available to you and attempt a concrete repair.',
      'Never print, quote, or expose credential values. Report only the checks performed, changes made, and whether the failing Agent is ready to retry.',
    ].join('\n')
  }

  async invokeWithUnauthorizedRecovery({
    group,
    kind,
    controller,
    activeKinds,
    threadRootId,
    context,
    reportedFailures,
  }) {
    let lastUnauthorized = null
    const invokeSource = async () => {
      this.setCurrentAgent(controller, kind)
      return this.invokeAgent(group, kind, 'auto', controller.signal, threadRootId, {
        ...context,
        deferCredentialFailure: true,
      })
    }
    for (let attempt = 0; attempt <= UNAUTHORIZED_RETRY_COUNT; attempt += 1) {
      try {
        return { result: await invokeSource(), removed: false }
      } catch (error) {
        if (controller.signal.aborted || !unauthorizedFailure(error)) throw error
        lastUnauthorized = error
      }
    }

    this.resetAgentSession(group, kind)
    const recoveryKind = this.nextRecoveryKind(activeKinds, kind)
    if (recoveryKind && !controller.signal.aborted) {
      this.setCurrentAgent(controller, recoveryKind)
      try {
        await this.invokeAgent(group, recoveryKind, 'auto', controller.signal, threadRootId, {
          attachments: [],
          skillHints: [],
          knowledgeBaseHints: [],
          runtimeInstruction: this.recoveryInstruction(kind, lastUnauthorized),
          deferCredentialFailure: false,
        })
      } catch (error) {
        if (controller.signal.aborted) throw error
        this.recordAgentFailure(
          group.id, recoveryKind, error, threadRootId, reportedFailures,
        )
      }
    }

    for (let attempt = 0; attempt < POST_RECOVERY_VERIFY_COUNT; attempt += 1) {
      try {
        return { result: await invokeSource(), removed: false }
      } catch (error) {
        if (controller.signal.aborted || !unauthorizedFailure(error)) throw error
        lastUnauthorized = error
      }
    }

    const terminalError = sanitizedUnauthorizedError(lastUnauthorized)
    this.markRuntimeCredential(kind, 'missing')
    this.recordAgentFailure(group.id, kind, terminalError, threadRootId, reportedFailures)
    const removed = this.removeAgentFromGroup(group.id, kind)
    this.resetAgentSession(group, kind, false)
    return { result: null, removed, error: terminalError }
  }

  start(
    group, targetKinds, threadRootId, maxRounds, reservation = null, preparedContext = null,
    unlimitedRounds = false,
  ) {
    const controller = this.beginRun(
      group.id, 'auto', targetKinds, threadRootId, reservation, maxRounds, unlimitedRounds,
    )
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
        let authRemovalOccurred = false
        let activeKinds = [...controller.targetKinds]
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
          for (const kind of [...activeKinds]) {
            if (controller.signal.aborted) break
            try {
              const attachments = attachmentRecipients.has(kind)
                ? []
                : rootAttachments.map(attachment => attachment.path)
              const invocation = await this.invokeWithUnauthorizedRecovery({
                group,
                kind,
                controller,
                activeKinds,
                threadRootId,
                context: {
                  attachments,
                  skillHints: rootSkillsByKind.get(kind) || [],
                  knowledgeBaseHints: rootKnowledgeBasesByKind.get(kind) || [],
                },
                reportedFailures,
              })
              if (invocation.removed) {
                authRemovalOccurred = true
                activeKinds = activeKinds.filter(activeKind => activeKind !== kind)
                controller.failedKinds.push(kind)
                controller.completedKinds.push(kind)
                if (activeKinds.length < 2) break
                continue
              }
              const result = invocation.result
              if (attachments.length) attachmentRecipients.add(kind)
              successes += 1
              if (result.consensus) agreements += 1
            } catch (error) {
              if (controller.signal.aborted) {
                const interruptedKind = controller.currentKind || kind
                if (error?.runTrace) {
                  this.recordAgentInterruption(
                    group.id,
                    interruptedKind,
                    error,
                    threadRootId,
                    controller.stopReason === 'shutdown' ? 'interrupted' : 'stopped',
                    reportedFailures,
                  )
                  controller.completedKinds.push(interruptedKind)
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
          if (activeKinds.length < 2) break
          if (successes === activeKinds.length && agreements === activeKinds.length) {
            consensusReached = true
            break
          }
        }
        if (controller.signal.aborted) {
          runStatus = controller.stopReason === 'shutdown' ? 'interrupted' : 'stopped'
        } else if (authRemovalOccurred) runStatus = totalSuccesses > 0 ? 'partial' : 'failed'
        else if (consensusReached) runStatus = 'completed'
        else runStatus = totalSuccesses > 0 ? 'round-limit' : 'failed'
        if (!authRemovalOccurred && !controller.unlimitedRounds
            && (runStatus === 'round-limit' || runStatus === 'failed')) {
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
          ? (controller.stopReason === 'shutdown' ? 'interrupted' : 'stopped')
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
        controller.currentKind = ''
        controller.progress = []
        if (controller.signal.aborted) {
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
