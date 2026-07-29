<template>
  <main class="app-shell" :data-theme="theme">
    <section v-if="booting" class="boot-state" aria-live="polite">
      <img class="boot-logo" :src="productLogo" alt="RoundRelay" />
      <p>{{ t('app.loading') }}</p>
      <div class="skeleton-line" />
    </section>

    <section v-else-if="bridgeMissing" class="bridge-state">
      <img class="bridge-logo" :src="productLogo" alt="RoundRelay" />
      <h1>{{ t('app.desktopRequired') }}</h1>
      <p>{{ t('app.desktopRequiredDetail') }}</p>
    </section>

    <template v-else>
      <aside class="sidebar">
        <header class="brand-row">
          <button class="brand-button" type="button" @click="goHome">
            <img :src="productLogo" alt="" />
            <span>
              <strong>RoundRelay</strong>
              <small>{{ t('app.localWorkspace') }}</small>
            </span>
          </button>
          <div class="brand-actions">
            <button
              class="icon-button"
              type="button"
              :title="t('common.languageTarget')"
              :aria-label="t('common.language')"
              @click="toggleLocale"
            >
              <LanguageOutline />
            </button>
            <button
              class="icon-button"
              type="button"
              :title="theme === 'dark' ? t('common.themeLight') : t('common.themeDark')"
              :aria-label="theme === 'dark' ? t('common.themeLight') : t('common.themeDark')"
              @click="toggleTheme"
            >
              <SunnyOutline v-if="theme === 'dark'" />
              <MoonOutline v-else />
            </button>
          </div>
        </header>

        <button class="new-group-button" type="button" @click="openNewGroup">
          <AddOutline />
          <span>{{ t('nav.newGroup') }}</span>
        </button>

        <nav class="conversation-nav" :aria-label="t('nav.conversations')">
          <section class="nav-section">
            <div class="nav-heading">
              <span>{{ t('nav.direct') }}</span>
              <PersonOutline />
            </div>
            <button
              v-for="group in directGroups"
              :key="group.id"
              class="conversation-link"
              :class="{ active: selectedGroupId === group.id }"
              type="button"
              @click="selectGroup(group.id)"
            >
              <img :src="agentLogo(group.directAgentKind)" alt="" />
              <span>{{ groupName(group) }}</span>
              <span v-if="isGroupRunning(group.id)" class="run-mark" :title="t('conversation.runningGeneric')">
                <StopCircleOutline />
              </span>
            </button>
            <p v-if="!directGroups.length" class="nav-empty">{{ t('nav.noDirect') }}</p>
          </section>

          <section class="nav-section">
            <div class="nav-heading">
              <span>{{ t('nav.groups') }}</span>
              <PeopleOutline />
            </div>
            <button
              v-for="group in groupGroups"
              :key="group.id"
              class="conversation-link"
              :class="{ active: selectedGroupId === group.id }"
              type="button"
              @click="selectGroup(group.id)"
            >
              <span class="group-avatar"><ChatbubblesOutline /></span>
              <span>{{ groupName(group) }}</span>
              <span v-if="isGroupRunning(group.id)" class="run-mark" :title="t('conversation.runningGeneric')">
                <StopCircleOutline />
              </span>
            </button>
            <p v-if="!groupGroups.length" class="nav-empty">{{ t('nav.noGroups') }}</p>
          </section>
        </nav>

        <footer class="sidebar-footer">
          <button type="button" @click="openAgentManager">
            <TerminalOutline />
            <span>{{ t('nav.agents') }}</span>
            <span class="footer-count">{{ readyCount }}/{{ AGENTS.length }}</span>
          </button>
          <button type="button" @click="openProvider">
            <KeyOutline />
            <span>{{ t('nav.provider') }}</span>
            <CheckmarkCircleOutline v-if="providerStatus.configured" class="footer-status ready" />
            <WarningOutline v-else class="footer-status" />
          </button>
        </footer>
      </aside>

      <section class="workspace-pane">
        <section v-if="!activeGroup" class="agent-home">
          <header class="home-header">
            <div>
              <h1>{{ t('home.title') }}</h1>
              <p>{{ t('home.subtitle') }}</p>
            </div>
            <div class="header-actions">
              <button class="secondary-button" type="button" :disabled="refreshing" @click="refreshAgents">
                <RefreshOutline :class="{ spinning: refreshing }" />
                <span>{{ refreshing ? t('home.refreshing') : t('home.refresh') }}</span>
              </button>
              <button class="primary-button" type="button" @click="openAgentManager">
                <SettingsOutline />
                <span>{{ t('home.manage') }}</span>
              </button>
            </div>
          </header>

          <div class="home-summary">
            <strong>{{ t('home.readyCount', { ready: readyCount, installed: installedCount }) }}</strong>
          </div>

          <div class="agent-grid">
            <article v-for="agent in mergedCatalog" :key="agent.kind" class="agent-card">
              <button class="agent-card-main" type="button" @click="handleAgentPrimary(agent)">
                <img :src="agent.logo" :alt="agent.label" />
                <span class="agent-card-copy">
                  <span class="agent-name-row">
                    <strong>{{ agent.label }}</strong>
                    <span class="agent-state" :class="agentState(agent).tone">
                      <component :is="agentState(agent).icon" />
                      {{ agentState(agent).label }}
                    </span>
                  </span>
                  <span class="agent-provider-mode">{{ providerModeLabel(agent.providerMode) }}</span>
                  <span v-if="agent.version" class="agent-version">
                    {{ t('agent.detectedVersion', { version: agent.version }) }}
                  </span>
                </span>
                <ChevronForwardOutline class="card-chevron" />
              </button>
              <div class="agent-card-actions">
                <button v-if="agent.ready" type="button" @click="openDirect(agent)">
                  <ChatbubbleEllipsesOutline />
                  {{ t('home.openChat') }}
                </button>
                <button v-else type="button" @click="openAgentManager(agent.kind)">
                  <DownloadOutline v-if="!agent.installed" />
                  <SettingsOutline v-else />
                  {{ agent.installed ? t('home.configure') : t('home.install') }}
                </button>
              </div>
            </article>
          </div>
        </section>

        <section v-else class="conversation-pane">
          <header class="conversation-header">
            <div class="conversation-identity">
              <div v-if="activeGroup.conversationType === 'direct'" class="conversation-avatar single">
                <img :src="agentLogo(activeGroup.directAgentKind)" alt="" />
              </div>
              <div v-else class="conversation-avatar stack">
                <img
                  v-for="kind in activeGroup.agentKinds.slice(0, 3)"
                  :key="kind"
                  :src="agentLogo(kind)"
                  alt=""
                />
              </div>
              <div>
                <h1>{{ groupName(activeGroup) }}</h1>
                <p>
                  <span>{{ activeGroup.conversationType === 'direct' ? t('conversation.direct') : t('conversation.members', { count: activeGroup.agentKinds.length }) }}</span>
                  <span class="meta-separator">/</span>
                  <span>{{ activeGroup.allowWrite ? t('conversation.writeEnabled') : t('conversation.readOnly') }}</span>
                </p>
              </div>
            </div>
            <div class="conversation-header-actions">
              <button class="workspace-chip" type="button" :title="activeGroup.workdir" @click="openGroupSettings">
                <FolderOpenOutline />
                <span>{{ compactPath(activeGroup.workdir) }}</span>
              </button>
              <button
                class="icon-button"
                type="button"
                :title="t('conversation.settings')"
                :aria-label="t('conversation.settings')"
                @click="openGroupSettings"
              >
                <SettingsOutline />
              </button>
            </div>
          </header>

          <div ref="messageScroller" class="message-scroll">
            <section v-if="!activeMessages.length" class="conversation-empty">
              <div class="empty-icon">
                <ChatbubbleEllipsesOutline />
              </div>
              <h2>{{ t('conversation.emptyTitle') }}</h2>
              <p v-if="activeGroup.conversationType === 'direct'">
                {{ t('conversation.emptyDirect', { agent: agentLabel(activeGroup.directAgentKind) }) }}
              </p>
              <p v-else>{{ t('conversation.emptyGroup') }}</p>
            </section>

            <div v-else class="message-list">
              <article
                v-for="message in activeMessages"
                :key="message.id"
                class="message-row"
                :class="message.role"
              >
                <template v-if="message.role === 'system'">
                  <div class="system-message">
                    <WarningOutline />
                    <span>{{ translateSystemMessage(message) }}</span>
                  </div>
                </template>
                <template v-else>
                  <img
                    v-if="message.role === 'agent'"
                    class="message-avatar"
                    :src="agentLogo(message.agentKind)"
                    :alt="agentLabel(message.agentKind)"
                  />
                  <div class="message-body">
                    <div class="message-meta">
                      <strong>{{ message.role === 'user' ? t('conversation.you') : agentLabel(message.agentKind) }}</strong>
                      <time>{{ formatTime(message.createdAt) }}</time>
                    </div>
                    <div
                      v-if="message.role === 'agent'"
                      class="message-content markdown-body"
                      v-html="renderMessage(message.content)"
                    />
                    <div v-else class="message-content plain-message">{{ message.content }}</div>
                  </div>
                </template>
              </article>

              <div v-if="activeRun" class="running-row" aria-live="polite">
                <img v-if="activeRun.currentKind" :src="agentLogo(activeRun.currentKind)" alt="" />
                <div class="typing-bars"><span /><span /><span /></div>
                <span>{{ activeRun.currentKind ? t('conversation.running', { agent: agentLabel(activeRun.currentKind) }) : t('conversation.runningGeneric') }}</span>
              </div>
            </div>
          </div>

          <footer class="composer-zone">
            <div v-if="activeGroup.conversationType !== 'direct'" class="target-row">
              <span>{{ t('composer.targets') }}</span>
              <button
                v-for="kind in activeGroup.agentKinds"
                :key="kind"
                class="target-chip"
                :class="{ selected: targetKinds.includes(kind) }"
                type="button"
                :disabled="Boolean(activeRun)"
                @click="toggleTarget(kind)"
              >
                <img :src="agentLogo(kind)" alt="" />
                {{ agentLabel(kind) }}
              </button>
            </div>

            <div class="composer-box">
              <textarea
                v-model="draft"
                rows="1"
                :placeholder="t('composer.placeholder', { name: groupName(activeGroup) })"
                :disabled="Boolean(activeRun)"
                @keydown="handleComposerKeydown"
              />
              <div class="composer-actions">
                <div v-if="activeGroup.agentKinds.length >= 2" class="auto-controls">
                  <select v-model.number="autoTurns" :disabled="Boolean(activeRun)" :aria-label="t('composer.auto')">
                    <option v-for="count in [4, 6, 8, 12]" :key="count" :value="count">
                      {{ t('composer.autoTurns', { count }) }}
                    </option>
                  </select>
                  <button
                    class="secondary-button compact"
                    type="button"
                    :disabled="Boolean(activeRun)"
                    @click="startAutoDiscussion"
                  >
                    <PlayOutline />
                    {{ t('composer.auto') }}
                  </button>
                </div>
                <button v-if="activeRun" class="stop-button" type="button" @click="stopRun">
                  <StopCircleOutline />
                  {{ t('composer.stop') }}
                </button>
                <button v-else class="send-button" type="button" :disabled="!draft.trim() || sending" @click="sendMessage">
                  <SendOutline />
                  <span>{{ t('composer.send') }}</span>
                </button>
              </div>
            </div>
          </footer>
        </section>
      </section>

      <div v-if="modal" class="modal-backdrop" @mousedown.self="closeModal">
        <section class="modal" :class="{ wide: modal === 'agents' }" role="dialog" aria-modal="true">
          <header class="modal-header">
            <div>
              <h2>{{ modalTitle }}</h2>
              <p v-if="modalSubtitle">{{ modalSubtitle }}</p>
            </div>
            <button class="icon-button" type="button" :aria-label="t('common.close')" @click="closeModal">
              <CloseOutline />
            </button>
          </header>

          <form v-if="modal === 'new-group'" class="modal-body form-stack" @submit.prevent="createGroup">
            <label>
              <span>{{ t('group.name') }}</span>
              <input v-model.trim="groupForm.name" :placeholder="t('group.namePlaceholder')" maxlength="60" />
            </label>
            <label>
              <span>{{ t('group.topic') }}</span>
              <input v-model.trim="groupForm.topic" :placeholder="t('group.topicPlaceholder')" maxlength="200" />
            </label>
            <fieldset>
              <legend>{{ t('group.agents') }}</legend>
              <div class="agent-choice-grid">
                <label v-for="agent in readyAgents" :key="agent.kind" class="agent-choice" :class="{ selected: groupForm.agentKinds.includes(agent.kind) }">
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
                <input v-model="groupForm.workdir" readonly />
                <button class="secondary-button" type="button" @click="pickGroupDirectory('new')">
                  <FolderOpenOutline />
                  {{ t('group.pickFolder') }}
                </button>
              </div>
            </label>
            <label class="switch-row">
              <input v-model="groupForm.allowWrite" type="checkbox" />
              <span class="switch-control" />
              <span>{{ t('group.allowWrite') }}</span>
            </label>
            <p v-if="formError" class="form-error">{{ formError }}</p>
            <footer class="modal-footer">
              <button class="secondary-button" type="button" @click="closeModal">{{ t('common.cancel') }}</button>
              <button class="primary-button" type="submit" :disabled="saving">
                {{ saving ? t('common.saving') : t('group.create') }}
              </button>
            </footer>
          </form>

          <form v-else-if="modal === 'settings'" class="modal-body form-stack" @submit.prevent="saveGroupSettings">
            <label>
              <span>{{ t('group.name') }}</span>
              <input v-model.trim="settingsForm.name" maxlength="60" />
            </label>
            <label>
              <span>{{ t('group.topic') }}</span>
              <input v-model.trim="settingsForm.topic" maxlength="200" />
            </label>
            <fieldset v-if="activeGroup?.conversationType !== 'direct'">
              <legend>{{ t('group.agents') }}</legend>
              <div class="agent-choice-grid">
                <label v-for="agent in readyAgents" :key="agent.kind" class="agent-choice" :class="{ selected: settingsForm.agentKinds.includes(agent.kind) }">
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
                <input v-model="settingsForm.workdir" readonly />
                <button class="secondary-button" type="button" @click="pickGroupDirectory('settings')">
                  <FolderOpenOutline />
                  {{ t('group.pickFolder') }}
                </button>
              </div>
            </label>
            <label class="switch-row">
              <input v-model="settingsForm.allowWrite" type="checkbox" />
              <span class="switch-control" />
              <span>{{ t('group.allowWrite') }}</span>
            </label>
            <p v-if="formError" class="form-error">{{ formError }}</p>
            <div class="danger-zone">
              <div>
                <strong>{{ t('settings.delete') }}</strong>
                <p>{{ t('settings.deleteHint') }}</p>
              </div>
              <button class="danger-button" type="button" @click="deleteConversation">
                <TrashOutline />
                {{ deleteArmed ? t('settings.deleteConfirm') : t('settings.delete') }}
              </button>
            </div>
            <footer class="modal-footer">
              <button class="secondary-button" type="button" @click="closeModal">{{ t('common.cancel') }}</button>
              <button class="primary-button" type="submit" :disabled="saving">
                {{ saving ? t('common.saving') : t('settings.save') }}
              </button>
            </footer>
          </form>

          <section v-else-if="modal === 'agents'" class="modal-body agent-manager">
            <div class="manager-toolbar">
              <span>{{ t('home.readyCount', { ready: readyCount, installed: installedCount }) }}</span>
              <button class="secondary-button" type="button" :disabled="refreshing" @click="refreshAgents">
                <RefreshOutline :class="{ spinning: refreshing }" />
                {{ t('installer.refresh') }}
              </button>
            </div>
            <div class="manager-list">
              <article v-for="agent in mergedCatalog" :key="agent.kind" class="manager-row" :class="{ focused: focusedAgentKind === agent.kind }">
                <img :src="agent.logo" :alt="agent.label" />
                <div class="manager-copy">
                  <div>
                    <strong>{{ agent.label }}</strong>
                    <span class="agent-state" :class="agentState(agent).tone">
                      <component :is="agentState(agent).icon" />
                      {{ agentState(agent).label }}
                    </span>
                  </div>
                  <p>{{ providerModeLabel(agent.providerMode) }}</p>
                  <small v-if="agent.version">{{ t('agent.detectedVersion', { version: agent.version }) }}</small>
                  <div v-if="installConfirmKind === agent.kind" class="install-confirm">
                    <strong>{{ t('installer.confirm', { agent: agent.label }) }}</strong>
                    <span>{{ t('installer.confirmHint') }}</span>
                  </div>
                  <div v-if="installerState.kind === agent.kind && installerState.phase !== 'idle'" class="install-progress">
                    <span>{{ installerPhaseLabel }}</span>
                  </div>
                </div>
                <div class="manager-actions">
                  <button v-if="agent.ready" class="secondary-button compact" type="button" @click="openDirect(agent)">
                    <ChatbubbleEllipsesOutline />
                    {{ t('home.openChat') }}
                  </button>
                  <button
                    v-else-if="!agent.installed && agent.installSupported"
                    class="primary-button compact"
                    type="button"
                    :disabled="installerBusy && installerState.kind !== agent.kind"
                    @click="requestInstall(agent)"
                  >
                    <DownloadOutline />
                    {{ installConfirmKind === agent.kind ? t('installer.confirm', { agent: agent.label }) : t('installer.install') }}
                  </button>
                  <span v-else-if="!agent.installed" class="manager-note">
                    {{ agent.installErrorCode === 'INSTALL_AGENT_NODE_REQUIRED' ? t('installer.nodeRequired') : t('installer.unsupported') }}
                  </span>
                  <button
                    v-if="installerState.kind === agent.kind && installerState.canCancel"
                    class="secondary-button compact"
                    type="button"
                    @click="cancelInstall"
                  >
                    {{ t('installer.cancel') }}
                  </button>
                  <button v-else-if="agent.installed && !agent.ready && supportsSharedProvider(agent)" class="secondary-button compact" type="button" @click="openProvider">
                    <KeyOutline />
                    {{ t('nav.provider') }}
                  </button>
                </div>
              </article>
            </div>
          </section>

          <form v-else-if="modal === 'provider'" class="modal-body form-stack" @submit.prevent="saveProvider">
            <div class="provider-status" :class="{ configured: providerStatus.configured }">
              <CheckmarkCircleOutline v-if="providerStatus.configured" />
              <WarningOutline v-else />
              <span>{{ providerStatus.configured ? t('provider.configured') : t('provider.notConfigured') }}</span>
            </div>
            <p v-if="providerStatus.encryptionAvailable === false" class="form-error">
              {{ t('provider.encryptionUnavailable') }}
            </p>
            <label>
              <span>{{ t('provider.name') }}</span>
              <input v-model.trim="providerForm.provider" :placeholder="t('provider.namePlaceholder')" autocomplete="off" />
            </label>
            <label>
              <span>{{ t('provider.baseUrl') }}</span>
              <input v-model.trim="providerForm.baseUrl" :placeholder="t('provider.baseUrlPlaceholder')" inputmode="url" autocomplete="off" />
            </label>
            <label>
              <span>{{ t('provider.model') }}</span>
              <input v-model.trim="providerForm.model" :placeholder="t('provider.modelPlaceholder')" autocomplete="off" />
            </label>
            <label>
              <span>{{ t('provider.apiKey') }}</span>
              <input v-model="providerForm.apiKey" type="password" :placeholder="t('provider.apiKeyPlaceholder')" autocomplete="new-password" />
            </label>
            <p v-if="formError" class="form-error">{{ formError }}</p>
            <footer class="modal-footer provider-footer">
              <button v-if="providerStatus.configured" class="danger-button" type="button" @click="removeProvider">
                <TrashOutline />
                {{ providerRemoveArmed ? t('provider.removeConfirm') : t('provider.remove') }}
              </button>
              <span class="footer-spacer" />
              <button class="secondary-button" type="button" @click="closeModal">{{ t('common.cancel') }}</button>
              <button class="primary-button" type="submit" :disabled="saving || providerStatus.encryptionAvailable === false">
                {{ saving ? t('common.saving') : t('provider.save') }}
              </button>
            </footer>
          </form>
        </section>
      </div>

      <transition name="toast">
        <div v-if="toastMessage" class="toast-message" role="status">
          <WarningOutline />
          <span>{{ toastMessage }}</span>
        </div>
      </transition>
    </template>
  </main>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import {
  AddOutline,
  ChatbubbleEllipsesOutline,
  ChatbubblesOutline,
  CheckmarkCircleOutline,
  ChevronForwardOutline,
  CloseOutline,
  DownloadOutline,
  FolderOpenOutline,
  KeyOutline,
  LanguageOutline,
  MoonOutline,
  PeopleOutline,
  PersonOutline,
  PlayOutline,
  RefreshOutline,
  SendOutline,
  SettingsOutline,
  StopCircleOutline,
  SunnyOutline,
  TerminalOutline,
  TrashOutline,
  WarningOutline,
} from '@vicons/ionicons5'
import { AGENTS, agentLabel, agentLogo, publicAsset } from './catalog.js'
import { desktopApi, emptySnapshot, errorCode, normalizeSnapshot } from './desktop.js'
import { locale, setLocale, t, translateError, translateSystemMessage } from './i18n.js'

