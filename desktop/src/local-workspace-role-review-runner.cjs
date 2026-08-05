const { parseWorkflowDefinition } = require('./orchestration-records.cjs')
const { RoleReviewExecutor } = require('./role-review-executor.cjs')
const {
  normalizeOutcomeRefs,
  traceCapsuleFromAgentRun,
} = require('./run-harness.cjs')
const {
  createWorkflowOutcome,
  parseWorkflowOutcome,
  serializeWorkflowOutcome,
} = require('./workflow-output.cjs')

const DECISION_GATE_SUMMARY = 'Role review requires a human decision.'
const DECISION_GATE_OPTIONS = Object.freeze([
  Object.freeze({ optionId: 'accept-artifact', name: 'Accept Artifact', kind: 'accept' }),
  Object.freeze({ optionId: 'reject-artifact', name: 'Reject Artifact', kind: 'reject' }),
  Object.freeze({ optionId: 'reopen-task', name: 'Reopen Task', kind: 'reopen' }),
])
const DECISIONS = Object.freeze({
  'accept-artifact': Object.freeze({ gateStatus: 'approved', status: 'accepted' }),
  'reject-artifact': Object.freeze({ gateStatus: 'rejected', status: 'rejected' }),
  'reopen-task': Object.freeze({ gateStatus: 'rejected', status: 'reopened' }),
})

function runnerError(code) {
  return Object.assign(new Error(code), { code })
}

function requireFunction(value, code) {
  if (typeof value !== 'function') throw runnerError(code)
  return value
}

function addUnique(values, value) {
  if (value && !values.includes(value)) values.push(value)
}

function sameSet(values, expected) {
  return values.length === expected.length
    && new Set(values).size === values.length
    && values.every(value => expected.includes(value))
}

function mergeOutcomeRefs(...inputs) {
  const merged = {
    artifactIds: [],
    evidenceIds: [],
    findingIds: [],
    reviewerFindingIds: [],
    adoptionIds: [],
    workflowOutcomeRefs: [],
  }
  for (const input of inputs) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) continue
    for (const field of Object.keys(merged)) {
      if (Array.isArray(input[field])) merged[field].push(...input[field])
    }
  }
  return normalizeOutcomeRefs(merged)
}

function terminalRunStatus(controller, error) {
  if (controller?.signal?.aborted) {
    return controller.stopReason === 'shutdown' ? 'interrupted' : 'stopped'
  }
  if (error?.roleReviewControl === 'cancel') return 'stopped'
  return error?.message === 'LOCAL_AGENT_TIMEOUT' ? 'timeout' : 'failed'
}

