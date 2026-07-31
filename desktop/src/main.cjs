const electron = require('electron')
const { app, BrowserWindow, dialog, ipcMain, Menu, Notification, protocol, shell } = electron
const fs = require('node:fs')
const path = require('node:path')
const { fileURLToPath } = require('node:url')
const { AttachmentStore } = require('./attachment-store.cjs')
const {
  captureAgentOutputState,
  importAgentOutputs,
} = require('./agent-output-importer.cjs')
const {
  assertImagePixelLimit,
  inspectImageDimensions,
} = require('./image-dimensions.cjs')
const { detectAgents, imageAttachmentLimit, runAgent } = require('./cli-adapters.cjs')
const { AgentInstaller } = require('./agent-installer.cjs')
const {
  nativeCredentialEnvironment,
  resolveNativeCredentialState,
} = require('./local-agent-readiness.cjs')
const { LocalWorkspace } = require('./local-workspace.cjs')
const { LocalSkillCatalog } = require('./local-skill-catalog.cjs')
const { managedOpenClawOptions } = require('./openclaw-runtime.cjs')
const { KnowledgeBaseStore } = require('./knowledge-base-store.cjs')
const {
  knowledgeBaseGuideUrl,
  resolveKnowledgeBaseSources,
} = require('./local-knowledge-base.cjs')
const { ProviderStore } = require('./provider-store.cjs')

const EXTERNAL_PROVIDER_KINDS = new Set([
  'codex', 'hermes', 'openclaw', 'workbuddy', 'kimi', 'mimo', 'claude', 'gemini', 'opencode', 'qwen',
])
const MEDIA_SCHEME = 'meldwork-media'
const ATTACHMENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const MAX_ATTACHMENT_PICK_REQUEST = 4
const MAX_ATTACHMENT_DISCARD_REQUEST = 4
const RUN_FINISHED_STATUSES = new Set([
  'completed', 'partial', 'failed', 'stopped', 'timeout', 'round-limit',
])
const LOCAL_AGENT_KINDS = new Set([
  'codex', 'hermes', 'openclaw', 'workbuddy', 'kimi', 'mimo', 'claude', 'gemini', 'opencode', 'qwen',
])
const LOCAL_IDENTIFIER = /^[A-Za-z0-9_-]{1,100}$/
let mainWindow = null
let workspace = null
let workspaceChangedListener = null
let workspaceRunFinishedListener = null
let installer = null
let localAgentRefreshQueue = Promise.resolve()
let providerStore = null
let knowledgeBaseStore = null
let knowledgeBaseStatusPromise = null
let attachmentStore = null
let skillCatalog = null
let shutdownStarted = false
let quitAfterCleanup = false
let quitCleanup = null
let pendingOpenGroupId = ''

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
    if (shutdownStarted) throw new Error('DESKTOP_CLIENT_SHUTTING_DOWN')
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

const OFFICIAL_PROVIDER_BASE_URLS = Object.freeze({
  codex: 'https://api.openai.com/v1',
  hermes: 'https://api.openai.com/v1',
  openclaw: 'https://api.openai.com/v1',
  workbuddy: '',
  kimi: 'https://api.moonshot.cn/v1',
  mimo: '',
  claude: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  opencode: '',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
})

function providerPresetFromStatus(kind, status = {}) {
  if (['official', 'openrouter', 'custom'].includes(status.activePreset)) {
    return status.activePreset
  }
  const provider = String(status.provider || '').trim().toLowerCase()
  const baseUrl = String(status.baseUrl || '').trim().replace(/\/+$/, '')
  if (/openrouter/i.test(provider) || /openrouter\.ai$/i.test(new URL(baseUrl || 'https://example.com').hostname)) {
    return 'openrouter'
  }
  if (OFFICIAL_PROVIDER_BASE_URLS[kind]
      && baseUrl
      && baseUrl === OFFICIAL_PROVIDER_BASE_URLS[kind]) {
    return 'official'
  }
  return 'custom'
}

