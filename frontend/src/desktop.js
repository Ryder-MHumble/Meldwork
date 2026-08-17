export {
  normalizeCapsuleEvent,
  normalizeMessageTrace,
  normalizeRunAgent,
  normalizeRunEvent,
} from './desktop-normalization.js'
export { mergeRunEvent } from './desktop-run-events.js'
export { emptySnapshot, normalizeSnapshot } from './desktop-snapshot.js'

export function desktopApi() {
  return typeof window !== 'undefined' ? window.meldworkDesktop || null : null
}

export function errorCode(error) {
  return String(error?.code || error?.message || error || '').trim()
}
