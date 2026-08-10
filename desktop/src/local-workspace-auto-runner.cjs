const { createHash } = require('node:crypto')

const {
  cleanText,
  credentialFailure,
  normalizeKnowledgeBaseHint,
  terminalRunStatusForReason,
} = require('./local-workspace-inputs.cjs')
const {
  MAX_RUN_AGENT_ATTEMPTS,
  boundedBackoffDelay,
  normalizeAttemptHistoryEntry,
  normalizeFailure,
  normalizeFailureOutcome,
  retryDecision,
} = require('./failure-policy.cjs')
const { mediaGenerationRequest } = require('./media-generation-request.cjs')

function authenticationFailureText(error) {
  return [
    error?.diagnostic,
    error?.message,
    error?.cause?.diagnostic,
    error?.cause?.message,
  ].filter(Boolean).join('\n')
}

function unauthorizedFailure(error) {
  return normalizeFailure(error).category === 'authentication'
}

function hardBudgetFailure(error) {
  return error?.code === 'LOCAL_BUDGET_EXHAUSTED'
    || error?.message === 'LOCAL_BUDGET_EXHAUSTED'
}

function circuitBreakerFailure(error) {
  return error?.code === 'LOCAL_RUN_CIRCUIT_BREAKER'
    || error?.message === 'LOCAL_RUN_CIRCUIT_BREAKER'
}

function circuitBreakerError() {
  return Object.assign(new Error('LOCAL_RUN_CIRCUIT_BREAKER'), {
    code: 'LOCAL_RUN_CIRCUIT_BREAKER',
  })
}

function authenticationFailureStatus(error) {
  const status = normalizeFailure(error).httpStatus
  if ([401, 403].includes(status)) return status
  const message = authenticationFailureText(error)
  if (/(?:\bHTTP\s*)?\b403\b|forbidden/i.test(message)) return 403
  return 401
}

