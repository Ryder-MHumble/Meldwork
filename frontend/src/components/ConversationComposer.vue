<template>
  <footer class="composer-zone">
    <div class="composer-shell">
      <section
        v-if="skillMenuOpen"
        ref="mentionMenu"
        id="composer-skill-menu"
        class="skill-menu"
        role="listbox"
        :aria-label="t('composer.mentions')"
      >
        <template v-if="composerMenuOptions.length">
          <div
            v-for="group in composerMenuGroups"
            :key="group.type"
            class="mention-menu-section"
            role="group"
            :aria-label="group.label"
          >
            <span class="mention-menu-section-label">{{ group.label }}</span>
            <button
              v-for="option in group.options"
              :key="composerMenuOptionKey(option)"
              :id="`composer-mention-option-${composerMenuOptionIndex(option)}`"
              class="skill-option"
              :class="{
                active: skillActiveIndex === composerMenuOptionIndex(option),
                'agent-mention-option': option.type === 'agent',
                'knowledge-base-mention-option': option.type === 'knowledge-base',
              }"
              type="button"
              role="option"
              :aria-selected="skillActiveIndex === composerMenuOptionIndex(option)"
              :disabled="composerMenuOptionDisabled(option)"
              @mouseenter="skillActiveIndex = composerMenuOptionIndex(option)"
              @click="selectComposerMenuOption(option)"
            >
              <img v-if="option.type !== 'skill'" :src="composerMenuOptionLogo(option)" alt="" />
              <LibraryOutline v-else class="mention-option-icon" />
              <span class="skill-option-copy">
                <strong>{{ composerMenuOptionTitle(option) }}</strong>
                <small>{{ composerMenuOptionDescription(option) }}</small>
              </span>
              <span class="mention-option-action" aria-hidden="true">
                <small>{{ composerMenuOptionKindLabel(option) }}</small>
                <AddOutline />
              </span>
            </button>
          </div>
        </template>
        <p v-if="skillsLoading" class="skill-menu-state compact">{{ t('composer.skillsLoading') }}</p>
        <p v-else-if="!composerMenuOptions.length" class="skill-menu-state">
          {{ selectedSkills.length >= MAX_SKILLS ? t('composer.skillLimit') : t('composer.noMentions') }}
        </p>
      </section>

      <div
        class="composer-box"
        :class="{
          'is-dragging-files': composerDropActive,
          'unlimited-mode': unlimitedModeActive,
          'unlimited-running': activeUnlimitedAutoRun,
        }"
        @dragenter="handleComposerDragEnter"
        @dragover="handleComposerDragOver"
        @dragleave="handleComposerDragLeave"
        @drop="handleComposerDrop"
      >
        <div v-if="composerDropActive" class="composer-drop-overlay" aria-hidden="true">
          <AttachOutline />
          <span>{{ t('composer.dropFiles') }}</span>
        </div>
        <div v-if="activeGroup.conversationType !== 'direct'" class="composer-context-row">
          <div class="mode-segmented" role="group" :aria-label="t('composer.responseMode')">
            <button
              type="button"
              data-mode="manual"
              :class="{ active: discussionMode === 'manual' }"
              :aria-pressed="discussionMode === 'manual'"
              :disabled="Boolean(activeRun) || sending"
              :title="t('composer.concurrentResponsesHint')"
              @click="discussionMode = 'manual'"
            >
              {{ manualModeLabel }}
            </button>
            <button
              type="button"
              data-mode="auto"
              :class="{ active: discussionMode === 'auto' }"
              :aria-pressed="discussionMode === 'auto'"
              :disabled="Boolean(activeRun) || sending"
              :title="t('composer.sequentialHint')"
              @click="discussionMode = 'auto'"
            >
              {{ t('composer.auto') }}
            </button>
            <button
              type="button"
              data-mode="auto-beta"
              class="mode-beta"
              :class="{ active: discussionMode === 'auto-beta' }"
              :aria-pressed="discussionMode === 'auto-beta'"
              :disabled="Boolean(activeRun) || sending"
              :title="t('composer.autoBetaHint')"
              :aria-label="`${t('composer.autoBeta')} — ${t('composer.autoBetaHint')}`"
              @click="discussionMode = 'auto-beta'"
            >
              {{ t('composer.autoBeta') }}
              <span class="mode-beta-badge" :aria-label="t('composer.autoBetaBadge')">{{ t('composer.autoBetaBadge') }}</span>
            </button>
          </div>

          <div class="target-row" :aria-label="t('composer.targets')">
            <div class="target-avatar-stack" role="group" :aria-label="t('composer.targets')">
              <button
                v-for="(kind, index) in activeGroup.agentKinds"
                :key="kind"
                class="target-chip"
                :class="{ selected: isComposerTargetSelected(kind) }"
                :style="{ '--stack-index': index }"
                type="button"
                :title="agentLabel(kind)"
                :aria-label="(discussionMode === 'auto' || discussionMode === 'auto-beta')
                  ? t('composer.autoTarget', { agent: agentLabel(kind) })
                  : t(isComposerTargetSelected(kind) ? 'composer.removeTarget' : 'composer.addTarget', { agent: agentLabel(kind) })"
                :aria-pressed="isComposerTargetSelected(kind)"
                :disabled="Boolean(activeRun) || sending || discussionMode === 'auto' || discussionMode === 'auto-beta' || automaticTeamFormation"
                @click="toggleTarget(kind)"
              >
                <img :src="agentLogo(kind, theme)" alt="" />
                <span class="visually-hidden">{{ agentLabel(kind) }}</span>
              </button>
            </div>
          </div>

          <div
            v-if="discussionMode === 'auto' || discussionMode === 'auto-beta'"
            ref="roundSettingsControl"
            class="round-settings-control"
            @click.stop
          >
            <button
              type="button"
              class="round-settings-trigger"
              :title="t('composer.maxRounds')"
              :aria-label="t('composer.maxRounds')"
              aria-haspopup="dialog"
              :aria-expanded="roundSettingsOpen ? 'true' : 'false'"
              :class="{ unlimited: unlimitedModeActive }"
              :disabled="Boolean(activeRun) || sending"
              @click="roundSettingsOpen = !roundSettingsOpen"
            >
              <span v-if="unlimitedModeActive" class="round-unlimited-symbol" aria-hidden="true">∞</span>
              <span>{{ unlimitedRounds || activeUnlimitedAutoRun ? t('composer.unlimitedRounds') : t('composer.autoRounds', { count: maxRounds }) }}</span>
              <ChevronDownOutline :class="{ open: roundSettingsOpen }" />
            </button>
            <section
              v-if="roundSettingsOpen"
              class="round-settings-popover"
              role="dialog"
              :aria-label="t('composer.maxRounds')"
            >
              <header>
                <span>{{ t('composer.maxRounds') }}</span>
                <output aria-live="polite">
                  {{ unlimitedRounds ? t('composer.unlimitedRounds') : t('composer.autoRounds', { count: maxRounds }) }}
                </output>
              </header>
              <div v-if="!unlimitedRounds" class="round-range-panel">
                <input
                  v-model.number="maxRounds"
                  class="round-range-input"
                  type="range"
                  min="1"
                  max="10"
                  step="1"
                  :style="{ '--round-progress': roundProgressPercent }"
                  :aria-label="t('composer.maxRounds')"
                  :aria-valuetext="t('composer.autoRounds', { count: maxRounds })"
                />
                <div class="round-range-labels" aria-hidden="true">
                  <span>1</span>
                  <span>10</span>
                </div>
              </div>
              <div v-else class="round-unlimited-active">
                <strong>{{ t('composer.unlimitedRounds') }}</strong>
                <small>{{ t('composer.unlimitedHint') }}</small>
              </div>
              <button
                v-if="!unlimitedRounds"
                class="round-unlimited-button"
                type="button"
                @click="requestUnlimitedRounds"
              >
                {{ t('composer.unlimitedRounds') }}
              </button>
              <button
                v-else
                class="round-bounded-button"
                type="button"
                @click="unlimitedRounds = false"
              >
                {{ t('composer.useBoundedRounds') }}
              </button>
            </section>
          </div>
        </div>

        <div v-if="composerAttachments.length" class="composer-attachment-list">
          <article
            v-for="attachment in composerAttachments"
            :key="attachment.id"
            class="composer-attachment"
            :class="`is-${attachmentKind(attachment)}`"
          >
            <img
              v-if="isImageAttachment(attachment)"
              :src="attachment.previewDataUrl || attachmentMediaUrl(attachment)"
              :alt="attachment.name"
            />
            <template v-else>
              <span
                class="composer-attachment-media-icon"
                :data-attachment-icon="composerAttachmentIconName(attachment)"
                aria-hidden="true"
              >
                <component :is="composerAttachmentIcon(attachment)" />
              </span>
              <span class="composer-attachment-file-copy">
                <strong :title="attachment.name">{{ attachment.name }}</strong>
                <small>{{ attachmentTypeLabel(attachment) }}</small>
              </span>
            </template>
            <button
              class="composer-attachment-remove"
              type="button"
              :title="t('composer.removeAttachment')"
              :aria-label="t('composer.removeAttachment')"
              :disabled="Boolean(activeRun) || sending"
              @click="removeAttachment(attachment.id)"
            >
              <CloseCircleOutline />
            </button>
          </article>
        </div>

        <div
          ref="composerInputShell"
          class="composer-input-shell"
          :style="composerMentionLayout"
        >
          <div
            v-if="selectedAgentKinds.length || selectedSkills.length || selectedKnowledgeBases.length"
            ref="composerMentionStrip"
            class="composer-inline-mentions"
            :aria-label="t('composer.mentions')"
          >
            <button
              v-for="kind in selectedAgentKinds"
              :key="kind"
              class="selected-mention-token selected-agent-avatar"
              type="button"
              :title="t('composer.removeMention', { agent: agentLabel(kind) })"
              :aria-label="t('composer.removeMention', { agent: agentLabel(kind) })"
              :disabled="Boolean(activeRun) || sending"
              @click="removeAgentMention(kind)"
            >
              <img :src="agentLogo(kind, theme)" alt="" />
              <CloseOutline aria-hidden="true" />
            </button>
            <button
              v-for="source in selectedKnowledgeBases"
              :key="`knowledge:${source.kind}`"
              class="selected-mention-token selected-knowledge-base-avatar"
              type="button"
              :title="t('composer.removeKnowledgeBase')"
              :aria-label="t('composer.removeKnowledgeBase')"
              :disabled="Boolean(activeRun) || sending"
              @click="removeKnowledgeBase(source.kind)"
            >
              <img :src="knowledgeBaseLogo(source.kind)" alt="" />
              <CloseOutline aria-hidden="true" />
            </button>
            <span v-for="skill in selectedSkills" :key="skillKey(skill)" class="selected-mention-token selected-skill">
              <LibraryOutline class="selected-context-icon" aria-hidden="true" />
              <span>{{ skill.name || skill.slug }}</span>
              <button
                type="button"
                :title="t('composer.removeSkill')"
                :aria-label="t('composer.removeSkill')"
                :disabled="Boolean(activeRun) || sending"
                @click="removeSkill(skill)"
              >
                <CloseOutline />
              </button>
            </span>
          </div>
          <textarea
            ref="composerInput"
            v-model="draft"
            rows="1"
            :placeholder="composerPlaceholder"
            :disabled="Boolean(activeRun) || sending"
            role="combobox"
            aria-autocomplete="list"
            aria-controls="composer-skill-menu"
            :aria-expanded="skillMenuOpen ? 'true' : 'false'"
            :aria-activedescendant="activeSkillOptionId || undefined"
            @input="handleComposerInput"
            @keydown="handleComposerKeydown"
            @paste="handleComposerPaste"
          />
        </div>
        <div class="composer-actions">
          <div class="composer-tools">
            <button
              class="composer-tool-button composer-attachment-button"
              type="button"
              :title="attachmentActionLabel"
              :aria-label="attachmentActionLabel"
              :disabled="Boolean(activeRun) || sending || importingAttachment || !composerAttachmentSupported"
              @click="pickAttachments"
            >
              <RefreshOutline v-if="importingAttachment" class="spinning" />
              <AttachOutline v-else />
            </button>
            <button
              class="composer-tool-button composer-skill-button"
              type="button"
              :title="t('composer.skills')"
              :aria-label="t('composer.skills')"
              :disabled="Boolean(activeRun) || sending"
              @click="openSkillMenu"
            >
              <AtOutline />
            </button>
            <div
              v-if="activeGroup.conversationType !== 'direct'"
              class="smart-team-control"
              @mouseenter="smartTeamTooltipOpen = true"
              @mouseleave="smartTeamTooltipOpen = false"
            >
              <button
                class="smart-team-trigger"
                :class="{ active: automaticTeamFormation }"
                type="button"
                :aria-label="t(automaticTeamFormation ? 'composer.autoTeamDisable' : 'composer.autoTeamEnable')"
                :aria-pressed="automaticTeamFormation"
                :aria-describedby="smartTeamTooltipOpen ? 'smart-team-tooltip' : undefined"
                :disabled="Boolean(activeRun) || sending"
                @click="handleSmartTeamToggle"
                @focus="smartTeamTooltipOpen = true"
                @blur="smartTeamTooltipOpen = false"
              >
                <svg
                  class="smart-team-icon"
                  viewBox="0 0 20 20"
                  fill="none"
                  aria-hidden="true"
                >
                  <g class="smart-team-icon-state smart-team-icon-state-off">
                    <path class="smart-team-icon-manual-rail" d="M3.5 5.25h8.4" />
                    <path class="smart-team-icon-manual-rail" d="M8.1 10h8.4" />
                    <path class="smart-team-icon-manual-rail" d="M3.5 14.75h8.4" />
                    <circle class="smart-team-icon-manual-node" cx="14.55" cy="5.25" r="1.55" />
                    <circle class="smart-team-icon-manual-node" cx="5.45" cy="10" r="1.55" />
                    <circle class="smart-team-icon-manual-node" cx="14.55" cy="14.75" r="1.55" />
                    <path class="smart-team-icon-manual-caret" d="M9.05 7.65 10 6.75l.95.9" />
                  </g>
                  <g class="smart-team-icon-state smart-team-icon-state-on">
                    <path class="smart-team-icon-network" d="M4.25 15.25c2.4-.45 3.85-1.7 4.7-3.75" />
                    <path class="smart-team-icon-network" d="M15.75 15.25c-2.4-.45-3.85-1.7-4.7-3.75" />
                    <circle cx="3.75" cy="15.25" r="1.35" />
                    <circle cx="16.25" cy="15.25" r="1.35" />
                    <path class="smart-team-icon-spark" d="M10 2.25 11.15 5.1 14 6.25 11.15 7.4 10 10.25 8.85 7.4 6 6.25 8.85 5.1 10 2.25Z" />
                  </g>
                </svg>
                <span class="smart-team-label">{{ t('composer.smartTeam') }}</span>
                <span class="smart-team-status" aria-live="polite">
                  {{ t(automaticTeamFormation ? 'composer.smartTeamOn' : 'composer.smartTeamOff') }}
                </span>
              </button>
              <div
                v-if="smartTeamTooltipOpen"
                id="smart-team-tooltip"
                class="smart-team-tooltip"
                role="tooltip"
              >
                <header>
                  <strong>{{ t('composer.smartTeam') }}</strong>
                  <small>{{ t(automaticTeamFormation ? 'composer.smartTeamOn' : 'composer.smartTeamOff') }}</small>
                </header>
                <p>
                  {{ t(automaticTeamFormation
                    ? 'composer.smartTeamActiveHint'
                    : 'composer.smartTeamEnableHint') }}
                </p>
              </div>
            </div>
          </div>

          <div class="composer-run-actions">
            <button
              v-if="activeRun"
              class="stop-button"
              type="button"
              :title="t('composer.stop')"
              :aria-label="t('composer.stop')"
              @click="stopRun"
            >
              <StopCircleOutline aria-hidden="true" />
              <span class="visually-hidden">{{ t('composer.stop') }}</span>
            </button>
            <button
              v-else
              class="send-button"
              type="button"
              :class="{ sending }"
              :title="sendButtonLabel"
              :aria-label="sendButtonLabel"
              :disabled="!canSendMessage || sending"
              @click="sendMessage"
            >
              <span v-if="sending" class="send-button-loader" aria-hidden="true"><i /><i /><i /></span>
              <SendOutline v-else aria-hidden="true" />
              <span class="visually-hidden">{{ sendButtonLabel }}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </footer>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  AddOutline,
  ArchiveOutline,
  AttachOutline,
  AtOutline,
  ChevronDownOutline,
  CloseCircleOutline,
  CloseOutline,
  CodeOutline,
  DocumentOutline,
  DocumentTextOutline,
  EaselOutline,
  GridOutline,
  LibraryOutline,
  MusicalNotesOutline,
  ReaderOutline,
  RefreshOutline,
  SendOutline,
  StopCircleOutline,
  VideocamOutline,
} from '@vicons/ionicons5'
import { agentLabel, agentLogo } from '../catalog.js'
import { MAX_SKILLS, skillKey } from '../composables/useComposerContext.js'

