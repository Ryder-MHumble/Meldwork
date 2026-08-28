<template>
  <span class="text-morph" aria-live="polite" aria-atomic="true">
    <Transition name="text-morph-swap" mode="out-in">
      <span :key="currentWord" class="text-morph-word">{{ currentWord }}</span>
    </Transition>
  </span>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps({
  intervalMs: { type: Number, default: 2200 },
  words: { type: Array, default: () => [] },
})

const index = ref(0)
let timer = null

const normalizedWords = computed(() => (
  Array.isArray(props.words)
    ? props.words.map(value => String(value || '').trim()).filter(Boolean)
    : []
))

const currentWord = computed(() => {
  const words = normalizedWords.value
  if (!words.length) return ''
  return words[index.value % words.length]
})

function clearTimer() {
  if (timer) clearInterval(timer)
  timer = null
}

function syncTimer() {
  clearTimer()
  index.value = 0
  const words = normalizedWords.value
  if (typeof window === 'undefined' || words.length < 2) return
  if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

  timer = window.setInterval(() => {
    index.value = (index.value + 1) % words.length
  }, Math.max(800, props.intervalMs))
}

watch([normalizedWords, () => props.intervalMs], syncTimer, { immediate: true })

onBeforeUnmount(clearTimer)
</script>

<style scoped>
.text-morph {
  position: relative;
  display: inline-grid;
  place-items: center;
  overflow: hidden;
  min-width: 7.5em;
  height: 1.5em;
  color: inherit;
  line-height: 1;
}

.text-morph-word {
  grid-area: 1 / 1;
  white-space: nowrap;
}

.text-morph-swap-enter-active,
.text-morph-swap-leave-active {
  transition: opacity 0.35s ease, transform 0.35s ease;
}

.text-morph-swap-enter-from {
  opacity: 0;
  transform: translateY(16px);
}

.text-morph-swap-leave-to {
  opacity: 0;
  transform: translateY(-16px);
}
</style>
