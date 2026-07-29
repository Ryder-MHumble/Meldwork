const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const Module = require('node:module')
const { EventEmitter } = require('node:events')

const PROVIDER_METADATA = Object.freeze({
  provider: 'OpenAI Compatible',
  baseUrl: 'https://api.example.com/v1',
  model: 'example-model',
})
const LOCAL_IPC_CHANNELS = Object.freeze([
  'local-workspace:get',
  'local-workspace:refresh-agents',
  'local-workspace:create-group',
  'local-workspace:update-group',
  'local-workspace:delete-group',
  'local-workspace:send',
  'local-workspace:start-auto',
  'local-workspace:stop',
  'local-workspace:pick-directory',
  'local-workspace:default-directory',
  'local-agent-installer:catalog',
  'local-agent-installer:state',
  'local-agent-installer:start',
  'local-agent-installer:cancel',
  'local-agent-installer:set-sidebar-visibility',
  'local-agent-provider:status',
  'local-agent-provider:probe',
  'local-agent-provider:save',
  'local-agent-provider:delete',
])

let nextRoutingId = 1

function deferred() {
  let resolve
  const promise = new Promise(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

async function waitFor(check, message = 'Timed out waiting for test state.') {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error(message)
}

function eventFor(url) {
  const mainFrame = { url, processId: 1, routingId: nextRoutingId++ }
  const sender = { mainFrame }
  return { event: { sender, senderFrame: { ...mainFrame } }, sender }
}

function loadMain(userData, options = {}) {
  const appListeners = new Map()
  const ipcHandlers = new Map()
  const ipcListeners = new Map()
  const windows = []
  const workspaceInstances = []
  const installerInstances = []
  const providerInstances = []
  const runAgentCalls = []
  const externalUrls = []
  const dialogCalls = []
  const permissionHandlers = {}
  let readyCallback
  let quitCount = 0
  let providerConfigured = options.providerConfigured === true

  class TestWorkspace extends EventEmitter {
    constructor(input) {
      super()
      this.input = input
      this.refreshCount = 0
      this.concurrentRefreshes = 0
      this.maxConcurrentRefreshes = 0
      this.clearRuntimeCredentialFailuresCount = 0
      this.stopCount = 0
      workspaceInstances.push(this)
    }

    async refreshAgents() {
      this.refreshCount += 1
      this.concurrentRefreshes += 1
      this.maxConcurrentRefreshes = Math.max(
        this.maxConcurrentRefreshes,
        this.concurrentRefreshes,
      )
      try {
        await options.onRefresh?.(this, this.refreshCount)
        return this.snapshot()
      } finally {
        this.concurrentRefreshes -= 1
      }
    }

    snapshot() { return { agents: [], groups: [], messages: [], localOnly: true } }
    clearRuntimeCredentialFailures() { this.clearRuntimeCredentialFailuresCount += 1 }
    createGroup() { return this.snapshot() }
    updateGroup() { return this.snapshot() }
    deleteGroup() {}
    sendMessage() { return Promise.resolve(this.snapshot()) }
    startAuto() { return this.snapshot() }
    stop() { return false }
    setSidebarVisibility() { return this.snapshot() }
    async stopAll() {
      this.stopCount += 1
      if (options.workspaceStopGate) await options.workspaceStopGate.promise
    }
  }

  class TestInstaller extends EventEmitter {
    constructor(input) {
      super()
      this.input = input
      this.cancelled = []
      this.invalidateCount = 0
      installerInstances.push(this)
    }

    catalog() { return Promise.resolve({ agents: [] }) }
    state() { return options.installerState || { phase: 'idle', canCancel: false } }
    start() { return this.state() }
    cancel(taskId) { this.cancelled.push(taskId); return true }
    invalidateDetectionCache() { this.invalidateCount += 1 }
    async waitForIdle() {
      if (options.installerIdleGate) await options.installerIdleGate.promise
    }
  }

  class TestProviderStore {
    constructor(input) {
      this.input = input
      this.saved = []
      this.deleteCount = 0
      this.statusCalls = []
      providerInstances.push(this)
    }

    status(input) {
      this.statusCalls.push(input)
      return providerConfigured
        ? { ...PROVIDER_METADATA, encryptionAvailable: true, configured: true }
        : {
            provider: '', baseUrl: '', model: '',
            encryptionAvailable: true, configured: false,
          }
    }

    save(input) {
      this.saved.push(input)
      providerConfigured = true
      return this.status()
    }

    delete() {
      this.deleteCount += 1
      providerConfigured = false
      return this.status()
    }

    envForAgent() {
      return options.providerEnv || {
        OPENAI_API_KEY: 'provider-key',
        OPENAI_BASE_URL: PROVIDER_METADATA.baseUrl,
        OPENAI_MODEL: PROVIDER_METADATA.model,
      }
    }
  }

  class TestBrowserWindow {
    constructor(input) {
      this.input = input
      this.loads = []
      this.windowListeners = new Map()
      const mainFrame = { url: 'about:blank', processId: 1, routingId: nextRoutingId++ }
      this.webContents = {
        mainFrame,
        listeners: new Map(),
        sent: [],
        session: {
          setPermissionCheckHandler: listener => { permissionHandlers.check = listener },
          setPermissionRequestHandler: listener => { permissionHandlers.request = listener },
          setDevicePermissionHandler: listener => { permissionHandlers.device = listener },
        },
        on: (name, listener) => this.webContents.listeners.set(name, listener),
        send: (...args) => this.webContents.sent.push(args),
        setWindowOpenHandler: listener => { this.openHandler = listener },
      }
      windows.push(this)
    }

    isDestroyed() { return false }

    loadFile(filename, loadOptions = {}) {
      let url = pathToFileURL(filename).href
      if (loadOptions.query) url += `?${new URLSearchParams(loadOptions.query)}`
      if (loadOptions.hash) url += `#${loadOptions.hash}`
      this.webContents.mainFrame.url = url
      this.loads.push({ filename, options: loadOptions, url })
      return Promise.resolve()
    }

    on(name, listener) { this.windowListeners.set(name, listener) }
  }
  TestBrowserWindow.getAllWindows = () => windows

  const electron = {
    app: {
      getPath: name => name === 'documents' ? path.join(userData, 'Documents') : userData,
      isPackaged: false,
      on: (name, listener) => appListeners.set(name, listener),
      quit: () => { quitCount += 1 },
      whenReady: () => ({ then: listener => { readyCallback = listener } }),
    },
    BrowserWindow: TestBrowserWindow,
    dialog: {
      showOpenDialog: async (...args) => {
        dialogCalls.push(args)
        return { canceled: true, filePaths: [] }
      },
    },
    ipcMain: {
      handle: (name, listener) => ipcHandlers.set(name, listener),
      on: (name, listener) => ipcListeners.set(name, listener),
    },
    Menu: {
      buildFromTemplate: template => template,
      setApplicationMenu: () => {},
    },
    shell: {
      openExternal: url => {
        externalUrls.push(url)
        return Promise.resolve()
      },
    },
  }
  Object.defineProperty(electron, 'safeStorage', {
    enumerable: true,
    get: () => {
      options.onSafeStorageAccess?.(windows.length)
      return options.safeStorage || {
        isEncryptionAvailable: () => true,
        encryptString: value => Buffer.from(value),
        decryptString: value => Buffer.from(value).toString('utf8'),
      }
    },
  })

  const moduleMocks = {
    electron,
    './cli-adapters.cjs': {
      detectAgents: async () => [],
      runAgent: async (...args) => {
        runAgentCalls.push(args)
        return { text: 'local reply', sessionRef: 'local-session' }
      },
    },
    './agent-installer.cjs': { AgentInstaller: TestInstaller },
    './local-agent-readiness.cjs': {
      nativeCredentialEnvironment: kind => options.nativeEnvironment?.(kind) || {},
      resolveNativeCredentialState: async () => ({ state: 'ready', source: 'native-credential' }),
    },
    './local-workspace.cjs': { LocalWorkspace: TestWorkspace },
    './openclaw-runtime.cjs': {
      managedOpenClawOptions: input => ({ env: { MANAGED_OPENCLAW: JSON.stringify(input) } }),
    },
    './provider-store.cjs': { ProviderStore: TestProviderStore },
    ...options.moduleMocks,
  }

  const originalLoad = Module._load
  Module._load = function load(request, parent, isMain) {
    if (Object.hasOwn(moduleMocks, request)) return moduleMocks[request]
    return originalLoad.call(this, request, parent, isMain)
  }
  const filename = require.resolve('../src/main.cjs')
  delete require.cache[filename]
  try {
    const main = require(filename)
    return {
      main,
      harness: {
        appListeners,
        ipcHandlers,
        ipcListeners,
        installerInstances,
        dialogCalls,
        externalUrls,
        permissionHandlers,
        providerInstances,
        runAgentCalls,
        windows,
        workspaceInstances,
        get quitCount() { return quitCount },
        event: () => {
          const sender = windows.at(-1)?.webContents
          return { sender, senderFrame: sender ? { ...sender.mainFrame } : null }
        },
        ready: async () => {
          assert.equal(typeof readyCallback, 'function')
          await readyCallback()
        },
      },
    }
  } finally {
    Module._load = originalLoad
    delete require.cache[filename]
  }
}

test('local desktop authorization requires the current main frame and exact frontend file', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-main-security-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { main } = loadMain(directory)
  const frontend = path.join(directory, 'frontend', 'index.html')
  const frontendUrl = `${pathToFileURL(frontend).href}?desktop=1#/chat`
  const trusted = eventFor(frontendUrl)

  assert.equal(main.isTrustedLocalRenderer(trusted.event, trusted.sender, frontend), true)
  assert.equal(main.isTrustedLocalWebContents(trusted.sender, frontend), true)
  assert.equal(main.isTrustedLocalRenderer({
    sender: trusted.sender,
    senderFrame: { url: frontendUrl, processId: 1, routingId: 999 },
  }, trusted.sender, frontend), false)
  assert.equal(main.isTrustedLocalRenderer(
    eventFor(pathToFileURL(path.join(directory, 'offline.html')).href).event,
    trusted.sender,
    frontend,
  ), false)
})

test('every local IPC handler rejects an untrusted renderer before dispatch', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-ipc-security-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory)
  await harness.ready()

  assert.deepEqual([...harness.ipcHandlers.keys()], LOCAL_IPC_CHANNELS)
  const trustedEvent = harness.event()
  const untrustedEvent = {
    sender: trustedEvent.sender,
    senderFrame: {
      ...trustedEvent.senderFrame,
      routingId: trustedEvent.senderFrame.routingId + 1,
    },
  }
  for (const channel of LOCAL_IPC_CHANNELS) {
    await assert.rejects(
      async () => harness.ipcHandlers.get(channel)(untrustedEvent),
      { message: 'DESKTOP_CLIENT_ACCESS_DENIED' },
      channel,
    )
  }
})

