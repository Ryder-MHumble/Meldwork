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
      @keydown.esc="handlePanelEscape"
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

      <div
        v-if="items.length"
        class="trace-panel-selectors"
        :class="{ 'single-selector': selectedAgentRuns.length <= 1 }"
      >
        <div ref="agentSelector" class="trace-select trace-agent-selector">
          <span class="trace-select-label">{{ t('trace.agentSelector') }}</span>
          <button
            ref="agentSelectTrigger"
            class="trace-select-trigger"
            type="button"
            :disabled="agentGroups.length <= 1"
            :aria-expanded="String(openSelector === 'agent')"
            :aria-haspopup="agentGroups.length > 1 ? 'listbox' : undefined"
            :aria-label="t('trace.selectAgent')"
            @click="toggleSelector('agent')"
            @keydown.down.prevent="openSelectorMenu('agent')"
          >
            <img v-if="selectedItem" :src="agentLogo(selectedItem.agentKind, theme)" alt="" />
            <span>
              <strong>{{ selectedItem ? agentLabel(selectedItem.agentKind) : t('trace.noProcess') }}</strong>
              <small v-if="selectedItem">{{ roundLabel(selectedItem) }} / {{ statusLabel(selectedItem.status) }}</small>
            </span>
            <ChevronDownOutline v-if="agentGroups.length > 1" :class="{ expanded: openSelector === 'agent' }" />
          </button>
          <div
            v-if="openSelector === 'agent'"
            class="trace-select-menu"
            role="listbox"
            :aria-label="t('trace.agentRuns')"
            @keydown="navigateSelector"
          >
            <button
              v-for="group in agentGroups"
              :key="group.agentKind"
              class="trace-select-option"
              type="button"
              role="option"
              :aria-selected="String(group.agentKind === selectedItem?.agentKind)"
              :data-selected="group.agentKind === selectedItem?.agentKind ? 'true' : undefined"
              @click="selectAgentGroup(group)"
            >
              <img :src="agentLogo(group.agentKind, theme)" alt="" />
              <span>
                <strong>{{ agentLabel(group.agentKind) }}</strong>
                <small>{{ roundLabel(agentTabItem(group)) }} / {{ statusLabel(agentTabItem(group).status) }}</small>
              </span>
              <CheckmarkCircleOutline v-if="group.agentKind === selectedItem?.agentKind" />
            </button>
          </div>
        </div>

        <div v-if="selectedAgentRuns.length > 1" ref="roundSelector" class="trace-select trace-round-selector">
          <span class="trace-select-label">{{ t('trace.roundSelector') }}</span>
          <button
            ref="roundSelectTrigger"
            class="trace-select-trigger trace-round-trigger"
            type="button"
            :aria-expanded="String(openSelector === 'round')"
            aria-haspopup="listbox"
            :aria-label="t('trace.selectRound', { agent: agentLabel(selectedItem?.agentKind) })"
            @click="toggleSelector('round')"
            @keydown.down.prevent="openSelectorMenu('round')"
          >
            <span>
              <strong>{{ roundLabel(selectedItem) }}</strong>
              <small>{{ statusLabel(selectedItem?.status) }}</small>
            </span>
            <ChevronDownOutline :class="{ expanded: openSelector === 'round' }" />
          </button>
          <div
            v-if="openSelector === 'round'"
            class="trace-select-menu trace-round-menu"
            role="listbox"
            :aria-label="t('trace.selectRound', { agent: agentLabel(selectedItem?.agentKind) })"
            @keydown="navigateSelector"
          >
            <button
              v-for="item in selectedAgentRuns"
              :key="item.agentRunId"
              class="trace-select-option trace-round-option"
              type="button"
              role="option"
              :aria-selected="String(item.agentRunId === selectedItem?.agentRunId)"
              :data-selected="item.agentRunId === selectedItem?.agentRunId ? 'true' : undefined"
              @click="selectRound(item.agentRunId)"
            >
              <span>
                <strong>{{ roundLabel(item) }}</strong>
                <small>{{ statusLabel(item.status) }}</small>
              </span>
              <CheckmarkCircleOutline v-if="item.agentRunId === selectedItem?.agentRunId" />
            </button>
          </div>
        </div>
      </div>

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
            <span class="trace-summary-statuses">
              <span v-if="waiting" class="trace-waiting-state">{{ t('humanGate.waiting') }}</span>
              <span class="trace-status" :data-status="statusTone(selectedItem.status)">
                {{ statusLabel(selectedItem.status) }}
              </span>
            </span>
          </div>
          <p v-if="selectedItem.summary" class="trace-summary-copy">{{ selectedItem.summary }}</p>
          <div v-if="selectedItem.output" class="trace-conclusion">
            <span>{{ t('trace.conclusion') }}</span>
            <MarkdownMessage :content="selectedItem.output" />
          </div>
          <div v-if="selectedItem.context && hasTraceContext(selectedItem.context)" class="trace-context-disclosure">
            <div class="trace-context-stats" data-context-section="attempt">
              <span>{{ t('trace.attemptInjection') }}</span>
              <span>{{ t('trace.contextIncluded', { count: selectedItem.context.includedCount }) }}</span>
              <span>{{ t('trace.contextOmitted', { count: selectedItem.context.omittedCount }) }}</span>
              <span>{{ t('trace.contextChars', { count: selectedItem.context.charCount }) }}</span>
              <span v-if="selectedItem.context.sessionRotated">{{ t('trace.contextRotated') }}</span>
              <span v-if="selectedItem.context.contextPackId" class="trace-context-record">
                {{ t('trace.contextPackId') }}
                <code>{{ selectedItem.context.contextPackId }}</code>
              </span>
            </div>
            <p
              v-if="selectedItem.context.contextPackState === 'legacy-unavailable'"
              class="trace-detail-unavailable trace-context-record trace-session-warning"
              data-context-section="context-pack-legacy"
            >
              {{ t('trace.contextPackLegacyUnavailable') }}
            </p>
            <p
              v-if="selectedItem.context.deliveryRecordIds?.length"
              class="trace-detail-unavailable trace-context-record"
              data-context-section="outbound"
            >
              <strong>{{ t('trace.actualOutbound') }}</strong><br />
              <span>{{ t('trace.deliveryRecordIds', { count: selectedItem.context.deliveryRecordIds.length }) }}</span>
              <template v-for="(id, index) in selectedItem.context.deliveryRecordIds" :key="id">
                <br v-if="index === 0" />
                <span v-else>, </span>
                <code>{{ id }}</code>
              </template>
            </p>
            <p
              v-if="selectedItem.context.sessionProvenance"
              class="trace-detail-unavailable trace-context-record"
              data-context-section="session"
              :data-session-reuse="selectedItem.context.sessionProvenance.reuse ? 'reused' : 'new'"
              :data-provenance-completeness="selectedItem.context.sessionProvenance.completeness"
            >
              <strong>{{ t('trace.sessionProvenance') }}</strong><br />
              <span>{{ sessionProvenanceSummary(selectedItem.context.sessionProvenance) }}</span>
              <template v-if="selectedItem.context.sessionProvenance.originTaskId">
                <br />
                <span>{{ t('trace.sessionOriginTask') }} </span>
                <code>{{ selectedItem.context.sessionProvenance.originTaskId }}</code>
              </template>
              <template v-if="selectedItem.context.sessionProvenance.inheritedTaskIds.length">
                <br />
                <span>{{ t('trace.sessionInheritedTasks') }} </span>
                <template
                  v-for="(taskId, index) in selectedItem.context.sessionProvenance.inheritedTaskIds"
                  :key="taskId"
                >
                  <span v-if="index">, </span><code>{{ taskId }}</code>
                </template>
              </template>
              <template v-if="sessionProvenanceWarning(selectedItem.context.sessionProvenance)">
                <br />
                <span class="trace-session-warning">
                  {{ sessionProvenanceWarning(selectedItem.context.sessionProvenance) }}
                </span>
              </template>
            </p>
          </div>
          <p v-if="hasOnlyBareEvents(selectedItem)" class="trace-detail-unavailable">
            {{ t('trace.detailUnavailable') }}
          </p>
          <p v-if="selectedItem.truncated" class="trace-truncated">{{ t('trace.truncated') }}</p>
        </section>

        <section v-if="orderedHumanGates.length" class="trace-human-gate-section" aria-live="polite">
          <header class="trace-section-heading">
            <strong>{{ t('humanGate.pendingTitle') }}</strong>
            <small>{{ orderedHumanGates.length }}</small>
          </header>
          <article v-for="gate in orderedHumanGates" :key="gate.gateId" class="trace-human-gate-card">
            <header>
              <span>
                <img :src="agentLogo(gate.agentKind, theme)" alt="" />
                <strong>{{ agentLabel(gate.agentKind) }}</strong>
              </span>
              <small>{{ t(`humanGate.type.${gate.type}`) }}</small>
            </header>
            <p>{{ humanGateSummary(gate) }}</p>
            <div class="trace-human-gate-options">
              <button
                v-for="option in gate.options"
                :key="option.optionId"
                class="compact"
                :class="optionApprovesHumanGate(option) ? 'primary-button' : 'secondary-button'"
                type="button"
                :disabled="humanGateDecisionPending(gate.gateId)"
                @click="emit('decide-human-gate', { gateId: gate.gateId, optionId: option.optionId })"
              >
                <CheckmarkCircleOutline v-if="optionApprovesHumanGate(option)" />
                <CloseCircleOutline v-else />
                {{ humanGateOptionLabel(option) }}
              </button>
            </div>
          </article>
        </section>

        <section v-if="agentControlsVisible" class="trace-agent-control-section">
          <header class="trace-section-heading">
            <strong>{{ t('trace.agentControls') }}</strong>
            <small>{{ agentLabel(selectedItem.agentKind) }}</small>
          </header>
          <div class="trace-agent-control-actions">
            <button
              class="secondary-button compact"
              type="button"
              :disabled="agentControlPending"
              @click="emitAgentControl('retry')"
            >
              <RefreshOutline />
              {{ t('trace.retryAgent') }}
            </button>
            <button
              class="secondary-button compact"
              type="button"
              :disabled="agentControlPending"
              @click="emitAgentControl('cancel')"
            >
              <CloseCircleOutline />
              {{ t('trace.cancelAgent') }}
            </button>
          </div>
          <div v-if="replacementAgentKinds.length" class="trace-agent-replace-control">
            <label>
              <span>{{ t('trace.replacementAgent') }}</span>
              <select v-model="replacementKind" :disabled="agentControlPending">
                <option value="" disabled>{{ t('trace.selectReplacementAgent') }}</option>
                <option v-for="kind in replacementAgentKinds" :key="kind" :value="kind">
                  {{ agentLabel(kind) }}
                </option>
              </select>
            </label>
            <button
              class="secondary-button compact"
              type="button"
              :disabled="agentControlPending || !replacementKind"
              @click="emitAgentControl('replace', replacementKind)"
            >
              <SwapHorizontalOutline />
              {{ t('trace.replaceAgent') }}
            </button>
          </div>
        </section>

        <section v-if="budgetRows.length" class="trace-budget-section">
          <header class="trace-section-heading">
            <strong>{{ t('trace.budgetTitle') }}</strong>
            <small>{{ budgetRows.length }}</small>
          </header>
          <dl>
            <div v-for="row in budgetRows" :key="row.dimension">
              <dt>{{ row.label }}</dt>
              <dd>{{ row.usage }}</dd>
              <small>{{ row.meta }}</small>
            </div>
          </dl>
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
                  <p v-if="!eventHasDetails(event)" class="trace-event-detail-unavailable">
                    {{ t('trace.eventDetailUnavailable') }}
                  </p>
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
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  CheckmarkCircleOutline,
  ChevronDownOutline,
  ChevronForwardOutline,
  CloseCircleOutline,
  CloseOutline,
  RefreshOutline,
  SwapHorizontalOutline,
} from '@vicons/ionicons5'
import MarkdownMessage from './MarkdownMessage.vue'
import { agentLabel, agentLogo } from '../catalog.js'
import { locale, t } from '../i18n.js'

