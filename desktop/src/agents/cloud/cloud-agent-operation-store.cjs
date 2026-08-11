const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { normalizeContentBlobRef } = require('../../attachments/content-blob-store.cjs')
const { canonicalJson } = require('../../collaboration/outcome-records.cjs')
const { atomicWritePrivateFile } = require('../../security/private-file.cjs')

const STORE_VERSION = 1
const MAX_STORE_BYTES = 4 * 1024 * 1024
const MAX_OPERATIONS = 2048
const MAX_INPUT_BYTES = 64 * 1024
const MAX_PROMPT_BYTES = 4 * 1024 * 1024
const MAX_SUBMIT_RESULT_BYTES = 4 * 1024 * 1024
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const OPAQUE_REF = /^[A-Za-z0-9][A-Za-z0-9._:+/=\-]{0,239}$/
const OPERATION_ID = /^cloud-operation-[a-f0-9]{64}$/
const TYPES = new Set(['submit', 'input', 'permission', 'cancel'])
const STATES = new Set(['pending', 'dispatched', 'delivered'])

function storeError(code, cause) {
  const error = new Error(code)
  error.code = code
  if (cause) error.cause = cause
  return error
}

function fail(code) {
  throw storeError(code)
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
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

function cleanBlobRef(input, mediaType, maxBytes) {
  try {
    const ref = normalizeContentBlobRef(input)
    return ref.mediaType === mediaType && ref.size > 0 && ref.size <= maxBytes ? ref : null
  } catch {
    return null
  }
}

function normalizePayload(type, input) {
  if (!isRecord(input)) return null
  if (type === 'submit') {
    if (Reflect.ownKeys(input).some(key => ![
      'promptRef', 'permissionMode', 'resultRef',
    ].includes(key))) return null
    const promptRef = cleanBlobRef(input.promptRef, 'text/plain', MAX_PROMPT_BYTES)
    const permissionMode = input.permissionMode === 'workspace-write'
      ? 'workspace-write'
      : input.permissionMode === 'read-only' ? 'read-only' : ''
    const resultRef = Object.hasOwn(input, 'resultRef')
      ? cleanBlobRef(input.resultRef, 'application/json', MAX_SUBMIT_RESULT_BYTES)
      : null
    if (!promptRef || !permissionMode || (Object.hasOwn(input, 'resultRef') && !resultRef)) return null
    return {
      promptRef,
      permissionMode,
      ...(resultRef ? { resultRef } : {}),
    }
  }
  if (type === 'input') {
    if (Reflect.ownKeys(input).some(key => key !== 'value')) return null
    const value = String(input.value || '')
    if (!value || value.includes('\u0000') || Buffer.byteLength(value) > MAX_INPUT_BYTES) return null
    return { value }
  }
  if (type === 'permission') {
    if (Reflect.ownKeys(input).some(key => key !== 'decision')
        || !['approved', 'rejected'].includes(input.decision)) return null
    return { decision: input.decision }
  }
  return Reflect.ownKeys(input).length ? null : {}
}

function operationIdFor(input) {
  const identity = input.type === 'submit'
    ? {
        type: input.type,
        runId: input.runId,
        agentRunId: input.agentRunId,
        connectorId: input.connectorId,
      }
    : {
        type: input.type,
        runId: input.runId,
        connectorId: input.connectorId,
        jobId: input.jobId,
        requestId: input.requestId,
      }
  const key = canonicalJson(identity)
  return `cloud-operation-${crypto.createHash('sha256').update(key).digest('hex')}`
}

function normalizeOperation(input) {
  if (!isRecord(input) || Reflect.ownKeys(input).some(key => ![
    'operationId', 'type', 'runId', 'agentRunId', 'connectorId', 'jobId', 'requestId',
    'state', 'payload', 'createdAt', 'updatedAt',
  ].includes(key))) return null
  const type = String(input.type || '')
  const runId = cleanPublicId(input.runId)
  const agentRunId = type === 'submit' ? cleanPublicId(input.agentRunId) : ''
  const connectorId = cleanPublicId(input.connectorId)
  const jobId = cleanOpaqueRef(input.jobId)
  const requestId = type === 'input' || type === 'permission' ? cleanPublicId(input.requestId) : ''
  const state = String(input.state || '')
  const payload = normalizePayload(type, input.payload)
  const createdAt = Number(input.createdAt)
  const updatedAt = Number(input.updatedAt)
  const validSubmitState = type !== 'submit' || (
    agentRunId
    && ((state === 'pending' && !jobId && !payload?.resultRef)
      || (state !== 'pending' && jobId && payload?.resultRef))
  )
  if (!TYPES.has(type) || !runId || !connectorId
      || (type === 'submit' ? !validSubmitState : !jobId)
      || ((type === 'input' || type === 'permission') && !requestId)
      || !STATES.has(state) || !payload
      || !Number.isSafeInteger(createdAt) || createdAt < 0
      || !Number.isSafeInteger(updatedAt) || updatedAt < createdAt) return null
  const normalized = {
    operationId: String(input.operationId || ''),
    type, runId, agentRunId, connectorId, jobId, requestId,
    state, payload, createdAt, updatedAt,
  }
  if (!OPERATION_ID.test(normalized.operationId)
      || normalized.operationId !== operationIdFor(normalized)) return null
  return normalized
}

function serializedStore(operations) {
  const content = `${JSON.stringify({ version: STORE_VERSION, operations }, null, 2)}\n`
  return { content, size: Buffer.byteLength(content) }
}

function oldestDeliveredIndex(operations) {
  let selected = -1
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index]
    if (operation.state !== 'delivered') continue
    if (selected < 0
        || operation.createdAt < operations[selected].createdAt
        || (operation.createdAt === operations[selected].createdAt
          && operation.updatedAt < operations[selected].updatedAt)) {
      selected = index
    }
  }
  return selected
}

