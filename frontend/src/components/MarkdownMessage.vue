<template>
  <div class="message-content markdown-body" v-html="html" />
</template>

<script setup>
import { computed } from 'vue'
import { renderMarkdown } from '../markdown.js'

const props = defineProps({
  content: {
    type: String,
    default: '',
  },
})

const html = computed(() => renderMarkdown(props.content))
</script>
