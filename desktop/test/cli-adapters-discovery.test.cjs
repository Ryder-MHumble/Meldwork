const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const {
  detectAgents,
  imageAttachmentLimit,
  invocation,
  normalizeOutput,
  parseCodexOutput,
  parseGeminiOutput,
  parseKimiOutput,
  parseMimoOutput,
  parseOpenCodeOutput,
  parseWorkBuddyOutput,
  prepareCommand,
  readHermesFinalResponse,
  readHermesMessageWatermark,
  resolveExecutable,
  runAgent,
  runtimeCommandSummary,
  searchPath,
} = require('../src/cli-adapters.cjs')
const {
  executable,
  readJsonWhenReady,
  readWhenReady,
  waitForExit,
  within,
} = require('./cli-adapters-test-helpers.cjs')

test('search path includes common user CLI locations', () => {
  assert.match(searchPath(), /\.local\/bin/)
  assert.match(searchPath(), /\.kimi-code\/bin/)
  assert.match(searchPath(), /\.mimocode\/bin/)
})

test('Agent discovery scans independent Agent kinds concurrently', async () => {
  const started = []
  let release
  const gate = new Promise(resolve => { release = resolve })
  const detection = detectAgents({
    platform: 'darwin',
    env: {},
    resolveExecutableFn: async (kind) => {
      started.push(kind)
      await gate
      return null
    },
  })

  await new Promise(resolve => setImmediate(resolve))
  const startedBeforeRelease = started.length
  release()
  assert.deepEqual(await detection, [])
  assert.equal(startedBeforeRelease, 11)
})

test('Hermes capability and ACP checks run concurrently without changing the result', async () => {
  let active = 0
  let maxActive = 0
  const started = []
  const found = await detectAgents({
    platform: 'darwin',
    env: {},
    resolveExecutableFn: async kind => kind === 'hermes' ? '/tmp/hermes' : null,
    execFileFn: async (_command, args) => {
      if (args[0] === '--version') return { stdout: 'Hermes 0.19.1\n', stderr: '' }
      started.push(args.join(' '))
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 12))
      active -= 1
      if (args[0] === 'chat') {
        return {
          stdout: '--quiet --query --provider --model --resume --image --yolo',
          stderr: '',
        }
      }
      return { stdout: '', stderr: '' }
    },
  })

  assert.equal(maxActive, 2)
  assert.deepEqual(started.sort(), ['acp --check', 'chat --help'])
  assert.equal(found[0].compatibilityState, 'compatible')
  assert.equal(found[0].acpAvailable, true)
})

test('Agent version gates capability checks while keeping compatible probes parallel', async () => {
  let releaseVersion
  let releaseCapability
  const versionGate = new Promise(resolve => { releaseVersion = resolve })
  const capabilityGate = new Promise(resolve => { releaseCapability = resolve })
  const started = []
  const detection = detectAgents({
    platform: 'darwin',
    env: {},
    resolveExecutableFn: async kind => kind === 'kimi' ? '/tmp/kimi' : null,
    probeAgentCapabilitiesFn: async () => {
      started.push('capability')
      await capabilityGate
      return {
        compatibilityState: 'compatible',
        incompatibilityReason: '',
        incompatibilityProbe: '',
      }
    },
    execFileFn: async (_command, args) => {
      if (args[0] === '--version') {
        started.push('version')
        await versionGate
        return { stdout: 'Kimi Code 0.19.2\n', stderr: '' }
      }
      throw new Error('unexpected probe')
    },
  })

  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(started, ['version'])
  releaseVersion()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(started, ['version', 'capability'])
  releaseCapability()
  const [found] = await detection
  assert.equal(found.kind, 'kimi')
  assert.equal(found.compatibilityState, 'compatible')
})

