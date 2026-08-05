const assert = require('node:assert/strict')
const test = require('node:test')

const {
  AGENT_COMPATIBILITY,
  assessAgentVersion,
  capabilityProbes,
  extractAgentVersion,
} = require('../src/agent-compatibility.cjs')

test('extracts connector versions from decorated CLI output', () => {
  assert.equal(extractAgentVersion('codex-cli 0.137.0'), '0.137.0')
  assert.equal(extractAgentVersion('codex-cli 0.146.0-alpha.9.2'), '0.146.0-alpha.9.2')
  assert.equal(extractAgentVersion('Hermes Agent v0.19.1 (2026.7.30)'), '0.19.1')
  assert.equal(extractAgentVersion('OpenClaw 2026.7.1-2 (0790d9f)'), '2026.7.1-2')
  assert.equal(extractAgentVersion('open-code-review v1.8.6 darwin/arm64'), '1.8.6')
  assert.equal(extractAgentVersion('Please log in'), '')
})

test('accepts inclusive release ranges and rejects unvalidated versions', () => {
  for (const [kind, contract] of Object.entries(AGENT_COMPATIBILITY)) {
    const supported = contract.exactVersion
      ? [contract.exactVersion]
      : [contract.minVersion, contract.maxVersion, ...contract.prereleaseVersions]
    for (const version of supported) {
      assert.equal(assessAgentVersion(kind, version).compatibilityState, 'compatible', kind)
    }
  }

  for (const [kind, version] of [
    ['codex', '0.136.9'],
    ['codex', '0.146.1'],
    ['codex', '0.146.0-alpha.9.3'],
    ['hermes', '0.19.1-beta.1'],
    ['openclaw', '2026.7.1'],
    ['gemini', '0.53.2'],
    ['opencodereview', '1.8.7'],
  ]) {
    assert.deepEqual(assessAgentVersion(kind, version), {
      resolvedVersion: version,
      supportedVersionRange: AGENT_COMPATIBILITY[kind].supportedVersionRange,
      compatibilityState: 'incompatible',
      incompatibilityReason: 'LOCAL_AGENT_VERSION_UNSUPPORTED',
    })
  }
})

test('defines required capability probes for every supported connector', () => {
  assert.deepEqual(Object.keys(AGENT_COMPATIBILITY).sort(), [
    'claude', 'codex', 'gemini', 'hermes', 'kimi', 'mimo', 'openclaw',
    'opencode', 'opencodereview', 'qwen', 'workbuddy',
  ])
  for (const kind of Object.keys(AGENT_COMPATIBILITY)) {
    assert.ok(capabilityProbes(kind).length > 0, kind)
  }
  assert.deepEqual(capabilityProbes('kimi').map(item => item.id), [
    'kimi-stream', 'kimi-acp',
  ])
  assert.ok(capabilityProbes('codex')[0].requiredText.includes('--json'))
  assert.equal(capabilityProbes('hermes')[0].requiredText.includes('--skills'), false)
  assert.ok(capabilityProbes('opencodereview')[0].requiredText.includes('--background'))
})
