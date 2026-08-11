import { computed, ref, watch } from 'vue'

const ACTIVE_RUN_PHASES = new Set(['preparing', 'running', 'waiting'])
const TERMINAL_AGENT_STATUSES = new Set([
  'completed', 'succeeded', 'failed', 'cancelled', 'stopped', 'partial', 'timeout', 'interrupted',
])

function runStillActive(run) {
  if (!ACTIVE_RUN_PHASES.has(String(run?.phase || '').toLowerCase())) return false
  const targetKinds = Array.isArray(run?.targetKinds) ? run.targetKinds : []
  if (!targetKinds.length || run?.mode === 'auto') return true
  const completed = new Set(Array.isArray(run?.completedKinds) ? run.completedKinds : [])
  const latestStatusByKind = new Map()
  for (const agent of Array.isArray(run?.agentRuns) ? run.agentRuns : []) {
    if (!agent?.kind) continue
    latestStatusByKind.set(agent.kind, String(agent.status || '').toLowerCase())
  }
  return targetKinds.some(kind => (
    !completed.has(kind) && !TERMINAL_AGENT_STATUSES.has(latestStatusByKind.get(kind))
  ))
}

export function useWorkspaceNavigationState({
  clearSidebarDeleteState,
  closeCollapsedGroupMenu,
  closeTracePanel,
  directGroupsFor,
  flushPendingRunFinishedEvents,
  hasFinishedDirectRun,
  isDirectCreationPending,
  openAgentManager,
  openDirect,
  preloadAgentSkills,
  setFinishedDirectRun,
  setSidebarAgentExpanded,
  sidebarCollapsed,
  snapshot,
  toggleSidebarAgentExpanded,
}) {
  const activeView = ref('home')
  const selectedGroupId = ref('')
  let pendingRequestedGroupId = ''

  const activeGroup = computed(() => (
    snapshot.value.groups.find(group => group.id === selectedGroupId.value) || null
  ))
  const activeGroupMemberSignature = computed(() => {
    const group = activeGroup.value
    return group ? [group.id, ...group.agentKinds].join('\u0000') : ''
  })

  function handleSidebarAgentMain(agent) {
    if (!agent || isDirectCreationPending(agent.kind)) return
    if (sidebarCollapsed.value) {
      void openDirect(agent)
      return
    }
    if (directGroupsFor(agent.kind).length) {
      toggleSidebarAgentExpanded(agent.kind)
      return
    }
    void openDirect(agent)
  }

  function handleAgentPrimary(agent) {
    if (agent.ready) openDirect(agent)
    else openAgentManager(agent.kind)
  }

  function goHome() {
    closeCollapsedGroupMenu()
    activeView.value = 'home'
    clearSidebarDeleteState()
    pendingRequestedGroupId = ''
    closeTracePanel()
  }

  function selectGroup(id) {
    closeCollapsedGroupMenu()
    const group = snapshot.value.groups.find(item => item.id === id)
    if (!group) {
      selectedGroupId.value = ''
      activeView.value = 'home'
      return
    }
    activeView.value = 'conversation'
    closeTracePanel()
    clearSidebarDeleteState()
    selectedGroupId.value = id
    if (group.conversationType === 'direct' && group.directAgentKind) {
      setSidebarAgentExpanded(group.directAgentKind, true)
    }
    void preloadAgentSkills(group.agentKinds)
    if (hasFinishedDirectRun(id)) setFinishedDirectRun(id, false)
  }

  function isGroupRunning(id) {
    const groupRuns = (Array.isArray(snapshot.value.runs) ? snapshot.value.runs : [])
      .filter(run => run?.groupId === id)
    if (groupRuns.length) return groupRuns.some(runStillActive)
    const hasConversationActivity = (Array.isArray(snapshot.value.messages) ? snapshot.value.messages : [])
      .some(message => message?.groupId === id)
    return hasConversationActivity && snapshot.value.runningGroupIds.includes(id)
  }

  function openPendingRequestedGroup() {
    if (!pendingRequestedGroupId
        || !snapshot.value.groups.some(group => group.id === pendingRequestedGroupId)) return false
    const groupId = pendingRequestedGroupId
    pendingRequestedGroupId = ''
    selectGroup(groupId)
    return true
  }

  function handleOpenGroup(event) {
    const groupId = String(event?.groupId || '')
    if (!groupId) return
    pendingRequestedGroupId = groupId
    openPendingRequestedGroup()
  }

  watch(() => snapshot.value.groups.map(group => group.id).join('\u0000'), () => {
    openPendingRequestedGroup()
    if (selectedGroupId.value
        && !snapshot.value.groups.some(group => group.id === selectedGroupId.value)) {
      selectedGroupId.value = ''
      if (activeView.value === 'conversation') activeView.value = 'home'
    } else if (activeView.value === 'conversation' && !selectedGroupId.value) {
      activeView.value = 'home'
    }
    flushPendingRunFinishedEvents()
  })

  return {
    activeGroup,
    activeGroupMemberSignature,
    activeView,
    goHome,
    handleAgentPrimary,
    handleOpenGroup,
    handleSidebarAgentMain,
    isGroupRunning,
    selectGroup,
    selectedGroupId,
  }
}
