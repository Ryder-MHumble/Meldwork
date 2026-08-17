import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import RunTracePanel from '../../components/RunTracePanel.vue'
import { retainedTraceEvents } from '../../conversationTimelineModel.js'
import { mergeRunEvent, normalizeSnapshot } from '../../desktop.js'
import { setLocale } from '../../i18n.js'

function runtimeEvent(overrides = {}) {
  return {
    runId: 'run-hermes-live',
    agentRunId: 'agent-hermes-live',
    groupId: 'group-hermes',
    threadRootId: 'root-hermes',
    agentKind: 'hermes',
    round: 1,
    seq: 1,
    type: 'tool_start',
    id: 'tool-hermes',
    title: 'research',
    status: 'running',
    timestamp: '2026-08-15T08:00:00.000Z',
    ...overrides,
  }
}

function liveSnapshot() {
  return normalizeSnapshot({
    agents: [],
    groups: [{ id: 'group-hermes', agentKinds: ['hermes'] }],
    messages: [{
      id: 'root-hermes',
      groupId: 'group-hermes',
      role: 'user',
      content: 'Inspect the result',
      targetKinds: ['hermes'],
    }],
    runningGroupIds: [],
    runs: [],
  })
}

afterEach(() => setLocale('en'))

describe('Meldwork runtime event bridge', () => {
  it('creates a scoped live Agent run and merges one tool lifecycle before terminal status', () => {
    const started = mergeRunEvent(liveSnapshot(), runtimeEvent({
      summary: 'Starting sanitized research',
    }))
    const updated = mergeRunEvent(started, runtimeEvent({
      seq: 2,
      type: 'tool_update',
      summary: 'Updated sanitized research',
    }))
    const toolCompleted = mergeRunEvent(updated, runtimeEvent({
      seq: 3,
      type: 'tool_result_summary',
      status: 'completed',
      summary: 'Final sanitized summary',
      detail: '3 public results',
    }))
    const streaming = mergeRunEvent(toolCompleted, runtimeEvent({
      id: undefined,
      seq: 4,
      type: 'answer_delta',
      status: 'running',
      delta: 'Visible answer',
    }))
    const completed = mergeRunEvent(streaming, runtimeEvent({
      id: 'agent-status',
      seq: 5,
      type: 'status',
      status: 'completed',
    }))

    expect(toolCompleted.runs).toHaveLength(1)
    expect(toolCompleted.runs[0]).toMatchObject({
      groupId: 'group-hermes',
      threadRootId: 'root-hermes',
      targetKinds: ['hermes'],
    })
    expect(toolCompleted.runs[0].agentRuns[0]).toMatchObject({
      kind: 'hermes',
      status: 'running',
      output: '',
    })
    expect(toolCompleted.runs[0].agentRuns[0].events).toEqual([
      expect.objectContaining({
        id: 'tool-hermes',
        type: 'tool_result_summary',
        status: 'completed',
        summary: 'Final sanitized summary',
      }),
    ])
    expect(streaming.runs[0].agentRuns[0].output).toBe('Visible answer')
    expect(streaming.runs[0].agentRuns[0].events).toHaveLength(1)
    expect(completed.runs[0].agentRuns[0].status).toBe('completed')
    expect(completed.runs[0].completedKinds).toEqual(['hermes'])
    expect(completed.runningGroupIds).not.toContain('group-hermes')
  })

  it('keeps sanitized lifecycle order while excluding answer deltas from Trace', () => {
    expect(retainedTraceEvents([
      { seq: 4, type: 'answer_delta', delta: 'visible answer' },
      { seq: 3, type: 'tool_result_summary', title: 'Latest' },
      { seq: 1, type: 'status', title: 'Agent' },
      { seq: 2, type: 'warning', title: 'Earlier' },
    ])).toEqual([
      { seq: 1, type: 'status', title: 'Agent' },
      { seq: 2, type: 'warning', title: 'Earlier' },
      { seq: 3, type: 'tool_result_summary', title: 'Latest' },
    ])
  })

  it('renders every sanitized lifecycle family and preserves an open tool disclosure', async () => {
    const item = events => ({
      runId: 'run-trace',
      agentRunId: 'agent-trace',
      agentKind: 'hermes',
      round: 0,
      status: 'running',
      events,
    })
    const wrapper = mount(RunTracePanel, {
      props: {
        open: true,
        selectedAgentRunId: 'agent-trace',
        items: [item([
          { id: 'status', seq: 1, type: 'status', status: 'running', summary: 'sanitized status' },
          { id: 'reasoning', seq: 2, type: 'reasoning_summary', status: 'completed', summary: 'sanitized reasoning' },
          { id: 'plan', seq: 3, type: 'plan', status: 'completed', summary: 'sanitized plan' },
          { id: 'tool', seq: 4, type: 'tool_start', status: 'running', title: 'search' },
          { id: 'warning', seq: 5, type: 'warning', status: 'partial', summary: 'sanitized warning' },
          { seq: 6, type: 'answer_delta', status: 'running', delta: 'answer body token' },
        ])],
      },
    })

    expect(wrapper.findAll('.trace-event-list > li')).toHaveLength(5)
    expect(wrapper.get('.trace-event-list').text()).toContain('Reasoning summary')
    expect(wrapper.get('.trace-event-list').text()).toContain('Plan')
    expect(wrapper.get('.trace-event-list').text()).toContain('Warning')
    expect(wrapper.get('.trace-event-list').text()).not.toContain('answer body token')
    expect(wrapper.get('.trace-agent-selector .trace-select-trigger small').text())
      .toBe('Response / Running')

    const disclosure = wrapper.findAll('.trace-event-list details')[3].element
    disclosure.open = true
    await wrapper.setProps({
      items: [item([
        { id: 'status', seq: 1, type: 'status', status: 'running', summary: 'sanitized status' },
        { id: 'reasoning', seq: 2, type: 'reasoning_summary', status: 'completed', summary: 'sanitized reasoning' },
        { id: 'plan', seq: 3, type: 'plan', status: 'completed', summary: 'sanitized plan' },
        { id: 'tool', seq: 7, type: 'tool_result_summary', status: 'completed', title: 'search', summary: 'Final sanitized summary' },
        { id: 'warning', seq: 5, type: 'warning', status: 'partial', summary: 'sanitized warning' },
      ])],
    })

    const toolDetails = wrapper.findAll('.trace-event-list details')[4].element
    expect(toolDetails).toBe(disclosure)
    expect(toolDetails.open).toBe(true)
    expect(wrapper.get('.trace-event-live-status').text())
      .toBe('Hermes / Tool result / search / Completed')
    wrapper.unmount()
  })
})
