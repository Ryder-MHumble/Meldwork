const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const {
  knowledgeBaseSelectionHint,
  resolveKnowledgeBaseSources,
} = require('../../src/knowledge/local-knowledge-base.cjs')

const MOCK_BIN = '/mock/bin'
const MOCK_HOME = '/mock/home'

function missingPath(filename) {
  return Object.assign(new Error(`Missing path: ${filename}`), { code: 'ENOENT' })
}

function probeOptions({
  commands = [], existingPaths = [], execFileFn, storeState = {}, vault = null,
} = {}) {
  const commandPaths = new Set(commands.map(command => path.posix.join(MOCK_BIN, command)))
  const accessiblePaths = new Set(existingPaths)
  const vaultPath = String(vault?.path || storeState.obsidianVaultPath || '')
  return {
    platform: 'darwin',
    home: MOCK_HOME,
    env: { PATH: MOCK_BIN },
    readdirFn: () => [],
    store: {
      state: () => ({
        ...storeState,
        obsidianVaultPath: vaultPath,
      }),
    },
    accessFn: async (filename, mode = fs.constants.F_OK) => {
      if (commandPaths.has(filename) || accessiblePaths.has(filename)) return
      if (vaultPath && filename === vaultPath && vault?.exists) {
        if (mode === fs.constants.R_OK && !vault.readable) throw missingPath(filename)
        if (mode === fs.constants.W_OK && !vault.writable) throw missingPath(filename)
        return
      }
      throw missingPath(filename)
    },
    statFn: async (filename) => {
      if (!vaultPath || filename !== vaultPath || !vault?.exists) throw missingPath(filename)
      return { isDirectory: () => Boolean(vault.directory) }
    },
    execFileFn: execFileFn || (async () => ({ stdout: '', stderr: '' })),
  }
}

function sourceByKind(sources, kind) {
  const source = sources.find(item => item.kind === kind)
  assert.ok(source, `Expected ${kind} knowledge source`)
  return source
}

test('knowledge base mentions expose only validated read access details', () => {
  assert.deepEqual(knowledgeBaseSelectionHint({
    kind: 'dingtalk',
    label: '钉钉文档',
    accessMode: 'cli',
    installed: true,
    loginState: 'ready',
    permissionState: 'ready',
    readable: true,
    probeState: 'ready',
    commandName: 'dws',
  }, ['codex', 'hermes']), {
    kind: 'dingtalk',
    name: '钉钉文档',
    accessMode: 'cli',
    commandName: 'dws',
    targetKinds: ['codex', 'hermes'],
  })
  assert.deepEqual(knowledgeBaseSelectionHint({
    kind: 'obsidian',
    label: 'Obsidian',
    accessMode: 'vault',
    installed: true,
    configured: true,
    readable: true,
    probeState: 'ready',
    vaultPath: '/mock/home/Notes',
  }, ['codex']), {
    kind: 'obsidian',
    name: 'Obsidian',
    accessMode: 'vault',
    location: '/mock/home/Notes',
    targetKinds: ['codex'],
  })
  assert.equal(knowledgeBaseSelectionHint({
    kind: 'dingtalk',
    accessMode: 'cli',
    installed: true,
    loginState: 'ready',
    permissionState: 'needs-grant',
    readable: false,
    probeState: 'ready',
    commandName: 'dws',
  }, ['codex']), null)
})

test('Feishu reports an installed CLI separately from a missing user login', async () => {
  const calls = []
  const sources = await resolveKnowledgeBaseSources(probeOptions({
    commands: ['lark-cli'],
    execFileFn: async (command, args) => {
      calls.push({ command, args })
      return {
        stdout: JSON.stringify({
          identities: {
            bot: { status: 'ready' },
            user: { status: 'missing' },
          },
        }),
        stderr: '',
      }
    },
  }))

  const feishu = sourceByKind(sources, 'feishu')
  assert.equal(feishu.installed, true)
  assert.equal(feishu.configured, false)
  assert.equal(feishu.connected, false)
  assert.equal(feishu.loginState, 'missing')
  assert.equal(feishu.permissionState, 'unknown')
  assert.equal(feishu.readable, false)
  assert.equal(feishu.writable, false)
  assert.equal(feishu.ready, false)
  assert.deepEqual(calls, [{
    command: path.posix.join(MOCK_BIN, 'lark-cli'),
    args: ['auth', 'status'],
  }])
})