const snapshot = ref(emptySnapshot())
const installCatalog = ref({ platform: '', agents: [] })
const installerState = ref({ taskId: '', kind: '', phase: 'idle', canCancel: false, errorCode: '' })
const providerStatus = ref({ provider: '', baseUrl: '', model: '', configured: false, encryptionAvailable: true })
const selectedGroupId = ref('')
const defaultDirectory = ref('')
const booting = ref(true)
const bridgeMissing = ref(false)
const refreshing = ref(false)
const sending = ref(false)
const saving = ref(false)
const modal = ref('')
const draft = ref('')
const targetKinds = ref([])
const autoTurns = ref(6)
const formError = ref('')
const deleteArmed = ref(false)
const providerRemoveArmed = ref(false)
const installConfirmKind = ref('')
const focusedAgentKind = ref('')
const toastMessage = ref('')
const messageScroller = ref(null)
let toastTimer = null
let unsubscribeWorkspace = null
let unsubscribeInstaller = null
let modalHistoryPushed = false

const api = computed(() => desktopApi())
const workspace = computed(() => api.value?.localWorkspace || null)
const installer = computed(() => api.value?.agentInstaller || null)
const provider = computed(() => api.value?.localAgentProvider || null)

function initialTheme() {
  try {
    const saved = localStorage.getItem('roundrelay-theme')
    if (saved === 'light' || saved === 'dark') return saved
  } catch { /* noop */ }
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

const theme = ref(initialTheme())
const productLogo = computed(() => publicAsset('logos/roundrelay.png'))

const directGroups = computed(() => snapshot.value.groups
  .filter(group => group.conversationType === 'direct')
  .sort(sortByUpdated))
const groupGroups = computed(() => snapshot.value.groups
  .filter(group => group.conversationType !== 'direct')
  .sort(sortByUpdated))
const activeGroup = computed(() => snapshot.value.groups.find(group => group.id === selectedGroupId.value) || null)
const activeMessages = computed(() => snapshot.value.messages.filter(message => message.groupId === selectedGroupId.value))
const activeRun = computed(() => snapshot.value.runs.find(run => run.groupId === selectedGroupId.value) || null)

const mergedCatalog = computed(() => AGENTS.map((profile) => {
  const installedProfile = installCatalog.value.agents?.find(agent => agent.kind === profile.kind) || {}
  const detected = snapshot.value.agents.find(agent => agent.kind === profile.kind) || {}
  return {
    ...profile,
    ...installedProfile,
    ...detected,
    label: profile.label,
    logo: profile.logo,
    providerMode: profile.providerMode,
    installed: Boolean(installedProfile.installed || detected.installed),
    ready: detected.available === true,
  }
}))
const readyAgents = computed(() => mergedCatalog.value.filter(agent => agent.ready))
const readyCount = computed(() => readyAgents.value.length)
const installedCount = computed(() => mergedCatalog.value.filter(agent => agent.installed).length)

const groupForm = reactive({ name: '', topic: '', agentKinds: [], workdir: '', allowWrite: false })
const settingsForm = reactive({ name: '', topic: '', agentKinds: [], workdir: '', allowWrite: false })
const providerForm = reactive({ provider: '', baseUrl: '', model: '', apiKey: '' })

const modalTitle = computed(() => ({
  'new-group': t('group.newTitle'),
  settings: t('settings.title'),
  agents: t('installer.title'),
  provider: t('provider.title'),
})[modal.value] || '')
const modalSubtitle = computed(() => ({
  agents: t('installer.subtitle'),
  provider: t('provider.subtitle'),
})[modal.value] || '')

const installerBusy = computed(() => !['', 'idle', 'completed', 'cancelled', 'failed'].includes(installerState.value.phase))
const installerPhaseLabel = computed(() => t(`installer.phase.${installerState.value.phase}`))

function sortByUpdated(a, b) {
  return (Date.parse(b.updatedAt || b.createdAt || '') || 0) - (Date.parse(a.updatedAt || a.createdAt || '') || 0)
}

function groupName(group) {
  return group?.name || t('group.defaultName')
}

function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
}

