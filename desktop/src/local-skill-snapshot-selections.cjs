const {
  normalizeContentBlobRef,
} = require('./content-blob-store.cjs')
const {
  canonicalSkillSnapshotJson,
  normalizeLocalSkillSnapshot,
} = require('./local-skill-snapshot.cjs')
const { normalizeSkillHint } = require('./local-workspace-message-records.cjs')

const LIVE_SELECTION_FIELDS = 'name,namespace,slug,targetKind'
const SNAPSHOT_SELECTION_FIELDS = [
  'manifestHash', 'name', 'namespace', 'slug', 'snapshotId', 'snapshotRef', 'targetKind',
].join(',')

function selectionError(code = 'LOCAL_SKILL_SELECTION_INVALID', cause) {
  const error = new Error(code)
  error.code = code
  if (cause) error.cause = cause
  return error
}

function fieldKey(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).sort().join(',')
    : ''
}

function sameCoordinates(left, right) {
  return ['targetKind', 'namespace', 'slug', 'name']
    .every(field => left?.[field] === right?.[field])
}

function runtimeHint(hint, entryPath) {
  const value = {
    ...hint,
    snapshotRef: Object.freeze({ ...hint.snapshotRef }),
  }
  Object.defineProperty(value, 'entryPath', {
    value: entryPath,
    enumerable: false,
    configurable: false,
    writable: false,
  })
  return Object.freeze(value)
}

class LocalSkillSnapshotSelections {
  constructor({ catalog, snapshotStore, contentBlobStore } = {}) {
    if (!catalog || typeof catalog.resolveSelections !== 'function'
        || !snapshotStore || typeof snapshotStore.create !== 'function'
        || typeof snapshotStore.materialize !== 'function'
        || !contentBlobStore || typeof contentBlobStore.put !== 'function'
        || typeof contentBlobStore.read !== 'function') {
      throw selectionError('LOCAL_SKILL_SNAPSHOT_SELECTIONS_REQUIRED')
    }
    this.catalog = catalog
    this.snapshotStore = snapshotStore
    this.contentBlobStore = contentBlobStore
  }

  prepare(kind, selections) {
    if (!Array.isArray(selections)) throw selectionError()
    if (!selections.length) return []
    const shapes = new Set(selections.map(fieldKey))
    if (shapes.size !== 1) throw selectionError()
    const [shape] = shapes
    if (shape === LIVE_SELECTION_FIELDS) return this.capture(kind, selections)
    if (shape === SNAPSHOT_SELECTION_FIELDS) return this.restore(kind, selections)
    throw selectionError()
  }

  capture(kind, selections) {
    const resolved = this.catalog.resolveSelections(kind, selections)
    return resolved.map(({ sourceDirectory, ...coordinates }) => {
      const snapshot = this.snapshotStore.create({ ...coordinates, sourceDirectory })
      const bytes = Buffer.from(canonicalSkillSnapshotJson(snapshot), 'utf8')
      const snapshotRef = this.contentBlobStore.put(bytes, { mediaType: 'application/json' })
      const materialized = this.snapshotStore.materialize(snapshot)
      return runtimeHint({
        ...coordinates,
        snapshotId: snapshot.snapshotId,
        manifestHash: snapshot.manifestHash,
        snapshotRef,
      }, materialized.entryPath)
    })
  }

  restore(kind, selections) {
    return selections.map((selection) => {
      const hint = normalizeSkillHint(selection)
      if (!hint || hint.targetKind !== String(kind || '').trim().toLowerCase()) {
        throw selectionError()
      }
      let snapshotRef
      let bytes
      let snapshot
      try {
        snapshotRef = normalizeContentBlobRef(hint.snapshotRef)
        bytes = this.contentBlobStore.read(snapshotRef)
        const text = bytes.toString('utf8')
        if (!Buffer.from(text, 'utf8').equals(bytes)) throw selectionError()
        snapshot = normalizeLocalSkillSnapshot(JSON.parse(text))
        if (canonicalSkillSnapshotJson(snapshot) !== text) throw selectionError()
      } catch (error) {
        if (error?.code === 'LOCAL_SKILL_SELECTION_INVALID') throw error
        throw selectionError('LOCAL_SKILL_SNAPSHOT_RESTORE_FAILED', error)
      }
      if (snapshot.snapshotId !== hint.snapshotId
          || snapshot.manifestHash !== hint.manifestHash
          || !sameCoordinates(snapshot.manifest.coordinates, hint)) {
        throw selectionError('LOCAL_SKILL_SNAPSHOT_RESTORE_FAILED')
      }
      const materialized = this.snapshotStore.materialize(snapshot)
      return runtimeHint({ ...hint, snapshotRef }, materialized.entryPath)
    })
  }
}

module.exports = { LocalSkillSnapshotSelections }
