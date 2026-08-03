import { onScopeDispose, ref } from 'vue'
import { normalizeSnapshot } from '../desktop.js'

export function useMessageActions({
  activeGroup,
  clearDeletedTurnState,
  isGroupRunning,
  notify,
  showCopyToast,
  showError,
  snapshot,
  t,
  workspace,
}) {
  const copiedMessageIds = ref(new Set())
  const messageDeleteArmedId = ref('')
  const deletingMessageId = ref('')
  const copiedMessageTimers = new Map()

  function isMessageCopied(id) {
    return copiedMessageIds.value.has(id)
  }

  function markMessageCopied(id) {
    if (!id) return
    copiedMessageIds.value = new Set([...copiedMessageIds.value, id])
    clearTimeout(copiedMessageTimers.get(id))
    copiedMessageTimers.set(id, setTimeout(() => {
      const next = new Set(copiedMessageIds.value)
      next.delete(id)
      copiedMessageIds.value = next
      copiedMessageTimers.delete(id)
    }, 1500))
  }

  function messageCopyBlocked(event) {
    const target = event?.target
    if (target instanceof Element && target.closest(
      'a, button, input, textarea, select, option, form, summary, [contenteditable="true"]',
    )) return true
    const selection = typeof window.getSelection === 'function' ? window.getSelection() : null
    return Boolean(selection && String(selection).trim())
  }

  function fallbackCopyText(content) {
    if (!document.body || typeof document.execCommand !== 'function') return false
    const textarea = document.createElement('textarea')
    textarea.value = content
    textarea.setAttribute('readonly', '')
    textarea.setAttribute('aria-hidden', 'true')
    textarea.style.position = 'fixed'
    textarea.style.top = '-1000px'
    textarea.style.opacity = '0'
    textarea.style.pointerEvents = 'none'
    document.body.appendChild(textarea)
    textarea.select()
    let copied = false
    try {
      copied = document.execCommand('copy')
    } catch {
      copied = false
    }
    textarea.remove()
    return copied
  }

  async function copyMessageContent(message, event, force = false) {
    const content = String(message?.content || '')
    if (!content || (!force && messageCopyBlocked(event))) return
    let copied = false
    try {
      if (typeof navigator.clipboard?.writeText === 'function') {
        await navigator.clipboard.writeText(content)
        copied = true
      }
    } catch {
      copied = false
    }
    if (!copied) copied = fallbackCopyText(content)
    if (!copied) {
      notify(t('conversation.copyFailed'))
      return
    }
    markMessageCopied(message.id)
    showCopyToast()
  }

  function messageDeletionScope(message) {
    if (message?.role !== 'user' || message.threadRootId) return 'message'
    return activeGroup.value?.conversationType === 'direct' ? 'turn' : 'topic'
  }

  function messageDeleteDisabled(message) {
    return typeof workspace.value?.deleteMessage !== 'function'
      || isGroupRunning(message?.groupId)
      || Boolean(deletingMessageId.value)
  }

  function messageDeleteTitle(message) {
    if (isGroupRunning(message?.groupId)) return t('conversation.deleteMessageRunning')
    const scope = messageDeletionScope(message)
    const confirming = messageDeleteArmedId.value === message?.id
    if (scope === 'topic') {
      return t(confirming ? 'conversation.confirmDeleteTopic' : 'conversation.deleteTopic')
    }
    if (scope === 'turn') {
      return t(confirming ? 'conversation.confirmDeleteTurn' : 'conversation.deleteTurn')
    }
    return t(confirming ? 'conversation.confirmDeleteMessage' : 'conversation.deleteMessage')
  }

  function clearDeletedMessageUi(snapshotValue, groupId, rootId = '') {
    const remainingIds = new Set(snapshotValue.messages.map(message => message.id))
    copiedMessageIds.value = new Set([...copiedMessageIds.value].filter(id => remainingIds.has(id)))
    for (const [id, timer] of copiedMessageTimers) {
      if (remainingIds.has(id)) continue
      clearTimeout(timer)
      copiedMessageTimers.delete(id)
    }
    if (rootId) clearDeletedTurnState(groupId, rootId)
  }

  async function confirmMessageDelete(message) {
    if (!message?.id || messageDeleteDisabled(message)) return
    const groupId = String(message.groupId || activeGroup.value?.id || '')
    const messageId = String(message.id)
    const deletesTurn = messageDeletionScope(message) !== 'message'
    deletingMessageId.value = messageId
    try {
      const result = await workspace.value.deleteMessage(groupId, messageId)
      const nextSnapshot = normalizeSnapshot(result?.messages ? result : await workspace.value.get())
      snapshot.value = nextSnapshot
      clearDeletedMessageUi(nextSnapshot, groupId, deletesTurn ? messageId : '')
      messageDeleteArmedId.value = ''
    } catch (error) {
      showError(error)
    } finally {
      deletingMessageId.value = ''
    }
  }

  function requestMessageDelete(message) {
    if (!message?.id || messageDeleteDisabled(message)) return
    if (messageDeleteArmedId.value === message.id) {
      void confirmMessageDelete(message)
      return
    }
    messageDeleteArmedId.value = message.id
  }

  onScopeDispose(() => {
    for (const timer of copiedMessageTimers.values()) clearTimeout(timer)
    copiedMessageTimers.clear()
  })

  return {
    copyMessageContent,
    deletingMessageId,
    isMessageCopied,
    messageDeleteArmedId,
    messageDeleteDisabled,
    messageDeleteTitle,
    requestMessageDelete,
  }
}
