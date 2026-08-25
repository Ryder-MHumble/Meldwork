import { computed, ref, watch } from 'vue'

export function useCloudAgentBridges({ bridgeApi, refreshAgents, showError }) {
  const bridges = ref([])
  const address = ref('')
  const label = ref('')
  const loading = ref(false)
  const saving = ref(false)
  const error = ref('')

  async function load() {
    if (!bridgeApi.value?.list) return
    loading.value = true
    try {
      bridges.value = await bridgeApi.value.list()
      error.value = ''
    } catch (reason) {
      error.value = String(reason?.code || reason?.message || 'CLOUD_AGENT_BRIDGE_LIST_FAILED')
    } finally {
      loading.value = false
    }
  }

  async function connect() {
    if (!bridgeApi.value?.connect || !address.value.trim() || saving.value) return
    saving.value = true
    error.value = ''
    try {
      await bridgeApi.value.connect({
        address: address.value.trim(),
        ...(label.value.trim() ? { label: label.value.trim() } : {}),
      })
      address.value = ''
      label.value = ''
      await load()
      await refreshAgents?.()
    } catch (reason) {
      error.value = String(reason?.code || reason?.message || 'CLOUD_AGENT_BRIDGE_CONNECT_FAILED')
      showError?.(reason)
    } finally {
      saving.value = false
    }
  }

  async function refresh() {
    if (!bridgeApi.value?.refresh || saving.value) return
    saving.value = true
    try {
      bridges.value = await bridgeApi.value.refresh()
      error.value = ''
      await refreshAgents?.()
    } catch (reason) {
      error.value = String(reason?.code || reason?.message || 'CLOUD_AGENT_BRIDGE_REFRESH_FAILED')
      showError?.(reason)
    } finally {
      saving.value = false
    }
  }

  async function remove(bridgeId) {
    if (!bridgeApi.value?.delete || saving.value) return
    saving.value = true
    try {
      await bridgeApi.value.delete(bridgeId)
      await load()
      await refreshAgents?.()
    } catch (reason) {
      error.value = String(reason?.code || reason?.message || 'CLOUD_AGENT_BRIDGE_DELETE_FAILED')
      showError?.(reason)
    } finally {
      saving.value = false
    }
  }

  watch(bridgeApi, value => {
    if (value) void load()
  }, { immediate: true })

  return {
    address,
    bridges,
    connect,
    error: computed(() => error.value),
    label,
    loading,
    refresh,
    remove,
    saving,
  }
}
