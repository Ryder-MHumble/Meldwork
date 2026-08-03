import { nextTick, onBeforeUnmount, onMounted, watch } from 'vue'

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

export function useOverlayLifecycle({
  blockingOverlayOpen,
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
}) {
  let historyPushed = false
  let focusReturn = null

  function focusOverlay(dialog) {
    void nextTick(() => dialog.value?.focus())
  }

  function completeOnboarding(options = {}) {
    const shouldRestoreHistory = historyPushed && options.fromHistory !== true
    historyPushed = false
    completeOnboardingState()
    if (shouldRestoreHistory) history.back()
  }

  function trapOverlayFocus(event) {
    if (event.key !== 'Tab' || !blockingOverlayOpen.value) return false
    const dialog = onboardingVisible.value ? onboardingDialog.value : modalDialog.value
    if (!dialog) return false
    const focusable = [...dialog.querySelectorAll(FOCUSABLE_SELECTOR)]
    if (!focusable.length) {
      event.preventDefault()
      dialog.focus()
      return true
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const focusOutside = !dialog.contains(document.activeElement)
    if (event.shiftKey && (focusOutside || document.activeElement === first)) {
      event.preventDefault()
      last.focus()
      return true
    }
    if (!event.shiftKey && (focusOutside || document.activeElement === last)) {
      event.preventDefault()
      first.focus()
      return true
    }
    return false
  }

  function handlePopState() {
    if (tracePanelOpen.value) {
      closeTracePanel({ fromHistory: true })
      return
    }
    if (!blockingOverlayOpen.value) return
    if (modal.value && saving.value) {
      history.pushState({ roundrelayOverlay: true }, '', window.location.href)
      historyPushed = true
      return
    }
    historyPushed = false
    if (onboardingVisible.value) completeOnboarding({ fromHistory: true })
    else closeModal()
  }

  watch(onboardingVisible, (value) => {
    if (value) {
      focusOverlay(onboardingDialog)
      ensureOnboardingPlayback()
      return
    }
    clearOnboardingPlayback()
  })

  watch(modal, (value, previous) => {
    if (value) closeCollapsedGroupMenu()
    if (value && !previous) {
      const active = document.activeElement
      focusReturn = active instanceof HTMLElement && active !== document.body ? active : null
    }
    if (value) {
      focusOverlay(modalDialog)
      return
    }
    if (!previous) return
    const target = focusReturn
    focusReturn = null
    void nextTick(() => {
      if (target?.isConnected && typeof target.focus === 'function') target.focus()
    })
  })

  watch(blockingOverlayOpen, (value, previous) => {
    const reusedTraceHistory = value && !previous && tracePanelOpen.value
      ? closeTracePanel({
          fromHistory: true,
          replacementState: { roundrelayOverlay: true },
        })
      : false
    document.body.classList.toggle('modal-open', Boolean(value))
    if (value && !previous) {
      if (!reusedTraceHistory) {
        history.pushState({ roundrelayOverlay: true }, '', window.location.href)
      }
      historyPushed = true
    } else if (!value && previous && historyPushed) {
      historyPushed = false
      history.back()
    }
  })

  onMounted(() => {
    window.addEventListener('popstate', handlePopState)
  })

  onBeforeUnmount(() => {
    window.removeEventListener('popstate', handlePopState)
    document.body.classList.remove('modal-open')
    clearOnboardingPlayback()
  })

  return {
    completeOnboarding,
    trapOverlayFocus,
  }
}
