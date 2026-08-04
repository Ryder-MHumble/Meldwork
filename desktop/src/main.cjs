const electron = require('electron')
const { app, BrowserWindow, dialog, ipcMain, Menu, Notification, protocol, shell } = electron
const path = require('node:path')
const { AttachmentStore } = require('./attachment-store.cjs')
const {
  MEDIA_SCHEME,
  attachmentIdsFromSnapshot,
  createAttachmentService,
  persistedAttachmentReferences,
} = require('./attachment-service.cjs')
const {
  captureAgentOutputState,
  importAgentOutputs,
} = require('./agent-output-importer.cjs')
const { detectAgents, imageAttachmentLimit, runAgent } = require('./cli-adapters.cjs')
const { AgentInstaller } = require('./agent-installer.cjs')
const { CustomAgentStore } = require('./custom-agent-store.cjs')
const {
  nativeCredentialEnvironment,
  resolveNativeOpenClawRuntime,
  resolveNativeCredentialState,
} = require('./local-agent-readiness.cjs')
const { LocalWorkspace } = require('./local-workspace.cjs')
const { registerDesktopIpc } = require('./main-ipc.cjs')
const {
  isAllowedExternalUrl,
  isAllowedLocalNavigation: isAllowedLocalNavigationForPaths,
  isTrustedLocalRenderer,
  isTrustedLocalWebContents: isTrustedLocalWebContentsForPath,
} = require('./main-renderer-security.cjs')
const { createRunNotificationCoordinator } = require('./main-run-notifications.cjs')
const { normalizeRunEvent } = require('./run-harness.cjs')
const { RunLedger } = require('./run-ledger.cjs')
const { LocalSkillCatalog } = require('./local-skill-catalog.cjs')
const { KnowledgeBaseStore } = require('./knowledge-base-store.cjs')
const {
  knowledgeBaseSelectionHint,
  knowledgeBaseGuideUrl,
  resolveKnowledgeBaseSources,
} = require('./local-knowledge-base.cjs')
const { ProviderStore } = require('./provider-store.cjs')
const {
  EXTERNAL_PROVIDER_KINDS,
  providerAgentKind,
  providerOptionsFor,
} = require('./provider-options.cjs')
const LOCAL_AGENT_KINDS = new Set([
  'codex', 'hermes', 'openclaw', 'workbuddy', 'kimi', 'mimo', 'claude', 'gemini', 'opencode', 'qwen',
  'opencodereview',
])
let mainWindow = null
let workspace = null
let workspaceChangedListener = null
let workspaceRunFinishedListener = null
let workspaceRunEventListener = null
let installer = null
let localAgentRefreshQueue = Promise.resolve()
let providerStore = null
let customAgentStore = null
let knowledgeBaseStore = null
let knowledgeBaseStatusPromise = null
const knowledgeBaseSourcesCache = new Map()
let attachmentStore = null
let skillCatalog = null
let shutdownStarted = false
let quitAfterCleanup = false
let quitCleanup = null
let cachedAppIcon

const attachments = createAttachmentService({
  getStore: () => attachmentStore,
  getSnapshot: () => workspace?.snapshot(),
  nativeImage: electron.nativeImage,
})

protocol?.registerSchemesAsPrivileged?.([{
  scheme: MEDIA_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
  },
}])

const lazySafeStorage = Object.freeze({
  isEncryptionAvailable: () => electron.safeStorage.isEncryptionAvailable(),
  encryptString: value => electron.safeStorage.encryptString(value),
  decryptString: value => electron.safeStorage.decryptString(value),
})

function frontendPath() {
  return app.isPackaged
    ? path.join(__dirname, '../frontend/index.html')
    : path.resolve(__dirname, '../../frontend/dist/index.html')
}

function offlinePath() {
  return path.join(__dirname, 'offline.html')
}

function appIconPath() {
  return app.isPackaged
    ? path.join(__dirname, '../frontend/logos/meldwork-app.png')
    : path.resolve(__dirname, '../../frontend/public/logos/meldwork-app.png')
}

function appIconImage() {
  if (cachedAppIcon !== undefined) return cachedAppIcon
  try {
    const image = electron.nativeImage.createFromPath(appIconPath())
    cachedAppIcon = image?.isEmpty?.() === false ? image : null
  } catch {
    cachedAppIcon = null
  }
  return cachedAppIcon
}

function isLocalAgentKind(kind) {
  return LOCAL_AGENT_KINDS.has(kind) || customAgentStore?.has(kind) === true
}

