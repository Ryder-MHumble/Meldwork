<template>
  <footer class="composer-zone">
    <div class="composer-shell">
      <section
        v-if="skillMenuOpen"
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
        :class="{ 'is-dragging-files': composerDropActive }"
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
              @click="discussionMode = 'manual'"
            >
              {{ t('composer.manual') }}
            </button>
            <button
              type="button"
              data-mode="auto"
              :class="{ active: discussionMode === 'auto' }"
              :aria-pressed="discussionMode === 'auto'"
              :disabled="Boolean(activeRun) || sending"
              @click="discussionMode = 'auto'"
            >
              {{ t('composer.auto') }}
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
                :aria-label="discussionMode === 'auto'
                  ? t('composer.autoTarget', { agent: agentLabel(kind) })
                  : t(isComposerTargetSelected(kind) ? 'composer.removeTarget' : 'composer.addTarget', { agent: agentLabel(kind) })"
                :aria-pressed="isComposerTargetSelected(kind)"
                :disabled="Boolean(activeRun) || sending || discussionMode === 'auto' || automaticTeamFormation"
                @click="toggleTarget(kind)"
              >
                <img :src="agentLogo(kind, theme)" alt="" />
                <span class="visually-hidden">{{ agentLabel(kind) }}</span>
              </button>
            </div>
          </div>

          <div
            v-if="discussionMode === 'auto'"
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
              :class="{ unlimited: unlimitedRounds }"
              :disabled="Boolean(activeRun) || sending"
              @click="roundSettingsOpen = !roundSettingsOpen"
            >
              <span>{{ unlimitedRounds ? t('composer.unlimitedRounds') : t('composer.autoRounds', { count: maxRounds }) }}</span>
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
              <span class="composer-attachment-media-icon" aria-hidden="true">
                <DocumentTextOutline v-if="attachmentKind(attachment) === 'file'" />
                <AttachOutline v-else />
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

        <div class="composer-input-shell">
          <div
            v-if="activeGroup.conversationType !== 'direct' && selectedAgentKinds.length"
            class="selected-agent-list"
            :aria-label="t('composer.mentionedAgents')"
          >
            <span v-for="kind in selectedAgentKinds" :key="kind" class="selected-agent-tag">
              <img :src="agentLogo(kind, theme)" alt="" />
              {{ agentLabel(kind) }}
              <button
                type="button"
                :title="t('composer.removeMention', { agent: agentLabel(kind) })"
                :aria-label="t('composer.removeMention', { agent: agentLabel(kind) })"
                :disabled="Boolean(activeRun) || sending"
                @click="removeAgentMention(kind)"
              >
                <CloseOutline />
              </button>
            </span>
          </div>
          <div
            v-if="selectedSkills.length || selectedKnowledgeBases.length"
            class="selected-agent-list selected-context-list"
            :aria-label="t('composer.mentions')"
          >
            <span v-for="skill in selectedSkills" :key="skillKey(skill)" class="selected-agent-tag selected-skill">
              <LibraryOutline class="selected-context-icon" aria-hidden="true" />
              @{{ skill.name || skill.slug }}
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
            <span
              v-for="source in selectedKnowledgeBases"
              :key="`knowledge:${source.kind}`"
              class="selected-agent-tag selected-skill selected-knowledge-base"
            >
              <img :src="knowledgeBaseLogo(source.kind)" alt="" />
              @{{ knowledgeBaseName(source.kind) }}
              <button
                type="button"
                :title="t('composer.removeKnowledgeBase')"
                :aria-label="t('composer.removeKnowledgeBase')"
                :disabled="Boolean(activeRun) || sending"
                @click="removeKnowledgeBase(source.kind)"
              >
                <CloseOutline />
              </button>
            </span>
          </div>
          <textarea
            ref="composerInput"
            v-model="draft"
            rows="1"
            :placeholder="automaticTeamFormation
              ? t('composer.smartTeamPlaceholder')
              : t(discussionMode === 'auto' && unlimitedRounds
                ? 'composer.unlimitedPlaceholder'
                : 'composer.placeholder', {
                  name: groupName(activeGroup),
                })"
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
import { ref } from 'vue'
import {
  AddOutline,
  AttachOutline,
  AtOutline,
  ChevronDownOutline,
  CloseCircleOutline,
  CloseOutline,
  DocumentTextOutline,
  LibraryOutline,
  RefreshOutline,
  SendOutline,
  StopCircleOutline,
} from '@vicons/ionicons5'
import { agentLabel, agentLogo } from '../catalog.js'
import { MAX_SKILLS, skillKey } from '../composables/useComposerContext.js'

const props = defineProps({
  controller: { type: Object, required: true },
})

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

function handleSmartTeamToggle() {
  toggleAutomaticTeamFormation()
}

</script>
