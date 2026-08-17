import { effectScope, nextTick, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useCollapsedGroupMenu } from '../../composables/useCollapsedGroupMenu.js'

describe('collapsed group menu', () => {
  it('positions and focuses the menu, restores trigger focus, and closes when the sidebar expands', async () => {
    const scope = effectScope()
    const sidebarCollapsed = ref(true)
    const shortcutMenuOpen = ref(true)
    const buttonFocus = vi.fn()
    const activeFocus = vi.fn()
    const firstFocus = vi.fn()
    const menu = scope.run(() => useCollapsedGroupMenu({ sidebarCollapsed, shortcutMenuOpen }))
    menu.collapsedGroupMenuButton.value = {
      focus: buttonFocus,
      getBoundingClientRect: () => ({ right: 80, bottom: 600 }),
    }
    menu.collapsedGroupMenu.value = {
      querySelector: vi.fn(selector => (
        selector === '[aria-current="page"]' ? { focus: activeFocus } : { focus: firstFocus }
      )),
    }

    await menu.toggleCollapsedGroupMenu()
    expect(menu.collapsedGroupMenuOpen.value).toBe(true)
    expect(menu.collapsedGroupMenuStyle.value).toEqual({
      left: '88px',
      bottom: `${Math.max(12, window.innerHeight - 600)}px`,
    })
    expect(shortcutMenuOpen.value).toBe(false)
    expect(activeFocus).toHaveBeenCalledOnce()
    expect(firstFocus).not.toHaveBeenCalled()

    await menu.toggleCollapsedGroupMenu()
    await nextTick()
    expect(menu.collapsedGroupMenuOpen.value).toBe(false)
    expect(buttonFocus).toHaveBeenCalledOnce()

    await menu.toggleCollapsedGroupMenu()
    sidebarCollapsed.value = false
    await nextTick()
    expect(menu.collapsedGroupMenuOpen.value).toBe(false)
    scope.stop()
  })
})
