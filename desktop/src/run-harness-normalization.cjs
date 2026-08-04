const MAX_CAPSULE_EVENTS = 12

const { redactSecrets } = require('./secret-redaction.cjs')
const { normalizeExternalRunRef } = require('./agent-runtime-contract.cjs')

const EVENT_TYPES = new Set([
  'status',
  'answer_delta',
  'reasoning_summary',
  'plan',
  'tool_start',
  'tool_update',
  'tool_result_summary',
  'warning',
])
const EVENT_STATUSES = new Set([
  'queued', 'running', 'waiting', 'completed', 'partial', 'failed', 'stopped', 'timeout',
  'interrupted',
])
const FINAL_STATUSES = new Set([
  'completed', 'partial', 'failed', 'stopped', 'timeout', 'interrupted',
])
const CAPSULE_EVENT_TYPES = new Set([
  'reasoning_summary', 'plan', 'tool_start', 'tool_update', 'tool_result_summary', 'warning',
])
const INCOMPLETE_TOOL_EVENT_TYPES = new Set(['tool_start', 'tool_update'])
const FAILED_TOOL_STATUSES = new Set(['failed', 'stopped', 'timeout', 'interrupted'])
const PUBLIC_ID = /^[A-Za-z0-9._:-]{1,120}$/
const PUBLIC_GROUP_ID = /^[^\u0000-\u001f\u007f]{1,100}$/u

function boundedNumber(value, fallback = 0, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return fallback
  return Math.min(max, Math.floor(number))
}

