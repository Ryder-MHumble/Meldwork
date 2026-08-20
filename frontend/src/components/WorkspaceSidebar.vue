<template>
  <aside
    class="sidebar"
    :class="{ collapsed: sidebarCollapsed }"
    :inert="contentInteractionBlocked ? '' : undefined"
    :aria-hidden="contentInteractionBlocked ? 'true' : undefined"
  >
    <header class="brand-row">
      <button
        class="brand-button"
        :class="{ active: activeView === 'home' }"
        type="button"
        :title="t('nav.home')"
        :aria-label="t('nav.home')"
        :aria-current="activeView === 'home' ? 'page' : undefined"
        @click="goHome"
      >
        <img :src="productMark" alt="" />
        <span>
          <strong>Meldwork</strong>
          <small>{{ t('app.localWorkspace') }}</small>
        </span>
      </button>
      <button
        class="icon-button sidebar-toggle"
        type="button"
        :title="sidebarCollapsed ? t('nav.expandSidebar') : t('nav.collapseSidebar')"
        :aria-label="sidebarCollapsed ? t('nav.expandSidebar') : t('nav.collapseSidebar')"
        :aria-expanded="sidebarCollapsed ? 'false' : 'true'"
        @click="sidebarCollapsed = !sidebarCollapsed"
      >
        <ChevronForwardOutline v-if="sidebarCollapsed" />
        <ChevronBackOutline v-else />
      </button>
    </header>

    <button class="new-group-button" type="button" :title="t('nav.newGroup')" @click="openNewGroup">
      <AddOutline />
      <span>{{ t('nav.newGroup') }}</span>
    </button>

    <nav class="conversation-nav" :aria-label="t('nav.conversations')">
      <section class="nav-section">
        <button
          class="nav-heading"
          type="button"
          :title="sidebarAgentsCollapsed ? t('nav.expandAgents') : t('nav.collapseAgents')"
          :aria-expanded="String(!sidebarAgentsCollapsed)"
          aria-controls="sidebar-agent-list"
          @click="sidebarAgentsCollapsed = !sidebarAgentsCollapsed"
        >
          <span>{{ t('nav.sidebarAgents') }}</span>
        </button>
        <div v-if="!sidebarAgentsCollapsed" id="sidebar-agent-list">
          <article v-for="agent in sidebarAgents" :key="agent.kind" class="sidebar-agent">
            <header class="sidebar-agent-header">
              <button
                class="sidebar-agent-main"
                type="button"
                :title="agent.label"
                :disabled="isDirectCreationPending(agent.kind)"
                :aria-expanded="directGroupsFor(agent.kind).length ? String(isSidebarAgentExpanded(agent.kind)) : undefined"
                :aria-controls="directGroupsFor(agent.kind).length ? sidebarAgentSessionListId(agent.kind) : undefined"
                @click="handleSidebarAgentMain(agent)"
              >
                <img :src="agent.logo" :alt="agent.label" />
                <span>
                  <strong>{{ agent.label }}</strong>
                  <small>
                    {{ directGroupsFor(agent.kind).length
                      ? t('nav.agentSessions', { count: directGroupsFor(agent.kind).length })
                      : t('nav.noAgentSessions') }}
                  </small>
                </span>
              </button>
              <button
                class="sidebar-agent-new"
                type="button"
                :title="t('nav.newDirect', { agent: agent.label })"
                :aria-label="t('nav.newDirect', { agent: agent.label })"
                :disabled="!agent.ready || isDirectCreationPending(agent.kind)"
                @click="createDirectSession(agent)"
              >
                <AddOutline />
              </button>
            </header>
            <div
              v-if="directGroupsFor(agent.kind).length && isSidebarAgentExpanded(agent.kind)"
              :id="sidebarAgentSessionListId(agent.kind)"
              class="direct-session-list"
            >
              <div
                v-for="group in visibleDirectGroupsFor(agent.kind)"
                :key="group.id"
                class="direct-session-row"
                :class="{ active: isSelectedConversation(group) }"
              >
                <button
                  class="direct-session-open"
                  type="button"
                  :title="t('nav.openDirect', { name: groupName(group) })"
                  :aria-current="isSelectedConversation(group) ? 'page' : undefined"
                  @click="selectGroup(group.id)"
                >
                  <span>{{ groupName(group) }}</span>
                </button>
                <span
                  v-if="isGroupRunning(group.id) && !isSelectedConversation(group)"
                  class="run-mark"
                  :title="t('conversation.runningGeneric')"
                >
                  <span class="run-agent-bars" aria-hidden="true"><i /><i /><i /></span>
                </span>
                <span
                  v-else-if="hasFinishedDirectRun(group.id) && !isSelectedConversation(group)"
                  class="run-finished-mark"
                  :title="t('nav.runFinished')"
                >
                  <CheckmarkCircleOutline />
                </span>
                <span v-else class="direct-session-spacer" />
                <button
                  v-if="!isGroupRunning(group.id) || isSelectedConversation(group)"
                  class="direct-session-action"
                  type="button"
                  :title="t('nav.renameDirect', { name: groupName(group) })"
                  :aria-label="t('nav.renameDirect', { name: groupName(group) })"
                  :disabled="isGroupRunning(group.id)"
                  @click="openConversationRename(group)"
                >
                  <PencilOutline />
                </button>
                <span v-if="!isGroupRunning(group.id) || isSelectedConversation(group)" class="sidebar-delete-control">
                  <button
                    class="direct-session-action danger"
                    type="button"
                    :title="t('nav.deleteDirect', { name: groupName(group) })"
                    :aria-label="t('nav.deleteDirect', { name: groupName(group) })"
                    :disabled="isGroupRunning(group.id)"
                    @click="openSidebarConversationDelete(group, $event)"
                  >
                    <TrashOutline />
                  </button>
                </span>
              </div>
              <button
                v-if="hasMoreDirectGroups(agent.kind)"
                class="sidebar-more-button"
                type="button"
                :title="t(isDirectSessionListExpanded(agent.kind) ? 'nav.lessDirectSessions' : 'nav.moreDirectSessions', {
                  agent: agent.label,
                  count: remainingDirectGroupsCount(agent.kind),
                })"
                :aria-label="t(isDirectSessionListExpanded(agent.kind) ? 'nav.lessDirectSessions' : 'nav.moreDirectSessions', {
                  agent: agent.label,
                  count: remainingDirectGroupsCount(agent.kind),
                })"
                :aria-expanded="String(isDirectSessionListExpanded(agent.kind))"
                @click="toggleDirectSessionListExpanded(agent.kind)"
              >
                <span>{{ t(isDirectSessionListExpanded(agent.kind) ? 'nav.lessItems' : 'nav.moreItems') }}</span>
              </button>
            </div>
          </article>
        </div>
        <p v-if="!sidebarAgents.length && !sidebarAgentsCollapsed" class="nav-empty">{{ t('nav.noSidebarAgents') }}</p>
      </section>

      <section class="nav-section group-nav-section">
        <button
          class="nav-heading"
          type="button"
          :title="sidebarGroupsCollapsed ? t('nav.expandGroups') : t('nav.collapseGroups')"
          :aria-expanded="String(!sidebarGroupsCollapsed)"
          aria-controls="sidebar-group-list"
          @click="sidebarGroupsCollapsed = !sidebarGroupsCollapsed"
        >
          <span>{{ t('nav.groups') }}</span>
        </button>
        <div v-if="!sidebarGroupsCollapsed" id="sidebar-group-list">
          <div v-if="groupGroups.length" class="group-conversation-list">
            <div
              v-for="group in visibleGroupGroups"
              :key="group.id"
              class="group-conversation-row"
              :class="{ active: isSelectedConversation(group) }"
            >
              <button
                class="conversation-link"
                type="button"
                :title="t('nav.openGroup', { name: groupName(group) })"
                :aria-current="isSelectedConversation(group) ? 'page' : undefined"
                @click="selectGroup(group.id)"
              >
                <span class="group-avatar"><ChatbubblesOutline /></span>
                <span>{{ groupName(group) }}</span>
                <span
                  v-if="isGroupRunning(group.id) && !isSelectedConversation(group)"
                  class="run-mark"
                  :title="t('conversation.runningGeneric')"
                >
                  <span class="run-agent-bars" aria-hidden="true"><i /><i /><i /></span>
                </span>
              </button>
              <span v-if="!isGroupRunning(group.id) || isSelectedConversation(group)" class="group-conversation-actions">
                <button
                  class="direct-session-action"
                  type="button"
                  :title="t('nav.renameGroup', { name: groupName(group) })"
                  :aria-label="t('nav.renameGroup', { name: groupName(group) })"
                  :disabled="isGroupRunning(group.id)"
                  @click="openConversationRename(group)"
                >
                  <PencilOutline />
                </button>
                <span class="sidebar-delete-control">
                  <button
                    class="direct-session-action danger"
                    type="button"
                    :title="t('nav.deleteGroup', { name: groupName(group) })"
                    :aria-label="t('nav.deleteGroup', { name: groupName(group) })"
                    :disabled="isGroupRunning(group.id)"
                    @click="openSidebarConversationDelete(group, $event)"
                  >
                    <TrashOutline />
                  </button>
                </span>
              </span>
            </div>
            <button
              v-if="hasMoreGroupGroups"
              class="sidebar-more-button"
              type="button"
              :title="t(groupSessionListExpanded ? 'nav.lessGroups' : 'nav.moreGroups', {
                count: remainingGroupGroupsCount,
              })"
              :aria-label="t(groupSessionListExpanded ? 'nav.lessGroups' : 'nav.moreGroups', {
                count: remainingGroupGroupsCount,
              })"
              :aria-expanded="String(groupSessionListExpanded)"
              @click="toggleGroupSessionListExpanded"
            >
              <span>{{ t(groupSessionListExpanded ? 'nav.lessItems' : 'nav.moreItems') }}</span>
            </button>
          </div>
          <p v-else class="nav-empty">{{ t('nav.noGroups') }}</p>
        </div>
      </section>
    </nav>

    <div v-if="sidebarCollapsed" class="collapsed-group-switcher">
      <button
        ref="collapsedGroupMenuButton"
        class="icon-button collapsed-group-switcher-button"
        :class="{ active: collapsedGroupMenuOpen }"
        type="button"
        :title="t('nav.switchGroup')"
        :aria-label="t('nav.switchGroup')"
        :aria-expanded="String(collapsedGroupMenuOpen)"
        aria-haspopup="dialog"
        aria-controls="collapsed-group-menu"
        @click="toggleCollapsedGroupMenu"
      >
        <ChatbubblesOutline />
        <span v-if="groupGroups.length" class="collapsed-group-count" aria-hidden="true">
          {{ groupGroups.length > 99 ? '99+' : groupGroups.length }}
        </span>
      </button>
    </div>

    <footer class="sidebar-footer">
      <button
        class="sidebar-settings-entry"
        :class="{ active: activeView === 'settings' }"
        type="button"
        :title="t('nav.settings')"
        :aria-current="activeView === 'settings' ? 'page' : undefined"
        @click="openSystemSettings('agents')"
      >
        <SettingsOutline />
        <span>{{ t('nav.settings') }}</span>
      </button>
      <div class="sidebar-footer-actions">
        <button
          class="icon-button"
          type="button"
          :title="t('common.languageTarget')"
          :aria-label="t('common.language')"
          @click="toggleLocale"
        >
          <span class="preference-icon-frame" aria-hidden="true">
            <Transition name="preference-icon">
              <span :key="t('common.languageTarget')" class="preference-icon">
                <LanguageOutline />
              </span>
            </Transition>
          </span>
        </button>
        <button
          class="icon-button"
          type="button"
          :title="theme === 'dark' ? t('common.themeLight') : t('common.themeDark')"
          :aria-label="theme === 'dark' ? t('common.themeLight') : t('common.themeDark')"
          @click="toggleTheme"
        >
          <span class="preference-icon-frame" aria-hidden="true">
            <Transition name="preference-icon">
              <span :key="theme" class="preference-icon">
                <SunnyOutline v-if="theme === 'dark'" />
                <MoonOutline v-else />
              </span>
            </Transition>
          </span>
        </button>
      </div>
    </footer>
  </aside>

  <Teleport to="body">
    <section
      v-if="collapsedGroupMenuOpen"
      id="collapsed-group-menu"
      ref="collapsedGroupMenu"
      class="collapsed-group-menu"
      role="dialog"
      :aria-label="t('nav.switchGroup')"
      :style="collapsedGroupMenuStyle"
    >
      <header class="collapsed-group-menu-header">
        <span class="collapsed-group-menu-icon"><PeopleOutline /></span>
        <span>
          <strong>{{ t('nav.groups') }}</strong>
          <small>{{ t('nav.groupCount', { count: groupGroups.length }) }}</small>
        </span>
      </header>
      <div v-if="groupGroups.length" class="collapsed-group-menu-list">
        <button
          v-for="group in groupGroups"
          :key="group.id"
          class="collapsed-group-option"
          :class="{ active: activeView === 'conversation' && selectedGroupId === group.id }"
          type="button"
          :title="t('nav.openGroup', { name: groupName(group) })"
          :aria-current="activeView === 'conversation' && selectedGroupId === group.id ? 'page' : undefined"
          @click="selectGroup(group.id)"
        >
          <span class="group-avatar"><ChatbubblesOutline /></span>
          <span class="collapsed-group-option-main">
            <strong>{{ groupName(group) }}</strong>
            <small>{{ groupAgentSummary(group) }}</small>
          </span>
          <span class="collapsed-group-option-state">
            <span
              v-if="isGroupRunning(group.id) && !isSelectedConversation(group)"
              class="run-mark"
              :title="t('conversation.runningGeneric')"
            >
              <span class="run-agent-bars" aria-hidden="true"><i /><i /><i /></span>
            </span>
            <CheckmarkCircleOutline v-else-if="isSelectedConversation(group)" aria-hidden="true" />
            <time v-else>{{ formatNavTime(group.updatedAt || group.createdAt) }}</time>
          </span>
        </button>
      </div>
      <p v-else class="collapsed-group-menu-empty">{{ t('nav.noGroups') }}</p>
    </section>
  </Teleport>

  <Teleport to="body">
    <span
      v-if="sidebarDeleteGroup"
      class="settings-delete-popover sidebar-delete-popover"
      role="dialog"
      aria-modal="false"
      :style="sidebarDeletePopoverStyle"
      :aria-labelledby="`sidebar-delete-title-${sidebarDeleteGroup.id}`"
    >
      <strong :id="`sidebar-delete-title-${sidebarDeleteGroup.id}`">{{ t('settings.deletePrompt') }}</strong>
      <p>{{ t('settings.deleteHint') }}</p>
      <span class="settings-delete-actions">
        <button class="secondary-button compact" type="button" :disabled="saving" @click="dismissSidebarDeleteConfirmation">
          {{ t('common.cancel') }}
        </button>
        <button class="danger-button" type="button" :disabled="saving" @click="deleteSidebarConversation(sidebarDeleteGroup)">
          {{ t('settings.deleteConfirm') }}
        </button>
      </span>
    </span>
  </Teleport>
