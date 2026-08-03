<template>
  <main
    class="app-shell"
    :class="{ 'sidebar-collapsed': sidebarCollapsed, 'trace-panel-open': tracePanelOpen }"
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
            <div class="nav-heading">
              <span>{{ t('nav.sidebarAgents') }}</span>
              <PersonOutline />
            </div>
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
                  :class="{ active: activeView === 'conversation' && selectedGroupId === group.id }"
                >
                  <button
                    class="direct-session-open"
                    type="button"
                    :title="t('nav.openDirect', { name: groupName(group) })"
                    :aria-current="activeView === 'conversation' && selectedGroupId === group.id ? 'page' : undefined"
                    @click="selectGroup(group.id)"
                  >
                    <span>{{ groupName(group) }}</span>
                    <time>{{ formatNavTime(group.updatedAt || group.createdAt) }}</time>
                  </button>
                  <span v-if="isGroupRunning(group.id)" class="run-mark" :title="t('conversation.runningGeneric')">
                    <span class="run-agent-bars" aria-hidden="true"><i /><i /><i /></span>
                  </span>
                  <span v-else-if="hasFinishedDirectRun(group.id)" class="run-finished-mark" :title="t('nav.runFinished')">
                    <CheckmarkCircleOutline />
                  </span>
                  <span v-else class="direct-session-spacer" />
                  <button
                    class="direct-session-action"
                    type="button"
                    :title="t('nav.renameDirect', { name: groupName(group) })"
                    :aria-label="t('nav.renameDirect', { name: groupName(group) })"
                    :disabled="isGroupRunning(group.id)"
                    @click="openConversationRename(group)"
                  >
                    <PencilOutline />
                  </button>
                  <span class="sidebar-delete-control">
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
            <p v-if="!sidebarAgents.length" class="nav-empty">{{ t('nav.noSidebarAgents') }}</p>
          </section>

          <section class="nav-section group-nav-section">
            <div class="nav-heading">
              <span>{{ t('nav.groups') }}</span>
              <PeopleOutline />
            </div>
            <div v-if="groupGroups.length" class="group-conversation-list">
              <div
                v-for="group in visibleGroupGroups"
                :key="group.id"
                class="group-conversation-row"
                :class="{ active: activeView === 'conversation' && selectedGroupId === group.id }"
              >
                <button
                  class="conversation-link"
                  type="button"
                  :title="t('nav.openGroup', { name: groupName(group) })"
                  :aria-current="activeView === 'conversation' && selectedGroupId === group.id ? 'page' : undefined"
                  @click="selectGroup(group.id)"
                >
                  <span class="group-avatar"><ChatbubblesOutline /></span>
                  <span>{{ groupName(group) }}</span>
                  <span v-if="isGroupRunning(group.id)" class="run-mark" :title="t('conversation.runningGeneric')">
                    <span class="run-agent-bars" aria-hidden="true"><i /><i /><i /></span>
                  </span>
                </button>
                <span class="group-conversation-actions">
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
            <p v-if="!groupGroups.length" class="nav-empty">{{ t('nav.noGroups') }}</p>
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
                <span v-if="isGroupRunning(group.id)" class="run-mark" :title="t('conversation.runningGeneric')">
                  <span class="run-agent-bars" aria-hidden="true"><i /><i /><i /></span>
                </span>
                <CheckmarkCircleOutline
                  v-else-if="activeView === 'conversation' && selectedGroupId === group.id"
                  aria-hidden="true"
                />
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

      <section
        class="workspace-pane"
        :inert="contentInteractionBlocked ? '' : undefined"
        :aria-hidden="contentInteractionBlocked ? 'true' : undefined"
      >
        <section v-if="activeView === 'settings'" class="system-settings-page">
          <header class="system-settings-header">
            <div>
              <h1>{{ t('systemSettings.title') }}</h1>
              <p>{{ t('systemSettings.subtitle') }}</p>
            </div>
          </header>

          <div class="system-settings-body">
            <nav class="settings-tabs" role="tablist" :aria-label="t('systemSettings.title')">
              <button
                type="button"
                role="tab"
                :aria-selected="systemSettingsSection === 'agents'"
                :class="{ active: systemSettingsSection === 'agents' }"
                @click="selectSystemSettingsSection('agents')"
              >
                <TerminalOutline />
                {{ t('systemSettings.agents') }}
              </button>
              <button
                type="button"
                role="tab"
                :aria-selected="systemSettingsSection === 'providers'"
                :class="{ active: systemSettingsSection === 'providers' }"
                @click="selectSystemSettingsSection('providers')"
              >
                <KeyOutline />
                {{ t('systemSettings.providers') }}
              </button>
              <button
                type="button"
                role="tab"
                :aria-selected="systemSettingsSection === 'knowledge-bases'"
                :class="{ active: systemSettingsSection === 'knowledge-bases' }"
                @click="selectSystemSettingsSection('knowledge-bases')"
              >
                <LibraryOutline />
                {{ t('systemSettings.knowledgeBases') }}
              </button>
            </nav>

            <section v-if="systemSettingsSection === 'agents'" class="settings-panel agent-manager">
              <div class="manager-toolbar">
                <span>{{ t('home.readyCount', { ready: readyCount, installed: installedCount }) }}</span>
                <div class="manager-toolbar-actions">
                  <button class="secondary-button" type="button" :disabled="saving" @click="openCustomAgentModal">
                    <AddOutline />
                    {{ t('customAgent.add') }}
                  </button>
                  <button class="secondary-button" type="button" :disabled="refreshing" @click="refreshAgents">
                    <RefreshOutline :class="{ spinning: refreshing }" />
                    {{ t('installer.refresh') }}
                  </button>
                </div>
              </div>
              <section
                v-for="category in agentCatalogGroups"
                :key="category.id"
                class="agent-catalog-category"
              >
                <header class="agent-catalog-category-header">
                  <div>
                    <h2>{{ t(category.titleKey) }}</h2>
                    <p>{{ t(category.subtitleKey) }}</p>
                  </div>
                  <small>{{ t('systemSettings.agentCount', { count: category.agents.length }) }}</small>
                </header>
                <div v-if="category.agents.length" class="agent-grid settings-agent-grid">
                <article
                  v-for="agent in category.agents"
                  :key="agent.kind"
                  class="agent-card settings-agent-card"
                  :class="{ focused: focusedAgentKind === agent.kind }"
                >
                  <button
                    class="agent-card-main"
                    type="button"
                    :title="t('systemSettings.openAgentDetail', { agent: agent.label })"
                    @click="openAgentDetail(agent)"
                  >
                    <img :src="agent.logo" :alt="agent.label" />
                    <span class="agent-card-copy">
                      <span class="agent-name-row">
                        <strong>{{ agent.label }}</strong>
                        <span class="agent-state" :class="agentState(agent).tone">
                          <component :is="agentState(agent).icon" />
                          {{ agentState(agent).label }}
                        </span>
                      </span>
                      <span class="agent-card-description">{{ agentDescription(agent.kind) }}</span>
                      <span class="agent-capability-list">
                        <span v-if="agent.ready">{{ agentSkillLabel(agent.kind) }}</span>
                        <span>{{ agentImageLabel(agent) }}</span>
                        <span>{{ providerSummaryLabel(agent) }}</span>
                      </span>
                    </span>
                    <ChevronForwardOutline class="card-chevron" />
                  </button>
                  <div v-if="installConfirmKind === agent.kind" class="install-confirm">
                    <strong>{{ t('installer.confirm', { agent: agent.label }) }}</strong>
                    <span>{{ t('installer.confirmHint') }}</span>
                  </div>
                  <div v-if="installerState.kind === agent.kind && installerState.phase !== 'idle'" class="install-progress">
                    <span>{{ installerPhaseLabel }}</span>
                  </div>
                  <div class="agent-card-meta-row">
                    <span
                      v-if="agent.version"
                      class="agent-version"
                      :title="t('agent.detectedVersion', { version: agent.version })"
                    >
                      {{ t('agent.detectedVersion', { version: agent.version }) }}
                    </span>
                    <div class="agent-card-actions settings-agent-actions">
                      <button
                        v-if="agent.ready"
                        type="button"
                        :disabled="isDirectCreationPending(agent.kind)"
                        @click.stop="openDirect(agent)"
                      >
                        <ChatbubbleEllipsesOutline />
                        {{ t('home.openChat') }}
                      </button>
                      <button
                        v-else-if="!agent.installed && agent.installSupported"
                        type="button"
                        :disabled="installerBusy && installerState.kind !== agent.kind"
                        @click.stop="requestInstall(agent)"
                      >
                        <DownloadOutline />
                        {{ installConfirmKind === agent.kind ? t('installer.confirm', { agent: agent.label }) : t('installer.install') }}
                      </button>
                      <span v-else-if="!agent.installed" class="manager-note">
                        {{ agent.custom
                          ? t('customAgent.executableUnavailable')
                          : agent.installErrorCode === 'INSTALL_AGENT_NODE_REQUIRED'
                            ? t('installer.nodeRequired')
                            : t('installer.unsupported') }}
                      </span>
                      <button
                        v-if="installerState.kind === agent.kind && installerState.canCancel"
                        type="button"
                        @click.stop="cancelInstall"
                      >
                        {{ t('installer.cancel') }}
                      </button>
                      <button
                        v-else-if="supportsExternalProvider(agent)"
                        type="button"
                        @click.stop="openProvider(agent.kind)"
                      >
                        <KeyOutline />
                        {{ t('systemSettings.providerForAgent') }}
                      </button>
                    </div>
                  </div>
                </article>
                </div>
                <div v-else class="custom-agent-empty">
                  <span>{{ t('customAgent.empty') }}</span>
                  <button class="secondary-button compact" type="button" :disabled="saving" @click="openCustomAgentModal">
                    <AddOutline />
                    {{ t('customAgent.add') }}
                  </button>
                </div>
              </section>
            </section>

            <section
              v-else-if="systemSettingsSection === 'knowledge-bases'"
              class="settings-panel knowledge-base-manager knowledge-base-panel"
              :aria-busy="String(knowledgeBaseLoading)"
            >
              <div class="manager-toolbar knowledge-base-toolbar">
                <span class="knowledge-base-ready-summary" role="status" aria-live="polite">
                  {{ knowledgeBaseLoading
                    ? t('knowledgeBase.status.checking')
                    : t('knowledgeBase.readyCount', { ready: readyKnowledgeBaseCount, total: localKnowledgeBaseEntries.length }) }}
                </span>
                <button class="secondary-button" type="button" :disabled="knowledgeBaseLoading" @click="loadKnowledgeBaseStatuses()">
                  <RefreshOutline :class="{ spinning: knowledgeBaseLoading }" />
                  {{ t('knowledgeBase.refresh') }}
                </button>
              </div>
              <div class="knowledge-base-sections">
                <section class="knowledge-base-group" :aria-labelledby="'knowledge-base-group-local'">
                  <header class="knowledge-base-group-header">
                    <h3 id="knowledge-base-group-local">{{ t('knowledgeBase.group.local') }}</h3>
                  </header>
                  <div class="knowledge-base-list">
                    <article
                      v-for="source in localKnowledgeBaseEntries"
                      :key="source.kind"
                      class="knowledge-base-item"
                      :class="{ pending: knowledgeBasePending(source) }"
                    >
                      <div class="knowledge-base-item-main">
                        <img class="knowledge-base-logo" :src="source.logo" :alt="t(`knowledgeBase.source.${source.kind}`)" />
                        <div class="knowledge-base-item-copy">
                          <div class="knowledge-base-item-title-row">
                            <strong>{{ t(`knowledgeBase.source.${source.kind}`) }}</strong>
                            <span class="knowledge-base-status" :class="knowledgeBaseTone(source)">
                              <component :is="knowledgeBaseIcon(source)" :class="{ spinning: knowledgeBasePending(source) }" />
                              {{ knowledgeBaseStatusLabel(source) }}
                            </span>
                          </div>
                          <div class="knowledge-base-tag-row">
                            <span
                              v-for="tag in knowledgeBaseTagItems(source)"
                              :key="tag.key"
                              class="knowledge-base-tag"
                              :class="tag.tone"
                            >
                              {{ tag.label }}
                            </span>
                          </div>
                          <span class="knowledge-base-card-description">{{ t(`knowledgeBase.description.${source.kind}`) }}</span>
                          <p v-if="knowledgeBaseLocationLabel(source)" class="knowledge-base-path">
                            <code>{{ knowledgeBaseLocationLabel(source) }}</code>
                          </p>
                        </div>
                      </div>
                      <button
                        class="knowledge-base-action"
                        type="button"
                        :disabled="knowledgeBasePending(source)"
                        @click="runKnowledgeBasePrimaryAction(source)"
                      >
                        <RefreshOutline v-if="knowledgeBasePending(source)" class="spinning" />
                        {{ knowledgeBasePrimaryActionLabel(source) }}
                        <ChevronForwardOutline v-if="!knowledgeBasePending(source)" />
                      </button>
                    </article>
                  </div>
                </section>
                <section class="knowledge-base-group" :aria-labelledby="'knowledge-base-group-planned'">
                  <header class="knowledge-base-group-header">
                    <h3 id="knowledge-base-group-planned">{{ t('knowledgeBase.group.planned') }}</h3>
                  </header>
                  <div class="knowledge-base-future-list">
                    <article
                      v-for="source in plannedKnowledgeBaseEntries"
                      :key="source.kind"
                      class="knowledge-base-future-item"
                      aria-disabled="true"
                    >
                      <div class="knowledge-base-item-main">
                        <img class="knowledge-base-logo" :src="source.logo" :alt="t(`knowledgeBase.source.${source.kind}`)" />
                        <div class="knowledge-base-item-copy">
                          <div class="knowledge-base-item-title-row">
                            <strong>{{ t(`knowledgeBase.source.${source.kind}`) }}</strong>
                            <span class="knowledge-base-status">
                              <CloudOutline />
                              {{ knowledgeBaseStatusLabel(source) }}
                            </span>
                          </div>
                          <span class="knowledge-base-card-description">{{ t(`knowledgeBase.description.${source.kind}`) }}</span>
                        </div>
                      </div>
                      <button class="knowledge-base-action ghost" type="button" disabled>
                        <CloudOutline />
                        {{ knowledgeBaseStatusLabel(source) }}
                      </button>
                    </article>
                  </div>
                </section>
              </div>
            </section>

            <section v-else-if="systemSettingsSection === 'providers'" class="settings-panel provider-settings-panel">
              <header class="provider-page-header">
                <div>
                  <h2>{{ t('provider.title') }}</h2>
                  <p>{{ t('provider.subtitle') }}</p>
                </div>
                <span class="provider-summary-count">
                  {{ t('provider.configuredCount', { configured: providerConfiguredCount, total: configurableProviderAgents.length }) }}
                </span>
              </header>
              <nav class="provider-agent-list" :aria-label="t('systemSettings.providers')">
                <button
                  v-for="agent in configurableProviderAgents"
                  :key="agent.kind"
                  type="button"
                  :aria-pressed="selectedProviderKind === agent.kind ? 'true' : 'false'"
                  :class="{ active: selectedProviderKind === agent.kind }"
                  @click="selectProviderAgent(agent.kind)"
                >
                  <img :src="agent.logo" alt="" />
                  <span class="provider-agent-copy">
                    <strong>{{ agent.label }}</strong>
                    <small :class="providerStatusTone(agent.kind)">{{ providerStatusLabel(agent.kind) }}</small>
                  </span>
                  <component
                    :is="providerStatusIcon(agent.kind)"
                    :class="{
                      ready: providerReady(agent.kind),
                      spinning: providerStatusIsChecking(agent.kind),
                    }"
                  />
                </button>
              </nav>

              <form
                class="provider-editor form-stack"
                :aria-busy="String(providerStatusIsChecking(selectedProviderKind))"
                @submit.prevent="saveProvider"
              >
                <header v-if="selectedProviderAgent" class="provider-editor-header">
                  <img :src="selectedProviderAgent.logo" alt="" />
                  <div class="provider-editor-title">
                    <h2>{{ t('provider.agentTitle', { agent: selectedProviderAgent.label }) }}</h2>
                    <div class="provider-agent-state" :class="selectedProviderAgentState.tone" role="status">
                      <component
                        :is="selectedProviderAgentState.icon"
                        :class="{ spinning: selectedProviderAgentState.id === 'checking' }"
                      />
                      <span>
                        <strong>{{ selectedProviderAgentState.label }}</strong>
                        <small>{{ selectedProviderAgentState.detail }}</small>
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
                      v-for="preset in selectedProviderPresets"
                      :key="preset.id"
                      type="button"
                      :aria-pressed="providerForm.preset === preset.id ? 'true' : 'false'"
                      :class="{ active: providerForm.preset === preset.id }"
                      :disabled="saving"
                      :title="providerPresetHint(preset.id)"
                      @click="applyProviderPreset(preset.id)"
                    >
                      <strong>{{ providerPresetLabel(preset.id) }}</strong>
                      <small :class="{ active: providerPresetActive(preset.id), configured: providerPresetConfigured(preset.id) }">
                        {{ providerPresetStateLabel(preset.id) }}
                      </small>
                    </button>
                  </div>
                </section>

                <section v-if="selectedProviderPreset" class="provider-source-detail">
                  <header class="provider-source-overview">
                    <TerminalOutline v-if="providerNativeOfficialMode" />
                    <KeyOutline v-else />
                    <div>
                      <strong>{{ t('provider.sourceTitle', { provider: providerPresetLabel(selectedProviderPreset.id) }) }}</strong>
                      <p>{{ providerPresetHint(selectedProviderPreset.id) }}</p>
                      <small>{{ t('provider.agentSpecificHint') }}</small>
                    </div>
                  </header>

                  <div v-if="providerStatus.error" class="provider-inline-warning" role="status">
                    <span>{{ t('provider.unavailable') }}</span>
                    <button type="button" :disabled="saving" @click="retryProviderStatus(selectedProviderKind)">
                      <RefreshOutline />
                      {{ t('common.retry') }}
                    </button>
                  </div>
                  <p v-if="providerStatus.encryptionAvailable === false" class="form-error">
                    {{ t('provider.encryptionUnavailable') }}
                  </p>

                  <template v-if="providerNativeOfficialMode">
                    <div class="provider-native-card" :class="selectedProviderAgentState.tone">
                      <TerminalOutline />
                      <div class="provider-native-card-content">
                        <strong>{{ t('provider.nativeTitle') }}</strong>
                        <p>{{ providerNativeGuideBody }}</p>
                        <div v-if="providerNativeActionVisible" class="provider-native-actions">
                          <button
                            class="secondary-button"
                            type="button"
                            :disabled="saving"
                            @click="openAgentManager(selectedProviderKind)"
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
                        <p>{{ t(selectedProviderProfile.docsKey) }}</p>
                      </div>
                      <dl>
                        <div v-if="selectedProviderProfile.configFile">
                          <dt>{{ t('provider.configFile') }}</dt>
                          <dd><code>{{ selectedProviderProfile.configFile }}</code></dd>
                        </div>
                        <div v-if="selectedProviderProfile.runtimeKeys.length">
                          <dt>{{ t('provider.runtimeKeys') }}</dt>
                          <dd>
                            <code v-for="key in selectedProviderProfile.runtimeKeys" :key="key">{{ key }}</code>
                          </dd>
                        </div>
                      </dl>
                    </div>
                  </template>

                  <template v-else>
                    <div v-if="selectedProviderProfileSaved" class="provider-profile-summary">
                      <span :class="{ active: selectedProviderPresetActive }">
                        {{ selectedProviderPresetActive ? t('provider.active') : t('provider.saved') }}
                      </span>
                      <span v-if="selectedProviderProfileStatus?.provider">{{ selectedProviderProfileStatus.provider }}</span>
                      <span v-if="selectedProviderProfileStatus?.model">{{ selectedProviderProfileStatus.model }}</span>
                    </div>

                    <p v-if="providerIdentityLocked" class="provider-field-note">
                      {{ t('provider.identityLocked') }}
                    </p>
                    <div class="provider-external-fields">
                      <label class="provider-field-name">
                        <span>{{ t('provider.name') }}</span>
                        <input
                          v-model.trim="providerForm.provider"
                          :placeholder="t('provider.namePlaceholder')"
                          autocomplete="off"
                          maxlength="80"
                          :readonly="providerIdentityLocked"
                          :aria-readonly="providerIdentityLocked ? 'true' : undefined"
                          :disabled="providerFormControlsDisabled"
                        />
                      </label>
                      <label class="provider-field-url">
                        <span>{{ t('provider.baseUrl') }}</span>
                        <input
                          v-model.trim="providerForm.baseUrl"
                          :placeholder="t('provider.baseUrlPlaceholder')"
                          inputmode="url"
                          autocomplete="off"
                          maxlength="300"
                          :readonly="providerIdentityLocked"
                          :aria-readonly="providerIdentityLocked ? 'true' : undefined"
                          :disabled="providerFormControlsDisabled"
                        />
                      </label>
                      <label class="provider-field-model">
                        <span>{{ t('provider.model') }}</span>
                        <input
                          v-model.trim="providerForm.model"
                          :placeholder="t('provider.modelPlaceholder')"
                          autocomplete="off"
                          maxlength="160"
                          :disabled="providerFormControlsDisabled"
                        />
                      </label>
                      <label class="provider-field-key">
                        <span>{{ t('provider.apiKey') }}</span>
                        <input
                          v-model="providerForm.apiKey"
                          type="password"
                          :placeholder="t('provider.apiKeyPlaceholder')"
                          autocomplete="new-password"
                          maxlength="8192"
                          :disabled="providerFormControlsDisabled"
                        />
                      </label>
                    </div>
                  </template>
                </section>

                <p v-if="formError" class="form-error">{{ formError }}</p>
                <footer class="provider-editor-footer">
                  <button v-if="selectedProviderProfileSaved" class="danger-button" type="button" :disabled="saving" @click="removeProvider">
                    <TrashOutline />
                    {{ providerRemoveArmed ? t('provider.removeConfirm') : t('provider.remove') }}
                  </button>
                  <span class="footer-spacer" />
                  <button
                    v-if="selectedProviderPresetConfigured && !selectedProviderPresetActive"
                    class="secondary-button provider-activate-button"
                    type="button"
                    :disabled="saving"
                    @click="activateProviderPreset(providerForm.preset)"
                  >
                    <CheckmarkCircleOutline />
                    {{ t('provider.useProfile') }}
                  </button>
                  <button
                    v-if="!providerNativeOfficialMode"
                    class="primary-button"
                    type="submit"
                    :disabled="providerFormControlsDisabled || providerStatus.encryptionAvailable === false"
                  >
                    {{ providerSaveActionLabel }}
                  </button>
                </footer>
              </form>
            </section>
          </div>
        </section>

        <section
          v-else-if="activeView === 'home'"
          class="agent-home home-dashboard"
          :data-home-mode="homeMode"
        >
          <header class="home-dashboard-header">
            <div>
              <h1>{{ t('home.dashboardTitle') }}</h1>
              <p>{{ t('home.dashboardSubtitle') }}</p>
            </div>
            <div class="home-workspace-state" :class="{ attention: homeNeedsAttention }" role="status">
              <WarningOutline v-if="homeNeedsAttention" />
              <CheckmarkCircleOutline v-else />
              <span>{{ homeWorkspaceSummary }}</span>
            </div>
          </header>

          <section v-if="showRecoveryGuide" class="home-recovery-notice" aria-live="polite">
            <WarningOutline />
            <div>
              <h2>{{ t('home.recoveryTitle') }}</h2>
              <p>{{ t('home.recoveryBody') }}</p>
            </div>
            <button class="secondary-button compact" type="button" @click="openAgentManager()">
              <SettingsOutline />
              {{ t('home.openSettings') }}
            </button>
          </section>

          <div v-if="!showSetupGuide" class="home-dashboard-grid">
            <section class="home-panel home-recent-panel">
              <header class="home-panel-header">
                <div>
                  <h2>{{ t(homeMode === 'first-task' ? 'home.firstTaskTitle' : 'home.recentTitle') }}</h2>
                  <p>{{ t(homeMode === 'first-task' ? 'home.firstTaskSubtitle' : 'home.recentSubtitle') }}</p>
                </div>
              </header>
              <div v-if="recentGroups.length" class="home-recent-list">
                <button v-for="group in recentGroups" :key="group.id" class="home-recent-item" type="button" @click="selectGroup(group.id)">
                  <span class="home-recent-avatar">
                    <ChatbubblesOutline v-if="group.conversationType !== 'direct'" />
                    <img v-else :src="agentLogo(group.directAgentKind, theme)" alt="" />
                  </span>
                  <span class="home-recent-copy">
                    <strong>{{ groupName(group) }}</strong>
                    <small>{{ recentGroupMeta(group) }}</small>
                  </span>
                  <span v-if="isGroupRunning(group.id)" class="run-mark" :title="t('conversation.runningGeneric')"><span class="run-pulse" /></span>
                  <ChevronForwardOutline />
                </button>
              </div>
              <div v-else class="home-panel-empty">
                <ChatbubblesOutline />
                <p>{{ t('home.recentEmpty') }}</p>
                <button
                  v-if="homeMode === 'first-task'"
                  class="primary-button compact"
                  type="button"
                  :disabled="readyCount < 2"
                  @click="openNewGroup"
                >
                  <AddOutline />
                  {{ t('nav.newGroup') }}
                </button>
              </div>
            </section>

            <section class="home-panel home-agent-panel">
              <header class="home-panel-header">
                <div>
                  <h2>{{ t('home.agentStatusTitle') }}</h2>
                  <p>{{ t('home.agentStatusSubtitle') }}</p>
                </div>
                <button
                  v-if="homeMode !== 'first-task'"
                  class="secondary-button compact home-new-group-button"
                  type="button"
                  :disabled="readyCount < 2"
                  @click="openNewGroup"
                >
                  <AddOutline />
                  {{ t('nav.newGroup') }}
                </button>
              </header>
              <div v-if="homeAgentPreview.length" class="home-agent-list">
                <button v-for="agent in homeAgentPreview" :key="agent.kind" type="button" class="home-agent-item" @click="openDirect(agent)">
                  <img :src="agent.logo" :alt="agent.label" />
                  <span>
                    <strong>{{ agent.label }}</strong>
                    <small>{{ agentDescription(agent.kind) }}</small>
                  </span>
                  <ChevronForwardOutline />
                </button>
              </div>
              <div v-else class="home-panel-empty">
                <TerminalOutline />
                <p>{{ t('home.noReadyAgents') }}</p>
              </div>
            </section>
          </div>

          <section v-if="showSetupGuide" class="setup-guide" :aria-label="t('setupGuide.title')">
            <header>
              <div>
                <h2>{{ t('setupGuide.title') }}</h2>
                <p>{{ setupGuideMessage }}</p>
              </div>
            </header>
            <ol>
              <li :class="{ complete: installedCount > 0 }">
                <CheckmarkCircleOutline v-if="installedCount > 0" />
                <RefreshOutline v-else />
                <span>
                  <strong>{{ t('setupGuide.detectTitle') }}</strong>
                  <small>{{ t('setupGuide.detectBody') }}</small>
                </span>
              </li>
              <li :class="{ complete: providerConfiguredCount > 0 || !configurableProviderAgents.length }">
                <CheckmarkCircleOutline v-if="providerConfiguredCount > 0 || !configurableProviderAgents.length" />
                <KeyOutline v-else />
                <span>
                  <strong>{{ t('setupGuide.providerTitle') }}</strong>
                  <small>{{ t('setupGuide.providerBody') }}</small>
                </span>
              </li>
              <li :class="{ complete: readyCount > 0 }">
                <CheckmarkCircleOutline v-if="readyCount > 0" />
                <ChatbubblesOutline v-else />
                <span>
                  <strong>{{ t('setupGuide.chatTitle') }}</strong>
                  <small>{{ t('setupGuide.chatBody') }}</small>
                </span>
              </li>
            </ol>
            <footer>
              <button class="secondary-button" type="button" :disabled="refreshing" @click="refreshAgents">
                <RefreshOutline :class="{ spinning: refreshing }" />
                {{ refreshing ? t('home.refreshing') : t('home.refresh') }}
              </button>
              <button class="secondary-button" type="button" @click="openProvider()">
                <KeyOutline />
                {{ t('systemSettings.providers') }}
              </button>
              <button class="primary-button" type="button" @click="openAgentManager()">
                <SettingsOutline />
                {{ t('home.openSettings') }}
              </button>
            </footer>
          </section>

        </section>

        <section v-else class="conversation-pane">
          <header class="conversation-header" :class="{ 'editing-title': inlineTitleEditing }">
            <div class="conversation-identity">
              <div v-if="activeGroup.conversationType === 'direct'" class="conversation-avatar single">
                <img :src="agentLogo(activeGroup.directAgentKind, theme)" alt="" />
              </div>
              <div v-else class="conversation-avatar stack">
                <img
                  v-for="kind in activeGroup.agentKinds.slice(0, 3)"
                  :key="kind"
                  :src="agentLogo(kind, theme)"
                  alt=""
                />
              </div>
              <div ref="conversationTitleBlock" class="conversation-title-block" tabindex="-1">
                <form v-if="inlineTitleEditing" class="inline-title-form" @submit.prevent="saveInlineTitle">
                  <input
                    ref="inlineTitleInput"
                    v-model="inlineTitleDraft"
                    :aria-label="t('settings.conversationName')"
                    :placeholder="groupName(activeGroup)"
                    :disabled="saving"
                    maxlength="60"
                    @keydown.esc.stop.prevent="cancelInlineTitleEdit"
                  />
                  <button
                    type="submit"
                    :title="t('common.save')"
                    :aria-label="t('common.save')"
                    :disabled="saving"
                  >
                    <CheckmarkCircleOutline />
                  </button>
                  <button
                    type="button"
                    :title="t('common.cancel')"
                    :aria-label="t('common.cancel')"
                    :disabled="saving"
                    @click="cancelInlineTitleEdit"
                  >
                    <CloseOutline />
                  </button>
                </form>
                <h1 v-else>
                  <button
                    ref="inlineTitleButton"
                    class="conversation-title-button"
                    type="button"
                    :title="t('conversation.renameTitle')"
                    :aria-label="t('conversation.renameTitle')"
                    :disabled="Boolean(activeRun) || sending || saving"
                    @click="beginInlineTitleEdit"
                  >
                    <span>{{ groupName(activeGroup) }}</span>
                    <PencilOutline />
                  </button>
                </h1>
                <p class="conversation-capabilities">
                  <span>{{ activeGroup.conversationType === 'direct' ? t('conversation.direct') : t('conversation.members', { count: activeGroup.agentKinds.length }) }}</span>
                  <span class="meta-separator">/</span>
                  <span>{{ conversationPermissionLabel(activeGroup) }}</span>
                  <template v-if="activeDirectAgent">
                    <template v-if="activeDirectAgent.ready">
                      <span class="meta-separator">/</span>
                      <span>{{ agentSkillLabel(activeDirectAgent.kind) }}</span>
                    </template>
                    <span class="meta-separator">/</span>
                    <span>{{ agentImageLabel(activeDirectAgent) }}</span>
                    <span class="meta-separator">/</span>
                    <span>{{ providerModeShortLabel(activeDirectAgent.providerMode) }}</span>
                  </template>
                </p>
              </div>
            </div>
            <div class="conversation-header-actions">
              <button
                class="workspace-chip"
                type="button"
                :title="activeGroup.workdir"
                :disabled="Boolean(activeRun) || sending"
                @click="openGroupSettings"
              >
                <FolderOpenOutline />
                <span>{{ compactPath(activeGroup.workdir) }}</span>
              </button>
              <div ref="shortcutMenu" class="shortcut-menu-anchor">
                <button
                  class="icon-button"
                  type="button"
                  :title="t('shortcut.title')"
                  :aria-label="t('shortcut.title')"
                  :aria-expanded="String(shortcutMenuOpen)"
                  aria-controls="keyboard-shortcut-menu"
                  @click="shortcutMenuOpen = !shortcutMenuOpen"
                >
                  <KeyOutline />
                </button>
                <section
                  v-if="shortcutMenuOpen"
                  id="keyboard-shortcut-menu"
                  class="shortcut-menu"
                  role="dialog"
                  :aria-label="t('shortcut.title')"
                >
                  <header>{{ t('shortcut.title') }}</header>
                  <ul>
                    <li v-for="shortcut in shortcutDefinitions" :key="shortcut.labelKey">
                      <span>{{ t(shortcut.labelKey) }}</span>
                      <kbd>{{ shortcut.keys }}</kbd>
                    </li>
                  </ul>
                </section>
              </div>
              <button
                class="icon-button"
                type="button"
                :title="t('conversation.settings')"
                :aria-label="t('conversation.settings')"
                :disabled="Boolean(activeRun) || sending"
                @click="openGroupSettings"
              >
                <SettingsOutline />
              </button>
            </div>
          </header>

          <p
            v-if="activeGroup.conversationType === 'direct'"
            class="visually-hidden direct-conclusion-live-status"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {{ directConclusionLiveStatus }}
          </p>

          <div ref="messageScroller" class="message-scroll" @scroll="handleMessageScroll">
            <section v-if="conversationEmptyVisible" class="conversation-empty">
              <img class="conversation-empty-wordmark" :src="productWordmark" alt="Meldwork" />
              <Transition name="empty-showcase" mode="out-in">
                <div :key="emptyShowcaseIndex" class="conversation-empty-copy" aria-live="polite">
                  <strong>{{ t(`conversation.emptyShowcase.${emptyShowcaseIndex}.title`) }}</strong>
                  <p>{{ t(`conversation.emptyShowcase.${emptyShowcaseIndex}.body`) }}</p>
                </div>
              </Transition>
            </section>

            <div v-else class="message-stage">
              <nav class="turn-rail" :aria-label="t('conversation.turnRail')">
                <button
                  v-for="turn in turnRailItems"
                  :key="turn.id"
                  type="button"
                  :class="{ active: activeTurnRailId === turn.id }"
                  :data-status="turn.status"
                  :aria-label="turnRailLabel(turn)"
                  :aria-current="activeTurnRailId === turn.id ? 'true' : undefined"
                  @click="focusTurn(turn.id)"
                >
                  <span aria-hidden="true" />
                  <span class="turn-rail-tooltip" aria-hidden="true">
                    {{ turnRailLabel(turn) }}
                  </span>
                </button>
              </nav>

              <div class="message-list">
                <article
                  v-for="message in timelineMessages"
                  :key="message.id"
                  :id="messageElementId(message.id)"
                  class="message-row"
                  :data-agent-kind="message.role === 'agent' ? message.agentKind : undefined"
                  :class="[
                    message.role,
                    {
                      'direct-message': activeGroup.conversationType === 'direct',
                      'group-message': activeGroup.conversationType !== 'direct',
                      'topic-root': activeGroup.conversationType !== 'direct' && isTopicRoot(message),
                      'topic-reply': activeGroup.conversationType !== 'direct' && Boolean(messageThreadRootId(message)),
                      'active-topic': isActiveRunTopic(message),
                      copied: isMessageCopied(message.id),
                    },
                  ]"
                >
                <template v-if="message.role === 'system'">
                  <div class="system-message-stack">
                    <div class="system-message">
                      <WarningOutline />
                      <span>{{ translateSystemMessage(message) }}</span>
                      <button
                        v-if="activeGroup.conversationType !== 'direct' && message.agentKind && messageHasTrace(message)"
                        class="message-trace-button"
                        type="button"
                        :data-trace-agent-run-id="messageAgentRunId(message) || undefined"
                        :title="t('trace.viewProcess')"
                        :aria-label="t('trace.viewProcess')"
                        @click.stop="openTraceForMessage(message, $event.currentTarget)"
                      >
                        <TerminalOutline />
                      </button>
                      <button
                        v-if="isDismissibleSystemWarning(message)"
                        class="message-dismiss-button"
                        type="button"
                        :title="t('common.dismiss')"
                        :aria-label="t('common.dismiss')"
                        @click="dismissSystemMessage(message.id)"
                      >
                        <CloseOutline />
                      </button>
                    </div>
                    <details
                      v-if="activeGroup.conversationType === 'direct' && message.agentKind && messageHasTrace(message)"
                      class="execution-details trace-inline-details trace-system-details"
                      :open="isDirectTraceOpen(message)"
                      @toggle="syncDirectTraceDisclosure(message, $event)"
                    >
                      <summary>
                        <TerminalOutline />
                        <span>{{ t('trace.process') }}</span>
                        <small>{{ messageTraceEvents(message).length }}</small>
                        <time v-if="messageTraceStatus(message)">{{ runStatusLabel(messageTraceStatus(message)) }}</time>
                      </summary>
                      <p v-if="messageTraceSummary(message)" class="trace-inline-summary">
                        {{ messageTraceSummary(message) }}
                      </p>
                      <ol v-if="messageTraceEvents(message).length">
                        <li
                          v-for="(event, index) in messageTraceEvents(message)"
                          :key="`${messageTraceKey(message)}-${index}`"
                          class="trace-inline-event"
                        >
                          <div class="trace-inline-event-heading">
                            <span>
                              <strong>{{ traceEventTypeLabel(event.type) }}</strong>
                              <small v-if="traceEventTitle(event)">{{ traceEventTitle(event) }}</small>
                            </span>
                            <small :class="runStatusTone(event.status)">{{ runStatusLabel(event.status) }}</small>
                          </div>
                          <p v-if="event.summary">{{ event.summary }}</p>
                          <pre v-if="event.detail">{{ event.detail }}</pre>
                        </li>
                      </ol>
                      <p v-else class="trace-inline-empty">{{ t('trace.noEvents') }}</p>
                    </details>
                  </div>
                </template>
                <template v-else>
                  <img
                    v-if="message.role === 'agent'"
                    class="message-avatar"
                    :src="agentLogo(message.agentKind, theme)"
                    :alt="agentLabel(message.agentKind)"
                  />
                  <div class="message-body" :class="{ 'has-topic-replies': isTopicRoot(message) }">
                    <div class="message-meta">
                      <strong>{{ message.role === 'user' ? t('conversation.you') : agentLabel(message.agentKind) }}</strong>
                      <time>{{ formatTime(message.createdAt) }}</time>
                      <span v-if="isActiveRunTopic(message)" class="active-topic-label">
                        {{ t(activeGroup.conversationType === 'direct' ? 'conversation.activeTask' : 'conversation.activeTopic') }}
                      </span>
                      <button
                        v-if="activeGroup.conversationType !== 'direct' && messageHasTrace(message)"
                        class="message-trace-button"
                        type="button"
                        :data-trace-agent-run-id="messageAgentRunId(message) || undefined"
                        :title="t('trace.viewProcess')"
                        :aria-label="t('trace.viewProcess')"
                        @click.stop="openTraceForMessage(message, $event.currentTarget)"
                      >
                        <TerminalOutline />
                      </button>
                      <button
                        v-if="message.content"
                        class="message-copy-button"
                        type="button"
                        :title="isMessageCopied(message.id) ? t('conversation.copied') : t('conversation.copyMessage')"
                        :aria-label="isMessageCopied(message.id) ? t('conversation.copied') : t('conversation.copyMessage')"
                        @click.stop="copyMessageContent(message, $event, true)"
                        @keydown.enter.prevent="copyMessageContent(message, $event, true)"
                        @keydown.space.prevent="copyMessageContent(message, $event, true)"
                      >
                        <CheckmarkCircleOutline v-if="isMessageCopied(message.id)" />
                        <CopyOutline v-else />
                      </button>
                      <button
                        v-if="!message.provisional"
                        class="message-delete-button"
                        :class="{
                          armed: messageDeleteArmedId === message.id,
                          deleting: deletingMessageId === message.id,
                        }"
                        type="button"
                        :disabled="messageDeleteDisabled(message)"
                        :title="messageDeleteTitle(message)"
                        :aria-label="messageDeleteTitle(message)"
                        :aria-pressed="messageDeleteArmedId === message.id ? 'true' : 'false'"
                        @click.stop="requestMessageDelete(message)"
                      >
                        <CheckmarkCircleOutline v-if="messageDeleteArmedId === message.id" />
                        <TrashOutline v-else />
                      </button>
                    </div>
                    <template v-if="message.role === 'agent'">
                      <div
                        class="message-copy-surface"
                        :class="{ copied: isMessageCopied(message.id) }"
                        @click="copyMessageContent(message, $event)"
                      >
                        <MarkdownMessage v-if="message.content" :content="message.content" />
                        <span v-else class="trace-waiting-output">
                          <span class="typing-bars" aria-hidden="true"><span /><span /><span /></span>
                          {{ t('trace.waitingOutput') }}
                        </span>
                      </div>
                      <details v-if="messageExecutionSteps(message).length" class="execution-details">
                        <summary>
                          <TerminalOutline />
                          <span>{{ t('conversation.executionProcess') }}</span>
                          <small>{{ messageExecutionSteps(message).length }}</small>
                          <time v-if="messageElapsedLabel(message)">{{ messageElapsedLabel(message) }}</time>
                        </summary>
                        <ol>
                          <li v-for="(step, index) in messageExecutionSteps(message)" :key="`${message.id}-${index}`">
                            <span>{{ localizedStepTitle(step, index) }}</span>
                            <small :class="runStatusTone(step.status)">{{ runStatusLabel(step.status) }}</small>
                          </li>
                        </ol>
                      </details>
                      <details
                        v-if="activeGroup.conversationType === 'direct' && messageHasTrace(message)"
                        class="execution-details trace-inline-details"
                        :open="isDirectTraceOpen(message)"
                        @toggle="syncDirectTraceDisclosure(message, $event)"
                      >
                        <summary>
                          <TerminalOutline />
                          <span>{{ t('trace.process') }}</span>
                          <small>{{ messageTraceEvents(message).length }}</small>
                          <time v-if="messageTraceStatus(message)">{{ runStatusLabel(messageTraceStatus(message)) }}</time>
                        </summary>
                        <p v-if="messageTraceSummary(message)" class="trace-inline-summary">
                          {{ messageTraceSummary(message) }}
                        </p>
                        <ol v-if="messageTraceEvents(message).length">
                          <li
                            v-for="(event, index) in messageTraceEvents(message)"
                            :key="`${messageTraceKey(message)}-${index}`"
                            class="trace-inline-event"
                          >
                            <div class="trace-inline-event-heading">
                              <span>
                                <strong>{{ traceEventTypeLabel(event.type) }}</strong>
                                <small v-if="traceEventTitle(event)">{{ traceEventTitle(event) }}</small>
                              </span>
                              <small :class="runStatusTone(event.status)">{{ runStatusLabel(event.status) }}</small>
                            </div>
                            <p v-if="event.summary">{{ event.summary }}</p>
                            <pre v-if="event.detail">{{ event.detail }}</pre>
                          </li>
                        </ol>
                        <p v-else class="trace-inline-empty">{{ t('trace.noEvents') }}</p>
                      </details>
                    </template>
                    <template v-else>
                      <div class="user-message-flow">
                        <div
                          v-if="activeGroup.conversationType !== 'direct' && messageTargetKinds(message).length"
                          class="message-target-list"
                          :aria-label="t('composer.mentionedAgents')"
                        >
                          <span v-for="kind in messageTargetKinds(message)" :key="kind">
                            <img :src="agentLogo(kind, theme)" alt="" />
                            {{ agentLabel(kind) }}
                          </span>
                        </div>
                        <div
                          v-if="message.content"
                          class="message-content plain-message message-copy-surface"
                          :class="{ copied: isMessageCopied(message.id) }"
                          @click="copyMessageContent(message, $event)"
                        >
                          {{ message.content }}
                        </div>
                      </div>
                      <button
                        v-if="isTopicRoot(message)"
                        class="topic-toggle topic-reply-summary"
                        type="button"
                        :aria-expanded="isTopicExpanded(message.id) ? 'true' : 'false'"
                        :aria-label="topicToggleLabel(message.id)"
                        @click="toggleTopic(message.id)"
                      >
                        <span class="topic-reply-avatars" aria-hidden="true">
                          <img
                            v-for="kind in topicReplyAgentKinds(message.id)"
                            :key="kind"
                            :src="agentLogo(kind, theme)"
                            :alt="agentLabel(kind)"
                          />
                        </span>
                        <span>{{ topicReplyLabel(topicReplyCount(message.id)) }}</span>
                        <ChevronDownOutline :class="{ collapsed: !isTopicExpanded(message.id) }" />
                      </button>
                      <div
                        v-if="messageSkills(message).length || messageKnowledgeBases(message).length"
                        class="message-skill-list"
                      >
                        <span v-for="skill in messageSkills(message)" :key="skillKey(skill)">
                          @{{ skill.name || skill.slug }}
                        </span>
                        <span
                          v-for="source in messageKnowledgeBases(message)"
                          :key="`knowledge:${source.kind}`"
                          class="message-knowledge-base"
                        >
                          <img :src="knowledgeBaseLogo(source.kind)" alt="" />
                          @{{ knowledgeBaseName(source.kind) }}
                        </span>
                      </div>
                    </template>
                    <div v-if="messageAttachments(message).length" class="message-attachment-grid">
                      <figure
                        v-for="attachment in messageAttachments(message)"
                        :key="attachment.id"
                        v-attachment-preview="isImageAttachment(attachment) ? attachment : null"
                        :class="`media-${attachmentKind(attachment)}`"
                      >
                        <img
                          v-if="isImageAttachment(attachment) && attachmentPreviewUrl(attachment)"
                          :src="attachmentPreviewUrl(attachment)"
                          :alt="attachment.name"
                          loading="lazy"
                          decoding="async"
                        />
                        <audio
                          v-else-if="attachmentKind(attachment) === 'audio'"
                          :src="attachmentMediaUrl(attachment)"
                          :aria-label="attachment.name"
                          controls
                          preload="metadata"
                        />
                        <video
                          v-else-if="attachmentKind(attachment) === 'video'"
                          :src="attachmentMediaUrl(attachment)"
                          :aria-label="attachment.name"
                          controls
                          preload="metadata"
                          playsinline
                        />
                        <div v-else class="message-attachment-placeholder" aria-hidden="true">
                          <AttachOutline />
                        </div>
                        <figcaption :title="attachment.name">{{ attachment.name }}</figcaption>
                      </figure>
                    </div>
                  </div>
                </template>
              </article>

                <section
                  v-if="displayedRun && (activeGroup.conversationType !== 'direct' || !provisionalMessages.length)"
                  class="run-status-panel"
                  :class="{
                    direct: activeGroup.conversationType === 'direct',
                    group: activeGroup.conversationType !== 'direct',
                    solo: !isDisplayedCoordinatedRun,
                    multi: isDisplayedCoordinatedRun,
                    history: !activeRun,
                  }"
                  aria-live="polite"
                >
                  <header class="run-status-header">
                    <div v-if="!isDisplayedCoordinatedRun" class="direct-run-indicator" aria-hidden="true">
                      <span class="run-agent-logo" :data-status="displayedRunAgentStatus">
                        <img :src="agentLogo(displayedRunAgentKind, theme)" alt="" />
                      </span>
                      <div v-if="displayedRunAgentStatus === 'running'" class="typing-bars"><span /><span /><span /></div>
                    </div>
                    <div v-else class="relay-run-indicator" aria-hidden="true">
                      <span
                        v-for="(kind, index) in displayedRunTargetKinds.slice(0, 4)"
                        :key="kind"
                        class="run-agent-logo relay-run-agent"
                        :data-status="displayedRunAgentStatusForKind(kind)"
                        :style="{ '--avatar-index': index }"
                      >
                        <img :src="agentLogo(kind, theme)" alt="" />
                      </span>
                    </div>
                    <div class="run-status-copy">
                      <strong>{{ displayedRunLabel }}</strong>
                      <span
                        v-if="!isDisplayedCoordinatedRun"
                        class="solo-run-status"
                        :data-status="displayedRunAgentStatus"
                      >
                        {{ runStatusLabel(displayedRunAgentStatus) }}
                      </span>
                      <div class="run-status-meta">
                        <span v-if="displayedRunTopicRootId">
                          {{ t(activeRun
                            ? (activeGroup.conversationType === 'direct' ? 'conversation.activeTask' : 'conversation.activeTopic')
                            : 'conversation.retainedTopic') }}
                        </span>
                        <span v-if="runRoundProgress" class="run-round-progress">
                          {{ t(runRoundProgress.unlimited ? 'run.roundProgressUnlimited' : 'run.roundProgress', runRoundProgress) }}
                        </span>
                        <span v-if="!activeRun" class="run-summary-status" :data-status="runStatusTone(displayedRun.status)">
                          {{ runStatusLabel(displayedRun.status) }}
                        </span>
                        <span v-if="!activeRun">
                          {{ t('run.retainedEvents', { count: displayedRun.eventCount }) }}
                        </span>
                      </div>
                    </div>
                    <button
                      v-if="activeGroup.conversationType !== 'direct' && displayedRunAgentRuns.length"
                      class="icon-button run-details-button"
                      type="button"
                      :title="t('run.openDetails')"
                      :aria-label="t('run.openDetails')"
                      @click="openDisplayedRunTrace($event.currentTarget)"
                    >
                      <TerminalOutline />
                    </button>
                  </header>
                  <div
                    v-if="isDisplayedCoordinatedRun"
                    class="run-agent-list"
                    :aria-label="t('run.agents')"
                  >
                    <button
                      v-for="(kind, index) in displayedRunTargetKinds"
                      :key="kind"
                      class="run-agent-row"
                      :data-status="displayedRunAgentStatusForKind(kind)"
                      :data-trace-agent-run-id="displayedRunAgentForKind(kind)?.agentRunId || undefined"
                      :style="{ '--reveal-index': index }"
                      type="button"
                      :disabled="!displayedRunAgentForKind(kind)"
                      :aria-label="displayedRunAgentTraceLabel(kind)"
                      @click="openDisplayedTraceForAgent(kind, $event.currentTarget)"
                    >
                      <span class="run-agent-logo" :data-status="displayedRunAgentStatusForKind(kind)" aria-hidden="true">
                        <img :src="agentLogo(kind, theme)" alt="" />
                      </span>
                      <strong>{{ agentLabel(kind) }}</strong>
                      <span class="run-agent-state">
                        <span
                          class="run-agent-motion"
                          :data-status="displayedRunAgentStatusForKind(kind)"
                          aria-hidden="true"
                        >
                          <CheckmarkCircleOutline v-if="displayedRunAgentStatusForKind(kind) === 'completed'" />
                          <CloseCircleOutline v-else-if="displayedRunAgentStatusForKind(kind) === 'failed'" />
                          <span v-else-if="displayedRunAgentStatusForKind(kind) === 'running'" class="run-agent-bars">
                            <i /><i /><i />
                          </span>
                          <span v-else class="run-agent-dots"><i /><i /><i /></span>
                        </span>
                        <small :class="displayedRunAgentStatusForKind(kind)">{{ runStatusLabel(displayedRunAgentStatusForKind(kind)) }}</small>
                      </span>
                    </button>
                  </div>
                  <div v-if="activeRunProgress.length && !activeRunHasAgentRuns" class="execution-details run-progress-details">
                    <div class="execution-progress-header">
                      <TerminalOutline />
                      <span>{{ t('run.progress') }}</span>
                      <small>{{ activeRunProgress.length }}</small>
                    </div>
                    <ol>
                      <li v-for="(step, index) in activeRunProgress" :key="`${step.title}-${index}`">
                        <span>{{ localizedStepTitle(step, index) }}</span>
                        <small :class="runStatusTone(step.status)">{{ runStatusLabel(step.status) }}</small>
                      </li>
                    </ol>
                  </div>
                </section>
              </div>
            </div>
          </div>

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
                      <img
                        v-if="option.type !== 'skill'"
                        :src="composerMenuOptionLogo(option)"
                        alt=""
                      />
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

              <div class="composer-box">
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
                        :disabled="Boolean(activeRun) || sending || discussionMode === 'auto'"
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
                  <article v-for="attachment in composerAttachments" :key="attachment.id" class="composer-attachment">
                    <img v-if="isImageAttachment(attachment)" :src="attachment.previewDataUrl" :alt="attachment.name" />
                    <span v-else class="composer-attachment-media-icon" aria-hidden="true"><AttachOutline /></span>
                    <span :title="attachment.name">{{ attachment.name }}</span>
                    <button
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
                    :placeholder="t('composer.placeholder', { name: groupName(activeGroup) })"
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
        </section>
      </section>

      <RunTracePanel
        v-if="tracePanelOpen"
        ref="tracePanel"
        :open="tracePanelOpen"
        :drawer="tracePanelDrawer"
        :items="tracePanelItems"
        :selected-agent-run-id="selectedTraceAgentRunId"
        :theme="theme"
        @close="closeTracePanel"
        @select="selectTraceAgentRun"
        @jump-source="jumpToTraceSource"
      />

      <div v-if="onboardingVisible" class="onboarding-backdrop">
        <section
          ref="onboardingDialog"
          class="onboarding-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="onboarding-title"
          tabindex="-1"
        >
          <div class="onboarding-slide-viewport">
            <transition name="onboarding-slide">
              <article :key="onboardingIndex" class="onboarding-slide">
                <img :src="onboardingSlide.image" alt="" />
                <div>
                  <h1 id="onboarding-title">{{ onboardingSlide.title }}</h1>
                  <p>{{ onboardingSlide.body }}</p>
                </div>
              </article>
            </transition>
          </div>
          <footer class="onboarding-footer">
            <div class="onboarding-dots" :aria-label="t('onboarding.progress')">
              <button
                v-for="(_slide, index) in onboardingSlides"
                :key="index"
                type="button"
                class="onboarding-dot"
                :class="{ active: onboardingIndex === index }"
                :aria-label="t('onboarding.goToSlide', { count: index + 1 })"
                :aria-current="onboardingIndex === index ? 'step' : undefined"
                @click="selectOnboardingSlide(index)"
              />
            </div>
            <button
              class="primary-button onboarding-primary"
              type="button"
              :class="{ loading: !onboardingReady }"
              :disabled="!onboardingReady"
              @click="completeOnboarding"
            >
              <span v-if="!onboardingReady" class="loading-dots" aria-hidden="true"><i /><i /><i /></span>
              <CheckmarkCircleOutline v-else />
              {{ onboardingReady ? t('onboarding.start') : onboardingLoadingLabel }}
            </button>
          </footer>
        </section>
      </div>

      <transition name="modal-backdrop" appear>
        <div v-if="modal" class="modal-backdrop" @mousedown.self="closeModal">
          <transition name="modal-pop" appear>
            <section
              ref="modalDialog"
              class="modal"
              :class="{
                medium: modal === 'new-group' || modal === 'settings' || modal === 'custom-agent',
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
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import {
  AddOutline,
  AttachOutline,
  AtOutline,
  ChatbubbleEllipsesOutline,
  ChatbubblesOutline,
  CheckmarkCircleOutline,
  ChevronBackOutline,
  ChevronDownOutline,
  ChevronForwardOutline,
  CloseCircleOutline,
  CloseOutline,
  CopyOutline,
  DownloadOutline,
  CloudOutline,
  FolderOpenOutline,
  KeyOutline,
  LanguageOutline,
  LibraryOutline,
  MoonOutline,
  PencilOutline,
  PeopleOutline,
  PersonOutline,
  RefreshOutline,
  SettingsOutline,
  SendOutline,
  StopCircleOutline,
  SunnyOutline,
  TerminalOutline,
  TrashOutline,
  WarningOutline,
} from '@vicons/ionicons5'
import MarkdownMessage from './components/MarkdownMessage.vue'
import RunTracePanel from './components/RunTracePanel.vue'
import { parseAgentRoutingPrefix } from './agent-routing.js'
import { AGENTS, agentLabel, agentLogo, publicAsset, setCustomAgentProfiles } from './catalog.js'
import { useAttachmentPreviews } from './composables/useAttachmentPreviews.js'
import { KNOWLEDGE_BASE_CATALOG } from './knowledgeBaseCatalog.js'
import { desktopApi, emptySnapshot, errorCode, mergeRunEvent, normalizeSnapshot } from './desktop.js'
import { locale, setLocale, t, translateError, translateSystemMessage } from './i18n.js'
import { inferProviderPreset, providerProfile } from './providerProfiles.js'

