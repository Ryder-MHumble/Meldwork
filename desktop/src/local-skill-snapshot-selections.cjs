const {
  normalizeContentBlobRef,
} = require('./content-blob-store.cjs')
const {
  bindLocalSkillSnapshotProvenance,
  canonicalSkillSnapshotJson,
  normalizeLocalSkillSnapshot,
} = require('./local-skill-snapshot.cjs')
const {
  LOCAL_SKILL_MANIFEST_FILENAME,
  assertManifestIdentity,
  createLocalSkillSnapshotProvenance,
  localSkillContractHash,
} = require('./local-skill-contract.cjs')
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

function runtimeHint(hint, entryPath, manifest, bindingId) {
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
  Object.defineProperty(value, 'approvedSkillManifest', {
    value: manifest,
    enumerable: false,
    configurable: false,
    writable: false,
  })
  Object.defineProperty(value, 'trustBindingId', {
    value: bindingId,
    enumerable: false,
    configurable: false,
    writable: false,
  })
  return Object.freeze(value)
}

function manifestForSnapshot(snapshot, contentBlobStore) {
  const file = snapshot.manifest.files.find(candidate => (
    candidate.relativePath === LOCAL_SKILL_MANIFEST_FILENAME
  ))
  if (!file) throw selectionError('LOCAL_SKILL_MANIFEST_MISSING')
  let manifest
  try {
    manifest = assertManifestIdentity(
      contentBlobStore.read(file.blobRef),
      snapshot.manifest.coordinates,
    )
  } catch (error) {
    if (error?.code?.startsWith('LOCAL_SKILL_')) throw error
    throw selectionError('LOCAL_SKILL_MANIFEST_INVALID', error)
  }
  return manifest
}

class LocalSkillSnapshotSelections {
  constructor({ catalog, snapshotStore, contentBlobStore, trustStore, requestTrust } = {}) {
    if (!catalog || typeof catalog.resolveSelections !== 'function'
        || !snapshotStore || typeof snapshotStore.create !== 'function'
        || typeof snapshotStore.materialize !== 'function'
        || !contentBlobStore || typeof contentBlobStore.put !== 'function'
        || typeof contentBlobStore.read !== 'function'
        || !trustStore || typeof trustStore.binding !== 'function'
        || typeof trustStore.decision !== 'function'
        || typeof trustStore.approve !== 'function'
        || typeof trustStore.assertApproved !== 'function'
        || typeof requestTrust !== 'function') {
      throw selectionError('LOCAL_SKILL_SNAPSHOT_SELECTIONS_REQUIRED')
    }
    this.catalog = catalog
    this.snapshotStore = snapshotStore
    this.contentBlobStore = contentBlobStore
    this.trustStore = trustStore
    this.requestTrust = requestTrust
  }

  async prepare(kind, selections) {
    if (!Array.isArray(selections)) throw selectionError()
    if (!selections.length) return []
    const shapes = new Set(selections.map(fieldKey))
    if (shapes.size !== 1) throw selectionError()
    const [shape] = shapes
    if (shape === LIVE_SELECTION_FIELDS) return this.capture(kind, selections)
    if (shape === SNAPSHOT_SELECTION_FIELDS) return this.restore(kind, selections)
    throw selectionError()
  }

  async capture(kind, selections) {
    const resolved = this.catalog.resolveSelections(kind, selections)
    const results = []
    for (const { sourceDirectory, ...coordinates } of resolved) {
      const captured = this.snapshotStore.create({ ...coordinates, sourceDirectory })
      const manifest = manifestForSnapshot(captured, this.contentBlobStore)
      const binding = this.trustStore.binding({
        coordinates,
        manifest,
        contentHash: captured.manifestHash,
      })
      let decision = this.trustStore.decision(binding)
      if (!decision) {
        const approved = await this.requestTrust(Object.freeze({
          binding,
          coordinates: Object.freeze({ ...coordinates }),
          manifest,
        }))
        if (approved !== true) throw selectionError('LOCAL_SKILL_TRUST_REQUIRED')
        decision = this.trustStore.approve(binding)
      }
      const snapshot = bindLocalSkillSnapshotProvenance(
        captured,
        createLocalSkillSnapshotProvenance({
          manifest,
          contentHash: captured.manifestHash,
          trustDecisionId: decision.decisionId,
          approvedAt: decision.approvedAt,
        }),
      )
      const bytes = Buffer.from(canonicalSkillSnapshotJson(snapshot), 'utf8')
      const snapshotRef = this.contentBlobStore.put(bytes, { mediaType: 'application/json' })
      const materialized = this.snapshotStore.materialize(snapshot)
      results.push(runtimeHint({
        ...coordinates,
        snapshotId: snapshot.snapshotId,
        manifestHash: snapshot.manifestHash,
        snapshotRef,
      }, materialized.entryPath, manifest, binding.bindingId))
    }
    return results
  }

  async restore(kind, selections) {
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
      if (!snapshot.provenance) throw selectionError('LOCAL_SKILL_TRUST_REQUIRED')
      const manifest = manifestForSnapshot(snapshot, this.contentBlobStore)
      if (localSkillContractHash(manifest) !== snapshot.provenance.contractHash) {
        throw selectionError('LOCAL_SKILL_SNAPSHOT_RESTORE_FAILED')
      }
      const binding = this.trustStore.binding({
        coordinates: snapshot.manifest.coordinates,
        manifest,
        contentHash: snapshot.manifestHash,
      })
      this.trustStore.assertApproved(binding, snapshot.provenance.trustDecisionId)
      const materialized = this.snapshotStore.materialize(snapshot)
      return runtimeHint(
        { ...hint, snapshotRef }, materialized.entryPath, manifest, binding.bindingId,
      )
    })
  }
}

module.exports = { LocalSkillSnapshotSelections }
