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
    const container = document.createElement('section')
    container.className = 'conversation-pane'
    const scroller = document.createElement('div')
    scroller.className = 'message-scroll'
    Object.defineProperties(scroller, {
      scrollHeight: { value: 1200 },
      clientHeight: { value: 400 },
    })
    scroller.scrollTop = 280
    const outerReveals = []
    container.scrollIntoView = options => outerReveals.push({ options, scrollTop: scroller.scrollTop })
    container.append(scroller)
    viewport.messageScroller.value = scroller

    selectedGroupId.value = 'group-two'
    await nextTick()
    await nextTick()

    expect(outerReveals).toEqual([{
      options: { block: 'end', inline: 'nearest' },
      scrollTop: 280,
    }])
    expect(scroller.scrollTop).toBe(1200)
  })

  it('shows a jump control away from the bottom and hides it after an explicit jump', async () => {
    const viewport = useConversationViewport({
      activeMessages: ref([{ id: 'message-one' }]),
      liveOutputSignature: ref(''),
      selectedGroupId: ref('group-one'),
    })
    const container = document.createElement('section')
    container.className = 'workspace-pane'
    const scroller = document.createElement('div')
    scroller.className = 'message-scroll'
    Object.defineProperties(scroller, {
      scrollHeight: { value: 1200 },
      clientHeight: { value: 400 },
    })
    scroller.scrollTop = 400
    const outerReveals = []
    container.scrollIntoView = options => outerReveals.push(options)
    container.append(scroller)
    viewport.messageScroller.value = scroller

    viewport.handleMessageScroll()
    expect(viewport.showScrollToLatest.value).toBe(true)

    await viewport.scrollToLatest({ force: true })

    expect(outerReveals).toEqual([{ block: 'end', inline: 'nearest' }])
    expect(scroller.scrollTop).toBe(1200)
    expect(viewport.showScrollToLatest.value).toBe(false)
  })
})
