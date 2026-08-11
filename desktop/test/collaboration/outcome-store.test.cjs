const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { ContentBlobStore } = require('../../src/attachments/content-blob-store.cjs')
const {
  canonicalJson,
  createAdoptionRecord,
  createArtifactRecord,
  createEvidenceRecord,
  createReviewerFindingRecord,
  parseAdoptionRecord,
  parseArtifactRecord,
  parseEvidenceRecord,
  parseReviewerFindingRecord,
} = require('../../src/collaboration/outcome-records.cjs')
const { OutcomeStore } = require('../../src/collaboration/outcome-store.cjs')

const PRODUCER = {
  runId: 'run-1',
  agentRunId: 'agent-run-1',
  agentKind: 'codex',
}
const AGENT_ACTOR = { kind: 'agent', ...PRODUCER }
const HUMAN_ACTOR = { kind: 'human', actorId: 'reviewer-1' }

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function fakeContentRef(value = 'artifact', mediaType = 'text/plain') {
  const bytes = Buffer.from(value)
  return {
    algorithm: 'sha256',
    hash: hash(bytes),
    size: bytes.length,
    mediaType,
  }
}

function artifactInput(overrides = {}) {
  const contentRef = fakeContentRef()
  return {
    type: 'document',
    name: 'report.md',
    producedBy: PRODUCER,
    contentRef,
    contentHash: contentRef.hash,
    locationRef: { kind: 'workspace-relative', path: 'reports/report.md' },
    ...overrides,
  }
}

function evidenceInput(artifactId, overrides = {}) {
  return {
    kind: 'observation',
    level: 'observed',
    subject: { type: 'artifact', artifactId },
    summary: 'The stored report contains the expected heading.',
    recordedBy: AGENT_ACTOR,
    refs: [{ type: 'artifact', artifactId }],
    ...overrides,
  }
}

function findingInput(artifactId, evidenceIds = [], overrides = {}) {
  return {
    artifactId,
    relation: 'support',
    summary: 'The reviewer confirmed the report output.',
    reviewer: HUMAN_ACTOR,
    evidenceIds,
    ...overrides,
  }
}

function adoptionInput(artifactId, overrides = {}) {
  return {
    artifactId,
    status: 'accepted',
    actor: HUMAN_ACTOR,
    summary: 'Accepted for the local release.',
    evidenceIds: [],
    findingIds: [],
    destinationRef: { kind: 'workspace-relative', path: 'release/report.md' },
    previousAdoptionId: null,
    ...overrides,
  }
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-outcomes-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const blobRoot = path.join(directory, 'private', 'blobs')
  const rootPath = path.join(directory, 'private', 'outcomes')
  const contentBlobStore = new ContentBlobStore({ rootPath: blobRoot })
  const store = new OutcomeStore({ rootPath, contentBlobStore })
  return { blobRoot, contentBlobStore, directory, rootPath, store }
}

function recordPath(rootPath, category, id) {
  const digest = id.slice(id.lastIndexOf('-') + 1)
  return path.join(rootPath, category, digest.slice(0, 2), `${id}.json`)
}

test('derives stable immutable IDs for every Outcome entity', () => {
  const artifact = createArtifactRecord(artifactInput())
  const reorderedArtifact = createArtifactRecord({
    locationRef: artifactInput().locationRef,
    contentHash: artifactInput().contentHash,
    contentRef: artifactInput().contentRef,
    producedBy: PRODUCER,
    name: 'report.md',
    type: 'document',
  })
  const evidence = createEvidenceRecord(evidenceInput(artifact.artifactId))
  const finding = createReviewerFindingRecord(findingInput(
    artifact.artifactId, [evidence.evidenceId],
  ))
  const adoption = createAdoptionRecord(adoptionInput(artifact.artifactId, {
    evidenceIds: [evidence.evidenceId],
    findingIds: [finding.reviewerFindingId],
  }))

  for (const [record, idKey, prefix, parser] of [
    [artifact, 'artifactId', 'artifact', parseArtifactRecord],
    [evidence, 'evidenceId', 'evidence', parseEvidenceRecord],
    [finding, 'reviewerFindingId', 'reviewer-finding', parseReviewerFindingRecord],
    [adoption, 'adoptionId', 'adoption', parseAdoptionRecord],
  ]) {
    const { [idKey]: id, ...body } = record
    assert.equal(id, `${prefix}-${hash(canonicalJson(body))}`)
    assert.deepEqual(parser(canonicalJson(record)), record)
  }
  assert.deepEqual(reorderedArtifact, artifact)
  assert.throws(
    () => parseArtifactRecord({ ...artifact, name: 'forged.md' }),
    { message: 'ARTIFACT_ID_MISMATCH' },
  )
})

