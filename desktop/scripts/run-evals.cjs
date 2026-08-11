#!/usr/bin/env node
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { EvalHarness, buildFitMatrix } = require('../src/eval-harness.cjs')
const { createEvalCase } = require('../src/eval-records.cjs')
const { EvalStore } = require('../src/eval-store.cjs')
const { canonicalJson } = require('../src/outcome-records.cjs')

function argumentValue(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? '' : String(process.argv[index + 1] || '')
}

function loadJson(filename) {
  const bytes = fs.readFileSync(filename)
  if (!bytes.length || bytes.length > 2 * 1024 * 1024) throw new Error('EVAL_CORPUS_INVALID')
  return JSON.parse(bytes.toString('utf8'))
}

function validateCorpus(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || input.schemaVersion !== 1 || typeof input.corpusVersion !== 'string'
      || !Array.isArray(input.cases) || !input.cases.length
      || !Array.isArray(input.targets) || !input.targets.length
      || !Array.isArray(input.runs) || !input.runs.length) {
    throw new Error('EVAL_CORPUS_INVALID')
  }
  const cases = input.cases.map(createEvalCase)
  const caseKeys = new Set(cases.map(item => item.caseKey))
  const targetIds = new Set(input.targets.map(item => item?.targetId))
  if (caseKeys.size !== cases.length || targetIds.size !== input.targets.length
      || input.runs.some(run => !caseKeys.has(run?.caseKey) || !targetIds.has(run?.targetId)
        || !Array.isArray(run?.omitCheckIds))) {
    throw new Error('EVAL_CORPUS_INVALID')
  }
  return { ...input, cases }
}

function fixtureObservation(evalCase, omitCheckIds) {
  const omitted = new Set(omitCheckIds)
  const artifacts = []
  const evidence = []
  const signals = []
  for (const check of evalCase.rubric.checks) {
    if (omitted.has(check.id)) continue
    if (check.type === 'artifact-requirement') {
      const requirement = evalCase.expectedArtifacts.find(item => item.id === check.requirementId)
      for (let index = 0; index < requirement.minCount; index += 1) {
        artifacts.push({ type: requirement.type, artifactId: null })
      }
    } else if (check.type === 'evidence-requirement') {
      const requirement = evalCase.evidenceRequirements.find(item => item.id === check.requirementId)
      for (let index = 0; index < requirement.minCount; index += 1) {
        evidence.push({ type: requirement.type, evidenceId: null })
      }
    } else if (check.type === 'signal-equals') {
      signals.push({ name: check.signal, value: check.expected })
    } else {
      signals.push({ name: check.signal, value: check.minimum })
    }
  }
  return {
    status: 'completed',
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      toolCalls: evalCase.routingDomains.includes('tool-use') ? 1 : 0,
      estimatedCostUsd: null,
    },
    failures: [],
    artifacts,
    evidence,
    signals,
    reviews: [],
  }
}

function providerExecutor(adapterPath) {
  if (process.env.MELDWORK_EVAL_PROVIDER !== '1') {
    throw new Error('EVAL_PROVIDER_OPT_IN_REQUIRED')
  }
  if (!adapterPath) throw new Error('EVAL_PROVIDER_ADAPTER_REQUIRED')
  const resolved = path.resolve(adapterPath)
  const adapter = require(resolved)
  if (typeof adapter.execute !== 'function') throw new Error('EVAL_PROVIDER_ADAPTER_INVALID')
  return context => adapter.execute(context)
}

async function main() {
  const suite = argumentValue('--suite') || 'deterministic'
  if (!['deterministic', 'provider'].includes(suite)) throw new Error('EVAL_SUITE_INVALID')
  const corpusPath = path.resolve(argumentValue('--corpus')
    || path.join(__dirname, '../test/fixtures/eval-deterministic-v1.json'))
  const corpus = validateCorpus(loadJson(corpusPath))
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-eval-run-'))
  const storeRoot = argumentValue('--store-root')
    ? path.resolve(argumentValue('--store-root'))
    : temporaryRoot
  const store = new EvalStore({ rootPath: path.join(storeRoot, 'records') })
  let clockValue = 0
  const harness = new EvalHarness({ store, clock: () => { clockValue += 10; return clockValue } })
  const caseByKey = new Map(corpus.cases.map(evalCase => [evalCase.caseKey, evalCase]))
  const targetById = new Map(corpus.targets.map(item => [item.targetId, item.target]))
  const executeProvider = suite === 'provider'
    ? providerExecutor(argumentValue('--adapter'))
    : null
  const results = []
  try {
    for (const run of corpus.runs) {
      const evalCase = caseByKey.get(run.caseKey)
      const target = targetById.get(run.targetId)
      const result = await harness.runCase(evalCase, target, context => (
        executeProvider
          ? executeProvider({ ...context, targetId: run.targetId })
          : fixtureObservation(evalCase, run.omitCheckIds)
      ))
      results.push(result)
    }
    const matrix = buildFitMatrix({
      cases: corpus.cases,
      results,
      corpusVersion: corpus.corpusVersion,
    })
    store.putMatrix(matrix)
    const matrixOutput = argumentValue('--matrix-output')
    if (matrixOutput) {
      const filename = path.resolve(matrixOutput)
      fs.mkdirSync(path.dirname(filename), { recursive: true })
      fs.writeFileSync(filename, `${canonicalJson(matrix)}\n`, { mode: 0o600 })
    }
    process.stdout.write(`${JSON.stringify({
      suite,
      corpusVersion: corpus.corpusVersion,
      cases: corpus.cases.length,
      results: results.length,
      matrixId: matrix.matrixId,
      routingEligibleEntries: matrix.entries.filter(entry => entry.routingEligible).length,
    })}\n`)
  } finally {
    if (!argumentValue('--store-root')) fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  process.stderr.write(`${String(error?.code || error?.message || 'EVAL_RUN_FAILED')}\n`)
  process.exitCode = 1
})
