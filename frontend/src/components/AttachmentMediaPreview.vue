<template>
  <Teleport to="body">
    <div
      ref="backdrop"
      class="attachment-media-preview-backdrop"
      role="presentation"
      @click.self="close"
    >
      <section
        class="attachment-media-preview-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="attachment.name"
      >
        <button
          ref="closeButton"
          class="attachment-media-preview-close"
          type="button"
          :aria-label="closeLabel"
          :title="closeLabel"
          @click="close"
        >
          <span aria-hidden="true">×</span>
        </button>
        <img
          v-if="type === 'image'"
          :src="source"
          :alt="attachment.name"
        />
        <video
          v-else
          :src="source"
          :aria-label="attachment.name"
          controls
          autoplay
          playsinline
          preload="auto"
        />
      </section>
    </div>
  </Teleport>
</template>

<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps({
  attachment: { type: Object, required: true },
  closeLabel: { type: String, required: true },
  source: { type: String, required: true },
  type: { type: String, required: true },
})
const emit = defineEmits(['close'])

const backdrop = ref(null)
const closeButton = ref(null)
let returnFocus = null

function close() {
  emit('close')
}

function handleKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
    return
  }
  if (event.key !== 'Tab') return
  event.preventDefault()
  closeButton.value?.focus()
}

onMounted(() => {
  const active = document.activeElement
  returnFocus = active instanceof HTMLElement ? active : null
  document.body.classList.add('media-preview-open')
  window.addEventListener('keydown', handleKeydown)
  void nextTick(() => closeButton.value?.focus())
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown)
  document.body.classList.remove('media-preview-open')
  void nextTick(() => {
    if (returnFocus?.isConnected) returnFocus.focus()
  })
})
</script>

<style>
body.media-preview-open {
  overflow: hidden;
}

.attachment-media-preview-backdrop {
  position: fixed;
  z-index: 1000;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgb(10 14 20 / 78%);
}

.attachment-media-preview-dialog {
  position: relative;
  display: grid;
  max-width: min(1100px, 100%);
  max-height: 100%;
  place-items: center;
}

.attachment-media-preview-dialog img,
.attachment-media-preview-dialog video {
  display: block;
  max-width: 100%;
  max-height: calc(100vh - 48px);
  background: #080b10;
  object-fit: contain;
}

.attachment-media-preview-dialog img {
  width: auto;
  height: auto;
}

.attachment-media-preview-dialog video {
  width: min(1100px, calc(100vw - 48px));
}

.attachment-media-preview-close {
  position: absolute;
  z-index: 1;
  top: 10px;
  right: 10px;
  width: 34px;
  height: 34px;
  border: 0;
  border-radius: 50%;
  background: rgb(0 0 0 / 62%);
  color: #fff;
  cursor: pointer;
  font-size: 28px;
  line-height: 28px;
}

.attachment-media-preview-close:hover,
.attachment-media-preview-close:focus-visible {
  background: rgb(0 0 0 / 82%);
}

@media (max-width: 640px) {
  .attachment-media-preview-backdrop { padding: 12px; }
  .attachment-media-preview-dialog video { width: calc(100vw - 24px); }
  .attachment-media-preview-dialog img,
  .attachment-media-preview-dialog video { max-height: calc(100vh - 24px); }
}
</style>
