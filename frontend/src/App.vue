<template>
  <main
    class="app-shell"
    :class="{
      'sidebar-collapsed': sidebarCollapsed,
      'trace-panel-open': tracePanelOpen && activeGroup?.conversationType !== 'direct',
    }"
    :data-theme="theme"
    :data-platform="desktopPlatform"
  >
    <section v-if="booting" class="boot-state" aria-live="polite">
      <img class="boot-logo" :src="productAppIcon" alt="Meldwork" />
      <p>{{ t('app.loading') }}</p>
      <div class="skeleton-line" />
    </section>

    <section v-else-if="bridgeMissing" class="bridge-state">
      <img class="bridge-logo" :src="productAppIcon" alt="Meldwork" />
      <h1>{{ t('app.desktopRequired') }}</h1>
      <p>{{ t('app.desktopRequiredDetail') }}</p>
    </section>

    <template v-else>
      <WorkspaceSidebar :controller="workspaceSidebarController" />

      <section
        class="workspace-pane"
        :inert="contentInteractionBlocked ? '' : undefined"
        :aria-hidden="contentInteractionBlocked ? 'true' : undefined"
      >
        <SystemSettingsView
          v-if="activeView === 'settings'"
          :controller="systemSettingsController"
        />

        <HomeDashboard
          v-else-if="activeView === 'home'"
          :agent-description="agentDescription"
          :configurable-provider-count="configurableProviderAgents.length"
          :group-name="groupName"
          :groups="snapshot.groups"
          :installed-count="installedCount"
          :is-group-running="isGroupRunning"
          :onboarding-completed="onboardingCompleted"
          :provider-configured-count="providerConfiguredCount"
          :ready-agents="readyAgents"
          :recent-group-meta="recentGroupMeta"
          :refreshing="refreshing"
          :theme="theme"
          @open-agent-manager="openAgentManager"
          @open-direct="openDirect"
          @open-new-group="openNewGroup"
          @open-provider="openProvider"
          @refresh-agents="refreshAgents"
          @select-group="selectGroup"
        />

        <section v-else class="conversation-pane">
          <ConversationHeader ref="conversationHeader" :controller="conversationHeaderController" />

          <ConversationTimelineView :controller="timelineController" />

          <div class="conversation-composer-stack">
            <div v-if="activeGroup?.conversationType !== 'direct'" class="role-review-entry-row">
              <button
                class="secondary-button compact role-review-entry-button"
                type="button"
                :title="roleReviewEntryTitle"
                :disabled="!canOpenRoleReview || Boolean(activeRun) || sending || importingAttachment"
                @click="openRoleReview"
              >
                <GitCompareOutline aria-hidden="true" />
                {{ t('roleReview.open') }}
              </button>
            </div>
            <ConversationComposer :controller="composerController" />
          </div>
        </section>
      </section>

      <RunTracePanel
        v-if="tracePanelOpen && activeGroup?.conversationType !== 'direct'"
        ref="tracePanel"
        :open="tracePanelOpen"
        :drawer="tracePanelDrawer"
        :agent-control-pending-agent-run-id="agentControlPendingAgentRunId"
        :budget="tracePanelBudget"
        :controllable-agent-run-id="traceControllableAgentRunId"
        :human-gate-decision-pending-ids="humanGateDecisionPendingIds"
        :human-gates="tracePanelHumanGates"
        :items="tracePanelItems"
        :replacement-agent-kinds="traceReplacementAgentKinds"
        :selected-agent-run-id="selectedTraceAgentRunId"
        :theme="theme"
        :waiting="tracePanelWaiting"
        @close="closeTracePanel"
        @control-agent="controlGroupAgent"
        @decide-human-gate="decideHumanGate"
        @select="selectTraceAgentRun"
        @jump-source="jumpToTraceSource"
      />

      <OnboardingDialog
        v-if="onboardingVisible"
        ref="onboardingDialog"
        :controller="onboardingDialogController"
      />

      <transition name="modal-backdrop" appear>
        <div v-if="modal" class="modal-backdrop" @mousedown.self="closeModal">
          <transition name="modal-pop" appear>
            <section
              ref="modalDialog"
              class="modal"
              :class="{
                medium: ['new-group', 'settings', 'custom-agent', 'role-review'].includes(modal),
                'agent-detail-modal': modal === 'agent-detail',
                'unlimited-confirm-modal': modal === 'unlimited-confirm',
              }"
              role="dialog"
              aria-modal="true"
              aria-labelledby="modal-title"
              tabindex="-1"
            >
              <header class="modal-header">
                <div>
                  <h2 id="modal-title">{{ modalTitle }}</h2>
                  <p v-if="modalSubtitle">{{ modalSubtitle }}</p>
                </div>
                <button class="icon-button" type="button" :aria-label="t('common.close')" :disabled="saving" @click="closeModal">
                  <CloseOutline />
                </button>
              </header>

              <form
                v-if="modal === 'role-review'"
                class="modal-body form-stack role-review-form"
                @submit.prevent="startRoleReview"
              >
                <label>
                  <span>{{ t('roleReview.task') }}</span>
                  <textarea
                    v-model="roleReviewForm.task"
                    rows="3"
                    maxlength="8000"
                    :placeholder="t('roleReview.taskPlaceholder')"
                    :disabled="sending"
                  />
                </label>

                <fieldset :disabled="sending">
                  <legend class="agent-choice-legend">
                    <span>{{ t('roleReview.primaryAgents') }}</span>
                    <small>{{ t('group.selectedCount', { count: roleReviewForm.primaryKinds.length }) }}</small>
                  </legend>
                  <div class="agent-choice-grid">
                    <label
                      v-for="agent in roleReviewAgents"
                      :key="agent.kind"
                      class="agent-choice"
                      :class="{ selected: roleReviewForm.primaryKinds.includes(agent.kind) }"
                      :title="agent.label"
                    >
                      <input
                        v-model="roleReviewForm.primaryKinds"
                        type="checkbox"
                        :value="agent.kind"
                        :disabled="roleReviewPrimaryDisabled(agent.kind)"
                      />
                      <img :src="agent.logo" alt="" />
                      <span>{{ agent.label }}</span>
                      <CheckmarkCircleOutline />
                    </label>
                  </div>
                </fieldset>

                <div class="settings-primary-grid">
                  <label>
                    <span>{{ t('roleReview.reviewer') }}</span>
                    <select v-model="roleReviewForm.reviewerKind" :disabled="sending">
                      <option
                        v-for="agent in roleReviewReviewerAgents"
                        :key="agent.kind"
                        :value="agent.kind"
                      >
                        {{ agent.label }}
                      </option>
                    </select>
                  </label>
                  <label>
                    <span>{{ t('roleReview.arbiter') }}</span>
                    <select v-model="roleReviewForm.arbiterKind" :disabled="sending">
                      <option value="">{{ t('roleReview.noArbiter') }}</option>
                      <option
                        v-for="agent in roleReviewArbiterAgents"
                        :key="agent.kind"
                        :value="agent.kind"
                      >
                        {{ agent.label }}
                      </option>
                    </select>
                  </label>
                </div>

                <label>
                  <span>{{ t('roleReview.criteria') }}</span>
                  <textarea
                    v-model="roleReviewForm.criteriaText"
                    rows="3"
                    maxlength="4000"
                    :placeholder="t('roleReview.criteriaPlaceholder')"
                    :disabled="sending"
                  />
                </label>

                <footer class="modal-footer">
                  <button class="secondary-button" type="button" :disabled="sending" @click="closeModal">
                    {{ t('common.cancel') }}
                  </button>
                  <button class="primary-button" type="submit" :disabled="!roleReviewCanSubmit || sending">
                    {{ t('roleReview.start') }}
                  </button>
                </footer>
              </form>
              <WorkspaceModalContent
                v-else
                ref="workspaceModalContent"
                :controller="workspaceModalController"
              />
            </section>
          </transition>
        </div>
      </transition>

      <transition name="toast">
        <div v-if="toastMessage" class="toast-message" role="status" aria-live="polite">
          <WarningOutline />
          <span>{{ toastMessage }}</span>
          <button
            class="toast-dismiss-button"
            type="button"
            :title="t('common.dismiss')"
            :aria-label="t('common.dismiss')"
            @click="dismissToast"
          >
            <CloseOutline />
          </button>
        </div>
      </transition>
      <transition name="copy-toast">
        <div v-if="copyToastMessage" class="copy-toast-message" role="status" aria-live="polite">
          <CheckmarkCircleOutline />
          <span>{{ copyToastMessage }}</span>
        </div>
      </transition>
    </template>
  </main>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  CheckmarkCircleOutline,
  CloseOutline,
  GitCompareOutline,
  WarningOutline,
} from '@vicons/ionicons5'
import ConversationComposer from './components/ConversationComposer.vue'
import ConversationHeader from './components/ConversationHeader.vue'
import ConversationTimelineView from './components/ConversationTimelineView.vue'
import HomeDashboard from './components/HomeDashboard.vue'
import OnboardingDialog from './components/OnboardingDialog.vue'
import RunTracePanel from './components/RunTracePanel.vue'
import SystemSettingsView from './components/SystemSettingsView.vue'
import WorkspaceModalContent from './components/WorkspaceModalContent.vue'
import WorkspaceSidebar from './components/WorkspaceSidebar.vue'
import { agentLabel, setCustomAgentProfiles } from './catalog.js'
import { createConversationControllers } from './conversationControllers.js'
import { useAgentCatalog } from './composables/useAgentCatalog.js'
import { useAgentManagement } from './composables/useAgentManagement.js'
import { useAgentRefresh } from './composables/useAgentRefresh.js'
import { useAgentSkills } from './composables/useAgentSkills.js'
import { useAppNotifications } from './composables/useAppNotifications.js'
import { useAppPreferences } from './composables/useAppPreferences.js'
import { useComposerAttachments } from './composables/useComposerAttachments.js'
import {
  normalizeSkill,
  useComposerContext,
} from './composables/useComposerContext.js'
import { useCollapsedGroupMenu } from './composables/useCollapsedGroupMenu.js'
import { useConversationActions } from './composables/useConversationActions.js'
import { useConversationExecution } from './composables/useConversationExecution.js'
import { useConversationTimeline } from './composables/useConversationTimeline.js'
import { useConversationNavigation } from './composables/useConversationNavigation.js'
import { useConversationViewport } from './composables/useConversationViewport.js'
import { useDesktopWorkspaceLifecycle } from './composables/useDesktopWorkspaceLifecycle.js'
import { useEmptyShowcasePlayback } from './composables/useEmptyShowcasePlayback.js'
import { useAppWindowInteractions } from './composables/useAppWindowInteractions.js'
import { useKnowledgeBaseSettings } from './composables/useKnowledgeBaseSettings.js'
import { useMessageActions } from './composables/useMessageActions.js'
import { useOnboarding } from './composables/useOnboarding.js'
import { useOverlayLifecycle } from './composables/useOverlayLifecycle.js'
import { useProviderSettings } from './composables/useProviderSettings.js'
import { useRunFinishedNotifications } from './composables/useRunFinishedNotifications.js'
import { useSystemSettingsNavigation } from './composables/useSystemSettingsNavigation.js'
import { useWorkspaceNavigationState } from './composables/useWorkspaceNavigationState.js'
import { desktopApi, emptySnapshot, normalizeSnapshot } from './desktop.js'
import { locale, t, translateError, translateSystemMessage } from './i18n.js'
import { createWorkspaceControllers } from './workspaceControllers.js'