const props = defineProps({
  controller: { type: Object, required: true },
})

const COMPOSER_FILE_ICON_COMPONENTS = {
  archive: ArchiveOutline,
  code: CodeOutline,
  document: DocumentOutline,
  pdf: DocumentTextOutline,
  presentation: EaselOutline,
  spreadsheet: GridOutline,
  text: ReaderOutline,
}
const COMPOSER_FILE_ICON_BY_EXTENSION = {
  '7z': 'archive', gz: 'archive', tar: 'archive', tgz: 'archive', zip: 'archive',
  c: 'code', cc: 'code', cjs: 'code', cpp: 'code', css: 'code', go: 'code', h: 'code',
  hpp: 'code', html: 'code', java: 'code', js: 'code', json: 'code', md: 'code', mjs: 'code',
  py: 'code', rs: 'code', sh: 'code', ts: 'code', tsx: 'code', vue: 'code', xml: 'code', yaml: 'code', yml: 'code',
  csv: 'spreadsheet', ods: 'spreadsheet', xls: 'spreadsheet', xlsx: 'spreadsheet',
  doc: 'text', docx: 'text', odt: 'text', rtf: 'text', txt: 'text',
  key: 'presentation', odp: 'presentation', ppt: 'presentation', pptx: 'presentation',
  pdf: 'pdf',
}