function loadFrontend() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.loadFile(frontendPath(), { hash: '/chat' }).catch(() => showOfflinePage('FRONTEND_LOAD_FAILED'))
}

function showOfflinePage(errorCode) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.loadFile(offlinePath(), {
    query: { code: String(errorCode) },
  }).catch(() => {})
}

function isTrustedLocalWebContents(webContents, expectedFrontendPath = frontendPath()) {
  return isTrustedLocalWebContentsForPath(webContents, expectedFrontendPath)
}

function requireDesktopRenderer(event) {
  if (!isTrustedLocalRenderer(event, mainWindow?.webContents, frontendPath())) {
    throw new Error('DESKTOP_CLIENT_ACCESS_DENIED')
  }
}

function registerTrustedHandle(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    requireDesktopRenderer(event)
    if (shutdownStarted) throw new Error('DESKTOP_CLIENT_SHUTTING_DOWN')
    return handler(...args)
  })
}

function isAllowedLocalNavigation(value, allowedPaths = [frontendPath(), offlinePath()]) {
  return isAllowedLocalNavigationForPaths(value, allowedPaths)
}

function openExternalUrl(value) {
  if (!isAllowedExternalUrl(value)) return false
  Promise.resolve(shell.openExternal(value)).catch(() => {})
  return true
}

function providerOptions(kind, context = {}) {
  if (!EXTERNAL_PROVIDER_KINDS.has(kind)) return {}
  const status = providerStore?.status(kind) || {}
  if (!status.configured && !(kind === 'openclaw' && context.nativeRuntime)) return {}
  return providerOptionsFor(
    kind,
    status.configured ? providerStore.envForAgent(kind) : {},
    context,
    status,
  )
}

function workspaceStoragePath(userData = app.getPath('userData')) {
  return path.join(userData, 'roundrelay-workspace.json')
}

function notifyWorkspaceChanged(snapshot) {
  if (mainWindow && !mainWindow.isDestroyed()
      && isTrustedLocalWebContents(mainWindow.webContents)) {
    mainWindow.webContents.send('local-workspace:changed', snapshot)
  }
}

function rememberKnowledgeBaseSources(sources) {
  for (const source of Array.isArray(sources) ? sources : []) {
    const kind = String(source?.kind || '')
    if (kind) knowledgeBaseSourcesCache.set(kind, source)
  }
  return sources
}

async function loadKnowledgeBaseSources(kind = '') {
  const selectedKind = String(kind || '').trim()
  if (knowledgeBaseStatusPromise) {
    const shared = await knowledgeBaseStatusPromise
    if (!selectedKind || shared.some(source => source?.kind === selectedKind)) return shared
  }
  const request = resolveKnowledgeBaseSources({
    store: knowledgeBaseStore,
    home: app.getPath('home'),
    kind: selectedKind,
  }).then(rememberKnowledgeBaseSources)
  knowledgeBaseStatusPromise = request
  try {
    return await request
  } finally {
    if (knowledgeBaseStatusPromise === request) knowledgeBaseStatusPromise = null
  }
}

async function validateKnowledgeBaseSelections(targetKinds, selections) {
  const targets = [...new Set((Array.isArray(targetKinds) ? targetKinds : [])
    .map(kind => String(kind || ''))
    .filter(isLocalAgentKind))]
  const requested = Array.isArray(selections) ? selections : []
  if (!requested.length) return []
  if (!targets.length) throw new Error('LOCAL_KNOWLEDGE_BASE_SELECTION_INVALID')
  const requestedKinds = [...new Set(requested.map(source => String(source?.kind || '')))]
  if (requestedKinds.some(kind => !knowledgeBaseSourcesCache.has(kind))) {
    await loadKnowledgeBaseSources()
  }
  return requested.map((selection) => {
    const selectionTargets = [...new Set((Array.isArray(selection?.targetKinds) ? selection.targetKinds : [])
      .map(kind => String(kind || ''))
      .filter(kind => targets.includes(kind)))]
    if (!selectionTargets.length
        || selectionTargets.length !== new Set(selection?.targetKinds || []).size) {
      throw new Error('LOCAL_KNOWLEDGE_BASE_SELECTION_INVALID')
    }
    const hint = knowledgeBaseSelectionHint(
      knowledgeBaseSourcesCache.get(String(selection?.kind || '')),
      selectionTargets,
    )
    if (!hint) throw new Error('LOCAL_KNOWLEDGE_BASE_SELECTION_INVALID')
    return hint
  })
}

