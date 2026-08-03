const { stripAnsi } = require('./cli-output-parsers.cjs')

const RUNTIME_EVENT_TYPES = new Set([
  'status',
  'answer_delta',
  'reasoning_summary',
  'plan',
  'tool_start',
  'tool_update',
  'tool_result_summary',
  'warning',
])
const RUNTIME_EVENT_STATUSES = new Set([
  'queued', 'running', 'waiting', 'completed', 'partial', 'failed', 'stopped', 'timeout',
])
const RUNTIME_EVENT_LIMITS = Object.freeze({
  id: 100,
  status: 24,
  title: 120,
  summary: 2000,
  detail: 4000,
  delta: 4000,
})

function redactChildSecrets(value, env) {
  let result = String(value || '')
  for (const [name, secret] of Object.entries(env)) {
    if (!/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION)/i.test(name)
        || typeof secret !== 'string' || secret.length < 8) continue
    result = result.split(secret).join('[redacted]')
  }
  return result
}

function runtimeEventStatus(value, fallback = '') {
  const normalized = String(value || '').toLowerCase()
  const aliases = {
    pending: 'queued',
    in_progress: 'running',
    cancelled: 'stopped',
    canceled: 'stopped',
    success: 'completed',
    error: 'failed',
  }
  const status = aliases[normalized] || normalized
  return RUNTIME_EVENT_STATUSES.has(status) ? status : fallback
}

function sanitizeRuntimeEventText(value, childEnv, limit, singleLine = false, trim = true) {
  let text = stripAnsi(redactChildSecrets(value, childEnv))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi, '[redacted private key]')
    .replace(/file:\/\/\/[^\s"'`<>|,;)}\]]+/gi, '[path]')
    .replace(/(?<![A-Za-z0-9:])(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`<>|,;)}\]]+/g, '[path]')
    .replace(/(?<![A-Za-z0-9:])\/(?!\/)[^\s"'`<>|,;)}\]]+/g, '[path]')
    .replace(/(["']?)(?:[A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?key(?:[_-]?id)?|secret[_-]?access[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|database[_-]?url|connection[_-]?string|dsn|token|secret|password|credential|authorization|private[_-]?key)[A-Za-z0-9_.-]*)\1\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|\[[^\]\r\n]*\]|[^\s,;}\]]+)/gi, 'credential=[redacted]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]')
    .replace(/\bbearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, '$1[redacted]@')
    .replace(/(["']?)(?:command|cmd)\1\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]+)/gi, '[operation hidden]')
    .replace(/(["']?)stderr\1\s*[:=]\s*[^\r\n]*/gi, '[diagnostic hidden]')
  if (singleLine) text = text.replace(/\s+/g, ' ')
  return (trim ? text.trim() : text).slice(0, limit)
}

function createRuntimeEventEmitter(options, childEnv) {
  const callback = typeof options.onEvent === 'function' ? options.onEvent : null
  let emittedAnswerDelta = false
  const deliver = (event) => {
    if (!callback) return
    try {
      const pending = callback(event)
      if (pending && typeof pending.catch === 'function') pending.catch(() => {})
    } catch { /* runtime events are best-effort */ }
  }
  const emit = (input) => {
    if (!callback || !input || !RUNTIME_EVENT_TYPES.has(input.type)) return
    const base = { type: input.type }
    const rawId = sanitizeRuntimeEventText(input.id, childEnv, RUNTIME_EVENT_LIMITS.id, true)
    if (/^[A-Za-z0-9._:-]{1,100}$/.test(rawId)) base.id = rawId
    const status = runtimeEventStatus(input.status)
    if (status) base.status = status
    for (const field of ['title', 'summary', 'detail']) {
      const text = sanitizeRuntimeEventText(
        input[field],
        childEnv,
        RUNTIME_EVENT_LIMITS[field],
        field === 'title',
      )
      if (text) base[field] = text
    }
    if (input.type !== 'answer_delta') {
      deliver(base)
      return
    }
    const delta = sanitizeRuntimeEventText(
      input.delta,
      childEnv,
      Number.MAX_SAFE_INTEGER,
      false,
      false,
    )
    if (!delta) return
    emittedAnswerDelta = true
    for (let offset = 0; offset < delta.length; offset += RUNTIME_EVENT_LIMITS.delta) {
      deliver({
        ...base,
        delta: delta.slice(offset, offset + RUNTIME_EVENT_LIMITS.delta),
      })
    }
  }
  return {
    emit,
    emitFinalAnswer(text) {
      if (!emittedAnswerDelta) {
        emit({ type: 'answer_delta', status: 'completed', delta: text })
      }
    },
  }
}

module.exports = {
  createRuntimeEventEmitter,
  redactChildSecrets,
  runtimeEventStatus,
}
