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
} = require('../runs/failure-policy.cjs')
const { mediaGenerationRequest } = require('../media/media-generation-request.cjs')
const {
  appendBlackboardEntry,
  appendHandoff,
  collaborationPackageText,
  emptyCollaborationState,
  publicCollaborationText,
  roleForIndex,
  visibleBlackboardEntries,
} = require('../collaboration/collaboration-records.cjs')
const { unlimitedReviewContract } = require('./local-workspace-context.cjs')
const {
  createTaskGraphCursor,
  parseTaskGraphCursor,
  readyTaskGraphNodes,
  terminalTaskGraphState,
  updateTaskGraphCursor,
} = require('../collaboration/task-graph-records.cjs')

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
      if (context.parallelGraph !== true) this.setCurrentAgent(controller, kind)
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

  orchestrationCursor(targetKinds, taskGraph = null) {
    if (taskGraph) {
      return {
        version: 3,
        workflow: 'auto',
        template: 'task-graph',
        currentKind: '',
        pendingKinds: [...targetKinds],
        activeKinds: [...targetKinds],
        successfulKinds: [],
        agreementKinds: [],
        attachmentRecipients: [],
        totalSuccesses: 0,
        terminalFailureOccurred: false,
        collaboration: emptyCollaborationState(),
        taskGraph: createTaskGraphCursor(taskGraph),
      }
    }
    return {
      version: 2,
      workflow: 'auto',
      currentKind: '',
      pendingKinds: [...targetKinds],
      activeKinds: [...targetKinds],
      successfulKinds: [],
      agreementKinds: [],
      attachmentRecipients: [],
      totalSuccesses: 0,
      terminalFailureOccurred: false,
      collaboration: emptyCollaborationState(),
    }
  }

  collaborationRole(activeKinds, kind) {
    return roleForIndex(Math.max(0, activeKinds.indexOf(kind)))
  }

  collaborationAudience(role) {
    return {
      roles: role === 'primary'
        ? ['reviewer', 'arbiter']
        : (role === 'reviewer' ? ['primary', 'arbiter'] : ['primary', 'reviewer']),
      agentKinds: [],
    }
  }

  collaborationAcceptance(role) {
    if (role === 'reviewer') {
      return [
        'Check the selected claims and outcome references.',
        'Identify unsupported assumptions, conflicts, or missing evidence.',
      ]
    }
    if (role === 'arbiter') {
      return [
        'Resolve visible conflicts using the selected evidence.',
        'Return one bounded conclusion and state whether consensus is reached.',
      ]
    }
    return [
      'Produce one concrete conclusion for the current task.',
      'Publish only claims and durable outcome references needed downstream.',
    ]
  }

  collaborationExpectedOutput(role) {
    if (role === 'reviewer') return 'A concise review with corrections or explicit acceptance.'
    if (role === 'arbiter') return 'A final adjudication of the selected claims and conflicts.'
    return 'A concise primary conclusion with any durable Artifact or Evidence references.'
  }

  collaborationObjective(group, controller, threadRootId) {
    const root = this.state().messages.find(message => (
      message.groupId === group.id && message.id === threadRootId && message.role === 'user'
    ))
    return publicCollaborationText(root?.content || 'Complete the current user task.', 3000)
      || 'Complete the current user task.'
  }

  prepareCollaborationPackage(
    group, controller, activeKinds, kind, threadRootId, options = {},
  ) {
    const collaboration = controller.orchestration?.collaboration || emptyCollaborationState()
    const destination = {
      agentKind: kind,
      role: options.role || this.collaborationRole(activeKinds, kind),
    }
    const selectedEntryIds = Array.isArray(options.selectedEntryIds)
      ? new Set(options.selectedEntryIds)
      : null
    const selectedEntries = selectedEntryIds
      ? collaboration.entries.filter(entry => selectedEntryIds.has(entry.entryId))
      : visibleBlackboardEntries(collaboration, destination)
    const objective = this.collaborationObjective(group, controller, threadRootId)
    const expectedOutput = options.expectedOutput
      || this.collaborationExpectedOutput(destination.role)
    const acceptanceCriteria = options.acceptanceCriteria
      || this.collaborationAcceptance(destination.role)
    const selectedIds = selectedEntries.map(entry => entry.entryId)
    const reusable = [...collaboration.handoffs].reverse().find(handoff => (
      handoff.destination.agentKind === destination.agentKind
      && handoff.destination.role === destination.role
      && handoff.objective === objective
      && handoff.expectedOutput === expectedOutput
      && handoff.selectedEntryIds.length === selectedIds.length
      && handoff.selectedEntryIds.every((id, index) => id === selectedIds[index])
      && handoff.acceptanceCriteria.length === acceptanceCriteria.length
      && handoff.acceptanceCriteria.every((value, index) => value === acceptanceCriteria[index])
    ))
    if (reusable) {
      return {
        handoff: reusable,
        entries: selectedEntries,
        text: collaborationPackageText(reusable, selectedEntries),
      }
    }
    const previousOwner = [...collaboration.entries].reverse().find(entry => (
      entry.owner.type === 'agent'
    ))?.owner
    const createdAt = Date.now()
    const next = appendHandoff(collaboration, {
      source: previousOwner || { type: 'harness' },
      destination,
      objective,
      selectedEntryIds: selectedIds,
      expectedOutput,
      acceptanceCriteria,
      provenance: {
        runId: controller.runId,
        taskId: controller.taskId,
        round: controller.currentRound,
        agentRunId: null,
        artifactIds: [],
        evidenceIds: [],
      },
      createdAt,
    })
    const handoff = next.handoffs.at(-1)
    this.checkpointOrchestration(group, controller, { collaboration: next })
    return {
      handoff,
      entries: selectedEntries,
      text: collaborationPackageText(handoff, selectedEntries),
    }
  }

  recordCollaborationResult(group, controller, activeKinds, kind, result, options = {}) {
    const role = options.role || this.collaborationRole(activeKinds, kind)
    const conclusion = publicCollaborationText(result?.message?.content || '')
    const trace = result?.message?.trace
    const provenance = {
      runId: controller.runId,
      taskId: controller.taskId,
      round: controller.currentRound,
      agentRunId: trace?.agentRunId || null,
      artifactIds: result?.outcomeRefs?.artifactIds || [],
      evidenceIds: result?.outcomeRefs?.evidenceIds || [],
    }
    let collaboration = controller.orchestration?.collaboration || emptyCollaborationState()
    const previousCollaboration = collaboration
    const previousEntryIds = new Set(collaboration.entries.map(entry => entry.entryId))
    let sequence = collaboration.entries.length + 1
    const recordedAt = Date.now()
    const conclusionValue = conclusion
      ? createHash('sha256').update(conclusion).digest('hex')
      : ''
    const entryType = options.entryType || 'claim'
    const subject = options.subject || `task:${controller.taskId}:conclusion`
    const entryRefs = Array.isArray(options.refs) ? options.refs : []
    const duplicateConclusion = conclusion && collaboration.entries.some(entry => (
      entry.entryType === entryType
      && entry.lifecycle.state === 'active'
      && entry.subject === subject
      && entry.value === conclusionValue
      && entry.owner.type === 'agent'
      && entry.owner.agentKind === kind
    ))
    if (conclusion && !duplicateConclusion) {
      collaboration = appendBlackboardEntry(collaboration, {
        entryType,
        subject,
        statement: conclusion,
        value: entryType === 'claim' ? conclusionValue : '',
        owner: { type: 'agent', agentKind: kind, role },
        audience: this.collaborationAudience(role),
        lifecycle: {
          state: 'active', sequence, recordedAt, supersedesEntryId: null,
        },
        provenance,
        refs: entryRefs,
      })
      sequence = collaboration.entries.length + 1
    }
    for (const artifactId of duplicateConclusion ? [] : provenance.artifactIds.slice(0, 1)) {
      collaboration = appendBlackboardEntry(collaboration, {
        entryType: 'artifact-ref',
        subject: `task:${controller.taskId}:artifact`,
        statement: 'Durable Artifact produced by the Agent.',
        value: '',
        owner: { type: 'agent', agentKind: kind, role },
        audience: this.collaborationAudience(role),
        lifecycle: {
          state: 'active', sequence, recordedAt, supersedesEntryId: null,
        },
        provenance,
        refs: [artifactId],
      })
      sequence = collaboration.entries.length + 1
    }
    for (const evidenceId of duplicateConclusion ? [] : provenance.evidenceIds.slice(0, 1)) {
      collaboration = appendBlackboardEntry(collaboration, {
        entryType: 'evidence-ref',
        subject: `task:${controller.taskId}:evidence`,
        statement: 'Durable Evidence recorded for the Agent conclusion.',
        value: '',
        owner: { type: 'agent', agentKind: kind, role },
        audience: this.collaborationAudience(role),
        lifecycle: {
          state: 'active', sequence, recordedAt, supersedesEntryId: null,
        },
        provenance,
        refs: [evidenceId],
      })
      sequence = collaboration.entries.length + 1
    }
    if (collaboration !== previousCollaboration) {
      this.checkpointOrchestration(group, controller, { collaboration })
    }
    return collaboration.entries
      .filter(entry => !previousEntryIds.has(entry.entryId))
      .map(entry => entry.entryId)
  }

  checkpointOrchestration(group, controller, updates = {}) {
    controller.orchestration = { ...controller.orchestration, ...updates }
    const persisted = this.checkpointRun?.(group.id, controller)
    if (this.hasRunLedger() && persisted !== true) {
      throw new Error('LOCAL_RUN_PERSIST_FAILED')
    }
  }

  unresolvedTaskGraphConflicts(collaborationInput = null) {
    const collaboration = collaborationInput || emptyCollaborationState()
    const resolved = new Set(collaboration.entries
      .filter(entry => entry.entryType === 'decision' && entry.lifecycle.state === 'active')
      .flatMap(entry => entry.refs))
    return collaboration.entries.filter(entry => (
      entry.entryType === 'conflict'
      && entry.lifecycle.state === 'active'
      && !resolved.has(entry.entryId)
    ))
  }

  taskGraphAcceptanceCriteria(node) {
    const criteria = []
    if (node.acceptance.requireConclusion) criteria.push('Return one concrete conclusion.')
    if (node.acceptance.minArtifactRefs) {
      criteria.push(`Produce at least ${node.acceptance.minArtifactRefs} durable Artifact reference(s).`)
    }
    if (node.acceptance.minEvidenceRefs) {
      criteria.push(`Produce at least ${node.acceptance.minEvidenceRefs} durable Evidence reference(s).`)
    }
    return criteria.length ? criteria : ['Complete the explicit Human decision.']
  }

  taskGraphSelectedEntryIds(controller, node) {
    const cursor = parseTaskGraphCursor(controller.orchestration.taskGraph)
    const states = new Map(cursor.nodeStates.map(state => [state.nodeId, state]))
    const selected = node.inputNodeIds.flatMap(nodeId => states.get(nodeId)?.entryIds || [])
    if (['reviewer', 'arbiter'].includes(node.role)) {
      selected.push(...this.unresolvedTaskGraphConflicts(
        controller.orchestration.collaboration,
      ).map(entry => entry.entryId))
    }
    return [...new Set(selected)]
  }

  taskGraphPrompt(node, objective, collaborationPackage, unlimitedRounds = false) {
    return [
      'ROUNDRELAY_TASK_GRAPH_V1',
      `Node: ${node.nodeId}`,
      `Role: ${node.role}`,
      `Objective: ${objective}`,
      `Expected output: ${node.expectedOutput}`,
      `Acceptance criteria: ${this.taskGraphAcceptanceCriteria(node).join(' | ')}`,
      unlimitedReviewContract(unlimitedRounds),
      collaborationPackage.text,
      'Return the requested result directly. Completion is evaluated from durable typed records; do not emit a consensus marker.',
    ].join('\n')
  }

  checkpointTaskGraph(group, controller, cursorInput, options = {}) {
    let taskGraph = parseTaskGraphCursor(cursorInput)
    taskGraph = parseTaskGraphCursor({
      ...taskGraph,
      terminalState: terminalTaskGraphState(taskGraph),
    })
    const states = new Map(taskGraph.nodeStates.map(state => [state.nodeId, state]))
    const pendingKinds = taskGraph.graph.nodes
      .filter(node => states.get(node.nodeId)?.status === 'pending' && node.agentKind)
      .map(node => node.agentKind)
    const successfulKinds = taskGraph.graph.nodes
      .filter(node => states.get(node.nodeId)?.status === 'accepted' && node.agentKind)
      .map(node => node.agentKind)
    const uniquePendingKinds = [...new Set(pendingKinds)]
    const uniqueSuccessfulKinds = [...new Set(successfulKinds)]
    this.checkpointOrchestration(group, controller, {
      taskGraph,
      currentKind: options.currentKind || '',
      pendingKinds: uniquePendingKinds,
      successfulKinds: uniqueSuccessfulKinds,
      agreementKinds: [],
      totalSuccesses: taskGraph.nodeStates.filter(state => state.status === 'accepted').length,
      terminalFailureOccurred: taskGraph.terminalState === 'failed',
    })
    return taskGraph
  }

  taskGraphResultAccepted(node, result) {
    const conclusion = publicCollaborationText(result?.message?.content || '')
    const artifactIds = result?.outcomeRefs?.artifactIds || []
    const evidenceIds = result?.outcomeRefs?.evidenceIds || []
    return (!node.acceptance.requireConclusion || Boolean(conclusion))
      && artifactIds.length >= node.acceptance.minArtifactRefs
      && evidenceIds.length >= node.acceptance.minEvidenceRefs
  }

  applyTaskGraphAgentResult(group, controller, node, result) {
    const conflicts = this.unresolvedTaskGraphConflicts(controller.orchestration.collaboration)
    const entryIds = this.recordCollaborationResult(
      group,
      controller,
      controller.orchestration.activeKinds,
      node.agentKind,
      result,
      {
        role: node.role,
        entryType: node.role === 'arbiter' ? 'decision' : 'claim',
        subject: node.role === 'primary'
          ? `task:${controller.taskId}:conclusion`
          : `task:${controller.taskId}:node:${node.nodeId}`,
        refs: node.role === 'arbiter' ? conflicts.map(entry => entry.entryId) : [],
      },
    )
    const accepted = this.taskGraphResultAccepted(node, result)
    const conclusion = publicCollaborationText(result?.message?.content || '')
    const artifactIds = result?.outcomeRefs?.artifactIds || []
    const evidenceIds = result?.outcomeRefs?.evidenceIds || []
    let cursor = updateTaskGraphCursor(
      controller.orchestration.taskGraph,
      node.nodeId,
      {
        status: accepted ? 'accepted' : 'failed',
        entryIds,
        artifactIds,
        evidenceIds,
        conclusionHash: conclusion
          ? createHash('sha256').update(conclusion).digest('hex')
          : '',
      },
    )
    if (accepted) {
      if (!controller.completedKinds.includes(node.agentKind)) {
        controller.completedKinds.push(node.agentKind)
      }
    } else if (!controller.failedKinds.includes(node.agentKind)) {
      controller.failedKinds.push(node.agentKind)
    }
    cursor = this.checkpointTaskGraph(group, controller, cursor)
    return accepted
  }

  taskGraphDecisionAgentRunId(graphId, nodeId) {
    const digest = createHash('sha256').update(JSON.stringify([graphId, nodeId])).digest('hex')
    return `graph-decision-${digest}`
  }

  taskGraphDecisionAnchor(controller, node) {
    const graph = parseTaskGraphCursor(controller.orchestration.taskGraph)
    const byId = new Map(graph.graph.nodes.map(candidate => [candidate.nodeId, candidate]))
    return [...node.dependsOn].reverse()
      .map(nodeId => byId.get(nodeId)?.agentKind)
      .find(Boolean) || controller.targetKinds[0]
  }

  applyTaskGraphHumanDecision(group, controller, node, decision) {
    const option = node.decisionOptions.find(candidate => candidate.optionId === decision.optionId)
    if (!option) throw new Error('LOCAL_WORKFLOW_DECISION_INVALID')
    const accepted = decision.status === 'approved'
    const conflicts = this.unresolvedTaskGraphConflicts(controller.orchestration.collaboration)
    let collaboration = controller.orchestration.collaboration
    collaboration = appendBlackboardEntry(collaboration, {
      entryType: 'decision',
      subject: `task:${controller.taskId}:node:${node.nodeId}`,
      statement: `Human selected: ${option.name}`,
      value: '',
      owner: { type: 'harness' },
      audience: { roles: ['primary', 'reviewer', 'arbiter'], agentKinds: [] },
      lifecycle: {
        state: 'active',
        sequence: collaboration.entries.length + 1,
        recordedAt: Date.now(),
        supersedesEntryId: null,
      },
      provenance: {
        runId: controller.runId,
        taskId: controller.taskId,
        round: controller.currentRound,
        agentRunId: this.taskGraphDecisionAgentRunId(
          controller.orchestration.taskGraph.graph.graphId,
          node.nodeId,
        ),
        artifactIds: [],
        evidenceIds: [],
      },
      refs: conflicts.map(entry => entry.entryId),
    })
    const decisionEntryId = collaboration.entries.at(-1).entryId
    this.checkpointOrchestration(group, controller, { collaboration })
    let cursor = updateTaskGraphCursor(
      controller.orchestration.taskGraph,
      node.nodeId,
      {
        status: accepted ? 'accepted' : 'rejected',
        entryIds: [decisionEntryId],
        decisionOptionId: option.optionId,
      },
    )
    cursor = this.checkpointTaskGraph(group, controller, cursor)
    return accepted
  }

  async executeTaskGraphAgentNode(
    group, controller, threadRootId, context, node, parallelGraph = false,
  ) {
    const selectedEntryIds = this.taskGraphSelectedEntryIds(controller, node)
    const collaborationPackage = this.prepareCollaborationPackage(
      group,
      controller,
      controller.orchestration.activeKinds,
      node.agentKind,
      threadRootId,
      {
        role: node.role,
        selectedEntryIds,
        expectedOutput: node.expectedOutput,
        acceptanceCriteria: this.taskGraphAcceptanceCriteria(node),
      },
    )
    const isolated = ['reviewer', 'arbiter'].includes(node.role)
    const attachments = node.role === 'primary'
      && !controller.orchestration.attachmentRecipients.includes(node.agentKind)
      ? context.rootAttachments.map(attachment => attachment.path)
      : []
    const objective = this.collaborationObjective(group, controller, threadRootId)
    return this.invokeWithUnauthorizedRecovery({
      group,
      kind: node.agentKind,
      controller,
      threadRootId,
      context: {
        attachments,
        attachmentSnapshots: attachments.length ? context.rootAttachments : [],
        skillHints: context.rootSkillsByKind.get(node.agentKind) || [],
        knowledgeBaseHints: context.rootKnowledgeBasesByKind.get(node.agentKind) || [],
        collaborationPackage,
        completionPolicy: 'typed',
        parallelGraph,
        runtimeInstruction: isolated ? '' : [
          `Execute task-graph node ${node.nodeId} as ${node.role}.`,
          `Expected output: ${node.expectedOutput}`,
          'Do not emit a consensus marker.',
        ].join('\n'),
        ...(isolated ? {
          sessionPolicy: 'isolated',
          promptOverride: this.taskGraphPrompt(
            node, objective, collaborationPackage, controller.unlimitedRounds === true,
          ),
          contextPackId: controller.contextPackId,
        } : {}),
        contextOptions: {
          focusUserMessageId: threadRootId,
          omitAgentThreadRootId: threadRootId,
        },
      },
      mode: 'auto',
    })
  }

  async executeTaskGraphHumanNode(group, controller, node) {
    if (!this.requestHumanGate) throw new Error('LOCAL_WORKFLOW_DECISION_UNAVAILABLE')
    const anchorKind = this.taskGraphDecisionAnchor(controller, node)
    const agentRunId = this.taskGraphDecisionAgentRunId(
      controller.orchestration.taskGraph.graph.graphId,
      node.nodeId,
    )
    let cursor = updateTaskGraphCursor(
      controller.orchestration.taskGraph,
      node.nodeId,
      { status: 'waiting', attention: 'decision', attempts: 1 },
    )
    cursor = this.checkpointTaskGraph(group, controller, cursor, { currentKind: anchorKind })
    const gate = await this.requestHumanGate({
      type: 'decision',
      runId: controller.runId,
      agentRunId,
      agentKind: anchorKind,
      summary: node.expectedOutput,
      options: node.decisionOptions,
      request: {
        graphId: cursor.graph.graphId,
        nodeId: node.nodeId,
        inputNodeIds: node.inputNodeIds,
      },
    }, {
      signal: controller.signal,
      preserveOnAbort: () => controller.stopReason === 'shutdown',
      continuation: {
        resumeKind: 'role_review_decision',
        agentRunId,
        agentKind: anchorKind,
        round: controller.currentRound,
      },
    })
    const accepted = this.applyTaskGraphHumanDecision(group, controller, node, gate)
    if (this.completeHumanGateContinuation?.(
      controller.runId,
      gate.gateId,
      accepted ? 'completed' : 'cancelled',
    ) !== true && this.hasRunLedger()) {
      throw new Error('LOCAL_RUN_PERSIST_FAILED')
    }
    return accepted
  }

  taskGraphBatch(group, readyNodes) {
    const parallel = []
    const kinds = new Set()
    if (group.allowWrite !== true) {
      for (const node of readyNodes) {
        if (!node.parallel || node.role === 'human' || kinds.has(node.agentKind)) continue
        parallel.push(node)
        kinds.add(node.agentKind)
      }
    }
    return parallel.length > 1 ? parallel : readyNodes.slice(0, 1)
  }

  async runTaskGraph(group, controller, threadRootId, context) {
    while (!controller.signal.aborted) {
      let cursor = parseTaskGraphCursor(controller.orchestration.taskGraph)
      const terminalState = terminalTaskGraphState(cursor)
      if (terminalState !== 'running') {
        cursor = this.checkpointTaskGraph(group, controller, cursor)
        break
      }
      if (!controller.unlimitedRounds && controller.currentRound >= controller.maxRounds) break
      const readyNodes = readyTaskGraphNodes(cursor)
      if (!readyNodes.length) {
        cursor = parseTaskGraphCursor({ ...cursor, terminalState: 'failed' })
        this.checkpointTaskGraph(group, controller, cursor)
        break
      }
      const batch = this.taskGraphBatch(group, readyNodes)
      controller.currentRound += 1
      if (batch.length === 1 && batch[0].role === 'human') {
        await this.executeTaskGraphHumanNode(group, controller, batch[0])
        continue
      }
      const conflicts = this.unresolvedTaskGraphConflicts(controller.orchestration.collaboration)
      for (const node of batch) {
        cursor = updateTaskGraphCursor(cursor, node.nodeId, {
          status: 'running',
          attention: node.role === 'reviewer' && conflicts.length
            ? 'review'
            : (node.role === 'arbiter' && conflicts.length ? 'decision' : 'none'),
          attempts: cursor.nodeStates.find(state => state.nodeId === node.nodeId).attempts + 1,
        })
      }
      const currentKind = batch.length === 1 ? batch[0].agentKind : ''
      cursor = this.checkpointTaskGraph(group, controller, cursor, { currentKind })
      this.emitChanged()
      const settled = await Promise.allSettled(batch.map(node => (
        this.executeTaskGraphAgentNode(
          group, controller, threadRootId, context, node, batch.length > 1,
        )
      )))
      for (let index = 0; index < batch.length; index += 1) {
        const node = batch[index]
        const outcome = settled[index]
        if (outcome.status === 'fulfilled' && outcome.value?.result) {
          if (outcome.value.result.outcomeRefs?.artifactIds?.length
              && !controller.orchestration.attachmentRecipients.includes(node.agentKind)) {
            this.checkpointOrchestration(group, controller, {
              attachmentRecipients: [...controller.orchestration.attachmentRecipients, node.agentKind],
            })
          }
          this.applyTaskGraphAgentResult(group, controller, node, outcome.value.result)
          continue
        }
        const error = outcome.status === 'rejected'
          ? outcome.reason
          : (outcome.value?.error || new Error('LOCAL_AGENT_UNKNOWN_FAILURE'))
        if (controller.signal.aborted) continue
        this.recordAgentFailure(group.id, node.agentKind, error, threadRootId, new Set())
        cursor = updateTaskGraphCursor(
          controller.orchestration.taskGraph,
          node.nodeId,
          { status: 'failed' },
        )
        this.checkpointTaskGraph(group, controller, cursor)
        if (!controller.failedKinds.includes(node.agentKind)) {
          controller.failedKinds.push(node.agentKind)
        }
        if (circuitBreakerFailure(error)) {
          controller.stopReason = 'circuit_breaker'
          controller.abort()
        } else if (hardBudgetFailure(error)) {
          controller.stopReason = 'hard_budget'
          controller.abort()
        }
      }
      controller.currentKind = ''
      controller.progress = []
      this.emitChanged()
    }

    if (controller.signal.aborted) return terminalRunStatusForReason(controller.stopReason)
    const cursor = parseTaskGraphCursor(controller.orchestration.taskGraph)
    if (cursor.terminalState === 'accepted') return 'completed'
    if (cursor.terminalState === 'rejected') return 'stopped'
    if (cursor.terminalState === 'failed') {
      return cursor.nodeStates.some(state => state.status === 'accepted') ? 'partial' : 'failed'
    }
    return cursor.nodeStates.some(state => state.status === 'accepted') ? 'round-limit' : 'failed'
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
          if (controller.attemptHistory.length >= MAX_RUN_AGENT_ATTEMPTS) {
            throw circuitBreakerError()
          }
          const collaborationPackage = this.prepareCollaborationPackage(
            group, controller, activeKinds, executionKind, threadRootId,
          )
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
              collaborationPackage,
              contextOptions: {
                focusUserMessageId: threadRootId,
                omitAgentThreadRootId: threadRootId,
              },
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
          this.recordCollaborationResult(
            group, controller, activeKinds, executionKind, result,
          )
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
      const crossReviewComplete = !controller.unlimitedRounds || controller.currentRound >= 2
      if (crossReviewComplete
          && successes === activeKinds.length
          && agreements === activeKinds.length) {
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
    unlimitedRounds = false, taskGraph = null,
  ) {
    reservation.orchestration = this.orchestrationCursor(targetKinds, taskGraph)
    const controller = this.beginRun(
      group.id, 'auto', targetKinds, threadRootId, reservation, maxRounds, unlimitedRounds,
    )
    const promise = (async () => {
      let runStatus = 'failed'
      try {
        const context = await this.automaticContext(
          group, controller, threadRootId, preparedContext,
        )
        runStatus = taskGraph
          ? await this.runTaskGraph(group, controller, threadRootId, context)
          : await this.runRounds(group, controller, threadRootId, maxRounds, context)
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

  async resume(group, durable, controller, replayedResult = null) {
    if (controller.orchestration?.version === 3) {
      const cursor = parseTaskGraphCursor(controller.orchestration.taskGraph)
      const runningNodeId = cursor.currentNodeIds.length === 1
        ? cursor.currentNodeIds[0]
        : ''
      const node = cursor.graph.nodes.find(candidate => candidate.nodeId === runningNodeId)
      if (replayedResult && node?.role !== 'human') {
        this.applyTaskGraphAgentResult(group, controller, node, replayedResult)
      }
      const context = await this.automaticContext(
        group, controller, durable.threadRootId, null,
      )
      return this.runTaskGraph(group, controller, durable.threadRootId, context)
    }
    if (controller.orchestration?.version === 1) {
      controller.orchestration = {
        ...controller.orchestration,
        version: 2,
        collaboration: emptyCollaborationState(),
      }
      const persisted = this.checkpointRun?.(group.id, controller)
      if (this.hasRunLedger() && persisted !== true) {
        throw new Error('LOCAL_RUN_PERSIST_FAILED')
      }
    }
    const context = await this.automaticContext(
      group, controller, durable.threadRootId, null,
    )
    return this.runRounds(
      group, controller, durable.threadRootId, durable.maxRounds, context, true,
    )
  }

  async resumeDecision(group, durable, controller, decision) {
    const cursor = parseTaskGraphCursor(controller.orchestration?.taskGraph)
    const waiting = cursor.nodeStates.find(state => state.status === 'waiting')
    const node = cursor.graph.nodes.find(candidate => candidate.nodeId === waiting?.nodeId)
    if (!node || node.role !== 'human') throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
    const expectedAgentRunId = this.taskGraphDecisionAgentRunId(cursor.graph.graphId, node.nodeId)
    if (durable.continuation?.agentRunId !== expectedAgentRunId) {
      throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
    }
    const accepted = this.applyTaskGraphHumanDecision(group, controller, node, decision)
    if (this.completeHumanGateContinuation?.(
      controller.runId,
      durable.continuation.gateId,
      accepted ? 'completed' : 'cancelled',
    ) !== true && this.hasRunLedger()) {
      throw new Error('LOCAL_RUN_PERSIST_FAILED')
    }
    const context = await this.automaticContext(
      group, controller, durable.threadRootId, null,
    )
    return this.runTaskGraph(group, controller, durable.threadRootId, context)
  }
}

module.exports = { LocalWorkspaceAutoRunner }