const props = defineProps({
  open: { type: Boolean, default: false },
  drawer: { type: Boolean, default: false },
  agentControlPendingAgentRunId: { type: String, default: '' },
  budget: { type: Object, default: null },
  controllableAgentRunId: { type: String, default: '' },
  humanGateDecisionPendingIds: { type: Array, default: () => [] },
  humanGates: { type: Array, default: () => [] },
  items: { type: Array, default: () => [] },
  replacementAgentKinds: { type: Array, default: () => [] },
  selectedAgentRunId: { type: String, default: '' },
  theme: { type: String, default: 'light' },
  waiting: { type: Boolean, default: false },
})

const emit = defineEmits(['close', 'control-agent', 'decide-human-gate', 'select', 'jump-source'])
const panelElement = ref(null)
const agentSelector = ref(null)
const agentSelectTrigger = ref(null)
const roundSelector = ref(null)
const roundSelectTrigger = ref(null)
const openSelector = ref('')
const replacementKind = ref('')
const BUDGET_DIMENSIONS = [
  'inputTokens', 'outputTokens', 'costMicros', 'toolCalls', 'outboundBytes', 'elapsedMs',
]
const selectedItem = computed(() => props.items.find(item => item.agentRunId === props.selectedAgentRunId) || props.items.at(-1) || null)
const agentGroups = computed(() => {
  const groups = new Map()
  for (const item of props.items) {
    const agentKind = String(item?.agentKind || '')
    if (!agentKind) continue
    const group = groups.get(agentKind) || { agentKind, items: [] }
    group.items.push(item)
    groups.set(agentKind, group)
  }
  return [...groups.values()]
})
const selectedAgentRuns = computed(() => (
  agentGroups.value.find(group => group.agentKind === selectedItem.value?.agentKind)?.items || []
))
const orderedHumanGates = computed(() => [...props.humanGates].sort((left, right) => (
  Number(right.agentRunId === selectedItem.value?.agentRunId)
  - Number(left.agentRunId === selectedItem.value?.agentRunId)
)))
const agentControlsVisible = computed(() => (
  Boolean(selectedItem.value?.agentRunId)
  && selectedItem.value.agentRunId === props.controllableAgentRunId
))
const agentControlPending = computed(() => (
  props.agentControlPendingAgentRunId === selectedItem.value?.agentRunId
))
const budgetRows = computed(() => normalizedBudgetRows(props.budget))
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