test('DingTalk readiness verifies document access after login', async () => {
  const calls = []
  const sources = await resolveKnowledgeBaseSources(probeOptions({
    commands: ['dws'],
    execFileFn: async (command, args) => {
      calls.push({ command, args })
      if (args[0] === 'auth') return { stdout: JSON.stringify({ authenticated: true }) }
      return { stdout: JSON.stringify({ success: false, permission_granted: false }) }
    },
  }))

  const dingtalk = sourceByKind(sources, 'dingtalk')
  assert.equal(dingtalk.installed, true)
  assert.equal(dingtalk.configured, true)
  assert.equal(dingtalk.connected, true)
  assert.equal(dingtalk.loginState, 'ready')
  assert.equal(dingtalk.permissionState, 'needs-grant')
  assert.equal(dingtalk.readable, false)
  assert.equal(dingtalk.writable, false)
  assert.equal(dingtalk.ready, false)
  assert.deepEqual(calls, [
    {
      command: path.posix.join(MOCK_BIN, 'dws'),
      args: ['auth', 'status'],
    },
    {
      command: path.posix.join(MOCK_BIN, 'dws'),
      args: ['doc', 'list', '--page-size', '1'],
    },
  ])
})

test('explicit authentication failures override a generic successful result', async () => {
  const sources = await resolveKnowledgeBaseSources(probeOptions({
    commands: ['dws'],
    execFileFn: async () => ({
      stdout: JSON.stringify({ ok: true, authenticated: false, token_valid: false }),
    }),
  }))

  const dingtalk = sourceByKind(sources, 'dingtalk')
  assert.equal(dingtalk.loginState, 'missing')
  assert.equal(dingtalk.configured, false)
  assert.equal(dingtalk.connected, false)
  assert.equal(dingtalk.readable, false)
  assert.equal(dingtalk.writable, false)
  assert.equal(dingtalk.ready, false)
})

test('stderr warnings cannot overturn explicit negative authentication or permission JSON', async () => {
  const sources = await resolveKnowledgeBaseSources(probeOptions({
    commands: ['lark-cli', 'dws'],
    execFileFn: async (command, args) => {
      if (command.endsWith('/lark-cli')) {
        return {
          stdout: JSON.stringify({ ok: true, authenticated: false }),
          stderr: 'Warning: authenticated account metadata is stale.',
        }
      }
      if (args[0] === 'auth') {
        return {
          stdout: JSON.stringify({ authenticated: true }),
          stderr: 'Warning: authenticated cache entry is stale.',
        }
      }
      return {
        stdout: JSON.stringify({ permission_granted: false }),
        stderr: 'Warning: permission granted cache entry is stale.',
      }
    },
  }))

  const feishu = sourceByKind(sources, 'feishu')
  assert.equal(feishu.loginState, 'missing')
  assert.equal(feishu.configured, false)
  assert.equal(feishu.ready, false)

  const dingtalk = sourceByKind(sources, 'dingtalk')
  assert.equal(dingtalk.loginState, 'ready')
  assert.equal(dingtalk.permissionState, 'needs-grant')
  assert.equal(dingtalk.readable, false)
  assert.equal(dingtalk.writable, false)
  assert.equal(dingtalk.ready, false)
})

test('an explicit denied permission alias overrides unknown and successful aliases', async () => {
  const sources = await resolveKnowledgeBaseSources(probeOptions({
    commands: ['dws'],
    execFileFn: async (command, args) => {
      if (args[0] === 'auth') return { stdout: JSON.stringify({ authenticated: true }) }
      return {
        stdout: JSON.stringify({
          success: true,
          permissionState: 'unknown',
          scope: { status: 'denied' },
        }),
      }
    },
  }))

  const dingtalk = sourceByKind(sources, 'dingtalk')
  assert.equal(dingtalk.permissionState, 'needs-grant')
  assert.equal(dingtalk.connected, true)
  assert.equal(dingtalk.readable, false)
  assert.equal(dingtalk.writable, false)
  assert.equal(dingtalk.probeState, 'ready')
  assert.equal(dingtalk.errorCode, '')
  assert.equal(dingtalk.ready, false)
})

