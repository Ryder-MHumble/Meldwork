const electron = require('electron')
const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = electron
const path = require('node:path')
const { fileURLToPath } = require('node:url')
const { detectAgents, runAgent } = require('./cli-adapters.cjs')
const { AgentInstaller } = require('./agent-installer.cjs')
const {
  nativeCredentialEnvironment,
  resolveNativeCredentialState,
} = require('./local-agent-readiness.cjs')
const { LocalWorkspace } = require('./local-workspace.cjs')
const { managedOpenClawOptions } = require('./openclaw-runtime.cjs')
const { ProviderStore } = require('./provider-store.cjs')

const SHARED_PROVIDER_KINDS = new Set(['hermes', 'openclaw', 'workbuddy', 'qwen'])
let mainWindow = null
let workspace = null
let workspaceChangedListener = null
let installer = null
let localAgentRefreshQueue = Promise.resolve()
let providerStore = null
let quitAfterCleanup = false
let quitCleanup = null

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

function isCurrentMainFrame(event, expectedWebContents) {
  const senderFrame = event?.senderFrame
  const mainFrame = event?.sender?.mainFrame
  return Boolean(
    expectedWebContents
    && event?.sender === expectedWebContents
    && senderFrame
    && mainFrame
    && senderFrame.processId === mainFrame.processId
    && senderFrame.routingId === mainFrame.routingId,
  )
}

function isTrustedLocalRenderer(event, expectedWebContents, expectedFrontendPath) {
  if (!isCurrentMainFrame(event, expectedWebContents)) return false
  try {
    const senderUrl = new URL(event.senderFrame.url)
    return senderUrl.protocol === 'file:'
      && path.resolve(fileURLToPath(senderUrl)) === path.resolve(expectedFrontendPath)
  } catch {
    return false
  }
}

function isTrustedLocalWebContents(webContents, expectedFrontendPath = frontendPath()) {
  if (!webContents?.mainFrame) return false
  return isTrustedLocalRenderer(
    { sender: webContents, senderFrame: webContents.mainFrame },
    webContents,
    expectedFrontendPath,
  )
}

function requireDesktopRenderer(event) {
  if (!isTrustedLocalRenderer(event, mainWindow?.webContents, frontendPath())) {
    throw new Error('DESKTOP_CLIENT_ACCESS_DENIED')
  }
}

function registerTrustedHandle(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    requireDesktopRenderer(event)
    return handler(...args)
  })
}

function isAllowedExternalUrl(value) {
  try {
    const target = new URL(value)
    return target.protocol === 'https:' && !target.username && !target.password
  } catch {
    return false
  }
}

function isAllowedLocalNavigation(value, allowedPaths = [frontendPath(), offlinePath()]) {
  try {
    const target = new URL(value)
    if (target.protocol !== 'file:') return false
    const targetPath = path.resolve(fileURLToPath(target))
    return allowedPaths.some(candidate => targetPath === path.resolve(candidate))
  } catch {
    return false
  }
}

function openExternalUrl(value) {
  if (!isAllowedExternalUrl(value)) return false
  Promise.resolve(shell.openExternal(value)).catch(() => {})
  return true
}

function providerOptionsFor(kind, generic, context = {}) {
  if (kind === 'hermes') {
    return {
      provider: { id: 'openai-api', model: generic.OPENAI_MODEL },
      env: { ...generic, HERMES_INFERENCE_MODEL: generic.OPENAI_MODEL },
    }
  }
  if (kind === 'workbuddy') {
    return {
      env: {
        CODEBUDDY_MODEL: generic.OPENAI_MODEL,
        CODEBUDDY_API_KEY: generic.OPENAI_API_KEY,
        CODEBUDDY_BASE_URL: generic.OPENAI_BASE_URL,
      },
    }
  }
  if (kind === 'qwen') return { provider: { id: 'openai', model: generic.OPENAI_MODEL }, env: generic }
  if (kind === 'openclaw' && context.storageRoot && context.workdir) {
    return managedOpenClawOptions({
      storageRoot: context.storageRoot,
      workdir: context.workdir,
      sessionRef: context.sessionRef,
      allowWrite: context.sandbox === 'workspace-write',
      provider: generic,
    })
  }
  return {}
}