function providerOptionsFor(kind, generic, context = {}, status = {}) {
  const preset = providerPresetFromStatus(kind, status)
  if (kind === 'codex') return { env: generic }
  if (kind === 'hermes') {
    return {
      provider: { id: 'openai-api', model: generic.OPENAI_MODEL },
      env: { ...generic, HERMES_INFERENCE_MODEL: generic.OPENAI_MODEL },
    }
  }
  if (kind === 'workbuddy') {
    return {
      env: {
        ...generic,
        CODEBUDDY_MODEL: generic.OPENAI_MODEL,
        CODEBUDDY_API_KEY: generic.OPENAI_API_KEY,
        CODEBUDDY_BASE_URL: generic.OPENAI_BASE_URL,
      },
    }
  }
  if (kind === 'kimi') {
    return {
      env: {
        ...generic,
        MOONSHOT_API_KEY: generic.OPENAI_API_KEY,
        KIMI_API_KEY: generic.OPENAI_API_KEY,
        KIMI_MODEL_API_KEY: generic.OPENAI_API_KEY,
        KIMI_MODEL_BASE_URL: generic.OPENAI_BASE_URL,
        KIMI_MODEL_NAME: generic.OPENAI_MODEL,
      },
    }
  }
  if (kind === 'mimo') {
    return {
      env: {
        ...generic,
        MIMO_API_KEY: generic.OPENAI_API_KEY,
        MIMO_BASE_URL: generic.OPENAI_BASE_URL,
        MIMO_MODEL: generic.OPENAI_MODEL,
      },
    }
  }
  if (kind === 'claude') {
    return {
      env: {
        ...generic,
        ANTHROPIC_API_KEY: generic.OPENAI_API_KEY,
        ANTHROPIC_BASE_URL: generic.OPENAI_BASE_URL,
        ANTHROPIC_MODEL: generic.OPENAI_MODEL,
      },
    }
  }
  if (kind === 'gemini') {
    return {
      env: {
        ...generic,
        GEMINI_API_KEY: generic.OPENAI_API_KEY,
        GOOGLE_API_KEY: generic.OPENAI_API_KEY,
        GEMINI_MODEL: generic.OPENAI_MODEL,
      },
    }
  }
  if (kind === 'qwen') {
    return {
      provider: { id: 'openai', model: generic.OPENAI_MODEL },
      env: {
        ...generic,
        DASHSCOPE_API_KEY: generic.OPENAI_API_KEY,
      },
    }
  }
  if (kind === 'opencode') {
    return {
      env: {
        ...generic,
        ...(preset === 'openrouter' ? { OPENROUTER_API_KEY: generic.OPENAI_API_KEY } : {}),
      },
    }
  }
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
  if (!EXTERNAL_PROVIDER_KINDS.has(kind)) return {}
  const status = providerStore?.status(kind) || {}
  if (!status.configured) return {}
  return providerOptionsFor(
    kind,
    providerStore.envForAgent(kind),
    context,
    status,
  )
}

function providerAgentKind(value) {
  const kind = String(value || '').trim()
  if (!EXTERNAL_PROVIDER_KINDS.has(kind)) throw new Error('PROVIDER_AGENT_UNSUPPORTED')
  return kind
}

function workspaceStoragePath(userData = app.getPath('userData')) {
  return path.join(userData, 'roundrelay-workspace.json')
}

function persistedAttachmentReferences(storagePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(storagePath, 'utf8'))
    if (![1, 2].includes(parsed?.version) || !Array.isArray(parsed.groups)
        || !Array.isArray(parsed.messages) || typeof parsed.sessions !== 'object') {
      return null
    }
    return attachmentIdsFromSnapshot(parsed)
  } catch (error) {
    return error.code === 'ENOENT' ? [] : null
  }
}

function availableAttachmentStore() {
  if (!attachmentStore) throw new Error('LOCAL_ATTACHMENT_STORAGE_UNAVAILABLE')
  return attachmentStore
}

function attachmentIdsFromSnapshot(snapshot, groupId = '') {
  const ids = []
  for (const message of Array.isArray(snapshot?.messages) ? snapshot.messages : []) {
    if (groupId && message?.groupId !== groupId) continue
    for (const attachment of Array.isArray(message?.attachments) ? message.attachments : []) {
      if (typeof attachment?.id === 'string' && ATTACHMENT_ID.test(attachment.id)) {
        ids.push(attachment.id)
      }
    }
  }
  return [...new Set(ids)]
}

function normalizeDiscardIds(value, maxIds = MAX_ATTACHMENT_DISCARD_REQUEST) {
  if (!Array.isArray(value)) throw new Error('LOCAL_ATTACHMENT_REFERENCE_INVALID')
  if (value.length > maxIds) throw new Error('LOCAL_ATTACHMENT_COUNT_LIMIT')
  const ids = value.map((id) => {
    if (typeof id !== 'string' || !ATTACHMENT_ID.test(id)) {
      throw new Error('LOCAL_ATTACHMENT_ID_INVALID')
    }
    return id
  })
  return [...new Set(ids)]
}