test('supports every Artifact type with content or bounded location references', () => {
  for (const type of ['diff', 'document', 'structured-data', 'media', 'bundle']) {
    assert.equal(createArtifactRecord(artifactInput({ type })).type, type)
  }

  const fileHash = hash('workspace file')
  const file = createArtifactRecord({
    type: 'file',
    name: 'result.txt',
    producedBy: PRODUCER,
    contentHash: fileHash,
    locationRef: { kind: 'workspace-relative', path: '.meldwork-output/result.txt' },
  })
  const link = createArtifactRecord({
    type: 'link',
    name: 'Source',
    producedBy: PRODUCER,
    locationRef: { kind: 'uri', uri: 'https://example.test/source' },
  })

  assert.equal(file.contentHash, fileHash)
  assert.equal(link.locationRef.kind, 'uri')
})

test('requires concrete references for reproduced and human-accepted Evidence', () => {
  const artifact = createArtifactRecord(artifactInput())
  const observed = createEvidenceRecord(evidenceInput(artifact.artifactId))
  const reproduced = createEvidenceRecord(evidenceInput(artifact.artifactId, {
    kind: 'test-result',
    level: 'reproduced',
    refs: [{ type: 'evidence', evidenceId: observed.evidenceId }],
  }))
  const accepted = createEvidenceRecord(evidenceInput(artifact.artifactId, {
    kind: 'human-decision',
    level: 'human-accepted',
    recordedBy: HUMAN_ACTOR,
    refs: [{
      type: 'location',
      locationRef: { kind: 'workspace-relative', path: 'reports/report.md' },
      contentHash: artifact.contentHash,
    }],
  }))

  assert.equal(reproduced.level, 'reproduced')
  assert.equal(accepted.level, 'human-accepted')
  assert.throws(() => createEvidenceRecord(evidenceInput(artifact.artifactId, {
    level: 'reproduced',
    refs: [{ type: 'artifact', artifactId: artifact.artifactId }],
  })), { message: 'EVIDENCE_SCHEMA_INVALID' })
  assert.throws(() => createEvidenceRecord(evidenceInput(artifact.artifactId, {
    level: 'reproduced',
    refs: [{
      type: 'location',
      locationRef: { kind: 'workspace-relative', path: 'reports/report.md' },
    }],
  })), { message: 'EVIDENCE_SCHEMA_INVALID' })
  assert.throws(() => createEvidenceRecord(evidenceInput(artifact.artifactId, {
    level: 'human-accepted',
    recordedBy: AGENT_ACTOR,
  })), { message: 'EVIDENCE_SCHEMA_INVALID' })
})

test('models support and contradict findings plus every Adoption status', () => {
  const artifact = createArtifactRecord(artifactInput())
  assert.equal(createReviewerFindingRecord(findingInput(artifact.artifactId)).relation, 'support')
  assert.equal(createReviewerFindingRecord(findingInput(artifact.artifactId, [], {
    relation: 'contradict',
  })).relation, 'contradict')

  for (const status of ['exported', 'applied', 'committed', 'sent']) {
    assert.equal(createAdoptionRecord(adoptionInput(artifact.artifactId, { status })).status, status)
  }
})

