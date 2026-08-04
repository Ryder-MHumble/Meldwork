const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { StringDecoder } = require('node:string_decoder')
const { agentRuntimeFailure } = require('./agent-runtime-contract.cjs')
const { codexProgressTitle } = require('./cli-runtime-summaries.cjs')

const MAX_RUNTIME_JSON_PENDING_CHARS = 1024 * 1024
function parseCodexOutput(stdout) {
  let sessionRef = ''
  const texts = []
  for (const line of String(stdout || '').split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
        sessionRef = event.thread_id
      }
      if (event.type === 'item.completed' && event.item?.type === 'agent_message'
          && typeof event.item.text === 'string') {
        texts.push(event.item.text)
      }
    } catch { /* ignore non-JSON diagnostics */ }
  }
  return { text: texts.join('\n').trim(), sessionRef }
}

function codexProgressEvent(event) {
  if (event?.type === 'turn.started') {
    return { id: 'turn', title: 'process', status: 'in_progress' }
  }
  if (event?.type === 'turn.completed') {
    return { id: 'turn', title: 'process', status: 'completed' }
  }
  if (!['item.started', 'item.completed'].includes(event?.type)
      || !event.item || event.item.type === 'agent_message') {
    return null
  }
  const rawId = String(event.item.id || '')
  const id = /^[A-Za-z0-9._:-]{1,100}$/.test(rawId) ? rawId : ''
  const failed = event.item.status === 'failed'
    || (Number.isInteger(event.item.exit_code) && event.item.exit_code !== 0)
  return {
    ...(id ? { id } : {}),
    title: codexProgressTitle(event.item),
    status: failed
      ? 'failed'
      : event.type === 'item.started' ? 'in_progress' : 'completed',
  }
}

function createJsonLineParser(onEvent) {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  const consume = (flush = false) => {
    const lines = pending.split(/\r?\n/)
    const remainder = lines.pop() || ''
    pending = flush ? '' : remainder
    if (flush && remainder.trim()) lines.push(remainder)
    for (const line of lines) {
      if (!line.trim()) continue
      try { onEvent(JSON.parse(line)) } catch { /* ignore non-JSON diagnostics */ }
    }
  }
  return {
    write(chunk) {
      pending += decoder.write(chunk)
      consume(false)
      if (pending.length > MAX_RUNTIME_JSON_PENDING_CHARS) pending = ''
    },
    end() {
      pending += decoder.end()
      consume(true)
    },
  }
}

function parseMimoOutput(stdout) {
  let sessionRef = ''
  const texts = []
  const errors = []
  for (const line of String(stdout || '').split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      if (typeof event.sessionID === 'string') sessionRef = event.sessionID
      if (event.type === 'text' && typeof event.part?.text === 'string') {
        texts.push(event.part.text)
      }
      if (event.type === 'error') {
        const detail = event.error?.data?.message || event.error?.message || event.error?.name
        if (detail) errors.push(String(detail))
      }
    } catch { /* ignore non-JSON diagnostics */ }
  }
  return { text: texts.join('\n').trim(), sessionRef, error: errors.join('\n').trim() }
}

function normalizeOpenClawOutput(stdout) {
  const raw = String(stdout || '').trim()
  if (!raw) return ''
  try {
    const value = JSON.parse(raw)
    const texts = []
    const visit = (node) => {
      if (!node) return
      if (typeof node === 'string') texts.push(node)
      else if (Array.isArray(node)) node.forEach(visit)
      else if (typeof node === 'object') {
        if (typeof node.text === 'string') texts.push(node.text)
        else if (typeof node.content === 'string') texts.push(node.content)
        else for (const key of ['payloads', 'messages', 'result', 'response']) visit(node[key])
      }
    }
    visit(value)
    return texts.filter(Boolean).join('\n').trim() || raw
  } catch {
    return raw
  }
}

function parseJsonOutputEvents(stdout) {
  const raw = String(stdout || '').trim()
  if (!raw) return []
  try {
    const value = JSON.parse(raw)
    return (Array.isArray(value) ? value : [value])
      .filter(event => event && typeof event === 'object')
  } catch { /* fall through to JSONL parsing */ }
  const events = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line)
      const parsed = Array.isArray(value) ? value : [value]
      events.push(...parsed.filter(event => event && typeof event === 'object'))
    } catch { /* ignore non-JSON diagnostics */ }
  }
  return events
}