test('macOS Finder cold starts include common Node version manager paths', () => {
  const roots = {
    '/Users/Ryder/.nvm/versions/node': ['v20.12.0', 'v22.5.1'],
    '/Users/Ryder/.local/share/fnm/node-versions': ['v21.1.0'],
    '/Users/Ryder/Library/Application Support/fnm/node-versions': ['v22.4.0'],
  }
  const value = searchPath({
    platform: 'darwin',
    home: '/Users/Ryder',
    env: {
      PATH: '/usr/bin:/bin',
      PNPM_HOME: '/Users/Ryder/Custom/pnpm',
      FNM_MULTISHELL_PATH: '/Users/Ryder/Library/Application Support/fnm/session',
      NVM_BIN: '/Users/Ryder/.nvm/versions/node/v23.0.0/bin',
      BUN_INSTALL: '/Users/Ryder/.custom-bun',
      ASDF_DATA_DIR: '/Users/Ryder/.custom-asdf',
      MISE_DATA_DIR: '/Users/Ryder/.custom-mise',
      NODENV_ROOT: '/Users/Ryder/.custom-nodenv',
    },
    readdirFn: root => (roots[root] || []).map(name => ({
      name,
      isDirectory: () => true,
      isSymbolicLink: () => false,
    })),
  }).split(':')

  assert.ok(value.includes('/Users/Ryder/.volta/bin'))
  assert.ok(value.includes('/Users/Ryder/Custom/pnpm'))
  assert.ok(value.includes('/Users/Ryder/Library/pnpm'))
  assert.ok(value.includes('/Users/Ryder/.local/share/pnpm'))
  assert.ok(value.includes('/Users/Ryder/.nvm/versions/node/v23.0.0/bin'))
  assert.ok(value.includes('/Users/Ryder/.nvm/versions/node/v22.5.1/bin'))
  assert.ok(value.includes('/Users/Ryder/.nvm/versions/node/v20.12.0/bin'))
  assert.ok(value.indexOf('/Users/Ryder/.nvm/versions/node/v22.5.1/bin')
    < value.indexOf('/Users/Ryder/.nvm/versions/node/v20.12.0/bin'))
  assert.ok(value.includes('/Users/Ryder/Library/Application Support/fnm/session/bin'))
  assert.ok(value.includes('/Users/Ryder/.local/share/fnm/aliases/default/bin'))
  assert.ok(value.includes('/Users/Ryder/.local/share/fnm/node-versions/v21.1.0/installation/bin'))
  assert.ok(value.includes('/Users/Ryder/Library/Application Support/fnm/node-versions/v22.4.0/installation/bin'))
  assert.ok(value.includes('/Users/Ryder/.asdf/shims'))
  assert.ok(value.includes('/Users/Ryder/.custom-asdf/shims'))
  assert.ok(value.includes('/Users/Ryder/.local/share/mise/shims'))
  assert.ok(value.includes('/Users/Ryder/.custom-mise/shims'))
  assert.ok(value.includes('/Users/Ryder/.nodenv/shims'))
  assert.ok(value.includes('/Users/Ryder/.custom-nodenv/shims'))
  assert.ok(value.includes('/Users/Ryder/.bun/bin'))
  assert.ok(value.includes('/Users/Ryder/.custom-bun/bin'))
})

test('Windows search path includes npm, app, and user CLI locations', () => {
  const value = searchPath({
    platform: 'win32',
    home: 'C:\\Users\\Ryder',
    env: {
      Path: 'C:\\Tools;C:\\Windows\\System32',
      APPDATA: 'C:\\Users\\Ryder\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\Ryder\\AppData\\Local',
      PNPM_HOME: 'D:\\Tools\\pnpm',
      NVM_HOME: 'D:\\Tools\\nvm',
      NVM_SYMLINK: 'D:\\Tools\\nodejs',
      ProgramFiles: 'C:\\Program Files',
      ProgramData: 'C:\\ProgramData',
    },
  }).split(';')

  assert.ok(value.includes('C:\\Users\\Ryder\\AppData\\Roaming\\npm'))
  assert.ok(value.includes('D:\\Tools\\pnpm'))
  assert.ok(value.includes('C:\\Users\\Ryder\\AppData\\Local\\pnpm'))
  assert.ok(value.includes('C:\\Users\\Ryder\\AppData\\Local\\Microsoft\\WindowsApps'))
  assert.ok(value.includes('C:\\Users\\Ryder\\AppData\\Local\\Programs\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin'))
  assert.ok(value.includes('C:\\Users\\Ryder\\.kimi-code\\bin'))
  assert.ok(value.includes('D:\\Tools\\nvm'))
  assert.ok(value.includes('D:\\Tools\\nodejs'))
  assert.ok(value.includes('C:\\Program Files\\nodejs'))
  assert.ok(value.includes('C:\\ProgramData\\chocolatey\\bin'))
})

test('Windows executable resolution honors PATHEXT', async () => {
  const expected = 'C:\\Tools\\codex.CMD'
  const executable = await resolveExecutable('codex', {
    platform: 'win32',
    home: 'C:\\Users\\Ryder',
    env: {
      Path: 'C:\\Tools',
      PATHEXT: '.EXE;.CMD',
    },
    accessFn: async (candidate) => {
      if (candidate !== expected) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    },
    execFileFn: async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    },
  })

  assert.equal(executable, expected)
})