test('ready activates one fixed local workspace and loads the bundled frontend', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-ready-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory)

  await harness.ready()

  assert.equal(harness.workspaceInstances.length, 1)
  assert.equal(
    harness.workspaceInstances[0].input.storagePath,
    path.join(directory, 'roundrelay-workspace.json'),
  )
  assert.equal(harness.workspaceInstances[0].refreshCount, 1)
  assert.equal(harness.providerInstances[0].input.storagePath,
    path.join(directory, 'roundrelay-provider.json'))
  assert.equal(harness.windows.length, 1)
  assert.equal(
    harness.windows[0].loads[0].filename,
    path.resolve(__dirname, '../../frontend/dist/index.html'),
  )
  assert.deepEqual(harness.windows[0].loads[0].options, { hash: '/chat' })
  assert.equal([...harness.ipcHandlers.keys()].some(name => name.includes('cloud')), false)
  assert.equal([...harness.ipcHandlers.keys()].some(name => name.includes('configure')), false)
  assert.equal(harness.ipcListeners.size, 0)
})

test('ready creates the desktop window before the initial Agent refresh settles', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-ready-window-'))
  const refreshGate = deferred()
  t.after(() => {
    refreshGate.resolve()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const { harness } = loadMain(directory, {
    onRefresh: async (_workspace, count) => {
      if (count === 1) await refreshGate.promise
    },
  })

  const ready = harness.ready()
  await waitFor(() => harness.workspaceInstances[0]?.refreshCount === 1)

  assert.equal(harness.windows.length, 1)
  refreshGate.resolve()
  await ready
})

test('Electron safeStorage stays lazy until after the desktop window exists', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-ready-safe-storage-'))
  const safeStorageAccesses = []
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory, {
    onSafeStorageAccess: windowCount => safeStorageAccesses.push(windowCount),
  })

  await harness.ready()
  assert.deepEqual(safeStorageAccesses, [])

  assert.equal(harness.providerInstances[0].input.safeStorage.isEncryptionAvailable(), true)
  assert.deepEqual(safeStorageAccesses, [1])
})

