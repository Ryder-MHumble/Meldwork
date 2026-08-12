import { nextTick, ref, watch } from 'vue'

export function useConversationViewport({ activeMessages, liveOutputSignature, selectedGroupId }) {
  const messageNearBottom = ref(true)
  const messageScroller = ref(null)

  function handleMessageScroll() {
    const scroller = messageScroller.value
    if (!scroller) return
    const remaining = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
    messageNearBottom.value = remaining <= 96
  }

  async function scrollToLatest({ force = false } = {}) {
    await nextTick()
    const scroller = messageScroller.value
    if (!scroller || (!force && !messageNearBottom.value)) return
    scroller.scrollTop = scroller.scrollHeight
    messageNearBottom.value = true
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
  }
}
