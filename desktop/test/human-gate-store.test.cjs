const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { ContentBlobStore } = require('../src/content-blob-store.cjs')
const { canonicalJson } = require('../src/outcome-records.cjs')
const {
  createHumanGateRecord,
  decideHumanGateRecord,
  parseHumanGateRecord,
  publicHumanGate,
} = require('../src/human-gate-records.cjs')
const { HumanGateStore } = require('../src/human-gate-store.cjs')

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-human-gates-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const contentBlobStore = new ContentBlobStore({ rootPath: path.join(directory, 'blobs') })
  const storagePath = path.join(directory, 'gates.json')
  const store = new HumanGateStore({ storagePath, contentBlobStore })
  return { contentBlobStore, directory, storagePath, store }
}

function gateInput(contentBlobStore, overrides = {}) {
  const requestRef = contentBlobStore.put('{"tool":"write_file"}', {
    mediaType: 'application/json',
  })
  return {
    type: 'permission',
    runId: 'run-1',
    agentRunId: 'agent-run-1',
    agentKind: 'codex',
    requestRef,
    requestHash: requestRef.hash,
    summary: 'Agent requests permission to edit the workspace.',
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
    ],
    createdAt: '2026-08-04T00:00:00.000Z',
    ...overrides,
  }
}

test('creates content-addressed pending gates without public request references', (t) => {
  const { contentBlobStore } = fixture(t)
  const record = createHumanGateRecord(gateInput(contentBlobStore))
  const restored = parseHumanGateRecord(canonicalJson(record))
  const publicRecord = publicHumanGate(record)

  assert.match(record.gateId, /^human-gate-[a-f0-9]{64}$/)
  assert.equal(restored.gateId, record.gateId)
  assert.equal(record.status, 'pending')
  assert.equal(record.decision, null)
  assert.equal('requestRef' in publicRecord, false)
  assert.equal('requestHash' in publicRecord, false)
  assert.equal(JSON.stringify(publicRecord).includes('write_file'), false)
})

test('accepts one idempotent decision and rejects conflicting decisions', (t) => {
  const { contentBlobStore } = fixture(t)
  const pending = createHumanGateRecord(gateInput(contentBlobStore))
  const decision = {
    status: 'approved',
    optionId: 'allow-once',
    actorId: 'local-user',
    decidedAt: '2026-08-04T00:01:00.000Z',
  }
  const decided = decideHumanGateRecord(pending, decision)

  assert.equal(decided.status, 'approved')
  assert.deepEqual(decided.decision, decision)
  assert.deepEqual(decideHumanGateRecord(decided, decision), decided)
  assert.throws(() => decideHumanGateRecord(decided, {
    ...decision, status: 'rejected', optionId: 'reject-once',
  }), { message: 'HUMAN_GATE_ALREADY_DECIDED' })
  assert.throws(() => decideHumanGateRecord(pending, {
    ...decision, optionId: 'missing-option',
  }), { message: 'HUMAN_GATE_DECISION_INVALID' })

  const withoutReject = createHumanGateRecord(gateInput(contentBlobStore, {
    options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
  }))
  const systemRejected = decideHumanGateRecord(withoutReject, {
    status: 'rejected',
    optionId: 'meldwork-system-reject',
    actorId: 'meldwork-system',
    decidedAt: '2026-08-04T00:01:00.000Z',
  })
  assert.equal(systemRejected.status, 'rejected')
  assert.throws(() => decideHumanGateRecord(withoutReject, {
    status: 'rejected',
    optionId: 'meldwork-system-reject',
    actorId: 'local-user',
    decidedAt: '2026-08-04T00:01:00.000Z',
  }), { message: 'HUMAN_GATE_DECISION_INVALID' })
})

test('persists private requests, pending state, and decisions across restart', (t) => {
  const { contentBlobStore, storagePath, store } = fixture(t)
  const created = store.create({
    type: 'permission',
    runId: 'run-1',
    agentRunId: 'agent-run-1',
    agentKind: 'hermes',
    summary: 'Agent requests workspace access.',
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
    ],
    createdAt: '2026-08-04T00:00:00.000Z',
    request: { tool: 'write_file', path: '/private/work/report.md', token: 'private-token' },
  })

  assert.deepEqual(store.request(created.gateId), {
    path: '/private/work/report.md', token: 'private-token', tool: 'write_file',
  })
  assert.equal(fs.readFileSync(storagePath, 'utf8').includes('private-token'), false)
  assert.equal(fs.readFileSync(storagePath, 'utf8').includes('/private/work'), false)
  assert.deepEqual(store.list({ pendingOnly: true }).map(gate => gate.gateId), [created.gateId])

  const restarted = new HumanGateStore({ storagePath, contentBlobStore })
  const decided = restarted.decide(created.gateId, {
    status: 'rejected',
    optionId: 'reject-once',
    actorId: 'local-user',
    decidedAt: '2026-08-04T00:02:00.000Z',
  })
  assert.equal(decided.status, 'rejected')
  assert.deepEqual(
    new HumanGateStore({ storagePath, contentBlobStore }).list({ pendingOnly: true }),
    [],
  )
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(storagePath).mode & 0o777, 0o600)
  }
})

