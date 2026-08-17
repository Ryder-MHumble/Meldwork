import { beforeEach, describe, expect, it } from 'vitest'

import { readProductPreference, writeProductPreference } from '../../product-preferences.js'

describe('Meldwork product preferences', () => {
  beforeEach(() => localStorage.clear())

  it('migrates a legacy preference once and keeps the Meldwork key authoritative', () => {
    const legacyKey = `${['round', 'relay'].join('')}-theme`
    localStorage.setItem(legacyKey, 'dark')

    expect(readProductPreference('theme')).toBe('dark')
    expect(localStorage.getItem('meldwork-theme')).toBe('dark')
    expect(localStorage.getItem(legacyKey)).toBeNull()

    writeProductPreference('theme', 'light')
    expect(readProductPreference('theme')).toBe('light')
  })
})
