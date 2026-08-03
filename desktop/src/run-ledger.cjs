const fs = require('node:fs')

const { atomicWritePrivateFile } = require('./private-file.cjs')
const { redactSecrets } = require('./secret-redaction.cjs')
const {
  DEFAULT_MAX_AGENT_RUNS,
  DEFAULT_MAX_EVENTS_PER_AGENT,
  DEFAULT_MAX_OUTPUT_CHARS,
  normalizeRunEvent,
  normalizeTraceCapsule,
} = require('./run-harness.cjs')

const STORE_VERSION = 1
const DEFAULT_MAX_RUNS = 64
const MAX_RUNS = 512
const MAX_TARGET_KINDS = 32
const MAX_REASON_CHARS = 240
const PUBLIC_ID = /^[A-Za-z0-9._:-]{1,120}$/
const PUBLIC_GROUP_ID = /^[^\u0000-\u001f\u007f]{1,100}$/u

const RUN_STATUSES = new Set([
  'preparing', 'queued', 'running', 'waiting',
  'completed', 'partial', 'failed', 'stopped', 'timeout', 'round-limit', 'interrupted',
])
const AGENT_STATUSES = new Set([
  'queued', 'running', 'waiting',
  'completed', 'partial', 'failed', 'stopped', 'timeout', 'interrupted',
])
const EVENT_STATUSES = new Set([
  'queued', 'running', 'waiting',
  'completed', 'partial', 'failed', 'stopped', 'timeout', 'interrupted',
])
const TERMINAL_STATUSES = new Set([
  'completed', 'partial', 'failed', 'stopped', 'timeout', 'round-limit', 'interrupted',
])
const MODES = new Set(['manual', 'auto'])
const PERMISSION_MODES = new Set(['read-only', 'workspace-write'])

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function cleanId(value) {
  const id = String(value || '')
  return PUBLIC_ID.test(id) ? id : ''
}

function cleanGroupId(value) {
  const id = String(value || '')
  return PUBLIC_GROUP_ID.test(id) ? id : ''
}

function boundedNumber(value, fallback = 0, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return fallback
  return Math.min(max, Math.floor(number))
}

function safeTimestamp(value, fallback = 0) {
  if (Number.isFinite(value) && value >= 0) return Math.floor(value)
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : fallback
}

