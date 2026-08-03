<template>
  <form v-if="modal === 'new-group'" class="modal-body form-stack" @submit.prevent="createGroup">
    <label>
      <span>{{ t('group.name') }}</span>
      <input v-model.trim="groupForm.name" :placeholder="t('group.namePlaceholder')" maxlength="60" :disabled="saving" />
    </label>
    <label>
      <span>{{ t('group.topic') }}</span>
      <input v-model.trim="groupForm.topic" :placeholder="t('group.topicPlaceholder')" maxlength="200" :disabled="saving" />
    </label>
    <fieldset :disabled="saving">
      <legend class="agent-choice-legend">
        <span>{{ t('group.agents') }}</span>
        <small>{{ t('group.selectedCount', { count: groupForm.agentKinds.length }) }}</small>
      </legend>
      <div class="agent-choice-grid">
        <label
          v-for="agent in readyAgents"
          :key="agent.kind"
          class="agent-choice"
          :class="{ selected: groupForm.agentKinds.includes(agent.kind) }"
          :title="agent.label"
        >
          <input v-model="groupForm.agentKinds" type="checkbox" :value="agent.kind" />
          <img :src="agent.logo" alt="" />
          <span>{{ agent.label }}</span>
          <CheckmarkCircleOutline />
        </label>
      </div>
    </fieldset>
    <label>
      <span>{{ t('group.workspace') }}</span>
      <div class="input-action-row">
        <input v-model="groupForm.workdir" :title="groupForm.workdir" readonly />
        <button class="secondary-button" type="button" :disabled="saving" @click="pickGroupDirectory('new')">
          <FolderOpenOutline />
          {{ t('group.pickFolder') }}
        </button>
      </div>
    </label>
    <label class="switch-row">
      <input v-model="groupForm.allowWrite" type="checkbox" :disabled="saving" />
      <span class="switch-control" />
      <span>{{ t('group.allowWrite') }}</span>
    </label>
    <p v-if="formError" class="form-error" role="alert">{{ formError }}</p>
    <footer class="modal-footer">
      <button class="secondary-button" type="button" :disabled="saving" @click="closeModal">{{ t('common.cancel') }}</button>
      <button class="primary-button" type="submit" :disabled="saving">
        {{ saving ? t('common.saving') : t('group.create') }}
      </button>
    </footer>
  </form>

  <form v-else-if="modal === 'settings'" class="modal-body form-stack settings-form" @submit.prevent="saveGroupSettings">
    <div class="settings-primary-grid">
      <label>
        <span>{{ activeGroup?.conversationType === 'direct' ? t('settings.conversationName') : t('group.name') }}</span>
        <input
          ref="settingsNameInput"
          v-model.trim="settingsForm.name"
          :placeholder="t('group.namePlaceholder')"
          maxlength="60"
          :disabled="saving"
        />
      </label>
      <label>
        <span>{{ t('group.topic') }}</span>
        <input
          v-model.trim="settingsForm.topic"
          :placeholder="t('group.topicPlaceholder')"
          maxlength="200"
          :disabled="saving"
        />
      </label>
    </div>
    <fieldset v-if="activeGroup?.conversationType !== 'direct'" class="settings-agent-fieldset" :disabled="saving">
      <legend class="agent-choice-legend">
        <span>{{ t('group.agents') }}</span>
        <small>{{ t('group.selectedCount', { count: settingsForm.agentKinds.length }) }}</small>
      </legend>
      <div class="agent-choice-grid settings-agent-choice-grid">
        <label
          v-for="agent in readyAgents"
          :key="agent.kind"
          class="agent-choice settings-agent-choice"
          :class="{ selected: settingsForm.agentKinds.includes(agent.kind) }"
          :title="agent.label"
        >
          <input v-model="settingsForm.agentKinds" type="checkbox" :value="agent.kind" />
          <img :src="agent.logo" alt="" />
          <span>{{ agent.label }}</span>
          <CheckmarkCircleOutline />
        </label>
      </div>
    </fieldset>
    <label>
      <span>{{ t('group.workspace') }}</span>
      <div class="input-action-row">
        <input v-model="settingsForm.workdir" :title="settingsForm.workdir" readonly />
        <button class="secondary-button" type="button" :disabled="saving" @click="pickGroupDirectory('settings')">
          <FolderOpenOutline />
          {{ t('group.pickFolder') }}
        </button>
      </div>
    </label>
    <label class="switch-row">
      <input v-model="settingsForm.allowWrite" type="checkbox" :disabled="saving" />
      <span class="switch-control" />
      <span>{{ t('group.allowWrite') }}</span>
    </label>
    <p v-if="formError" class="form-error" role="alert">{{ formError }}</p>
    <footer class="modal-footer settings-modal-footer">
      <div class="settings-delete-control">
        <button
          class="settings-delete-trigger"
          type="button"
          :aria-expanded="String(deleteArmed)"
          aria-controls="settings-delete-confirmation"
          :disabled="saving"
          @click="requestDeleteConfirmation"
        >
          <TrashOutline />
          {{ t('settings.delete') }}
        </button>
        <div
          v-if="deleteArmed"
          id="settings-delete-confirmation"
          class="settings-delete-popover"
          role="alertdialog"
          aria-modal="false"
          aria-labelledby="settings-delete-title"
          aria-describedby="settings-delete-description"
        >
          <strong id="settings-delete-title">{{ t('settings.deletePrompt') }}</strong>
          <p id="settings-delete-description">{{ t('settings.deleteHint') }}</p>
          <div class="settings-delete-actions">
            <button class="secondary-button compact" type="button" :disabled="saving" @click="dismissDeleteConfirmation">
              {{ t('common.cancel') }}
            </button>
            <button class="danger-button" type="button" :disabled="saving" @click="deleteConversation">
              {{ t('settings.deleteConfirm') }}
            </button>
          </div>
        </div>
      </div>
      <div class="modal-footer-actions">
        <button class="secondary-button" type="button" :disabled="saving" @click="closeModal">{{ t('common.cancel') }}</button>
        <button class="primary-button" type="submit" :disabled="saving">
          {{ saving ? t('common.saving') : t('settings.save') }}
        </button>
      </div>
    </footer>
  </form>

  <form v-else-if="modal === 'custom-agent'" class="modal-body form-stack custom-agent-form" @submit.prevent="createCustomAgent">
    <label>
      <span>{{ t('customAgent.name') }}</span>
      <input
        v-model.trim="customAgentForm.label"
        :placeholder="t('customAgent.namePlaceholder')"
        maxlength="60"
        :disabled="saving"
      />
    </label>
    <label>
      <span>{{ t('customAgent.description') }}</span>
      <textarea
        v-model.trim="customAgentForm.description"
        :placeholder="t('customAgent.descriptionPlaceholder')"
        maxlength="240"
        rows="3"
        :disabled="saving"
      />
    </label>
    <label>
      <span>{{ t('customAgent.arguments') }}</span>
      <textarea
        v-model="customAgentForm.argumentsText"
        :placeholder="t('customAgent.argumentsPlaceholder')"
        rows="4"
        :disabled="saving"
      />
      <small>{{ t('customAgent.argumentsHint') }}</small>
    </label>
    <fieldset>
      <legend>{{ t('customAgent.promptMode') }}</legend>
      <div class="segmented-control custom-agent-prompt-modes">
        <label :class="{ active: customAgentForm.promptMode === 'stdin' }">
          <input v-model="customAgentForm.promptMode" type="radio" value="stdin" :disabled="saving" />
          {{ t('customAgent.promptStdin') }}
        </label>
        <label :class="{ active: customAgentForm.promptMode === 'argument' }">
          <input v-model="customAgentForm.promptMode" type="radio" value="argument" :disabled="saving" />
          {{ t('customAgent.promptArgument') }}
        </label>
      </div>
    </fieldset>
    <div class="custom-agent-security-notice">
      <WarningOutline />
      <p>{{ t('customAgent.securityNotice') }}</p>
    </div>
    <p v-if="formError" class="form-error" role="alert">{{ formError }}</p>
    <footer class="modal-footer">
      <button class="secondary-button" type="button" :disabled="saving" @click="closeModal">{{ t('common.cancel') }}</button>
      <button class="primary-button" type="submit" :disabled="saving || !customAgentForm.label">
        {{ saving ? t('common.saving') : t('customAgent.chooseExecutable') }}
      </button>
    </footer>
  </form>

  <section v-else-if="modal === 'unlimited-confirm'" class="modal-body confirmation-modal-body">
    <p>{{ t('composer.unlimitedConfirm') }}</p>
    <footer class="modal-footer confirmation-modal-footer">
      <button class="secondary-button" type="button" @click="closeModal">{{ t('common.cancel') }}</button>
      <button class="primary-button" type="button" @click="confirmUnlimitedRounds">{{ t('common.confirm') }}</button>
    </footer>
  </section>

  <section v-else-if="modal === 'agent-detail' && selectedAgentDetail" class="modal-body agent-detail-body">
    <div class="agent-detail-hero">
      <img :src="selectedAgentDetail.logo" :alt="selectedAgentDetail.label" />
      <div>
        <span class="agent-state" :class="agentState(selectedAgentDetail).tone">
          <component :is="agentState(selectedAgentDetail).icon" />
          {{ agentState(selectedAgentDetail).label }}
        </span>
        <p>{{ agentDescription(selectedAgentDetail.kind) }}</p>
      </div>
    </div>

    <div class="agent-detail-metrics">
      <span>
        <strong>{{ t('agentDetail.skills') }}</strong>
        <small>{{ agentDetailSkillSummary }}</small>
      </span>
      <span>
        <strong>{{ t('agentDetail.provider') }}</strong>
        <small>{{ providerSummaryLabel(selectedAgentDetail) }}</small>
      </span>
      <span>
        <strong>{{ t('agentDetail.images') }}</strong>
        <small>{{ agentImageLabel(selectedAgentDetail) }}</small>
      </span>
    </div>

    <section class="agent-detail-section">
      <h3>{{ t('agentDetail.soul') }}</h3>
      <p>{{ agentSoul(selectedAgentDetail) }}</p>
    </section>

    <label v-if="selectedAgentDetail.installed" class="sidebar-visibility-control switch-row">
      <input
        type="checkbox"
        :checked="selectedAgentDetail.showInSidebar !== false"
        :disabled="saving"
        @change="setAgentSidebarVisibility(selectedAgentDetail, $event.target.checked)"
      />
      <span class="switch-control" />
      <span>
        <strong>{{ t('agentDetail.showInSidebar') }}</strong>
        <small>{{ t('agentDetail.showInSidebarHint') }}</small>
      </span>
    </label>

    <section class="agent-detail-section">
      <h3>{{ t('agentDetail.localSkills') }}</h3>
      <p v-if="agentDetailSkillsLoading" class="agent-detail-muted">{{ t('agent.skillsLoading') }}</p>
      <p v-else-if="!agentDetailSkillItems.length" class="agent-detail-muted">{{ t('agent.skillsUnavailable') }}</p>
      <div v-else class="agent-detail-skill-grid">
        <span v-for="skill in agentDetailSkillItems" :key="skillKey(skill)">
          <strong>@{{ skill.name || skill.slug }}</strong>
          <small>{{ skill.namespace }}</small>
        </span>
      </div>
    </section>

    <p v-if="formError" class="form-error" role="alert">{{ formError }}</p>
    <footer class="modal-footer agent-detail-footer">
      <button
        v-if="selectedAgentDetail.custom"
        class="danger-button"
        type="button"
        :disabled="saving"
        @click="deleteCustomAgent"
      >
        <TrashOutline />
        {{ customAgentDeleteArmed ? t('customAgent.deleteConfirm') : t('customAgent.delete') }}
      </button>
      <button class="secondary-button" type="button" @click="closeModal">{{ t('common.close') }}</button>
      <button
        v-if="supportsExternalProvider(selectedAgentDetail)"
        class="secondary-button"
        type="button"
        @click="openProvider(selectedAgentDetail.kind)"
      >
        <KeyOutline />
        {{ t('systemSettings.providerForAgent') }}
      </button>
      <button
        v-if="selectedAgentDetail.ready"
        class="primary-button"
        type="button"
        :disabled="isDirectCreationPending(selectedAgentDetail.kind)"
        @click="openDirect(selectedAgentDetail)"
      >
        <ChatbubbleEllipsesOutline />
        {{ t('home.openChat') }}
      </button>
      <button
        v-else-if="!selectedAgentDetail.installed && selectedAgentDetail.installSupported"
        class="primary-button"
        type="button"
        :disabled="installerBusy && installerState.kind !== selectedAgentDetail.kind"
        @click="requestInstall(selectedAgentDetail)"
      >
        <DownloadOutline />
        {{ t('installer.install') }}
      </button>
    </footer>
  </section>
