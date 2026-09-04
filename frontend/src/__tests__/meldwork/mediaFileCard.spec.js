import { describe, expect, it } from 'vitest'
import {
  activeMediaGenerationForRun,
  fileCardIconKey,
  formatFileCardSize,
  mediaGenerationFromRunEvents,
} from '../../mediaFileCard.js'

describe('file card icon mapping', () => {
  it('maps document extensions to Ant Design X preset icons', () => {
    expect(fileCardIconKey({ name: 'report.pdf' })).toBe('pdf')
    expect(fileCardIconKey({ name: 'sheet.xlsx' })).toBe('excel')
    expect(fileCardIconKey({ name: 'slides.pptx' })).toBe('ppt')
    expect(fileCardIconKey({ name: 'memo.docx' })).toBe('word')
    expect(fileCardIconKey({ name: 'bundle.zip' })).toBe('zip')
    expect(fileCardIconKey({ name: 'notes.md' })).toBe('markdown')
    expect(fileCardIconKey({ name: 'server.ts' })).toBe('default')
  })

  it('prefers explicit media kinds and falls back to mime types', () => {
    expect(fileCardIconKey({ name: 'blob', kind: 'video' })).toBe('video')
    expect(fileCardIconKey({ name: 'blob', mimeType: 'audio/mpeg' })).toBe('audio')
    expect(fileCardIconKey({ name: 'blob', mimeType: 'image/png' })).toBe('image')
    expect(fileCardIconKey({ name: 'unknown' })).toBe('default')
  })

  it('formats sizes the way the FileCard description does', () => {
    expect(formatFileCardSize(0)).toBe('0 B')
    expect(formatFileCardSize(512)).toBe('512 B')
    expect(formatFileCardSize(2048)).toBe('2 KB')
    expect(formatFileCardSize(5 * 1024 * 1024)).toBe('5 MB')
  })
})

describe('media generation process state', () => {
  it('reports the running phase while a generation event is active', () => {
    const activity = mediaGenerationFromRunEvents([
      { title: 'image_generation', status: 'running', summary: 'Generating image' },
    ])
    expect(activity).toEqual({ type: 'image', status: 'running', phase: 'running' })
  })

  it('reports the complete phase once the generation event completes', () => {
    const activity = mediaGenerationFromRunEvents([
      { title: 'video_generation', status: 'running', summary: 'Generating video: 42%' },
      { title: 'video_generation', status: 'completed', summary: 'generated-video-1.mp4' },
    ])
    expect(activity).toEqual({ type: 'video', status: 'completed', phase: 'complete' })
  })

  it('drops failed generations so no stuck card renders', () => {
    expect(mediaGenerationFromRunEvents([
      { title: 'image_generation', status: 'failed' },
    ])).toBeNull()
  })

  it('ignores unrelated trace events', () => {
    expect(mediaGenerationFromRunEvents([
      { title: 'tool_call', status: 'running' },
      { title: 'plan_update', status: 'completed' },
    ])).toBeNull()
  })

  it('skips agent runs that already finished', () => {
    const activity = activeMediaGenerationForRun([
      { kind: 'codex', status: 'completed', events: [{ title: 'image_generation', status: 'running' }] },
      { kind: 'codex', status: 'running', events: [{ title: 'image_generation', status: 'running' }] },
    ])
    expect(activity.phase).toBe('running')
    expect(activity.agentKind).toBe('codex')
  })

  it('returns null when every run is terminal', () => {
    expect(activeMediaGenerationForRun([
      { kind: 'codex', status: 'failed', events: [{ title: 'image_generation', status: 'running' }] },
    ])).toBeNull()
    expect(activeMediaGenerationForRun([])).toBeNull()
  })
})
