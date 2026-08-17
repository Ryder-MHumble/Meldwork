import { onBeforeUnmount, reactive } from 'vue'

const ELEMENT_ATTACHMENT = Symbol('meldworkAttachment')
const MAX_IGNORED_ENTRIES = 64
const PREVIEW_ATTEMPTS = 2

export function useAttachmentPreviews({
  api,
  normalize,
  maxEntries = 32,
  concurrency = 2,
}) {
  const cache = reactive({})
  const order = []
  const visible = new Set()
  const ignored = new Set()
  const ignoredOrder = []
  const cancelledTasks = new Set()
  const tasks = new Map()
  const queue = []
  let activeLoads = 0
  let observer = null
  let stopped = false

  function attachmentId(value) {
    return String(value?.id || '')
  }

  function attachmentPreviewUrl(attachment) {
    const id = attachmentId(attachment)
    return String(attachment?.previewDataUrl || cache[id]?.previewDataUrl || '')
  }

  function touch(id) {
    const index = order.indexOf(id)
    if (index >= 0) order.splice(index, 1)
    order.push(id)
  }

  function clearIgnored(id) {
    if (!ignored.delete(id)) return
    const index = ignoredOrder.indexOf(id)
    if (index >= 0) ignoredOrder.splice(index, 1)
  }

  function markIgnored(id) {
    clearIgnored(id)
    ignored.add(id)
    ignoredOrder.push(id)
    while (ignoredOrder.length > MAX_IGNORED_ENTRIES) {
      ignored.delete(ignoredOrder.shift())
    }
  }

  function evict() {
    while (order.length > maxEntries) {
      const index = order.findIndex(id => !visible.has(id))
      if (index < 0) return
      const [id] = order.splice(index, 1)
      delete cache[id]
    }
  }

  function rememberAttachmentPreview(value) {
    const preview = normalize(value)
    const id = attachmentId(preview)
    if (!id || !preview?.previewDataUrl || ignored.has(id)) return ''
    cache[id] = preview
    touch(id)
    evict()
    return preview.previewDataUrl
  }

  function pumpQueue() {
    while (!stopped && activeLoads < concurrency && queue.length) {
      const item = queue.shift()
      activeLoads += 1
      Promise.resolve().then(async () => {
        for (let attempt = 0; attempt < PREVIEW_ATTEMPTS; attempt += 1) {
          if (stopped || cancelledTasks.has(item.id)) return ''
          try {
            const previewApi = api()
            if (typeof previewApi?.preview !== 'function') return ''
            const preview = await previewApi.preview(item.id)
            if (stopped || cancelledTasks.has(item.id)) return ''
            const previewUrl = rememberAttachmentPreview(preview)
            if (previewUrl || ignored.has(item.id)) return previewUrl
          } catch { /* retry once */ }
        }
        return ''
      }).then(item.resolve).finally(() => {
        activeLoads -= 1
        tasks.delete(item.id)
        if (cancelledTasks.delete(item.id)) clearIgnored(item.id)
        pumpQueue()
      })
    }
  }

  function loadAttachmentPreview(attachment) {
    const id = attachmentId(attachment)
    if (!id) return Promise.resolve('')
    const existing = attachmentPreviewUrl(attachment)
    if (existing) {
      if (cache[id]) touch(id)
      return Promise.resolve(existing)
    }
    if (tasks.has(id)) return tasks.get(id)
    clearIgnored(id)
    const task = new Promise((resolve) => {
      queue.push({ id, resolve })
      pumpQueue()
    })
    tasks.set(id, task)
    return task
  }

  function forgetAttachmentPreviews(values) {
    const ids = [...new Set(values.map(value => (
      String(typeof value === 'string' ? value : value?.id || '')
    )).filter(Boolean))]
    for (const id of ids) {
      markIgnored(id)
      if (tasks.has(id)) cancelledTasks.add(id)
      visible.delete(id)
      delete cache[id]
      const index = order.indexOf(id)
      if (index >= 0) order.splice(index, 1)
    }
  }

  function previewObserver() {
    if (observer || typeof IntersectionObserver !== 'function') return observer
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const attachment = entry.target[ELEMENT_ATTACHMENT]
        const id = attachmentId(attachment)
        if (!id) continue
        if (entry.isIntersecting) {
          visible.add(id)
          void loadAttachmentPreview(attachment)
        } else {
          visible.delete(id)
          evict()
        }
      }
    }, { rootMargin: '160px 0px' })
    return observer
  }

  const vAttachmentPreview = {
    mounted(element, binding) {
      element[ELEMENT_ATTACHMENT] = binding.value
      const nextObserver = previewObserver()
      if (nextObserver) nextObserver.observe(element)
      else void loadAttachmentPreview(binding.value)
    },
    updated(element, binding) {
      element[ELEMENT_ATTACHMENT] = binding.value
      if (!observer) void loadAttachmentPreview(binding.value)
    },
    unmounted(element) {
      const id = attachmentId(element[ELEMENT_ATTACHMENT])
      if (id) visible.delete(id)
      observer?.unobserve(element)
      delete element[ELEMENT_ATTACHMENT]
      evict()
    },
  }

  onBeforeUnmount(() => {
    stopped = true
    observer?.disconnect()
    observer = null
    while (queue.length) queue.shift().resolve('')
    tasks.clear()
    cancelledTasks.clear()
    visible.clear()
    ignored.clear()
    ignoredOrder.length = 0
  })

  return {
    attachmentPreviewUrl,
    forgetAttachmentPreviews,
    loadAttachmentPreview,
    rememberAttachmentPreview,
    vAttachmentPreview,
  }
}