function toggleLocale() {
  setLocale(locale.value === 'zh' ? 'en' : 'zh')
}

function applyTheme(value) {
  document.documentElement.dataset.theme = value
  document.documentElement.style.colorScheme = value
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', value === 'dark' ? '#0d1117' : '#f6f3ed')
  try { localStorage.setItem('roundrelay-theme', value) } catch { /* noop */ }
}

function goHome() {
  selectedGroupId.value = ''
}

function selectGroup(id) {
  selectedGroupId.value = id
}

function isGroupRunning(id) {
  return snapshot.value.runningGroupIds.includes(id)
}

function compactPath(path) {
  const value = String(path || '')
  if (value.length <= 42) return value
  const parts = value.split(/[\\/]/).filter(Boolean)
  return parts.length >= 2 ? `.../${parts.slice(-2).join('/')}` : `${value.slice(0, 38)}...`
}

function formatTime(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(locale.value === 'zh' ? 'zh-CN' : 'en', {
    hour: '2-digit', minute: '2-digit',
  }).format(date)
}

function renderMessage(content) {
  return DOMPurify.sanitize(marked.parse(String(content || ''), { breaks: true, gfm: true }))
}

function providerModeLabel(mode) {
  return t(`agent.provider.${mode}`)
}

function supportsSharedProvider(agent) {
  return ['compatible', 'experimental', 'responses', 'anthropic'].includes(agent.providerMode)
}

