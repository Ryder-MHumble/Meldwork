const LOCAL_GROUP_IDENTIFIER = /^[^\u0000-\u001f\u007f]{1,100}$/u
const LOCAL_RUN_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/

function registerDesktopIpc(options) {
  const {
    app,
    attachmentIdsFromSnapshot,
    attachments,
    customAgentStore,
    dialog,
    getAttachmentStore,
    getMainWindow,
    getWorkspace,
    installer,
    isShutdownStarted,
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
  } = options

  registerTrustedHandle('local-workspace:get', () => {
    const workspace = getWorkspace()
    if (!workspace) throw new Error('LOCAL_WORKSPACE_UNAVAILABLE')
    return workspace.snapshot()
  })
  registerTrustedHandle('local-workspace:refresh-agents', async () => {
    const workspace = getWorkspace()
    if (!workspace) throw new Error('LOCAL_WORKSPACE_UNAVAILABLE')
    workspace.clearRuntimeCredentialFailures()
    installer.invalidateDetectionCache()
    skillCatalog?.invalidate()
    return refreshLocalAgentState()
  })
  registerTrustedHandle('local-workspace:create-group', (input) => {
    const workspace = getWorkspace()
    if (!workspace) throw new Error('LOCAL_WORKSPACE_UNAVAILABLE')
    return workspace.createGroup(input || {})
  })
  registerTrustedHandle('local-workspace:update-group', (groupId, input) => {
    const workspace = getWorkspace()
    if (!workspace) throw new Error('LOCAL_WORKSPACE_UNAVAILABLE')
    return workspace.updateGroup(String(groupId || ''), input || {})
  })
  registerTrustedHandle('local-workspace:delete-group', (groupId) => {
    const workspace = getWorkspace()
    if (!workspace) throw new Error('LOCAL_WORKSPACE_UNAVAILABLE')
    const normalizedGroupId = String(groupId || '')
    const candidates = attachmentIdsFromSnapshot(workspace.snapshot(), normalizedGroupId)
    workspace.deleteGroup(normalizedGroupId)
    const snapshot = workspace.snapshot()
    if (getAttachmentStore() && candidates.length) {
      try { attachments.discardUnreferenced(candidates, Number.POSITIVE_INFINITY) } catch { /* startup cleanup retries */ }
    }
    return snapshot
  })
  registerTrustedHandle('local-workspace:delete-message', (groupId, messageId) => {
    const workspace = getWorkspace()
    if (!workspace) throw new Error('LOCAL_WORKSPACE_UNAVAILABLE')
    const normalizedGroupId = String(groupId || '')
    const normalizedMessageId = String(messageId || '')
    const beforeMessages = [...workspace.snapshot().messages]
    workspace.deleteMessage(normalizedGroupId, normalizedMessageId)
    const snapshot = workspace.snapshot()
    if (getAttachmentStore()) {
      const retainedMessageIds = new Set(snapshot.messages.map(message => message.id))
      const deletedMessages = beforeMessages.filter(message => !retainedMessageIds.has(message.id))
      const candidates = attachmentIdsFromSnapshot({ messages: deletedMessages })
      if (candidates.length) {
        try { attachments.discardUnreferenced(candidates, Number.POSITIVE_INFINITY) } catch { /* startup cleanup retries */ }
      }
    }
    return snapshot
  })
  registerTrustedHandle('local-workspace:send', async (input) => {
    const workspace = getWorkspace()
    if (!workspace) throw new Error('LOCAL_WORKSPACE_UNAVAILABLE')
    if (!Array.isArray(input?.targetKinds) || !input.targetKinds.length) {
      throw new Error('LOCAL_MESSAGE_TARGET_REQUIRED')
    }
    return workspace.sendMessage(input)
  })
  registerTrustedHandle('local-workspace:stop', (groupId, runId) => {
    const workspace = getWorkspace()
    if (!workspace) return false
    const normalizedGroupId = String(groupId || '')
    const normalizedRunId = String(runId || '')
    if (!LOCAL_GROUP_IDENTIFIER.test(normalizedGroupId)
        || !LOCAL_RUN_IDENTIFIER.test(normalizedRunId)) return false
    return workspace.stop(normalizedGroupId, normalizedRunId)
  })
  registerTrustedHandle('local-workspace:pick-directory', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled ? '' : result.filePaths[0]
  })
  registerTrustedHandle('local-workspace:default-directory', () => app.getPath('documents'))
  registerTrustedHandle('local-agent-installer:catalog', async () => localAgentCatalog())
  registerTrustedHandle('local-agent-installer:skills', async (kind) => {
    const selectedKind = String(kind || '')
    if (customAgentStore.has(selectedKind)) {
      return { supported: false, skills: [], total: 0, limit: 0 }
    }
    return installer.skills(selectedKind)
  })
  registerTrustedHandle('local-agent-installer:state', () => installer.state())
  registerTrustedHandle('local-agent-installer:start', kind => installer.start(String(kind || '')))
  registerTrustedHandle('local-agent-installer:cancel', taskId => installer.cancel(String(taskId || '')))
  registerTrustedHandle('local-agent-installer:set-sidebar-visibility', (kind, visible) => {
    const workspace = getWorkspace()
    if (!workspace) throw new Error('LOCAL_WORKSPACE_UNAVAILABLE')
    return workspace.setSidebarVisibility(String(kind || ''), visible === true)
  })
  registerTrustedHandle('local-custom-agent:create', async (input) => {
    const locale = String(app.getLocale?.() || '').toLowerCase()
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: locale.startsWith('zh') ? '选择 Agent CLI 可执行文件' : 'Choose Agent CLI executable',
      properties: ['openFile'],
    })
    if (isShutdownStarted()) throw new Error('DESKTOP_CLIENT_SHUTTING_DOWN')
    if (result.canceled || !result.filePaths[0]) return { canceled: true }
    const agent = customAgentStore.create({
      label: input?.label,
      description: input?.description,
      args: input?.args,
      promptMode: input?.promptMode,
    }, result.filePaths[0])
    await refreshLocalAgentState()
    return { canceled: false, agent }
  })
  registerTrustedHandle('local-custom-agent:delete', async (kind) => {
    const selectedKind = String(kind || '')
    const referenced = (getWorkspace()?.snapshot().groups || []).some(group => (
      group?.directAgentKind === selectedKind
      || (Array.isArray(group?.agentKinds) && group.agentKinds.includes(selectedKind))
    ))
    if (referenced) throw new Error('CUSTOM_AGENT_IN_USE')
    customAgentStore.remove(selectedKind)
    await refreshLocalAgentState()
    return { deleted: true, kind: selectedKind }
  })
  registerTrustedHandle('local-attachments:pick', async (remainingCapacity) => {
    attachments.availableStore()
    const limit = attachments.normalizePickLimit(remainingCapacity)
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Media', extensions: ['png', 'jpg', 'jpeg', 'mp3', 'wav', 'm4a', 'mp4', 'mov', 'webm'] }],
    })
    if (isShutdownStarted()) throw new Error('DESKTOP_CLIENT_SHUTTING_DOWN')
    if (result.canceled) return { attachments: [], truncated: false }
    const filenames = result.filePaths.slice(0, limit)
    return {
      attachments: attachments.importFiles(filenames),
      truncated: result.filePaths.length > filenames.length,
    }
  })
  registerTrustedHandle('local-attachments:import', input => attachments.importBuffer(input))
  registerTrustedHandle('local-attachments:preview', id => attachments.preview(String(id || '')))
  registerTrustedHandle('local-attachments:discard', ids => attachments.discardUnreferenced(ids))
  registerTrustedHandle('local-agent-provider:status', kind => (
    providerStore.status(providerAgentKind(kind))
  ))
  registerTrustedHandle('local-agent-provider:probe', kind => (
    providerStore.status(providerAgentKind(kind), { probeEncryption: true })
  ))
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
  registerTrustedHandle('local-knowledge-base:status', async (kind = '') => (
    loadKnowledgeBaseSources(kind)
  ))
  registerTrustedHandle('local-knowledge-base:open-guide', async (kind, action) => {
    const url = knowledgeBaseGuideUrl(String(kind || ''), String(action || ''))
    if (!url) return false
    return openExternalUrl(url)
  })
  registerTrustedHandle('local-knowledge-base:pick-obsidian-vault', async () => {
    if (!knowledgeBaseStore) throw new Error('LOCAL_KNOWLEDGE_BASE_UNAVAILABLE')
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ['openDirectory', 'createDirectory'],
    })
    if (isShutdownStarted()) throw new Error('DESKTOP_CLIENT_SHUTTING_DOWN')
    if (result.canceled) return knowledgeBaseStore.state()
    knowledgeBaseStore.saveObsidianVaultPath(result.filePaths[0] || '')
    return loadKnowledgeBaseSources()
  })
}

module.exports = { registerDesktopIpc }