const snapshot = ref(emptySnapshot())
const ONBOARDING_KEY = 'roundrelay-onboarding-seen-v1'
const MAX_SKILLS = 4
const MAX_KNOWLEDGE_BASES = 4
const MAX_ATTACHMENTS = 4
const MAX_ATTACHMENT_BYTES = 128 * 1024 * 1024
const ATTACHMENT_TYPES = new Set(['image', 'audio', 'video'])
const COMPOSER_INPUT_MIN_HEIGHT = 58
const COMPOSER_INPUT_MAX_HEIGHT = 180
const DIRECT_SESSION_PREVIEW_LIMIT = 5
const GROUP_SESSION_PREVIEW_LIMIT = 8
const ONBOARDING_SLIDE_MS = 3200
const EMPTY_SHOWCASE_COUNT = 3
const EMPTY_SHOWCASE_SLIDE_MS = 2800
const DISMISSIBLE_PLAN_WARNING = 'error: Cannot combine --prompt with --plan.'
const RUN_FINISHED_STATUSES = new Set([
  'completed', 'partial', 'failed', 'stopped', 'timeout', 'round-limit',
])
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
const NATIVE_PROVIDER_READY_SOURCES = new Set(['native-credential', 'native-auth-status', 'native-cli', 'verified-run'])
const COMING_SOON_KNOWLEDGE_BASE_KINDS = new Set(['notion', 'confluence', 'googledrive', 'sharepoint'])
const EXTERNAL_PROVIDER_KINDS = new Set(AGENTS.map(agent => agent.kind))
const EMPTY_PROVIDER_STATUS = Object.freeze({
  provider: '', baseUrl: '', model: '', activePreset: 'official', profiles: {},
  configured: false, encryptionAvailable: true, error: false,
})
const installCatalog = ref({ platform: '', agents: [] })
const installerState = ref({ taskId: '', kind: '', phase: 'idle', canCancel: false, errorCode: '' })
const providerStatuses = ref({})
const providerStatusLoadingKinds = ref(new Set())
const selectedProviderKind = ref(AGENTS[0]?.kind || 'codex')
const activeView = ref('home')
const systemSettingsSection = ref('agents')
const selectedGroupId = ref('')
const sidebarCollapsed = ref(false)
const defaultDirectory = ref('')
const booting = ref(true)
const bridgeMissing = ref(false)
const refreshing = ref(false)
const sending = ref(false)
const saving = ref(false)
const directCreationKinds = ref(new Set())
const modal = ref('')
const draft = ref('')
const targetKinds = ref([])
const selectedAgentKinds = ref([])
const activeMentionAgentKind = ref('')
const selectedSkills = ref([])
const selectedKnowledgeBases = ref([])
const skillOptions = ref([])
const skillMenuOpen = ref(false)
const skillActiveIndex = ref(0)
const skillsLoading = ref(false)
const composerAttachments = ref([])
const attachmentImportOperations = ref([])
const composerContextVersion = ref(0)
const onboardingVisible = ref(false)
const onboardingCompleted = ref(onboardingSeen())
const onboardingIndex = ref(0)
const onboardingDetecting = ref(false)
const onboardingPlaybackComplete = ref(false)
const discussionMode = ref('auto')
const maxRounds = ref(6)
const unlimitedRounds = ref(false)
const emptyShowcaseIndex = ref(0)
const roundSettingsOpen = ref(false)
const formError = ref('')
const deleteArmed = ref(false)
const customAgentDeleteArmed = ref(false)
const sidebarDeleteGroupId = ref('')
const sidebarDeletePopoverPoint = ref({ left: 0, top: 0 })
const providerRemoveArmed = ref(false)
const installConfirmKind = ref('')
const focusedAgentKind = ref('')
const toastMessage = ref('')
const copyToastMessage = ref('')
const shortcutMenuOpen = ref(false)
const collapsedGroupMenuOpen = ref(false)
const collapsedGroupMenuPoint = ref({ left: 0, bottom: 0 })
const settingsIntent = ref('settings')
const knowledgeBaseSources = ref([])
const knowledgeBaseLoading = ref(false)
const knowledgeBaseRefreshingKinds = reactive(new Set())
let knowledgeBaseStatusPromise = null
const knowledgeBaseSourceMap = computed(() => new Map(knowledgeBaseSources.value.map(source => [source.kind, source])))
const knowledgeBaseEntries = computed(() => KNOWLEDGE_BASE_CATALOG.map((definition) => {
  const status = knowledgeBaseSourceMap.value.get(definition.kind) || {}
  return {
    ...definition,
    ...definition.defaultState,
    ...status,
  }
}))
const localKnowledgeBaseEntries = computed(() => knowledgeBaseEntries.value.filter(source => !knowledgeBaseComingSoon(source)))
const plannedKnowledgeBaseEntries = computed(() => knowledgeBaseEntries.value.filter(knowledgeBaseComingSoon))
const readyKnowledgeBaseCount = computed(() => localKnowledgeBaseEntries.value.filter(knowledgeBaseReady).length)
const collapsedSidebarAgentKinds = ref(new Set())
const expandedSidebarAgentSessionKinds = ref(new Set())
const groupSessionListExpanded = ref(false)
const agentSkillStats = ref({})
const agentSkillCatalog = ref({})
const inlineTitleEditing = ref(false)
const inlineTitleDraft = ref('')
const activeTurnId = ref('')
const copiedMessageIds = ref(new Set())
const messageDeleteArmedId = ref('')
const deletingMessageId = ref('')
const collapsedTopicIds = ref(new Set())
const directTraceDisclosure = ref(new Map())
const tracePanelOpen = ref(false)
const selectedTraceAgentRunId = ref('')
const tracePanel = ref(null)
const tracePanelGroupId = ref('')
const tracePanelRunId = ref('')
const tracePanelDrawer = ref(typeof matchMedia === 'function' && matchMedia('(max-width: 1179px)').matches)
const messageNearBottom = ref(true)
const dismissedSystemMessageIds = ref(new Set())
const finishedDirectGroupIds = ref(new Set())
const runFinishedTurnStatuses = ref(new Map())
const messageScroller = ref(null)
const composerInput = ref(null)
const conversationTitleBlock = ref(null)
const inlineTitleInput = ref(null)
const inlineTitleButton = ref(null)
const settingsNameInput = ref(null)
const onboardingDialog = ref(null)
const modalDialog = ref(null)
const roundSettingsControl = ref(null)
const shortcutMenu = ref(null)
const collapsedGroupMenuButton = ref(null)
const collapsedGroupMenu = ref(null)
let toastTimer = null
let copyToastTimer = null
let onboardingPlaybackTimer = null
let emptyShowcaseTimer = null
const copiedMessageTimers = new Map()
const agentSkillCatalogRequests = new Map()
let skillLoadToken = 0
let agentSkillCatalogGeneration = 0
let agentSkillStatsToken = 0
let agentDetailSkillToken = 0
let attachmentImportSequence = 0
let providerStatusRequestSequence = 0
const providerStatusRequestTokens = new Map()
let unsubscribeWorkspace = null
let unsubscribeInstaller = null
let unsubscribeRunFinished = null
let unsubscribeRunEvent = null
let unsubscribeOpenGroup = null
let modalHistoryPushed = false
let modalFocusReturn = null
let tracePanelHistoryPushed = false
let tracePanelFocusReturn = null
let tracePanelFocusReturnAgentRunId = ''
let tracePanelMediaQuery = null
let tracePanelResizeHandler = null
let pendingRequestedGroupId = ''
const pendingRunFinishedEvents = new Map()

