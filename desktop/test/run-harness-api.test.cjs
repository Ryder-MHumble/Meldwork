const test = require('node:test')
const assert = require('node:assert/strict')

const harnessApi = require('../src/run-harness.cjs')

test('keeps the Run Harness facade API stable after internal module extraction', () => {
  assert.deepEqual(Object.keys(harnessApi).sort(), [
    'DEFAULT_CONTEXT_BUDGET',
    'DEFAULT_CONTEXT_ENTRY_LIMIT',
    'DEFAULT_MAX_AGENT_RUNS',
    'DEFAULT_MAX_EVENTS_PER_AGENT',
    'DEFAULT_MAX_OUTPUT_CHARS',
    'DEFAULT_SESSION_CHARS',
    'DEFAULT_SESSION_TURNS',
    'EVENT_TYPES',
    'RunHarness',
    'evidenceCapsuleText',
    'nextSessionMeta',
    'normalizeOutcomeRefs',
    'normalizeRawEvent',
    'normalizeRunEvent',
    'normalizeSessionMeta',
    'normalizeTraceCapsule',
    'packContextEntries',
    'shouldRotateSession',
    'traceCapsuleFromAgentRun',
  ])
  assert.equal(harnessApi.DEFAULT_CONTEXT_BUDGET, 12000)
  assert.equal(harnessApi.DEFAULT_CONTEXT_ENTRY_LIMIT, 3000)
  assert.equal(harnessApi.DEFAULT_MAX_AGENT_RUNS, 64)
  assert.equal(harnessApi.DEFAULT_MAX_EVENTS_PER_AGENT, 80)
  assert.equal(harnessApi.DEFAULT_MAX_OUTPUT_CHARS, 20000)
  assert.equal(harnessApi.DEFAULT_SESSION_CHARS, 48000)
  assert.equal(harnessApi.DEFAULT_SESSION_TURNS, 18)
  assert.ok(harnessApi.EVENT_TYPES instanceof Set)
})
