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
})
