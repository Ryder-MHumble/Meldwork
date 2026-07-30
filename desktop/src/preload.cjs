const { contextBridge, ipcRenderer } = require('electron')

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg'])

function attachmentError(code) {
  return Object.assign(new Error(code), { code })
}

function normalizeImageImport(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || typeof input.name !== 'string' || input.name.length > 4096
      || typeof input.mimeType !== 'string' || input.mimeType.length > 128) {
    throw attachmentError('LOCAL_ATTACHMENT_INPUT_INVALID')
  }
  const declaredMimeType = input.mimeType.split(';', 1)[0].trim().toLowerCase()
  const mimeType = declaredMimeType === 'image/jpg' ? 'image/jpeg' : declaredMimeType
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
    throw attachmentError('LOCAL_ATTACHMENT_TYPE_UNSUPPORTED')
  }
  const bytes = input.bytes
  if (!ArrayBuffer.isView(bytes)
      || Object.prototype.toString.call(bytes) !== '[object Uint8Array]'
      || bytes.byteLength <= 0) {
    throw attachmentError('LOCAL_ATTACHMENT_BYTES_INVALID')
  }
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw attachmentError('LOCAL_ATTACHMENT_TOO_LARGE')
  }
  return {
    name: input.name,
    mimeType,
    bytes: Uint8Array.from(bytes),
  }
}

const isLocalDocument = location.protocol === 'file:'
const desktopApi = {
  isDesktop: true,
  localOnly: true,
}

if (isLocalDocument) Object.assign(desktopApi, {
  localWorkspace: Object.freeze({
    get: () => ipcRenderer.invoke('local-workspace:get'),
    refreshAgents: () => ipcRenderer.invoke('local-workspace:refresh-agents'),
    createGroup: input => ipcRenderer.invoke('local-workspace:create-group', input),
    updateGroup: (groupId, input) => ipcRenderer.invoke('local-workspace:update-group', groupId, input),
    deleteGroup: groupId => ipcRenderer.invoke('local-workspace:delete-group', groupId),
    send: input => ipcRenderer.invoke('local-workspace:send', input),
    startAuto: input => ipcRenderer.invoke('local-workspace:start-auto', input),
    stop: groupId => ipcRenderer.invoke('local-workspace:stop', groupId),
    pickDirectory: () => ipcRenderer.invoke('local-workspace:pick-directory'),
    defaultDirectory: () => ipcRenderer.invoke('local-workspace:default-directory'),
    onChanged: callback => {
      const listener = (_event, snapshot) => callback(snapshot)
      ipcRenderer.on('local-workspace:changed', listener)
      return () => ipcRenderer.removeListener('local-workspace:changed', listener)
    },
    onRunFinished: callback => {
      const listener = (_event, result) => callback(result)
      ipcRenderer.on('local-workspace:run-finished', listener)
      return () => ipcRenderer.removeListener('local-workspace:run-finished', listener)
    },
    onOpenGroup: callback => {
      const listener = (_event, request) => callback(request)
      ipcRenderer.on('local-workspace:open-group', listener)
      return () => ipcRenderer.removeListener('local-workspace:open-group', listener)
    },
  }),
  agentInstaller: Object.freeze({
    catalog: () => ipcRenderer.invoke('local-agent-installer:catalog'),
    skills: kind => ipcRenderer.invoke('local-agent-installer:skills', kind),
    state: () => ipcRenderer.invoke('local-agent-installer:state'),
    start: kind => ipcRenderer.invoke('local-agent-installer:start', kind),
    cancel: taskId => ipcRenderer.invoke('local-agent-installer:cancel', taskId),
    setSidebarVisibility: (kind, visible) => ipcRenderer.invoke(
      'local-agent-installer:set-sidebar-visibility', kind, visible,
    ),
    onChanged: callback => {
      const listener = (_event, state) => callback(state)
      ipcRenderer.on('local-agent-installer:changed', listener)
      return () => ipcRenderer.removeListener('local-agent-installer:changed', listener)
    },
  }),
  localAttachments: Object.freeze({
    pickImages: remainingCapacity => ipcRenderer.invoke(
      'local-attachments:pick-images', remainingCapacity,
    ),
    importImage: input => ipcRenderer.invoke('local-attachments:import-image', normalizeImageImport(input)),
    preview: id => ipcRenderer.invoke('local-attachments:preview', id),
    discard: ids => ipcRenderer.invoke('local-attachments:discard', ids),
  }),
  localAgentProvider: Object.freeze({
    status: () => ipcRenderer.invoke('local-agent-provider:status'),
    probe: () => ipcRenderer.invoke('local-agent-provider:probe'),
    save: input => ipcRenderer.invoke('local-agent-provider:save', input),
    delete: () => ipcRenderer.invoke('local-agent-provider:delete'),
  }),
})

contextBridge.exposeInMainWorld('roundrelayDesktop', Object.freeze(desktopApi))
