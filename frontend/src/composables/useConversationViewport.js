import { nextTick, ref, watch } from 'vue'

export function useConversationViewport({
  activeMessages,
  activeRunTopicSignature,
  liveOutputSignature,
  selectedGroupId,
}) {
  const messageFollowLatest = ref(true)
  const messageScroller = ref(null)
  const previousMessageScrollTop = ref(0)
  const showScrollToLatest = ref(false)

  function handleMessageScroll() {
    const scroller = messageScroller.value
    if (!scroller) return
    const remaining = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
    const atLatest = remaining <= 96
    const movedTowardLatest = scroller.scrollTop > previousMessageScrollTop.value
    if (!atLatest) messageFollowLatest.value = false
    else if (messageFollowLatest.value || movedTowardLatest) messageFollowLatest.value = true
    previousMessageScrollTop.value = scroller.scrollTop
    showScrollToLatest.value = !messageFollowLatest.value
  }

  async function scrollToLatest({ force = false, behavior = 'auto' } = {}) {
    await nextTick()
    const scroller = messageScroller.value
    if (!scroller || (!force && !messageFollowLatest.value)) return
    if (force) {
      const container = scroller.closest?.('.conversation-pane, .workspace-pane')
      container?.scrollIntoView?.({ block: 'end', inline: 'nearest' })
    }
    const reduceMotion = typeof matchMedia === 'function'
      && matchMedia('(prefers-reduced-motion: reduce)').matches
    const requestedBehavior = behavior === 'smooth' && !reduceMotion ? 'smooth' : 'auto'
    if (requestedBehavior === 'smooth' && typeof scroller.scrollTo === 'function') {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' })
    } else {
      const previousScrollBehavior = scroller.style.scrollBehavior
      scroller.style.scrollBehavior = 'auto'
      scroller.scrollTop = scroller.scrollHeight
      scroller.style.scrollBehavior = previousScrollBehavior
    }
    previousMessageScrollTop.value = scroller.scrollHeight
    messageFollowLatest.value = true
    showScrollToLatest.value = false
  }

  function resetMessageViewport() {
    messageFollowLatest.value = true
    previousMessageScrollTop.value = 0
    void scrollToLatest({ force: true })
  }

  watch(() => activeMessages.value.length, () => { void scrollToLatest() })
  if (activeRunTopicSignature) {
    watch(activeRunTopicSignature, value => { if (value) void scrollToLatest({ force: true }) })
  }
  watch(liveOutputSignature, () => { void scrollToLatest() })
  watch(selectedGroupId, () => { resetMessageViewport() }, { flush: 'post' })

  return {
    handleMessageScroll,
    messageScroller,
    resetMessageViewport,
    scrollToLatest,
    showScrollToLatest,
  }
}
