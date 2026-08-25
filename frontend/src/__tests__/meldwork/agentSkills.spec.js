import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useAgentSkills } from '../../composables/useAgentSkills.js'

function deferred() {
  let resolve
  const promise = new Promise(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

describe('Agent Skill catalog', () => {
  it('loads Skills for cloud connector Agents', async () => {
    const installer = { skills: vi.fn(async kind => ({
      supported: true,
      total: 1,
      skills: [{ targetKind: kind, namespace: 'hermes', slug: 'research', name: 'Research' }],
    })) }
    const skills = useAgentSkills({
      installer: ref(installer),
      mergedCatalog: ref([{
        kind: 'cloud-hermes', cloud: true, connector: true, custom: false,
      }]),
      normalizeSkill: (skill, targetKind) => ({ ...skill, targetKind }),
      readyAgents: ref([{ kind: 'cloud-hermes', cloud: true, custom: false }]),
      t: key => key,
    })

    await skills.selectAgentDetail('cloud-hermes')

    expect(installer.skills).toHaveBeenCalledWith('cloud-hermes')
    expect(skills.agentDetailSkillItems.value).toEqual([{
      targetKind: 'cloud-hermes', namespace: 'hermes', slug: 'research', name: 'Research',
    }])
  })

  it('does not repopulate the cache after disposal', async () => {
    const pending = deferred()
    const skills = useAgentSkills({
      installer: ref({ skills: vi.fn(() => pending.promise) }),
      mergedCatalog: ref([{ kind: 'codex' }]),
      normalizeSkill: (skill, targetKind) => ({ ...skill, targetKind }),
      readyAgents: ref([{ kind: 'codex' }]),
      t: key => key,
    })

    const loading = skills.loadAgentSkills(['codex'])
    skills.disposeAgentSkills()
    pending.resolve({
      supported: true,
      skills: [{ namespace: 'local', slug: 'review', name: 'Review' }],
    })
    const result = await loading

    expect(result).toEqual({ complete: false, skills: [] })
    expect(skills.agentSkillsSnapshot(['codex'])).toEqual({ complete: false, skills: [] })
  })
})
