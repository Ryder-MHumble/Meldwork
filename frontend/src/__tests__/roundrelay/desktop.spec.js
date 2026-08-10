import { afterEach, describe, expect, it } from 'vitest'
import {
  desktopApi,
  mergeRunEvent,
  normalizeCapsuleEvent,
  normalizeMessageTrace,
  normalizeRunAgent,
  normalizeRunEvent,
  normalizeSnapshot,
} from '../../desktop.js'
import * as desktop from '../../desktop.js'

afterEach(() => {
  delete window.roundrelayDesktop
})

describe('desktop bridge access', () => {
  it('keeps the public desktop facade stable', () => {
    expect(Object.keys(desktop).sort()).toEqual([
      'desktopApi',
      'emptySnapshot',
      'errorCode',
      'mergeRunEvent',
      'normalizeCapsuleEvent',
      'normalizeMessageTrace',
      'normalizeRunAgent',
      'normalizeRunEvent',
      'normalizeSnapshot',
    ])
  })

  it('reads the RoundRelay preload bridge', () => {
    const bridge = {
      localWorkspace: { get() {} },
      agentInstaller: { catalog() {} },
      localAgentProvider: { status() {} },
    }
    window.roundrelayDesktop = bridge

    expect(desktopApi()).toBe(bridge)
  })
})

