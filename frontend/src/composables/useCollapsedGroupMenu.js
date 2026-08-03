import { computed, nextTick, ref, watch } from 'vue'

export function useCollapsedGroupMenu({ sidebarCollapsed, shortcutMenuOpen }) {
  const collapsedGroupMenu = ref(null)
  const collapsedGroupMenuButton = ref(null)
  const collapsedGroupMenuOpen = ref(false)
  const collapsedGroupMenuPoint = ref({ left: 0, bottom: 0 })
  const collapsedGroupMenuStyle = computed(() => ({
    left: `${collapsedGroupMenuPoint.value.left}px`,
    bottom: `${collapsedGroupMenuPoint.value.bottom}px`,
  }))

  function updatePosition() {
    const rect = collapsedGroupMenuButton.value?.getBoundingClientRect()
    if (!rect) return
    collapsedGroupMenuPoint.value = {
      left: Math.max(12, Math.min(rect.right + 8, window.innerWidth - 312)),
      bottom: Math.max(12, window.innerHeight - rect.bottom),
    }
  }

  function closeCollapsedGroupMenu({ restoreFocus = false } = {}) {
    if (!collapsedGroupMenuOpen.value) return
    collapsedGroupMenuOpen.value = false
    if (restoreFocus) void nextTick(() => collapsedGroupMenuButton.value?.focus())
  }

  async function toggleCollapsedGroupMenu() {
    if (collapsedGroupMenuOpen.value) {
      closeCollapsedGroupMenu({ restoreFocus: true })
      return
    }
    shortcutMenuOpen.value = false
    updatePosition()
    collapsedGroupMenuOpen.value = true
    await nextTick()
    const activeOption = collapsedGroupMenu.value?.querySelector('[aria-current="page"]')
    const firstOption = collapsedGroupMenu.value?.querySelector('.collapsed-group-option')
    const focusTarget = activeOption || firstOption
    focusTarget?.focus()
  }

  watch(sidebarCollapsed, (collapsed) => {
    if (!collapsed) closeCollapsedGroupMenu()
  })

  return {
    collapsedGroupMenu,
    collapsedGroupMenuButton,
    collapsedGroupMenuOpen,
    collapsedGroupMenuStyle,
    closeCollapsedGroupMenu,
    toggleCollapsedGroupMenu,
  }
}
