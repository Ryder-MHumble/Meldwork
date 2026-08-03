const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { managedOpenClawOptions } = require('../src/openclaw-runtime.cjs')

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-openclaw-runtime-'))
  const workdir = path.join(directory, 'workspace')
  fs.mkdirSync(workdir)
  return { directory, workdir }
}

function provider(apiKey = 'test-openclaw-key') {
  return {
    OPENAI_API_KEY: apiKey,
    OPENAI_BASE_URL: 'https://api.example.com/v1',
    OPENAI_MODEL: 'example-model',
  }
}

test('managed runtime isolates OpenClaw state and keeps the API key out of config', (t) => {
  const { directory, workdir } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const result = managedOpenClawOptions({
    storageRoot: directory,
    workdir,
    sessionRef: 'agent:main:desktop-roundrelay-group-topic-openclaw',
    provider: provider(),
  })
  const configText = fs.readFileSync(result.env.OPENCLAW_CONFIG_PATH, 'utf8')
  const config = JSON.parse(configText)

  assert.equal(configText.includes('test-openclaw-key'), false)
  assert.deepEqual(config.models.providers['roundrelay-desktop'].apiKey, {
    source: 'env', provider: 'default', id: 'ROUNDRELAY_OPENCLAW_API_KEY',
  })
  assert.equal(config.agents.defaults.workspace, workdir)
  assert.equal(config.agents.defaults.skipBootstrap, true)
  assert.deepEqual(config.tools.allow, [
    'read', 'web_search', 'web_fetch', 'memory_search', 'memory_get', 'session_status',
  ])
  assert.equal(config.tools.fs.workspaceOnly, true)
  assert.equal(config.tools.elevated.enabled, false)
  assert.equal(result.env.ROUNDRELAY_OPENCLAW_API_KEY, 'test-openclaw-key')
  assert.equal(result.env.OPENCLAW_WORKSPACE_DIR, workdir)
  assert.ok(result.env.OPENCLAW_STATE_DIR.startsWith(directory))
  assert.equal(fs.statSync(result.env.OPENCLAW_CONFIG_PATH).mode & 0o777, 0o600)
})

test('managed runtime defensively normalizes chat completion endpoints to the API root', (t) => {
  const { directory, workdir } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const result = managedOpenClawOptions({
    storageRoot: directory,
    workdir,
    provider: {
      ...provider(),
      OPENAI_BASE_URL: 'https://api.example.com/v1/chat/completions/',
    },
  })
  const config = JSON.parse(fs.readFileSync(result.env.OPENCLAW_CONFIG_PATH, 'utf8'))

  assert.equal(config.models.providers['roundrelay-desktop'].baseUrl, 'https://api.example.com/v1')
})

test('write authorization uses an immutable config and preserves the topic state', (t) => {
  const { directory, workdir } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const input = {
    storageRoot: directory,
    workdir,
    sessionRef: 'agent:main:desktop-roundrelay-group-topic-openclaw',
    provider: provider(),
  }
  const readOnly = managedOpenClawOptions(input)
  const writable = managedOpenClawOptions({ ...input, allowWrite: true })
  const readOnlyConfig = JSON.parse(fs.readFileSync(readOnly.env.OPENCLAW_CONFIG_PATH, 'utf8'))
  const writableConfig = JSON.parse(fs.readFileSync(writable.env.OPENCLAW_CONFIG_PATH, 'utf8'))

  assert.equal(writable.env.OPENCLAW_STATE_DIR, readOnly.env.OPENCLAW_STATE_DIR)
  assert.notEqual(writable.env.OPENCLAW_CONFIG_PATH, readOnly.env.OPENCLAW_CONFIG_PATH)
  assert.equal(readOnlyConfig.tools.allow.includes('write'), false)
  assert.deepEqual(writableConfig.tools.allow.slice(-3), ['write', 'edit', 'apply_patch'])
  assert.ok(writableConfig.tools.deny.includes('exec'))
  assert.ok(writableConfig.tools.deny.includes('process'))
  assert.equal(writableConfig.tools.exec.security, 'deny')
})

test('runtime paths are stable and isolated per topic and workspace', (t) => {
  const { directory, workdir } = fixture()
  const otherWorkdir = path.join(directory, 'workspace-other')
  fs.mkdirSync(otherWorkdir)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const input = {
    storageRoot: directory,
    workdir,
    sessionRef: 'agent:main:desktop-roundrelay-group-topic-openclaw',
    provider: provider(),
  }

  const first = managedOpenClawOptions(input)
  const repeated = managedOpenClawOptions(input)
  const otherTopic = managedOpenClawOptions({ ...input, sessionRef: `${input.sessionRef}-other` })
  const otherWorkspace = managedOpenClawOptions({ ...input, workdir: otherWorkdir })

  assert.equal(repeated.env.OPENCLAW_STATE_DIR, first.env.OPENCLAW_STATE_DIR)
  assert.notEqual(otherTopic.env.OPENCLAW_STATE_DIR, first.env.OPENCLAW_STATE_DIR)
  assert.notEqual(otherWorkspace.env.OPENCLAW_STATE_DIR, first.env.OPENCLAW_STATE_DIR)
  assert.equal(otherWorkspace.env.OPENCLAW_WORKSPACE_DIR, otherWorkdir)
})

test('invalid runtime scopes and Provider metadata fail closed', (t) => {
  const { directory, workdir } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  assert.throws(() => managedOpenClawOptions({
    storageRoot: 'relative', workdir, provider: provider(),
  }), { message: 'OPENCLAW_RUNTIME_INVALID_SCOPE' })
  assert.throws(() => managedOpenClawOptions({
    storageRoot: directory, workdir,
    provider: provider(''),
  }), { message: 'OPENCLAW_PROVIDER_INVALID' })
  assert.throws(() => managedOpenClawOptions({
    storageRoot: directory, workdir,
    provider: { ...provider(), OPENAI_BASE_URL: 'http://provider.example/v1' },
  }), { message: 'OPENCLAW_PROVIDER_INVALID' })
})
