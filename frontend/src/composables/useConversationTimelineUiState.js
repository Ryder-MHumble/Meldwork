import { ref } from 'vue'
import {
  isLiveDirectTrace,
  messageTraceKey,
  responseVersionRootId,
} from '../conversationTimelineModel.js'

const DISMISSIBLE_PLAN_WARNING = 'error: Cannot combine --prompt with --plan.'

export function useConversationTimelineUiState() {
  const directTraceDisclosure = ref(new Map())
  const dismissedSystemMessageIds = ref(new Set())
  const finishedDirectGroupIds = ref(new Set())
  const collapsedAgentReplyIds = ref(new Set())

  function directTraceDisclosureKey(message) {
    const key = messageTraceKey(message)
    return key ? `${isLiveDirectTrace(message) ? 'live' : 'durable'}:${key}` : ''
  }

  function isDirectTraceOpen(message) {
    const key = directTraceDisclosureKey(message)
    if (directTraceDisclosure.value.has(key)) return directTraceDisclosure.value.get(key)
    return false
  }

  function syncDirectTraceDisclosure(message, event) {
    const key = directTraceDisclosureKey(message)
    if (!key) return
    const open = event?.target?.open === true
    const defaultOpen = false
    const next = new Map(directTraceDisclosure.value)
    if (open === defaultOpen) next.delete(key)
    else next.set(key, open)
    directTraceDisclosure.value = next
  }

  function isDismissibleSystemWarning(message) {
    return message?.role === 'system'
      && Boolean(message?.id)
      && String(message.content || '').trim() === DISMISSIBLE_PLAN_WARNING
  }

  function dismissSystemMessage(id) {
    if (!id) return
    dismissedSystemMessageIds.value = new Set([...dismissedSystemMessageIds.value, id])
  }

  function hasFinishedDirectRun(groupId) {
    return finishedDirectGroupIds.value.has(groupId)
  }

  function setFinishedDirectRun(groupId, finished) {
    const next = new Set(finishedDirectGroupIds.value)
    if (finished) next.add(groupId)
    else next.delete(groupId)
    finishedDirectGroupIds.value = next
  }

  function isAgentReplyExpanded(message) {
    const key = responseVersionRootId(message)
    return !key || !collapsedAgentReplyIds.value.has(key)
  }

  function toggleAgentReply(message) {
    const key = responseVersionRootId(message)
    if (!key) return
    const next = new Set(collapsedAgentReplyIds.value)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    collapsedAgentReplyIds.value = next
  }

  return {
    dismissedSystemMessageIds,
    dismissSystemMessage,
    hasFinishedDirectRun,
    isAgentReplyExpanded,
    isDirectTraceOpen,
    isDismissibleSystemWarning,
    setFinishedDirectRun,
    syncDirectTraceDisclosure,
    toggleAgentReply,
  }
}
