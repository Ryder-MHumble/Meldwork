import DOMPurify from 'dompurify'
import { marked } from 'marked'

export function renderMarkdown(content, mentionProfiles = []) {
  const html = DOMPurify.sanitize(marked.parse(String(content || ''), { breaks: true, gfm: true }))
  if (!mentionProfiles.length) return html
  const aliases = mentionProfiles.flatMap(({ kind, label }) => (
    [...new Set([kind, label, String(label || '').replace(/\s+(?:code|cli|agent)$/iu, '')])]
      .filter(Boolean).map(alias => ({ kind, alias }))
  )).sort((left, right) => right.alias.length - left.alias.length)
  if (!aliases.length) return html
  const pattern = new RegExp(`(^|[^A-Za-z0-9_@/\\\\])@(${aliases.map(({ alias }) => (
    alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  )).join('|')})(?![A-Za-z0-9_/-]|\\.[A-Za-z0-9])`, 'giu')
  const fragment = DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true })
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT)
  const nodes = []
  while (walker.nextNode()) {
    if (!walker.currentNode.parentElement?.closest('a, code, pre, blockquote')) nodes.push(walker.currentNode)
  }
  for (const node of nodes) {
    const text = node.textContent
    const matches = [...text.matchAll(pattern)]
    if (!matches.length) continue
    const replacement = document.createDocumentFragment()
    let cursor = 0
    for (const match of matches) {
      const start = match.index + match[1].length
      replacement.append(document.createTextNode(text.slice(cursor, start)))
      const mention = document.createElement('span')
      mention.className = 'agent-inline-mention'
      mention.dataset.agentKind = aliases.find(({ alias }) => alias.toLowerCase() === match[2].toLowerCase()).kind
      mention.textContent = `@${match[2]}`
      replacement.append(mention)
      cursor = start + match[2].length + 1
    }
    replacement.append(document.createTextNode(text.slice(cursor)))
    node.replaceWith(replacement)
  }
  const container = document.createElement('div')
  container.append(fragment)
  return container.innerHTML
}
