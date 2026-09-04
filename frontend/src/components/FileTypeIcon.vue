<template>
  <svg
    class="file-type-icon"
    :class="`is-${resolvedKey}`"
    :viewBox="art.viewBox"
    :style="{ color }"
    aria-hidden="true"
    focusable="false"
  >
    <path v-for="(segment, index) in art.paths" :key="index" :d="segment" fill="currentColor" />
  </svg>
</template>

<script setup>
import { computed } from 'vue'
import { fileCardIconArt, fileCardIconColor } from '../mediaFileCard.js'

const props = defineProps({
  iconKey: { type: String, default: 'default' },
  color: { type: String, default: '' },
})

const resolvedKey = computed(() => props.iconKey || 'default')
const art = computed(() => fileCardIconArt(resolvedKey.value))
const color = computed(() => props.color || fileCardIconColor(resolvedKey.value))
</script>

<style>
.file-type-icon {
  display: block;
  width: 1em;
  height: 1em;
  flex: 0 0 auto;
}
</style>