class CloudAgentOperationStore {
  constructor(options = {}) {
    this.storagePath = typeof options.storagePath === 'string' ? options.storagePath.trim() : ''
    if (!this.storagePath) fail('CLOUD_AGENT_OPERATION_STORE_PATH_REQUIRED')
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.loadError = null
    this.operations = this.load()
  }

  timestamp() {
    const value = Number(this.now())
    return Number.isSafeInteger(value) && value >= 0 ? value : Date.now()
  }

  load() {
    try {
      if (!fs.existsSync(this.storagePath)) return []
      const stat = fs.lstatSync(this.storagePath)
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0 || stat.size > MAX_STORE_BYTES
          || (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600)) {
        fail('CLOUD_AGENT_OPERATION_STORE_INVALID')
      }
      const parsed = JSON.parse(fs.readFileSync(this.storagePath, 'utf8'))
      if (!isRecord(parsed) || parsed.version !== STORE_VERSION
          || !Array.isArray(parsed.operations) || parsed.operations.length > MAX_OPERATIONS
          || Reflect.ownKeys(parsed).some(key => !['version', 'operations'].includes(key))) {
        fail('CLOUD_AGENT_OPERATION_STORE_INVALID')
      }
      const operations = parsed.operations.map(normalizeOperation)
      if (operations.some(operation => !operation)
          || new Set(operations.map(operation => operation.operationId)).size !== operations.length) {
        fail('CLOUD_AGENT_OPERATION_STORE_INVALID')
      }
      return operations
    } catch (error) {
      this.loadError = error instanceof Error ? error : storeError('CLOUD_AGENT_OPERATION_STORE_INVALID')
      return []
    }
  }

  assertLoaded() {
    if (this.loadError) fail('CLOUD_AGENT_OPERATION_STORE_UNAVAILABLE')
  }

  persist(next) {
    let retained = [...next]
    let serialized = serializedStore(retained)
    while (retained.length > MAX_OPERATIONS || serialized.size > MAX_STORE_BYTES) {
      const index = oldestDeliveredIndex(retained)
      if (index < 0) fail('CLOUD_AGENT_OPERATION_STORE_LIMIT')
      retained.splice(index, 1)
      serialized = serializedStore(retained)
    }
    try {
      atomicWritePrivateFile(this.storagePath, serialized.content)
    } catch (error) {
      throw storeError('CLOUD_AGENT_OPERATION_STORE_UNAVAILABLE', error)
    }
    return retained
  }

  put(input, initialState = 'pending') {
    this.assertLoaded()
    const now = this.timestamp()
    const candidate = normalizeOperation({
      ...input,
      operationId: operationIdFor(input),
      state: initialState,
      createdAt: now,
      updatedAt: now,
    })
    if (!candidate) fail('CLOUD_AGENT_OPERATION_INVALID')
    const existing = this.operations.find(item => item.operationId === candidate.operationId)
    if (existing) {
      const comparable = operation => canonicalJson(operation.type === 'submit'
        ? {
            type: operation.type,
            runId: operation.runId,
            agentRunId: operation.agentRunId,
            connectorId: operation.connectorId,
            promptRef: operation.payload.promptRef,
            permissionMode: operation.payload.permissionMode,
          }
        : {
            type: operation.type,
            runId: operation.runId,
            connectorId: operation.connectorId,
            jobId: operation.jobId,
            requestId: operation.requestId,
            payload: operation.payload,
          })
      if (comparable(existing) !== comparable(candidate)) fail('CLOUD_AGENT_OPERATION_CONFLICT')
      return clone(existing)
    }
    if (candidate.type === 'submit'
        && this.operations.some(item => item.type === 'submit' && item.runId === candidate.runId)) {
      fail('CLOUD_AGENT_OPERATION_CONFLICT')
    }
    const next = [...this.operations, candidate]
    this.operations = this.persist(next)
    return clone(candidate)
  }

  update(operationId, state) {
    this.assertLoaded()
    if (!OPERATION_ID.test(String(operationId || '')) || !STATES.has(state)) {
      fail('CLOUD_AGENT_OPERATION_INVALID')
    }
    const index = this.operations.findIndex(item => item.operationId === operationId)
    if (index < 0) fail('CLOUD_AGENT_OPERATION_NOT_FOUND')
    const current = this.operations[index]
    const order = { pending: 0, dispatched: 1, delivered: 2 }
    if (order[state] < order[current.state]) fail('CLOUD_AGENT_OPERATION_STATE_INVALID')
    if (current.type === 'submit'
        && (state === 'dispatched' || (current.state === 'pending' && state === 'delivered'))) {
      fail('CLOUD_AGENT_OPERATION_STATE_INVALID')
    }
    if (state === current.state) return clone(current)
    const updated = { ...current, state, updatedAt: this.timestamp() }
    const next = [...this.operations]
    next[index] = updated
    this.operations = this.persist(next)
    return clone(updated)
  }

  recordSubmitResult(operationId, input) {
    this.assertLoaded()
    if (!OPERATION_ID.test(String(operationId || '')) || !isRecord(input)
        || Reflect.ownKeys(input).some(key => !['jobId', 'resultRef'].includes(key))) {
      fail('CLOUD_AGENT_OPERATION_INVALID')
    }
    const index = this.operations.findIndex(item => item.operationId === operationId)
    if (index < 0) fail('CLOUD_AGENT_OPERATION_NOT_FOUND')
    const current = this.operations[index]
    if (current.type !== 'submit') fail('CLOUD_AGENT_OPERATION_INVALID')
    const candidate = normalizeOperation({
      ...current,
      jobId: input.jobId,
      state: 'dispatched',
      payload: {
        ...current.payload,
        resultRef: input.resultRef,
      },
      updatedAt: this.timestamp(),
    })
    if (!candidate) fail('CLOUD_AGENT_OPERATION_INVALID')
    if (current.state !== 'pending') {
      if (current.jobId !== candidate.jobId
          || canonicalJson(current.payload.resultRef) !== canonicalJson(candidate.payload.resultRef)) {
        fail('CLOUD_AGENT_OPERATION_CONFLICT')
      }
      return clone(current)
    }
    const next = [...this.operations]
    next[index] = candidate
    this.operations = this.persist(next)
    return clone(candidate)
  }

  submissionIntents() {
    this.assertLoaded()
    return this.operations
      .filter(operation => operation.type === 'submit' && operation.state !== 'delivered')
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(clone)
  }

  pendingForRun(runId) {
    this.assertLoaded()
    const id = cleanPublicId(runId)
    if (!id) return []
    return this.operations
      .filter(operation => operation.runId === id && operation.state !== 'delivered')
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(clone)
  }

  list() {
    this.assertLoaded()
    return this.operations.map(clone)
  }
}

module.exports = { CloudAgentOperationStore }
