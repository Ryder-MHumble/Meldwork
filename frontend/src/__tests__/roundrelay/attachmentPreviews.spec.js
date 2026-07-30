import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { useAttachmentPreviews } from '../../composables/useAttachmentPreviews.js'

function attachment(id) {
  return { id, name: `${id}.png`, mimeType: 'image/png', size: 3 }
}

function preview(id) {
  return { ...attachment(id), previewDataUrl: `data:image/png;base64,${id}` }
}

function normalize(value) {
  return value?.id && value?.previewDataUrl ? value : null
}

function deferred() {
  let resolve
  const promise = new Promise(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

function mountHarness(options) {
  let previews
  const wrapper = mount(defineComponent({
    setup() {
      previews = useAttachmentPreviews(options)
      return () => h('div')
    },
  }))
  return { wrapper, previews }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('attachment preview lifecycle', () => {
  it('loads only visible previews and limits main-process requests to two at a time', async () => {
    let observerCallback
    const gates = [deferred(), deferred(), deferred()]
    const api = {
      preview: vi.fn(id => gates[Number(id.slice(-1)) - 1].promise),
    }
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback) { observerCallback = callback }
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    const { wrapper, previews } = mountHarness({ api: () => api, normalize })
    const elements = [1, 2, 3].map(() => document.createElement('figure'))
    elements.forEach((element, index) => {
      previews.vAttachmentPreview.mounted(element, { value: attachment(`image-${index + 1}`) })
    })

    expect(api.preview).not.toHaveBeenCalled()
    observerCallback(elements.map(element => ({ target: element, isIntersecting: true })))
    await flushPromises()
    expect(api.preview.mock.calls.map(call => call[0])).toEqual(['image-1', 'image-2'])

    gates[0].resolve(preview('image-1'))
    await flushPromises()
    expect(api.preview.mock.calls.map(call => call[0])).toEqual(['image-1', 'image-2', 'image-3'])

    gates[1].resolve(preview('image-2'))
    gates[2].resolve(preview('image-3'))
    await flushPromises()
    wrapper.unmount()
  })

  it('evicts the least-recently-loaded preview once the cache reaches its bound', async () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const api = { preview: vi.fn(async id => preview(id)) }
    const { wrapper, previews } = mountHarness({
      api: () => api,
      normalize,
      maxEntries: 2,
    })
    for (const id of ['image-1', 'image-2', 'image-3']) {
      previews.vAttachmentPreview.mounted(document.createElement('figure'), {
        value: attachment(id),
      })
    }
    await flushPromises()

    expect(previews.attachmentPreviewUrl(attachment('image-1'))).toBe('')
    expect(previews.attachmentPreviewUrl(attachment('image-2'))).toContain('image-2')
    expect(previews.attachmentPreviewUrl(attachment('image-3'))).toContain('image-3')
    wrapper.unmount()
  })

  it('retries one transient preview failure and keeps the same public result', async () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const api = {
      preview: vi.fn()
        .mockRejectedValueOnce(new Error('temporary read failure'))
        .mockResolvedValueOnce(preview('image-retry')),
    }
    const { wrapper, previews } = mountHarness({ api: () => api, normalize })

    await expect(previews.loadAttachmentPreview(attachment('image-retry')))
      .resolves.toContain('image-retry')
    expect(api.preview).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('stops after one retry when preview loading keeps failing', async () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const api = { preview: vi.fn().mockRejectedValue(new Error('unavailable')) }
    const { wrapper, previews } = mountHarness({ api: () => api, normalize })

    await expect(previews.loadAttachmentPreview(attachment('image-fail'))).resolves.toBe('')
    expect(api.preview).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('does not restore a forgotten in-flight preview and clears its tombstone afterward', async () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const gate = deferred()
    const api = { preview: vi.fn(() => gate.promise) }
    const { wrapper, previews } = mountHarness({ api: () => api, normalize })

    const loading = previews.loadAttachmentPreview(attachment('image-forgotten'))
    await flushPromises()
    previews.forgetAttachmentPreviews(['image-forgotten'])
    gate.resolve(preview('image-forgotten'))

    await expect(loading).resolves.toBe('')
    expect(previews.attachmentPreviewUrl(attachment('image-forgotten'))).toBe('')
    expect(previews.rememberAttachmentPreview(preview('image-forgotten'))).toContain('image-forgotten')
    wrapper.unmount()
  })

  it('bounds forgotten-preview tombstones by evicting the oldest entries', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const { wrapper, previews } = mountHarness({ api: () => null, normalize })
    const ids = Array.from({ length: 65 }, (_, index) => `image-${index + 1}`)

    previews.forgetAttachmentPreviews(ids)

    expect(previews.rememberAttachmentPreview(preview(ids[0]))).toContain(ids[0])
    expect(previews.rememberAttachmentPreview(preview(ids.at(-1)))).toBe('')
    wrapper.unmount()
  })
})
