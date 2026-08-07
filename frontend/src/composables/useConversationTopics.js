import { computed, nextTick, ref } from 'vue'
import {
  durableAgentTurnStatus,
  durableGroupTerminalStatus,
  durableRunTurnStatus,
  isAgentFailureMessage,
  isAgentTerminalMessage,
  messageElementId,
  responseVersionRootId,
  traceRound,
} from '../conversationTimelineModel.js'

export function useConversationTopics({
  activeGroup,
  activeMessages,
  locale,
  selectedGroupId,
  t,
}) {
  const activeTurnId = ref('')
  const collapsedTopicIds = ref(new Set())
  const runFinishedTurnStatuses = ref(new Map())

  const topLevelUserMessages = computed(() => activeMessages.value.filter(
    message => message.role === 'user' && !message.threadRootId,
  ))
  const messageThreadRootIds = computed(() => {
    const roots = new Map()
    let latestRootId = ''
    const direct = activeGroup.value?.conversationType === 'direct'
    for (const message of activeMessages.value) {
      if (message.role === 'user' && !message.threadRootId) {
        latestRootId = message.id
        continue
      }
      if (message.threadRootId) {
        roots.set(message.id, message.threadRootId)
        continue
      }
      if (direct && latestRootId && (message.role === 'agent' || isAgentTerminalMessage(message))) {
        roots.set(message.id, latestRootId)
      }
    }
    return roots
  })

  function messageThreadRootId(message) {
    return message?.threadRootId || messageThreadRootIds.value.get(message?.id) || ''
  }

  const topicReplyCounts = computed(() => {
    const replies = new Map()
    for (const message of activeMessages.value) {
      if (message.role !== 'agent') continue
      const rootId = messageThreadRootId(message)
      if (!rootId) continue
      const replyIds = replies.get(rootId) || new Set()
      replyIds.add(responseVersionRootId(message))
      replies.set(rootId, replyIds)
    }
    return new Map([...replies].map(([rootId, replyIds]) => [rootId, replyIds.size]))
  })
  const failedTopicIds = computed(() => new Set(activeMessages.value
    .filter(isAgentFailureMessage)
    .map(messageThreadRootId)
    .filter(Boolean)))
  const durableTopicStatuses = computed(() => {
    const runsByRoot = new Map()
    const latestRunIdByRoot = new Map()
    activeMessages.value.forEach((message, index) => {
      const rootId = messageThreadRootId(message)
      const agentStatus = durableAgentTurnStatus(message)
      const terminalStatus = durableGroupTerminalStatus(message)
      if (!rootId || (!agentStatus && !terminalStatus)) return
      const traceRunId = String(message?.trace?.runId || '')
      const runId = traceRunId || latestRunIdByRoot.get(rootId) || `root:${rootId}`
      if (traceRunId || !latestRunIdByRoot.has(rootId)) latestRunIdByRoot.set(rootId, runId)
      const rootRuns = runsByRoot.get(rootId) || new Map()
      const run = rootRuns.get(runId) || { agentAttempts: [], terminalStatus: '', lastIndex: index }
      if (agentStatus) {
        run.agentAttempts.push({
          agentKind: String(message?.agentKind || message?.trace?.agentRunId || message?.id || ''),
          round: traceRound(message?.trace),
          status: agentStatus,
          index,
        })
      }
      if (terminalStatus) run.terminalStatus = terminalStatus
      run.lastIndex = index
      rootRuns.set(runId, run)
      runsByRoot.set(rootId, rootRuns)
    })
    const statuses = new Map()
    for (const [rootId, runs] of runsByRoot) {
      const latestRun = [...runs.values()].sort((left, right) => left.lastIndex - right.lastIndex).at(-1)
      const status = durableRunTurnStatus(latestRun)
      if (status) statuses.set(rootId, status)
    }
    return statuses
  })
  const messageTimeFormatter = computed(() => new Intl.DateTimeFormat(locale.value === 'zh' ? 'zh-CN' : 'en', {
    hour: '2-digit', minute: '2-digit',
  }))

  function topicReplyCount(rootId) {
    return topicReplyCounts.value.get(rootId) || 0
  }

  function topicReplyAgentKinds(rootId) {
    return [...new Set(activeMessages.value
      .filter(message => message.role === 'agent' && messageThreadRootId(message) === rootId)
      .map(message => message.agentKind)
      .filter(Boolean))]
      .slice(0, 4)
  }

  function topicReplyLabel(count) {
    return t(count === 1 ? 'conversation.topicReply' : 'conversation.topicReplies', { count })
  }

  function isTopicRoot(message) {
    return activeGroup.value?.conversationType !== 'direct'
      && message?.role === 'user'
      && !message.threadRootId
      && topicReplyCount(message.id) > 0
  }

  function isTopicExpanded(rootId) {
    return !collapsedTopicIds.value.has(rootId)
  }

  function expandTopic(rootId) {
    const next = new Set(collapsedTopicIds.value)
    next.delete(rootId)
    collapsedTopicIds.value = next
  }

  function toggleTopic(rootId) {
    const next = new Set(collapsedTopicIds.value)
    if (next.has(rootId)) next.delete(rootId)
    else next.add(rootId)
    collapsedTopicIds.value = next
  }

  function topicToggleLabel(rootId) {
    const count = topicReplyCount(rootId)
    return t(isTopicExpanded(rootId) ? 'conversation.collapseTopic' : 'conversation.expandTopic', {
      replies: topicReplyLabel(count),
    })
  }

  function runFinishedTurnKey(groupId, rootId) {
    return `${String(groupId || '')}\u0000${String(rootId || '')}`
  }

  function runFinishedTurnStatus(rootId) {
    return runFinishedTurnStatuses.value.get(runFinishedTurnKey(selectedGroupId.value, rootId)) || ''
  }

  function rememberRunFinishedTurnStatus(groupId, rootId, status) {
    const next = new Map(runFinishedTurnStatuses.value)
    next.set(runFinishedTurnKey(groupId, rootId), status)
    runFinishedTurnStatuses.value = next
  }

  function clearDeletedTurnState(groupId, rootId) {
    expandTopic(rootId)
    const statuses = new Map(runFinishedTurnStatuses.value)
    statuses.delete(runFinishedTurnKey(groupId, rootId))
    runFinishedTurnStatuses.value = statuses
    if (activeTurnId.value === rootId) activeTurnId.value = ''
  }

  function clearActiveTurn() {
    activeTurnId.value = ''
  }

  async function focusTurn(rootId) {
    if (!rootId) return
    activeTurnId.value = rootId
    if (!isTopicExpanded(rootId)) expandTopic(rootId)
    await nextTick()
    const element = document.getElementById(messageElementId(rootId))
    element?.scrollIntoView?.({
      block: 'nearest',
      behavior: typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth',
    })
  }

  function formatTime(value) {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return ''
    return messageTimeFormatter.value.format(date)
  }

  return {
    activeTurnId,
    clearActiveTurn,
    clearDeletedTurnState,
    durableTopicStatuses,
    expandTopic,
    failedTopicIds,
    focusTurn,
    formatTime,
    isTopicExpanded,
    isTopicRoot,
    messageThreadRootId,
    rememberRunFinishedTurnStatus,
    runFinishedTurnStatus,
    toggleTopic,
    topLevelUserMessages,
    topicReplyAgentKinds,
    topicReplyCount,
    topicReplyLabel,
    topicToggleLabel,
  }
}