function parseResultOutput(stdout) {
  const raw = String(stdout || '').trim()
  if (!raw) return { text: '', sessionRef: '' }
  const result = parseJsonOutputEvents(raw)
    .findLast(event => event?.type === 'result' && typeof event.result === 'string')
  if (result) {
    return {
      text: result.result.trim(),
      sessionRef: typeof result.session_id === 'string' ? result.session_id : '',
    }
  }
  return { text: raw, sessionRef: '' }
}

function parseClaudeQwenOutput(stdout) {
  const raw = String(stdout || '').trim()
  if (!raw) return { text: '', sessionRef: '' }
  const events = parseJsonOutputEvents(raw)
  if (!events.length) return { text: raw, sessionRef: '' }
  let sessionRef = ''
  let resultText = ''
  const assistantTexts = []
  const partialTexts = []
  for (const event of events) {
    if (typeof event.session_id === 'string') sessionRef = event.session_id
    if (event.type === 'result' && typeof event.result === 'string') {
      resultText = event.result
      continue
    }
    const isRoot = event.parent_tool_use_id == null || event.parent_tool_use_id === ''
    if (!isRoot) continue
    if (event.type === 'assistant') {
      const content = event.message?.content
      const blocks = Array.isArray(content) ? content : [content]
      for (const block of blocks) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          assistantTexts.push(block.text)
        }
      }
    }
    if (event.type === 'stream_event' && event.event?.type === 'content_block_delta'
        && event.event.delta?.type === 'text_delta'
        && typeof event.event.delta.text === 'string') {
      partialTexts.push(event.event.delta.text)
    }
  }
  return {
    text: (resultText || assistantTexts.join('') || partialTexts.join('')).trim(),
    sessionRef,
  }
}

function parseWorkBuddyOutput(stdout) {
  return parseResultOutput(stdout)
}

function parseKimiOutput(stdout) {
  const raw = String(stdout || '').trim()
  if (!raw) return { text: '', sessionRef: '' }
  const texts = []
  let parsedLine = false
  let sessionRef = ''
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      parsedLine = true
      if (event?.role === 'assistant' && typeof event.content === 'string') {
        texts.push(event.content)
      }
      if (event?.type === 'session.resume_hint' && typeof event.session_id === 'string') {
        sessionRef = event.session_id
      }
    } catch { /* fall back to raw output when the CLI did not emit JSONL */ }
  }
  return {
    text: texts.join('\n').trim() || (parsedLine ? '' : raw),
    sessionRef,
  }
}

function parseGeminiOutput(stdout) {
  const raw = String(stdout || '').trim()
  if (!raw) return { text: '', sessionRef: '' }
  const texts = []
  let parsedLine = false
  let sessionRef = ''
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      parsedLine = true
      if (event?.type === 'init' && typeof event.session_id === 'string') {
        sessionRef = event.session_id
      }
      if (event?.type === 'message' && event.role === 'assistant'
          && typeof event.content === 'string') {
        texts.push(event.content)
      }
    } catch { /* fall back to raw output when the CLI did not emit JSONL */ }
  }
  return {
    text: texts.join('').trim() || (parsedLine ? '' : raw),
    sessionRef,
  }
}

function parseOpenCodeOutput(stdout) {
  const raw = String(stdout || '').trim()
  if (!raw) return { text: '', sessionRef: '' }
  const texts = []
  let parsedLine = false
  let sessionRef = ''
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      parsedLine = true
      if (typeof event?.sessionID === 'string') sessionRef = event.sessionID
      if (event?.type === 'text' && event.part?.type === 'text'
          && typeof event.part.text === 'string') {
        texts.push(event.part.text)
      }
    } catch { /* fall back to raw output when the CLI did not emit JSONL */ }
  }
  return {
    text: texts.join('\n').trim() || (parsedLine ? '' : raw),
    sessionRef,
  }
}

