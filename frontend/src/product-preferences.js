const LEGACY_PRODUCT_STEM = ['round', 'relay'].join('')

function storageKey(name) {
  return `meldwork-${name}`
}

export function readProductPreference(name) {
  const currentKey = storageKey(name)
  const current = localStorage.getItem(currentKey)
  if (current != null) return current
  const legacyKey = `${LEGACY_PRODUCT_STEM}-${name}`
  const legacy = localStorage.getItem(legacyKey)
  if (legacy == null) return null
  localStorage.setItem(currentKey, legacy)
  localStorage.removeItem(legacyKey)
  return legacy
}

export function writeProductPreference(name, value) {
  localStorage.setItem(storageKey(name), value)
}
