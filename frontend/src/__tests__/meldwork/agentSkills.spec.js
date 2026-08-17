import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useAgentSkills } from '../../composables/useAgentSkills.js'

function deferred() {
  let resolve
  const promise = new Promise(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

describe('Agent Skill catalog', () => {
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