test('exit-zero unsuccessful permission JSON remains an execution error', async () => {
  const sources = await resolveKnowledgeBaseSources(probeOptions({
    commands: ['dws'],
    execFileFn: async (command, args) => {
      if (args[0] === 'auth') return { stdout: JSON.stringify({ authenticated: true }) }
      return {
        stdout: JSON.stringify({ success: false, error: 'upstream unavailable' }),
      }
    },
  }))

  const dingtalk = sourceByKind(sources, 'dingtalk')
  assert.equal(dingtalk.permissionState, 'unknown')
  assert.equal(dingtalk.configured, true)
  assert.equal(dingtalk.connected, false)
  assert.equal(dingtalk.readable, false)
  assert.equal(dingtalk.writable, false)
  assert.equal(dingtalk.probeState, 'error')
  assert.equal(dingtalk.errorCode, 'PROBE_REPORTED_FAILURE')
  assert.equal(dingtalk.ready, false)
})

test('an error probe cannot produce a ready CLI DTO', async () => {
  const sources = await resolveKnowledgeBaseSources(probeOptions({
    commands: ['dws'],
    execFileFn: async (command, args) => {
      if (args[0] === 'auth') {
        throw Object.assign(new Error('Unexpected auth exit'), {
          code: 1,
          stdout: JSON.stringify({ authenticated: true }),
        })
      }
      return { stdout: JSON.stringify({ success: true }) }
    },
  }))

  const dingtalk = sourceByKind(sources, 'dingtalk')
  assert.equal(dingtalk.loginState, 'ready')
  assert.equal(dingtalk.permissionState, 'ready')
  assert.equal(dingtalk.configured, true)
  assert.equal(dingtalk.connected, false)
  assert.equal(dingtalk.readable, false)
  assert.equal(dingtalk.writable, false)
  assert.equal(dingtalk.probeState, 'error')
  assert.equal(dingtalk.ready, false)
})

test('classified CLI authentication and permission failures are not probe errors', async () => {
  const sources = await resolveKnowledgeBaseSources(probeOptions({
    commands: ['lark-cli', 'dws'],
    execFileFn: async (command, args) => {
      if (command.endsWith('/lark-cli')) {
        throw Object.assign(new Error('Login required'), {
          code: 1,
          stderr: 'Not logged in. Please login.',
        })
      }
      if (args[0] === 'auth') return { stdout: JSON.stringify({ authenticated: true }) }
      throw Object.assign(new Error('Permission required'), {
        code: 1,
        stderr: 'Permission denied: required document scope is missing.',
      })
    },
  }))

  const feishu = sourceByKind(sources, 'feishu')
  assert.equal(feishu.loginState, 'missing')
  assert.equal(feishu.configured, false)
  assert.equal(feishu.connected, false)
  assert.equal(feishu.probeState, 'ready')
  assert.equal(feishu.errorCode, '')

  const dingtalk = sourceByKind(sources, 'dingtalk')
  assert.equal(dingtalk.loginState, 'ready')
  assert.equal(dingtalk.permissionState, 'needs-grant')
  assert.equal(dingtalk.configured, true)
  assert.equal(dingtalk.connected, true)
  assert.equal(dingtalk.readable, false)
  assert.equal(dingtalk.writable, false)
  assert.equal(dingtalk.probeState, 'ready')
  assert.equal(dingtalk.errorCode, '')
})