watch(
  [() => selectedItem.value?.agentRunId, () => props.replacementAgentKinds.join('\u0000')],
  () => {
    if (!props.replacementAgentKinds.includes(replacementKind.value)) replacementKind.value = ''
  },
)
watch(() => props.open, (value) => {
  if (!value) openSelector.value = ''
})

function focus() {
  void nextTick(() => panelElement.value?.focus())
}

function agentTabItem(group) {
  return group.agentKind === selectedItem.value?.agentKind
    ? selectedItem.value
    : group.items.at(-1)
}

function selectAgentGroup(group) {
  const item = agentTabItem(group)
  if (item?.agentRunId) {
    emit('select', item.agentRunId)
    closeSelectorMenu(true)
  }
}

function selectRound(agentRunId) {
  const selectedId = String(agentRunId || '')
  if (selectedId) {
    emit('select', selectedId)
    closeSelectorMenu(true)
  }
}

function selectorTrigger(name) {
  return name === 'agent' ? agentSelectTrigger.value : roundSelectTrigger.value
}

function selectorElement(name) {
  return name === 'agent' ? agentSelector.value : roundSelector.value
}

function focusSelectedOption() {
  void nextTick(() => {
    const selector = selectorElement(openSelector.value)
    const selected = selector?.querySelector('.trace-select-option[data-selected="true"]')
    const first = selector?.querySelector('.trace-select-option')
    ;(selected || first)?.focus?.()
  })
}