function agentState(agent) {
  if (agent.ready) return { label: t('agent.ready'), tone: 'ready', icon: CheckmarkCircleOutline }
  if (!agent.installed) return { label: t('agent.notInstalled'), tone: 'off', icon: DownloadOutline }
  if (agent.credentialState === 'missing') return { label: t('agent.needsLogin'), tone: 'warning', icon: WarningOutline }
  return { label: t('agent.unverified'), tone: 'neutral', icon: WarningOutline }
}

function handleAgentPrimary(agent) {
  if (agent.ready) openDirect(agent)
  else openAgentManager(agent.kind)
}

async function ensureDefaultDirectory() {
  if (defaultDirectory.value) return defaultDirectory.value
  defaultDirectory.value = await workspace.value?.defaultDirectory?.() || ''
  return defaultDirectory.value
}

async function openDirect(agent) {
  closeModal()
  if (!agent.ready) {
    openAgentManager(agent.kind)
    return
  }
  let group = directGroups.value.find(item => item.directAgentKind === agent.kind)
  if (!group) {
    try {
      group = await workspace.value.createGroup({
        conversationType: 'direct',
        directAgentKind: agent.kind,
        name: agent.label,
        agentKinds: [agent.kind],
        workdir: await ensureDefaultDirectory(),
        allowWrite: false,
      })
      snapshot.value = normalizeSnapshot(await workspace.value.get())
    } catch (error) {
      showError(error)
      return
    }
  }
  selectGroup(group.id)
}

