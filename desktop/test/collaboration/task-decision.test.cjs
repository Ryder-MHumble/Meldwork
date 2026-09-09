const test = require('node:test')
const assert = require('node:assert/strict')
const { parseTaskDecision } = require('../../src/collaboration/task-decision.cjs')

test('completion requires an explicit reason and deliverable evidence', () => {
  const decision = { status: 'completed', reason: 'Checked the requested output.', deliverables: ['result.txt'] }
  assert.deepEqual(parseTaskDecision(decision), decision)
  for (const input of [
    { ...decision, deliverables: [] },
    { ...decision, reason: ' ' },
    { ...decision, deliverables: [''] },
    { ...decision, status: 'success' },
    { ...decision, extra: true },
    { ...decision, handoffTo: 'other' },
  ]) assert.throws(() => parseTaskDecision(input), /LOCAL_RUN_TASK_DECISION_INVALID/)
})

test('unfinished decisions permit no deliverable and continuation permits an explicit handoff', () => {
  for (const status of ['continue', 'blocked', 'needs-human']) {
    const decision = { status, reason: 'More input is needed.', deliverables: [] }
    assert.deepEqual(parseTaskDecision(decision), decision)
  }
  const decision = { status: 'continue', reason: 'Review the output.', deliverables: [], handoffTo: 'custom-agent' }
  assert.deepEqual(parseTaskDecision(decision), decision)
  assert.throws(() => parseTaskDecision({ ...decision, handoffTo: '@ghost' }), /LOCAL_RUN_TASK_DECISION_INVALID/)
})

test('task decisions reject malformed and oversized payloads', () => {
  const decision = { status: 'continue', reason: 'Continue.', deliverables: [] }
  for (const input of [
    null, [], 'completed',
    { ...decision, reason: 'x'.repeat(1601) },
    { ...decision, reason: 'bad\u0000input' },
    { ...decision, deliverables: 'output' },
    { ...decision, deliverables: Array(17).fill('output') },
    { ...decision, deliverables: ['x'.repeat(801)] },
    { ...decision, deliverables: [42] },
  ]) assert.throws(() => parseTaskDecision(input), /LOCAL_RUN_TASK_DECISION_INVALID/)
})
