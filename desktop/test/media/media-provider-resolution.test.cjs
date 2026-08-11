const test = require('node:test')
const assert = require('node:assert/strict')

const { resolveMediaProvider } = require('../../src/media/media-provider-resolution.cjs')

test('all Agents can fall back to one securely configured media Provider', () => {
  const statuses = {
    openclaw: {
      configured: true, baseUrl: 'https://hub.zgci.org/v1', model: 'glm',
    },
  }
  const provider = resolveMediaProvider({
    requestedKind: 'hermes',
    type: 'video',
    kinds: ['codex', 'hermes', 'openclaw'],
    statusFor: kind => statuses[kind] || { configured: false },
    credentialsFor: kind => kind === 'openclaw' ? { OPENAI_API_KEY: 'secure-key' } : {},
  })

  assert.deepEqual(provider, {
    apiKey: 'secure-key',
    baseUrl: 'https://hub.zgci.org/v1',
    model: 'glm',
    sourceKind: 'openclaw',
  })
})

test('video resolution prefers an H3-capable profile over the target chat profile', () => {
  const statuses = {
    hermes: { configured: true, baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1' },
    openclaw: { configured: true, baseUrl: 'https://hub.zgci.org/v1', model: 'glm' },
  }
  const provider = resolveMediaProvider({
    requestedKind: 'hermes',
    type: 'video',
    kinds: ['hermes', 'openclaw'],
    statusFor: kind => statuses[kind] || { configured: false },
    credentialsFor: kind => ({ OPENAI_API_KEY: `${kind}-key` }),
  })

  assert.equal(provider.sourceKind, 'openclaw')
  assert.equal(provider.apiKey, 'openclaw-key')
})

test('excludes a configured Provider after its media model is unavailable', () => {
  const statuses = {
    openclaw: { configured: true, baseUrl: 'https://hub.zgci.org/v1', model: 'glm' },
    opencodereview: { configured: true, baseUrl: 'https://hub.zgci.org/v1', model: 'glm' },
  }
  const provider = resolveMediaProvider({
    requestedKind: 'hermes',
    type: 'video',
    kinds: ['openclaw', 'opencodereview'],
    excludedKinds: ['openclaw'],
    statusFor: kind => statuses[kind] || { configured: false },
    credentialsFor: kind => ({ OPENAI_API_KEY: `${kind}-key` }),
  })

  assert.equal(provider.sourceKind, 'opencodereview')
  assert.equal(provider.apiKey, 'opencodereview-key')
})

test('uses a secure global ZGCI media fallback without requiring per-Agent provider binding', () => {
  const provider = resolveMediaProvider({
    requestedKind: 'codex',
    type: 'video',
    kinds: ['codex', 'hermes'],
    statusFor: () => ({ configured: false }),
    credentialsFor: () => ({}),
    fallbackProviders: [{
      kind: 'zgci-media',
      status: {
        configured: true,
        provider: 'ZGCI Media',
        baseUrl: 'https://hub.zgci.org/v1',
        model: 'glm',
      },
      credentials: { OPENAI_API_KEY: 'zgci-key' },
    }],
  })

  assert.deepEqual(provider, {
    apiKey: 'zgci-key',
    baseUrl: 'https://hub.zgci.org/v1',
    model: 'glm',
    sourceKind: 'zgci-media',
  })
})
