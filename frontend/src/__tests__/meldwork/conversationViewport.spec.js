import { nextTick, ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { useConversationViewport } from '../../composables/useConversationViewport.js'

describe('Conversation viewport', () => {
  it('jumps to the latest message whenever the selected conversation changes', async () => {
    const selectedGroupId = ref('group-one')
    const viewport = useConversationViewport({
      activeMessages: ref([{ id: 'message-one' }]),
      liveOutputSignature: ref(''),
      selectedGroupId,
    })
    const scroller = { scrollHeight: 1200, scrollTop: 280, clientHeight: 400 }
    viewport.messageScroller.value = scroller

    selectedGroupId.value = 'group-two'
    await nextTick()
    await nextTick()

    expect(scroller.scrollTop).toBe(1200)
  })

  it('shows a jump control away from the bottom and hides it after an explicit jump', async () => {
    const viewport = useConversationViewport({
      activeMessages: ref([{ id: 'message-one' }]),
      liveOutputSignature: ref(''),
      selectedGroupId: ref('group-one'),
    })
    const scroller = { scrollHeight: 1200, scrollTop: 400, clientHeight: 400 }
    viewport.messageScroller.value = scroller

    viewport.handleMessageScroll()
    expect(viewport.showScrollToLatest.value).toBe(true)

    await viewport.scrollToLatest({ force: true })

    expect(scroller.scrollTop).toBe(1200)
    expect(viewport.showScrollToLatest.value).toBe(false)
  })
})
