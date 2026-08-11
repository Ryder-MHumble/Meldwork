import { describe, expect, it } from 'vitest'
import {
  durableRunTurnStatus,
  retainedTraceEvents,
  runStatusTone,
  traceRound,
} from '../../composables/useConversationTimeline.js'

describe('conversation timeline helpers', () => {
  it('keeps meaningful trace events and removes streaming placeholders', () => {
    expect(retainedTraceEvents([
      { type: 'answer_delta', summary: 'partial answer' },
      { type: 'status', title: 'agent' },
      { type: 'status', title: 'process' },
      { type: 'tool_start', title: 'Read file' },
    ])).toEqual([
      { type: 'tool_start', title: 'Read file' },
    ])
  })

  it('derives a round from explicit metadata before evidence identifiers', () => {
    expect(traceRound({ round: 3, events: [{ evidenceId: 'E-R8-1' }] })).toBe(3)
    expect(traceRound({ events: [{ evidenceId: 'E-R8-1' }] })).toBe(8)
    expect(traceRound({ events: [] })).toBe(0)
  })

  it('uses each Agent latest attempt when folding a durable run status', () => {
    expect(durableRunTurnStatus({
      agentAttempts: [
        { agentKind: 'codex', round: 1, index: 1, status: 'failed' },
        { agentKind: 'codex', round: 2, index: 2, status: 'completed' },
        { agentKind: 'hermes', round: 2, index: 3, status: 'timeout' },
      ],
    })).toBe('partial')
  })

  it('maps terminal and live statuses to stable presentation tones', () => {
    expect(runStatusTone('succeeded')).toBe('completed')
    expect(runStatusTone('timeout')).toBe('failed')
    expect(runStatusTone('budget-exhausted')).toBe('failed')
    expect(runStatusTone('circuit-breaker')).toBe('failed')
    expect(runStatusTone('interrupted')).toBe('partial')
    expect(runStatusTone('in_progress')).toBe('running')
    expect(runStatusTone('pending')).toBe('queued')
  })
})