test('Windows executable resolution falls back to where.exe', async () => {
  const expected = 'D:\\Agent Tools\\qwen.cmd'
  const executable = await resolveExecutable('qwen', {
    platform: 'win32',
    home: 'C:\\Users\\Ryder',
    env: {
      Path: 'C:\\Windows\\System32',
      PATHEXT: '.EXE;.CMD',
    },
    accessFn: async (candidate) => {
      if (candidate !== expected) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    },
    execFileFn: async (command, args) => {
      assert.equal(command, 'where.exe')
      assert.deepEqual(args, ['qwen'])
      return { stdout: `${expected}\r\n`, stderr: '' }
    },
  })

  assert.equal(executable, expected)
})

test('Linux executable resolution uses an allowlisted environment in the fallback shell', async () => {
  const expected = '/opt/agents/kimi'
  const executable = await resolveExecutable('kimi', {
    platform: 'linux',
    home: '/home/ryder',
    env: {
      HOME: '/home/ryder',
      LANG: 'zh_CN.UTF-8',
      PATH: '/usr/bin:/bin',
      ROUNDRELAY_PRIVATE_VALUE: 'desktop-private-value',
      OPENAI_API_KEY: 'provider-secret',
    },
    accessFn: async (candidate) => {
      if (candidate !== expected) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    },
    execFileFn: async (command, args, options) => {
      assert.equal(command, '/bin/sh')
      assert.deepEqual(args, ['-lc', 'command -v -- kimi'])
      assert.equal(options.env.HOME, '/home/ryder')
      assert.equal(options.env.LANG, 'zh_CN.UTF-8')
      assert.match(options.env.PATH, /\/usr\/bin:\/bin/)
      assert.equal(options.env.ROUNDRELAY_PRIVATE_VALUE, undefined)
      assert.equal(options.env.OPENAI_API_KEY, undefined)
      return { stdout: `${expected}\n`, stderr: '' }
    },
  })

  assert.equal(executable, expected)
})

test('macOS WorkBuddy detection keeps the application-bundled CLI path', async () => {
  const expected = '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy'
  const executable = await resolveExecutable('workbuddy', {
    platform: 'darwin',
    home: '/Users/ryder',
    env: { PATH: '' },
    accessFn: async (candidate) => {
      if (candidate !== expected) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    },
    execFileFn: async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    },
  })

  assert.equal(executable, expected)
})

test('macOS WorkBuddy detection also checks the per-user Applications folder', async () => {
  const expected = '/Users/ryder/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy'
  const executable = await resolveExecutable('workbuddy', {
    platform: 'darwin',
    home: '/Users/ryder',
    env: { PATH: '' },
    accessFn: async (candidate) => {
      if (candidate !== expected) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    },
    execFileFn: async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    },
  })

  assert.equal(executable, expected)
})

test('macOS Codex detection keeps the ChatGPT application-bundled CLI path', async () => {
  const expected = '/Applications/ChatGPT.app/Contents/Resources/codex'
  const executable = await resolveExecutable('codex', {
    platform: 'darwin',
    home: '/Users/ryder',
    env: { PATH: '' },
    accessFn: async (candidate) => {
      if (candidate !== expected) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    },
    execFileFn: async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    },
  })

  assert.equal(executable, expected)
})

test('macOS Codex detection also checks the per-user ChatGPT application', async () => {
  const expected = '/Users/ryder/Applications/ChatGPT.app/Contents/Resources/codex'
  const executable = await resolveExecutable('codex', {
    platform: 'darwin',
    home: '/Users/ryder',
    env: { PATH: '' },
    accessFn: async (candidate) => {
      if (candidate !== expected) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    },
    execFileFn: async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    },
  })

  assert.equal(executable, expected)
})

test('WorkBuddy detection does not mistake the generic cbc solver for WorkBuddy', async () => {
  const probed = []
  const lookups = []
  const executable = await resolveExecutable('workbuddy', {
    platform: 'darwin',
    home: '/Users/Ryder',
    env: { PATH: '/tools' },
    accessFn: async (candidate) => {
      probed.push(candidate)
      if (candidate === '/tools/cbc') return
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    },
    execFileFn: async (_command, args) => {
      lookups.push(args.at(-1))
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    },
  })

  assert.equal(executable, null)
  assert.equal(probed.includes('/tools/cbc'), false)
  assert.equal(lookups.some(value => value.includes('cbc')), false)
})

