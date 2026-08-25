import { ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { agentLogo, setCloudAgentProfiles } from '../../catalog.js'
import { useAgentCatalog } from '../../composables/useAgentCatalog.js'
import { setLocale, t } from '../../i18n.js'

function catalogFor(agent) {
  const catalog = useAgentCatalog({
    activeGroup: ref(null),
    directGroupsFor: () => [],
    installCatalog: ref({ agents: [{ kind: agent.kind, installed: true }] }),
    snapshot: ref({ agents: [agent] }),
    t,
    theme: ref('light'),
  })
  const merged = catalog.mergedCatalog.value.find(item => item.kind === agent.kind)
  return catalog.agentState(merged)
}

describe('Agent compatibility state', () => {
  it('keeps cloud Agents out of the local catalog and groups ready Agents by execution location', () => {
    setLocale('en')
    const cloudAgent = {
      kind: 'cloud-0123456789abcdef01234567',
      sourceKind: 'codex',
      label: 'Cloud Codex',
      custom: false,
      connector: true,
      cloud: true,
      installed: true,
      available: true,
      credentialState: 'ready',
      showInSidebar: true,
    }
    const catalog = useAgentCatalog({
      activeGroup: ref(null),
      directGroupsFor: () => [],
      installCatalog: ref({ agents: [{ kind: 'codex', installed: true }, cloudAgent] }),
      snapshot: ref({ agents: [
        { kind: 'codex', installed: true, available: true, credentialState: 'ready', showInSidebar: true },
        cloudAgent,
      ] }),
      t,
      theme: ref('light'),
    })

    expect(catalog.agentCatalogGroups.value.find(group => group.id === 'official').agents.map(agent => agent.kind))
      .not.toContain('cloud-0123456789abcdef01234567')
    expect(catalog.readyAgentGroups.value.map(group => [group.id, group.agents.map(agent => agent.kind)]))
      .toEqual([['local', ['codex']], ['cloud', ['cloud-0123456789abcdef01234567']]])
    expect(catalog.sidebarAgentGroups.value.map(group => [group.id, group.agents.map(agent => agent.kind)]))
      .toEqual([['local', ['codex']], ['cloud', ['cloud-0123456789abcdef01234567']]])
    const mergedCloud = catalog.mergedCatalog.value.find(agent => agent.kind === 'cloud-0123456789abcdef01234567')
    expect(mergedCloud.logo).toContain('agent-logos/codex.svg')
    setCloudAgentProfiles([cloudAgent])
    expect(agentLogo('cloud-0123456789abcdef01234567')).toContain('agent-logos/codex.svg')
  })

  it('keeps an installed cloud Agent that needs login in management but out of chat choices', () => {
    setLocale('en')
    const cloudAgent = {
      kind: 'cloud-claude', sourceKind: 'claude', label: 'Claude Code @ Server',
      cloud: true, connector: true, custom: false, installed: true,
      available: false, credentialState: 'missing', showInSidebar: true,
    }
    const catalog = useAgentCatalog({
      activeGroup: ref(null),
      directGroupsFor: () => [],
      installCatalog: ref({ agents: [cloudAgent] }),
      snapshot: ref({ agents: [] }),
      t,
      theme: ref('light'),
    })

    expect(catalog.agentCatalogGroups.value.find(group => group.id === 'cloud').agents)
      .toHaveLength(1)
    expect(catalog.readyAgents.value).toHaveLength(0)
    const mergedCloud = catalog.mergedCatalog.value.find(agent => agent.kind === 'cloud-claude')
    expect(catalog.agentState(mergedCloud).label).toBe('Needs sign-in or Provider')
  })

  it('keeps ready OpenCodeReview available for sidebar and composer targets', () => {
    setLocale('en')
    const catalog = useAgentCatalog({
      activeGroup: ref(null),
      directGroupsFor: () => [],
      installCatalog: ref({ agents: [{ kind: 'opencodereview', installed: true }] }),
      snapshot: ref({
        agents: [{
          kind: 'opencodereview',
          installed: true,
          available: true,
          credentialState: 'ready',
          showInSidebar: true,
          task: 'code_review',
          version: '1.8.6',
        }],
      }),
      t,
      theme: ref('light'),
    })

    expect(catalog.readyAgents.value.map(agent => agent.kind)).toContain('opencodereview')
    expect(catalog.sidebarAgents.value.map(agent => agent.kind)).toContain('opencodereview')
    expect(catalog.readyAgentKinds.value.has('opencodereview')).toBe(true)
  })

  it.each([
    ['LOCAL_AGENT_VERSION_UNSUPPORTED', 'Unsupported version'],
    ['LOCAL_AGENT_REQUIRED_CAPABILITY_MISSING', 'Required capability missing'],
    ['LOCAL_AGENT_PROTOCOL_UNAVAILABLE', 'Required protocol unavailable'],
  ])('shows a stable reason for %s', (incompatibilityReason, label) => {
    setLocale('en')
    const state = catalogFor({
      kind: 'codex',
      installed: true,
      available: false,
      credentialState: 'ready',
      compatibilityState: 'incompatible',
      incompatibilityReason,
    })

    expect(state.label).toBe(label)
    expect(state.tone).toBe('warning')
  })
})
