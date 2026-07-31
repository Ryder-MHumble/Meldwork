const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { resolveKnowledgeBaseSources } = require('../src/local-knowledge-base.cjs')

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
  assert.equal(feishu.loginState, 'missing')
  assert.equal(feishu.permissionState, 'unknown')
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
      return { stdout: JSON.stringify({ success: false }) }
    },
  }))

  const dingtalk = sourceByKind(sources, 'dingtalk')
  assert.equal(dingtalk.installed, true)
  assert.equal(dingtalk.loginState, 'ready')
  assert.equal(dingtalk.permissionState, 'needs-grant')
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
  assert.equal(feishu.probeState, 'ready')
  assert.equal(feishu.errorCode, '')

  const dingtalk = sourceByKind(sources, 'dingtalk')
  assert.equal(dingtalk.loginState, 'ready')
  assert.equal(dingtalk.permissionState, 'needs-grant')
  assert.equal(dingtalk.probeState, 'ready')
  assert.equal(dingtalk.errorCode, '')
})

test('Obsidian is ready only when its Vault is a readable and writable directory', async () => {
  const cases = [
    {
      name: 'missing',
      vault: { path: '/vault/missing', exists: false },
      details: { exists: false, directory: false, readable: false, writable: false },
      ready: false,
    },
    {
      name: 'not a directory',
      vault: {
        path: '/vault/file', exists: true, directory: false, readable: true, writable: true,
      },
      details: { exists: true, directory: false, readable: false, writable: false },
      ready: false,
    },
    {
      name: 'not readable',
      vault: {
        path: '/vault/unreadable', exists: true, directory: true, readable: false, writable: true,
      },
      details: { exists: true, directory: true, readable: false, writable: true },
      ready: false,
    },
    {
      name: 'not writable',
      vault: {
        path: '/vault/read-only', exists: true, directory: true, readable: true, writable: false,
      },
      details: { exists: true, directory: true, readable: true, writable: false },
      ready: false,
    },
    {
      name: 'usable',
      vault: {
        path: '/vault/usable', exists: true, directory: true, readable: true, writable: true,
      },
      details: { exists: true, directory: true, readable: true, writable: true },
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
  }
  assert.equal(JSON.stringify(sources).includes(MOCK_BIN), false)
})
