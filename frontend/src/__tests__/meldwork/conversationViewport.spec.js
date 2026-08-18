import { nextTick, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
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

  it('moves to the loading state at the bottom when a new run starts', async () => {
    const activeRunTopicSignature = ref('')
    const viewport = useConversationViewport({
      activeMessages: ref([{ id: 'message-one' }]),
      activeRunTopicSignature,
      liveOutputSignature: ref(''),
      selectedGroupId: ref('group-one'),
    })
    const container = document.createElement('section')
    container.className = 'conversation-pane'
    const scroller = document.createElement('div')
    Object.defineProperties(scroller, {
      scrollHeight: { value: 1200 },
      clientHeight: { value: 400 },
    })
    scroller.scrollTop = 360
    container.scrollIntoView = vi.fn()
    container.append(scroller)
    viewport.messageScroller.value = scroller

    activeRunTopicSignature.value = 'group-one\u0000message-one'
    await nextTick()
    await nextTick()

    expect(container.scrollIntoView).toHaveBeenCalledWith({ block: 'end', inline: 'nearest' })
    expect(scroller.scrollTop).toBe(1200)
    expect(viewport.showScrollToLatest.value).toBe(false)
  })

  it('keeps following live output after an explicit jump from a smooth-scrolling timeline', async () => {
    const liveOutputSignature = ref('chunk-one')
    const viewport = useConversationViewport({
      activeMessages: ref([{ id: 'message-one' }]),
      liveOutputSignature,
      selectedGroupId: ref('group-one'),
    })
    const scroller = document.createElement('div')
    let scrollHeight = 1200
    let scrollTop = 400
    scroller.style.scrollBehavior = 'smooth'
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, get: () => scrollHeight },
      clientHeight: { value: 400 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: value => {
          scrollTop = scroller.style.scrollBehavior === 'auto'
            ? value
            : Math.min(value, scrollTop + 120)
        },
      },
    })
    viewport.messageScroller.value = scroller

    viewport.handleMessageScroll()
    expect(viewport.showScrollToLatest.value).toBe(true)

    await viewport.scrollToLatest({ force: true })
    viewport.handleMessageScroll()
    scrollHeight = 1400
    liveOutputSignature.value = 'chunk-two'
    await nextTick()
    await nextTick()

    expect(scrollTop).toBe(1400)
    expect(viewport.showScrollToLatest.value).toBe(false)
  })

  it('preserves an upward reading position while provisional output becomes durable', async () => {
    const activeMessages = ref([{ id: 'message-one' }])
    const viewport = useConversationViewport({
      activeMessages,
      liveOutputSignature: ref('chunk-one'),
      selectedGroupId: ref('group-one'),
    })
    const scroller = document.createElement('div')
    const clientHeight = 400
    let scrollHeight = 2000
    let scrollTop = 1000
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, get: () => scrollHeight },
      clientHeight: { value: clientHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: value => {
          scrollTop = Math.max(0, Math.min(value, scrollHeight - clientHeight))
        },
      },
    })
    viewport.messageScroller.value = scroller

    viewport.handleMessageScroll()
    expect(viewport.showScrollToLatest.value).toBe(true)

    scrollHeight = 1200
    scrollTop = 800
    viewport.handleMessageScroll()
    activeMessages.value = [...activeMessages.value, { id: 'message-two' }]
    scrollHeight = 2200
    await nextTick()
    await nextTick()

    expect(scrollTop).toBe(800)
    expect(viewport.showScrollToLatest.value).toBe(true)

    scrollTop = 1800
    viewport.handleMessageScroll()
    expect(viewport.showScrollToLatest.value).toBe(false)
  })
})
