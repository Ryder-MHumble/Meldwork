const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { StringDecoder } = require('node:string_decoder')
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
  parseWorkBuddyOutput,
  readHermesFinalResponse,
  readHermesMessageWatermark,
  stripAnsi,
  structuredCliError,
}