test('rejects unknown, secret, executable, raw command, tool output, and reasoning fields', () => {
  const artifact = createArtifactRecord(artifactInput())
  assert.throws(
    () => createArtifactRecord({ ...artifactInput(), arbitrary: true }),
    { message: 'ARTIFACT_SCHEMA_INVALID' },
  )
  assert.throws(
    () => createArtifactRecord({ ...artifactInput(), credentials: { token: 'value' } }),
    { message: 'ARTIFACT_FORBIDDEN_FIELD' },
  )
  assert.throws(
    () => createArtifactRecord({ ...artifactInput(), executablePath: '/usr/bin/agent' }),
    { message: 'ARTIFACT_FORBIDDEN_FIELD' },
  )
  assert.throws(() => createEvidenceRecord({
    ...evidenceInput(artifact.artifactId),
    rawCommand: 'npm test',
  }), { message: 'EVIDENCE_FORBIDDEN_FIELD' })
  assert.throws(() => createReviewerFindingRecord({
    ...findingInput(artifact.artifactId),
    toolOutput: 'unrestricted output',
  }), { message: 'REVIEWER_FINDING_FORBIDDEN_FIELD' })
  assert.throws(() => createAdoptionRecord({
    ...adoptionInput(artifact.artifactId),
    privateChainOfThought: 'hidden reasoning',
  }), { message: 'ADOPTION_FORBIDDEN_FIELD' })
  assert.throws(() => createArtifactRecord({
    ...artifactInput(),
    name: 'Authorization: Bearer example-secret',
  }), { message: 'ARTIFACT_FORBIDDEN_VALUE' })
})

test('enforces bounded schemas, safe locations, unique refs, and matching hashes', () => {
  const artifact = createArtifactRecord(artifactInput())
  assert.throws(() => createArtifactRecord(artifactInput({
    contentHash: '0'.repeat(64),
  })), { message: 'ARTIFACT_SCHEMA_INVALID' })
  assert.throws(() => createArtifactRecord(artifactInput({
    type: 'link',
    contentRef: undefined,
    contentHash: undefined,
  })), { message: 'ARTIFACT_SCHEMA_INVALID' })
  assert.throws(() => createArtifactRecord(artifactInput({
    locationRef: { kind: 'workspace-relative', path: '../outside.txt' },
  })), { message: 'ARTIFACT_SCHEMA_INVALID' })
  assert.throws(() => createArtifactRecord(artifactInput({
    type: 'link',
    contentRef: undefined,
    contentHash: undefined,
    locationRef: { kind: 'uri', uri: 'https://user:pass@example.test/' },
  })), { message: 'ARTIFACT_FORBIDDEN_VALUE' })
  assert.throws(() => createEvidenceRecord(evidenceInput(artifact.artifactId, {
    refs: [
      { type: 'artifact', artifactId: artifact.artifactId },
      { type: 'artifact', artifactId: artifact.artifactId },
    ],
  })), { message: 'EVIDENCE_SCHEMA_INVALID' })
  assert.throws(() => createEvidenceRecord(evidenceInput(artifact.artifactId, {
    refs: Array.from({ length: 65 }, (_, index) => ({
      type: 'location',
      locationRef: { kind: 'workspace-relative', path: `evidence/${index}.txt` },
    })),
  })), { message: 'EVIDENCE_SCHEMA_INVALID' })
})

test('roundtrips all entities with private write-once files and no pruning', {
  skip: process.platform === 'win32',
}, (t) => {
  const { contentBlobStore, rootPath, store } = fixture(t)
  const contentRef = contentBlobStore.put('durable report', { mediaType: 'text/plain' })
  const artifact = store.putArtifact(artifactInput({ contentRef, contentHash: contentRef.hash }))
  const evidence = store.putEvidence(evidenceInput(artifact.artifactId, {
    kind: 'source-snapshot',
    refs: [{ type: 'blob', contentRef, contentHash: contentRef.hash }],
  }))
  const finding = store.putReviewerFinding(findingInput(
    artifact.artifactId, [evidence.evidenceId],
  ))
  const adoption = store.putAdoption(adoptionInput(artifact.artifactId, {
    evidenceIds: [evidence.evidenceId],
    findingIds: [finding.reviewerFindingId],
  }))
  const artifactFilename = recordPath(rootPath, 'artifacts', artifact.artifactId)

  assert.deepEqual(store.getArtifact(artifact.artifactId), artifact)
  assert.deepEqual(store.getEvidence(evidence.evidenceId), evidence)
  assert.deepEqual(store.getReviewerFinding(finding.reviewerFindingId), finding)
  assert.deepEqual(store.getAdoption(adoption.adoptionId), adoption)
  assert.equal(fs.readFileSync(artifactFilename, 'utf8'), canonicalJson(artifact))
  assert.equal(fs.statSync(rootPath).mode & 0o777, 0o700)
  assert.equal(fs.statSync(path.dirname(artifactFilename)).mode & 0o777, 0o700)
  assert.equal(fs.statSync(artifactFilename).mode & 0o777, 0o600)

  const records = Array.from({ length: 80 }, (_, index) => store.putArtifact(artifactInput({
    name: `report-${index}.md`,
    contentRef,
    contentHash: contentRef.hash,
  })))
  const restarted = new OutcomeStore({ rootPath, contentBlobStore })
  assert.deepEqual(restarted.getArtifact(records[0].artifactId), records[0])
  assert.deepEqual(restarted.getAdoption(adoption.adoptionId), adoption)
})