test('window navigation permits only local app pages and credential-free HTTPS links', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-navigation-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory)
  await harness.ready()
  const window = harness.windows[0]

  assert.equal(harness.permissionHandlers.check(), false)
  let granted = true
  harness.permissionHandlers.request(null, 'camera', value => { granted = value })
  assert.equal(granted, false)
  assert.equal(harness.permissionHandlers.device(), false)

  assert.deepEqual(window.openHandler({ url: 'https://example.com/docs' }), { action: 'deny' })
  assert.deepEqual(window.openHandler({ url: 'http://example.com' }), { action: 'deny' })
  assert.deepEqual(window.openHandler({ url: 'https://user:pass@example.com' }), { action: 'deny' })
  assert.deepEqual(harness.externalUrls, ['https://example.com/docs'])

  const navigate = window.webContents.listeners.get('will-navigate')
  let prevented = 0
  navigate({ preventDefault: () => { prevented += 1 } }, window.loads[0].url)
  assert.equal(prevented, 0)

  navigate(
    { preventDefault: () => { prevented += 1 } },
    pathToFileURL(path.join(directory, 'untrusted.html')).href,
  )
  navigate({ preventDefault: () => { prevented += 1 } }, 'https://example.com/help')
  navigate({ preventDefault: () => { prevented += 1 } }, 'javascript:alert(1)')
  assert.equal(prevented, 3)
  assert.deepEqual(harness.externalUrls, [
    'https://example.com/docs',
    'https://example.com/help',
  ])
})