class LocalWorkspaceRoleReviewRunner {
  constructor(options = {}) {
    this.state = requireFunction(options.state, 'LOCAL_ROLE_REVIEW_STATE_REQUIRED')
    this.detectedAgents = requireFunction(
      options.detectedAgents, 'LOCAL_ROLE_REVIEW_AGENTS_REQUIRED',
    )
    this.getGroup = requireFunction(options.getGroup, 'LOCAL_ROLE_REVIEW_GROUP_REQUIRED')
    this.reserveRun = requireFunction(options.reserveRun, 'LOCAL_ROLE_REVIEW_RUNNER_REQUIRED')
    this.bindRunTask = requireFunction(options.bindRunTask, 'LOCAL_ROLE_REVIEW_RUNNER_REQUIRED')
    this.releasePreparation = requireFunction(
      options.releasePreparation, 'LOCAL_ROLE_REVIEW_RUNNER_REQUIRED',
    )
    this.configureRunBudget = requireFunction(
      options.configureRunBudget, 'LOCAL_ROLE_REVIEW_RUNNER_REQUIRED',
    )
    this.beginRun = requireFunction(options.beginRun, 'LOCAL_ROLE_REVIEW_RUNNER_REQUIRED')
    this.finishRun = requireFunction(options.finishRun, 'LOCAL_ROLE_REVIEW_RUNNER_REQUIRED')
    this.preflightMessage = requireFunction(
      options.preflightMessage, 'LOCAL_ROLE_REVIEW_PREFLIGHT_REQUIRED',
    )
    this.addMessage = requireFunction(options.addMessage, 'LOCAL_ROLE_REVIEW_MESSAGE_REQUIRED')
    this.rollbackAddedMessage = requireFunction(
      options.rollbackAddedMessage, 'LOCAL_ROLE_REVIEW_MESSAGE_REQUIRED',
    )
    this.createContextPack = requireFunction(
      options.createContextPack, 'LOCAL_ROLE_REVIEW_CONTEXT_REQUIRED',
    )
    this.invokeWithRecovery = requireFunction(
      options.invokeWithRecovery, 'LOCAL_ROLE_REVIEW_INVOKER_REQUIRED',
    )
    this.recordAgentFailure = requireFunction(
      options.recordAgentFailure, 'LOCAL_ROLE_REVIEW_FAILURE_HANDLER_REQUIRED',
    )
    this.recordAgentInterruption = requireFunction(
      options.recordAgentInterruption, 'LOCAL_ROLE_REVIEW_FAILURE_HANDLER_REQUIRED',
    )
    this.requestHumanGate = requireFunction(
      options.requestHumanGate, 'LOCAL_ROLE_REVIEW_GATE_REQUIRED',
    )
    this.completeHumanGateContinuation = typeof options.completeHumanGateContinuation === 'function'
      ? options.completeHumanGateContinuation
      : () => false
    this.checkpointRun = requireFunction(
      options.checkpointRun, 'LOCAL_ROLE_REVIEW_CHECKPOINT_REQUIRED',
    )
    this.save = requireFunction(options.save, 'LOCAL_ROLE_REVIEW_SAVE_REQUIRED')
    this.emitChanged = requireFunction(options.emitChanged, 'LOCAL_ROLE_REVIEW_EMIT_REQUIRED')
    this.hasRunLedger = typeof options.hasRunLedger === 'function'
      ? options.hasRunLedger
      : () => false
    this.contentBlobStore = options.contentBlobStore
    this.contextPackStore = options.contextPackStore
    this.outcomeStore = options.outcomeStore
  }

  validateInput(input, workflow, group) {
    if (group.conversationType === 'direct') throw runnerError('LOCAL_ROLE_REVIEW_GROUP_REQUIRED')
    const targetKinds = Array.isArray(input.targetKinds) ? input.targetKinds.map(String) : []
    const workflowKinds = [...new Set(workflow.nodes.map(node => node.agentKind))]
    if (!sameSet(targetKinds, workflowKinds)) {
      throw runnerError('LOCAL_ROLE_REVIEW_TARGET_MISMATCH')
    }
    const groupKinds = new Set(Array.isArray(group.agentKinds) ? group.agentKinds : [])
    if (workflowKinds.some(kind => !groupKinds.has(kind))) {
      throw runnerError('LOCAL_ROLE_REVIEW_GROUP_MISMATCH')
    }
    const available = new Set(this.detectedAgents()
      .filter(agent => agent?.available)
      .map(agent => agent.kind))
    if (workflowKinds.some(kind => !available.has(kind))) {
      throw runnerError('LOCAL_AGENT_UNAVAILABLE')
    }
    return {
      targetKinds: workflowKinds,
      primaryKinds: [...new Set(workflow.nodes
        .filter(node => node.role === 'primary')
        .map(node => node.agentKind))],
    }
  }

