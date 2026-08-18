import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLocale } from '../../i18n.js'
import { mountApp } from './app-test-harness.js'
import { readStylesSource } from './style-test-helpers.js'

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('meldwork-onboarding-seen-v1', '1')
  setLocale('en')
})

afterEach(() => {
  delete window.meldworkDesktop
  document.body.innerHTML = ''
})

describe('Unlimited-round review mode', () => {
  it('keeps the normal composer surface while retaining the infinity cue', () => {
    const styles = readStylesSource()

    expect(styles).not.toMatch(/\.composer-box\.unlimited-mode(?::focus-within)?\s*\{/)
    expect(styles).not.toMatch(/\.composer-box\.unlimited-running\s*\{/)
    expect(styles).not.toContain('@keyframes unlimited-composer-breathe')
    expect(styles).toMatch(/\.composer-box\.unlimited-running \.round-unlimited-symbol\s*\{/)
  })

  it('derives the live infinity cue from the active run instead of the finite composer draft', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-live-unlimited',
        conversationType: 'group',
        name: 'Live unlimited',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      state.runningGroupIds = ['group-live-unlimited']
      state.runs = [{
        runId: 'run-live-unlimited',
        groupId: 'group-live-unlimited',
        mode: 'auto',
        phase: 'running',
        targetKinds: ['codex', 'hermes'],
        completedKinds: [],
        failedKinds: [],
        currentKind: 'codex',
        currentRound: 2,
        maxRounds: 0,
        unlimitedRounds: true,
        agentRuns: [],
      }]
    })

    await wrapper.get('.conversation-link').trigger('click')
    expect(wrapper.get('.composer-box').classes()).toContain('unlimited-mode')
    expect(wrapper.get('.composer-box').classes()).toContain('unlimited-running')
    expect(wrapper.get('.round-settings-trigger').classes()).toContain('unlimited')
    expect(wrapper.get('.round-unlimited-symbol').text()).toBe('∞')
    expect(wrapper.get('.round-settings-trigger').text()).toContain('No round limit')
    wrapper.unmount()
  })

  it('explains strict peer review in the confirmation and composer', async () => {
    const { wrapper, state, emitWorkspaceChanged } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-1',
        conversationType: 'group',
        name: 'Review',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
    })

    await wrapper.get('.conversation-link').trigger('click')
    await wrapper.get('.round-settings-trigger').trigger('click')
    await wrapper.get('.round-unlimited-button').trigger('click')
    await flushPromises()

    expect(wrapper.get('.confirmation-modal-body').text()).toContain('strict peer review')
    expect(wrapper.get('.confirmation-modal-body').text()).toContain('independently verify claims')

    await wrapper.get('.confirmation-modal-footer .primary-button').trigger('click')
    await flushPromises()

    expect(wrapper.get('.composer-box').classes()).toContain('unlimited-mode')
    expect(wrapper.get('.composer-box').classes()).not.toContain('unlimited-running')
    expect(wrapper.get('.round-settings-trigger').classes()).toContain('unlimited')
    expect(wrapper.get('.round-unlimited-symbol').text()).toBe('∞')
    expect(wrapper.get('.round-settings-trigger').text()).toContain('No round limit')
    expect(wrapper.get('.round-unlimited-active').text()).toContain('report material defects')
    expect(wrapper.get('.composer-box textarea').attributes('placeholder'))
      .toBe('Message Review with strict peer review enabled')

    state.runningGroupIds = ['group-1']
    state.runs = [{
      runId: 'run-unlimited',
      groupId: 'group-1',
      mode: 'auto',
      phase: 'running',
      targetKinds: ['codex', 'hermes'],
      completedKinds: [],
      failedKinds: [],
      currentKind: 'codex',
      currentRound: 1,
      maxRounds: 0,
      unlimitedRounds: true,
      agentRuns: [],
    }]
    emitWorkspaceChanged()
    await flushPromises()
    expect(wrapper.get('.composer-box').classes()).toContain('unlimited-mode')
    expect(wrapper.get('.composer-box').classes()).toContain('unlimited-running')
    expect(wrapper.get('.round-settings-trigger').classes()).toContain('unlimited')
    expect(wrapper.get('.round-unlimited-symbol').text()).toBe('∞')
    expect(wrapper.get('.round-unlimited-symbol').attributes('aria-hidden')).toBe('true')

    state.runs[0] = { ...state.runs[0], mode: 'manual' }
    emitWorkspaceChanged()
    await flushPromises()
    expect(wrapper.get('.composer-box').classes()).not.toContain('unlimited-mode')
    expect(wrapper.get('.composer-box').classes()).not.toContain('unlimited-running')
    expect(wrapper.get('.round-settings-trigger').classes()).not.toContain('unlimited')
    expect(wrapper.find('.round-unlimited-symbol').exists()).toBe(false)

    state.runs[0] = { ...state.runs[0], mode: 'auto', phase: 'completed' }
    emitWorkspaceChanged()
    await flushPromises()
    expect(wrapper.get('.composer-box').classes()).not.toContain('unlimited-mode')
    expect(wrapper.get('.composer-box').classes()).not.toContain('unlimited-running')
    expect(wrapper.get('.round-settings-trigger').classes()).not.toContain('unlimited')
    expect(wrapper.find('.round-unlimited-symbol').exists()).toBe(false)

    state.runningGroupIds = []
    state.runs = []
    emitWorkspaceChanged()
    await flushPromises()

    expect(wrapper.get('.composer-box').classes()).toContain('unlimited-mode')
    expect(wrapper.find('.round-unlimited-symbol').exists()).toBe(true)
    await wrapper.get('.round-settings-trigger').trigger('click')
    await wrapper.get('.round-bounded-button').trigger('click')
    await flushPromises()
    expect(wrapper.get('.composer-box').classes()).not.toContain('unlimited-mode')
    expect(wrapper.find('.round-unlimited-symbol').exists()).toBe(false)
    expect(wrapper.get('.composer-box textarea').attributes('placeholder')).toBe('Message Review')
    wrapper.unmount()
  })
})