function providerOptions(kind, context = {}) {
  if (!SHARED_PROVIDER_KINDS.has(kind)) return {}
  if (!providerStore?.status().configured) {
    if (kind === 'openclaw') throw new Error('PROVIDER_CREDENTIAL_REQUIRED')
    return {}
  }
  return providerOptionsFor(
    kind,
    providerStore.envForAgent(),
    context,
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

function createWorkspace() {
  return new LocalWorkspace({
    storagePath: workspaceStoragePath(),
    detectAgents,
    credentialState: (kind, agent) => {
      if (kind === 'openclaw' && !providerStore?.status().configured) {
        return { state: 'missing', source: 'shared-provider-required' }
      }
      return resolveNativeCredentialState(kind, { executable: agent?.executable })
    },
    sharedProviderReady: kind => SHARED_PROVIDER_KINDS.has(kind) && providerStore.status().configured,
    runAgent: async (agent, prompt, workdir, options = {}) => {
      const injected = providerOptions(agent.kind, {
        ...options,
        workdir,
        storageRoot: app.getPath('userData'),
      })
      const nativeEnv = nativeCredentialEnvironment(agent.kind)
      return runAgent(agent, prompt, workdir, {
        ...options,
        ...injected,
        env: { ...nativeEnv, ...options.env, ...injected.env },
      })
    },
  })
}

async function localAgentCatalog() {
  const catalog = await installer.catalog()
  const states = new Map((workspace?.snapshot().agents || []).map(agent => [agent.kind, agent]))
  return {
    ...catalog,
    agents: catalog.agents.map((agent) => {
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
  next.on('changed', workspaceChangedListener)
  return next
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    title: 'RoundRelay',
    backgroundColor: '#f6f3ed',
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
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  loadFrontend()
}

function registerIpc() {
  registerTrustedHandle('local-workspace:get', () => {
    if (!workspace) throw new Error('LOCAL_WORKSPACE_UNAVAILABLE')
    return workspace.snapshot()
  })
  registerTrustedHandle('local-workspace:refresh-agents', async () => {
    if (!workspace) throw new Error('LOCAL_WORKSPACE_UNAVAILABLE')
    workspace.clearRuntimeCredentialFailures()
    installer.invalidateDetectionCache()
    return refreshLocalAgentState()
  })
  registerTrustedHandle('local-workspace:create-group', (input) => {
    if (!workspace) throw new Error('LOCAL_WORKSPACE_UNAVAILABLE')
    return workspace.createGroup(input || {})
  })
  registerTrustedHandle('local-workspace:update-group', (groupId, input) => {
    if (!workspace) throw new Error('LOCAL_WORKSPACE_UNAVAILABLE')
    return workspace.updateGroup(String(groupId || ''), input || {})
  })
  registerTrustedHandle('local-workspace:delete-group', (groupId) => {
    if (!workspace) throw new Error('LOCAL_WORKSPACE_UNAVAILABLE')
    workspace.deleteGroup(String(groupId || ''))
    return workspace.snapshot()
  })
  registerTrustedHandle('local-workspace:send', async (input) => {
    if (!workspace) throw new Error('LOCAL_WORKSPACE_UNAVAILABLE')
    return workspace.sendMessage(input || {})
  })
  registerTrustedHandle('local-workspace:start-auto', (input) => {
    if (!workspace) throw new Error('LOCAL_WORKSPACE_UNAVAILABLE')
    return workspace.startAuto(input || {})
  })
  registerTrustedHandle('local-workspace:stop', (groupId) => {
    if (!workspace) return false
    return workspace.stop(String(groupId || ''))
  })
  registerTrustedHandle('local-workspace:pick-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled ? '' : result.filePaths[0]
  })
  registerTrustedHandle('local-workspace:default-directory', () => {
    return app.getPath('documents')
  })
  registerTrustedHandle('local-agent-installer:catalog', async () => {
    return localAgentCatalog()
  })
  registerTrustedHandle('local-agent-installer:state', () => {
    return installer.state()
  })
  registerTrustedHandle('local-agent-installer:start', (kind) => {
    return installer.start(String(kind || ''))
  })
  registerTrustedHandle('local-agent-installer:cancel', (taskId) => {
    return installer.cancel(String(taskId || ''))
  })
  registerTrustedHandle('local-agent-installer:set-sidebar-visibility', (kind, visible) => {
    if (!workspace) throw new Error('LOCAL_WORKSPACE_UNAVAILABLE')
    return workspace.setSidebarVisibility(String(kind || ''), visible === true)
  })
  registerTrustedHandle('local-agent-provider:status', () => {
    return providerStore.status()
  })
  registerTrustedHandle('local-agent-provider:probe', () => {
    return providerStore.status({ probeEncryption: true })
  })
  registerTrustedHandle('local-agent-provider:save', async (input) => {
    const result = providerStore.save({
      apiKey: input?.apiKey,
      provider: input?.provider,
      baseUrl: input?.baseUrl,
      model: input?.model,
    })
    await refreshLocalAgentState()
    return result
  })
  registerTrustedHandle('local-agent-provider:delete', async () => {
    const result = providerStore.delete()
    await refreshLocalAgentState()
    return result
  })
}

app.whenReady().then(async () => {
  providerStore = new ProviderStore({
    storagePath: path.join(app.getPath('userData'), 'roundrelay-provider.json'),
    safeStorage: lazySafeStorage,
  })
  installer = new AgentInstaller({ detectAgents })
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
  registerIpc()
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]))
  createWindow()
  refreshLocalAgentState().catch(() => {})
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

module.exports = {
  isTrustedLocalRenderer,
  isTrustedLocalWebContents,
}