const snapshot = ref(emptySnapshot())
const shortcutDefinitions = Object.freeze([
  { labelKey: 'shortcut.toggleSidebar', keys: 'Cmd/Ctrl + B' },
  { labelKey: 'shortcut.newGroup', keys: 'Cmd/Ctrl + G' },
  { labelKey: 'shortcut.previousConversation', keys: 'Cmd/Ctrl + [' },
  { labelKey: 'shortcut.nextConversation', keys: 'Cmd/Ctrl + ]' },
  { labelKey: 'shortcut.openAgents', keys: 'Cmd/Ctrl + ,' },
])
const READ_ONLY_ENFORCED_AGENT_KINDS = new Set([
  'codex', 'hermes', 'openclaw', 'workbuddy', 'kimi', 'mimo', 'claude', 'qwen', 'gemini',
  'opencode', 'opencodereview',
])
const installCatalog = ref({ platform: '', agents: [] })
const installerState = ref({ taskId: '', kind: '', phase: 'idle', canCancel: false, errorCode: '' })
const systemSettingsSection = ref('agents')
const sidebarCollapsed = ref(false)
const refreshing = ref(false)
const sending = ref(false)
const saving = ref(false)
const agentControlPendingAgentRunId = ref('')
const humanGateDecisionPendingIds = ref([])
const modal = ref('')
const roleReviewForm = ref({
  task: '',
  primaryKinds: [],
  reviewerKind: '',
  arbiterKind: '',
  criteriaText: '',
})
const composerContextVersion = ref(0)
const maxRounds = ref(6)
const unlimitedRounds = ref(false)
const roundSettingsOpen = ref(false)
const formError = ref('')
const customAgentDeleteArmed = ref(false)
const installConfirmKind = ref('')
const focusedAgentKind = ref('')
const shortcutMenuOpen = ref(false)
const conversationHeader = ref(null)
const workspaceModalContent = ref(null)
const onboardingDialog = ref(null)
const modalDialog = ref(null)
const roundSettingsControl = ref(null)
let systemSettingsNavigation = null
const {
  copyToastMessage,
  dismissToast,
  notify,
  showCopyToast,
  showError,
  toastMessage,
} = useAppNotifications()
const collapsedGroupMenuController = useCollapsedGroupMenu({ sidebarCollapsed, shortcutMenuOpen })
const {
  collapsedGroupMenu,
  collapsedGroupMenuButton,
  collapsedGroupMenuOpen,
  closeCollapsedGroupMenu,
} = collapsedGroupMenuController
const api = computed(() => desktopApi())
const conversationTitleBlock = computed(() => ({
  focus: () => conversationHeader.value?.focusTitleBlock(),
}))
const desktopPlatform = computed(() => api.value?.platform || installCatalog.value.platform || '')
const workspace = computed(() => api.value?.localWorkspace || null)
const installer = computed(() => api.value?.agentInstaller || null)
const customAgent = computed(() => api.value?.customAgent || null)
const provider = computed(() => api.value?.localAgentProvider || null)
const knowledgeBase = computed(() => api.value?.localKnowledgeBase || null)
const attachmentsApi = computed(() => api.value?.localAttachments || null)
const {
  clearOnboardingPlayback,
  completeOnboardingState,
  ensureOnboardingPlayback,
  hasPersistedWorkspaceActivity,
  onboardingCompleted,
  onboardingIndex,
  onboardingLoadingLabel,
  onboardingReady,
  onboardingSlide,
  onboardingSlides,
  onboardingVisible,
  openOnboarding,
  selectOnboardingSlide,
} = useOnboarding({ refreshAgents: (...args) => refreshAgents(...args) })
const onboardingDialogController = {
  completeOnboarding: (...args) => completeOnboarding(...args),
  onboardingIndex,
  onboardingLoadingLabel,
  onboardingReady,
  onboardingSlide,
  onboardingSlides,
  selectOnboardingSlide,
  t,
}
const knowledgeBaseSettings = useKnowledgeBaseSettings({ knowledgeBase, showError })
const {
  knowledgeBaseName,
  knowledgeBaseReady,
  loadKnowledgeBaseStatuses,
  localKnowledgeBaseEntries,
} = knowledgeBaseSettings
const {
  applyTheme,
  productAppIcon,
  productMark,
  productWordmark,
  theme,
  toggleLocale,
  toggleTheme,
} = useAppPreferences()
const conversationNavigation = useConversationNavigation({ agentLabel, locale, snapshot, t })
const {
  directGroupsFor,
  groupName,
  isDirectCreationPending,
  recentGroupMeta,
  setDirectCreationPending,
  setSidebarAgentExpanded,
  sortByUpdated,
  toggleSidebarAgentExpanded,
} = conversationNavigation
const workspaceNavigationState = useWorkspaceNavigationState({
  clearSidebarDeleteState: () => { sidebarDeleteGroupId.value = '' },
  closeCollapsedGroupMenu,
  closeTracePanel: (...args) => closeTracePanel(...args),
  directGroupsFor,
  flushPendingRunFinishedEvents: (...args) => flushPendingRunFinishedEvents(...args),
  hasFinishedDirectRun: (...args) => hasFinishedDirectRun(...args),
  isDirectCreationPending,
  openAgentManager: (...args) => openAgentManager(...args),
  openDirect: (...args) => openDirect(...args),
  preloadAgentSkills: (...args) => preloadAgentSkills(...args),
  setFinishedDirectRun: (...args) => setFinishedDirectRun(...args),
  setSidebarAgentExpanded,
  sidebarCollapsed,
  snapshot,
  toggleSidebarAgentExpanded,
})
const {
  activeGroup,
  activeGroupMemberSignature,
  activeView,
  goHome,
  handleAgentPrimary,
  handleOpenGroup,
  handleSidebarAgentMain,
  isGroupRunning,
  selectGroup,
  selectedGroupId,
} = workspaceNavigationState
const sidebarDeleteGroup = computed(() => snapshot.value.groups.find(group => group.id === sidebarDeleteGroupId.value) || null)
const sidebarDeletePopoverStyle = computed(() => ({
  left: `${sidebarDeletePopoverPoint.value.left}px`,
  top: `${sidebarDeletePopoverPoint.value.top}px`,
}))
const blockingOverlayOpen = computed(() => Boolean(modal.value || onboardingVisible.value))

