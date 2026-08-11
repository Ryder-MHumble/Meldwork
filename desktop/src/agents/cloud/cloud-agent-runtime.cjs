const {
  normalizeCloudAgentConnector,
  parseCloudObservation,
  parseCloudSubmitResult,
} = require('./cloud-agent-contract.cjs')
const { CloudAgentOperationStore } = require('./cloud-agent-operation-store.cjs')
const { ContentBlobStore } = require('../../attachments/content-blob-store.cjs')
const { canonicalJson } = require('../../collaboration/outcome-records.cjs')
const {
  createRunEventState,
  parseConnectorRunEvent,
  parseRunEventState,
  reduceRunEvents,
} = require('../../runs/run-event-protocol.cjs')

const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const OPAQUE_REF = /^[A-Za-z0-9][A-Za-z0-9._:+/=\-]{0,239}$/
const MAX_PROMPT_BYTES = 4 * 1024 * 1024
const MAX_SUBMIT_RESULT_BYTES = 4 * 1024 * 1024
const TERMINAL_RUN_STATUSES = new Set([
  'completed', 'partial', 'failed', 'stopped', 'timeout', 'round-limit', 'interrupted',
  'budget-exhausted', 'circuit-breaker',
])
const TERMINAL_EVENT_STATUSES = new Set(['completed', 'partial', 'failed', 'cancelled'])
const REQUIRED_LEDGER_METHODS = [
  'get', 'list', 'checkpoint', 'recoverInterrupted', 'remoteRecoveries', 'reconcileRemote',
]

function runtimeError(code, cause) {
  const error = new Error(code)
  error.code = code
  if (cause) error.cause = cause
  return error
}

function fail(code) {
  throw runtimeError(code)
}

function clone(value) {
  return JSON.parse(canonicalJson(value))
}

function cleanPublicId(value) {
  const text = String(value || '')
  return PUBLIC_ID.test(text) ? text : ''
}

function cleanOpaqueRef(value) {
  const text = String(value || '')
  return OPAQUE_REF.test(text) ? text : ''
}

function connectorEntries(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail('CLOUD_AGENT_CONNECTORS_INVALID')
  return value
}

function eventStatusToLedger(status) {
  if (status === 'waiting_input' || status === 'waiting_permission') return 'waiting'
  if (status === 'cancelled') return 'stopped'
  return status
}

function eventStatusReason(status) {
  if (status === 'waiting_input') return 'cloud_waiting_input'
  if (status === 'waiting_permission') return 'cloud_waiting_permission'
  if (status === 'cancelled') return 'cloud_cancelled'
  return ''
}

function stateSignature(value) {
  return canonicalJson(value)
}

function createCloudAgentStartRetry(options = {}) {
  const runtime = options.runtime
  if (!runtime || typeof runtime.start !== 'function') {
    fail('CLOUD_AGENT_START_RETRY_RUNTIME_REQUIRED')
  }
  const isActive = typeof options.isActive === 'function' ? options.isActive : () => true
  const setTimer = typeof options.setTimer === 'function' ? options.setTimer : setTimeout
  const clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : clearTimeout
  const onError = typeof options.onError === 'function' ? options.onError : () => {}
  const baseDelayMs = Number.isFinite(options.baseDelayMs)
    ? Math.max(1, Math.min(60_000, Math.floor(options.baseDelayMs)))
    : 250
  const maxDelayMs = Number.isFinite(options.maxDelayMs)
    ? Math.max(baseDelayMs, Math.min(300_000, Math.floor(options.maxDelayMs)))
    : Math.max(baseDelayMs, 30_000)
  let cancelled = false
  let succeeded = false
  let failures = 0
  let timer = null
  let inflight = null

  const active = () => {
    if (cancelled) return false
    try { return isActive(runtime) === true } catch { return false }
  }
  const schedule = () => {
    if (!active() || succeeded || timer || inflight) return false
    const delay = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.min(30, failures - 1)))
    const scheduled = setTimer(() => {
      if (timer === scheduled) timer = null
      return attempt()
    }, delay)
    timer = scheduled
    scheduled?.unref?.()
    return true
  }
  const attempt = () => {
    if (!active() || succeeded) return Promise.resolve(succeeded)
    if (inflight) return inflight
    if (timer) return Promise.resolve(false)
    const task = Promise.resolve()
      .then(() => runtime.start())
      .then(() => {
        if (!active()) return false
        succeeded = true
        failures = 0
        return true
      })
      .catch((error) => {
        if (!active()) return false
        failures += 1
        try { onError(error, failures) } catch { /* Retry ownership stays local. */ }
        return false
      })
    inflight = task
    task.finally(() => {
      if (inflight !== task) return
      inflight = null
      if (!succeeded) schedule()
    })
    return task
  }

  return Object.freeze({
    start: attempt,
    cancel() {
      if (cancelled) return
      cancelled = true
      if (timer) clearTimer(timer)
      timer = null
    },
  })
}