  primaryOutcome(outcomeRefs) {
    const refs = normalizeOutcomeRefs(outcomeRefs)
    const artifacts = (refs.artifactIds || []).map(
      artifactId => this.outcomeStore.getArtifact(artifactId),
    )
    const artifact = artifacts.find(record => !/-conclusion\.txt$/iu.test(record.name))
      || artifacts[0]
    if (!artifact) throw runnerError('LOCAL_ROLE_REVIEW_ARTIFACT_REQUIRED')
    const evidenceIds = (refs.evidenceIds || []).filter((evidenceId) => {
      const evidence = this.outcomeStore.getEvidence(evidenceId)
      return evidence.subject.type === 'artifact'
        && evidence.subject.artifactId === artifact.artifactId
    })
    if (!evidenceIds.length) throw runnerError('LOCAL_ROLE_REVIEW_EVIDENCE_REQUIRED')
    return { artifactId: artifact.artifactId, evidenceIds }
  }

  actor(message, agentKind) {
    const trace = message?.trace
    if (!trace?.runId || !trace.agentRunId || message.agentKind !== agentKind) {
      throw runnerError('LOCAL_ROLE_REVIEW_TRACE_REQUIRED')
    }
    return {
      kind: 'agent',
      runId: trace.runId,
      agentRunId: trace.agentRunId,
      agentKind,
    }
  }

  reviewPresentationSummary(harnessRun, finding) {
    if (!finding) return ''
    const actor = finding.reviewer
    const rawOutput = String(harnessRun.output || '')
    if (!rawOutput) return ''
    const refs = normalizeOutcomeRefs(harnessRun.context?.outcomeRefs)
    const artifact = (refs.artifactIds || []).map((artifactId) => {
      try { return this.outcomeStore.getArtifact(artifactId) } catch { return null }
    }).find(record => (
      record?.name === `${actor.agentKind}-conclusion.txt`
        && record.producedBy?.runId === actor.runId
        && record.producedBy?.agentRunId === actor.agentRunId
        && record.producedBy?.agentKind === actor.agentKind
        && record.contentRef
        && (() => {
          try {
            return this.contentBlobStore.read(record.contentRef).toString('utf8') === rawOutput
          } catch {
            return false
          }
        })()
    ))
    if (!artifact) return ''
    const hasEvidence = (refs.evidenceIds || []).some((evidenceId) => {
      try {
        const evidence = this.outcomeStore.getEvidence(evidenceId)
        return evidence.subject?.type === 'artifact'
          && evidence.subject.artifactId === artifact.artifactId
          && evidence.refs.some(ref => (
            ref.type === 'artifact' && ref.artifactId === artifact.artifactId
          ))
          && evidence.refs.some(ref => (
            ref.type === 'blob' && ref.contentHash === artifact.contentHash
          ))
      } catch {
        return false
      }
    })
    return hasEvidence ? finding.summary : ''
  }

  replacementInstruction(agentKind) {
    return [
      `You are replacing the ${agentKind} workflow Agent for this node.`,
      'Complete only the interrupted workflow role from the supplied immutable context.',
      'Do not claim that the replaced Agent completed this work.',
    ].join(' ')
  }

