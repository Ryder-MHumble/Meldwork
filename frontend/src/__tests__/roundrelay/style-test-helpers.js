import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export const STYLE_FILES = ['base.css', 'workspace.css', 'conversation.css', 'overlays.css', 'responsive.css']

export function readStylesSource(filename = resolve(process.cwd(), 'src/styles.css'), visited = new Set()) {
  const absolutePath = resolve(filename)
  if (visited.has(absolutePath)) return ''
  visited.add(absolutePath)
  const source = readFileSync(absolutePath, 'utf8')
  return source.replace(/@import\s+['"]([^'"]+)['"];\s*/g, (statement, importPath) => {
    if (!importPath.startsWith('.')) return statement
    return readStylesSource(resolve(dirname(absolutePath), importPath), visited)
  })
}
