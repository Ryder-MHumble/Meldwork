import { afterEach, describe, expect, it } from 'vitest'
import { desktopApi } from '../../desktop.js'

afterEach(() => {
  delete window.roundrelayDesktop
})

describe('desktop bridge access', () => {
  it('reads the RoundRelay preload bridge', () => {
    const bridge = {
      localWorkspace: { get() {} },
      agentInstaller: { catalog() {} },
      localAgentProvider: { status() {} },
    }
    window.roundrelayDesktop = bridge

    expect(desktopApi()).toBe(bridge)
  })
})