class CloudAgentRuntime {
  constructor(options = {}) {
    if (!options.runLedger
        || REQUIRED_LEDGER_METHODS.some(method => typeof options.runLedger[method] !== 'function')) {
      fail('CLOUD_AGENT_RUN_LEDGER_REQUIRED')
    }
    if (!options.outcomeStore
        || typeof options.outcomeStore.putArtifact !== 'function'
        || typeof options.outcomeStore.getArtifact !== 'function'
        || typeof options.outcomeStore.getEvidence !== 'function') {
      fail('CLOUD_AGENT_OUTCOME_STORE_REQUIRED')
    }
    if (!(options.operationStore instanceof CloudAgentOperationStore)) {
      fail('CLOUD_AGENT_OPERATION_STORE_REQUIRED')
    }
    if (!(options.contentBlobStore instanceof ContentBlobStore)) {
      fail('CLOUD_AGENT_CONTENT_BLOB_STORE_REQUIRED')
    }
    this.runLedger = options.runLedger
    this.outcomeStore = options.outcomeStore
    this.operationStore = options.operationStore
    this.contentBlobStore = options.contentBlobStore
    this.recoveryOwnerId = cleanPublicId(options.recoveryOwnerId || 'cloud-agent-runtime')
    if (!this.recoveryOwnerId) fail('CLOUD_AGENT_RECOVERY_OWNER_INVALID')
    this.pollIntervalMs = Number.isFinite(options.pollIntervalMs)
      ? Math.max(1, Math.min(60_000, Math.floor(options.pollIntervalMs)))
      : 1000
    this.shutdownGraceMs = Number.isFinite(options.shutdownGraceMs)
      ? Math.max(1, Math.min(30_000, Math.floor(options.shutdownGraceMs)))
      : 2500
    this.autoObserve = options.autoObserve !== false
    this.setTimer = options.setTimer || setTimeout
    this.clearTimer = options.clearTimer || clearTimeout
    this.connectors = new Map()
    this.timers = new Map()
    this.inflight = new Map()
    this.listeners = new Set()
    this.started = false
    this.stopping = false
    this.ledgerFacade = null
    for (const connector of connectorEntries(options.connectors)) this.registerConnector(connector)
  }

  registerConnector(input) {
    const connector = normalizeCloudAgentConnector(input)
    if (this.started || this.connectors.has(connector.connectorId)) {
      fail('CLOUD_AGENT_CONNECTOR_CONFLICT')
    }
    this.connectors.set(connector.connectorId, connector)
    return connector.snapshot
  }

  connectorIds() {
    return [...this.connectors.keys()].sort()
  }

