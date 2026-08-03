<template>
  <section class="settings-panel provider-settings-panel">
    <header class="provider-page-header">
      <div>
        <h2>{{ t('provider.title') }}</h2>
        <p>{{ t('provider.subtitle') }}</p>
      </div>
      <span class="provider-summary-count">
        {{ t('provider.configuredCount', {
          configured: provider.providerConfiguredCount,
          total: provider.configurableProviderAgents.length,
        }) }}
      </span>
    </header>
    <nav class="provider-agent-list" :aria-label="t('systemSettings.providers')">
      <button
        v-for="agent in provider.configurableProviderAgents"
        :key="agent.kind"
        type="button"
        :aria-pressed="provider.selectedProviderKind === agent.kind ? 'true' : 'false'"
        :class="{ active: provider.selectedProviderKind === agent.kind }"
        @click="provider.selectProviderAgent(agent.kind)"
      >
        <img :src="agent.logo" alt="" />
        <span class="provider-agent-copy">
          <strong>{{ agent.label }}</strong>
          <small :class="provider.providerStatusTone(agent.kind)">{{ provider.providerStatusLabel(agent.kind) }}</small>
        </span>
        <component
          :is="provider.providerStatusIcon(agent.kind)"
          :class="{
            ready: provider.providerReady(agent.kind),
            spinning: provider.providerStatusIsChecking(agent.kind),
          }"
        />
      </button>
    </nav>

    <form
      class="provider-editor form-stack"
      :aria-busy="String(provider.providerStatusIsChecking(provider.selectedProviderKind))"
      @submit.prevent="provider.saveProvider"
    >
      <header v-if="provider.selectedProviderAgent" class="provider-editor-header">
        <img :src="provider.selectedProviderAgent.logo" alt="" />
        <div class="provider-editor-title">
          <h2>{{ t('provider.agentTitle', { agent: provider.selectedProviderAgent.label }) }}</h2>
          <div class="provider-agent-state" :class="provider.selectedProviderAgentState.tone" role="status">
            <component
              :is="provider.selectedProviderAgentState.icon"
              :class="{ spinning: provider.selectedProviderAgentState.id === 'checking' }"
            />
            <span>
              <strong>{{ provider.selectedProviderAgentState.label }}</strong>
              <small>{{ provider.selectedProviderAgentState.detail }}</small>
            </span>
          </div>
        </div>
      </header>

      <section class="provider-source-section" :aria-label="t('provider.source')">
        <div class="provider-source-heading">
          <span>{{ t('provider.source') }}</span>
        </div>
        <div class="provider-source-options">
          <button
            v-for="preset in provider.selectedProviderPresets"
            :key="preset.id"
            type="button"
            :aria-pressed="provider.providerForm.preset === preset.id ? 'true' : 'false'"
            :class="{ active: provider.providerForm.preset === preset.id }"
            :disabled="saving"
            :title="provider.providerPresetHint(preset.id)"
            @click="provider.applyProviderPreset(preset.id)"
          >
            <strong>{{ provider.providerPresetLabel(preset.id) }}</strong>
            <small :class="{
              active: provider.providerPresetActive(preset.id),
              configured: provider.providerPresetConfigured(preset.id),
            }">
              {{ provider.providerPresetStateLabel(preset.id) }}
            </small>
          </button>
        </div>
      </section>

      <section v-if="provider.selectedProviderPreset" class="provider-source-detail">
        <header class="provider-source-overview">
          <TerminalOutline v-if="provider.providerNativeOfficialMode" />
          <KeyOutline v-else />
          <div>
            <strong>{{ t('provider.sourceTitle', {
              provider: provider.providerPresetLabel(provider.selectedProviderPreset.id),
            }) }}</strong>
            <p>{{ provider.providerPresetHint(provider.selectedProviderPreset.id) }}</p>
            <small>{{ t('provider.agentSpecificHint') }}</small>
          </div>
        </header>

        <div v-if="provider.providerStatus.error" class="provider-inline-warning" role="status">
          <span>{{ t('provider.unavailable') }}</span>
          <button
            type="button"
            :disabled="saving"
            @click="provider.retryProviderStatus(provider.selectedProviderKind)"
          >
            <RefreshOutline />
            {{ t('common.retry') }}
          </button>
        </div>
        <p v-if="provider.providerStatus.encryptionAvailable === false" class="form-error">
          {{ t('provider.encryptionUnavailable') }}
        </p>

        <template v-if="provider.providerNativeOfficialMode">
          <div class="provider-native-card" :class="provider.selectedProviderAgentState.tone">
            <TerminalOutline />
            <div class="provider-native-card-content">
              <strong>{{ t('provider.nativeTitle') }}</strong>
              <p>{{ provider.providerNativeGuideBody }}</p>
              <div v-if="provider.providerNativeActionVisible" class="provider-native-actions">
                <button
                  class="secondary-button"
                  type="button"
                  :disabled="saving"
                  @click="$emit('open-agent-manager', provider.selectedProviderKind)"
                >
                  <SettingsOutline />
                  {{ t('provider.manageAgent') }}
                </button>
              </div>
            </div>
          </div>

          <div class="provider-doc-card">
            <div>
              <strong>{{ t('provider.configGuide') }}</strong>
              <p>{{ t(provider.selectedProviderProfile.docsKey) }}</p>
            </div>
            <dl>
              <div v-if="provider.selectedProviderProfile.configFile">
                <dt>{{ t('provider.configFile') }}</dt>
                <dd><code>{{ provider.selectedProviderProfile.configFile }}</code></dd>
              </div>
              <div v-if="provider.selectedProviderProfile.runtimeKeys.length">
                <dt>{{ t('provider.runtimeKeys') }}</dt>
                <dd>
                  <code v-for="key in provider.selectedProviderProfile.runtimeKeys" :key="key">{{ key }}</code>
                </dd>
              </div>
            </dl>
          </div>
        </template>

        <template v-else>
          <div v-if="provider.selectedProviderProfileSaved" class="provider-profile-summary">
            <span :class="{ active: provider.selectedProviderPresetActive }">
              {{ provider.selectedProviderPresetActive ? t('provider.active') : t('provider.saved') }}
            </span>
            <span v-if="provider.selectedProviderProfileStatus?.provider">
              {{ provider.selectedProviderProfileStatus.provider }}
            </span>
            <span v-if="provider.selectedProviderProfileStatus?.model">
              {{ provider.selectedProviderProfileStatus.model }}
            </span>
          </div>

          <p v-if="provider.providerIdentityLocked" class="provider-field-note">
            {{ t('provider.identityLocked') }}
          </p>
          <div class="provider-external-fields">
            <label class="provider-field-name">
              <span>{{ t('provider.name') }}</span>
              <input
                v-model.trim="provider.providerForm.provider"
                :placeholder="t('provider.namePlaceholder')"
                autocomplete="off"
                maxlength="80"
                :readonly="provider.providerIdentityLocked"
                :aria-readonly="provider.providerIdentityLocked ? 'true' : undefined"
                :disabled="provider.providerFormControlsDisabled"
              />
            </label>
            <label class="provider-field-url">
              <span>{{ t('provider.baseUrl') }}</span>
              <input
                v-model.trim="provider.providerForm.baseUrl"
                :placeholder="t('provider.baseUrlPlaceholder')"
                inputmode="url"
                autocomplete="off"
                maxlength="300"
                :readonly="provider.providerIdentityLocked"
                :aria-readonly="provider.providerIdentityLocked ? 'true' : undefined"
                :disabled="provider.providerFormControlsDisabled"
              />
            </label>
            <label class="provider-field-model">
              <span>{{ t('provider.model') }}</span>
              <input
                v-model.trim="provider.providerForm.model"
                :placeholder="t('provider.modelPlaceholder')"
                autocomplete="off"
                maxlength="160"
                :disabled="provider.providerFormControlsDisabled"
              />
            </label>
            <label class="provider-field-key">
              <span>{{ t('provider.apiKey') }}</span>
              <input
                v-model="provider.providerForm.apiKey"
                type="password"
                :placeholder="t('provider.apiKeyPlaceholder')"
                autocomplete="new-password"
                maxlength="8192"
                :disabled="provider.providerFormControlsDisabled"
              />
            </label>
          </div>
        </template>
      </section>

      <p v-if="formError" class="form-error">{{ formError }}</p>
      <footer class="provider-editor-footer">
        <button
          v-if="provider.selectedProviderProfileSaved"
          class="danger-button"
          type="button"
          :disabled="saving"
          @click="provider.removeProvider"
        >
          <TrashOutline />
          {{ provider.providerRemoveArmed ? t('provider.removeConfirm') : t('provider.remove') }}
        </button>
        <span class="footer-spacer" />
        <button
          v-if="provider.selectedProviderPresetConfigured && !provider.selectedProviderPresetActive"
          class="secondary-button provider-activate-button"
          type="button"
          :disabled="saving"
          @click="provider.activateProviderPreset(provider.providerForm.preset)"
        >
          <CheckmarkCircleOutline />
          {{ t('provider.useProfile') }}
        </button>
        <button
          v-if="!provider.providerNativeOfficialMode"
          class="primary-button"
          type="submit"
          :disabled="provider.providerFormControlsDisabled || provider.providerStatus.encryptionAvailable === false"
        >
          {{ provider.providerSaveActionLabel }}
        </button>
      </footer>
    </form>
  </section>
</template>

<script setup>
import { reactive } from 'vue'
import {
  CheckmarkCircleOutline,
  KeyOutline,
  RefreshOutline,
  SettingsOutline,
  TerminalOutline,
  TrashOutline,
} from '@vicons/ionicons5'
import { t } from '../i18n.js'

const props = defineProps({
  controller: { type: Object, required: true },
  formError: { type: String, required: true },
  saving: { type: Boolean, required: true },
})

defineEmits(['open-agent-manager'])

const provider = reactive(props.controller)
</script>