const api = computed(() => desktopApi())
const desktopPlatform = computed(() => api.value?.platform || installCatalog.value.platform || '')
const workspace = computed(() => api.value?.localWorkspace || null)
const installer = computed(() => api.value?.agentInstaller || null)
const customAgent = computed(() => api.value?.customAgent || null)
const provider = computed(() => api.value?.localAgentProvider || null)
const knowledgeBase = computed(() => api.value?.localKnowledgeBase || null)
const attachmentsApi = computed(() => api.value?.localAttachments || null)
const {
  attachmentPreviewUrl,
  forgetAttachmentPreviews,
  rememberAttachmentPreview,
  vAttachmentPreview,
} = useAttachmentPreviews({
  api: () => attachmentsApi.value,
  normalize: normalizeAttachment,
})

function initialTheme() {
  try {
    const saved = localStorage.getItem('roundrelay-theme')
    if (saved === 'light' || saved === 'dark') return saved
  } catch { /* noop */ }
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

const theme = ref(initialTheme())
const productMark = computed(() => publicAsset(
  theme.value === 'dark' ? 'logos/meldwork-mark-v3-dark.svg' : 'logos/meldwork-mark-v3.svg',
))
const productWordmark = computed(() => publicAsset(
  theme.value === 'dark' ? 'logos/meldwork-wordmark-v3-dark.svg' : 'logos/meldwork-wordmark-v3.svg',
))
const productAppIcon = computed(() => publicAsset('logos/meldwork-app.png'))
const onboardingSlides = computed(() => [
  {
    image: publicAsset('onboarding/discover-local-agents-meldwork.png'),
    title: t('onboarding.discoverTitle'),
    body: t('onboarding.discoverBody'),
  },
  {
    image: publicAsset('onboarding/provider-setup-v2.png'),
    title: t('onboarding.providerTitle'),
    body: t('onboarding.providerBody'),
  },
  {
    image: publicAsset('onboarding/agent-collaboration.png'),
    title: t('onboarding.collaborationTitle'),
    body: t('onboarding.collaborationBody'),
  },
  {
    image: publicAsset('onboarding/skills-and-images.png'),
    title: t('onboarding.toolsTitle'),
    body: t('onboarding.toolsBody'),
  },
  {
    image: publicAsset('onboarding/auto-discussion-v2.png'),
    title: t('onboarding.autoTitle'),
    body: t('onboarding.autoBody'),
  },
])
const onboardingSlide = computed(() => onboardingSlides.value[onboardingIndex.value] || onboardingSlides.value[0])
const onboardingLastIndex = computed(() => Math.max(0, onboardingSlides.value.length - 1))
const onboardingOnLastSlide = computed(() => onboardingIndex.value === onboardingLastIndex.value)
const onboardingReady = computed(() => !onboardingDetecting.value)
const onboardingLoadingLabel = computed(() => (
  onboardingDetecting.value ? t('onboarding.detecting') : t('onboarding.loading')
))

const directGroups = computed(() => snapshot.value.groups
  .filter(group => group.conversationType === 'direct')
  .sort(sortByUpdated))
const groupGroups = computed(() => snapshot.value.groups
  .filter(group => group.conversationType !== 'direct')
  .sort(sortByUpdated))
const visibleGroupGroups = computed(() => (
  groupSessionListExpanded.value || groupGroups.value.length <= GROUP_SESSION_PREVIEW_LIMIT
    ? groupGroups.value
    : groupGroups.value.slice(0, GROUP_SESSION_PREVIEW_LIMIT)
))
const hasMoreGroupGroups = computed(() => groupGroups.value.length > GROUP_SESSION_PREVIEW_LIMIT)
const remainingGroupGroupsCount = computed(() => Math.max(0, groupGroups.value.length - GROUP_SESSION_PREVIEW_LIMIT))
const activeGroup = computed(() => snapshot.value.groups.find(group => group.id === selectedGroupId.value) || null)
const sidebarDeleteGroup = computed(() => snapshot.value.groups.find(group => group.id === sidebarDeleteGroupId.value) || null)
const sidebarDeletePopoverStyle = computed(() => ({
  left: `${sidebarDeletePopoverPoint.value.left}px`,
  top: `${sidebarDeletePopoverPoint.value.top}px`,
}))
const collapsedGroupMenuStyle = computed(() => ({
  left: `${collapsedGroupMenuPoint.value.left}px`,
  bottom: `${collapsedGroupMenuPoint.value.bottom}px`,
}))
const activeGroupMemberSignature = computed(() => {
  const group = activeGroup.value
  return group ? [group.id, ...group.agentKinds].join('\u0000') : ''
})
const activeMessages = computed(() => snapshot.value.messages.filter(message => message.groupId === selectedGroupId.value))
const topLevelUserMessages = computed(() => activeMessages.value.filter(
  message => message.role === 'user' && !message.threadRootId,
))
const messageThreadRootIds = computed(() => {
  const roots = new Map()
  let latestRootId = ''
  const direct = activeGroup.value?.conversationType === 'direct'
  for (const message of activeMessages.value) {
    if (message.role === 'user' && !message.threadRootId) {
      latestRootId = message.id
      continue
    }
    if (message.threadRootId) {
      roots.set(message.id, message.threadRootId)
      continue
    }
    if (direct && latestRootId && (message.role === 'agent' || isAgentFailureMessage(message))) {
      roots.set(message.id, latestRootId)
    }
  }
  return roots
})
const topicReplyCounts = computed(() => {
  const counts = new Map()
  for (const message of activeMessages.value) {
    if (message.role !== 'agent') continue
    const rootId = messageThreadRootId(message)
    if (!rootId) continue
    counts.set(rootId, (counts.get(rootId) || 0) + 1)
  }
  return counts
})
const failedTopicIds = computed(() => new Set(activeMessages.value
  .filter(isAgentFailureMessage)
  .map(messageThreadRootId)
  .filter(Boolean)))
const messageTimeFormatter = computed(() => new Intl.DateTimeFormat(locale.value === 'zh' ? 'zh-CN' : 'en', {
  hour: '2-digit', minute: '2-digit',
}))
const navTimeFormatter = computed(() => new Intl.DateTimeFormat(locale.value === 'zh' ? 'zh-CN' : 'en', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
}))
const activeRun = computed(() => snapshot.value.runs.find(run => run.groupId === selectedGroupId.value) || null)
const activeRunAgentRuns = computed(() => (
  Array.isArray(activeRun.value?.agentRuns) ? activeRun.value.agentRuns : []
))
const activeRunHasAgentRuns = computed(() => activeRunAgentRuns.value.length > 0)
const activeRunProgress = computed(() => Array.isArray(activeRun.value?.progress) ? activeRun.value.progress.slice(0, 8) : [])
const liveOutputSignature = computed(() => activeRunAgentRuns.value.map(agent => (
  `${agent.agentRunId}:${String(agent.output || '').length}:${agent.events?.at(-1)?.seq || 0}`
)).join('\u0000'))
const directConclusionLiveStatus = computed(() => {
  if (activeGroup.value?.conversationType !== 'direct') return ''
  const agent = activeRunAgentRuns.value.at(-1)
  if (!agent?.output) return ''
  const status = ['completed', 'succeeded', 'failed', 'cancelled', 'stopped', 'partial', 'timeout', 'interrupted']
    .includes(String(agent.status || '').toLowerCase())
    ? agent.status
    : 'streaming'
  return [agentLabel(agent.kind), t('trace.conclusion'), runStatusLabel(status)].join(' / ')
})

function latestAgentRunForKind(kind) {
  return activeRunAgentRuns.value.filter(agent => agent.kind === kind).at(-1) || null
}

const runTargetKinds = computed(() => {
  if (!activeRun.value) return []
  const runTargets = Array.isArray(activeRun.value.targetKinds) ? activeRun.value.targetKinds : []
  const rootMessage = activeMessages.value.find(message => message.id === activeRun.value.threadRootId)
  const messageTargets = messageScopedTargetKinds(rootMessage, activeGroup.value)
  const targets = runTargets.length
    ? runTargets
    : activeRunAgentRuns.value.length
      ? activeRunAgentRuns.value.map(agent => agent.kind)
      : messageTargets
  return [...new Set(targets)]
})
const isCoordinatedRun = computed(() => (
  activeGroup.value?.conversationType !== 'direct' && runTargetKinds.value.length > 1
))
const activeRunAgentKind = computed(() => (
  activeRun.value?.currentKind
  || activeRunAgentRuns.value.at(-1)?.kind
  || runTargetKinds.value[0]
  || activeGroup.value?.directAgentKind
  || ''
))
const activeRunAgentStatus = computed(() => runAgentStatus(activeRunAgentKind.value))
const runCompletedKinds = computed(() => {
  const targets = new Set(runTargetKinds.value)
  const completed = activeRunAgentRuns.value
    .filter(agent => ['completed', 'succeeded'].includes(agent.status))
    .map(agent => agent.kind)
  return [...new Set([...(activeRun.value?.completedKinds || []), ...completed])].filter(kind => targets.has(kind))
})
const runFailedKinds = computed(() => {
  const targets = new Set(runTargetKinds.value)
  const failed = activeRunAgentRuns.value
    .filter(agent => ['failed', 'timeout'].includes(agent.status))
    .map(agent => agent.kind)
  return [...new Set([...(activeRun.value?.failedKinds || []), ...failed])].filter(kind => targets.has(kind))
})
const activeRunLabel = computed(() => {
  if (!activeRun.value || !activeGroup.value) return ''
  if (!isCoordinatedRun.value) {
    const agent = agentLabel(activeRunAgentKind.value)
    return activeRunAgentStatus.value === 'running'
      ? t('conversation.directWorking', { agent })
      : agent
  }
  return t('conversation.groupWorking')
})
const activeRunTopicRootId = computed(() => {
  if (activeRun.value?.threadRootId) return activeRun.value.threadRootId
  if (activeGroup.value?.conversationType !== 'direct') return ''
  return topLevelUserMessages.value.at(-1)?.id || ''
})
const runRoundProgress = computed(() => {
  const current = Number(activeRun.value?.currentRound)
  const max = Number(activeRun.value?.maxRounds)
  if (!Number.isInteger(current) || current < 1) return null
  if (activeRun.value?.unlimitedRounds === true) return { current, unlimited: true }
  if (!Number.isInteger(max) || max < current) return null
  return { current, max }
})

const provisionalMessages = computed(() => {
  const run = activeRun.value
  const group = activeGroup.value
  if (!run || !group || !activeRunAgentRuns.value.length) return []
  const durableAgentRunIds = new Set(activeMessages.value
    .map(message => message?.trace?.agentRunId)
    .filter(Boolean))
  const rootId = run.threadRootId || topLevelUserMessages.value.at(-1)?.id || ''
  return activeRunAgentRuns.value
    .filter(agent => !durableAgentRunIds.has(agent.agentRunId))
    .filter(agent => group.conversationType === 'direct' || agent.output || (agent.events || []).some(event => event.type !== 'answer_delta'))
    .map(agent => ({
      id: `run-message-${agent.agentRunId}`,
      groupId: group.id,
      role: 'agent',
      agentKind: agent.kind,
      content: agent.output || '',
      createdAt: agent.startedAt || Date.now(),
      threadRootId: rootId,
      provisional: true,
      traceRunId: run.runId,
      liveAgentRun: agent,
      sourceMessageIds: agent.sourceMessageIds || [],
    }))
})

const messagesWithLiveTrace = computed(() => {
  const run = activeRun.value
  if (!run) return activeMessages.value
  const liveByAgentRunId = new Map(activeRunAgentRuns.value.map(agent => [agent.agentRunId, agent]))
  return activeMessages.value.map((message) => {
    if (!run.runId || !message?.trace?.runId || message.trace.runId !== run.runId) return message
    const liveAgentRun = liveByAgentRunId.get(message.trace.agentRunId)
    return liveAgentRun
      ? { ...message, liveAgentRun, traceRunId: run.runId }
      : message
  })
})

function traceRound(item) {
  const directRound = Number(item?.round)
  if (Number.isInteger(directRound) && directRound >= 0) return directRound
  const evidence = item?.events?.find(event => /^E-R\d+-/i.test(String(event?.evidenceId || '')))?.evidenceId
  const match = String(evidence || '').match(/^E-R(\d+)-/i)
  return match ? Number(match[1]) : 0
}

function traceSourceItems(sourceIds) {
  const messagesById = new Map(activeMessages.value.map(message => [message.id, message]))
  return (Array.isArray(sourceIds) ? sourceIds : []).map((id) => {
    const message = messagesById.get(id)
    if (!message) return { id, available: false, label: t('trace.sourceUnavailable') }
    const sender = message.role === 'user'
      ? t('conversation.you')
      : message.agentKind ? agentLabel(message.agentKind) : t('conversation.system')
    const content = message.role === 'system' ? translateSystemMessage(message) : message.content
    const summary = String(content || '').trim().replace(/\s+/g, ' ').slice(0, 96)
      || t('conversation.attachmentTurn')
    return { id, available: true, label: `${sender}: ${summary}` }
  })
}

const allTracePanelItems = computed(() => {
  if (activeGroup.value?.conversationType === 'direct') return []
  const byRunAgentId = new Map()
  for (const agent of activeRunAgentRuns.value) {
    const runId = String(activeRun.value?.runId || '')
    if (!runId) continue
    byRunAgentId.set(`${runId}\u0000${agent.agentRunId}`, {
      runId,
      agentRunId: agent.agentRunId,
      agentKind: agent.kind,
      round: agent.round,
      status: agent.status,
      output: agent.output || '',
      summary: '',
      events: agent.events || [],
      sourceMessageIds: agent.sourceMessageIds || [],
      sources: traceSourceItems(agent.sourceMessageIds),
      truncated: agent.truncated === true,
      context: {},
      threadRootId: activeRun.value?.threadRootId || '',
      createdAt: agent.startedAt,
      startedAt: agent.startedAt,
      live: true,
    })
  }
  for (const message of activeMessages.value) {
    const trace = message?.trace
    if (!['agent', 'system'].includes(message.role) || !message.agentKind || !trace?.runId || !trace?.agentRunId) continue
    const key = `${trace.runId}\u0000${trace.agentRunId}`
    if (message.role === 'system' && byRunAgentId.has(key)) continue
    const durable = {
      runId: trace.runId,
      agentRunId: trace.agentRunId,
      agentKind: message.agentKind,
      round: traceRound(trace),
      status: trace.status,
      output: message.role === 'agent' ? message.content || '' : '',
      summary: trace.summary || '',
      events: trace.events || [],
      sourceMessageIds: trace.sourceMessageIds || [],
      sources: traceSourceItems(trace.sourceMessageIds),
      truncated: trace.truncated === true,
      context: trace.context || {},
      messageId: message.id,
      threadRootId: messageThreadRootId(message),
      createdAt: message.createdAt,
      live: false,
    }
    const live = byRunAgentId.get(key)
    byRunAgentId.set(key, live ? {
      ...durable,
      round: live.round || durable.round,
      status: live.status || durable.status,
      output: durable.output || live.output,
      events: live.events?.length ? live.events : durable.events,
      sourceMessageIds: live.sourceMessageIds?.length
        ? live.sourceMessageIds
        : durable.sourceMessageIds,
      sources: live.sources?.length ? live.sources : durable.sources,
      truncated: live.truncated || durable.truncated,
      threadRootId: live.threadRootId || durable.threadRootId,
      createdAt: live.createdAt || durable.createdAt,
      startedAt: live.startedAt || durable.startedAt,
      live: true,
    } : durable)
  }
  return [...byRunAgentId.values()].sort((left, right) => (
    (Number(left.round) || 0) - (Number(right.round) || 0)
  ))
})
const tracePanelItems = computed(() => (
  tracePanelRunId.value
    ? allTracePanelItems.value.filter(item => item.runId === tracePanelRunId.value)
    : []
))

function retainedTraceEvents(events) {
  return (Array.isArray(events) ? events : []).filter((event) => {
    const type = String(event?.type || '').toLowerCase()
    const title = String(event?.title || '').trim().toLowerCase()
    return type !== 'answer_delta' && !(type === 'status' && ['agent', 'process'].includes(title))
  })
}