test('validates Content Blob and durable cross-entity references before writing', (t) => {
  const { contentBlobStore, store } = fixture(t)
  const missingRef = fakeContentRef('missing')
  assert.throws(() => store.putArtifact(artifactInput({
    contentRef: missingRef,
    contentHash: missingRef.hash,
  })), { message: 'ARTIFACT_CONTENT_NOT_FOUND' })

  const contentRef = contentBlobStore.put('stored')
  const artifact = store.putArtifact(artifactInput({ contentRef, contentHash: contentRef.hash }))
  const observed = store.putEvidence(evidenceInput(artifact.artifactId))
  const reproduced = store.putEvidence(evidenceInput(artifact.artifactId, {
    kind: 'test-result',
    level: 'reproduced',
    refs: [{ type: 'evidence', evidenceId: observed.evidenceId }],
  }))
  assert.equal(reproduced.refs[0].evidenceId, observed.evidenceId)
  const missingArtifactId = `artifact-${'a'.repeat(64)}`
  assert.throws(
    () => store.putEvidence(evidenceInput(missingArtifactId)),
    { message: 'ARTIFACT_NOT_FOUND' },
  )
  assert.throws(() => store.putEvidence(evidenceInput(artifact.artifactId, {
    refs: [{ type: 'blob', contentRef: missingRef, contentHash: missingRef.hash }],
  })), { message: 'EVIDENCE_CONTENT_NOT_FOUND' })
  assert.throws(() => store.putEvidence(evidenceInput(artifact.artifactId, {
    kind: 'test-result',
    level: 'reproduced',
    refs: [{ type: 'evidence', evidenceId: `evidence-${'b'.repeat(64)}` }],
  })), { message: 'EVIDENCE_NOT_FOUND' })
  assert.throws(
    () => store.putReviewerFinding(findingInput(missingArtifactId)),
    { message: 'ARTIFACT_NOT_FOUND' },
  )
  assert.throws(() => store.putAdoption(adoptionInput(artifact.artifactId, {
    evidenceIds: [`evidence-${'b'.repeat(64)}`],
  })), { message: 'EVIDENCE_NOT_FOUND' })
})

test('records every local human Adoption action through the production store API', (t) => {
  const { contentBlobStore, store } = fixture(t)
  const contentRef = contentBlobStore.put('adoptable report')
  const artifact = store.putArtifact(artifactInput({
    contentRef,
    contentHash: contentRef.hash,
  }))
  const evidence = store.putEvidence(evidenceInput(artifact.artifactId, {
    refs: [{ type: 'blob', contentRef, contentHash: contentRef.hash }],
  }))
  let previousAdoptionId = null

  for (const status of ['exported', 'applied', 'committed', 'sent']) {
    const record = store.recordHumanAdoption({
      artifactId: artifact.artifactId,
      status,
      summary: `The local user recorded ${status}.`,
      evidenceIds: [evidence.evidenceId],
      destinationRef: { kind: 'workspace-relative', path: `adoptions/${status}.json` },
      previousAdoptionId,
    })
    assert.deepEqual(record.actor, { kind: 'human', actorId: 'local-user' })
    assert.equal(record.previousAdoptionId, previousAdoptionId)
    assert.deepEqual(store.getAdoption(record.adoptionId), record)
    previousAdoptionId = record.adoptionId
  }

  assert.throws(() => store.recordHumanAdoption({
    artifactId: artifact.artifactId,
    status: 'exported',
    destinationRef: { kind: 'workspace-relative', path: 'adoptions/exported.json' },
    actor: AGENT_ACTOR,
  }), { message: 'ADOPTION_REQUEST_INVALID' })
  assert.throws(() => store.recordHumanAdoption({
    artifactId: artifact.artifactId,
    status: 'accepted',
    destinationRef: { kind: 'workspace-relative', path: 'adoptions/accepted.json' },
  }), { message: 'ADOPTION_REQUEST_INVALID' })
  assert.throws(() => store.recordHumanAdoption({
    artifactId: artifact.artifactId,
    status: 'exported',
  }), { message: 'ADOPTION_REQUEST_INVALID' })
})