describe('run event normalization', () => {
  const event = overrides => ({
    runId: 'run-1',
    agentRunId: 'agent-run-1',
    groupId: 'group-1',
    threadRootId: 'root-1',
    agentKind: 'codex',
    round: 1,
    seq: 1,
    type: 'answer_delta',
    delta: 'First',
    timestamp: '2026-07-31T12:00:00.000Z',
    ...overrides,
  })
  const budgetSnapshot = overrides => ({
    limits: {
      inputTokens: 4000,
      outputTokens: null,
      costMicros: null,
      toolCalls: 20,
      outboundBytes: null,
      elapsedMs: null,
    },
    used: {
      inputTokens: 750,
      outputTokens: 120,
      costMicros: 0,
      toolCalls: 3,
      outboundBytes: 2048,
      elapsedMs: 2500,
    },
    source: {
      inputTokens: 'estimated',
      outputTokens: 'reported',
      costMicros: 'unknown',
      toolCalls: 'estimated',
      outboundBytes: 'reported',
      elapsedMs: 'reported',
    },
    enforcement: {
      inputTokens: 'hard',
      outputTokens: 'soft',
      costMicros: 'hard',
      toolCalls: 'hard',
      outboundBytes: 'soft',
      elapsedMs: 'soft',
    },
    startedAt: 1000,
    exhaustion: null,
    ...overrides,
  })
  const humanGate = (gateId, overrides = {}) => ({
    gateId,
    type: 'permission',
    runId: 'run-gated',
    agentRunId: 'agent-gated',
    agentKind: 'codex',
    summary: 'Agent requests permission to continue a tool action.',
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
    ],
    status: 'pending',
    createdAt: '2026-08-04T08:00:00.000Z',
    ...overrides,
  })

  it('keeps only bounded public fields and rejects unsupported events', () => {
    const normalized = normalizeRunEvent(event({
      status: 'running',
      summary: 'Visible summary',
      detail: 'Visible detail',
      executable: '/private/bin/codex',
      sessionRef: 'secret-session',
    }))

    expect(normalized).toEqual({
      runId: 'run-1',
      agentRunId: 'agent-run-1',
      groupId: 'group-1',
      threadRootId: 'root-1',
      agentKind: 'codex',
      round: 1,
      seq: 1,
      type: 'answer_delta',
      status: 'running',
      summary: 'Visible summary',
      detail: 'Visible detail',
      delta: 'First',
      timestamp: '2026-07-31T12:00:00.000Z',
    })
    expect(normalizeRunEvent(event({ type: 'raw_stdout' }))).toBeNull()
    expect(normalizeRunEvent(event({ runId: '../private' }))).toBeNull()
    expect(normalizeRunEvent(event({ delta: 'x'.repeat(16001) }))).toBeNull()
  })

  it('preserves bounded Unicode group ids while keeping execution ids ASCII-only', () => {
    const groupId = '项目协作组-甲'
    const normalized = normalizeRunEvent(event({ groupId }))

    expect(normalized).toMatchObject({
      runId: 'run-1',
      agentRunId: 'agent-run-1',
      groupId,
      threadRootId: 'root-1',
    })
    expect(normalizeRunEvent(event({ groupId: '项目\n组' }))).toBeNull()
    expect(normalizeRunEvent(event({ groupId: '组'.repeat(101) }))).toBeNull()
    expect(normalizeRunEvent(event({ groupId, runId: '运行-1' }))).toBeNull()
    expect(normalizeRunEvent(event({ groupId, agentRunId: '代理-1' }))).toBeNull()
    expect(normalizeRunEvent(event({ groupId, threadRootId: '线程-1' }))).not.toHaveProperty('threadRootId')

    const snapshot = normalizeSnapshot({
      agents: [],
      groups: [],
      messages: [],
      runningGroupIds: [groupId],
      runs: [{
        runId: 'run-1',
        groupId,
        threadRootId: 'root-1',
        targetKinds: ['codex'],
        agentRuns: [{
          agentRunId: 'agent-run-1',
          kind: 'codex',
          round: 1,
          status: 'running',
          events: [{ seq: 1, type: 'reasoning_summary', summary: 'Visible summary' }],
        }],
      }],
    })

    expect(snapshot.runs[0].groupId).toBe(groupId)
    expect(snapshot.runs[0].agentRuns[0].events[0].groupId).toBe(groupId)
  })

  it('normalizes bounded run agents and durable traces from snapshots', () => {
    const contextPackId = `context-pack-${'a'.repeat(64)}`
    const deliveryRecordIds = Array.from(
      { length: 10 },
      (_, index) => `delivery-record-${String(index).padStart(64, '0')}`,
    )
    const sessionProvenance = {
      scope: 'conversation',
      reuse: true,
      origin: 'resumed',
      originTaskId: 'task-origin',
      inheritedTaskIds: ['task-earlier'],
      completeness: 'complete',
    }
    const run = {
      runId: 'run-1',
      groupId: 'group-1',
      threadRootId: 'root-1',
    }
    const agent = normalizeRunAgent({
      agentRunId: 'agent-run-1',
      kind: 'codex',
      round: 2,
      status: 'running',
      output: 'Streaming answer',
      sourceMessageIds: ['root-1', '../private'],
      events: [
        event({ seq: 3, type: 'reasoning_summary', delta: undefined, summary: 'Compare both options' }),
        event({ seq: 4, type: 'raw_stdout', delta: undefined, detail: 'private output' }),
      ],
      executable: '/private/bin/codex',
    }, run)

    expect(agent).toMatchObject({
      agentRunId: 'agent-run-1',
      kind: 'codex',
      round: 2,
      status: 'running',
      output: 'Streaming answer',
      sourceMessageIds: ['root-1'],
    })
    expect(agent.events.map(item => item.type)).toEqual(['reasoning_summary'])
    expect(agent).not.toHaveProperty('executable')

    const trace = normalizeMessageTrace({
      runId: 'run-1',
      agentRunId: 'agent-run-1',
      round: 2,
      status: 'completed',
      summary: 'Final trace summary',
      events: [
        {
          evidenceId: 'E-R2-CODEX-01',
          type: 'reasoning_summary',
          status: 'completed',
          summary: 'Compare both options',
          seq: 99,
          detail: 'Output: 5 lines, 47 bytes',
        },
        {
          evidenceId: 'E-R2-CODEX-02',
          type: 'tool_start',
          status: 'partial',
          title: 'read_file',
          summary: 'read: docs/architecture.md',
        },
        { evidenceId: 'E-R2-CODEX-03', type: 'raw_stdout', status: 'completed' },
      ],
      sourceMessageIds: ['root-1'],
      truncated: true,
      context: {
        includedCount: 3,
        omittedCount: 7,
        charCount: 1200,
        sessionRotated: true,
        contextPackId,
        deliveryRecordIds: [deliveryRecordIds[0], 'invalid-record', ...deliveryRecordIds, deliveryRecordIds[9]],
        sessionProvenance,
        ignored: 'secret',
      },
    }, { groupId: 'group-1', threadRootId: 'root-1', agentKind: 'codex' })

    expect(trace).toMatchObject({
      runId: 'run-1',
      agentRunId: 'agent-run-1',
      round: 2,
      status: 'completed',
      summary: 'Final trace summary',
      truncated: true,
      context: {
        includedCount: 3,
        omittedCount: 7,
        charCount: 1200,
        sessionRotated: true,
        contextPackId,
        deliveryRecordIds: deliveryRecordIds.slice(-8),
        sessionProvenance,
      },
    })
    expect(trace.events).toEqual([
      {
        evidenceId: 'E-R2-CODEX-01',
        type: 'reasoning_summary',
        status: 'completed',
        summary: 'Compare both options',
        detail: 'Output: 5 lines, 47 bytes',
      },
      {
        evidenceId: 'E-R2-CODEX-02',
        type: 'tool_start',
        status: 'partial',
        title: 'read_file',
        summary: 'read: docs/architecture.md',
      },
    ])
    expect(trace.context).not.toHaveProperty('ignored')

    const snapshot = normalizeSnapshot({
      agents: [],
      groups: [],
      runningGroupIds: ['group-1'],
      runs: [{ ...run, agentRuns: [agent] }],
      messages: [{
        id: 'message-1', groupId: 'group-1', role: 'agent', agentKind: 'codex', trace,
      }],
    })
    expect(snapshot.runs[0].agentRuns[0].output).toBe('Streaming answer')
    expect(snapshot.messages[0].trace.agentRunId).toBe('agent-run-1')
    expect(snapshot.messages[0].trace.round).toBe(2)
  })

  it('drops malformed Context Pack and Session provenance fields', () => {
    const trace = normalizeMessageTrace({
      runId: 'run-1',
      agentRunId: 'agent-run-1',
      context: {
        contextPackId: `context-pack-${'A'.repeat(64)}`,
        deliveryRecordIds: ['delivery-record-not-a-hash'],
        sessionProvenance: {
          scope: 'task',
          reuse: true,
          origin: 'created',
          originTaskId: 'task-1',
          inheritedTaskIds: [],
          completeness: 'complete',
          privateSessionRef: 'must-not-cross-the-bridge',
        },
      },
    })

    expect(trace.context).toEqual({ includedCount: 0, omittedCount: 0, charCount: 0 })
  })

  it('preserves an explicit legacy Context Pack provenance gap', () => {
    const trace = normalizeMessageTrace({
      runId: 'run-legacy-context',
      agentRunId: 'agent-run-legacy-context',
      context: { contextPackState: 'legacy-unavailable' },
    })

    expect(trace.context).toEqual({
      includedCount: 0,
      omittedCount: 0,
      charCount: 0,
      contextPackState: 'legacy-unavailable',
    })
  })

  it('retains only exact budget snapshots and linked pending Human Gates', () => {
    const gateId = `human-gate-${'a'.repeat(64)}`
    const mismatchedGateId = `human-gate-${'b'.repeat(64)}`
    const extraFieldGateId = `human-gate-${'c'.repeat(64)}`
    const budget = budgetSnapshot({
      limits: { ...budgetSnapshot().limits, toolCalls: 2 },
      used: { ...budgetSnapshot().used, toolCalls: 3 },
      exhaustion: {
        dimension: 'toolCalls',
        limit: 2,
        priorUsed: 2,
        attemptedUsage: 1,
        used: 3,
        source: 'estimated',
        enforcement: 'hard',
        reason: 'BUDGET_LIMIT_EXCEEDED',
      },
    })
    const snapshot = normalizeSnapshot({
      agents: [],
      groups: [],
      messages: [],
      runningGroupIds: ['group-gated'],
      runs: [{
        runId: 'run-gated',
        groupId: 'group-gated',
        targetKinds: ['codex'],
        currentKind: 'codex',
        waitingGateIds: [gateId, mismatchedGateId, extraFieldGateId, gateId],
        budget,
        agentRuns: [{
          agentRunId: 'agent-gated', kind: 'codex', round: 1, status: 'waiting', events: [],
        }],
      }],
      humanGates: [
        humanGate(gateId, {
          type: 'decision',
          summary: 'This run requires a human decision.',
          options: [
            { optionId: 'accept-artifact', name: 'Accept Artifact', kind: 'accept' },
            { optionId: 'reject-artifact', name: 'Reject Artifact', kind: 'reject' },
            { optionId: 'reopen-task', name: 'Reopen Task', kind: 'reopen' },
          ],
        }),
        humanGate(mismatchedGateId, { agentRunId: 'agent-other' }),
        { ...humanGate(extraFieldGateId), requestHash: 'must-not-cross-the-bridge' },
      ],
    })

    expect(snapshot.runs[0].budget).toEqual(budget)
    expect(snapshot.runs[0].waitingGateIds).toEqual([gateId])
    expect(snapshot.humanGates).toEqual([humanGate(gateId, {
      type: 'decision',
      summary: 'This run requires a human decision.',
      options: [
        { optionId: 'accept-artifact', name: 'Accept Artifact', kind: 'accept' },
        { optionId: 'reject-artifact', name: 'Reject Artifact', kind: 'reject' },
        { optionId: 'reopen-task', name: 'Reopen Task', kind: 'reopen' },
      ],
    })])
  })

  it('accepts a strict pending input Gate without exposing response data', () => {
    const gateId = `human-gate-${'d'.repeat(64)}`
    const inputGate = humanGate(gateId, {
      type: 'input',
      summary: 'Choose release channel',
      options: [
        { optionId: 'submit-input', name: 'Submit', kind: 'respond' },
        { optionId: 'cancel-input', name: 'Cancel', kind: 'reject' },
      ],
    })
    const snapshot = normalizeSnapshot({
      agents: [], groups: [], messages: [], runningGroupIds: [],
      runs: [{
        runId: 'run-gated', groupId: 'group-gated', targetKinds: ['codex'],
        waitingGateIds: [gateId],
        agentRuns: [{ agentRunId: 'agent-gated', kind: 'codex', status: 'waiting' }],
      }],
      humanGates: [inputGate, { ...inputGate, response: 'must-not-cross-the-bridge' }],
    })

    expect(snapshot.humanGates).toEqual([inputGate])
  })

  it('drops budget snapshots with extra or missing fields', () => {
    const valid = budgetSnapshot()
    const malformed = [
      { ...valid, privateCost: 42 },
      { ...valid, limits: { ...valid.limits, privateLimit: 1 } },
      { ...valid, limits: { inputTokens: 4000 } },
      { ...valid, used: { ...valid.used, inputTokens: -1 } },
      { ...valid, source: { ...valid.source, costMicros: 'guessed' } },
      { ...valid, enforcement: { ...valid.enforcement, toolCalls: 'warn' } },
      { ...valid, exhaustion: { ...valid.exhaustion, used: 4 } },
    ]

    for (const budget of malformed) {
      const snapshot = normalizeSnapshot({
        agents: [],
        groups: [],
        messages: [],
        runningGroupIds: ['group-budget'],
        runs: [{
          runId: 'run-budget',
          groupId: 'group-budget',
          targetKinds: ['codex'],
          budget,
          agentRuns: [],
        }],
      })
      expect(snapshot.runs[0]).not.toHaveProperty('budget')
    }
  })

  it('merges answer deltas by run, Agent run, and sequence without duplicates', () => {
    const base = normalizeSnapshot({
      agents: [],
      groups: [],
      messages: [],
      runningGroupIds: ['group-1'],
      runs: [{
        runId: 'run-1',
        groupId: 'group-1',
        threadRootId: 'root-1',
        targetKinds: ['codex'],
        agentRuns: [],
      }],
    })
    const first = mergeRunEvent(base, event({ seq: 10, delta: 'First' }))
    const duplicate = mergeRunEvent(first, event({ seq: 10, delta: 'First' }))
    const second = mergeRunEvent(duplicate, event({ seq: 11, delta: ' answer' }))

    expect(base.runs[0].agentRuns).toEqual([])
    expect(first.runs[0].agentRuns[0].output).toBe('First')
    expect(duplicate).toBe(first)
    expect(second.runs[0].agentRuns[0].output).toBe('First answer')
    expect(second.runs[0].agentRuns[0].events.map(item => item.seq)).toEqual([10, 11])
    expect(mergeRunEvent(second, event({ seq: 12, type: 'unknown' }))).toBe(second)
  })

  it('does not synthesize a Run from an event without a durable snapshot record', () => {
    const snapshot = normalizeSnapshot({
      agents: [],
      groups: [],
      messages: [],
      runningGroupIds: [],
      runs: [],
    })

    expect(mergeRunEvent(snapshot, event({ seq: 13 }))).toBe(snapshot)
    expect(snapshot.runs).toEqual([])
    expect(snapshot.runningGroupIds).toEqual([])
  })

  it('upserts a tool lifecycle by public tool id', () => {
    const base = normalizeSnapshot({
      agents: [],
      groups: [],
      messages: [],
      runningGroupIds: ['group-1'],
      runs: [{
        runId: 'run-1',
        groupId: 'group-1',
        threadRootId: 'root-1',
        targetKinds: ['codex'],
        agentRuns: [],
      }],
    })
    const started = mergeRunEvent(base, event({
      id: 'tool-1', seq: 20, type: 'tool_start', delta: undefined, title: 'search', status: 'running',
    }))
    const completed = mergeRunEvent(started, event({
      id: 'tool-1', seq: 21, type: 'tool_result_summary', delta: undefined,
      title: 'search', summary: 'Found three files', status: 'completed',
    }))

    expect(started.runs[0].agentRuns[0].events).toHaveLength(1)
    expect(completed.runs[0].agentRuns[0].events).toEqual([expect.objectContaining({
      id: 'tool-1',
      seq: 21,
      type: 'tool_result_summary',
      summary: 'Found three files',
    })])
    expect(completed.runs[0].agentRuns[0].seenSeqs).toEqual([20, 21])
  })

  it('backfills missing fields for an already-seen sequence without replaying output', () => {
    const base = normalizeSnapshot({
      agents: [],
      groups: [],
      messages: [],
      runningGroupIds: ['group-1'],
      runs: [{
        runId: 'run-1',
        groupId: 'group-1',
        threadRootId: 'root-1',
        targetKinds: ['codex'],
        agentRuns: [{
          agentRunId: 'agent-run-1',
          kind: 'codex',
          round: 1,
          status: 'running',
          output: 'First',
          seenSeqs: [10, 11],
          events: [event({
            id: 'tool-1', seq: 11, type: 'tool_result_summary', delta: undefined,
            title: 'search', summary: undefined, detail: undefined, status: 'completed',
          })],
        }],
      }],
    })

    const backfilled = mergeRunEvent(base, event({
      id: 'tool-1', seq: 11, type: 'tool_result_summary', delta: undefined,
      title: 'search', summary: 'Found three files', detail: 'Names only', status: 'completed',
    }))
    const replay = mergeRunEvent(backfilled, event({
      seq: 10, type: 'answer_delta', delta: ' answer', status: 'running',
    }))

    expect(backfilled.runs[0].agentRuns[0].output).toBe('First')
    expect(backfilled.runs[0].agentRuns[0].events).toHaveLength(1)
    expect(backfilled.runs[0].agentRuns[0].events[0]).toMatchObject({
      seq: 11,
      summary: 'Found three files',
      detail: 'Names only',
    })
    expect(replay).toBe(backfilled)
    expect(replay.runs[0].agentRuns[0].output).toBe('First')
    expect(replay.runs[0].agentRuns[0].events).toHaveLength(1)
  })

  it('keeps a group marked running until every target Agent reaches a terminal state', () => {
    const base = normalizeSnapshot({
      agents: [],
      groups: [],
      messages: [],
      runningGroupIds: ['group-1'],
      runs: [{
        runId: 'run-1',
        groupId: 'group-1',
        targetKinds: ['codex', 'hermes'],
        agentRuns: [],
      }],
    })
    const codexDone = mergeRunEvent(base, event({
      agentRunId: 'agent-codex', agentKind: 'codex', seq: 30,
      type: 'status', delta: undefined, status: 'completed',
    }))
    const hermesDone = mergeRunEvent(codexDone, event({
      agentRunId: 'agent-hermes', agentKind: 'hermes', seq: 31,
      type: 'status', delta: undefined, status: 'completed',
    }))

    expect(codexDone.runningGroupIds).toContain('group-1')
    expect(hermesDone.runningGroupIds).not.toContain('group-1')

    const autoBase = normalizeSnapshot({
      agents: [],
      groups: [],
      messages: [],
      runningGroupIds: ['group-1'],
      runs: [{
        runId: 'run-auto',
        groupId: 'group-1',
        mode: 'auto',
        targetKinds: ['codex', 'hermes'],
        agentRuns: [],
      }],
    })
    const autoCodexDone = mergeRunEvent(autoBase, event({
      runId: 'run-auto', agentRunId: 'agent-auto-codex', agentKind: 'codex', seq: 40,
      type: 'status', delta: undefined, status: 'completed',
    }))
    const autoRoundDone = mergeRunEvent(autoCodexDone, event({
      runId: 'run-auto', agentRunId: 'agent-auto-hermes', agentKind: 'hermes', seq: 41,
      type: 'status', delta: undefined, status: 'completed',
    }))

    expect(autoRoundDone.runningGroupIds).toContain('group-1')
  })

  it('keeps a persisted message target subset authoritative across snapshots and later run events', () => {
    const snapshot = normalizeSnapshot({
      agents: [],
      groups: [],
      messages: [{
        id: 'root-subset',
        groupId: 'group-1',
        role: 'user',
        content: 'openclaw和claude code你们俩互相了解下对方',
        targetKinds: ['openclaw', 'claude'],
      }],
      runningGroupIds: ['group-1'],
      runs: [{
        runId: 'run-subset',
        groupId: 'group-1',
        threadRootId: 'root-subset',
        mode: 'auto',
        targetKinds: ['codex', 'openclaw', 'claude'],
        currentKind: 'codex',
        completedKinds: ['openclaw', 'codex'],
        failedKinds: ['codex'],
        agentRuns: [
          { agentRunId: 'subset-openclaw-r1', kind: 'openclaw', round: 1, status: 'completed' },
          { agentRunId: 'subset-claude-r1', kind: 'claude', round: 1, status: 'completed' },
          { agentRunId: 'subset-codex-r2', kind: 'codex', round: 2, status: 'running' },
        ],
      }],
    })

    expect(snapshot.runs[0]).toMatchObject({
      targetKinds: ['openclaw', 'claude'],
      currentKind: '',
      completedKinds: ['openclaw'],
      failedKinds: [],
    })
    expect(snapshot.runs[0].agentRuns.map(agent => agent.kind)).toEqual(['openclaw', 'claude'])

    const stray = mergeRunEvent(snapshot, event({
      runId: 'run-subset',
      agentRunId: 'subset-codex-r3',
      agentKind: 'codex',
      round: 3,
      seq: 60,
      type: 'status',
      delta: undefined,
      status: 'running',
    }))
    expect(stray).toBe(snapshot)

    const nextRound = mergeRunEvent(snapshot, event({
      runId: 'run-subset',
      agentRunId: 'subset-openclaw-r2',
      agentKind: 'openclaw',
      round: 2,
      seq: 61,
      type: 'reasoning_summary',
      delta: undefined,
      summary: 'Round two remains scoped',
      status: 'running',
    }))
    expect(nextRound.runs[0].targetKinds).toEqual(['openclaw', 'claude'])
    expect(nextRound.runs[0].agentRuns.map(agent => agent.kind)).toEqual(['openclaw', 'claude', 'openclaw'])
  })

  it('initializes an empty live run scope from its first accepted event', () => {
    const snapshot = normalizeSnapshot({
      agents: [],
      groups: [],
      messages: [],
      runningGroupIds: [],
      runs: [{ runId: 'run-empty', groupId: 'group-1', targetKinds: [], agentRuns: [] }],
    })
    const first = mergeRunEvent(snapshot, event({
      runId: 'run-empty',
      agentRunId: 'empty-openclaw-r1',
      agentKind: 'openclaw',
      seq: 70,
    }))

    expect(first.runs[0].targetKinds).toEqual(['openclaw'])
    expect(first.runs[0].agentRuns.map(agent => agent.kind)).toEqual(['openclaw'])
  })

  it('drops late events after the durable traced message has replaced the active run', () => {
    const snapshot = normalizeSnapshot({
      agents: [],
      groups: [],
      runningGroupIds: [],
      runs: [],
      messages: [{
        id: 'message-1',
        groupId: 'group-1',
        role: 'agent',
        agentKind: 'codex',
        trace: {
          runId: 'run-1', agentRunId: 'agent-run-1', status: 'completed', context: {},
        },
      }],
    })

    expect(mergeRunEvent(snapshot, event({ seq: 99, delta: 'late' }))).toBe(snapshot)
  })

  it('normalizes allowlisted durable tool lifecycle events without live-only fields', () => {
    expect(normalizeCapsuleEvent({
      evidenceId: 'E-R1-HERMES-01',
      type: 'tool_result_summary',
      status: 'waiting',
      title: 'Browser research',
      summary: 'Collected three sources',
      detail: 'Result: 3 items\nBearer private-token',
      runId: 'must-not-survive',
      seq: 42,
    })).toEqual({
      evidenceId: 'E-R1-HERMES-01',
      type: 'tool_result_summary',
      status: 'waiting',
      title: 'Browser research',
      summary: 'Collected three sources',
      detail: 'Result: 3 items',
    })

    expect(normalizeCapsuleEvent({
      evidenceId: 'E-R1-HERMES-02',
      type: 'tool_start',
      status: 'partial',
      title: 'Read file',
      summary: 'frontend/package.json',
      detail: 'Output: 1 line, 400 bytes\nraw private payload',
      command: 'cat frontend/package.json',
    })).toEqual({
      evidenceId: 'E-R1-HERMES-02',
      type: 'tool_start',
      status: 'partial',
      title: 'Read file',
      summary: 'frontend/package.json',
      detail: 'Output: 1 line, 400 bytes',
    })

    expect(normalizeCapsuleEvent({
      evidenceId: 'E-R1-HERMES-03',
      type: 'tool_update',
      status: 'partial',
      title: 'Read file',
      summary: 'desktop/package.json',
      executable: '/private/bin/hermes',
    })).toEqual({
      evidenceId: 'E-R1-HERMES-03',
      type: 'tool_update',
      status: 'partial',
      title: 'Read file',
      summary: 'desktop/package.json',
    })

    expect(normalizeCapsuleEvent({
      evidenceId: 'E-R1-HERMES-04', type: 'raw_stdout', status: 'partial',
    })).toBeNull()
  })
})