const historicalGroupRun = computed(() => {
  const group = activeGroup.value
  if (!group || group.conversationType === 'direct' || activeRun.value) return null
  const rootOrder = new Map(topLevelUserMessages.value.map((message, index) => [message.id, index]))
  const runs = new Map()
  for (const item of allTracePanelItems.value) {
    if (!item.runId || !item.threadRootId) continue
    const current = runs.get(item.runId) || {
      runId: item.runId,
      threadRootId: item.threadRootId,
      agentRuns: [],
      rootIndex: rootOrder.get(item.threadRootId) ?? -1,
      createdAt: 0,
    }
    current.agentRuns.push(item)
    current.createdAt = Math.max(current.createdAt, Date.parse(item.createdAt || item.startedAt || '') || 0)
    runs.set(item.runId, current)
  }
  const latest = [...runs.values()].sort((left, right) => (
    left.rootIndex - right.rootIndex || left.createdAt - right.createdAt
  )).at(-1)
  if (!latest || latest.threadRootId !== topLevelUserMessages.value.at(-1)?.id) return null

  const topicMessages = activeMessages.value.filter(message => (
    message.id === latest.threadRootId || messageThreadRootId(message) === latest.threadRootId
  ))
  const rootMessage = topicMessages.find(message => message.id === latest.threadRootId)
  const scopedTargets = messageScopedTargetKinds(rootMessage, group)
  const systemKeys = new Set(topicMessages.map(message => message?.system?.key).filter(Boolean))
  const traceKinds = [...new Set(latest.agentRuns.map(item => item.agentKind).filter(Boolean))]
  const targetKinds = scopedTargets.length
    ? scopedTargets
    : systemKeys.has('system.autoTimeout') || systemKeys.has('system.autoRoundLimit')
      ? [...group.agentKinds]
      : traceKinds
  const latestByKind = new Map()
  for (const item of latest.agentRuns) {
    const previous = latestByKind.get(item.agentKind)
    if (!previous || traceRound(item) >= traceRound(previous)) latestByKind.set(item.agentKind, item)
  }
  const agentRuns = targetKinds.map(kind => latestByKind.get(kind)).filter(Boolean)
  const statuses = agentRuns.map(item => runStatusTone(item.status))
  let status = 'completed'
  if (systemKeys.has('system.autoTimeout')) status = 'timeout'
  else if (systemKeys.has('system.autoRoundLimit')) status = 'round-limit'
  else if (systemKeys.has('system.autoStopped')) status = 'stopped'
  else if (statuses.length && statuses.every(value => value === 'failed')) status = 'failed'
  else if (statuses.includes('failed') || statuses.includes('partial')) status = 'partial'
  return {
    ...latest,
    targetKinds,
    agentRuns,
    status,
    eventCount: latest.agentRuns.reduce(
      (count, item) => count + retainedTraceEvents(item.events).length,
      0,
    ),
  }
})

const displayedRun = computed(() => activeRun.value || historicalGroupRun.value)
const displayedRunAgentRuns = computed(() => (
  activeRun.value ? activeRunAgentRuns.value : historicalGroupRun.value?.agentRuns || []
))
const displayedRunTargetKinds = computed(() => (
  activeRun.value ? runTargetKinds.value : historicalGroupRun.value?.targetKinds || []
))
const isDisplayedCoordinatedRun = computed(() => (
  activeGroup.value?.conversationType !== 'direct' && displayedRunTargetKinds.value.length > 1
))
const displayedRunAgentKind = computed(() => (
  activeRun.value?.currentKind
  || displayedRunAgentRuns.value.at(-1)?.agentKind
  || displayedRunAgentRuns.value.at(-1)?.kind
  || displayedRunTargetKinds.value[0]
  || activeGroup.value?.directAgentKind
  || ''
))
const displayedRunAgentStatus = computed(() => displayedRunAgentStatusForKind(displayedRunAgentKind.value))
const displayedRunTopicRootId = computed(() => (
  activeRunTopicRootId.value || historicalGroupRun.value?.threadRootId || ''
))
const displayedRunLabel = computed(() => {
  if (!displayedRun.value || !activeGroup.value) return ''
  if (!activeRun.value) return t('conversation.groupRunHistory')
  return activeRunLabel.value
})

const traceDrawerBlocking = computed(() => tracePanelOpen.value && tracePanelDrawer.value)
const contentInteractionBlocked = computed(() => blockingOverlayOpen.value || traceDrawerBlocking.value)
const turnRailItems = computed(() => topLevelUserMessages.value.map((message) => {
  const replyCount = topicReplyCount(message.id)
  const finishedStatus = runFinishedTurnStatus(message.id)
  return {
    id: message.id,
    query: String(message.content || '').trim().replace(/\s+/g, ' ').slice(0, 56) || t('conversation.attachmentTurn'),
    time: formatTime(message.createdAt),
    replyCount,
    status: activeRunTopicRootId.value === message.id
      ? 'running'
      : finishedStatus || (replyCount > 0
        ? 'completed'
        : failedTopicIds.value.has(message.id) ? 'failed' : 'pending'),
  }
}))
const activeTurnRailId = computed(() => (
  activeRunTopicRootId.value || activeTurnId.value || turnRailItems.value.at(-1)?.id || ''
))
const activeRunTopicSignature = computed(() => {
  if (!activeRunTopicRootId.value) return ''
  return `${activeRun.value?.groupId || ''}\u0000${activeRunTopicRootId.value}`
})
const timelineMessages = computed(() => [...messagesWithLiveTrace.value, ...provisionalMessages.value].filter((message) => {
  if (dismissedSystemMessageIds.value.has(message.id)) return false
  const rootId = messageThreadRootId(message)
  return !rootId || isTopicExpanded(rootId)
}))
const conversationEmptyVisible = computed(() => (
  activeView.value === 'conversation'
  && Boolean(activeGroup.value)
  && !timelineMessages.value.length
  && !activeRun.value
))
const addressedAgentKinds = computed(() => {
  const group = activeGroup.value
  if (!group || group.conversationType === 'direct') return []
  const natural = parseAgentRoutingPrefix(draft.value, mergedCatalog.value, group.agentKinds).targetKinds
  const addressed = new Set([...selectedAgentKinds.value, ...natural])
  return group.agentKinds.filter(kind => addressed.has(kind))
})
const composerTargetKinds = computed(() => {
  const group = activeGroup.value
  if (!group) return []
  if (group.conversationType !== 'direct' && addressedAgentKinds.value.length) {
    return [...addressedAgentKinds.value]
  }
  if (group.conversationType === 'direct' || discussionMode.value === 'auto') return [...group.agentKinds]
  return [...targetKinds.value]
})
const composerMode = computed(() => {
  if (activeGroup.value?.conversationType === 'direct') return 'manual'
  return addressedAgentKinds.value.length === 1 ? 'manual' : discussionMode.value
})
const sendButtonLabel = computed(() => t(composerMode.value === 'auto' ? 'composer.startAuto' : 'composer.send'))
const skillTargetSignature = computed(() => composerTargetKinds.value.join('\u0000'))
const currentSkillTrigger = computed(() => parseSkillTrigger(draft.value))
const skillMenuTargetKinds = computed(() => {
  const group = activeGroup.value
  if (!group) return []
  if (group.conversationType === 'direct') return [...group.agentKinds]
  if (activeMentionAgentKind.value && selectedAgentKinds.value.includes(activeMentionAgentKind.value)) {
    return [activeMentionAgentKind.value]
  }
  return []
})
const knowledgeBaseSelectionTargetKinds = computed(() => {
  const group = activeGroup.value
  if (!group) return []
  return group.conversationType === 'direct'
    ? [...group.agentKinds]
    : addressedAgentKinds.value.length
      ? [...addressedAgentKinds.value]
      : [...group.agentKinds]
})
const filteredAgentMentionOptions = computed(() => {
  const group = activeGroup.value
  if (!group || group.conversationType === 'direct' || !currentSkillTrigger.value) return []
  const query = currentSkillTrigger.value.query.toLocaleLowerCase()
  const selected = new Set(selectedAgentKinds.value)
  return group.agentKinds
    .filter(kind => !selected.has(kind))
    .filter((kind) => {
      if (!query) return true
      return [kind, agentLabel(kind)]
        .some(value => String(value || '').toLocaleLowerCase().includes(query))
    })
    .slice(0, 8)
})
const filteredSkillOptions = computed(() => {
  const query = currentSkillTrigger.value?.query.toLocaleLowerCase() || ''
  const selected = new Set(selectedSkills.value.map(skillKey))
  return skillOptions.value
    .filter(skill => !selected.has(skillKey(skill)))
    .filter((skill) => {
      if (!query) return true
      return [skill.name, skill.slug, skill.namespace, agentLabel(skill.targetKind)]
        .some(value => String(value || '').toLocaleLowerCase().includes(query))
    })
    .slice(0, 8)
})
const filteredKnowledgeBaseOptions = computed(() => {
  if (!knowledgeBaseSelectionTargetKinds.value.length) return []
  const query = currentSkillTrigger.value?.query.toLocaleLowerCase() || ''
  const targets = knowledgeBaseSelectionTargetKinds.value
  const selected = new Map(selectedKnowledgeBases.value.map(source => [source.kind, source]))
  return localKnowledgeBaseEntries.value
    .filter(knowledgeBaseReady)
    .filter((source) => {
      const existingTargets = new Set(selected.get(source.kind)?.targetKinds || [])
      return targets.some(kind => !existingTargets.has(kind))
    })
    .filter((source) => {
      if (!query) return true
      return [source.kind, knowledgeBaseName(source.kind), t(`composer.knowledgeBaseDescription.${source.kind}`)]
        .some(value => String(value || '').toLocaleLowerCase().includes(query))
    })
    .slice(0, MAX_KNOWLEDGE_BASES)
})
const composerMenuGroups = computed(() => [
  {
    type: 'knowledge-base',
    label: t('composer.mentionSection.knowledge-base'),
    options: filteredKnowledgeBaseOptions.value.map(source => ({ type: 'knowledge-base', value: source })),
  },
  {
    type: 'skill',
    label: t('composer.mentionSection.skill'),
    options: filteredSkillOptions.value.map(skill => ({ type: 'skill', value: skill })),
  },
  {
    type: 'agent',
    label: t('composer.mentionSection.agent'),
    options: filteredAgentMentionOptions.value.map(kind => ({ type: 'agent', value: kind })),
  },
].filter(group => group.options.length))
const composerMenuOptions = computed(() => composerMenuGroups.value.flatMap(group => group.options))
const activeSkillOptionId = computed(() => (
  skillMenuOpen.value && composerMenuOptions.value[skillActiveIndex.value]
    ? `composer-mention-option-${skillActiveIndex.value}`
    : ''
))
const importingAttachment = computed(() => attachmentImportOperations.value
  .some(operation => operation.contextVersion === composerContextVersion.value))
const blockingOverlayOpen = computed(() => Boolean(modal.value || onboardingVisible.value))

const mergedCatalog = computed(() => [
  ...AGENTS,
  ...(installCatalog.value.agents || [])
    .filter(agent => agent?.custom === true)
    .map(agent => ({
      kind: agent.kind,
      label: agent.label,
      logo: agentLogo(agent.kind, theme.value),
      providerMode: 'custom',
      imageLimit: MAX_ATTACHMENTS,
      attachmentTypes: ['image', 'audio', 'video'],
      custom: true,
      description: agent.description || '',
      commandName: agent.commandName || '',
      promptMode: agent.promptMode || 'stdin',
    })),
].map((profile) => {
  const installedProfile = installCatalog.value.agents?.find(agent => agent.kind === profile.kind) || {}
  const detected = snapshot.value.agents.find(agent => agent.kind === profile.kind) || {}
  return {
    ...profile,
    ...installedProfile,
    ...detected,
    label: profile.label,
    logo: agentLogo(profile.kind, theme.value),
    providerMode: profile.providerMode,
    imageLimit: profile.custom
      ? MAX_ATTACHMENTS
      : Number(detected.imageAttachmentLimit ?? installedProfile.imageAttachmentLimit ?? profile.imageLimit) || 0,
    installed: Boolean(installedProfile.installed || detected.installed),
    ready: detected.available === true,
  }
}))
const agentCatalogGroups = computed(() => [
  {
    id: 'official',
    titleKey: 'systemSettings.officialAgents',
    subtitleKey: 'systemSettings.officialAgentsHint',
    agents: mergedCatalog.value.filter(agent => !agent.custom),
  },
  {
    id: 'custom',
    titleKey: 'systemSettings.customAgents',
    subtitleKey: 'systemSettings.customAgentsHint',
    agents: mergedCatalog.value.filter(agent => agent.custom),
  },
])
const readyAgents = computed(() => mergedCatalog.value.filter(agent => agent.ready))
const readyAgentSignature = computed(() => readyAgents.value.map(agent => agent.kind).join('\u0000'))
const sidebarAgents = computed(() => mergedCatalog.value.filter((agent) => {
  if (agent.ready) return agent.showInSidebar !== false
  return directGroupsFor(agent.kind).length > 0
}))
const activeDirectAgent = computed(() => {
  if (activeGroup.value?.conversationType !== 'direct') return null
  return mergedCatalog.value.find(agent => agent.kind === activeGroup.value.directAgentKind) || null
})
const readyAgentKinds = computed(() => new Set(readyAgents.value.map(agent => agent.kind)))
const composerTargetsReady = computed(() => (
  composerTargetKinds.value.length > 0
  && composerTargetKinds.value.every(kind => readyAgentKinds.value.has(kind))
))
const composerImageLimit = computed(() => {
  const targets = composerTargetKinds.value
  if (!targets.length) return 0
  const limits = targets.map((kind) => {
    const agent = mergedCatalog.value.find(item => item.kind === kind)
    return Math.max(0, Math.floor(Number(agent?.imageLimit) || 0))
  })
  return Math.min(MAX_ATTACHMENTS, ...limits)
})
function attachmentLimitFor(type) {
  const normalizedType = String(type || '')
  if (!ATTACHMENT_TYPES.has(normalizedType)) return 0
  const targets = composerTargetKinds.value
  if (!targets.length) return 0
  const limits = targets.map((kind) => {
    const agent = mergedCatalog.value.find(item => item.kind === kind)
    if (Array.isArray(agent?.attachmentTypes) && agent.attachmentTypes.includes(normalizedType)) {
      return MAX_ATTACHMENTS
    }
    return normalizedType === 'image'
      ? Math.max(0, Math.floor(Number(agent?.imageLimit) || 0))
      : 0
  })
  return Math.min(MAX_ATTACHMENTS, ...limits)
}
const composerAttachmentLimit = computed(() => Math.max(
  ...[...ATTACHMENT_TYPES].map(type => attachmentLimitFor(type)),
))
const composerAttachmentSupported = computed(() => composerAttachments.value.every((attachment) => {
  const type = attachmentKind(attachment)
  if (!ATTACHMENT_TYPES.has(type)) return false
  return composerAttachments.value.filter(item => attachmentKind(item) === type).length <= attachmentLimitFor(type)
}))
const attachmentActionLabel = computed(() => {
  if (!composerTargetKinds.value.length) return t('composer.selectTarget')
  if (!composerTargetsReady.value) return t('error.agentUnavailable')
  return composerAttachmentLimit.value > 0 ? t('composer.attachMedia') : t('composer.attachmentsUnsupported')
})
const canSendMessage = computed(() => (
  composerTargetsReady.value
  && (composerMode.value !== 'auto' || composerTargetKinds.value.length >= 2)
  && !importingAttachment.value
  && composerAttachmentSupported.value
  && Boolean(draft.value.trim() || composerAttachments.value.length)
))
const readyCount = computed(() => readyAgents.value.length)
const installedCount = computed(() => mergedCatalog.value.filter(agent => agent.installed).length)
const configurableProviderAgents = computed(() => mergedCatalog.value.filter(agent => (
  EXTERNAL_PROVIDER_KINDS.has(agent.kind)
)))
const providerConfiguredCount = computed(() => configurableProviderAgents.value.filter(agent => providerReady(agent.kind)).length)
const recentGroups = computed(() => snapshot.value.groups.slice().sort(sortByUpdated).slice(0, 6))
const homeAgentPreview = computed(() => readyAgents.value.slice(0, 5))
const homeMode = computed(() => {
  if (snapshot.value.groups.length) return 'workspace'
  return readyCount.value > 0 ? 'first-task' : 'setup'
})
const homeNeedsAttention = computed(() => readyCount.value === 0)
const selectedAgentDetailKind = ref('')
const agentDetailSkillItems = ref([])
const agentDetailSkillsLoading = ref(false)
const selectedAgentDetail = computed(() => mergedCatalog.value.find(agent => agent.kind === selectedAgentDetailKind.value) || null)
const agentDetailSkillSummary = computed(() => {
  if (selectedAgentDetail.value?.custom) return t('customAgent.skillsUnsupported')
  if (agentDetailSkillsLoading.value) return t('agent.skillsLoading')
  if (!agentDetailSkillItems.value.length) return t('agent.skillsUnavailable')
  return t('agent.localSkills', { count: agentDetailSkillItems.value.length })
})
const showSetupGuide = computed(() => (
  onboardingCompleted.value
  && homeMode.value === 'setup'
))
const showRecoveryGuide = computed(() => (
  onboardingCompleted.value
  && homeMode.value === 'workspace'
  && homeNeedsAttention.value
))
const homeWorkspaceSummary = computed(() => (
  homeNeedsAttention.value
    ? t('home.setupNeeded')
    : t('home.workspaceSummary', {
        agents: readyCount.value,
        conversations: snapshot.value.groups.length,
      })
))
const setupGuideMessage = computed(() => {
  if (!installedCount.value) return t('setupGuide.detectBody')
  if (configurableProviderAgents.value.length && !providerConfiguredCount.value) return t('setupGuide.providerBody')
  return t('setupGuide.detectBody')
})
const selectedProviderAgent = computed(() => configurableProviderAgents.value.find(
  agent => agent.kind === selectedProviderKind.value,
) || configurableProviderAgents.value[0] || null)
const providerStatus = computed(() => providerStatusFor(selectedProviderKind.value))
const selectedProviderProfile = computed(() => providerProfile(selectedProviderKind.value))
const selectedProviderPresets = computed(() => selectedProviderProfile.value.presets || [])
const selectedProviderPreset = computed(() => (
  selectedProviderPresets.value.find(preset => preset.id === providerForm.preset)
  || selectedProviderPresets.value[0]
  || null
))
const selectedProviderAgentState = computed(() => providerAgentState(selectedProviderKind.value))
const providerActiveSource = computed(() => providerActiveSourceFor(selectedProviderKind.value))
const selectedProviderProfileStatus = computed(() => (
  providerProfilesFor(selectedProviderKind.value)[providerForm.preset] || null
))
const selectedProviderProfileSaved = computed(() => Boolean(selectedProviderProfileStatus.value?.configured))
const selectedProviderPresetActive = computed(() => providerActiveSource.value === providerForm.preset)
const selectedProviderPresetConfigured = computed(() => providerPresetConfigured(providerForm.preset))
const providerNativeOfficialMode = computed(() => (
  providerForm.preset === 'official'
  && !selectedProviderProfileSaved.value
  && (
    nativeProviderReady(selectedProviderAgent.value)
    || !String(selectedProviderPreset.value?.baseUrl || '').trim()
  )
))
const providerIdentityLocked = computed(() => providerForm.preset !== 'custom')
const providerFormControlsDisabled = computed(() => (
  saving.value
  || providerStatus.value.error
  || (providerStatusIsChecking(selectedProviderKind.value) && !hasProviderStatus(selectedProviderKind.value))
))
const providerSaveActionLabel = computed(() => {
  if (saving.value) return t('common.saving')
  if (!selectedProviderProfileSaved.value) return t('provider.saveAndUse')
  return selectedProviderPresetActive.value
    ? t('provider.updateCredentials')
    : t('provider.updateAndUse')
})
const providerNativeGuideBody = computed(() => {
  const state = selectedProviderAgentState.value
  const agent = selectedProviderAgent.value
  if (state.id === 'checking') return t('provider.nativeStatusCheckingBody')
  if (state.id === 'unavailable') return t('provider.nativeStatusErrorBody')
  if (nativeProviderReady(agent)) {
    return selectedProviderPresetActive.value
      ? t('provider.nativeBody')
      : t('provider.nativeAvailableBody')
  }
  return state.detail
})
const providerNativeActionVisible = computed(() => (
  providerNativeOfficialMode.value
  && ['not-installed', 'login-required', 'unverified'].includes(selectedProviderAgentState.value.id)
))
const roundProgressPercent = computed(() => {
  const bounded = Math.max(1, Math.min(10, Number(maxRounds.value) || 1))
  return `${((bounded - 1) / 9) * 100}%`
})

const groupForm = reactive({ name: '', topic: '', agentKinds: [], workdir: '', allowWrite: true })
const settingsForm = reactive({ name: '', topic: '', agentKinds: [], workdir: '', allowWrite: false })
const customAgentForm = reactive({ label: '', description: '', argumentsText: '', promptMode: 'stdin' })
const providerForm = reactive({ preset: 'official', provider: '', baseUrl: '', model: '', apiKey: '' })

const modalTitle = computed(() => ({
  'new-group': t('group.newTitle'),
  settings: settingsIntent.value === 'rename'
    ? t(activeGroup.value?.conversationType === 'direct' ? 'settings.renameDirectTitle' : 'settings.renameGroupTitle')
    : t('settings.title'),
  'custom-agent': t('customAgent.title'),
  'unlimited-confirm': t('composer.unlimitedConfirmTitle'),
  'agent-detail': selectedAgentDetail.value?.label || t('systemSettings.openAgentDetailDefault'),
})[modal.value] || '')
const modalSubtitle = computed(() => ({
  settings: groupName(activeGroup.value),
  'custom-agent': t('customAgent.subtitle'),
  'agent-detail': agentDetailSkillSummary.value,
})[modal.value] || '')

const installerBusy = computed(() => !['', 'idle', 'completed', 'cancelled', 'failed'].includes(installerState.value.phase))
const installerPhaseLabel = computed(() => t(`installer.phase.${installerState.value.phase}`))

function sortByUpdated(a, b) {
  return (Date.parse(b.updatedAt || b.createdAt || '') || 0) - (Date.parse(a.updatedAt || a.createdAt || '') || 0)
}

function groupName(group) {
  return group?.name || t('group.defaultName')
}

function groupAgentSummary(group) {
  return (group?.agentKinds || []).map(kind => agentLabel(kind)).filter(Boolean).join(', ')
}

function directGroupsFor(kind) {
  return directGroups.value.filter(group => group.directAgentKind === kind)
}

function visibleDirectGroupsFor(kind) {
  const groups = directGroupsFor(kind)
  if (groups.length <= DIRECT_SESSION_PREVIEW_LIMIT || isDirectSessionListExpanded(kind)) {
    return groups
  }
  return groups.slice(0, DIRECT_SESSION_PREVIEW_LIMIT)
}

function hasMoreDirectGroups(kind) {
  return directGroupsFor(kind).length > DIRECT_SESSION_PREVIEW_LIMIT
}

function remainingDirectGroupsCount(kind) {
  return Math.max(0, directGroupsFor(kind).length - DIRECT_SESSION_PREVIEW_LIMIT)
}

function isDirectCreationPending(kind) {
  return directCreationKinds.value.has(kind)
}

function setDirectCreationPending(kind, pending) {
  const next = new Set(directCreationKinds.value)
  if (pending) next.add(kind)
  else next.delete(kind)
  directCreationKinds.value = next
}

function sidebarAgentSessionListId(kind) {
  return `sidebar-agent-sessions-${String(kind || '')}`
}

function isSidebarAgentExpanded(kind) {
  return !collapsedSidebarAgentKinds.value.has(String(kind || ''))
}

function setSidebarAgentExpanded(kind, expanded) {
  const normalized = String(kind || '')
  if (!normalized) return
  const next = new Set(collapsedSidebarAgentKinds.value)
  if (expanded) next.delete(normalized)
  else next.add(normalized)
  collapsedSidebarAgentKinds.value = next
}

function toggleSidebarAgentExpanded(kind) {
  setSidebarAgentExpanded(kind, !isSidebarAgentExpanded(kind))
}

function isDirectSessionListExpanded(kind) {
  return expandedSidebarAgentSessionKinds.value.has(String(kind || ''))
}

function setDirectSessionListExpanded(kind, expanded) {
  const normalized = String(kind || '')
  if (!normalized) return
  const next = new Set(expandedSidebarAgentSessionKinds.value)
  if (expanded) next.add(normalized)
  else next.delete(normalized)
  expandedSidebarAgentSessionKinds.value = next
}

function toggleDirectSessionListExpanded(kind) {
  setDirectSessionListExpanded(kind, !isDirectSessionListExpanded(kind))
}

function toggleGroupSessionListExpanded() {
  groupSessionListExpanded.value = !groupSessionListExpanded.value
}

function updateCollapsedGroupMenuPosition() {
  const rect = collapsedGroupMenuButton.value?.getBoundingClientRect()
  if (!rect) return
  collapsedGroupMenuPoint.value = {
    left: Math.max(12, Math.min(rect.right + 8, window.innerWidth - 312)),
    bottom: Math.max(12, window.innerHeight - rect.bottom),
  }
}

function closeCollapsedGroupMenu({ restoreFocus = false } = {}) {
  if (!collapsedGroupMenuOpen.value) return
  collapsedGroupMenuOpen.value = false
  if (restoreFocus) void nextTick(() => collapsedGroupMenuButton.value?.focus())
}

async function toggleCollapsedGroupMenu() {
  if (collapsedGroupMenuOpen.value) {
    closeCollapsedGroupMenu({ restoreFocus: true })
    return
  }
  shortcutMenuOpen.value = false
  updateCollapsedGroupMenuPosition()
  collapsedGroupMenuOpen.value = true
  await nextTick()
  const activeOption = collapsedGroupMenu.value?.querySelector('[aria-current="page"]')
  const firstOption = collapsedGroupMenu.value?.querySelector('.collapsed-group-option')
  const focusTarget = activeOption || firstOption
  focusTarget?.focus()
}

function handleSidebarAgentMain(agent) {
  if (!agent || isDirectCreationPending(agent.kind)) return
  if (sidebarCollapsed.value) {
    void openDirect(agent)
    return
  }
  if (directGroupsFor(agent.kind).length) {
    toggleSidebarAgentExpanded(agent.kind)
    return
  }
  void openDirect(agent)
}

function formatNavTime(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return navTimeFormatter.value.format(date)
}

function recentGroupMeta(group) {
  const count = Array.isArray(group?.agentKinds) ? group.agentKinds.length : 0
  const kindLabel = group?.conversationType === 'direct'
    ? t('conversation.direct')
    : t('conversation.members', { count })
  const time = formatNavTime(group?.updatedAt || group?.createdAt)
  return time ? `${kindLabel} / ${time}` : kindLabel
}

function providerModeShortLabel(mode) {
  return t(`agent.providerShort.${mode}`)
}

function agentDescription(kind) {
  const profile = mergedCatalog.value.find(agent => agent.kind === kind)
  if (profile?.custom && profile.description) return profile.description
  if (profile?.custom) return t('customAgent.defaultDescription')
  return t(`agent.description.${kind}`)
}

function agentSoul(agent) {
  if (agent?.custom) return agent.description || t('customAgent.detailBody')
  return t(`agent.soul.${agent?.kind}`)
}