function createWorkspace() {
  return new LocalWorkspace({
    storagePath: workspaceStoragePath(),
    runLedger: new RunLedger({
      storagePath: path.join(app.getPath('userData'), 'roundrelay-run-ledger.json'),
    }),
    detectAgents: async () => [
      ...await installer.detectedAgents(),
      ...await customAgentStore.detectAgents(),
    ],
    resolveAttachments: input => attachments.availableStore().resolve(input),
    captureAgentOutputs: workdir => captureAgentOutputState(workdir),
    importAgentOutputs: input => importAgentOutputs(input, attachments.availableStore()),
    validateSkillSelections: (kind, selections) => skillCatalog.validateSelections(kind, selections),
    validateKnowledgeBaseSelections,
    imageAttachmentLimit,
    attachmentSupport: kind => customAgentStore.has(kind)
      ? { image: 4, audio: 4, video: 4 }
      : { image: imageAttachmentLimit(kind) },
    credentialState: (kind, agent) => customAgentStore.has(kind)
      ? { state: 'ready', source: 'custom-agent' }
      : resolveNativeCredentialState(kind, { executable: agent?.executable }),
    agentLabel: kind => customAgentStore.label(kind),
    sharedProviderReady: kind => EXTERNAL_PROVIDER_KINDS.has(kind) && providerStore.status(kind).configured,
    runAgent: async (agent, prompt, workdir, options = {}) => {
      if (customAgentStore.has(agent.kind)) {
        return customAgentStore.run(agent.kind, prompt, workdir, {
          signal: options.signal,
          onProgress: options.onProgress,
          onEvent: options.onEvent,
          attachments: options.attachments,
        })
      }
      const status = providerStore.status(agent.kind)
      const nativeRuntime = agent.kind === 'openclaw' && !status.configured
        ? await resolveNativeOpenClawRuntime({ executable: agent.executable })
        : null
      const injected = providerOptions(agent.kind, {
        ...options,
        workdir,
        storageRoot: app.getPath('userData'),
        nativeRuntime,
      })
      const nativeEnv = agent.kind === 'openclaw'
        ? {}
        : nativeCredentialEnvironment(agent.kind)
      const callerEnv = agent.kind === 'openclaw' ? {} : options.env
      return runAgent(agent, prompt, workdir, {
        ...options,
        ...injected,
        env: { ...nativeEnv, ...callerEnv, ...injected.env },
      })
    },
  })
}

async function localAgentCatalog() {
  const [catalog, customAgents] = await Promise.all([
    installer.catalog(),
    customAgentStore.catalog(),
  ])
  const states = new Map((workspace?.snapshot().agents || []).map(agent => [agent.kind, agent]))
  return {
    ...catalog,
    agents: [...catalog.agents, ...customAgents].map((agent) => {
      const state = states.get(agent.kind)
      return {
        ...agent,
        available: Boolean(agent.installed && state?.available),
        credentialState: agent.installed ? (state?.credentialState || 'unknown') : 'missing',
        availabilitySource: agent.installed ? (state?.availabilitySource || 'unverified') : 'none',
        showInSidebar: Boolean(agent.installed && state?.showInSidebar),
      }
    }),
  }
}

async function refreshLocalAgentState() {
  const target = workspace
  if (!target) return null
  const task = localAgentRefreshQueue.then(async () => {
    if (workspace !== target) return workspace?.snapshot() || null
    const snapshot = await target.refreshAgents()
    if (workspace !== target) return workspace?.snapshot() || null
    return snapshot
  })
  localAgentRefreshQueue = task.catch(() => {})
  return task
}

function initializeWorkspace() {
  if (workspace) return workspace
  const next = createWorkspace()
  workspace = next
  workspaceChangedListener = notifyWorkspaceChanged
  workspaceRunFinishedListener = notifyRunFinished
  workspaceRunEventListener = notifyWorkspaceRunEvent
  next.on('changed', workspaceChangedListener)
  next.on('run-finished', workspaceRunFinishedListener)
  next.on('run-event', workspaceRunEventListener)
  return next
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    title: 'Meldwork',
    icon: appIconImage() || appIconPath(),
    backgroundColor: process.platform === 'darwin' ? '#e7edef' : '#f3f6f8',
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 18, y: 16 },
    } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  })
  mainWindow.webContents.session.setPermissionCheckHandler?.(() => false)
  mainWindow.webContents.session.setPermissionRequestHandler?.((
    _webContents, _permission, callback,
  ) => callback(false))
  mainWindow.webContents.session.setDevicePermissionHandler?.(() => false)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAllowedLocalNavigation(url)) return
    event.preventDefault()
    openExternalUrl(url)
  })
  mainWindow.webContents.on('did-fail-load', (
    _event, errorCode, _errorDescription, validatedUrl, isMainFrame,
  ) => {
    if (!isMainFrame || errorCode === -3) return
    try {
      if (new URL(validatedUrl).pathname.endsWith('/offline.html')) return
    } catch { /* invalid URLs fall through to the offline page */ }
    showOfflinePage(errorCode)
  })
  mainWindow.webContents.on('did-finish-load', flushPendingOpenGroup)
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  loadFrontend()
  flushPendingOpenGroup()
  return mainWindow
}

