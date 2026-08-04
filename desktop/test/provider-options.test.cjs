const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  EXTERNAL_PROVIDER_KINDS,
  providerAgentKind,
  providerOptionsFor,
} = require('../src/provider-options.cjs')

const GENERIC = Object.freeze({
  OPENAI_API_KEY: 'provider-key',
  OPENAI_BASE_URL: 'https://api.example.com/v1',
  OPENAI_MODEL: 'example-model',
})

test('Provider Agent kinds are validated at the domain boundary', () => {
  assert.equal(providerAgentKind(' hermes '), 'hermes')
  assert.equal(EXTERNAL_PROVIDER_KINDS.has('opencodereview'), true)
  assert.throws(() => providerAgentKind('unknown'), { message: 'PROVIDER_AGENT_UNSUPPORTED' })
})

test('Provider options preserve the shared OpenAI-compatible environment', () => {
  assert.deepEqual(providerOptionsFor('codex', GENERIC), { env: GENERIC })
  assert.deepEqual(providerOptionsFor('hermes', GENERIC), {
    provider: { id: 'openai-api', model: 'example-model' },
    env: {
      ...GENERIC,
      HERMES_INFERENCE_PROVIDER: 'openai-api',
      HERMES_INFERENCE_MODEL: 'example-model',
    },
  })
  assert.deepEqual(providerOptionsFor('qwen', GENERIC), {
    provider: { id: 'openai', model: 'example-model' },
    env: { ...GENERIC, DASHSCOPE_API_KEY: 'provider-key' },
  })
})

test('Provider options map native Agent credential names without dropping generic values', () => {
  const expected = {
    workbuddy: {
      CODEBUDDY_MODEL: 'example-model',
      CODEBUDDY_API_KEY: 'provider-key',
      CODEBUDDY_BASE_URL: 'https://api.example.com/v1',
    },
    kimi: {
      MOONSHOT_API_KEY: 'provider-key',
      KIMI_API_KEY: 'provider-key',
      KIMI_MODEL_API_KEY: 'provider-key',
      KIMI_MODEL_BASE_URL: 'https://api.example.com/v1',
      KIMI_MODEL_NAME: 'example-model',
    },
    mimo: {
      MIMO_API_KEY: 'provider-key',
      MIMO_BASE_URL: 'https://api.example.com/v1',
      MIMO_MODEL: 'example-model',
    },
    claude: {
      ANTHROPIC_API_KEY: 'provider-key',
      ANTHROPIC_BASE_URL: 'https://api.example.com/v1',
      ANTHROPIC_MODEL: 'example-model',
    },
    gemini: {
      GEMINI_API_KEY: 'provider-key',
      GOOGLE_API_KEY: 'provider-key',
      GEMINI_MODEL: 'example-model',
    },
  }

  for (const [kind, values] of Object.entries(expected)) {
    assert.deepEqual(providerOptionsFor(kind, GENERIC), {
      env: { ...GENERIC, ...values },
    })
  }
})

test('OpenCode receives OpenRouter credentials only for an OpenRouter preset', () => {
  assert.deepEqual(providerOptionsFor('opencode', GENERIC, {}, {
    provider: 'Private OpenRouter proxy',
  }), {
    env: { ...GENERIC, OPENROUTER_API_KEY: 'provider-key' },
  })
  assert.deepEqual(providerOptionsFor('opencode', GENERIC, {}, {
    activePreset: 'custom',
    provider: 'OpenRouter',
  }), { env: GENERIC })
})

test('OpenCodeReview receives an exact chat completions endpoint', () => {
  assert.deepEqual(providerOptionsFor('opencodereview', GENERIC), {
    env: {
      ...GENERIC,
      OCR_LLM_URL: 'https://api.example.com/v1/chat/completions',
      OCR_LLM_TOKEN: 'provider-key',
      OCR_LLM_MODEL: 'example-model',
      OCR_USE_ANTHROPIC: 'false',
    },
  })
  assert.equal(
    providerOptionsFor('opencodereview', {
      ...GENERIC,
      OPENAI_BASE_URL: 'https://api.example.com/v1/chat/completions/',
    }).env.OCR_LLM_URL,
    'https://api.example.com/v1/chat/completions',
  )
})

test('OpenClaw Provider options remain scoped to its managed local runtime', (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-provider-options-'))
  const workdir = path.join(storageRoot, 'workspace')
  fs.mkdirSync(workdir)
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }))

  assert.deepEqual(providerOptionsFor('openclaw', GENERIC), {})
  const options = providerOptionsFor('openclaw', GENERIC, {
    storageRoot,
    workdir,
    sessionRef: 'agent:main:provider-options',
    sandbox: 'workspace-write',
  })
  const config = JSON.parse(fs.readFileSync(options.env.OPENCLAW_CONFIG_PATH, 'utf8'))

  assert.equal(options.env.ROUNDRELAY_OPENCLAW_API_KEY, 'provider-key')
  assert.equal(config.agents.defaults.workspace, workdir)
  assert.equal(config.tools.allow.includes('write'), true)
})

test('OpenClaw native auth also receives an app-owned isolated runtime', (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-native-openclaw-options-'))
  const workdir = path.join(storageRoot, 'workspace')
  fs.mkdirSync(workdir)
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }))

  const options = providerOptionsFor('openclaw', {}, {
    storageRoot,
    workdir,
    sessionRef: 'agent:main:native-provider-options',
    sandbox: 'read-only',
    nativeRuntime: {
      model: 'native/model',
      provider: {
        id: 'native',
        baseUrl: 'https://native.example.com/v1',
        api: 'openai-completions',
        apiKey: 'native-provider-key',
        model: { id: 'model', name: 'Native Model', input: ['text'] },
      },
    },
  })
  const config = JSON.parse(fs.readFileSync(options.env.OPENCLAW_CONFIG_PATH, 'utf8'))

  assert.equal(config.models.mode, 'replace')
  assert.equal(config.agents.defaults.model.primary, 'native/model')
  assert.equal(Object.hasOwn(config.agents, 'list'), false)
  assert.equal(config.tools.allow.includes('write'), false)
  assert.equal(config.tools.deny.includes('exec'), true)
  assert.equal(options.env.ROUNDRELAY_OPENCLAW_NATIVE_API_KEY, 'native-provider-key')
  assert.equal(Object.hasOwn(options.env, 'ROUNDRELAY_OPENCLAW_API_KEY'), false)
})

test('unknown Provider kinds do not create execution options', () => {
  assert.deepEqual(providerOptionsFor('unknown', GENERIC), {})
})
