const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  managedOpenClawOptions,
  nativeOpenClawOptions,
  validateOpenClawRuntimeGuard,
} = require('../src/openclaw-runtime.cjs')

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

function nativeRuntime(apiKey = 'native-openclaw-key') {
  return {
    model: 'native/model',
    provider: {
      id: 'native',
      baseUrl: 'https://native.example.com/v1',
      api: 'openai-completions',
      apiKey,
      model: {
        id: 'model',
        name: 'Native Model',
        input: ['text'],
        contextWindow: 128000,
        maxTokens: 4096,
      },
    },
  }
}

function runtimeScope(sessionRef, workdir) {
  return crypto.createHash('sha256')
    .update(`${sessionRef || 'configure'}\0${path.resolve(workdir)}`)
    .digest('hex')
    .slice(0, 24)
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
  assert.ok(result.env.OPENCLAW_STATE_DIR.startsWith(fs.realpathSync(directory)))
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

test('native auth uses the same isolated tool policy without importing user configuration', (t) => {
  const { directory, workdir } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const common = {
    storageRoot: directory,
    workdir,
    sessionRef: 'agent:main:desktop-roundrelay-native-openclaw',
  }
  const providerOptions = managedOpenClawOptions({ ...common, provider: provider() })
  const nativeOptions = nativeOpenClawOptions({
    ...common,
    runtime: {
      ...nativeRuntime(),
      provider: {
        ...nativeRuntime().provider,
        model: { ...nativeRuntime().provider.model, params: { unsafe: true } },
      },
      agentDir: '/Users/example/.openclaw/agents/main/agent',
      tools: { allow: ['exec'] },
    },
  })
  const providerConfig = JSON.parse(fs.readFileSync(providerOptions.env.OPENCLAW_CONFIG_PATH, 'utf8'))
  const nativeConfig = JSON.parse(fs.readFileSync(nativeOptions.env.OPENCLAW_CONFIG_PATH, 'utf8'))

  assert.deepEqual(nativeConfig.tools, providerConfig.tools)
  assert.equal(nativeConfig.models.mode, 'replace')
  assert.equal(nativeConfig.agents.defaults.model.primary, 'native/model')
  assert.equal(Object.hasOwn(nativeConfig.agents, 'list'), false)
  assert.equal(Object.hasOwn(nativeConfig, '$include'), false)
  assert.equal(Object.hasOwn(nativeConfig, 'plugins'), false)
  assert.equal(Object.hasOwn(nativeConfig, 'channels'), false)
  assert.deepEqual(Object.keys(nativeConfig.models.providers), ['native'])
  assert.deepEqual(nativeConfig.models.providers.native.apiKey, {
    source: 'env', provider: 'default', id: 'ROUNDRELAY_OPENCLAW_NATIVE_API_KEY',
  })
  assert.equal(JSON.stringify(nativeConfig).includes('native-openclaw-key'), false)
  assert.equal(Object.hasOwn(nativeConfig.models.providers.native.models[0], 'params'), false)
  assert.equal(nativeOptions.env.ROUNDRELAY_OPENCLAW_NATIVE_API_KEY, 'native-openclaw-key')
  assert.equal(Object.hasOwn(nativeOptions.env, 'ROUNDRELAY_OPENCLAW_API_KEY'), false)
  assert.ok(nativeOptions.env.OPENCLAW_STATE_DIR.startsWith(fs.realpathSync(directory)))
})

test('native write mode remains workspace scoped and keeps high-risk tools denied', (t) => {
  const { directory, workdir } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const options = nativeOpenClawOptions({
    storageRoot: directory,
    workdir,
    allowWrite: true,
    runtime: nativeRuntime(),
  })
  const config = JSON.parse(fs.readFileSync(options.env.OPENCLAW_CONFIG_PATH, 'utf8'))

  assert.deepEqual(config.tools.allow.slice(-3), ['write', 'edit', 'apply_patch'])
  assert.equal(config.tools.fs.workspaceOnly, true)
  assert.ok(config.tools.deny.includes('exec'))
  assert.ok(config.tools.deny.includes('browser'))
  assert.ok(config.tools.deny.includes('message'))
  assert.ok(config.tools.deny.includes('sessions_spawn'))
  assert.equal(config.agents.defaults.workspace, workdir)
})

test('native runtime descriptors fail closed before a config is written', (t) => {
  const { directory, workdir } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  for (const runtime of [
    null,
    { ...nativeRuntime(), model: 'invalid model' },
    { ...nativeRuntime(), provider: { ...nativeRuntime().provider, id: 'native.id' } },
    { ...nativeRuntime(), provider: { ...nativeRuntime().provider, apiKey: '' } },
    {
      ...nativeRuntime(),
      provider: {
        ...nativeRuntime().provider,
        apiKey: { source: 'env', provider: 'default', id: 'GITHUB_TOKEN' },
      },
    },
    { ...nativeRuntime(), provider: { ...nativeRuntime().provider, api: 'invalid' } },
    { ...nativeRuntime(), provider: { ...nativeRuntime().provider, baseUrl: 'http://native.example/v1' } },
    {
      ...nativeRuntime(),
      provider: {
        ...nativeRuntime().provider,
        model: { ...nativeRuntime().provider.model, id: 'different' },
      },
    },
  ]) {
    assert.throws(() => nativeOpenClawOptions({
      storageRoot: directory, workdir, runtime,
    }), { message: 'OPENCLAW_NATIVE_RUNTIME_INVALID' })
  }
})

test('managed and native runtime boundaries reject every SecretRef form', (t) => {
  const { directory, workdir } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const references = [
    { source: 'env', provider: 'default', id: 'GITHUB_TOKEN' },
    { source: 'file', provider: 'default', id: '/tmp/secret' },
    { source: 'exec', provider: 'default', id: 'secret-command' },
    { source: 'env', id: 'GITHUB_TOKEN' },
    '$GITHUB_TOKEN',
    '${GITHUB_TOKEN}',
    'secretref-env:GITHUB_TOKEN',
    '__env__:GITHUB_TOKEN',
    'secretref-managed',
    'GITHUB_TOKEN',
    'AWS_PROFILE',
    'oauth:github',
    'custom-local',
    'gcp-vertex-credentials',
  ]

  for (const apiKey of references) {
    assert.throws(() => managedOpenClawOptions({
      storageRoot: directory,
      workdir,
      provider: provider(apiKey),
    }), { message: 'OPENCLAW_PROVIDER_INVALID' })
    assert.throws(() => nativeOpenClawOptions({
      storageRoot: directory,
      workdir,
      runtime: {
        ...nativeRuntime(),
        provider: { ...nativeRuntime().provider, apiKey },
      },
    }), { message: 'OPENCLAW_NATIVE_RUNTIME_INVALID' })
  }
})

test('runtime paths reject pre-existing symlinks without writing outside app storage', {
  skip: process.platform === 'win32',
}, (t) => {
  const { directory, workdir } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const sessionRef = 'agent:main:symlink-test'
  const scope = runtimeScope(sessionRef, workdir)

  for (const position of ['managed', 'scope', 'home', 'state']) {
    const storageRoot = path.join(directory, `storage-${position}`)
    const external = path.join(directory, `external-${position}`)
    const managed = path.join(storageRoot, 'openclaw-managed')
    const runtimeRoot = path.join(managed, scope)
    fs.mkdirSync(storageRoot)
    fs.mkdirSync(external)
    if (position !== 'managed') fs.mkdirSync(managed)
    if (['home', 'state'].includes(position)) fs.mkdirSync(runtimeRoot)
    if (position === 'state') fs.mkdirSync(path.join(runtimeRoot, 'home'))
    const target = {
      managed,
      scope: runtimeRoot,
      home: path.join(runtimeRoot, 'home'),
      state: path.join(runtimeRoot, 'state'),
    }[position]
    fs.symlinkSync(external, target, 'dir')

    assert.throws(() => managedOpenClawOptions({
      storageRoot,
      workdir,
      sessionRef,
      provider: provider(),
    }), { message: 'OPENCLAW_RUNTIME_UNSAFE_PATH' })
    assert.deepEqual(fs.readdirSync(external), [])
  }
})

test('runtime paths repair overly broad directory permissions', {
  skip: process.platform === 'win32',
}, (t) => {
  const { directory, workdir } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const storageRoot = path.join(directory, 'permission-storage')
  const sessionRef = 'agent:main:permission-test'
  const managed = path.join(storageRoot, 'openclaw-managed')
  const runtimeRoot = path.join(managed, runtimeScope(sessionRef, workdir))
  const directories = [managed, runtimeRoot, path.join(runtimeRoot, 'home'), path.join(runtimeRoot, 'state')]
  fs.mkdirSync(storageRoot)
  for (const target of directories) {
    fs.mkdirSync(target)
    fs.chmodSync(target, 0o777)
  }

  managedOpenClawOptions({ storageRoot, workdir, sessionRef, provider: provider() })

  for (const target of directories) {
    assert.equal(fs.statSync(target).mode & 0o777, 0o700)
  }
})

test('runtime config atomically replaces a matching-content symlink before execution', {
  skip: process.platform === 'win32',
}, (t) => {
  const { directory, workdir } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const input = {
    storageRoot: directory,
    workdir,
    sessionRef: 'agent:main:config-symlink-test',
    runtime: nativeRuntime(),
  }
  const initial = nativeOpenClawOptions(input)
  const expected = fs.readFileSync(initial.env.OPENCLAW_CONFIG_PATH, 'utf8')
  const external = path.join(directory, 'external-openclaw.json')
  fs.writeFileSync(external, expected)
  fs.rmSync(initial.env.OPENCLAW_CONFIG_PATH)
  fs.symlinkSync(external, initial.env.OPENCLAW_CONFIG_PATH)

  const repaired = nativeOpenClawOptions(input)

  assert.equal(fs.lstatSync(repaired.env.OPENCLAW_CONFIG_PATH).isSymbolicLink(), false)
  assert.equal(fs.statSync(repaired.env.OPENCLAW_CONFIG_PATH).mode & 0o777, 0o600)
  fs.writeFileSync(external, JSON.stringify({ tools: { allow: ['exec'] } }))
  const config = JSON.parse(fs.readFileSync(repaired.env.OPENCLAW_CONFIG_PATH, 'utf8'))
  assert.equal(config.tools.allow.includes('exec'), false)
  assert.equal(config.tools.deny.includes('exec'), true)
})

test('runtime config creation revalidates parent identities before writing', {
  skip: process.platform === 'win32',
}, (t) => {
  const { directory, workdir } = fixture()
  const external = path.join(directory, 'external-runtime')
  fs.mkdirSync(external)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const originalRealpath = fs.realpathSync
  let redirected = false
  fs.realpathSync = function guardedRealpath(filename, ...args) {
    const resolved = originalRealpath.call(this, filename, ...args)
    if (!redirected && path.basename(String(filename)) === 'state') {
      redirected = true
      const runtimeRoot = path.dirname(String(filename))
      fs.renameSync(runtimeRoot, `${runtimeRoot}.original`)
      fs.symlinkSync(external, runtimeRoot, 'dir')
    }
    return resolved
  }

  try {
    assert.throws(() => managedOpenClawOptions({
      storageRoot: directory,
      workdir,
      sessionRef: 'agent:main:runtime-parent-change',
      provider: provider(),
    }), { message: 'OPENCLAW_RUNTIME_UNSAFE_PATH' })
  } finally {
    fs.realpathSync = originalRealpath
  }
  assert.deepEqual(fs.readdirSync(external), [])
})

test('runtime guard rejects directory and config identity changes before execution', {
  skip: process.platform === 'win32',
}, (t) => {
  const { directory, workdir } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const directoryOptions = managedOpenClawOptions({
    storageRoot: directory,
    workdir,
    sessionRef: 'agent:main:runtime-directory-guard',
    provider: provider(),
  })
  const runtimeRoot = path.dirname(directoryOptions.env.OPENCLAW_CONFIG_PATH)
  const originalRuntimeRoot = `${runtimeRoot}.original`
  const external = path.join(directory, 'external-runtime-guard')
  fs.mkdirSync(external)
  fs.renameSync(runtimeRoot, originalRuntimeRoot)
  fs.symlinkSync(external, runtimeRoot, 'dir')

  assert.throws(() => validateOpenClawRuntimeGuard(
    directoryOptions.openClawRuntimeGuard,
    directoryOptions.env,
  ), { message: 'OPENCLAW_RUNTIME_UNSAFE_PATH' })

  const fileOptions = managedOpenClawOptions({
    storageRoot: directory,
    workdir,
    sessionRef: 'agent:main:runtime-file-guard',
    provider: provider(),
  })
  const configPath = fileOptions.env.OPENCLAW_CONFIG_PATH
  const contents = fs.readFileSync(configPath)
  fs.renameSync(configPath, `${configPath}.original`)
  fs.writeFileSync(configPath, contents, { mode: 0o600 })

  assert.throws(() => validateOpenClawRuntimeGuard(
    fileOptions.openClawRuntimeGuard,
    fileOptions.env,
  ), { message: 'OPENCLAW_RUNTIME_UNSAFE_PATH' })
})

test('runtime guard rejects in-place config and credential changes without exposing secret state', (t) => {
  const { directory, workdir } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const configOptions = managedOpenClawOptions({
    storageRoot: directory,
    workdir,
    sessionRef: 'agent:main:runtime-content-guard',
    provider: provider(),
  })
  const serializedGuard = JSON.stringify(configOptions.openClawRuntimeGuard)
  const credentialDigest = crypto.createHash('sha256')
    .update(configOptions.env.ROUNDRELAY_OPENCLAW_API_KEY)
    .digest('hex')
  assert.equal(serializedGuard.includes(configOptions.env.ROUNDRELAY_OPENCLAW_API_KEY), false)
  assert.equal(serializedGuard.includes(credentialDigest), false)

  const configPath = configOptions.env.OPENCLAW_CONFIG_PATH
  const originalIdentity = fs.statSync(configPath).ino
  const originalConfig = fs.readFileSync(configPath, 'utf8')
  fs.writeFileSync(configPath, originalConfig.replace('"read"', '"exec"'), { mode: 0o600 })
  assert.equal(fs.statSync(configPath).ino, originalIdentity)
  assert.throws(() => validateOpenClawRuntimeGuard(
    configOptions.openClawRuntimeGuard,
    configOptions.env,
  ), { message: 'OPENCLAW_RUNTIME_UNSAFE_PATH' })

  const credentialOptions = managedOpenClawOptions({
    storageRoot: directory,
    workdir,
    sessionRef: 'agent:main:runtime-credential-guard',
    provider: provider(),
  })
  assert.throws(() => validateOpenClawRuntimeGuard(
    credentialOptions.openClawRuntimeGuard,
    {
      ...credentialOptions.env,
      ROUNDRELAY_OPENCLAW_API_KEY: 'tampered-openclaw-key',
    },
  ), { message: 'OPENCLAW_RUNTIME_CREDENTIAL_SCOPE_INVALID' })
})

test('runtime guard rejects permissions broadened after creation', {
  skip: process.platform === 'win32',
}, (t) => {
  const { directory, workdir } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  for (const target of ['directory', 'config']) {
    const options = managedOpenClawOptions({
      storageRoot: directory,
      workdir,
      sessionRef: `agent:main:runtime-${target}-permission-guard`,
      provider: provider(),
    })
    fs.chmodSync(
      target === 'directory' ? options.env.OPENCLAW_HOME : options.env.OPENCLAW_CONFIG_PATH,
      target === 'directory' ? 0o755 : 0o644,
    )
    assert.throws(() => validateOpenClawRuntimeGuard(
      options.openClawRuntimeGuard,
      options.env,
    ), { message: 'OPENCLAW_RUNTIME_UNSAFE_PATH' })
  }
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