test('Windows npm command shims launch Node directly without reparsing prompt text', () => {
  const executable = 'C:\\Users\\Ryder\\AppData\\Roaming\\npm\\codex.cmd'
  const prompt = 'compare A & B, then echo %PATH% and !tokens!'
  const shim = [
    '@ECHO off',
    'SETLOCAL',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    ')',
    '"%_prog%" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
  ].join('\r\n')

  const spec = prepareCommand(executable, [prompt], {
    platform: 'win32',
    env: {},
    readFileFn: () => shim,
    existsFn: () => false,
  })

  assert.equal(spec.command, 'node.exe')
  assert.deepEqual(spec.args, [
    'C:\\Users\\Ryder\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js',
    prompt,
  ])
})

test('Windows WorkBuddy npm shims accept an extensionless node_modules target', () => {
  const executable = 'C:\\Users\\Ryder\\AppData\\Roaming\\npm\\codebuddy.cmd'
  const shim = [
    '@ECHO off',
    '"%dp0%\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy" %*',
  ].join('\r\n')

  const spec = prepareCommand(executable, ['hello'], {
    platform: 'win32',
    env: {},
    readFileFn: () => shim,
    existsFn: () => false,
  })

  assert.equal(spec.command, 'node.exe')
  assert.deepEqual(spec.args, [
    'C:\\Users\\Ryder\\AppData\\Roaming\\npm\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy',
    'hello',
  ])
})

test('Windows OpenCode npm shims launch the packaged native executable directly', () => {
  const executable = 'C:\\Users\\Ryder\\AppData\\Roaming\\npm\\opencode.cmd'
  const native = 'C:\\Users\\Ryder\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe'
  const shim = [
    '@ECHO off',
    '"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe" %*',
  ].join('\r\n')

  const spec = prepareCommand(executable, ['run', '--format', 'json'], {
    platform: 'win32',
    env: {},
    readFileFn: () => shim,
    existsFn: filename => filename === native,
  })

  assert.equal(spec.command, native)
  assert.deepEqual(spec.args, ['run', '--format', 'json'])
})

test('Windows extensionless npm shims reject traversal and non-node_modules targets', () => {
  const executable = 'C:\\Users\\Ryder\\AppData\\Roaming\\npm\\codebuddy.cmd'
  const options = {
    platform: 'win32',
    env: {},
    existsFn: () => false,
  }

  assert.throws(
    () => prepareCommand(executable, [], {
      ...options,
      readFileFn: () => '"%dp0%\\..\\outside\\node_modules\\codebuddy" %*',
    }),
    { message: 'LOCAL_CLI_WRAPPER_UNSUPPORTED' },
  )
  assert.throws(
    () => prepareCommand(executable, [], {
      ...options,
      readFileFn: () => '"%dp0%\\bin\\codebuddy" %*',
    }),
    { message: 'LOCAL_CLI_WRAPPER_UNSUPPORTED' },
  )
})

test('Windows Agent detection reads versions through the portable command launcher', async () => {
  const executable = 'C:\\Users\\Ryder\\AppData\\Roaming\\npm\\claude.cmd'
  const calls = []
  const found = await detectAgents({
    platform: 'win32',
    env: {},
    resolveExecutableFn: async kind => kind === 'claude' ? executable : null,
    prepareCommandFn: (command, args) => ({ command: 'node.exe', args: ['claude.js', ...args] }),
    execFileFn: async (command, args) => {
      calls.push({ command, args })
      return args.includes('--version')
        ? { stdout: '2.1.165\r\nbuild metadata\r\n', stderr: '' }
        : {
            stdout: [
              '--print', '--output-format', '--include-partial-messages', '--verbose',
              '--permission-mode', '--resume', 'stream-json', 'plan', 'acceptEdits',
            ].join(' '),
            stderr: '',
          }
    },
  })

  assert.deepEqual(calls, [
    { command: 'node.exe', args: ['claude.js', '--version'] },
    { command: 'node.exe', args: ['claude.js', '--help'] },
  ])
  assert.deepEqual(found, [{
    kind: 'claude',
    name: 'Claude CLI',
    executable,
    version: '2.1.165',
    resolvedVersion: '2.1.165',
    supportedVersionRange: '2.1.165..2.1.221',
    compatibilityState: 'compatible',
    incompatibilityReason: '',
    incompatibilityProbe: '',
  }])
})