  async invokeWorkflowNode({
    call,
    workflow,
    group,
    controller,
    threadRootId,
    prepared,
    invocations,
    reportedFailures,
  }) {
    if (call.groupId !== group.id || call.taskId !== workflow.taskId
        || call.workflowId !== workflow.workflowId) {
      throw runnerError('LOCAL_ROLE_REVIEW_NODE_INVALID')
    }
    const isolated = call.sessionPolicy === 'isolated'
    let executionCall = call
    let runtimeInstruction = ''
    controller.currentKind = executionCall.agentKind
    controller.workflowRole = call.role
    controller.progress = []
    this.emitChanged()
    try {
      while (true) {
        const recovered = await this.invokeWithRecovery({
          group,
          kind: executionCall.agentKind,
          controller,
          activeKinds: controller.targetKinds,
          threadRootId,
          context: {
            taskId: workflow.taskId,
            taskType: executionCall.taskType,
            sessionPolicy: executionCall.sessionPolicy,
            sessionThreadRootId: threadRootId,
            contextPackId: executionCall.contextPackId,
            promptOverride: executionCall.promptOverride,
            runtimeInstruction,
            skillHints: isolated
              ? []
              : (prepared.skillHintsByKind.get(executionCall.agentKind) || []),
            knowledgeBaseHints: isolated
              ? []
              : (prepared.knowledgeBaseHintsByKind.get(executionCall.agentKind) || []),
            attachments: isolated ? [] : prepared.attachments.map(attachment => attachment.path),
            attachmentSnapshots: isolated ? [] : prepared.attachments,
          },
          reportedFailures,
        })
        if (recovered?.control?.action === 'replace') {
          this.recordAgentInterruption(
            group.id,
            executionCall.agentKind,
            recovered.error,
            threadRootId,
            'stopped',
            reportedFailures,
          )
          addUnique(controller.failedKinds, executionCall.agentKind)
          addUnique(controller.completedKinds, executionCall.agentKind)
          const replacedKind = executionCall.agentKind
          executionCall = {
            ...executionCall,
            agentKind: recovered.control.replacementKind,
          }
          runtimeInstruction = this.replacementInstruction(replacedKind)
          controller.currentKind = executionCall.agentKind
          controller.progress = []
          this.emitChanged()
          continue
        }
        if (!recovered?.result) {
          const error = recovered?.error || runnerError('LOCAL_ROLE_REVIEW_AGENT_UNAVAILABLE')
          if (recovered?.control?.action === 'cancel') error.roleReviewControl = 'cancel'
          throw error
        }
        const invocation = recovered.result
        addUnique(controller.completedKinds, executionCall.agentKind)
        const entry = {
          call: executionCall,
          message: invocation.message,
          outcomeRefs: invocation.outcomeRefs,
        }
        invocations.push(entry)
        if (executionCall.role === 'primary') {
          const outcome = this.primaryOutcome(invocation.outcomeRefs)
          entry.primaryOutcome = outcome
          return { status: 'completed', agentKind: executionCall.agentKind, ...outcome }
        }
        return {
          output: invocation.message.content,
          actor: this.actor(invocation.message, executionCall.agentKind),
          agentKind: executionCall.agentKind,
        }
      }
    } catch (error) {
      addUnique(controller.failedKinds, executionCall.agentKind)
      if (controller.signal.aborted || error?.roleReviewControl === 'cancel') {
        this.recordAgentInterruption(
          group.id,
          executionCall.agentKind,
          error,
          threadRootId,
          controller.stopReason === 'shutdown' ? 'interrupted' : 'stopped',
          reportedFailures,
        )
      } else {
        this.recordAgentFailure(
          group.id, executionCall.agentKind, error, threadRootId, reportedFailures,
        )
      }
      throw error
    } finally {
      if (controller.currentKind === executionCall.agentKind) {
        controller.currentKind = ''
        controller.workflowRole = ''
      }
      controller.progress = []
      this.emitChanged()
    }
  }

  resultOutcomeRefs(result, invocations) {
    const primaryOutcomes = invocations.map(entry => entry.primaryOutcome).filter(Boolean)
    return normalizeOutcomeRefs({
      artifactIds: [
        ...primaryOutcomes.map(outcome => outcome.artifactId),
        ...(result.primaryBundle ? [result.primaryBundle.artifactId] : []),
      ],
      evidenceIds: [
        ...primaryOutcomes.flatMap(outcome => outcome.evidenceIds),
        ...(result.primaryBundle?.evidenceIds || []),
      ],
      reviewerFindingIds: result.findingRecords.map(record => record.reviewerFindingId),
      adoptionIds: result.adoptionRecord ? [result.adoptionRecord.adoptionId] : [],
      workflowOutcomeRefs: [result.workflowOutcomeRef],
    })
  }