async function refreshAgents() {
  if (!workspace.value || refreshing.value) return
  refreshing.value = true
  try {
    const [nextSnapshot, nextCatalog, nextInstaller] = await Promise.all([
      workspace.value.refreshAgents(),
      installer.value?.catalog?.() || installCatalog.value,
      installer.value?.state?.() || installerState.value,
    ])
    snapshot.value = normalizeSnapshot(nextSnapshot)
    installCatalog.value = nextCatalog || { platform: '', agents: [] }
    installerState.value = nextInstaller || installerState.value
  } catch (error) {
    showError(error)
  } finally {
    refreshing.value = false
  }
}

function openNewGroup() {
  formError.value = ''
  groupForm.name = ''
  groupForm.topic = ''
  groupForm.agentKinds = readyAgents.value.slice(0, 2).map(agent => agent.kind)
  groupForm.workdir = defaultDirectory.value
  groupForm.allowWrite = false
  modal.value = 'new-group'
  void ensureDefaultDirectory().then(path => { if (!groupForm.workdir) groupForm.workdir = path })
}

async function pickGroupDirectory(target) {
  try {
    const path = await workspace.value.pickDirectory()
    if (!path) return
    if (target === 'settings') settingsForm.workdir = path
    else groupForm.workdir = path
  } catch (error) {
    showError(error)
  }
}