test('Hermes detection records ACP availability when the capability check succeeds', async () => {
  const calls = []
  const found = await detectAgents({
    platform: 'darwin',
    env: {},
    resolveExecutableFn: async kind => kind === 'hermes' ? '/tmp/hermes' : null,
    execFileFn: async (_command, args) => {
      calls.push(args)
      if (args[0] === '--version') return { stdout: 'Hermes 0.19.1\n', stderr: '' }
      if (args[0] === 'chat') {
        return {
          stdout: [
            '--quiet', '--query', '--provider', '--model', '--resume',
            '--image', '--yolo',
          ].join(' '),
          stderr: '',
        }
      }
      assert.deepEqual(args, ['acp', '--check'])
      return { stdout: '', stderr: '' }
    },
  })

  assert.deepEqual(calls.map(args => args.join(' ')).sort(), [
    '--version', 'acp --check', 'chat --help',
  ])
  assert.deepEqual(found, [{
    kind: 'hermes',
    name: 'Hermes CLI',
    executable: '/tmp/hermes',
    version: 'Hermes 0.19.1',
    resolvedVersion: '0.19.1',
    supportedVersionRange: '0.19.1..0.20.0',
    compatibilityState: 'compatible',
    incompatibilityReason: '',
    incompatibilityProbe: '',
    acpAvailable: true,
  }])
})

test('Hermes detection records unavailable ACP when the capability check fails', async () => {
  const calls = []
  const found = await detectAgents({
    platform: 'darwin',
    env: {},
    resolveExecutableFn: async kind => kind === 'hermes' ? '/tmp/hermes' : null,
    execFileFn: async (_command, args) => {
      calls.push(args)
      if (args[0] === '--version') return { stdout: 'Hermes 0.19.1\n', stderr: '' }
      if (args[0] === 'chat') {
        return {
          stdout: [
            '--quiet', '--query', '--provider', '--model', '--resume',
            '--image', '--yolo',
          ].join(' '),
          stderr: '',
        }
      }
      assert.deepEqual(args, ['acp', '--check'])
      throw new Error('ACP unavailable')
    },
  })

  assert.deepEqual(calls.map(args => args.join(' ')).sort(), [
    '--version', 'acp --check', 'chat --help',
  ])
  assert.deepEqual(found, [{
    kind: 'hermes',
    name: 'Hermes CLI',
    executable: '/tmp/hermes',
    version: 'Hermes 0.19.1',
    resolvedVersion: '0.19.1',
    supportedVersionRange: '0.19.1..0.20.0',
    compatibilityState: 'compatible',
    incompatibilityReason: '',
    incompatibilityProbe: '',
    acpAvailable: false,
  }])
})

test('Agent detection ignores blank output and startup warnings before the version line', async () => {
  const found = await detectAgents({
    platform: 'darwin',
    env: {},
    resolveExecutableFn: async kind => kind === 'kimi' ? '/tmp/kimi' : null,
    probeAgentCapabilitiesFn: async () => ({
      compatibilityState: 'compatible',
      incompatibilityReason: '',
      incompatibilityProbe: '',
    }),
    execFileFn: async () => ({
      stdout: '  \n',
      stderr: 'experimental startup warning\nKimi Code 0.19.2\n',
    }),
  })

  assert.deepEqual(found, [{
    kind: 'kimi',
    name: 'Kimi CLI',
    executable: '/tmp/kimi',
    version: 'Kimi Code 0.19.2',
    resolvedVersion: '0.19.2',
    supportedVersionRange: '0.19.2..0.32.0',
    compatibilityState: 'compatible',
    incompatibilityReason: '',
    incompatibilityProbe: '',
  }])
})

test('Agent detection keeps unsupported versions installed but incompatible', async () => {
  let calls = 0
  const found = await detectAgents({
    platform: 'darwin',
    env: {},
    resolveExecutableFn: async kind => kind === 'codex' ? '/tmp/codex' : null,
    execFileFn: async () => {
      calls += 1
      return { stdout: 'codex-cli 0.147.0\n', stderr: '' }
    },
  })

  assert.equal(calls, 1)
  assert.deepEqual(found, [{
    kind: 'codex',
    name: 'Codex CLI',
    executable: '/tmp/codex',
    version: 'codex-cli 0.147.0',
    resolvedVersion: '0.147.0',
    supportedVersionRange: '0.137.0..0.146.0',
    compatibilityState: 'incompatible',
    incompatibilityReason: 'LOCAL_AGENT_VERSION_UNSUPPORTED',
    incompatibilityProbe: '',
  }])
})

