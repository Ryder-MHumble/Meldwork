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
const PROVIDER_AGENT_KINDS = Object.freeze([
  'codex', 'hermes', 'openclaw', 'workbuddy', 'kimi', 'mimo', 'claude', 'gemini', 'opencode', 'qwen',
])

function pngHeader(width = 1, height = 1) {
  const bytes = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

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
  'local-agent-installer:skills',
  'local-agent-installer:state',
  'local-agent-installer:start',
  'local-agent-installer:cancel',
  'local-agent-installer:set-sidebar-visibility',
  'local-attachments:pick-images',
  'local-attachments:import-image',
  'local-attachments:preview',
  'local-attachments:discard',
  'local-agent-provider:status',
  'local-agent-provider:probe',
  'local-agent-provider:save',
  'local-agent-provider:delete',
  'local-knowledge-base:status',
  'local-knowledge-base:open-guide',
  'local-knowledge-base:pick-obsidian-vault',
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
  const knowledgeBaseStoreInstances = []
  const knowledgeBaseResolveCalls = []
  const attachmentInstances = []
  const skillCatalogInstances = []
  const runAgentCalls = []
  const externalUrls = []
  const dialogCalls = []
  const permissionHandlers = {}
  const nativeImageCalls = []
  const notificationInstances = []
  const protocolHandlers = new Map()
  const registeredSchemes = []
  let readyCallback
  let appReady = false
  let quitCount = 0
  let singleInstanceLockCalls = 0
  let attachmentConstructionCount = 0
  const providerConfiguredKinds = new Set(options.providerConfigured === true ? ['hermes'] : [])

  class TestWorkspace extends EventEmitter {
    constructor(input) {
      super()
      this.input = input
      this.state = structuredClone(options.workspaceSnapshot || {
        agents: [], groups: [], messages: [], localOnly: true,
      })
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

    snapshot() { return this.state }
    clearRuntimeCredentialFailures() { this.clearRuntimeCredentialFailuresCount += 1 }
    createGroup() { return this.snapshot() }
    updateGroup() { return this.snapshot() }
    deleteGroup(groupId) {
      this.state.groups = this.state.groups.filter(group => group.id !== groupId)
      this.state.messages = this.state.messages.filter(message => message.groupId !== groupId)
    }
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
      this.pendingCancelCount = 0
      this.invalidateCount = 0
      this.detectedCount = 0
      installerInstances.push(this)
    }

    catalog() { return Promise.resolve({ agents: [] }) }
    skills(kind) {
      this.skillsKind = kind
      return Promise.resolve(options.skillsResult || {
        supported: true, total: 0, limit: 100, skills: [],
      })
    }
    detectedAgents() {
      this.detectedCount += 1
      return Promise.resolve(options.detectedAgents || [])
    }
    state() { return options.installerState || { phase: 'idle', canCancel: false } }
    start() { return this.state() }
    cancel(taskId) { this.cancelled.push(taskId); return true }
    cancelPending() { this.pendingCancelCount += 1; return true }
    invalidateDetectionCache() { this.invalidateCount += 1 }
    async waitForIdle() {
      if (options.installerIdleGate) await options.installerIdleGate.promise
    }
  }

  class TestAttachmentStore {
    constructor(input) {
      attachmentConstructionCount += 1
      if (options.attachmentInitError) throw options.attachmentInitError
      this.input = input
      this.cleanupCalls = []
      this.importedBuffers = []
      this.importedFiles = []
      this.discarded = []
      this.resolved = []
      this.readWithMetadataCalls = []
      this.metadataById = new Map()
      this.nextId = 0
      attachmentInstances.push(this)
    }

    metadata(name = 'diagram.png', mimeType = 'image/png', size = 3) {
      const metadata = { id: `attachment-${++this.nextId}`, name, mimeType, size }
      this.metadataById.set(metadata.id, metadata)
      return metadata
    }

    importBuffer(input) {
      this.importedBuffers.push(input)
      return this.metadata(input.name, input.mimeType, input.bytes?.length || 3)
    }

    importFile(filename) {
      this.importedFiles.push(filename)
      return this.metadata(path.basename(filename), 'image/png', 3)
    }

    resolve(refs) {
      this.resolved.push(refs)
      return refs.map((ref) => {
        const metadata = typeof ref === 'string'
          ? this.metadataById.get(ref)
            || { id: ref, name: 'diagram.png', mimeType: 'image/png', size: 3 }
          : ref
        return {
          ...metadata,
          path: path.join(userData, 'attachments', metadata.id, 'image.png'),
        }
      })
    }

    readWithMetadata(id) {
      this.readWithMetadataCalls.push(id)
      return {
        metadata: options.mediaMetadata || this.metadataById.get(id)
          || { id, name: 'diagram.png', mimeType: 'image/png', size: 3 },
        bytes: options.mediaBytes || options.attachmentBytes || pngHeader(),
      }
    }
    discard(refs) {
      this.discarded.push(refs)
      return refs.map(ref => typeof ref === 'string' ? ref : ref.id)
    }
    cleanup(refs) {
      this.cleanupCalls.push([...refs])
      if (options.attachmentCleanupError) throw options.attachmentCleanupError
      return { discardedIds: [], removedTemporaryEntries: 0 }
    }
  }

  class TestLocalSkillCatalog {
    constructor(input) {
      this.input = input
      this.invalidateCalls = 0
      this.listCalls = []
      this.validationCalls = []
      skillCatalogInstances.push(this)
    }

    invalidate() {
      this.invalidateCalls += 1
    }

    list(kind) {
      this.listCalls.push(kind)
      return options.skillsResult || { supported: true, total: 0, limit: 100, skills: [] }
    }

    validateSelections(kind, selections) {
      this.validationCalls.push({ kind, selections })
      return selections
    }
  }

  class TestProviderStore {
    constructor(input) {
      this.input = input
      this.saved = []
      this.deleted = []
      this.statusCalls = []
      providerInstances.push(this)
    }

    status(kind, input) {
      this.statusCalls.push({ kind, input })
      return providerConfiguredKinds.has(kind)
        ? { ...PROVIDER_METADATA, encryptionAvailable: true, configured: true }
        : {
            provider: '', baseUrl: '', model: '',
            encryptionAvailable: true, configured: false,
          }
    }

    save(kind, input) {
      this.saved.push({ kind, input })
      providerConfiguredKinds.add(kind)
      return this.status(kind)
    }

    delete(kind) {
      this.deleted.push(kind)
      providerConfiguredKinds.delete(kind)
      return this.status(kind)
    }

    envForAgent(kind) {
      assert.equal(providerConfiguredKinds.has(kind), true)
      return options.providerEnv || {
        OPENAI_API_KEY: 'provider-key',
        OPENAI_BASE_URL: PROVIDER_METADATA.baseUrl,
        OPENAI_MODEL: PROVIDER_METADATA.model,
      }
    }
  }

  class TestKnowledgeBaseStore {
    constructor(input) {
      this.input = input
      this.savedVaultPaths = []
      this.vaultPath = options.obsidianVaultPath || ''
      knowledgeBaseStoreInstances.push(this)
    }

    state() {
      return {
        version: 1,
        obsidianVaultPath: this.vaultPath,
      }
    }

    saveObsidianVaultPath(value) {
      this.vaultPath = String(value || '')
      this.savedVaultPaths.push(this.vaultPath)
      return {
        version: 1,
        obsidianVaultPath: this.vaultPath,
      }
    }
  }

  class TestBrowserWindow {
    constructor(input) {
      this.input = input
      this.loads = []
      this.windowListeners = new Map()
      this.focused = options.windowFocused !== false
      this.minimized = options.windowMinimized === true
      this.focusCount = 0
      this.restoreCount = 0
      this.showCount = 0
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
    isFocused() { return this.focused }
    isMinimized() { return this.minimized }
    focus() { this.focused = true; this.focusCount += 1 }
    restore() { this.minimized = false; this.restoreCount += 1 }
    show() { this.showCount += 1 }

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

  class TestNotification extends EventEmitter {
    constructor(input) {
      super()
      this.input = input
      this.showCount = 0
      notificationInstances.push(this)
    }

    show() { this.showCount += 1 }
  }
  TestNotification.isSupported = () => options.notificationSupported !== false

  const electron = {
    app: {
      getPath: name => name === 'documents'
        ? path.join(userData, 'Documents')
        : name === 'home' ? path.join(userData, 'Home') : userData,
      getLocale: () => options.locale || 'en-US',
      isPackaged: false,
      isReady: () => appReady,
      on: (name, listener) => appListeners.set(name, listener),
      quit: () => { quitCount += 1 },
      requestSingleInstanceLock: () => {
        singleInstanceLockCalls += 1
        return options.singleInstanceLock !== false
      },
      whenReady: () => ({ then: listener => { readyCallback = listener } }),
    },
    BrowserWindow: TestBrowserWindow,
    Notification: TestNotification,
    dialog: {
      showOpenDialog: async (...args) => {
        dialogCalls.push(args)
        return options.dialogResult || { canceled: true, filePaths: [] }
      },
    },
    ipcMain: {
      handle: (name, listener) => ipcHandlers.set(name, listener),
      on: (name, listener) => ipcListeners.set(name, listener),
    },
    protocol: {
      registerSchemesAsPrivileged: schemes => registeredSchemes.push(...schemes),
      handle: (scheme, listener) => protocolHandlers.set(scheme, listener),
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
    nativeImage: {
      createFromBuffer: (bytes) => {
        nativeImageCalls.push(bytes)
        const image = {
          isEmpty: () => false,
          getSize: () => options.nativeImageSize || { width: 640, height: 320 },
          resize: () => image,
          toDataURL: () => 'data:image/png;base64,AQID',
        }
        return image
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
      imageAttachmentLimit: kind => ({ codex: 4, hermes: 1, opencode: 4 })[kind] || 0,
      runAgent: async (...args) => {
        runAgentCalls.push(args)
        return { text: 'local reply', sessionRef: 'local-session' }
      },
    },
    './agent-installer.cjs': { AgentInstaller: TestInstaller },
    './attachment-store.cjs': { AttachmentStore: TestAttachmentStore },
    './local-agent-readiness.cjs': {
      nativeCredentialEnvironment: kind => options.nativeEnvironment?.(kind) || {},
      resolveNativeCredentialState: async () => ({ state: 'ready', source: 'native-credential' }),
    },
    './local-workspace.cjs': { LocalWorkspace: TestWorkspace },
    './local-skill-catalog.cjs': { LocalSkillCatalog: TestLocalSkillCatalog },
    './openclaw-runtime.cjs': {
      managedOpenClawOptions: input => ({ env: { MANAGED_OPENCLAW: JSON.stringify(input) } }),
    },
    './provider-store.cjs': { ProviderStore: TestProviderStore },
    './knowledge-base-store.cjs': { KnowledgeBaseStore: TestKnowledgeBaseStore },
    './local-knowledge-base.cjs': {
      knowledgeBaseGuideUrl: (kind, action) => (
        options.knowledgeBaseGuideUrl?.(kind, action) || `https://example.com/${kind}/${action}`
      ),
      resolveKnowledgeBaseSources: async (input) => {
        knowledgeBaseResolveCalls.push(input)
        return options.knowledgeBaseSources || [{
          kind: 'obsidian',
          installed: true,
          vaultPath: input.store?.state?.().obsidianVaultPath || '',
        }]
      },
    },
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
        attachmentInstances,
        get attachmentConstructionCount() { return attachmentConstructionCount },
        ipcHandlers,
        ipcListeners,
        installerInstances,
        nativeImageCalls,
        notificationInstances,
        knowledgeBaseResolveCalls,
        knowledgeBaseStoreInstances,
        dialogCalls,
        externalUrls,
        permissionHandlers,
        protocolHandlers,
        registeredSchemes,
        providerInstances,
        runAgentCalls,
        skillCatalogInstances,
        windows,
        workspaceInstances,
        get quitCount() { return quitCount },
        get readyRegistered() { return typeof readyCallback === 'function' },
        get singleInstanceLockCalls() { return singleInstanceLockCalls },
        event: () => {
          const sender = windows.at(-1)?.webContents
          return { sender, senderFrame: sender ? { ...sender.mainFrame } : null }
        },
        ready: async () => {
          assert.equal(typeof readyCallback, 'function')
          appReady = true
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

test('a second desktop process exits before ready initialization', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-single-instance-denied-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory, { singleInstanceLock: false })

  assert.equal(harness.singleInstanceLockCalls, 1)
  assert.equal(harness.quitCount, 1)
  assert.equal(harness.readyRegistered, false)
  assert.equal(harness.workspaceInstances.length, 0)
  assert.equal(harness.windows.length, 0)
})

test('controlled media protocol serves attachment bytes with range support and rejects invalid ids', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-media-protocol-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const mediaBytes = Buffer.from('ID3-audio-payload')
  const { harness } = loadMain(directory, {
    mediaMetadata: {
      id: 'generated-audio', name: 'briefing.mp3', mimeType: 'audio/mpeg', size: mediaBytes.length,
    },
    mediaBytes,
  })

  assert.equal(harness.registeredSchemes.some(entry => (
    entry.scheme === 'meldwork-media'
      && entry.privileges?.secure === true
      && entry.privileges?.standard === true
  )), true)
  await harness.ready()
  const handler = harness.protocolHandlers.get('meldwork-media')
  assert.equal(typeof handler, 'function')

  const response = await handler(new Request(
    'meldwork-media://attachment/generated-audio',
    { headers: { Range: 'bytes=4-8' } },
  ))
  assert.equal(response.status, 206)
  assert.equal(response.headers.get('content-type'), 'audio/mpeg')
  assert.equal(response.headers.get('content-range'), `bytes 4-8/${mediaBytes.length}`)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), mediaBytes.subarray(4, 9))

  const readsBeforeInvalid = harness.attachmentInstances[0].readWithMetadataCalls.length
  const invalid = await handler(new Request('meldwork-media://attachment/..%2Fsecret'))
  assert.equal(invalid.status, 404)
  assert.equal(harness.attachmentInstances[0].readWithMetadataCalls.length, readsBeforeInvalid)
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
  assert.equal(harness.workspaceInstances[0].refreshCount, 0)
  assert.equal(harness.providerInstances[0].input.storagePath,
    path.join(directory, 'roundrelay-provider.json'))
  assert.deepEqual(
    [...harness.providerInstances[0].input.allowedKinds].sort(),
    [...PROVIDER_AGENT_KINDS].sort(),
  )
  assert.equal(harness.knowledgeBaseStoreInstances[0].input.storagePath,
    path.join(directory, 'roundrelay-knowledge-base.json'))
  assert.equal(harness.attachmentInstances[0].input.rootPath,
    path.join(directory, 'attachments'))
  assert.equal(harness.skillCatalogInstances[0].input.home,
    path.join(directory, 'Home'))
  await harness.workspaceInstances[0].input.detectAgents()
  assert.equal(harness.installerInstances[0].detectedCount, 1)
  assert.equal(typeof harness.workspaceInstances[0].input.resolveAttachments, 'function')
  assert.equal(typeof harness.workspaceInstances[0].input.validateSkillSelections, 'function')
  assert.equal(typeof harness.workspaceInstances[0].input.imageAttachmentLimit, 'function')
  assert.deepEqual(harness.attachmentInstances[0].cleanupCalls, [[]])
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

test('a second desktop launch restores and focuses the existing window', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-single-instance-focus-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory, {
    windowFocused: false,
    windowMinimized: true,
  })
  await harness.ready()

  harness.appListeners.get('second-instance')()

  assert.equal(harness.windows.length, 1)
  assert.equal(harness.windows[0].restoreCount, 1)
  assert.equal(harness.windows[0].showCount, 1)
  assert.equal(harness.windows[0].focusCount, 1)
})

test('run completion uses sanitized renderer events and a localized background notification', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-notification-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory, { locale: 'zh-CN', windowFocused: false })
  await harness.ready()
  const window = harness.windows[0]
  const workspace = harness.workspaceInstances[0]

  workspace.emit('run-finished', {
    groupId: 'group-1',
    mode: 'auto',
    status: 'partial',
    threadRootId: 'thread-1',
    targetKinds: ['hermes', '../../private', 'hermes'],
    completedKinds: ['hermes'],
    startedAt: 100,
    finishedAt: 200,
    path: '/private/workspace',
    sessionRef: 'secret-session',
    content: 'secret message body',
  })

  const finished = window.webContents.sent.find(([channel]) => (
    channel === 'local-workspace:run-finished'
  ))
  assert.deepEqual(finished, ['local-workspace:run-finished', {
    groupId: 'group-1',
    mode: 'auto',
    status: 'partial',
    threadRootId: 'thread-1',
    targetKinds: ['hermes'],
    completedKinds: ['hermes'],
    startedAt: 100,
    finishedAt: 200,
  }])
  assert.equal(harness.notificationInstances.length, 1)
  const notification = harness.notificationInstances[0]
  assert.deepEqual(notification.input, {
    title: 'Meldwork',
    body: '会话运行已结束',
  })
  assert.equal(notification.showCount, 1)
  assert.doesNotMatch(
    JSON.stringify(notification.input),
    /private|secret-session|secret message|group-1|thread-1/,
  )

  notification.emit('click')
  assert.equal(window.showCount, 1)
  assert.equal(window.focusCount, 1)
  assert.deepEqual(window.webContents.sent.at(-1), [
    'local-workspace:open-group', { groupId: 'group-1' },
  ])

  workspace.emit('run-finished', {
    groupId: 'group-1', status: 'completed', targetKinds: [], completedKinds: [],
  })
  assert.equal(harness.notificationInstances.length, 1)
})