function providerStatusFor(kind) {
  return providerStatuses.value[kind] || EMPTY_PROVIDER_STATUS
}

function providerProfilesFor(kind) {
  const status = providerStatusFor(kind)
  if (status.profiles && typeof status.profiles === 'object' && !Array.isArray(status.profiles)) {
    return status.profiles
  }
  if (!status.configured) return {}
  const preset = status.activePreset || inferProviderPreset(kind, status)
  return {
    [preset]: {
      provider: status.provider,
      baseUrl: status.baseUrl,
      model: status.model,
      configured: true,
    },
  }
}

function hasProviderStatus(kind) {
  return Object.prototype.hasOwnProperty.call(providerStatuses.value, String(kind || ''))
}

function setProviderStatusPending(kind, pending) {
  const targetKind = String(kind || '')
  const next = new Set(providerStatusLoadingKinds.value)
  if (pending) next.add(targetKind)
  else next.delete(targetKind)
  providerStatusLoadingKinds.value = next
}

function providerStatusIsChecking(kind) {
  const targetKind = String(kind || '')
  return providerStatusLoadingKinds.value.has(targetKind) || !hasProviderStatus(targetKind)
}

function nativeProviderReady(agent) {
  return Boolean(agent?.ready && NATIVE_PROVIDER_READY_SOURCES.has(String(agent.availabilitySource || '')))
}

function activeSavedProviderPreset(kind) {
  const status = providerStatusFor(kind)
  if (!hasProviderStatus(kind) || status.error || !status.configured) return ''
  const preset = status.activePreset || inferProviderPreset(kind, status)
  return providerProfilesFor(kind)[preset]?.configured ? preset : ''
}

function providerActiveSourceFor(kind) {
  const agent = configurableProviderAgents.value.find(item => item.kind === kind)
  if (!agent?.installed || !hasProviderStatus(kind) || providerStatusFor(kind).error) return ''
  const savedPreset = activeSavedProviderPreset(kind)
  if (savedPreset) return savedPreset
  return nativeProviderReady(agent) ? 'official' : ''
}

function providerAgentState(kind) {
  const agent = configurableProviderAgents.value.find(item => item.kind === kind)
  const agentName = agent?.label || String(kind || '')
  if (!agent?.installed) {
    return {
      id: 'not-installed',
      label: t('provider.state.notInstalled'),
      detail: t('provider.state.notInstalledBody', { agent: agentName }),
      tone: 'warning',
      icon: DownloadOutline,
    }
  }
  if (providerStatusIsChecking(kind) && !hasProviderStatus(kind)) {
    return {
      id: 'checking',
      label: t('provider.checking'),
      detail: t('provider.state.checkingBody', { agent: agentName }),
      tone: 'checking',
      icon: RefreshOutline,
    }
  }
  if (providerStatusFor(kind).error) {
    return {
      id: 'unavailable',
      label: t('provider.unavailable'),
      detail: t('provider.state.unavailableBody', { agent: agentName }),
      tone: 'warning',
      icon: WarningOutline,
    }
  }
  const savedPreset = activeSavedProviderPreset(kind)
  if (savedPreset) {
    const source = providerPresetLabel(savedPreset)
    return {
      id: 'active-override',
      label: t('provider.state.overrideActive', { provider: source }),
      detail: t('provider.state.overrideActiveBody', { agent: agentName, provider: source }),
      tone: 'connected',
      icon: CheckmarkCircleOutline,
    }
  }
  if (nativeProviderReady(agent)) {
    return {
      id: 'native-ready',
      label: t('provider.nativeReady'),
      detail: t('provider.state.nativeReadyBody', { agent: agentName }),
      tone: 'connected',
      icon: CheckmarkCircleOutline,
    }
  }
  if (agent.credentialState === 'missing') {
    return {
      id: 'login-required',
      label: t('provider.state.loginRequired'),
      detail: t('provider.state.loginRequiredBody', { agent: agentName }),
      tone: 'warning',
      icon: WarningOutline,
    }
  }
  return {
    id: 'unverified',
    label: t('provider.state.unverified'),
    detail: t('provider.state.unverifiedBody', { agent: agentName }),
    tone: 'neutral',
    icon: WarningOutline,
  }
}

function providerReady(kind) {
  return ['active-override', 'native-ready'].includes(providerAgentState(kind).id)
}

function providerStatusLabel(kind) {
  return providerAgentState(kind).label
}

function providerStatusTone(kind) {
  return providerAgentState(kind).tone
}

function providerStatusIcon(kind) {
  return providerAgentState(kind).icon
}

function providerSummaryLabel(agent) {
  if (!agent) return ''
  if (agent.custom) return t('customAgent.cliManaged')
  if (supportsExternalProvider(agent)) {
    const status = providerStatusFor(agent.kind)
    if (!hasProviderStatus(agent.kind)) return t('provider.checking')
    if (status.error) return t('provider.unavailable')
    if (status.configured) return t('provider.configured')
    if (nativeProviderReady(agent)) return t('provider.nativeReady')
    return t('provider.notConfigured')
  }
  if (agent.ready) return t('provider.nativeConnected')
  return providerModeLabel(agent.providerMode)
}

function providerPresetLabel(id) {
  return t(`provider.preset.${id}`)
}

function providerPresetHint(id) {
  return t(`provider.presetHint.${id}`)
}

function providerPresetSaved(presetId) {
  return Boolean(providerProfilesFor(selectedProviderKind.value)[presetId]?.configured)
}

function providerPresetConfigured(presetId) {
  if (providerPresetSaved(presetId)) return true
  return presetId === 'official'
    && hasProviderStatus(selectedProviderKind.value)
    && !providerStatus.value.error
    && nativeProviderReady(selectedProviderAgent.value)
}

function providerPresetActive(presetId) {
  return providerActiveSource.value === presetId
}

function providerPresetStateLabel(presetId) {
  if (providerStatusIsChecking(selectedProviderKind.value) && !hasProviderStatus(selectedProviderKind.value)) {
    return t('provider.checking')
  }
  if (providerStatus.value.error) return t('provider.unavailable')
  if (providerPresetActive(presetId)) return t('provider.active')
  if (providerPresetSaved(presetId)) return t('provider.saved')
  if (presetId === 'official') {
    if (!selectedProviderAgent.value?.installed) return t('provider.state.notInstalled')
    if (selectedProviderAgent.value?.credentialState === 'missing') return t('provider.state.loginRequired')
    if (nativeProviderReady(selectedProviderAgent.value)) return t('provider.nativeAvailable')
    return t('provider.state.unverified')
  }
  return t('provider.notConfigured')
}

function providerPresetFor(kind, presetId) {
  const profile = providerProfile(kind)
  return profile.presets.find(preset => preset.id === presetId) || profile.presets[0] || null
}

function fillProviderFormFromPreset(kind, presetId) {
  const preset = providerPresetFor(kind, presetId)
  if (!preset) return
  const saved = providerProfilesFor(kind)[preset.id]
  const lockedIdentity = preset.id !== 'custom'
  providerForm.preset = preset.id
  providerForm.provider = lockedIdentity ? (preset.provider || '') : (saved?.provider || preset.provider || '')
  providerForm.baseUrl = lockedIdentity ? (preset.baseUrl || '') : (saved?.baseUrl || preset.baseUrl || '')
  providerForm.model = saved?.model || preset.model || ''
}

function applyProviderPreset(presetId) {
  const changed = providerForm.preset !== presetId
  formError.value = ''
  providerRemoveArmed.value = false
  fillProviderFormFromPreset(selectedProviderKind.value, presetId)
  if (changed) providerForm.apiKey = ''
}

function conversationPermissionLabel(group) {
  const kinds = Array.isArray(group?.agentKinds) ? group.agentKinds : []
  const enforced = kinds.length && kinds.every(kind => READ_ONLY_ENFORCED_AGENT_KINDS.has(kind))
  if (!enforced) return t('conversation.agentManagedPermissions')
  return group?.allowWrite ? t('conversation.writeEnabled') : t('conversation.readOnly')
}

function agentSkillLabel(kind) {
  if (mergedCatalog.value.find(agent => agent.kind === kind)?.custom) {
    return t('customAgent.skillsUnsupported')
  }
  const state = agentSkillStats.value[kind]
  if (!state || state.loading) return t('agent.skillsLoading')
  if (!Number.isFinite(state.total)) return t('agent.skillsUnavailable')
  return t('agent.localSkills', { count: state.total })
}

function agentImageLabel(agent) {
  return agent?.imageLimit > 0
    ? t('agent.images', { count: agent.imageLimit })
    : t('agent.noImages')
}

async function loadAgentSkillStats() {
  if (typeof installer.value?.skills !== 'function') return
  const kinds = readyAgents.value.filter(agent => !agent.custom).map(agent => agent.kind)
  const token = ++agentSkillStatsToken
  const next = { ...agentSkillStats.value }
  for (const kind of kinds) next[kind] = { loading: true, total: next[kind]?.total }
  agentSkillStats.value = next
  const results = await Promise.all(kinds.map(async kind => [kind, await loadAgentSkillCatalog(kind)]))
  if (token !== agentSkillStatsToken) return
  agentSkillStats.value = Object.fromEntries(results.map(([kind, catalog]) => [kind, {
    loading: false,
    total: catalog?.supported === false || !Number.isFinite(catalog?.total) ? NaN : catalog.total,
  }]))
}

function normalizeAgentSkillCatalog(result, kind) {
  const supported = result?.supported !== false
  const skills = supported
    ? (Array.isArray(result?.skills) ? result.skills : [])
      .map(skill => normalizeSkill(skill, kind))
      .filter(Boolean)
    : []
  const requestedTotal = Number(result?.total)
  return {
    supported,
    total: Number.isFinite(requestedTotal) ? requestedTotal : skills.length,
    skills,
  }
}

function invalidateAgentSkillCatalog() {
  agentSkillCatalogGeneration += 1
  agentSkillCatalogRequests.clear()
  agentSkillCatalog.value = {}
}

async function loadAgentSkillCatalog(kind, options = {}) {
  const targetKind = String(kind || '')
  if (!targetKind || typeof installer.value?.skills !== 'function') return null
  if (!options.refresh && agentSkillCatalog.value[targetKind]) {
    return agentSkillCatalog.value[targetKind]
  }
  if (agentSkillCatalogRequests.has(targetKind)) return agentSkillCatalogRequests.get(targetKind)
  const generation = agentSkillCatalogGeneration
  const request = Promise.resolve(installer.value.skills(targetKind))
    .then(result => normalizeAgentSkillCatalog(result, targetKind))
    .catch(() => ({ supported: false, total: NaN, skills: [] }))
    .then((catalog) => {
      if (generation === agentSkillCatalogGeneration) {
        agentSkillCatalog.value = { ...agentSkillCatalog.value, [targetKind]: catalog }
      }
      return catalog
    })
    .finally(() => {
      if (agentSkillCatalogRequests.get(targetKind) === request) {
        agentSkillCatalogRequests.delete(targetKind)
      }
    })
  agentSkillCatalogRequests.set(targetKind, request)
  return request
}

async function preloadAgentSkills(kinds) {
  const targets = [...new Set((Array.isArray(kinds) ? kinds : []).map(kind => String(kind || '')).filter(Boolean))]
  await Promise.all(targets.map(kind => loadAgentSkillCatalog(kind)))
}

async function loadAgentDetailSkills(kind) {
  const targetKind = String(kind || '')
  const token = ++agentDetailSkillToken
  agentDetailSkillItems.value = []
  if (mergedCatalog.value.find(agent => agent.kind === targetKind)?.custom) {
    agentDetailSkillsLoading.value = false
    return
  }
  if (!targetKind || typeof installer.value?.skills !== 'function') {
    agentDetailSkillsLoading.value = false
    return
  }
  agentDetailSkillsLoading.value = true
  try {
    const catalog = await loadAgentSkillCatalog(targetKind)
    if (token === agentDetailSkillToken) agentDetailSkillItems.value = catalog?.skills?.slice(0, 12) || []
  } catch {
    if (token === agentDetailSkillToken) agentDetailSkillItems.value = []
  } finally {
    if (token === agentDetailSkillToken) agentDetailSkillsLoading.value = false
  }
}

function topicReplyCount(rootId) {
  return topicReplyCounts.value.get(rootId) || 0
}

function topicReplyAgentKinds(rootId) {
  return [...new Set(activeMessages.value
    .filter(message => message.role === 'agent' && messageThreadRootId(message) === rootId)
    .map(message => message.agentKind)
    .filter(Boolean))]
    .slice(0, 4)
}

function topicReplyLabel(count) {
  return t(count === 1 ? 'conversation.topicReply' : 'conversation.topicReplies', { count })
}

function isAgentFailureMessage(message) {
  return message?.role === 'system' && message?.system?.key === 'system.agentCallFailed'
}

function messageThreadRootId(message) {
  return message?.threadRootId || messageThreadRootIds.value.get(message?.id) || ''
}

function isTopicRoot(message) {
  return activeGroup.value?.conversationType !== 'direct'
    && message?.role === 'user'
    && !message.threadRootId
    && topicReplyCount(message.id) > 0
}

function isTopicExpanded(rootId) {
  return !collapsedTopicIds.value.has(rootId)
}

function toggleTopic(rootId) {
  const next = new Set(collapsedTopicIds.value)
  if (next.has(rootId)) next.delete(rootId)
  else next.add(rootId)
  collapsedTopicIds.value = next
}

function topicToggleLabel(rootId) {
  const count = topicReplyCount(rootId)
  return t(isTopicExpanded(rootId) ? 'conversation.collapseTopic' : 'conversation.expandTopic', {
    replies: topicReplyLabel(count),
  })
}

function runFinishedTurnKey(groupId, rootId) {
  return `${String(groupId || '')}\u0000${String(rootId || '')}`
}

function runFinishedTurnStatus(rootId) {
  return runFinishedTurnStatuses.value.get(runFinishedTurnKey(selectedGroupId.value, rootId)) || ''
}

function turnRailLabel(turn) {
  const values = {
    query: turn.query,
    time: turn.time || t('conversation.timeUnknown'),
    status: runStatusLabel(turn.status),
  }
  if (activeGroup.value?.conversationType === 'direct') {
    return t('conversation.turnRailDirectLabel', values)
  }
  return t('conversation.turnRailLabel', {
    ...values,
    replies: topicReplyLabel(turn.replyCount),
  })
}

function isActiveRunTopic(message) {
  const rootId = activeRunTopicRootId.value
  return Boolean(rootId && (message?.id === rootId || messageThreadRootId(message) === rootId))
}

function messageElementId(id) {
  return `message-${String(id || '').replace(/[^a-zA-Z0-9_-]/g, '-')}`
}

async function focusTurn(rootId) {
  if (!rootId) return
  activeTurnId.value = rootId
  if (!isTopicExpanded(rootId)) {
    const next = new Set(collapsedTopicIds.value)
    next.delete(rootId)
    collapsedTopicIds.value = next
  }
  await nextTick()
  const element = document.getElementById(messageElementId(rootId))
  element?.scrollIntoView?.({
    block: 'nearest',
    behavior: typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 'auto'
      : 'smooth',
  })
}

async function focusRunTopic() {
  await focusTurn(activeRunTopicRootId.value)
}

function messageExecutionSteps(message) {
  const values = Array.isArray(message?.toolCalls)
    ? message.toolCalls
    : Array.isArray(message?.metadata?.toolCalls) ? message.metadata.toolCalls : []
  return values.slice(0, 8).map(item => ({
    title: String(item?.title || item?.label || item?.name || item?.toolName || item?.tool || item?.type || item?.kind || '').trim(),
    status: String(item?.status || item?.state || '').trim().toLowerCase(),
  })).filter(item => item.title)
}

function messageTraceKey(message) {
  return message?.liveAgentRun?.agentRunId || message?.trace?.agentRunId || message?.id || ''
}

function messageAgentRunId(message) {
  return message?.liveAgentRun?.agentRunId || message?.trace?.agentRunId || ''
}

function messageTraceEvents(message) {
  const events = message?.liveAgentRun?.events || message?.trace?.events
  return (Array.isArray(events) ? events : []).filter((event) => {
    const type = String(event?.type || '').toLowerCase()
    const title = String(event?.title || '').trim().toLowerCase()
    return type !== 'answer_delta' && !(type === 'status' && ['agent', 'process'].includes(title))
  })
}

function messageHasTrace(message) {
  return Boolean(
    message?.provisional
    || message?.trace?.agentRunId
    || message?.trace?.summary
    || messageTraceEvents(message).length,
  )
}

function messageTraceSummary(message) {
  return String(message?.trace?.summary || '').trim()
}

function messageTraceStatus(message) {
  return String(message?.liveAgentRun?.status || message?.trace?.status || '').trim().toLowerCase()
}

function traceEventTypeLabel(type) {
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

function traceEventTitle(event) {
  const title = String(event?.title || '').trim()
  const connectorTitleKey = {
    connector_fallback: 'trace.eventConnectorFallback',
    connector_limited: 'trace.eventConnectorLimited',
  }[title.toLowerCase()]
  if (connectorTitleKey) return t(connectorTitleKey)
  if (!title || ['agent', 'waiting_for_output'].includes(title.toLowerCase())) return ''
  return title
}

function isDirectTraceOpen(message) {
  const key = messageTraceKey(message)
  if (directTraceDisclosure.value.has(key)) return directTraceDisclosure.value.get(key)
  return false
}

function syncDirectTraceDisclosure(message, event) {
  const key = messageTraceKey(message)
  if (!key) return
  const next = new Map(directTraceDisclosure.value)
  next.set(key, event?.target?.open === true)
  directTraceDisclosure.value = next
}

function localizedStepTitle(step, index) {
  const key = String(step?.title || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  const known = {
    reasoning: 'run.step.reasoning',
    process: 'run.step.process',
    write_file: 'run.step.writeFile',
    edit_file: 'run.step.writeFile',
    read_file: 'run.step.readFile',
    search: 'run.step.search',
    image_generation: 'run.step.imageGeneration',
    audio_generation: 'run.step.audioGeneration',
    video_generation: 'run.step.videoGeneration',
    tool: 'run.step.tool',
  }[key]
  if (known) return t(known)
  if (locale.value === 'en' && step?.title) return step.title
  return t('run.step.generic', { count: index + 1 })
}

function runStatusLabel(status) {
  const normalized = String(status || '').trim().toLowerCase()
  if (normalized === 'in_progress') return t('run.status.running')
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
    skipped: 'skipped',
    partial: 'partial',
    cancelled: 'cancelled',
    stopped: 'stopped',
    timeout: 'timeout',
    interrupted: 'interrupted',
    'not-started': 'notStarted',
    'round-limit': 'roundLimit',
  }[normalized] || 'unknown'
  return t(`run.status.${key}`)
}

function runStatusTone(status) {
  const normalized = String(status || '').trim().toLowerCase()
  if (['completed', 'succeeded'].includes(normalized)) return 'completed'
  if (['failed', 'timeout'].includes(normalized)) return 'failed'
  if (['partial', 'round-limit', 'stopped', 'cancelled', 'interrupted'].includes(normalized)) return 'partial'
  if (['running', 'in_progress', 'waiting'].includes(normalized)) return 'running'
  return 'queued'
}

function runAgentForKind(kind) {
  return latestAgentRunForKind(kind)
}

function runAgentStatus(kind) {
  if (runFailedKinds.value.includes(kind)) return 'failed'
  if (activeRun.value?.currentKind === kind) return 'running'
  if (runCompletedKinds.value.includes(kind)) return 'completed'
  const agent = runAgentForKind(kind)
  if (agent) return runStatusTone(agent.status)
  return 'queued'
}

function displayedRunAgentForKind(kind) {
  if (activeRun.value) return runAgentForKind(kind)
  return displayedRunAgentRuns.value.filter(item => item.agentKind === kind).at(-1) || null
}

function displayedRunAgentStatusForKind(kind) {
  if (activeRun.value) return runAgentStatus(kind)
  const agent = displayedRunAgentForKind(kind)
  return agent ? runStatusTone(agent.status) : 'not-started'
}

function displayedRunAgentTraceLabel(kind) {
  const agent = displayedRunAgentForKind(kind)
  return t('trace.viewAgentProcess', {
    agent: agentLabel(kind),
    status: runStatusLabel(agent?.status || displayedRunAgentStatusForKind(kind)),
  })
}

function formatElapsed(milliseconds) {
  const value = Number(milliseconds)
  if (!Number.isFinite(value) || value < 0) return ''
  if (value < 60000) {
    const seconds = Math.max(0.1, Math.round(value / 100) / 10)
    return t('conversation.seconds', { count: seconds })
  }
  const minutes = Math.round(value / 6000) / 10
  return t('conversation.minutes', { count: minutes })
}

function messageElapsedLabel(message) {
  const elapsed = message?.elapsedMs ?? message?.metadata?.elapsedMs
  const duration = formatElapsed(elapsed)
  return duration ? t('conversation.elapsed', { duration }) : ''
}

function isMessageCopied(id) {
  return copiedMessageIds.value.has(id)
}

function markMessageCopied(id) {
  if (!id) return
  copiedMessageIds.value = new Set([...copiedMessageIds.value, id])
  clearTimeout(copiedMessageTimers.get(id))
  copiedMessageTimers.set(id, setTimeout(() => {
    const next = new Set(copiedMessageIds.value)
    next.delete(id)
    copiedMessageIds.value = next
    copiedMessageTimers.delete(id)
  }, 1500))
}

function messageCopyBlocked(event) {
  const target = event?.target
  if (target instanceof Element && target.closest(
    'a, button, input, textarea, select, option, form, summary, [contenteditable="true"]',
  )) return true
  const selection = typeof window.getSelection === 'function' ? window.getSelection() : null
  return Boolean(selection && String(selection).trim())
}

function fallbackCopyText(content) {
  if (!document.body || typeof document.execCommand !== 'function') return false
  const textarea = document.createElement('textarea')
  textarea.value = content
  textarea.setAttribute('readonly', '')
  textarea.setAttribute('aria-hidden', 'true')
  textarea.style.position = 'fixed'
  textarea.style.top = '-1000px'
  textarea.style.opacity = '0'
  textarea.style.pointerEvents = 'none'
  document.body.appendChild(textarea)
  textarea.select()
  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch {
    copied = false
  }
  textarea.remove()
  return copied
}

async function copyMessageContent(message, event, force = false) {
  const content = String(message?.content || '')
  if (!content || (!force && messageCopyBlocked(event))) return
  let copied = false
  try {
    if (typeof navigator.clipboard?.writeText === 'function') {
      await navigator.clipboard.writeText(content)
      copied = true
    }
  } catch {
    copied = false
  }
  if (!copied) copied = fallbackCopyText(content)
  if (!copied) {
    notify(t('conversation.copyFailed'))
    return
  }
  markMessageCopied(message.id)
  showCopyToast()
}

function messageDeletionScope(message) {
  if (message?.role !== 'user' || message.threadRootId) return 'message'
  return activeGroup.value?.conversationType === 'direct' ? 'turn' : 'topic'
}

function messageDeleteDisabled(message) {
  return typeof workspace.value?.deleteMessage !== 'function'
    || isGroupRunning(message?.groupId)
    || Boolean(deletingMessageId.value)
}

function messageDeleteTitle(message) {
  if (isGroupRunning(message?.groupId)) return t('conversation.deleteMessageRunning')
  const scope = messageDeletionScope(message)
  const confirming = messageDeleteArmedId.value === message?.id
  if (scope === 'topic') {
    return t(confirming ? 'conversation.confirmDeleteTopic' : 'conversation.deleteTopic')
  }
  if (scope === 'turn') {
    return t(confirming ? 'conversation.confirmDeleteTurn' : 'conversation.deleteTurn')
  }
  return t(confirming ? 'conversation.confirmDeleteMessage' : 'conversation.deleteMessage')
}

function clearDeletedMessageUi(snapshotValue, groupId, rootId = '') {
  const remainingIds = new Set(snapshotValue.messages.map(message => message.id))
  copiedMessageIds.value = new Set([...copiedMessageIds.value].filter(id => remainingIds.has(id)))
  for (const [id, timer] of copiedMessageTimers) {
    if (remainingIds.has(id)) continue
    clearTimeout(timer)
    copiedMessageTimers.delete(id)
  }
  if (!rootId) return
  const collapsed = new Set(collapsedTopicIds.value)
  collapsed.delete(rootId)
  collapsedTopicIds.value = collapsed
  const statuses = new Map(runFinishedTurnStatuses.value)
  statuses.delete(runFinishedTurnKey(groupId, rootId))
  runFinishedTurnStatuses.value = statuses
  if (activeTurnId.value === rootId) activeTurnId.value = ''
}

async function confirmMessageDelete(message) {
  if (!message?.id || messageDeleteDisabled(message)) return
  const groupId = String(message.groupId || activeGroup.value?.id || '')
  const messageId = String(message.id)
  const deletesTurn = messageDeletionScope(message) !== 'message'
  deletingMessageId.value = messageId
  try {
    const result = await workspace.value.deleteMessage(groupId, messageId)
    const nextSnapshot = normalizeSnapshot(result?.messages ? result : await workspace.value.get())
    snapshot.value = nextSnapshot
    clearDeletedMessageUi(nextSnapshot, groupId, deletesTurn ? messageId : '')
    messageDeleteArmedId.value = ''
  } catch (error) {
    showError(error)
  } finally {
    deletingMessageId.value = ''
  }
}

function requestMessageDelete(message) {
  if (!message?.id || messageDeleteDisabled(message)) return
  if (messageDeleteArmedId.value === message.id) {
    void confirmMessageDelete(message)
    return
  }
  messageDeleteArmedId.value = message.id
}

function isDismissibleSystemWarning(message) {
  return message?.role === 'system'
    && Boolean(message?.id)
    && String(message.content || '').trim() === DISMISSIBLE_PLAN_WARNING
}

function dismissSystemMessage(id) {
  if (!id) return
  dismissedSystemMessageIds.value = new Set([...dismissedSystemMessageIds.value, id])
}

function hasFinishedDirectRun(groupId) {
  return finishedDirectGroupIds.value.has(groupId)
}

function onboardingSeen() {
  try { return localStorage.getItem(ONBOARDING_KEY) === '1' } catch { return false }
}

function hasPersistedWorkspaceActivity(value) {
  return Boolean(value?.groups?.length || value?.messages?.length)
}

function completeOnboarding(options = {}) {
  try { localStorage.setItem(ONBOARDING_KEY, '1') } catch { /* noop */ }
  onboardingCompleted.value = true
  clearOnboardingPlayback()
  const shouldRestoreHistory = modalHistoryPushed && options.fromHistory !== true
  modalHistoryPushed = false
  onboardingVisible.value = false
  if (shouldRestoreHistory) history.back()
}

function clearOnboardingPlayback() {
  if (onboardingPlaybackTimer) clearTimeout(onboardingPlaybackTimer)
  onboardingPlaybackTimer = null
}

function startOnboardingPlayback() {
  clearOnboardingPlayback()
  onboardingPlaybackComplete.value = false
  if (onboardingSlides.value.length <= 1) {
    onboardingPlaybackComplete.value = true
    return
  }
  const step = () => {
    if (!onboardingVisible.value) return
    if (!onboardingOnLastSlide.value) {
      onboardingIndex.value = Math.min(onboardingIndex.value + 1, onboardingLastIndex.value)
      onboardingPlaybackTimer = setTimeout(step, ONBOARDING_SLIDE_MS)
      return
    }
    onboardingPlaybackComplete.value = true
    clearOnboardingPlayback()
  }
  onboardingPlaybackTimer = setTimeout(step, ONBOARDING_SLIDE_MS)
}

function selectOnboardingSlide(index) {
  const nextIndex = Math.max(0, Math.min(Number(index) || 0, onboardingLastIndex.value))
  onboardingIndex.value = nextIndex
  clearOnboardingPlayback()
  if (onboardingOnLastSlide.value) {
    onboardingPlaybackComplete.value = true
    return
  }
  startOnboardingPlayback()
}

function beginOnboardingDetection() {
  onboardingDetecting.value = true
  void refreshAgents().finally(() => { onboardingDetecting.value = false })
}

function openOnboarding() {
  onboardingIndex.value = 0
  onboardingPlaybackComplete.value = false
  onboardingVisible.value = true
  startOnboardingPlayback()
  beginOnboardingDetection()
}

function settleWithin(promise, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs)
    Promise.resolve(promise).then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(undefined)
      },
    )
  })
}