test('Agent detection accepts the validated ChatGPT-bundled Codex prerelease', async () => {
  let calls = 0
  const found = await detectAgents({
    platform: 'darwin',
    env: {},
    resolveExecutableFn: async kind => kind === 'codex' ? '/tmp/codex' : null,
    execFileFn: async (_command, args) => {
      calls += 1
      if (args[0] === '--version') {
        return { stdout: 'codex-cli 0.146.0-alpha.9.2\n', stderr: '' }
      }
      if (args.includes('resume')) {
        return { stdout: '--json --skip-git-repo-check', stderr: '' }
      }
      return {
        stdout: '--json --sandbox --skip-git-repo-check --image read-only workspace-write',
        stderr: '',
      }
    },
  })

  assert.equal(calls, 3)
  assert.equal(found[0].resolvedVersion, '0.146.0-alpha.9.2')
  assert.equal(found[0].compatibilityState, 'compatible')
  assert.equal(found[0].incompatibilityReason, '')
})

test('Agent detection skips an unsupported Codex before the compatible ChatGPT bundle', async () => {
  const unsupported = '/tools/codex'
  const bundled = '/Applications/ChatGPT.app/Contents/Resources/codex'
  const found = await detectAgents({
    platform: 'darwin',
    home: '/Users/ryder',
    env: { PATH: '/tools' },
    accessFn: async (candidate) => {
      if (![unsupported, bundled].includes(candidate)) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      }
    },
    execFileFn: async (command, args) => {
      if (args[0] === '--version') {
        return {
          stdout: command === unsupported
            ? 'codex-cli 0.147.0\n'
            : 'codex-cli 0.146.0-alpha.9.2\n',
          stderr: '',
        }
      }
      if (args.includes('resume')) {
        return { stdout: '--json --skip-git-repo-check', stderr: '' }
      }
      return {
        stdout: '--json --sandbox --skip-git-repo-check --image read-only workspace-write',
        stderr: '',
      }
    },
  })

  assert.equal(found.length, 1)
  assert.equal(found[0].executable, bundled)
  assert.equal(found[0].resolvedVersion, '0.146.0-alpha.9.2')
  assert.equal(found[0].compatibilityState, 'compatible')
})

test('Agent detection skips a capability-incompatible Codex before the compatible bundle', async () => {
  const incomplete = '/tools/codex'
  const bundled = '/Applications/ChatGPT.app/Contents/Resources/codex'
  const found = await detectAgents({
    platform: 'darwin',
    home: '/Users/ryder',
    env: { PATH: '/tools' },
    accessFn: async (candidate) => {
      if (![incomplete, bundled].includes(candidate)) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      }
    },
    execFileFn: async (command, args) => {
      if (args[0] === '--version') {
        return { stdout: 'codex-cli 0.146.0\n', stderr: '' }
      }
      if (command === incomplete) return { stdout: '--json', stderr: '' }
      if (args.includes('resume')) {
        return { stdout: '--json --skip-git-repo-check', stderr: '' }
      }
      return {
        stdout: '--json --sandbox --skip-git-repo-check --image read-only workspace-write',
        stderr: '',
      }
    },
  })

  assert.equal(found.length, 1)
  assert.equal(found[0].executable, bundled)
  assert.equal(found[0].resolvedVersion, '0.146.0')
  assert.equal(found[0].compatibilityState, 'compatible')
})

test('Agent detection retains the first incompatible Codex when no candidate is compatible', async () => {
  const first = '/tools/codex'
  const bundled = '/Applications/ChatGPT.app/Contents/Resources/codex'
  const found = await detectAgents({
    platform: 'darwin',
    home: '/Users/ryder',
    env: { PATH: '/tools' },
    accessFn: async (candidate) => {
      if (![first, bundled].includes(candidate)) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      }
    },
    execFileFn: async (command, args) => {
      if (args[0] !== '--version') throw new Error('unexpected capability probe')
      return {
        stdout: command === first
          ? 'codex-cli 0.147.0\n'
          : 'codex-cli 0.146.0-alpha.9.3\n',
        stderr: '',
      }
    },
  })

  assert.equal(found.length, 1)
  assert.equal(found[0].executable, first)
  assert.equal(found[0].resolvedVersion, '0.147.0')
  assert.equal(found[0].compatibilityState, 'incompatible')
  assert.equal(found[0].incompatibilityReason, 'LOCAL_AGENT_VERSION_UNSUPPORTED')
})

