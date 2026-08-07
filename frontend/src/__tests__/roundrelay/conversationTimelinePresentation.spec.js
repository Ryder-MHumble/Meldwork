import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useConversationTimelineLabels } from '../../composables/useConversationTimelineLabels.js'
import { useConversationTimelineUiState } from '../../composables/useConversationTimelineUiState.js'

function translator(key, params = {}) {
  return `${key}:${JSON.stringify(params)}`
}

describe('conversation timeline labels', () => {
  it('localizes statuses, trace events, steps, elapsed time, and turn rail labels', () => {
    const activeGroup = ref({ conversationType: 'group' })
    const locale = ref('zh')
    const topicReplyLabel = vi.fn(count => `replies:${count}`)
    const labels = useConversationTimelineLabels({
      activeGroup,
      locale,
      t: translator,
      topicReplyLabel,
    })

    expect(labels.runStatusLabel('in_progress')).toBe('run.status.running:{}')
    expect(labels.runStatusLabel('round-limit')).toBe('run.status.roundLimit:{}')
    expect(labels.runStatusLabel('unexpected')).toBe('run.status.unknown:{}')
    expect(labels.traceEventTypeLabel('tool_start')).toBe('trace.eventToolStart:{}')
    expect(labels.traceEventTitle({ title: 'connector_fallback' })).toBe('trace.eventConnectorFallback:{}')
    expect(labels.traceEventTitle({ title: 'waiting_for_output' })).toBe('')
    expect(labels.localizedStepTitle({ title: 'write-file' }, 0)).toBe('run.step.writeFile:{}')
    expect(labels.localizedStepTitle({ title: '自定义步骤' }, 2)).toBe('run.step.generic:{"count":3}')
    expect(labels.messageElapsedLabel({ elapsedMs: 1250 })).toBe(
      'conversation.elapsed:{"duration":"conversation.seconds:{\\"count\\":1.3}"}',
    )

    expect(labels.turnRailLabel({ query: 'Q', time: '', status: 'completed', replyCount: 2 })).toBe(
      'conversation.turnRailLabel:{"query":"Q","time":"conversation.timeUnknown:{}","status":"run.status.completed:{}","replies":"replies:2"}',
    )
    expect(topicReplyLabel).toHaveBeenCalledWith(2)

    activeGroup.value = { conversationType: 'direct' }
    locale.value = 'en'
    expect(labels.localizedStepTitle({ title: 'Custom step' }, 0)).toBe('Custom step')
    expect(labels.turnRailLabel({ query: 'Q', time: '10:00', status: 'running', replyCount: 0 })).toBe(
      'conversation.turnRailDirectLabel:{"query":"Q","time":"10:00","status":"run.status.running:{}"}',
    )
  })
})

describe('conversation timeline UI state', () => {
  it('tracks disclosure overrides, dismissed warnings, and finished direct runs immutably', () => {
    const state = useConversationTimelineUiState()
    const liveMessage = { id: 'live-1', provisional: true }
    const durableMessage = { id: 'durable-1' }

    expect(state.isDirectTraceOpen(liveMessage)).toBe(false)
    state.syncDirectTraceDisclosure(liveMessage, { target: { open: true } })
    expect(state.isDirectTraceOpen(liveMessage)).toBe(true)
    state.syncDirectTraceDisclosure(liveMessage, { target: { open: false } })
    expect(state.isDirectTraceOpen(liveMessage)).toBe(false)

    expect(state.isDirectTraceOpen(durableMessage)).toBe(false)
    state.syncDirectTraceDisclosure(durableMessage, { target: { open: true } })
    expect(state.isDirectTraceOpen(durableMessage)).toBe(true)
    state.syncDirectTraceDisclosure(durableMessage, { target: { open: false } })
    expect(state.isDirectTraceOpen(durableMessage)).toBe(false)

    const warning = {
      id: 'warning-1',
      role: 'system',
      content: 'error: Cannot combine --prompt with --plan.',
    }
    expect(state.isDismissibleSystemWarning(warning)).toBe(true)
    state.dismissSystemMessage(warning.id)
    expect(state.dismissedSystemMessageIds.value.has(warning.id)).toBe(true)

    expect(state.hasFinishedDirectRun('group-1')).toBe(false)
    state.setFinishedDirectRun('group-1', true)
    expect(state.hasFinishedDirectRun('group-1')).toBe(true)
    state.setFinishedDirectRun('group-1', false)
    expect(state.hasFinishedDirectRun('group-1')).toBe(false)
  })
})