test('a completion notification restores a closed window and opens its local group', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-notification-restore-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory)
  await harness.ready()
  const originalWindow = harness.windows[0]
  const workspace = harness.workspaceInstances[0]
  originalWindow.windowListeners.get('closed')()

  workspace.emit('run-finished', {
    groupId: 'group-restore',
    status: 'completed',
    targetKinds: ['codex'],
    completedKinds: ['codex'],
  })

  assert.equal(harness.notificationInstances.length, 1)
  assert.deepEqual(harness.notificationInstances[0].input, {
    title: 'Meldwork',
    body: 'Conversation run finished',
  })
  assert.equal(originalWindow.webContents.sent.length, 0)

  harness.notificationInstances[0].emit('click')

  assert.equal(harness.windows.length, 2)
  const restoredWindow = harness.windows[1]
  assert.equal(restoredWindow.showCount, 1)
  assert.equal(restoredWindow.focusCount, 1)
  assert.deepEqual(restoredWindow.webContents.sent.at(-1), [
    'local-workspace:open-group', { groupId: 'group-restore' },
  ])
})

test('attachment storage initialization failure does not block text chat startup', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-attachment-fallback-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory, {
    attachmentInitError: new Error('sensitive local storage path'),
  })

  await harness.ready()

  assert.equal(harness.attachmentConstructionCount, 1)
  assert.equal(harness.attachmentInstances.length, 0)
  assert.equal(harness.windows.length, 1)
  await assert.doesNotReject(
    harness.ipcHandlers.get('local-workspace:send')(
      harness.event(),
      { groupId: 'group-1', text: 'text still works', attachments: [] },
    ),
  )
  for (const [channel, args] of [
    ['local-attachments:pick-images', []],
    ['local-attachments:import-image', [{ name: 'x.png', mimeType: 'image/png', bytes: [1] }]],
    ['local-attachments:preview', ['attachment-1']],
    ['local-attachments:discard', [['attachment-1']]],
  ]) {
    await assert.rejects(
      async () => harness.ipcHandlers.get(channel)(harness.event(), ...args),
      { message: 'LOCAL_ATTACHMENT_STORAGE_UNAVAILABLE' },
    )
  }
})

