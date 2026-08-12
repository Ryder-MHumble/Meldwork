import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLocale } from '../../i18n.js'
import { mountApp } from './app-test-harness.js'

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('roundrelay-onboarding-seen-v1', '1')
  setLocale('en')
})

afterEach(() => {
  delete window.roundrelayDesktop
  document.body.innerHTML = ''
})

describe('Unlimited-round review mode', () => {
  it('explains strict peer review in the confirmation and composer', async () => {
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
    })

    await wrapper.get('.conversation-link').trigger('click')
    await wrapper.get('.round-settings-trigger').trigger('click')
    await wrapper.get('.round-unlimited-button').trigger('click')
    await flushPromises()

    expect(wrapper.get('.confirmation-modal-body').text()).toContain('strict peer review')
    expect(wrapper.get('.confirmation-modal-body').text()).toContain('independently verify claims')

    await wrapper.get('.confirmation-modal-footer .primary-button').trigger('click')
    await flushPromises()

    expect(wrapper.get('.round-unlimited-active').text()).toContain('report material defects')
    expect(wrapper.get('.composer-box textarea').attributes('placeholder'))
      .toBe('Message Review with strict peer review enabled')

    await wrapper.get('.round-bounded-button').trigger('click')
    await flushPromises()

    expect(wrapper.get('.composer-box textarea').attributes('placeholder')).toBe('Message Review')
    wrapper.unmount()
  })
})