test('Provider IPC accepts the complete user payload and supports local deletion', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-provider-ipc-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory)
  await harness.ready()
  const input = { ...PROVIDER_METADATA, apiKey: 'renderer-provider-key' }

  const initial = await harness.ipcHandlers.get('local-agent-provider:status')(harness.event())
  assert.equal(initial.configured, false)
  assert.deepEqual(harness.providerInstances[0].statusCalls, [undefined])

  await harness.ipcHandlers.get('local-agent-provider:probe')(harness.event())
  assert.deepEqual(harness.providerInstances[0].statusCalls, [
    undefined,
    { probeEncryption: true },
  ])

  const saved = await harness.ipcHandlers.get('local-agent-provider:save')(
    harness.event(), input,
  )
  assert.deepEqual(harness.providerInstances[0].saved, [input])
  assert.equal(saved.configured, true)
  assert.equal(harness.workspaceInstances[0].refreshCount, 2)

  const deleted = await harness.ipcHandlers.get('local-agent-provider:delete')(harness.event())
  assert.equal(harness.providerInstances[0].deleteCount, 1)
  assert.equal(deleted.configured, false)
  assert.equal(harness.workspaceInstances[0].refreshCount, 3)
})

test('directory picker uses the operating system localized title', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-directory-dialog-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory)
  await harness.ready()

  const selected = await harness.ipcHandlers.get('local-workspace:pick-directory')(harness.event())

  assert.equal(selected, '')
  assert.equal(harness.dialogCalls.length, 1)
  assert.deepEqual(harness.dialogCalls[0][1], {
    properties: ['openDirectory', 'createDirectory'],
  })
})

