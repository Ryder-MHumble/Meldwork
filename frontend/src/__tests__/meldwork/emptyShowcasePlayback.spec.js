import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEmptyShowcasePlayback } from '../../composables/useEmptyShowcasePlayback.js'

describe('empty showcase playback', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('advances only while visible and clears its timer on unmount', async () => {
    vi.useFakeTimers()
    const visible = ref(false)
    const wrapper = mount(defineComponent({
      setup() {
        const { index } = useEmptyShowcasePlayback({ visible })
        return () => h('span', String(index.value))
      },
    }))

    visible.value = true
    await nextTick()
    vi.advanceTimersByTime(2800)
    await nextTick()
    expect(wrapper.text()).toBe('1')

    visible.value = false
    await nextTick()
    vi.advanceTimersByTime(5600)
    await nextTick()
    expect(wrapper.text()).toBe('1')

    visible.value = true
    await nextTick()
    expect(vi.getTimerCount()).toBe(1)
    wrapper.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
