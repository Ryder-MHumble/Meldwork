import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../App.vue'
import { AGENTS } from '../../catalog.js'
import { setLocale } from '../../i18n.js'

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
const originalClipboard = navigator.clipboard
const originalExecCommand = document.execCommand

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
    status: vi.fn(async kind => ({
      kind,
      provider: '',
      baseUrl: '',
      model: '',
      activePreset: 'official',
      profiles: {},
      configured: false,
      encryptionAvailable: true,
    })),
    probe: vi.fn(async kind => ({
      kind,
      provider: '',
      baseUrl: '',
      model: '',
      activePreset: 'official',
      profiles: {},
      configured: false,
      encryptionAvailable: true,
    })),
    save: vi.fn(async (kind, input) => ({ kind, ...input, configured: true, encryptionAvailable: true })),
    activate: vi.fn(async (kind, preset) => ({
      kind,
      provider: '',
      baseUrl: '',
      model: '',
      activePreset: preset,
      profiles: {},
      configured: false,
      encryptionAvailable: true,
    })),
    delete: vi.fn(async kind => ({
      kind,
      provider: '',
      baseUrl: '',
      model: '',
      activePreset: 'official',
      profiles: {},
      configured: false,
      encryptionAvailable: true,
    })),
  }
  const localKnowledgeBase = {
    status: vi.fn(async () => ([
      {
        kind: 'feishu',
        label: 'Feishu Docs',
        badge: 'FS',
        type: 'cloud',
        accessMode: 'cli',
        installed: false,
        configured: false,
        loginState: 'missing',
        permissionState: 'unknown',
        commandName: '',
        vaultPath: '',
        readable: false,
        writable: false,
        probeState: 'ready',
        errorCode: '',
        ready: false,
        installCommand: 'npm install -g @larksuite/cli@latest',
        statusCommand: 'lark-cli auth status',
        loginCommand: 'lark-cli auth login',
        permissionCommand: 'lark-cli docs +search --query . --page-size 1 --as user',
      },
      {
        kind: 'dingtalk',
        label: 'DingTalk Docs',
        badge: 'DT',
        type: 'cloud',
        accessMode: 'cli',
        installed: true,
        configured: false,
        loginState: 'ready',
        permissionState: 'ready',
        commandName: 'dws',
        vaultPath: '',
        readable: true,
        writable: false,
        probeState: 'ready',
        errorCode: '',
        ready: true,
        installCommand: 'npm install -g dingtalk-workspace-cli --registry=https://registry.npmmirror.com',
        statusCommand: 'dws auth status',
        loginCommand: 'dws auth login',
        permissionCommand: 'dws doc list --page-size 1',
      },
      {
        kind: 'obsidian',
        label: 'Obsidian',
        badge: 'OB',
        type: 'local',
        accessMode: 'vault',
        installed: true,
        configured: false,
        loginState: 'ready',
        permissionState: 'ready',
        commandName: 'Obsidian app',
        vaultPath: '',
        vaultDetails: { exists: false, directory: false, readable: false, writable: false },
        readable: false,
        writable: false,
        probeState: 'ready',
        errorCode: '',
        ready: false,
      },
    ])),
    openGuide: vi.fn(async () => true),
    pickObsidianVault: vi.fn(async () => ([
      {
        kind: 'feishu',
        label: 'Feishu Docs',
        badge: 'FS',
        type: 'cloud',
        accessMode: 'cli',
        installed: false,
        configured: false,
        loginState: 'missing',
        permissionState: 'unknown',
        commandName: '',
        vaultPath: '',
        readable: false,
        writable: false,
        probeState: 'ready',
        errorCode: '',
        ready: false,
        installCommand: 'npm install -g @larksuite/cli@latest',
        statusCommand: 'lark-cli auth status',
        loginCommand: 'lark-cli auth login',
        permissionCommand: 'lark-cli docs +search --query . --page-size 1 --as user',
      },
      {
        kind: 'dingtalk',
        label: 'DingTalk Docs',
        badge: 'DT',
        type: 'cloud',
        accessMode: 'cli',
        installed: true,
        configured: false,
        loginState: 'ready',
        permissionState: 'ready',
        commandName: 'dws',
        vaultPath: '',
        readable: true,
        writable: false,
        probeState: 'ready',
        errorCode: '',
        ready: true,
        installCommand: 'npm install -g dingtalk-workspace-cli --registry=https://registry.npmmirror.com',
        statusCommand: 'dws auth status',
        loginCommand: 'dws auth login',
        permissionCommand: 'dws doc list --page-size 1',
      },
      {
        kind: 'obsidian',
        label: 'Obsidian',
        badge: 'OB',
        type: 'local',
        accessMode: 'vault',
        installed: true,
        configured: false,
        loginState: 'ready',
        permissionState: 'ready',
        commandName: 'Obsidian app',
        vaultPath: '/Users/rydersun/Documents/Knowledge',
        vaultDetails: { exists: true, directory: true, readable: true, writable: true },
        readable: false,
        writable: false,
        probeState: 'ready',
        errorCode: '',
        ready: true,
      },
    ])),
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
    bridge: { localWorkspace: workspace, agentInstaller, localAgentProvider, localKnowledgeBase, localAttachments },
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
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async () => {}) },
  })
  setLocale('en')
})

afterEach(() => {
  vi.useRealTimers()
  delete window.roundrelayDesktop
  document.body.className = ''
  document.body.innerHTML = ''
  if (originalScrollIntoView) HTMLElement.prototype.scrollIntoView = originalScrollIntoView
  else delete HTMLElement.prototype.scrollIntoView
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard })
  if (originalExecCommand) Object.defineProperty(document, 'execCommand', { configurable: true, value: originalExecCommand })
  else delete document.execCommand
  vi.restoreAllMocks()
})