test('startup attachment cleanup receives every persisted message reference once', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-attachment-cleanup-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'roundrelay-workspace.json'), JSON.stringify({
    version: 2,
    groups: [{ id: 'one' }, { id: 'two' }],
    messages: [
      { groupId: 'one', attachments: [{ id: 'shared' }, { id: 'only-one' }] },
      { groupId: 'two', attachments: [{ id: 'shared' }] },
    ],
    sessions: {},
  }))
  const { harness } = loadMain(directory, {
    workspaceSnapshot: {
      agents: [],
      groups: [{ id: 'one' }, { id: 'two' }],
      messages: [
        { groupId: 'one', attachments: [{ id: 'shared' }, { id: 'only-one' }] },
        { groupId: 'two', attachments: [{ id: 'shared' }] },
      ],
      localOnly: true,
    },
  })

  await harness.ready()

  assert.deepEqual(harness.attachmentInstances[0].cleanupCalls, [['shared', 'only-one']])
})

test('startup attachment cleanup failure keeps the validated store available', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-attachment-cleanup-fallback-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory, {
    attachmentCleanupError: new Error('temporary cleanup failure'),
  })

  await harness.ready()

  assert.deepEqual(harness.attachmentInstances[0].cleanupCalls, [[]])
  await assert.doesNotReject(
    harness.ipcHandlers.get('local-attachments:pick-images')(harness.event(), 1),
  )
})

