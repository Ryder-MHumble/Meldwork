const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const {
  AgentInstaller,
  defaultFindCommand,
  defaultRunProcess,
  installRecipe,
  prepareInstallCommand,
  validateScriptUrl,
} = require('../src/agent-installer.cjs')

function shellLiteral(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

async function readWhenReady(filename, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const value = fs.readFileSync(filename, 'utf8')
      if (value) return value
    } catch {
      // Keep polling until the child creates the file.
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${filename}`)
}

async function within(promise, timeoutMs = 3000) {
  let timeout
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Installer cancellation did not settle.')),
          timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

async function waitForExit(pid, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error.code === 'ESRCH') return
      throw error
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Process ${pid} did not exit.`)
}

function installer(overrides = {}) {
  return new AgentInstaller({
    platform: 'darwin',
    detectAgents: async () => [],
    findCommand: async command => (command === 'npm' ? '/usr/local/bin/npm' : ''),
    downloadScript: async () => '/tmp/roundrelay-installer/install.sh',
    removeDownload: async () => {},
    runProcess: async () => {},
    createId: () => 'task-1',
    ...overrides,
  })
}

test('catalog reports installed, recommended and provider-compatible Agents', async () => {
  const service = installer({
    detectAgents: async () => [
      { kind: 'workbuddy', version: '2.115.0', executable: '/tmp/codebuddy' },
      { kind: 'kimi', version: '0.19.2', executable: '/tmp/kimi' },
    ],
  })

  const result = await service.catalog()
  assert.equal(result.platform, 'darwin')
  assert.deepEqual(result.agents.map(agent => agent.kind), [
    'hermes', 'openclaw', 'workbuddy', 'kimi', 'codex', 'claude', 'qwen',
    'gemini', 'opencode',
  ])
  assert.equal(result.agents.find(agent => agent.kind === 'workbuddy').installed, true)
  assert.equal(result.agents.find(agent => agent.kind === 'workbuddy').providerCompatible, true)
  assert.equal(result.agents.find(agent => agent.kind === 'hermes').recommended, true)
  assert.equal(result.agents.find(agent => agent.kind === 'openclaw').providerCompatible, true)
  assert.equal(result.agents.find(agent => agent.kind === 'openclaw').providerSupport,
    'supported')
  assert.equal(result.agents.find(agent => agent.kind === 'kimi').providerCompatible, false)
  assert.equal(result.agents.find(agent => agent.kind === 'kimi').providerSupport, 'native-config')
  assert.equal(result.agents.find(agent => agent.kind === 'openclaw').installSupported, true)
  assert.equal(result.agents.find(agent => agent.kind === 'openclaw').installErrorCode, '')
  assert.equal(result.agents.find(agent => agent.kind === 'gemini').providerSupport, 'native-config')
  assert.equal(result.agents.find(agent => agent.kind === 'opencode').providerCompatible, false)
  assert.equal(JSON.stringify(result).includes('/tmp/codebuddy'), false)
  assert.equal(JSON.stringify(result).includes('/tmp/kimi'), false)
})

test('catalog lookups share in-flight and short-lived Agent detection', async () => {
  let detectCount = 0
  let now = 1000
  let resolveDetection
  const firstDetection = new Promise(resolve => { resolveDetection = resolve })
  const detected = [{ kind: 'hermes', version: '0.18.0', executable: '/tmp/hermes' }]
  const service = installer({
    now: () => now,
    detectAgents: async () => {
      detectCount += 1
      return detectCount === 1 ? firstDetection : detected
    },
  })

  const firstCatalog = service.catalog()
  const secondCatalog = service.catalog()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(detectCount, 1)
  resolveDetection(detected)

  const [firstResult, secondResult] = await Promise.all([firstCatalog, secondCatalog])
  assert.equal(firstResult.agents.find(agent => agent.kind === 'hermes').installed, true)
  assert.equal(secondResult.agents.find(agent => agent.kind === 'hermes').installed, true)

  await service.catalog()
  assert.equal(detectCount, 1)

  now += 3001
  await service.catalog()
  assert.equal(detectCount, 2)

  service.invalidateDetectionCache()
  await service.catalog()
  assert.equal(detectCount, 3)
})