function openCodeReviewText(output) {
  const sections = []
  if (typeof output.message === 'string' && output.message.trim()) {
    sections.push(output.message.trim())
  }
  if (typeof output.project_summary === 'string' && output.project_summary.trim()) {
    sections.push(output.project_summary.trim())
  }
  for (const comment of Array.isArray(output.comments) ? output.comments : []) {
    if (!comment || typeof comment !== 'object') continue
    const location = typeof comment.path === 'string' && comment.path.trim()
      ? `${comment.path.trim()}${Number.isInteger(comment.start_line)
        ? `:${comment.start_line}${Number.isInteger(comment.end_line)
          && comment.end_line !== comment.start_line ? `-${comment.end_line}` : ''}`
        : ''}`
      : ''
    const metadata = [comment.category, comment.severity]
      .filter(value => typeof value === 'string' && value.trim())
      .map(value => value.trim())
      .join(' / ')
    const content = typeof comment.content === 'string' ? comment.content.trim() : ''
    const suggestion = typeof comment.suggestion_code === 'string'
      ? comment.suggestion_code.trim()
      : ''
    const header = [location, metadata && `[${metadata}]`].filter(Boolean).join(' ')
    const finding = [
      header,
      content,
      suggestion ? `Suggested change:\n${suggestion}` : '',
    ].filter(Boolean).join('\n')
    if (finding) sections.push(finding)
  }
  return sections.join('\n\n').trim()
}

function invalidOpenCodeReviewOutput(diagnostic) {
  return {
    text: '',
    sessionRef: '',
    outcome: 'failed',
    failure: agentRuntimeFailure('LOCAL_AGENT_OUTCOME_INVALID'),
    diagnostic,
  }
}

function parseOpenCodeReviewOutput(stdout) {
  const raw = String(stdout || '').trim()
  if (!raw) return invalidOpenCodeReviewOutput('OpenCodeReview returned no JSON result.')
  let output
  try {
    output = JSON.parse(raw)
  } catch {
    return invalidOpenCodeReviewOutput('OpenCodeReview returned malformed JSON.')
  }
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return invalidOpenCodeReviewOutput('OpenCodeReview returned an invalid JSON result.')
  }

  const status = String(output.status || '')
  let outcome = ''
  if (output.manifest != null) {
    if (output.manifest?.schema_version !== 'ocr.run-manifest/v1') {
      return invalidOpenCodeReviewOutput('OpenCodeReview returned an unsupported manifest schema.')
    }
    if (output.manifest?.operation !== 'review') {
      return invalidOpenCodeReviewOutput('OpenCodeReview returned an unsupported manifest operation.')
    }
    const terminalState = String(output.manifest.terminal_state || '')
    if (status !== terminalState) {
      return invalidOpenCodeReviewOutput('OpenCodeReview returned inconsistent terminal states.')
    }
    outcome = ({
      complete: 'completed',
      partial: 'partial',
      failed: 'failed',
      skipped: 'completed',
    })[terminalState] || ''
  } else {
    outcome = ({
      success: 'completed',
      complete: 'completed',
      skipped: 'completed',
      completed_with_warnings: 'completed',
      partial: 'partial',
      completed_with_errors: 'partial',
      budget_exceeded: 'partial',
      failed: 'failed',
    })[status] || ''
  }
  if (!outcome) {
    return invalidOpenCodeReviewOutput('OpenCodeReview returned an unknown terminal state.')
  }

  const text = openCodeReviewText(output)
    || (outcome === 'completed' ? 'OpenCodeReview completed without findings.' : '')
  const result = {
    text,
    sessionRef: '',
    outcome,
    ...(typeof output.session_id === 'string' && output.session_id
      ? { externalRunRef: output.session_id }
      : {}),
  }
  if (outcome === 'failed') {
    result.failure = agentRuntimeFailure('LOCAL_AGENT_PROCESS_FAILED')
    result.diagnostic = text || 'OpenCodeReview reported a failed review.'
  }
  return result
}

