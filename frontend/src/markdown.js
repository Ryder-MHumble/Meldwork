import DOMPurify from 'dompurify'
import { marked } from 'marked'

export function renderMarkdown(content) {
  return DOMPurify.sanitize(marked.parse(String(content || ''), { breaks: true, gfm: true }))
}
