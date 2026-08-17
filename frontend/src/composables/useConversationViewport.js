import { nextTick, ref, watch } from 'vue'

export function useConversationViewport({ activeMessages, liveOutputSignature, selectedGroupId }) {
  const messageNearBottom = ref(true)
  const messageScroller = ref(null)
  const showScrollToLatest = ref(false)

  function handleMessageScroll() {
    const scroller = messageScroller.value
    if (!scroller) return
    const remaining = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
    messageNearBottom.value = remaining <= 96
    showScrollToLatest.value = !messageNearBottom.value
  }

  async function scrollToLatest({ force = false } = {}) {
    await nextTick()
    const scroller = messageScroller.value
    if (!scroller || (!force && !messageNearBottom.value)) return
    scroller.scrollTop = scroller.scrollHeight
    messageNearBottom.value = true
    showScrollToLatest.value = false
  }

  function resetMessageViewport() {
    messageNearBottom.value = true
    void scrollToLatest({ force: true })
  }

  watch(() => activeMessages.value.length, () => { void scrollToLatest() })
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
