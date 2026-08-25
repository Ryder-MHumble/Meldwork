import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useCloudAgentBridges } from '../../composables/useCloudAgentBridges.js'

describe('Cloud Agent bridges', () => {
  it('refreshes the local Agent snapshot after connecting a server', async () => {
    const refreshAgents = vi.fn(async () => {})
    const bridgeApi = ref({
      connect: vi.fn(async () => ({ bridgeId: 'cloud-bridge-1' })),
      list: vi.fn(async () => []),
    })
    const bridges = useCloudAgentBridges({ bridgeApi, refreshAgents, showError: vi.fn() })

    bridges.address.value = '10.1.132.21'
    await bridges.connect()

    expect(bridgeApi.value.connect).toHaveBeenCalledWith({ address: '10.1.132.21' })
    expect(refreshAgents).toHaveBeenCalledTimes(1)
  })
})