const agentCatalog = useAgentCatalog({
  activeGroup,
  directGroupsFor,
  installCatalog,
  snapshot,
  t,
  theme,
})
const {
  agentDescription,
  installedCount,
  mergedCatalog,
  readyAgentKinds,
  readyAgentSignature,
  readyAgents,
} = agentCatalog
const agentSkills = useAgentSkills({
  installer,
  mergedCatalog,
  normalizeSkill,
  readyAgents,
  t,
})
const {
  agentDetailSkillSummary,
  agentSkillsSnapshot,
  disposeAgentSkills,
  invalidateAgentSkillCatalog,
  loadAgentSkills,
  loadAgentSkillStats,
  preloadAgentSkills,
  resetAgentDetailSkills,
  selectAgentDetail,
  selectedAgentDetail,
} = agentSkills
const agentRefresh = useAgentRefresh({
  installCatalog,
  installer,
  installerState,
  invalidateAgentSkillCatalog,
  loadAgentSkillStats,
  readyAgentSignature,
  refreshing,
  showError,
  snapshot,
  workspace,
})
const { refreshAgents } = agentRefresh
const agentManagement = useAgentManagement({
  activeView,
  closeModal,
  customAgent,
  customAgentDeleteArmed,
  focusedAgentKind,
  formError,
  installConfirmKind,
  installer,
  installerState,
  modal,
  normalizeSnapshot,
  refreshAgents,
  saving,
  selectAgentDetail,
  selectedAgentDetail,
  showError,
  snapshot,
  systemSettingsSection,
  t,
  translateError,
})
const conversationTimeline = useConversationTimeline({
  activeGroup,
  activeView,
  blockingOverlayOpen,
  conversationTitleBlock,
  locale,
  mergedCatalog,
  selectedGroupId,
  snapshot,
  t,
  translateSystemMessage,
})
const {
  activeMessages,
  activeRun,
  activeRunTopicSignature,
  closeTracePanel,
  clearActiveTurn,
  clearDeletedTurnState,
  conversationEmptyVisible,
  focusRunTopic,
  hasFinishedDirectRun,
  jumpToTraceSource,
  liveOutputSignature,
  rememberRunFinishedTurnStatus,
  selectTraceAgentRun,
  selectedTraceAgentRunId,
  setFinishedDirectRun,
  traceDrawerBlocking,
  tracePanel,
  tracePanelDrawer,
  tracePanelItems,
  tracePanelOpen,
  tracePanelRunId,
} = conversationTimeline
const pendingHumanGates = computed(() => (
  snapshot.value.humanGates.filter(gate => gate.status === 'pending')
))
const activeRunHumanGates = computed(() => (
  activeRun.value
    ? pendingHumanGates.value.filter(gate => gate.runId === activeRun.value.runId)
    : []
))
const directHumanGates = computed(() => (
  activeGroup.value?.conversationType === 'direct' ? activeRunHumanGates.value : []
))
const directRunBudget = computed(() => (
  activeGroup.value?.conversationType === 'direct' ? activeRun.value?.budget || null : null
))
const tracePanelRun = computed(() => (
  snapshot.value.runs.find(run => (
    run.runId === tracePanelRunId.value && run.groupId === activeGroup.value?.id
  )) || null
))
const tracePanelHumanGates = computed(() => (
  activeGroup.value?.conversationType !== 'direct' && tracePanelRun.value
    ? pendingHumanGates.value.filter(gate => gate.runId === tracePanelRun.value.runId)
    : []
))
const tracePanelBudget = computed(() => tracePanelRun.value?.budget || null)
const tracePanelWaiting = computed(() => (
  tracePanelHumanGates.value.length > 0
  && tracePanelHumanGates.value.every(gate => tracePanelRun.value?.waitingGateIds.includes(gate.gateId))
))
const traceControllableAgent = computed(() => {
  const run = tracePanelRun.value
  if (!run || run.runId !== activeRun.value?.runId || !run.currentKind) return null
  const candidate = run.agentRuns.filter(agent => agent.kind === run.currentKind).at(-1) || null
  return ['in_progress', 'running', 'streaming', 'waiting'].includes(candidate?.status)
    ? candidate
    : null
})
const traceControllableAgentRunId = computed(() => traceControllableAgent.value?.agentRunId || '')
const traceReplacementAgentKinds = computed(() => {
  const run = tracePanelRun.value
  const group = activeGroup.value
  if (!run || run.runId !== activeRun.value?.runId || group?.conversationType === 'direct') return []
  const groupKinds = new Set(group.agentKinds || [])
  return (run.targetKinds || []).filter(kind => (
    kind !== traceControllableAgent.value?.kind
    && groupKinds.has(kind)
    && readyAgentKinds.value.has(kind)
  ))
})
const {
  handleMessageScroll,
  messageScroller,
  resetMessageViewport,
} = useConversationViewport({ activeMessages, liveOutputSignature })
const { index: emptyShowcaseIndex } = useEmptyShowcasePlayback({
  visible: conversationEmptyVisible,
})
const { completeOnboarding, trapOverlayFocus } = useOverlayLifecycle({
  blockingOverlayOpen,
  clearOnboardingPlayback,
  closeCollapsedGroupMenu,
  closeModal,
  closeTracePanel,
  completeOnboardingState,
  ensureOnboardingPlayback,
  modal,
  modalDialog,
  onboardingDialog,
  onboardingVisible,
  saving,
  tracePanelOpen,
})
const messageActions = useMessageActions({
  activeGroup,
  clearDeletedTurnState,
  isGroupRunning,
  notify,
  showCopyToast,
  showError,
  snapshot,
  t,
  workspace,
})
const {
  clearPendingRunFinishedEvents,
  flushPendingRunFinishedEvents,
  handleRunFinished,
} = useRunFinishedNotifications({
  hasFinishedDirectRun,
  rememberRunFinishedTurnStatus,
  selectedGroupId,
  setFinishedDirectRun,
  snapshot,
})
const { messageDeleteArmedId } = messageActions
const contentInteractionBlocked = computed(() => blockingOverlayOpen.value || traceDrawerBlocking.value)
const providerSettings = useProviderSettings({
  agents: mergedCatalog,
  provider,
  saving,
  formError,
  refreshAgents,
})
const composerContext = useComposerContext({
  activeGroup,
  activeRun,
  agentDescription,
  agentSkillsSnapshot,
  knowledgeBaseName,
  knowledgeBaseReady,
  loadAgentSkills,
  localKnowledgeBaseEntries,
  mergedCatalog,
  notify,
  onSubmit: (...args) => sendMessage(...args),
  preloadAgentSkills,
  sending,
  t,
  theme,
})
const {
  configurableProviderAgents,
  loadProviderWorkspace,
  providerConfiguredCount,
  providerRemoveArmed,
  selectedProviderKind,
  supportsExternalProvider,
} = providerSettings
systemSettingsNavigation = useSystemSettingsNavigation({
  activeView,
  closeModal,
  focusedAgentKind,
  formError,
  installConfirmKind,
  loadKnowledgeBaseStatuses,
  loadProviderWorkspace,
  modal,
  providerRemoveArmed,
  saving,
  selectedProviderKind,
  supportsExternalProvider,
  systemSettingsSection,
})
const {
  captureComposerContext,
  clearComposerContext,
  composerMode,
  composerTargetKinds,
  discussionMode,
  disposeComposerContext,
  draft,
  resetComposerContext,
  restoreComposerContext,
  scheduleComposerResize,
  serializeComposerContext,
  skillMenuOpen,
} = composerContext
const composerTargetsReady = computed(() => (
  composerTargetKinds.value.length > 0
  && composerTargetKinds.value.every(kind => readyAgentKinds.value.has(kind))
))
const roleReviewAgents = computed(() => {
  const readyByKind = new Map(readyAgents.value.map(agent => [agent.kind, agent]))
  return (activeGroup.value?.agentKinds || []).map(kind => readyByKind.get(kind)).filter(Boolean)
})
const canOpenRoleReview = computed(() => roleReviewAgents.value.length >= 2)
const roleReviewEntryTitle = computed(() => (
  canOpenRoleReview.value ? t('roleReview.open') : t('roleReview.unavailable')
))
const roleReviewReviewerAgents = computed(() => {
  const primaryKinds = new Set(roleReviewForm.value.primaryKinds)
  return roleReviewAgents.value.filter(agent => (
    !primaryKinds.has(agent.kind) && agent.kind !== roleReviewForm.value.arbiterKind
  ))
})
const roleReviewArbiterAgents = computed(() => {
  const primaryKinds = new Set(roleReviewForm.value.primaryKinds)
  return roleReviewAgents.value.filter(agent => (
    !primaryKinds.has(agent.kind) && agent.kind !== roleReviewForm.value.reviewerKind
  ))
})
const roleReviewCriteria = computed(() => roleReviewForm.value.criteriaText
  .split(/\r?\n/u)
  .map(value => value.trim())
  .filter(Boolean))
