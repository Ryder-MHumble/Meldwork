const test = require('node:test')
const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const frozenMatrix = require('../../src/evaluations/data/agent-fit-matrix.v1.json')

const desktopRoot = path.resolve(__dirname, '..', '..')
const runner = path.join(desktopRoot, 'scripts', 'run-evals.cjs')

test('deterministic Eval CLI reproduces the committed frozen matrix', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-eval-cli-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const matrixPath = path.join(directory, 'matrix.json')
  const run = childProcess.spawnSync(process.execPath, [
    runner, '--suite', 'deterministic', '--matrix-output', matrixPath,
  ], { cwd: desktopRoot, encoding: 'utf8' })

  assert.equal(run.status, 0, run.stderr)
  const summary = JSON.parse(run.stdout.trim())
  const generated = JSON.parse(fs.readFileSync(matrixPath, 'utf8'))
  assert.equal(summary.cases, 6)
  assert.equal(summary.results, 18)
  assert.equal(summary.routingEligibleEntries, 0)
  assert.equal(summary.matrixId, frozenMatrix.matrixId)
  assert.deepEqual(generated, frozenMatrix)
})

test('provider Eval CLI remains disabled without explicit local opt-in', () => {
  const environment = { ...process.env }
  delete environment.MELDWORK_EVAL_PROVIDER
  const run = childProcess.spawnSync(process.execPath, [runner, '--suite', 'provider'], {
    cwd: desktopRoot,
    encoding: 'utf8',
    env: environment,
  })

  assert.equal(run.status, 1)
  assert.equal(run.stderr.trim(), 'EVAL_PROVIDER_OPT_IN_REQUIRED')
})