test('startup skips destructive attachment cleanup when the workspace file is malformed', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-attachment-corrupt-workspace-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'roundrelay-workspace.json'), '{not-json')
  const { harness } = loadMain(directory)

  await harness.ready()

  assert.equal(harness.windows.length, 1)
  assert.deepEqual(harness.attachmentInstances[0].cleanupCalls, [])
})

test('ready creates the desktop window without eagerly duplicating renderer Agent detection', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-ready-window-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory)

  await harness.ready()
  assert.equal(harness.windows.length, 1)
  assert.equal(harness.workspaceInstances[0].refreshCount, 0)
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

  const initial = await harness.ipcHandlers.get('local-agent-provider:status')(
    harness.event(), 'hermes',
  )
  assert.equal(initial.configured, false)
  assert.deepEqual(harness.providerInstances[0].statusCalls, [{ kind: 'hermes', input: undefined }])

  await harness.ipcHandlers.get('local-agent-provider:probe')(harness.event(), 'hermes')
  assert.deepEqual(harness.providerInstances[0].statusCalls, [
    { kind: 'hermes', input: undefined },
    { kind: 'hermes', input: { probeEncryption: true } },
  ])

  const saved = await harness.ipcHandlers.get('local-agent-provider:save')(
    harness.event(), 'hermes', input,
  )
  assert.deepEqual(harness.providerInstances[0].saved, [{ kind: 'hermes', input }])
  assert.equal(saved.configured, true)
  assert.equal(harness.workspaceInstances[0].refreshCount, 1)

  await assert.rejects(
    async () => harness.ipcHandlers.get('local-agent-provider:status')(harness.event(), 'not-an-agent'),
    { message: 'PROVIDER_AGENT_UNSUPPORTED' },
  )

  const deleted = await harness.ipcHandlers.get('local-agent-provider:delete')(
    harness.event(), 'hermes',
  )
  assert.deepEqual(harness.providerInstances[0].deleted, ['hermes'])
  assert.equal(deleted.configured, false)
  assert.equal(harness.workspaceInstances[0].refreshCount, 2)
})

