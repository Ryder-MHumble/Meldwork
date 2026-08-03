import { computed } from 'vue'
import { agentLabel } from '../catalog.js'
import {
  durableRunTurnStatus,
  messageAgentRunId,
  messageElementId,
  messageExecutionSteps,
  messageHasTrace,
  messageTraceEvents,
  messageTraceKey,
  messageTraceStatus,
  messageTraceSummary,
  retainedTraceEvents,
  runStatusTone,
  terminalSystemConclusion,
  terminalSystemFallback,
  traceRound,
} from '../conversationTimelineModel.js'
import { messageScopedTargetKinds } from '../messageContext.js'
import { useConversationTimelineLabels } from './useConversationTimelineLabels.js'
import { useConversationTimelineUiState } from './useConversationTimelineUiState.js'
import { useConversationTraceRuns } from './useConversationTraceRuns.js'
import { useConversationTopics } from './useConversationTopics.js'
import { useRunTracePanel } from './useRunTracePanel.js'

export { durableRunTurnStatus, retainedTraceEvents, runStatusTone, traceRound }

export function useConversationTimeline({
  activeGroup,
  activeView,
  blockingOverlayOpen,
  conversationTitleBlock,
  locale,
  mergedCatalog,
  selectedGroupId,
  snapshot,
  t,
  translateSystemMessage,
}) {
  const {
    dismissedSystemMessageIds,
    dismissSystemMessage,
    hasFinishedDirectRun,
    isDirectTraceOpen,
    isDismissibleSystemWarning,
    setFinishedDirectRun,
    syncDirectTraceDisclosure,
  } = useConversationTimelineUiState()

  const activeMessages = computed(() => (
    snapshot.value.messages.filter(message => message.groupId === selectedGroupId.value)
  ))
  const {
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
  } = useConversationTopics({ activeGroup, activeMessages, locale, selectedGroupId, t })
  const {
    localizedStepTitle,
    messageElapsedLabel,
    runStatusLabel,
    traceEventTitle,
    traceEventTypeLabel,
    turnRailLabel,
  } = useConversationTimelineLabels({ activeGroup, locale, t, topicReplyLabel })
  const activeRun = computed(() => snapshot.value.runs.find(run => run.groupId === selectedGroupId.value) || null)
  const activeRunAgentRuns = computed(() => (
    Array.isArray(activeRun.value?.agentRuns) ? activeRun.value.agentRuns : []
  ))
  const activeRunHasAgentRuns = computed(() => activeRunAgentRuns.value.length > 0)
  const activeRunProgress = computed(() => Array.isArray(activeRun.value?.progress) ? activeRun.value.progress.slice(0, 8) : [])
  const liveOutputSignature = computed(() => activeRunAgentRuns.value.map(agent => (
    `${agent.agentRunId}:${String(agent.output || '').length}:${agent.events?.at(-1)?.seq || 0}`
  )).join('\u0000'))
  const directConclusionLiveStatus = computed(() => {
    if (activeGroup.value?.conversationType !== 'direct') return ''
    const agent = activeRunAgentRuns.value.at(-1)
    if (!agent?.output) return ''
    const status = ['completed', 'succeeded', 'failed', 'cancelled', 'stopped', 'partial', 'timeout', 'interrupted']
      .includes(String(agent.status || '').toLowerCase())
      ? agent.status
      : 'streaming'
    return [agentLabel(agent.kind), t('trace.conclusion'), runStatusLabel(status)].join(' / ')
  })
  const directTraceEventLiveStatus = computed(() => {
    if (activeGroup.value?.conversationType !== 'direct') return ''
    const agent = activeRunAgentRuns.value.at(-1)
    const event = retainedTraceEvents(agent?.events).at(-1)
    if (!agent || !event) return ''
    return [...new Set([
      agentLabel(agent.kind),
      t('trace.process'),
      traceEventTypeLabel(event.type),
      traceEventTitle(event),
      runStatusLabel(event.status),
    ].filter(Boolean))].join(' / ')
  })

  function latestAgentRunForKind(kind) {
    return activeRunAgentRuns.value.filter(agent => agent.kind === kind).at(-1) || null
  }

  const runTargetKinds = computed(() => {
    if (!activeRun.value) return []
    const runTargets = Array.isArray(activeRun.value.targetKinds) ? activeRun.value.targetKinds : []
    const rootMessage = activeMessages.value.find(message => message.id === activeRun.value.threadRootId)
    const messageTargets = scopedTargetKinds(rootMessage, activeGroup.value)
    const targets = runTargets.length
      ? runTargets
      : activeRunAgentRuns.value.length
        ? activeRunAgentRuns.value.map(agent => agent.kind)
        : messageTargets
    return [...new Set(targets)]
  })
  const isCoordinatedRun = computed(() => (
    activeGroup.value?.conversationType !== 'direct' && runTargetKinds.value.length > 1
  ))
  const activeRunAgentKind = computed(() => (
    activeRun.value?.currentKind
    || activeRunAgentRuns.value.at(-1)?.kind
    || runTargetKinds.value[0]
    || activeGroup.value?.directAgentKind
    || ''
  ))
  const activeRunAgentStatus = computed(() => runAgentStatus(activeRunAgentKind.value))
  const runCompletedKinds = computed(() => {
    const targets = new Set(runTargetKinds.value)
    const completed = activeRunAgentRuns.value
      .filter(agent => ['completed', 'succeeded'].includes(agent.status))
      .map(agent => agent.kind)
    return [...new Set([...(activeRun.value?.completedKinds || []), ...completed])].filter(kind => targets.has(kind))
  })
  const runFailedKinds = computed(() => {
    const targets = new Set(runTargetKinds.value)
    const failed = activeRunAgentRuns.value
      .filter(agent => ['failed', 'timeout'].includes(agent.status))
      .map(agent => agent.kind)
    return [...new Set([...(activeRun.value?.failedKinds || []), ...failed])].filter(kind => targets.has(kind))
  })
  const activeRunLabel = computed(() => {
    if (!activeRun.value || !activeGroup.value) return ''
    if (!isCoordinatedRun.value) {
      const agent = agentLabel(activeRunAgentKind.value)
      return activeRunAgentStatus.value === 'running'
        ? t('conversation.directWorking', { agent })
        : agent
    }
    return t('conversation.groupWorking')
  })
  const activeRunTopicRootId = computed(() => {
    if (!activeRun.value) return ''
    if (activeRun.value?.threadRootId) return activeRun.value.threadRootId
    if (activeGroup.value?.conversationType !== 'direct') return ''
    return topLevelUserMessages.value.at(-1)?.id || ''
  })
  const runRoundProgress = computed(() => {
    const current = Number(activeRun.value?.currentRound)
    const max = Number(activeRun.value?.maxRounds)
    if (!Number.isInteger(current) || current < 1) return null
    if (activeRun.value?.unlimitedRounds === true) return { current, unlimited: true }
    if (!Number.isInteger(max) || max < current) return null
    return { current, max }
  })
  const provisionalMessages = computed(() => {
    const run = activeRun.value
    const group = activeGroup.value
    if (!run || !group || !activeRunAgentRuns.value.length) return []
    const durableAgentRunIds = new Set(activeMessages.value
      .map(message => message?.trace?.agentRunId)
      .filter(Boolean))
    const rootId = run.threadRootId || topLevelUserMessages.value.at(-1)?.id || ''
    return activeRunAgentRuns.value
      .filter(agent => !durableAgentRunIds.has(agent.agentRunId))
      .filter(agent => group.conversationType === 'direct' || agent.output || (agent.events || []).some(event => event.type !== 'answer_delta'))
      .map(agent => ({
        id: `run-message-${agent.agentRunId}`,
        groupId: group.id,
        role: 'agent',
        agentKind: agent.kind,
        content: agent.output || '',
        createdAt: agent.startedAt || Date.now(),
        threadRootId: rootId,
        provisional: true,
        traceRunId: run.runId,
        liveAgentRun: agent,
        sourceMessageIds: agent.sourceMessageIds || [],
      }))
  })
  const messagesWithLiveTrace = computed(() => {
    const run = activeRun.value
    if (!run) return activeMessages.value
    const liveByAgentRunId = new Map(activeRunAgentRuns.value.map(agent => [agent.agentRunId, agent]))
    return activeMessages.value.map((message) => {
      if (!run.runId || !message?.trace?.runId || message.trace.runId !== run.runId) return message
      const liveAgentRun = liveByAgentRunId.get(message.trace.agentRunId)
      return liveAgentRun
        ? { ...message, liveAgentRun, traceRunId: run.runId }
        : message
    })
  })

  const { allTracePanelItems, historicalGroupRun } = useConversationTraceRuns({
    activeGroup,
    activeMessages,
    activeRun,
    activeRunAgentRuns,
    messageThreadRootId,
    scopedTargetKinds,
    t,
    topLevelUserMessages,
    translateSystemMessage,
  })
  const displayedRun = computed(() => activeRun.value || historicalGroupRun.value)
  const displayedRunAgentRuns = computed(() => (
    activeRun.value ? activeRunAgentRuns.value : historicalGroupRun.value?.agentRuns || []
  ))
  const displayedRunTargetKinds = computed(() => (
    activeRun.value ? runTargetKinds.value : historicalGroupRun.value?.targetKinds || []
  ))
  const isDisplayedCoordinatedRun = computed(() => (
    activeGroup.value?.conversationType !== 'direct' && displayedRunTargetKinds.value.length > 1
  ))
  const displayedRunAgentKind = computed(() => (
    activeRun.value?.currentKind
    || displayedRunAgentRuns.value.at(-1)?.agentKind
    || displayedRunAgentRuns.value.at(-1)?.kind
    || displayedRunTargetKinds.value[0]
    || activeGroup.value?.directAgentKind
    || ''
  ))
  const displayedRunAgentStatus = computed(() => displayedRunAgentStatusForKind(displayedRunAgentKind.value))
  const displayedRunAgentTone = computed(() => runStatusTone(displayedRunAgentStatus.value))
  const displayedRunTopicRootId = computed(() => (
    activeRunTopicRootId.value || historicalGroupRun.value?.threadRootId || ''
  ))
  const displayedRunLabel = computed(() => {
    if (!displayedRun.value || !activeGroup.value) return ''
    if (!activeRun.value) return t('conversation.groupRunHistory')
    return activeRunLabel.value
  })
  const {
    closeTracePanel,
    jumpToTraceSource,
    openDisplayedRunTrace,
    openDisplayedTraceForAgent,
    openTraceForMessage,
    openTracePanel,
    selectTraceAgentRun,
    selectedTraceAgentRunId,
    traceDrawerBlocking,
    tracePanel,
    tracePanelDrawer,
    tracePanelGroupId,
    tracePanelItems,
    tracePanelOpen,
    tracePanelRunId,
  } = useRunTracePanel({
    activeGroup,
    activeMessages,
    activeRun,
    activeView,
    allTracePanelItems,
    blockingOverlayOpen,
    conversationTitleBlock,
    displayedRun,
    displayedRunAgentForKind,
    displayedRunAgentKind,
    displayedRunAgentRuns,
    expandTopic,
    isTopicExpanded,
    messageAgentRunId,
    messageElementId,
    messageThreadRootId,
    retainedTraceEvents,
    selectedGroupId,
    snapshot,
  })
  const turnRailItems = computed(() => topLevelUserMessages.value.map((message) => {
    const replyCount = topicReplyCount(message.id)
    const finishedStatus = runFinishedTurnStatus(message.id)
    const durableStatus = durableTopicStatuses.value.get(message.id) || ''
    return {
      id: message.id,
      query: String(message.content || '').trim().replace(/\s+/g, ' ').slice(0, 56) || t('conversation.attachmentTurn'),
      time: formatTime(message.createdAt),
      replyCount,
      status: activeRunTopicRootId.value === message.id
        ? 'running'
        : finishedStatus || durableStatus || (replyCount > 0
          ? 'completed'
          : failedTopicIds.value.has(message.id) ? 'failed' : 'pending'),
    }
  }))
  const activeTurnRailId = computed(() => (
    activeRunTopicRootId.value || activeTurnId.value || turnRailItems.value.at(-1)?.id || ''
  ))
  const activeRunTopicSignature = computed(() => {
    if (!activeRunTopicRootId.value) return ''
    return `${activeRun.value?.groupId || ''}\u0000${activeRunTopicRootId.value}`
  })
  const timelineMessages = computed(() => [...messagesWithLiveTrace.value, ...provisionalMessages.value].filter((message) => {
    if (dismissedSystemMessageIds.value.has(message.id)) return false
    const rootId = messageThreadRootId(message)
    return !rootId || isTopicExpanded(rootId)
  }))
  const conversationEmptyVisible = computed(() => (
    activeView.value === 'conversation'
    && Boolean(activeGroup.value)
    && !timelineMessages.value.length
    && !activeRun.value
  ))

  function scopedTargetKinds(message, group) {
    return messageScopedTargetKinds(message, group, mergedCatalog.value)
  }

  function isActiveRunTopic(message) {
    const rootId = activeRunTopicRootId.value
    return Boolean(rootId && (message?.id === rootId || messageThreadRootId(message) === rootId))
  }

  async function focusRunTopic() {
    await focusTurn(activeRunTopicRootId.value)
  }

  function runAgentForKind(kind) {
    return latestAgentRunForKind(kind)
  }

  function runAgentStatus(kind) {
    const agent = runAgentForKind(kind)
    const latestStatus = String(agent?.status || '').trim().toLowerCase()
    if (['failed', 'partial', 'stopped', 'timeout', 'cancelled', 'interrupted'].includes(latestStatus)) {
      return latestStatus
    }
    if (activeRun.value?.currentKind === kind) return 'running'
    if (latestStatus) return latestStatus
    if (runFailedKinds.value.includes(kind)) return 'failed'
    if (runCompletedKinds.value.includes(kind)) return 'completed'
    return 'queued'
  }

  function displayedRunAgentForKind(kind) {
    if (activeRun.value) return runAgentForKind(kind)
    return displayedRunAgentRuns.value.filter(item => item.agentKind === kind).at(-1) || null
  }

  function displayedRunAgentStatusForKind(kind) {
    if (activeRun.value) return runAgentStatus(kind)
    const agent = displayedRunAgentForKind(kind)
    return agent?.status || 'not-started'
  }

  function displayedRunAgentToneForKind(kind) {
    return runStatusTone(displayedRunAgentStatusForKind(kind))
  }

  function displayedRunAgentTraceLabel(kind) {
    const agent = displayedRunAgentForKind(kind)
    return t('trace.viewAgentProcess', {
      agent: agentLabel(kind),
      status: runStatusLabel(agent?.status || displayedRunAgentStatusForKind(kind)),
    })
  }

  return {
    activeMessages,
    activeRun,
    activeRunAgentKind,
    activeRunAgentRuns,
    activeRunAgentStatus,
    activeRunHasAgentRuns,
    activeRunLabel,
    activeRunProgress,
    activeRunTopicRootId,
    activeRunTopicSignature,
    activeTurnRailId,
    allTracePanelItems,
    closeTracePanel,
    clearActiveTurn,
    clearDeletedTurnState,
    conversationEmptyVisible,
    directConclusionLiveStatus,
    directTraceEventLiveStatus,
    dismissSystemMessage,
    displayedRun,
    displayedRunAgentForKind,
    displayedRunAgentKind,
    displayedRunAgentRuns,
    displayedRunAgentStatus,
    displayedRunAgentStatusForKind,
    displayedRunAgentTone,
    displayedRunAgentToneForKind,
    displayedRunAgentTraceLabel,
    displayedRunLabel,
    displayedRunTargetKinds,
    displayedRunTopicRootId,
    focusRunTopic,
    focusTurn,
    formatTime,
    hasFinishedDirectRun,
    isActiveRunTopic,
    isCoordinatedRun,
    isDirectTraceOpen,
    isDismissibleSystemWarning,
    isDisplayedCoordinatedRun,
    isTopicExpanded,
    isTopicRoot,
    jumpToTraceSource,
    liveOutputSignature,
    localizedStepTitle,
    messageAgentRunId,
    messageElapsedLabel,
    messageElementId,
    messageExecutionSteps,
    messageHasTrace,
    messageThreadRootId,
    messageTraceEvents,
    messageTraceKey,
    messageTraceStatus,
    messageTraceSummary,
    openDisplayedRunTrace,
    openDisplayedTraceForAgent,
    openTraceForMessage,
    openTracePanel,
    provisionalMessages,
    retainedTraceEvents,
    runCompletedKinds,
    runFailedKinds,
    rememberRunFinishedTurnStatus,
    runRoundProgress,
    runStatusLabel,
    runStatusTone,
    runTargetKinds,
    selectTraceAgentRun,
    selectedTraceAgentRunId,
    setFinishedDirectRun,
    syncDirectTraceDisclosure,
    terminalSystemConclusion,
    terminalSystemFallback,
    timelineMessages,
    toggleTopic,
    topLevelUserMessages,
    topicReplyAgentKinds,
    topicReplyCount,
    topicReplyLabel,
    topicToggleLabel,
    traceDrawerBlocking,
    traceEventTitle,
    traceEventTypeLabel,
    tracePanel,
    tracePanelDrawer,
    tracePanelGroupId,
    tracePanelItems,
    tracePanelOpen,
    tracePanelRunId,
    turnRailLabel,
    turnRailItems,
  }
}
