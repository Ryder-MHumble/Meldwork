import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGENTS, publicAsset } from '../../catalog.js'

describe('renderer security policy', () => {
  it('keeps a restrictive content security policy in the shared entry point', () => {
    const indexPath = resolve(process.cwd(), 'index.html')
    const source = readFileSync(indexPath, 'utf8')

    expect(source).toContain('http-equiv="Content-Security-Policy"')
    expect(source).toContain("default-src 'self'")
    expect(source).toContain("connect-src 'self'")
    expect(source).toContain("object-src 'none'")
    expect(source).toContain("frame-src 'none'")
    expect(source).toContain("base-uri 'none'")
    expect(source).toContain("form-action 'none'")
  })

  it('does not expose a PWA product surface for the desktop-only application', () => {
    const indexSource = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')
    const viteSource = readFileSync(resolve(process.cwd(), 'vite.config.js'), 'utf8')
    const packageSource = readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')

    expect(indexSource).not.toContain('apple-touch-icon')
    expect(indexSource).not.toContain('manifest')
    expect(viteSource).not.toContain('VitePWA')
    expect(packageSource).not.toContain('vite-plugin-pwa')
  })

  it('keeps public asset URLs relative for file-based Electron builds', () => {
    const indexSource = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')
    expect(publicAsset('logos/meldwork-mark.svg')).toBe('./logos/meldwork-mark.svg')
    expect(indexSource).toContain('href="./logos/meldwork-favicon-16.png"')
    expect(indexSource).toContain('href="./logos/meldwork-favicon-32.png"')
    expect(indexSource).toContain('href="./logos/meldwork-favicon.png"')
    expect(AGENTS.every(agent => agent.logo.startsWith('./agent-logos/'))).toBe(true)
    expect(AGENTS.some(agent => agent.kind === 'mimo')).toBe(true)
    expect(AGENTS.at(-1)?.kind).toBe('qwen')

    const mimoSource = readFileSync(resolve(process.cwd(), 'public/agent-logos/mimo.svg'), 'utf8')
    const openCodeSource = readFileSync(resolve(process.cwd(), 'public/agent-logos/opencode.svg'), 'utf8')
    expect(mimoSource).toContain('data-brand="mimocode"')
    expect(mimoSource).toContain('#FF7F45')
    expect(mimoSource).not.toBe(openCodeSource)

    const appSource = readFileSync(resolve(process.cwd(), 'src/App.vue'), 'utf8')
    const catalogSource = readFileSync(resolve(process.cwd(), 'src/catalog.js'), 'utf8')
    expect(appSource).not.toMatch(/['"]\/logos\//)
    expect(catalogSource).not.toMatch(/['"]\/agent-logos\//)
  })
})