test('Agent detection records the required capability or protocol that is unavailable', async () => {
  const codex = await detectAgents({
    platform: 'darwin',
    env: {},
    resolveExecutableFn: async kind => kind === 'codex' ? '/tmp/codex' : null,
    execFileFn: async (_command, args) => args[0] === '--version'
      ? { stdout: '0.137.0\n', stderr: '' }
      : { stdout: '--json --sandbox --skip-git-repo-check', stderr: '' },
  })
  assert.equal(codex[0].compatibilityState, 'incompatible')
  assert.equal(codex[0].incompatibilityReason, 'LOCAL_AGENT_REQUIRED_CAPABILITY_MISSING')
  assert.equal(codex[0].incompatibilityProbe, 'codex-exec')

  const kimi = await detectAgents({
    platform: 'darwin',
    env: {},
    resolveExecutableFn: async kind => kind === 'kimi' ? '/tmp/kimi' : null,
    execFileFn: async (_command, args) => {
      if (args[0] === '--version') return { stdout: '0.19.2\n', stderr: '' }
      if (args[0] === '--help') {
        return {
          stdout: '--output-format --auto --session --prompt stream-json',
          stderr: '',
        }
      }
      throw new Error('ACP unavailable')
    },
  })
  assert.equal(kimi[0].compatibilityState, 'incompatible')
  assert.equal(kimi[0].incompatibilityReason, 'LOCAL_AGENT_PROTOCOL_UNAVAILABLE')
  assert.equal(kimi[0].incompatibilityProbe, 'kimi-acp')
})

test('Agent detection retains installed CLIs with unrecognized version output as incompatible', async () => {
  const found = await detectAgents({
    platform: 'darwin',
    env: {},
    resolveExecutableFn: async kind => kind === 'kimi' ? '/tmp/kimi' : null,
    execFileFn: async () => ({ stdout: 'Please log in first\n', stderr: '' }),
  })

  assert.deepEqual(found, [{
    kind: 'kimi',
    name: 'Kimi CLI',
    executable: '/tmp/kimi',
    version: '',
    resolvedVersion: '',
    supportedVersionRange: '0.19.2..0.32.0',
    compatibilityState: 'incompatible',
    incompatibilityReason: 'LOCAL_AGENT_VERSION_UNSUPPORTED',
    incompatibilityProbe: '',
  }])
})

test('Agent detection passes only allowlisted system environment to version commands', async () => {
  const calls = []
  const found = await detectAgents({
    platform: 'darwin',
    home: '/Users/Ryder',
    env: {
      HOME: '/Users/Ryder',
      LANG: 'zh_CN.UTF-8',
      PATH: '/custom/bin',
      ROUNDRELAY_PRIVATE_VALUE: 'desktop-private-value',
      OPENAI_API_KEY: 'provider-secret',
    },
    resolveExecutableFn: async kind => kind === 'kimi' ? '/tmp/kimi' : null,
    execFileFn: async (_command, args, options) => {
      calls.push(options.env)
      if (args[0] === '--version') return { stdout: '0.19.2\n', stderr: '' }
      if (args[0] === '--help') {
        return {
          stdout: '--output-format --auto --session --prompt stream-json',
          stderr: '',
        }
      }
      return { stdout: 'Kimi ACP', stderr: '' }
    },
  })

  assert.equal(found.length, 1)
  assert.equal(calls.length, 3)
  for (const env of calls) {
    assert.equal(env.HOME, '/Users/Ryder')
    assert.equal(env.LANG, 'zh_CN.UTF-8')
    assert.match(env.PATH, /\/custom\/bin/)
    assert.equal(env.ROUNDRELAY_PRIVATE_VALUE, undefined)
    assert.equal(env.OPENAI_API_KEY, undefined)
  }
})

test('Agent detection excludes executable shims that cannot report a version', async () => {
  const found = await detectAgents({
    platform: 'darwin',
    env: {},
    resolveExecutableFn: async kind => kind === 'codex' ? '/tmp/codex' : null,
    execFileFn: async () => { throw new Error('broken shim') },
  })

  assert.deepEqual(found, [])
})

