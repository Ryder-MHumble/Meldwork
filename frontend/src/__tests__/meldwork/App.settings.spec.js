import { readFileSync as readNodeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENTS } from '../../catalog.js'
import RunTracePanel from '../../components/RunTracePanel.vue'
import { setLocale } from '../../i18n.js'
import { deferred, imageAttachment, mountApp } from './app-test-harness.js'
import { readStylesSource, STYLE_FILES } from './style-test-helpers.js'

function readFileSync(filename, encoding) {
  if (filename === resolve(process.cwd(), 'src/styles.css')) {
    return readStylesSource(filename)
  }
  return readNodeFileSync(filename, encoding)
}

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
const originalClipboard = navigator.clipboard
const originalExecCommand = document.execCommand

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('meldwork-theme', 'light')
  localStorage.setItem('meldwork-onboarding-seen-v1', '1')
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async () => {}) },
  })
  setLocale('en')
})

afterEach(() => {
  vi.useRealTimers()
  delete window.meldworkDesktop
  document.body.className = ''
  document.body.innerHTML = ''
  if (originalScrollIntoView) HTMLElement.prototype.scrollIntoView = originalScrollIntoView
  else delete HTMLElement.prototype.scrollIntoView
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard })
  if (originalExecCommand) Object.defineProperty(document, 'execCommand', { configurable: true, value: originalExecCommand })
  else delete document.execCommand
  vi.restoreAllMocks()
})

