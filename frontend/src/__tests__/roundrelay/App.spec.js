import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../App.vue'
import { AGENTS } from '../../catalog.js'
import { setLocale } from '../../i18n.js'

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView

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

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function imageAttachment(id, name = `${id}.png`) {
  return {
    id,
    name,
    mimeType: 'image/png',
    size: 3,
    previewDataUrl: 'data:image/png;base64,AQID',
  }
}

function createBridge() {
  const state = baseSnapshot()
  let workspaceChanged = null
  let runFinished = null
  let openGroup = null
  const snapshot = value => structuredClone(value || state)
  const cloneInput = input => structuredClone(input)
  const workspace = {
    get: vi.fn(async () => snapshot()),
    refreshAgents: vi.fn(async () => snapshot()),
    createGroup: vi.fn(async input => ({
      id: 'group-1',
      createdAt: '2026-07-29T08:00:00Z',
      ...cloneInput(input),
    })),
    updateGroup: vi.fn(async (_groupId, input) => cloneInput(input)),
    deleteGroup: vi.fn(async () => snapshot()),
    send: vi.fn(async input => {
      cloneInput(input)
      return snapshot()
    }),
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
    onRunFinished: vi.fn((callback) => {
      runFinished = callback
      return vi.fn(() => {
        if (runFinished === callback) runFinished = null
      })
    }),
    onOpenGroup: vi.fn((callback) => {
      openGroup = callback
      return vi.fn(() => {
        if (openGroup === callback) openGroup = null
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
    skills: vi.fn(async () => ({ skills: [] })),
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
  const localAttachments = {
    pickImages: vi.fn(async () => ({ attachments: [] })),
    importImage: vi.fn(async input => ({
      id: 'attachment-1',
      name: input.name,
      mimeType: input.mimeType,
      size: input.bytes.length,
      previewDataUrl: 'data:image/png;base64,AQID',
    })),
    preview: vi.fn(async id => ({
      id,
      name: `${id}.png`,
      mimeType: 'image/png',
      size: 3,
      previewDataUrl: 'data:image/png;base64,AQID',
    })),
    discard: vi.fn(async ids => ({ discardedIds: [...ids], retainedIds: [] })),
  }
  return {
    bridge: { localWorkspace: workspace, agentInstaller, localAgentProvider, localAttachments },
    state,
    emitWorkspaceChanged(value = state) {
      workspaceChanged?.(snapshot(value))
    },
    emitRunFinished(value) {
      runFinished?.(structuredClone(value))
    },
    emitOpenGroup(value) {
      openGroup?.(structuredClone(value))
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
  localStorage.setItem('roundrelay-onboarding-seen-v1', '1')
  setLocale('en')
})

afterEach(() => {
  vi.useRealTimers()
  delete window.roundrelayDesktop
  document.body.className = ''
  document.body.innerHTML = ''
  if (originalScrollIntoView) HTMLElement.prototype.scrollIntoView = originalScrollIntoView
  else delete HTMLElement.prototype.scrollIntoView
  vi.restoreAllMocks()
})

describe('RoundRelay workbench', () => {
  it('keeps first-run onboarding disabled until local Agent detection settles', async () => {
    vi.useFakeTimers()
    localStorage.removeItem('roundrelay-onboarding-seen-v1')
    let finishDetection
    const pendingDetection = new Promise(resolve => { finishDetection = resolve })
    const { wrapper, state } = await mountApp(({ bridge }) => {
      bridge.localWorkspace.refreshAgents.mockReturnValueOnce(pendingDetection)
    })

    expect(wrapper.get('.onboarding-dialog').attributes('aria-modal')).toBe('true')
    expect(wrapper.findAll('.onboarding-dot')).toHaveLength(3)
    expect(wrapper.get('.onboarding-primary').attributes()).toHaveProperty('disabled')
    expect(wrapper.get('.onboarding-primary').text()).toContain('Detecting local Agents')
    expect(document.activeElement).toBe(wrapper.get('.onboarding-dialog').element)
    expect(wrapper.get('.sidebar').attributes()).toHaveProperty('inert')
    expect(wrapper.get('.workspace-pane').attributes()).toHaveProperty('inert')

    await vi.advanceTimersByTimeAsync(10_001)
    await flushPromises()
    expect(wrapper.get('.onboarding-primary').attributes()).toHaveProperty('disabled')
    expect(wrapper.get('.onboarding-primary').text()).toContain('Detecting local Agents')

    finishDetection(structuredClone(state))
    await flushPromises()

    expect(wrapper.get('.onboarding-primary').attributes()).not.toHaveProperty('disabled')
    expect(wrapper.get('.onboarding-primary').text()).toContain('Start using')
    const firstControl = wrapper.get('.onboarding-carousel-controls button')
    const lastControl = wrapper.get('.onboarding-primary')
    lastControl.element.focus()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))
    expect(document.activeElement).toBe(firstControl.element)
    firstControl.element.focus()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true }))
    expect(document.activeElement).toBe(lastControl.element)
    await wrapper.get('.onboarding-primary').trigger('click')
    expect(wrapper.find('.onboarding-dialog').exists()).toBe(false)
    expect(localStorage.getItem('roundrelay-onboarding-seen-v1')).toBe('1')
    expect(wrapper.get('.sidebar').attributes()).not.toHaveProperty('inert')
    wrapper.unmount()
  })

  it('dismisses first-run onboarding with Escape and releases the body scroll lock', async () => {
    localStorage.removeItem('roundrelay-onboarding-seen-v1')
    const historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const { wrapper } = await mountApp()

    expect(document.body.classList.contains('modal-open')).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()

    expect(wrapper.find('.onboarding-dialog').exists()).toBe(false)
    expect(document.body.classList.contains('modal-open')).toBe(false)
    expect(localStorage.getItem('roundrelay-onboarding-seen-v1')).toBe('1')
    expect(historyBack).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('dismisses first-run onboarding with browser back without navigating twice', async () => {
    localStorage.removeItem('roundrelay-onboarding-seen-v1')
    const historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const { wrapper } = await mountApp()

    expect(document.body.classList.contains('modal-open')).toBe(true)
    window.dispatchEvent(new PopStateEvent('popstate'))
    await flushPromises()

    expect(wrapper.find('.onboarding-dialog').exists()).toBe(false)
    expect(document.body.classList.contains('modal-open')).toBe(false)
    expect(localStorage.getItem('roundrelay-onboarding-seen-v1')).toBe('1')
    expect(historyBack).not.toHaveBeenCalled()
    wrapper.unmount()
  })

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
    expect(wrapper.get('.conversation-capabilities').text()).toContain('Read only')

    await wrapper.get('.new-group-button').trigger('click')
    await flushPromises()
    expect(wrapper.get('.modal.medium').attributes('aria-labelledby')).toBe('modal-title')
    expect(wrapper.get('#modal-title').text()).toBe('New Agent group')
    const groupInputs = wrapper.findAll('.form-stack input:not([type="checkbox"])')
    expect(document.activeElement).toBe(wrapper.get('.modal.medium').element)
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
    expect(() => structuredClone(bridge.localWorkspace.createGroup.mock.calls.at(-1)[0])).not.toThrow()
    wrapper.unmount()
  })

  it('creates only one direct chat when its entry point is clicked twice rapidly', async () => {
    const creation = deferred()
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
    const { wrapper, bridge, state } = await mountApp(({ bridge: desktopBridge }) => {
      desktopBridge.localWorkspace.createGroup.mockReturnValueOnce(creation.promise)
    })
    bridge.localWorkspace.get.mockImplementation(async () => ({ ...state, groups: [directGroup] }))

    const openChat = wrapper.findAll('.agent-card')[0].get('.agent-card-actions button')
    openChat.element.click()
    openChat.element.click()
    await wrapper.vm.$nextTick()

    expect(bridge.localWorkspace.createGroup).toHaveBeenCalledTimes(1)
    expect(openChat.attributes()).toHaveProperty('disabled')

    creation.resolve(directGroup)
    await flushPromises()

    expect(openChat.attributes()).not.toHaveProperty('disabled')
    wrapper.unmount()
  })

  it('keeps a group creation modal open while its save is pending', async () => {
    const creation = deferred()
    const group = {
      id: 'group-1',
      conversationType: 'group',
      name: 'Review',
      topic: '',
      agentKinds: ['codex', 'hermes'],
      workdir: '/tmp/roundrelay-workspace',
      allowWrite: false,
      createdAt: '2026-07-29T08:00:00Z',
      updatedAt: '2026-07-29T08:00:00Z',
    }
    const { wrapper, bridge, state } = await mountApp(({ bridge: desktopBridge }) => {
      desktopBridge.localWorkspace.createGroup.mockReturnValueOnce(creation.promise)
    })
    bridge.localWorkspace.get.mockImplementation(async () => ({ ...state, groups: [group] }))

    await wrapper.get('.new-group-button').trigger('click')
    await wrapper.get('form.form-stack').trigger('submit')

    const closeButton = wrapper.get('.modal-header .icon-button')
    const cancelButton = wrapper.get('.modal-footer .secondary-button')
    expect(closeButton.attributes()).toHaveProperty('disabled')
    expect(cancelButton.attributes()).toHaveProperty('disabled')

    await wrapper.get('.modal-backdrop').trigger('mousedown')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    closeButton.element.click()
    cancelButton.element.click()
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.modal.medium').exists()).toBe(true)
    expect(bridge.localWorkspace.createGroup).toHaveBeenCalledTimes(1)

    creation.resolve(group)
    await flushPromises()

    expect(wrapper.find('.modal.medium').exists()).toBe(false)
    wrapper.unmount()
  })

  it('restores modal history when browser back occurs during pending group creation', async () => {
    const creation = deferred()
    const group = {
      id: 'group-1',
      conversationType: 'group',
      name: 'Review',
      topic: '',
      agentKinds: ['codex', 'hermes'],
      workdir: '/tmp/roundrelay-workspace',
      allowWrite: false,
      createdAt: '2026-07-29T08:00:00Z',
      updatedAt: '2026-07-29T08:00:00Z',
    }
    const historyPush = vi.spyOn(window.history, 'pushState').mockImplementation(() => {})
    const historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const { wrapper, bridge, state } = await mountApp(({ bridge: desktopBridge }) => {
      desktopBridge.localWorkspace.createGroup.mockReturnValueOnce(creation.promise)
    })
    bridge.localWorkspace.get.mockImplementation(async () => ({ ...state, groups: [group] }))

    await wrapper.get('.new-group-button').trigger('click')
    await wrapper.get('form.form-stack').trigger('submit')
    expect(historyPush).toHaveBeenCalledTimes(1)

    window.dispatchEvent(new PopStateEvent('popstate'))
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.modal.medium').exists()).toBe(true)
    expect(historyPush).toHaveBeenCalledTimes(2)
    expect(historyBack).not.toHaveBeenCalled()

    creation.resolve(group)
    await flushPromises()

    expect(wrapper.find('.modal.medium').exists()).toBe(false)
    expect(historyBack).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('returns focus to the control that opened a modal', async () => {
    vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const { wrapper } = await mountApp()
    const trigger = wrapper.get('.new-group-button')
    trigger.element.focus()

    await trigger.trigger('click')
    expect(document.activeElement).toBe(wrapper.get('.modal.medium').element)

    await wrapper.get('.modal-header .icon-button').trigger('click')
    await flushPromises()

    expect(document.activeElement).toBe(trigger.element)
    wrapper.unmount()
  })

  it('keeps unavailable Agent histories accessible without allowing new runs', async () => {
    const { wrapper, bridge } = await mountApp(({ state }) => {
      Object.assign(state.agents.find(agent => agent.kind === 'hermes'), {
        available: false,
        credentialState: 'missing',
        showInSidebar: false,
      })
      state.groups.push({
        id: 'direct-hermes',
        conversationType: 'direct',
        directAgentKind: 'hermes',
        name: 'Hermes history',
        topic: '',
        agentKinds: ['hermes'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: true,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
    })

    const hermesAgent = wrapper.findAll('.sidebar-agent')
      .find(agent => agent.text().includes('Hermes'))
    expect(hermesAgent.get('.sidebar-agent-new').attributes()).toHaveProperty('disabled')
    expect(hermesAgent.findAll('.direct-session-action')).toHaveLength(2)

    await hermesAgent.get('.sidebar-agent-main').trigger('click')

    expect(wrapper.get('.conversation-header h1').text()).toBe('Hermes history')
    expect(wrapper.get('.conversation-capabilities').text()).toContain('Agent-managed permissions')
    expect(wrapper.get('.conversation-capabilities').text()).not.toContain('Read only')
    expect(wrapper.get('.conversation-capabilities').text()).not.toContain('Write enabled')
    const textarea = wrapper.get('.composer-box textarea')
    await textarea.setValue('Continue this task')
    expect(wrapper.get('.send-button').attributes()).toHaveProperty('disabled')

    await textarea.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(bridge.localWorkspace.send).not.toHaveBeenCalled()
    expect(wrapper.get('.toast-message').text()).toContain('This local Agent is unavailable.')
    wrapper.unmount()
  })

  it('sends a structured-cloneable plain payload when group settings are saved', async () => {
    const { wrapper, bridge } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-1',
        conversationType: 'group',
        name: 'Review',
        topic: 'Initial topic',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
    })

    await wrapper.get('.conversation-link').trigger('click')
    await wrapper.get('.conversation-header-actions .icon-button').trigger('click')
    await wrapper.get('form.form-stack').trigger('submit')
    await flushPromises()

    expect(bridge.localWorkspace.updateGroup).toHaveBeenCalledWith('group-1', {
      name: 'Review',
      topic: 'Initial topic',
      agentKinds: ['codex', 'hermes'],
      workdir: '/tmp/roundrelay-workspace',
      allowWrite: false,
    })
    expect(() => structuredClone(bridge.localWorkspace.updateGroup.mock.calls[0][1])).not.toThrow()
    wrapper.unmount()
  })

  it('loads and sends only skills belonging to the currently selected targets', async () => {
    const { wrapper, bridge } = await mountApp(({ state, bridge: desktopBridge }) => {
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
      desktopBridge.agentInstaller.skills.mockImplementation(async kind => ({
        skills: kind === 'codex'
          ? [
              { targetKind: 'codex', namespace: 'quality', slug: 'review', name: 'Review code' },
              { targetKind: 'hermes', namespace: 'quality', slug: 'research', name: 'Research' },
            ]
          : [{ targetKind: 'hermes', namespace: 'quality', slug: 'research', name: 'Research' }],
      }))
    })

    await wrapper.get('.conversation-link').trigger('click')
    await wrapper.findAll('.target-chip')[1].trigger('click')
    bridge.agentInstaller.skills.mockClear()
    const textarea = wrapper.get('.composer-box textarea')
    await textarea.setValue('@rev')
    await flushPromises()

    expect(bridge.agentInstaller.skills.mock.calls).toEqual([['codex']])
    expect(wrapper.findAll('.skill-option')).toHaveLength(1)
    expect(wrapper.get('.skill-option').text()).toContain('Review code')
    expect(wrapper.get('.skill-option').text()).not.toContain('Research')
    expect(textarea.attributes('role')).toBe('combobox')
    expect(textarea.attributes('aria-expanded')).toBe('true')
    expect(textarea.attributes('aria-controls')).toBe('composer-skill-menu')
    expect(textarea.attributes('aria-activedescendant')).toBe('composer-skill-option-0')

    await textarea.setValue('@review')
    await flushPromises()
    expect(bridge.agentInstaller.skills.mock.calls).toEqual([['codex']])

    await textarea.trigger('keydown', { key: 'Enter' })
    expect(textarea.attributes('aria-expanded')).toBe('false')
    await textarea.setValue('Review this implementation')
    await wrapper.get('.send-button').trigger('click')
    await flushPromises()

    expect(bridge.localWorkspace.send).toHaveBeenCalledWith({
      groupId: 'group-1',
      text: 'Review this implementation',
      targetKinds: ['codex'],
      skillHints: [{ targetKind: 'codex', namespace: 'quality', slug: 'review', name: 'Review code' }],
      attachments: [],
    })
    wrapper.unmount()
  })

  it('imports a pasted image and sends safe attachment metadata without text', async () => {
    const { wrapper, bridge } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'direct-codex',
        conversationType: 'direct',
        directAgentKind: 'codex',
        name: 'Codex',
        agentKinds: ['codex'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
    })

    await wrapper.get('.direct-session-open').trigger('click')
    const imageFile = {
      name: 'diagram.png',
      type: 'image/png',
      size: 3,
      arrayBuffer: vi.fn(async () => Uint8Array.from([1, 2, 3]).buffer),
    }
    await wrapper.get('.composer-box textarea').trigger('paste', {
      clipboardData: {
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => imageFile }],
      },
    })
    await flushPromises()

    expect(bridge.localAttachments.importImage).toHaveBeenCalledWith({
      name: 'diagram.png',
      mimeType: 'image/png',
      bytes: Uint8Array.from([1, 2, 3]),
    })
    expect(wrapper.get('.composer-attachment img').attributes('src')).toBe('data:image/png;base64,AQID')
    expect(wrapper.get('.send-button').attributes()).not.toHaveProperty('disabled')

    await wrapper.get('.send-button').trigger('click')
    await flushPromises()

    expect(bridge.localWorkspace.send).toHaveBeenCalledWith({
      groupId: 'direct-codex',
      text: '',
      targetKinds: ['codex'],
      skillHints: [],
      attachments: [{ id: 'attachment-1', name: 'diagram.png', mimeType: 'image/png', size: 3 }],
    })
    wrapper.unmount()
  })

  it('keeps an all-failed accepted image message out of the composer', async () => {
    const { wrapper, bridge } = await mountApp(({ state, bridge: desktopBridge }) => {
      state.groups.push({
        id: 'direct-codex',
        conversationType: 'direct',
        directAgentKind: 'codex',
        name: 'Codex',
        agentKinds: ['codex'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      desktopBridge.localWorkspace.send.mockImplementation(async (input) => {
        state.messages.push(
          {
            id: 'failed-user-message',
            groupId: input.groupId,
            role: 'user',
            agentKind: '',
            content: input.text,
            attachments: structuredClone(input.attachments),
            createdAt: '2026-07-29T08:01:00Z',
          },
          {
            id: 'failed-system-message',
            groupId: input.groupId,
            role: 'system',
            agentKind: '',
            content: 'Codex failed: process failed',
            createdAt: '2026-07-29T08:01:01Z',
          },
        )
        return structuredClone(state)
      })
    })

    await wrapper.get('.direct-session-open').trigger('click')
    const imageFile = {
      name: 'failure.png',
      type: 'image/png',
      size: 3,
      arrayBuffer: vi.fn(async () => Uint8Array.from([1, 2, 3]).buffer),
    }
    await wrapper.get('.composer-box textarea').trigger('paste', {
      clipboardData: {
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => imageFile }],
      },
    })
    await flushPromises()
    await wrapper.get('.send-button').trigger('click')
    await flushPromises()

    expect(wrapper.get('.composer-box textarea').element.value).toBe('')
    expect(wrapper.find('.composer-attachment').exists()).toBe(false)
    expect(wrapper.findAll('.message-row.user')).toHaveLength(1)
    expect(wrapper.findAll('.message-attachment-grid')).toHaveLength(1)
    expect(bridge.localAttachments.discard).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('rejects an oversized pasted image before reading its bytes', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0))
    const { wrapper, bridge } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'direct-codex',
        conversationType: 'direct',
        directAgentKind: 'codex',
        name: 'Codex',
        agentKinds: ['codex'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
    })

    await wrapper.get('.direct-session-open').trigger('click')
    await wrapper.get('.composer-box textarea').trigger('paste', {
      clipboardData: {
        items: [{
          kind: 'file',
          type: 'image/png',
          getAsFile: () => ({
            name: 'large.png',
            type: 'image/png',
            size: (8 * 1024 * 1024) + 1,
            arrayBuffer,
          }),
        }],
      },
    })
    await flushPromises()

    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(bridge.localAttachments.importImage).not.toHaveBeenCalled()
    expect(wrapper.get('.toast-message').text()).toContain('too large')
    wrapper.unmount()
  })

  it('reloads Skill counts when Agent kinds are unchanged after manual refresh', async () => {
    let total = 1
    const { wrapper, bridge } = await mountApp(({ bridge: desktopBridge }) => {
      desktopBridge.agentInstaller.skills.mockImplementation(async () => ({
        supported: true,
        total,
        skills: [],
      }))
    })
    bridge.agentInstaller.skills.mockClear()
    total = 3

    await wrapper.get('.home-header .secondary-button').trigger('click')
    await flushPromises()

    expect(bridge.agentInstaller.skills.mock.calls.map(([kind]) => kind).sort()).toEqual(['codex', 'hermes'])
    for (const card of wrapper.findAll('.agent-card').slice(0, 2)) {
      expect(card.get('.agent-capability-list').text()).toContain('3 local skills')
    }
    wrapper.unmount()
  })

  it('discards an unsent image when the user removes it', async () => {
    const { wrapper, bridge } = await mountApp(({ state, bridge: desktopBridge }) => {
      state.groups.push({
        id: 'direct-codex',
        conversationType: 'direct',
        directAgentKind: 'codex',
        name: 'Codex',
        agentKinds: ['codex'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      desktopBridge.localAttachments.pickImages.mockResolvedValueOnce({
        attachments: [imageAttachment('remove-me')],
      })
    })

    await wrapper.get('.direct-session-open').trigger('click')
    await wrapper.get('[aria-label="Attach images"]').trigger('click')
    await flushPromises()
    await wrapper.get('[aria-label="Remove image"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('.composer-attachment').exists()).toBe(false)
    expect(bridge.localAttachments.discard).toHaveBeenCalledWith(['remove-me'])
    wrapper.unmount()
  })

  it('passes the remaining image capacity to the picker and reports truncated selections', async () => {
    const firstPick = [imageAttachment('picked-1')]
    const secondPick = Array.from({ length: 3 }, (_, index) => imageAttachment(`picked-${index + 2}`))
    const { wrapper, bridge } = await mountApp(({ state, bridge: desktopBridge }) => {
      state.groups.push({
        id: 'direct-codex',
        conversationType: 'direct',
        directAgentKind: 'codex',
        name: 'Codex',
        agentKinds: ['codex'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      desktopBridge.localAttachments.pickImages
        .mockResolvedValueOnce({ attachments: firstPick, truncated: false })
        .mockResolvedValueOnce({ attachments: secondPick, truncated: true })
    })

    await wrapper.get('.direct-session-open').trigger('click')
    await wrapper.get('[aria-label="Attach images"]').trigger('click')
    await flushPromises()
    await wrapper.get('[aria-label="Attach images"]').trigger('click')
    await flushPromises()

    expect(wrapper.findAll('.composer-attachment')).toHaveLength(4)
    expect(bridge.localAttachments.pickImages.mock.calls).toEqual([[4], [3]])
    expect(bridge.localAttachments.discard).not.toHaveBeenCalled()
    expect(wrapper.get('.toast-message').text()).toContain('up to 4 images')
    wrapper.unmount()
  })

  it('limits picked images to the selected Agents minimum capability', async () => {
    const picked = [imageAttachment('hermes-1')]
    const { wrapper, bridge } = await mountApp(({ state, bridge: desktopBridge }) => {
      state.groups.push({
        id: 'direct-hermes',
        conversationType: 'direct',
        directAgentKind: 'hermes',
        name: 'Hermes',
        agentKinds: ['hermes'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      desktopBridge.localAttachments.pickImages.mockResolvedValueOnce({
        attachments: picked,
        truncated: true,
      })
    })

    await wrapper.get('.direct-session-open').trigger('click')
    await wrapper.get('[aria-label="Attach images"]').trigger('click')
    await flushPromises()

    expect(wrapper.findAll('.composer-attachment')).toHaveLength(1)
    expect(bridge.localAttachments.pickImages).toHaveBeenCalledWith(1)
    expect(bridge.localAttachments.discard).not.toHaveBeenCalled()
    expect(wrapper.get('[aria-label="Attach images"]').attributes()).toHaveProperty('disabled')

    await wrapper.get('.composer-box textarea').trigger('paste', {
      clipboardData: {
        items: [{
          kind: 'file',
          type: 'image/png',
          getAsFile: () => ({
            name: 'overflow.png',
            type: 'image/png',
            arrayBuffer: vi.fn(async () => Uint8Array.from([1]).buffer),
          }),
        }],
      },
    })
    await flushPromises()

    expect(bridge.localAttachments.importImage).not.toHaveBeenCalled()
    expect(wrapper.get('.toast-message').text()).toContain('accepts fewer images')
    wrapper.unmount()
  })

  it('discards unsent draft images when switching conversations', async () => {
    const { wrapper, bridge } = await mountApp(({ state, bridge: desktopBridge }) => {
      state.groups.push(
        {
          id: 'group-alpha',
          conversationType: 'group',
          name: 'Alpha review',
          topic: '',
          agentKinds: ['codex', 'hermes'],
          workdir: '/tmp/roundrelay-workspace',
          allowWrite: false,
          createdAt: '2026-07-29T08:00:00Z',
          updatedAt: '2026-07-29T08:02:00Z',
        },
        {
          id: 'group-beta',
          conversationType: 'group',
          name: 'Beta review',
          topic: '',
          agentKinds: ['codex', 'hermes'],
          workdir: '/tmp/roundrelay-workspace',
          allowWrite: false,
          createdAt: '2026-07-29T08:00:00Z',
          updatedAt: '2026-07-29T08:01:00Z',
        },
      )
      desktopBridge.localAttachments.pickImages.mockResolvedValueOnce({
        attachments: [imageAttachment('alpha-draft')],
      })
    })

    const links = wrapper.findAll('.conversation-link')
    const alphaLink = links.find(link => link.text().includes('Alpha review'))
    const betaLink = links.find(link => link.text().includes('Beta review'))
    await alphaLink.trigger('click')
    await wrapper.get('[aria-label="Attach images"]').trigger('click')
    await flushPromises()
    await betaLink.trigger('click')
    await flushPromises()

    expect(wrapper.find('.composer-attachment').exists()).toBe(false)
    expect(bridge.localAttachments.discard).toHaveBeenCalledWith(['alpha-draft'])
    wrapper.unmount()
  })

  it('loads persisted attachment previews by id without requiring preview data in the snapshot', async () => {
    const { wrapper, bridge } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'direct-codex',
        conversationType: 'direct',
        directAgentKind: 'codex',
        name: 'Codex',
        agentKinds: ['codex'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      state.messages.push({
        id: 'message-1',
        groupId: 'direct-codex',
        role: 'user',
        content: '',
        attachments: [{ id: 'persisted-image', name: 'diagram.png', mimeType: 'image/png', size: 3 }],
        createdAt: '2026-07-29T08:01:00Z',
      })
    })

    await wrapper.get('.direct-session-open').trigger('click')
    await flushPromises()

    expect(bridge.localAttachments.preview).toHaveBeenCalledWith('persisted-image')
    expect(wrapper.get('.message-attachment-grid img').attributes('src')).toBe('data:image/png;base64,AQID')
    expect(wrapper.get('.message-attachment-grid figcaption').text()).toBe('diagram.png')
    wrapper.unmount()
  })

  it('blocks button and Enter sends until a pasted image finishes importing', async () => {
    const pendingImport = deferred()
    const { wrapper, bridge } = await mountApp(({ state, bridge: desktopBridge }) => {
      state.groups.push({
        id: 'direct-codex',
        conversationType: 'direct',
        directAgentKind: 'codex',
        name: 'Codex',
        agentKinds: ['codex'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      desktopBridge.localAttachments.importImage.mockReturnValueOnce(pendingImport.promise)
    })

    await wrapper.get('.direct-session-open').trigger('click')
    const textarea = wrapper.get('.composer-box textarea')
    await textarea.setValue('Include this image')
    await textarea.trigger('paste', {
      clipboardData: {
        items: [{
          kind: 'file',
          type: 'image/png',
          getAsFile: () => ({
            name: 'diagram.png',
            type: 'image/png',
            arrayBuffer: vi.fn(async () => Uint8Array.from([1, 2, 3]).buffer),
          }),
        }],
      },
    })
    await flushPromises()

    expect(wrapper.get('.send-button').attributes()).toHaveProperty('disabled')
    await textarea.trigger('keydown', { key: 'Enter' })
    expect(bridge.localWorkspace.send).not.toHaveBeenCalled()

    pendingImport.resolve({
      id: 'attachment-1',
      name: 'diagram.png',
      mimeType: 'image/png',
      size: 3,
      previewDataUrl: 'data:image/png;base64,AQID',
    })
    await flushPromises()

    expect(wrapper.get('.send-button').attributes()).not.toHaveProperty('disabled')
    await wrapper.get('.send-button').trigger('click')
    await flushPromises()
    expect(bridge.localWorkspace.send).toHaveBeenCalledWith(expect.objectContaining({
      groupId: 'direct-codex',
      text: 'Include this image',
      attachments: [{ id: 'attachment-1', name: 'diagram.png', mimeType: 'image/png', size: 3 }],
    }))
    wrapper.unmount()
  })

  it('does not start a second paste import while the current batch is pending', async () => {
    const pendingImport = deferred()
    const secondRead = vi.fn(async () => Uint8Array.from([4, 5, 6]).buffer)
    const { wrapper, bridge } = await mountApp(({ state, bridge: desktopBridge }) => {
      state.groups.push({
        id: 'direct-codex',
        conversationType: 'direct',
        directAgentKind: 'codex',
        name: 'Codex',
        agentKinds: ['codex'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      desktopBridge.localAttachments.importImage.mockReturnValueOnce(pendingImport.promise)
    })

    await wrapper.get('.direct-session-open').trigger('click')
    const textarea = wrapper.get('.composer-box textarea')
    await textarea.trigger('paste', {
      clipboardData: {
        items: [{
          kind: 'file',
          type: 'image/png',
          getAsFile: () => ({
            name: 'first.png',
            type: 'image/png',
            size: 3,
            arrayBuffer: vi.fn(async () => Uint8Array.from([1, 2, 3]).buffer),
          }),
        }],
      },
    })
    await flushPromises()
    await textarea.trigger('paste', {
      clipboardData: {
        items: [{
          kind: 'file',
          type: 'image/png',
          getAsFile: () => ({
            name: 'second.png',
            type: 'image/png',
            size: 3,
            arrayBuffer: secondRead,
          }),
        }],
      },
    })
    await flushPromises()

    expect(bridge.localAttachments.importImage).toHaveBeenCalledTimes(1)
    expect(secondRead).not.toHaveBeenCalled()
    expect(wrapper.get('.toast-message').text()).toContain('current image import')

    pendingImport.resolve(imageAttachment('first'))
    await flushPromises()
    wrapper.unmount()
  })

  it('discards attachment imports that finish after switching conversations', async () => {
    const pendingImport = deferred()
    const { wrapper, bridge } = await mountApp(({ state, bridge: desktopBridge }) => {
      state.groups.push(
        {
          id: 'group-alpha',
          conversationType: 'group',
          name: 'Alpha review',
          topic: '',
          agentKinds: ['codex', 'hermes'],
          workdir: '/tmp/roundrelay-workspace',
          allowWrite: false,
          createdAt: '2026-07-29T08:00:00Z',
          updatedAt: '2026-07-29T08:02:00Z',
        },
        {
          id: 'group-beta',
          conversationType: 'group',
          name: 'Beta review',
          topic: '',
          agentKinds: ['codex', 'hermes'],
          workdir: '/tmp/roundrelay-workspace',
          allowWrite: false,
          createdAt: '2026-07-29T08:00:00Z',
          updatedAt: '2026-07-29T08:01:00Z',
        },
      )
      desktopBridge.localAttachments.importImage.mockReturnValueOnce(pendingImport.promise)
    })

    const links = wrapper.findAll('.conversation-link')
    const alphaLink = links.find(link => link.text().includes('Alpha review'))
    const betaLink = links.find(link => link.text().includes('Beta review'))
    await alphaLink.trigger('click')
    await wrapper.get('.composer-box textarea').trigger('paste', {
      clipboardData: {
        items: [{
          kind: 'file',
          type: 'image/png',
          getAsFile: () => ({
            name: 'alpha.png',
            type: 'image/png',
            arrayBuffer: vi.fn(async () => Uint8Array.from([1, 2, 3]).buffer),
          }),
        }],
      },
    })
    await flushPromises()

    await betaLink.trigger('click')
    const betaTextarea = wrapper.get('.composer-box textarea')
    await betaTextarea.setValue('Beta task')
    expect(wrapper.get('.send-button').attributes()).not.toHaveProperty('disabled')
    await wrapper.get('.send-button').trigger('click')
    await flushPromises()
    expect(bridge.localWorkspace.send).toHaveBeenCalledWith(expect.objectContaining({
      groupId: 'group-beta',
      text: 'Beta task',
      attachments: [],
    }))

    pendingImport.resolve({
      id: 'alpha-image',
      name: 'alpha.png',
      mimeType: 'image/png',
      size: 3,
      previewDataUrl: 'data:image/png;base64,AQID',
    })
    await flushPromises()
    expect(wrapper.find('.composer-attachment').exists()).toBe(false)
    expect(bridge.localAttachments.discard).toHaveBeenCalledWith(['alpha-image'])
    wrapper.unmount()
  })

  it('does not restore a failed send draft after switching conversations', async () => {
    const pendingSend = deferred()
    const { wrapper, bridge } = await mountApp(({ state, bridge: desktopBridge }) => {
      state.groups.push(
        {
          id: 'group-alpha',
          conversationType: 'group',
          name: 'Alpha review',
          topic: '',
          agentKinds: ['codex', 'hermes'],
          workdir: '/tmp/roundrelay-workspace',
          allowWrite: false,
          createdAt: '2026-07-29T08:00:00Z',
          updatedAt: '2026-07-29T08:02:00Z',
        },
        {
          id: 'group-beta',
          conversationType: 'group',
          name: 'Beta review',
          topic: '',
          agentKinds: ['codex', 'hermes'],
          workdir: '/tmp/roundrelay-workspace',
          allowWrite: false,
          createdAt: '2026-07-29T08:00:00Z',
          updatedAt: '2026-07-29T08:01:00Z',
        },
      )
      desktopBridge.localWorkspace.send.mockReturnValueOnce(pendingSend.promise)
    })

    const links = wrapper.findAll('.conversation-link')
    const alphaLink = links.find(link => link.text().includes('Alpha review'))
    const betaLink = links.find(link => link.text().includes('Beta review'))
    await alphaLink.trigger('click')
    await wrapper.get('.composer-box textarea').setValue('Alpha draft')
    await wrapper.get('.send-button').trigger('click')
    await flushPromises()
    expect(bridge.localWorkspace.send).toHaveBeenCalledWith(expect.objectContaining({
      groupId: 'group-alpha',
      text: 'Alpha draft',
    }))

    await betaLink.trigger('click')
    pendingSend.reject(new Error('LOCAL_AGENT_PROCESS_FAILED'))
    await flushPromises()

    expect(wrapper.get('.conversation-header h1').text()).toBe('Beta review')
    expect(wrapper.get('.composer-box textarea').element.value).toBe('')
    wrapper.unmount()
  })

  it('groups direct sessions under visible Agents and keeps local session actions explicit', async () => {
    const existing = {
      id: 'direct-codex-1',
      conversationType: 'direct',
      directAgentKind: 'codex',
      name: 'Codex',
      topic: '',
      agentKinds: ['codex'],
      workdir: '/tmp/roundrelay-workspace',
      allowWrite: false,
      createdAt: '2026-07-29T08:00:00Z',
      updatedAt: '2026-07-29T08:00:00Z',
    }
    const { wrapper, bridge } = await mountApp(({ state, bridge: desktopBridge }) => {
      state.agents[1].showInSidebar = false
      state.groups.push(existing)
      desktopBridge.agentInstaller.skills.mockImplementation(async kind => ({
        supported: true,
        total: kind === 'codex' ? 12 : 0,
        skills: [],
      }))
      desktopBridge.localWorkspace.createGroup.mockImplementation(async (input) => {
        const group = {
          id: 'direct-codex-2',
          createdAt: '2026-07-29T09:00:00Z',
          updatedAt: '2026-07-29T09:00:00Z',
          ...structuredClone(input),
        }
        state.groups.push(group)
        return structuredClone(group)
      })
      desktopBridge.localWorkspace.get.mockImplementation(async () => structuredClone(state))
    })

    expect(wrapper.findAll('.sidebar-agent')).toHaveLength(1)
    expect(wrapper.get('.sidebar-agent-main').text()).toContain('Codex')
    expect(wrapper.get('.agent-card .agent-capability-list').text()).toContain('12 local skills')
    expect(wrapper.get('.agent-card .agent-capability-list').text()).toContain('Up to 4 images')
    expect(wrapper.get('.agent-card .agent-capability-list').text()).toContain('Responses API')

    await wrapper.get('.sidebar-agent-new').trigger('click')
    await flushPromises()

    expect(bridge.localWorkspace.createGroup).toHaveBeenCalledWith(expect.objectContaining({
      conversationType: 'direct',
      directAgentKind: 'codex',
      name: 'Codex chat 2',
    }))
    const sessions = wrapper.findAll('.direct-session-row')
    expect(sessions).toHaveLength(2)
    expect(sessions[0].get('.direct-session-open span').text()).toBe('Codex chat 2')

    await sessions[0].findAll('.direct-session-action')[0].trigger('click')
    expect(wrapper.get('#modal-title').text()).toBe('Rename direct chat')
    const nameInput = wrapper.get('form.form-stack input:not([type="checkbox"])')
    await nameInput.setValue('Code audit')
    await wrapper.get('form.form-stack').trigger('submit')
    await flushPromises()
    expect(bridge.localWorkspace.updateGroup).toHaveBeenCalledWith(
      'direct-codex-2',
      expect.objectContaining({ name: 'Code audit' }),
    )

    await wrapper.findAll('.direct-session-row')[1].findAll('.direct-session-action')[1].trigger('click')
    expect(wrapper.get('.danger-zone').text()).toContain('Native CLI sessions are not deleted')
    expect(wrapper.get('.danger-button').text()).toContain('Confirm delete')
    await wrapper.get('.danger-button').trigger('click')
    await flushPromises()
    expect(bridge.localWorkspace.deleteGroup).toHaveBeenCalledWith('direct-codex-1')
    wrapper.unmount()
  })

  it('dismisses only the known plan warning for the component lifetime and closes the global toast', async () => {
    const { wrapper, bridge, emitWorkspaceChanged } = await mountApp(({ state, bridge: desktopBridge }) => {
      state.groups.push({
        id: 'direct-codex',
        conversationType: 'direct',
        directAgentKind: 'codex',
        name: 'Codex',
        topic: '',
        agentKinds: ['codex'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      state.messages.push(
        {
          id: 'plan-warning',
          groupId: 'direct-codex',
          role: 'system',
          content: '  error: Cannot combine --prompt with --plan.\n',
          createdAt: '2026-07-29T08:01:00Z',
        },
        {
          id: 'combined-warning',
          groupId: 'direct-codex',
          role: 'system',
          content: 'error: Cannot combine --prompt with --plan.\nAdditional diagnostic detail',
          createdAt: '2026-07-29T08:01:30Z',
        },
        {
          id: 'other-warning',
          groupId: 'direct-codex',
          role: 'system',
          content: 'Another warning',
          createdAt: '2026-07-29T08:02:00Z',
        },
      )
      desktopBridge.localAttachments.pickImages.mockRejectedValueOnce(new Error('LOCAL_ATTACHMENT_INPUT_INVALID'))
    })

    await wrapper.get('.direct-session-open').trigger('click')
    expect(wrapper.findAll('.message-dismiss-button')).toHaveLength(1)
    await wrapper.get('.message-dismiss-button').trigger('click')
    expect(wrapper.find('#message-plan-warning').exists()).toBe(false)
    expect(wrapper.get('#message-combined-warning').text()).toContain('Additional diagnostic detail')
    expect(wrapper.get('#message-other-warning').text()).toContain('Another warning')

    emitWorkspaceChanged()
    await flushPromises()
    expect(wrapper.find('#message-plan-warning').exists()).toBe(false)
    expect(wrapper.findAll('.message-dismiss-button')).toHaveLength(0)

    await wrapper.get('[aria-label="Attach images"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('.toast-message').attributes('role')).toBe('status')
    expect(wrapper.get('.toast-dismiss-button').attributes('aria-label')).toBe('Dismiss')
    await wrapper.get('.toast-dismiss-button').trigger('click')
    expect(wrapper.find('.toast-message').exists()).toBe(false)
    expect(bridge.localAttachments.pickImages).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('reopens and locates the running topic while keeping progress and execution metadata collapsed', async () => {
    const scrollIntoView = vi.fn()
    HTMLElement.prototype.scrollIntoView = scrollIntoView
    const { wrapper, state, emitWorkspaceChanged } = await mountApp(({ state: nextState }) => {
      nextState.groups.push({
        id: 'group-1',
        conversationType: 'group',
        name: 'Implementation review',
        topic: '',
        agentKinds: ['codex', 'hermes', 'qwen'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      nextState.messages.push(
        {
          id: 'root-1',
          groupId: 'group-1',
          role: 'user',
          content: 'Review this change',
          createdAt: '2026-07-29T08:01:00Z',
        },
        {
          id: 'reply-1',
          groupId: 'group-1',
          role: 'agent',
          agentKind: 'codex',
          content: 'Final answer remains visible.',
          threadRootId: 'root-1',
          toolCalls: [
            { title: 'process', status: 'completed' },
            { title: 'write_file', status: 'succeeded' },
            { title: 'internal_debug', status: 'running' },
          ],
          elapsedMs: 1250,
          createdAt: '2026-07-29T08:02:00Z',
        },
      )
    })

    await wrapper.get('.conversation-link').trigger('click')
    await wrapper.get('.topic-toggle').trigger('click')
    expect(wrapper.find('.message-row.agent').exists()).toBe(false)

    state.runningGroupIds = ['group-1']
    state.runs = [{
      groupId: 'group-1',
      mode: 'auto',
      targetKinds: ['codex', 'hermes', 'qwen'],
      completedKinds: ['codex'],
      currentKind: 'hermes',
      threadRootId: 'root-1',
      progress: [
        { title: 'process', status: 'completed' },
        { title: 'write_file', status: 'in_progress' },
        { title: 'private_detail', status: 'queued' },
      ],
    }]
    emitWorkspaceChanged()
    await flushPromises()

    expect(wrapper.get('.message-row.agent').text()).toContain('Final answer remains visible.')
    expect(wrapper.get('#message-root-1').classes()).toContain('active-topic')
    expect(scrollIntoView).toHaveBeenCalled()
    expect(wrapper.get('.run-status-panel.group').text()).toContain('Hermes')
    expect(wrapper.get('.run-progress-summary').text()).toContain('1/3')
    expect(wrapper.get('.run-progress-summary').text()).toContain('1')
    expect(wrapper.findAll('.execution-details')).toHaveLength(2)
    expect(wrapper.findAll('.execution-details').every(details => details.attributes('open') === undefined)).toBe(true)
    const runningStep = wrapper.findAll('.run-progress-details li')[1].get('small')
    expect(runningStep.text()).toBe('Running')
    expect(runningStep.classes()).toContain('running')

    await wrapper.findAll('.brand-actions button')[0].trigger('click')
    const detailsText = wrapper.findAll('.execution-details').map(details => details.text()).join(' ')
    expect(detailsText).toContain('运行进程')
    expect(detailsText).toContain('写入文件')
    expect(detailsText).toContain('执行步骤 3')
    expect(detailsText).toContain('进行中')
    expect(detailsText).not.toContain('internal_debug')
    expect(detailsText).not.toContain('private_detail')
    wrapper.unmount()
  })

  it('marks a background direct run as finished and opens its notification target', async () => {
    const directGroup = (id, kind, name, updatedAt) => ({
      id,
      conversationType: 'direct',
      directAgentKind: kind,
      name,
      topic: '',
      agentKinds: [kind],
      workdir: '/tmp/roundrelay-workspace',
      allowWrite: false,
      createdAt: '2026-07-29T08:00:00Z',
      updatedAt,
    })
    const { wrapper, emitRunFinished, emitOpenGroup } = await mountApp(({ state }) => {
      state.groups.push(
        directGroup('direct-codex', 'codex', 'Codex review', '2026-07-29T08:02:00Z'),
        directGroup('direct-hermes', 'hermes', 'Hermes review', '2026-07-29T08:01:00Z'),
      )
    })

    await wrapper.findAll('.direct-session-open')
      .find(button => button.text().includes('Codex review'))
      .trigger('click')
    emitRunFinished({ groupId: 'direct-hermes', status: 'failed' })
    emitRunFinished({ groupId: 'direct-hermes', status: 'stopped' })
    await flushPromises()
    expect(wrapper.find('.run-finished-mark').exists()).toBe(false)

    emitRunFinished({ groupId: 'direct-hermes', status: 'completed' })
    await flushPromises()

    expect(wrapper.findAll('.run-finished-mark')).toHaveLength(1)
    emitOpenGroup({ groupId: 'direct-hermes' })
    await flushPromises()

    expect(wrapper.get('.conversation-header h1').text()).toBe('Hermes review')
    expect(wrapper.find('.run-finished-mark').exists()).toBe(false)
    wrapper.unmount()
  })

  it('opens a notification target that arrives before the initial workspace snapshot', async () => {
    const initialSnapshot = deferred()
    const { wrapper, state, emitOpenGroup } = await mountApp(({ bridge }) => {
      bridge.localWorkspace.get.mockReturnValueOnce(initialSnapshot.promise)
    })
    state.groups.push({
      id: 'direct-hermes',
      conversationType: 'direct',
      directAgentKind: 'hermes',
      name: 'Hermes review',
      topic: '',
      agentKinds: ['hermes'],
      workdir: '/tmp/roundrelay-workspace',
      allowWrite: false,
      createdAt: '2026-07-29T08:00:00Z',
      updatedAt: '2026-07-29T08:01:00Z',
    })

    emitOpenGroup({ groupId: 'direct-hermes' })
    initialSnapshot.resolve(structuredClone(state))
    await flushPromises()

    expect(wrapper.get('.conversation-header h1').text()).toBe('Hermes review')
    wrapper.unmount()
  })

  it('keeps a direct completion event that arrives before the initial workspace snapshot', async () => {
    const initialSnapshot = deferred()
    const { wrapper, state, emitRunFinished } = await mountApp(({ bridge }) => {
      bridge.localWorkspace.get.mockReturnValueOnce(initialSnapshot.promise)
    })
    state.groups.push({
      id: 'direct-hermes',
      conversationType: 'direct',
      directAgentKind: 'hermes',
      name: 'Hermes review',
      topic: '',
      agentKinds: ['hermes'],
      workdir: '/tmp/roundrelay-workspace',
      allowWrite: false,
      createdAt: '2026-07-29T08:00:00Z',
      updatedAt: '2026-07-29T08:01:00Z',
    })

    emitRunFinished({ groupId: 'direct-hermes', status: 'completed' })
    initialSnapshot.resolve(structuredClone(state))
    await flushPromises()

    expect(wrapper.findAll('.run-finished-mark')).toHaveLength(1)
    wrapper.unmount()
  })
})