const roleReviewCanSubmit = computed(() => {
  const form = roleReviewForm.value
  const participants = [...form.primaryKinds, form.reviewerKind, form.arbiterKind].filter(Boolean)
  return Boolean(form.task.trim())
    && form.primaryKinds.length > 0
    && Boolean(form.reviewerKind)
    && new Set(participants).size === participants.length
    && roleReviewCriteria.value.length > 0
    && roleReviewCriteria.value.length <= 32
    && roleReviewCriteria.value.every(description => description.length <= 1200)
})
const attachmentController = useComposerAttachments({
  activeGroup,
  attachmentsApi,
  composerContextVersion,
  composerTargetKinds,
  composerTargetsReady,
  mergedCatalog,
  notify,
  showError,
  t,
})
const {
  attachmentLimitMessage,
  composerAttachmentSupported,
  composerAttachments,
  discardAttachments,
  importingAttachment,
  safeAttachmentPayload,
} = attachmentController
const conversationExecution = useConversationExecution({
  activeGroup,
  activeRun,
  attachmentLimitMessage,
  captureComposerContext,
  clearComposerContext,
  composerAttachmentSupported,
  composerAttachments,
  composerContextVersion,
  composerMode,
  composerTargetKinds,
  composerTargetsReady,
  discardAttachments,
  draft,
  importingAttachment,
  maxRounds,
  normalizeSnapshot,
  notify,
  readyAgentKinds,
  restoreComposerContext,
  roundSettingsOpen,
  safeAttachmentPayload,
  sending,
  serializeComposerContext,
  showError,
  snapshot,
  t,
  unlimitedRounds,
  workspace,
})
const { canSendMessage } = conversationExecution

