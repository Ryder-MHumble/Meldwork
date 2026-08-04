const { randomUUID } = require('node:crypto')
const {
  nextSessionMeta,
  normalizeSessionMeta,
  shouldRotateSession,
} = require('./run-harness.cjs')
const {
  HERMES_WORKSPACE_ACP_ENABLED,
  MAX_MESSAGE_ATTACHMENTS,
  abortableOperation,
  agentStoppedError,
  cleanText,
  cleanProgressSteps,
  credentialFailure,
  normalizeAttachmentMetadata,
  parseAutoReply,
  settleWithin,
} = require('./local-workspace-inputs.cjs')

class LocalWorkspaceAgentInvocation {
  constructor(options) {
    this.state = options.state
    this.detectedAgents = options.detectedAgents
    this.activeRuns = options.activeRuns
    this.runAgentTimeoutMs = options.runAgentTimeoutMs
    this.runAbortGraceMs = options.runAbortGraceMs
    this.captureAgentOutputs = options.captureAgentOutputs
    this.runAgent = options.runAgent
    this.importAgentOutputs = options.importAgentOutputs
    this.sessionKey = options.sessionKey
    this.sessionRef = options.sessionRef
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
    this.persistSessionRef = options.persistSessionRef
    this.persistSessionMeta = options.persistSessionMeta
    this.markRuntimeCredential = options.markRuntimeCredential
    this.addMessage = options.addMessage
  }

