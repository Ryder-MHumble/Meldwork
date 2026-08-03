import { onBeforeUnmount, ref } from 'vue'
import { errorCode } from '../desktop.js'
import { t, translateError } from '../i18n.js'

export function useAppNotifications() {
  const toastMessage = ref('')
  const copyToastMessage = ref('')
  let toastTimer = null
  let copyToastTimer = null

  function notify(message) {
    toastMessage.value = message
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { toastMessage.value = '' }, 3600)
  }

  function showCopyToast() {
    copyToastMessage.value = t('conversation.copySuccess')
    clearTimeout(copyToastTimer)
    copyToastTimer = setTimeout(() => { copyToastMessage.value = '' }, 1500)
  }

  function dismissToast() {
    clearTimeout(toastTimer)
    toastMessage.value = ''
  }

  function showError(error) {
    console.error('[Meldwork]', errorCode(error))
    notify(translateError(error))
  }

  onBeforeUnmount(() => {
    clearTimeout(toastTimer)
    clearTimeout(copyToastTimer)
  })

  return {
    copyToastMessage,
    dismissToast,
    notify,
    showCopyToast,
    showError,
    toastMessage,
  }
}
