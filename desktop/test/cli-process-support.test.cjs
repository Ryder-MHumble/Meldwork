const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { childEnvironment } = require('../src/cli-process-support.cjs')
const { managedOpenClawOptions } = require('../src/openclaw-runtime.cjs')

test('OpenClaw child environment keeps only its guarded runtime and selected credential', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-openclaw-child-env-'))
  const workdir = path.join(directory, 'workspace')
  fs.mkdirSync(workdir)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const previous = {}
  for (const key of ['GITHUB_TOKEN', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'APPDATA', 'LOCALAPPDATA']) {
    previous[key] = process.env[key]
  }
  process.env.GITHUB_TOKEN = 'ambient-secret'
  process.env.XDG_CONFIG_HOME = '/tmp/native-config'
  process.env.XDG_DATA_HOME = '/tmp/native-data'
  process.env.APPDATA = '/tmp/native-appdata'
  process.env.LOCALAPPDATA = '/tmp/native-localappdata'
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
  })

  const runtime = managedOpenClawOptions({
    storageRoot: directory,
    workdir,
    sessionRef: 'agent:main:child-env',
    provider: {
      OPENAI_API_KEY: 'selected-openclaw-key',
      OPENAI_BASE_URL: 'https://api.example.com/v1',
      OPENAI_MODEL: 'example-model',
    },
  })
  const env = childEnvironment(
    { kind: 'openclaw' },
    workdir,
    {
      ...runtime,
      env: {
        ...runtime.env,
        ROUNDRELAY_OPENCLAW_NATIVE_API_KEY: 'wrong-openclaw-key',
        GITHUB_TOKEN: 'caller-secret',
        ANTHROPIC_API_KEY: 'caller-anthropic-secret',
        XDG_CONFIG_HOME: '/tmp/caller-config',
      },
    },
    process.platform,
  )

  assert.equal(env.ROUNDRELAY_OPENCLAW_API_KEY, 'selected-openclaw-key')
  assert.equal(Object.hasOwn(env, 'ROUNDRELAY_OPENCLAW_NATIVE_API_KEY'), false)
  assert.equal(Object.hasOwn(env, 'GITHUB_TOKEN'), false)
  assert.equal(Object.hasOwn(env, 'ANTHROPIC_API_KEY'), false)
  assert.equal(env.OPENCLAW_WORKSPACE_DIR, workdir)
  assert.equal(env.HOME, runtime.env.OPENCLAW_HOME)
  assert.equal(env.USERPROFILE, runtime.env.OPENCLAW_HOME)
  assert.ok(env.XDG_CONFIG_HOME.startsWith(runtime.env.OPENCLAW_HOME))
  assert.ok(env.XDG_DATA_HOME.startsWith(runtime.env.OPENCLAW_HOME))
  assert.ok(env.XDG_STATE_HOME.startsWith(runtime.env.OPENCLAW_HOME))
  assert.ok(env.XDG_CACHE_HOME.startsWith(runtime.env.OPENCLAW_HOME))
  assert.notEqual(env.XDG_CONFIG_HOME, '/tmp/native-config')
  assert.notEqual(env.APPDATA, '/tmp/native-appdata')
  assert.notEqual(env.LOCALAPPDATA, '/tmp/native-localappdata')
})

test('every OpenClaw child requires an app-owned runtime guard', () => {
  assert.throws(() => childEnvironment(
    { kind: 'openclaw' },
    '/tmp/workspace',
    {},
    process.platform,
  ), { message: 'OPENCLAW_RUNTIME_GUARD_REQUIRED' })
})
