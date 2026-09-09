import { ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { useConversationTraceRuns } from '../../composables/useConversationTraceRuns.js'

describe('conversation trace runs', () => {
  it('uses persisted task outcomes after recovery and keeps Agent call status separate', () => {
    const root = { id: 'root', groupId: 'group', role: 'user' }
    const runOutcomes = ref([{ runId: 'run', groupId: 'group', threadRootId: 'root',
      targetKinds: ['codex'], status: 'completed' }])
    const activeRun = ref(null)
    const runs = useConversationTraceRuns({
      activeGroup: ref({ id: 'group', conversationType: 'group' }), activeRun,
      activeRunAgentRuns: ref([]), runOutcomes,
      activeMessages: ref([root, { id: 'reply', groupId: 'group', role: 'agent', agentKind: 'codex',
        threadRootId: 'root', trace: { runId: 'run', agentRunId: 'attempt', status: 'completed', round: 1 } },
      { id: 'error', groupId: 'group', role: 'system', threadRootId: 'root', system: { key: 'system.autoStopped' } }]),
      messageThreadRootId: message => message.threadRootId || '', scopedTargetKinds: () => ['codex'],
      t: key => key, topLevelUserMessages: ref([root]), translateSystemMessage: message => message.content,
    })
    expect(runs.historicalGroupRun.value).toMatchObject({ status: 'completed', authoritative: true })
    for (const status of ['partial', 'round-limit', 'stopped', 'failed']) {
      runOutcomes.value[0].status = status
      expect(runs.historicalGroupRun.value.status).toBe(status)
      expect(runs.historicalGroupRun.value.agentRuns[0].status).toBe('completed')
    }
    runOutcomes.value[0].status = 'running'
    expect(runs.historicalGroupRun.value).toBeNull()
    runOutcomes.value[0].status = 'completed'
    activeRun.value = { runId: 'new-run' }
    expect(runs.historicalGroupRun.value).toBeNull()
    activeRun.value = null
    runOutcomes.value[0] = { ...runOutcomes.value[0], runId: 'new-run', status: 'failed' }
    expect(runs.historicalGroupRun.value).toMatchObject({ runId: 'new-run', status: 'failed', agentRuns: [] })
    runOutcomes.value[0].groupId = 'other'
    expect(runs.historicalGroupRun.value).toBeNull()
  })
  it('merges live and durable traces before rebuilding the latest completed group run', () => {
    const activeGroup = ref({ id: 'group-1', conversationType: 'group' })
    const activeRun = ref({ runId: 'run-1', threadRootId: 'root-1' })
    const activeRunAgentRuns = ref([{
      agentRunId: 'agent-run-1',
      kind: 'codex',
      round: 1,
      status: 'running',
      output: 'live output',
      events: [{ type: 'tool_start', title: 'search' }],
      sourceMessageIds: ['root-1', 'missing-source'],
      startedAt: '2026-08-03T10:00:01.000Z',
    }])
    const rootMessage = {
      id: 'root-1',
      groupId: 'group-1',
      role: 'user',
      content: 'Investigate',
      createdAt: '2026-08-03T10:00:00.000Z',
    }
    const durableMessage = {
      id: 'reply-1',
      groupId: 'group-1',
      role: 'agent',
      agentKind: 'codex',
      content: 'durable output',
      threadRootId: 'root-1',
      createdAt: '2026-08-03T10:00:02.000Z',
      trace: {
        runId: 'run-1',
        agentRunId: 'agent-run-1',
        round: 1,
        status: 'completed',
        events: [{ type: 'tool_result_summary', title: 'search' }],
        sourceMessageIds: ['root-1'],
      },
    }
    const activeMessages = ref([rootMessage, durableMessage])
    const topLevelUserMessages = ref([rootMessage])
    const runs = useConversationTraceRuns({
      activeGroup,
      activeMessages,
      activeRun,
      activeRunAgentRuns,
      messageThreadRootId: message => message.threadRootId || (message.role === 'user' ? message.id : ''),
      scopedTargetKinds: () => ['codex'],
      t: key => key,
      topLevelUserMessages,
      translateSystemMessage: message => message.content,
    })

    expect(runs.allTracePanelItems.value).toEqual([expect.objectContaining({
      agentKind: 'codex',
      status: 'running',
      output: 'durable output',
      live: true,
      sources: [
        { id: 'root-1', available: true, label: 'conversation.you: Investigate' },
        { id: 'missing-source', available: false, label: 'trace.sourceUnavailable' },
      ],
    })])
    expect(runs.historicalGroupRun.value).toBeNull()

    activeRun.value = null
    activeRunAgentRuns.value = []
    expect(runs.historicalGroupRun.value).toEqual(expect.objectContaining({
      runId: 'run-1',
      threadRootId: 'root-1',
      targetKinds: ['codex'],
      status: 'completed',
      eventCount: 1,
    }))
  })

  it('does not expose trace panel items for direct conversations', () => {
    const runs = useConversationTraceRuns({
      activeGroup: ref({ id: 'group-1', conversationType: 'direct' }),
      activeMessages: ref([]),
      activeRun: ref(null),
      activeRunAgentRuns: ref([]),
      messageThreadRootId: () => '',
      scopedTargetKinds: () => [],
      t: key => key,
      topLevelUserMessages: ref([]),
      translateSystemMessage: message => message.content,
    })

    expect(runs.allTracePanelItems.value).toEqual([])
    expect(runs.historicalGroupRun.value).toBeNull()
  })

  it('keeps the live trace when a matching durable system failure arrives during the run', () => {
    const activeRun = ref({ runId: 'run-1', threadRootId: 'root-1' })
    const runs = useConversationTraceRuns({
      activeGroup: ref({ id: 'group-1', conversationType: 'group' }),
      activeMessages: ref([{
        id: 'failure-1',
        role: 'system',
        agentKind: 'codex',
        threadRootId: 'root-1',
        trace: {
          runId: 'run-1',
          agentRunId: 'agent-run-1',
          status: 'failed',
        },
      }]),
      activeRun,
      activeRunAgentRuns: ref([{
        agentRunId: 'agent-run-1',
        kind: 'codex',
        status: 'running',
        output: 'still streaming',
      }]),
      messageThreadRootId: message => message.threadRootId || '',
      scopedTargetKinds: () => ['codex'],
      t: key => key,
      topLevelUserMessages: ref([]),
      translateSystemMessage: message => message.content,
    })

    expect(runs.allTracePanelItems.value).toEqual([expect.objectContaining({
      agentRunId: 'agent-run-1',
      status: 'running',
      output: 'still streaming',
      live: true,
    })])
    expect(runs.allTracePanelItems.value[0]).not.toHaveProperty('messageId')
  })
})