test('Obsidian is ready only when its Vault is a readable and writable directory', async () => {
  const cases = [
    {
      name: 'missing',
      vault: { path: '/vault/missing', exists: false },
      details: { exists: false, directory: false, readable: false, writable: false },
      state: { configured: false, connected: false, readable: false, writable: false },
      ready: false,
    },
    {
      name: 'not a directory',
      vault: {
        path: '/vault/file', exists: true, directory: false, readable: true, writable: true,
      },
      details: { exists: true, directory: false, readable: false, writable: false },
      state: { configured: false, connected: false, readable: false, writable: false },
      ready: false,
    },
    {
      name: 'not readable',
      vault: {
        path: '/vault/unreadable', exists: true, directory: true, readable: false, writable: true,
      },
      details: { exists: true, directory: true, readable: false, writable: true },
      state: { configured: true, connected: true, readable: false, writable: true },
      ready: false,
    },
    {
      name: 'not writable',
      vault: {
        path: '/vault/read-only', exists: true, directory: true, readable: true, writable: false,
      },
      details: { exists: true, directory: true, readable: true, writable: false },
      state: { configured: true, connected: true, readable: true, writable: false },
      ready: false,
    },
    {
      name: 'usable',
      vault: {
        path: '/vault/usable', exists: true, directory: true, readable: true, writable: true,
      },
      details: { exists: true, directory: true, readable: true, writable: true },
      state: { configured: true, connected: true, readable: true, writable: true },
      ready: true,
    },
  ]

  for (const fixture of cases) {
    const sources = await resolveKnowledgeBaseSources(probeOptions({
      commands: ['obsidian'],
      vault: fixture.vault,
      execFileFn: async () => ({ stdout: '1.8.10', stderr: '' }),
    }))
    const obsidian = sourceByKind(sources, 'obsidian')
    assert.deepEqual(obsidian.vaultDetails, fixture.details, fixture.name)
    assert.deepEqual({
      configured: obsidian.configured,
      connected: obsidian.connected,
      readable: obsidian.readable,
      writable: obsidian.writable,
    }, fixture.state, fixture.name)
    assert.equal(obsidian.ready, fixture.ready, fixture.name)
  }
})

test('Obsidian falls back to the desktop app when an installed CLI cannot run', async () => {
  const failingVersionProbe = async () => {
    throw Object.assign(new Error('Broken Obsidian CLI'), {
      code: 'EIO',
      stderr: 'Broken Obsidian CLI',
    })
  }
  const withApp = await resolveKnowledgeBaseSources(probeOptions({
    commands: ['obsidian'],
    existingPaths: ['/Applications/Obsidian.app'],
    execFileFn: failingVersionProbe,
  }))
  const withoutApp = await resolveKnowledgeBaseSources(probeOptions({
    commands: ['obsidian'],
    execFileFn: failingVersionProbe,
  }))

  const installed = sourceByKind(withApp, 'obsidian')
  assert.equal(installed.installed, true)
  assert.equal(installed.probeState, 'ready')
  assert.equal(installed.errorCode, '')

  const unavailable = sourceByKind(withoutApp, 'obsidian')
  assert.equal(unavailable.installed, false)
  assert.equal(unavailable.probeState, 'error')
  assert.equal(unavailable.errorCode, 'EIO')
})

test('a failed source probe does not mark other knowledge sources unavailable', async () => {
  const sources = await resolveKnowledgeBaseSources(probeOptions({
    commands: ['lark-cli', 'dws'],
    execFileFn: async (command, args) => {
      if (command.endsWith('/lark-cli')) {
        throw Object.assign(new Error(`Failed to run ${command}`), {
          stderr: 'Feishu probe failed',
        })
      }
      if (args[0] === 'auth') return { stdout: JSON.stringify({ authenticated: true }) }
      return { stdout: JSON.stringify({ success: true }) }
    },
  }))

  const feishu = sourceByKind(sources, 'feishu')
  assert.equal(feishu.installed, true)
  assert.equal(feishu.probeState, 'error')
  assert.equal(feishu.errorCode, 'PROBE_FAILED')
  assert.equal(feishu.ready, false)
  assert.equal(JSON.stringify(feishu).includes(MOCK_BIN), false)

  const dingtalk = sourceByKind(sources, 'dingtalk')
  assert.equal(dingtalk.installed, true)
  assert.equal(dingtalk.probeState, 'ready')
  assert.equal(dingtalk.loginState, 'ready')
  assert.equal(dingtalk.permissionState, 'ready')
  assert.equal(dingtalk.configured, true)
  assert.equal(dingtalk.connected, true)
  assert.equal(dingtalk.readable, true)
  assert.equal(dingtalk.writable, false)
  assert.equal(dingtalk.ready, true)
})