async function createGroup() {
  formError.value = ''
  if (!groupForm.agentKinds.length) {
    formError.value = t('group.createErrorAgents')
    return
  }
  if (!groupForm.workdir) {
    formError.value = t('group.createErrorWorkspace')
    return
  }
  saving.value = true
  try {
    const group = await workspace.value.createGroup({ ...groupForm })
    snapshot.value = normalizeSnapshot(await workspace.value.get())
    closeModal()
    selectGroup(group.id)
  } catch (error) {
    formError.value = translateError(error)
  } finally {
    saving.value = false
  }
}

function openGroupSettings() {
  if (!activeGroup.value) return
  settingsForm.name = activeGroup.value.name || ''
  settingsForm.topic = activeGroup.value.topic || ''
  settingsForm.agentKinds = [...activeGroup.value.agentKinds]
  settingsForm.workdir = activeGroup.value.workdir || ''
  settingsForm.allowWrite = activeGroup.value.allowWrite === true
  formError.value = ''
  deleteArmed.value = false
  modal.value = 'settings'
}

async function saveGroupSettings() {
  if (!activeGroup.value) return
  formError.value = ''
  if (!settingsForm.workdir) {
    formError.value = t('group.createErrorWorkspace')
    return
  }
  if (activeGroup.value.conversationType !== 'direct' && !settingsForm.agentKinds.length) {
    formError.value = t('group.createErrorAgents')
    return
  }
  saving.value = true
  try {
    await workspace.value.updateGroup(activeGroup.value.id, { ...settingsForm })
    snapshot.value = normalizeSnapshot(await workspace.value.get())
    closeModal()
  } catch (error) {
    formError.value = translateError(error)
  } finally {
    saving.value = false
  }
}