function openSelectorMenu(name) {
  if (name === 'agent' && agentGroups.value.length <= 1) return
  if (name === 'round' && selectedAgentRuns.value.length <= 1) return
  openSelector.value = name
  focusSelectedOption()
}

function toggleSelector(name) {
  if (openSelector.value === name) closeSelectorMenu(false)
  else openSelectorMenu(name)
}

function closeSelectorMenu(returnFocus = false) {
  const name = openSelector.value
  openSelector.value = ''
  if (returnFocus && name) void nextTick(() => selectorTrigger(name)?.focus?.())
}

function navigateSelector(event) {
  const options = [...event.currentTarget.querySelectorAll('.trace-select-option')]
  const current = options.indexOf(document.activeElement)
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    options[(current + 1 + options.length) % options.length]?.focus()
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    options[(current - 1 + options.length) % options.length]?.focus()
  } else if (event.key === 'Home') {
    event.preventDefault()
    options[0]?.focus()
  } else if (event.key === 'End') {
    event.preventDefault()
    options.at(-1)?.focus()
  }
}

function handlePanelEscape(event) {
  if (!openSelector.value) return
  event.preventDefault()
  event.stopPropagation()
  closeSelectorMenu(true)
}

function handleDocumentPointerDown(event) {
  const selector = selectorElement(openSelector.value)
  if (selector && !selector.contains(event.target)) closeSelectorMenu(false)
}