function redactPaths(value) {
  return String(value || '')
    .replace(/\bfile:\/\/\/[^\s"'`<>]+/gi, '[path]')
    .replace(/(^|[\s("'`])\/(?!\/)[^\s"'`<>)]*/g, '$1[path]')
    .replace(/\b[A-Za-z]:\\(?:[^\s"'`<>]+\\)*[^\s"'`<>]*/g, '[path]')
}

function cleanText(value, limit, options = {}) {
  let text = redactPaths(redactSecrets(value))
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  if (options.inline) text = text.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ')
  return text.trim().slice(0, limit)
}

function cleanStatus(value, fallback = 'running', statuses = RUN_STATUSES) {
  const status = String(value || '').toLowerCase()
  return statuses.has(status) ? status : fallback
}

function normalizeKinds(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map(cleanId)
    .filter(Boolean))]
    .slice(0, MAX_TARGET_KINDS)
}

function cleanEventDetail(value) {
  return cleanText(value, 1600)
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => (
      /^Exit code: -?\d+$/u.test(line)
      || /^Output: \d+ lines?, \d+ bytes$/u.test(line)
      || /^Result: (?:-?\d+(?:\.\d+)?|true|false|\d+ items?|\d+ fields?)$/u.test(line)
    ))
    .slice(0, 4)
    .join('\n')
}

function normalizeAgentEvents(value, parent, fallbackTimestamp) {
  return (Array.isArray(value) ? value : [])
    .slice(-DEFAULT_MAX_EVENTS_PER_AGENT)
    .map((input, index) => {
      if (!isRecord(input) || input.type === 'answer_delta') return null
      const normalized = normalizeRunEvent({
        ...input,
        runId: parent.runId,
        agentRunId: parent.agentRunId,
        groupId: parent.groupId,
        threadRootId: parent.threadRootId,
        agentKind: parent.kind,
        round: parent.round,
        seq: boundedNumber(input.seq, index + 1, 1000000000) || index + 1,
        timestamp: safeTimestamp(input.timestamp, fallbackTimestamp),
      })
      if (!normalized || normalized.type === 'answer_delta') return null
      const event = {
        runId: normalized.runId,
        agentRunId: normalized.agentRunId,
        groupId: normalized.groupId,
        threadRootId: normalized.threadRootId,
        agentKind: normalized.agentKind,
        round: normalized.round,
        seq: normalized.seq,
        timestamp: normalized.timestamp,
        status: cleanStatus(input.status, normalized.status, EVENT_STATUSES),
        type: normalized.type,
      }
      if (normalized.id) event.id = normalized.id
      if (normalized.title) event.title = cleanText(normalized.title, 120, { inline: true })
      if (normalized.summary) event.summary = cleanText(normalized.summary, 800)
      const detail = cleanEventDetail(normalized.detail)
      if (detail) event.detail = detail
      return event
    })
    .filter(Boolean)
}

function normalizeAgentRun(input, parent, fallbackTimestamp) {
  if (!isRecord(input)) return null
  const agentRunId = cleanId(input.agentRunId)
  const kind = cleanId(input.kind)
  if (!agentRunId || !kind || !parent.targetKinds.includes(kind)) return null
  const round = boundedNumber(input.round, 0, 100000)
  const status = cleanStatus(input.status, 'running', AGENT_STATUSES)
  const outputSource = String(input.output || '')
  const output = cleanText(outputSource, DEFAULT_MAX_OUTPUT_CHARS)
  const startedAt = safeTimestamp(input.startedAt, fallbackTimestamp)
  const lastActivityAt = safeTimestamp(input.lastActivityAt, startedAt)
  const capsule = normalizeTraceCapsule({
    runId: parent.runId,
    agentRunId,
    round,
    status: TERMINAL_STATUSES.has(status) ? 'completed' : status,
    sourceMessageIds: input.sourceMessageIds,
    context: input.context,
  })
  const hasContext = isRecord(input.context) && [
    'includedCount', 'omittedCount', 'charCount', 'sessionRotated',
  ].some(key => hasOwn(input.context, key))
  const rawEvents = Array.isArray(input.events) ? input.events : []
  const rawSourceIds = Array.isArray(input.sourceMessageIds) ? input.sourceMessageIds : []
  const agentRun = {
    agentRunId,
    kind,
    round,
    status,
    output,
    events: normalizeAgentEvents(rawEvents, {
      ...parent, agentRunId, kind, round,
    }, lastActivityAt),
    sourceMessageIds: capsule?.sourceMessageIds || [],
    startedAt,
    lastActivityAt,
    silent: input.silent === true,
    truncated: input.truncated === true
      || outputSource.length > DEFAULT_MAX_OUTPUT_CHARS
      || rawEvents.length > DEFAULT_MAX_EVENTS_PER_AGENT
      || rawSourceIds.length > 32,
    context: hasContext ? (capsule?.context || {}) : {},
  }
  const reason = cleanText(input.reason, MAX_REASON_CHARS, { inline: true })
  if (reason) agentRun.reason = reason
  if (TERMINAL_STATUSES.has(status) && hasOwn(input, 'finishedAt')) {
    agentRun.finishedAt = safeTimestamp(input.finishedAt, lastActivityAt)
  }
  return agentRun
}

function hasStoredFieldTypes(input, fields, type) {
  return fields.every(field => !hasOwn(input, field) || typeof input[field] === type)
}

function hasStoredEnum(input, field, values) {
  return !hasOwn(input, field)
    || (typeof input[field] === 'string' && values.has(input[field].toLowerCase()))
}

function hasStoredBoundedInteger(input, field, min, max) {
  return !hasOwn(input, field)
    || (Number.isInteger(input[field]) && input[field] >= min && input[field] <= max)
}

function isStoredTimestamp(value) {
  return (
    (typeof value === 'number' && Number.isFinite(value) && value >= 0)
    || (typeof value === 'string' && Number.isFinite(Date.parse(value)))
  )
}

function hasStoredTimestamps(input, fields) {
  return fields.every(field => !hasOwn(input, field) || isStoredTimestamp(input[field]))
}

function hasValidStoredRecordShape(input) {
  if (!isRecord(input)) return false
  if (!hasStoredFieldTypes(input, [
    'runId', 'groupId', 'threadRootId', 'reason',
  ], 'string')) return false
  if (!hasStoredEnum(input, 'mode', MODES)) return false
  if (!hasStoredEnum(input, 'status', RUN_STATUSES)) return false
  if (!hasStoredEnum(input, 'permissionMode', PERMISSION_MODES)) return false
  if (!hasStoredBoundedInteger(input, 'currentRound', 0, 100000)) return false
  if (!hasStoredBoundedInteger(input, 'maxRounds', 0, 100000)) return false
  if (!hasStoredFieldTypes(input, ['unlimitedRounds'], 'boolean')) return false
  if (!hasStoredTimestamps(input, [
    'createdAt', 'startedAt', 'updatedAt', 'finishedAt',
  ])) return false
  const mode = hasOwn(input, 'mode') ? input.mode.toLowerCase() : 'manual'
  if (mode !== 'auto' && (
    input.unlimitedRounds === true
    || (hasOwn(input, 'currentRound') && input.currentRound !== 0)
    || (hasOwn(input, 'maxRounds') && input.maxRounds !== 0)
  )) return false
  if (mode === 'auto' && input.unlimitedRounds === true
      && hasOwn(input, 'maxRounds') && input.maxRounds !== 0) return false
  if (mode === 'auto' && input.unlimitedRounds !== true
      && input.maxRounds > 0 && input.currentRound > input.maxRounds) return false
  if (hasOwn(input, 'targetKinds') && (
    !Array.isArray(input.targetKinds)
    || input.targetKinds.some(kind => typeof kind !== 'string' || !cleanId(kind))
  )) return false
  if (!hasOwn(input, 'agentRuns')) return true
  if (!Array.isArray(input.agentRuns)) return false

  const targetKinds = normalizeKinds(input.targetKinds)
  const parent = {
    runId: cleanId(input.runId),
    groupId: cleanGroupId(input.groupId),
    threadRootId: cleanId(input.threadRootId),
    targetKinds,
  }
  const fallbackTimestamp = safeTimestamp(input.startedAt, 0)
  return input.agentRuns.every(agentRun => {
    if (!isRecord(agentRun)) return false
    if (!hasStoredFieldTypes(agentRun, [
      'agentRunId', 'kind', 'output', 'reason',
    ], 'string')) return false
    if (!hasStoredEnum(agentRun, 'status', AGENT_STATUSES)) return false
    if (!hasStoredBoundedInteger(agentRun, 'round', 0, 100000)) return false
    if (!hasStoredFieldTypes(agentRun, ['silent', 'truncated'], 'boolean')) return false
    if (!hasStoredTimestamps(agentRun, [
      'startedAt', 'lastActivityAt', 'finishedAt',
    ])) return false
    if (hasOwn(agentRun, 'context')) {
      if (!isRecord(agentRun.context)) return false
      if (!hasStoredBoundedInteger(agentRun.context, 'includedCount', 0, 1000)) return false
      if (!hasStoredBoundedInteger(agentRun.context, 'omittedCount', 0, 100000)) return false
      if (!hasStoredBoundedInteger(agentRun.context, 'charCount', 0, 1000000)) return false
      if (!hasStoredFieldTypes(agentRun.context, ['sessionRotated'], 'boolean')) return false
    }
    if (hasOwn(agentRun, 'sourceMessageIds') && (
      !Array.isArray(agentRun.sourceMessageIds)
      || agentRun.sourceMessageIds.some(id => typeof id !== 'string' || !cleanId(id))
    )) return false
    if (hasOwn(agentRun, 'events') && !Array.isArray(agentRun.events)) return false

    const normalized = normalizeAgentRun(agentRun, parent, fallbackTimestamp)
    if (!normalized) return false
    return !hasOwn(agentRun, 'events') || agentRun.events.every(event => (
      isRecord(event)
      && hasStoredFieldTypes(event, [
        'runId', 'agentRunId', 'groupId', 'threadRootId', 'agentKind',
        'type', 'id', 'title', 'summary', 'detail', 'delta',
      ], 'string')
      && hasStoredEnum(event, 'status', EVENT_STATUSES)
      && hasStoredBoundedInteger(event, 'round', 0, 100000)
      && hasStoredBoundedInteger(event, 'seq', 1, 1000000000)
      && hasStoredTimestamps(event, ['timestamp'])
      && (!hasOwn(event, 'runId') || event.runId === parent.runId)
      && (!hasOwn(event, 'agentRunId') || event.agentRunId === normalized.agentRunId)
      && (!hasOwn(event, 'groupId') || event.groupId === parent.groupId)
      && (!hasOwn(event, 'threadRootId') || event.threadRootId === parent.threadRootId)
      && (!hasOwn(event, 'agentKind') || event.agentKind === normalized.kind)
      && (!hasOwn(event, 'round') || event.round === normalized.round)
      && normalizeAgentEvents([event], {
        ...parent,
        agentRunId: normalized.agentRunId,
        kind: normalized.kind,
        round: normalized.round,
      }, normalized.lastActivityAt).length === 1
    ))
  })
}

function selectedValue(input, existing, key) {
  return hasOwn(input, key) ? input[key] : existing?.[key]
}

function normalizeRecord(input, options = {}) {
  if (!isRecord(input)) return null
  const existing = options.existing || null
  const now = safeTimestamp(options.now, 0)
  const runId = cleanId(selectedValue(input, existing, 'runId'))
  const groupId = cleanGroupId(selectedValue(input, existing, 'groupId'))
  if (!runId || !groupId) return null

  const modeValue = String(selectedValue(input, existing, 'mode') || '').toLowerCase()
  const mode = MODES.has(modeValue) ? modeValue : (existing?.mode || 'manual')
  const fallbackStatus = existing?.status || 'preparing'
  const status = cleanStatus(selectedValue(input, existing, 'status'), fallbackStatus)
  const targetKinds = normalizeKinds(selectedValue(input, existing, 'targetKinds'))
  const threadRootId = cleanId(selectedValue(input, existing, 'threadRootId'))
  const permissionValue = String(
    selectedValue(input, existing, 'permissionMode') || '',
  ).toLowerCase()
  const permissionMode = PERMISSION_MODES.has(permissionValue)
    ? permissionValue
    : (existing?.permissionMode || 'read-only')
  const startedAt = safeTimestamp(
    selectedValue(input, existing, 'startedAt'),
    safeTimestamp(selectedValue(input, existing, 'createdAt'), now),
  )
  const createdAt = safeTimestamp(selectedValue(input, existing, 'createdAt'), startedAt)
  const updatedAt = options.touch === true
    ? now
    : safeTimestamp(selectedValue(input, existing, 'updatedAt'), startedAt)
  const unlimitedRounds = mode === 'auto'
    && selectedValue(input, existing, 'unlimitedRounds') === true
  const maxRounds = mode === 'auto' && !unlimitedRounds
    ? boundedNumber(selectedValue(input, existing, 'maxRounds'), 0, 100000)
    : 0
  const requestedRound = mode === 'auto'
    ? boundedNumber(selectedValue(input, existing, 'currentRound'), 0, 100000)
    : 0
  const currentRound = maxRounds ? Math.min(requestedRound, maxRounds) : requestedRound
  const reason = cleanText(
    selectedValue(input, existing, 'reason'), MAX_REASON_CHARS, { inline: true },
  )
  const parent = { runId, groupId, threadRootId, targetKinds }
  const rawAgentRuns = selectedValue(input, existing, 'agentRuns')
  const agentRuns = (Array.isArray(rawAgentRuns) ? rawAgentRuns : [])
    .slice(-DEFAULT_MAX_AGENT_RUNS)
    .map(agentRun => normalizeAgentRun(agentRun, parent, startedAt))
    .filter(Boolean)

  const record = {
    runId,
    groupId,
    threadRootId,
    mode,
    targetKinds,
    status,
    createdAt,
    startedAt,
    updatedAt,
    reason,
    permissionMode,
    currentRound,
    maxRounds,
    unlimitedRounds,
    agentRuns,
  }
  if (TERMINAL_STATUSES.has(status)) {
    record.finishedAt = safeTimestamp(
      selectedValue(input, existing, 'finishedAt'),
      options.touch === true ? now : updatedAt,
    )
  }
  return record
}

function recordTimestamp(record) {
  return record.updatedAt || record.finishedAt || record.startedAt || record.createdAt || 0
}

function oldestTimestamp(record) {
  return record.finishedAt || record.updatedAt || record.startedAt || record.createdAt || 0
}

function pruneRecords(value, maxRuns) {
  const records = [...value]
  while (records.length > maxRuns) {
    let removable = -1
    for (let index = 0; index < records.length; index += 1) {
      if (!TERMINAL_STATUSES.has(records[index].status)) continue
      if (removable < 0 || oldestTimestamp(records[index]) < oldestTimestamp(records[removable])) {
        removable = index
      }
    }
    if (removable < 0) {
      removable = records.reduce((oldest, record, index) => (
        oldestTimestamp(record) < oldestTimestamp(records[oldest]) ? index : oldest
      ), 0)
    }
    records.splice(removable, 1)
  }
  return records
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function newestFirst(records) {
  return records
    .map((record, index) => ({ record, index }))
    .sort((left, right) => (
      recordTimestamp(right.record) - recordTimestamp(left.record)
      || right.index - left.index
    ))
    .map(({ record }) => record)
}

class RunLedger {
  constructor(options = {}) {
    this.storagePath = typeof options.storagePath === 'string'
      ? options.storagePath.trim()
      : ''
    if (!this.storagePath) throw new Error('RUN_LEDGER_STORAGE_REQUIRED')
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.maxRuns = Math.max(1, Math.min(
      MAX_RUNS,
      boundedNumber(options.maxRuns, DEFAULT_MAX_RUNS, MAX_RUNS),
    ))
    this.loadError = null
    this.runs = this.load()
  }

  timestamp() {
    return safeTimestamp(this.now(), Date.now())
  }

  load() {
    try {
      if (!fs.existsSync(this.storagePath)) return []
      const parsed = JSON.parse(fs.readFileSync(this.storagePath, 'utf8'))
      if (!isRecord(parsed) || parsed.version !== STORE_VERSION || !Array.isArray(parsed.runs)) {
        throw new Error('RUN_LEDGER_STORE_INVALID')
      }
      const runIds = new Set()
      const agentRunIds = new Set()
      for (const rawRecord of parsed.runs) {
        const normalized = hasValidStoredRecordShape(rawRecord)
          ? normalizeRecord(rawRecord, { now: 0 })
          : null
        if (!normalized || runIds.has(normalized.runId)) {
          throw new Error('RUN_LEDGER_STORE_INVALID')
        }
        runIds.add(normalized.runId)
        for (const agentRun of rawRecord.agentRuns || []) {
          if (agentRunIds.has(agentRun.agentRunId)) {
            throw new Error('RUN_LEDGER_STORE_INVALID')
          }
          agentRunIds.add(agentRun.agentRunId)
        }
      }
      const byId = new Map()
      for (const rawRecord of parsed.runs.slice(-MAX_RUNS * 4)) {
        const normalized = normalizeRecord(rawRecord, { now: 0 })
        byId.set(normalized.runId, normalized)
      }
      return pruneRecords([...byId.values()], this.maxRuns)
    } catch (error) {
      this.loadError = error instanceof Error ? error : new Error(String(error))
      return []
    }
  }

  assertLoaded() {
    if (this.loadError) throw new Error('RUN_LEDGER_LOAD_FAILED')
  }

  persist(runs = this.runs) {
    atomicWritePrivateFile(
      this.storagePath,
      `${JSON.stringify({ version: STORE_VERSION, runs }, null, 2)}\n`,
    )
  }

  commit(nextRuns) {
    this.persist(nextRuns)
    this.runs = nextRuns
  }

  checkpoint(record) {
    this.assertLoaded()
    if (!isRecord(record) || !cleanId(record.runId)) {
      throw new Error('RUN_LEDGER_RECORD_INVALID')
    }
    const index = this.runs.findIndex(item => item.runId === record.runId)
    const existing = index >= 0 ? this.runs[index] : null
    const normalized = normalizeRecord(record, {
      existing,
      now: this.timestamp(),
      touch: true,
    })
    if (!normalized) throw new Error('RUN_LEDGER_RECORD_INVALID')
    const nextRuns = this.runs.filter((_item, recordIndex) => recordIndex !== index)
    nextRuns.push(normalized)
    this.commit(pruneRecords(nextRuns, this.maxRuns))
    return clone(normalized)
  }

  finish(runId, status, reason = '') {
    this.assertLoaded()
    const id = cleanId(runId)
    const index = this.runs.findIndex(record => record.runId === id)
    if (index < 0) return null
    const requestedStatus = String(status || '').toLowerCase()
    const terminalStatus = TERMINAL_STATUSES.has(requestedStatus) ? requestedStatus : 'failed'
    const now = this.timestamp()
    const normalized = normalizeRecord({
      runId: id,
      status: terminalStatus,
      reason,
      finishedAt: now,
    }, {
      existing: this.runs[index],
      now,
      touch: true,
    })
    const nextRuns = this.runs.filter((_record, recordIndex) => recordIndex !== index)
    nextRuns.push(normalized)
    this.commit(nextRuns)
    return clone(normalized)
  }

  recoverInterrupted() {
    this.assertLoaded()
    const now = this.timestamp()
    const nextRuns = clone(this.runs)
    const changed = []
    for (let index = 0; index < nextRuns.length; index += 1) {
      const record = nextRuns[index]
      let recordChanged = false
      if (!TERMINAL_STATUSES.has(record.status)) {
        record.status = 'interrupted'
        record.reason = 'app_restart'
        record.finishedAt = now
        recordChanged = true
      }
      for (const agentRun of record.agentRuns) {
        if (TERMINAL_STATUSES.has(agentRun.status)) continue
        agentRun.status = 'interrupted'
        agentRun.reason = 'app_restart'
        agentRun.lastActivityAt = now
        agentRun.finishedAt = now
        agentRun.silent = false
        recordChanged = true
      }
      if (!recordChanged) continue
      record.updatedAt = now
      const normalized = normalizeRecord(record, { now })
      nextRuns[index] = normalized
      changed.push(normalized)
    }
    if (changed.length) this.commit(nextRuns)
    return clone(newestFirst(changed))
  }

  list(groupId = '') {
    const requestedGroupId = String(groupId || '')
    const normalizedGroupId = requestedGroupId ? cleanGroupId(requestedGroupId) : ''
    if (requestedGroupId && !normalizedGroupId) return []
    const records = normalizedGroupId
      ? this.runs.filter(record => record.groupId === normalizedGroupId)
      : this.runs
    return clone(newestFirst(records))
  }

  get(runId) {
    const id = cleanId(runId)
    const record = id ? this.runs.find(item => item.runId === id) : null
    return record ? clone(record) : null
  }

  deleteGroup(groupId) {
    this.assertLoaded()
    const id = cleanGroupId(groupId)
    if (!id) return 0
    const before = this.runs.length
    const nextRuns = this.runs.filter(record => record.groupId !== id)
    const removed = before - nextRuns.length
    if (removed) this.commit(nextRuns)
    return removed
  }
}

module.exports = { RunLedger }
