const { contextBridge, ipcRenderer } = require('electron')

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
  }),
  agentInstaller: Object.freeze({
    catalog: () => ipcRenderer.invoke('local-agent-installer:catalog'),
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
  localAgentProvider: Object.freeze({
    status: () => ipcRenderer.invoke('local-agent-provider:status'),
    probe: () => ipcRenderer.invoke('local-agent-provider:probe'),
    save: input => ipcRenderer.invoke('local-agent-provider:save', input),
    delete: () => ipcRenderer.invoke('local-agent-provider:delete'),
  }),
})

contextBridge.exposeInMainWorld('roundrelayDesktop', Object.freeze(desktopApi))