function discardUnreferencedAttachments(value, maxIds = MAX_ATTACHMENT_DISCARD_REQUEST) {
  const store = availableAttachmentStore()
  const ids = normalizeDiscardIds(value, maxIds)
  const referenced = new Set(attachmentIdsFromSnapshot(workspace?.snapshot()))
  const retainedIds = ids.filter(id => referenced.has(id))
  const discardedIds = ids.filter(id => !referenced.has(id))
  if (discardedIds.length) store.discard(discardedIds)
  return { discardedIds, retainedIds }
}

function attachmentPreview(id) {
  const { metadata, bytes } = availableAttachmentStore().readWithMetadata(id)
  inspectImageDimensions(bytes)
  const source = electron.nativeImage.createFromBuffer(bytes)
  if (source.isEmpty()) throw new Error('LOCAL_ATTACHMENT_TYPE_UNSUPPORTED')
  const { width, height } = source.getSize()
  assertImagePixelLimit({ width, height })
  const scale = Math.min(1, 320 / Math.max(width, height))
  const preview = scale < 1
    ? source.resize({
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
        quality: 'good',
      })
    : source
  const previewDataUrl = preview.toDataURL()
  if (!previewDataUrl.startsWith('data:image/png;base64,') || previewDataUrl.length > 2 * 1024 * 1024) {
    throw new Error('LOCAL_ATTACHMENT_TYPE_UNSUPPORTED')
  }
  return {
    id: metadata.id,
    name: metadata.name,
    mimeType: metadata.mimeType,
    size: metadata.size,
    previewDataUrl,
  }
}

function mediaRequestId(value) {
  try {
    const target = new URL(value)
    const id = decodeURIComponent(target.pathname.replace(/^\//, ''))
    if (target.protocol !== `${MEDIA_SCHEME}:` || target.hostname !== 'attachment'
        || target.username || target.password || target.port || target.search || target.hash
        || !ATTACHMENT_ID.test(id)) {
      return ''
    }
    return id
  } catch {
    return ''
  }
}

function mediaByteRange(value, size) {
  if (!value) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(value).trim())
  if (!match || (!match[1] && !match[2])) return false
  let start
  let end
  if (!match[1]) {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] ? Number(match[2]) : size - 1
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || start >= size || end < start) return false
  return { start, end: Math.min(end, size - 1) }
}

function attachmentMediaResponse(request) {
  const id = mediaRequestId(request?.url)
  if (!id) return new Response(null, { status: 404 })
  let entry
  try { entry = availableAttachmentStore().readWithMetadata(id) } catch { return new Response(null, { status: 404 }) }
  const { metadata, bytes } = entry
  if (!/^(?:image|audio|video)\//.test(metadata.mimeType) || bytes.length !== metadata.size) {
    return new Response(null, { status: 415 })
  }
  const range = mediaByteRange(request?.headers?.get?.('range'), bytes.length)
  if (range === false) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${bytes.length}` },
    })
  }
  const body = range ? bytes.subarray(range.start, range.end + 1) : bytes
  const headers = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=31536000, immutable',
    'Content-Length': String(body.length),
    'Content-Type': metadata.mimeType,
    'X-Content-Type-Options': 'nosniff',
  }
  if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${bytes.length}`
  return new Response(body, { status: range ? 206 : 200, headers })
}

function registerMediaProtocol() {
  protocol?.handle?.(MEDIA_SCHEME, request => attachmentMediaResponse(request))
}

function importAttachmentBuffer(input) {
  const store = availableAttachmentStore()
  const metadata = store.importBuffer(input)
  try {
    return attachmentPreview(metadata.id)
  } catch (error) {
    try { store.discard([metadata]) } catch { /* best effort */ }
    throw error
  }
}

function importAttachmentFiles(filenames) {
  if (filenames.length > MAX_ATTACHMENT_PICK_REQUEST) {
    throw new Error('LOCAL_ATTACHMENT_COUNT_LIMIT')
  }
  const store = availableAttachmentStore()
  const imported = []
  try {
    for (const filename of filenames) {
      const metadata = store.importFile(filename)
      imported.push(metadata)
    }
    return imported.map(metadata => attachmentPreview(metadata.id))
  } catch (error) {
    if (imported.length) {
      try { store.discard(imported) } catch { /* best effort */ }
    }
    throw error
  }
}