test('rolls back only the exact durable decision to a retryable pending gate', (t) => {
  const { contentBlobStore, storagePath, store } = fixture(t)
  const created = store.create({
    type: 'permission',
    runId: 'run-rollback',
    agentRunId: 'agent-run-rollback',
    agentKind: 'codex',
    summary: 'Agent requests permission to edit the workspace.',
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
    ],
    createdAt: '2026-08-04T00:00:00.000Z',
    request: { tool: 'write_file' },
  })
  const decision = {
    status: 'approved',
    optionId: 'allow-once',
    actorId: 'local-user',
    decidedAt: '2026-08-04T00:01:00.000Z',
  }
  store.decide(created.gateId, decision)

  assert.throws(() => store.rollbackDecision(created.gateId, {
    ...decision, optionId: 'reject-once', status: 'rejected',
  }), { message: 'HUMAN_GATE_ROLLBACK_INVALID' })
  const pending = store.rollbackDecision(created.gateId, decision)

  assert.equal(pending.status, 'pending')
  assert.equal(pending.decision, null)
  assert.deepEqual(
    new HumanGateStore({ storagePath, contentBlobStore }).list({ pendingOnly: true })
      .map(gate => gate.gateId),
    [created.gateId],
  )
  assert.throws(() => store.rollbackDecision(created.gateId, decision), {
    message: 'HUMAN_GATE_ROLLBACK_INVALID',
  })
})

test('accepts the typed role-review decision Gate contract', (t) => {
  const { store } = fixture(t)
  const record = store.create({
    type: 'decision',
    runId: 'run-role-review',
    agentRunId: 'agent-run-reviewer',
    agentKind: 'claude',
    summary: 'Role review requires a human decision.',
    options: [
      { optionId: 'accept-artifact', name: 'Accept Artifact', kind: 'accept' },
      { optionId: 'reject-artifact', name: 'Reject Artifact', kind: 'reject' },
      { optionId: 'reopen-task', name: 'Reopen Task', kind: 'reopen' },
    ],
    createdAt: '2026-08-04T00:00:00.000Z',
    request: { workflowId: `workflow-${'a'.repeat(64)}` },
  })

  assert.equal(record.type, 'decision')
  assert.deepEqual(store.list({ pendingOnly: true })[0].options.map(option => (
    [option.optionId, option.kind]
  )), [
    ['accept-artifact', 'accept'],
    ['reject-artifact', 'reject'],
    ['reopen-task', 'reopen'],
  ])
})

test('fails closed for secret-bearing public summaries and missing request blobs', (t) => {
  const { contentBlobStore, store } = fixture(t)
  assert.throws(() => store.create({
    type: 'budget',
    runId: 'run-1',
    agentRunId: 'agent-run-1',
    agentKind: 'codex',
    summary: 'Authorization: Bearer private-value',
    options: [{ optionId: 'reject', name: 'Reject', kind: 'reject' }],
    createdAt: '2026-08-04T00:00:00.000Z',
    request: { dimension: 'outboundBytes' },
  }), { message: 'HUMAN_GATE_SCHEMA_INVALID' })

  const created = store.create({
    type: 'budget',
    runId: 'run-1',
    agentRunId: 'agent-run-1',
    agentKind: 'codex',
    summary: 'Outbound byte usage is unavailable.',
    options: [{ optionId: 'reject', name: 'Reject', kind: 'reject' }],
    createdAt: '2026-08-04T00:00:00.000Z',
    request: { dimension: 'outboundBytes' },
  })
  const blobPath = path.join(
    contentBlobStore.rootPath,
    'sha256',
    created.requestRef.hash.slice(0, 2),
    created.requestRef.hash,
  )
  fs.unlinkSync(blobPath)
  assert.throws(() => store.get(created.gateId), { message: 'HUMAN_GATE_REQUEST_NOT_FOUND' })
})