describe('RoundRelay workbench', () => {
  it('lets first-run users browse the guide while detection gates only the final action', async () => {
    vi.useFakeTimers()
    localStorage.removeItem('roundrelay-onboarding-seen-v1')
    let finishDetection
    const pendingDetection = new Promise(resolve => { finishDetection = resolve })
    const { wrapper, state } = await mountApp(({ bridge }) => {
      bridge.localWorkspace.refreshAgents.mockReturnValueOnce(pendingDetection)
    })

    expect(wrapper.get('.onboarding-dialog').attributes('aria-modal')).toBe('true')
    expect(wrapper.findAll('.onboarding-dot')).toHaveLength(5)
    expect(wrapper.get('.onboarding-slide img').attributes('src')).toContain('discover-local-agents-meldwork.png')
    expect(wrapper.get('.onboarding-primary').attributes()).toHaveProperty('disabled')
    expect(wrapper.get('.onboarding-primary').text()).toContain('Detecting local Agents')
    expect(document.activeElement).toBe(wrapper.get('.onboarding-dialog').element)
    expect(wrapper.get('.sidebar').attributes()).toHaveProperty('inert')
    expect(wrapper.get('.workspace-pane').attributes()).toHaveProperty('inert')

    await vi.advanceTimersByTimeAsync(7_500)
    await flushPromises()
    expect(wrapper.get('.onboarding-slide img').attributes('src')).toContain('auto-discussion.svg')
    expect(wrapper.get('.onboarding-primary').attributes()).toHaveProperty('disabled')
    expect(wrapper.get('.onboarding-primary').text()).toContain('Detecting local Agents')

    finishDetection(structuredClone(state))
    await flushPromises()

    expect(wrapper.get('.onboarding-primary').attributes()).not.toHaveProperty('disabled')
    expect(wrapper.get('.onboarding-primary').text()).toContain('Start using')

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

  it('loads home status once at boot and re-probes knowledge bases only from their tab', async () => {
    const { wrapper, bridge } = await mountApp()

    expect(bridge.localAgentProvider.status).toHaveBeenCalledTimes(AGENTS.length)
    expect(bridge.localAgentProvider.status.mock.calls.map(([kind]) => kind).sort())
      .toEqual(AGENTS.map(agent => agent.kind).sort())
    expect(bridge.localAgentProvider.probe).not.toHaveBeenCalled()
    expect(bridge.localKnowledgeBase.status).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.home-overview-item').exists()).toBe(false)

    await wrapper.get('.sidebar-settings-entry').trigger('click')
    expect(wrapper.get('.system-settings-page').exists()).toBe(true)
    expect(bridge.localAgentProvider.status).toHaveBeenCalledTimes(AGENTS.length)
    expect(bridge.localKnowledgeBase.status).toHaveBeenCalledTimes(1)

    await wrapper.findAll('.settings-tabs button')[1].trigger('click')
    await flushPromises()
    expect(bridge.localAgentProvider.status).toHaveBeenCalledTimes(AGENTS.length * 2)
    expect(bridge.localAgentProvider.probe).toHaveBeenCalledTimes(1)
    expect(bridge.localAgentProvider.probe).toHaveBeenCalledWith('codex')
    expect(wrapper.get('.provider-summary-count').text()).toContain(`0 ready of ${AGENTS.length}`)
    expect(bridge.localKnowledgeBase.status).toHaveBeenCalledTimes(1)

    await wrapper.findAll('.settings-tabs button')[0].trigger('click')
    await flushPromises()
    expect(bridge.localKnowledgeBase.status).toHaveBeenCalledTimes(1)

    await wrapper.findAll('.settings-tabs button')[2].trigger('click')
    await flushPromises()
    expect(bridge.localKnowledgeBase.status).toHaveBeenCalledTimes(2)
    expect(wrapper.get('.knowledge-base-ready-summary').text()).toContain('1 ready, 3 total')
    wrapper.unmount()
  })

  it('offers three Provider sources for every Agent and clears the API key when switching sources', async () => {
    const styles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    expect(styles).toMatch(/\.provider-source-options\s*\{[^}]*display:\s*flex;[^}]*gap:\s*6px;/s)
    expect(styles).toMatch(/\.provider-source-options button\s*\{[^}]*border:\s*0;[^}]*background:\s*color-mix/s)
    expect(styles).toMatch(/\.provider-editor-tags span,[\s\S]*\.provider-profile-summary code\s*\{[^}]*border:\s*0;/s)
    expect(styles).toMatch(/\.provider-settings-panel\s*\{[^}]*--provider-success:\s*#4f7564;/s)
    expect(styles).toMatch(/\.provider-external-fields\s*\{[^}]*"name model"[^}]*"url url"[^}]*"key key";/s)
    const narrowProviderRules = styles.slice(
      styles.indexOf('@media (max-width: 920px)'),
      styles.indexOf('@media (max-width: 760px)'),
    )
    expect(narrowProviderRules).toMatch(/\.provider-settings-panel\s*\{[^}]*grid-template-columns:\s*1fr;/s)
    expect(narrowProviderRules).toMatch(/\.provider-agent-list\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/s)
    expect(narrowProviderRules).toMatch(/\.provider-editor\s*\{[^}]*width:\s*100%;[^}]*overflow:\s*visible;/s)
    expect(narrowProviderRules).toMatch(/\.provider-source-heading small\s*\{[^}]*white-space:\s*normal;/s)

    const { wrapper } = await mountApp()
    await wrapper.get('.sidebar-settings-entry').trigger('click')
    await wrapper.findAll('.settings-tabs button')[1].trigger('click')
    await flushPromises()

    expect(wrapper.findAll('.provider-agent-list button')).toHaveLength(AGENTS.length)
    expect(wrapper.find('.provider-agent-mode').exists()).toBe(false)
    expect(wrapper.findAll('.provider-agent-list button').every(button => (
      button.findAll('.provider-agent-copy small').length === 1
    ))).toBe(true)
    for (const agent of AGENTS) {
      const agentButton = wrapper.findAll('.provider-agent-list button')
        .find(button => button.text().includes(agent.label))
      expect(agentButton).toBeTruthy()
      await agentButton.trigger('click')
      await flushPromises()
      const sources = wrapper.findAll('.provider-source-options button')
      expect(sources).toHaveLength(3)
      expect(sources.map(button => button.get('strong').text())).toEqual(['Official', 'OpenRouter', 'Custom'])
      expect(wrapper.get('.provider-source-heading small').text()).toContain('official')
    }

    const apiKey = wrapper.get('.provider-editor input[type="password"]')
    await apiKey.setValue('secret-that-must-not-carry-over')
    await wrapper.findAll('.provider-source-options button')[1].trigger('click')
    expect(wrapper.get('.provider-editor input[type="password"]').element.value).toBe('')
    expect(wrapper.get('.provider-source-heading small').text()).toContain('OpenRouter')
    wrapper.unmount()
  })

  it('shows verified native CLI Provider readiness separately from a saved profile', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      state.agents[0].availabilitySource = 'native-credential'
    })

    await wrapper.get('.sidebar-settings-entry').trigger('click')
    await wrapper.findAll('.settings-tabs button')[1].trigger('click')
    await flushPromises()

    const codexProvider = wrapper.findAll('.provider-agent-list button')
      .find(button => button.text().includes('Codex'))
    expect(codexProvider.text()).toContain('Native config ready')
    expect(codexProvider.find('svg.ready').exists()).toBe(true)
    expect(wrapper.get('.provider-editor-tags').text()).toContain('Native config ready')
    expect(wrapper.get('.provider-profile-summary').text()).toContain('Native config ready')
    expect(wrapper.find('.provider-inline-warning').exists()).toBe(false)
    expect(wrapper.find('.provider-editor .danger-button').exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps native Provider readiness pending and unavailable until override status is verified', async () => {
    const kimiStatus = deferred()
    const emptyStatus = kind => ({
      kind,
      provider: '',
      baseUrl: '',
      model: '',
      activePreset: 'official',
      profiles: {},
      configured: false,
      encryptionAvailable: true,
    })
    const { wrapper, bridge } = await mountApp(({ state, bridge }) => {
      state.agents.push({
        kind: 'kimi',
        installed: true,
        available: true,
        credentialState: 'ready',
        availabilitySource: 'native-credential',
        version: '1.0.0',
      })
      bridge.localAgentProvider.status.mockImplementation(kind => (
        kind === 'kimi' ? kimiStatus.promise : Promise.resolve(emptyStatus(kind))
      ))
      bridge.localAgentProvider.probe.mockImplementation(kind => (
        kind === 'kimi' ? kimiStatus.promise : Promise.resolve(emptyStatus(kind))
      ))
    })

    await wrapper.get('.sidebar-settings-entry').trigger('click')
    await wrapper.findAll('.settings-tabs button')[1].trigger('click')
    await wrapper.vm.$nextTick()

    const kimiProvider = wrapper.findAll('.provider-agent-list button')
      .find(button => button.text().includes('Kimi Code'))
    expect(kimiProvider.text()).toContain('Checking')
    expect(kimiProvider.find('svg.ready').exists()).toBe(false)
    await kimiProvider.trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.get('.provider-editor').attributes('aria-busy')).toBe('true')
    expect(wrapper.get('.provider-editor-tags').text()).toContain('Checking')
    expect(wrapper.find('.provider-inline-warning').exists()).toBe(false)

    kimiStatus.reject(Object.assign(new Error('Provider status unavailable'), {
      code: 'PROVIDER_STATUS_UNAVAILABLE',
    }))
    await flushPromises()

    expect(kimiProvider.text()).toContain('Status unavailable')
    expect(kimiProvider.text()).not.toContain('Native config ready')
    expect(kimiProvider.find('svg.ready').exists()).toBe(false)
    expect(wrapper.get('.provider-editor').attributes('aria-busy')).toBe('false')
    expect(wrapper.get('.provider-inline-warning').text()).toContain('Status unavailable')
    expect(wrapper.get('.provider-inline-warning button').text()).toContain('Retry')

    bridge.localAgentProvider.probe.mockResolvedValue(emptyStatus('kimi'))
    await wrapper.get('.provider-inline-warning button').trigger('click')
    await flushPromises()
    expect(bridge.localAgentProvider.probe).toHaveBeenLastCalledWith('kimi')
    expect(wrapper.get('.provider-profile-summary').text()).toContain('Native config ready')
    expect(wrapper.find('.provider-inline-warning').exists()).toBe(false)
    wrapper.unmount()
  })

  it('counts a successful native Agent run as Provider readiness', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      state.agents[0].availabilitySource = 'verified-run'
    })

    await wrapper.get('.sidebar-settings-entry').trigger('click')
    await wrapper.findAll('.settings-tabs button')[1].trigger('click')
    await flushPromises()

    const codexProvider = wrapper.findAll('.provider-agent-list button')
      .find(button => button.text().includes('Codex'))
    expect(codexProvider.text()).toContain('Native config ready')
    expect(codexProvider.find('svg.ready').exists()).toBe(true)
    wrapper.unmount()
  })

  it('removes only the selected Provider profile after two-step confirmation', async () => {
    let openrouterSaved = true
    const providerStatus = kind => (kind === 'kimi' && openrouterSaved
      ? {
          kind,
          provider: 'OpenRouter',
          baseUrl: 'https://openrouter.ai/api/v1',
          model: 'moonshotai/kimi-k2',
          activePreset: 'openrouter',
          profiles: {
            openrouter: {
              provider: 'OpenRouter',
              baseUrl: 'https://openrouter.ai/api/v1',
              model: 'moonshotai/kimi-k2',
              configured: true,
            },
            custom: {
              provider: 'Private gateway',
              baseUrl: 'https://gateway.example/v1',
              model: 'kimi-private',
              configured: true,
            },
          },
          configured: true,
          encryptionAvailable: true,
        }
      : {
          kind,
          provider: '',
          baseUrl: '',
          model: '',
          activePreset: 'official',
          profiles: {
            custom: {
              provider: 'Private gateway',
              baseUrl: 'https://gateway.example/v1',
              model: 'kimi-private',
              configured: true,
            },
          },
          configured: false,
          encryptionAvailable: true,
        })
    const { wrapper, bridge } = await mountApp(({ state, bridge: desktopBridge }) => {
      state.agents.push({
        kind: 'kimi',
        installed: true,
        available: true,
        credentialState: 'ready',
        availabilitySource: 'native-credential',
        version: '1.0.0',
      })
      desktopBridge.localAgentProvider.status.mockImplementation(async kind => providerStatus(kind))
      desktopBridge.localAgentProvider.probe.mockImplementation(async kind => providerStatus(kind))
      desktopBridge.localAgentProvider.delete.mockImplementation(async (kind, preset) => {
        if (kind === 'kimi' && preset === 'openrouter') openrouterSaved = false
        return providerStatus(kind)
      })
    })

    await wrapper.get('.sidebar-settings-entry').trigger('click')
    await wrapper.findAll('.settings-tabs button')[1].trigger('click')
    await wrapper.findAll('.provider-agent-list button')
      .find(button => button.text().includes('Kimi Code'))
      .trigger('click')
    await flushPromises()
    expect(bridge.localAgentProvider.delete).not.toHaveBeenCalled()
    expect(wrapper.get('.provider-profile-summary').text()).toContain('OpenRouter')

    await wrapper.get('.provider-editor-footer .danger-button').trigger('click')
    expect(bridge.localAgentProvider.delete).not.toHaveBeenCalled()
    expect(wrapper.get('.provider-editor-footer .danger-button').text()).toContain('Confirm removal')

    await wrapper.get('.provider-editor-footer .danger-button').trigger('click')
    await flushPromises()
    expect(bridge.localAgentProvider.delete).toHaveBeenCalledWith('kimi', 'openrouter')
    expect(wrapper.find('.provider-editor-footer .danger-button').exists()).toBe(false)
    await wrapper.findAll('.provider-source-options button')[2].trigger('click')
    expect(wrapper.get('.provider-profile-summary').text()).toContain('Private gateway')
    wrapper.unmount()
  })

  it('switches between configured Provider profiles for one Agent', async () => {
    let activePreset = 'openrouter'
    const profiles = {
      openrouter: {
        provider: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'anthropic/claude-sonnet-4',
        configured: true,
      },
      custom: {
        provider: 'Private gateway',
        baseUrl: 'https://gateway.example/v1',
        model: 'private-model',
        configured: true,
      },
    }
    const status = kind => ({
      kind,
      ...profiles[activePreset],
      activePreset,
      profiles,
      configured: true,
      encryptionAvailable: true,
    })
    const { wrapper, bridge } = await mountApp(({ bridge: desktopBridge }) => {
      desktopBridge.localAgentProvider.status.mockImplementation(async kind => (
        kind === 'hermes' ? status(kind) : {
          kind,
          provider: '',
          baseUrl: '',
          model: '',
          activePreset: 'official',
          profiles: {},
          configured: false,
          encryptionAvailable: true,
        }
      ))
      desktopBridge.localAgentProvider.probe.mockImplementation(desktopBridge.localAgentProvider.status)
      desktopBridge.localAgentProvider.activate.mockImplementation(async (kind, preset) => {
        activePreset = preset
        return status(kind)
      })
    })

    await wrapper.get('.sidebar-settings-entry').trigger('click')
    await wrapper.findAll('.settings-tabs button')[1].trigger('click')
    await wrapper.findAll('.provider-agent-list button')
      .find(button => button.text().includes('Hermes'))
      .trigger('click')
    await flushPromises()

    await wrapper.findAll('.provider-source-options button')[2].trigger('click')
    expect(wrapper.get('.provider-profile-summary').text()).toContain('Private gateway')
    expect(wrapper.get('.provider-activate-button').text()).toContain('Use Custom')

    await wrapper.get('.provider-activate-button').trigger('click')
    await flushPromises()
    expect(bridge.localAgentProvider.activate).toHaveBeenCalledWith('hermes', 'custom')
    expect(wrapper.get('.provider-editor-tags').text()).toContain('Custom active')
    wrapper.unmount()
  })

  it('keeps a newly selected Provider Agent while the initial status refresh is pending', async () => {
    const slowRefresh = deferred()
    const slowCodexProbe = deferred()
    let statusCalls = 0
    const statusFor = kind => ({
      kind,
      provider: '',
      baseUrl: '',
      model: '',
      configured: false,
      encryptionAvailable: true,
    })
    const { wrapper } = await mountApp(({ bridge }) => {
      bridge.localAgentProvider.status.mockImplementation((kind) => {
        statusCalls += 1
        const status = statusFor(kind)
        return statusCalls <= AGENTS.length
          ? Promise.resolve(status)
          : slowRefresh.promise.then(() => status)
      })
      bridge.localAgentProvider.probe.mockImplementation(kind => (
        kind === 'codex' ? slowCodexProbe.promise : Promise.resolve(statusFor(kind))
      ))
    })

    await wrapper.get('.sidebar-settings-entry').trigger('click')
    await wrapper.findAll('.settings-tabs button')[1].trigger('click')
    const hermesProvider = wrapper.findAll('.provider-agent-list button')
      .find(button => button.text().includes('Hermes'))
    await hermesProvider.trigger('click')
    await flushPromises()
    expect(wrapper.get('.provider-agent-list button.active').text()).toContain('Hermes')

    slowRefresh.resolve()
    await flushPromises()
    expect(wrapper.get('.provider-agent-list button.active').text()).toContain('Hermes')

    slowCodexProbe.resolve(statusFor('codex'))
    await flushPromises()
    expect(wrapper.get('.provider-agent-list button.active').text()).toContain('Hermes')
    wrapper.unmount()
  })

  it('shows an existing Agent-specific Provider in settings', async () => {
    const { wrapper } = await mountApp(({ bridge }) => {
      bridge.localAgentProvider.status.mockImplementation(async kind => (
        kind === 'hermes'
          ? {
              provider: 'Local gateway',
              baseUrl: 'https://gateway.example/v1',
              model: 'roundrelay-model',
              configured: true,
              encryptionAvailable: true,
            }
          : { provider: '', baseUrl: '', model: '', configured: false, encryptionAvailable: true }
      ))
      bridge.localAgentProvider.probe.mockImplementation(bridge.localAgentProvider.status)
    })

    await wrapper.get('.sidebar-settings-entry').trigger('click')
    await wrapper.findAll('.settings-tabs button')[1].trigger('click')
    await wrapper.findAll('.provider-agent-list button')
      .find(button => button.text().includes('Hermes'))
      .trigger('click')
    await flushPromises()

    expect(wrapper.find('.provider-agent-list svg.ready').exists()).toBe(true)
    expect(wrapper.get('.provider-editor-header h2').text()).toContain('Hermes')
    expect(wrapper.get('.provider-editor-tags').text()).toContain('Configured')
    expect(wrapper.get('.provider-profile-summary').text()).toContain('Local gateway')
    wrapper.unmount()
  })

  it('shows local knowledge sources and can pick an Obsidian vault', async () => {
    const styles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    expect(styles).toMatch(/\.knowledge-base-panel\s*\{[^}]*align-content:\s*start;/s)
    expect(styles).toMatch(/\.knowledge-base-grid\s*\{[^}]*align-content:\s*start;/s)
    expect(styles).toMatch(/\.knowledge-base-card-header\s*\{[^}]*grid-template-columns:\s*38px minmax\(0, 1fr\);/s)
    expect(styles).toMatch(/\.knowledge-base-status\s*\{[^}]*grid-column:\s*2;[^}]*white-space:\s*normal;/s)
    expect(styles).toMatch(/\.knowledge-base-facts\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1\.05fr\) minmax\(0, 0\.95fr\) minmax\(0, 1\.2fr\);/s)
    expect(styles).toMatch(/\.knowledge-base-facts dd\s*\{[^}]*text-overflow:\s*clip;[^}]*white-space:\s*normal;/s)
    expect(styles).toMatch(/\.knowledge-base-planned-list\s*\{/)
    expect(styles).not.toMatch(/\.knowledge-base-tag\s*\{/)
    for (const [filename, source] of [
      ['feishu.svg', 'https://open.feishu.cn/'],
      ['dingtalk.svg', 'https://www.dingtalk.com/'],
      ['obsidian.svg', 'https://obsidian.md/brand'],
    ]) {
      expect(readFileSync(resolve(process.cwd(), `public/knowledge-base-logos/${filename}`), 'utf8')).toContain(`Source: ${source}`)
    }

    const { wrapper, bridge } = await mountApp()

    await wrapper.get('.sidebar-settings-entry').trigger('click')
    await wrapper.findAll('.settings-tabs button')[2].trigger('click')
    await wrapper.vm.selectSystemSettingsSection('knowledge-bases')
    await flushPromises()

    expect(bridge.localKnowledgeBase.status).toHaveBeenCalled()
    const panelText = wrapper.get('.knowledge-base-panel').text()
    expect(panelText).toContain('Knowledge bases')
    expect(panelText).toContain('Feishu Docs')
    expect(panelText).toContain('DingTalk Docs')
    expect(panelText).toContain('Obsidian')
    expect(panelText).toContain('Notion')
    expect(panelText).toContain('Confluence')
    expect(panelText).toContain('Google Drive')
    expect(panelText).toContain('SharePoint')

    const sourceGroups = wrapper.findAll('.knowledge-base-group')
    expect(sourceGroups).toHaveLength(2)
    expect(sourceGroups[0].get('h3').text()).toBe('Local connections')
    expect(sourceGroups[0].findAll('.knowledge-base-card')).toHaveLength(3)
    expect(sourceGroups[1].get('h3').text()).toBe('Coming soon')
    expect(sourceGroups[1].text()).toContain('Reference links only')
    expect(sourceGroups[1].findAll('.knowledge-base-planned-item')).toHaveLength(4)
    expect(sourceGroups[1].findAll('.knowledge-base-card')).toHaveLength(0)
    expect(wrapper.get('.knowledge-base-ready-summary').text()).toContain('1 ready, 3 total')
    expect(wrapper.get('.knowledge-base-panel').attributes('aria-busy')).toBe('false')
    expect(wrapper.get('.knowledge-base-ready-summary').attributes('role')).toBe('status')

    for (const label of ['Notion', 'Confluence', 'Google Drive', 'SharePoint']) {
      const plannedItem = wrapper.findAll('.knowledge-base-planned-item')
        .find(item => item.text().includes(label))
      expect(plannedItem.get('.knowledge-base-planned-status').text()).toContain('Coming soon')
      expect(plannedItem.get('.knowledge-base-doc-link').text()).toContain('View official docs')
      expect(plannedItem.text()).not.toContain('Not configured')
    }

    const notionItem = wrapper.findAll('.knowledge-base-planned-item')
      .find(item => item.text().includes('Notion'))
    expect(notionItem.text()).toContain('Pages and databases')
    await notionItem.get('.knowledge-base-doc-link').trigger('click')
    await flushPromises()
    expect(bridge.localKnowledgeBase.openGuide).toHaveBeenCalledWith('notion', 'install')
    expect(bridge.localKnowledgeBase.status).toHaveBeenCalledTimes(2)

    const obsidianCard = wrapper.findAll('.knowledge-base-card')
      .find(card => card.text().includes('Obsidian'))
    expect(obsidianCard.exists()).toBe(true)
    expect(obsidianCard.text()).toContain('Vault not selected')
    await obsidianCard.get('.knowledge-base-actions button').trigger('click')
    await flushPromises()

    expect(bridge.localKnowledgeBase.pickObsidianVault).toHaveBeenCalledTimes(1)
    expect(wrapper.findAll('.knowledge-base-card').at(2).text()).toContain('/Users/rydersun/Documents/Knowledge')
    wrapper.unmount()
  })

  it('reports verified CLI knowledge access as read-only', async () => {
    const readyCliSource = kind => ({
      kind,
      accessMode: 'cli',
      installed: true,
      configured: true,
      connected: true,
      loginState: 'ready',
      permissionState: 'ready',
      commandName: kind === 'feishu' ? 'lark-cli' : 'dws',
      readable: true,
      writable: false,
      probeState: 'ready',
      errorCode: '',
      ready: true,
    })
    const { wrapper } = await mountApp(({ bridge }) => {
      bridge.localKnowledgeBase.status.mockResolvedValue([
        readyCliSource('feishu'),
        readyCliSource('dingtalk'),
        {
          kind: 'obsidian',
          accessMode: 'vault',
          installed: true,
          configured: false,
          connected: false,
          vaultPath: '',
          vaultDetails: { exists: false, directory: false, readable: false, writable: false },
          readable: false,
          writable: false,
          probeState: 'ready',
          errorCode: '',
          ready: false,
        },
      ])
    })

    await wrapper.get('.sidebar-settings-entry').trigger('click')
    await wrapper.findAll('.settings-tabs button')[2].trigger('click')
    await flushPromises()

    expect(wrapper.get('.knowledge-base-ready-summary').text()).toContain('2 ready, 3 total')
    for (const label of ['Feishu Docs', 'DingTalk Docs']) {
      const card = wrapper.findAll('.knowledge-base-card')
        .find(item => item.text().includes(label))
      expect(card.get('.knowledge-base-status').text()).toContain('Ready')
      const facts = card.findAll('.knowledge-base-facts > div')
      expect(facts).toHaveLength(3)
      expect(facts[0].text()).toContain('ConnectionOfficial CLI')
      expect(facts[1].text()).toContain('ReadRead enabled')
      expect(facts[2].text()).toContain('WriteWrite not verified')
      expect(facts[2].text()).not.toContain('Write enabled')
    }
    wrapper.unmount()
  })

  it('keeps local knowledge cards in Checking state until detection finishes', async () => {
    const statusResult = deferred()
    const { wrapper, bridge } = await mountApp(({ bridge }) => {
      bridge.localKnowledgeBase.status.mockReturnValue(statusResult.promise)
    })

    await wrapper.get('.sidebar-settings-entry').trigger('click')
    await wrapper.findAll('.settings-tabs button')[2].trigger('click')
    await wrapper.vm.$nextTick()

    const sourceGroups = wrapper.findAll('.knowledge-base-group')
    const localCards = sourceGroups[0].findAll('.knowledge-base-card')
    expect(localCards).toHaveLength(3)
    for (const card of localCards) {
      expect(card.get('.knowledge-base-status').text()).toContain('Checking')
      const facts = card.findAll('.knowledge-base-facts dd')
      expect(facts).toHaveLength(3)
      expect(facts[1].text()).toBe('Checking')
      expect(facts[2].text()).toBe('Checking')
      expect(card.get('.knowledge-base-hint').text()).toContain('Checking local installation')
      expect(card.get('.knowledge-base-actions button').text()).toContain('Checking')
      expect(card.get('.knowledge-base-actions button').attributes()).toHaveProperty('disabled')
      expect(card.text()).not.toMatch(/CLI not installed|CLI missing|Obsidian not installed|App missing|Vault not selected/)
    }
    expect(wrapper.get('.knowledge-base-panel').attributes('aria-busy')).toBe('true')
    expect(wrapper.get('.knowledge-base-ready-summary').text()).toBe('Checking')

    const plannedItems = sourceGroups[1].findAll('.knowledge-base-planned-item')
    expect(plannedItems).toHaveLength(4)
    for (const item of plannedItems) {
      expect(item.get('.knowledge-base-planned-status').text()).toContain('Coming soon')
      expect(item.get('.knowledge-base-doc-link').text()).toContain('View official docs')
      expect(item.get('.knowledge-base-doc-link').attributes()).not.toHaveProperty('disabled')
    }

    statusResult.resolve([])
    await flushPromises()

    expect(wrapper.get('.knowledge-base-panel').attributes('aria-busy')).toBe('false')
    expect(wrapper.get('.knowledge-base-ready-summary').text()).toContain('0 ready, 3 total')
    const unknownCards = wrapper.findAll('.knowledge-base-group')[0].findAll('.knowledge-base-card')
    for (const card of unknownCards) {
      expect(card.get('.knowledge-base-status').text()).toContain('Could not verify')
      expect(card.get('.knowledge-base-facts').text()).toContain('Read not verified')
      expect(card.get('.knowledge-base-facts').text()).toContain('Write not verified')
      expect(card.get('.knowledge-base-hint').text()).toContain('No local status was returned')
      expect(card.get('.knowledge-base-actions button').text()).toContain('Recheck')
      expect(card.get('.knowledge-base-actions button').attributes()).not.toHaveProperty('disabled')
      expect(card.text()).not.toMatch(/CLI not installed|CLI missing|Obsidian not installed|App missing|Vault not selected/)
    }

    await unknownCards[0].get('.knowledge-base-actions button').trigger('click')
    await flushPromises()
    expect(bridge.localKnowledgeBase.status).toHaveBeenCalledTimes(2)
    expect(wrapper.findAll('.knowledge-base-group')[0].findAll('.knowledge-base-card')[0].get('.knowledge-base-status').text()).toContain('Could not verify')
    wrapper.unmount()
  })

  it('shows knowledge probe failures without misreporting a missing CLI', async () => {
    const { wrapper } = await mountApp(({ bridge }) => {
      bridge.localKnowledgeBase.status.mockRejectedValue(Object.assign(
        new Error('probe unavailable'),
        { code: 'KNOWLEDGE_BASE_PROBE_FAILED' },
      ))
    })

    await wrapper.get('.sidebar-settings-entry').trigger('click')
    await wrapper.findAll('.settings-tabs button')[2].trigger('click')
    await flushPromises()

    const feishuCard = wrapper.findAll('.knowledge-base-card')
      .find(card => card.text().includes('Feishu Docs'))
    expect(feishuCard.exists()).toBe(true)
    expect(feishuCard.get('.knowledge-base-status').text()).toContain('Detection failed')
    expect(feishuCard.text()).toContain('The local probe failed')
    expect(feishuCard.text()).not.toContain('CLI not installed')
    expect(feishuCard.text()).not.toContain('CLI missing')
    wrapper.unmount()
  })

  it('shows the workspace home, keeps full Agent management in Settings, and switches language and theme', async () => {
    const { wrapper } = await mountApp()

    expect(wrapper.get('.home-dashboard-header h1').text()).toBe('Meldwork workspace')
    expect(wrapper.get('.home-workspace-state').text()).toContain('2 Agents ready')
    expect(wrapper.get('.home-panel-header h2').text()).toBe('Continue working')
    expect(wrapper.findAll('.home-panel-header h2')[1].text()).toBe('Start with an Agent')
    expect(wrapper.find('.home-overview-grid').exists()).toBe(false)
    expect(wrapper.find('.setup-guide').exists()).toBe(false)
    expect(wrapper.findAll('.agent-card')).toHaveLength(0)
    expect(wrapper.get('.brand-button img').attributes('src')).toBe('./logos/meldwork-mark-v3.svg')
    expect(wrapper.get('.brand-button').attributes('aria-current')).toBe('page')
    expect(wrapper.get('.sidebar-settings-entry').attributes()).not.toHaveProperty('aria-current')

    await wrapper.get('.sidebar-settings-entry').trigger('click')
    expect(wrapper.findAll('.agent-card')).toHaveLength(AGENTS.length)
    expect(wrapper.get('.system-settings-header h1').text()).toBe('Settings')
    expect(wrapper.get('.system-settings-header p').text()).toContain('knowledge bases')
    expect(wrapper.get('.sidebar-settings-entry').attributes('aria-current')).toBe('page')
    expect(wrapper.get('.brand-button').attributes()).not.toHaveProperty('aria-current')

    const controls = wrapper.findAll('.sidebar-footer-actions button')
    await controls[0].trigger('click')
    expect(wrapper.get('.system-settings-header h1').text()).toBe('设置')
    expect(wrapper.get('.system-settings-header p').text()).toContain('知识库')

    await controls[1].trigger('click')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(wrapper.get('.brand-button img').attributes('src')).toBe('./logos/meldwork-mark-v3-dark.svg')
    wrapper.unmount()
  })

  it('shows setup guidance only when no local Agent is ready', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      state.agents = state.agents.map(agent => ({
        ...agent,
        available: false,
        credentialState: 'missing',
      }))
    })

    expect(wrapper.get('.home-workspace-state').classes()).toContain('attention')
    expect(wrapper.get('.home-workspace-state').text()).toContain('needs attention')
    expect(wrapper.get('.setup-guide').exists()).toBe(true)
    wrapper.unmount()
  })

  it('returns to the workspace home from both conversations and Settings', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-home-navigation',
        conversationType: 'group',
        name: 'Home navigation',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
    })

    await wrapper.get('.conversation-link').trigger('click')
    expect(wrapper.find('.conversation-pane').exists()).toBe(true)
    await wrapper.get('.brand-button').trigger('click')
    expect(wrapper.find('.home-dashboard').exists()).toBe(true)
    expect(wrapper.find('.conversation-pane').exists()).toBe(false)
    expect(wrapper.get('.brand-button').attributes('aria-current')).toBe('page')

    await wrapper.get('.sidebar-settings-entry').trigger('click')
    expect(wrapper.find('.system-settings-page').exists()).toBe(true)
    expect(wrapper.get('.sidebar-settings-entry').attributes('aria-current')).toBe('page')
    await wrapper.get('.brand-button').trigger('click')
    expect(wrapper.find('.home-dashboard').exists()).toBe(true)
    expect(wrapper.find('.system-settings-page').exists()).toBe(false)
    wrapper.unmount()
  })

  it('collapses the sidebar while keeping Agent logos and workspace preferences available', async () => {
    const { wrapper } = await mountApp()

    expect(wrapper.find('.brand-actions').exists()).toBe(false)
    expect(wrapper.findAll('.sidebar-footer-actions button')).toHaveLength(2)
    expect(wrapper.findAll('.sidebar-agent-main img')).toHaveLength(2)

    await wrapper.get('.sidebar-toggle').trigger('click')
    expect(wrapper.get('.app-shell').classes()).toContain('sidebar-collapsed')
    expect(wrapper.get('.sidebar').classes()).toContain('collapsed')
    expect(wrapper.findAll('.sidebar-agent-main img')).toHaveLength(2)

    await wrapper.get('.sidebar-toggle').trigger('click')
    expect(wrapper.get('.app-shell').classes()).not.toContain('sidebar-collapsed')
    wrapper.unmount()
  })

  it('stacks the collapsed brand mark above the expand control without shrinking either', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')

    expect(source).toMatch(/\.sidebar\.collapsed \.brand-row\s*\{[^}]*flex-direction:\s*column;/s)
    expect(source).toMatch(/\.sidebar\.collapsed \.brand-button\s*\{[^}]*flex:\s*0 0 34px;/s)
    expect(source).toMatch(/\.sidebar\.collapsed \.sidebar-toggle\s*\{[^}]*flex:\s*0 0 34px;/s)
  })

  it('anchors collapsed sidebar controls while the workspace width animates', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')

    expect(source).toMatch(/\.app-shell\s*\{[^}]*transition:\s*grid-template-columns 0\.22s cubic-bezier\(0\.16, 1, 0\.3, 1\);/s)
    expect(source).toMatch(/\.sidebar\.collapsed \.brand-row\s*\{[^}]*width:\s*var\(--sidebar-collapsed-width\);[^}]*align-self:\s*flex-start;/s)
    expect(source).toMatch(/\.sidebar\.collapsed \.conversation-nav\s*\{[^}]*width:\s*var\(--sidebar-collapsed-width\);[^}]*align-self:\s*flex-start;/s)
    expect(source).toMatch(/\.sidebar\.collapsed \.sidebar-footer\s*\{[^}]*width:\s*var\(--sidebar-collapsed-width\);[^}]*align-self:\s*flex-start;/s)
    expect(source).toMatch(/\.sidebar\.collapsed \.sidebar-footer button\s*\{[^}]*width:\s*34px;/s)
    expect(source).toMatch(/\.sidebar\.collapsed \.new-group-button\s*\{[^}]*margin:\s*2px 15px 12px;/s)
    expect(source).not.toMatch(/\.sidebar\.collapsed \.new-group-button\s*\{[^}]*margin-inline:\s*auto;/s)
  })

  it('uses one settings entry and a borderless Agent mention menu', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')

    expect(source).toMatch(/\.sidebar-footer\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto;/s)
    expect(source).not.toMatch(/\.sidebar\s*\{[^}]*border-right:\s*1px solid var\(--border\);/s)
    expect(source).not.toMatch(/\.sidebar-footer\s*\{[^}]*border-top:\s*1px solid var\(--border\);/s)
    expect(source).not.toMatch(/\.system-settings-header\s*\{[^}]*border-bottom:\s*1px solid var\(--border\);/s)
    expect(source).not.toMatch(/\.settings-tabs\s*\{[^}]*border-bottom:\s*1px solid var\(--border\);/s)
    expect(source).toMatch(/\.settings-tabs button\.active\s*\{[^}]*border-bottom-color:\s*var\(--accent\);/s)
    expect(source).toMatch(/\.skill-menu\s*\{[^}]*border:\s*0;/s)
    expect(source).toMatch(/\.skill-option\.agent-mention-option small\s*\{[^}]*-webkit-line-clamp:\s*2;/s)
    expect(source).toMatch(/\.modal-pop-enter-active,[^{]+\.modal-pop-leave-active\s*\{[^}]*transform 0\.18s cubic-bezier\(0\.16, 1, 0\.3, 1\);/s)
    expect(source).toMatch(/\.direct-session-action\s*\{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/s)
    expect(source).toMatch(/\.direct-session-row:hover \.direct-session-action,[^{]+\.direct-session-row:focus-within \.direct-session-action\s*\{[^}]*opacity:\s*0\.62;[^}]*pointer-events:\s*auto;/s)
  })

  it('uses a distinct Meldwork palette and separates composer controls', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    const appSource = readFileSync(resolve(process.cwd(), 'src/App.vue'), 'utf8')

    expect(source).toContain('--accent: #d45f52;')
    expect(source).toContain('--accent: #d98568;')
    expect(source).toMatch(/\.mode-segmented button\[data-mode="auto"\]\.active\s*\{[^}]*background:\s*var\(--accent-soft\);/s)
    expect(source).toMatch(/\.composer-attachment-button\s*\{[^}]*background:\s*transparent;/s)
    expect(source).toMatch(/\.composer-skill-button\s*\{[^}]*background:\s*transparent;/s)
    expect(source).toMatch(/:root\[data-theme="dark"\] \.send-button\s*\{[^}]*background:\s*transparent;/s)
    expect(source).not.toContain(':root[data-theme="dark"] img[src$="/hermes.svg"] {')
    expect(source).toMatch(/\.target-chip\s*\{[^}]*margin-left:\s*-19px;/s)
    expect(source).toMatch(/\.target-row\s*\{[^}]*background:\s*transparent;/s)
    expect(source).toMatch(/\.agent-card\s*\{[^}]*border:\s*0;[^}]*background:\s*color-mix/s)
    expect(source).toMatch(/\.agent-capability-list > span\s*\{[^}]*border:\s*0;/s)
    expect(source).toMatch(/\.settings-agent-card\.focused\s*\{[^}]*box-shadow:\s*none;/s)
    expect(source).not.toContain('img[src$="/hermes.svg"],\n:root[data-theme="dark"] img[src$="/opencode.svg"]')
    expect(appSource).toContain('composer-attachment-button')
    expect(appSource).toContain('composer-skill-button')
    expect(appSource).toContain("modal === 'unlimited-confirm'")
    expect(appSource).not.toContain('window.confirm')
  })

  it('keeps the collapsed mobile sidebar to the expandable brand row', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    const mobileRules = source.slice(source.indexOf('@media (max-width: 760px)'))

    expect(mobileRules).toMatch(/\.sidebar\.collapsed\s*\{[^}]*min-height:\s*0;/)
    expect(mobileRules).toMatch(/\.sidebar\.collapsed\s*>\s*:not\(\.brand-row\)\s*\{[^}]*display:\s*none;/)
  })

  it('lets the conversation and composer grow with wide desktop windows', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')

    expect(source).toMatch(/--conversation-content-width:\s*clamp\(820px,\s*70vw,\s*1360px\)/)
    expect(source).toMatch(/\.message-list\s*\{[^}]*width:\s*min\(var\(--conversation-content-width\),\s*100%\);[^}]*justify-self:\s*center;/s)
    expect(source).toMatch(/\.composer-shell\s*\{[^}]*width:\s*min\(var\(--conversation-content-width\),\s*100%\);/s)
  })

  it('pins the turn rail beside the sidebar with Dock proximity magnification', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    const appSource = readFileSync(resolve(process.cwd(), 'src/App.vue'), 'utf8')

    expect(source).toMatch(/\.message-stage\s*\{[^}]*width:\s*100%;[^}]*grid-template-columns:\s*48px minmax\(0,\s*1fr\);[^}]*padding-right:\s*48px;/s)
    expect(source).toMatch(/\.turn-rail\s*\{[^}]*top:\s*50%;[^}]*transform:\s*translateY\(-50%\);/s)
    expect(source).toContain('.turn-rail button:has(+ button:hover)')
    expect(source).toContain('.turn-rail button:has(+ button + button + button:hover)')
    expect(source).toMatch(/\.turn-rail button:hover > span:first-child,[^{]+\{[^}]*--turn-offset:\s*10px;[^}]*--turn-scale:\s*2\.4;/s)
    expect(source).toMatch(/\.turn-rail button > span:first-child\s*\{[^}]*transform-origin:\s*left center;/s)
    expect(source).not.toContain('.turn-rail::before')
    expect(source).toMatch(/\.message-row\.topic-reply\s*\{[^}]*border-left:\s*0;/s)
    expect(source).toMatch(/\.message-row\.group-message\.agent \.message-body::before\s*\{[^}]*background:\s*var\(--agent-accent\);/s)
    expect(source).toMatch(/\.message-copy-surface\s*\{[^}]*cursor:\s*text;/s)
    expect(source).toMatch(/\.run-status-panel\.group\s*\{[^}]*border-left:\s*0;/s)
    expect(source).toMatch(/\.composer-box\s*\{[^}]*border:\s*0;/s)
    expect(source).toMatch(/\.composer-context-row\s*\{[^}]*border-bottom:\s*0;/s)
    expect(source).toMatch(/\.send-button,\s*\.stop-button\s*\{[^}]*border:\s*0;/s)
    expect(source).toMatch(/\.send-button,\s*\.stop-button\s*\{[^}]*border-radius:\s*var\(--radius\);/s)
    expect(source).not.toContain('.stop-button-motion')
    expect(appSource).toContain('<SendOutline v-else aria-hidden="true" />')
    expect(appSource).toContain('<StopCircleOutline aria-hidden="true" />')
    expect(appSource).not.toContain('<PlayOutline')
    expect(appSource).not.toContain('<ArrowUpOutline')
  })

  it('saves the exact Provider payload exposed by preload', async () => {
    const { wrapper, bridge } = await mountApp()

    await wrapper.get('.sidebar-settings-entry').trigger('click')
    await wrapper.findAll('.settings-tabs button')[1].trigger('click')
    await wrapper.findAll('.provider-agent-list button')
      .find(button => button.text().includes('Hermes'))
      .trigger('click')
    await flushPromises()
    const inputs = wrapper.findAll('.provider-editor input')
    await inputs[0].setValue('Local gateway')
    await inputs[1].setValue('https://gateway.example/v1')
    await inputs[2].setValue('roundrelay-model')
    await inputs[3].setValue('secret-key')
    await wrapper.get('form.provider-editor').trigger('submit')
    await flushPromises()

    expect(bridge.localAgentProvider.save).toHaveBeenCalledWith('hermes', {
      preset: 'official',
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

    await wrapper.findAll('.sidebar-footer-actions button')[0].trigger('click')
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
    await wrapper.get('.mode-segmented [data-mode="manual"]').trigger('click')
    await wrapper.findAll('.target-chip')[1].trigger('click')
    expect(wrapper.findAll('.target-chip')[0].classes()).toContain('selected')
    expect(wrapper.findAll('.target-chip')[1].classes()).not.toContain('selected')

    emitWorkspaceChanged()
    await flushPromises()

    expect(wrapper.findAll('.target-chip')[0].classes()).toContain('selected')
    expect(wrapper.findAll('.target-chip')[1].classes()).not.toContain('selected')
    wrapper.unmount()
  })

  it('sends one atomic automatic discussion with bounded rounds', async () => {
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
    expect(wrapper.get('.mode-segmented [data-mode="auto"]').classes()).toContain('active')
    expect(wrapper.get('.round-settings-trigger').text()).toContain('6 rounds')
    expect(wrapper.findAll('.target-chip').every(chip => chip.classes().includes('selected'))).toBe(true)
    expect(wrapper.findAll('.target-chip').every(chip => chip.attributes('disabled') !== undefined)).toBe(true)
    expect(wrapper.findAll('.target-chip')[0].attributes('aria-label')).toBe('Codex participates in automatic discussion')

    await wrapper.get('.round-settings-trigger').trigger('click')
    const range = wrapper.get('.round-range-input')
    await range.setValue(1)
    expect(wrapper.get('.round-settings-popover output').text()).toBe('1 rounds')
    await range.setValue(10)
    expect(wrapper.get('.round-settings-popover output').text()).toBe('10 rounds')
    await range.setValue(6)
    await wrapper.get('.round-unlimited-button').trigger('click')
    await flushPromises()
    expect(wrapper.get('.confirmation-modal-body').text()).toContain('consume more Provider quota')
    expect(wrapper.find('.round-range-input').exists()).toBe(true)
    await wrapper.get('.confirmation-modal-footer .primary-button').trigger('click')
    await flushPromises()
    expect(wrapper.find('.round-range-input').exists()).toBe(false)
    expect(wrapper.get('.round-settings-trigger').text()).toContain('Unlimited')
    await wrapper.get('.round-bounded-button').trigger('click')
    await flushPromises()
    expect(wrapper.find('.round-range-input').exists()).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(wrapper.find('.round-settings-popover').exists()).toBe(false)

    await wrapper.get('.composer-box textarea').setValue('Continue the review')
    await wrapper.get('.send-button').trigger('click')
    await flushPromises()

    expect(bridge.localWorkspace.send).toHaveBeenCalledTimes(1)
    expect(bridge.localWorkspace.send).toHaveBeenCalledWith({
      groupId: 'group-1',
      text: 'Continue the review',
      targetKinds: ['codex', 'hermes'],
      skillHints: [],
      attachments: [],
      mode: 'auto',
      maxRounds: 6,
    })
    expect(bridge.localWorkspace.startAuto).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('sends unlimited automatic discussions without a round cap', async () => {
    const { wrapper, bridge } = await mountApp(({ state, bridge: desktopBridge }) => {
      state.groups.push({
        id: 'group-1',
        conversationType: 'group',
        name: 'Open discussion',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      desktopBridge.localWorkspace.send.mockImplementation(async (input) => {
        state.runningGroupIds = [input.groupId]
        state.runs = [{
          groupId: input.groupId,
          mode: 'auto',
          targetKinds: input.targetKinds,
          completedKinds: [],
          currentKind: 'codex',
          currentRound: 1,
          maxRounds: 0,
          unlimitedRounds: true,
          progress: [],
        }]
        return structuredClone(state)
      })
    })

    await wrapper.get('.conversation-link').trigger('click')
    await wrapper.get('.round-settings-trigger').trigger('click')
    await wrapper.get('.round-unlimited-button').trigger('click')
    await wrapper.get('.confirmation-modal-footer .primary-button').trigger('click')
    await wrapper.get('.composer-box textarea').setValue('Continue until consensus')
    await wrapper.get('.send-button').trigger('click')
    await flushPromises()

    expect(bridge.localWorkspace.send).toHaveBeenCalledWith({
      groupId: 'group-1',
      text: 'Continue until consensus',
      targetKinds: ['codex', 'hermes'],
      skillHints: [],
      attachments: [],
      mode: 'auto',
      maxRounds: 6,
      unlimitedRounds: true,
    })
    expect(wrapper.get('.run-round-progress').text()).toBe('Round 1 / Unlimited')
    wrapper.unmount()
  })

  it('creates direct chats and local Agent groups', async () => {
    const { wrapper, bridge, state } = await mountApp()

    let createdGroup = null
    const directGroup = {
      id: 'direct-codex',
      conversationType: 'direct',
      directAgentKind: 'codex',
      name: 'Codex',
      agentKinds: ['codex'],
      workdir: '/tmp/roundrelay-workspace',
      allowWrite: true,
      createdAt: '2026-07-29T08:00:00Z',
      updatedAt: '2026-07-29T08:00:00Z',
    }
    bridge.localWorkspace.createGroup.mockResolvedValueOnce(directGroup)
    bridge.localWorkspace.createGroup.mockImplementationOnce(async input => {
      createdGroup = {
        id: 'group-1',
        createdAt: '2026-07-29T09:00:00Z',
        updatedAt: '2026-07-29T09:00:00Z',
        ...structuredClone(input),
      }
      return structuredClone(createdGroup)
    })
    bridge.localWorkspace.get.mockImplementation(async () => ({
      ...state,
      groups: createdGroup ? [directGroup, createdGroup] : [directGroup],
    }))

    await wrapper.findAll('.home-agent-item')[0].trigger('click')
    await flushPromises()
    expect(bridge.localWorkspace.createGroup).toHaveBeenCalledWith({
      conversationType: 'direct',
      directAgentKind: 'codex',
      name: 'Codex',
      agentKinds: ['codex'],
      workdir: '/tmp/roundrelay-workspace',
      allowWrite: true,
    })
    expect(wrapper.get('.conversation-capabilities').text()).toContain('Write enabled')

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
      allowWrite: true,
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

    const openChat = wrapper.findAll('.sidebar-agent-new')[0]
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

    await hermesAgent.get('.direct-session-open').trigger('click')

    expect(wrapper.get('.conversation-header h1').text()).toBe('Hermes history')
    expect(wrapper.get('.conversation-capabilities').text()).toContain('Write enabled')
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
    expect(wrapper.get('.modal-header p').text()).toBe('Review')
    const primaryInputs = wrapper.findAll('.settings-primary-grid input')
    expect(primaryInputs[0].element.value).toBe('Review')
    expect(primaryInputs[0].attributes('placeholder')).toBe('Design review')
    expect(primaryInputs[1].element.value).toBe('Initial topic')
    expect(primaryInputs[1].attributes('placeholder')).toBe('What should the Agents work on?')
    expect(wrapper.findAll('.settings-agent-choice.selected')).toHaveLength(2)
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

  it('renames a group inline and cancels a later edit with Escape', async () => {
    const { wrapper, bridge } = await mountApp(({ state, bridge: desktopBridge }) => {
      state.groups.push({
        id: 'group-1',
        conversationType: 'group',
        name: 'Review',
        topic: 'Initial topic',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: true,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      desktopBridge.localWorkspace.updateGroup.mockImplementation(async (groupId, input) => {
        Object.assign(state.groups.find(group => group.id === groupId), structuredClone(input))
        return structuredClone(state.groups.find(group => group.id === groupId))
      })
      desktopBridge.localWorkspace.get.mockImplementation(async () => structuredClone(state))
    })

    await wrapper.get('.conversation-link').trigger('click')
    await wrapper.get('.conversation-title-button').trigger('click')
    const input = wrapper.get('.inline-title-form input')
    await input.setValue('Architecture review')
    await wrapper.get('.inline-title-form').trigger('submit')
    await flushPromises()

    expect(bridge.localWorkspace.updateGroup).toHaveBeenCalledWith('group-1', {
      name: 'Architecture review',
      topic: 'Initial topic',
      agentKinds: ['codex', 'hermes'],
      workdir: '/tmp/roundrelay-workspace',
      allowWrite: true,
    })
    expect(wrapper.get('.conversation-header h1').text()).toBe('Architecture review')

    await wrapper.get('.conversation-title-button').trigger('click')
    await wrapper.get('.inline-title-form input').setValue('Discarded title')
    await wrapper.get('.inline-title-form input').trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('.inline-title-form').exists()).toBe(false)
    expect(wrapper.get('.conversation-header h1').text()).toBe('Architecture review')
    expect(bridge.localWorkspace.updateGroup).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('cancels and saves inline title edits for a direct conversation', async () => {
    const { wrapper, bridge } = await mountApp(({ state, bridge: desktopBridge }) => {
      state.groups.push({
        id: 'direct-codex',
        conversationType: 'direct',
        directAgentKind: 'codex',
        name: 'Codex review',
        topic: 'Keep context',
        agentKinds: ['codex'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      desktopBridge.localWorkspace.updateGroup.mockImplementation(async (groupId, input) => {
        Object.assign(state.groups.find(group => group.id === groupId), structuredClone(input))
        return structuredClone(state.groups.find(group => group.id === groupId))
      })
      desktopBridge.localWorkspace.get.mockImplementation(async () => structuredClone(state))
    })

    await wrapper.get('.direct-session-open').trigger('click')
    await wrapper.get('.conversation-title-button').trigger('click')
    await wrapper.get('.inline-title-form input').setValue('Temporary name')
    await wrapper.get('.inline-title-form button[type="button"]').trigger('click')
    expect(wrapper.get('.conversation-header h1').text()).toBe('Codex review')
    expect(bridge.localWorkspace.updateGroup).not.toHaveBeenCalled()

    await wrapper.get('.conversation-title-button').trigger('click')
    await wrapper.get('.inline-title-form input').setValue('Code audit')
    await wrapper.get('.inline-title-form').trigger('submit')
    await flushPromises()

    expect(bridge.localWorkspace.updateGroup).toHaveBeenCalledWith('direct-codex', {
      name: 'Code audit',
      topic: 'Keep context',
      agentKinds: ['codex'],
      workdir: '/tmp/roundrelay-workspace',
      allowWrite: false,
    })
    expect(wrapper.get('.conversation-header h1').text()).toBe('Code audit')
    wrapper.unmount()
  })

  it('mentions one Agent, scopes its Skills, and sends only to that Agent', async () => {
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
    const textarea = wrapper.get('.composer-box textarea')
    await textarea.setValue('@co')
    await flushPromises()

    expect(wrapper.findAll('.agent-mention-option')).toHaveLength(1)
    expect(wrapper.get('.agent-mention-option').text()).toContain('Codex')
    expect(wrapper.get('.agent-mention-option').text()).toContain('Structured reasoning')
    await wrapper.get('.agent-mention-option').trigger('click')
    expect(wrapper.get('.selected-agent-tag').text()).toContain('Codex')
    expect(wrapper.get('.mode-segmented [data-mode="manual"]').classes()).toContain('active')
    expect(wrapper.get('.mode-segmented [data-mode="auto"]').attributes()).toHaveProperty('disabled')

    bridge.agentInstaller.skills.mockClear()
    await textarea.setValue('@rev')
    await flushPromises()

    expect(bridge.agentInstaller.skills.mock.calls).toEqual([['codex']])
    expect(wrapper.findAll('.skill-option')).toHaveLength(1)
    expect(wrapper.get('.skill-option').text()).toContain('Review code')
    expect(wrapper.get('.skill-option').text()).not.toContain('Research')
    expect(textarea.attributes('role')).toBe('combobox')
    expect(textarea.attributes('aria-expanded')).toBe('true')
    expect(textarea.attributes('aria-controls')).toBe('composer-skill-menu')
    expect(textarea.attributes('aria-activedescendant')).toBe('composer-mention-option-0')

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
      mentionedAgentKinds: ['codex'],
      skillHints: [{ targetKind: 'codex', namespace: 'quality', slug: 'review', name: 'Review code' }],
      attachments: [],
      mode: 'manual',
      maxRounds: 6,
    })
    expect(wrapper.find('.selected-agent-tag').exists()).toBe(false)
    wrapper.unmount()
  })

  it('supports multiple Agent Tags and removes Skills with their Agent', async () => {
    const { wrapper } = await mountApp(({ state, bridge: desktopBridge }) => {
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
        skills: kind === 'hermes'
          ? [{ targetKind: 'hermes', namespace: 'research', slug: 'sources', name: 'Find sources' }]
          : [],
      }))
    })

    await wrapper.get('.conversation-link').trigger('click')
    const textarea = wrapper.get('.composer-box textarea')
    await textarea.setValue('@cod')
    await wrapper.get('.agent-mention-option').trigger('click')
    await textarea.setValue('@her')
    await flushPromises()
    await wrapper.get('.agent-mention-option').trigger('click')

    expect(wrapper.findAll('.selected-agent-tag').map(tag => tag.text()))
      .toEqual(['Codex', 'Hermes'])

    await textarea.setValue('@find')
    await flushPromises()
    expect(wrapper.findAll('.skill-option')).toHaveLength(1)
    expect(wrapper.get('.skill-option').text()).toContain('Find sources')
    await textarea.trigger('keydown', { key: 'Enter' })
    expect(wrapper.get('.selected-skill').text()).toContain('Find sources')

    await wrapper.findAll('.selected-agent-tag button')[1].trigger('click')
    expect(wrapper.findAll('.selected-agent-tag').map(tag => tag.text())).toEqual(['Codex'])
    expect(wrapper.find('.selected-skill').exists()).toBe(false)
    wrapper.unmount()
  })

  it('sends multiple Agent Tags without queueing unmentioned group members', async () => {
    const { wrapper, bridge } = await mountApp(({ state }) => {
      state.agents.push({
        kind: 'qwen',
        installed: true,
        available: true,
        credentialState: 'ready',
        version: '1.0.0',
      })
      state.groups.push({
        id: 'group-1',
        conversationType: 'group',
        name: 'Review',
        topic: '',
        agentKinds: ['codex', 'hermes', 'qwen'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
    })

    await wrapper.get('.conversation-link').trigger('click')
    const textarea = wrapper.get('.composer-box textarea')
    await textarea.setValue('@cod')
    await wrapper.get('.agent-mention-option').trigger('click')
    await textarea.setValue('@her')
    await flushPromises()
    await wrapper.get('.agent-mention-option').trigger('click')
    await textarea.setValue('Compare your findings')
    await wrapper.get('.send-button').trigger('click')
    await flushPromises()

    expect(bridge.localWorkspace.send).toHaveBeenCalledWith({
      groupId: 'group-1',
      text: 'Compare your findings',
      targetKinds: ['codex', 'hermes'],
      mentionedAgentKinds: ['codex', 'hermes'],
      skillHints: [],
      attachments: [],
      mode: 'manual',
      maxRounds: 6,
    })
    wrapper.unmount()
  })

  it('restores Agent Tags and Skills when a targeted send fails', async () => {
    const { wrapper } = await mountApp(({ state, bridge: desktopBridge }) => {
      state.groups.push({
        id: 'group-1',
        conversationType: 'group',
        name: 'Research',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      desktopBridge.agentInstaller.skills.mockResolvedValue({
        skills: [{ targetKind: 'hermes', namespace: 'research', slug: 'sources', name: 'Find sources' }],
      })
      desktopBridge.localWorkspace.send.mockRejectedValueOnce(new Error('LOCAL_AGENT_EXECUTION_FAILED'))
    })

    await wrapper.get('.conversation-link').trigger('click')
    const textarea = wrapper.get('.composer-box textarea')
    await textarea.setValue('@her')
    await wrapper.get('.agent-mention-option').trigger('click')
    await textarea.setValue('@find')
    await flushPromises()
    await textarea.trigger('keydown', { key: 'Enter' })
    await textarea.setValue('Research this market')
    await wrapper.get('.send-button').trigger('click')
    await flushPromises()

    expect(textarea.element.value).toBe('Research this market')
    expect(wrapper.get('.selected-agent-tag').text()).toContain('Hermes')
    expect(wrapper.get('.selected-skill').text()).toContain('Find sources')
    wrapper.unmount()
  })

  it('keeps direct chats on their Agent Skills without Agent Tags', async () => {
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
      desktopBridge.agentInstaller.skills.mockImplementation(async kind => ({
        skills: kind === 'codex'
          ? [{ targetKind: 'codex', namespace: 'quality', slug: 'review', name: 'Review code' }]
          : [],
      }))
    })

    await wrapper.get('.direct-session-open').trigger('click')
    bridge.agentInstaller.skills.mockClear()
    const textarea = wrapper.get('.composer-box textarea')
    await textarea.setValue('@review')
    await flushPromises()

    expect(bridge.agentInstaller.skills.mock.calls).toEqual([['codex']])
    expect(wrapper.find('.agent-mention-option').exists()).toBe(false)
    expect(wrapper.get('.skill-option').text()).toContain('Review code')
    await textarea.trigger('keydown', { key: 'Enter' })
    await textarea.setValue('Review this implementation')
    await wrapper.get('.send-button').trigger('click')
    await flushPromises()

    expect(bridge.localWorkspace.send).toHaveBeenCalledWith({
      groupId: 'direct-codex',
      text: 'Review this implementation',
      targetKinds: ['codex'],
      skillHints: [{ targetKind: 'codex', namespace: 'quality', slug: 'review', name: 'Review code' }],
      attachments: [],
      mode: 'manual',
      maxRounds: 6,
    })
    expect(wrapper.find('.selected-agent-tag').exists()).toBe(false)
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
      mode: 'manual',
      maxRounds: 6,
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

    await wrapper.get('.sidebar-settings-entry').trigger('click')
    await wrapper.get('.manager-toolbar .secondary-button').trigger('click')
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

  it('keeps the attachment action clickable when image support is unavailable', async () => {
    const { wrapper, bridge } = await mountApp(({ state }) => {
      state.agents.push({
        kind: 'workbuddy',
        installed: true,
        available: true,
        credentialState: 'ready',
        version: '1.0.0',
      })
      state.groups.push({
        id: 'direct-workbuddy',
        conversationType: 'direct',
        directAgentKind: 'workbuddy',
        name: 'WorkBuddy',
        agentKinds: ['workbuddy'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
    })

    await wrapper.get('.direct-session-open').trigger('click')
    const attachmentButton = wrapper.get('.composer-attachment-button')
    expect(attachmentButton.attributes()).not.toHaveProperty('disabled')
    await attachmentButton.trigger('click')
    await flushPromises()

    expect(bridge.localAttachments.pickImages).not.toHaveBeenCalled()
    expect(wrapper.get('.toast-message').text()).toContain('does not support image attachments')
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

  it('renders Agent image, audio, and video outputs inside the conversation', async () => {
    const { wrapper, bridge } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'direct-codex',
        conversationType: 'direct',
        directAgentKind: 'codex',
        name: 'Codex',
        agentKinds: ['codex'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: true,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      state.messages.push({
        id: 'agent-media',
        groupId: 'direct-codex',
        role: 'agent',
        agentKind: 'codex',
        content: 'Generated media is ready.',
        attachments: [
          { id: 'poster-image', name: 'poster.png', mimeType: 'image/png', size: 3 },
          { id: 'briefing-audio', name: 'briefing.mp3', mimeType: 'audio/mpeg', size: 12 },
          { id: 'demo-video', name: 'demo.mp4', mimeType: 'video/mp4', size: 24 },
        ],
        createdAt: '2026-07-29T08:01:00Z',
      })
    })

    await wrapper.get('.direct-session-open').trigger('click')
    await flushPromises()

    expect(bridge.localAttachments.preview).toHaveBeenCalledTimes(1)
    expect(bridge.localAttachments.preview).toHaveBeenCalledWith('poster-image')
    expect(wrapper.get('.message-attachment-grid img').attributes('src')).toBe('data:image/png;base64,AQID')
    expect(wrapper.get('.message-attachment-grid audio').attributes('src'))
      .toBe('meldwork-media://attachment/briefing-audio')
    expect(wrapper.get('.message-attachment-grid video').attributes('src'))
      .toBe('meldwork-media://attachment/demo-video')
    expect(wrapper.findAll('.message-attachment-grid figcaption').map(item => item.text()))
      .toEqual(['poster.png', 'briefing.mp3', 'demo.mp4'])
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
    await wrapper.get('.sidebar-settings-entry').trigger('click')
    expect(wrapper.get('.agent-card .agent-capability-list').text()).toContain('12 local skills')
    expect(wrapper.get('.agent-card .agent-capability-list').text()).toContain('Up to 4 images')
    expect(wrapper.get('.agent-card .agent-capability-list').text()).toContain('Not configured')

    await wrapper.get('.sidebar-agent-new').trigger('click')
    await flushPromises()

    expect(bridge.localWorkspace.createGroup).toHaveBeenCalledWith(expect.objectContaining({
      conversationType: 'direct',
      directAgentKind: 'codex',
      name: 'Codex chat 2',
    }))
    expect(wrapper.findAll('.direct-session-row')).toHaveLength(2)
    await wrapper.get('.sidebar-agent-main').trigger('click')
    expect(wrapper.findAll('.direct-session-row')).toHaveLength(0)
    await wrapper.get('.sidebar-agent-main').trigger('click')
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
    expect(wrapper.find('.modal.medium').exists()).toBe(false)
    expect(wrapper.get('.sidebar-delete-popover').text()).toContain('Delete this conversation?')
    expect(wrapper.get('.sidebar-delete-popover').text()).toContain('Native CLI sessions are not deleted')
    expect(wrapper.get('.sidebar-delete-popover .danger-button').text()).toContain('Confirm delete')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(wrapper.find('.sidebar-delete-popover').exists()).toBe(false)
    await wrapper.findAll('.direct-session-row')[1].findAll('.direct-session-action')[1].trigger('click')
    await wrapper.get('.sidebar-delete-popover .danger-button').trigger('click')
    await flushPromises()
    expect(bridge.localWorkspace.deleteGroup).toHaveBeenCalledWith('direct-codex-1')
    wrapper.unmount()
  })

  it('keeps sidebar session trees visible and collapses long lists behind More', async () => {
    const source = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    expect(source).toMatch(/\.direct-session-list::before/)
    expect(source).toMatch(/\.direct-session-list > \.sidebar-more-button::before/)
    expect(source).toMatch(/\.direct-session-list > :last-child::before\s*\{[^}]*border-bottom-left-radius:\s*5px;/s)
    expect(source).toMatch(/\.direct-session-list::before\s*\{[^}]*bottom:\s*19px;/s)
    expect(source).not.toMatch(/\.group-conversation-list::before/)
    expect(source).not.toMatch(/\.group-conversation-row::before/)

    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push(
        ...Array.from({ length: 6 }, (_, index) => ({
          id: `direct-codex-${index + 1}`,
          conversationType: 'direct',
          directAgentKind: 'codex',
          name: `Codex ${index + 1}`,
          topic: '',
          agentKinds: ['codex'],
          workdir: '/tmp/roundrelay-workspace',
          allowWrite: false,
          createdAt: `2026-07-29T08:${String(index).padStart(2, '0')}:00Z`,
          updatedAt: `2026-07-29T09:${String(59 - index).padStart(2, '0')}:00Z`,
        })),
      )
      state.groups.push(
        ...Array.from({ length: 9 }, (_, index) => ({
          id: `group-sidebar-${index + 1}`,
          conversationType: 'group',
          name: `Group ${index + 1}`,
          topic: '',
          agentKinds: ['codex', 'hermes'],
          workdir: '/tmp/roundrelay-workspace',
          allowWrite: false,
          createdAt: `2026-07-29T10:${String(index).padStart(2, '0')}:00Z`,
          updatedAt: `2026-07-29T11:${String(59 - index).padStart(2, '0')}:00Z`,
        })),
      )
    })

    const codexAgent = wrapper.findAll('.sidebar-agent').find(node => node.text().includes('Codex'))
    expect(codexAgent).toBeTruthy()
    expect(codexAgent.get('.direct-session-list').classes()).toContain('direct-session-list')
    expect(codexAgent.findAll('.direct-session-row')).toHaveLength(5)

    const directMore = codexAgent.get('.sidebar-more-button')
    expect(directMore.text()).toBe('More')
    expect(directMore.attributes('aria-expanded')).toBe('false')
    await directMore.trigger('click')
    expect(codexAgent.findAll('.direct-session-row')).toHaveLength(6)
    expect(codexAgent.get('.sidebar-more-button').text()).toBe('Less')
    expect(codexAgent.get('.sidebar-more-button').attributes('aria-expanded')).toBe('true')

    const groupList = wrapper.get('.group-conversation-list')
    expect(groupList.classes()).not.toContain('direct-session-list')
    expect(groupList.findAll('.direct-session-row')).toHaveLength(0)
    expect(groupList.findAll('.group-conversation-row')).toHaveLength(8)
    const groupMore = groupList.get('.sidebar-more-button')
    expect(groupMore.text()).toBe('More')
    expect(groupMore.attributes('aria-expanded')).toBe('false')
    await groupMore.trigger('click')
    expect(groupList.findAll('.group-conversation-row')).toHaveLength(9)
    expect(groupList.get('.sidebar-more-button').text()).toBe('Less')
    expect(groupList.get('.sidebar-more-button').attributes('aria-expanded')).toBe('true')

    wrapper.unmount()
  })

  it('keeps group icons transparent and exposes safe sidebar rename and delete actions', async () => {
    const source = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    expect(source).toMatch(/\.group-avatar\s*\{[^}]*background:\s*transparent;/s)
    expect(source).toMatch(/\.group-conversation-row:hover \.group-conversation-actions/)
    expect(source).toMatch(/\.group-conversation-row:hover \.direct-session-action,\s*\.group-conversation-row:focus-within \.direct-session-action/s)

    const { wrapper, bridge } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-sidebar-actions',
        conversationType: 'group',
        name: 'Market research',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
    })

    const row = wrapper.get('.group-conversation-row')
    const actions = row.findAll('.direct-session-action')
    expect(actions).toHaveLength(2)
    expect(actions[0].attributes('aria-label')).toBe('Rename group Market research')
    expect(actions[1].attributes('aria-label')).toBe('Delete group Market research')

    await actions[0].trigger('click')
    expect(wrapper.get('#modal-title').text()).toBe('Rename group chat')
    await wrapper.get('form.form-stack input:not([type="checkbox"])').setValue('GEO research')
    await wrapper.get('form.form-stack').trigger('submit')
    await flushPromises()
    expect(bridge.localWorkspace.updateGroup).toHaveBeenCalledWith(
      'group-sidebar-actions',
      expect.objectContaining({ name: 'GEO research' }),
    )

    await wrapper.get('.group-conversation-row .direct-session-action.danger').trigger('click')
    expect(wrapper.find('.modal.medium').exists()).toBe(false)
    expect(wrapper.get('.sidebar-delete-popover .danger-button').text()).toContain('Confirm delete')
    await wrapper.get('.sidebar-delete-popover .danger-button').trigger('click')
    await flushPromises()
    expect(bridge.localWorkspace.deleteGroup).toHaveBeenCalledWith('group-sidebar-actions')
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

  it('maps direct tasks onto the turn rail without group reply styling', async () => {
    const scrollIntoView = vi.fn()
    HTMLElement.prototype.scrollIntoView = scrollIntoView
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'direct-codex',
        conversationType: 'direct',
        directAgentKind: 'codex',
        name: 'Codex review',
        topic: '',
        agentKinds: ['codex'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      state.messages.push(
        {
          id: 'root-1',
          groupId: 'direct-codex',
          role: 'user',
          content: 'First direct task',
          createdAt: '2026-07-29T08:01:00Z',
        },
        {
          id: 'agent-1',
          groupId: 'direct-codex',
          role: 'agent',
          agentKind: 'codex',
          content: 'First answer',
          createdAt: '2026-07-29T08:02:00Z',
        },
        {
          id: 'root-2',
          groupId: 'direct-codex',
          role: 'user',
          content: 'Latest direct task',
          createdAt: '2026-07-29T08:03:00Z',
        },
        {
          id: 'agent-2',
          groupId: 'direct-codex',
          role: 'agent',
          agentKind: 'codex',
          content: 'Latest answer',
          createdAt: '2026-07-29T08:04:00Z',
        },
      )
      state.runningGroupIds = ['direct-codex']
      state.runs = [{
        groupId: 'direct-codex',
        mode: 'manual',
        targetKinds: ['codex'],
        completedKinds: [],
        currentKind: 'codex',
        progress: [],
      }]
    })

    await wrapper.get('.direct-session-open').trigger('click')
    await flushPromises()

    const railButtons = wrapper.findAll('.turn-rail button')
    expect(railButtons).toHaveLength(2)
    expect(railButtons[0].attributes('aria-label')).toContain('First direct task')
    expect(railButtons[0].attributes('aria-label')).not.toContain('reply')
    expect(railButtons[0].attributes('aria-label')).toContain('Completed')
    expect(railButtons[0].get('.turn-rail-tooltip').text()).toBe(railButtons[0].attributes('aria-label'))
    expect(railButtons[1].attributes('data-status')).toBe('running')
    expect(railButtons[1].attributes('aria-current')).toBe('true')
    expect(wrapper.get('#message-agent-1').classes()).toContain('direct-message')
    expect(wrapper.get('#message-agent-1').classes()).not.toContain('topic-reply')
    expect(wrapper.find('.topic-toggle').exists()).toBe(false)
    expect(wrapper.findAll('.active-topic-label').every(label => label.text() === 'Current task')).toBe(true)
    expect(wrapper.get('.conversation-title-button').attributes()).toHaveProperty('disabled')
    expect(wrapper.find('.run-round-progress').exists()).toBe(false)

    scrollIntoView.mockClear()
    await railButtons[0].trigger('click')
    await flushPromises()

    expect(wrapper.get('#message-agent-1').text()).toContain('First answer')
    expect(scrollIntoView).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('copies message content while ignoring links and active text selections', async () => {
    const { wrapper } = await mountApp(({ state }) => {
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
          content: 'Review the selected text',
          createdAt: '2026-07-29T08:01:00Z',
        },
        {
          id: 'reply-1',
          groupId: 'group-1',
          role: 'agent',
          agentKind: 'codex',
          content: '[Open docs](https://example.com)\n\nCopy this answer.',
          threadRootId: 'root-1',
          createdAt: '2026-07-29T08:02:00Z',
        },
      )
    })
    const getSelection = vi.spyOn(window, 'getSelection')
    const writeText = navigator.clipboard.writeText

    await wrapper.get('.conversation-link').trigger('click')
    getSelection.mockReturnValue({ toString: () => 'selected text' })
    await wrapper.get('.message-row.user .message-copy-surface').trigger('click')
    expect(writeText).not.toHaveBeenCalled()

    getSelection.mockReturnValue({ toString: () => '' })
    const link = wrapper.get('.message-row.agent a')
    link.element.addEventListener('click', event => event.preventDefault(), { once: true })
    await link.trigger('click')
    expect(writeText).not.toHaveBeenCalled()

    await wrapper.get('.message-row.agent .message-copy-surface').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith('[Open docs](https://example.com)\n\nCopy this answer.')
    expect(wrapper.get('.message-row.agent').classes()).toContain('copied')
    expect(wrapper.get('.message-row.agent .message-copy-button').attributes('aria-label')).toBe('Copied')

    writeText.mockClear()
    await wrapper.get('.message-row.user .message-copy-button').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith('Review the selected text')

    const execCommand = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })
    writeText.mockRejectedValueOnce(new Error('Clipboard permission denied'))
    await wrapper.get('.message-row.agent .message-copy-surface').trigger('click')
    await flushPromises()
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(wrapper.find('.toast-message').exists()).toBe(false)
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
          targetKinds: ['codex'],
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
    expect(wrapper.get('.message-target-list').text()).toBe('Codex')
    expect(wrapper.get('.message-target-list').element.parentElement.className).toBe('user-message-flow')
    expect(wrapper.get('.plain-message').element.parentElement.className).toBe('user-message-flow')
    expect(wrapper.get('.message-row.agent').classes()).toContain('group-message')
    expect(wrapper.get('.message-row.agent').classes()).toContain('topic-reply')
    expect(wrapper.get('.topic-toggle').text()).toContain('1 reply')
    expect(wrapper.findAll('.topic-reply-avatars img')).toHaveLength(1)
    expect(wrapper.get('.topic-reply-avatars img').attributes('alt')).toBe('Codex')
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
      currentRound: 2,
      maxRounds: 6,
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
    expect(wrapper.get('.run-round-progress').text()).toBe('Round 2/6')
    expect(wrapper.findAll('.run-agent-row').map(row => row.attributes('data-status')))
      .toEqual(['completed', 'running', 'queued'])
    expect(wrapper.findAll('.run-agent-row').map(row => row.text()))
      .toEqual(['CodexCompleted', 'HermesRunning', 'Qwen CodeQueued'])
    const agentRows = wrapper.findAll('.run-agent-row')
    expect(agentRows[0].find('.run-agent-motion[data-status="completed"] svg').exists()).toBe(true)
    expect(agentRows[1].findAll('.run-agent-bars i')).toHaveLength(3)
    expect(agentRows[2].findAll('.run-agent-dots i')).toHaveLength(3)
    expect(wrapper.findAll('.execution-details')).toHaveLength(2)
    expect(wrapper.findAll('.execution-details').every(details => details.attributes('open') === undefined)).toBe(true)
    expect(wrapper.get('.run-progress-details').element.tagName).toBe('DIV')
    const runningStep = wrapper.findAll('.run-progress-details li')[1].get('small')
    expect(runningStep.text()).toBe('Running')
    expect(runningStep.classes()).toContain('running')

    await wrapper.findAll('.sidebar-footer-actions button')[0].trigger('click')
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
