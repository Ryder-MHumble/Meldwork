const crypto = require('node:crypto')

const { canonicalJson } = require('./outcome-records.cjs')
const {
  createRunEventState,
  parseConnectorRunEvent,
  reduceRunEvent,
} = require('./run-event-protocol.cjs')

const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const SHA256 = /^[a-f0-9]{64}$/
const MAX_PROMPT_BYTES = 4 * 1024 * 1024
const MAX_INPUT_RESPONSE_BYTES = 128 * 1024

function runtimeError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function fail(code) {
  throw runtimeError(code)
}

function clone(value) {
  return JSON.parse(canonicalJson(value))
}

function normalizeResume(input) {
  if (input == null) return null
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('AGENT_CONNECTOR_RESUME_INVALID')
  }
  const type = String(input.type || '')
  const requestId = String(input.requestId || '')
  const requestHash = String(input.requestHash || '')
  const sessionRefHash = String(input.sessionRefHash || '')
  const sessionProvenanceHash = String(input.sessionProvenanceHash || '')
  if (!['input', 'permission'].includes(type) || !PUBLIC_ID.test(requestId)
      || !SHA256.test(requestHash) || !SHA256.test(sessionRefHash)
      || !SHA256.test(sessionProvenanceHash)) {
    fail('AGENT_CONNECTOR_RESUME_INVALID')
  }
  if (type === 'input') {
    const response = String(input.response || '').trim()
    if (!response || Buffer.byteLength(response) > MAX_INPUT_RESPONSE_BYTES) {
      fail('AGENT_CONNECTOR_RESUME_INVALID')
    }
    return Object.freeze({
      type, requestId, requestHash, sessionRefHash, sessionProvenanceHash, response,
    })
  }
  const status = String(input.status || '')
  const optionId = String(input.optionId || '')
  if (!['approved', 'rejected'].includes(status) || !PUBLIC_ID.test(optionId)) {
    fail('AGENT_CONNECTOR_RESUME_INVALID')
  }
  return Object.freeze({
    type, requestId, requestHash, sessionRefHash, sessionProvenanceHash, status, optionId,
  })
}

function recipeEntries(value) {
  if (value instanceof Map) return [...value.entries()]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.entries(value)
}

function uiEventId(eventId) {
  return `connector-${crypto.createHash('sha256').update(eventId).digest('hex').slice(0, 16)}`
}

function usageSummary(usage) {
  return Object.entries(usage || {})
    .filter(([, value]) => Number.isSafeInteger(value) && value >= 0)
    .map(([field, value]) => `${field}=${value}`)
    .join(', ')
    .slice(0, 800)
}

function harnessEvent(event) {
  const base = { id: uiEventId(event.eventId) }
  if (event.type === 'Permission') {
    return {
      ...base,
      type: 'warning',
      status: event.decision === 'requested' ? 'waiting' : 'completed',
      title: 'connector_permission',
      summary: event.summary || `${event.permission}: ${event.decision}`,
    }
  }
  if (event.type === 'SourceUsed') {
    return {
      ...base,
      type: 'tool_result_summary',
      status: 'completed',
      title: 'connector_source_used',
      summary: event.citation || `${event.sourceType}: ${event.sourceId}`,
    }
  }
  if (event.type === 'Artifact' || event.type === 'Evidence') {
    const reference = event.type === 'Artifact' ? event.artifactId : event.evidenceId
    return {
      ...base,
      type: 'tool_result_summary',
      status: 'completed',
      title: event.type === 'Artifact' ? 'connector_artifact' : 'connector_evidence',
      summary: reference,
    }
  }
  if (event.type === 'Usage') {
    return {
      ...base,
      type: 'tool_update',
      status: 'running',
      title: 'connector_usage',
      summary: usageSummary(event.usage),
    }
  }
  if (event.type === 'WaitingInput') {
    return {
      ...base,
      type: 'warning',
      status: 'waiting',
      title: 'connector_waiting_input',
      summary: event.prompt,
    }
  }
  if (event.type === 'Completed') {
    return {
      ...base,
      type: 'status',
      status: event.outcome,
      title: 'connector_completed',
      summary: event.summary || '',
    }
  }
  if (event.type === 'Failed') {
    return {
      ...base,
      type: 'warning',
      status: 'failed',
      title: 'connector_failed',
      summary: event.summary || `${event.category}: ${event.code}`,
    }
  }
  if (event.type === 'Cancelled') {
    return {
      ...base,
      type: 'warning',
      status: 'stopped',
      title: 'connector_cancelled',
      summary: event.summary || event.reason,
    }
  }
  return {
    ...base,
    type: 'warning',
    status: 'running',
    title: 'connector_unknown_event',
    summary: event.summary,
  }
}