test('deduplicates exact records but never overwrites a tampered path', (t) => {
  const { contentBlobStore, rootPath, store } = fixture(t)
  const contentRef = contentBlobStore.put('content')
  const input = artifactInput({ contentRef, contentHash: contentRef.hash })
  const record = store.putArtifact(input)
  const filename = recordPath(rootPath, 'artifacts', record.artifactId)
  const before = fs.statSync(filename)

  assert.deepEqual(store.putArtifact(input), record)
  const after = fs.statSync(filename)
  assert.equal(after.ino, before.ino)
  assert.equal(after.mtimeMs, before.mtimeMs)

  fs.writeFileSync(filename, '{}', { mode: 0o600 })
  assert.throws(() => store.putArtifact(input), { message: 'ARTIFACT_TAMPERED' })
  assert.equal(fs.readFileSync(filename, 'utf8'), '{}')
  assert.equal(fs.readdirSync(path.dirname(filename)).some(name => name.startsWith('.tmp-')), false)
})

test('rejects identifier traversal, symlink roots, and symlink record files', {
  skip: process.platform === 'win32',
}, (t) => {
  const { contentBlobStore, directory, rootPath, store } = fixture(t)
  assert.throws(
    () => store.getArtifact('../artifact-' + 'a'.repeat(64)),
    { message: 'ARTIFACT_ID_INVALID' },
  )

  const realRoot = path.join(directory, 'real-outcome-root')
  const rootLink = path.join(directory, 'outcome-root-link')
  fs.mkdirSync(realRoot)
  fs.symlinkSync(realRoot, rootLink)
  assert.throws(
    () => new OutcomeStore({ rootPath: rootLink, contentBlobStore }),
    { message: 'OUTCOME_STORE_ROOT_UNSAFE' },
  )

  const contentRef = contentBlobStore.put('content')
  const record = store.putArtifact(artifactInput({ contentRef, contentHash: contentRef.hash }))
  const filename = recordPath(rootPath, 'artifacts', record.artifactId)
  const outside = path.join(directory, 'outside-record.json')
  fs.writeFileSync(outside, canonicalJson(record))
  fs.unlinkSync(filename)
  fs.symlinkSync(outside, filename)
  assert.throws(() => store.getArtifact(record.artifactId), { message: 'ARTIFACT_TAMPERED' })
  assert.equal(fs.readFileSync(outside, 'utf8'), canonicalJson(record))
})

test('rejects non-canonical stored records and invalid Adoption ancestry', (t) => {
  const { contentBlobStore, rootPath, store } = fixture(t)
  const contentRef = contentBlobStore.put('content')
  const firstArtifact = store.putArtifact(artifactInput({
    contentRef,
    contentHash: contentRef.hash,
  }))
  const secondArtifact = store.putArtifact(artifactInput({
    name: 'second.md',
    contentRef,
    contentHash: contentRef.hash,
  }))
  const previous = store.putAdoption(adoptionInput(firstArtifact.artifactId))
  assert.throws(() => store.putAdoption(adoptionInput(secondArtifact.artifactId, {
    previousAdoptionId: previous.adoptionId,
  })), { message: 'ADOPTION_REFERENCE_INVALID' })

  const filename = recordPath(rootPath, 'artifacts', firstArtifact.artifactId)
  const { version, ...remaining } = firstArtifact
  fs.writeFileSync(filename, JSON.stringify({ version, ...remaining }), { mode: 0o600 })
  assert.throws(
    () => store.getArtifact(firstArtifact.artifactId),
    { message: 'ARTIFACT_TAMPERED' },
  )
})