function sendMessage(...args) {
  return conversationExecution.sendMessage(...args)
}

function roleReviewPrimaryDisabled(kind) {
  return kind === roleReviewForm.value.reviewerKind || kind === roleReviewForm.value.arbiterKind
}

function openRoleReview() {
  if (!canOpenRoleReview.value || activeRun.value || sending.value || importingAttachment.value) return
  const [primary, reviewer] = roleReviewAgents.value
  roleReviewForm.value = {
    task: draft.value,
    primaryKinds: [primary.kind],
    reviewerKind: reviewer.kind,
    arbiterKind: '',
    criteriaText: t('roleReview.defaultCriterion'),
  }
  modal.value = 'role-review'
}

async function startRoleReview() {
  if (!roleReviewCanSubmit.value) return
  const input = {
    text: roleReviewForm.value.task,
    primaryKinds: [...roleReviewForm.value.primaryKinds],
    reviewerKind: roleReviewForm.value.reviewerKind,
    arbiterKind: roleReviewForm.value.arbiterKind,
    criteria: [...roleReviewCriteria.value],
  }
  draft.value = input.text
  closeModal()
  await conversationExecution.sendRoleReview(input)
}

function stopRun(...args) {
  return conversationExecution.stopRun(...args)
}

async function decideHumanGate(payload = {}) {
  const gate = pendingHumanGates.value.find(item => item.gateId === payload.gateId)
  const option = gate?.options.find(item => item.optionId === payload.optionId)
  if (!gate || !option || humanGateDecisionPendingIds.value.includes(gate.gateId)) return false
  const bridge = workspace.value
  if (!bridge?.decideHumanGate) return false
  humanGateDecisionPendingIds.value = [...humanGateDecisionPendingIds.value, gate.gateId]
  try {
    const result = await bridge.decideHumanGate(gate.gateId, { optionId: option.optionId })
    if (!['approved', 'rejected'].includes(result?.status)
        || result?.decision?.optionId !== option.optionId) {
      throw new Error('HUMAN_GATE_DECISION_FAILED')
    }
    return true
  } catch (error) {
    showError(error)
    return false
  } finally {
    humanGateDecisionPendingIds.value = humanGateDecisionPendingIds.value
      .filter(gateId => gateId !== gate.gateId)
  }
}