test('Knowledge base IPC exposes status, safe guides, and a local Obsidian directory picker', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-knowledge-base-ipc-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const vaultPath = path.join(directory, 'Obsidian Vault')
  const { harness } = loadMain(directory, {
    dialogResult: { canceled: false, filePaths: [vaultPath] },
    knowledgeBaseGuideUrl: (kind, action) => (
      kind === 'unsafe'
        ? 'http://example.com/unsafe'
        : `https://example.com/${kind}/${action}`
    ),
  })
  await harness.ready()

  const status = await harness.ipcHandlers.get('local-knowledge-base:status')(harness.event())
  assert.deepEqual(status, [{ kind: 'obsidian', installed: true, vaultPath: '' }])
  assert.equal(harness.knowledgeBaseResolveCalls[0].home, path.join(directory, 'Home'))

  const opened = await harness.ipcHandlers.get('local-knowledge-base:open-guide')(
    harness.event(), 'feishu', 'login',
  )
  assert.equal(opened, true)
  assert.deepEqual(harness.externalUrls, ['https://example.com/feishu/login'])

  const unsafe = await harness.ipcHandlers.get('local-knowledge-base:open-guide')(
    harness.event(), 'unsafe', 'login',
  )
  assert.equal(unsafe, false)
  assert.deepEqual(harness.externalUrls, ['https://example.com/feishu/login'])

  const picked = await harness.ipcHandlers.get('local-knowledge-base:pick-obsidian-vault')(
    harness.event(),
  )
  assert.deepEqual(harness.dialogCalls[0][1], {
    properties: ['openDirectory', 'createDirectory'],
  })
  assert.deepEqual(harness.knowledgeBaseStoreInstances[0].savedVaultPaths, [vaultPath])
  assert.deepEqual(picked, [{ kind: 'obsidian', installed: true, vaultPath }])
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

test('Skills IPC uses the installed-Agent gate and the shared local catalog', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-skills-ipc-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const skillsResult = {
    supported: true,
    total: 1,
    limit: 100,
    skills: [{ targetKind: 'codex', namespace: 'global', slug: 'review', name: 'Review' }],
  }
  const { harness } = loadMain(directory, { skillsResult })
  await harness.ready()

  const result = await harness.ipcHandlers.get('local-agent-installer:skills')(
    harness.event(), 'codex',
  )

  assert.deepEqual(result, skillsResult)
  assert.equal(harness.installerInstances[0].skillsKind, 'codex')
  assert.deepEqual(harness.installerInstances[0].input.listSkills('codex'), skillsResult)
  assert.deepEqual(harness.skillCatalogInstances[0].listCalls, ['codex'])
})

