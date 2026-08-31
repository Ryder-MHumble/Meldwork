function normalizedSection(section) {
  if (section === 'providers') return 'providers'
  if (section === 'cloud-agents') return 'cloud-agents'
  if (section === 'knowledge-bases') return 'knowledge-bases'
  return 'agents'
}

export function useSystemSettingsNavigation({
  activeView,
  closeModal,
  focusedAgentKind,
  formError,
  installConfirmKind,
  loadKnowledgeBaseStatuses,
  loadProviderWorkspace,
  modal,
  providerRemoveArmed,
  saving,
  selectedProviderKind,
  supportsExternalProvider,
  systemSettingsSection,
}) {
  function openAgentManager(kind = '') {
    openSystemSettings('agents', kind)
  }

  function openSystemSettings(section = 'agents', kind = '') {
    if (saving.value) return
    if (modal.value) closeModal()
    activeView.value = 'settings'
    systemSettingsSection.value = normalizedSection(section)
    focusedAgentKind.value = systemSettingsSection.value === 'agents' ? kind : ''
    installConfirmKind.value = ''
    formError.value = ''
    providerRemoveArmed.value = false
    if (systemSettingsSection.value === 'providers') {
      const targetKind = supportsExternalProvider({ kind }) ? kind : selectedProviderKind.value
      void loadProviderWorkspace(targetKind, { probeSelected: true })
    } else if (systemSettingsSection.value === 'knowledge-bases') {
      void loadKnowledgeBaseStatuses()
    }
  }

  function selectSystemSettingsSection(section) {
    if (section === systemSettingsSection.value) return
    systemSettingsSection.value = normalizedSection(section)
    formError.value = ''
    providerRemoveArmed.value = false
    if (systemSettingsSection.value === 'providers') {
      void loadProviderWorkspace(selectedProviderKind.value, { probeSelected: true })
    } else if (systemSettingsSection.value === 'knowledge-bases') {
      void loadKnowledgeBaseStatuses()
    }
  }

  function openProvider(kind = '') {
    if (saving.value) return
    openSystemSettings(
      'providers',
      supportsExternalProvider({ kind }) ? kind : selectedProviderKind.value,
    )
  }

  return {
    openAgentManager,
    openProvider,
    openSystemSettings,
    selectSystemSettingsSection,
  }
}