  backfillOutcomeRefs(group, controller, invocations, refs) {
    const findingsByAgentRunId = new Map()
    for (const reviewerFindingId of normalizeOutcomeRefs(refs).reviewerFindingIds || []) {
      const finding = this.outcomeStore.getReviewerFinding(reviewerFindingId)
      findingsByAgentRunId.set(finding.reviewer.agentRunId, finding)
    }
    const staged = invocations.map((invocation) => {
      const agentRunId = invocation.message?.trace?.agentRunId
      const harnessRun = controller.harness?.agentRuns?.find(
        run => run.agentRunId === agentRunId,
      )
      if (!harnessRun) throw runnerError('LOCAL_ROLE_REVIEW_TRACE_REQUIRED')
      const outcomeRefs = mergeOutcomeRefs(harnessRun.context?.outcomeRefs, refs)
      const context = { ...harnessRun.context, outcomeRefs }
      const trace = traceCapsuleFromAgentRun(harnessRun, {
        runId: controller.runId,
        status: harnessRun.status,
        context,
      })
      const message = this.state().messages.find(candidate => (
        candidate.id === invocation.message.id && candidate.groupId === group.id
      ))
      if (!message || !trace) throw runnerError('LOCAL_ROLE_REVIEW_TRACE_REQUIRED')
      const summary = this.reviewPresentationSummary(
        harnessRun, findingsByAgentRunId.get(agentRunId),
      )
      return {
        invocation,
        harnessRun,
        message,
        outcomeRefs,
        context,
        trace,
        output: summary || harnessRun.output,
        content: summary || message.content,
        previousHarnessContext: harnessRun.context,
        previousHarnessOutput: harnessRun.output,
        previousMessageTrace: message.trace,
        previousMessageContent: message.content,
      }
    })
    const applyHarness = () => {
      for (const entry of staged) {
        entry.harnessRun.context = entry.context
        entry.harnessRun.output = entry.output
      }
    }
    const rollbackHarness = () => {
      for (const entry of staged) {
        entry.harnessRun.context = entry.previousHarnessContext
        entry.harnessRun.output = entry.previousHarnessOutput
      }
    }
    const applyMessages = () => {
      for (const entry of staged) {
        entry.message.trace = entry.trace
        entry.message.content = entry.content
      }
    }
    const rollbackMessages = () => {
      for (const entry of staged) {
        entry.message.trace = entry.previousMessageTrace
        entry.message.content = entry.previousMessageContent
      }
    }

    applyHarness()
    try {
      const persisted = this.checkpointRun(group.id, controller)
      if (this.hasRunLedger() && persisted !== true) {
        throw runnerError('LOCAL_RUN_PERSIST_FAILED')
      }
    } catch (error) {
      rollbackHarness()
      throw error
    }

    rollbackHarness()
    applyMessages()
    try {
      this.save()
    } catch (error) {
      rollbackMessages()
      try { this.checkpointRun(group.id, controller) } catch { /* best-effort compensation */ }
      throw error
    }

    applyHarness()
    for (const entry of staged) {
      entry.invocation.message = entry.message
      entry.invocation.outcomeRefs = entry.outcomeRefs
    }
    try { this.emitChanged() } catch { /* persistence already committed */ }
    return refs
  }

  humanDecisionEvidence(result, primaryEvidenceIds, decision, finalStatus) {
    const summaries = {
      accepted: 'The local user accepted the Artifact after role review.',
      rejected: 'The local user rejected the Artifact after role review.',
      reopened: 'The local user reopened the Task after role review.',
    }
    const refs = [
      ...primaryEvidenceIds.map(evidenceId => ({ type: 'evidence', evidenceId })),
      ...result.findingRecords.map(record => ({
        type: 'reviewer-finding', reviewerFindingId: record.reviewerFindingId,
      })),
    ].slice(0, 64)
    return this.outcomeStore.putEvidence({
      kind: 'human-decision',
      level: 'human-accepted',
      subject: { type: 'artifact', artifactId: result.workflowOutcome.artifactId },
      summary: summaries[finalStatus],
      recordedBy: { kind: 'human', actorId: decision.actorId },
      refs,
    })
  }