test('image IPC returns bounded previews and never exposes imported file paths', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-image-ipc-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const first = path.join(directory, 'diagram.png')
  const second = path.join(directory, 'flow.png')
  const third = path.join(directory, 'overflow.png')
  const { harness } = loadMain(directory, {
    dialogResult: { canceled: false, filePaths: [first, second, third] },
  })
  await harness.ready()

  const picked = await harness.ipcHandlers.get('local-attachments:pick-images')(
    harness.event(), 2,
  )
  assert.equal(picked.attachments.length, 2)
  assert.equal(picked.truncated, true)
  assert.deepEqual(harness.attachmentInstances[0].importedFiles, [first, second])
  assert.deepEqual(harness.dialogCalls[0][1], {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
  })
  for (const attachment of picked.attachments) {
    assert.deepEqual(Object.keys(attachment).sort(), [
      'id', 'mimeType', 'name', 'previewDataUrl', 'size',
    ])
    assert.equal(attachment.previewDataUrl, 'data:image/png;base64,AQID')
    assert.equal(JSON.stringify(attachment).includes(directory), false)
  }

  const imported = await harness.ipcHandlers.get('local-attachments:import-image')(
    harness.event(),
    { name: 'paste.png', mimeType: 'image/png', bytes: [1, 2, 3] },
  )
  assert.equal(imported.name, 'paste.png')
  assert.equal(imported.previewDataUrl, 'data:image/png;base64,AQID')
  assert.deepEqual(harness.attachmentInstances[0].importedBuffers, [
    { name: 'paste.png', mimeType: 'image/png', bytes: [1, 2, 3] },
  ])

  const previewed = await harness.ipcHandlers.get('local-attachments:preview')(
    harness.event(), picked.attachments[0].id,
  )
  assert.equal(previewed.previewDataUrl, 'data:image/png;base64,AQID')
  assert.deepEqual(harness.attachmentInstances[0].readWithMetadataCalls, [
    picked.attachments[0].id,
    picked.attachments[1].id,
    imported.id,
    picked.attachments[0].id,
  ])
  assert.deepEqual(harness.attachmentInstances[0].resolved, [])
  assert.equal('path' in previewed, false)
})