async function controlGroupAgent(payload = {}) {
  const group = activeGroup.value
  const run = activeRun.value
  const candidate = traceControllableAgent.value
  const action = String(payload.action || '')
  const replacementKind = String(payload.replacementKind || '')
  if (group?.conversationType === 'direct'
      || !run
      || candidate?.agentRunId !== payload.agentRunId
      || candidate?.kind !== payload.kind
      || !['cancel', 'retry', 'replace'].includes(action)
      || (action === 'replace' && !traceReplacementAgentKinds.value.includes(replacementKind))
      || (action !== 'replace' && replacementKind)
      || agentControlPendingAgentRunId.value) return false
  const bridge = workspace.value
  if (!bridge?.controlAgent) return false
  agentControlPendingAgentRunId.value = candidate.agentRunId
  try {
    const controlled = await bridge.controlAgent(
      group.id,
      run.runId,
      candidate.kind,
      action,
      replacementKind,
    )
    if (controlled !== true) notify(t('trace.agentControlUnavailable'))
    return controlled === true
  } catch (error) {
    showError(error)
    return false
  } finally {
    agentControlPendingAgentRunId.value = ''
  }
}
const roundProgressPercent = computed(() => {
  const bounded = Math.max(1, Math.min(10, Number(maxRounds.value) || 1))
  return `${((bounded - 1) / 9) * 100}%`
})
const conversationActions = useConversationActions({
  activeGroup,
  activeRun,
  activeView,
  closeModal,
  conversationHeader,
  directGroupsFor,
  formError,
  groupName,
  isDirectCreationPending,
  isGroupRunning,
  modal,
  openAgentManager,
  preloadAgentSkills,
  readyAgents,
  saving,
  selectedGroupId,
  selectGroup,
  sending,
  setDirectCreationPending,
  setSidebarAgentExpanded,
  showError,
  snapshot,
  t,
  translateError,
  workspace,
  workspaceModalContent,
})
const {
  cancelInlineTitleEdit,
  defaultDirectory,
  deleteArmed,
  openDirect,
  openNewGroup,
  settingsIntent,
  sidebarDeleteGroupId,
  sidebarDeletePopoverPoint,
} = conversationActions
const {
  composerController,
  conversationHeaderController,
  timelineController,
} = createConversationControllers({
  agentCatalog,
  agentSkills,
  app: {
    activeGroup,
    activeRun,
    canSendMessage,
    compactPath,
    conversationPermissionLabel,
    emptyShowcaseIndex,
    groupName,
    handleMessageScroll,
    maxRounds,
    messageScroller,
    productWordmark,
    requestUnlimitedRounds,
    roundProgressPercent,
    roundSettingsControl,
    roundSettingsOpen,
    saving,
    sendMessage,
    sending,
    shortcutDefinitions,
    shortcutMenuOpen,
    stopRun,
    t,
    theme,
    translateSystemMessage,
    unlimitedRounds,
  },
  attachments: attachmentController,
  composerContext,
  conversationActions,
  knowledgeBase: knowledgeBaseSettings,
  messageActions,
  timeline: conversationTimeline,
})
Object.assign(timelineController, {
  decideHumanGate,
  directHumanGates,
  directRunBudget,
  humanGateDecisionPendingIds,
})

