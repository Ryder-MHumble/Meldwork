import { ref } from 'vue'
import { describe, expect, it } from 'vitest'
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