</template>

<script setup>
import { unref } from 'vue'
import {
  AddOutline,
  ChatbubblesOutline,
  CheckmarkCircleOutline,
  ChevronBackOutline,
  ChevronForwardOutline,
  LanguageOutline,
  MoonOutline,
  PencilOutline,
  PeopleOutline,
  SettingsOutline,
  SunnyOutline,
  TrashOutline,
} from '@vicons/ionicons5'

const props = defineProps({
  controller: { type: Object, required: true },
})

const {
  activeView,
  collapsedGroupMenu,
  collapsedGroupMenuButton,
  collapsedGroupMenuOpen,
  collapsedGroupMenuStyle,
  contentInteractionBlocked,
  createDirectSession,
  deleteSidebarConversation,
  directGroupsFor,
  dismissSidebarDeleteConfirmation,
  formatNavTime,
  goHome,
  groupAgentSummary,
  groupGroups,
  groupName,
  groupSessionListExpanded,
  handleSidebarAgentMain,
  hasFinishedDirectRun,
  hasMoreDirectGroups,
  hasMoreGroupGroups,
  isDirectCreationPending,
  isDirectSessionListExpanded,
  isGroupRunning,
  isSidebarAgentExpanded,
  openConversationRename,
  openNewGroup,
  openSidebarConversationDelete,
  openSystemSettings,
  productMark,
  remainingDirectGroupsCount,
  remainingGroupGroupsCount,
  saving,
  selectGroup,
  selectedGroupId,
  sidebarAgentSessionListId,
  sidebarAgents,
  sidebarAgentsCollapsed,
  sidebarGroupsCollapsed,
  sidebarCollapsed,
  sidebarDeleteGroup,
  sidebarDeletePopoverStyle,
  t,
  theme,
  toggleCollapsedGroupMenu,
  toggleDirectSessionListExpanded,
  toggleGroupSessionListExpanded,
  toggleLocale,
  toggleTheme,
  visibleDirectGroupsFor,
  visibleGroupGroups,
} = props.controller

function isSelectedConversation(group) {
  return unref(activeView) === 'conversation' && unref(selectedGroupId) === group.id
}
</script>