function composerAttachmentIcon(attachment) {
  const name = composerAttachmentIconName(attachment)
  if (name === 'audio') return MusicalNotesOutline
  if (name === 'video') return VideocamOutline
  if (name === 'attachment') return AttachOutline
  return COMPOSER_FILE_ICON_COMPONENTS[name] || DocumentOutline
}

function composerAttachmentIconName(attachment) {
  const type = attachmentKind(attachment)
  if (type === 'audio' || type === 'video') return type
  if (type !== 'file') return 'attachment'
  const extension = String(attachment?.name || '').split('.').pop()?.toLowerCase() || ''
  return COMPOSER_FILE_ICON_BY_EXTENSION[extension] || 'document'
}

const {
  activeGroup,
  activeRun,
  automaticTeamFormation,
  activeSkillOptionId,
  attachmentActionLabel,
  attachmentKind,
  attachmentMediaUrl,
  attachmentTypeLabel,
  canSendMessage,
  composerAttachmentSupported,
  composerAttachments,
  composerDropActive,
  composerInput,
  composerMenuGroups,
  composerMenuOptionDescription,
  composerMenuOptionDisabled,
  composerMenuOptionIndex,
  composerMenuOptionKey,
  composerMenuOptionKindLabel,
  composerMenuOptionLogo,
  composerMenuOptions,
  composerMenuOptionTitle,
  discussionMode,
  draft,
  groupName,
  handleComposerDragEnter,
  handleComposerDragLeave,
  handleComposerDragOver,
  handleComposerDrop,
  handleComposerInput,
  handleComposerKeydown,
  handleComposerPaste,
  importingAttachment,
  isComposerTargetSelected,
  isImageAttachment,
  knowledgeBaseLogo,
  knowledgeBaseName,
  manualModeLabel,
  maxRounds,
  openSkillMenu,
  pickAttachments,
  removeAgentMention,
  removeAttachment,
  removeKnowledgeBase,
  removeSkill,
  requestUnlimitedRounds,
  roundProgressPercent,
  roundSettingsControl,
  roundSettingsOpen,
  selectedAgentKinds,
  selectedKnowledgeBases,
  selectedSkills,
  selectComposerMenuOption,
  sendButtonLabel,
  sendMessage,
  sending,
  skillActiveIndex,
  skillMenuOpen,
  skillsLoading,
  stopRun,
  t,
  theme,
  toggleTarget,
  toggleAutomaticTeamFormation,
  unlimitedRounds,
} = props.controller

