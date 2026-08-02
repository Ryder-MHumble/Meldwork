import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../App.vue'
import { AGENTS } from '../../catalog.js'
import RunTracePanel from '../../components/RunTracePanel.vue'
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
  let runEvent = null
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
    stop: vi.fn(async () => true),
    pickDirectory: vi.fn(async () => '/tmp/roundrelay-workspace'),
    defaultDirectory: vi.fn(async () => '/tmp/roundrelay-workspace'),
    onChanged: vi.fn((callback) => {
      workspaceChanged = callback
      return vi.fn(() => {
        if (workspaceChanged === callback) workspaceChanged = null
      })
    }),
    onRunEvent: vi.fn((callback) => {
      runEvent = callback
      return vi.fn(() => {
        if (runEvent === callback) runEvent = null
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
    emitRunEvent(value) {
      runEvent?.(structuredClone(value))
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

  it('does not cover an existing workspace when the onboarding marker is missing', async () => {
    localStorage.removeItem('roundrelay-onboarding-seen-v1')
    const { wrapper, bridge } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'existing-group',
        name: 'Existing workspace',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
    })

    expect(wrapper.find('.onboarding-dialog').exists()).toBe(false)
    expect(localStorage.getItem('roundrelay-onboarding-seen-v1')).toBe('1')
    expect(bridge.localWorkspace.refreshAgents).toHaveBeenCalledTimes(1)
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
    expect(bridge.localAgentProvider.status).toHaveBeenCalledTimes((AGENTS.length * 2) - 1)
    expect(bridge.localAgentProvider.probe).toHaveBeenCalledTimes(1)
    expect(bridge.localAgentProvider.probe).toHaveBeenCalledWith('codex')
    expect(wrapper.get('.provider-summary-count').text()).toContain(`0 usable of ${AGENTS.length}`)
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
    expect(styles).toMatch(/\.provider-source-options\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);[^}]*gap:\s*6px;/s)
    expect(styles).toMatch(/\.provider-source-options button\s*\{[^}]*border:\s*0;[^}]*background:\s*color-mix/s)
    expect(styles).toMatch(/\.provider-profile-summary span,[\s\S]*\.provider-profile-summary code\s*\{[^}]*border:\s*0;/s)
    expect(styles).toMatch(/\.provider-settings-panel\s*\{[^}]*--provider-success:\s*#4f7564;/s)
    expect(styles).toMatch(/\.provider-external-fields\s*\{[^}]*"name model"[^}]*"url url"[^}]*"key key";/s)
    expect(styles).toMatch(/\.system-settings-body\s*\{[^}]*container-name:\s*settings-content;[^}]*container-type:\s*inline-size;/s)
    const narrowProviderRules = styles.slice(
      styles.indexOf('@container settings-content (max-width: 820px)'),
      styles.indexOf('@container settings-content (max-width: 600px)'),
    )
    expect(narrowProviderRules).toMatch(/\.provider-settings-panel\s*\{[^}]*grid-template-columns:\s*1fr;/s)
    expect(narrowProviderRules).toMatch(/\.provider-agent-list\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/s)
    expect(narrowProviderRules).toMatch(/\.provider-editor\s*\{[^}]*width:\s*100%;[^}]*overflow:\s*visible;/s)

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
      expect(wrapper.get('.provider-source-overview p').text()).toContain('official')
    }

    const officialInputs = wrapper.findAll('.provider-editor input')
    expect(officialInputs[0].attributes()).toHaveProperty('readonly')
    expect(officialInputs[1].attributes()).toHaveProperty('readonly')
    expect(officialInputs.every(input => !Object.hasOwn(input.attributes(), 'required'))).toBe(true)
    const apiKey = wrapper.get('.provider-editor input[type="password"]')
    await apiKey.setValue('secret-that-must-not-carry-over')
    await wrapper.findAll('.provider-source-options button')[1].trigger('click')
    expect(wrapper.get('.provider-editor input[type="password"]').element.value).toBe('')
    expect(wrapper.get('.provider-source-overview p').text()).toContain('OpenRouter')
    expect(wrapper.findAll('.provider-editor input')[0].attributes()).toHaveProperty('readonly')
    expect(wrapper.findAll('.provider-editor input')[1].attributes()).toHaveProperty('readonly')
    await wrapper.findAll('.provider-source-options button')[2].trigger('click')
    expect(wrapper.findAll('.provider-editor input')[0].attributes()).not.toHaveProperty('readonly')
    expect(wrapper.findAll('.provider-editor input')[1].attributes()).not.toHaveProperty('readonly')
    wrapper.unmount()
  })

  it('shows real Agent readiness without marking an unconfigured Official source active', async () => {
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
    const qwenStatus = {
      kind: 'qwen',
      provider: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'qwen/qwen3-coder',
      activePreset: 'openrouter',
      profiles: {
        openrouter: {
          provider: 'OpenRouter',
          baseUrl: 'https://openrouter.ai/api/v1',
          model: 'qwen/qwen3-coder',
          configured: true,
        },
      },
      configured: true,
      encryptionAvailable: true,
    }
    const { wrapper } = await mountApp(({ state, bridge }) => {
      state.agents = [
        {
          kind: 'codex', installed: true, available: false, credentialState: 'unknown',
          availabilitySource: 'unverified', version: '1.0.0',
        },
        {
          kind: 'hermes', installed: true, available: false, credentialState: 'missing',
          availabilitySource: 'native-auth-status', version: '1.0.0',
        },
        {
          kind: 'kimi', installed: true, available: true, credentialState: 'ready',
          availabilitySource: 'native-credential', version: '1.0.0',
        },
        {
          kind: 'qwen', installed: true, available: true, credentialState: 'ready',
          availabilitySource: 'shared-provider', version: '1.0.0',
        },
      ]
      bridge.agentInstaller.catalog.mockResolvedValue({
        platform: 'darwin',
        agents: AGENTS.map(agent => ({
          kind: agent.kind,
          installed: agent.kind !== 'gemini',
          installSupported: true,
        })),
      })
      bridge.localAgentProvider.status.mockImplementation(async kind => (
        kind === 'qwen' ? qwenStatus : emptyStatus(kind)
      ))
      bridge.localAgentProvider.probe.mockImplementation(bridge.localAgentProvider.status)
    })

    await wrapper.get('.sidebar-settings-entry').trigger('click')
    await wrapper.findAll('.settings-tabs button')[1].trigger('click')
    await flushPromises()
    const providerButton = label => wrapper.findAll('.provider-agent-list button')
      .find(button => button.text().includes(label))

    expect(providerButton('Gemini CLI').text()).toContain('Not installed')
    expect(providerButton('Hermes').text()).toContain('Sign-in required')
    expect(providerButton('Codex').text()).toContain('Sign-in not verified')
    expect(providerButton('Kimi Code').text()).toContain('Native configuration active')
    expect(providerButton('Qwen Code').text()).toContain('OpenRouter override active')

    await providerButton('Gemini CLI').trigger('click')
    await flushPromises()
    const officialSource = wrapper.findAll('.provider-source-options button')[0]
    expect(officialSource.text()).toContain('Not installed')
    expect(officialSource.text()).not.toContain('Active')
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
    expect(codexProvider.text()).toContain('Native configuration active')
    expect(codexProvider.find('svg.ready').exists()).toBe(true)
    expect(wrapper.get('.provider-agent-state').text()).toContain('Native configuration active')
    expect(wrapper.get('.provider-native-card').text()).toContain('Agent CLI configuration')
    expect(wrapper.get('.provider-doc-card').text()).toContain('~/.codex/config.toml')
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
    expect(wrapper.get('.provider-agent-state').text()).toContain('Checking')
    expect(wrapper.find('.provider-inline-warning').exists()).toBe(false)

    kimiStatus.reject(Object.assign(new Error('Provider status unavailable'), {
      code: 'PROVIDER_STATUS_UNAVAILABLE',
    }))
    await flushPromises()

    expect(kimiProvider.text()).toContain('Status unavailable')
    expect(kimiProvider.text()).not.toContain('Native configuration active')
    expect(kimiProvider.find('svg.ready').exists()).toBe(false)
    expect(wrapper.get('.provider-editor').attributes('aria-busy')).toBe('false')
    expect(wrapper.get('.provider-inline-warning').text()).toContain('Status unavailable')
    expect(wrapper.get('.provider-inline-warning button').text()).toContain('Retry')

    bridge.localAgentProvider.probe.mockResolvedValue(emptyStatus('kimi'))
    await wrapper.get('.provider-inline-warning button').trigger('click')
    await flushPromises()
    expect(bridge.localAgentProvider.probe).toHaveBeenLastCalledWith('kimi')
    expect(wrapper.get('.provider-agent-state').text()).toContain('Native configuration active')
    expect(wrapper.get('.provider-native-card').text()).toContain('No Provider key is stored')
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
    expect(codexProvider.text()).toContain('Native configuration active')
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
    expect(wrapper.get('.provider-activate-button').text()).toContain('Use this configuration')

    await wrapper.get('.provider-activate-button').trigger('click')
    await flushPromises()
    expect(bridge.localAgentProvider.activate).toHaveBeenCalledWith('hermes', 'custom')
    expect(wrapper.get('.provider-agent-state').text()).toContain('Custom override active')
    wrapper.unmount()
  })

  it('ignores an older Provider status result after a newer probe completes', async () => {
    const staleHermesStatus = deferred()
    let hermesStatusCalls = 0
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
    const configuredHermesStatus = {
      kind: 'hermes',
      provider: 'Private gateway',
      baseUrl: 'https://gateway.example/v1',
      model: 'private-model',
      activePreset: 'custom',
      profiles: {
        custom: {
          provider: 'Private gateway',
          baseUrl: 'https://gateway.example/v1',
          model: 'private-model',
          configured: true,
        },
      },
      configured: true,
      encryptionAvailable: true,
    }
    const { wrapper } = await mountApp(({ bridge }) => {
      bridge.localAgentProvider.status.mockImplementation((kind) => {
        if (kind === 'hermes') {
          hermesStatusCalls += 1
          if (hermesStatusCalls === 2) return staleHermesStatus.promise
        }
        return Promise.resolve(emptyStatus(kind))
      })
      bridge.localAgentProvider.probe.mockImplementation(kind => (
        kind === 'hermes'
          ? Promise.resolve(configuredHermesStatus)
          : Promise.resolve(emptyStatus(kind))
      ))
    })

    await wrapper.get('.sidebar-settings-entry').trigger('click')
    await wrapper.findAll('.settings-tabs button')[1].trigger('click')
    const hermesProvider = wrapper.findAll('.provider-agent-list button')
      .find(button => button.text().includes('Hermes'))
    await hermesProvider.trigger('click')
    await flushPromises()
    expect(wrapper.get('.provider-agent-list button.active').text()).toContain('Hermes')
    expect(wrapper.get('.provider-agent-state').text()).toContain('Custom override active')
    expect(wrapper.get('.provider-profile-summary').text()).toContain('Private gateway')

    staleHermesStatus.resolve(emptyStatus('hermes'))
    await flushPromises()
    expect(wrapper.get('.provider-agent-list button.active').text()).toContain('Hermes')
    expect(wrapper.get('.provider-agent-state').text()).toContain('Custom override active')
    expect(wrapper.get('.provider-profile-summary').text()).toContain('Private gateway')
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
    expect(wrapper.get('.provider-agent-state').text()).toContain('Custom override active')
    expect(wrapper.get('.provider-profile-summary').text()).toContain('Local gateway')
    wrapper.unmount()
  })

  it('shows local knowledge sources and can pick an Obsidian vault', async () => {
    const styles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    expect(styles).toMatch(/\.knowledge-base-toolbar\s*\{/s)
    expect(styles).toMatch(/\.knowledge-base-list,\s*\.knowledge-base-future-list\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/s)
    expect(styles).toMatch(/\.knowledge-base-item\s*,\s*\.knowledge-base-future-item\s*\{[^}]*border:\s*0;[^}]*background:\s*color-mix/s)
    expect(styles).toMatch(/\.knowledge-base-item-main\s*\{[^}]*grid-template-columns:\s*48px minmax\(0, 1fr\);/s)
    expect(styles).toMatch(/\.knowledge-base-tag-row\s*\{[^}]*flex-wrap:\s*wrap;/s)
    expect(styles).toMatch(/\.knowledge-base-tag\s*\{[^}]*border-radius:\s*4px;/s)
    expect(styles).toMatch(/\.knowledge-base-future-item\s*\{[^}]*pointer-events:\s*none;/s)
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
    expect(panelText).toContain('Feishu Docs')
    expect(panelText).toContain('DingTalk Docs')
    expect(panelText).toContain('Obsidian')
    expect(panelText).toContain('Notion')
    expect(panelText).toContain('Confluence')
    expect(panelText).toContain('Google Drive')
    expect(panelText).toContain('SharePoint')
    expect(panelText).not.toContain('Knowledge bases')
    expect(panelText).not.toContain('Connect local document sources')

    const sourceGroups = wrapper.findAll('.knowledge-base-group')
    expect(sourceGroups).toHaveLength(2)
    expect(sourceGroups[0].get('h3').text()).toBe('Local connections')
    expect(sourceGroups[0].findAll('.knowledge-base-item')).toHaveLength(3)
    expect(sourceGroups[1].get('h3').text()).toBe('Coming soon')
    expect(sourceGroups[1].findAll('.knowledge-base-future-item')).toHaveLength(4)
    expect(wrapper.get('.knowledge-base-ready-summary').text()).toContain('1 ready, 3 total')
    expect(wrapper.get('.knowledge-base-panel').attributes('aria-busy')).toBe('false')
    expect(wrapper.get('.knowledge-base-ready-summary').attributes('role')).toBe('status')

    for (const label of ['Notion', 'Confluence', 'Google Drive', 'SharePoint']) {
      const plannedItem = wrapper.findAll('.knowledge-base-future-item')
        .find(item => item.text().includes(label))
      expect(plannedItem.get('.knowledge-base-status').text()).toContain('Coming soon')
      expect(plannedItem.attributes('aria-disabled')).toBe('true')
      expect(plannedItem.get('.knowledge-base-action').text()).toContain('Coming soon')
      expect(plannedItem.get('.knowledge-base-action').attributes()).toHaveProperty('disabled')
      expect(plannedItem.text()).not.toContain('Not configured')
    }

    const notionItem = wrapper.findAll('.knowledge-base-future-item')
      .find(item => item.text().includes('Notion'))
    await notionItem.get('.knowledge-base-action').trigger('click')
    await flushPromises()
    expect(bridge.localKnowledgeBase.openGuide).not.toHaveBeenCalled()

    const obsidianItem = wrapper.findAll('.knowledge-base-item')
      .find(item => item.text().includes('Obsidian'))
    expect(obsidianItem.exists()).toBe(true)
    expect(obsidianItem.text()).toContain('Vault not selected')
    await obsidianItem.get('.knowledge-base-action').trigger('click')
    await flushPromises()

    expect(bridge.localKnowledgeBase.pickObsidianVault).toHaveBeenCalledTimes(1)
    expect(wrapper.findAll('.knowledge-base-item').at(2).text()).toContain('/Users/rydersun/Documents/Knowledge')
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
      const card = wrapper.findAll('.knowledge-base-item')
        .find(item => item.text().includes(label))
      expect(card.get('.knowledge-base-status').text()).toContain('Ready')
      const tags = card.findAll('.knowledge-base-tag')
      expect(tags).toHaveLength(1)
      expect(tags[0].text()).toContain('Official CLI')
      expect(card.text()).not.toContain('Read enabled')
      expect(card.text()).not.toContain('Write not verified')
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

    const localItems = wrapper.findAll('.knowledge-base-item')
    expect(localItems).toHaveLength(3)
    for (const item of localItems) {
      expect(item.get('.knowledge-base-status').text()).toContain('Checking')
      const tags = item.findAll('.knowledge-base-tag')
      expect(tags).toHaveLength(1)
      expect(item.get('.knowledge-base-action').text()).toContain('Checking')
      expect(item.get('.knowledge-base-action').attributes()).toHaveProperty('disabled')
      expect(item.text()).not.toMatch(/CLI not installed|CLI missing|Obsidian not installed|App missing|Vault not selected/)
    }
    expect(wrapper.get('.knowledge-base-panel').attributes('aria-busy')).toBe('true')
    expect(wrapper.get('.knowledge-base-ready-summary').text()).toBe('Checking')

    const plannedItems = wrapper.findAll('.knowledge-base-future-item')
    expect(plannedItems).toHaveLength(4)
    for (const item of plannedItems) {
      expect(item.get('.knowledge-base-status').text()).toContain('Coming soon')
      expect(item.get('.knowledge-base-action').text()).toContain('Coming soon')
      expect(item.get('.knowledge-base-action').attributes()).toHaveProperty('disabled')
    }

    statusResult.resolve([])
    await flushPromises()

    expect(wrapper.get('.knowledge-base-panel').attributes('aria-busy')).toBe('false')
    expect(wrapper.get('.knowledge-base-ready-summary').text()).toContain('0 ready, 3 total')
    const unknownItems = wrapper.findAll('.knowledge-base-item')
    for (const item of unknownItems) {
      expect(item.get('.knowledge-base-status').text()).toContain('Could not verify')
      expect(item.findAll('.knowledge-base-tag')).toHaveLength(1)
      expect(item.text()).not.toContain('Read not verified')
      expect(item.text()).not.toContain('Write not verified')
      expect(item.get('.knowledge-base-action').text()).toContain('Recheck')
      expect(item.get('.knowledge-base-action').attributes()).not.toHaveProperty('disabled')
      expect(item.text()).not.toMatch(/CLI not installed|CLI missing|Obsidian not installed|App missing|Vault not selected/)
    }

    await unknownItems[0].get('.knowledge-base-action').trigger('click')
    await flushPromises()
    expect(bridge.localKnowledgeBase.status).toHaveBeenCalledTimes(2)
    expect(bridge.localKnowledgeBase.status).toHaveBeenLastCalledWith('feishu')
    expect(wrapper.findAll('.knowledge-base-item')[0].get('.knowledge-base-status').text()).toContain('Could not verify')
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

    const feishuCard = wrapper.findAll('.knowledge-base-item')
      .find(card => card.text().includes('Feishu Docs'))
    expect(feishuCard.exists()).toBe(true)
    expect(feishuCard.get('.knowledge-base-status').text()).toContain('Detection failed')
    expect(feishuCard.text()).not.toContain('CLI not installed')
    expect(feishuCard.text()).not.toContain('CLI missing')
    wrapper.unmount()
  })

  it('shows the workspace home, keeps full Agent management in Settings, and switches language and theme', async () => {
    const { wrapper } = await mountApp()

    expect(wrapper.get('.home-dashboard').attributes('data-home-mode')).toBe('first-task')
    expect(wrapper.get('.home-dashboard-header h1').text()).toBe('Meldwork workspace')
    expect(wrapper.get('.home-workspace-state').text()).toContain('2 Agents ready')
    expect(wrapper.get('.home-panel-header h2').text()).toBe('Start your first task')
    expect(wrapper.findAll('.home-panel-header h2')[1].text()).toBe('Start a new task')
    expect(wrapper.get('.home-recent-panel .primary-button').text()).toContain('New group')
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

  it('uses the Meldwork wordmark and automatically rotates empty copy in direct and group chats', async () => {
    vi.useFakeTimers()
    setLocale('zh')
    const styles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    expect(styles).not.toContain('.conversation-empty-refresh')
    expect(styles).toMatch(/\.empty-showcase-enter-active,\s*\.empty-showcase-leave-active\s*\{[^}]*transition:\s*opacity 0\.16s ease,\s*transform 0\.16s ease;/s)
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push(
        {
          id: 'direct-empty-codex',
          conversationType: 'direct',
          directAgentKind: 'codex',
          name: 'Codex',
          topic: '',
          agentKinds: ['codex'],
          workdir: '/tmp/roundrelay-workspace',
          allowWrite: true,
          createdAt: '2026-07-29T08:00:00Z',
          updatedAt: '2026-07-29T08:00:00Z',
        },
        {
          id: 'group-empty',
          conversationType: 'group',
          name: 'Agent review',
          topic: '',
          agentKinds: ['codex', 'hermes'],
          workdir: '/tmp/roundrelay-workspace',
          allowWrite: false,
          createdAt: '2026-07-29T09:00:00Z',
          updatedAt: '2026-07-29T09:00:00Z',
        },
      )
    })

    await wrapper.get('.direct-session-open').trigger('click')
    expect(wrapper.get('.conversation-empty-wordmark').attributes('src')).toBe('./logos/meldwork-wordmark-v3.svg')
    expect(wrapper.find('.empty-icon').exists()).toBe(false)
    expect(wrapper.find('.conversation-empty-refresh').exists()).toBe(false)
    expect(wrapper.get('.conversation-empty').text()).not.toContain('开始对话')
    expect(wrapper.get('.conversation-empty').text()).not.toContain('给 Codex 发送一个任务')
    expect(wrapper.get('.conversation-empty-copy').text()).toContain('先从一个 Agent 开始')
    expect(wrapper.get('.conversation-empty-copy').text()).not.toMatch(/[。.]$/)

    await vi.advanceTimersByTimeAsync(2_800)
    await flushPromises()
    expect(wrapper.get('.conversation-empty-copy').text()).toContain('再把 Agent 们叫到一起')

    await wrapper.findAll('.sidebar-footer-actions button')[1].trigger('click')
    expect(wrapper.get('.conversation-empty-wordmark').attributes('src')).toBe('./logos/meldwork-wordmark-v3-dark.svg')

    await wrapper.get('.conversation-link').trigger('click')
    expect(wrapper.get('.conversation-empty-wordmark').attributes('src')).toBe('./logos/meldwork-wordmark-v3-dark.svg')
    expect(wrapper.get('.conversation-empty').text()).not.toContain('先发送讨论主题')
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

    expect(wrapper.get('.home-dashboard').attributes('data-home-mode')).toBe('setup')
    expect(wrapper.get('.home-workspace-state').classes()).toContain('attention')
    expect(wrapper.get('.home-workspace-state').text()).toContain('needs attention')
    expect(wrapper.get('.setup-guide').exists()).toBe(true)
    expect(wrapper.find('.home-dashboard-grid').exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps conversation history visible when local Agents need recovery', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      state.agents = state.agents.map(agent => ({
        ...agent,
        available: false,
        credentialState: 'missing',
      }))
      state.groups.push({
        id: 'group-recovery',
        conversationType: 'group',
        name: 'Recovery history',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
    })

    expect(wrapper.get('.home-dashboard').attributes('data-home-mode')).toBe('workspace')
    expect(wrapper.get('.home-workspace-state').classes()).toContain('attention')
    expect(wrapper.get('.home-recovery-notice').text()).toContain('conversation history is still available')
    expect(wrapper.get('.home-recent-item').text()).toContain('Recovery history')
    expect(wrapper.find('.setup-guide').exists()).toBe(false)

    await wrapper.get('.home-recovery-notice button').trigger('click')
    expect(wrapper.get('.system-settings-page').exists()).toBe(true)
    expect(wrapper.get('.sidebar-settings-entry').attributes('aria-current')).toBe('page')
    wrapper.unmount()
  })

  it('keeps exactly one current navigation target across conversations, home, and Settings', async () => {
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
    expect(wrapper.get('.conversation-link').attributes('aria-current')).toBe('page')
    expect(wrapper.get('.group-conversation-row').classes()).toContain('active')
    expect(wrapper.get('.brand-button').attributes()).not.toHaveProperty('aria-current')
    expect(wrapper.get('.sidebar-settings-entry').attributes()).not.toHaveProperty('aria-current')

    await wrapper.get('.brand-button').trigger('click')
    expect(wrapper.find('.home-dashboard').exists()).toBe(true)
    expect(wrapper.find('.conversation-pane').exists()).toBe(false)
    expect(wrapper.get('.brand-button').attributes('aria-current')).toBe('page')
    expect(wrapper.get('.conversation-link').attributes()).not.toHaveProperty('aria-current')
    expect(wrapper.get('.group-conversation-row').classes()).not.toContain('active')

    await wrapper.get('.sidebar-settings-entry').trigger('click')
    expect(wrapper.find('.system-settings-page').exists()).toBe(true)
    expect(wrapper.get('.sidebar-settings-entry').attributes('aria-current')).toBe('page')
    expect(wrapper.get('.brand-button').attributes()).not.toHaveProperty('aria-current')
    expect(wrapper.get('.conversation-link').attributes()).not.toHaveProperty('aria-current')
    expect(wrapper.get('.group-conversation-row').classes()).not.toContain('active')

    await wrapper.get('.brand-button').trigger('click')
    expect(wrapper.find('.home-dashboard').exists()).toBe(true)
    expect(wrapper.find('.system-settings-page').exists()).toBe(false)
    wrapper.unmount()
  })

  it('returns explicitly to home when the current conversation disappears', async () => {
    const { wrapper, state, emitWorkspaceChanged } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-removed-externally',
        conversationType: 'group',
        name: 'External removal',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
    })

    await wrapper.get('.conversation-link').trigger('click')
    expect(wrapper.get('.conversation-pane').exists()).toBe(true)

    state.groups = []
    emitWorkspaceChanged(state)
    await flushPromises()

    expect(wrapper.get('.home-dashboard').exists()).toBe(true)
    expect(wrapper.get('.home-dashboard').attributes('data-home-mode')).toBe('first-task')
    expect(wrapper.get('.brand-button').attributes('aria-current')).toBe('page')
    wrapper.unmount()
  })

  it('preserves unsent attachments while opening home and Settings', async () => {
    const { wrapper, bridge } = await mountApp(({ state, bridge: desktopBridge }) => {
      state.groups.push({
        id: 'group-preserved-draft',
        conversationType: 'group',
        name: 'Preserved draft',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      desktopBridge.localAttachments.pickImages.mockResolvedValueOnce({
        attachments: [imageAttachment('preserved-draft')],
      })
    })

    const conversationLink = wrapper.get('.conversation-link')
    await conversationLink.trigger('click')
    await wrapper.get('[aria-label="Attach images"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('.composer-attachment').exists()).toBe(true)

    await wrapper.get('.brand-button').trigger('click')
    expect(wrapper.get('.home-dashboard').exists()).toBe(true)
    expect(bridge.localAttachments.discard).not.toHaveBeenCalled()

    await conversationLink.trigger('click')
    expect(wrapper.get('.composer-attachment').exists()).toBe(true)
    await wrapper.get('.sidebar-settings-entry').trigger('click')
    expect(wrapper.get('.system-settings-page').exists()).toBe(true)
    expect(bridge.localAttachments.discard).not.toHaveBeenCalled()

    await conversationLink.trigger('click')
    expect(wrapper.get('.composer-attachment').exists()).toBe(true)
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
    expect(source).toMatch(/\.skill-option\.agent-mention-option \.skill-option-copy small,[^{]+\.skill-option\.knowledge-base-mention-option \.skill-option-copy small\s*\{[^}]*-webkit-line-clamp:\s*2;/s)
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
    expect(source).toMatch(/\.agent-version\s*\{[^}]*max-width:\s*min\(20ch, 40%\);/s)
    expect(source).toMatch(/\.agent-card-meta-row\s*\{[^}]*display:\s*flex;[^}]*padding:\s*0 16px 14px 77px;/s)
    expect(source).toMatch(/\.settings-agent-actions\s*\{[^}]*flex-wrap:\s*nowrap;[^}]*padding:\s*0;/s)
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
    expect(source).toMatch(/\.turn-rail button > span:first-child\s*\{[^}]*width:\s*var\(--turn-width\);[^}]*height:\s*var\(--turn-height\);[^}]*border:\s*0;[^}]*border-radius:\s*999px;/s)
    expect(source).toMatch(/\.turn-rail button > span:first-child\s*\{[^}]*transform:\s*translateX\(var\(--turn-offset\)\) scaleX\(var\(--turn-scale\)\);/s)
    expect(source).not.toMatch(/\.turn-rail button > span:first-child\s*\{[^}]*border-radius:\s*50%;/s)
    expect(source).not.toMatch(/\.turn-rail button > span:first-child\s*\{[^}]*box-shadow:\s*0 0 0 1px/s)
    expect(source).toMatch(/\.turn-rail-tooltip\s*\{[^}]*border:\s*0;[^}]*border-radius:\s*11px 11px 11px 5px;/s)
    expect(source).toMatch(/\.turn-rail-tooltip::before\s*\{[^}]*clip-path:\s*polygon\(100% 0, 0 50%, 100% 100%\);/s)
    expect(source).not.toContain('.turn-rail::before')
    expect(source).toMatch(/\.message-row\.topic-reply\s*\{[^}]*border-left:\s*0;/s)
    expect(source).toMatch(/\.message-row\.group-message\.agent \.message-body::before\s*\{[^}]*background:\s*var\(--agent-accent\);/s)
    expect(source).toMatch(/\.message-copy-surface\s*\{[^}]*cursor:\s*text;/s)
    expect(source).toMatch(/\.run-status-panel\.group\s*\{[^}]*border-left:\s*0;/s)
    expect(source).toMatch(/\.run-status-panel\s*\{[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/s)
    expect(source).toMatch(/\.run-status-panel\.solo\s*\{[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/s)
    expect(source).toMatch(/\.run-status-panel\.solo \.run-progress-details\s*\{[^}]*border-top:\s*0;/s)
    expect(source).toMatch(/\.run-agent-logo\[data-status="running"\]::before\s*\{[^}]*background:\s*color-mix/s)
    expect(source).not.toContain('@keyframes run-agent-halo')
    expect(source).toMatch(/\.run-agent-logo\[data-status="queued"\] img,[^{]+\.run-agent-logo\[data-status="not-started"\] img\s*\{[^}]*opacity:\s*0\.38;/s)
    expect(source).toMatch(/\.run-trace-panel\s*\{[^}]*border-left:\s*0;/s)
    expect(source).toMatch(/\.trace-conclusion\s*\{[^}]*border-left:\s*0;/s)
    expect(source).toMatch(/\.trace-event-list details\s*\{[^}]*border:\s*0;/s)
    expect(source).toMatch(/\.trace-source-list button\s*\{[^}]*border:\s*0;/s)
    expect(source).toMatch(/\.composer-box\s*\{[^}]*border:\s*0;/s)
    expect(source).toMatch(/\.composer-context-row\s*\{[^}]*border-bottom:\s*0;/s)
    expect(source).toMatch(/\.send-button,\s*\.stop-button\s*\{[^}]*border:\s*0;/s)
    expect(source).toMatch(/\.send-button,\s*\.stop-button\s*\{[^}]*border-radius:\s*var\(--radius\);/s)
    expect(source).toMatch(/body\.trace-drawer-open\s*\{[^}]*overflow:\s*hidden;/s)
    expect(source).toMatch(/@media \(max-width: 1179px\)\s*\{[^}]*\.app-shell\.trace-panel-open,[^{]+\{[^}]*grid-template-columns:\s*var\(--sidebar-width\) minmax\(0, 1fr\);/s)
    expect(source).not.toContain('.stop-button-motion')
    expect(appSource).toContain('<SendOutline v-else aria-hidden="true" />')
    expect(appSource).toContain('<StopCircleOutline aria-hidden="true" />')
    expect(appSource).not.toContain('<PlayOutline')
    expect(appSource).not.toContain('<ArrowUpOutline')
  })

  it('merges live run events into the trace panel and closes it with Escape or browser back', async () => {
    const pushState = vi.spyOn(history, 'pushState')
    const back = vi.spyOn(history, 'back').mockImplementation(() => {})
    const { wrapper, emitRunEvent } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-1',
        conversationType: 'group',
        name: 'Trace review',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      state.messages.push({
        id: 'root-1',
        groupId: 'group-1',
        role: 'user',
        content: 'Inspect the implementation',
        targetKinds: ['codex', 'hermes'],
        createdAt: '2026-07-29T08:01:00Z',
      })
      state.runningGroupIds = ['group-1']
      state.runs = [{
        runId: 'run-1',
        groupId: 'group-1',
        threadRootId: 'root-1',
        phase: 'running',
        mode: 'auto',
        targetKinds: ['codex', 'hermes'],
        completedKinds: [],
        failedKinds: [],
        currentKind: 'codex',
        currentRound: 1,
        maxRounds: 4,
        progress: [],
        agentRuns: [{
          agentRunId: 'agent-run-codex',
          kind: 'codex',
          round: 1,
          status: 'running',
          output: '',
          events: [],
          sourceMessageIds: ['root-1', 'missing-source'],
          seenSeqs: [],
        }],
      }]
    })

    await wrapper.get('.conversation-link').trigger('click')
    await wrapper.get('.run-agent-row:not([disabled])').trigger('click')
    await flushPromises()

    expect(wrapper.get('.run-trace-panel').exists()).toBe(true)
    expect(pushState).toHaveBeenCalledWith({ roundrelayTracePanel: true }, '', window.location.href)

    emitRunEvent({
      runId: 'run-1',
      agentRunId: 'agent-run-codex',
      groupId: 'group-1',
      threadRootId: 'root-1',
      agentKind: 'codex',
      round: 1,
      seq: 1,
      type: 'reasoning_summary',
      status: 'running',
      title: 'Reviewing files',
      summary: 'Checking the sidebar implementation.',
      detail: 'Matched two files under [path].',
      command: 'cat /Users/private/secret.txt',
      secret: 'PRIVATE_TOKEN_VALUE',
      timestamp: '2026-07-29T08:02:00Z',
    })
    await flushPromises()

    expect(wrapper.get('.trace-event-list').text()).toContain('Reviewing files')
    expect(wrapper.get('.trace-event-list').text()).toContain('Running')
    const eventDetails = wrapper.get('.trace-event-list details')
    expect(eventDetails.element.open).toBe(false)
    eventDetails.element.open = true
    await eventDetails.trigger('toggle')
    expect(eventDetails.element.open).toBe(true)
    expect(wrapper.get('.trace-event-body').text()).toContain('Checking the sidebar implementation.')
    expect(wrapper.get('.trace-event-body').text()).toContain('Matched two files under [path].')
    expect(wrapper.get('.run-trace-panel').text()).not.toContain('/Users/private/secret.txt')
    expect(wrapper.get('.run-trace-panel').text()).not.toContain('PRIVATE_TOKEN_VALUE')
    expect(wrapper.get('.trace-event-time').text()).not.toBe('2026-07-29T08:02:00Z')
    expect(wrapper.get('.trace-event-live-status').text()).toBe('Codex / Reasoning summary / Reviewing files / Running')
    expect(wrapper.get('.trace-panel-summary').attributes('aria-live')).toBeUndefined()
    expect(wrapper.get('.trace-source-section .trace-section-heading strong').text()).toBe('Context used')
    const sourceButtons = wrapper.findAll('.trace-source-list button')
    expect(sourceButtons).toHaveLength(2)
    expect(sourceButtons[0].text()).toContain('You: Inspect the implementation')
    expect(sourceButtons[0].text()).not.toContain('root-1')
    expect(sourceButtons[0].attributes('disabled')).toBeUndefined()
    expect(sourceButtons[1].text()).toContain('Source unavailable')
    expect(sourceButtons[1].attributes()).toHaveProperty('disabled')
    const scrollIntoView = vi.fn()
    wrapper.get('#message-root-1').element.scrollIntoView = scrollIntoView
    await sourceButtons[0].trigger('click')
    await flushPromises()
    expect(scrollIntoView).toHaveBeenCalledTimes(1)

    emitRunEvent({
      runId: 'run-1',
      agentRunId: 'agent-run-codex',
      groupId: 'group-1',
      threadRootId: 'root-1',
      agentKind: 'codex',
      round: 1,
      seq: 2,
      type: 'tool_start',
      status: 'running',
      title: 'Read source',
      timestamp: '2026-07-29T08:03:00Z',
    })
    emitRunEvent({
      runId: 'run-1',
      agentRunId: 'agent-run-codex',
      groupId: 'group-1',
      threadRootId: 'root-1',
      agentKind: 'codex',
      round: 1,
      seq: 3,
      type: 'status',
      status: 'running',
      title: 'Agent',
      timestamp: '2026-07-29T08:04:00Z',
    })
    emitRunEvent({
      runId: 'run-1',
      agentRunId: 'agent-run-codex',
      groupId: 'group-1',
      threadRootId: 'root-1',
      agentKind: 'codex',
      round: 1,
      seq: 4,
      type: 'status',
      status: 'running',
      title: 'Process',
      timestamp: '2026-07-29T08:05:00Z',
    })
    emitRunEvent({
      runId: 'run-1',
      agentRunId: 'agent-run-codex',
      groupId: 'group-1',
      threadRootId: 'root-1',
      agentKind: 'codex',
      round: 1,
      seq: 5,
      type: 'warning',
      status: 'partial',
      title: 'connector_limited',
      timestamp: '2026-07-29T08:06:00Z',
    })
    await flushPromises()
    expect(wrapper.findAll('.trace-event-title').at(-1).text())
      .toBe('Connector provided only the final answer; structured tool activity was unavailable.')

    emitRunEvent({
      runId: 'run-1',
      agentRunId: 'agent-run-codex',
      groupId: 'group-1',
      threadRootId: 'root-1',
      agentKind: 'codex',
      round: 1,
      seq: 6,
      type: 'warning',
      status: 'waiting',
      title: 'connector_fallback',
      timestamp: '2026-07-29T08:07:00Z',
    })
    await flushPromises()
    expect(wrapper.findAll('.trace-event-title').at(-1).text())
      .toBe('Structured connector failed before execution; switched to compatibility mode.')
    expect(wrapper.findAll('.trace-event-type').map(item => item.text()))
      .toEqual(['Reasoning summary', 'Tool call', 'Warning', 'Warning'])
    const visibleEventTitles = wrapper.findAll('.trace-event-title').map(item => item.text())
    expect(visibleEventTitles).not.toContain('Agent')
    expect(visibleEventTitles).not.toContain('Process')

    setLocale('zh')
    await flushPromises()
    const localizedEventTitles = wrapper.findAll('.trace-event-title').map(item => item.text())
    expect(localizedEventTitles).toContain('连接器只提供最终答案，未暴露结构化工具过程。')
    expect(localizedEventTitles).toContain('结构化连接失败，已在提交任务前切换兼容模式。')
    expect(wrapper.get('.trace-source-section .trace-section-heading strong').text()).toBe('本次使用的上下文')
    expect(wrapper.findAll('.trace-source-list button')[1].text()).toContain('来源不可用')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(wrapper.find('.run-trace-panel').exists()).toBe(false)
    expect(back).toHaveBeenCalledTimes(1)

    await wrapper.get('.run-agent-row:not([disabled])').trigger('click')
    await flushPromises()
    window.dispatchEvent(new PopStateEvent('popstate'))
    await flushPromises()
    expect(wrapper.find('.run-trace-panel').exists()).toBe(false)
    expect(back).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('traps keyboard focus inside the responsive trace drawer', async () => {
    const wrapper = mount(RunTracePanel, {
      attachTo: document.body,
      props: {
        open: true,
        drawer: true,
        items: [{
          agentRunId: 'agent-run-codex',
          agentKind: 'codex',
          round: 1,
          status: 'running',
          output: '',
          summary: '',
          events: [],
          sourceMessageIds: [],
          context: {},
        }],
        selectedAgentRunId: 'agent-run-codex',
      },
    })
    const buttons = wrapper.findAll('.run-trace-panel button')
    const first = buttons[0].element
    const last = buttons.at(-1).element

    last.focus()
    await wrapper.get('.run-trace-panel').trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(first)

    first.focus()
    await wrapper.get('.run-trace-panel').trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
    wrapper.unmount()
  })

  it('saves the exact Provider payload exposed by preload', async () => {
    const { wrapper, bridge } = await mountApp()

    await wrapper.get('.sidebar-settings-entry').trigger('click')
    await wrapper.findAll('.settings-tabs button')[1].trigger('click')
    await wrapper.findAll('.provider-agent-list button')
      .find(button => button.text().includes('Hermes'))
      .trigger('click')
    await flushPromises()
    expect(wrapper.get('.provider-editor .primary-button').text()).toContain('Save and use')
    await wrapper.findAll('.provider-source-options button')[2].trigger('click')
    const inputs = wrapper.findAll('.provider-editor input')
    await inputs[0].setValue('Local gateway')
    await inputs[1].setValue('https://gateway.example/v1')
    await inputs[2].setValue('roundrelay-model')
    await inputs[3].setValue('secret-key')
    await wrapper.get('form.provider-editor').trigger('submit')
    await flushPromises()

    expect(bridge.localAgentProvider.save).toHaveBeenCalledWith('hermes', {
      preset: 'custom',
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
      knowledgeBaseHints: [],
      attachments: [],
      mode: 'auto',
      maxRounds: 6,
    })
    expect(bridge.localWorkspace.startAuto).toBeUndefined()
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
      knowledgeBaseHints: [],
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

  it('keeps the inline title editor focused without an outer accent ring', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')

    expect(source).toMatch(/\.inline-title-form input\s*\{[^}]*border:\s*1px solid transparent;[^}]*outline:\s*none;[^}]*box-shadow:\s*inset 0 -1px 0 var\(--border-strong\);/s)
    expect(source).toMatch(/\.inline-title-form input:focus-visible\s*\{[^}]*outline:\s*none;[^}]*box-shadow:\s*inset 0 -2px 0 var\(--accent\);/s)
    expect(source).toMatch(/\.inline-title-form input::selection\s*\{[^}]*var\(--accent\) 28%/s)
  })

  it('sends one mentioned Agent as a manual reply while the group defaults to automatic mode', async () => {
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
    expect(wrapper.get('.mode-segmented [data-mode="auto"]').classes()).toContain('active')
    expect(wrapper.get('.mode-segmented [data-mode="auto"]').attributes()).not.toHaveProperty('disabled')
    expect(wrapper.get('.send-button').text()).toBe('Send')

    expect(bridge.agentInstaller.skills.mock.calls).toEqual(expect.arrayContaining([['codex'], ['hermes']]))
    bridge.agentInstaller.skills.mockClear()
    await textarea.setValue('@rev')
    await flushPromises()

    expect(bridge.agentInstaller.skills).not.toHaveBeenCalled()
    expect(wrapper.findAll('.skill-option')).toHaveLength(1)
    expect(wrapper.get('.skill-option').text()).toContain('Review code')
    expect(wrapper.get('.skill-option').text()).not.toContain('Research')
    expect(textarea.attributes('role')).toBe('combobox')
    expect(textarea.attributes('aria-expanded')).toBe('true')
    expect(textarea.attributes('aria-controls')).toBe('composer-skill-menu')
    expect(textarea.attributes('aria-activedescendant')).toBe('composer-mention-option-0')

    await textarea.setValue('@review')
    await flushPromises()
    expect(bridge.agentInstaller.skills).not.toHaveBeenCalled()

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
      knowledgeBaseHints: [],
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
    await wrapper.get('.mode-segmented [data-mode="manual"]').trigger('click')
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
    await wrapper.get('.mode-segmented [data-mode="manual"]').trigger('click')
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
      knowledgeBaseHints: [],
      attachments: [],
      mode: 'manual',
      maxRounds: 6,
    })
    wrapper.unmount()
  })

  it('routes one named Agent as a manual reply while the group defaults to automatic mode', async () => {
    const { wrapper, bridge } = await mountApp(({ state }) => {
      state.agents.push({
        kind: 'qwen',
        installed: true,
        available: true,
        credentialState: 'ready',
        version: '1.0.0',
      })
      state.groups.push({
        id: 'group-natural-routing',
        conversationType: 'group',
        name: 'Natural routing',
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
    const text = 'Codex，帮我检查这个方案'
    await textarea.setValue(text)
    await flushPromises()

    expect(wrapper.get('.mode-segmented [data-mode="auto"]').classes()).toContain('active')
    expect(wrapper.get('.send-button').text()).toBe('Send')
    expect(wrapper.findAll('.target-chip').map(chip => chip.classes().includes('selected')))
      .toEqual([true, false, false])
    await wrapper.get('.send-button').trigger('click')
    await flushPromises()

    expect(bridge.localWorkspace.send).toHaveBeenCalledWith({
      groupId: 'group-natural-routing',
      text,
      targetKinds: ['codex'],
      mentionedAgentKinds: ['codex'],
      skillHints: [],
      knowledgeBaseHints: [],
      attachments: [],
      mode: 'manual',
      maxRounds: 6,
    })
    wrapper.unmount()
  })

  it('does not run an Agent explicitly excluded by a natural-language request', async () => {
    const { wrapper, bridge } = await mountApp(({ state }) => {
      state.agents.push({
        kind: 'claude',
        installed: true,
        available: true,
        credentialState: 'ready',
        version: '1.0.0',
      })
      state.groups.push({
        id: 'group-negated-routing',
        conversationType: 'group',
        name: 'Negated routing',
        topic: '',
        agentKinds: ['codex', 'openclaw', 'claude'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
    })

    await wrapper.get('.conversation-link').trigger('click')
    const textarea = wrapper.get('.composer-box textarea')
    const text = 'OpenClaw 不要运行，让 Claude Code 回答'
    await textarea.setValue(text)
    await flushPromises()

    expect(wrapper.get('.send-button').text()).toBe('Send')
    expect(wrapper.findAll('.target-chip').map(chip => chip.classes().includes('selected')))
      .toEqual([false, false, true])
    await wrapper.get('.send-button').trigger('click')
    await flushPromises()

    expect(bridge.localWorkspace.send).toHaveBeenCalledWith(expect.objectContaining({
      text,
      targetKinds: ['claude'],
      mentionedAgentKinds: ['claude'],
      mode: 'manual',
    }))
    wrapper.unmount()
  })

  it('keeps the exact OpenClaw and Claude request scoped through a live automatic run', async () => {
    const text = 'openclaw和claude code你们俩互相了解下对方'
    const { wrapper, bridge, emitRunEvent } = await mountApp(({ state, bridge: desktopBridge }) => {
      for (const kind of ['openclaw', 'claude']) {
        state.agents.push({
          kind,
          installed: true,
          available: true,
          credentialState: 'ready',
          version: '1.0.0',
        })
      }
      state.groups.push({
        id: 'group-exact-routing',
        conversationType: 'group',
        name: 'Exact routing',
        topic: '',
        agentKinds: ['codex', 'openclaw', 'claude', 'hermes'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      desktopBridge.localWorkspace.send.mockImplementation(async () => {
        state.messages.push({
          id: 'root-exact-routing',
          groupId: 'group-exact-routing',
          role: 'user',
          content: text,
          targetKinds: ['openclaw', 'claude'],
          mentionedAgentKinds: ['openclaw', 'claude'],
          createdAt: '2026-07-29T08:01:00Z',
        })
        state.runningGroupIds = ['group-exact-routing']
        state.runs = [{
          runId: 'run-exact-routing',
          groupId: 'group-exact-routing',
          threadRootId: 'root-exact-routing',
          phase: 'running',
          mode: 'auto',
          targetKinds: ['codex', 'openclaw', 'claude', 'hermes'],
          completedKinds: ['codex', 'claude'],
          failedKinds: ['codex'],
          currentKind: 'openclaw',
          currentRound: 2,
          maxRounds: 6,
          progress: [],
          agentRuns: [
            {
              agentRunId: 'agent-run-codex-stray',
              kind: 'codex',
              round: 2,
              status: 'running',
              output: 'Stray Codex output',
              events: [{
                runId: 'run-exact-routing',
                agentRunId: 'agent-run-codex-stray',
                groupId: 'group-exact-routing',
                threadRootId: 'root-exact-routing',
                agentKind: 'codex',
                round: 2,
                seq: 1,
                type: 'warning',
                status: 'running',
                title: 'Stray Codex event',
              }],
            },
            {
              agentRunId: 'agent-run-openclaw-round-1',
              kind: 'openclaw',
              round: 1,
              status: 'completed',
              output: 'OpenClaw round one',
              events: [],
            },
            {
              agentRunId: 'agent-run-claude-round-1',
              kind: 'claude',
              round: 1,
              status: 'completed',
              output: 'Claude round one',
              events: [],
            },
            {
              agentRunId: 'agent-run-openclaw-round-2',
              kind: 'openclaw',
              round: 2,
              status: 'running',
              output: '',
              events: [],
            },
          ],
        }]
      })
    })

    await wrapper.get('.conversation-link').trigger('click')
    const textarea = wrapper.get('.composer-box textarea')
    await textarea.setValue(text)
    await flushPromises()

    expect(wrapper.get('.mode-segmented [data-mode="auto"]').classes()).toContain('active')
    expect(wrapper.get('.send-button').text()).toBe('Start discussion')
    expect(wrapper.findAll('.target-chip').map(chip => chip.classes().includes('selected')))
      .toEqual([false, true, true, false])

    await wrapper.get('.send-button').trigger('click')
    await flushPromises()

    expect(bridge.localWorkspace.send).toHaveBeenCalledWith({
      groupId: 'group-exact-routing',
      text,
      targetKinds: ['openclaw', 'claude'],
      mentionedAgentKinds: ['openclaw', 'claude'],
      skillHints: [],
      knowledgeBaseHints: [],
      attachments: [],
      mode: 'auto',
      maxRounds: 6,
    })
    expect(wrapper.findAll('.run-status-panel .run-agent-row').map(row => row.get('strong').text()))
      .toEqual(['OpenClaw', 'Claude Code'])
    expect(wrapper.get('.run-status-panel').text()).not.toContain('Codex')
    expect(wrapper.findAll('.message-row.agent[data-agent-kind="codex"]')).toHaveLength(0)

    emitRunEvent({
      runId: 'run-exact-routing',
      agentRunId: 'agent-run-codex-live',
      groupId: 'group-exact-routing',
      threadRootId: 'root-exact-routing',
      agentKind: 'codex',
      round: 2,
      seq: 99,
      type: 'warning',
      status: 'running',
      title: 'Late stray Codex event',
    })
    await flushPromises()

    expect(wrapper.findAll('.run-status-panel .run-agent-row').map(row => row.get('strong').text()))
      .toEqual(['OpenClaw', 'Claude Code'])
    expect(wrapper.get('.run-status-panel').text()).not.toContain('Codex')
    expect(wrapper.findAll('.message-row.agent[data-agent-kind="codex"]')).toHaveLength(0)
    wrapper.unmount()
  })

  it('unions Agent Tags and named members in automatic mode without queueing the rest', async () => {
    const { wrapper, bridge } = await mountApp(({ state }) => {
      for (const kind of ['qwen', 'kimi', 'workbuddy']) {
        state.agents.push({
          kind,
          installed: true,
          available: true,
          credentialState: 'ready',
          version: '1.0.0',
        })
      }
      state.groups.push({
        id: 'group-auto-routing',
        conversationType: 'group',
        name: 'Automatic routing',
        topic: '',
        agentKinds: ['codex', 'hermes', 'qwen', 'kimi', 'workbuddy'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
    })

    await wrapper.get('.conversation-link').trigger('click')
    const textarea = wrapper.get('.composer-box textarea')
    await textarea.setValue('@cod')
    await flushPromises()
    await wrapper.get('.agent-mention-option').trigger('click')
    await textarea.setValue('Hermes、Qwen Code，一起检查 Harness')
    await flushPromises()

    expect(wrapper.get('.mode-segmented [data-mode="auto"]').classes()).toContain('active')
    expect(wrapper.get('.mode-segmented [data-mode="auto"]').attributes()).not.toHaveProperty('disabled')
    expect(wrapper.findAll('.target-chip').map(chip => chip.classes().includes('selected')))
      .toEqual([true, true, true, false, false])

    await wrapper.get('.send-button').trigger('click')
    await flushPromises()

    expect(bridge.localWorkspace.send).toHaveBeenCalledWith({
      groupId: 'group-auto-routing',
      text: 'Hermes、Qwen Code，一起检查 Harness',
      targetKinds: ['codex', 'hermes', 'qwen'],
      mentionedAgentKinds: ['codex', 'hermes', 'qwen'],
      skillHints: [],
      knowledgeBaseHints: [],
      attachments: [],
      mode: 'auto',
      maxRounds: 6,
    })
    wrapper.unmount()
  })

  it('mentions a ready knowledge base for multiple selected Agents and sends its scoped access', async () => {
    const { wrapper, bridge } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-knowledge',
        conversationType: 'group',
        name: 'Knowledge review',
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
    const textarea = wrapper.get('.composer-box textarea')
    await textarea.setValue('@cod')
    await wrapper.get('.agent-mention-option').trigger('click')
    await textarea.setValue('@her')
    await flushPromises()
    await wrapper.get('.agent-mention-option').trigger('click')

    await textarea.setValue('@ding')
    await flushPromises()
    const option = wrapper.get('.knowledge-base-mention-option')
    expect(option.get('img').attributes('src')).toBe('./knowledge-base-logos/dingtalk.svg')
    expect(option.text()).toContain('Search DingTalk documents through the configured dws connection')
    expect(option.text()).toContain('Knowledge')
    await option.trigger('click')
    expect(wrapper.get('.selected-knowledge-base').text()).toContain('@DingTalk Docs')

    await textarea.setValue('Compare the internal references')
    await wrapper.get('.send-button').trigger('click')
    await flushPromises()

    expect(bridge.localWorkspace.send).toHaveBeenCalledWith({
      groupId: 'group-knowledge',
      text: 'Compare the internal references',
      targetKinds: ['codex', 'hermes'],
      mentionedAgentKinds: ['codex', 'hermes'],
      skillHints: [],
      knowledgeBaseHints: [{ kind: 'dingtalk', targetKinds: ['codex', 'hermes'] }],
      attachments: [],
      mode: 'manual',
      maxRounds: 6,
    })
    expect(wrapper.find('.selected-knowledge-base').exists()).toBe(false)
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
    await wrapper.get('.mode-segmented [data-mode="manual"]').trigger('click')
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

    expect(bridge.agentInstaller.skills).not.toHaveBeenCalled()
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
      knowledgeBaseHints: [],
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
      knowledgeBaseHints: [],
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
    let sidebarDeletePopover = document.body.querySelector('.sidebar-delete-popover')
    expect(sidebarDeletePopover.textContent).toContain('Delete this conversation?')
    expect(sidebarDeletePopover.textContent).toContain('Native CLI sessions are not deleted')
    expect(sidebarDeletePopover.querySelector('.danger-button').textContent).toContain('Confirm delete')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(document.body.querySelector('.sidebar-delete-popover')).toBeNull()
    await wrapper.findAll('.direct-session-row')[1].findAll('.direct-session-action')[1].trigger('click')
    sidebarDeletePopover = document.body.querySelector('.sidebar-delete-popover')
    sidebarDeletePopover.querySelector('.danger-button').click()
    await flushPromises()
    expect(bridge.localWorkspace.deleteGroup).toHaveBeenCalledWith('direct-codex-1')
    wrapper.unmount()
  })

  it('keeps sidebar session trees visible and collapses long lists behind More', async () => {
    const source = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    expect(source).toMatch(/\.direct-session-list::before/)
    expect(source).toMatch(/\.direct-session-list > \.sidebar-more-button::before/)
    expect(source).toMatch(/--session-tree-line:\s*color-mix\(in srgb,\s*var\(--border\)\s*78%,\s*transparent\);/)
    expect(source).toMatch(/\.direct-session-list::before\s*\{[^}]*border-left:\s*1px solid var\(--session-tree-line\);[^}]*border-bottom-left-radius:\s*7px;/s)
    expect(source).toMatch(/\.direct-session-list > :last-child::before\s*\{[^}]*content:\s*none;/s)
    expect(source).toMatch(/\.direct-session-row\.active\s*\{[^}]*border-color:\s*transparent;[^}]*background:\s*var\(--surface-active\);/s)
    expect(source).toMatch(/\.direct-session-row\.active::after\s*\{[^}]*background:\s*var\(--accent\);/s)
    expect(source).toMatch(/\.sidebar-delete-popover\s*\{[^}]*position:\s*fixed;[^}]*border:\s*0;[^}]*transform:\s*translateY\(calc\(-100% \+ 18px\)\);/s)
    expect(source).toMatch(/\.sidebar-delete-popover::after\s*\{[^}]*border:\s*0;/s)
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
    const sidebarDeletePopover = document.body.querySelector('.sidebar-delete-popover')
    expect(sidebarDeletePopover.querySelector('.danger-button').textContent).toContain('Confirm delete')
    sidebarDeletePopover.querySelector('.danger-button').click()
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
    expect(wrapper.get('.run-status-panel.direct.solo').text()).toContain('Codex is working in this chat')
    expect(wrapper.get('.run-status-panel .run-agent-logo').attributes('data-status')).toBe('running')
    expect(wrapper.find('.relay-run-indicator').exists()).toBe(false)
    expect(wrapper.find('.run-agent-list').exists()).toBe(false)

    scrollIntoView.mockClear()
    await railButtons[0].trigger('click')
    await flushPromises()

    expect(wrapper.get('#message-agent-1').text()).toContain('First answer')
    expect(scrollIntoView).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('reuses the solo presentation and reflects each run state when a group message targets one Agent', async () => {
    const { wrapper, state, emitWorkspaceChanged } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-1',
        conversationType: 'group',
        name: 'Focused review',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      state.messages.push({
        id: 'root-1',
        groupId: 'group-1',
        role: 'user',
        content: 'Codex only',
        targetKinds: ['codex'],
        createdAt: '2026-07-29T08:01:00Z',
      })
      state.runningGroupIds = ['group-1']
      state.runs = [{
        groupId: 'group-1',
        phase: 'preparing',
        mode: 'manual',
        targetKinds: ['codex'],
        completedKinds: [],
        failedKinds: [],
        currentKind: '',
        threadRootId: 'root-1',
        progress: [],
      }]
    })

    await wrapper.get('.conversation-link').trigger('click')
    await flushPromises()

    const panel = wrapper.get('.run-status-panel.group.solo')
    expect(panel.classes()).not.toContain('multi')
    expect(panel.text()).toContain('Codex')
    expect(panel.get('.direct-run-indicator').exists()).toBe(true)
    expect(panel.get('.run-agent-logo').attributes('data-status')).toBe('queued')
    expect(panel.get('.solo-run-status').text()).toBe('Queued')
    expect(panel.text()).not.toContain('Codex is working in this chat')
    expect(panel.find('.typing-bars').exists()).toBe(false)
    expect(wrapper.find('.relay-run-indicator').exists()).toBe(false)
    expect(wrapper.find('.run-agent-list').exists()).toBe(false)
    expect(wrapper.findAll('.run-agent-row')).toHaveLength(0)

    state.runs[0].phase = 'running'
    state.runs[0].currentKind = 'codex'
    state.runs[0].progress = [{ title: 'process', status: 'running' }]
    emitWorkspaceChanged()
    await flushPromises()
    expect(panel.get('.run-agent-logo').attributes('data-status')).toBe('running')
    expect(panel.get('.solo-run-status').text()).toBe('Running')
    expect(panel.text()).toContain('Codex is working in this chat')
    expect(panel.get('.typing-bars').exists()).toBe(true)
    expect(panel.get('.run-progress-details').text()).toContain('Run process')

    state.runs[0].currentKind = ''
    state.runs[0].completedKinds = ['codex']
    emitWorkspaceChanged()
    await flushPromises()
    expect(panel.get('.run-agent-logo').attributes('data-status')).toBe('completed')
    expect(panel.get('.solo-run-status').text()).toBe('Completed')
    expect(panel.text()).not.toContain('Codex is working in this chat')
    expect(panel.find('.typing-bars').exists()).toBe(false)

    state.runs[0].failedKinds = ['codex']
    emitWorkspaceChanged()
    await flushPromises()
    expect(panel.get('.run-agent-logo').attributes('data-status')).toBe('failed')
    expect(panel.get('.solo-run-status').text()).toBe('Failed')
    expect(panel.text()).not.toContain('Codex is working in this chat')
    expect(panel.find('.typing-bars').exists()).toBe(false)
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

  it('reopens and locates the declared running topic while keeping progress and execution metadata collapsed', async () => {
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
    expect(wrapper.get('.run-status-panel.group.solo').text()).toContain('Codex')
    expect(wrapper.get('.run-status-panel').text()).not.toContain('Hermes')
    expect(wrapper.get('.run-status-panel').text()).not.toContain('Qwen Code')
    expect(wrapper.get('.run-round-progress').text()).toBe('Round 2/6')
    expect(wrapper.findAll('.relay-run-indicator .run-agent-logo')).toHaveLength(0)
    expect(wrapper.findAll('.run-agent-row')).toHaveLength(0)
    expect(wrapper.get('.direct-run-indicator .run-agent-logo').attributes('data-status')).toBe('completed')
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

    state.runs[0].failedKinds = ['codex']
    emitWorkspaceChanged()
    await flushPromises()
    expect(wrapper.get('.direct-run-indicator .run-agent-logo').attributes('data-status')).toBe('failed')
    expect(wrapper.get('.solo-run-status').attributes('data-status')).toBe('failed')
    wrapper.unmount()
  })

  it('streams direct Agent answer deltas inline without opening the group trace panel', async () => {
    const { wrapper, emitRunEvent } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'direct-trace',
        conversationType: 'direct',
        directAgentKind: 'codex',
        name: 'Codex trace',
        topic: '',
        agentKinds: ['codex'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      state.messages.push({
        id: 'direct-root',
        groupId: 'direct-trace',
        role: 'user',
        content: 'Stream this answer',
        createdAt: '2026-07-29T08:01:00Z',
      })
      state.runningGroupIds = ['direct-trace']
      state.runs = [{
        runId: 'run-direct',
        groupId: 'direct-trace',
        threadRootId: 'direct-root',
        targetKinds: ['codex'],
        currentKind: 'codex',
        agentRuns: [{
          agentRunId: 'agent-direct',
          kind: 'codex',
          round: 1,
          status: 'running',
          output: '',
          events: [],
        }],
      }]
    })

    await wrapper.get('.direct-session-open').trigger('click')
    emitRunEvent({
      runId: 'run-direct', agentRunId: 'agent-direct', groupId: 'direct-trace',
      threadRootId: 'direct-root', agentKind: 'codex', round: 1, seq: 1,
      type: 'answer_delta', status: 'running', delta: 'First',
    })
    await flushPromises()
    expect(wrapper.get('.message-row.agent[data-agent-kind="codex"] .message-copy-surface').text()).toContain('First')
    expect(wrapper.get('.direct-conclusion-live-status').text()).toBe('Codex / Conclusion / Streaming')
    expect(wrapper.get('.direct-conclusion-live-status').text()).not.toContain('First')
    const traceDetails = wrapper.get('.trace-inline-details')
    expect(traceDetails.exists()).toBe(true)
    expect(traceDetails.element.open).toBe(false)
    expect(wrapper.find('.run-trace-panel').exists()).toBe(false)
    expect(wrapper.find('.message-trace-button').exists()).toBe(false)

    traceDetails.element.open = true
    await traceDetails.trigger('toggle')
    await flushPromises()
    expect(traceDetails.element.open).toBe(true)

    emitRunEvent({
      runId: 'run-direct', agentRunId: 'agent-direct', groupId: 'direct-trace',
      threadRootId: 'direct-root', agentKind: 'codex', round: 1, seq: 2,
      type: 'answer_delta', status: 'running', delta: ' answer',
    })
    emitRunEvent({
      runId: 'run-direct', agentRunId: 'agent-direct', groupId: 'direct-trace',
      threadRootId: 'direct-root', agentKind: 'codex', round: 1, seq: 3,
      type: 'warning', status: 'waiting', title: 'connector_limited',
    })
    await flushPromises()
    expect(wrapper.get('.message-row.agent[data-agent-kind="codex"] .message-copy-surface').text()).toContain('First answer')
    expect(wrapper.get('.direct-conclusion-live-status').text()).toBe('Codex / Conclusion / Streaming')
    expect(wrapper.get('.trace-inline-details').element.open).toBe(true)
    expect(wrapper.get('.trace-inline-event small').text())
      .toBe('Connector provided only the final answer; structured tool activity was unavailable.')
    expect(wrapper.get('.trace-inline-details').text()).not.toContain('connector_limited')
    wrapper.unmount()
  })

  it('shows a failed direct Agent trace inline without opening the group panel', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'direct-failed-trace',
        conversationType: 'direct',
        directAgentKind: 'codex',
        name: 'Codex failure trace',
        topic: '',
        agentKinds: ['codex'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      state.messages.push(
        {
          id: 'failed-root',
          groupId: 'direct-failed-trace',
          role: 'user',
          content: 'Run the failing task',
          createdAt: '2026-07-29T08:01:00Z',
        },
        {
          id: 'failed-system',
          groupId: 'direct-failed-trace',
          role: 'system',
          agentKind: 'codex',
          content: 'Codex failed: process failed',
          system: {
            key: 'system.agentCallFailed',
            params: { agent: 'Codex', reason: 'process failed' },
          },
          trace: {
            runId: 'run-failed-direct',
            agentRunId: 'agent-failed-direct',
            status: 'failed',
            summary: 'The process exited before returning a conclusion.',
            events: [{
              evidenceId: 'E-R0-CODEX-01',
              type: 'tool_result_summary',
              status: 'failed',
              title: 'Process',
              summary: 'Exit code 1',
            }],
          },
          createdAt: '2026-07-29T08:02:00Z',
        },
      )
    })

    await wrapper.get('.direct-session-open').trigger('click')
    const details = wrapper.get('.trace-system-details')
    expect(details.element.open).toBe(false)
    expect(wrapper.find('.run-trace-panel').exists()).toBe(false)

    details.element.open = true
    await details.trigger('toggle')
    await flushPromises()
    expect(details.element.open).toBe(true)
    expect(details.text()).toContain('The process exited before returning a conclusion.')
    expect(details.text()).toContain('Tool result')
    expect(details.text()).toContain('Exit code 1')
    expect(details.text()).toContain('Failed')
    expect(wrapper.find('.run-trace-panel').exists()).toBe(false)
    wrapper.unmount()
  })

  it('shows an honest empty state when a direct trace contains only lifecycle placeholders', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'direct-empty-trace',
        conversationType: 'direct',
        directAgentKind: 'codex',
        name: 'Codex empty trace',
        topic: '',
        agentKinds: ['codex'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      state.messages.push(
        {
          id: 'direct-empty-root',
          groupId: 'direct-empty-trace',
          role: 'user',
          content: 'Return the final answer',
          createdAt: '2026-07-29T08:01:00Z',
        },
        {
          id: 'direct-empty-agent',
          groupId: 'direct-empty-trace',
          role: 'agent',
          agentKind: 'codex',
          threadRootId: 'direct-empty-root',
          content: 'Final answer',
          trace: {
            runId: 'run-direct-empty',
            agentRunId: 'agent-direct-empty',
            status: 'completed',
            events: [
              { evidenceId: 'E-R1-CODEX-01', type: 'status', status: 'running', title: 'Agent' },
              { evidenceId: 'E-R1-CODEX-02', type: 'status', status: 'running', title: 'Process' },
            ],
          },
          createdAt: '2026-07-29T08:02:00Z',
        },
      )
    })

    await wrapper.get('.direct-session-open').trigger('click')
    const details = wrapper.get('.trace-inline-details')
    expect(details.get('summary small').text()).toBe('0')

    details.element.open = true
    await details.trigger('toggle')
    await flushPromises()

    expect(details.findAll('.trace-inline-event')).toHaveLength(0)
    expect(details.get('.trace-inline-empty').text()).toBe('No detailed events were retained.')
    wrapper.unmount()
  })

  it('opens the selected Agent execution details in a group trace panel', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-trace',
        conversationType: 'group',
        name: 'Trace review',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      state.messages.push({
        id: 'group-root',
        groupId: 'group-trace',
        role: 'user',
        content: 'Compare the approaches',
        createdAt: '2026-07-29T08:01:00Z',
      })
      state.runningGroupIds = ['group-trace']
      state.runs = [{
        runId: 'run-group',
        groupId: 'group-trace',
        threadRootId: 'group-root',
        targetKinds: ['codex', 'hermes'],
        currentKind: 'hermes',
        agentRuns: [
          {
            agentRunId: 'agent-codex',
            kind: 'codex',
            round: 1,
            status: 'completed',
            output: 'Codex conclusion',
            events: [{ seq: 1, type: 'reasoning_summary', status: 'completed', summary: 'Codex evidence' }],
          },
          {
            agentRunId: 'agent-hermes',
            kind: 'hermes',
            round: 1,
            status: 'running',
            output: 'Hermes conclusion',
            events: [{ seq: 2, type: 'tool_result_summary', status: 'completed', title: 'Research', summary: 'Hermes evidence' }],
          },
        ],
      }]
    })

    await wrapper.get('.conversation-link').trigger('click')
    const hermesRow = wrapper.findAll('.run-agent-row').find(row => row.get('strong').text() === 'Hermes')
    expect(hermesRow).toBeTruthy()
    await hermesRow.trigger('click')
    await flushPromises()

    expect(wrapper.get('.run-trace-panel').exists()).toBe(true)
    expect(wrapper.get('.trace-panel-header strong').text()).toBe('Hermes')
    expect(wrapper.get('.trace-agent-tab.active strong').text()).toBe('Hermes')
    expect(wrapper.get('.trace-agent-tab.active').attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('.trace-conclusion').text()).toContain('Hermes conclusion')
    expect(wrapper.get('.trace-event-list').text()).toContain('Tool result')
    wrapper.unmount()
  })

  it('keeps historical message traces and the active run in separate trace panels', async () => {
    const historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const { wrapper } = await mountApp(({ state }) => {
      for (const kind of ['claude', 'openclaw']) {
        state.agents.push({
          kind,
          installed: true,
          available: true,
          credentialState: 'ready',
          version: '1.0.0',
        })
      }
      state.groups.push({
        id: 'group-trace-boundaries',
        conversationType: 'group',
        name: 'Trace boundaries',
        topic: '',
        agentKinds: ['codex', 'hermes', 'claude', 'openclaw'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:06:00Z',
      })
      state.messages.push(
        {
          id: 'trace-history-root',
          groupId: 'group-trace-boundaries',
          role: 'user',
          content: 'First historical request',
          targetKinds: ['codex'],
          createdAt: '2026-07-29T08:01:00Z',
        },
        {
          id: 'trace-history-codex',
          groupId: 'group-trace-boundaries',
          role: 'agent',
          agentKind: 'codex',
          threadRootId: 'trace-history-root',
          content: 'Historical Codex answer',
          trace: {
            runId: 'run-trace-history-one',
            agentRunId: 'agent-trace-history-codex',
            status: 'completed',
            events: [{ evidenceId: 'E-R1-CODEX-01', type: 'reasoning_summary', status: 'completed', title: 'Old evidence' }],
          },
          createdAt: '2026-07-29T08:02:00Z',
        },
        {
          id: 'trace-current-root',
          groupId: 'group-trace-boundaries',
          role: 'user',
          content: 'Second historical request',
          targetKinds: ['claude', 'hermes'],
          createdAt: '2026-07-29T08:03:00Z',
        },
        {
          id: 'trace-current-claude',
          groupId: 'group-trace-boundaries',
          role: 'agent',
          agentKind: 'claude',
          threadRootId: 'trace-current-root',
          content: 'Current Claude answer',
          trace: {
            runId: 'run-trace-history-two',
            agentRunId: 'agent-trace-shared-claude',
            status: 'completed',
            events: [{ evidenceId: 'E-R1-CLAUDE-01', type: 'reasoning_summary', status: 'completed', title: 'Current Claude evidence' }],
          },
          createdAt: '2026-07-29T08:04:00Z',
        },
        {
          id: 'trace-current-hermes',
          groupId: 'group-trace-boundaries',
          role: 'agent',
          agentKind: 'hermes',
          threadRootId: 'trace-current-root',
          content: 'Current Hermes answer',
          trace: {
            runId: 'run-trace-history-two',
            agentRunId: 'agent-trace-current-hermes',
            status: 'completed',
            events: [{ evidenceId: 'E-R1-HERMES-01', type: 'tool_result_summary', status: 'completed', title: 'Current Hermes evidence' }],
          },
          createdAt: '2026-07-29T08:05:00Z',
        },
        {
          id: 'trace-active-root',
          groupId: 'group-trace-boundaries',
          role: 'user',
          content: 'Active request',
          targetKinds: ['openclaw', 'claude'],
          createdAt: '2026-07-29T08:06:00Z',
        },
      )
      state.runningGroupIds = ['group-trace-boundaries']
      state.runs = [{
        runId: 'run-trace-active',
        groupId: 'group-trace-boundaries',
        threadRootId: 'trace-active-root',
        targetKinds: ['openclaw', 'claude'],
        currentKind: 'claude',
        currentRound: 1,
        maxRounds: 4,
        agentRuns: [
          {
            agentRunId: 'agent-trace-active-openclaw',
            kind: 'openclaw',
            round: 1,
            status: 'completed',
            output: 'Active OpenClaw answer',
            events: [{ seq: 1, type: 'reasoning_summary', status: 'completed', title: 'Active OpenClaw evidence' }],
          },
          {
            agentRunId: 'agent-trace-shared-claude',
            kind: 'claude',
            round: 1,
            status: 'running',
            output: 'Active Claude work',
            events: [{ seq: 2, type: 'tool_start', status: 'running', title: 'Active Claude evidence' }],
          },
        ],
      }]
    })

    await wrapper.get('.conversation-link').trigger('click')
    const currentClaudeMessage = wrapper.findAll('.message-row.agent[data-agent-kind="claude"]')
      .find(row => row.text().includes('Current Claude answer'))
    expect(currentClaudeMessage).toBeTruthy()
    await currentClaudeMessage.get('.message-trace-button').trigger('click')
    await flushPromises()

    expect(wrapper.findAll('.trace-agent-tab strong').map(item => item.text()))
      .toEqual(['Claude Code', 'Hermes'])
    expect(wrapper.get('.run-trace-panel').text()).toContain('Current Claude evidence')
    expect(wrapper.get('.run-trace-panel').text()).not.toContain('Historical Codex answer')
    expect(wrapper.get('.run-trace-panel').text()).not.toContain('Active Claude work')

    await wrapper.get('.run-trace-panel .icon-button').trigger('click')
    await flushPromises()
    expect(historyBack).toHaveBeenCalledTimes(1)

    const activeClaudeRow = wrapper.findAll('.run-agent-row')
      .find(row => row.get('strong').text() === 'Claude Code')
    expect(activeClaudeRow).toBeTruthy()
    await activeClaudeRow.trigger('click')
    await flushPromises()

    expect(wrapper.findAll('.trace-agent-tab strong').map(item => item.text()))
      .toEqual(['OpenClaw', 'Claude Code'])
    expect(wrapper.get('.trace-conclusion').text()).toContain('Active Claude work')
    expect(wrapper.get('.run-trace-panel').text()).not.toContain('Current Claude answer')
    expect(wrapper.get('.run-trace-panel').text()).not.toContain('Historical Codex answer')
    wrapper.unmount()
  })

  it('opens a retained group trace with no events and keeps its context statistics visible', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-empty-retained-trace',
        conversationType: 'group',
        name: 'Retained empty trace',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:02:00Z',
      })
      state.messages.push(
        {
          id: 'empty-retained-root',
          groupId: 'group-empty-retained-trace',
          role: 'user',
          content: 'Keep the trace identity',
          targetKinds: ['codex'],
          createdAt: '2026-07-29T08:01:00Z',
        },
        {
          id: 'empty-retained-agent',
          groupId: 'group-empty-retained-trace',
          role: 'agent',
          agentKind: 'codex',
          threadRootId: 'empty-retained-root',
          content: 'Retained conclusion',
          trace: {
            runId: 'run-empty-retained',
            agentRunId: 'agent-empty-retained',
            round: 4,
            status: 'completed',
            summary: '',
            events: [],
            context: {
              includedCount: 3,
              omittedCount: 2,
              charCount: 480,
              sessionRotated: true,
            },
          },
          createdAt: '2026-07-29T08:02:00Z',
        },
      )
    })

    await wrapper.get('.conversation-link').trigger('click')
    const traceButton = wrapper.get('.message-row.agent[data-agent-kind="codex"] .message-trace-button')
    expect(traceButton.exists()).toBe(true)
    await traceButton.trigger('click')
    await flushPromises()

    expect(wrapper.get('.trace-event-section .trace-empty-state').text())
      .toBe('No detailed events were retained.')
    expect(wrapper.get('.trace-agent-tab.active small').text()).toBe('Round 4 / Completed')
    expect(wrapper.get('.trace-context-stats').text()).toContain('3 messages included')
    expect(wrapper.get('.trace-context-stats').text()).toContain('2 messages compacted')
    expect(wrapper.get('.trace-context-stats').text()).toContain('480 context characters')
    expect(wrapper.get('.trace-context-stats').text()).toContain('Session context rotated')

    setLocale('zh')
    await flushPromises()
    expect(wrapper.get('.trace-event-section .trace-empty-state').text()).toBe('没有保留详细过程事件。')
    expect(wrapper.get('.trace-context-stats').text()).toContain('纳入 3 条消息')
    wrapper.unmount()
  })

  it('closes the group trace panel when leaving the conversation or its group disappears', async () => {
    const historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const { wrapper, state, emitWorkspaceChanged } = await mountApp(({ state: nextState }) => {
      nextState.groups.push({
        id: 'group-trace-lifecycle',
        conversationType: 'group',
        name: 'Trace lifecycle',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      nextState.runs = [{
        runId: 'run-trace-lifecycle',
        groupId: 'group-trace-lifecycle',
        targetKinds: ['codex', 'hermes'],
        currentKind: 'codex',
        agentRuns: [
          { agentRunId: 'agent-lifecycle-codex', kind: 'codex', round: 1, status: 'running', output: '', events: [] },
          { agentRunId: 'agent-lifecycle-hermes', kind: 'hermes', round: 1, status: 'queued', output: '', events: [] },
        ],
      }]
    })

    await wrapper.get('.conversation-link').trigger('click')
    await wrapper.get('.run-agent-row:not([disabled])').trigger('click')
    await flushPromises()
    expect(wrapper.find('.run-trace-panel').exists()).toBe(true)

    await wrapper.get('.sidebar-settings-entry').trigger('click')
    await flushPromises()
    expect(wrapper.find('.run-trace-panel').exists()).toBe(false)
    expect(wrapper.find('.system-settings-page').exists()).toBe(true)

    await wrapper.get('.conversation-link').trigger('click')
    await wrapper.get('.run-agent-row:not([disabled])').trigger('click')
    await flushPromises()
    expect(wrapper.find('.run-trace-panel').exists()).toBe(true)

    state.groups = []
    state.messages = []
    state.runs = []
    state.runningGroupIds = []
    emitWorkspaceChanged()
    await flushPromises()

    expect(wrapper.find('.run-trace-panel').exists()).toBe(false)
    expect(wrapper.find('.agent-home').exists()).toBe(true)
    expect(historyBack).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('closes the group trace panel with Escape and restores the Agent row focus', async () => {
    const historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-trace-focus',
        conversationType: 'group',
        name: 'Trace focus',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      state.runningGroupIds = ['group-trace-focus']
      state.runs = [{
        runId: 'run-focus',
        groupId: 'group-trace-focus',
        targetKinds: ['codex', 'hermes'],
        agentRuns: [
          { agentRunId: 'agent-focus-codex', kind: 'codex', round: 1, status: 'running', output: 'Codex', events: [] },
          { agentRunId: 'agent-focus-hermes', kind: 'hermes', round: 1, status: 'running', output: 'Hermes', events: [] },
        ],
      }]
    })

    await wrapper.get('.conversation-link').trigger('click')
    const opener = wrapper.findAll('.run-agent-row').find(row => row.get('strong').text() === 'Hermes')
    await opener.trigger('click')
    await flushPromises()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()

    expect(wrapper.find('.run-trace-panel').exists()).toBe(false)
    expect(document.activeElement).toBe(opener.element)
    expect(historyBack).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('closes an empty trace panel and falls back to the conversation title', async () => {
    const historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const { wrapper, state, emitWorkspaceChanged } = await mountApp(({ state: nextState }) => {
      nextState.groups.push({
        id: 'group-trace-title-focus',
        conversationType: 'group',
        name: 'Trace title focus',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      nextState.runs = [{
        runId: 'run-title-focus',
        groupId: 'group-trace-title-focus',
        targetKinds: ['codex', 'hermes'],
        currentKind: 'codex',
        agentRuns: [
          { agentRunId: 'agent-title-focus-codex', kind: 'codex', round: 1, status: 'running', output: '', events: [] },
          { agentRunId: 'agent-title-focus-hermes', kind: 'hermes', round: 1, status: 'queued', output: '', events: [] },
        ],
      }]
    })

    await wrapper.get('.conversation-link').trigger('click')
    const opener = wrapper.get('.run-agent-row:not([disabled])')
    await opener.trigger('click')
    await flushPromises()

    state.runs = []
    emitWorkspaceChanged()
    await flushPromises()
    expect(opener.element.isConnected).toBe(false)
    expect(wrapper.find('.run-trace-panel').exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.get('.conversation-title-block').element)
    expect(historyBack).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('keeps the full live ledger until the run ends, then uses the durable trace capsule', async () => {
    const historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const { wrapper, state, emitWorkspaceChanged } = await mountApp(({ state: nextState }) => {
      nextState.groups.push({
        id: 'group-durable-trace',
        conversationType: 'group',
        name: 'Durable trace',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      nextState.messages.push({
        id: 'durable-root',
        groupId: 'group-durable-trace',
        role: 'user',
        content: 'Keep the evidence',
        createdAt: '2026-07-29T08:01:00Z',
      })
      nextState.runningGroupIds = ['group-durable-trace']
      nextState.runs = [{
        runId: 'run-durable',
        groupId: 'group-durable-trace',
        threadRootId: 'durable-root',
        targetKinds: ['codex', 'hermes'],
        agentRuns: [{
          agentRunId: 'agent-durable',
          kind: 'codex',
          round: 1,
          status: 'completed',
          output: 'live output',
          events: [
            { seq: 1, type: 'reasoning_summary', status: 'completed', summary: 'live reasoning' },
            { seq: 2, type: 'tool_result_summary', status: 'completed', title: 'Bash', summary: 'live tool result' },
          ],
        }, {
          agentRunId: 'agent-durable-hermes',
          kind: 'hermes',
          round: 1,
          status: 'running',
          output: '',
          events: [],
        }],
      }]
    })

    await wrapper.get('.conversation-link').trigger('click')
    expect(wrapper.findAll('.message-row.agent[data-agent-kind="codex"]')).toHaveLength(1)
    expect(wrapper.get('.message-row.agent[data-agent-kind="codex"]').text()).toContain('live output')
    const provisionalTraceButton = wrapper.get('.message-row.agent[data-agent-kind="codex"] .message-trace-button')
    await provisionalTraceButton.trigger('click')
    await flushPromises()
    expect(wrapper.find('.run-trace-panel').exists()).toBe(true)

    state.messages.push({
      id: 'durable-agent',
      groupId: 'group-durable-trace',
      role: 'agent',
      agentKind: 'codex',
      threadRootId: 'durable-root',
      content: 'durable output',
      createdAt: '2026-07-29T08:02:00Z',
      trace: {
        runId: 'run-durable',
        agentRunId: 'agent-durable',
        round: 1,
        status: 'completed',
        summary: 'durable summary',
        events: [{
          evidenceId: 'E-R1-CODEX-01',
          type: 'tool_result_summary',
          status: 'completed',
          title: 'Bash',
          summary: 'Bash: operation: ls -1 (3 hidden arguments)',
          detail: 'Output: 5 lines, 47 bytes',
        }],
      },
    })
    emitWorkspaceChanged()
    await flushPromises()

    expect(wrapper.findAll('.message-row.agent[data-agent-kind="codex"]')).toHaveLength(1)
    expect(wrapper.get('.message-row.agent[data-agent-kind="codex"]').text()).toContain('durable output')
    expect(wrapper.get('.message-row.agent[data-agent-kind="codex"]').text()).not.toContain('live output')
    expect(provisionalTraceButton.element.isConnected).toBe(false)
    expect(wrapper.get('.trace-summary-copy').text()).toContain('durable summary')
    expect(wrapper.get('.trace-conclusion').text()).toContain('durable output')
    expect(wrapper.get('.trace-event-list').text()).toContain('live reasoning')
    expect(wrapper.get('.trace-event-list').text()).toContain('Bash')
    expect(wrapper.get('.trace-agent-tab.active small').text()).toBe('Round 1 / Completed')

    state.runs = []
    state.runningGroupIds = []
    emitWorkspaceChanged()
    await flushPromises()

    expect(wrapper.get('.trace-event-list').text()).not.toContain('live reasoning')
    expect(wrapper.get('.trace-agent-tab.active small').text()).toBe('Round 1 / Completed')
    const durableEventDetails = wrapper.get('.trace-event-list details')
    durableEventDetails.element.open = true
    await durableEventDetails.trigger('toggle')
    expect(wrapper.get('.trace-event-body').text()).toContain('Output: 5 lines, 47 bytes')
    const durableTraceButton = wrapper.get('.message-row.agent[data-agent-kind="codex"] .message-trace-button')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(document.activeElement).toBe(durableTraceButton.element)
    expect(historyBack).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('keeps a retained group run summary after timeout and opens its durable trace', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      state.agents.push({
        kind: 'workbuddy', installed: true, available: true, credentialState: 'ready', version: '1.0.0',
      })
      state.groups.push({
        id: 'group-timeout-trace',
        conversationType: 'group',
        name: 'Timeout trace',
        topic: '',
        agentKinds: ['codex', 'hermes', 'workbuddy'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:04:00Z',
      })
      state.messages.push(
        {
          id: 'timeout-root',
          groupId: 'group-timeout-trace',
          role: 'user',
          content: 'Research the available approaches',
          targetKinds: ['codex', 'hermes', 'workbuddy'],
          createdAt: '2026-07-29T08:01:00Z',
        },
        {
          id: 'timeout-codex',
          groupId: 'group-timeout-trace',
          role: 'agent',
          agentKind: 'codex',
          threadRootId: 'timeout-root',
          content: 'Codex retained conclusion',
          trace: {
            runId: 'run-timeout-retained',
            agentRunId: 'run-timeout-retained:1:codex:one',
            round: 1,
            status: 'completed',
            events: [
              { evidenceId: 'E-R1-CODEX-01', type: 'status', status: 'running', title: 'Agent' },
              { evidenceId: 'E-R1-CODEX-02', type: 'tool_result_summary', status: 'completed', title: 'Bash', summary: 'Read 12 files' },
            ],
          },
          createdAt: '2026-07-29T08:02:00Z',
        },
        {
          id: 'timeout-hermes',
          groupId: 'group-timeout-trace',
          role: 'system',
          agentKind: 'hermes',
          threadRootId: 'timeout-root',
          content: 'Hermes failed: process failed',
          trace: {
            runId: 'run-timeout-retained',
            agentRunId: 'run-timeout-retained:1:hermes:two',
            round: 1,
            status: 'failed',
            summary: 'Hermes stopped before returning a conclusion.',
            events: [],
          },
          createdAt: '2026-07-29T08:03:00Z',
        },
        {
          id: 'timeout-system',
          groupId: 'group-timeout-trace',
          role: 'system',
          agentKind: '',
          threadRootId: 'timeout-root',
          content: 'Automatic discussion reached its runtime limit without consensus.',
          system: { key: 'system.autoTimeout', params: {} },
          createdAt: '2026-07-29T08:04:00Z',
        },
      )
    })

    await wrapper.get('.conversation-link').trigger('click')
    const summary = wrapper.get('.run-status-panel.group.history')
    expect(summary.text()).toContain('Agent activity for this topic')
    expect(summary.text()).toContain('Timed out')
    expect(summary.text()).toContain('1 retained events')
    expect(summary.findAll('.run-agent-row').map(row => row.get('strong').text()))
      .toEqual(['Codex', 'Hermes', 'WorkBuddy'])
    expect(summary.findAll('.run-agent-row').map(row => row.attributes('data-status')))
      .toEqual(['completed', 'failed', 'not-started'])
    expect(summary.findAll('.run-agent-row')[2].attributes()).toHaveProperty('disabled')

    await summary.findAll('.run-agent-row')[0].trigger('click')
    await flushPromises()
    expect(wrapper.get('.run-trace-panel').text()).toContain('Codex retained conclusion')
    expect(wrapper.get('.trace-event-list').text()).toContain('Read 12 files')
    wrapper.unmount()
  })

  it('labels a retained manual trace as a completed single response', () => {
    const wrapper = mount(RunTracePanel, {
      props: {
        open: true,
        items: [{
          runId: 'run-manual',
          agentRunId: 'run-manual:0:codex:one',
          agentKind: 'codex',
          round: 0,
          status: 'completed',
          output: 'Manual conclusion',
          events: [],
          live: false,
        }],
        selectedAgentRunId: 'run-manual:0:codex:one',
      },
    })

    expect(wrapper.get('.trace-agent-tab.active small').text()).toBe('Single response / Completed')
    wrapper.unmount()
  })

  it('labels historical trace events whose detailed input and result were not captured', async () => {
    const wrapper = mount(RunTracePanel, {
      props: {
        open: true,
        items: [{
          runId: 'run-legacy',
          agentRunId: 'run-legacy:1:codex:one',
          agentKind: 'codex',
          round: 1,
          status: 'completed',
          events: [{
            evidenceId: 'E-R1-CODEX-01',
            type: 'tool_result_summary',
            status: 'completed',
            title: 'search',
          }],
        }],
        selectedAgentRunId: 'run-legacy:1:codex:one',
      },
    })

    expect(wrapper.get('.trace-detail-unavailable').text())
      .toContain('retained tool names and statuses')
    await wrapper.get('.trace-event-list summary').trigger('click')
    expect(wrapper.get('.trace-event-detail-unavailable').text())
      .toContain('was not captured')
    wrapper.unmount()
  })

  it('does not force-scroll a direct stream while the user is reading above the bottom', async () => {
    const { wrapper, emitRunEvent } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'direct-scroll',
        conversationType: 'direct',
        directAgentKind: 'codex',
        name: 'Scroll protection',
        topic: '',
        agentKinds: ['codex'],
        workdir: '/tmp/roundrelay-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      state.messages.push({
        id: 'scroll-root',
        groupId: 'direct-scroll',
        role: 'user',
        content: 'Read this carefully',
        createdAt: '2026-07-29T08:01:00Z',
      })
      state.runningGroupIds = ['direct-scroll']
      state.runs = [{
        runId: 'run-scroll',
        groupId: 'direct-scroll',
        threadRootId: 'scroll-root',
        targetKinds: ['codex'],
        agentRuns: [{ agentRunId: 'agent-scroll', kind: 'codex', round: 1, status: 'running', output: '', events: [] }],
      }]
    })

    await wrapper.get('.direct-session-open').trigger('click')
    await flushPromises()
    const scroller = wrapper.get('.message-scroll').element
    let scrollTop = 400
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1200 },
      clientHeight: { configurable: true, value: 400 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: value => { scrollTop = value },
      },
    })
    await wrapper.get('.message-scroll').trigger('scroll')
    emitRunEvent({
      runId: 'run-scroll', agentRunId: 'agent-scroll', groupId: 'direct-scroll',
      threadRootId: 'scroll-root', agentKind: 'codex', round: 1, seq: 1,
      type: 'answer_delta', status: 'running', delta: 'new output',
    })
    await flushPromises()

    expect(wrapper.get('.message-row.agent[data-agent-kind="codex"]').text()).toContain('new output')
    expect(scrollTop).toBe(400)
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