function stripAnsi(value) {
  return String(value || '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
}

function redactPrivatePaths(value) {
  return String(value || '')
    .replace(/\bfile:\/\/\/[^\s"'`<>]+/gi, '[path]')
    .replace(/(?:^|[\s("'`])\/(?:Users|home|private|tmp|var\/folders|Library|Applications|Volumes|opt|etc|usr)\/[^\s"'`<>)]*/g, match => `${match[0] === '/' ? '' : match[0]}[path]`)
    .replace(/\b[A-Za-z]:\\(?:[^\s"'`<>]+\\)*[^\s"'`<>]*/g, '[path]')
}

function cleanText(value, limit, options = {}) {
  let text = redactSecrets(stripAnsi(value))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  if (options.redactPaths !== false) text = redactPrivatePaths(text)
  if (options.inline) text = text.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ')
  if (options.trim !== false) text = text.trim()
  return text.slice(0, limit)
}

function cleanId(value, fallback = '') {
  const id = String(value || '')
  return PUBLIC_ID.test(id) ? id : fallback
}

function cleanGroupId(value) {
  const id = String(value || '')
  return PUBLIC_GROUP_ID.test(id) ? id : ''
}

function cleanStatus(value, fallback = 'running') {
  const status = String(value || '').toLowerCase()
  return EVENT_STATUSES.has(status) ? status : fallback
}

function safeTimestamp(value, fallback = Date.now()) {
  if (Number.isFinite(value) && value >= 0) return Math.floor(value)
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : fallback
}

function normalizeRawEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const type = String(input.type || '').toLowerCase()
  if (!EVENT_TYPES.has(type)) return null
  const event = { type }
  const id = cleanId(input.id)
  if (id) event.id = id
  if (input.status != null) event.status = cleanStatus(input.status)
  const title = cleanText(input.title, 120, { inline: true })
  const summary = cleanText(input.summary, 800)
  const detail = cleanText(input.detail, 1600)
  const delta = cleanText(input.delta, 4000, { redactPaths: false, trim: false })
  if (title) event.title = title
  if (summary) event.summary = summary
  if (detail) event.detail = detail
  if (delta) event.delta = delta
  if (type === 'answer_delta' && !delta) return null
  return event
}

function normalizeRunEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const event = normalizeRawEvent(input)
  const runId = cleanId(input.runId)
  const agentRunId = cleanId(input.agentRunId)
  const groupId = cleanGroupId(input.groupId)
  const threadRootId = cleanId(input.threadRootId)
  const agentKind = cleanId(input.agentKind)
  const seq = boundedNumber(input.seq, 0, 1000000000)
  if (!event || !runId || !agentRunId || !groupId || !agentKind || !seq) return null
  return {
    runId,
    agentRunId,
    groupId,
    threadRootId,
    agentKind,
    round: boundedNumber(input.round, 0, 100000),
    seq,
    timestamp: safeTimestamp(input.timestamp),
    status: cleanStatus(input.status),
    ...event,
  }
}

function lifecycleFamily(type) {
  if (String(type || '').startsWith('tool_')) return 'tool'
  return ['reasoning_summary', 'plan', 'status', 'warning'].includes(type) ? type : ''
}

function lifecycleEventKey(event) {
  const family = lifecycleFamily(event?.type)
  return family && event?.id ? `${family}:${event.id}` : ''
}

function sameLifecycleEvent(existing, event, fallbackStatus) {
  if (!existing || !lifecycleEventKey(event)) return false
  const fields = ['id', 'type', 'status', 'title', 'summary', 'detail', 'delta']
  const normalized = {
    ...event,
    status: cleanStatus(event.status, fallbackStatus),
  }
  return fields.every(field => (existing[field] || '') === (normalized[field] || ''))
}

function normalizeSourceMessageIds(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map(id => cleanId(id))
    .filter(Boolean))]
    .slice(0, 32)
}

function normalizeContextStats(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const context = {
    includedCount: boundedNumber(input.includedCount, 0, 1000),
    omittedCount: boundedNumber(input.omittedCount, 0, 100000),
    charCount: boundedNumber(input.charCount, 0, 1000000),
  }
  if (input.sessionRotated === true) context.sessionRotated = true
  const externalRunRef = normalizeExternalRunRef(redactSecrets(input.externalRunRef))
  if (externalRunRef) context.externalRunRef = externalRunRef
  return context
}

function compactCapsuleDetail(value) {
  const detail = cleanText(value, 600)
  if (!detail) return ''
  return detail.split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => (
      /^Exit code: -?\d+$/u.test(line)
      || /^Output: \d+ lines?, \d+ bytes$/u.test(line)
      || /^Result: (?:-?\d+(?:\.\d+)?|true|false|\d+ items?|\d+ fields?)$/u.test(line)
    ))
    .slice(0, 4)
    .join('\n')
}

function normalizeCapsuleEventStatus(type, value) {
  const status = cleanStatus(value, INCOMPLETE_TOOL_EVENT_TYPES.has(type) ? 'partial' : 'completed')
  if (INCOMPLETE_TOOL_EVENT_TYPES.has(type)) {
    return FAILED_TOOL_STATUSES.has(status) ? status : 'partial'
  }
  if (type === 'tool_result_summary' && !FINAL_STATUSES.has(status)) return 'partial'
  return status
}

function normalizeCapsuleEvent(input, index = 0) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const type = String(input.type || '').toLowerCase()
  if (!CAPSULE_EVENT_TYPES.has(type)) return null
  const event = {
    evidenceId: cleanId(input.evidenceId, `E-${index + 1}`),
    type,
    status: normalizeCapsuleEventStatus(type, input.status),
  }
  const title = cleanText(input.title, 120, { inline: true })
  const summary = cleanText(input.summary, 600)
  const detail = compactCapsuleDetail(input.detail)
  if (title) event.title = title
  if (summary) event.summary = summary
  if (detail) event.detail = detail
  return event
}

function normalizeCapsuleRound(value, runId, agentRunId, hasExplicitRound) {
  if (hasExplicitRound) {
    return typeof value === 'number'
      && Number.isInteger(value)
      && value >= 0
      && value <= 100000
      ? value
      : null
  }
  const prefix = `${runId}:`
  if (!agentRunId.startsWith(prefix)) return null
  const match = agentRunId.slice(prefix.length)
    .match(/^(\d{1,6}):[A-Za-z0-9._-]{1,120}:[A-Za-z0-9._-]{1,120}$/u)
  if (!match) return null
  const inferred = Number(match[1])
  return inferred <= 100000 ? inferred : null
}

function normalizeTraceCapsule(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const runId = cleanId(input.runId)
  const agentRunId = cleanId(input.agentRunId)
  if (!runId || !agentRunId) return null
  const round = normalizeCapsuleRound(
    input.round,
    runId,
    agentRunId,
    Object.prototype.hasOwnProperty.call(input, 'round'),
  )
  const events = (Array.isArray(input.events) ? input.events : [])
    .slice(0, MAX_CAPSULE_EVENTS)
    .map(normalizeCapsuleEvent)
    .filter(Boolean)
  return {
    runId,
    agentRunId,
    ...(round != null ? { round } : {}),
    status: cleanStatus(input.status, 'completed'),
    summary: cleanText(input.summary, 1200),
    events,
    sourceMessageIds: normalizeSourceMessageIds(input.sourceMessageIds),
    truncated: input.truncated === true,
    context: normalizeContextStats(input.context),
  }
}

function traceCapsuleFromAgentRun(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const runId = cleanId(options.runId || input.runId)
  const agentRunId = cleanId(input.agentRunId)
  const kind = cleanId(input.kind || input.agentKind)
  if (!runId || !agentRunId || !kind) return null
  const round = boundedNumber(input.round, 0, 100000)
  const status = cleanStatus(options.status || input.status, 'interrupted')
  const capsuleEvents = (Array.isArray(input.events) ? input.events : [])
    .filter(item => CAPSULE_EVENT_TYPES.has(String(item?.type || '').toLowerCase()))
    .filter(item => (
      ['reasoning_summary', 'plan'].includes(item.type)
        ? Boolean(item.summary)
        : Boolean(item.title || item.summary)
    ))
    .slice(-MAX_CAPSULE_EVENTS)
    .map((item, index) => ({
      evidenceId: `E-R${round}-${kind.toUpperCase()}-${String(index + 1).padStart(2, '0')}`,
      type: item.type,
      status: normalizeCapsuleEventStatus(item.type, item.status),
      title: cleanText(item.title, 120, { inline: true }),
      summary: cleanText(item.summary, 600),
      detail: compactCapsuleDetail(item.detail),
    }))
  const narrative = [...(Array.isArray(input.events) ? input.events : [])].reverse().find(item => (
    ['reasoning_summary', 'plan'].includes(item?.type) && item.summary
  ))
  return normalizeTraceCapsule({
    runId,
    agentRunId,
    round,
    status,
    summary: narrative?.summary || input.summary || '',
    events: capsuleEvents,
    sourceMessageIds: input.sourceMessageIds,
    truncated: input.truncated === true,
    context: options.context || input.context,
  })
}

module.exports = {
  EVENT_TYPES,
  FINAL_STATUSES,
  boundedNumber,
  cleanGroupId,
  cleanId,
  cleanStatus,
  cleanText,
  lifecycleEventKey,
  normalizeContextStats,
  normalizeRawEvent,
  normalizeRunEvent,
  normalizeSourceMessageIds,
  normalizeTraceCapsule,
  safeTimestamp,
  sameLifecycleEvent,
  traceCapsuleFromAgentRun,
}
