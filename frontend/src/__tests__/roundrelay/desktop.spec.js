import { afterEach, describe, expect, it } from 'vitest'
import { desktopApi, installerApi, providerApi, workspaceApi } from '../../desktop.js'

afterEach(() => {
  delete window.roundrelayDesktop
})

describe('desktop bridge access', () => {
  it('reads the RoundRelay preload bridge and its narrow services', () => {
    const bridge = {
      localWorkspace: { get() {} },
      agentInstaller: { catalog() {} },
      localAgentProvider: { status() {} },
    }
    window.roundrelayDesktop = bridge

    expect(desktopApi()).toBe(bridge)
    expect(workspaceApi()).toBe(bridge.localWorkspace)
    expect(installerApi()).toBe(bridge.agentInstaller)
    expect(providerApi()).toBe(bridge.localAgentProvider)
  })
})