test('configured Provider is injected only through local Agent execution options', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-provider-routing-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory, {
    providerConfigured: true,
    nativeEnvironment: kind => kind === 'hermes'
      ? { ANTHROPIC_API_KEY: 'native-hermes-key' }
      : {},
  })
  await harness.ready()

  await harness.workspaceInstances[0].input.runAgent(
    { kind: 'hermes', executable: '/tmp/hermes' },
    'hello', directory, { env: { CURRENT_RUN: '1' } },
  )

  const options = harness.runAgentCalls[0][3]
  assert.deepEqual(options.provider, { id: 'openai-api', model: 'example-model' })
  assert.equal(options.env.OPENAI_API_KEY, 'provider-key')
  assert.equal(options.env.OPENAI_BASE_URL, PROVIDER_METADATA.baseUrl)
  assert.equal(options.env.OPENAI_MODEL, PROVIDER_METADATA.model)
  assert.equal(options.env.HERMES_INFERENCE_MODEL, PROVIDER_METADATA.model)
  assert.equal(options.env.ANTHROPIC_API_KEY, 'native-hermes-key')
  assert.equal(options.env.CURRENT_RUN, '1')
})

test('manual Agent refreshes remain serialized', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-refresh-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const firstGate = deferred()
  const secondGate = deferred()
  const { harness } = loadMain(directory, {
    onRefresh: async (_workspace, count) => {
      if (count === 2) await firstGate.promise
      if (count === 3) await secondGate.promise
    },
  })
  await harness.ready()
  const handler = harness.ipcHandlers.get('local-workspace:refresh-agents')

  const first = handler(harness.event())
  const second = handler(harness.event())
  await waitFor(() => harness.workspaceInstances[0].refreshCount === 2)
  assert.equal(harness.workspaceInstances[0].maxConcurrentRefreshes, 1)

  firstGate.resolve()
  await waitFor(() => harness.workspaceInstances[0].refreshCount === 3)
  assert.equal(harness.workspaceInstances[0].maxConcurrentRefreshes, 1)
  secondGate.resolve()
  await Promise.all([first, second])
  assert.equal(harness.workspaceInstances[0].clearRuntimeCredentialFailuresCount, 2)
})

test('before-quit waits for local workspace and installer cleanup', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-quit-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspaceStopGate = deferred()
  const installerIdleGate = deferred()
  const { harness } = loadMain(directory, {
    workspaceStopGate,
    installerIdleGate,
    installerState: { phase: 'installing', canCancel: true, taskId: 'task-1' },
  })
  await harness.ready()
  let prevented = 0

  harness.appListeners.get('before-quit')({ preventDefault: () => { prevented += 1 } })
  assert.equal(prevented, 1)
  assert.deepEqual(harness.installerInstances[0].cancelled, ['task-1'])
  assert.equal(harness.quitCount, 0)

  workspaceStopGate.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(harness.quitCount, 0)
  installerIdleGate.resolve()
  await waitFor(() => harness.quitCount === 1)
  assert.equal(harness.workspaceInstances[0].stopCount, 1)
})
