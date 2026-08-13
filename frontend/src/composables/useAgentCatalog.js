import { computed } from 'vue'
import {
  CheckmarkCircleOutline,
  DownloadOutline,
  WarningOutline,
} from '@vicons/ionicons5'
import { AGENTS, agentLogo } from '../catalog.js'

export function useAgentCatalog({
  activeGroup,
  directGroupsFor,
  installCatalog,
  snapshot,
  t,
  theme,
}) {
  const mergedCatalog = computed(() => AGENTS.map((profile) => {
    const installedProfile = installCatalog.value.agents?.find(agent => agent.kind === profile.kind) || {}
    const detected = snapshot.value.agents.find(agent => agent.kind === profile.kind) || {}
    return {
      ...profile,
      ...installedProfile,
      ...detected,
      label: profile.label,
      logo: agentLogo(profile.kind, theme.value),
      providerMode: profile.providerMode,
      imageLimit: profile.custom
        ? MAX_ATTACHMENTS
        : Number(detected.imageAttachmentLimit ?? installedProfile.imageAttachmentLimit ?? profile.imageLimit) || 0,
      installed: Boolean(installedProfile.installed || detected.installed),
      ready: detected.available === true,
    }
  }))

  const agentCatalogGroups = computed(() => [
    {
      id: 'official',
      titleKey: 'systemSettings.officialAgents',
      subtitleKey: 'systemSettings.officialAgentsHint',
      agents: mergedCatalog.value.filter(agent => !agent.custom),
    },
  ])
  const readyAgents = computed(() => mergedCatalog.value.filter(agent => agent.ready))
  const readyAgentSignature = computed(() => readyAgents.value.map(agent => agent.kind).join('\u0000'))
  const readyAgentKinds = computed(() => new Set(readyAgents.value.map(agent => agent.kind)))
  const readyCount = computed(() => readyAgents.value.length)
  const installedCount = computed(() => mergedCatalog.value.filter(agent => agent.installed).length)
  const sidebarAgents = computed(() => mergedCatalog.value.filter((agent) => {
    if (agent.ready) return agent.showInSidebar !== false
    return directGroupsFor(agent.kind).length > 0
  }))
  const activeDirectAgent = computed(() => {
    if (activeGroup.value?.conversationType !== 'direct') return null
    return mergedCatalog.value.find(agent => agent.kind === activeGroup.value.directAgentKind) || null
  })

  function providerModeShortLabel(mode) {
    return t(`agent.providerShort.${mode}`)
  }

  function agentDescription(kind) {
    const profile = mergedCatalog.value.find(agent => agent.kind === kind)
    if (profile?.custom && profile.description) return profile.description
    if (profile?.custom) return t('customAgent.defaultDescription')
    return t(`agent.description.${kind}`)
  }

  function agentSoul(agent) {
    if (agent?.custom) return agent.description || t('customAgent.detailBody')
    return t(`agent.soul.${agent?.kind}`)
  }

  function agentImageLabel(agent) {
    return agent?.imageLimit > 0
      ? t('agent.images', { count: agent.imageLimit })
      : t('agent.noImages')
  }

  function agentState(agent) {
    if (agent.ready) return { label: t('agent.ready'), tone: 'ready', icon: CheckmarkCircleOutline }
    if (agent.custom) return { label: t('customAgent.executableUnavailable'), tone: 'warning', icon: WarningOutline }
    if (!agent.installed) return { label: t('agent.notInstalled'), tone: 'off', icon: DownloadOutline }
    if (agent.compatibilityState === 'incompatible') {
      const reasonKey = ({
        LOCAL_AGENT_VERSION_UNSUPPORTED: 'agent.incompatibleVersion',
        LOCAL_AGENT_REQUIRED_CAPABILITY_MISSING: 'agent.incompatibleCapability',
        LOCAL_AGENT_PROTOCOL_UNAVAILABLE: 'agent.incompatibleProtocol',
      })[agent.incompatibilityReason] || 'agent.incompatible'
      return { label: t(reasonKey), tone: 'warning', icon: WarningOutline }
    }
    if (agent.credentialState === 'missing') return { label: t('agent.needsLogin'), tone: 'warning', icon: WarningOutline }
    return { label: t('agent.unverified'), tone: 'neutral', icon: WarningOutline }
  }

  return {
    activeDirectAgent,
    agentCatalogGroups,
    agentDescription,
    agentImageLabel,
    agentSoul,
    agentState,
    installedCount,
    mergedCatalog,
    providerModeShortLabel,
    readyAgentKinds,
    readyAgentSignature,
    readyAgents,
    readyCount,
    sidebarAgents,
  }
}
