import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../App.vue'
import { AGENTS } from '../../catalog.js'
import { setLocale } from '../../i18n.js'

function baseSnapshot() {
  return {
    agents: AGENTS.slice(0, 2).map(agent => ({
      kind: agent.kind,
      installed: true,
      available: true,
      credentialState: 'ready',
      version: '1.0.0',
    })),
    groups: [],
    messages: [],
    runningGroupIds: [],
    runs: [],
  }
}

function createBridge() {
  const state = baseSnapshot()
  let workspaceChanged = null
  const snapshot = value => structuredClone(value || state)
  const workspace = {
    get: vi.fn(async () => snapshot()),
    refreshAgents: vi.fn(async () => snapshot()),
    createGroup: vi.fn(async input => ({ id: 'group-1', createdAt: '2026-07-29T08:00:00Z', ...input })),
    updateGroup: vi.fn(async () => ({})),
    deleteGroup: vi.fn(async () => snapshot()),
    send: vi.fn(async () => snapshot()),
    startAuto: vi.fn(async () => ({ started: true })),
    stop: vi.fn(async () => true),
    pickDirectory: vi.fn(async () => '/tmp/roundrelay-workspace'),
    defaultDirectory: vi.fn(async () => '/tmp/roundrelay-workspace'),
    onChanged: vi.fn((callback) => {
      workspaceChanged = callback
      return vi.fn(() => {
        if (workspaceChanged === callback) workspaceChanged = null
      })
    }),
  }
  const agentInstaller = {
    catalog: vi.fn(async () => ({
      platform: 'darwin',
      agents: AGENTS.map(agent => ({
        kind: agent.kind,
        installed: true,
        installSupported: true,
      })),
    })),
    state: vi.fn(async () => ({ taskId: '', kind: '', phase: 'idle', canCancel: false, errorCode: '' })),
    start: vi.fn(async kind => ({ taskId: 'install-1', kind, phase: 'checking', canCancel: true })),
    cancel: vi.fn(async () => true),
    onChanged: vi.fn(() => vi.fn()),
  }
  const localAgentProvider = {
    status: vi.fn(async () => ({
      provider: '',
      baseUrl: '',
      model: '',
      configured: false,
      encryptionAvailable: true,
    })),
    probe: vi.fn(async () => ({
      provider: '',
      baseUrl: '',
      model: '',
      configured: false,
      encryptionAvailable: true,
    })),
    save: vi.fn(async input => ({ ...input, configured: true, encryptionAvailable: true })),
    delete: vi.fn(async () => ({ configured: false, encryptionAvailable: true })),
  }
  return {
    bridge: { localWorkspace: workspace, agentInstaller, localAgentProvider },
    state,
    emitWorkspaceChanged(value = state) {
      workspaceChanged?.(snapshot(value))
    },
  }
}

async function mountApp(configure = () => {}) {
  const fixture = createBridge()
  configure(fixture)
  window.roundrelayDesktop = fixture.bridge
  const wrapper = mount(App, { attachTo: document.body })
  await flushPromises()
  return { wrapper, ...fixture }
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('roundrelay-theme', 'light')
  setLocale('en')
})