test('knowledge source DTOs never expose executable or command paths', async () => {
  const sources = await resolveKnowledgeBaseSources(probeOptions({
    commands: ['lark-cli', 'dws', 'obsidian'],
    vault: {
      path: '/vault/usable', exists: true, directory: true, readable: true, writable: true,
    },
    execFileFn: async (command, args) => {
      if (command.endsWith('/obsidian')) return { stdout: '1.8.10', stderr: '' }
      if (args[0] === 'auth') return { stdout: JSON.stringify({ authenticated: true }) }
      return { stdout: JSON.stringify({ success: true }) }
    },
  }))

  for (const source of sources) {
    assert.equal(Object.hasOwn(source, 'executable'), false)
    assert.equal(Object.hasOwn(source, 'commandPath'), false)
    assert.equal(Object.hasOwn(source, 'appPath'), false)
    assert.equal(Object.hasOwn(source, 'commandCandidates'), false)
    assert.equal(Object.hasOwn(source, 'appCandidates'), false)
    assert.equal(Object.hasOwn(source, 'installUrl'), false)
    assert.equal(Object.hasOwn(source, 'loginUrl'), false)
    assert.equal(Object.hasOwn(source, 'permissionUrl'), false)
  }
  assert.equal(JSON.stringify(sources).includes(MOCK_BIN), false)
  const feishu = sourceByKind(sources, 'feishu')
  assert.equal(feishu.commandName, 'lark-cli')
  assert.equal(feishu.installCommand, 'npm install -g @larksuite/cli@latest')
  assert.equal(feishu.loginCommand, 'lark-cli auth login')
  assert.equal(feishu.statusCommand, 'lark-cli auth status')
  assert.equal(feishu.permissionCommand, 'lark-cli docs +search --query . --page-size 1 --as user')

  const dingtalk = sourceByKind(sources, 'dingtalk')
  assert.equal(dingtalk.commandName, 'dws')
  assert.equal(dingtalk.installCommand, 'npm install -g dingtalk-workspace-cli --registry=https://registry.npmmirror.com')
  assert.equal(dingtalk.loginCommand, 'dws auth login')
  assert.equal(dingtalk.statusCommand, 'dws auth status')
  assert.equal(dingtalk.permissionCommand, 'dws doc list --page-size 1')
})

test('knowledge probes receive only the minimal system environment', async () => {
  const childEnvironments = []
  const options = probeOptions({
    commands: ['lark-cli'],
    execFileFn: async (command, args, execOptions) => {
      childEnvironments.push(execOptions.env)
      if (args[0] === 'auth') return { stdout: JSON.stringify({ authenticated: true }) }
      return { stdout: JSON.stringify({ success: true }) }
    },
  })
  options.env = {
    PATH: MOCK_BIN,
    HOME: MOCK_HOME,
    LANG: 'en_US.UTF-8',
    OPENAI_API_KEY: 'must-not-reach-probe',
    MELDWORK_PRIVATE_VALUE: 'must-not-reach-probe',
  }

  const sources = await resolveKnowledgeBaseSources(options)

  assert.equal(sourceByKind(sources, 'feishu').ready, true)
  assert.equal(childEnvironments.length, 2)
  for (const childEnv of childEnvironments) {
    assert.equal(childEnv.HOME, MOCK_HOME)
    assert.equal(childEnv.LANG, 'en_US.UTF-8')
    assert.match(childEnv.PATH, new RegExp(`(?:^|:)${MOCK_BIN}(?::|$)`))
    assert.equal(Object.hasOwn(childEnv, 'OPENAI_API_KEY'), false)
    assert.equal(Object.hasOwn(childEnv, 'MELDWORK_PRIVATE_VALUE'), false)
  }
})

test('source resolution failures expose stable codes without raw error messages', async () => {
  let storeReads = 0
  const options = probeOptions()
  options.store = {
    state: () => {
      storeReads += 1
      if (storeReads === 2) throw new Error('private configuration path must stay local')
      return { obsidianVaultPath: '' }
    },
  }

  const sources = await resolveKnowledgeBaseSources(options)
  const notion = sourceByKind(sources, 'notion')

  assert.equal(notion.probeState, 'error')
  assert.equal(notion.errorCode, 'PROBE_FAILED')
  assert.equal(JSON.stringify(sources).includes('private configuration path'), false)
})
