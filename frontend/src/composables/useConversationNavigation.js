import { computed, ref } from 'vue'

const DIRECT_SESSION_PREVIEW_LIMIT = 5
const GROUP_SESSION_PREVIEW_LIMIT = 8

export function sortByUpdated(a, b) {
  return (Date.parse(b.updatedAt || b.createdAt || '') || 0)
    - (Date.parse(a.updatedAt || a.createdAt || '') || 0)
}

export function useConversationNavigation({ agentLabel, locale, snapshot, t }) {
  const directCreationKinds = ref(new Set())
  const collapsedSidebarAgentKinds = ref(new Set())
  const expandedSidebarAgentSessionKinds = ref(new Set())
  const groupSessionListExpanded = ref(false)

  const directGroups = computed(() => snapshot.value.groups
    .filter(group => group.conversationType === 'direct')
    .sort(sortByUpdated))
  const groupGroups = computed(() => snapshot.value.groups
    .filter(group => group.conversationType !== 'direct')
    .sort(sortByUpdated))
  const visibleGroupGroups = computed(() => (
    groupSessionListExpanded.value || groupGroups.value.length <= GROUP_SESSION_PREVIEW_LIMIT
      ? groupGroups.value
      : groupGroups.value.slice(0, GROUP_SESSION_PREVIEW_LIMIT)
  ))
  const hasMoreGroupGroups = computed(() => groupGroups.value.length > GROUP_SESSION_PREVIEW_LIMIT)
  const remainingGroupGroupsCount = computed(() => Math.max(
    0,
    groupGroups.value.length - GROUP_SESSION_PREVIEW_LIMIT,
  ))
  const navTimeFormatter = computed(() => new Intl.DateTimeFormat(locale.value === 'zh' ? 'zh-CN' : 'en', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }))

  function groupName(group) {
    return group?.name || t('group.defaultName')
  }

  function groupAgentSummary(group) {
    return (group?.agentKinds || []).map(kind => agentLabel(kind)).filter(Boolean).join(', ')
  }

  function directGroupsFor(kind) {
    return directGroups.value.filter(group => group.directAgentKind === kind)
  }

  function visibleDirectGroupsFor(kind) {
    const groups = directGroupsFor(kind)
    if (groups.length <= DIRECT_SESSION_PREVIEW_LIMIT || isDirectSessionListExpanded(kind)) {
      return groups
    }
    return groups.slice(0, DIRECT_SESSION_PREVIEW_LIMIT)
  }

  function hasMoreDirectGroups(kind) {
    return directGroupsFor(kind).length > DIRECT_SESSION_PREVIEW_LIMIT
  }

  function remainingDirectGroupsCount(kind) {
    return Math.max(0, directGroupsFor(kind).length - DIRECT_SESSION_PREVIEW_LIMIT)
  }

  function isDirectCreationPending(kind) {
    return directCreationKinds.value.has(kind)
  }

  function setDirectCreationPending(kind, pending) {
    const next = new Set(directCreationKinds.value)
    if (pending) next.add(kind)
    else next.delete(kind)
    directCreationKinds.value = next
  }

  function sidebarAgentSessionListId(kind) {
    return `sidebar-agent-sessions-${String(kind || '')}`
  }

  function isSidebarAgentExpanded(kind) {
    return !collapsedSidebarAgentKinds.value.has(String(kind || ''))
  }

  function setSidebarAgentExpanded(kind, expanded) {
    const normalized = String(kind || '')
    if (!normalized) return
    const next = new Set(collapsedSidebarAgentKinds.value)
    if (expanded) next.delete(normalized)
    else next.add(normalized)
    collapsedSidebarAgentKinds.value = next
  }

  function toggleSidebarAgentExpanded(kind) {
    setSidebarAgentExpanded(kind, !isSidebarAgentExpanded(kind))
  }

  function isDirectSessionListExpanded(kind) {
    return expandedSidebarAgentSessionKinds.value.has(String(kind || ''))
  }

  function setDirectSessionListExpanded(kind, expanded) {
    const normalized = String(kind || '')
    if (!normalized) return
    const next = new Set(expandedSidebarAgentSessionKinds.value)
    if (expanded) next.add(normalized)
    else next.delete(normalized)
    expandedSidebarAgentSessionKinds.value = next
  }

  function toggleDirectSessionListExpanded(kind) {
    setDirectSessionListExpanded(kind, !isDirectSessionListExpanded(kind))
  }

  function toggleGroupSessionListExpanded() {
    groupSessionListExpanded.value = !groupSessionListExpanded.value
  }

  function formatNavTime(value) {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return ''
    return navTimeFormatter.value.format(date)
  }

  function recentGroupMeta(group) {
    const count = Array.isArray(group?.agentKinds) ? group.agentKinds.length : 0
    const kindLabel = group?.conversationType === 'direct'
      ? t('conversation.direct')
      : t('conversation.members', { count })
    const time = formatNavTime(group?.updatedAt || group?.createdAt)
    return time ? `${kindLabel} / ${time}` : kindLabel
  }

  return {
    directGroups,
    directGroupsFor,
    formatNavTime,
    groupAgentSummary,
    groupGroups,
    groupName,
    groupSessionListExpanded,
    hasMoreDirectGroups,
    hasMoreGroupGroups,
    isDirectCreationPending,
    isDirectSessionListExpanded,
    isSidebarAgentExpanded,
    recentGroupMeta,
    remainingDirectGroupsCount,
    remainingGroupGroupsCount,
    setDirectCreationPending,
    setDirectSessionListExpanded,
    setSidebarAgentExpanded,
    sidebarAgentSessionListId,
    sortByUpdated,
    toggleDirectSessionListExpanded,
    toggleGroupSessionListExpanded,
    toggleSidebarAgentExpanded,
    visibleDirectGroupsFor,
    visibleGroupGroups,
  }
}
