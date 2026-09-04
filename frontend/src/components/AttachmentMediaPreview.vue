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
        :class="[{ 'is-zoomed': zoomed }, `is-${type}`]"
        role="dialog"
        aria-modal="true"
        :aria-label="attachment.name"
      >
        <div class="attachment-media-preview-toolbar">
          <button
            v-if="canZoom"
            type="button"
            class="attachment-media-preview-action"
            :title="zoomed ? zoomOutLabel : zoomInLabel"
            :aria-label="zoomed ? zoomOutLabel : zoomInLabel"
            :aria-pressed="zoomed ? 'true' : 'false'"
            @click="zoomed = !zoomed"
          >
            <RemoveOutline v-if="zoomed" aria-hidden="true" />
            <SearchOutline v-else aria-hidden="true" />
          </button>
          <button
            type="button"
            class="attachment-media-preview-action"
            :title="downloadLabel"
            :aria-label="downloadLabel"
            @click="emit('save')"
          >
            <DownloadOutline aria-hidden="true" />
          </button>
          <button
            ref="closeButton"
            type="button"
            class="attachment-media-preview-action"
            :aria-label="closeLabel"
            :title="closeLabel"
            @click="close"
          >
            <CloseOutline aria-hidden="true" />
          </button>
        </div>
        <template v-if="type === 'audio'">
          <div class="attachment-media-preview-audio-card">
            <FileTypeIcon icon-key="audio" class="attachment-media-preview-audio-icon" />
            <span class="attachment-media-preview-audio-copy">
              <strong :title="attachment.name">{{ attachment.name }}</strong>
              <small>{{ formatFileCardSize(attachment.size) }}</small>
            </span>
          </div>
          <audio
            :src="source"
            :aria-label="attachment.name"
            controls
            preload="auto"
          />
        </template>
        <img
          v-else-if="type === 'image'"
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
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { CloseOutline, DownloadOutline, RemoveOutline, SearchOutline } from '@vicons/ionicons5'
import FileTypeIcon from './FileTypeIcon.vue'
import { formatFileCardSize } from '../mediaFileCard.js'

const props = defineProps({
  attachment: { type: Object, required: true },
  closeLabel: { type: String, required: true },
  downloadLabel: { type: String, required: true },
  zoomInLabel: { type: String, default: '' },
  zoomOutLabel: { type: String, default: '' },
  source: { type: String, required: true },
  type: { type: String, required: true },
})
const emit = defineEmits(['close', 'save'])

const backdrop = ref(null)
const closeButton = ref(null)
const zoomed = ref(false)
let returnFocus = null

const canZoom = computed(() => ['image', 'video'].includes(props.type))

function close() {
  emit('close')
}

function focusableElements() {
  const root = backdrop.value
  if (!root) return []
  return [...root.querySelectorAll('button, video, audio')]
    .filter(element => element instanceof HTMLElement)
}

function handleKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
    return
  }
  if (event.key !== 'Tab') return
  const elements = focusableElements()
  if (!elements.length) return
  event.preventDefault()
  const current = document.activeElement
  const index = elements.indexOf(current)
  if (event.shiftKey) {
    const previous = index <= 0 ? elements.length - 1 : index - 1
    elements[previous]?.focus()
    return
  }
  const next = index < 0 || index >= elements.length - 1 ? 0 : index + 1
  elements[next]?.focus()
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
  gap: 10px;
  max-width: min(1100px, 100%);
  max-height: 100%;
  place-items: center;
}

.attachment-media-preview-toolbar {
  position: absolute;
  z-index: 2;
  top: 10px;
  right: 10px;
  display: flex;
  gap: 6px;
}

.attachment-media-preview-action {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: rgb(0 0 0 / 62%);
  color: #fff;
  cursor: pointer;
}

.attachment-media-preview-action svg {
  width: 17px;
  height: 17px;
}

.attachment-media-preview-action:hover,
.attachment-media-preview-action:focus-visible {
  background: rgb(0 0 0 / 82%);
}

.attachment-media-preview-dialog img,
.attachment-media-preview-dialog video {
  display: block;
  max-width: min(1100px, calc(100vw - 48px));
  max-height: calc(100vh - 48px);
  background: #080b10;
  border-radius: 10px;
  object-fit: contain;
  transition: max-width 0.22s ease, max-height 0.22s ease;
}

.attachment-media-preview-dialog.is-zoomed img,
.attachment-media-preview-dialog.is-zoomed video {
  max-width: calc(100vw - 24px);
  max-height: calc(100vh - 24px);
}

.attachment-media-preview-dialog img {
  width: auto;
  height: auto;
}

.attachment-media-preview-dialog video {
  width: min(1100px, calc(100vw - 48px));
}

.attachment-media-preview-dialog.is-zoomed video {
  width: calc(100vw - 24px);
}

.attachment-media-preview-dialog.is-audio {
  width: min(430px, 100%);
  padding: 52px 16px 16px;
  border-radius: 14px;
  background: rgb(14 18 24 / 92%);
}

.attachment-media-preview-audio-card {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgb(255 255 255 / 7%);
}

.attachment-media-preview-audio-icon {
  width: 30px;
  height: 30px;
}

.attachment-media-preview-audio-copy {
  min-width: 0;
  display: grid;
  gap: 2px;
  color: #fff;
}

.attachment-media-preview-audio-copy strong,
.attachment-media-preview-audio-copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attachment-media-preview-audio-copy strong {
  font-size: 13px;
  font-weight: 650;
}

.attachment-media-preview-audio-copy small {
  color: rgb(255 255 255 / 64%);
  font-size: 11px;
}

.attachment-media-preview-dialog audio {
  width: 100%;
  display: block;
}

@media (max-width: 640px) {
  .attachment-media-preview-backdrop { padding: 12px; }
  .attachment-media-preview-dialog video { width: calc(100vw - 24px); }
  .attachment-media-preview-dialog img,
  .attachment-media-preview-dialog video { max-height: calc(100vh - 24px); }
}
</style>