const smartTeamTooltipOpen = ref(false)
const mentionMenu = ref(null)
const composerInputShell = ref(null)
const composerMentionStrip = ref(null)
const composerMentionLayout = ref({})
let composerMentionResizeObserver = null
const activeUnlimitedAutoRun = computed(() => (
  activeRun.value?.mode === 'auto'
  && activeRun.value?.unlimitedRounds === true
  && ['preparing', 'running', 'waiting'].includes(String(activeRun.value?.phase || '').toLowerCase())
))
const unlimitedModeActive = computed(() => (
  activeRun.value
    ? activeUnlimitedAutoRun.value
    : discussionMode.value === 'auto' && unlimitedRounds.value === true
))
const modeExplanation = computed(() => {
  if (discussionMode.value === 'auto') return t('composer.sequentialHint')
  if (discussionMode.value === 'auto-beta') return t('composer.autoBetaHint')
  return t('composer.concurrentResponsesHint')
})
const composerPlaceholder = computed(() => {
  const group = activeGroup.value
  if (!group) return t('composer.placeholder', { name: '' })
  if (group.conversationType === 'direct') {
    return t('composer.placeholder', { name: groupName(group) })
  }
  if (automaticTeamFormation.value) return t('composer.smartTeamPlaceholder')
  if (discussionMode.value === 'auto' && unlimitedRounds.value) {
    return t('composer.unlimitedPlaceholder', { name: groupName(group) })
  }
  return modeExplanation.value
})
const composerMentionSignature = computed(() => JSON.stringify([
  selectedAgentKinds.value,
  selectedKnowledgeBases.value.map(source => source.kind),
  selectedSkills.value.map(skill => skillKey(skill)),
]))