function sanitizedAuthenticationError(error) {
  const statusCode = authenticationFailureStatus(error)
  const sanitized = Object.assign(
    new Error(`HTTP ${statusCode}; authentication failed; Agent retained`),
    {
      code: 'LOCAL_AGENT_AUTH_REQUIRED',
      statusCode,
      failure: Object.freeze({
        code: 'LOCAL_AGENT_AUTH_REQUIRED',
        category: 'authentication',
        retryable: false,
      }),
    },
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

function abortableDelay(delayMs, signal) {
  if (!delayMs) return Promise.resolve()
  if (signal?.aborted) return Promise.reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abortHandler)
      resolve()
    }, delayMs)
    const abortHandler = () => {
      clearTimeout(timer)
      reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED'))
    }
    signal?.addEventListener('abort', abortHandler, { once: true })
  })
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
    this.refreshAgents = options.refreshAgents
    this.consumeAgentControl = options.consumeAgentControl
    this.markRuntimeCredential = options.markRuntimeCredential
    this.agentLabel = options.agentLabel
    this.recordAgentFailure = options.recordAgentFailure
    this.recordAgentInterruption = options.recordAgentInterruption
    this.addMessage = options.addMessage
    this.emitChanged = options.emitChanged
    this.finishRun = options.finishRun
    this.checkpointRun = options.checkpointRun
    this.hasRunLedger = typeof options.hasRunLedger === 'function'
      ? options.hasRunLedger
      : () => false
    this.requestHumanGate = typeof options.requestHumanGate === 'function'
      ? options.requestHumanGate
      : null
    this.completeHumanGateContinuation = typeof options.completeHumanGateContinuation === 'function'
      ? options.completeHumanGateContinuation
      : null
    this.retryContract = typeof options.retryContract === 'function'
      ? options.retryContract
      : () => ({ idempotencyMode: 'none' })
    this.retryBaseDelayMs = Number.isFinite(options.retryBaseDelayMs)
      ? Math.max(1, Math.floor(options.retryBaseDelayMs))
      : 250
    this.retryMaxDelayMs = Number.isFinite(options.retryMaxDelayMs)
      ? Math.max(this.retryBaseDelayMs, Math.floor(options.retryMaxDelayMs))
      : 2000
    this.sleep = options.retrySleep || abortableDelay
  }

  setCurrentAgent(controller, kind) {
    controller.currentKind = kind
    controller.progress = []
    this.emitChanged()
  }

  replacementInstruction(failedKind) {
    return [
      `You are replacing ${this.agentLabel(failedKind)} for this turn.`,
      'Complete the interrupted Agent slot using the shared task context, then return your own conclusion.',
      'Do not claim that the interrupted Agent completed this work.',
    ].join('\n')
  }

  retryDelay(failedAttempt) {
    return boundedBackoffDelay(failedAttempt, {
      baseDelayMs: this.retryBaseDelayMs,
      maxDelayMs: this.retryMaxDelayMs,
    })
  }

  operationIdFor(controller, kind, mode) {
    const digest = createHash('sha256').update(JSON.stringify({
      runId: controller.runId,
      kind,
      mode,
      round: controller.currentRound || 0,
    })).digest('hex')
    return `agent-operation-${digest}`
  }

  recordAttempt(group, controller, input) {
    const history = Array.isArray(controller.attemptHistory) ? controller.attemptHistory : []
    const previousSequence = history.at(-1)?.sequence || 0
    const entry = normalizeAttemptHistoryEntry({
      sequence: previousSequence + 1,
      agentKind: input.agentKind,
      phase: input.phase,
      attempt: input.attempt,
      failureCategory: input.failureCategory ?? null,
      policyAction: input.policyAction,
      backoffMs: input.backoffMs || 0,
      recoveryAgentKind: input.recoveryAgentKind || '',
      finalOutcome: input.finalOutcome,
      timestamp: Date.now(),
      ...(input.outcomeCertainty ? { outcomeCertainty: input.outcomeCertainty } : {}),
      ...(Object.hasOwn(input, 'sideEffectsPossible')
        ? { sideEffectsPossible: input.sideEffectsPossible }
        : {}),
      ...(input.operationId ? { operationId: input.operationId } : {}),
      ...(input.idempotencyMode ? { idempotencyMode: input.idempotencyMode } : {}),
    })
    if (!entry) throw new Error('LOCAL_RUN_ATTEMPT_INVALID')
    controller.attemptHistory = [...history, entry].slice(-256)
    const persisted = this.checkpointRun?.(group.id, controller)
    if (this.hasRunLedger() && persisted !== true) {
      throw new Error('LOCAL_RUN_PERSIST_FAILED')
    }
    return entry
  }

  async prepareRetry(group, kind, controller, failedAttempt, options = {}) {
    if (options.resetSession === true) {
      this.resetAgentSession(group, kind, true, controller.taskId)
    }
    this.markRuntimeCredential(kind, 'unknown')
    try { await this.refreshAgents() } catch {
      if (controller.signal.aborted) throw new Error('LOCAL_AGENT_EXECUTION_STOPPED')
    }
    const delayMs = Number.isFinite(options.delayMs)
      ? Math.max(0, Math.floor(options.delayMs))
      : this.retryDelay(failedAttempt)
    await this.sleep(delayMs, controller.signal)
    return delayMs
  }

  async invokeTransiently(invokeSource, group, kind, controller, options = {}) {
    const operationId = options.operationId
    const idempotencyMode = options.idempotencyMode === 'durable' ? 'durable' : 'none'
    for (let attempt = 1; ; attempt += 1) {
      if (controller.attemptHistory.length >= MAX_RUN_AGENT_ATTEMPTS) {
        throw circuitBreakerError()
      }
      const phase = attempt === 1 ? (options.phase || 'initial') : 'transient_retry'
      const phaseAttempt = attempt === 1 ? (options.attempt || 1) : attempt - 1
      try {
        const result = await invokeSource()
        this.recordAttempt(group, controller, {
          agentKind: options.agentKind || kind,
          phase,
          attempt: phaseAttempt,
          failureCategory: null,
          policyAction: options.successAction || 'complete',
          backoffMs: options.successBackoffMs || 0,
          recoveryAgentKind: options.recoveryAgentKind || '',
          finalOutcome: 'succeeded',
          sideEffectsPossible: group.allowWrite === true,
          operationId,
          idempotencyMode,
        })
        return result
      } catch (error) {
        if (controller.signal.aborted) {
          this.recordAttempt(group, controller, {
            agentKind: options.agentKind || kind,
            phase,
            attempt: phaseAttempt,
            failureCategory: 'cancellation',
            policyAction: 'cancel',
            recoveryAgentKind: options.recoveryAgentKind || '',
            finalOutcome: 'cancelled',
          })
          throw error
        }
        if (unauthorizedFailure(error)) throw error
        const failure = normalizeFailure(error)
        const safety = normalizeFailureOutcome(error, {
          category: failure.category,
          sideEffectsPossible: group.allowWrite === true,
          operationId,
          idempotencyMode,
        })
        if (failure.category === 'cancellation') throw error
        // Session recovery is owned by LocalWorkspaceAgentInvocation so a stale
        // native Session gets exactly one fresh attempt across every run mode.
        const decision = retryDecision(failure, {
          attempt,
          maxAttempts: 4,
          baseDelayMs: this.retryBaseDelayMs,
          maxDelayMs: this.retryMaxDelayMs,
          safety,
        })
        if (decision.action === 'human_gate') {
          this.recordAttempt(group, controller, {
            agentKind: options.agentKind || kind,
            phase,
            attempt: phaseAttempt,
            failureCategory: failure.category,
            policyAction: 'human_gate',
            backoffMs: decision.delayMs,
            recoveryAgentKind: options.recoveryAgentKind || '',
            finalOutcome: 'failed',
            ...safety,
          })
          if (!this.requestHumanGate || !error?.runTrace?.agentRunId) {
            throw new Error('LOCAL_RUN_RETRY_GATE_INVALID')
          }
          const gate = await this.requestHumanGate({
            type: 'retry',
            runId: controller.runId,
            agentRunId: error.runTrace.agentRunId,
            agentKind: options.agentKind || kind,
            summary: 'The previous write-capable Agent attempt may already have changed the workspace.',
            options: [
              { optionId: 'retry-once', name: 'Retry once', kind: 'allow_once' },
              { optionId: 'cancel-retry', name: 'Do not retry', kind: 'reject_once' },
            ],
            request: {
              failureCategory: failure.category,
              outcomeCertainty: safety.outcomeCertainty,
              sideEffectsPossible: safety.sideEffectsPossible,
              operationId: safety.operationId,
              idempotencyMode: safety.idempotencyMode,
            },
          }, {
            signal: controller.signal,
            preserveOnAbort: () => controller.stopReason === 'shutdown',
            continuation: {
              resumeKind: 'agent_slot',
              agentRunId: error.runTrace.agentRunId,
              agentKind: options.agentKind || kind,
              round: controller.currentRound || 0,
            },
          })
          if (gate.status !== 'approved') {
            this.completeHumanGateContinuation?.(controller.runId, gate.gateId, 'cancelled')
            controller.stopReason = 'human_gate_rejected'
            controller.abort()
            throw new Error('LOCAL_AGENT_EXECUTION_STOPPED')
          }
          if (this.completeHumanGateContinuation?.(
            controller.runId, gate.gateId, 'completed',
          ) !== true && this.hasRunLedger()) {
            throw new Error('LOCAL_RUN_PERSIST_FAILED')
          }
          this.markRuntimeCredential(kind, 'unknown')
          try { await this.refreshAgents() } catch {
            if (controller.signal.aborted) throw new Error('LOCAL_AGENT_EXECUTION_STOPPED')
          }
          await this.sleep(decision.delayMs, controller.signal)
          continue
        }
        if (decision.action !== 'retry') {
          this.recordAttempt(group, controller, {
            agentKind: options.agentKind || kind,
            phase,
            attempt: phaseAttempt,
            failureCategory: failure.category,
            policyAction: options.failureAction
              || (decision.action === 'refresh_session' ? 'refresh_session' : 'fail'),
            backoffMs: options.failureBackoffMs || 0,
            recoveryAgentKind: options.recoveryAgentKind || '',
            finalOutcome: 'failed',
            ...safety,
          })
          throw error
        }
        this.recordAttempt(group, controller, {
          agentKind: options.agentKind || kind,
          phase,
          attempt: phaseAttempt,
          failureCategory: failure.category,
          policyAction: 'retry',
          backoffMs: decision.delayMs,
          recoveryAgentKind: options.recoveryAgentKind || '',
          finalOutcome: 'failed',
          ...safety,
        })
        this.markRuntimeCredential(kind, 'unknown')
        try { await this.refreshAgents() } catch {
          if (controller.signal.aborted) throw new Error('LOCAL_AGENT_EXECUTION_STOPPED')
        }
        await this.sleep(decision.delayMs, controller.signal)
      }
    }
  }

  async controlAfterFailure(group, kind, controller, error) {
    const request = this.consumeAgentControl(controller, kind)
    if (!request) return null
    const failure = normalizeFailure(error)
    const manualAttempt = (controller.manualRetryCounts.get(kind) || 0) + 1
    if (request.action === 'retry') {
      controller.manualRetryCounts.set(kind, manualAttempt)
      const delayMs = this.retryDelay(manualAttempt)
      this.recordAttempt(group, controller, {
        agentKind: kind,
        phase: 'manual_retry',
        attempt: manualAttempt,
        failureCategory: failure.category,
        policyAction: 'retry',
        backoffMs: delayMs,
        finalOutcome: 'failed',
      })
      await this.prepareRetry(group, kind, controller, manualAttempt, {
        resetSession: true,
        delayMs,
      })
      return { action: 'retry' }
    }
    this.recordAttempt(group, controller, {
      agentKind: kind,
      phase: 'manual_retry',
      attempt: manualAttempt,
      failureCategory: failure.category,
      policyAction: request.action === 'replace' ? 'replace_agent' : 'cancel',
      recoveryAgentKind: request.replacementKind || '',
      finalOutcome: request.action === 'replace' ? 'replaced' : 'cancelled',
    })
    return request
  }

  async invokeWithUnauthorizedRecovery(input) {
    const { controller, kind } = input
    if (controller.attemptHistory.length >= MAX_RUN_AGENT_ATTEMPTS) {
      throw circuitBreakerError()
    }
    if (controller.agentSlotKinds.has(kind)) {
      throw new Error('LOCAL_AGENT_ATTEMPT_RUNNING')
    }
    controller.agentSlotKinds.add(kind)
    try {
      return await this.invokeWithUnauthorizedRecoveryInSlot(input)
    } finally {
      controller.agentSlotKinds.delete(kind)
    }
  }

  async invokeWithUnauthorizedRecoveryInSlot({
    group,
    kind,
    controller,
    threadRootId,
    context,
    mode = 'auto',
  }) {
    const operationId = this.operationIdFor(controller, kind, mode)
    const contract = this.retryContract(kind) || {}
    const idempotencyMode = contract.idempotencyMode === 'durable' ? 'durable' : 'none'
    const invokeSource = async () => {
      this.setCurrentAgent(controller, kind)
      return this.invokeAgent(group, kind, mode, controller.signal, threadRootId, {
        ...context,
        deferCredentialFailure: true,
        operationId,
      })
    }
    let phase = 'initial'
    let phaseAttempt = 1
    while (true) {
      try {
        return {
          result: await this.invokeTransiently(invokeSource, group, kind, controller, {
            phase,
            attempt: phaseAttempt,
            operationId,
            idempotencyMode,
          }),
          removed: false,
        }
      } catch (error) {
        if (controller.signal.aborted) throw error
        const control = await this.controlAfterFailure(group, kind, controller, error)
        if (control?.action === 'retry') {
          phase = 'manual_retry'
          phaseAttempt = controller.manualRetryCounts.get(kind) || 1
          continue
        }
        if (control) return { result: null, removed: false, control, error }
        if (!unauthorizedFailure(error)) {
          if (credentialFailure(error)) this.markRuntimeCredential(kind, 'missing')
          throw error
        }
        this.markRuntimeCredential(kind, 'missing')
        this.recordAttempt(group, controller, {
          agentKind: kind,
          phase,
          attempt: phaseAttempt,
          failureCategory: 'authentication',
          policyAction: 'fail',
          finalOutcome: 'failed',
          ...normalizeFailureOutcome(error, {
            sideEffectsPossible: group.allowWrite === true,
            operationId,
            idempotencyMode,
          }),
        })
        this.resetAgentSession(group, kind, false, controller.taskId)
        throw sanitizedAuthenticationError(error)
      }
    }
  }

  orchestrationCursor(targetKinds) {
    return {
      version: 1,
      workflow: 'auto',
      currentKind: '',
      pendingKinds: [...targetKinds],
      activeKinds: [...targetKinds],
      successfulKinds: [],
      agreementKinds: [],
      attachmentRecipients: [],
      totalSuccesses: 0,
      terminalFailureOccurred: false,
    }
  }

  checkpointOrchestration(group, controller, updates = {}) {
    controller.orchestration = { ...controller.orchestration, ...updates }
    const persisted = this.checkpointRun?.(group.id, controller)
    if (this.hasRunLedger() && persisted !== true) {
      throw new Error('LOCAL_RUN_PERSIST_FAILED')
    }
  }

  async automaticContext(group, controller, threadRootId, preparedContext = null) {
    let rootAttachments = preparedContext?.attachments
    let rootSkillsByKind = preparedContext?.skillHintsByKind
    let rootKnowledgeBasesByKind = preparedContext?.knowledgeBaseHintsByKind
    let rootMediaRequest = preparedContext?.mediaRequest || null
    if (!rootAttachments || !rootSkillsByKind || !rootKnowledgeBasesByKind) {
      const rootMessage = this.state().messages.find(message => (
        message.id === threadRootId && message.groupId === group.id && message.role === 'user'
      ))
      rootMediaRequest = mediaGenerationRequest(rootMessage?.content || '')
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
    return {
      rootAttachments,
      rootSkillsByKind,
      rootKnowledgeBasesByKind,
      rootMediaRequest,
    }
  }

  async runRounds(group, controller, threadRootId, maxRounds, context, resume = false) {
    const {
      rootAttachments,
      rootSkillsByKind,
      rootKnowledgeBasesByKind,
      rootMediaRequest,
    } = context
    const mediaOwnerKind = rootMediaRequest ? controller.targetKinds[0] : ''
    const cursor = resume ? controller.orchestration : null
    const attachmentRecipients = new Set(cursor?.attachmentRecipients || [])
    let terminalFailureOccurred = cursor?.terminalFailureOccurred === true
    let activeKinds = cursor ? [...cursor.activeKinds] : [...controller.targetKinds]
    let totalSuccesses = cursor?.totalSuccesses || 0
    let consensusReached = false
    const reportedFailures = new Set()
    const firstRound = resume ? Math.max(0, controller.currentRound - 1) : 0

    for (
      let round = firstRound;
      (controller.unlimitedRounds || round < maxRounds) && !controller.signal.aborted;
      round += 1
    ) {
      const resumedRound = resume && round === firstRound
      const successfulKinds = new Set(resumedRound ? cursor.successfulKinds : [])
      const agreementKinds = new Set(resumedRound ? cursor.agreementKinds : [])
      const replacementInstructions = new Map()
      const roundQueue = resumedRound ? [...cursor.pendingKinds] : [...activeKinds]
      controller.currentRound = round + 1
      controller.completedKinds = resumedRound
        ? activeKinds.filter(kind => !roundQueue.includes(kind))
        : []
      controller.failedKinds = resumedRound
        ? controller.completedKinds.filter(kind => !successfulKinds.has(kind))
        : []
      if (!resumedRound) {
        this.checkpointOrchestration(group, controller, {
          currentKind: '',
          pendingKinds: [...roundQueue],
          activeKinds: [...activeKinds],
          successfulKinds: [],
          agreementKinds: [],
          attachmentRecipients: [...attachmentRecipients],
          totalSuccesses,
          terminalFailureOccurred,
        })
      }
      this.emitChanged()

      while (roundQueue.length) {
        const kind = roundQueue.shift()
        if (!activeKinds.includes(kind)) {
          this.checkpointOrchestration(group, controller, { pendingKinds: [...roundQueue] })
          continue
        }
        if (controller.signal.aborted) break
        const executionKind = kind
        this.setCurrentAgent(controller, executionKind)
        this.checkpointOrchestration(group, controller, {
          currentKind: executionKind,
          pendingKinds: [...roundQueue],
          activeKinds: [...activeKinds],
          successfulKinds: [...successfulKinds],
          agreementKinds: [...agreementKinds],
          attachmentRecipients: [...attachmentRecipients],
          totalSuccesses,
          terminalFailureOccurred,
        })
        try {
          const attachments = attachmentRecipients.has(executionKind)
            ? []
            : rootAttachments.map(attachment => attachment.path)
          const invocation = await this.invokeWithUnauthorizedRecovery({
            group,
            kind: executionKind,
            controller,
            activeKinds,
            threadRootId,
            context: {
              attachments,
              attachmentSnapshots: attachments.length ? rootAttachments : [],
              skillHints: rootSkillsByKind.get(executionKind) || [],
              knowledgeBaseHints: rootKnowledgeBasesByKind.get(executionKind) || [],
              runtimeInstruction: replacementInstructions.get(executionKind) || '',
              mediaRequest: executionKind === mediaOwnerKind && round === 0
                ? rootMediaRequest
                : null,
              contextOptions: { focusUserMessageId: threadRootId },
            },
            reportedFailures,
          })
          replacementInstructions.delete(executionKind)
          if (invocation.control?.action === 'replace') {
            this.recordAgentInterruption(
              group.id, executionKind, invocation.error, threadRootId, 'stopped', reportedFailures,
            )
            if (!controller.failedKinds.includes(executionKind)) {
              controller.failedKinds.push(executionKind)
            }
            if (!controller.completedKinds.includes(executionKind)) {
              controller.completedKinds.push(executionKind)
            }
            successfulKinds.delete(executionKind)
            agreementKinds.delete(executionKind)
            const replacementKind = invocation.control.replacementKind
            activeKinds = activeKinds.filter(activeKind => activeKind !== executionKind)
            replacementInstructions.set(
              replacementKind,
              this.replacementInstruction(executionKind),
            )
            if (!roundQueue.includes(replacementKind)) roundQueue.unshift(replacementKind)
            controller.currentKind = ''
            controller.progress = []
            this.checkpointOrchestration(group, controller, {
              currentKind: '',
              pendingKinds: [...roundQueue],
              activeKinds: [...activeKinds],
              successfulKinds: [...successfulKinds],
              agreementKinds: [...agreementKinds],
            })
            this.emitChanged()
            continue
          }
          if (invocation.control?.action === 'cancel') {
            this.recordAgentInterruption(
              group.id, executionKind, invocation.error, threadRootId, 'stopped', reportedFailures,
            )
            if (!controller.failedKinds.includes(executionKind)) {
              controller.failedKinds.push(executionKind)
            }
            if (!controller.completedKinds.includes(executionKind)) {
              controller.completedKinds.push(executionKind)
            }
            successfulKinds.delete(executionKind)
            agreementKinds.delete(executionKind)
            controller.currentKind = ''
            controller.progress = []
            this.checkpointOrchestration(group, controller, {
              currentKind: '',
              pendingKinds: [...roundQueue],
              successfulKinds: [...successfulKinds],
              agreementKinds: [...agreementKinds],
            })
            this.emitChanged()
            continue
          }
          const result = invocation.result
          if (attachments.length) attachmentRecipients.add(executionKind)
          successfulKinds.add(executionKind)
          if (result.consensus) agreementKinds.add(executionKind)
          else agreementKinds.delete(executionKind)
        } catch (error) {
          if (circuitBreakerFailure(error)) {
            controller.stopReason = 'circuit_breaker'
            controller.abort()
            break
          }
          const hardBudget = hardBudgetFailure(error)
          if (hardBudget) {
            this.recordAgentFailure(
              group.id, executionKind, error, threadRootId, reportedFailures,
            )
            successfulKinds.delete(executionKind)
            agreementKinds.delete(executionKind)
            if (!controller.failedKinds.includes(executionKind)) {
              controller.failedKinds.push(executionKind)
            }
            if (!controller.completedKinds.includes(executionKind)) {
              controller.completedKinds.push(executionKind)
            }
            terminalFailureOccurred = true
            controller.stopReason = 'hard_budget'
            controller.abort()
            break
          }
          if (controller.signal.aborted) {
            const interruptedKind = controller.currentKind || executionKind
            if (error?.runTrace) {
              this.recordAgentInterruption(
                group.id,
                interruptedKind,
                error,
                threadRootId,
                controller.stopReason === 'shutdown' ? 'interrupted' : 'stopped',
                reportedFailures,
              )
              if (!controller.completedKinds.includes(interruptedKind)) {
                controller.completedKinds.push(interruptedKind)
              }
              controller.currentKind = ''
              controller.progress = []
              this.emitChanged()
            }
            break
          }
          this.recordAgentFailure(
            group.id, executionKind, error, threadRootId, reportedFailures,
          )
          successfulKinds.delete(executionKind)
          agreementKinds.delete(executionKind)
          if (!controller.failedKinds.includes(executionKind)) {
            controller.failedKinds.push(executionKind)
          }
          if (['authentication', 'compatibility'].includes(normalizeFailure(error).category)) {
            terminalFailureOccurred = true
            activeKinds = activeKinds.filter(activeKind => activeKind !== executionKind)
          }
        }
        if (controller.signal.aborted) break
        if (!controller.completedKinds.includes(executionKind)) {
          controller.completedKinds.push(executionKind)
        }
        controller.currentKind = ''
        controller.progress = []
        this.checkpointOrchestration(group, controller, {
          currentKind: '',
          pendingKinds: [...roundQueue],
          activeKinds: [...activeKinds],
          successfulKinds: [...successfulKinds],
          agreementKinds: [...agreementKinds],
          attachmentRecipients: [...attachmentRecipients],
          totalSuccesses,
          terminalFailureOccurred,
        })
        this.emitChanged()
      }

      if (controller.signal.aborted) break
      const successes = activeKinds.filter(kind => successfulKinds.has(kind)).length
      const agreements = activeKinds.filter(kind => agreementKinds.has(kind)).length
      totalSuccesses += successes
      this.checkpointOrchestration(group, controller, {
        currentKind: '',
        pendingKinds: [],
        activeKinds: [...activeKinds],
        successfulKinds: [...successfulKinds],
        agreementKinds: [...agreementKinds],
        attachmentRecipients: [...attachmentRecipients],
        totalSuccesses,
        terminalFailureOccurred,
      })
      if (activeKinds.length < 2) break
      if (successes === activeKinds.length && agreements === activeKinds.length) {
        consensusReached = true
        break
      }
    }

    let runStatus
    if (controller.signal.aborted) {
      runStatus = terminalRunStatusForReason(controller.stopReason)
    } else if (terminalFailureOccurred) runStatus = totalSuccesses > 0 ? 'partial' : 'failed'
    else if (consensusReached) runStatus = 'completed'
    else runStatus = totalSuccesses > 0 ? 'round-limit' : 'failed'
    if (!terminalFailureOccurred && !controller.unlimitedRounds
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
    if (controller.stopReason === 'circuit_breaker') {
      this.addMessage(
        group.id,
        'system',
        `Automatic discussion stopped after ${MAX_RUN_AGENT_ATTEMPTS} Agent attempts.`,
        '',
        threadRootId,
        {
          key: 'system.runCircuitBreaker',
          params: { maxAttempts: MAX_RUN_AGENT_ATTEMPTS },
        },
      )
    }
    return runStatus
  }

  start(
    group, targetKinds, threadRootId, maxRounds, reservation = null, preparedContext = null,
    unlimitedRounds = false,
  ) {
    reservation.orchestration = this.orchestrationCursor(targetKinds)
    const controller = this.beginRun(
      group.id, 'auto', targetKinds, threadRootId, reservation, maxRounds, unlimitedRounds,
    )
    const promise = (async () => {
      let runStatus = 'failed'
      try {
        const context = await this.automaticContext(
          group, controller, threadRootId, preparedContext,
        )
        runStatus = await this.runRounds(
          group, controller, threadRootId, maxRounds, context,
        )
      } catch (error) {
        runStatus = controller.signal.aborted
          ? terminalRunStatusForReason(controller.stopReason)
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
          runStatus = terminalRunStatusForReason(controller.stopReason)
        }
        await this.finishRun(group.id, controller, runStatus)
      }
    })()
    controller.promise = promise
    return controller
  }

  async resume(group, durable, controller) {
    const context = await this.automaticContext(
      group, controller, durable.threadRootId, null,
    )
    return this.runRounds(
      group, controller, durable.threadRootId, durable.maxRounds, context, true,
    )
  }
}

module.exports = { LocalWorkspaceAutoRunner }
