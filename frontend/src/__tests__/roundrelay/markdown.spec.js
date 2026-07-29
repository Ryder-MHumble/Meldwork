import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import MarkdownMessage from '../../components/MarkdownMessage.vue'
import { renderMarkdown } from '../../markdown.js'

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
})