function classifyCliOutcome(kind, stdout) {
  if (kind === 'hermes') return { outcome: 'completed' }
  if (kind === 'opencodereview') {
    const parsed = parseOpenCodeReviewOutput(stdout)
    return {
      outcome: parsed.outcome,
      ...(parsed.failure ? { failure: parsed.failure } : {}),
      ...(parsed.diagnostic ? { diagnostic: parsed.diagnostic } : {}),
    }
  }

  const events = parseJsonOutputEvents(stdout)
  const failed = events.findLast(event => (
    event?.type === 'error'
      || event?.status === 'failed'
      || event?.status === 'error'
      || event?.is_error === true
      || String(event?.subtype || '').startsWith('error')
  ))
  if (failed) {
    return {
      outcome: 'failed',
      failure: agentRuntimeFailure('LOCAL_AGENT_PROCESS_FAILED'),
    }
  }
  if (kind === 'codex') {
    return {
      outcome: events.some(event => event?.type === 'turn.completed')
        ? 'completed'
        : 'partial',
    }
  }
  if (['workbuddy', 'claude', 'qwen'].includes(kind)) {
    return {
      outcome: events.some(event => event?.type === 'result') ? 'completed' : 'partial',
    }
  }
  if (kind === 'kimi') {
    return {
      outcome: events.some(event => event?.type === 'session.resume_hint')
        ? 'completed'
        : 'partial',
    }
  }
  if (['mimo', 'opencode'].includes(kind)) {
    const hasNativeText = events.some(event => (
      event?.type === 'text' && event.part?.type === 'text'
    ))
    return { outcome: hasNativeText ? 'completed' : 'partial' }
  }
  if (kind === 'gemini') {
    const result = events.findLast(event => event?.type === 'result')
    if (!result) return { outcome: 'partial' }
    if (result.status === 'success') return { outcome: 'completed' }
    if (result.status === 'cancelled') return { outcome: 'cancelled' }
    return {
      outcome: 'failed',
      failure: agentRuntimeFailure('LOCAL_AGENT_OUTCOME_INVALID'),
    }
  }
  if (kind === 'openclaw') {
    const raw = String(stdout || '').trim()
    try {
      const value = JSON.parse(raw)
      return { outcome: value && typeof value === 'object' ? 'completed' : 'partial' }
    } catch {
      return { outcome: 'partial' }
    }
  }
  return { outcome: 'partial' }
}

function structuredCliError(stdout) {
  const failed = parseJsonOutputEvents(stdout)
    .findLast(event => event?.is_error || event?.subtype?.startsWith('error'))
  return String(failed?.error?.message || failed?.result || '').trim()
}

function hermesSessionRef(stderr) {
  const matches = [...String(stderr || '').matchAll(/\bsession_id:\s*([^\s]+)/gi)]
  return matches.at(-1)?.[1] || ''
}

function stripAnsi(value) {
  return String(value || '').replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
}

function queryHermesState(databasePath, sql, params, options = {}) {
  if (typeof options.queryFn === 'function') {
    return options.queryFn({ databasePath, sql, params, readOnly: true })
  }
  let database
  try {
    const { DatabaseSync } = require('node:sqlite')
    database = new DatabaseSync(databasePath, { readOnly: true })
    return database.prepare(sql).get(...params)
  } finally {
    try { database?.close() } catch { /* database was already closed */ }
  }
}

function readHermesMessageWatermark(options = {}) {
  const databasePath = path.join(options.home || os.homedir(), '.hermes', 'state.db')
  const existsFn = options.existsFn || fs.existsSync
  if (!existsFn(databasePath)) return 0
  try {
    const row = queryHermesState(databasePath, `
      SELECT COALESCE(MAX(id), 0) AS max_id
      FROM messages
    `, [], options)
    const watermark = Number(row?.max_id)
    return Number.isSafeInteger(watermark) && watermark >= 0 ? watermark : null
  } catch {
    return null
  }
}

function readHermesFinalResponse(sessionRef, options = {}) {
  const afterMessageId = Number(options.afterMessageId)
  if (!sessionRef || !Number.isSafeInteger(afterMessageId) || afterMessageId < 0) return ''
  const databasePath = path.join(options.home || os.homedir(), '.hermes', 'state.db')
  const existsFn = options.existsFn || fs.existsSync
  if (!existsFn(databasePath)) return ''
  try {
    const row = queryHermesState(databasePath, `
      SELECT content
      FROM messages
      WHERE session_id = ?
        AND id > ?
        AND role = 'assistant'
        AND finish_reason IN ('stop', 'length')
        AND length(trim(content)) > 0
      ORDER BY id DESC
      LIMIT 1
    `, [sessionRef, afterMessageId], options)
    return String(row?.content || '').trim()
  } catch {
    return ''
  }
}

module.exports = {
  codexProgressEvent,
  createJsonLineParser,
  hermesSessionRef,
  normalizeOpenClawOutput,
  parseClaudeQwenOutput,
  parseCodexOutput,
  parseGeminiOutput,
  parseJsonOutputEvents,
  parseKimiOutput,
  parseMimoOutput,
  parseOpenCodeOutput,
  parseOpenCodeReviewOutput,
  parseWorkBuddyOutput,
  readHermesFinalResponse,
  readHermesMessageWatermark,
  stripAnsi,
  structuredCliError,
  classifyCliOutcome,
}