const modalTitle = computed(() => ({
  'new-group': t('group.newTitle'),
  settings: settingsIntent.value === 'rename'
    ? t(activeGroup.value?.conversationType === 'direct' ? 'settings.renameDirectTitle' : 'settings.renameGroupTitle')
    : t('settings.title'),
  'custom-agent': t('customAgent.title'),
  'unlimited-confirm': t('composer.unlimitedConfirmTitle'),
  'agent-detail': selectedAgentDetail.value?.label || t('systemSettings.openAgentDetailDefault'),
  'role-review': t('roleReview.title'),
})[modal.value] || '')
const modalSubtitle = computed(() => ({
  settings: groupName(activeGroup.value),
  'custom-agent': t('customAgent.subtitle'),
  'agent-detail': agentDetailSkillSummary.value,
  'role-review': groupName(activeGroup.value),
})[modal.value] || '')

const {
  systemSettingsController,
  workspaceModalController,
  workspaceSidebarController,
} = createWorkspaceControllers({
  agentCatalog,
  agentManagement,
  agentRefresh,
  agentSkills,
  app: {
    activeGroup,
    activeView,
    closeModal,
    confirmUnlimitedRounds,
    contentInteractionBlocked,
    customAgentDeleteArmed,
    focusedAgentKind,
    formError,
    goHome,
    groupName,
    handleSidebarAgentMain,
    installConfirmKind,
    installerState,
    isGroupRunning,
    modal,
    openAgentManager,
    openProvider,
    openSystemSettings,
    productMark,
    refreshing,
    saving,
    selectGroup,
    selectedGroupId,
    selectSystemSettingsSection,
    sidebarCollapsed,
    sidebarDeleteGroup,
    sidebarDeletePopoverStyle,
    systemSettingsSection,
    t,
    theme,
    toggleLocale,
    toggleTheme,
  },
  collapsedGroupMenu: collapsedGroupMenuController,
  conversationActions,
  conversationNavigation,
  knowledgeBase: knowledgeBaseSettings,
  providerSettings,
  timeline: conversationTimeline,
})

useAppWindowInteractions({
  closeCollapsedGroupMenu,
  closeModal,
  closeTracePanel,
  collapsedGroupMenu,
  collapsedGroupMenuButton,
  collapsedGroupMenuOpen,
  completeOnboarding,
  conversationHeader,
  customAgentDeleteArmed,
  deleteArmed,
  messageDeleteArmedId,
  modal,
  onboardingVisible,
  openNewGroup,
  openSystemSettings,
  roundSettingsControl,
  roundSettingsOpen,
  selectGroup,
  selectedGroupId,
  shortcutMenuOpen,
  sidebarCollapsed,
  sidebarDeleteGroupId,
  skillMenuOpen,
  snapshot,
  sortByUpdated,
  tracePanelOpen,
  trapOverlayFocus,
})