async function deleteConversation() {
  if (!deleteArmed.value) {
    deleteArmed.value = true
    return
  }
  try {
    snapshot.value = normalizeSnapshot(await workspace.value.deleteGroup(activeGroup.value.id))
    selectedGroupId.value = ''
    closeModal()
  } catch (error) {
    formError.value = translateError(error)
  }
}

function toggleTarget(kind) {
  if (targetKinds.value.includes(kind)) targetKinds.value = targetKinds.value.filter(item => item !== kind)
  else targetKinds.value = [...targetKinds.value, kind]
}

function handleComposerKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    void sendMessage()
  }
}

async function sendMessage() {
  if (!activeGroup.value || sending.value || activeRun.value) return
  const text = draft.value.trim()
  if (!text) {
    notify(t('composer.messageRequired'))
    return
  }
  const targets = activeGroup.value.conversationType === 'direct'
    ? [...activeGroup.value.agentKinds]
    : [...targetKinds.value]
  if (!targets.length) {
    notify(t('composer.selectTarget'))
    return
  }
  draft.value = ''
  sending.value = true
  try {
    await workspace.value.send({ groupId: activeGroup.value.id, text, targetKinds: targets })
    snapshot.value = normalizeSnapshot(await workspace.value.get())
  } catch (error) {
    draft.value = text
    showError(error)
  } finally {
    sending.value = false
  }
}

async function startAutoDiscussion() {
  if (!activeGroup.value || activeRun.value) return
  const hasTopic = activeMessages.value.some(message => message.role === 'user' && !message.threadRootId)
  if (!hasTopic) {
    notify(t('composer.autoNeedsMessage'))
    return
  }
  try {
    await workspace.value.startAuto({ groupId: activeGroup.value.id, maxTurns: autoTurns.value })
  } catch (error) {
    showError(error)
  }
}

async function stopRun() {
  if (!activeGroup.value) return
  try { await workspace.value.stop(activeGroup.value.id) } catch (error) { showError(error) }
}

function openAgentManager(kind = '') {
  focusedAgentKind.value = kind
  installConfirmKind.value = ''
  modal.value = 'agents'
}

async function requestInstall(agent) {
  if (installConfirmKind.value !== agent.kind) {
    installConfirmKind.value = agent.kind
    return
  }
  installConfirmKind.value = ''
  try {
    installerState.value = await installer.value.start(agent.kind)
  } catch (error) {
    showError(error)
  }
}

async function cancelInstall() {
  try { await installer.value.cancel(installerState.value.taskId) } catch (error) { showError(error) }
}

