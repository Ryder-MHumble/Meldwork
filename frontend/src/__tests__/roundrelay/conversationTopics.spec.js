import { effectScope, ref } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import { useConversationTopics } from '../../composables/useConversationTopics.js'

let scope

afterEach(() => {
  scope?.stop()
  scope = null
})

function createTopics(messages, conversationType = 'group') {
  scope = effectScope()
  return scope.run(() => useConversationTopics({
    activeGroup: ref({ id: 'group-1', conversationType }),
    activeMessages: ref(messages),
    locale: ref('en'),
    selectedGroupId: ref('group-1'),
    t: (key, values = {}) => `${key}:${values.count ?? values.replies ?? ''}`,
  }))
}

describe('conversation topics', () => {
  it('associates direct Agent and terminal system messages with the latest user turn', () => {
    const topics = createTopics([
      { id: 'user-1', role: 'user' },
      { id: 'agent-1', role: 'agent' },
      { id: 'system-1', role: 'system', system: { key: 'system.agentStopped' } },
    ], 'direct')

    expect(topics.messageThreadRootId({ id: 'agent-1' })).toBe('user-1')
    expect(topics.messageThreadRootId({ id: 'system-1' })).toBe('user-1')
  })

  it('clears collapsed and finished state when a turn is deleted', () => {
    const topics = createTopics([{ id: 'user-1', role: 'user' }])

    topics.toggleTopic('user-1')
    topics.rememberRunFinishedTurnStatus('group-1', 'user-1', 'completed')
    expect(topics.isTopicExpanded('user-1')).toBe(false)
    expect(topics.runFinishedTurnStatus('user-1')).toBe('completed')

    topics.clearDeletedTurnState('group-1', 'user-1')
    expect(topics.isTopicExpanded('user-1')).toBe(true)
    expect(topics.runFinishedTurnStatus('user-1')).toBe('')
  })
})
