import { nextTick, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useWorkspaceNavigationState } from '../../composables/useWorkspaceNavigationState.js'

function group(id, options = {}) {
  return {
    id,
    agentKinds: ['codex'],
    conversationType: 'group',
    ...options,
  }
}

function createNavigation() {
  const snapshot = ref({
    groups: [group('group-1')],
    runningGroupIds: [],
  })
  const dependencies = {
    clearSidebarDeleteState: vi.fn(),
    closeCollapsedGroupMenu: vi.fn(),
    closeTracePanel: vi.fn(),
    directGroupsFor: vi.fn(() => []),
    flushPendingRunFinishedEvents: vi.fn(),
    hasFinishedDirectRun: vi.fn(() => false),
    isDirectCreationPending: vi.fn(() => false),
    openAgentManager: vi.fn(),
    openDirect: vi.fn(),
    preloadAgentSkills: vi.fn(),
    setFinishedDirectRun: vi.fn(),
    setSidebarAgentExpanded: vi.fn(),
    sidebarCollapsed: ref(false),
    snapshot,
    toggleSidebarAgentExpanded: vi.fn(),
  }
  return {
    dependencies,
    navigation: useWorkspaceNavigationState(dependencies),
    snapshot,
  }
}

describe('workspace navigation state', () => {
  it('opens a pending external group once it appears in the snapshot', async () => {
    const { dependencies, navigation, snapshot } = createNavigation()

    navigation.handleOpenGroup({ groupId: 'group-2' })
    expect(navigation.selectedGroupId.value).toBe('')

    snapshot.value = {
      ...snapshot.value,
      groups: [...snapshot.value.groups, group('group-2')],
    }
    await nextTick()

    expect(navigation.activeView.value).toBe('conversation')
    expect(navigation.selectedGroupId.value).toBe('group-2')
    expect(dependencies.preloadAgentSkills).toHaveBeenCalledTimes(1)

    snapshot.value = { ...snapshot.value, groups: [...snapshot.value.groups] }
    await nextTick()
    expect(dependencies.preloadAgentSkills).toHaveBeenCalledTimes(1)
  })

  it('keeps a valid conversation selected while an unknown external group is pending', () => {
    const { navigation } = createNavigation()

    navigation.selectGroup('group-1')
    navigation.handleOpenGroup({ groupId: 'missing-group' })

    expect(navigation.activeView.value).toBe('conversation')
    expect(navigation.selectedGroupId.value).toBe('group-1')
  })

  it('returns to home only after the selected group is removed', async () => {
    const { navigation, snapshot } = createNavigation()
    navigation.selectGroup('group-1')

    snapshot.value = { ...snapshot.value, groups: [] }
    await nextTick()

    expect(navigation.activeView.value).toBe('home')
    expect(navigation.selectedGroupId.value).toBe('')
  })
})
