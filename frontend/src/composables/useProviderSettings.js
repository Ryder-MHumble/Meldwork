import { computed, reactive, ref } from 'vue'
import { AGENTS } from '../catalog.js'
import { t, translateError } from '../i18n.js'
import { inferProviderPreset, providerProfile } from '../providerProfiles.js'
import {
  EMPTY_PROVIDER_STATUS,
  hasProviderStatus as hasProviderStatusIn,
  nativeProviderReady,
  providerActiveSourceFor as providerActiveSourceFrom,
  providerAgentState as buildProviderAgentState,
  providerProfilesFor as providerProfilesFrom,
  providerStatusFor as providerStatusFrom,
  providerSummaryLabel as buildProviderSummaryLabel,
  supportsExternalProvider,
} from '../providerSettingsModel.js'

export function useProviderSettings({ agents, provider, saving, formError, refreshAgents }) {
  const providerStatuses = ref({})
  const providerStatusLoadingKinds = ref(new Set())
  const selectedProviderKind = ref(AGENTS[0]?.kind || 'codex')
  const providerRemoveArmed = ref(false)
  const providerForm = reactive({ preset: 'official', provider: '', baseUrl: '', model: '', apiKey: '' })
  const providerStatusRequestTokens = new Map()
  let providerStatusRequestSequence = 0

  const configurableProviderAgents = computed(() => agents.value.filter(agent => (
    supportsExternalProvider(agent)
  )))

  function providerStatusFor(kind) {
    return providerStatusFrom(providerStatuses.value, kind)
  }

  function providerProfilesFor(kind) {
    return providerProfilesFrom(providerStatuses.value, kind)
  }

  function hasProviderStatus(kind) {
    return hasProviderStatusIn(providerStatuses.value, kind)
  }

  function setProviderStatusPending(kind, pending) {
    const targetKind = String(kind || '')
    const next = new Set(providerStatusLoadingKinds.value)
    if (pending) next.add(targetKind)
    else next.delete(targetKind)
    providerStatusLoadingKinds.value = next
  }

  function providerStatusIsChecking(kind) {
    const targetKind = String(kind || '')
    return providerStatusLoadingKinds.value.has(targetKind) || !hasProviderStatus(targetKind)
  }

  function providerActiveSourceFor(kind) {
    return providerActiveSourceFrom(configurableProviderAgents.value, providerStatuses.value, kind)
  }

  function providerPresetLabel(id) {
    return t(`provider.preset.${id}`)
  }

  function providerAgentState(kind) {
    return buildProviderAgentState({
      agents: configurableProviderAgents.value,
      checking: providerStatusIsChecking(kind),
      kind,
      statuses: providerStatuses.value,
      t,
    })
  }

  function providerReady(kind) {
    return ['active-override', 'native-ready'].includes(providerAgentState(kind).id)
  }

  function providerStatusLabel(kind) {
    return providerAgentState(kind).label
  }

  function providerStatusTone(kind) {
    return providerAgentState(kind).tone
  }

  function providerStatusIcon(kind) {
    return providerAgentState(kind).icon
  }

  function providerSummaryLabel(agent) {
    return buildProviderSummaryLabel({ agent, statuses: providerStatuses.value, t })
  }

  function providerPresetHint(id) {
    return t(`provider.presetHint.${id}`)
  }

  function providerPresetSaved(presetId) {
    return Boolean(providerProfilesFor(selectedProviderKind.value)[presetId]?.configured)
  }

  function providerPresetConfigured(presetId) {
    if (providerPresetSaved(presetId)) return true
    return presetId === 'official'
      && hasProviderStatus(selectedProviderKind.value)
      && !providerStatus.value.error
      && nativeProviderReady(selectedProviderAgent.value)
  }

  function providerPresetActive(presetId) {
    return providerActiveSource.value === presetId
  }

  function providerPresetStateLabel(presetId) {
    if (providerStatusIsChecking(selectedProviderKind.value) && !hasProviderStatus(selectedProviderKind.value)) {
      return t('provider.checking')
    }
    if (providerStatus.value.error) return t('provider.unavailable')
    if (providerPresetActive(presetId)) return t('provider.active')
    if (providerPresetSaved(presetId)) return t('provider.saved')
    if (presetId === 'official') {
      if (!selectedProviderAgent.value?.installed) return t('provider.state.notInstalled')
      if (selectedProviderAgent.value?.credentialState === 'missing') return t('provider.state.loginRequired')
      if (nativeProviderReady(selectedProviderAgent.value)) return t('provider.nativeAvailable')
      return t('provider.state.unverified')
    }
    return t('provider.notConfigured')
  }

  function providerPresetFor(kind, presetId) {
    const profile = providerProfile(kind)
    return profile.presets.find(preset => preset.id === presetId) || profile.presets[0] || null
  }

  function fillProviderFormFromPreset(kind, presetId) {
    const preset = providerPresetFor(kind, presetId)
    if (!preset) return
    const saved = providerProfilesFor(kind)[preset.id]
    const lockedIdentity = preset.id !== 'custom'
    providerForm.preset = preset.id
    providerForm.provider = lockedIdentity ? (preset.provider || '') : (saved?.provider || preset.provider || '')
    providerForm.baseUrl = lockedIdentity ? (preset.baseUrl || '') : (saved?.baseUrl || preset.baseUrl || '')
    providerForm.model = saved?.model || preset.model || ''
  }

  function applyProviderPreset(presetId) {
    const changed = providerForm.preset !== presetId
    formError.value = ''
    providerRemoveArmed.value = false
    fillProviderFormFromPreset(selectedProviderKind.value, presetId)
    if (changed) providerForm.apiKey = ''
  }

  function syncProviderForm(kind) {
    const status = providerStatusFor(kind)
    const preset = status.activePreset || inferProviderPreset(kind, status)
    fillProviderFormFromPreset(kind, preset)
    if (status.configured && !providerProfilesFor(kind)[preset]) {
      providerForm.provider = status.provider || providerForm.provider
      providerForm.baseUrl = status.baseUrl || providerForm.baseUrl
      providerForm.model = status.model || providerForm.model
    }
    providerForm.apiKey = ''
  }

  async function loadProviderStatus(kind, { probeEncryption = false, trackPending = true } = {}) {
    if (!provider.value || !supportsExternalProvider({ kind })) {
      return { status: EMPTY_PROVIDER_STATUS, applied: false }
    }
    const requestToken = ++providerStatusRequestSequence
    providerStatusRequestTokens.set(kind, requestToken)
    if (trackPending) setProviderStatusPending(kind, true)
    try {
      const status = await (probeEncryption ? provider.value.probe(kind) : provider.value.status(kind))
      const applied = providerStatusRequestTokens.get(kind) === requestToken
      if (applied) providerStatuses.value = { ...providerStatuses.value, [kind]: status }
      return { status: applied ? status : providerStatusFor(kind), applied }
    } catch {
      const unavailable = { ...EMPTY_PROVIDER_STATUS, error: true }
      const applied = providerStatusRequestTokens.get(kind) === requestToken
      if (applied) providerStatuses.value = { ...providerStatuses.value, [kind]: unavailable }
      return { status: applied ? unavailable : providerStatusFor(kind), applied }
    } finally {
      if (trackPending && providerStatusRequestTokens.get(kind) === requestToken) {
        setProviderStatusPending(kind, false)
      }
    }
  }

  async function retryProviderStatus(kind) {
    const targetKind = String(kind || '')
    if (!supportsExternalProvider({ kind: targetKind }) || saving.value) {
      return { status: EMPTY_PROVIDER_STATUS, applied: false }
    }
    const nextStatuses = { ...providerStatuses.value }
    delete nextStatuses[targetKind]
    providerStatuses.value = nextStatuses
    const result = await loadProviderStatus(targetKind, { probeEncryption: true })
    if (result.applied && selectedProviderKind.value === targetKind && !result.status.error) {
      syncProviderForm(targetKind)
    }
    return result
  }

  async function loadProviderWorkspace(targetKind = '', { probeSelected = false } = {}) {
    const selectedKind = supportsExternalProvider({ kind: targetKind }) ? targetKind : ''
    if (selectedKind) {
      selectedProviderKind.value = selectedKind
      formError.value = ''
      providerRemoveArmed.value = false
      syncProviderForm(selectedKind)
    }
    const providerAgents = configurableProviderAgents.value
    const results = await Promise.all(providerAgents.map(agent => loadProviderStatus(agent.kind, {
      probeEncryption: probeSelected && agent.kind === selectedKind,
      trackPending: Boolean(selectedKind && agent.kind === selectedKind),
    })))
    const selectedResult = results[providerAgents.findIndex(agent => agent.kind === selectedKind)]
    if (selectedKind
        && selectedProviderKind.value === selectedKind
        && selectedResult?.applied
        && !selectedResult.status.error) {
      syncProviderForm(selectedKind)
    }
    return results
  }

  async function selectProviderAgent(kind) {
    if (!supportsExternalProvider({ kind }) || saving.value) return
    selectedProviderKind.value = kind
    formError.value = ''
    providerRemoveArmed.value = false
    syncProviderForm(kind)
    const result = await loadProviderStatus(kind, { probeEncryption: true })
    if (result.applied && selectedProviderKind.value === kind && !result.status.error) syncProviderForm(kind)
  }

  async function activateProviderPreset(presetId) {
    if (saving.value || providerPresetActive(presetId) || !providerPresetConfigured(presetId)) return
    if (typeof provider.value?.activate !== 'function') {
      formError.value = t('provider.switchUnavailable')
      return
    }
    saving.value = true
    formError.value = ''
    try {
      const kind = selectedProviderKind.value
      await provider.value.activate(kind, presetId)
      const [result] = await Promise.all([
        loadProviderStatus(kind, { probeEncryption: true }),
        refreshAgents(),
      ])
      if (result.applied) syncProviderForm(kind)
    } catch (error) {
      formError.value = translateError(error)
    } finally {
      saving.value = false
    }
  }

  async function saveProvider() {
    formError.value = ''
    if (providerNativeOfficialMode.value) return
    if (!providerForm.provider || !providerForm.baseUrl || !providerForm.model) {
      formError.value = t('provider.requiredFields')
      return
    }
    if (!providerForm.apiKey) {
      formError.value = t('provider.keyRequired')
      return
    }
    saving.value = true
    try {
      const kind = selectedProviderKind.value
      await provider.value.save(kind, {
        preset: providerForm.preset,
        provider: providerForm.provider,
        baseUrl: providerForm.baseUrl,
        model: providerForm.model,
        apiKey: providerForm.apiKey,
      })
      providerForm.apiKey = ''
      const [result] = await Promise.all([
        loadProviderStatus(kind, { probeEncryption: true }),
        refreshAgents(),
      ])
      if (result.applied) syncProviderForm(kind)
    } catch (error) {
      formError.value = translateError(error)
    } finally {
      saving.value = false
    }
  }

  async function removeProvider() {
    if (saving.value) return
    if (!providerRemoveArmed.value) {
      providerRemoveArmed.value = true
      return
    }
    saving.value = true
    try {
      const kind = selectedProviderKind.value
      const preset = providerForm.preset
      await provider.value.delete(kind, preset)
      const [result] = await Promise.all([
        loadProviderStatus(kind, { probeEncryption: true }),
        refreshAgents(),
      ])
      providerRemoveArmed.value = false
      if (result.applied) fillProviderFormFromPreset(kind, preset)
      providerForm.apiKey = ''
    } catch (error) {
      formError.value = translateError(error)
    } finally {
      saving.value = false
    }
  }

  const providerConfiguredCount = computed(() => configurableProviderAgents.value.filter(
    agent => providerReady(agent.kind),
  ).length)
  const selectedProviderAgent = computed(() => configurableProviderAgents.value.find(
    agent => agent.kind === selectedProviderKind.value,
  ) || configurableProviderAgents.value[0] || null)
  const providerStatus = computed(() => providerStatusFor(selectedProviderKind.value))
  const selectedProviderProfile = computed(() => providerProfile(selectedProviderKind.value))
  const selectedProviderPresets = computed(() => selectedProviderProfile.value.presets || [])
  const selectedProviderPreset = computed(() => (
    selectedProviderPresets.value.find(preset => preset.id === providerForm.preset)
    || selectedProviderPresets.value[0]
    || null
  ))
  const selectedProviderAgentState = computed(() => providerAgentState(selectedProviderKind.value))
  const providerActiveSource = computed(() => providerActiveSourceFor(selectedProviderKind.value))
  const selectedProviderProfileStatus = computed(() => (
    providerProfilesFor(selectedProviderKind.value)[providerForm.preset] || null
  ))
  const selectedProviderProfileSaved = computed(() => Boolean(selectedProviderProfileStatus.value?.configured))
  const selectedProviderPresetActive = computed(() => providerActiveSource.value === providerForm.preset)
  const selectedProviderPresetConfigured = computed(() => providerPresetConfigured(providerForm.preset))
  const providerNativeOfficialMode = computed(() => (
    providerForm.preset === 'official'
    && !selectedProviderProfileSaved.value
    && (
      nativeProviderReady(selectedProviderAgent.value)
      || !String(selectedProviderPreset.value?.baseUrl || '').trim()
    )
  ))
  const providerIdentityLocked = computed(() => providerForm.preset !== 'custom')
  const providerFormControlsDisabled = computed(() => (
    saving.value
    || providerStatus.value.error
    || (providerStatusIsChecking(selectedProviderKind.value) && !hasProviderStatus(selectedProviderKind.value))
  ))
  const providerSaveActionLabel = computed(() => {
    if (saving.value) return t('common.saving')
    if (!selectedProviderProfileSaved.value) return t('provider.saveAndUse')
    return selectedProviderPresetActive.value
      ? t('provider.updateCredentials')
      : t('provider.updateAndUse')
  })
  const providerNativeGuideBody = computed(() => {
    const state = selectedProviderAgentState.value
    const agent = selectedProviderAgent.value
    if (state.id === 'checking') return t('provider.nativeStatusCheckingBody')
    if (state.id === 'unavailable') return t('provider.nativeStatusErrorBody')
    if (nativeProviderReady(agent)) {
      return selectedProviderPresetActive.value
        ? t('provider.nativeBody')
        : t('provider.nativeAvailableBody')
    }
    return state.detail
  })
  const providerNativeActionVisible = computed(() => (
    providerNativeOfficialMode.value
    && ['not-installed', 'login-required', 'unverified'].includes(selectedProviderAgentState.value.id)
  ))

  return {
    activateProviderPreset,
    applyProviderPreset,
    configurableProviderAgents,
    loadProviderWorkspace,
    providerConfiguredCount,
    providerForm,
    providerFormControlsDisabled,
    providerIdentityLocked,
    providerNativeActionVisible,
    providerNativeGuideBody,
    providerNativeOfficialMode,
    providerPresetActive,
    providerPresetConfigured,
    providerPresetHint,
    providerPresetLabel,
    providerPresetStateLabel,
    providerReady,
    providerRemoveArmed,
    providerSaveActionLabel,
    providerStatus,
    providerStatusIcon,
    providerStatusIsChecking,
    providerStatusLabel,
    providerStatusTone,
    providerSummaryLabel,
    removeProvider,
    retryProviderStatus,
    saveProvider,
    selectProviderAgent,
    selectedProviderAgent,
    selectedProviderAgentState,
    selectedProviderKind,
    selectedProviderPreset,
    selectedProviderPresetActive,
    selectedProviderPresetConfigured,
    selectedProviderPresets,
    selectedProviderProfile,
    selectedProviderProfileSaved,
    selectedProviderProfileStatus,
    supportsExternalProvider,
  }
}