test('runAgent hides executable paths from spawn failures', async () => {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => true
  const outcome = runAgent(
    { kind: 'codex', executable: '/private/agents/codex', name: 'Codex' },
    'hello',
    '/private/workspace',
    { spawnFn: () => child },
  )

  child.emit('error', new Error('spawn /private/agents/codex ENOENT'))

  await assert.rejects(outcome, (error) => {
    assert.equal(error.message, 'LOCAL_AGENT_SPAWN_FAILED')
    assert.doesNotMatch(error.message, /private|codex/)
    assert.equal(error.diagnostic, 'spawn /private/agents/codex ENOENT')
    assert.equal(Object.prototype.propertyIsEnumerable.call(error, 'diagnostic'), false)
    return true
  })

  await assert.rejects(
    runAgent(
      { kind: 'codex', executable: '/private/agents/codex', name: 'Codex' },
      'hello',
      '/private/workspace',
      { spawnFn: () => { throw new Error('spawn /private/agents/codex ENOENT') } },
    ),
    (error) => {
      assert.equal(error.message, 'LOCAL_AGENT_SPAWN_FAILED')
      assert.equal(error.diagnostic, 'spawn /private/agents/codex ENOENT')
      assert.equal(Object.prototype.propertyIsEnumerable.call(error, 'diagnostic'), false)
      return true
    },
  )
})

test('runAgent escalates cancellation when the CLI ignores SIGTERM', {
  skip: process.platform === 'win32',
}, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-cli-abort-'))
  const readyFile = path.join(directory, 'ready')
  const cli = executable(directory, 'ignore-term.cjs', `
const fs = require('node:fs')
fs.writeFileSync(process.argv.at(-1), String(process.pid))
process.on('SIGTERM', () => {})
setInterval(() => {}, 1000)
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const controller = new AbortController()
  const outcome = runAgent(
    { kind: 'hermes', executable: cli, name: 'Hermes' },
    readyFile,
    directory,
    { signal: controller.signal, hermesAcpAvailable: false, hermesMessageWatermarkFn: () => 0 },
  ).then(value => ({ value }), error => ({ error }))
  const pid = Number(await readWhenReady(readyFile))

  controller.abort()

  const result = await within(outcome)
  assert.equal(result.error?.message, 'LOCAL_AGENT_EXECUTION_STOPPED')
  await waitForExit(pid)
})

test('runAgent cancellation closes pipes inherited by a descendant process', {
  skip: process.platform === 'win32',
}, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-cli-tree-'))
  const readyFile = path.join(directory, 'ready.json')
  const cli = executable(directory, 'spawn-descendant.cjs', `
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const descendant = spawn(process.execPath, ['-e', [
  "process.on('SIGTERM', () => {})",
  'setInterval(() => {}, 1000)',
].join(';')], { stdio: ['ignore', 'inherit', 'inherit'] })
fs.writeFileSync(process.argv.at(-1), JSON.stringify({ parent: process.pid, descendant: descendant.pid }))
setInterval(() => {}, 1000)
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const controller = new AbortController()
  const outcome = runAgent(
    { kind: 'hermes', executable: cli, name: 'Hermes' },
    readyFile,
    directory,
    { signal: controller.signal, hermesAcpAvailable: false, hermesMessageWatermarkFn: () => 0 },
  ).then(value => ({ value }), error => ({ error }))
  const pids = await readJsonWhenReady(readyFile)

  controller.abort()

  const result = await within(outcome)
  assert.equal(result.error?.message, 'LOCAL_AGENT_EXECUTION_STOPPED')
  await Promise.all([waitForExit(pids.parent), waitForExit(pids.descendant)])
})

test('Windows Agent cancellation terminates the full process tree with taskkill', async () => {
  const controller = new AbortController()
  const child = new EventEmitter()
  child.pid = 4321
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => true
  const killer = new EventEmitter()
  killer.unref = () => {}
  const calls = []
  const outcome = runAgent(
    { kind: 'codex', executable: 'C:\\Tools\\codex.exe', name: 'Codex' },
    'hello',
    'C:\\work',
    {
      platform: 'win32',
      signal: controller.signal,
      spawnFn: (command, args, options) => {
        calls.push({ command, args, options })
        return calls.length === 1 ? child : killer
      },
    },
  )

  controller.abort()
  child.emit('close', 1, 'SIGTERM')

  await assert.rejects(outcome, { message: 'LOCAL_AGENT_EXECUTION_STOPPED' })
  assert.equal(calls[1].command, 'taskkill.exe')
  assert.deepEqual(calls[1].args, ['/PID', '4321', '/T', '/F'])
})
