import { computed, effectScope, nextTick, ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as composerContextModule from '../../composables/useComposerContext.js'
import { useComposerMentionMenu } from '../../composables/useComposerMentionMenu.js'

function deferred() {
  let resolve
  const promise = new Promise(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

function createMentionMenu(overrides = {}) {
  const activeGroup = ref({
    id: 'group-1',
    conversationType: 'group',
    agentKinds: ['codex', 'hermes'],
  })
  const draft = ref('@')
  const selectedAgentKinds = ref([])
  const selectedSkills = ref([])
  const selectedKnowledgeBases = ref([])
  const activeMentionAgentKind = ref('')
  const composerTargetKinds = computed(() => activeGroup.value?.agentKinds || [])
  const dependencies = {
    activeGroup,
    activeMentionAgentKind,
    addressedAgentKinds: ref([]),
    agentDescription: kind => `Description ${kind}`,
    agentSkillsSnapshot: () => ({ complete: true, skills: [] }),
    composerInput: ref({ focus: vi.fn() }),
    composerTargetKinds,
    draft,
    knowledgeBaseName: kind => kind,
    knowledgeBaseReady: () => false,
    loadAgentSkills: vi.fn(async () => ({ complete: true, skills: [] })),
    localKnowledgeBaseEntries: ref([]),
    notify: vi.fn(),
    preloadAgentSkills: vi.fn(async () => {}),
    selectedAgentKinds,
    selectedKnowledgeBases,
    selectedSkills,
    skillTargetSignature: computed(() => composerTargetKinds.value.join('\u0000')),
    t: key => key,
    theme: ref('light'),
    ...overrides,
  }
  const scope = effectScope()
  let menu
  scope.run(() => {
    menu = useComposerMentionMenu(dependencies)
  })
  return { dependencies, menu, scope }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('composer mention menu', () => {
  it('keeps the useComposerContext facade exports stable', () => {
    expect(Object.keys(composerContextModule).sort()).toEqual([
      'MAX_KNOWLEDGE_BASES',
      'MAX_SKILLS',
      'normalizeSkill',
      'parseSkillTrigger',
      'skillKey',
      'useComposerContext',
    ])
  })

  it('cycles through mention options and selects the active Agent with Enter', async () => {
    const { dependencies, menu, scope } = createMentionMenu()
    menu.handleMentionInput()

    expect(menu.composerMenuOptions.value.map(option => option.value)).toEqual(['codex', 'hermes'])
    const arrowEvent = { key: 'ArrowDown', preventDefault: vi.fn() }
    expect(menu.handleMentionKeydown(arrowEvent)).toBe(true)
    expect(menu.skillActiveIndex.value).toBe(1)

    const enterEvent = { key: 'Enter', isComposing: false, preventDefault: vi.fn() }
    expect(menu.handleMentionKeydown(enterEvent)).toBe(true)
    await nextTick()
    await flushPromises()

    expect(dependencies.selectedAgentKinds.value).toEqual(['hermes'])
    expect(dependencies.activeMentionAgentKind.value).toBe('hermes')
    expect(dependencies.draft.value).toBe('')
    expect(dependencies.preloadAgentSkills).toHaveBeenCalledWith(['hermes'])
    scope.stop()
  })

  it('ignores an in-flight Skill result after the menu is reset', async () => {
    const pendingSkills = deferred()
    const { menu, scope } = createMentionMenu({
      activeGroup: ref({
        id: 'direct-codex',
        conversationType: 'direct',
        agentKinds: ['codex'],
      }),
      agentSkillsSnapshot: () => ({ complete: false, skills: [] }),
      composerTargetKinds: ref(['codex']),
      loadAgentSkills: vi.fn(() => pendingSkills.promise),
      skillTargetSignature: ref('codex'),
    })

    const opening = menu.openSkillMenu()
    await nextTick()
    menu.resetMentionMenu()
    pendingSkills.resolve({
      complete: true,
      skills: [{ targetKind: 'codex', namespace: 'local', slug: 'review', name: 'Review' }],
    })
    await opening
    await flushPromises()

    expect(menu.composerMenuOptions.value).toEqual([])
    expect(menu.skillsLoading.value).toBe(false)
    scope.stop()
  })

  it('removes Agent-scoped Skills and knowledge targets together', () => {
    const selectedAgentKinds = ref(['codex', 'hermes'])
    const selectedSkills = ref([
      { targetKind: 'codex', namespace: 'local', slug: 'review', name: 'Review' },
      { targetKind: 'hermes', namespace: 'local', slug: 'research', name: 'Research' },
    ])
    const selectedKnowledgeBases = ref([
      { kind: 'obsidian', targetKinds: ['codex', 'hermes'] },
    ])
    const activeMentionAgentKind = ref('codex')
    const { menu, scope } = createMentionMenu({
      activeMentionAgentKind,
      selectedAgentKinds,
      selectedKnowledgeBases,
      selectedSkills,
    })

    menu.removeAgentMention('codex')

    expect(selectedAgentKinds.value).toEqual(['hermes'])
    expect(selectedSkills.value.map(skill => skill.targetKind)).toEqual(['hermes'])
    expect(selectedKnowledgeBases.value).toEqual([
      { kind: 'obsidian', targetKinds: ['hermes'] },
    ])
    expect(activeMentionAgentKind.value).toBe('hermes')
    scope.stop()
  })
})