  async invoke(group, kind, mode, signal, threadRootId = '', context = {}) {
    const agent = this.detectedAgents().find(item => item.kind === kind && item.available)
    if (!agent) throw new Error('LOCAL_AGENT_UNAVAILABLE')
    const key = this.sessionKey(group.id, kind)
    const state = this.state()
    const storedSessionRef = String(state.sessions[key] || '')
    const activeRun = this.activeRuns.get(group.id)
    const round = mode === 'auto' ? (activeRun?.currentRound || 1) : 0
    let sessionRef = this.sessionRef(
      group, kind, context.sessionThreadRootId || threadRootId,
    )
    const sessionMeta = normalizeSessionMeta(state.sessionMeta[key])
    let sessionRotated = false
    if (sessionRef && shouldRotateSession(sessionMeta)) {
      delete state.sessions[key]
      if (kind === 'openclaw') {
        const generation = randomUUID().replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'session'
        sessionRef = this.openClawSessionRef(group, generation)
        state.sessions[key] = sessionRef
      } else {
        sessionRef = ''
      }
      sessionRotated = true
      this.save()
    }
    let sessionTransport = sessionRef ? String(sessionMeta.transport || '') : ''
    const hermesNeedsLegacy = kind === 'hermes' && sessionTransport === 'acp'
      && (!HERMES_WORKSPACE_ACP_ENABLED
        || agent.acpAvailable === false
        || (context.attachments || []).length > 0
        || (context.skillHints || []).length > 0)
    if (sessionRef && hermesNeedsLegacy) {
      delete state.sessions[key]
      sessionRef = ''
      sessionTransport = ''
      sessionRotated = true
      this.save()
    }
    let transcriptAfterKind = !sessionRotated && storedSessionRef && storedSessionRef === sessionRef
      ? kind
      : ''
    let packedContext = this.packedPromptContext(group.id, transcriptAfterKind, threadRootId)
    const harness = this.ensureRunHarness(group, activeRun, threadRootId)
    const harnessRun = harness?.beginAgent(kind, round, packedContext.sourceMessageIds)
    if (harnessRun) {
      const liveHarnessRun = harness.current(kind, round, harnessRun.agentRunId)
      if (liveHarnessRun) {
        liveHarnessRun.context = { ...packedContext.context, sessionRotated }
      }
      this.emitRunEvent(harnessRun)
      this.armAgentSilence(activeRun, kind, round, harnessRun.agentRunId)
      this.checkpointRun(group.id, activeRun)
      this.emitChanged()
    }
    const agentController = new AbortController()
    let watchdogTimedOut = false
    let watchdogError = null
    let parentAbortObserved = false
    let agentCallbacksClosed = false
    let watchdogTimer = null
    let watchdogPromise = null
    let parentAbortHandler = null
    let parentAbortPromise = null
    let capturePromise = null
    let runPromise = null
    let importPromise = null
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
    watchdogPromise = new Promise((_, reject) => {
      watchdogTimer = setTimeout(() => {
        if (parentAbortObserved || signal?.aborted) return
        watchdogTimedOut = true
        watchdogError = new Error('LOCAL_AGENT_TIMEOUT')
        agentController.abort()
        reject(watchdogError)
      }, this.runAgentTimeoutMs)
    })
    watchdogPromise.catch(() => {})
    const onProgress = (step) => {
      if (agentCallbacksClosed || agentController.signal.aborted
          || !activeRun || this.activeRuns.get(group.id) !== activeRun
          || activeRun.currentKind !== kind) return
      const next = [...(activeRun.progress || [])]
      const progressId = typeof step?.id === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(step.id)
        ? step.id
        : ''
      const existingIndex = progressId
        ? next.findIndex(item => item?.id === progressId)
        : -1
      if (existingIndex >= 0) next[existingIndex] = { ...step, id: progressId }
      else next.push(progressId ? { ...step, id: progressId } : step)
      activeRun.progress = next.slice(-8)
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
    let result
    let harnessFinished = false
    const finishHarness = (status, finalText = '') => {
      if (!harness || !harnessRun || harnessFinished) return null
      flushRuntimeEvent()
      agentCallbacksClosed = true
      this.clearAgentSilence(activeRun, kind, round, harnessRun.agentRunId)
      const finished = harness.finishAgent(kind, round, status, finalText, {
        ...packedContext.context,
        sessionRotated,
      }, harnessRun.agentRunId)
      harnessFinished = true
      this.emitRunEvent(finished.event)
      this.checkpointRun(group.id, activeRun)
      this.emitChanged()
      return finished.capsule
    }
    try {
      if (group.allowWrite) {
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
      }
      const runtimeInstruction = cleanText(context.runtimeInstruction, 3000)
      const buildPrompt = (afterKind, contextPackage) => [
        this.promptFor(
          group, kind, mode, threadRootId, context.skillHints || [],
          context.knowledgeBaseHints || [], afterKind, contextPackage,
        ),
        runtimeInstruction ? `Harness recovery task:\n${runtimeInstruction}` : '',
      ].filter(Boolean).join('\n')
      let prompt = buildPrompt(transcriptAfterKind, packedContext)
      if (agentController.signal.aborted) throw agentStoppedError()
      runPromise = Promise.resolve().then(() => this.runAgent(
        agent,
        prompt,
        group.workdir,
        {
          sessionRef,
          onSessionRef: (nextSessionRef, metadata = {}) => {
            if (agentCallbacksClosed || agentController.signal.aborted) return
            this.persistSessionRef(key, nextSessionRef)
            const transport = ['legacy', 'acp'].includes(metadata?.transport)
              ? metadata.transport
              : ''
            if (transport) {
              sessionTransport = transport
              this.persistSessionMeta(key, {
                ...normalizeSessionMeta(state.sessionMeta[key]),
                transport,
              })
            }
          },
          onSessionInvalidated: () => {
            if (kind !== 'hermes') return null
            delete state.sessions[key]
            delete state.sessionMeta[key]
            sessionRef = ''
            sessionTransport = ''
            transcriptAfterKind = ''
            sessionRotated = true
            packedContext = this.packedPromptContext(group.id, '', threadRootId)
            const liveHarnessRun = harness?.current(
              kind, round, harnessRun?.agentRunId || '',
            )
            if (liveHarnessRun) {
              liveHarnessRun.sourceMessageIds = [...packedContext.sourceMessageIds]
              liveHarnessRun.context = { ...packedContext.context, sessionRotated }
            }
            prompt = buildPrompt('', packedContext)
            this.save()
            this.scheduleRunCheckpoint(group.id, activeRun)
            this.emitChanged()
            return { prompt }
          },
          signal: agentController.signal,
          sandbox: group.allowWrite ? 'workspace-write' : undefined,
          onProgress,
          onEvent: emitRuntimeEvent,
          sessionTransport,
          attachments: context.attachments || [],
          ...(kind === 'hermes'
            ? {
                hermesAcpAvailable: HERMES_WORKSPACE_ACP_ENABLED && agent.acpAvailable !== false,
                skills: (context.skillHints || []).map(skill => skill.slug),
              }
            : {}),
        },
      ))
      runPromise.catch(() => {})
      const pending = [runPromise, watchdogPromise]
      if (parentAbortPromise) pending.push(parentAbortPromise)
      result = await Promise.race(pending)
      if (agentController.signal.aborted) throw agentStoppedError()
      this.markRuntimeCredential(kind, 'ready')

      if (!watchdogTimedOut && !agentController.signal.aborted) {
        this.persistSessionRef(key, result.sessionRef)
      }
      const reply = mode === 'auto'
        ? parseAutoReply(result.text)
        : { text: result.text, consensus: false }
      if (!reply.text) throw new Error('LOCAL_AGENT_EMPTY_RESPONSE')
      const progress = activeRun?.progress?.length ? activeRun.progress : result.progress
      const toolCalls = cleanProgressSteps(progress).map(step => ({
        ...step,
        status: step.status === 'in_progress' ? 'completed' : step.status,
      }))
      if (activeRun) activeRun.progress = toolCalls
      let attachments = []
      if (group.allowWrite) {
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
      const finalStatus = result.completed === false ? 'partial' : 'completed'
      const trace = finishHarness(finalStatus, reply.text)
      const message = this.addMessage(
        group.id,
        'agent',
        reply.text,
        kind,
        threadRootId,
        null,
        { elapsedMs: Date.now() - startedAt, toolCalls, attachments, trace },
      )
      this.persistSessionMeta(key, nextSessionMeta(sessionMeta, {
        promptChars: buildPrompt(transcriptAfterKind, packedContext).length,
        replyChars: reply.text.length,
        rotated: sessionRotated,
        transport: sessionTransport,
      }))
      return { message, consensus: reply.consensus && result.completed !== false }
    } catch (caughtError) {
      const parentTimedOut = Boolean(signal?.aborted && activeRun?.stopReason === 'timeout')
      const parentStopped = Boolean(signal?.aborted || parentAbortObserved)
      const parentInterrupted = parentStopped && activeRun?.stopReason === 'shutdown'
      if (parentStopped || watchdogTimedOut) {
        const cleanupPromises = [capturePromise, runPromise, importPromise].filter(Boolean)
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
              : 'failed'
      const trace = finishHarness(status)
      if (trace && error && (typeof error === 'object' || typeof error === 'function')) {
        Object.defineProperty(error, 'runTrace', {
          value: trace,
          enumerable: false,
          configurable: true,
        })
      }
      throw error
    } finally {
      agentCallbacksClosed = true
      clearTimeout(watchdogTimer)
      watchdogTimer = null
      if (signal && parentAbortHandler) {
        signal.removeEventListener('abort', parentAbortHandler)
      }
    }
  }

  resetSession(group, kind, rotateOpenClaw = true) {
    const state = this.state()
    const key = this.sessionKey(group.id, kind)
    const legacyPrefix = `${group.id}:${kind}:thread:`
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
      state.sessions[key] = this.openClawSessionRef(group, generation)
      changed = true
    }
    if (changed) this.save()
    return changed
  }
}

module.exports = { LocalWorkspaceAgentInvocation }