test('image picker does not import files after application shutdown starts', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-image-shutdown-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const dialogResult = deferred()
  const selected = path.join(directory, 'late-selection.png')
  const { harness } = loadMain(directory, { dialogResult: dialogResult.promise })
  await harness.ready()

  const picking = harness.ipcHandlers.get('local-attachments:pick-images')(harness.event())
  await waitFor(() => harness.dialogCalls.length === 1)
  harness.appListeners.get('before-quit')({ preventDefault: () => {} })
  dialogResult.resolve({ canceled: false, filePaths: [selected] })

  await assert.rejects(picking, { message: 'DESKTOP_CLIENT_SHUTTING_DOWN' })
  assert.deepEqual(harness.attachmentInstances[0].importedFiles, [])
})

test('image dimensions are bounded before nativeImage decoding and checked again afterward', async (t) => {
  const firstDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-image-pixels-before-'))
  const secondDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-image-pixels-after-'))
  t.after(() => fs.rmSync(firstDirectory, { recursive: true, force: true }))
  t.after(() => fs.rmSync(secondDirectory, { recursive: true, force: true }))
  const oversizedBeforeDecode = loadMain(firstDirectory, {
    attachmentBytes: pngHeader(8193, 4096),
  })
  await oversizedBeforeDecode.harness.ready()

  await assert.rejects(
    async () => oversizedBeforeDecode.harness.ipcHandlers.get('local-attachments:import-image')(
      oversizedBeforeDecode.harness.event(),
      { name: 'large.png', mimeType: 'image/png', bytes: [1, 2, 3] },
    ),
    { message: 'LOCAL_ATTACHMENT_TOO_LARGE' },
  )
  assert.equal(oversizedBeforeDecode.harness.nativeImageCalls.length, 0)
  assert.equal(oversizedBeforeDecode.harness.attachmentInstances[0].discarded.length, 1)

  const oversizedAfterDecode = loadMain(secondDirectory, {
    attachmentBytes: pngHeader(1, 1),
    nativeImageSize: { width: 8193, height: 4096 },
  })
  await oversizedAfterDecode.harness.ready()
  await assert.rejects(
    async () => oversizedAfterDecode.harness.ipcHandlers.get('local-attachments:import-image')(
      oversizedAfterDecode.harness.event(),
      { name: 'decoded-large.png', mimeType: 'image/png', bytes: [1, 2, 3] },
    ),
    { message: 'LOCAL_ATTACHMENT_TOO_LARGE' },
  )
  assert.equal(oversizedAfterDecode.harness.nativeImageCalls.length, 1)
  assert.equal(oversizedAfterDecode.harness.attachmentInstances[0].discarded.length, 1)
})