function plainGroupPayload(form) {
  return {
    name: String(form.name || ''),
    topic: String(form.topic || ''),
    agentKinds: [...form.agentKinds].map(kind => String(kind)),
    workdir: String(form.workdir || ''),
    allowWrite: form.allowWrite === true,
  }
}

function parseSkillTrigger(value) {
  const match = /(^|\s)@([^\s@]*)$/.exec(String(value || ''))
  if (!match) return null
  return {
    query: match[2] || '',
    start: match.index + match[1].length,
    end: String(value || '').length,
  }
}

function skillKey(skill) {
  return [skill?.targetKind, skill?.namespace, skill?.slug].map(value => String(value || '')).join(':')
}

function knowledgeBaseDefinition(kind) {
  return KNOWLEDGE_BASE_CATALOG.find(source => source.kind === kind) || null
}

function knowledgeBaseName(kind) {
  const definition = knowledgeBaseDefinition(kind)
  return definition ? t(`knowledgeBase.source.${definition.kind}`) : String(kind || '')
}

function knowledgeBaseLogo(kind) {
  return knowledgeBaseDefinition(kind)?.logo || ''
}

function normalizeSkill(skill, requestedTarget) {
  const targetKind = String(skill?.targetKind || requestedTarget || '')
  const namespace = String(skill?.namespace || '')
  const slug = String(skill?.slug || '')
  const name = String(skill?.name || slug)
  if (!targetKind || targetKind !== requestedTarget || !slug) return null
  return { targetKind, namespace, slug, name }
}

function messageSkills(message) {
  return Array.isArray(message?.skillHints) ? message.skillHints : []
}

function messageKnowledgeBases(message) {
  const seen = new Set()
  return (Array.isArray(message?.knowledgeBaseHints) ? message.knowledgeBaseHints : []).filter((source) => {
    const kind = String(source?.kind || '')
    if (!kind || seen.has(kind)) return false
    seen.add(kind)
    return true
  })
}

function messageTargetKinds(message) {
  return [...new Set((Array.isArray(message?.targetKinds) ? message.targetKinds : [])
    .map(kind => String(kind || ''))
    .filter(Boolean))]
}

function messageScopedTargetKinds(message, group) {
  if (!message || !group || !Array.isArray(group.agentKinds)) return []
  const explicit = messageTargetKinds(message)
  const mentioned = Array.isArray(message?.mentionedAgentKinds) ? message.mentionedAgentKinds : []
  const natural = parseAgentRoutingPrefix(message.content, mergedCatalog.value, group.agentKinds).targetKinds
  const requested = explicit.length ? explicit : mentioned.length ? mentioned : natural
  const selected = new Set(requested.map(kind => String(kind || '')))
  return group.agentKinds.filter(kind => selected.has(kind))
}

function normalizeAttachment(attachment) {
  const id = String(attachment?.id || '')
  const name = String(attachment?.name || '')
  const mimeType = String(attachment?.mimeType || '')
  const size = Number(attachment?.size || 0)
  const previewDataUrl = String(attachment?.previewDataUrl || '')
  const kind = attachmentKind({ mimeType })
  if (!id || !name || !ATTACHMENT_TYPES.has(kind) || (kind === 'image' && !previewDataUrl)) return null
  return {
    id,
    name,
    mimeType,
    size: Number.isFinite(size) ? size : 0,
    ...(previewDataUrl ? { previewDataUrl } : {}),
  }
}

function safeAttachmentPayload(attachment) {
  return {
    id: String(attachment.id),
    name: String(attachment.name),
    mimeType: String(attachment.mimeType),
    size: Number(attachment.size) || 0,
  }
}

function messageAttachments(message) {
  return Array.isArray(message?.attachments) ? message.attachments : []
}

function attachmentKind(attachment) {
  const mimeType = String(attachment?.mimeType || '').toLowerCase()
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('audio/')) return 'audio'
  if (mimeType.startsWith('video/')) return 'video'
  return 'file'
}

function isImageAttachment(attachment) {
  return attachmentKind(attachment) === 'image'
}

function attachmentMediaUrl(attachment) {
  const id = String(attachment?.id || '')
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)
      || !['audio', 'video'].includes(attachmentKind(attachment))) return ''
  return `meldwork-media://attachment/${id}`
}

async function discardAttachments(values) {
  if (typeof attachmentsApi.value?.discard !== 'function') return
  const ids = [...new Set(values
    .map(value => String(typeof value === 'string' ? value : value?.id || ''))
    .filter(Boolean))]
  if (!ids.length) return
  try {
    const result = await attachmentsApi.value.discard(ids)
    forgetAttachmentPreviews(Array.isArray(result?.discardedIds) ? result.discardedIds : [])
  } catch (error) {
    console.error('[Meldwork]', errorCode(error))
  }
}

function attachmentLimitMessage() {
  if (composerAttachmentLimit.value <= 0) return t('composer.attachmentsUnsupported')
  return composerAttachmentLimit.value < MAX_ATTACHMENTS
    ? t('composer.attachmentTypeLimit')
    : t('composer.attachmentLimit')
}

function addAttachments(values) {
  const normalized = values.map(normalizeAttachment).filter(Boolean)
  normalized.forEach(rememberAttachmentPreview)
  const existingIds = new Set(composerAttachments.value.map(attachment => attachment.id))
  const available = normalized.filter(attachment => !existingIds.has(attachment.id))
  const counts = new Map([...ATTACHMENT_TYPES].map(type => [
    type,
    composerAttachments.value.filter(attachment => attachmentKind(attachment) === type).length,
  ]))
  const accepted = []
  const overflow = []
  for (const attachment of available) {
    const type = attachmentKind(attachment)
    const used = counts.get(type) || 0
    if (used >= attachmentLimitFor(type) || accepted.length + composerAttachments.value.length >= MAX_ATTACHMENTS) {
      overflow.push(attachment)
      continue
    }
    counts.set(type, used + 1)
    accepted.push(attachment)
  }
  composerAttachments.value = [...composerAttachments.value, ...accepted]
  if (overflow.length) {
    notify(attachmentLimitMessage())
    void discardAttachments(overflow)
  }
}

function beginAttachmentImport() {
  const groupId = String(activeGroup.value?.id || '')
  if (!groupId) return null
  const operation = {
    id: ++attachmentImportSequence,
    groupId,
    contextVersion: composerContextVersion.value,
  }
  attachmentImportOperations.value = [...attachmentImportOperations.value, operation]
  return operation
}

function finishAttachmentImport(operation) {
  attachmentImportOperations.value = attachmentImportOperations.value.filter(item => item.id !== operation.id)
}

function attachmentImportIsCurrent(operation) {
  return operation.contextVersion === composerContextVersion.value
    && operation.groupId === String(activeGroup.value?.id || '')
}

function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
}

function advanceEmptyShowcase() {
  emptyShowcaseIndex.value = (emptyShowcaseIndex.value + 1) % EMPTY_SHOWCASE_COUNT
}

function clearEmptyShowcasePlayback() {
  if (emptyShowcaseTimer) clearTimeout(emptyShowcaseTimer)
  emptyShowcaseTimer = null
}

function startEmptyShowcasePlayback() {
  clearEmptyShowcasePlayback()
  if (!conversationEmptyVisible.value || EMPTY_SHOWCASE_COUNT <= 1) return
  const step = () => {
    if (!conversationEmptyVisible.value) {
      clearEmptyShowcasePlayback()
      return
    }
    advanceEmptyShowcase()
    emptyShowcaseTimer = setTimeout(step, EMPTY_SHOWCASE_SLIDE_MS)
  }
  emptyShowcaseTimer = setTimeout(step, EMPTY_SHOWCASE_SLIDE_MS)
}

function toggleLocale() {
  setLocale(locale.value === 'zh' ? 'en' : 'zh')
}

function applyTheme(value) {
  document.documentElement.dataset.theme = value
  document.documentElement.style.colorScheme = value
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', value === 'dark' ? '#0e171d' : '#f3f6f8')
  try { localStorage.setItem('roundrelay-theme', value) } catch { /* noop */ }
}

function selectTraceAgentRun(agentRunId) {
  if (!agentRunId || !tracePanelItems.value.some(item => item.agentRunId === agentRunId)) return
  selectedTraceAgentRunId.value = agentRunId
}

function openTracePanel(agentRunId, opener = null, runId = '') {
  if (activeGroup.value?.conversationType === 'direct') return
  const item = allTracePanelItems.value.find(candidate => (
    candidate.agentRunId === agentRunId && (!runId || candidate.runId === runId)
  ))
  if (!item) return
  if (!tracePanelOpen.value) {
    tracePanelFocusReturn = opener instanceof HTMLElement ? opener : document.activeElement
    tracePanelFocusReturnAgentRunId = agentRunId
    history.pushState({ roundrelayTracePanel: true }, '', window.location.href)
    tracePanelHistoryPushed = true
  }
  tracePanelGroupId.value = selectedGroupId.value
  tracePanelRunId.value = item.runId
  selectedTraceAgentRunId.value = agentRunId
  tracePanelOpen.value = true
  void nextTick(() => tracePanel.value?.focus?.())
}

function openDisplayedTraceForAgent(kind, opener = null) {
  const agent = displayedRunAgentForKind(kind)
  if (agent) openTracePanel(agent.agentRunId, opener, displayedRun.value?.runId || '')
}

function openDisplayedRunTrace(opener = null) {
  const preferred = displayedRunAgentForKind(displayedRunAgentKind.value)
    || displayedRunAgentRuns.value.find(item => retainedTraceEvents(item.events).length)
    || displayedRunAgentRuns.value.at(-1)
  if (preferred) openTracePanel(preferred.agentRunId, opener, displayedRun.value?.runId || '')
}

function openTraceForMessage(message, opener = null) {
  const agentRunId = messageAgentRunId(message)
  const runId = message?.traceRunId || message?.trace?.runId || ''
  if (agentRunId) openTracePanel(agentRunId, opener, runId)
}

function focusTraceReturnTarget(target, agentRunId) {
  if (target?.isConnected && typeof target.focus === 'function') {
    target.focus()
    if (document.activeElement === target) return
  }
  const matchingTarget = [...document.querySelectorAll('[data-trace-agent-run-id]')]
    .find(element => element.getAttribute('data-trace-agent-run-id') === agentRunId && !element.disabled)
  if (matchingTarget && typeof matchingTarget.focus === 'function') {
    matchingTarget.focus()
    if (document.activeElement === matchingTarget) return
  }
  conversationTitleBlock.value?.focus?.()
}

function closeTracePanel(options = {}) {
  if (!tracePanelOpen.value) return false
  tracePanelOpen.value = false
  tracePanelGroupId.value = ''
  tracePanelRunId.value = ''
  selectedTraceAgentRunId.value = ''
  const target = tracePanelFocusReturn
  const agentRunId = tracePanelFocusReturnAgentRunId
  tracePanelFocusReturn = null
  tracePanelFocusReturnAgentRunId = ''
  if (!options.fromHistory && tracePanelHistoryPushed) {
    tracePanelHistoryPushed = false
    history.back()
  } else {
    tracePanelHistoryPushed = false
  }
  void nextTick(() => {
    focusTraceReturnTarget(target, agentRunId)
  })
  return true
}

async function jumpToTraceSource(sourceId) {
  const message = activeMessages.value.find(item => item.id === sourceId)
  if (!message) return
  const rootId = messageThreadRootId(message) || (message.role === 'user' ? message.id : '')
  if (rootId && !isTopicExpanded(rootId)) {
    const next = new Set(collapsedTopicIds.value)
    next.delete(rootId)
    collapsedTopicIds.value = next
  }
  if (tracePanelDrawer.value) closeTracePanel()
  await nextTick()
  document.getElementById(messageElementId(sourceId))?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
}

function handleRunEvent(event) {
  const next = mergeRunEvent(snapshot.value, event)
  if (next !== snapshot.value) snapshot.value = next
}

function goHome() {
  closeCollapsedGroupMenu()
  activeView.value = 'home'
  sidebarDeleteGroupId.value = ''
  pendingRequestedGroupId = ''
  closeTracePanel()
}

function selectGroup(id) {
  closeCollapsedGroupMenu()
  const group = snapshot.value.groups.find(item => item.id === id)
  if (!group) {
    selectedGroupId.value = ''
    activeView.value = 'home'
    return
  }
  activeView.value = 'conversation'
  closeTracePanel()
  sidebarDeleteGroupId.value = ''
  selectedGroupId.value = id
  if (group?.conversationType === 'direct' && group.directAgentKind) {
    setSidebarAgentExpanded(group.directAgentKind, true)
  }
  void preloadAgentSkills(group.agentKinds)
  if (finishedDirectGroupIds.value.has(id)) {
    const next = new Set(finishedDirectGroupIds.value)
    next.delete(id)
    finishedDirectGroupIds.value = next
  }
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
  return messageTimeFormatter.value.format(date)
}

function providerModeLabel(mode) {
  return t(`agent.provider.${mode}`)
}

function supportsExternalProvider(agent) {
  return EXTERNAL_PROVIDER_KINDS.has(agent?.kind)
}

function agentState(agent) {
  if (agent.ready) return { label: t('agent.ready'), tone: 'ready', icon: CheckmarkCircleOutline }
  if (agent.custom) return { label: t('customAgent.executableUnavailable'), tone: 'warning', icon: WarningOutline }
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
  if (saving.value || isDirectCreationPending(agent?.kind)) return
  closeModal()
  if (agent?.kind) setSidebarAgentExpanded(agent.kind, true)
  const existing = directGroupsFor(agent.kind)[0]
  if (existing) {
    selectGroup(existing.id)
    return
  }
  if (!agent.ready) {
    openAgentManager(agent.kind)
    return
  }
  const group = await createDirectSession(agent, false)
  if (!group) return
  selectGroup(group.id)
}

async function createDirectSession(agent, select = true) {
  const kind = String(agent?.kind || '')
  if (saving.value || !kind || isDirectCreationPending(kind)) return null
  setDirectCreationPending(kind, true)
  closeModal()
  if (kind) setSidebarAgentExpanded(kind, true)
  if (!agent?.ready) {
    if (agent?.kind) openAgentManager(agent.kind)
    setDirectCreationPending(kind, false)
    return null
  }
  try {
    const sessionCount = directGroupsFor(agent.kind).length + 1
    const group = await workspace.value.createGroup({
      conversationType: 'direct',
      directAgentKind: agent.kind,
      name: sessionCount === 1
        ? agent.label
        : t('conversation.directDefaultName', { agent: agent.label, count: sessionCount }),
      agentKinds: [agent.kind],
      workdir: await ensureDefaultDirectory(),
      allowWrite: true,
    })
    snapshot.value = normalizeSnapshot(await workspace.value.get())
    void preloadAgentSkills(group.agentKinds)
    if (select) selectGroup(group.id)
    return group
  } catch (error) {
    showError(error)
    return null
  } finally {
    setDirectCreationPending(kind, false)
  }
}

async function refreshAgents() {
  if (!workspace.value || refreshing.value) return
  refreshing.value = true
  const previousReadyAgentSignature = readyAgentSignature.value
  try {
    const [nextSnapshot, nextCatalog, nextInstaller] = await Promise.all([
      workspace.value.refreshAgents(),
      installer.value?.catalog?.() || installCatalog.value,
      installer.value?.state?.() || installerState.value,
    ])
    snapshot.value = normalizeSnapshot(nextSnapshot)
    applyInstallCatalog(nextCatalog)
    installerState.value = nextInstaller || installerState.value
    invalidateAgentSkillCatalog()
    if (readyAgentSignature.value && readyAgentSignature.value === previousReadyAgentSignature) {
      await loadAgentSkillStats()
    }
  } catch (error) {
    showError(error)
  } finally {
    refreshing.value = false
  }
}

function applyInstallCatalog(value) {
  const catalog = value && typeof value === 'object'
    ? value
    : { platform: '', agents: [] }
  installCatalog.value = {
    ...catalog,
    agents: Array.isArray(catalog.agents) ? catalog.agents : [],
  }
  setCustomAgentProfiles(installCatalog.value.agents.filter(agent => agent?.custom === true))
}

function openNewGroup() {
  if (saving.value) return
  formError.value = ''
  groupForm.name = ''
  groupForm.topic = ''
  groupForm.agentKinds = readyAgents.value.slice(0, 2).map(agent => agent.kind)
  groupForm.workdir = defaultDirectory.value
  groupForm.allowWrite = true
  modal.value = 'new-group'
  void ensureDefaultDirectory().then(path => { if (!groupForm.workdir) groupForm.workdir = path })
}

function openCustomAgentModal() {
  if (saving.value) return
  formError.value = ''
  customAgentForm.label = ''
  customAgentForm.description = ''
  customAgentForm.argumentsText = ''
  customAgentForm.promptMode = 'stdin'
  customAgentDeleteArmed.value = false
  modal.value = 'custom-agent'
}

async function createCustomAgent() {
  formError.value = ''
  if (!customAgentForm.label) {
    formError.value = t('customAgent.nameRequired')
    return
  }
  if (typeof customAgent.value?.create !== 'function') {
    formError.value = t('error.bridge')
    return
  }
  const args = customAgentForm.argumentsText
    .split(/\r?\n/)
    .map(argument => argument.trim())
    .filter(Boolean)
  saving.value = true
  try {
    const result = await customAgent.value.create({
      label: customAgentForm.label,
      description: customAgentForm.description,
      args,
      promptMode: customAgentForm.promptMode,
    })
    if (result?.canceled) return
    await refreshAgents()
    focusedAgentKind.value = String(result?.agent?.kind || '')
    closeModal({ force: true })
  } catch (error) {
    formError.value = translateError(error)
  } finally {
    saving.value = false
  }
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
    const group = await workspace.value.createGroup(plainGroupPayload(groupForm))
    snapshot.value = normalizeSnapshot(await workspace.value.get())
    void preloadAgentSkills(group.agentKinds)
    closeModal({ force: true })
    selectGroup(group.id)
  } catch (error) {
    formError.value = translateError(error)
  } finally {
    saving.value = false
  }
}

function beginInlineTitleEdit() {
  if (!activeGroup.value || activeRun.value || sending.value || saving.value) return
  inlineTitleDraft.value = String(activeGroup.value.name || '')
  inlineTitleEditing.value = true
  void nextTick(() => {
    inlineTitleInput.value?.focus()
    inlineTitleInput.value?.select()
  })
}

function restoreInlineTitleFocus() {
  void nextTick(() => inlineTitleButton.value?.focus())
}

function cancelInlineTitleEdit(options = {}) {
  inlineTitleEditing.value = false
  inlineTitleDraft.value = ''
  if (options?.restoreFocus !== false) restoreInlineTitleFocus()
}

async function saveInlineTitle() {
  const group = activeGroup.value
  const name = inlineTitleDraft.value.trim()
  if (!group || !name || activeRun.value || sending.value || saving.value) {
    if (!name) cancelInlineTitleEdit()
    return
  }
  saving.value = true
  let saved = false
  try {
    await workspace.value.updateGroup(group.id, plainGroupPayload({ ...group, name }))
    snapshot.value = normalizeSnapshot(await workspace.value.get())
    inlineTitleEditing.value = false
    inlineTitleDraft.value = ''
    saved = true
  } catch (error) {
    showError(error)
  } finally {
    saving.value = false
  }
  if (saved) restoreInlineTitleFocus()
}

function openGroupSettings(intent = 'settings') {
  if (!activeGroup.value || sending.value || saving.value) return
  settingsIntent.value = typeof intent === 'string' ? intent : 'settings'
  settingsForm.name = groupName(activeGroup.value)
  settingsForm.topic = activeGroup.value.topic || ''
  settingsForm.agentKinds = [...activeGroup.value.agentKinds]
  settingsForm.workdir = activeGroup.value.workdir || ''
  settingsForm.allowWrite = activeGroup.value.allowWrite === true
  formError.value = ''
  deleteArmed.value = false
  modal.value = 'settings'
}

function openConversationRename(group) {
  if (!group || isGroupRunning(group.id)) return
  selectGroup(group.id)
  openGroupSettings('rename')
  void nextTick(() => settingsNameInput.value?.focus())
}

function positionSidebarDeletePopover(target) {
  const rect = target?.getBoundingClientRect?.()
  if (!rect) return
  const tooltipWidth = 278
  const gutter = 12
  sidebarDeletePopoverPoint.value = {
    left: Math.max(gutter, Math.min(rect.right + 10, window.innerWidth - tooltipWidth - gutter)),
    top: Math.max(86, rect.top + 12),
  }
}

function openSidebarConversationDelete(group, event) {
  if (!group || isGroupRunning(group.id) || saving.value) return
  if (sidebarDeleteGroupId.value === group.id) {
    sidebarDeleteGroupId.value = ''
    return
  }
  positionSidebarDeletePopover(event?.currentTarget)
  sidebarDeleteGroupId.value = group.id
}

function dismissSidebarDeleteConfirmation() {
  if (saving.value) return
  sidebarDeleteGroupId.value = ''
}

function requestDeleteConfirmation() {
  if (saving.value) return
  deleteArmed.value = true
}

function dismissDeleteConfirmation() {
  if (saving.value) return
  deleteArmed.value = false
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
    await workspace.value.updateGroup(activeGroup.value.id, plainGroupPayload(settingsForm))
    snapshot.value = normalizeSnapshot(await workspace.value.get())
    closeModal({ force: true })
  } catch (error) {
    formError.value = translateError(error)
  } finally {
    saving.value = false
  }
}

async function deleteConversation() {
  if (saving.value) return
  if (!deleteArmed.value) {
    deleteArmed.value = true
    return
  }
  saving.value = true
  try {
    snapshot.value = normalizeSnapshot(await workspace.value.deleteGroup(activeGroup.value.id))
    selectedGroupId.value = ''
    activeView.value = 'home'
    closeModal({ force: true })
  } catch (error) {
    formError.value = translateError(error)
  } finally {
    saving.value = false
  }
}

async function deleteSidebarConversation(group) {
  if (!group || saving.value || sidebarDeleteGroupId.value !== group.id) return
  saving.value = true
  try {
    snapshot.value = normalizeSnapshot(await workspace.value.deleteGroup(group.id))
    if (selectedGroupId.value === group.id) {
      selectedGroupId.value = ''
      if (activeView.value === 'conversation') activeView.value = 'home'
    }
    sidebarDeleteGroupId.value = ''
  } catch (error) {
    showError(error)
  } finally {
    saving.value = false
  }
}

function toggleTarget(kind) {
  if (sending.value || activeRun.value || composerMode.value === 'auto') return
  if (selectedAgentKinds.value.length) {
    if (selectedAgentKinds.value.includes(kind)) removeAgentMention(kind)
    else addAgentMention(kind)
    return
  }
  if (targetKinds.value.includes(kind)) targetKinds.value = targetKinds.value.filter(item => item !== kind)
  else targetKinds.value = [...targetKinds.value, kind]
}

function isComposerTargetSelected(kind) {
  return composerTargetKinds.value.includes(kind)
}

async function loadSkillsForTargets() {
  const targets = [...skillMenuTargetKinds.value]
  const token = ++skillLoadToken
  if (!targets.length || typeof installer.value?.skills !== 'function') {
    skillOptions.value = []
    skillsLoading.value = false
    return
  }
  const missingTargets = targets.filter(kind => !agentSkillCatalog.value[kind])
  const cached = targets.flatMap(kind => agentSkillCatalog.value[kind]?.skills || [])
  skillOptions.value = uniqueSkills(cached)
  skillsLoading.value = missingTargets.length > 0
  if (!missingTargets.length) return
  try {
    await Promise.all(missingTargets.map(kind => loadAgentSkillCatalog(kind)))
    if (token !== skillLoadToken) return
    skillOptions.value = uniqueSkills(targets.flatMap(kind => agentSkillCatalog.value[kind]?.skills || []))
  } finally {
    if (token === skillLoadToken) skillsLoading.value = false
  }
}

