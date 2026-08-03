import { computed, nextTick, ref, watch } from 'vue'
import { agentLabel, agentLogo } from '../catalog.js'

export const MAX_SKILLS = 4
export const MAX_KNOWLEDGE_BASES = 4

export function parseSkillTrigger(value) {
  const match = /(^|\s)@([^\s@]*)$/.exec(String(value || ''))
  if (!match) return null
  return {
    query: match[2] || '',
    start: match.index + match[1].length,
    end: String(value || '').length,
  }
}

export function skillKey(skill) {
  return [skill?.targetKind, skill?.namespace, skill?.slug]
    .map(value => String(value || ''))
    .join(':')
}

export function useComposerMentionMenu({
  activeGroup,
  activeMentionAgentKind,
  addressedAgentKinds,
  agentDescription,
  agentSkillsSnapshot,
  composerInput,
  composerTargetKinds,
  draft,
  knowledgeBaseName,
  knowledgeBaseReady,
  loadAgentSkills,
  localKnowledgeBaseEntries,
  notify,
  preloadAgentSkills,
  selectedAgentKinds,
  selectedKnowledgeBases,
  selectedSkills,
  skillTargetSignature,
  t,
  theme,
}) {
  const skillOptions = ref([])
  const skillMenuOpen = ref(false)
  const skillActiveIndex = ref(0)
  const skillsLoading = ref(false)
  let skillLoadToken = 0

  const currentSkillTrigger = computed(() => parseSkillTrigger(draft.value))
  const skillMenuTargetKinds = computed(() => {
    const group = activeGroup.value
    if (!group) return []
    if (group.conversationType === 'direct') return [...group.agentKinds]
    if (activeMentionAgentKind.value && selectedAgentKinds.value.includes(activeMentionAgentKind.value)) {
      return [activeMentionAgentKind.value]
    }
    return []
  })
  const knowledgeBaseSelectionTargetKinds = computed(() => {
    const group = activeGroup.value
    if (!group) return []
    return group.conversationType === 'direct'
      ? [...group.agentKinds]
      : addressedAgentKinds.value.length
        ? [...addressedAgentKinds.value]
        : [...group.agentKinds]
  })
  const filteredAgentMentionOptions = computed(() => {
    const group = activeGroup.value
    if (!group || group.conversationType === 'direct' || !currentSkillTrigger.value) return []
    const query = currentSkillTrigger.value.query.toLocaleLowerCase()
    const selected = new Set(selectedAgentKinds.value)
    return group.agentKinds
      .filter(kind => !selected.has(kind))
      .filter((kind) => {
        if (!query) return true
        return [kind, agentLabel(kind)]
          .some(value => String(value || '').toLocaleLowerCase().includes(query))
      })
      .slice(0, 8)
  })
  const filteredSkillOptions = computed(() => {
    const query = currentSkillTrigger.value?.query.toLocaleLowerCase() || ''
    const selected = new Set(selectedSkills.value.map(skillKey))
    return skillOptions.value
      .filter(skill => !selected.has(skillKey(skill)))
      .filter((skill) => {
        if (!query) return true
        return [skill.name, skill.slug, skill.namespace, agentLabel(skill.targetKind)]
          .some(value => String(value || '').toLocaleLowerCase().includes(query))
      })
      .slice(0, 8)
  })
  const filteredKnowledgeBaseOptions = computed(() => {
    if (!knowledgeBaseSelectionTargetKinds.value.length) return []
    const query = currentSkillTrigger.value?.query.toLocaleLowerCase() || ''
    const targets = knowledgeBaseSelectionTargetKinds.value
    const selected = new Map(selectedKnowledgeBases.value.map(source => [source.kind, source]))
    return localKnowledgeBaseEntries.value
      .filter(knowledgeBaseReady)
      .filter((source) => {
        const existingTargets = new Set(selected.get(source.kind)?.targetKinds || [])
        return targets.some(kind => !existingTargets.has(kind))
      })
      .filter((source) => {
        if (!query) return true
        return [source.kind, knowledgeBaseName(source.kind), t(`composer.knowledgeBaseDescription.${source.kind}`)]
          .some(value => String(value || '').toLocaleLowerCase().includes(query))
      })
      .slice(0, MAX_KNOWLEDGE_BASES)
  })
  const composerMenuGroups = computed(() => [
    {
      type: 'knowledge-base',
      label: t('composer.mentionSection.knowledge-base'),
      options: filteredKnowledgeBaseOptions.value.map(source => ({ type: 'knowledge-base', value: source })),
    },
    {
      type: 'skill',
      label: t('composer.mentionSection.skill'),
      options: filteredSkillOptions.value.map(skill => ({ type: 'skill', value: skill })),
    },
    {
      type: 'agent',
      label: t('composer.mentionSection.agent'),
      options: filteredAgentMentionOptions.value.map(kind => ({ type: 'agent', value: kind })),
    },
  ].filter(group => group.options.length))
  const composerMenuOptions = computed(() => composerMenuGroups.value.flatMap(group => group.options))
  const activeSkillOptionId = computed(() => (
    skillMenuOpen.value && composerMenuOptions.value[skillActiveIndex.value]
      ? `composer-mention-option-${skillActiveIndex.value}`
      : ''
  ))

  function uniqueSkills(skills) {
    const seen = new Set()
    return skills.filter((skill) => {
      const key = skillKey(skill)
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  async function loadSkillsForTargets() {
    const targets = [...skillMenuTargetKinds.value]
    const token = ++skillLoadToken
    if (!targets.length) {
      skillOptions.value = []
      skillsLoading.value = false
      return
    }
    const cached = agentSkillsSnapshot(targets)
    skillOptions.value = uniqueSkills(cached.skills)
    skillsLoading.value = !cached.complete
    if (cached.complete) return
    try {
      const loaded = await loadAgentSkills(targets)
      if (token !== skillLoadToken) return
      skillOptions.value = uniqueSkills(loaded.skills)
    } finally {
      if (token === skillLoadToken) skillsLoading.value = false
    }
  }

  function composerMenuOptionKey(option) {
    if (option?.type === 'skill') return skillKey(option.value)
    if (option?.type === 'knowledge-base') return `knowledge:${option.value?.kind}`
    return `agent:${option?.value}`
  }

  function composerMenuOptionIndex(option) {
    return composerMenuOptions.value.indexOf(option)
  }

  function composerMenuOptionLogo(option) {
    if (option?.type === 'knowledge-base') return option.value?.logo || ''
    if (option?.type === 'agent') return agentLogo(option.value, theme.value)
    return ''
  }

  function composerMenuOptionTitle(option) {
    if (option?.type === 'skill') return option.value?.name || option.value?.slug || ''
    if (option?.type === 'knowledge-base') return knowledgeBaseName(option.value?.kind)
    return agentLabel(option?.value)
  }

  function composerMenuOptionDescription(option) {
    if (option?.type === 'skill') {
      return `${agentLabel(option.value?.targetKind)} / ${option.value?.namespace || t('composer.skills')}`
    }
    if (option?.type === 'knowledge-base') {
      return t(`composer.knowledgeBaseDescription.${option.value?.kind}`)
    }
    return agentDescription(option?.value)
  }

  function composerMenuOptionKindLabel(option) {
    return t(`composer.mentionType.${option?.type || 'skill'}`)
  }

  function composerMenuOptionDisabled(option) {
    if (option?.type === 'skill') return selectedSkills.value.length >= MAX_SKILLS
    if (option?.type === 'knowledge-base') {
      const alreadySelected = selectedKnowledgeBases.value.some(source => source.kind === option.value?.kind)
      return !alreadySelected && selectedKnowledgeBases.value.length >= MAX_KNOWLEDGE_BASES
    }
    return false
  }

  function handleMentionInput() {
    if (!currentSkillTrigger.value) {
      skillMenuOpen.value = false
      return
    }
    const shouldLoad = !skillMenuOpen.value
    skillActiveIndex.value = 0
    skillMenuOpen.value = true
    if (shouldLoad && skillMenuTargetKinds.value.length) void loadSkillsForTargets()
    else if (!skillMenuTargetKinds.value.length) skillsLoading.value = false
  }

  async function openSkillMenu() {
    if (!composerTargetKinds.value.length && activeGroup.value?.conversationType === 'direct') {
      notify(t('composer.selectTarget'))
      return
    }
    if (!currentSkillTrigger.value) {
      const spacer = draft.value && !/\s$/.test(draft.value) ? ' ' : ''
      draft.value = `${draft.value}${spacer}@`
    }
    skillActiveIndex.value = 0
    skillMenuOpen.value = true
    if (skillMenuTargetKinds.value.length) await loadSkillsForTargets()
    await nextTick()
    composerInput.value?.focus()
  }

  async function addAgentMention(kind) {
    const group = activeGroup.value
    if (!group || group.conversationType === 'direct' || !group.agentKinds.includes(kind)) return
    if (!selectedAgentKinds.value.includes(kind)) {
      selectedAgentKinds.value = [...selectedAgentKinds.value, kind]
    }
    activeMentionAgentKind.value = kind
    skillMenuOpen.value = false
    skillsLoading.value = false
    void preloadAgentSkills([kind])
    await nextTick()
    composerInput.value?.focus()
  }

  async function selectAgentMention(kind) {
    const trigger = currentSkillTrigger.value
    if (trigger) draft.value = `${draft.value.slice(0, trigger.start)}${draft.value.slice(trigger.end)}`
    await addAgentMention(kind)
  }

  function removeAgentMention(kind) {
    selectedAgentKinds.value = selectedAgentKinds.value.filter(item => item !== kind)
    selectedSkills.value = selectedSkills.value.filter(skill => skill.targetKind !== kind)
    selectedKnowledgeBases.value = selectedKnowledgeBases.value
      .map(source => ({ ...source, targetKinds: source.targetKinds.filter(target => target !== kind) }))
      .filter(source => source.targetKinds.length)
    activeMentionAgentKind.value = selectedAgentKinds.value.at(-1) || ''
    skillMenuOpen.value = false
    skillsLoading.value = false
    skillOptions.value = []
    skillLoadToken += 1
  }

  function selectComposerMenuOption(option) {
    if (option?.type === 'agent') return selectAgentMention(option.value)
    if (option?.type === 'skill') return selectSkill(option.value)
    if (option?.type === 'knowledge-base') return selectKnowledgeBase(option.value)
    return undefined
  }

  async function selectSkill(skill) {
    if (selectedSkills.value.length >= MAX_SKILLS) {
      notify(t('composer.skillLimit'))
      return
    }
    const key = skillKey(skill)
    if (!selectedSkills.value.some(item => skillKey(item) === key)) {
      selectedSkills.value = [...selectedSkills.value, { ...skill }]
    }
    const trigger = currentSkillTrigger.value
    if (trigger) draft.value = `${draft.value.slice(0, trigger.start)}${draft.value.slice(trigger.end)}`
    skillMenuOpen.value = false
    await nextTick()
    composerInput.value?.focus()
  }

  function removeSkill(skill) {
    const key = skillKey(skill)
    selectedSkills.value = selectedSkills.value.filter(item => skillKey(item) !== key)
  }

  async function selectKnowledgeBase(source) {
    const targets = [...knowledgeBaseSelectionTargetKinds.value]
    if (!source?.kind || !targets.length) return
    const existing = selectedKnowledgeBases.value.find(item => item.kind === source.kind)
    if (!existing && selectedKnowledgeBases.value.length >= MAX_KNOWLEDGE_BASES) {
      notify(t('composer.knowledgeBaseLimit'))
      return
    }
    const targetKinds = [...new Set([...(existing?.targetKinds || []), ...targets])]
    selectedKnowledgeBases.value = [
      ...selectedKnowledgeBases.value.filter(item => item.kind !== source.kind),
      { kind: source.kind, targetKinds },
    ]
    const trigger = currentSkillTrigger.value
    if (trigger) draft.value = `${draft.value.slice(0, trigger.start)}${draft.value.slice(trigger.end)}`
    skillMenuOpen.value = false
    await nextTick()
    composerInput.value?.focus()
  }

  function removeKnowledgeBase(kind) {
    selectedKnowledgeBases.value = selectedKnowledgeBases.value.filter(source => source.kind !== kind)
  }

  function handleMentionKeydown(event) {
    if (skillMenuOpen.value) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const count = composerMenuOptions.value.length
        if (count) {
          const direction = event.key === 'ArrowDown' ? 1 : -1
          skillActiveIndex.value = (skillActiveIndex.value + direction + count) % count
        }
        return true
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        skillMenuOpen.value = false
        return true
      }
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault()
        const option = composerMenuOptions.value[skillActiveIndex.value]
        if (option) void selectComposerMenuOption(option)
        else skillMenuOpen.value = false
        return true
      }
    }
    if (event.key === 'Backspace' && !draft.value && selectedAgentKinds.value.length) {
      event.preventDefault()
      removeAgentMention(selectedAgentKinds.value.at(-1))
      return true
    }
    return false
  }

  function resetMentionMenu() {
    skillMenuOpen.value = false
    skillsLoading.value = false
    skillOptions.value = []
    skillLoadToken += 1
  }

  function disposeMentionMenu() {
    skillLoadToken += 1
  }

  watch(skillTargetSignature, () => {
    const targets = new Set(composerTargetKinds.value)
    selectedSkills.value = selectedSkills.value.filter(skill => targets.has(skill.targetKind))
    selectedKnowledgeBases.value = selectedKnowledgeBases.value
      .map(source => ({
        ...source,
        targetKinds: source.targetKinds.filter(kind => targets.has(kind)),
      }))
      .filter(source => source.targetKinds.length)
    skillOptions.value = []
    skillActiveIndex.value = 0
    skillsLoading.value = false
    skillLoadToken += 1
    if (skillMenuOpen.value && currentSkillTrigger.value) void loadSkillsForTargets()
  })
  watch(() => composerMenuOptions.value.length, (length) => {
    skillActiveIndex.value = length ? Math.min(skillActiveIndex.value, length - 1) : 0
  })

  return {
    activeSkillOptionId,
    addAgentMention,
    composerMenuGroups,
    composerMenuOptionDescription,
    composerMenuOptionDisabled,
    composerMenuOptionIndex,
    composerMenuOptionKey,
    composerMenuOptionKindLabel,
    composerMenuOptionLogo,
    composerMenuOptions,
    composerMenuOptionTitle,
    disposeMentionMenu,
    handleMentionInput,
    handleMentionKeydown,
    openSkillMenu,
    removeAgentMention,
    removeKnowledgeBase,
    removeSkill,
    resetMentionMenu,
    selectComposerMenuOption,
    skillActiveIndex,
    skillMenuOpen,
    skillsLoading,
  }
}