test('discard IPC is idempotent and refuses to delete attachments referenced by messages', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-discard-ipc-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory, {
    workspaceSnapshot: {
      agents: [],
      groups: [{ id: 'group-1' }],
      messages: [{
        groupId: 'group-1',
        attachments: [{ id: 'referenced' }],
      }],
      localOnly: true,
    },
  })
  await harness.ready()
  const discard = harness.ipcHandlers.get('local-attachments:discard')

  assert.deepEqual(
    await discard(harness.event(), ['referenced', 'orphan', 'already-absent', 'orphan']),
    {
      discardedIds: ['orphan', 'already-absent'],
      retainedIds: ['referenced'],
    },
  )
  assert.deepEqual(harness.attachmentInstances[0].discarded, [
    ['orphan', 'already-absent'],
  ])
  assert.deepEqual(
    await discard(harness.event(), ['already-absent']),
    { discardedIds: ['already-absent'], retainedIds: [] },
  )
})

test('deleting a conversation removes only attachments no longer referenced elsewhere', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-delete-attachments-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory, {
    workspaceSnapshot: {
      agents: [],
      groups: [{ id: 'group-one' }, { id: 'group-two' }],
      messages: [
        {
          groupId: 'group-one',
          attachments: [{ id: 'shared' }, { id: 'only-one' }],
        },
        { groupId: 'group-two', attachments: [{ id: 'shared' }] },
      ],
      localOnly: true,
    },
  })
  await harness.ready()

  const snapshot = await harness.ipcHandlers.get('local-workspace:delete-group')(
    harness.event(), 'group-one',
  )

  assert.deepEqual(snapshot.groups, [{ id: 'group-two' }])
  assert.deepEqual(snapshot.messages, [
    { groupId: 'group-two', attachments: [{ id: 'shared' }] },
  ])
  assert.deepEqual(harness.attachmentInstances[0].discarded, [['only-one']])
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
      if (count === 1) await firstGate.promise
      if (count === 2) await secondGate.promise
    },
  })
  await harness.ready()
  const handler = harness.ipcHandlers.get('local-workspace:refresh-agents')

  const first = handler(harness.event())
  const second = handler(harness.event())
  await waitFor(() => harness.workspaceInstances[0].refreshCount === 1)
  assert.equal(harness.workspaceInstances[0].maxConcurrentRefreshes, 1)

  firstGate.resolve()
  await waitFor(() => harness.workspaceInstances[0].refreshCount === 2)
  assert.equal(harness.workspaceInstances[0].maxConcurrentRefreshes, 1)
  secondGate.resolve()
  await Promise.all([first, second])
  assert.equal(harness.workspaceInstances[0].clearRuntimeCredentialFailuresCount, 2)
  assert.equal(harness.installerInstances[0].invalidateCount, 2)
  assert.equal(harness.skillCatalogInstances[0].invalidateCalls, 2)
})

test('before-quit waits for local workspace and installer cleanup', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-quit-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspaceStopGate = deferred()
  const installerIdleGate = deferred()
  const { harness } = loadMain(directory, {
    workspaceStopGate,
    installerIdleGate,
    windowFocused: false,
    installerState: { phase: 'installing', canCancel: true, taskId: 'task-1' },
  })
  await harness.ready()
  let prevented = 0

  harness.appListeners.get('before-quit')({ preventDefault: () => { prevented += 1 } })
  assert.equal(prevented, 1)
  assert.equal(harness.installerInstances[0].pendingCancelCount, 1)
  assert.deepEqual(harness.installerInstances[0].cancelled, ['task-1'])
  assert.equal(harness.quitCount, 0)

  harness.workspaceInstances[0].emit('run-finished', {
    groupId: 'group-1', status: 'stopped', targetKinds: [], completedKinds: [],
  })
  assert.equal(harness.notificationInstances.length, 0)

  for (const channel of LOCAL_IPC_CHANNELS) {
    await assert.rejects(
      Promise.resolve().then(() => harness.ipcHandlers.get(channel)(harness.event())),
      { message: 'DESKTOP_CLIENT_SHUTTING_DOWN' },
      `${channel} should reject after shutdown starts`,
    )
  }

  workspaceStopGate.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(harness.quitCount, 0)
  installerIdleGate.resolve()
  await waitFor(() => harness.quitCount === 1)
  assert.equal(harness.workspaceInstances[0].stopCount, 1)
})