function uniqueSkills(skills) {
  const seen = new Set()
  return skills.filter((skill) => {
    const key = skillKey(skill)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function composerMenuOptionKey(option) {
  if (option?.type === 'skill') return skillKey(option.value)
  if (option?.type === 'knowledge-base') return `knowledge:${option.value?.kind}`
  return `agent:${option?.value}`
}

function composerMenuOptionIndex(option) {
  return composerMenuOptions.value.indexOf(option)
}

function composerMenuOptionLogo(option) {
  if (option?.type === 'knowledge-base') return option.value?.logo || ''
  if (option?.type === 'agent') return agentLogo(option.value, theme.value)
  return ''
}

function composerMenuOptionTitle(option) {
  if (option?.type === 'skill') return option.value?.name || option.value?.slug || ''
  if (option?.type === 'knowledge-base') return knowledgeBaseName(option.value?.kind)
  return agentLabel(option?.value)
}

function composerMenuOptionDescription(option) {
  if (option?.type === 'skill') {
    return `${agentLabel(option.value?.targetKind)} / ${option.value?.namespace || t('composer.skills')}`
  }
  if (option?.type === 'knowledge-base') {
    return t(`composer.knowledgeBaseDescription.${option.value?.kind}`)
  }
  return agentDescription(option?.value)
}

function composerMenuOptionKindLabel(option) {
  return t(`composer.mentionType.${option?.type || 'skill'}`)
}

function composerMenuOptionDisabled(option) {
  if (option?.type === 'skill') return selectedSkills.value.length >= MAX_SKILLS
  if (option?.type === 'knowledge-base') {
    const alreadySelected = selectedKnowledgeBases.value.some(source => source.kind === option.value?.kind)
    return !alreadySelected && selectedKnowledgeBases.value.length >= MAX_KNOWLEDGE_BASES
  }
  return false
}

function resizeComposerInput() {
  const input = composerInput.value
  if (!input) return
  input.style.height = 'auto'
  const scrollHeight = Math.max(Number(input.scrollHeight) || 0, COMPOSER_INPUT_MIN_HEIGHT)
  input.style.height = `${Math.min(scrollHeight, COMPOSER_INPUT_MAX_HEIGHT)}px`
  input.style.overflowY = scrollHeight > COMPOSER_INPUT_MAX_HEIGHT ? 'auto' : 'hidden'
}

function scheduleComposerResize() {
  void nextTick(resizeComposerInput)
}

function handleComposerInput() {
  resizeComposerInput()
  if (!currentSkillTrigger.value) {
    skillMenuOpen.value = false
    return
  }
  const shouldLoad = !skillMenuOpen.value
  skillActiveIndex.value = 0
  skillMenuOpen.value = true
  if (shouldLoad && skillMenuTargetKinds.value.length) void loadSkillsForTargets()
  else if (!skillMenuTargetKinds.value.length) skillsLoading.value = false
}

async function openSkillMenu() {
  if (!composerTargetKinds.value.length && activeGroup.value?.conversationType === 'direct') {
    notify(t('composer.selectTarget'))
    return
  }
  if (!currentSkillTrigger.value) {
    const spacer = draft.value && !/\s$/.test(draft.value) ? ' ' : ''
    draft.value = `${draft.value}${spacer}@`
  }
  skillActiveIndex.value = 0
  skillMenuOpen.value = true
  if (skillMenuTargetKinds.value.length) await loadSkillsForTargets()
  await nextTick()
  composerInput.value?.focus()
}

async function addAgentMention(kind) {
  const group = activeGroup.value
  if (!group || group.conversationType === 'direct' || !group.agentKinds.includes(kind)) return
  if (!selectedAgentKinds.value.includes(kind)) {
    selectedAgentKinds.value = [...selectedAgentKinds.value, kind]
  }
  activeMentionAgentKind.value = kind
  skillMenuOpen.value = false
  skillsLoading.value = false
  void preloadAgentSkills([kind])
  await nextTick()
  composerInput.value?.focus()
}

async function selectAgentMention(kind) {
  const trigger = currentSkillTrigger.value
  if (trigger) draft.value = `${draft.value.slice(0, trigger.start)}${draft.value.slice(trigger.end)}`
  await addAgentMention(kind)
}

function removeAgentMention(kind) {
  selectedAgentKinds.value = selectedAgentKinds.value.filter(item => item !== kind)
  selectedSkills.value = selectedSkills.value.filter(skill => skill.targetKind !== kind)
  selectedKnowledgeBases.value = selectedKnowledgeBases.value
    .map(source => ({ ...source, targetKinds: source.targetKinds.filter(target => target !== kind) }))
    .filter(source => source.targetKinds.length)
  activeMentionAgentKind.value = selectedAgentKinds.value.at(-1) || ''
  skillMenuOpen.value = false
  skillsLoading.value = false
  skillOptions.value = []
  skillLoadToken += 1
}

function selectComposerMenuOption(option) {
  if (option?.type === 'agent') return selectAgentMention(option.value)
  if (option?.type === 'skill') return selectSkill(option.value)
  if (option?.type === 'knowledge-base') return selectKnowledgeBase(option.value)
  return undefined
}

async function selectSkill(skill) {
  if (selectedSkills.value.length >= MAX_SKILLS) {
    notify(t('composer.skillLimit'))
    return
  }
  const key = skillKey(skill)
  if (!selectedSkills.value.some(item => skillKey(item) === key)) {
    selectedSkills.value = [...selectedSkills.value, { ...skill }]
  }
  const trigger = currentSkillTrigger.value
  if (trigger) draft.value = `${draft.value.slice(0, trigger.start)}${draft.value.slice(trigger.end)}`
  skillMenuOpen.value = false
  await nextTick()
  composerInput.value?.focus()
}

function removeSkill(skill) {
  const key = skillKey(skill)
  selectedSkills.value = selectedSkills.value.filter(item => skillKey(item) !== key)
}

async function selectKnowledgeBase(source) {
  const targets = [...knowledgeBaseSelectionTargetKinds.value]
  if (!source?.kind || !targets.length) return
  const existing = selectedKnowledgeBases.value.find(item => item.kind === source.kind)
  if (!existing && selectedKnowledgeBases.value.length >= MAX_KNOWLEDGE_BASES) {
    notify(t('composer.knowledgeBaseLimit'))
    return
  }
  const targetKinds = [...new Set([...(existing?.targetKinds || []), ...targets])]
  selectedKnowledgeBases.value = [
    ...selectedKnowledgeBases.value.filter(item => item.kind !== source.kind),
    { kind: source.kind, targetKinds },
  ]
  const trigger = currentSkillTrigger.value
  if (trigger) draft.value = `${draft.value.slice(0, trigger.start)}${draft.value.slice(trigger.end)}`
  skillMenuOpen.value = false
  await nextTick()
  composerInput.value?.focus()
}

function removeKnowledgeBase(kind) {
  selectedKnowledgeBases.value = selectedKnowledgeBases.value.filter(source => source.kind !== kind)
}

function removeAttachment(id) {
  composerAttachments.value = composerAttachments.value.filter(attachment => attachment.id !== id)
  void discardAttachments([id])
}

async function pickAttachments() {
  const pick = attachmentsApi.value?.pickAttachments
  if (typeof pick !== 'function') {
    notify(t('composer.attachmentsUnavailable'))
    return
  }
  if (!composerTargetKinds.value.length) {
    notify(t('composer.selectTarget'))
    return
  }
  if (!composerTargetsReady.value) {
    notify(t('error.agentUnavailable'))
    return
  }
  if (composerAttachmentLimit.value <= 0) {
    notify(t('composer.attachmentsUnsupported'))
    return
  }
  const remainingCapacity = Math.min(
    Math.max(0, MAX_ATTACHMENTS - composerAttachments.value.length),
    composerAttachmentLimit.value,
  )
  if (!remainingCapacity) {
    notify(attachmentLimitMessage())
    return
  }
  const operation = beginAttachmentImport()
  if (!operation) return
  try {
    const result = await pick(remainingCapacity)
    const values = Array.isArray(result) ? result : (Array.isArray(result?.attachments) ? result.attachments : [])
    if (attachmentImportIsCurrent(operation)) {
      addAttachments(values)
      if (result?.truncated) notify(attachmentLimitMessage())
    }
    else void discardAttachments(values)
  } catch (error) {
    if (attachmentImportIsCurrent(operation)) showError(error)
  } finally {
    finishAttachmentImport(operation)
  }
}

async function handleComposerPaste(event) {
  const importAttachment = attachmentsApi.value?.importAttachment
  if (typeof importAttachment !== 'function') return
  const files = [...new Map([
    ...Array.from(event.clipboardData?.files || []),
    ...Array.from(event.clipboardData?.items || [])
      .filter(item => item.kind === 'file')
      .map(item => item.getAsFile?.())
      .filter(Boolean),
  ].map(file => [`${file.name}:${file.size}:${file.lastModified}:${file.type}`, file])).values()]
  if (!files.length) return
  event.preventDefault()
  if (importingAttachment.value) {
    notify(t('composer.attachmentImporting'))
    return
  }
  if (!composerTargetKinds.value.length) {
    notify(t('composer.selectTarget'))
    return
  }
  if (!composerTargetsReady.value) {
    notify(t('error.agentUnavailable'))
    return
  }
  const room = Math.max(0, MAX_ATTACHMENTS - composerAttachments.value.length)
  if (!room) {
    notify(attachmentLimitMessage())
    return
  }
  if (files.length > room) notify(attachmentLimitMessage())
  const operation = beginAttachmentImport()
  if (!operation) return
  try {
    const imported = []
    const attachmentCounts = new Map([...ATTACHMENT_TYPES].map(type => [
      type,
      composerAttachments.value.filter(attachment => attachmentKind(attachment) === type).length,
    ]))
    for (const file of files.slice(0, room)) {
      if (!attachmentImportIsCurrent(operation)) break
      try {
        const type = attachmentKind({ mimeType: file.type })
        if (!ATTACHMENT_TYPES.has(type) || (attachmentCounts.get(type) || 0) >= attachmentLimitFor(type)) {
          notify(attachmentLimitMessage())
          continue
        }
        if (Number(file.size) > MAX_ATTACHMENT_BYTES) {
          throw Object.assign(new Error('LOCAL_ATTACHMENT_TOO_LARGE'), {
            code: 'LOCAL_ATTACHMENT_TOO_LARGE',
          })
        }
        const bytes = new Uint8Array(await file.arrayBuffer())
        const attachment = await importAttachment({
          name: String(file.name || t('composer.pastedAttachment')),
          mimeType: String(file.type || 'application/octet-stream'),
          bytes,
        })
        if (!attachmentImportIsCurrent(operation)) {
          void discardAttachments([attachment])
          break
        }
        imported.push(attachment)
        attachmentCounts.set(type, (attachmentCounts.get(type) || 0) + 1)
      } catch (error) {
        if (attachmentImportIsCurrent(operation)) showError(error)
      }
    }
    if (attachmentImportIsCurrent(operation)) addAttachments(imported)
    else void discardAttachments(imported)
  } finally {
    finishAttachmentImport(operation)
  }
}

function handleComposerKeydown(event) {
  if (skillMenuOpen.value) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const count = composerMenuOptions.value.length
      if (count) {
        const direction = event.key === 'ArrowDown' ? 1 : -1
        skillActiveIndex.value = (skillActiveIndex.value + direction + count) % count
      }
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      skillMenuOpen.value = false
      return
    }
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault()
      const option = composerMenuOptions.value[skillActiveIndex.value]
      if (option) void selectComposerMenuOption(option)
      else skillMenuOpen.value = false
      return
    }
  }
  if (event.key === 'Backspace' && !draft.value && selectedAgentKinds.value.length) {
    event.preventDefault()
    removeAgentMention(selectedAgentKinds.value.at(-1))
    return
  }
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    void sendMessage()
  }
}

async function sendMessage() {
  if (!activeGroup.value || sending.value || activeRun.value || importingAttachment.value) return
  const groupId = activeGroup.value.id
  const contextVersion = composerContextVersion.value
  const text = draft.value.trim()
  const attachments = composerAttachments.value.map(safeAttachmentPayload)
  const mode = composerMode.value
  if (!text && !attachments.length) {
    notify(t('composer.messageRequired'))
    return
  }
  const targets = [...composerTargetKinds.value]
  if (!targets.length) {
    notify(t('composer.selectTarget'))
    return
  }
  if (mode === 'auto' && targets.length < 2) {
    notify(t('error.autoAgentCount'))
    return
  }
  if (targets.some(kind => !readyAgentKinds.value.has(kind))) {
    notify(t('error.agentUnavailable'))
    return
  }
  if (!composerAttachmentSupported.value || attachments.length > MAX_ATTACHMENTS) {
    notify(attachmentLimitMessage())
    return
  }
  const skillHints = selectedSkills.value
    .filter(skill => targets.includes(skill.targetKind))
    .map(skill => ({
      targetKind: String(skill.targetKind),
      namespace: String(skill.namespace),
      slug: String(skill.slug),
      name: String(skill.name),
    }))
  const knowledgeBaseHints = selectedKnowledgeBases.value
    .map(source => ({
      kind: String(source.kind),
      targetKinds: source.targetKinds.filter(kind => targets.includes(kind)),
    }))
    .filter(source => source.kind && source.targetKinds.length)
  const previousDraft = draft.value
  const mentionedAgentKinds = [...addressedAgentKinds.value]
  const previousAgentKinds = [...selectedAgentKinds.value]
  const previousActiveMentionAgentKind = activeMentionAgentKind.value
  const previousSkills = selectedSkills.value.map(skill => ({ ...skill }))
  const previousKnowledgeBases = selectedKnowledgeBases.value.map(source => ({
    ...source,
    targetKinds: [...source.targetKinds],
  }))
  const previousAttachments = composerAttachments.value.map(attachment => ({ ...attachment }))
  draft.value = ''
  selectedAgentKinds.value = []
  activeMentionAgentKind.value = ''
  selectedSkills.value = []
  selectedKnowledgeBases.value = []
  composerAttachments.value = []
  skillMenuOpen.value = false
  roundSettingsOpen.value = false
  sending.value = true
  try {
    await workspace.value.send({
      groupId,
      text,
      targetKinds: targets,
      ...(mentionedAgentKinds.length ? { mentionedAgentKinds } : {}),
      skillHints,
      knowledgeBaseHints,
      attachments,
      mode,
      maxRounds: maxRounds.value,
      ...(mode === 'auto' && unlimitedRounds.value ? { unlimitedRounds: true } : {}),
    })
    snapshot.value = normalizeSnapshot(await workspace.value.get())
  } catch (error) {
    if (contextVersion === composerContextVersion.value && groupId === activeGroup.value?.id) {
      draft.value = previousDraft
      selectedAgentKinds.value = previousAgentKinds
      activeMentionAgentKind.value = previousActiveMentionAgentKind
      selectedSkills.value = previousSkills
      selectedKnowledgeBases.value = previousKnowledgeBases
      composerAttachments.value = previousAttachments
    } else {
      void discardAttachments(previousAttachments)
    }
    showError(error)
  } finally {
    sending.value = false
  }
}

async function stopRun() {
  if (!activeGroup.value) return
  try { await workspace.value.stop(activeGroup.value.id) } catch (error) { showError(error) }
}

function openAgentManager(kind = '') {
  openSystemSettings('agents', kind)
}

function openSystemSettings(section = 'agents', kind = '') {
  if (saving.value) return
  if (modal.value) closeModal()
  activeView.value = 'settings'
  systemSettingsSection.value = section === 'providers'
    ? 'providers'
    : section === 'knowledge-bases'
      ? 'knowledge-bases'
      : 'agents'
  focusedAgentKind.value = systemSettingsSection.value === 'agents' ? kind : ''
  installConfirmKind.value = ''
  formError.value = ''
  providerRemoveArmed.value = false
  if (systemSettingsSection.value === 'providers') {
    const targetKind = EXTERNAL_PROVIDER_KINDS.has(kind) ? kind : selectedProviderKind.value
    void loadProviderWorkspace(targetKind, { probeSelected: true })
  } else if (systemSettingsSection.value === 'knowledge-bases') {
    void loadKnowledgeBaseStatuses()
  }
}

function selectSystemSettingsSection(section) {
  if (section === systemSettingsSection.value) return
  systemSettingsSection.value = section === 'providers'
    ? 'providers'
    : section === 'knowledge-bases'
      ? 'knowledge-bases'
      : 'agents'
  formError.value = ''
  providerRemoveArmed.value = false
  if (systemSettingsSection.value === 'providers') {
    const targetKind = selectedProviderKind.value
    void loadProviderWorkspace(targetKind, { probeSelected: true })
  } else if (systemSettingsSection.value === 'knowledge-bases') {
    void loadKnowledgeBaseStatuses()
  }
}

function openAgentDetail(agent) {
  if (!agent || saving.value) return
  activeView.value = 'settings'
  systemSettingsSection.value = 'agents'
  focusedAgentKind.value = agent.kind
  installConfirmKind.value = ''
  formError.value = ''
  customAgentDeleteArmed.value = false
  selectedAgentDetailKind.value = agent.kind
  agentDetailSkillItems.value = []
  agentDetailSkillsLoading.value = false
  modal.value = 'agent-detail'
  void loadAgentDetailSkills(agent.kind)
}

async function setAgentSidebarVisibility(agent, visible) {
  if (!agent?.kind || typeof installer.value?.setSidebarVisibility !== 'function' || saving.value) return
  saving.value = true
  formError.value = ''
  try {
    snapshot.value = normalizeSnapshot(await installer.value.setSidebarVisibility(agent.kind, visible === true))
  } catch (error) {
    formError.value = translateError(error)
  } finally {
    saving.value = false
  }
}

async function deleteCustomAgent() {
  const agent = selectedAgentDetail.value
  if (!agent?.custom || typeof customAgent.value?.delete !== 'function' || saving.value) return
  if (!customAgentDeleteArmed.value) {
    customAgentDeleteArmed.value = true
    return
  }
  saving.value = true
  formError.value = ''
  try {
    await customAgent.value.delete(agent.kind)
    closeModal({ force: true })
    focusedAgentKind.value = ''
    await refreshAgents()
  } catch (error) {
    formError.value = translateError(error)
    customAgentDeleteArmed.value = false
  } finally {
    saving.value = false
  }
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

function requestUnlimitedRounds() {
  if (unlimitedRounds.value) return
  modal.value = 'unlimited-confirm'
}

function confirmUnlimitedRounds() {
  unlimitedRounds.value = true
  closeModal()
}

async function loadProviderStatus(kind, { probeEncryption = false, trackPending = true } = {}) {
  if (!provider.value || !EXTERNAL_PROVIDER_KINDS.has(kind)) {
    return { status: EMPTY_PROVIDER_STATUS, applied: false }
  }
  const requestToken = ++providerStatusRequestSequence
  providerStatusRequestTokens.set(kind, requestToken)
  if (trackPending) setProviderStatusPending(kind, true)
  try {
    const status = await (probeEncryption ? provider.value.probe(kind) : provider.value.status(kind))
    const applied = providerStatusRequestTokens.get(kind) === requestToken
    if (applied) providerStatuses.value = { ...providerStatuses.value, [kind]: status }
    return { status: applied ? status : providerStatusFor(kind), applied }
  } catch {
    const unavailable = { ...EMPTY_PROVIDER_STATUS, error: true }
    const applied = providerStatusRequestTokens.get(kind) === requestToken
    if (applied) providerStatuses.value = { ...providerStatuses.value, [kind]: unavailable }
    return { status: applied ? unavailable : providerStatusFor(kind), applied }
  } finally {
    if (trackPending && providerStatusRequestTokens.get(kind) === requestToken) {
      setProviderStatusPending(kind, false)
    }
  }
}

async function retryProviderStatus(kind) {
  const targetKind = String(kind || '')
  if (!EXTERNAL_PROVIDER_KINDS.has(targetKind) || saving.value) {
    return { status: EMPTY_PROVIDER_STATUS, applied: false }
  }
  const nextStatuses = { ...providerStatuses.value }
  delete nextStatuses[targetKind]
  providerStatuses.value = nextStatuses
  const result = await loadProviderStatus(targetKind, { probeEncryption: true })
  if (result.applied && selectedProviderKind.value === targetKind && !result.status.error) syncProviderForm(targetKind)
  return result
}

async function loadProviderWorkspace(targetKind = '', { probeSelected = false } = {}) {
  const selectedKind = EXTERNAL_PROVIDER_KINDS.has(targetKind) ? targetKind : ''
  if (selectedKind) {
    selectedProviderKind.value = selectedKind
    formError.value = ''
    providerRemoveArmed.value = false
    syncProviderForm(selectedKind)
  }
  const agents = configurableProviderAgents.value
  const results = await Promise.all(agents.map(agent => loadProviderStatus(agent.kind, {
    probeEncryption: probeSelected && agent.kind === selectedKind,
    trackPending: Boolean(selectedKind && agent.kind === selectedKind),
  })))
  const selectedResult = results[agents.findIndex(agent => agent.kind === selectedKind)]
  if (selectedKind
      && selectedProviderKind.value === selectedKind
      && selectedResult?.applied
      && !selectedResult.status.error) {
    syncProviderForm(selectedKind)
  }
  return results
}

function normalizeKnowledgeBaseStatuses(sources) {
  const sourceMap = new Map((Array.isArray(sources) ? sources : [])
    .filter(source => source?.kind)
    .map(source => [source.kind, source]))
  return KNOWLEDGE_BASE_CATALOG.map((definition) => {
    const source = sourceMap.get(definition.kind)
    if (source) {
      return {
        ...source,
        kind: definition.kind,
        accessMode: source.accessMode || definition.accessMode,
      }
    }
    return {
      ...definition.defaultState,
      kind: definition.kind,
      accessMode: definition.accessMode,
      probeState: 'unknown',
      errorCode: 'KNOWLEDGE_BASE_STATUS_MISSING',
    }
  })
}

function fallbackKnowledgeBaseStatuses(errorCode = 'KNOWLEDGE_BASE_STATUS_MISSING', probeState = 'unknown') {
  return KNOWLEDGE_BASE_CATALOG.map(source => ({
    ...source.defaultState,
    kind: source.kind,
    accessMode: source.accessMode,
    probeState,
    errorCode,
  }))
}

function mergeKnowledgeBaseStatuses(nextSources) {
  const sourceMap = new Map(knowledgeBaseSources.value.map(source => [source.kind, source]))
  for (const source of (Array.isArray(nextSources) ? nextSources : [])) {
    if (!source?.kind) continue
    const definition = KNOWLEDGE_BASE_CATALOG.find(item => item.kind === source.kind)
    if (!definition) continue
    sourceMap.set(definition.kind, {
      ...source,
      kind: definition.kind,
      accessMode: source.accessMode || definition.accessMode,
    })
  }
  return KNOWLEDGE_BASE_CATALOG.map((definition) => {
    const source = sourceMap.get(definition.kind)
    if (source) return source
    return {
      ...definition.defaultState,
      kind: definition.kind,
      accessMode: definition.accessMode,
      probeState: 'unknown',
      errorCode: 'KNOWLEDGE_BASE_STATUS_MISSING',
    }
  })
}

async function loadKnowledgeBaseStatuses(targetKind = '') {
  const selectedKind = String(targetKind || '').trim()
  if (!knowledgeBase.value?.status) {
    const fallback = fallbackKnowledgeBaseStatuses('LOCAL_KNOWLEDGE_BASE_UNAVAILABLE', 'error')
    knowledgeBaseSources.value = fallback
    return fallback
  }
  if (!selectedKind && knowledgeBaseStatusPromise) return knowledgeBaseStatusPromise
  if (selectedKind) {
    knowledgeBaseRefreshingKinds.add(selectedKind)
  } else {
    knowledgeBaseLoading.value = true
  }
  const request = (async () => {
    try {
      const sources = await knowledgeBase.value.status(selectedKind || undefined)
      knowledgeBaseSources.value = selectedKind
        ? mergeKnowledgeBaseStatuses(sources)
        : normalizeKnowledgeBaseStatuses(sources)
      return knowledgeBaseSources.value
    } catch (error) {
      showError(error)
      const fallback = selectedKind
        ? mergeKnowledgeBaseStatuses([{
            kind: selectedKind,
            ...(KNOWLEDGE_BASE_CATALOG.find(source => source.kind === selectedKind)?.defaultState || {}),
            accessMode: KNOWLEDGE_BASE_CATALOG.find(source => source.kind === selectedKind)?.accessMode || 'cli',
            probeState: 'error',
            errorCode: errorCode(error) || 'KNOWLEDGE_BASE_PROBE_FAILED',
          }])
        : fallbackKnowledgeBaseStatuses(errorCode(error) || 'KNOWLEDGE_BASE_PROBE_FAILED', 'error')
      knowledgeBaseSources.value = fallback
      return fallback
    } finally {
      if (selectedKind) knowledgeBaseRefreshingKinds.delete(selectedKind)
      else knowledgeBaseLoading.value = false
    }
  })()
  if (!selectedKind) {
    knowledgeBaseStatusPromise = request
    try {
      return await request
    } finally {
      if (knowledgeBaseStatusPromise === request) knowledgeBaseStatusPromise = null
    }
  }
  return request
}

function syncProviderForm(kind) {
  const status = providerStatusFor(kind)
  const preset = status.activePreset || inferProviderPreset(kind, status)
  fillProviderFormFromPreset(kind, preset)
  if (status.configured && !providerProfilesFor(kind)[preset]) {
    providerForm.provider = status.provider || providerForm.provider
    providerForm.baseUrl = status.baseUrl || providerForm.baseUrl
    providerForm.model = status.model || providerForm.model
  }
  providerForm.apiKey = ''
}

async function selectProviderAgent(kind) {
  if (!EXTERNAL_PROVIDER_KINDS.has(kind) || saving.value) return
  selectedProviderKind.value = kind
  formError.value = ''
  providerRemoveArmed.value = false
  syncProviderForm(kind)
  const result = await loadProviderStatus(kind, { probeEncryption: true })
  if (result.applied && selectedProviderKind.value === kind && !result.status.error) syncProviderForm(kind)
}

function openProvider(kind = '') {
  if (saving.value) return
  openSystemSettings('providers', EXTERNAL_PROVIDER_KINDS.has(kind) ? kind : selectedProviderKind.value)
}

async function activateProviderPreset(presetId) {
  if (saving.value || providerPresetActive(presetId) || !providerPresetConfigured(presetId)) return
  if (typeof provider.value?.activate !== 'function') {
    formError.value = t('provider.switchUnavailable')
    return
  }
  saving.value = true
  formError.value = ''
  try {
    const kind = selectedProviderKind.value
    await provider.value.activate(kind, presetId)
    const [result] = await Promise.all([
      loadProviderStatus(kind, { probeEncryption: true }),
      refreshAgents(),
    ])
    if (result.applied) syncProviderForm(kind)
  } catch (error) {
    formError.value = translateError(error)
  } finally {
    saving.value = false
  }
}

async function saveProvider() {
  formError.value = ''
  if (providerNativeOfficialMode.value) return
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
    const kind = selectedProviderKind.value
    await provider.value.save(kind, {
      preset: providerForm.preset,
      provider: providerForm.provider,
      baseUrl: providerForm.baseUrl,
      model: providerForm.model,
      apiKey: providerForm.apiKey,
    })
    providerForm.apiKey = ''
    const [result] = await Promise.all([
      loadProviderStatus(kind, { probeEncryption: true }),
      refreshAgents(),
    ])
    if (result.applied) syncProviderForm(kind)
  } catch (error) {
    formError.value = translateError(error)
  } finally {
    saving.value = false
  }
}

function knowledgeBaseComingSoon(source) {
  return Boolean(source && COMING_SOON_KNOWLEDGE_BASE_KINDS.has(source.kind))
}

function knowledgeBasePending(source) {
  if (!source || knowledgeBaseComingSoon(source)) return false
  return knowledgeBaseLoading.value
    || knowledgeBaseRefreshingKinds.has(source.kind)
    || ['idle', 'loading'].includes(source.probeState)
}