async function loadProviderStatus(probeEncryption = false) {
  if (!provider.value) return
  try {
    providerStatus.value = await (probeEncryption ? provider.value.probe() : provider.value.status())
  } catch {
    providerStatus.value = { provider: '', baseUrl: '', model: '', configured: false, encryptionAvailable: true }
  }
}

function openProvider() {
  closeModal()
  formError.value = ''
  providerRemoveArmed.value = false
  providerForm.provider = providerStatus.value.provider || ''
  providerForm.baseUrl = providerStatus.value.baseUrl || ''
  providerForm.model = providerStatus.value.model || ''
  providerForm.apiKey = ''
  modal.value = 'provider'
  void loadProviderStatus(true).then(() => {
    providerForm.provider = providerStatus.value.provider || providerForm.provider
    providerForm.baseUrl = providerStatus.value.baseUrl || providerForm.baseUrl
    providerForm.model = providerStatus.value.model || providerForm.model
  })
}

async function saveProvider() {
  formError.value = ''
  if (!providerForm.provider || !providerForm.baseUrl || !providerForm.model) {
    formError.value = t('provider.requiredFields')
    return
  }
  if (!providerForm.apiKey) {
    formError.value = t('provider.keyRequired')
    return
  }
  saving.value = true
  try {
    await provider.value.save({
      provider: providerForm.provider,
      baseUrl: providerForm.baseUrl,
      model: providerForm.model,
      apiKey: providerForm.apiKey,
    })
    providerForm.apiKey = ''
    await Promise.all([loadProviderStatus(), refreshAgents()])
    closeModal()
  } catch (error) {
    formError.value = translateError(error)
  } finally {
    saving.value = false
  }
}

async function removeProvider() {
  if (!providerRemoveArmed.value) {
    providerRemoveArmed.value = true
    return
  }
  try {
    await provider.value.delete()
    await Promise.all([loadProviderStatus(), refreshAgents()])
    closeModal()
  } catch (error) {
    formError.value = translateError(error)
  }
}

function closeModal() {
  modal.value = ''
  formError.value = ''
  deleteArmed.value = false
  providerRemoveArmed.value = false
  installConfirmKind.value = ''
}

function notify(message) {
  toastMessage.value = message
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toastMessage.value = '' }, 3600)
}

function showError(error) {
  console.error('[RoundRelay]', errorCode(error))
  notify(translateError(error))
}

async function scrollToLatest() {
  await nextTick()
  if (messageScroller.value) messageScroller.value.scrollTop = messageScroller.value.scrollHeight
}

async function boot() {
  applyTheme(theme.value)
  if (!workspace.value || !installer.value || !provider.value) {
    bridgeMissing.value = true
    booting.value = false
    return
  }
  try {
    unsubscribeWorkspace = workspace.value.onChanged?.((value) => { snapshot.value = normalizeSnapshot(value) }) || null
    unsubscribeInstaller = installer.value.onChanged?.((value) => { installerState.value = value }) || null
    const [nextSnapshot, nextCatalog, nextInstaller, nextProvider, nextDirectory] = await Promise.all([
      workspace.value.refreshAgents().catch(() => workspace.value.get()),
      installer.value.catalog(),
      installer.value.state(),
      provider.value.status().catch(() => providerStatus.value),
      workspace.value.defaultDirectory(),
    ])
    snapshot.value = normalizeSnapshot(nextSnapshot)
    installCatalog.value = nextCatalog || { platform: '', agents: [] }
    installerState.value = nextInstaller || installerState.value
    providerStatus.value = nextProvider || providerStatus.value
    defaultDirectory.value = nextDirectory || ''
  } catch (error) {
    showError(error)
  } finally {
    booting.value = false
  }
}

function handleEscape(event) {
  if (event.key === 'Escape' && modal.value) closeModal()
}

function handlePopState() {
  if (!modal.value) return
  modalHistoryPushed = false
  closeModal()
}

watch(theme, applyTheme)
watch(modal, (value, previous) => {
  document.body.classList.toggle('modal-open', Boolean(value))
  if (value && !previous) {
    history.pushState({ roundrelayOverlay: true }, '', window.location.href)
    modalHistoryPushed = true
  } else if (!value && previous && modalHistoryPushed) {
    modalHistoryPushed = false
    history.back()
  }
})
watch(activeGroup, (group) => {
  targetKinds.value = group ? [...group.agentKinds] : []
  void scrollToLatest()
})
watch(() => activeMessages.value.length, scrollToLatest)
watch(() => installerState.value.phase, (phase, previous) => {
  if (phase === 'completed' && previous !== 'completed') void refreshAgents()
})

onMounted(() => {
  window.addEventListener('keydown', handleEscape)
  window.addEventListener('popstate', handlePopState)
  void boot()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleEscape)
  window.removeEventListener('popstate', handlePopState)
  document.body.classList.remove('modal-open')
  unsubscribeWorkspace?.()
  unsubscribeInstaller?.()
  clearTimeout(toastTimer)
})
</script>