onMounted(() => document.addEventListener('pointerdown', handleDocumentPointerDown))
onBeforeUnmount(() => document.removeEventListener('pointerdown', handleDocumentPointerDown))

function emitAgentControl(action, nextReplacementKind = '') {
  if (!agentControlsVisible.value || agentControlPending.value) return
  emit('control-agent', {
    agentRunId: selectedItem.value.agentRunId,
    kind: selectedItem.value.agentKind,
    action,
    replacementKind: action === 'replace' ? nextReplacementKind : '',
  })
}

function optionApprovesHumanGate(option) {
  return ['allow_once', 'allow_always', 'accept'].includes(option?.kind)
}

function humanGateDecisionPending(gateId) {
  return props.humanGateDecisionPendingIds.includes(gateId)
}

function humanGateSummary(gate) {
  const key = {
    'Agent requests permission to continue a tool action.': 'humanGate.summary.permission',
    'Cost usage is unavailable for this Agent attempt.': 'humanGate.summary.budget',
    'This run requires a human decision.': 'humanGate.summary.decision',
    'The previous write-capable Agent attempt may already have changed the workspace.': 'humanGate.summary.retry',
  }[gate?.summary]
  return key ? t(key) : gate?.summary || ''
}

function humanGateOptionLabel(option) {
  const optionIdKey = {
    'retry-once': 'humanGate.option.retryOnce',
    'cancel-retry': 'humanGate.option.cancelRetry',
  }[option?.optionId]
  if (optionIdKey) return t(optionIdKey)
  const key = {
    allow_once: 'humanGate.option.allowOnce',
    allow_always: 'humanGate.option.allowAlways',
    reject_once: 'humanGate.option.reject',
    reject_always: 'humanGate.option.rejectAlways',
    accept: 'humanGate.option.acceptArtifact',
    reject: 'humanGate.option.rejectArtifact',
    reopen: 'humanGate.option.reopenTask',
  }[option?.kind]
  return key ? t(key) : option?.name || ''
}

function normalizedBudgetRows(budget) {
  if (!budget) return []
  return BUDGET_DIMENSIONS.map((dimension) => {
    const used = budget.used[dimension]
    const limit = budget.limits[dimension]
    return {
      dimension,
      label: t(`trace.budgetDimension.${dimension}`),
      usage: t('trace.budgetUsage', {
        used: formatBudgetNumber(used),
        limit: limit === null ? t('trace.budgetUnlimited') : formatBudgetNumber(limit),
      }),
      meta: `${t(`trace.budgetSource.${budget.source[dimension]}`)} / ${t(`trace.budgetEnforcement.${budget.enforcement[dimension]}`)}`,
      meaningful: used > 0 || limit !== null || budget.source[dimension] !== 'unknown'
        || budget.enforcement[dimension] === 'hard',
    }
  }).filter(row => row.meaningful)
}

function formatBudgetNumber(value) {
  return new Intl.NumberFormat(locale.value === 'zh' ? 'zh-CN' : 'en-US').format(value)
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
  return (Array.isArray(item?.events) ? item.events : []).filter((event) => {
    const type = String(event?.type || '').toLowerCase()
    const title = String(event?.title || '').trim().toLowerCase()
    return type !== 'answer_delta' && !(type === 'status' && ['agent', 'process'].includes(title))
  })
}

function eventHasDetails(event) {
  return Boolean(String(event?.summary || '').trim() || String(event?.detail || '').trim())
}

function hasOnlyBareEvents(item) {
  const events = filteredEvents(item)
  return events.length > 0 && events.every(event => !eventHasDetails(event))
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
  const connectorTitleKey = {
    connector_fallback: 'trace.eventConnectorFallback',
    connector_limited: 'trace.eventConnectorLimited',
  }[title.toLowerCase()]
  if (connectorTitleKey) return t(connectorTitleKey)
  if (!title || ['agent', 'waiting_for_output'].includes(title.toLowerCase())) return eventTypeLabel(event?.type)
  return title
}

