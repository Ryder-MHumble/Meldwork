const assert = require('node:assert/strict')
const { test } = require('node:test')

const {
  assertLocalSkillExecution,
  assertManifestIdentity,
  createLocalSkillSnapshotProvenance,
  localSkillContractHash,
  normalizeLocalSkillManifest,
  normalizeLocalSkillSnapshotProvenance,
} = require('../../src/skills/local-skill-contract.cjs')

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    recordType: 'meldwork-skill-manifest',
    identity: { id: 'global/review', version: '1.2.3' },
    origin: { type: 'local-unsigned', publisher: 'Local author' },
    agents: [{ kind: 'codex', minVersion: '0.130.0', maxVersion: '0.200.0' }],
    inputTypes: ['text'],
    tools: ['filesystem'],
    credentials: [],
    permissionMode: 'read-only',
    networkDestinations: [],
    sideEffectClass: 'none',
    ...overrides,
  }
}

function execution(overrides = {}) {
  return {
    kind: 'codex',
    version: '0.137.0',
    inputTypes: ['text'],
    capabilities: {
      toolClasses: ['filesystem', 'shell'],
      permissionModes: ['read-only', 'workspace-write'],
    },
    permissionMode: 'read-only',
    credentialIds: [],
    ...overrides,
  }
}

test('normalizes a versioned unsigned Skill contract and binds identity to coordinates', () => {
  const value = normalizeLocalSkillManifest(manifest())
  assert.equal(value.identity.version, '1.2.3')
  assert.match(localSkillContractHash(value), /^[a-f0-9]{64}$/)
  assert.deepEqual(
    assertManifestIdentity(value, {
      targetKind: 'codex', namespace: 'global', slug: 'review', name: 'Review',
    }),
    value,
  )
  assert.throws(
    () => assertManifestIdentity(value, {
      targetKind: 'codex', namespace: 'global', slug: 'other', name: 'Other',
    }),
    { message: 'LOCAL_SKILL_MANIFEST_IDENTITY_MISMATCH' },
  )
})

test('rejects incompatible Agents, missing inputs, tools, credentials, and permission escalation', () => {
  assert.equal(assertLocalSkillExecution(manifest(), execution()).identity.id, 'global/review')
  assert.throws(
    () => assertLocalSkillExecution(manifest(), execution({ version: '0.201.0' })),
    { message: 'LOCAL_SKILL_AGENT_INCOMPATIBLE' },
  )
  assert.throws(
    () => assertLocalSkillExecution(
      manifest({ inputTypes: ['text', 'image'] }), execution(),
    ),
    { message: 'LOCAL_SKILL_INPUT_INCOMPATIBLE' },
  )
  assert.throws(
    () => assertLocalSkillExecution(
      manifest({ tools: ['browser'] }), execution(),
    ),
    { message: 'LOCAL_SKILL_TOOL_INCOMPATIBLE' },
  )
  assert.throws(
    () => assertLocalSkillExecution(
      manifest({ credentials: [{ credentialId: 'account', type: 'provider-profile' }] }),
      execution(),
    ),
    { message: 'LOCAL_SKILL_CREDENTIAL_UNAVAILABLE' },
  )
  assert.throws(
    () => assertLocalSkillExecution(manifest(), execution({ permissionMode: 'workspace-write' })),
    { message: 'LOCAL_SKILL_PERMISSION_ESCALATION' },
  )
  assert.throws(
    () => assertLocalSkillExecution(
      manifest({ permissionMode: 'workspace-write', sideEffectClass: 'local-write' }),
      execution(),
    ),
    { message: 'LOCAL_SKILL_PERMISSION_ESCALATION' },
  )
})

test('rejects invalid side-effect and destination declarations', () => {
  assert.throws(
    () => normalizeLocalSkillManifest(manifest({ sideEffectClass: 'local-write' })),
    { message: 'LOCAL_SKILL_MANIFEST_INVALID' },
  )
  assert.throws(
    () => normalizeLocalSkillManifest(manifest({
      permissionMode: 'workspace-write',
      sideEffectClass: 'external-write',
      tools: ['network'],
    })),
    { message: 'LOCAL_SKILL_MANIFEST_INVALID' },
  )
  assert.throws(
    () => normalizeLocalSkillManifest(manifest({
      permissionMode: 'workspace-write',
      sideEffectClass: 'external-write',
      tools: ['network'],
      networkDestinations: ['http://example.com'],
    })),
    { message: 'LOCAL_SKILL_MANIFEST_INVALID' },
  )
  assert.throws(
    () => normalizeLocalSkillManifest(manifest({
      origin: { type: 'local-unsigned', publisher: '/Users/private/skill' },
    })),
    { message: 'LOCAL_SKILL_MANIFEST_INVALID' },
  )
})

test('snapshot provenance binds the approved manifest to the exact content hash', () => {
  const approvedManifest = manifest()
  const contentHash = 'a'.repeat(64)
  const provenance = createLocalSkillSnapshotProvenance({
    manifest: approvedManifest,
    contentHash,
    trustDecisionId: `skill-trust-decision-${'b'.repeat(64)}`,
    approvedAt: '2026-08-10T00:00:00.000Z',
  })
  assert.equal(provenance.contentHash, contentHash)
  assert.equal(provenance.contractHash, localSkillContractHash(approvedManifest))
  assert.deepEqual(normalizeLocalSkillSnapshotProvenance(provenance, contentHash), provenance)
  assert.throws(
    () => normalizeLocalSkillSnapshotProvenance(provenance, 'c'.repeat(64)),
    { message: 'LOCAL_SKILL_PROVENANCE_INVALID' },
  )
})