  finalizeHumanDecisionFromEvidence(result, primaryEvidenceIds, decision) {
    const selected = DECISIONS[decision?.optionId]
    if (!selected || decision.status !== selected.gateStatus) {
      throw runnerError('LOCAL_ROLE_REVIEW_DECISION_INVALID')
    }
    if (!primaryEvidenceIds.length) throw runnerError('LOCAL_ROLE_REVIEW_EVIDENCE_REQUIRED')
    const humanDecisionEvidence = this.humanDecisionEvidence(
      result, primaryEvidenceIds, decision, selected.status,
    )
    const adoptionRecord = this.outcomeStore.putAdoption({
      artifactId: result.workflowOutcome.artifactId,
      status: selected.status,
      actor: { kind: 'human', actorId: decision.actorId },
      summary: humanDecisionEvidence.summary,
      evidenceIds: [...primaryEvidenceIds, humanDecisionEvidence.evidenceId],
      findingIds: result.findingRecords.map(record => record.reviewerFindingId),
      previousAdoptionId: null,
    })
    const workflowOutcome = createWorkflowOutcome({
      workflowId: result.workflowOutcome.workflowId,
      taskId: result.workflowOutcome.taskId,
      artifactId: result.workflowOutcome.artifactId,
      status: selected.status,
      completedNodeIds: result.completedNodeIds,
      findingIds: result.findingRecords.map(record => record.reviewerFindingId),
      adoptionId: adoptionRecord.adoptionId,
      reviewerContextPackId: result.contextPackIds.reviewer,
      arbiterContextPackId: result.contextPackIds.arbiter,
    })
    const workflowOutcomeRef = this.contentBlobStore.put(
      Buffer.from(serializeWorkflowOutcome(workflowOutcome), 'utf8'),
      { mediaType: 'application/json' },
    )
    return {
      ...result,
      status: 'completed',
      decision: selected.status,
      workflowOutcome,
      workflowOutcomeRef,
      adoptionRecord,
      humanDecisionEvidence,
    }
  }

  primaryEvidenceIds(result, invocations) {
    return [...new Set([
      ...(result.primaryBundle?.evidenceIds || []),
      ...invocations.flatMap(entry => entry.primaryOutcome?.evidenceIds || []),
    ])].slice(0, 63)
  }

  finalizeHumanDecision(result, invocations, decision) {
    const primaryEvidenceIds = this.primaryEvidenceIds(result, invocations)
    return this.finalizeHumanDecisionFromEvidence(result, primaryEvidenceIds, decision)
  }

  resumedHarness(durable) {
    const cloneRun = run => ({
      ...run,
      events: Array.isArray(run.events) ? run.events.map(event => ({ ...event })) : [],
      sourceMessageIds: Array.isArray(run.sourceMessageIds) ? [...run.sourceMessageIds] : [],
      seenSeqs: Array.isArray(run.seenSeqs) ? [...run.seenSeqs] : [],
      context: {
        ...(run.context || {}),
        outcomeRefs: normalizeOutcomeRefs(run.context?.outcomeRefs),
      },
    })
    const agentRuns = (Array.isArray(durable?.agentRuns) ? durable.agentRuns : []).map(cloneRun)
    if (!agentRuns.length) throw runnerError('LOCAL_RUN_CONTINUATION_INVALID')
    return { agentRuns, snapshot: () => agentRuns.map(cloneRun) }
  }