test('cache invalidation does not let an older in-flight detection overwrite fresh results', async () => {
  const detections = []
  const service = installer({
    detectAgents: () => new Promise(resolve => detections.push(resolve)),
  })

  const staleCatalog = service.catalog()
  await new Promise(resolve => setImmediate(resolve))
  service.invalidateDetectionCache()
  const freshCatalog = service.catalog()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(detections.length, 2)

  detections[1]([{ kind: 'hermes', version: '0.18.0', executable: '/tmp/hermes' }])
  assert.equal((await freshCatalog).agents.find(agent => agent.kind === 'hermes').installed, true)
  detections[0]([])
  const retriedCatalog = await staleCatalog
  assert.equal(retriedCatalog.agents.find(agent => agent.kind === 'hermes').installed, true)

  assert.equal((await service.catalog()).agents.find(agent => agent.kind === 'hermes').installed, true)
  assert.equal(detections.length, 2)
})

test('recipes are fixed by Agent and platform', () => {
  const npmPackages = {
    codex: '@openai/codex@latest',
    claude: '@anthropic-ai/claude-code@latest',
    openclaw: 'openclaw@latest',
    qwen: '@qwen-code/qwen-code@latest',
    workbuddy: '@tencent-ai/codebuddy-code@2.115.0',
    gemini: '@google/gemini-cli@latest',
    opencode: 'opencode-ai@latest',
  }
  for (const platform of ['darwin', 'win32']) {
    for (const [kind, packageName] of Object.entries(npmPackages)) {
      assert.deepEqual(installRecipe(kind, platform), { type: 'npm', packageName })
    }
  }
  assert.deepEqual(installRecipe('hermes', 'darwin'), {
    type: 'script',
    url: 'https://hermes-agent.nousresearch.com/install.sh',
    interpreter: '/bin/bash',
    args: ['$SCRIPT', '--non-interactive', '--skip-setup'],
  })
  assert.deepEqual(installRecipe('hermes', 'win32'), {
    type: 'script',
    url: 'https://hermes-agent.nousresearch.com/install.ps1',
    interpreter: 'powershell.exe',
    args: [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '$SCRIPT',
      '-NonInteractive', '-SkipSetup',
    ],
  })
  assert.deepEqual(installRecipe('kimi', 'darwin'), {
    type: 'script',
    url: 'https://code.kimi.com/kimi-code/install.sh',
    interpreter: '/bin/bash',
    args: ['$SCRIPT'],
  })
  assert.deepEqual(installRecipe('kimi', 'win32'), {
    type: 'script',
    url: 'https://code.kimi.com/kimi-code/install.ps1',
    interpreter: 'powershell.exe',
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '$SCRIPT'],
  })
  assert.equal(installRecipe('hermes', 'linux'), null)
})

test('npm lookup uses the enhanced Finder-safe search path', async () => {
  const result = await defaultFindCommand('npm', 'darwin', {
    home: '/Users/Ryder',
    env: { PATH: '/usr/bin:/bin' },
    execFileFn: async (command, args, options) => {
      assert.equal(command, '/usr/bin/which')
      assert.deepEqual(args, ['npm'])
      assert.ok(options.env.PATH.split(':').includes('/Users/Ryder/.volta/bin'))
      return { stdout: '/Users/Ryder/.volta/bin/npm\n', stderr: '' }
    },
  })

  assert.equal(result, '/Users/Ryder/.volta/bin/npm')
})

test('Windows npm lookup normalizes Path and includes user installation locations', async () => {
  const expected = 'C:\\Users\\Ryder\\AppData\\Roaming\\npm\\npm.cmd'
  const result = await defaultFindCommand('npm.cmd', 'win32', {
    home: 'C:\\Users\\Ryder',
    env: {
      Path: 'C:\\Windows\\System32',
      APPDATA: 'C:\\Users\\Ryder\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\Ryder\\AppData\\Local',
    },
    execFileFn: async (command, args, options) => {
      assert.equal(command, 'where.exe')
      assert.deepEqual(args, ['npm.cmd'])
      assert.equal('Path' in options.env, false)
      const lookupPath = options.env.PATH.split(';')
      assert.ok(lookupPath.includes('C:\\Users\\Ryder\\AppData\\Roaming\\npm'))
      assert.ok(lookupPath.includes('C:\\Users\\Ryder\\AppData\\Local\\Microsoft\\WindowsApps'))
      assert.ok(lookupPath.includes('C:\\Users\\Ryder\\AppData\\Local\\Programs\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin'))
      return { stdout: `${expected}\r\n`, stderr: '' }
    },
  })

  assert.equal(result, expected)
})