async function updateComposerMentionLayout() {
  await nextTick()
  const strip = composerMentionStrip.value
  if (!strip?.lastElementChild) {
    composerMentionLayout.value = {}
    return
  }
  const last = strip.lastElementChild
  const rowTop = Math.max(0, Number(last.offsetTop) || 0)
  const indent = Math.max(0, (Number(last.offsetLeft) || 0) + (Number(last.offsetWidth) || 0) + 6)
  composerMentionLayout.value = {
    '--composer-mention-line-top': `${rowTop}px`,
    '--composer-mention-indent': `${indent}px`,
  }
}

watch([activeSkillOptionId, skillMenuOpen], async ([, open]) => {
  if (!open) return
  await nextTick()
  mentionMenu.value?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
}, { flush: 'post' })
watch(composerMentionSignature, updateComposerMentionLayout, { flush: 'post' })

onMounted(() => {
  if (typeof ResizeObserver !== 'function') return
  composerMentionResizeObserver = new ResizeObserver(() => { void updateComposerMentionLayout() })
  if (composerInputShell.value) composerMentionResizeObserver.observe(composerInputShell.value)
})

onBeforeUnmount(() => composerMentionResizeObserver?.disconnect())

function handleSmartTeamToggle() {
  toggleAutomaticTeamFormation()
}

</script>
