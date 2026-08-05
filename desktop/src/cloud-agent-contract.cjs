const { parseConnectorRunSnapshot } = require('./agent-connector-registry.cjs')
const { canonicalJson } = require('./outcome-records.cjs')

const MAX_CLOUD_EVENTS = 512
const OPAQUE_REF = /^[A-Za-z0-9][A-Za-z0-9._:+/=\-]{0,239}$/
const CONNECTOR_FIELDS = new Set([
  'snapshot', 'submit', 'observe', 'poll', 'provideInput',
  'decidePermission', 'cancel', 'fetchArtifacts', 'reconcile',
])
const OPTIONAL_METHODS = [
  'provideInput', 'decidePermission', 'cancel', 'fetchArtifacts', 'reconcile',
]

function contractError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function fail(code) {
  throw contractError(code)
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function clone(value) {
  return JSON.parse(canonicalJson(value))
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const item of Object.values(value)) deepFreeze(item)
  return value
}

function cleanOpaqueRef(value, required = true) {
  const text = String(value || '')
  if ((!text && !required) || OPAQUE_REF.test(text)) return text
  fail('CLOUD_AGENT_REMOTE_REF_INVALID')
}

function strictEventBatch(value) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_CLOUD_EVENTS
      || value.some(event => !isRecord(event))) {
    fail('CLOUD_AGENT_OBSERVATION_INVALID')
  }
  return value.map(clone)
}

function parseCloudSubmitResult(input) {
  if (!isRecord(input)
      || Reflect.ownKeys(input).some(key => !['jobId', 'cursor', 'events'].includes(key))) {
    fail('CLOUD_AGENT_SUBMIT_RESULT_INVALID')
  }
  const result = {
    jobId: cleanOpaqueRef(input.jobId),
    cursor: cleanOpaqueRef(input.cursor, false),
    events: strictEventBatch(input.events),
  }
  return deepFreeze(result)
}

function parseCloudObservation(input) {
  if (!isRecord(input)
      || Reflect.ownKeys(input).some(key => !['cursor', 'events'].includes(key))) {
    fail('CLOUD_AGENT_OBSERVATION_INVALID')
  }
  return deepFreeze({
    cursor: cleanOpaqueRef(input.cursor, false),
    events: strictEventBatch(input.events),
  })
}

function normalizeCloudAgentConnector(input) {
  if (!isRecord(input)
      || Reflect.ownKeys(input).some(key => typeof key !== 'string' || !CONNECTOR_FIELDS.has(key))) {
    fail('CLOUD_AGENT_CONNECTOR_INVALID')
  }
  const snapshot = parseConnectorRunSnapshot(input.snapshot)
  if (!['http', 'a2a'].includes(snapshot.transport.type)
      || typeof input.submit !== 'function'
      || (typeof input.observe === 'function') === (typeof input.poll === 'function')) {
    fail('CLOUD_AGENT_CONNECTOR_INVALID')
  }
  for (const method of OPTIONAL_METHODS) {
    if (input[method] !== undefined && typeof input[method] !== 'function') {
      fail('CLOUD_AGENT_CONNECTOR_INVALID')
    }
  }
  const observe = typeof input.observe === 'function' ? input.observe : input.poll
  const connector = {
    connectorId: snapshot.connectorId,
    snapshot,
    submit: request => input.submit(request),
    observe: request => observe(request),
  }
  for (const method of OPTIONAL_METHODS) {
    if (typeof input[method] === 'function') {
      connector[method] = request => input[method](request)
    }
  }
  return deepFreeze(connector)
}

module.exports = {
  MAX_CLOUD_EVENTS,
  normalizeCloudAgentConnector,
  parseCloudObservation,
  parseCloudSubmitResult,
}