function normalizeAttachmentPickLimit(value) {
  if (value == null) return MAX_ATTACHMENT_PICK_REQUEST
  const limit = Number(value)
  if (!Number.isFinite(limit)) return MAX_ATTACHMENT_PICK_REQUEST
  return Math.max(1, Math.min(MAX_ATTACHMENT_PICK_REQUEST, Math.floor(limit)))
}

function notifyWorkspaceChanged(snapshot) {
  if (mainWindow && !mainWindow.isDestroyed()
      && isTrustedLocalWebContents(mainWindow.webContents)) {
    mainWindow.webContents.send('local-workspace:changed', snapshot)
  }
}

function normalizeRunFinished(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const groupId = String(input.groupId || '')
  const status = String(input.status || '')
  if (!LOCAL_IDENTIFIER.test(groupId) || !RUN_FINISHED_STATUSES.has(status)) return null
  const threadRootId = String(input.threadRootId || '')
  const kinds = value => [...new Set((Array.isArray(value) ? value : [])
    .filter(kind => LOCAL_AGENT_KINDS.has(kind)))]
  return {
    groupId,
    mode: input.mode === 'auto' ? 'auto' : 'manual',
    status,
    threadRootId: LOCAL_IDENTIFIER.test(threadRootId) ? threadRootId : '',
    targetKinds: kinds(input.targetKinds),
    completedKinds: kinds(input.completedKinds),
    startedAt: Number.isFinite(input.startedAt) ? input.startedAt : 0,
    finishedAt: Number.isFinite(input.finishedAt) ? input.finishedAt : Date.now(),
  }
}

function flushPendingOpenGroup() {
  if (!pendingOpenGroupId || !mainWindow || mainWindow.isDestroyed()
      || !isTrustedLocalWebContents(mainWindow.webContents)) return false
  const groupId = pendingOpenGroupId
  pendingOpenGroupId = ''
  mainWindow.webContents.send('local-workspace:open-group', { groupId })
  return true
}

function activateMainWindow() {
  if ((!mainWindow || mainWindow.isDestroyed()) && app.isReady()) createWindow()
  if (!mainWindow || mainWindow.isDestroyed()) return false
  if (mainWindow.isMinimized?.()) mainWindow.restore?.()
  mainWindow.show?.()
  mainWindow.focus()
  return true
}

function openRunResult(groupId) {
  if (shutdownStarted) return
  pendingOpenGroupId = groupId
  if (!activateMainWindow()) return
  flushPendingOpenGroup()
}

function notifyRunFinished(input) {
  if (shutdownStarted) return
  const payload = normalizeRunFinished(input)
  if (!payload) return
  const availableWindow = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
  if (availableWindow && isTrustedLocalWebContents(availableWindow.webContents)) {
    mainWindow.webContents.send('local-workspace:run-finished', payload)
  }
  if (availableWindow
      && (typeof availableWindow.isFocused !== 'function' || availableWindow.isFocused())) return
  if (typeof Notification !== 'function' || Notification.isSupported?.() === false) return
  const locale = String(app.getLocale?.() || '').toLowerCase()
  const notification = new Notification({
    title: 'Meldwork',
    body: locale.startsWith('zh') ? '会话运行已结束' : 'Conversation run finished',
  })
  notification.on('click', () => openRunResult(payload.groupId))
  notification.show()
}