describe('Meldwork workbench', () => {
  it('provides a dedicated cloud-server settings tab', async () => {
    const { wrapper } = await mountApp()

    await wrapper.get('.sidebar-settings-entry').trigger('click')
    const cloudTab = wrapper.findAll('.settings-tabs button')
      .find(button => button.text().includes('Cloud servers'))
    await cloudTab.trigger('click')

    expect(wrapper.get('.cloud-agent-bridge-panel h2').text()).toBe('Cloud servers')
    expect(wrapper.get('.cloud-agent-connect-form').exists()).toBe(true)
    wrapper.unmount()
  })

  it('enables onboarding completion as soon as Agent detection finishes on any slide', async () => {
    vi.useFakeTimers()
    localStorage.removeItem('meldwork-onboarding-seen-v1')
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

    await wrapper.findAll('.onboarding-dot')[1].trigger('click')
    expect(wrapper.get('.onboarding-slide img').attributes('src')).toContain('provider-setup-v2.png')
    expect(wrapper.findAll('.onboarding-dot')[1].attributes('aria-current')).toBe('step')
    expect(wrapper.get('.onboarding-primary').attributes()).toHaveProperty('disabled')
    expect(wrapper.get('.onboarding-primary').text()).toContain('Detecting local Agents')

    finishDetection(structuredClone(state))
    await flushPromises()

    expect(wrapper.get('.onboarding-slide img').attributes('src')).toContain('provider-setup-v2.png')
    expect(wrapper.get('.onboarding-primary').attributes()).not.toHaveProperty('disabled')
    expect(wrapper.get('.onboarding-primary').text()).toContain('Start using')

    await vi.advanceTimersByTimeAsync(3_200)
    await flushPromises()
    expect(wrapper.get('.onboarding-slide img').attributes('src')).toContain('agent-collaboration.png')

    await wrapper.get('.onboarding-primary').trigger('click')
    expect(wrapper.find('.onboarding-dialog').exists()).toBe(false)
    expect(localStorage.getItem('meldwork-onboarding-seen-v1')).toBe('1')
    expect(wrapper.get('.sidebar').attributes()).not.toHaveProperty('inert')
    wrapper.unmount()
  })

  it('wraps keyboard focus within the onboarding dialog in both directions', async () => {
    localStorage.removeItem('meldwork-onboarding-seen-v1')
    const { wrapper } = await mountApp()
    const dialog = wrapper.get('.onboarding-dialog')
    const focusable = dialog.findAll('button:not([disabled])')
    const first = focusable[0].element
    const last = focusable[focusable.length - 1].element

    last.focus()
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    }))
    expect(document.activeElement).toBe(first)

    first.focus()
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }))
    expect(document.activeElement).toBe(last)

    wrapper.unmount()
  })

  it('loads every stylesheet partition from the real entrypoint in stable order', () => {
    const entry = readNodeFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
    expect(entry).toEqual(STYLE_FILES.map(file => `@import './styles/${file}';`))
  })

  it('keeps the onboarding frame stable with faster transitions and no internal dividers', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    const onboardingSource = readFileSync(
      resolve(process.cwd(), 'src/composables/useOnboarding.js'),
      'utf8',
    )

    expect(onboardingSource).toContain('const ONBOARDING_SLIDE_MS = 3200')
    expect(onboardingSource).toContain('const onboardingReady = computed(() => !onboardingDetecting.value)')
    expect(source).toMatch(/\.onboarding-dialog\s*\{[^}]*height:\s*min\(700px, calc\(100dvh - 48px\)\);/s)
    expect(source).toMatch(/\.onboarding-slide-viewport\s*\{[^}]*position:\s*relative;[^}]*overflow:\s*hidden;/s)
    expect(source).toMatch(/\.onboarding-slide\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*grid-template-rows:\s*minmax\(0, 1fr\) 148px;/s)
    expect(source).toMatch(/\.onboarding-slide > img\s*\{[^}]*height:\s*100%;[^}]*border-bottom:\s*0;/s)
    expect(source).toMatch(/\.onboarding-footer\s*\{[^}]*border-top:\s*0;/s)
    expect(source).toMatch(/\.onboarding-slide-enter-active,[^{]+\{[^}]*transition:\s*opacity 0\.1s ease;/s)
  })

  it('dismisses first-run onboarding with Escape and releases the body scroll lock', async () => {
    localStorage.removeItem('meldwork-onboarding-seen-v1')
    const historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const { wrapper } = await mountApp()

    expect(document.body.classList.contains('modal-open')).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()

    expect(wrapper.find('.onboarding-dialog').exists()).toBe(false)
    expect(document.body.classList.contains('modal-open')).toBe(false)
    expect(localStorage.getItem('meldwork-onboarding-seen-v1')).toBe('1')
    expect(historyBack).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('dismisses first-run onboarding with browser back without navigating twice', async () => {
    localStorage.removeItem('meldwork-onboarding-seen-v1')
    const historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const { wrapper } = await mountApp()

    expect(document.body.classList.contains('modal-open')).toBe(true)
    window.dispatchEvent(new PopStateEvent('popstate'))
    await flushPromises()

    expect(wrapper.find('.onboarding-dialog').exists()).toBe(false)
    expect(document.body.classList.contains('modal-open')).toBe(false)
    expect(localStorage.getItem('meldwork-onboarding-seen-v1')).toBe('1')
    expect(historyBack).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('does not cover an existing workspace when the onboarding marker is missing', async () => {
    localStorage.removeItem('meldwork-onboarding-seen-v1')
    const { wrapper, bridge } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'existing-group',
        name: 'Existing workspace',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
    })

    expect(wrapper.find('.onboarding-dialog').exists()).toBe(false)
    expect(localStorage.getItem('meldwork-onboarding-seen-v1')).toBe('1')
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

    await wrapper.findAll(".settings-tabs button")[2].trigger("click")
    await flushPromises()
    expect(bridge.localAgentProvider.status).toHaveBeenCalledTimes((AGENTS.length * 2) - 1)
    expect(bridge.localAgentProvider.probe).toHaveBeenCalledTimes(1)
    expect(bridge.localAgentProvider.probe).toHaveBeenCalledWith('codex')
    expect(wrapper.get('.provider-summary-count').text()).toContain(`0 usable of ${AGENTS.length}`)
    expect(bridge.localKnowledgeBase.status).toHaveBeenCalledTimes(1)

    await wrapper.findAll('.settings-tabs button')[0].trigger('click')
    await flushPromises()
    expect(bridge.localKnowledgeBase.status).toHaveBeenCalledTimes(1)

    await wrapper.findAll(".settings-tabs button")[3].trigger("click")
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
    await wrapper.findAll(".settings-tabs button")[2].trigger("click")
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
          installed: agent.kind !== 'pi',
          installSupported: agent.kind !== 'pi',
        })),
      })
      bridge.localAgentProvider.status.mockImplementation(async kind => (
        kind === 'qwen' ? qwenStatus : emptyStatus(kind)
      ))
      bridge.localAgentProvider.probe.mockImplementation(bridge.localAgentProvider.status)
    })

    await wrapper.get('.sidebar-settings-entry').trigger('click')
    await wrapper.findAll(".settings-tabs button")[2].trigger("click")
    await flushPromises()
    const providerButton = label => wrapper.findAll('.provider-agent-list button')
      .find(button => button.text().includes(label))

    expect(providerButton('Pi Agent').text()).toContain('Not installed')
    expect(providerButton('Hermes').text()).toContain('Sign-in required')
    expect(providerButton('Codex').text()).toContain('Sign-in not verified')
    expect(providerButton('Kimi Code').text()).toContain('Native configuration active')
    expect(providerButton('Qwen Code').text()).toContain('OpenRouter override active')

    await providerButton('Pi Agent').trigger('click')
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
    await wrapper.findAll(".settings-tabs button")[2].trigger("click")
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
    await wrapper.findAll(".settings-tabs button")[2].trigger("click")
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
    await wrapper.findAll(".settings-tabs button")[2].trigger("click")
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
    await wrapper.findAll(".settings-tabs button")[2].trigger("click")
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
    await wrapper.findAll(".settings-tabs button")[2].trigger("click")
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
    await wrapper.findAll(".settings-tabs button")[2].trigger("click")
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
              model: 'meldwork-model',
              configured: true,
              encryptionAvailable: true,
            }
          : { provider: '', baseUrl: '', model: '', configured: false, encryptionAvailable: true }
      ))
      bridge.localAgentProvider.probe.mockImplementation(bridge.localAgentProvider.status)
    })

    await wrapper.get('.sidebar-settings-entry').trigger('click')
    await wrapper.findAll(".settings-tabs button")[2].trigger("click")
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
    await wrapper.findAll(".settings-tabs button")[3].trigger("click")
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
    await wrapper.findAll(".settings-tabs button")[3].trigger("click")
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
    await wrapper.findAll(".settings-tabs button")[3].trigger("click")
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
    await wrapper.findAll(".settings-tabs button")[3].trigger("click")
    await flushPromises()

    const feishuCard = wrapper.findAll('.knowledge-base-item')
      .find(card => card.text().includes('Feishu Docs'))
    expect(feishuCard.exists()).toBe(true)
    expect(feishuCard.get('.knowledge-base-status').text()).toContain('Detection failed')
    expect(feishuCard.text()).not.toContain('CLI not installed')
    expect(feishuCard.text()).not.toContain('CLI missing')
    wrapper.unmount()
  })
})