test('installer processes inherit the same enhanced Finder-safe search path', async () => {
  const calls = []
  const child = new EventEmitter()
  child.pid = 12345
  child.kill = () => true

  const running = defaultRunProcess('/Users/Ryder/.volta/bin/npm', ['install'], {
    platform: 'darwin',
    home: '/Users/Ryder',
    env: {
      PATH: '/usr/bin:/bin',
      PNPM_HOME: '/Users/Ryder/Library/pnpm',
      OPENAI_API_KEY: 'test-provider-key',
      ROUNDRELAY_SESSION_SECRET: 'test-private-value',
      USER_PROMPT: 'test-private-prompt',
    },
    spawnFn: (command, args, options) => {
      calls.push({ command, args, options })
      queueMicrotask(() => child.emit('close', 0))
      return child
    },
  })

  await running
  assert.equal(calls[0].command, '/Users/Ryder/.volta/bin/npm')
  assert.deepEqual(calls[0].args, ['install'])
  const childPath = calls[0].options.env.PATH.split(':')
  assert.ok(childPath.includes('/Users/Ryder/.volta/bin'))
  assert.ok(childPath.includes('/Users/Ryder/Library/pnpm'))
  assert.ok(childPath.includes('/Users/Ryder/.local/share/fnm/aliases/default/bin'))
  assert.equal('OPENAI_API_KEY' in calls[0].options.env, false)
  assert.equal('ROUNDRELAY_SESSION_SECRET' in calls[0].options.env, false)
  assert.equal('USER_PROMPT' in calls[0].options.env, false)
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'ignore', 'ignore'])
  assert.equal(calls[0].options.shell, false)
})

test('rejects non-allowlisted script URLs before any download', () => {
  assert.equal(
    validateScriptUrl('https://hermes-agent.nousresearch.com/install.sh').hostname,
    'hermes-agent.nousresearch.com',
  )
  assert.equal(
    validateScriptUrl('https://cdn.kimi.com/kimi-code/install.sh').hostname,
    'cdn.kimi.com',
  )
  assert.throws(
    () => validateScriptUrl('https://example.invalid/install.sh'),
    /INSTALL_AGENT_DOWNLOAD_BLOCKED/,
  )
  assert.throws(
    () => validateScriptUrl('http://hermes-agent.nousresearch.com/install.sh'),
    /INSTALL_AGENT_DOWNLOAD_BLOCKED/,
  )
})

test('npm installation uses an allowlisted package then verifies detection', async () => {
  const calls = []
  let detectCount = 0
  const phases = []
  const service = installer({
    detectAgents: async () => {
      detectCount += 1
      return detectCount > 1
        ? [{ kind: 'workbuddy', version: '2.115.0', executable: '/tmp/codebuddy' }]
        : []
    },
    runProcess: async (...args) => { calls.push(args) },
  })
  service.on('changed', state => phases.push(state.phase))

  const started = await service.start('workbuddy')
  assert.equal(started.taskId, 'task-1')
  await service.waitForIdle()

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].slice(0, 2), [
    '/usr/local/bin/npm',
    ['install', '--global', '@tencent-ai/codebuddy-code@2.115.0'],
  ])
  assert.equal(calls[0][2].platform, 'darwin')
  assert.equal(calls[0][2].signal.aborted, false)
  assert.deepEqual(phases, ['checking', 'installing', 'verifying', 'completed'])
  assert.deepEqual(service.state(), {
    taskId: 'task-1',
    kind: 'workbuddy',
    phase: 'completed',
    canCancel: false,
    errorCode: '',
  })
})

