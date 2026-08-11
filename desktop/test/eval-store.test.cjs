const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { EvalHarness, buildFitMatrix } = require('../src/eval-harness.cjs')
const { EVAL_CASE_VERSION } = require('../src/eval-records.cjs')
const { EvalStore } = require('../src/eval-store.cjs')

function caseInput() {
  return {
    schemaVersion: EVAL_CASE_VERSION,
    caseKey: 'recovery',
    caseVersion: '1.0.0',
    title: 'Recover after an interrupted run',
    domain: 'recovery',
    routingDomains: ['general'],
    input: { prompt: 'Resume from a checkpoint.', contextVersion: 'context-v1' },
    constraints: [{ id: 'preserve-state', statement: 'Preserve completed work.' }],
    expectedArtifacts: [{ id: 'record', type: 'recovery-record', minCount: 1 }],
    evidenceRequirements: [{ id: 'checkpoint', type: 'recovery-checkpoint', minCount: 1 }],
    rubric: {
      version: 'rubric-v1',
      checks: [
        { id: 'artifact', type: 'artifact-requirement', requirementId: 'record', weight: 25 },
        { id: 'evidence', type: 'evidence-requirement', requirementId: 'checkpoint', weight: 25 },
        { id: 'recovered', type: 'signal-equals', signal: 'recovered', expected: true, weight: 25 },
        { id: 'preserved', type: 'signal-equals', signal: 'state-preserved', expected: true, weight: 25 },
      ],
    },
  }
}

function target() {
  return {
    mode: 'single-agent',
    participants: [{
      kind: 'codex', connectorId: 'builtin.codex', connectorVersion: '0.1.0',
      provider: null, model: null,
    }],
    workflow: null,
  }
}

function observation() {
  return {
    status: 'completed',
    usage: { inputTokens: null, outputTokens: null, toolCalls: 1, estimatedCostUsd: null },
    failures: [],
    artifacts: [{ type: 'recovery-record', artifactId: null }],
    evidence: [{ type: 'recovery-checkpoint', evidenceId: null }],
    signals: [{ name: 'recovered', value: true }, { name: 'state-preserved', value: true }],
    reviews: [],
  }
}

function recordPath(root, category, id) {
  const digest = id.slice(id.lastIndexOf('-') + 1)
  return path.join(root, category, digest.slice(0, 2), `${id}.json`)
}

test('EvalStore persists immutable cases, results, and matrices with reference checks', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-evals-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = new EvalStore({ rootPath: path.join(directory, 'evals') })
  let time = 0
  const harness = new EvalHarness({ store, clock: () => ++time })
  const result = await harness.runCase(caseInput(), target(), observation)
  const evalCase = store.getCase(result.evalCaseId)
  const matrix = buildFitMatrix({
    cases: [evalCase], results: [result], corpusVersion: 'store-test-v1',
  })
  store.putMatrix(matrix)

  assert.deepEqual(store.getResult(result.evalResultId), result)
  assert.deepEqual(store.getMatrix(matrix.matrixId), matrix)
  assert.equal(fs.statSync(recordPath(store.rootPath, 'results', result.evalResultId)).mode & 0o777, 0o600)
})

test('EvalStore rejects missing references and tampered content', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-evals-tamper-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = new EvalStore({ rootPath: path.join(directory, 'evals') })
  let time = 0
  const harness = new EvalHarness({ store, clock: () => ++time })
  const result = await harness.runCase(caseInput(), target(), observation)
  const filename = recordPath(store.rootPath, 'results', result.evalResultId)
  const forged = JSON.parse(fs.readFileSync(filename, 'utf8'))
  forged.durationMs += 1
  fs.writeFileSync(filename, JSON.stringify(forged), { mode: 0o600 })
  assert.throws(() => store.getResult(result.evalResultId), { message: 'EVAL_RESULT_TAMPERED' })

  const orphanStore = new EvalStore({ rootPath: path.join(directory, 'orphan-evals') })
  assert.throws(() => orphanStore.putResult(result), { message: 'EVAL_CASE_NOT_FOUND' })
})