  resumedInvocations(group, harness) {
    const completedRuns = harness.agentRuns.filter(run => ['completed', 'partial'].includes(run.status))
    const invocations = completedRuns.map((run) => {
      const message = this.state().messages.find(candidate => (
        candidate.groupId === group.id
          && candidate.role === 'agent'
          && candidate.trace?.agentRunId === run.agentRunId
      ))
      return message ? { message, outcomeRefs: run.context?.outcomeRefs || {} } : null
    }).filter(Boolean)
    if (!invocations.length || invocations.length !== completedRuns.length) {
      throw runnerError('LOCAL_RUN_CONTINUATION_INVALID')
    }
    return invocations
  }

  resumeDecision(request, decision, resume = null) {
    const workflowOutcome = parseWorkflowOutcome(
      this.contentBlobStore.read(request?.workflowOutcomeRef),
    )
    if (workflowOutcome.status !== 'decision-required'
        || workflowOutcome.workflowId !== request.workflowId
        || workflowOutcome.taskId !== request.taskId
        || workflowOutcome.artifactId !== request.artifactId
        || !Array.isArray(request.findingIds)
        || request.findingIds.some(id => !workflowOutcome.findingIds.includes(id))) {
      throw runnerError('LOCAL_RUN_CONTINUATION_INVALID')
    }
    const findingRecords = workflowOutcome.findingIds.map(
      findingId => this.outcomeStore.getReviewerFinding(findingId),
    )
    const requestedEvidenceIds = Array.isArray(request.primaryEvidenceIds)
      ? request.primaryEvidenceIds
      : findingRecords.flatMap(record => record.evidenceIds)
    const primaryEvidenceIds = [...new Set(requestedEvidenceIds)].slice(0, 63)
    for (const evidenceId of primaryEvidenceIds) this.outcomeStore.getEvidence(evidenceId)
    const finalized = this.finalizeHumanDecisionFromEvidence({
      status: 'decision-required',
      workflowOutcome,
      workflowOutcomeRef: request.workflowOutcomeRef,
      findingRecords,
      adoptionRecord: null,
      completedNodeIds: workflowOutcome.completedNodeIds,
      contextPackIds: {
        reviewer: workflowOutcome.reviewerContextPackId,
        arbiter: workflowOutcome.arbiterContextPackId,
      },
    }, primaryEvidenceIds, decision)
    if (!resume) return finalized
    const { group, controller, durable } = resume
    if (!group || !controller || durable?.runId !== controller.runId) {
      throw runnerError('LOCAL_RUN_CONTINUATION_INVALID')
    }
    controller.harness = this.resumedHarness(durable)
    const invocations = this.resumedInvocations(group, controller.harness)
    const outcomeRefs = normalizeOutcomeRefs({
      artifactIds: [finalized.workflowOutcome.artifactId],
      evidenceIds: [...primaryEvidenceIds, finalized.humanDecisionEvidence.evidenceId],
      reviewerFindingIds: finalized.findingRecords.map(record => record.reviewerFindingId),
      adoptionIds: [finalized.adoptionRecord.adoptionId],
      workflowOutcomeRefs: [request.workflowOutcomeRef, finalized.workflowOutcomeRef],
    })
    this.backfillOutcomeRefs(group, controller, invocations, outcomeRefs)
    return { ...finalized, outcomeRefs }
  }

  async requestDecision(result, invocations, controller) {
    const terminal = invocations.at(-1)?.message?.trace
    if (!terminal?.agentRunId) throw runnerError('LOCAL_ROLE_REVIEW_TRACE_REQUIRED')
    const decision = await this.requestHumanGate({
      type: 'decision',
      runId: controller.runId,
      agentRunId: terminal.agentRunId,
      agentKind: invocations.at(-1).call.agentKind,
      summary: DECISION_GATE_SUMMARY,
      options: DECISION_GATE_OPTIONS,
      request: {
        workflowId: result.workflowOutcome.workflowId,
        taskId: result.workflowOutcome.taskId,
        artifactId: result.workflowOutcome.artifactId,
        findingIds: result.findingRecords.map(record => record.reviewerFindingId),
        primaryEvidenceIds: this.primaryEvidenceIds(result, invocations),
        workflowOutcomeRef: result.workflowOutcomeRef,
      },
    }, {
      signal: controller.signal,
      preserveOnAbort: () => controller.stopReason === 'shutdown',
      continuation: {
        resumeKind: 'role_review_decision',
        agentRunId: terminal.agentRunId,
        agentKind: invocations.at(-1).call.agentKind,
        round: terminal.round || 0,
      },
    })
    const finalized = this.finalizeHumanDecision(result, invocations, decision)
    this.completeHumanGateContinuation(controller.runId, decision.gateId, 'completed')
    return finalized
  }