  workspaceLedger() {
    if (this.ledgerFacade) return this.ledgerFacade
    const runtime = this
    this.ledgerFacade = new Proxy(this.runLedger, {
      get(target, property, receiver) {
        if (property === 'recoverInterrupted') {
          return (options = {}) => {
            const recoveryOptions = options && typeof options === 'object' ? options : {}
            const unresolved = new Set(runtime.operationStore.submissionIntents()
              .filter(operation => !target.get(operation.runId)?.remoteJob)
              .map(operation => operation.runId))
            const preserved = new Map([...unresolved]
              .map(runId => [runId, target.get(runId)])
              .filter(([, record]) => record && !TERMINAL_RUN_STATUSES.has(record.status)))
            const callerPreserve = typeof recoveryOptions.preserveWaitingRun === 'function'
              ? recoveryOptions.preserveWaitingRun
              : () => false
            const changed = target.recoverInterrupted({
              ...recoveryOptions,
              remoteConnectorIds: runtime.connectorIds(),
              recoveryOwnerId: runtime.recoveryOwnerId,
              preserveWaitingRun: record => (
                preserved.has(record.runId) || callerPreserve(record)
              ),
            })
            for (const record of preserved.values()) target.checkpoint(record)
            return changed.filter(record => !preserved.has(record.runId))
          }
        }
        const value = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    return this.ledgerFacade
  }

  subscribe(listener) {
    if (typeof listener !== 'function') fail('CLOUD_AGENT_LISTENER_INVALID')
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  notify(value) {
    const snapshot = clone(value)
    for (const listener of this.listeners) {
      try { listener(snapshot) } catch { /* Observers never own remote execution. */ }
    }
  }

  connectorFor(connectorId) {
    const id = cleanPublicId(connectorId)
    const connector = id ? this.connectors.get(id) : null
    if (!connector) fail('CLOUD_AGENT_CONNECTOR_UNAVAILABLE')
    return connector
  }

  runRecord(runId) {
    const id = cleanPublicId(runId)
    const record = id ? this.runLedger.get(id) : null
    if (!record) fail('CLOUD_AGENT_RUN_NOT_FOUND')
    return record
  }

  cloudAgentRun(record, requestedAgentRunId = '') {
    const agentRunId = cleanPublicId(requestedAgentRunId)
    if (!Array.isArray(record.agentRuns) || record.agentRuns.length !== 1
        || (agentRunId && record.agentRuns[0].agentRunId !== agentRunId)) {
      fail('CLOUD_AGENT_RUN_SHAPE_UNSUPPORTED')
    }
    return record.agentRuns[0]
  }

  eventState(record, connector, agentRun) {
    const stored = agentRun.context?.connectorEventState
    if (stored) {
      const state = parseRunEventState(stored)
      const fields = [
        'connectorId', 'connectorVersion', 'manifestId', 'instanceId',
        'upstreamId', 'upstreamVersion',
      ]
      if (fields.some(field => state[field] !== connector.snapshot[field])) {
        fail('CLOUD_AGENT_CONNECTOR_PROVENANCE_MISMATCH')
      }
      if (state.runId !== record.runId || state.agentRunId !== agentRun.agentRunId) {
        fail('CLOUD_AGENT_RUN_PROVENANCE_MISMATCH')
      }
      return state
    }
    return createRunEventState({
      protocolVersion: connector.snapshot.capabilities.eventProtocolVersion,
      connectorId: connector.snapshot.connectorId,
      connectorVersion: connector.snapshot.connectorVersion,
      manifestId: connector.snapshot.manifestId,
      instanceId: connector.snapshot.instanceId,
      upstreamId: connector.snapshot.upstreamId,
      upstreamVersion: connector.snapshot.upstreamVersion,
      runId: record.runId,
      agentRunId: agentRun.agentRunId,
    })
  }

  checkpointState(record, connector, state, cursor) {
    const agentRun = this.cloudAgentRun(record, state.agentRunId)
    const outcomeRefs = {
      ...(agentRun.context?.outcomeRefs || {}),
      artifactIds: state.artifactIds,
      evidenceIds: state.evidenceIds,
    }
    const updatedAgentRun = {
      ...agentRun,
      status: eventStatusToLedger(state.status),
      context: {
        ...(agentRun.context || {}),
        connector: connector.snapshot,
        connectorEventState: state,
        outcomeRefs,
      },
    }
    const checkpoint = this.runLedger.checkpoint({
      runId: record.runId,
      status: record.status,
      remoteJob: {
        ...record.remoteJob,
        cursor,
      },
      agentRuns: [updatedAgentRun],
    })
    if (TERMINAL_RUN_STATUSES.has(record.status)) return checkpoint
    if (checkpoint.remoteJob?.recoveryOwnerId !== this.recoveryOwnerId) {
      fail('CLOUD_AGENT_RECOVERY_OWNER_INVALID')
    }
    return this.runLedger.reconcileRemote(record.runId, this.recoveryOwnerId, {
      status: eventStatusToLedger(state.status),
      cursor,
      reason: eventStatusReason(state.status),
    })
  }

  async persistArtifacts(connector, record, previousState, nextState) {
    const artifactIds = nextState.artifactIds.filter(id => !previousState.artifactIds.includes(id))
    if (!artifactIds.length) return
    if (typeof connector.fetchArtifacts !== 'function') fail('CLOUD_AGENT_ARTIFACT_FETCH_UNSUPPORTED')
    const records = await connector.fetchArtifacts(Object.freeze({
      runId: record.runId,
      agentRunId: nextState.agentRunId,
      jobId: record.remoteJob.jobId,
      artifactIds: [...artifactIds],
    }))
    if (!Array.isArray(records) || records.length !== artifactIds.length
        || new Set(records.map(item => item?.artifactId)).size !== artifactIds.length
        || artifactIds.some(id => !records.some(item => item?.artifactId === id))) {
      fail('CLOUD_AGENT_ARTIFACT_RESULT_INVALID')
    }
    for (const artifact of records) this.outcomeStore.putArtifact(artifact)
  }

  verifyEvidence(previousState, nextState) {
    for (const evidenceId of nextState.evidenceIds) {
      if (!previousState.evidenceIds.includes(evidenceId)) this.outcomeStore.getEvidence(evidenceId)
    }
  }

  async applyObservation(runId, connectorId, observationInput) {
    const connector = this.connectorFor(connectorId)
    const observation = parseCloudObservation(observationInput)
    const record = this.runRecord(runId)
    if (record.remoteJob?.connectorId !== connector.connectorId) {
      fail('CLOUD_AGENT_REMOTE_JOB_MISMATCH')
    }
    const agentRun = this.cloudAgentRun(record)
    const previousState = this.eventState(record, connector, agentRun)
    const provenance = Object.fromEntries([
      'protocolVersion', 'connectorId', 'connectorVersion', 'manifestId', 'instanceId',
      'upstreamId', 'upstreamVersion', 'runId', 'agentRunId',
    ].map(field => [field, previousState[field]]))
    const events = observation.events.map(event => parseConnectorRunEvent(event, provenance))
    const nextState = reduceRunEvents(previousState, events)
    await this.persistArtifacts(connector, record, previousState, nextState)
    this.verifyEvidence(previousState, nextState)
    const advancesSequence = events.some(event => event.sequence > previousState.lastSequence)
    const cursor = advancesSequence || record.status === 'reconciling'
      ? (observation.cursor || nextState.cursor || record.remoteJob.cursor)
      : record.remoteJob.cursor
    if (!cleanOpaqueRef(cursor)) fail('CLOUD_AGENT_REMOTE_REF_INVALID')
    const expectedLedgerStatus = eventStatusToLedger(nextState.status)
    if (TERMINAL_RUN_STATUSES.has(record.status) && record.status !== expectedLedgerStatus) {
      fail('CLOUD_AGENT_RUN_STATE_MISMATCH')
    }
    let updated = record
    if (stateSignature(nextState) !== stateSignature(previousState)
        || cursor !== record.remoteJob.cursor || record.status === 'reconciling'
        || record.status !== expectedLedgerStatus) {
      updated = this.checkpointState(record, connector, nextState, cursor)
      this.notify(this.publicSnapshot(updated))
    }
    return updated
  }

  publicSnapshot(recordInput) {
    const record = typeof recordInput === 'string' ? this.runRecord(recordInput) : recordInput
    const agentRun = this.cloudAgentRun(record)
    const connector = record.remoteJob?.connectorId
      ? this.connectorFor(record.remoteJob.connectorId)
      : null
    const state = connector ? this.eventState(record, connector, agentRun) : null
    let waiting = null
    if (state?.status === 'waiting_input') {
      const event = [...state.events].reverse().find(item => item.type === 'WaitingInput')
      if (event) waiting = { type: 'input', requestId: event.requestId, prompt: event.prompt }
    } else if (state?.status === 'waiting_permission') {
      const event = [...state.events].reverse().find(item => (
        item.type === 'Permission' && item.decision === 'requested'
      ))
      if (event) waiting = {
        type: 'permission', requestId: event.requestId,
        permission: event.permission, summary: event.summary || '',
      }
    }
    return {
      runId: record.runId,
      agentRunId: agentRun.agentRunId,
      status: state?.status || record.status,
      connectorId: record.remoteJob?.connectorId || '',
      jobId: record.remoteJob?.jobId || '',
      cursor: record.remoteJob?.cursor || '',
      artifactIds: state?.artifactIds || [],
      evidenceIds: state?.evidenceIds || [],
      waiting,
    }
  }

  readTextBlob(ref, errorCode) {
    let bytes
    try {
      bytes = this.contentBlobStore.read(ref)
    } catch (error) {
      throw runtimeError(errorCode, error)
    }
    const value = bytes.toString('utf8')
    if (!value || value.includes('\u0000') || !Buffer.from(value, 'utf8').equals(bytes)) fail(errorCode)
    return value
  }

  readSubmitResult(operation) {
    let parsed
    try {
      parsed = JSON.parse(this.readTextBlob(
        operation.payload.resultRef,
        'CLOUD_AGENT_SUBMIT_RESULT_INVALID',
      ))
    } catch (error) {
      if (error?.code === 'CLOUD_AGENT_SUBMIT_RESULT_INVALID') throw error
      throw runtimeError('CLOUD_AGENT_SUBMIT_RESULT_INVALID', error)
    }
    const result = parseCloudSubmitResult(parsed)
    if (result.jobId !== operation.jobId) fail('CLOUD_AGENT_REMOTE_JOB_MISMATCH')
    return result
  }

  persistSubmitResult(operation, result) {
    const serialized = canonicalJson(result)
    if (Buffer.byteLength(serialized) > MAX_SUBMIT_RESULT_BYTES) {
      fail('CLOUD_AGENT_SUBMIT_RESULT_INVALID')
    }
    const resultRef = this.contentBlobStore.put(serialized, { mediaType: 'application/json' })
    return this.operationStore.recordSubmitResult(operation.operationId, {
      jobId: result.jobId,
      resultRef,
    })
  }

  async applySubmission(operation, result) {
    const connector = this.connectorFor(operation.connectorId)
    let record = this.runRecord(operation.runId)
    const agentRun = this.cloudAgentRun(record, operation.agentRunId)
    const cursor = result.cursor || result.jobId
    if (record.remoteJob) {
      if (record.remoteJob.connectorId !== connector.connectorId
          || record.remoteJob.jobId !== result.jobId) {
        fail('CLOUD_AGENT_REMOTE_JOB_MISMATCH')
      }
    } else {
      if (TERMINAL_RUN_STATUSES.has(record.status)) fail('CLOUD_AGENT_RUN_ALREADY_SUBMITTED')
      const state = this.eventState(record, connector, agentRun)
      record = this.runLedger.checkpoint({
        runId: record.runId,
        status: 'running',
        remoteJob: {
          connectorId: connector.connectorId,
          jobId: result.jobId,
          cursor,
          recoveryOwnerId: this.recoveryOwnerId,
        },
        agentRuns: [{
          ...agentRun,
          status: 'running',
          context: {
            ...(agentRun.context || {}),
            connector: connector.snapshot,
            connectorEventState: state,
          },
        }],
      })
    }
    if (result.events.length) {
      record = await this.applyObservation(record.runId, connector.connectorId, {
        cursor,
        events: result.events,
      })
    }
    this.operationStore.update(operation.operationId, 'delivered')
    return this.publicSnapshot(record)
  }

  async replaySubmission(operation) {
    let current = operation
    const connector = this.connectorFor(current.connectorId)
    const record = this.runRecord(current.runId)
    this.cloudAgentRun(record, current.agentRunId)
    if (current.state === 'pending') {
      if (TERMINAL_RUN_STATUSES.has(record.status) && !record.remoteJob) {
        fail('CLOUD_AGENT_RUN_ALREADY_SUBMITTED')
      }
      const prompt = this.readTextBlob(current.payload.promptRef, 'CLOUD_AGENT_SUBMIT_INVALID')
      if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) fail('CLOUD_AGENT_SUBMIT_INVALID')
      const result = parseCloudSubmitResult(await connector.submit(Object.freeze({
        runId: current.runId,
        agentRunId: current.agentRunId,
        prompt,
        permissionMode: current.payload.permissionMode,
        idempotencyKey: current.operationId,
      })))
      current = this.persistSubmitResult(current, result)
    }
    return this.applySubmission(current, this.readSubmitResult(current))
  }

  async submit(input = {}) {
    const runId = cleanPublicId(input.runId)
    const agentRunId = cleanPublicId(input.agentRunId)
    const connector = this.connectorFor(input.connectorId)
    const prompt = String(input.prompt || '')
    const permissionMode = input.permissionMode === 'workspace-write' ? 'workspace-write' : 'read-only'
    if (!runId || !agentRunId || !prompt || prompt.includes('\u0000')
        || Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) {
      fail('CLOUD_AGENT_SUBMIT_INVALID')
    }
    const record = this.runRecord(runId)
    const unresolved = this.operationStore.submissionIntents()
      .find(operation => operation.runId === runId)
    if ((TERMINAL_RUN_STATUSES.has(record.status) || record.remoteJob) && !unresolved) {
      fail('CLOUD_AGENT_RUN_ALREADY_SUBMITTED')
    }
    this.cloudAgentRun(record, agentRunId)
    if (unresolved && (
      unresolved.agentRunId !== agentRunId
      || unresolved.connectorId !== connector.connectorId
      || unresolved.payload.permissionMode !== permissionMode
      || this.readTextBlob(unresolved.payload.promptRef, 'CLOUD_AGENT_SUBMIT_INVALID') !== prompt
    )) fail('CLOUD_AGENT_OPERATION_CONFLICT')
    const promptRef = unresolved?.payload.promptRef
      || this.contentBlobStore.put(prompt, { mediaType: 'text/plain' })
    const operation = this.operationStore.put({
      type: 'submit',
      runId,
      agentRunId,
      connectorId: connector.connectorId,
      jobId: '',
      requestId: '',
      payload: { promptRef, permissionMode },
    })
    const snapshot = await this.replaySubmission(operation)
    this.notify(snapshot)
    if (this.autoObserve && !TERMINAL_EVENT_STATUSES.has(snapshot.status)) this.schedule(runId, 0)
    return snapshot
  }

  async observeNow(runId, options = {}) {
    const id = cleanPublicId(runId)
    if (!id) fail('CLOUD_AGENT_RUN_NOT_FOUND')
    if (this.inflight.has(id)) return this.inflight.get(id)
    const task = (async () => {
      const record = this.runRecord(id)
      if (TERMINAL_RUN_STATUSES.has(record.status)) return this.publicSnapshot(record)
      if (record.remoteJob?.recoveryOwnerId !== this.recoveryOwnerId) {
        fail('CLOUD_AGENT_RECOVERY_OWNER_INVALID')
      }
      const connector = this.connectorFor(record.remoteJob.connectorId)
      const method = options.reconcile === true && typeof connector.reconcile === 'function'
        ? connector.reconcile
        : connector.observe
      const controller = new AbortController()
      this.inflight.set(`${id}:abort`, controller)
      try {
        const observation = await method(Object.freeze({
          runId: record.runId,
          agentRunId: this.cloudAgentRun(record).agentRunId,
          jobId: record.remoteJob.jobId,
          cursor: record.remoteJob.cursor,
          signal: controller.signal,
        }))
        const updated = await this.applyObservation(id, connector.connectorId, observation)
        return this.publicSnapshot(updated)
      } finally {
        this.inflight.delete(`${id}:abort`)
      }
    })()
    this.inflight.set(id, task)
    try {
      return await task
    } finally {
      this.inflight.delete(id)
    }
  }

  schedule(runId, delay = this.pollIntervalMs, reconcile = false) {
    if (!this.autoObserve || this.stopping || this.timers.has(runId)) return
    const timer = this.setTimer(async () => {
      this.timers.delete(runId)
      try {
        const snapshot = await this.observeNow(runId, { reconcile })
        if (snapshot.status === 'running') this.schedule(runId)
      } catch (error) {
        this.notify({ runId, status: 'observe_error', code: error?.code || error?.message || 'CLOUD_AGENT_OBSERVE_FAILED' })
        if (!this.stopping) this.schedule(runId)
      }
    }, delay)
    timer?.unref?.()
    this.timers.set(runId, timer)
  }

  async handleCallback(connectorId, jobId, observation) {
    const connector = this.connectorFor(connectorId)
    const remoteJobId = cleanOpaqueRef(jobId)
    const record = this.runLedger.list().find(item => (
      item.remoteJob?.connectorId === connector.connectorId
      && item.remoteJob?.jobId === remoteJobId
    ))
    if (!record) fail('CLOUD_AGENT_RUN_NOT_FOUND')
    const updated = await this.applyObservation(record.runId, connector.connectorId, observation)
    const snapshot = this.publicSnapshot(updated)
    if (snapshot.status === 'running') this.schedule(record.runId)
    return snapshot
  }

  waitingEvent(record, expectedType, requestId) {
    const connector = this.connectorFor(record.remoteJob?.connectorId)
    const state = this.eventState(record, connector, this.cloudAgentRun(record))
    const event = [...state.events].reverse().find(item => (
      expectedType === 'input'
        ? item.type === 'WaitingInput' && item.requestId === requestId
        : item.type === 'Permission' && item.decision === 'requested'
          && item.requestId === requestId
    ))
    if (!event || state.status !== (expectedType === 'input' ? 'waiting_input' : 'waiting_permission')) {
      fail('CLOUD_AGENT_REQUEST_NOT_PENDING')
    }
    return { connector, state, event }
  }

  async deliverOperation(record, operation) {
    if (operation.type === 'submit') fail('CLOUD_AGENT_OPERATION_INVALID')
    const connector = this.connectorFor(operation.connectorId)
    const method = operation.type === 'input'
      ? connector.provideInput
      : operation.type === 'permission'
        ? connector.decidePermission
        : connector.cancel
    if (typeof method !== 'function') fail('CLOUD_AGENT_ACTION_UNSUPPORTED')
    await method(Object.freeze({
      runId: record.runId,
      agentRunId: this.cloudAgentRun(record).agentRunId,
      jobId: operation.jobId,
      idempotencyKey: operation.operationId,
      ...(operation.type === 'input'
        ? { requestId: operation.requestId, input: operation.payload.value }
        : operation.type === 'permission'
          ? { requestId: operation.requestId, decision: operation.payload.decision }
          : {}),
    }))
    this.operationStore.update(operation.operationId, 'delivered')
  }

  async provideInput(runId, requestId, value) {
    const record = this.runRecord(runId)
    const id = cleanPublicId(requestId)
    this.waitingEvent(record, 'input', id)
    const operation = this.operationStore.put({
      type: 'input',
      runId: record.runId,
      connectorId: record.remoteJob.connectorId,
      jobId: record.remoteJob.jobId,
      requestId: id,
      payload: { value },
    })
    if (operation.state === 'pending') await this.deliverOperation(record, operation)
    this.schedule(record.runId, 0)
    return this.publicSnapshot(this.runRecord(record.runId))
  }

  async decidePermission(runId, requestId, decision) {
    const record = this.runRecord(runId)
    const id = cleanPublicId(requestId)
    this.waitingEvent(record, 'permission', id)
    const operation = this.operationStore.put({
      type: 'permission',
      runId: record.runId,
      connectorId: record.remoteJob.connectorId,
      jobId: record.remoteJob.jobId,
      requestId: id,
      payload: { decision },
    })
    if (operation.state === 'pending') await this.deliverOperation(record, operation)
    this.schedule(record.runId, 0)
    return this.publicSnapshot(this.runRecord(record.runId))
  }

  async cancel(runId) {
    const record = this.runRecord(runId)
    if (TERMINAL_RUN_STATUSES.has(record.status)) return false
    const connector = this.connectorFor(record.remoteJob?.connectorId)
    if (typeof connector.cancel !== 'function') fail('CLOUD_AGENT_CANCEL_UNSUPPORTED')
    const existing = this.operationStore.list().find(item => (
      item.type === 'cancel'
      && item.runId === record.runId
      && item.connectorId === record.remoteJob.connectorId
      && item.jobId === record.remoteJob.jobId
    ))
    if (existing) return false
    const operation = this.operationStore.put({
      type: 'cancel',
      runId: record.runId,
      connectorId: record.remoteJob.connectorId,
      jobId: record.remoteJob.jobId,
      requestId: '',
      payload: {},
    }, 'dispatched')
    await this.deliverOperation(record, operation)
    this.schedule(record.runId, 0)
    return true
  }

  async replayPending(record) {
    for (const operation of this.operationStore.pendingForRun(record.runId)) {
      if (operation.type === 'submit') continue
      await this.deliverOperation(record, operation)
    }
  }

  async start() {
    if (this.started) return this.runLedger.remoteRecoveries(this.recoveryOwnerId)
    this.started = true
    this.stopping = false
    try {
      for (const operation of this.operationStore.submissionIntents()) {
        this.notify(await this.replaySubmission(operation))
      }
      this.runLedger.recoverInterrupted({
        remoteConnectorIds: this.connectorIds(),
        recoveryOwnerId: this.recoveryOwnerId,
      })
      const recoveries = this.runLedger.remoteRecoveries(this.recoveryOwnerId)
      for (const claim of recoveries) {
        const record = this.runRecord(claim.runId)
        await this.replayPending(record)
        this.schedule(claim.runId, 0, true)
      }
      return recoveries.map(clone)
    } catch (error) {
      await this.shutdown()
      throw error
    }
  }

  async shutdown() {
    this.stopping = true
    this.started = false
    for (const timer of this.timers.values()) this.clearTimer(timer)
    this.timers.clear()
    for (const [key, controller] of this.inflight.entries()) {
      if (String(key).endsWith(':abort')) controller.abort()
    }
    const pending = [...this.inflight.entries()]
      .filter(([key]) => !String(key).endsWith(':abort'))
      .map(([, task]) => task)
    if (pending.length) {
      await new Promise((resolve) => {
        let settled = false
        let timer = null
        const finish = () => {
          if (settled) return
          settled = true
          if (timer) clearTimeout(timer)
          resolve()
        }
        Promise.allSettled(pending).then(finish)
        timer = setTimeout(finish, this.shutdownGraceMs)
      })
    }
    this.inflight.clear()
  }
}

module.exports = { CloudAgentRuntime, createCloudAgentStartRetry }