function createWorkspace() {
  return new LocalWorkspace({
    storagePath: workspaceStoragePath(),
    detectAgents: () => installer.detectedAgents(),
    resolveAttachments: attachments => availableAttachmentStore().resolve(attachments),
    captureAgentOutputs: workdir => captureAgentOutputState(workdir),
    importAgentOutputs: input => importAgentOutputs(input, availableAttachmentStore()),
    validateSkillSelections: (kind, selections) => skillCatalog.validateSelections(kind, selections),
    imageAttachmentLimit,
    credentialState: (kind, agent) => (
      resolveNativeCredentialState(kind, { executable: agent?.executable })
    ),
    sharedProviderReady: kind => EXTERNAL_PROVIDER_KINDS.has(kind) && providerStore.status(kind).configured,
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
  workspaceRunFinishedListener = notifyRunFinished
  next.on('changed', workspaceChangedListener)
  next.on('run-finished', workspaceRunFinishedListener)
  return next
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    title: 'Meldwork',
    backgroundColor: '#f3f6f8',
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

function registerIpc() {
  registerTrustedHandle('local-workspace:get', () => {
    if (!workspace) throw new Error('LOCAL_WORKSPACE_UNAVAILABLE')
    return workspace.snapshot()
  })
  registerTrustedHandle('local-workspace:refresh-agents', async () => {
    if (!workspace) throw new Error('LOCAL_WORKSPACE_UNAVAILABLE')
    workspace.clearRuntimeCredentialFailures()
    installer.invalidateDetectionCache()
    skillCatalog?.invalidate()
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
    const normalizedGroupId = String(groupId || '')
    const candidates = attachmentIdsFromSnapshot(workspace.snapshot(), normalizedGroupId)
    workspace.deleteGroup(normalizedGroupId)
    const snapshot = workspace.snapshot()
    if (attachmentStore && candidates.length) {
      try { discardUnreferencedAttachments(candidates, Number.POSITIVE_INFINITY) } catch { /* startup cleanup retries */ }
    }
    return snapshot
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
  registerTrustedHandle('local-agent-installer:skills', async (kind) => {
    return installer.skills(String(kind || ''))
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
  registerTrustedHandle('local-attachments:pick-images', async (remainingCapacity) => {
    availableAttachmentStore()
    const limit = normalizeAttachmentPickLimit(remainingCapacity)
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
    })
    if (shutdownStarted) throw new Error('DESKTOP_CLIENT_SHUTTING_DOWN')
    if (result.canceled) return { attachments: [], truncated: false }
    const filenames = result.filePaths.slice(0, limit)
    return {
      attachments: importAttachmentFiles(filenames),
      truncated: result.filePaths.length > filenames.length,
    }
  })
  registerTrustedHandle('local-attachments:import-image', (input) => {
    return importAttachmentBuffer(input)
  })
  registerTrustedHandle('local-attachments:preview', (id) => {
    return attachmentPreview(String(id || ''))
  })
  registerTrustedHandle('local-attachments:discard', (ids) => {
    return discardUnreferencedAttachments(ids)
  })
  registerTrustedHandle('local-agent-provider:status', (kind) => {
    return providerStore.status(providerAgentKind(kind))
  })
  registerTrustedHandle('local-agent-provider:probe', (kind) => {
    return providerStore.status(providerAgentKind(kind), { probeEncryption: true })
  })
  registerTrustedHandle('local-agent-provider:save', async (kind, input) => {
    const result = providerStore.save(providerAgentKind(kind), {
      apiKey: input?.apiKey,
      provider: input?.provider,
      baseUrl: input?.baseUrl,
      model: input?.model,
      preset: input?.preset,
    })
    await refreshLocalAgentState()
    return result
  })
  registerTrustedHandle('local-agent-provider:activate', async (kind, preset) => {
    const result = providerStore.activate(providerAgentKind(kind), preset)
    await refreshLocalAgentState()
    return result
  })
  registerTrustedHandle('local-agent-provider:delete', async (kind, preset) => {
    const result = providerStore.delete(providerAgentKind(kind), preset)
    await refreshLocalAgentState()
    return result
  })
  registerTrustedHandle('local-knowledge-base:status', async (kind = '') => {
    if (knowledgeBaseStatusPromise) return knowledgeBaseStatusPromise
    const request = resolveKnowledgeBaseSources({
      store: knowledgeBaseStore,
      home: app.getPath('home'),
      kind: String(kind || '').trim(),
    })
    knowledgeBaseStatusPromise = request
    try {
      return await request
    } finally {
      if (knowledgeBaseStatusPromise === request) knowledgeBaseStatusPromise = null
    }
  })
  registerTrustedHandle('local-knowledge-base:open-guide', async (kind, action) => {
    const url = knowledgeBaseGuideUrl(String(kind || ''), String(action || ''))
    if (!url) return false
    return openExternalUrl(url)
  })
  registerTrustedHandle('local-knowledge-base:pick-obsidian-vault', async () => {
    if (!knowledgeBaseStore) throw new Error('LOCAL_KNOWLEDGE_BASE_UNAVAILABLE')
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
    })
    if (shutdownStarted) throw new Error('DESKTOP_CLIENT_SHUTTING_DOWN')
    if (result.canceled) return knowledgeBaseStore.state()
    knowledgeBaseStore.saveObsidianVaultPath(result.filePaths[0] || '')
    return resolveKnowledgeBaseSources({
      store: knowledgeBaseStore,
      home: app.getPath('home'),
    })
  })
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', activateMainWindow)

  app.whenReady().then(async () => {
    const attachmentReferences = persistedAttachmentReferences(workspaceStoragePath())
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
    registerMediaProtocol()
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