class AgentConnectorRuntime {
  constructor(options = {}) {
    if (!options.registry
        || typeof options.registry.resolveExecution !== 'function'
        || typeof options.registry.runSnapshot !== 'function'
        || typeof options.registry.listInstances !== 'function') {
      fail('AGENT_CONNECTOR_RUNTIME_REGISTRY_REQUIRED')
    }
    this.registry = options.registry
    this.recipes = new Map()
    for (const [recipeId, handler] of recipeEntries(options.recipes)) {
      this.registerRecipe(recipeId, handler)
    }
  }

  registerRecipe(recipeId, handler) {
    if (!PUBLIC_ID.test(String(recipeId || '')) || typeof handler !== 'function') {
      fail('AGENT_CONNECTOR_RECIPE_INVALID')
    }
    if (this.recipes.has(recipeId)) fail('AGENT_CONNECTOR_RECIPE_CONFLICT')
    this.recipes.set(recipeId, handler)
    return this
  }

  detectAgents() {
    return this.registry.listInstances().map((instance) => {
      const { manifest } = this.registry.resolveInstance(instance.instanceId)
      return Object.freeze({
        kind: instance.instanceId,
        name: instance.label,
        label: instance.label,
        version: instance.upstreamVersion,
        installed: true,
        custom: true,
        compatibilityState: 'compatible',
        connectorInstanceId: instance.instanceId,
        connectorId: manifest.connectorId,
        connectorVersion: manifest.connectorVersion,
        upstreamVersion: instance.upstreamVersion,
        acpAvailable: manifest.transport.type === 'acp',
        idempotencyMode: manifest.invocation.idempotencyMode || 'none',
      })
    })
  }