const { booting, bridgeMissing } = useDesktopWorkspaceLifecycle({
  afterInitialLoad: () => {
    if (!onboardingCompleted.value && hasPersistedWorkspaceActivity(snapshot.value)) {
      completeOnboarding({ fromHistory: true })
    }
    if (!onboardingCompleted.value) {
      openOnboarding()
    } else {
      void refreshAgents()
    }
    void loadProviderWorkspace()
    void loadKnowledgeBaseStatuses()
  },
  beforeBoot: () => {
    applyTheme(theme.value)
    setCustomAgentProfiles([])
  },
  defaultDirectory,
  handleOpenGroup,
  handleRunFinished,
  installer,
  installerState,
  provider,
  showError,
  snapshot,
  workspace,
})

function conversationPermissionLabel(group) {
  const kinds = Array.isArray(group?.agentKinds) ? group.agentKinds : []
  const enforced = kinds.length && kinds.every(kind => READ_ONLY_ENFORCED_AGENT_KINDS.has(kind))
  if (!enforced) return t('conversation.agentManagedPermissions')
  return group?.allowWrite ? t('conversation.writeEnabled') : t('conversation.readOnly')
}

function compactPath(path) {
  const value = String(path || '')
  if (value.length <= 42) return value
  const parts = value.split(/[\\/]/).filter(Boolean)
  return parts.length >= 2 ? `.../${parts.slice(-2).join('/')}` : `${value.slice(0, 38)}...`
}

function openAgentManager(kind = '') {
  return systemSettingsNavigation.openAgentManager(kind)
}

function openSystemSettings(section = 'agents', kind = '') {
  return systemSettingsNavigation.openSystemSettings(section, kind)
}

function selectSystemSettingsSection(section) {
  return systemSettingsNavigation.selectSystemSettingsSection(section)
}

function requestUnlimitedRounds() {
  if (unlimitedRounds.value) return
  modal.value = 'unlimited-confirm'
}

function confirmUnlimitedRounds() {
  unlimitedRounds.value = true
  closeModal()
}

function openProvider(kind = '') {
  return systemSettingsNavigation.openProvider(kind)
}

function closeModal(options = {}) {
  if (saving.value && options?.force !== true) return false
  if (!modal.value) return false
  modal.value = ''
  settingsIntent.value = 'settings'
  formError.value = ''
  deleteArmed.value = false
  customAgentDeleteArmed.value = false
  providerRemoveArmed.value = false
  installConfirmKind.value = ''
  resetAgentDetailSkills()
  return true
}

watch(() => snapshot.value.messages.map(message => message.id).join('\u0000'), () => {
  flushPendingRunFinishedEvents()
  if (
    messageDeleteArmedId.value
    && !snapshot.value.messages.some(message => message.id === messageDeleteArmedId.value)
  ) {
    messageDeleteArmedId.value = ''
  }
})
watch(activeGroupMemberSignature, () => {
  composerContextVersion.value += 1
  const abandonedAttachments = composerAttachments.value
  const group = activeGroup.value
  cancelInlineTitleEdit({ restoreFocus: false })
  messageDeleteArmedId.value = ''
  clearActiveTurn()
  roundSettingsOpen.value = false
  resetComposerContext(group)
  composerAttachments.value = []
  void discardAttachments(abandonedAttachments)
  resetMessageViewport()
})
watch(activeRun, (value) => {
  if (!value) return
  messageDeleteArmedId.value = ''
  roundSettingsOpen.value = false
  cancelInlineTitleEdit({ restoreFocus: false })
})
watch(discussionMode, (value) => {
  if (value !== 'auto') roundSettingsOpen.value = false
})
watch(
  [draft, () => composerAttachments.value.length, activeGroupMemberSignature],
  scheduleComposerResize,
  { flush: 'post' },
)
watch(activeRunTopicSignature, (value) => { if (value) void focusRunTopic() })
watch(readyAgentSignature, (value) => { if (value) void loadAgentSkillStats() })
watch(() => installerState.value.phase, (phase, previous) => {
  if (phase === 'completed' && previous !== 'completed') void refreshAgents()
})

onBeforeUnmount(() => {
  composerContextVersion.value += 1
  const abandonedAttachments = composerAttachments.value
  composerAttachments.value = []
  void discardAttachments(abandonedAttachments)
  disposeComposerContext()
  disposeAgentSkills()
  clearPendingRunFinishedEvents()
})
</script>

<style scoped>
.conversation-composer-stack {
  min-width: 0;
}

.role-review-entry-row {
  width: min(var(--conversation-content-width), 100%);
  box-sizing: border-box;
  display: flex;
  justify-content: flex-end;
  margin: 0 auto -5px;
  padding: 6px clamp(18px, 4vw, 44px) 0;
}

.role-review-entry-button svg {
  width: 15px;
  height: 15px;
}

.role-review-form select {
  width: 100%;
  height: 38px;
  padding: 0 11px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-raised);
  color: var(--text);
}

.role-review-form .agent-choice:has(input:disabled) {
  cursor: not-allowed;
  opacity: 0.55;
}

@media (max-width: 620px) {
  .role-review-entry-row {
    padding-inline: 10px;
  }
}
</style>
