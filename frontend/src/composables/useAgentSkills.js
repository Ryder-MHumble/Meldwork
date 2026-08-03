import { computed, ref } from 'vue'

export function useAgentSkills({
  installer,
  mergedCatalog,
  normalizeSkill,
  readyAgents,
  t,
}) {
  const agentSkillStats = ref({})
  const agentSkillCatalog = ref({})
  const selectedAgentDetailKind = ref('')
  const agentDetailSkillItems = ref([])
  const agentDetailSkillsLoading = ref(false)
  const agentSkillCatalogRequests = new Map()
  let agentSkillCatalogGeneration = 0
  let agentSkillStatsToken = 0
  let agentDetailSkillToken = 0

  const selectedAgentDetail = computed(() => (
    mergedCatalog.value.find(agent => agent.kind === selectedAgentDetailKind.value) || null
  ))
  const agentDetailSkillSummary = computed(() => {
    if (selectedAgentDetail.value?.custom) return t('customAgent.skillsUnsupported')
    if (agentDetailSkillsLoading.value) return t('agent.skillsLoading')
    if (!agentDetailSkillItems.value.length) return t('agent.skillsUnavailable')
    return t('agent.localSkills', { count: agentDetailSkillItems.value.length })
  })

  function agentSkillLabel(kind) {
    if (mergedCatalog.value.find(agent => agent.kind === kind)?.custom) {
      return t('customAgent.skillsUnsupported')
    }
    const state = agentSkillStats.value[kind]
    if (!state || state.loading) return t('agent.skillsLoading')
    if (!Number.isFinite(state.total)) return t('agent.skillsUnavailable')
    return t('agent.localSkills', { count: state.total })
  }

  function normalizeAgentSkillCatalog(result, kind) {
    const supported = result?.supported !== false
    const skills = supported
      ? (Array.isArray(result?.skills) ? result.skills : [])
        .map(skill => normalizeSkill(skill, kind))
        .filter(Boolean)
      : []
    const requestedTotal = Number(result?.total)
    return {
      supported,
      total: Number.isFinite(requestedTotal) ? requestedTotal : skills.length,
      skills,
    }
  }

  function invalidateAgentSkillCatalog() {
    agentSkillCatalogGeneration += 1
    agentSkillCatalogRequests.clear()
    agentSkillCatalog.value = {}
  }

  async function loadAgentSkillCatalog(kind, options = {}) {
    const targetKind = String(kind || '')
    if (!targetKind || typeof installer.value?.skills !== 'function') return null
    if (!options.refresh && agentSkillCatalog.value[targetKind]) {
      return agentSkillCatalog.value[targetKind]
    }
    if (agentSkillCatalogRequests.has(targetKind)) return agentSkillCatalogRequests.get(targetKind)
    const generation = agentSkillCatalogGeneration
    const request = Promise.resolve(installer.value.skills(targetKind))
      .then(result => normalizeAgentSkillCatalog(result, targetKind))
      .catch(() => ({ supported: false, total: NaN, skills: [] }))
      .then((catalog) => {
        if (generation === agentSkillCatalogGeneration) {
          agentSkillCatalog.value = { ...agentSkillCatalog.value, [targetKind]: catalog }
        }
        return catalog
      })
      .finally(() => {
        if (agentSkillCatalogRequests.get(targetKind) === request) {
          agentSkillCatalogRequests.delete(targetKind)
        }
      })
    agentSkillCatalogRequests.set(targetKind, request)
    return request
  }

  function agentSkillsSnapshot(kinds) {
    const targets = [...new Set((Array.isArray(kinds) ? kinds : [])
      .map(kind => String(kind || ''))
      .filter(Boolean))]
    return {
      complete: targets.every(kind => Boolean(agentSkillCatalog.value[kind])),
      skills: targets.flatMap(kind => agentSkillCatalog.value[kind]?.skills || []),
    }
  }

  async function loadAgentSkills(kinds) {
    const targets = [...new Set((Array.isArray(kinds) ? kinds : [])
      .map(kind => String(kind || ''))
      .filter(Boolean))]
    await Promise.all(targets.map(kind => loadAgentSkillCatalog(kind)))
    return agentSkillsSnapshot(targets)
  }

  async function loadAgentSkillStats() {
    if (typeof installer.value?.skills !== 'function') return
    const kinds = readyAgents.value.filter(agent => !agent.custom).map(agent => agent.kind)
    const token = ++agentSkillStatsToken
    const next = { ...agentSkillStats.value }
    for (const kind of kinds) next[kind] = { loading: true, total: next[kind]?.total }
    agentSkillStats.value = next
    const results = await Promise.all(kinds.map(async kind => [kind, await loadAgentSkillCatalog(kind)]))
    if (token !== agentSkillStatsToken) return
    agentSkillStats.value = Object.fromEntries(results.map(([kind, catalog]) => [kind, {
      loading: false,
      total: catalog?.supported === false || !Number.isFinite(catalog?.total) ? NaN : catalog.total,
    }]))
  }

  async function preloadAgentSkills(kinds) {
    const targets = [...new Set((Array.isArray(kinds) ? kinds : [])
      .map(kind => String(kind || ''))
      .filter(Boolean))]
    await Promise.all(targets.map(kind => loadAgentSkillCatalog(kind)))
  }

  async function loadAgentDetailSkills(kind) {
    const targetKind = String(kind || '')
    const token = ++agentDetailSkillToken
    agentDetailSkillItems.value = []
    if (mergedCatalog.value.find(agent => agent.kind === targetKind)?.custom) {
      agentDetailSkillsLoading.value = false
      return
    }
    if (!targetKind || typeof installer.value?.skills !== 'function') {
      agentDetailSkillsLoading.value = false
      return
    }
    agentDetailSkillsLoading.value = true
    try {
      const catalog = await loadAgentSkillCatalog(targetKind)
      if (token === agentDetailSkillToken) agentDetailSkillItems.value = catalog?.skills?.slice(0, 12) || []
    } catch {
      if (token === agentDetailSkillToken) agentDetailSkillItems.value = []
    } finally {
      if (token === agentDetailSkillToken) agentDetailSkillsLoading.value = false
    }
  }

  function selectAgentDetail(kind) {
    selectedAgentDetailKind.value = String(kind || '')
    agentDetailSkillItems.value = []
    agentDetailSkillsLoading.value = false
    return loadAgentDetailSkills(selectedAgentDetailKind.value)
  }

  function resetAgentDetailSkills() {
    selectedAgentDetailKind.value = ''
    agentDetailSkillToken += 1
    agentDetailSkillItems.value = []
    agentDetailSkillsLoading.value = false
  }

  function disposeAgentSkills() {
    agentSkillStatsToken += 1
    agentDetailSkillToken += 1
    invalidateAgentSkillCatalog()
  }

  return {
    agentDetailSkillItems,
    agentDetailSkillSummary,
    agentDetailSkillsLoading,
    agentSkillLabel,
    agentSkillsSnapshot,
    disposeAgentSkills,
    invalidateAgentSkillCatalog,
    loadAgentSkills,
    loadAgentSkillStats,
    preloadAgentSkills,
    resetAgentDetailSkills,
    selectAgentDetail,
    selectedAgentDetail,
  }
}