function statusTone(status) {
  const value = String(status || '').toLowerCase()
  if (['completed', 'succeeded'].includes(value)) return 'completed'
  if (['failed', 'timeout'].includes(value)) return 'failed'
  if (['partial', 'cancelled', 'stopped', 'interrupted'].includes(value)) return 'partial'
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
  if (Number.isInteger(round) && round > 0) return t('trace.round', { count: round })
  return item?.live && ['running', 'streaming', 'waiting'].includes(String(item?.status || '').toLowerCase())
    ? t('trace.live')
    : t('trace.singleResponse')
}

function hasTraceContext(context) {
  return Number(context?.includedCount) > 0
    || Number(context?.omittedCount) > 0
    || Number(context?.charCount) > 0
    || context?.sessionRotated === true
    || Boolean(context?.contextPackId)
    || context?.contextPackState === 'legacy-unavailable'
    || Boolean(context?.deliveryRecordIds?.length)
    || Boolean(context?.sessionProvenance)
}

function sessionProvenanceSummary(provenance) {
  return t('trace.sessionProvenanceSummary', {
    scope: t(`trace.sessionScope.${provenance?.scope || 'none'}`),
    origin: t(`trace.sessionOrigin.${provenance?.origin || 'none'}`),
    completeness: t(`trace.sessionCompleteness.${provenance?.completeness || 'complete'}`),
  })
}

function sessionProvenanceWarning(provenance) {
  if (
    provenance?.scope === 'unknown-legacy'
    || provenance?.origin === 'unknown-legacy'
    || provenance?.completeness === 'unknown-legacy'
  ) return t('trace.sessionUnknownLegacyWarning')
  return provenance?.reuse ? t('trace.sessionReuseWarning') : ''
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

<style scoped>
.trace-context-disclosure {
  display: grid;
  gap: 6px;
}

.trace-context-record code {
  overflow-wrap: anywhere;
}

.trace-summary-statuses,
.trace-human-gate-card header,
.trace-human-gate-card header span,
.trace-human-gate-options,
.trace-agent-control-actions,
.trace-agent-replace-control {
  display: flex;
  align-items: center;
}

.trace-summary-statuses {
  gap: 7px;
}

.trace-waiting-state {
  color: var(--accent-hover);
  font-size: 10px;
  font-weight: 700;
  white-space: nowrap;
}

.trace-human-gate-section,
.trace-agent-control-section,
.trace-budget-section {
  display: grid;
  gap: 8px;
  padding-top: 18px;
}

.trace-human-gate-card {
  display: grid;
  gap: 9px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-raised);
}

.trace-human-gate-card header {
  justify-content: space-between;
  gap: 8px;
}

.trace-human-gate-card header span {
  min-width: 0;
  gap: 6px;
}

.trace-human-gate-card header img {
  width: 20px;
  height: 20px;
  border-radius: 50%;
}

.trace-human-gate-card header strong {
  overflow: hidden;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trace-human-gate-card header small {
  color: var(--accent-hover);
  font-size: 9px;
  font-weight: 700;
}

.trace-human-gate-card p {
  margin: 0;
  color: var(--text-soft);
  font-size: 11px;
  line-height: 1.5;
}

.trace-human-gate-options,
.trace-agent-control-actions {
  flex-wrap: wrap;
  gap: 6px;
}

.trace-human-gate-options button svg,
.trace-agent-control-actions button svg,
.trace-agent-replace-control button svg {
  width: 14px;
  height: 14px;
}

.trace-agent-replace-control {
  align-items: end;
  gap: 6px;
}

.trace-agent-replace-control label {
  min-width: 0;
  display: grid;
  gap: 4px;
  flex: 1;
  color: var(--muted);
  font-size: 9px;
}

.trace-agent-replace-control select {
  width: 100%;
  min-height: 32px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-raised);
  color: var(--text-soft);
  font: inherit;
  font-size: 11px;
}

.trace-budget-section dl {
  display: grid;
  gap: 4px;
  margin: 0;
}

.trace-budget-section dl div {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 2px 8px;
  padding: 7px 8px;
  border-radius: var(--radius-sm);
  background: var(--surface-raised);
  color: var(--text-soft);
  font-size: 10px;
}

.trace-budget-section dd {
  margin: 0;
}

.trace-budget-section dl small {
  grid-column: 1 / -1;
  color: var(--muted);
  font-size: 9px;
}
</style>