afterEach(() => {
  delete window.roundrelayDesktop
  document.body.className = ''
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('RoundRelay workbench', () => {
  it('uses non-probing Provider status at boot and probes only when the panel opens', async () => {
    const { wrapper, bridge } = await mountApp()

    expect(bridge.localAgentProvider.status).toHaveBeenCalledTimes(1)
    expect(bridge.localAgentProvider.probe).not.toHaveBeenCalled()
    await wrapper.findAll('.sidebar-footer button')[1].trigger('click')
    await flushPromises()
    expect(bridge.localAgentProvider.probe).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('shows an existing Provider as configured after boot', async () => {
    const { wrapper } = await mountApp(({ bridge }) => {
      bridge.localAgentProvider.status.mockResolvedValueOnce({
        provider: 'Local gateway',
        baseUrl: 'https://gateway.example/v1',
        model: 'roundrelay-model',
        configured: true,
        encryptionAvailable: true,
      })
    })

    expect(wrapper.find('.sidebar-footer .footer-status.ready').exists()).toBe(true)
    wrapper.unmount()
  })

  it('shows all nine Agents and switches language and theme', async () => {
    const { wrapper } = await mountApp()

    expect(wrapper.findAll('.agent-card')).toHaveLength(9)
    expect(wrapper.get('.home-header h1').text()).toBe('Local Agents')

    const controls = wrapper.findAll('.brand-actions button')
    await controls[0].trigger('click')
    expect(wrapper.get('.home-header h1').text()).toBe('本地 Agent')

    await controls[1].trigger('click')
    expect(document.documentElement.dataset.theme).toBe('dark')
    wrapper.unmount()
  })

  it('saves the exact Provider payload exposed by preload', async () => {
    const { wrapper, bridge } = await mountApp()

    await wrapper.findAll('.sidebar-footer button')[1].trigger('click')
    await flushPromises()
    const inputs = wrapper.findAll('.form-stack input')
    await inputs[0].setValue('Local gateway')
    await inputs[1].setValue('https://gateway.example/v1')
    await inputs[2].setValue('roundrelay-model')
    await inputs[3].setValue('secret-key')
    await wrapper.get('form.form-stack').trigger('submit')
    await flushPromises()

    expect(bridge.localAgentProvider.save).toHaveBeenCalledWith({
      provider: 'Local gateway',
      baseUrl: 'https://gateway.example/v1',
      model: 'roundrelay-model',
      apiKey: 'secret-key',
    })
    wrapper.unmount()
  })

  it('localizes default group names and structured system messages at render time', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-1',
        name: '',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      state.messages.push({
        id: 'message-1',
        groupId: 'group-1',
        role: 'system',
        agentKind: 'hermes',
        content: 'Hermes failed: LOCAL_AGENT_EXECUTION_STOPPED',
        system: {
          key: 'system.agentCallFailed',
          params: { agent: 'Hermes', reason: 'LOCAL_AGENT_EXECUTION_STOPPED' },
        },
        createdAt: '2026-07-29T08:01:00Z',
      })
    })

    expect(wrapper.get('.conversation-link').text()).toContain('Agent group')
    await wrapper.get('.conversation-link').trigger('click')
    expect(wrapper.get('.system-message').text()).toContain('Hermes failed: Agent execution stopped.')

    await wrapper.findAll('.brand-actions button')[0].trigger('click')
    expect(wrapper.get('.conversation-link').text()).toContain('Agent 群聊')
    expect(wrapper.get('.system-message').text()).toContain('Hermes 调用失败：Agent 执行已停止。')
    wrapper.unmount()
  })

  it('preserves selected targets across equivalent structured-clone snapshots', async () => {
    const { wrapper, emitWorkspaceChanged } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-1',
        conversationType: 'group',
        name: 'Review',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
    })

    await wrapper.get('.conversation-link').trigger('click')
    await wrapper.findAll('.target-chip')[1].trigger('click')
    expect(wrapper.findAll('.target-chip')[0].classes()).toContain('selected')
    expect(wrapper.findAll('.target-chip')[1].classes()).not.toContain('selected')

    emitWorkspaceChanged()
    await flushPromises()

    expect(wrapper.findAll('.target-chip')[0].classes()).toContain('selected')
    expect(wrapper.findAll('.target-chip')[1].classes()).not.toContain('selected')
    wrapper.unmount()
  })

  it('starts automatic discussion with max rounds and the latest root message', async () => {
    const { wrapper, bridge } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-1',
        conversationType: 'group',
        name: 'Review',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      state.messages.push(
        {
          id: 'root-1',
          groupId: 'group-1',
          role: 'user',
          content: 'First topic',
          createdAt: '2026-07-29T08:01:00Z',
        },
        {
          id: 'reply-1',
          groupId: 'group-1',
          role: 'agent',
          agentKind: 'codex',
          content: 'First reply',
          threadRootId: 'root-1',
          createdAt: '2026-07-29T08:02:00Z',
        },
        {
          id: 'root-2',
          groupId: 'group-1',
          role: 'user',
          content: 'Latest topic',
          createdAt: '2026-07-29T08:03:00Z',
        },
      )
    })

    await wrapper.get('.conversation-link').trigger('click')
    const roundSelect = wrapper.get('.auto-controls select')
    expect(roundSelect.element.value).toBe('3')
    expect(wrapper.findAll('.auto-controls option').map(option => Number(option.element.value)))
      .toEqual([1, 2, 3, 4, 6])

    await wrapper.get('.auto-controls button').trigger('click')

    expect(bridge.localWorkspace.startAuto).toHaveBeenCalledWith({
      groupId: 'group-1',
      maxRounds: 3,
      threadRootId: 'root-2',
    })
    wrapper.unmount()
  })

  it('creates direct chats and local Agent groups', async () => {
    const { wrapper, bridge, state } = await mountApp()

    const directGroup = {
      id: 'direct-codex',
      conversationType: 'direct',
      directAgentKind: 'codex',
      name: 'Codex',
      agentKinds: ['codex'],
      workdir: '/tmp/roundrelay-workspace',
      allowWrite: false,
      createdAt: '2026-07-29T08:00:00Z',
      updatedAt: '2026-07-29T08:00:00Z',
    }
    bridge.localWorkspace.createGroup.mockResolvedValueOnce(directGroup)
    bridge.localWorkspace.get.mockImplementation(async () => ({ ...state, groups: [directGroup] }))

    await wrapper.findAll('.agent-card')[0].get('.agent-card-actions button').trigger('click')
    await flushPromises()
    expect(bridge.localWorkspace.createGroup).toHaveBeenCalledWith({
      conversationType: 'direct',
      directAgentKind: 'codex',
      name: 'Codex',
      agentKinds: ['codex'],
      workdir: '/tmp/roundrelay-workspace',
      allowWrite: false,
    })

    await wrapper.get('.new-group-button').trigger('click')
    await flushPromises()
    const groupInputs = wrapper.findAll('.form-stack input:not([type="checkbox"])')
    await groupInputs[0].setValue('Local review')
    await groupInputs[1].setValue('Review the implementation')
    await wrapper.get('form.form-stack').trigger('submit')
    await flushPromises()

    expect(bridge.localWorkspace.createGroup).toHaveBeenLastCalledWith(expect.objectContaining({
      name: 'Local review',
      topic: 'Review the implementation',
      agentKinds: ['codex', 'hermes'],
      workdir: '/tmp/roundrelay-workspace',
      allowWrite: false,
    }))
    wrapper.unmount()
  })
})