  async run(agent, prompt, workdir, options = {}) {
    const instanceId = String(agent?.connectorInstanceId || '')
    const runId = String(options.runId || '')
    const agentRunId = String(options.agentRunId || '')
    if (!PUBLIC_ID.test(instanceId) || !PUBLIC_ID.test(runId) || !PUBLIC_ID.test(agentRunId)) {
      fail('AGENT_CONNECTOR_RUN_ID_INVALID')
    }
    const promptText = String(prompt || '')
    if (!promptText || promptText.includes('\u0000')
        || Buffer.byteLength(promptText) > MAX_PROMPT_BYTES) {
      fail('AGENT_CONNECTOR_PROMPT_INVALID')
    }
    const resolvedWorkdir = String(workdir || '')
    if (!resolvedWorkdir || resolvedWorkdir.includes('\u0000')) {
      fail('AGENT_CONNECTOR_WORKDIR_INVALID')
    }

    const execution = this.registry.resolveExecution(instanceId)
    const connector = this.registry.runSnapshot(instanceId)
    const requestedOperationId = String(options.operationId || '')
    if (connector.capabilities.idempotencyMode === 'durable'
        && !PUBLIC_ID.test(requestedOperationId)) {
      fail('AGENT_CONNECTOR_OPERATION_ID_REQUIRED')
    }
    const operationId = PUBLIC_ID.test(requestedOperationId)
      ? requestedOperationId
      : `agent-operation-${crypto.createHash('sha256')
          .update(canonicalJson({ runId, agentRunId, instanceId }))
          .digest('hex')}`
    const provenance = {
      ...execution.provenance,
      runId,
      agentRunId,
    }
    let state = createRunEventState(provenance)
    const notifyState = (event = null) => {
      options.onConnectorState?.({
        connector,
        connectorEventState: clone(state),
      }, event)
    }
    notifyState()
    const handler = this.recipes.get(execution.recipeId)
    if (!handler) fail('AGENT_CONNECTOR_RECIPE_UNAVAILABLE')
    const permissionMode = options.sandbox === 'workspace-write'
      ? 'workspace-write'
      : 'read-only'
    if (!connector.capabilities.permissionModes.includes(permissionMode)) {
      fail('AGENT_CONNECTOR_PERMISSION_MODE_UNSUPPORTED')
    }
    if (!connector.capabilities.inputTypes.includes('text')) {
      fail('AGENT_CONNECTOR_INPUT_UNSUPPORTED')
    }
    const emit = (input) => {
      const event = parseConnectorRunEvent(input, provenance)
      const duplicate = state.events.find(existing => existing.eventId === event.eventId)
      if (duplicate && canonicalJson(duplicate) === canonicalJson(event)) return event
      const next = reduceRunEvent(state, event)
      state = next
      notifyState(event)
      try { options.onEvent?.(harnessEvent(event)) } catch { /* Renderer events are best effort. */ }
      return event
    }
    const resume = normalizeResume(options.connectorResume)

    const result = await handler(Object.freeze({
      agent: Object.freeze({
        kind: String(agent?.kind || ''),
        label: String(agent?.label || agent?.name || ''),
      }),
      connector,
      credentialRefId: execution.credentialRef,
      runId,
      agentRunId,
      operationId,
      idempotencyKey: operationId,
      prompt: promptText,
      workdir: resolvedWorkdir,
      permissionMode,
      sessionRef: String(options.sessionRef || ''),
      attachments: Array.isArray(options.attachments) ? [...options.attachments] : [],
      signal: options.signal,
      emit,
      onProgress: options.onProgress,
      onRuntimeEvent: options.onEvent,
      onOutboundPayload: options.onOutboundPayload,
      onPermissionRequest: options.onPermissionRequest,
      resume,
    }))

    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      fail('AGENT_CONNECTOR_RESULT_INVALID')
    }
    if (result.outcome != null && result.outcome !== state.status) {
      fail('AGENT_CONNECTOR_RESULT_MISMATCH')
    }
    if (['waiting_input', 'waiting_permission'].includes(state.status)) {
      const waiting = state.events.at(-1)
      const validWaiting = state.status === 'waiting_input'
        ? waiting?.type === 'WaitingInput'
        : waiting?.type === 'Permission' && waiting.decision === 'requested'
      if (!validWaiting) fail('AGENT_CONNECTOR_WAITING_EVENT_REQUIRED')
      return {
        ...result,
        outcome: state.status,
        usage: state.usage,
        waitingRequest: clone(waiting),
        connector,
        connectorEventState: clone(state),
      }
    }
    if (!['completed', 'partial', 'failed', 'cancelled'].includes(state.status)) {
      fail('AGENT_CONNECTOR_TERMINAL_EVENT_REQUIRED')
    }
    const terminal = state.events.at(-1)
    if (state.status === 'failed') {
      return {
        text: terminal?.summary || '',
        sessionRef: '',
        outcome: 'failed',
        failure: {
          code: terminal?.code || 'AGENT_CONNECTOR_FAILED',
          category: terminal?.category || 'protocol',
          retryable: terminal?.retryable === true,
        },
        usage: state.usage,
        connector,
        connectorEventState: clone(state),
      }
    }
    if (state.status === 'cancelled') {
      return {
        text: terminal?.summary || '',
        sessionRef: '',
        outcome: 'cancelled',
        usage: state.usage,
        connector,
        connectorEventState: clone(state),
      }
    }
    return {
      ...result,
      outcome: state.status,
      usage: state.usage,
      connector,
      connectorEventState: clone(state),
    }
  }
}

module.exports = {
  AgentConnectorRuntime,
  harnessEvent,
}
