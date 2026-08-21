const assert = require('node:assert/strict')
const test = require('node:test')

const {
  discoverTestFiles,
  normalizeSuite,
  testSuiteForFile,
} = require('../../scripts/test-discovery.cjs')

test('test discovery exposes stable domain suites', () => {
  assert.deepEqual([...normalizeSuite('agents')], ['agents'])
  assert.equal(testSuiteForFile('/tmp/project/test/workspace/example.test.cjs', '/tmp/project/test'), 'workspace')
  assert.throws(() => normalizeSuite('missing'), /Unknown desktop test suite/)
})

test('test discovery filters recursively without changing the default set', () => {
  const all = discoverTestFiles()
  const agents = discoverTestFiles({ suite: 'agents' })

  assert.ok(all.length > agents.length)
  assert.ok(agents.length > 0)
  assert.ok(agents.every((filename) => testSuiteForFile(filename) === 'agents'))
})
