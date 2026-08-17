import { mount } from '@vue/test-utils'
import { computed, defineComponent, h, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useOverlayLifecycle } from '../../composables/useOverlayLifecycle.js'

describe('overlay lifecycle', () => {
  afterEach(() => {
    document.body.classList.remove('modal-open')
    vi.restoreAllMocks()
  })

  it('coordinates focus, history, saving guards, onboarding playback, and cleanup', async () => {
    const modal = ref('')
    const onboardingVisible = ref(false)
    const saving = ref(false)
    const tracePanelOpen = ref(false)
    const modalDialog = ref(document.createElement('section'))
    const onboardingDialog = ref(document.createElement('section'))
    const first = document.createElement('button')
    const last = document.createElement('button')
    modalDialog.value.tabIndex = -1
    modalDialog.value.append(first, last)
    document.body.append(modalDialog.value, onboardingDialog.value)

    const pushState = vi.spyOn(history, 'pushState').mockImplementation(() => {})
    const back = vi.spyOn(history, 'back').mockImplementation(() => {})
    const closeCollapsedGroupMenu = vi.fn()
    const closeTracePanel = vi.fn(() => false)
    const ensureOnboardingPlayback = vi.fn()
    const clearOnboardingPlayback = vi.fn()
    const completeOnboardingState = vi.fn(() => { onboardingVisible.value = false })
    const closeModal = vi.fn(() => { modal.value = '' })
    let lifecycle
    const wrapper = mount(defineComponent({
      setup() {
        lifecycle = useOverlayLifecycle({
          blockingOverlayOpen: computed(() => Boolean(modal.value || onboardingVisible.value)),
          clearOnboardingPlayback,
          closeCollapsedGroupMenu,
          closeModal,
          closeTracePanel,
          completeOnboardingState,
          ensureOnboardingPlayback,
          modal,
          modalDialog,
          onboardingDialog,
          onboardingVisible,
          saving,
          tracePanelOpen,
        })
        return () => h('div')
      },
    }))

    modal.value = 'settings'
    await nextTick()
    await nextTick()
    expect(closeCollapsedGroupMenu).toHaveBeenCalledOnce()
    expect(document.body.classList.contains('modal-open')).toBe(true)
    expect(pushState).toHaveBeenCalledWith(
      { meldworkOverlay: true },
      '',
      window.location.href,
    )
    expect(document.activeElement).toBe(modalDialog.value)

    last.focus()
    const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true })
    expect(lifecycle.trapOverlayFocus(tabEvent)).toBe(true)
    expect(tabEvent.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(first)

    saving.value = true
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(closeModal).not.toHaveBeenCalled()
    expect(pushState).toHaveBeenCalledTimes(2)

    saving.value = false
    window.dispatchEvent(new PopStateEvent('popstate'))
    await nextTick()
    expect(closeModal).toHaveBeenCalledOnce()
    expect(modal.value).toBe('')

    onboardingVisible.value = true
    await nextTick()
    expect(ensureOnboardingPlayback).toHaveBeenCalledOnce()
    lifecycle.completeOnboarding()
    await nextTick()
    expect(completeOnboardingState).toHaveBeenCalledOnce()
    expect(back).toHaveBeenCalledOnce()
    expect(clearOnboardingPlayback).toHaveBeenCalled()

    wrapper.unmount()
    expect(document.body.classList.contains('modal-open')).toBe(false)
    const closeCount = closeModal.mock.calls.length
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(closeModal).toHaveBeenCalledTimes(closeCount)
    modalDialog.value.remove()
    onboardingDialog.value.remove()
  })
})