  async send(input = {}) {
    const workflow = parseWorkflowDefinition(input.workflow)
    if (workflow.template !== 'role-review') {
      throw runnerError('LOCAL_ROLE_REVIEW_TEMPLATE_INVALID')
    }
    const group = this.getGroup(input.groupId)
    const { targetKinds, primaryKinds } = this.validateInput(input, workflow, group)
    const reservation = this.reserveRun(
      group.id, 'manual', targetKinds, workflow.taskId,
    )
    reservation.workflowType = 'role-review'
    let controller = null
    let runStatus = 'failed'
    const reportedFailures = new Set()
    const invocations = []
    try {
      this.configureRunBudget(reservation, input.budget || {})
      const prepared = await this.preflightMessage(primaryKinds, input, reservation)
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
          taskId: workflow.taskId,
          mode: 'manual',
          targetKinds: primaryKinds,
          message: userMessage,
          prepared,
        })
        this.bindRunTask(
          group.id,
          reservation,
          workflow.taskId,
          userMessage.id,
          contextPack.contextPackId,
        )
        controller = this.beginRun(
          group.id, 'manual', targetKinds, userMessage.id, reservation,
        )
      } catch (error) {
        try {
          this.rollbackAddedMessage(group.id, userMessage.id, previousUpdatedAt)
        } catch (rollbackError) {
          if (error && typeof error === 'object') error.rollbackError = rollbackError
        }
        throw error
      }

      const executor = new RoleReviewExecutor({
        contentBlobStore: this.contentBlobStore,
        contextPackStore: this.contextPackStore,
        outcomeStore: this.outcomeStore,
        invokeNode: call => this.invokeWorkflowNode({
          call,
          workflow,
          group,
          controller,
          threadRootId: userMessage.id,
          prepared,
          invocations,
          reportedFailures,
        }),
      })
      let result = await executor.execute({
        workflow,
        groupId: group.id,
        primaryPermissionMode: group.allowWrite ? 'workspace-write' : 'read-only',
        signal: controller.signal,
      })
      let outcomeRefs = this.resultOutcomeRefs(result, invocations)
      this.backfillOutcomeRefs(group, controller, invocations, outcomeRefs)
      if (result.status === 'decision-required') {
        result = await this.requestDecision(result, invocations, controller)
        outcomeRefs = mergeOutcomeRefs(
          outcomeRefs,
          {
            evidenceIds: [result.humanDecisionEvidence.evidenceId],
            adoptionIds: [result.adoptionRecord.adoptionId],
            workflowOutcomeRefs: [result.workflowOutcomeRef],
          },
        )
        this.backfillOutcomeRefs(group, controller, invocations, outcomeRefs)
      }
      runStatus = 'completed'
      return { ...result, runId: controller.runId, outcomeRefs }
    } catch (error) {
      runStatus = terminalRunStatus(controller || reservation, error)
      throw error
    } finally {
      if (controller) {
        controller.currentKind = ''
        controller.progress = []
        this.finishRun(group.id, controller, runStatus)
      } else {
        this.releasePreparation(group.id, reservation)
      }
    }
  }
}

module.exports = {
  DECISION_GATE_OPTIONS,
  DECISION_GATE_SUMMARY,
  LocalWorkspaceRoleReviewRunner,
}
