import { describe, expect, it } from 'vitest'
import {
  EMPTY_PROVIDER_STATUS,
  activeSavedProviderPreset,
  nativeProviderReady,
  providerActiveSourceFor,
  providerAgentState,
  providerProfilesFor,
  providerStatusFor,
  providerSummaryLabel,
  supportsExternalProvider,
} from '../../providerSettingsModel.js'

const t = (key, params = {}) => `${key}:${JSON.stringify(params)}`
const agent = overrides => ({
  kind: 'codex',
  label: 'Codex',
  installed: true,
  ready: false,
  availabilitySource: '',
  credentialState: 'unknown',
  ...overrides,
})

describe('Provider settings model', () => {
  it('normalizes missing and legacy single-profile statuses without exposing mutable defaults', () => {
    expect(providerStatusFor({}, 'codex')).toBe(EMPTY_PROVIDER_STATUS)
    expect(providerProfilesFor({}, 'codex')).toEqual({})

    const status = {
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'model-1',
      activePreset: 'openrouter',
      configured: true,
    }
    expect(providerProfilesFor({ codex: status }, 'codex')).toEqual({
      openrouter: {
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'model-1',
        configured: true,
      },
    })
    expect(activeSavedProviderPreset({ codex: status }, 'codex')).toBe('openrouter')
  })

  it('keeps native readiness restricted to verified local evidence', () => {
    expect(nativeProviderReady(agent({ ready: true, availabilitySource: 'native-cli' }))).toBe(true)
    expect(nativeProviderReady(agent({ ready: true, availabilitySource: 'native-shell' }))).toBe(true)
    expect(nativeProviderReady(agent({ ready: true, availabilitySource: 'provider-profile' }))).toBe(false)
    expect(supportsExternalProvider(agent())).toBe(true)
    expect(supportsExternalProvider({ kind: 'custom-0123456789abcdef' })).toBe(false)
  })

  it('resolves Provider card states in the original priority order', () => {
    const states = [
      providerAgentState({ agents: [], checking: true, kind: 'codex', statuses: {}, t }),
      providerAgentState({ agents: [agent()], checking: true, kind: 'codex', statuses: {}, t }),
      providerAgentState({ agents: [agent()], checking: false, kind: 'codex', statuses: { codex: { error: true } }, t }),
      providerAgentState({
        agents: [agent()],
        checking: false,
        kind: 'codex',
        statuses: { codex: { activePreset: 'custom', configured: true, profiles: { custom: { configured: true } } } },
        t,
      }),
      providerAgentState({
        agents: [agent({ ready: true, availabilitySource: 'verified-run' })],
        checking: false,
        kind: 'codex',
        statuses: { codex: { configured: false } },
        t,
      }),
      providerAgentState({
        agents: [agent({ credentialState: 'missing' })],
        checking: false,
        kind: 'codex',
        statuses: { codex: { configured: false } },
        t,
      }),
      providerAgentState({ agents: [agent()], checking: false, kind: 'codex', statuses: { codex: {} }, t }),
    ]

    expect(states.map(state => state.id)).toEqual([
      'not-installed',
      'checking',
      'unavailable',
      'active-override',
      'native-ready',
      'login-required',
      'unverified',
    ])
  })

  it('derives active sources and summary labels from the same normalized status', () => {
    const native = agent({ ready: true, availabilitySource: 'native-auth-status' })
    expect(providerActiveSourceFor([native], { codex: { configured: false } }, 'codex')).toBe('official')
    expect(providerSummaryLabel({ agent: native, statuses: { codex: { configured: false } }, t }))
      .toBe('provider.nativeReady:{}')

    const status = { activePreset: 'openrouter', configured: true, profiles: { openrouter: { configured: true } } }
    expect(providerActiveSourceFor([native], { codex: status }, 'codex')).toBe('openrouter')
    expect(providerSummaryLabel({ agent: native, statuses: { codex: status }, t }))
      .toBe('provider.configured:{}')
  })
})