const {
  activateMainWindow,
  flushPendingOpenGroup,
  notifyRunFinished,
  notifyWorkspaceRunEvent,
} = createRunNotificationCoordinator({
  Notification,
  app,
  appIconImage,
  appIconPath,
  createWindow,
  getMainWindow: () => mainWindow,
  isLocalAgentKind,
  isShutdownStarted: () => shutdownStarted,
  isTrustedLocalWebContents,
  normalizeRunEvent,
})

function registerIpc() {
  registerDesktopIpc({
    app,
    attachmentIdsFromSnapshot,
    attachments,
    customAgentStore,
    dialog,
    getAttachmentStore: () => attachmentStore,
    getMainWindow: () => mainWindow,
    getWorkspace: () => workspace,
    installer,
    isShutdownStarted: () => shutdownStarted,
    knowledgeBaseStore,
    knowledgeBaseGuideUrl,
    loadKnowledgeBaseSources,
    localAgentCatalog,
    openExternalUrl,
    providerStore,
    providerAgentKind,
    refreshLocalAgentState,
    registerTrustedHandle,
    skillCatalog,
  })
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', activateMainWindow)

  app.whenReady().then(async () => {
    const attachmentReferences = persistedAttachmentReferences(workspaceStoragePath())
    customAgentStore = new CustomAgentStore({
      storagePath: path.join(app.getPath('userData'), 'roundrelay-custom-agents.json'),
    })
    providerStore = new ProviderStore({
      storagePath: path.join(app.getPath('userData'), 'roundrelay-provider.json'),
      safeStorage: lazySafeStorage,
      allowedKinds: [...LOCAL_AGENT_KINDS],
    })
    knowledgeBaseStore = new KnowledgeBaseStore({
      storagePath: path.join(app.getPath('userData'), 'roundrelay-knowledge-base.json'),
    })
    try {
      attachmentStore = new AttachmentStore({
        rootPath: path.join(app.getPath('userData'), 'attachments'),
      })
    } catch {
      attachmentStore = null
    }
    attachments.registerProtocol(protocol)
    skillCatalog = new LocalSkillCatalog({ home: app.getPath('home') })
    installer = new AgentInstaller({
      detectAgents,
      listSkills: kind => skillCatalog.list(kind),
    })
    installer.on('changed', state => {
      if (mainWindow && !mainWindow.isDestroyed()
          && isTrustedLocalWebContents(mainWindow.webContents)) {
        mainWindow.webContents.send('local-agent-installer:changed', state)
      }
      if (state.phase === 'completed') {
        refreshLocalAgentState().catch(() => {})
      }
    })
    initializeWorkspace()
    if (attachmentStore && attachmentReferences) {
      try {
        attachmentStore.cleanup(attachmentReferences)
      } catch { /* orphan cleanup is best effort; the validated store remains usable */ }
    }
    registerIpc()
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]))
    if (process.platform === 'darwin') {
      const icon = appIconImage()
      if (icon) app.dock?.setIcon?.(icon)
    }
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', (event) => {
    if (quitAfterCleanup) return
    event.preventDefault()
    if (quitCleanup) return
    shutdownStarted = true
    installer?.cancelPending()
    const installerState = installer?.state()
    const installRunning = Boolean(installerState?.canCancel)
    if (installRunning) installer.cancel(installerState.taskId)
    quitCleanup = Promise.allSettled([
      workspace?.stopAll() || Promise.resolve(),
      installer?.waitForIdle() || Promise.resolve(),
    ]).then(() => {
      quitAfterCleanup = true
      app.quit()
    })
  })
}

module.exports = {
  isTrustedLocalRenderer,
  isTrustedLocalWebContents,
}
