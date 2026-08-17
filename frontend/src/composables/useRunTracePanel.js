import { computed, nextTick, onMounted, onScopeDispose, ref, watch } from 'vue'

export function useRunTracePanel({
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
}) {
  const tracePanelOpen = ref(false)
  const selectedTraceAgentRunId = ref('')
  const tracePanel = ref(null)
  const tracePanelGroupId = ref('')
  const tracePanelRunId = ref('')
  const tracePanelDrawer = ref(typeof matchMedia === 'function' && matchMedia('(max-width: 1179px)').matches)
  let tracePanelHistoryPushed = false
  let tracePanelFocusReturn = null
  let tracePanelFocusReturnAgentRunId = ''
  let tracePanelMediaQuery = null
  let tracePanelResizeHandler = null

  const tracePanelItems = computed(() => (
    tracePanelRunId.value
      ? allTracePanelItems.value.filter(item => item.runId === tracePanelRunId.value)
      : []
  ))
  const traceDrawerBlocking = computed(() => tracePanelOpen.value && tracePanelDrawer.value)

  function selectTraceAgentRun(agentRunId) {
    if (!agentRunId || !tracePanelItems.value.some(item => item.agentRunId === agentRunId)) return
    selectedTraceAgentRunId.value = agentRunId
  }

  function openTracePanel(agentRunId, opener = null, runId = '') {
    const item = allTracePanelItems.value.find(candidate => (
      candidate.agentRunId === agentRunId && (!runId || candidate.runId === runId)
    ))
    if (!item) return
    if (!tracePanelOpen.value) {
      tracePanelFocusReturn = opener instanceof HTMLElement ? opener : document.activeElement
      tracePanelFocusReturnAgentRunId = agentRunId
      history.pushState({ meldworkTracePanel: true }, '', window.location.href)
      tracePanelHistoryPushed = true
    }
    tracePanelGroupId.value = selectedGroupId.value
    tracePanelRunId.value = item.runId
    selectedTraceAgentRunId.value = agentRunId
    tracePanelOpen.value = true
    void nextTick(() => tracePanel.value?.focus?.())
  }

  function openDisplayedTraceForAgent(kind, opener = null) {
    const agent = displayedRunAgentForKind(kind)
    if (agent) openTracePanel(agent.agentRunId, opener, displayedRun.value?.runId || '')
  }

  function openDisplayedRunTrace(opener = null) {
    const preferred = displayedRunAgentForKind(displayedRunAgentKind.value)
      || displayedRunAgentRuns.value.find(item => retainedTraceEvents(item.events).length)
      || displayedRunAgentRuns.value.at(-1)
    if (preferred) openTracePanel(preferred.agentRunId, opener, displayedRun.value?.runId || '')
  }

  function openTraceForMessage(message, opener = null) {
    const agentRunId = messageAgentRunId(message)
    const runId = message?.traceRunId || message?.trace?.runId || ''
    if (agentRunId) openTracePanel(agentRunId, opener, runId)
  }

  function focusTraceReturnTarget(target, agentRunId) {
    if (target?.isConnected && typeof target.focus === 'function') {
      target.focus()
      if (document.activeElement === target) return
    }
    const matchingTarget = [...document.querySelectorAll('[data-trace-agent-run-id]')]
      .find(element => element.getAttribute('data-trace-agent-run-id') === agentRunId && !element.disabled)
    if (matchingTarget && typeof matchingTarget.focus === 'function') {
      matchingTarget.focus()
      if (document.activeElement === matchingTarget) return
    }
    conversationTitleBlock.value?.focus?.()
  }

  function closeTracePanel(options = {}) {
    if (!tracePanelOpen.value) return false
    tracePanelOpen.value = false
    tracePanelGroupId.value = ''
    tracePanelRunId.value = ''
    selectedTraceAgentRunId.value = ''
    const target = tracePanelFocusReturn
    const agentRunId = tracePanelFocusReturnAgentRunId
    tracePanelFocusReturn = null
    tracePanelFocusReturnAgentRunId = ''
    if (tracePanelHistoryPushed && options.replacementState) {
      history.replaceState(options.replacementState, '', window.location.href)
      tracePanelHistoryPushed = false
    } else if (!options.fromHistory && tracePanelHistoryPushed) {
      tracePanelHistoryPushed = false
      history.back()
    } else {
      tracePanelHistoryPushed = false
    }
    void nextTick(() => {
      focusTraceReturnTarget(target, agentRunId)
    })
    return true
  }

  function focusTraceSourceMessage(element) {
    if (!(element instanceof HTMLElement)) return
    const hadTabIndex = element.hasAttribute('tabindex')
    const previousTabIndex = element.getAttribute('tabindex')
    if (!hadTabIndex) element.setAttribute('tabindex', '-1')
    element.focus({ preventScroll: true })
    if (hadTabIndex) return
    element.addEventListener('blur', () => {
      if (previousTabIndex == null) element.removeAttribute('tabindex')
      else element.setAttribute('tabindex', previousTabIndex)
    }, { once: true })
  }

  async function jumpToTraceSource(sourceId) {
    const message = activeMessages.value.find(item => item.id === sourceId)
    if (!message) return
    const rootId = messageThreadRootId(message) || (message.role === 'user' ? message.id : '')
    if (rootId && !isTopicExpanded(rootId)) expandTopic(rootId)
    if (tracePanelDrawer.value) closeTracePanel()
    await nextTick()
    const element = document.getElementById(messageElementId(sourceId))
    element?.scrollIntoView?.({
      block: 'nearest',
      behavior: typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth',
    })
    focusTraceSourceMessage(element)
  }

  watch(
    [
      activeView,
      selectedGroupId,
      () => snapshot.value.groups.some(group => group.id === tracePanelGroupId.value),
      () => tracePanelItems.value.length,
    ],
    ([view, groupId, traceGroupExists, traceItemCount]) => {
      if (!tracePanelOpen.value) return
      if (
        view === 'conversation'
        && groupId === tracePanelGroupId.value
        && traceGroupExists
        && traceItemCount > 0
      ) return
      closeTracePanel({ fromHistory: blockingOverlayOpen.value })
    },
  )
  watch(activeRun, (value, previous) => {
    if (
      previous
      && previous.runId !== value?.runId
      && tracePanelOpen.value
      && tracePanelRunId.value === previous.runId
    ) closeTracePanel()
  })
  watch(traceDrawerBlocking, (value) => {
    document.body.classList.toggle('trace-drawer-open', Boolean(value))
  })

  onMounted(() => {
    if (typeof window.matchMedia !== 'function') return
    tracePanelMediaQuery = window.matchMedia('(max-width: 1179px)')
    tracePanelDrawer.value = tracePanelMediaQuery.matches
    tracePanelResizeHandler = () => { tracePanelDrawer.value = tracePanelMediaQuery?.matches === true }
    if (typeof tracePanelMediaQuery.addEventListener === 'function') {
      tracePanelMediaQuery.addEventListener('change', tracePanelResizeHandler)
    } else if (typeof tracePanelMediaQuery.addListener === 'function') {
      tracePanelMediaQuery.addListener(tracePanelResizeHandler)
    }
  })

  onScopeDispose(() => {
    document.body.classList.remove('trace-drawer-open')
    if (tracePanelMediaQuery && tracePanelResizeHandler) {
      if (typeof tracePanelMediaQuery.removeEventListener === 'function') {
        tracePanelMediaQuery.removeEventListener('change', tracePanelResizeHandler)
      } else if (typeof tracePanelMediaQuery.removeListener === 'function') {
        tracePanelMediaQuery.removeListener(tracePanelResizeHandler)
      }
    }
    tracePanelMediaQuery = null
    tracePanelResizeHandler = null
    tracePanelHistoryPushed = false
    tracePanelFocusReturn = null
    tracePanelFocusReturnAgentRunId = ''
  })

  return {
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
  }
}
