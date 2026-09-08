import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MarkdownMessage from '../../components/MarkdownMessage.vue'
import { renderMarkdown } from '../../markdown.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Markdown messages', () => {
  const mentionProfiles = [
    { kind: 'claude', label: 'Claude Code' },
    { kind: 'pi', label: 'Pi Agent' },
  ]

  it('highlights group Agent mentions in prose without moving them to a footer', async () => {
    const wrapper = mount(MarkdownMessage, {
      props: { content: '方案已确定，@Claude Code 请核对。随后请 **@pi** 评审。继续执行。', mentionProfiles },
    })
    expect(wrapper.findAll('.agent-inline-mention').map(node => node.text()))
      .toEqual(['@Claude Code', '@pi'])
    expect(wrapper.get('[data-agent-kind="claude"]').text()).toBe('@Claude Code')
    expect(wrapper.text()).toBe('方案已确定，@Claude Code 请核对。随后请 @pi 评审。继续执行。')
    await wrapper.setProps({ content: '请 @Pi Agent 继续。' })
    expect(wrapper.get('.agent-inline-mention').text()).toBe('@Pi Agent')
  })

  it('does not decorate code, quotes, links, email, partial names or nonmembers', () => {
    const content = '`@pi`\n\n```text\n@claude\n```\n\n> @pi\n\n[@pi](https://example.com/@pi) user@pi.dev @pilot @unknown /@pi @pi.'
    const wrapper = mount(MarkdownMessage, { props: { content, mentionProfiles } })
    expect(wrapper.findAll('.agent-inline-mention').map(node => node.text())).toEqual(['@pi'])
    expect(wrapper.get('a').attributes('href')).toBe('https://example.com/@pi')
  })

  it('keeps mention labels as text and sanitizes HTML when decorating mentions', () => {
    const html = renderMarkdown('@pi <img src=x onerror=alert(1)>', mentionProfiles)
    expect(html).toContain('agent-inline-mention')
    expect(html).not.toContain('onerror')
    expect(renderMarkdown('@pi')).not.toContain('agent-inline-mention')
  })

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
