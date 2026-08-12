<template>
  <div ref="root" class="message-content markdown-body" v-html="html" />
</template>

<script setup>
import { computed, h, nextTick, onBeforeUnmount, ref, render, watch } from 'vue'
import { CheckmarkOutline, CopyOutline } from '@vicons/ionicons5'
import { locale, t } from '../i18n.js'
import { renderMarkdown } from '../markdown.js'

const props = defineProps({
  content: {
    type: String,
    default: '',
  },
})

const html = computed(() => renderMarkdown(props.content))
const root = ref(null)
const cleanupCallbacks = []
const copyResetTimers = new Set()

function clearCodeCopyControls() {
  while (cleanupCallbacks.length) cleanupCallbacks.pop()()
  for (const timer of copyResetTimers) clearTimeout(timer)
  copyResetTimers.clear()
}

function fallbackCopyText(content) {
  if (!document.body || typeof document.execCommand !== 'function') return false
  const textarea = document.createElement('textarea')
  textarea.value = content
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.top = '-1000px'
  document.body.appendChild(textarea)
  textarea.select()
  let copied = false
  try { copied = document.execCommand('copy') } catch { copied = false }
  textarea.remove()
  return copied
}

async function copyCode(button, iconHost, content) {
  let copied = false
  try {
    if (typeof navigator.clipboard?.writeText === 'function') {
      await navigator.clipboard.writeText(content)
      copied = true
    }
  } catch { copied = false }
  if (!copied) copied = fallbackCopyText(content)
  if (!copied) return
  const copiedLabel = t('conversation.copied')
  button.dataset.tooltip = copiedLabel
  button.setAttribute('aria-label', copiedLabel)
  render(h(CheckmarkOutline), iconHost)
  const timer = setTimeout(() => {
    const copyLabel = t('conversation.copyCode')
    button.dataset.tooltip = copyLabel
    button.setAttribute('aria-label', copyLabel)
    render(h(CopyOutline), iconHost)
    copyResetTimers.delete(timer)
  }, 1500)
  copyResetTimers.add(timer)
}

async function mountCodeCopyControls() {
  await nextTick()
  clearCodeCopyControls()
  for (const pre of root.value?.querySelectorAll('pre') || []) {
    const code = pre.querySelector('code')
    if (!code) continue
    const button = document.createElement('button')
    const iconHost = document.createElement('span')
    const label = t('conversation.copyCode')
    button.type = 'button'
    button.className = 'code-copy-button'
    button.dataset.tooltip = label
    button.setAttribute('aria-label', label)
    button.appendChild(iconHost)
    render(h(CopyOutline), iconHost)
    const handleClick = event => {
      event.stopPropagation()
      void copyCode(button, iconHost, code.textContent || '')
    }
    button.addEventListener('click', handleClick)
    pre.appendChild(button)
    cleanupCallbacks.push(() => {
      button.removeEventListener('click', handleClick)
      render(null, iconHost)
      button.remove()
    })
  }
}

watch([html, root, locale], mountCodeCopyControls, { immediate: true, flush: 'post' })
onBeforeUnmount(clearCodeCopyControls)
</script>
