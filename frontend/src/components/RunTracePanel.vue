<template>
  <div v-if="open" class="trace-panel-layer" :class="{ drawer }">
    <button
      v-if="drawer"
      class="trace-panel-scrim"
      type="button"
      :aria-label="t('trace.close')"
      @click="emit('close')"
    />

    <aside
      ref="panelElement"
      class="run-trace-panel"
      role="dialog"
      :aria-modal="drawer ? 'true' : undefined"
      :aria-label="t('trace.title')"
      tabindex="-1"
      @keydown.tab="trapFocus"
    >
      <header class="trace-panel-header">
        <div>
          <span class="trace-panel-kicker">{{ t('trace.title') }}</span>
          <strong>{{ selectedItem ? agentLabel(selectedItem.agentKind) : t('trace.noProcess') }}</strong>
        </div>
        <button
          class="icon-button"
          type="button"
          :title="t('trace.close')"
          :aria-label="t('trace.close')"
          @click="emit('close')"
        >
          <CloseOutline />
        </button>
      </header>

      <nav v-if="items.length" class="trace-panel-agent-switch" :aria-label="t('trace.agentRuns')">
        <button
          v-for="item in items"
          :key="item.agentRunId"
          class="trace-agent-tab"
          :class="{ active: item.agentRunId === selectedItem?.agentRunId }"
          type="button"
          :aria-pressed="item.agentRunId === selectedItem?.agentRunId ? 'true' : 'false'"
          @click="emit('select', item.agentRunId)"
        >
          <img :src="agentLogo(item.agentKind, theme)" alt="" />
          <span>
            <strong>{{ agentLabel(item.agentKind) }}</strong>
            <small>{{ roundLabel(item) }} / {{ statusLabel(item.status) }}</small>
          </span>
        </button>
      </nav>

      <p
        class="visually-hidden trace-event-live-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {{ eventLiveStatus }}
      </p>

      <div v-if="selectedItem" class="trace-panel-scroll">
        <section class="trace-panel-summary">
          <div class="trace-panel-summary-heading">
            <div>
              <strong>{{ agentLabel(selectedItem.agentKind) }}</strong>
              <span>{{ roundLabel(selectedItem) }}</span>
            </div>
            <span class="trace-status" :data-status="statusTone(selectedItem.status)">
              {{ statusLabel(selectedItem.status) }}
            </span>
          </div>
          <p v-if="selectedItem.summary" class="trace-summary-copy">{{ selectedItem.summary }}</p>
          <div v-if="selectedItem.output" class="trace-conclusion">
            <span>{{ t('trace.conclusion') }}</span>
            <MarkdownMessage :content="selectedItem.output" />
          </div>
          <div v-if="selectedItem.context && hasContextStats(selectedItem.context)" class="trace-context-stats">
            <span>{{ t('trace.contextIncluded', { count: selectedItem.context.includedCount }) }}</span>
            <span>{{ t('trace.contextOmitted', { count: selectedItem.context.omittedCount }) }}</span>
            <span>{{ t('trace.contextChars', { count: selectedItem.context.charCount }) }}</span>
            <span v-if="selectedItem.context.sessionRotated">{{ t('trace.contextRotated') }}</span>
          </div>
          <p v-if="selectedItem.truncated" class="trace-truncated">{{ t('trace.truncated') }}</p>
        </section>

        <section class="trace-event-section" :aria-label="t('trace.events')">
          <header class="trace-section-heading">
            <strong>{{ t('trace.events') }}</strong>
            <small>{{ filteredEvents(selectedItem).length }}</small>
          </header>
          <ol v-if="filteredEvents(selectedItem).length" class="trace-event-list">
            <li v-for="(event, index) in filteredEvents(selectedItem)" :key="eventKey(event, index)">
              <details>
                <summary>
                  <span class="trace-event-type">{{ eventTypeLabel(event.type) }}</span>
                  <span class="trace-event-title">{{ eventTitle(event) }}</span>
                  <span class="trace-event-status" :data-status="statusTone(event.status)">
                    {{ statusLabel(event.status) }}
                  </span>
                  <ChevronDownOutline />
                </summary>
                <div class="trace-event-body">
                  <p v-if="event.summary">{{ event.summary }}</p>
                  <pre v-if="event.detail">{{ event.detail }}</pre>
                  <small v-if="formatEventTime(event.timestamp)" class="trace-event-time">
                    {{ formatEventTime(event.timestamp) }}
                  </small>
                </div>
              </details>
            </li>
          </ol>
          <p v-else class="trace-empty-state">{{ t('trace.noEvents') }}</p>
        </section>

        <section v-if="selectedSources.length" class="trace-source-section">
          <header class="trace-section-heading">
            <strong>{{ t('trace.sources') }}</strong>
            <small>{{ selectedSources.length }}</small>
          </header>
          <div class="trace-source-list">
            <button
              v-for="source in selectedSources"
              :key="source.id"
              type="button"
              :disabled="!source.available"
              :aria-label="source.label"
              @click="emit('jump-source', source.id)"
            >
              <span>{{ source.label }}</span>
              <ChevronForwardOutline />
            </button>
          </div>
        </section>
      </div>

      <div v-else class="trace-empty-state trace-panel-empty">
        {{ t('trace.noProcess') }}
      </div>
    </aside>
  </div>