</template>

<script setup>
import { ref } from 'vue'
import {
  ChatbubbleEllipsesOutline,
  CheckmarkCircleOutline,
  DownloadOutline,
  FolderOpenOutline,
  KeyOutline,
  TrashOutline,
  WarningOutline,
} from '@vicons/ionicons5'
import { skillKey } from '../composables/useComposerContext.js'

const props = defineProps({
  controller: { type: Object, required: true },
})

const {
  activeGroup,
  agentDescription,
  agentDetailSkillItems,
  agentDetailSkillSummary,
  agentDetailSkillsLoading,
  agentImageLabel,
  agentSoul,
  agentState,
  closeModal,
  confirmUnlimitedRounds,
  createCustomAgent,
  createGroup,
  customAgentDeleteArmed,
  customAgentForm,
  deleteArmed,
  deleteConversation,
  deleteCustomAgent,
  dismissDeleteConfirmation,
  formError,
  groupForm,
  installerBusy,
  installerState,
  isDirectCreationPending,
  modal,
  openDirect,
  openProvider,
  pickGroupDirectory,
  providerSummaryLabel,
  readyAgents,
  requestDeleteConfirmation,
  requestInstall,
  saveGroupSettings,
  saving,
  selectedAgentDetail,
  setAgentSidebarVisibility,
  settingsForm,
  supportsExternalProvider,
  t,
} = props.controller

const settingsNameInput = ref(null)

function focusSettingsName() {
  settingsNameInput.value?.focus?.()
}

defineExpose({ focusSettingsName })
</script>
