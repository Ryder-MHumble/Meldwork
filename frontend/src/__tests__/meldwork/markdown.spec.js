import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MarkdownMessage from '../../components/MarkdownMessage.vue'
import { renderMarkdown } from '../../markdown.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Markdown messages', () => {
  it('renders ordinary GitHub-flavored Markdown through the message component', () => {
    const content = '**Decision**\n\n- Keep the local workflow\n- Add a focused test'
    const html = renderMarkdown(content)

    expect(html).toContain('<strong>Decision</strong>')
    expect(html).toContain('<li>Keep the local workflow</li>')

    const wrapper = mount(MarkdownMessage, { props: { content } })
    expect(wrapper.classes()).toEqual(expect.arrayContaining(['message-content', 'markdown-body']))
    expect(wrapper.get('strong').text()).toBe('Decision')
    expect(wrapper.findAll('li').map(item => item.text()))
      .toEqual(['Keep the local workflow', 'Add a focused test'])
  })

  it('removes executable HTML and unsafe link protocols', () => {
    const content = [
      '<img src="x" onerror="alert(1)">',
      '<script>alert(2)</script>',
      '<a href="javascript:alert(3)">unsafe</a>',
    ].join('\n')
    const html = renderMarkdown(content)

    expect(html).not.toContain('onerror')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('javascript:')

    const wrapper = mount(MarkdownMessage, { props: { content } })
    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.get('img').attributes('onerror')).toBeUndefined()
    expect(wrapper.get('a').attributes('href')).toBeUndefined()
  })

  it('adds a copy action to fenced code blocks', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const wrapper = mount(MarkdownMessage, {
      props: { content: '```js\nconst answer = 42\n```' },
    })
    await wrapper.vm.$nextTick()

    const button = wrapper.get('.code-copy-button')
    expect(button.attributes('aria-label')).toBeTruthy()
    await button.trigger('click')
    expect(writeText).toHaveBeenCalledWith('const answer = 42\n')
    expect(button.find('svg').exists()).toBe(true)
  })
})