function knowledgeBaseConfigured(source) {
  if (!source) return false
  if (knowledgeBaseComingSoon(source)) return false
  if (source.probeState === 'error' || source.probeState === 'unknown') return false
  if (source.accessMode === 'vault') return Boolean(source.installed && source.vaultPath)
  if (source.accessMode === 'cli') {
    return Boolean(source.installed && source.loginState === 'ready')
  }
  return Boolean(source.configured || source.connected)
}

function knowledgeBaseReady(source) {
  if (!source) return false
  if (knowledgeBaseComingSoon(source)) return false
  if (source.probeState !== 'ready') return false
  if (source.accessMode === 'vault') {
    return Boolean(source.installed && source.vaultPath && source.vaultDetails?.directory && source.vaultDetails?.readable && source.vaultDetails?.writable)
  }
  if (source.accessMode === 'cli') {
    return knowledgeBaseCanRead(source)
  }
  return Boolean(source.configured && source.authState === 'ready' && source.permissionState === 'ready' && knowledgeBaseCanRead(source) && knowledgeBaseCanWrite(source))
}

function knowledgeBaseCanRead(source) {
  if (!source) return false
  if (knowledgeBaseComingSoon(source)) return false
  if (source.probeState !== 'ready') return false
  if (source.accessMode === 'vault') return Boolean(source.installed && source.vaultPath && source.vaultDetails?.directory && source.vaultDetails?.readable)
  if (source.accessMode === 'cli') {
    return Boolean(source.installed && source.loginState === 'ready' && source.permissionState === 'ready' && source.readable === true)
  }
  return Boolean(knowledgeBaseConfigured(source) && source.authState === 'ready' && source.permissionState === 'ready' && source.readable !== false)
}

function knowledgeBaseCanWrite(source) {
  if (!source) return false
  if (knowledgeBaseComingSoon(source)) return false
  if (source.probeState !== 'ready') return false
  if (source.accessMode === 'vault') return Boolean(source.installed && source.vaultPath && source.vaultDetails?.directory && source.vaultDetails?.writable)
  if (source.accessMode === 'cli') {
    return Boolean(source.installed && source.loginState === 'ready' && source.permissionState === 'ready' && source.writable === true)
  }
  return Boolean(knowledgeBaseConfigured(source) && source.authState === 'ready' && source.permissionState === 'ready' && source.writable !== false)
}

function knowledgeBaseModeLabel(source) {
  const key = {
    cli: 'cli',
    vault: 'vault',
    oauth: 'oauth',
    token: 'apiToken',
  }[source?.accessMode] || 'cli'
  return t(`knowledgeBase.tag.mode.${key}`)
}

function knowledgeBaseTone(source) {
  if (!source) return 'checking'
  if (knowledgeBaseComingSoon(source) || knowledgeBasePending(source)) return 'checking'
  if (source.probeState === 'error') return 'warning'
  if (source.probeState === 'unknown') return 'checking'
  if (knowledgeBaseReady(source)) return 'connected'
  if (source.accessMode === 'vault') return source.installed ? 'warning' : 'checking'
  if (source.accessMode === 'cli') {
    if (!source.installed) return 'warning'
    if (source.loginState === 'missing' || source.permissionState === 'needs-grant') return 'warning'
    return 'checking'
  }
  return knowledgeBaseConfigured(source) ? 'checking' : 'warning'
}

function knowledgeBaseIcon(source) {
  if (!source) return RefreshOutline
  if (knowledgeBaseComingSoon(source)) return CloudOutline
  if (knowledgeBasePending(source)) return RefreshOutline
  if (source.probeState === 'unknown') return WarningOutline
  if (knowledgeBaseReady(source)) return CheckmarkCircleOutline
  if (source?.probeState === 'error') return WarningOutline
  if (source.accessMode === 'vault') return source.installed ? WarningOutline : DownloadOutline
  if (source.accessMode === 'cli') {
    if (!source.installed) return DownloadOutline
    return source.loginState === 'missing' || source.permissionState === 'needs-grant'
      ? WarningOutline
      : RefreshOutline
  }
  if (!knowledgeBaseConfigured(source)) return CloudOutline
  if (source.authState === 'missing' || source.permissionState === 'needs-grant') return WarningOutline
  return RefreshOutline
}

function knowledgeBaseStatusLabel(source) {
  if (!source) return ''
  if (knowledgeBaseComingSoon(source)) return t('knowledgeBase.status.comingSoon')
  if (knowledgeBasePending(source)) return t('knowledgeBase.status.checking')
  if (source.probeState === 'error') return t('knowledgeBase.status.error')
  if (source.probeState === 'unknown') return t('knowledgeBase.status.unknown')
  if (knowledgeBaseReady(source)) return t('knowledgeBase.status.ready')
  if (source.accessMode === 'vault') {
    if (!source.installed) return t('knowledgeBase.status.obsidianMissing')
    if (!source.vaultPath) return t('knowledgeBase.status.obsidianNeedVault')
    if (!source.vaultDetails?.directory || !source.vaultDetails?.readable || !source.vaultDetails?.writable) {
      return t('knowledgeBase.status.needsPermission')
    }
    return t('knowledgeBase.status.ready')
  }
  if (source.accessMode === 'cli') {
    if (!source.installed) return t('knowledgeBase.status.cliMissing')
    if (source.loginState === 'missing') return t('knowledgeBase.status.needsLogin')
    if (source.permissionState === 'needs-grant') return t('knowledgeBase.status.needsPermission')
    if (source.loginState === 'ready' && source.permissionState === 'ready') return t('knowledgeBase.status.ready')
    if (source.loginState === 'unknown' || source.permissionState === 'unknown') return t('knowledgeBase.status.unknown')
    return t('knowledgeBase.status.checking')
  }
  if (!knowledgeBaseConfigured(source)) return t('knowledgeBase.status.notConfigured')
  if (source.authState === 'missing') return t('knowledgeBase.status.needsLogin')
  if (source.permissionState === 'needs-grant') return t('knowledgeBase.status.needsPermission')
  if (source.authState === 'unknown' || source.permissionState === 'unknown') return t('knowledgeBase.status.unknown')
  if (knowledgeBaseReady(source)) return t('knowledgeBase.status.ready')
  return t('knowledgeBase.status.checking')
}

function knowledgeBaseTagItems(source) {
  if (!source) return []
  return [
    {
      key: 'mode',
      label: knowledgeBaseModeLabel(source),
      tone: 'mode',
    },
  ]
}

function knowledgeBasePrimaryActionLabel(source) {
  if (!source) return ''
  if (knowledgeBaseComingSoon(source)) return t('knowledgeBase.action.viewDocumentation')
  if (knowledgeBasePending(source)) return t('knowledgeBase.status.checking')
  if (source.probeState === 'error' || source.probeState === 'unknown') return t('knowledgeBase.action.recheck')
  if (source.accessMode === 'vault') {
    if (!source.installed) return t('knowledgeBase.action.installObsidian')
    if (!source.vaultPath) return t('knowledgeBase.action.pickDirectory')
    return t('knowledgeBase.action.changeDirectory')
  }
  if (source.accessMode === 'cli') {
    if (!source.installed) return t('knowledgeBase.action.installCli')
    if (source.loginState === 'missing') return t('knowledgeBase.action.goLogin')
    if (source.permissionState === 'needs-grant') return t('knowledgeBase.action.grantPermission')
    return t('knowledgeBase.action.recheck')
  }
  if (!knowledgeBaseConfigured(source)) return t('knowledgeBase.action.openSetupGuide')
  if (source.authState === 'missing') return t('knowledgeBase.action.goLogin')
  if (source.permissionState === 'needs-grant') return t('knowledgeBase.action.grantPermission')
  return t('knowledgeBase.action.recheck')
}

function knowledgeBaseLocationLabel(source) {
  if (!source) return ''
  if (source.accessMode === 'vault') return source.vaultPath || ''
  return ''
}

async function runKnowledgeBasePrimaryAction(source) {
  if (!source || !knowledgeBase.value) return
  if (knowledgeBasePending(source)) return
  if (knowledgeBaseComingSoon(source)) return
  if (source.probeState === 'error' || source.probeState === 'unknown') {
    await loadKnowledgeBaseStatuses(source.kind)
    return
  }
  if (source.accessMode === 'vault') {
    if (!source.installed) {
      await knowledgeBase.value.openGuide?.(source.kind, 'install')
      return
    }
    try {
      const next = await knowledgeBase.value.pickObsidianVault?.()
      if (Array.isArray(next)) knowledgeBaseSources.value = next
      else await loadKnowledgeBaseStatuses()
    } catch (error) {
      showError(error)
    }
    return
  }
  if (source.accessMode === 'cli') {
    if (!source.installed) {
      await knowledgeBase.value.openGuide?.(source.kind, 'install')
      return
    }
    if (source.loginState === 'missing') {
      await knowledgeBase.value.openGuide?.(source.kind, 'login')
      return
    }
    if (source.permissionState === 'needs-grant') {
      await knowledgeBase.value.openGuide?.(source.kind, 'permission')
      return
    }
    await loadKnowledgeBaseStatuses(source.kind)
    return
  }
  if (!knowledgeBaseConfigured(source)) {
    await knowledgeBase.value.openGuide?.(source.kind, 'install')
    return
  }
  if (source.authState === 'missing') {
    await knowledgeBase.value.openGuide?.(source.kind, 'login')
    return
  }
  if (source.permissionState === 'needs-grant') {
    await knowledgeBase.value.openGuide?.(source.kind, 'permission')
    return
  }
  await loadKnowledgeBaseStatuses(source.kind)
}

async function removeProvider() {
  if (saving.value) return
  if (!providerRemoveArmed.value) {
    providerRemoveArmed.value = true
    return
  }
  saving.value = true
  try {
    const kind = selectedProviderKind.value
    const preset = providerForm.preset
    await provider.value.delete(kind, preset)
    const [result] = await Promise.all([
      loadProviderStatus(kind, { probeEncryption: true }),
      refreshAgents(),
    ])
    providerRemoveArmed.value = false
    if (result.applied) fillProviderFormFromPreset(kind, preset)
    providerForm.apiKey = ''
  } catch (error) {
    formError.value = translateError(error)
  } finally {
    saving.value = false
  }
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
  selectedAgentDetailKind.value = ''
  agentDetailSkillToken += 1
  agentDetailSkillItems.value = []
  agentDetailSkillsLoading.value = false
  return true
}

function notify(message) {
  toastMessage.value = message
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toastMessage.value = '' }, 3600)
}

function showCopyToast() {
  copyToastMessage.value = t('conversation.copySuccess')
  clearTimeout(copyToastTimer)
  copyToastTimer = setTimeout(() => { copyToastMessage.value = '' }, 1500)
}

function dismissToast() {
  clearTimeout(toastTimer)
  toastMessage.value = ''
}

function normalizeRunFinishedStatus(status) {
  const normalized = String(status || '').trim().toLowerCase()
  return RUN_FINISHED_STATUSES.has(normalized) ? normalized : 'failed'
}

function latestTopLevelUserMessage(groupId) {
  return snapshot.value.messages.filter(message => (
    message.groupId === groupId && message.role === 'user' && !message.threadRootId
  )).at(-1) || null
}

function rememberRunFinishedTurn(event, group) {
  const groupId = String(event?.groupId || '')
  const rootId = String(event?.threadRootId || '')
    || (group?.conversationType === 'direct' ? latestTopLevelUserMessage(groupId)?.id : '')
  if (!groupId || !rootId) return false
  const next = new Map(runFinishedTurnStatuses.value)
  next.set(runFinishedTurnKey(groupId, rootId), normalizeRunFinishedStatus(event?.status))
  runFinishedTurnStatuses.value = next
  return true
}

function handleRunFinished(event) {
  const groupId = String(event?.groupId || '')
  if (!groupId) return
  const group = snapshot.value.groups.find(item => item.id === groupId)
  const normalizedEvent = {
    groupId,
    status: normalizeRunFinishedStatus(event?.status),
    threadRootId: String(event?.threadRootId || ''),
  }
  if (!group || !rememberRunFinishedTurn(normalizedEvent, group)) {
    pendingRunFinishedEvents.set(groupId, {
      ...normalizedEvent,
    })
    if (!group) return
  } else {
    pendingRunFinishedEvents.delete(groupId)
  }
  if (group.conversationType !== 'direct' || selectedGroupId.value === groupId) return
  if (normalizedEvent.status !== 'completed') {
    if (finishedDirectGroupIds.value.has(groupId)) {
      const next = new Set(finishedDirectGroupIds.value)
      next.delete(groupId)
      finishedDirectGroupIds.value = next
    }
    return
  }
  finishedDirectGroupIds.value = new Set([...finishedDirectGroupIds.value, groupId])
}

function flushPendingRunFinishedEvents() {
  const readyEvents = [...pendingRunFinishedEvents.entries()].filter(([groupId]) => (
    snapshot.value.groups.some(group => group.id === groupId)
  ))
  for (const [groupId] of readyEvents) pendingRunFinishedEvents.delete(groupId)
  for (const [, event] of readyEvents) {
    handleRunFinished(event)
  }
}

function openPendingRequestedGroup() {
  if (!pendingRequestedGroupId
      || !snapshot.value.groups.some(group => group.id === pendingRequestedGroupId)) return false
  const groupId = pendingRequestedGroupId
  pendingRequestedGroupId = ''
  selectGroup(groupId)
  return true
}

function handleOpenGroup(event) {
  const groupId = String(event?.groupId || '')
  if (!groupId) return
  pendingRequestedGroupId = groupId
  openPendingRequestedGroup()
}

function showError(error) {
  console.error('[Meldwork]', errorCode(error))
  notify(translateError(error))
}

function handleMessageScroll() {
  const scroller = messageScroller.value
  if (!scroller) return
  const remaining = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
  messageNearBottom.value = remaining <= 96
}

async function scrollToLatest({ force = false } = {}) {
  await nextTick()
  const scroller = messageScroller.value
  if (!scroller || (!force && !messageNearBottom.value)) return
  scroller.scrollTop = scroller.scrollHeight
  messageNearBottom.value = true
}

async function boot() {
  applyTheme(theme.value)
  setCustomAgentProfiles([])
  if (!workspace.value || !installer.value || !provider.value) {
    bridgeMissing.value = true
    booting.value = false
    return
  }
  try {
    unsubscribeWorkspace = workspace.value.onChanged?.((value) => { snapshot.value = normalizeSnapshot(value) }) || null
    unsubscribeRunEvent = workspace.value.onRunEvent?.(handleRunEvent) || null
    unsubscribeRunFinished = workspace.value.onRunFinished?.(handleRunFinished) || null
    unsubscribeOpenGroup = workspace.value.onOpenGroup?.(handleOpenGroup) || null
    unsubscribeInstaller = installer.value.onChanged?.((value) => { installerState.value = value }) || null
    const [nextSnapshot, nextInstaller, nextDirectory] = await Promise.all([
      settleWithin(workspace.value.get()),
      settleWithin(installer.value.state()),
      settleWithin(workspace.value.defaultDirectory()),
    ])
    if (nextSnapshot) snapshot.value = normalizeSnapshot(nextSnapshot)
    installerState.value = nextInstaller || installerState.value
    defaultDirectory.value = nextDirectory || ''
  } catch (error) {
    showError(error)
  } finally {
    booting.value = false
  }
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
}

function focusOverlay(dialog) {
  void nextTick(() => dialog.value?.focus())
}

function trapOverlayFocus(event) {
  if (event.key !== 'Tab' || !blockingOverlayOpen.value) return false
  const dialog = onboardingVisible.value ? onboardingDialog.value : modalDialog.value
  if (!dialog) return false
  const focusable = [...dialog.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
  )]
  if (!focusable.length) {
    event.preventDefault()
    dialog.focus()
    return true
  }
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  const focusOutside = !dialog.contains(document.activeElement)
  if (event.shiftKey && (focusOutside || document.activeElement === first)) {
    event.preventDefault()
    last.focus()
    return true
  }
  if (!event.shiftKey && (focusOutside || document.activeElement === last)) {
    event.preventDefault()
    first.focus()
    return true
  }
  return false
}

function selectAdjacentConversation(direction) {
  const groups = [...snapshot.value.groups].sort(sortByUpdated)
  if (!groups.length) return
  const activeIndex = groups.findIndex(group => group.id === selectedGroupId.value)
  const nextIndex = activeIndex < 0
    ? 0
    : (activeIndex + direction + groups.length) % groups.length
  selectGroup(groups[nextIndex].id)
}

function handleWindowKeydown(event) {
  if (trapOverlayFocus(event)) return
  if (event.key === 'Escape') {
    if (messageDeleteArmedId.value) {
      messageDeleteArmedId.value = ''
      return
    }
    if (collapsedGroupMenuOpen.value) {
      closeCollapsedGroupMenu({ restoreFocus: true })
      return
    }
    if (shortcutMenuOpen.value) {
      shortcutMenuOpen.value = false
      return
    }
    if (tracePanelOpen.value) {
      closeTracePanel()
      return
    }
    if (sidebarDeleteGroupId.value) {
      sidebarDeleteGroupId.value = ''
      return
    }
    if (onboardingVisible.value) {
      completeOnboarding()
      return
    }
    if (modal.value === 'settings' && deleteArmed.value) {
      deleteArmed.value = false
      return
    }
    if (modal.value === 'agent-detail' && customAgentDeleteArmed.value) {
      customAgentDeleteArmed.value = false
      return
    }
    if (modal.value) {
      closeModal()
      return
    }
    if (roundSettingsOpen.value) {
      roundSettingsOpen.value = false
      return
    }
    if (skillMenuOpen.value) {
      skillMenuOpen.value = false
      return
    }
    return
  }
  if (event.isComposing || event.altKey || (!event.metaKey && !event.ctrlKey)) return
  const key = String(event.key || '').toLowerCase()
  if (key === 'b') {
    event.preventDefault()
    closeCollapsedGroupMenu()
    sidebarCollapsed.value = !sidebarCollapsed.value
    shortcutMenuOpen.value = false
    return
  }
  if (key === 'g') {
    event.preventDefault()
    closeCollapsedGroupMenu()
    shortcutMenuOpen.value = false
    openNewGroup()
    return
  }
  if (key === '[' || key === ']') {
    event.preventDefault()
    closeCollapsedGroupMenu()
    shortcutMenuOpen.value = false
    selectAdjacentConversation(key === '[' ? -1 : 1)
    return
  }
  if (key === ',') {
    event.preventDefault()
    closeCollapsedGroupMenu()
    shortcutMenuOpen.value = false
    openSystemSettings('agents')
  }
}

function handleWindowPointerDown(event) {
  const target = event.target
  if (
    messageDeleteArmedId.value
    && !(target instanceof Element && target.closest('.message-delete-button'))
  ) {
    messageDeleteArmedId.value = ''
  }
  if (
    sidebarDeleteGroupId.value
    && !(target instanceof Element && target.closest('.sidebar-delete-control, .sidebar-delete-popover'))
  ) {
    sidebarDeleteGroupId.value = ''
  }
  if (roundSettingsOpen.value && !roundSettingsControl.value?.contains(target)) {
    roundSettingsOpen.value = false
  }
  if (shortcutMenuOpen.value && !shortcutMenu.value?.contains(target)) {
    shortcutMenuOpen.value = false
  }
  if (
    collapsedGroupMenuOpen.value
    && !collapsedGroupMenuButton.value?.contains(target)
    && !collapsedGroupMenu.value?.contains(target)
  ) {
    closeCollapsedGroupMenu()
  }
}

function handlePopState() {
  if (tracePanelOpen.value) {
    closeTracePanel({ fromHistory: true })
    return
  }
  if (!blockingOverlayOpen.value) return
  if (modal.value && saving.value) {
    history.pushState({ roundrelayOverlay: true }, '', window.location.href)
    modalHistoryPushed = true
    return
  }
  modalHistoryPushed = false
  if (onboardingVisible.value) completeOnboarding({ fromHistory: true })
  else closeModal()
}

watch(theme, applyTheme)
watch(sidebarCollapsed, (collapsed) => {
  if (!collapsed) closeCollapsedGroupMenu()
})
watch(onboardingVisible, (value) => {
  if (value) {
    focusOverlay(onboardingDialog)
    if (!onboardingPlaybackTimer && !onboardingPlaybackComplete.value) startOnboardingPlayback()
    return
  }
  clearOnboardingPlayback()
})
watch(modal, (value, previous) => {
  if (value) closeCollapsedGroupMenu()
  if (value && !previous) {
    const active = document.activeElement
    modalFocusReturn = active instanceof HTMLElement && active !== document.body ? active : null
  }
  if (value) {
    focusOverlay(modalDialog)
    return
  }
  if (!previous) return
  const target = modalFocusReturn
  modalFocusReturn = null
  void nextTick(() => {
    if (target?.isConnected && typeof target.focus === 'function') target.focus()
  })
})
watch(
  [
    activeView,
    selectedGroupId,
    () => snapshot.value.groups.some(group => group.id === tracePanelGroupId.value),
    () => tracePanelItems.value.length,
  ],
  ([view, groupId, traceGroupExists, traceItemCount]) => {
    if (!tracePanelOpen.value) return
    if (
      view === 'conversation'
      && groupId === tracePanelGroupId.value
      && traceGroupExists
      && traceItemCount > 0
    ) return
    closeTracePanel({ fromHistory: blockingOverlayOpen.value })
  },
)
watch(blockingOverlayOpen, (value, previous) => {
  if (value && !previous && tracePanelOpen.value) closeTracePanel({ fromHistory: true })
  document.body.classList.toggle('modal-open', Boolean(value))
  if (value && !previous) {
    history.pushState({ roundrelayOverlay: true }, '', window.location.href)
    modalHistoryPushed = true
  } else if (!value && previous && modalHistoryPushed) {
    modalHistoryPushed = false
    history.back()
  }
})
watch(traceDrawerBlocking, (value) => {
  document.body.classList.toggle('trace-drawer-open', Boolean(value))
})
watch(() => snapshot.value.groups.map(group => group.id).join('\u0000'), () => {
  openPendingRequestedGroup()
  if (selectedGroupId.value && !snapshot.value.groups.some(group => group.id === selectedGroupId.value)) {
    selectedGroupId.value = ''
    if (activeView.value === 'conversation') activeView.value = 'home'
  } else if (activeView.value === 'conversation' && !selectedGroupId.value) {
    activeView.value = 'home'
  }
  flushPendingRunFinishedEvents()
})
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
  activeTurnId.value = ''
  discussionMode.value = group?.conversationType === 'direct' ? 'manual' : 'auto'
  roundSettingsOpen.value = false
  targetKinds.value = group ? [...group.agentKinds] : []
  selectedAgentKinds.value = []
  activeMentionAgentKind.value = ''
  selectedSkills.value = []
  selectedKnowledgeBases.value = []
  composerAttachments.value = []
  void discardAttachments(abandonedAttachments)
  skillMenuOpen.value = false
  skillsLoading.value = false
  messageNearBottom.value = true
  void scrollToLatest({ force: true })
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
watch(skillTargetSignature, () => {
  const targets = new Set(composerTargetKinds.value)
  selectedSkills.value = selectedSkills.value.filter(skill => targets.has(skill.targetKind))
  selectedKnowledgeBases.value = selectedKnowledgeBases.value
    .map(source => ({
      ...source,
      targetKinds: source.targetKinds.filter(kind => targets.has(kind)),
    }))
    .filter(source => source.targetKinds.length)
  skillOptions.value = []
  skillActiveIndex.value = 0
  skillsLoading.value = false
  skillLoadToken += 1
  if (skillMenuOpen.value && currentSkillTrigger.value) void loadSkillsForTargets()
})
watch(() => composerMenuOptions.value.length, (length) => {
  skillActiveIndex.value = length ? Math.min(skillActiveIndex.value, length - 1) : 0
})
watch(
  [draft, () => composerAttachments.value.length, activeGroupMemberSignature],
  scheduleComposerResize,
  { flush: 'post' },
)
watch(() => activeMessages.value.length, () => { void scrollToLatest() })
watch(liveOutputSignature, () => { void scrollToLatest() })
watch(conversationEmptyVisible, (visible) => {
  if (visible) startEmptyShowcasePlayback()
  else clearEmptyShowcasePlayback()
}, { flush: 'post' })
watch(activeRunTopicSignature, (value) => { if (value) void focusRunTopic() })
watch(readyAgentSignature, (value) => { if (value) void loadAgentSkillStats() })
watch(() => installerState.value.phase, (phase, previous) => {
  if (phase === 'completed' && previous !== 'completed') void refreshAgents()
})

onMounted(() => {
  window.addEventListener('keydown', handleWindowKeydown)
  window.addEventListener('pointerdown', handleWindowPointerDown)
  window.addEventListener('popstate', handlePopState)
  if (typeof window.matchMedia === 'function') {
    tracePanelMediaQuery = window.matchMedia('(max-width: 1179px)')
    tracePanelDrawer.value = tracePanelMediaQuery.matches
    tracePanelResizeHandler = () => { tracePanelDrawer.value = tracePanelMediaQuery?.matches === true }
    if (typeof tracePanelMediaQuery.addEventListener === 'function') {
      tracePanelMediaQuery.addEventListener('change', tracePanelResizeHandler)
    } else if (typeof tracePanelMediaQuery.addListener === 'function') {
      tracePanelMediaQuery.addListener(tracePanelResizeHandler)
    }
  }
  void boot()
})

onBeforeUnmount(() => {
  composerContextVersion.value += 1
  const abandonedAttachments = composerAttachments.value
  composerAttachments.value = []
  void discardAttachments(abandonedAttachments)
  window.removeEventListener('keydown', handleWindowKeydown)
  window.removeEventListener('pointerdown', handleWindowPointerDown)
  window.removeEventListener('popstate', handlePopState)
  document.body.classList.remove('modal-open')
  document.body.classList.remove('trace-drawer-open')
  if (tracePanelMediaQuery && tracePanelResizeHandler) {
    if (typeof tracePanelMediaQuery.removeEventListener === 'function') {
      tracePanelMediaQuery.removeEventListener('change', tracePanelResizeHandler)
    } else if (typeof tracePanelMediaQuery.removeListener === 'function') {
      tracePanelMediaQuery.removeListener(tracePanelResizeHandler)
    }
  }
  tracePanelMediaQuery = null
  tracePanelResizeHandler = null
  clearOnboardingPlayback()
  skillLoadToken += 1
  agentSkillStatsToken += 1
  agentDetailSkillToken += 1
  unsubscribeWorkspace?.()
  unsubscribeRunEvent?.()
  unsubscribeInstaller?.()
  unsubscribeRunFinished?.()
  unsubscribeOpenGroup?.()
  pendingRunFinishedEvents.clear()
  for (const timer of copiedMessageTimers.values()) clearTimeout(timer)
  copiedMessageTimers.clear()
  clearEmptyShowcasePlayback()
  clearTimeout(toastTimer)
  clearTimeout(copyToastTimer)
})
</script>