test('a completed installation invalidates a previously cached catalog', async () => {
  let installed = false
  let detectCount = 0
  const service = installer({
    detectAgents: async () => {
      detectCount += 1
      return installed
        ? [{ kind: 'workbuddy', version: '2.115.0', executable: '/tmp/codebuddy' }]
        : []
    },
    runProcess: async () => { installed = true },
  })

  const before = await service.catalog()
  assert.equal(before.agents.find(agent => agent.kind === 'workbuddy').installed, false)
  await service.start('workbuddy')
  await service.waitForIdle()

  const after = await service.catalog()
  assert.equal(after.agents.find(agent => agent.kind === 'workbuddy').installed, true)
  assert.equal(detectCount, 4)
})

test('Windows npm installation launches node.exe and npm-cli.js without a shell', async () => {
  const npmCommand = 'C:\\Program Files\\nodejs\\npm.cmd'
  const nodeCommand = 'C:\\Program Files\\nodejs\\node.exe'
  const npmCli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'
  const shim = [
    '@ECHO off',
    'SET "NODE_EXE=%~dp0\\node.exe"',
    'SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"',
    '"%NODE_EXE%" "%NPM_CLI_JS%" %*',
  ].join('\r\n')
  const calls = []
  let detectCount = 0
  const service = installer({
    platform: 'win32',
    detectAgents: async () => {
      detectCount += 1
      return detectCount > 1
        ? [{ kind: 'qwen', version: '0.10.0', executable: 'C:\\npm\\qwen.cmd' }]
        : []
    },
    findCommand: async command => command === 'npm.cmd' ? npmCommand : '',
    readCommandFile: filename => {
      assert.equal(filename, npmCommand)
      return shim
    },
    commandPathExists: filename => [nodeCommand, npmCli].includes(filename),
    runProcess: async (...args) => { calls.push(args) },
  })

  await service.start('qwen')
  await service.waitForIdle()

  assert.deepEqual(calls[0].slice(0, 2), [
    nodeCommand,
    [npmCli, 'install', '--global', '@qwen-code/qwen-code@latest'],
  ])
  assert.equal(calls[0][2].platform, 'win32')
  assert.equal(service.state().phase, 'completed')
})

test('Windows npm parsing rejects wrappers that do not target npm-cli.js', () => {
  assert.throws(() => prepareInstallCommand(
    'C:\\Program Files\\nodejs\\npm.cmd',
    ['install', '--global', '@qwen-code/qwen-code@latest'],
    {
      platform: 'win32',
      readFileFn: () => '"node.exe" "%~dp0\\download-and-run.js" %*',
      existsFn: () => true,
    },
  ), /INSTALL_AGENT_COMMAND_BLOCKED/)
})

test('script installation downloads a fixed official URL instead of piping remote code', async () => {
  const downloads = []
  const calls = []
  let detectCount = 0
  const service = installer({
    detectAgents: async () => {
      detectCount += 1
      return detectCount > 1
        ? [{ kind: 'hermes', version: '0.18.0', executable: '/tmp/hermes' }]
        : []
    },
    downloadScript: async (...args) => {
      downloads.push(args)
      return '/tmp/roundrelay-installer/install.sh'
    },
    runProcess: async (...args) => { calls.push(args) },
  })

  await service.start('hermes')
  await service.waitForIdle()

  assert.equal(downloads[0][0], 'https://hermes-agent.nousresearch.com/install.sh')
  assert.deepEqual(calls[0].slice(0, 2), [
    '/bin/bash',
    ['/tmp/roundrelay-installer/install.sh', '--non-interactive', '--skip-setup'],
  ])
})

test('rejects unknown, verified installed, unsupported and missing-prerequisite installs', async () => {
  const service = installer()
  await assert.rejects(service.start('anything'), /INSTALL_AGENT_UNSUPPORTED/)

  const installed = installer({
    detectAgents: async () => [{ kind: 'kimi', executable: '/tmp/kimi', version: '0.19.2' }],
  })
  await assert.rejects(installed.start('kimi'), /INSTALL_AGENT_ALREADY_INSTALLED/)

  const unsupported = installer({ platform: 'linux' })
  await assert.rejects(unsupported.start('hermes'), /INSTALL_AGENT_PLATFORM_UNSUPPORTED/)

  const noNode = installer({ findCommand: async () => '' })
  await assert.rejects(noNode.start('qwen'), /INSTALL_AGENT_NODE_REQUIRED/)
})

