import {
  CheckmarkCircleOutline,
  DownloadOutline,
  RefreshOutline,
  WarningOutline,
} from '@vicons/ionicons5'
import { AGENTS } from './catalog.js'
import { inferProviderPreset } from './providerProfiles.js'

const EXTERNAL_PROVIDER_KINDS = new Set(AGENTS.map(agent => agent.kind))
const NATIVE_PROVIDER_READY_SOURCES = new Set([
  'native-credential', 'native-auth-status', 'native-cli', 'verified-run',
])

export const EMPTY_PROVIDER_STATUS = Object.freeze({
  provider: '',
  baseUrl: '',
  model: '',
  activePreset: 'official',
  profiles: {},
  configured: false,
  encryptionAvailable: true,
  error: false,
})

export function supportsExternalProvider(agent) {
  return EXTERNAL_PROVIDER_KINDS.has(agent?.kind)
}

export function providerStatusFor(statuses, kind) {
  return statuses?.[kind] || EMPTY_PROVIDER_STATUS
}

export function hasProviderStatus(statuses, kind) {
  return Object.prototype.hasOwnProperty.call(statuses || {}, String(kind || ''))
}

export function providerProfilesFor(statuses, kind) {
  const status = providerStatusFor(statuses, kind)
  if (status.profiles && typeof status.profiles === 'object' && !Array.isArray(status.profiles)) {
    return status.profiles
  }
  if (!status.configured) return {}
  const preset = status.activePreset || inferProviderPreset(kind, status)
  return {
    [preset]: {
      provider: status.provider,
      baseUrl: status.baseUrl,
      model: status.model,
      configured: true,
    },
  }
}

export function nativeProviderReady(agent) {
  return Boolean(agent?.ready && NATIVE_PROVIDER_READY_SOURCES.has(String(agent.availabilitySource || '')))
}

export function activeSavedProviderPreset(statuses, kind) {
  const status = providerStatusFor(statuses, kind)
  if (!hasProviderStatus(statuses, kind) || status.error || !status.configured) return ''
  const preset = status.activePreset || inferProviderPreset(kind, status)
  return providerProfilesFor(statuses, kind)[preset]?.configured ? preset : ''
}

export function providerActiveSourceFor(agents, statuses, kind) {
  const agent = agents.find(item => item.kind === kind)
  if (!agent?.installed || !hasProviderStatus(statuses, kind) || providerStatusFor(statuses, kind).error) return ''
  const savedPreset = activeSavedProviderPreset(statuses, kind)
  if (savedPreset) return savedPreset
  return nativeProviderReady(agent) ? 'official' : ''
}

export function providerAgentState({ agents, checking, kind, statuses, t }) {
  const agent = agents.find(item => item.kind === kind)
  const agentName = agent?.label || String(kind || '')
  if (!agent?.installed) {
    return {
      id: 'not-installed',
      label: t('provider.state.notInstalled'),
      detail: t('provider.state.notInstalledBody', { agent: agentName }),
      tone: 'warning',
      icon: DownloadOutline,
    }
  }
  if (checking && !hasProviderStatus(statuses, kind)) {
    return {
      id: 'checking',
      label: t('provider.checking'),
      detail: t('provider.state.checkingBody', { agent: agentName }),
      tone: 'checking',
      icon: RefreshOutline,
    }
  }
  if (providerStatusFor(statuses, kind).error) {
    return {
      id: 'unavailable',
      label: t('provider.unavailable'),
      detail: t('provider.state.unavailableBody', { agent: agentName }),
      tone: 'warning',
      icon: WarningOutline,
    }
  }
  const savedPreset = activeSavedProviderPreset(statuses, kind)
  if (savedPreset) {
    const source = t(`provider.preset.${savedPreset}`)
    return {
      id: 'active-override',
      label: t('provider.state.overrideActive', { provider: source }),
      detail: t('provider.state.overrideActiveBody', { agent: agentName, provider: source }),
      tone: 'connected',
      icon: CheckmarkCircleOutline,
    }
  }
  if (nativeProviderReady(agent)) {
    return {
      id: 'native-ready',
      label: t('provider.nativeReady'),
      detail: t('provider.state.nativeReadyBody', { agent: agentName }),
      tone: 'connected',
      icon: CheckmarkCircleOutline,
    }
  }
  if (agent.credentialState === 'missing') {
    return {
      id: 'login-required',
      label: t('provider.state.loginRequired'),
      detail: t('provider.state.loginRequiredBody', { agent: agentName }),
      tone: 'warning',
      icon: WarningOutline,
    }
  }
  return {
    id: 'unverified',
    label: t('provider.state.unverified'),
    detail: t('provider.state.unverifiedBody', { agent: agentName }),
    tone: 'neutral',
    icon: WarningOutline,
  }
}

export function providerSummaryLabel({ agent, statuses, t }) {
  if (!agent) return ''
  if (agent.custom) return t('customAgent.cliManaged')
  if (supportsExternalProvider(agent)) {
    const status = providerStatusFor(statuses, agent.kind)
    if (!hasProviderStatus(statuses, agent.kind)) return t('provider.checking')
    if (status.error) return t('provider.unavailable')
    if (status.configured) return t('provider.configured')
    if (nativeProviderReady(agent)) return t('provider.nativeReady')
    return t('provider.notConfigured')
  }
  if (agent.ready) return t('provider.nativeConnected')
  return t(`agent.provider.${agent.providerMode}`)
}
