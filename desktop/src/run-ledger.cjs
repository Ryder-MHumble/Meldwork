const fs = require('node:fs')

const { atomicWritePrivateFile } = require('./private-file.cjs')
const {
  TERMINAL_STATUSES,
  boundedNumber,
  cleanGroupId,
  cleanId,
  clone,
  hasValidStoredRecordShape,
  isRecord,
  newestFirst,
  normalizeRecord,
  pruneRecords,
  safeTimestamp,
} = require('./run-ledger-records.cjs')

const STORE_VERSION = 1
const DEFAULT_MAX_RUNS = 64
const MAX_RUNS = 512

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