test('installation verification rejects a detected command without a working version', async () => {
  let detectCount = 0
  const service = installer({
    detectAgents: async () => {
      detectCount += 1
      return detectCount > 1
        ? [{ kind: 'openclaw', executable: '/tmp/openclaw', version: '' }]
        : []
    },
  })

  await service.start('openclaw')
  await service.waitForIdle()

  assert.equal(service.state().phase, 'failed')
  assert.equal(service.state().errorCode, 'INSTALL_AGENT_VERIFY_FAILED')
})

test('rejects a non-allowlisted executable before starting a process', async () => {
  let processStarted = false
  const service = installer({
    findCommand: async () => '/tmp/curl',
    runProcess: async () => { processStarted = true },
  })

  await assert.rejects(service.start('qwen'), /INSTALL_AGENT_COMMAND_BLOCKED/)
  assert.equal(processStarted, false)
  assert.equal(service.state().phase, 'idle')
})

test('reports download failures without starting the installer command', async () => {
  let processStarted = false
  const phases = []
  const service = installer({
    downloadScript: async () => { throw new Error('socket closed') },
    runProcess: async () => { processStarted = true },
  })
  service.on('changed', state => phases.push(state.phase))

  await service.start('hermes')
  await service.waitForIdle()

  assert.equal(processStarted, false)
  assert.deepEqual(phases, ['checking', 'downloading', 'failed'])
  assert.deepEqual(service.state(), {
    taskId: 'task-1',
    kind: 'hermes',
    phase: 'failed',
    canCancel: false,
    errorCode: 'INSTALL_AGENT_DOWNLOAD_FAILED',
  })
})

test('cancels only the active task and never exposes commands or output in state', async () => {
  let rejectRun
  let observedSignal
  const service = installer({
    runProcess: async (_command, _args, options) => {
      observedSignal = options.signal
      await new Promise((_resolve, reject) => { rejectRun = reject })
    },
  })

  await service.start('codex')
  while (!rejectRun) await new Promise(resolve => setImmediate(resolve))
  assert.equal(service.cancel('wrong-task'), false)
  assert.equal(service.cancel('task-1'), true)
  assert.equal(observedSignal.aborted, true)
  rejectRun(Object.assign(new Error('cancelled'), { name: 'AbortError' }))
  await service.waitForIdle()

  assert.deepEqual(service.state(), {
    taskId: 'task-1',
    kind: 'codex',
    phase: 'cancelled',
    canCancel: false,
    errorCode: '',
  })
  assert.equal(JSON.stringify(service.state()).includes('npm'), false)
})

test('process cancellation escalates from SIGTERM to SIGKILL', {
  skip: process.platform === 'win32',
}, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-installer-abort-'))
  const readyFile = path.join(directory, 'ready')
  const termFile = path.join(directory, 'term')
  const script = path.join(directory, 'ignore-term.sh')
  const source = `
const fs = require('node:fs')
fs.writeFileSync(${JSON.stringify(readyFile)}, String(process.pid))
process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(termFile)}, 'SIGTERM'))
setInterval(() => {}, 1000)
`
  fs.writeFileSync(script, `#!/bin/bash\nexec ${shellLiteral(process.execPath)} -e ${shellLiteral(source)}\n`, {
    mode: 0o755,
  })
  let pid = 0
  t.after(() => {
    if (pid) {
      try { process.kill(pid, 'SIGKILL') } catch { /* already exited */ }
    }
    fs.rmSync(directory, { recursive: true, force: true })
  })

  const service = installer({
    downloadScript: async () => script,
    runProcess: undefined,
  })

  await service.start('hermes')
  pid = Number(await readWhenReady(readyFile))
  assert.equal(service.cancel('task-1'), true)
  assert.equal(await readWhenReady(termFile), 'SIGTERM')
  await within(service.waitForIdle())
  await waitForExit(pid)

  assert.deepEqual(service.state(), {
    taskId: 'task-1',
    kind: 'hermes',
    phase: 'cancelled',
    canCancel: false,
    errorCode: '',
  })
})