</template>

<script setup>
import { computed, nextTick, ref } from 'vue'
import {
  ChevronDownOutline,
  ChevronForwardOutline,
  CloseOutline,
} from '@vicons/ionicons5'
import MarkdownMessage from './MarkdownMessage.vue'
import { agentLabel, agentLogo } from '../catalog.js'
import { locale, t } from '../i18n.js'

const props = defineProps({
  open: { type: Boolean, default: false },
  drawer: { type: Boolean, default: false },
  items: { type: Array, default: () => [] },
  selectedAgentRunId: { type: String, default: '' },
  theme: { type: String, default: 'light' },
})

const emit = defineEmits(['close', 'select', 'jump-source'])
const panelElement = ref(null)
const selectedItem = computed(() => props.items.find(item => item.agentRunId === props.selectedAgentRunId) || props.items.at(-1) || null)
const selectedSources = computed(() => {
  const item = selectedItem.value
  const sources = Array.isArray(item?.sources) ? item.sources : []
  if (sources.length) {
    return sources.map(source => ({
      id: String(source?.id || ''),
      available: source?.available === true && Boolean(source?.label),
      label: String(source?.label || t('trace.sourceUnavailable')),
    })).filter(source => source.id)
  }
  return (Array.isArray(item?.sourceMessageIds) ? item.sourceMessageIds : []).map(id => ({
    id,
    available: false,
    label: t('trace.sourceUnavailable'),
  }))
})
const eventLiveStatus = computed(() => {
  const item = selectedItem.value
  const event = filteredEvents(item).at(-1)
  if (!item || !event) return ''
  return [...new Set([
    agentLabel(item.agentKind),
    eventTypeLabel(event.type),
    eventTitle(event),
    statusLabel(event.status),
  ].filter(Boolean))].join(' / ')
})

function focus() {
  void nextTick(() => panelElement.value?.focus())
}

function trapFocus(event) {
  if (!props.drawer || !panelElement.value) return
  const focusable = [...panelElement.value.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
  )]
  if (!focusable.length) {
    event.preventDefault()
    panelElement.value.focus()
    return
  }
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  const focusOutside = !panelElement.value.contains(document.activeElement)
  if (event.shiftKey && (focusOutside || document.activeElement === first)) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (focusOutside || document.activeElement === last)) {
    event.preventDefault()
    first.focus()
  }
}

function filteredEvents(item) {
  return (Array.isArray(item?.events) ? item.events : []).filter(event => event?.type !== 'answer_delta')
}

function eventKey(event, index) {
  return `${event?.evidenceId || event?.seq || event?.timestamp || 'event'}-${index}`
}

function eventTypeLabel(type) {
  const key = {
    status: 'trace.eventStatus',
    reasoning_summary: 'trace.eventReasoning',
    plan: 'trace.eventPlan',
    tool_start: 'trace.eventToolStart',
    tool_update: 'trace.eventToolUpdate',
    tool_result_summary: 'trace.eventToolResult',
    warning: 'trace.eventWarning',
  }[String(type || '').toLowerCase()] || 'trace.eventOther'
  return t(key)
}

function eventTitle(event) {
  const title = String(event?.title || '').trim()
  if (!title || ['agent', 'waiting_for_output'].includes(title.toLowerCase())) return eventTypeLabel(event?.type)
  return title
}

function statusTone(status) {
  const value = String(status || '').toLowerCase()
  if (['completed', 'succeeded'].includes(value)) return 'completed'
  if (['failed', 'timeout'].includes(value)) return 'failed'
  if (['partial'].includes(value)) return 'partial'
  if (['running', 'in_progress', 'waiting'].includes(value)) return 'running'
  return 'queued'
}

function statusLabel(status) {
  const key = {
    pending: 'pending',
    queued: 'queued',
    preparing: 'preparing',
    running: 'running',
    streaming: 'streaming',
    waiting: 'waiting',
    completed: 'completed',
    succeeded: 'succeeded',
    failed: 'failed',
    partial: 'partial',
    cancelled: 'cancelled',
    stopped: 'stopped',
    timeout: 'timeout',
    interrupted: 'interrupted',
  }[String(status || '').toLowerCase()] || 'unknown'
  return t(`run.status.${key}`)
}

function roundLabel(item) {
  const round = Number(item?.round)
  return Number.isInteger(round) && round > 0 ? t('trace.round', { count: round }) : t('trace.live')
}

function hasContextStats(context) {
  return Number(context?.includedCount) > 0
    || Number(context?.omittedCount) > 0
    || Number(context?.charCount) > 0
    || context?.sessionRotated === true
}

function formatEventTime(value) {
  if (value == null || value === '') return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(locale.value === 'zh' ? 'zh-CN' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date)
}

defineExpose({ focus })
</script>
