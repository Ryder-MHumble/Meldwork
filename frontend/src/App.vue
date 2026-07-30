<template>
  <main class="app-shell" :class="{ 'sidebar-collapsed': sidebarCollapsed }" :data-theme="theme">
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
        :inert="blockingOverlayOpen ? '' : undefined"
        :aria-hidden="blockingOverlayOpen ? 'true' : undefined"
      >
        <header class="brand-row">
          <button class="brand-button" type="button" title="Meldwork" @click="goHome">
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
                  @click="openDirect(agent)"
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
              <div v-if="directGroupsFor(agent.kind).length" class="direct-session-list">
                <div
                  v-for="group in directGroupsFor(agent.kind)"
                  :key="group.id"
                  class="direct-session-row"
                  :class="{ active: selectedGroupId === group.id }"
                >
                  <button
                    class="direct-session-open"
                    type="button"
                    :title="t('nav.openDirect', { name: groupName(group) })"
                    @click="selectGroup(group.id)"
                  >
                    <span>{{ groupName(group) }}</span>
                    <time>{{ formatNavTime(group.updatedAt || group.createdAt) }}</time>
                  </button>
                  <span v-if="isGroupRunning(group.id)" class="run-mark" :title="t('conversation.runningGeneric')">
                    <span class="run-pulse" />
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
                    @click="openDirectRename(group)"
                  >
                    <PencilOutline />
                  </button>
                  <button
                    class="direct-session-action danger"
                    type="button"
                    :title="t('nav.deleteDirect', { name: groupName(group) })"
                    :aria-label="t('nav.deleteDirect', { name: groupName(group) })"
                    :disabled="isGroupRunning(group.id)"
                    @click="openDirectDelete(group)"
                  >
                    <TrashOutline />
                  </button>
                </div>
              </div>
            </article>
            <p v-if="!sidebarAgents.length" class="nav-empty">{{ t('nav.noSidebarAgents') }}</p>
          </section>

          <section class="nav-section group-nav-section">
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
                <span class="run-pulse" />
              </span>
            </button>
            <p v-if="!groupGroups.length" class="nav-empty">{{ t('nav.noGroups') }}</p>
          </section>
        </nav>

        <footer class="sidebar-footer">
          <button type="button" :title="t('nav.agents')" @click="openAgentManager">
            <TerminalOutline />
            <span>{{ t('nav.agents') }}</span>
            <span class="footer-count">{{ readyCount }}/{{ AGENTS.length }}</span>
          </button>
          <button type="button" :title="t('nav.provider')" @click="openProvider">
            <KeyOutline />
            <span>{{ t('nav.provider') }}</span>
            <CheckmarkCircleOutline v-if="providerStatus.configured" class="footer-status ready" />
            <WarningOutline v-else class="footer-status" />
          </button>
        </footer>
      </aside>

      <section
        class="workspace-pane"
        :inert="blockingOverlayOpen ? '' : undefined"
        :aria-hidden="blockingOverlayOpen ? 'true' : undefined"
      >
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
              <div class="workspace-preferences">
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
            </div>
          </header>

          <div class="home-summary">
            <strong>{{ t('home.readyCount', { ready: readyCount, installed: installedCount }) }}</strong>
          </div>

          <div class="agent-grid">
            <article v-for="agent in mergedCatalog" :key="agent.kind" class="agent-card">
              <button
                class="agent-card-main"
                type="button"
                :disabled="agent.ready && isDirectCreationPending(agent.kind)"
                @click="handleAgentPrimary(agent)"
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
                  <span class="agent-capability-list">
                    <span v-if="agent.ready">{{ agentSkillLabel(agent.kind) }}</span>
                    <span>{{ agentImageLabel(agent) }}</span>
                    <span>{{ providerModeShortLabel(agent.providerMode) }}</span>
                  </span>
                  <span v-if="agent.version" class="agent-version">
                    {{ t('agent.detectedVersion', { version: agent.version }) }}
                  </span>
                </span>
                <ChevronForwardOutline class="card-chevron" />
              </button>
              <div class="agent-card-actions">
                <button
                  v-if="agent.ready"
                  type="button"
                  :disabled="isDirectCreationPending(agent.kind)"
                  @click="openDirect(agent)"
                >
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
          <header class="conversation-header" :class="{ 'editing-title': inlineTitleEditing }">
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
              <div class="conversation-title-block">
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
              <div class="workspace-preferences">
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
            </div>
          </header>

          <div ref="messageScroller" class="message-scroll">
            <section v-if="!timelineMessages.length && !activeRun" class="conversation-empty">
              <div class="empty-icon">
                <ChatbubbleEllipsesOutline />
              </div>
              <h2>{{ t('conversation.emptyTitle') }}</h2>
              <p v-if="activeGroup.conversationType === 'direct'">
                {{ t('conversation.emptyDirect', { agent: agentLabel(activeGroup.directAgentKind) }) }}
              </p>
              <p v-else>{{ t('conversation.emptyGroup') }}</p>
            </section>

            <div v-else class="message-stage">
              <nav class="turn-rail" :aria-label="t('conversation.turnRail')">
                <button
                  v-for="turn in turnRailItems"
                  :key="turn.id"
                  type="button"
                  :class="{ active: activeTurnRailId === turn.id }"
                  :data-status="turn.status"
                  :title="turnRailLabel(turn)"
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
                      'topic-root': isTopicRoot(message),
                      'topic-reply': Boolean(messageThreadRootId(message)),
                      'active-topic': isActiveRunTopic(message),
                      copied: isMessageCopied(message.id),
                    },
                  ]"
                >
                <template v-if="message.role === 'system'">
                  <div class="system-message">
                    <WarningOutline />
                    <span>{{ translateSystemMessage(message) }}</span>
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
                      <span v-if="isActiveRunTopic(message)" class="active-topic-label">
                        {{ t('conversation.activeTopic') }}
                      </span>
                      <button
                        v-if="isTopicRoot(message)"
                        class="topic-toggle"
                        type="button"
                        :aria-expanded="isTopicExpanded(message.id) ? 'true' : 'false'"
                        :aria-label="topicToggleLabel(message.id)"
                        @click="toggleTopic(message.id)"
                      >
                        <ChevronDownOutline :class="{ collapsed: !isTopicExpanded(message.id) }" />
                        {{ topicReplyLabel(topicReplyCount(message.id)) }}
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
                    </div>
                    <template v-if="message.role === 'agent'">
                      <div
                        class="message-copy-surface"
                        :class="{ copied: isMessageCopied(message.id) }"
                        @click="copyMessageContent(message, $event)"
                      >
                        <MarkdownMessage :content="message.content" />
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
                    </template>
                    <template v-else>
                      <div
                        v-if="message.content"
                        class="message-content plain-message message-copy-surface"
                        :class="{ copied: isMessageCopied(message.id) }"
                        @click="copyMessageContent(message, $event)"
                      >
                        {{ message.content }}
                      </div>
                      <div v-if="messageSkills(message).length" class="message-skill-list">
                        <span v-for="skill in messageSkills(message)" :key="skillKey(skill)">
                          @{{ skill.name || skill.slug }}
                        </span>
                      </div>
                      <div v-if="messageAttachments(message).length" class="message-attachment-grid">
                        <figure
                          v-for="attachment in messageAttachments(message)"
                          :key="attachment.id"
                          v-attachment-preview="attachment"
                        >
                          <img
                            v-if="attachmentPreviewUrl(attachment)"
                            :src="attachmentPreviewUrl(attachment)"
                            :alt="attachment.name"
                            loading="lazy"
                            decoding="async"
                          />
                          <div v-else class="message-attachment-placeholder" aria-hidden="true">
                            <AttachOutline />
                          </div>
                          <figcaption :title="attachment.name">{{ attachment.name }}</figcaption>
                        </figure>
                      </div>
                    </template>
                  </div>
                </template>
              </article>

                <section
                  v-if="activeRun"
                  class="run-status-panel"
                  :class="activeGroup.conversationType === 'direct' ? 'direct' : 'group'"
                  aria-live="polite"
                >
                  <header class="run-status-header">
                    <div v-if="activeGroup.conversationType === 'direct'" class="direct-run-indicator" aria-hidden="true">
                      <img :src="agentLogo(activeRun.currentKind || activeGroup.directAgentKind)" alt="" />
                      <div class="typing-bars"><span /><span /><span /></div>
                    </div>
                    <div v-else class="relay-run-indicator" aria-hidden="true">
                      <img
                        v-for="kind in runTargetKinds.slice(0, 4)"
                        :key="kind"
                        :src="agentLogo(kind)"
                        alt=""
                        :class="{
                          current: runAgentStatus(kind) === 'running',
                          completed: runAgentStatus(kind) === 'completed',
                          failed: runAgentStatus(kind) === 'failed',
                        }"
                      />
                    </div>
                    <div>
                      <strong>{{ activeRunLabel }}</strong>
                      <span v-if="activeRunTopicRootId">{{ t('conversation.activeTopic') }}</span>
                      <span v-if="runRoundProgress" class="run-round-progress">
                        {{ t('run.roundProgress', runRoundProgress) }}
                      </span>
                    </div>
                  </header>
                  <div
                    v-if="activeGroup.conversationType !== 'direct'"
                    class="run-agent-list"
                    :aria-label="t('run.agents')"
                  >
                    <div
                      v-for="(kind, index) in runTargetKinds"
                      :key="kind"
                      class="run-agent-row"
                      :data-status="runAgentStatus(kind)"
                      :style="{ '--reveal-index': index }"
                    >
                      <img :src="agentLogo(kind)" alt="" />
                      <strong>{{ agentLabel(kind) }}</strong>
                      <small :class="runAgentStatus(kind)">{{ runStatusLabel(runAgentStatus(kind)) }}</small>
                    </div>
                  </div>
                  <details v-if="activeRunProgress.length" class="execution-details run-progress-details">
                    <summary>
                      <TerminalOutline />
                      <span>{{ t('run.progress') }}</span>
                      <small>{{ activeRunProgress.length }}</small>
                    </summary>
                    <ol>
                      <li v-for="(step, index) in activeRunProgress" :key="`${step.title}-${index}`">
                        <span>{{ localizedStepTitle(step, index) }}</span>
                        <small :class="runStatusTone(step.status)">{{ runStatusLabel(step.status) }}</small>
                      </li>
                    </ol>
                  </details>
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
                :aria-label="t('composer.skills')"
              >
                <p v-if="skillsLoading" class="skill-menu-state">{{ t('composer.skillsLoading') }}</p>
                <template v-else-if="filteredSkillOptions.length">
                  <button
                    v-for="(skill, index) in filteredSkillOptions"
                    :key="skillKey(skill)"
                    :id="`composer-skill-option-${index}`"
                    class="skill-option"
                    :class="{ active: skillActiveIndex === index }"
                    type="button"
                    role="option"
                    :aria-selected="skillActiveIndex === index"
                    :disabled="selectedSkills.length >= MAX_SKILLS"
                    @mouseenter="skillActiveIndex = index"
                    @click="selectSkill(skill)"
                  >
                    <span>
                      <strong>{{ skill.name || skill.slug }}</strong>
                      <small>{{ agentLabel(skill.targetKind) }} / {{ skill.namespace }}</small>
                    </span>
                    <AddOutline />
                  </button>
                </template>
                <p v-else class="skill-menu-state">
                  {{ selectedSkills.length >= MAX_SKILLS ? t('composer.skillLimit') : t('composer.noSkills') }}
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

                  <div class="target-row">
                    <span>{{ t('composer.targets') }}</span>
                    <div class="target-avatar-stack" role="group" :aria-label="t('composer.targets')">
                      <button
                        v-for="kind in activeGroup.agentKinds"
                        :key="kind"
                        class="target-chip"
                        :class="{ selected: isComposerTargetSelected(kind) }"
                        type="button"
                        :title="agentLabel(kind)"
                        :aria-label="discussionMode === 'auto'
                          ? t('composer.autoTarget', { agent: agentLabel(kind) })
                          : t(isComposerTargetSelected(kind) ? 'composer.removeTarget' : 'composer.addTarget', { agent: agentLabel(kind) })"
                        :aria-pressed="isComposerTargetSelected(kind)"
                        :disabled="Boolean(activeRun) || sending || discussionMode === 'auto'"
                        @click="toggleTarget(kind)"
                      >
                        <img :src="agentLogo(kind)" alt="" />
                        <span class="visually-hidden">{{ agentLabel(kind) }}</span>
                        <CheckmarkCircleOutline v-if="isComposerTargetSelected(kind)" class="target-selected-mark" />
                      </button>
                    </div>
                  </div>

                  <div v-if="discussionMode === 'auto'" class="round-stepper">
                    <span>{{ t('composer.maxRounds') }}</span>
                    <button
                      type="button"
                      class="round-stepper-decrease"
                      :title="t('composer.decreaseRounds')"
                      :aria-label="t('composer.decreaseRounds')"
                      :disabled="Boolean(activeRun) || sending || maxRounds <= 1"
                      @click="adjustMaxRounds(-1)"
                    >
                      <RemoveOutline />
                    </button>
                    <output aria-live="polite">{{ t('composer.autoRounds', { count: maxRounds }) }}</output>
                    <button
                      type="button"
                      class="round-stepper-increase"
                      :title="t('composer.increaseRounds')"
                      :aria-label="t('composer.increaseRounds')"
                      :disabled="Boolean(activeRun) || sending || maxRounds >= 10"
                      @click="adjustMaxRounds(1)"
                    >
                      <AddOutline />
                    </button>
                  </div>
                </div>

                <div v-if="composerAttachments.length" class="composer-attachment-list">
                  <article v-for="attachment in composerAttachments" :key="attachment.id" class="composer-attachment">
                    <img :src="attachment.previewDataUrl" :alt="attachment.name" />
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
                <div class="composer-actions">
                  <div class="composer-tools">
                    <button
                      class="composer-tool-button"
                      type="button"
                      :title="attachmentActionLabel"
                      :aria-label="attachmentActionLabel"
                      :disabled="Boolean(activeRun) || sending || importingAttachment || !composerTargetsReady || composerImageLimit <= composerAttachments.length"
                      @click="pickImages"
                    >
                      <RefreshOutline v-if="importingAttachment" class="spinning" />
                      <AttachOutline v-else />
                    </button>
                    <button
                      class="composer-tool-button"
                      type="button"
                      :title="t('composer.skills')"
                      :aria-label="t('composer.skills')"
                      :disabled="Boolean(activeRun) || sending || selectedSkills.length >= MAX_SKILLS"
                      @click="openSkillMenu"
                    >
                      <AtOutline />
                    </button>
                    <div v-if="selectedSkills.length" class="selected-skill-list">
                      <span v-for="skill in selectedSkills" :key="skillKey(skill)" class="selected-skill">
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
                    </div>
                  </div>

                  <div class="composer-run-actions">
                    <button v-if="activeRun" class="stop-button" type="button" @click="stopRun">
                      <StopCircleOutline />
                      {{ t('composer.stop') }}
                    </button>
                    <button v-else class="send-button" type="button" :disabled="!canSendMessage || sending" @click="sendMessage">
                      <PlayOutline v-if="composerMode === 'auto'" />
                      <SendOutline v-else />
                      <span>{{ sendButtonLabel }}</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </footer>
        </section>
      </section>

      <div v-if="onboardingVisible" class="onboarding-backdrop">
        <section
          ref="onboardingDialog"
          class="onboarding-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="onboarding-title"
          tabindex="-1"
        >
          <transition name="onboarding-slide" mode="out-in">
            <article :key="onboardingIndex" class="onboarding-slide">
              <img :src="onboardingSlide.image" alt="" />
              <div>
                <h1 id="onboarding-title">{{ onboardingSlide.title }}</h1>
                <p>{{ onboardingSlide.body }}</p>
              </div>
            </article>
          </transition>
          <footer class="onboarding-footer">
            <div class="onboarding-carousel-controls">
              <button
                class="icon-button"
                type="button"
                :title="t('onboarding.previous')"
                :aria-label="t('onboarding.previous')"
                @click="moveOnboarding(-1)"
              >
                <ChevronBackOutline />
              </button>
              <div class="onboarding-dots" :aria-label="t('onboarding.progress')">
                <button
                  v-for="(_slide, index) in onboardingSlides"
                  :key="index"
                  class="onboarding-dot"
                  :class="{ active: onboardingIndex === index }"
                  type="button"
                  :aria-label="t('onboarding.goToSlide', { count: index + 1 })"
                  :aria-current="onboardingIndex === index ? 'step' : undefined"
                  @click="onboardingIndex = index"
                />
              </div>
              <button
                class="icon-button"
                type="button"
                :title="t('onboarding.next')"
                :aria-label="t('onboarding.next')"
                @click="moveOnboarding(1)"
              >
                <ChevronForwardOutline />
              </button>
            </div>
            <button
              class="primary-button onboarding-primary"
              type="button"
              :disabled="onboardingOnLastSlide && onboardingDetecting"
              @click="advanceOnboarding"
            >
              <RefreshOutline v-if="onboardingOnLastSlide && onboardingDetecting" class="spinning" />
              <CheckmarkCircleOutline v-else-if="onboardingOnLastSlide" />
              <ChevronForwardOutline v-else />
              {{ onboardingOnLastSlide
                ? (onboardingDetecting ? t('onboarding.detecting') : t('onboarding.start'))
                : t('onboarding.continue') }}
            </button>
          </footer>
        </section>
      </div>

      <div v-if="modal" class="modal-backdrop" @mousedown.self="closeModal">
        <section
          ref="modalDialog"
          class="modal"
          :class="{ wide: modal === 'agents', medium: modal === 'new-group' || modal === 'settings' }"
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

          <form v-else-if="modal === 'settings'" class="modal-body form-stack" @submit.prevent="saveGroupSettings">
            <label>
              <span>{{ activeGroup?.conversationType === 'direct' ? t('settings.conversationName') : t('group.name') }}</span>
              <input ref="settingsNameInput" v-model.trim="settingsForm.name" maxlength="60" :disabled="saving" />
            </label>
            <label>
              <span>{{ t('group.topic') }}</span>
              <input v-model.trim="settingsForm.topic" maxlength="200" :disabled="saving" />
            </label>
            <fieldset v-if="activeGroup?.conversationType !== 'direct'" :disabled="saving">
              <legend class="agent-choice-legend">
                <span>{{ t('group.agents') }}</span>
                <small>{{ t('group.selectedCount', { count: settingsForm.agentKinds.length }) }}</small>
              </legend>
              <div class="agent-choice-grid">
                <label
                  v-for="agent in readyAgents"
                  :key="agent.kind"
                  class="agent-choice"
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
            <div class="danger-zone" :class="{ attention: settingsIntent === 'delete' }">
              <div>
                <strong>{{ t('settings.delete') }}</strong>
                <p>{{ t('settings.deleteHint') }}</p>
              </div>
              <button class="danger-button" type="button" :disabled="saving" @click="deleteConversation">
                <TrashOutline />
                {{ deleteArmed ? t('settings.deleteConfirm') : t('settings.delete') }}
              </button>
            </div>
            <footer class="modal-footer">
              <button class="secondary-button" type="button" :disabled="saving" @click="closeModal">{{ t('common.cancel') }}</button>
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
                  <button
                    v-if="agent.ready"
                    class="secondary-button compact"
                    type="button"
                    :disabled="isDirectCreationPending(agent.kind)"
                    @click="openDirect(agent)"
                  >
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
              <input v-model.trim="providerForm.provider" :placeholder="t('provider.namePlaceholder')" autocomplete="off" :disabled="saving" />
            </label>
            <label>
              <span>{{ t('provider.baseUrl') }}</span>
              <input v-model.trim="providerForm.baseUrl" :placeholder="t('provider.baseUrlPlaceholder')" inputmode="url" autocomplete="off" :disabled="saving" />
            </label>
            <label>
              <span>{{ t('provider.model') }}</span>
              <input v-model.trim="providerForm.model" :placeholder="t('provider.modelPlaceholder')" autocomplete="off" :disabled="saving" />
            </label>
            <label>
              <span>{{ t('provider.apiKey') }}</span>
              <input v-model="providerForm.apiKey" type="password" :placeholder="t('provider.apiKeyPlaceholder')" autocomplete="new-password" :disabled="saving" />
            </label>
            <p v-if="formError" class="form-error">{{ formError }}</p>
            <footer class="modal-footer provider-footer">
              <button v-if="providerStatus.configured" class="danger-button" type="button" :disabled="saving" @click="removeProvider">
                <TrashOutline />
                {{ providerRemoveArmed ? t('provider.removeConfirm') : t('provider.remove') }}
              </button>
              <span class="footer-spacer" />
              <button class="secondary-button" type="button" :disabled="saving" @click="closeModal">{{ t('common.cancel') }}</button>
              <button class="primary-button" type="submit" :disabled="saving || providerStatus.encryptionAvailable === false">
                {{ saving ? t('common.saving') : t('provider.save') }}
              </button>
            </footer>
          </form>
        </section>
      </div>

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
  FolderOpenOutline,
  KeyOutline,
  LanguageOutline,
  MoonOutline,
  PencilOutline,
  PeopleOutline,
  PersonOutline,
  PlayOutline,
  RefreshOutline,
  RemoveOutline,
  SendOutline,
  SettingsOutline,
  StopCircleOutline,
  SunnyOutline,
  TerminalOutline,
  TrashOutline,
  WarningOutline,
} from '@vicons/ionicons5'
import MarkdownMessage from './components/MarkdownMessage.vue'
import { AGENTS, agentLabel, agentLogo, publicAsset } from './catalog.js'
import { useAttachmentPreviews } from './composables/useAttachmentPreviews.js'
import { desktopApi, emptySnapshot, errorCode, normalizeSnapshot } from './desktop.js'
import { locale, setLocale, t, translateError, translateSystemMessage } from './i18n.js'

const snapshot = ref(emptySnapshot())
const ONBOARDING_KEY = 'roundrelay-onboarding-seen-v1'
const MAX_SKILLS = 4
const MAX_ATTACHMENTS = 4
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
const COMPOSER_INPUT_MIN_HEIGHT = 58
const COMPOSER_INPUT_MAX_HEIGHT = 180
const DISMISSIBLE_PLAN_WARNING = 'error: Cannot combine --prompt with --plan.'
const RUN_FINISHED_STATUSES = new Set([
  'completed', 'partial', 'failed', 'stopped', 'timeout', 'round-limit',
])
const READ_ONLY_ENFORCED_AGENT_KINDS = new Set([
  'codex', 'workbuddy', 'kimi', 'mimo', 'claude', 'qwen', 'gemini', 'opencode',
])
const installCatalog = ref({ platform: '', agents: [] })
const installerState = ref({ taskId: '', kind: '', phase: 'idle', canCancel: false, errorCode: '' })
const providerStatus = ref({ provider: '', baseUrl: '', model: '', configured: false, encryptionAvailable: true })
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
const selectedSkills = ref([])
const skillOptions = ref([])
const skillMenuOpen = ref(false)
const skillActiveIndex = ref(0)
const skillsLoading = ref(false)
const composerAttachments = ref([])
const attachmentImportOperations = ref([])
const composerContextVersion = ref(0)
const onboardingVisible = ref(false)
const onboardingIndex = ref(0)
const onboardingDetecting = ref(false)
const discussionMode = ref('auto')
const maxRounds = ref(6)
const formError = ref('')
const deleteArmed = ref(false)
const providerRemoveArmed = ref(false)
const installConfirmKind = ref('')
const focusedAgentKind = ref('')
const toastMessage = ref('')
const settingsIntent = ref('settings')
const agentSkillStats = ref({})
const inlineTitleEditing = ref(false)
const inlineTitleDraft = ref('')
const activeTurnId = ref('')
const copiedMessageIds = ref(new Set())
const collapsedTopicIds = ref(new Set())
const dismissedSystemMessageIds = ref(new Set())
const finishedDirectGroupIds = ref(new Set())
const runFinishedTurnStatuses = ref(new Map())
const messageScroller = ref(null)
const composerInput = ref(null)
const inlineTitleInput = ref(null)
const inlineTitleButton = ref(null)
const settingsNameInput = ref(null)
const onboardingDialog = ref(null)
const modalDialog = ref(null)
let toastTimer = null
const copiedMessageTimers = new Map()
let skillLoadToken = 0
let agentSkillStatsToken = 0
let attachmentImportSequence = 0
let unsubscribeWorkspace = null
let unsubscribeInstaller = null
let unsubscribeRunFinished = null
let unsubscribeOpenGroup = null
let modalHistoryPushed = false
let modalFocusReturn = null
let pendingRequestedGroupId = ''
const pendingRunFinishedEvents = new Map()

const api = computed(() => desktopApi())
const workspace = computed(() => api.value?.localWorkspace || null)
const installer = computed(() => api.value?.agentInstaller || null)
const provider = computed(() => api.value?.localAgentProvider || null)
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
const productMark = computed(() => publicAsset('logos/meldwork-mark.svg'))
const productAppIcon = computed(() => publicAsset('logos/meldwork-app.png'))
const onboardingSlides = computed(() => [
  {
    image: publicAsset('onboarding/discover-local-agents-meldwork.png'),
    title: t('onboarding.discoverTitle'),
    body: t('onboarding.discoverBody'),
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
])
const onboardingSlide = computed(() => onboardingSlides.value[onboardingIndex.value] || onboardingSlides.value[0])
const onboardingLastIndex = computed(() => Math.max(0, onboardingSlides.value.length - 1))
const onboardingOnLastSlide = computed(() => onboardingIndex.value === onboardingLastIndex.value)

const directGroups = computed(() => snapshot.value.groups
  .filter(group => group.conversationType === 'direct')
  .sort(sortByUpdated))
const groupGroups = computed(() => snapshot.value.groups
  .filter(group => group.conversationType !== 'direct')
  .sort(sortByUpdated))
const activeGroup = computed(() => snapshot.value.groups.find(group => group.id === selectedGroupId.value) || null)
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
const activeRunProgress = computed(() => Array.isArray(activeRun.value?.progress) ? activeRun.value.progress.slice(0, 8) : [])
const runTargetKinds = computed(() => {
  if (!activeRun.value) return []
  const targets = Array.isArray(activeRun.value.targetKinds) && activeRun.value.targetKinds.length
    ? activeRun.value.targetKinds
    : activeGroup.value?.agentKinds || []
  return [...new Set(targets)]
})
const runCompletedKinds = computed(() => {
  const targets = new Set(runTargetKinds.value)
  return [...new Set(activeRun.value?.completedKinds || [])].filter(kind => targets.has(kind))
})
const runFailedKinds = computed(() => {
  const targets = new Set(runTargetKinds.value)
  return [...new Set(activeRun.value?.failedKinds || [])].filter(kind => targets.has(kind))
})
const activeRunLabel = computed(() => {
  if (!activeRun.value || !activeGroup.value) return ''
  if (activeGroup.value.conversationType === 'direct') {
    return t('conversation.directWorking', {
      agent: agentLabel(activeRun.value.currentKind || activeGroup.value.directAgentKind),
    })
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
  if (!Number.isInteger(current) || current < 1 || !Number.isInteger(max) || max < current) return null
  return { current, max }
})
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
const timelineMessages = computed(() => activeMessages.value.filter((message) => {
  if (dismissedSystemMessageIds.value.has(message.id)) return false
  const rootId = messageThreadRootId(message)
  return !rootId || isTopicExpanded(rootId)
}))
const composerTargetKinds = computed(() => {
  const group = activeGroup.value
  if (!group) return []
  if (group.conversationType === 'direct' || discussionMode.value === 'auto') return [...group.agentKinds]
  return [...targetKinds.value]
})
const composerMode = computed(() => (
  activeGroup.value?.conversationType === 'direct' ? 'manual' : discussionMode.value
))
const sendButtonLabel = computed(() => t(composerMode.value === 'auto' ? 'composer.startAuto' : 'composer.send'))
const skillTargetSignature = computed(() => composerTargetKinds.value.join('\u0000'))
const currentSkillTrigger = computed(() => parseSkillTrigger(draft.value))
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
const activeSkillOptionId = computed(() => (
  skillMenuOpen.value && filteredSkillOptions.value[skillActiveIndex.value]
    ? `composer-skill-option-${skillActiveIndex.value}`
    : ''
))
const importingAttachment = computed(() => attachmentImportOperations.value
  .some(operation => operation.contextVersion === composerContextVersion.value))
const blockingOverlayOpen = computed(() => Boolean(modal.value || onboardingVisible.value))

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
    imageLimit: Number(detected.imageAttachmentLimit ?? installedProfile.imageAttachmentLimit ?? profile.imageLimit) || 0,
    installed: Boolean(installedProfile.installed || detected.installed),
    ready: detected.available === true,
  }
}))
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
const attachmentActionLabel = computed(() => {
  if (!composerTargetKinds.value.length) return t('composer.selectTarget')
  if (!composerTargetsReady.value) return t('error.agentUnavailable')
  return composerImageLimit.value > 0 ? t('composer.attachImages') : t('agent.noImages')
})
const canSendMessage = computed(() => (
  composerTargetsReady.value
  && (composerMode.value !== 'auto' || composerTargetKinds.value.length >= 2)
  && !importingAttachment.value
  && composerAttachments.value.length <= composerImageLimit.value
  && Boolean(draft.value.trim() || composerAttachments.value.length)
))
const readyCount = computed(() => readyAgents.value.length)
const installedCount = computed(() => mergedCatalog.value.filter(agent => agent.installed).length)

const groupForm = reactive({ name: '', topic: '', agentKinds: [], workdir: '', allowWrite: false })
const settingsForm = reactive({ name: '', topic: '', agentKinds: [], workdir: '', allowWrite: false })
const providerForm = reactive({ provider: '', baseUrl: '', model: '', apiKey: '' })

const modalTitle = computed(() => ({
  'new-group': t('group.newTitle'),
  settings: activeGroup.value?.conversationType === 'direct' && settingsIntent.value === 'rename'
    ? t('settings.renameDirectTitle')
    : t('settings.title'),
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

function directGroupsFor(kind) {
  return directGroups.value.filter(group => group.directAgentKind === kind)
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

function formatNavTime(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return navTimeFormatter.value.format(date)
}

function providerModeShortLabel(mode) {
  return t(`agent.providerShort.${mode}`)
}

function conversationPermissionLabel(group) {
  const kinds = Array.isArray(group?.agentKinds) ? group.agentKinds : []
  const enforced = kinds.length && kinds.every(kind => READ_ONLY_ENFORCED_AGENT_KINDS.has(kind))
  if (!enforced) return t('conversation.agentManagedPermissions')
  return group?.allowWrite ? t('conversation.writeEnabled') : t('conversation.readOnly')
}

function agentSkillLabel(kind) {
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
  const kinds = readyAgents.value.map(agent => agent.kind)
  const token = ++agentSkillStatsToken
  const next = { ...agentSkillStats.value }
  for (const kind of kinds) next[kind] = { loading: true, total: next[kind]?.total }
  agentSkillStats.value = next
  const results = await Promise.all(kinds.map(async (kind) => {
    try {
      const result = await installer.value.skills(kind)
      const total = Number.isFinite(Number(result?.total))
        ? Number(result.total)
        : Array.isArray(result?.skills) ? result.skills.length : NaN
      return [kind, result?.supported === false ? NaN : total]
    } catch {
      return [kind, NaN]
    }
  }))
  if (token !== agentSkillStatsToken) return
  agentSkillStats.value = Object.fromEntries(results.map(([kind, total]) => [kind, {
    loading: false,
    total: Number.isFinite(total) ? total : NaN,
  }]))
}

function topicReplyCount(rootId) {
  return topicReplyCounts.value.get(rootId) || 0
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
  return message?.role === 'user' && !message.threadRootId && topicReplyCount(message.id) > 0
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
  return t('conversation.turnRailLabel', {
    query: turn.query,
    time: turn.time || t('conversation.timeUnknown'),
    replies: topicReplyLabel(turn.replyCount),
    status: runStatusLabel(turn.status),
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

function localizedStepTitle(step, index) {
  const key = String(step?.title || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  const known = {
    process: 'run.step.process',
    write_file: 'run.step.writeFile',
    edit_file: 'run.step.writeFile',
    read_file: 'run.step.readFile',
    search: 'run.step.search',
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
    running: 'running',
    completed: 'completed',
    succeeded: 'succeeded',
    failed: 'failed',
    skipped: 'skipped',
    partial: 'partial',
    stopped: 'stopped',
    timeout: 'timeout',
    'round-limit': 'roundLimit',
  }[normalized] || 'unknown'
  return t(`run.status.${key}`)
}

function runStatusTone(status) {
  const normalized = String(status || '').trim().toLowerCase()
  if (['completed', 'succeeded'].includes(normalized)) return 'completed'
  if (['failed', 'timeout'].includes(normalized)) return 'failed'
  if (['partial', 'round-limit'].includes(normalized)) return 'partial'
  if (['running', 'in_progress'].includes(normalized)) return 'running'
  return 'queued'
}

function runAgentStatus(kind) {
  if (runFailedKinds.value.includes(kind)) return 'failed'
  if (activeRun.value?.currentKind === kind) return 'running'
  if (runCompletedKinds.value.includes(kind)) return 'completed'
  return 'queued'
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

async function copyMessageContent(message, event, force = false) {
  const content = String(message?.content || '')
  if (!content || (!force && messageCopyBlocked(event))) return
  if (typeof navigator.clipboard?.writeText !== 'function') {
    notify(t('conversation.copyFailed'))
    return
  }
  try {
    await navigator.clipboard.writeText(content)
    markMessageCopied(message.id)
  } catch {
    notify(t('conversation.copyFailed'))
  }
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

function completeOnboarding() {
  try { localStorage.setItem(ONBOARDING_KEY, '1') } catch { /* noop */ }
  onboardingVisible.value = false
}

function advanceOnboarding() {
  if (!onboardingOnLastSlide.value) {
    onboardingIndex.value += 1
    return
  }
  if (!onboardingDetecting.value) completeOnboarding()
}

function moveOnboarding(direction) {
  const count = onboardingSlides.value.length
  onboardingIndex.value = (onboardingIndex.value + direction + count) % count
}

function beginOnboardingDetection() {
  onboardingDetecting.value = true
  void refreshAgents().finally(() => { onboardingDetecting.value = false })
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

function normalizeAttachment(attachment) {
  const id = String(attachment?.id || '')
  const name = String(attachment?.name || '')
  const mimeType = String(attachment?.mimeType || '')
  const size = Number(attachment?.size || 0)
  const previewDataUrl = String(attachment?.previewDataUrl || '')
  if (!id || !name || !mimeType.startsWith('image/') || !previewDataUrl) return null
  return { id, name, mimeType, size: Number.isFinite(size) ? size : 0, previewDataUrl }
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
  if (composerImageLimit.value <= 0) return t('error.imageUnsupported')
  return composerImageLimit.value < MAX_ATTACHMENTS
    ? t('error.imageLimit')
    : t('composer.attachmentLimit')
}

function addAttachments(values) {
  const normalized = values.map(normalizeAttachment).filter(Boolean)
  normalized.forEach(rememberAttachmentPreview)
  const existingIds = new Set(composerAttachments.value.map(attachment => attachment.id))
  const available = normalized.filter(attachment => !existingIds.has(attachment.id))
  const room = Math.max(0, composerImageLimit.value - composerAttachments.value.length)
  const accepted = available.slice(0, room)
  const overflow = available.slice(room)
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
  if (saving.value || isDirectCreationPending(agent?.kind)) return
  closeModal()
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
      allowWrite: false,
    })
    snapshot.value = normalizeSnapshot(await workspace.value.get())
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
    installCatalog.value = nextCatalog || { platform: '', agents: [] }
    installerState.value = nextInstaller || installerState.value
    if (readyAgentSignature.value && readyAgentSignature.value === previousReadyAgentSignature) {
      await loadAgentSkillStats()
    }
  } catch (error) {
    showError(error)
  } finally {
    refreshing.value = false
  }
}

function openNewGroup() {
  if (saving.value) return
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
    const group = await workspace.value.createGroup(plainGroupPayload(groupForm))
    snapshot.value = normalizeSnapshot(await workspace.value.get())
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
  settingsForm.name = activeGroup.value.name || ''
  settingsForm.topic = activeGroup.value.topic || ''
  settingsForm.agentKinds = [...activeGroup.value.agentKinds]
  settingsForm.workdir = activeGroup.value.workdir || ''
  settingsForm.allowWrite = activeGroup.value.allowWrite === true
  formError.value = ''
  deleteArmed.value = false
  modal.value = 'settings'
}

function openDirectRename(group) {
  if (!group || isGroupRunning(group.id)) return
  selectGroup(group.id)
  openGroupSettings('rename')
  void nextTick(() => settingsNameInput.value?.focus())
}

function openDirectDelete(group) {
  if (!group || isGroupRunning(group.id)) return
  selectGroup(group.id)
  openGroupSettings('delete')
  deleteArmed.value = true
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
    closeModal({ force: true })
  } catch (error) {
    formError.value = translateError(error)
  } finally {
    saving.value = false
  }
}

function toggleTarget(kind) {
  if (sending.value || activeRun.value || composerMode.value === 'auto') return
  if (targetKinds.value.includes(kind)) targetKinds.value = targetKinds.value.filter(item => item !== kind)
  else targetKinds.value = [...targetKinds.value, kind]
}

function isComposerTargetSelected(kind) {
  return composerTargetKinds.value.includes(kind)
}

function adjustMaxRounds(delta) {
  maxRounds.value = Math.max(1, Math.min(10, maxRounds.value + delta))
}

async function loadSkillsForTargets() {
  const targets = [...composerTargetKinds.value]
  const token = ++skillLoadToken
  skillOptions.value = []
  if (!targets.length || typeof installer.value?.skills !== 'function') {
    skillsLoading.value = false
    return
  }
  skillsLoading.value = true
  try {
    const results = await Promise.all(targets.map(async (kind) => {
      try {
        const result = await installer.value.skills(kind)
        return (Array.isArray(result?.skills) ? result.skills : [])
          .map(skill => normalizeSkill(skill, kind))
          .filter(Boolean)
      } catch {
        return []
      }
    }))
    if (token !== skillLoadToken) return
    const seen = new Set()
    skillOptions.value = results.flat().filter((skill) => {
      const key = skillKey(skill)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  } finally {
    if (token === skillLoadToken) skillsLoading.value = false
  }
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
  if (!currentSkillTrigger.value || selectedSkills.value.length >= MAX_SKILLS) {
    skillMenuOpen.value = false
    return
  }
  const shouldLoad = !skillMenuOpen.value
  skillActiveIndex.value = 0
  skillMenuOpen.value = true
  if (shouldLoad) void loadSkillsForTargets()
}

async function openSkillMenu() {
  if (!composerTargetKinds.value.length) {
    notify(t('composer.selectTarget'))
    return
  }
  if (selectedSkills.value.length >= MAX_SKILLS) {
    notify(t('composer.skillLimit'))
    return
  }
  if (!currentSkillTrigger.value) {
    const spacer = draft.value && !/\s$/.test(draft.value) ? ' ' : ''
    draft.value = `${draft.value}${spacer}@`
  }
  skillActiveIndex.value = 0
  skillMenuOpen.value = true
  await loadSkillsForTargets()
  await nextTick()
  composerInput.value?.focus()
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

function removeAttachment(id) {
  composerAttachments.value = composerAttachments.value.filter(attachment => attachment.id !== id)
  void discardAttachments([id])
}

async function pickImages() {
  if (typeof attachmentsApi.value?.pickImages !== 'function') {
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
  if (composerImageLimit.value <= 0) {
    notify(t('error.imageUnsupported'))
    return
  }
  const remainingCapacity = Math.max(
    0, composerImageLimit.value - composerAttachments.value.length,
  )
  if (!remainingCapacity) {
    notify(attachmentLimitMessage())
    return
  }
  const operation = beginAttachmentImport()
  if (!operation) return
  try {
    const result = await attachmentsApi.value.pickImages(remainingCapacity)
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
  if (typeof attachmentsApi.value?.importImage !== 'function') return
  const files = Array.from(event.clipboardData?.items || [])
    .filter(item => item.kind === 'file' && String(item.type || '').startsWith('image/'))
    .map(item => item.getAsFile?.())
    .filter(Boolean)
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
  const room = Math.max(0, composerImageLimit.value - composerAttachments.value.length)
  if (!room) {
    notify(attachmentLimitMessage())
    return
  }
  if (files.length > room) notify(attachmentLimitMessage())
  const operation = beginAttachmentImport()
  if (!operation) return
  try {
    const imported = []
    for (const file of files.slice(0, room)) {
      if (!attachmentImportIsCurrent(operation)) break
      try {
        if (Number(file.size) > MAX_ATTACHMENT_BYTES) {
          throw Object.assign(new Error('LOCAL_ATTACHMENT_TOO_LARGE'), {
            code: 'LOCAL_ATTACHMENT_TOO_LARGE',
          })
        }
        const bytes = new Uint8Array(await file.arrayBuffer())
        const attachment = await attachmentsApi.value.importImage({
          name: String(file.name || t('composer.pastedImage')),
          mimeType: String(file.type || 'application/octet-stream'),
          bytes,
        })
        if (!attachmentImportIsCurrent(operation)) {
          void discardAttachments([attachment])
          break
        }
        imported.push(attachment)
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
      const count = filteredSkillOptions.value.length
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
      const skill = filteredSkillOptions.value[skillActiveIndex.value]
      if (skill) void selectSkill(skill)
      else skillMenuOpen.value = false
      return
    }
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
  if (attachments.length > composerImageLimit.value) {
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
  const previousDraft = draft.value
  const previousSkills = selectedSkills.value.map(skill => ({ ...skill }))
  const previousAttachments = composerAttachments.value.map(attachment => ({ ...attachment }))
  draft.value = ''
  selectedSkills.value = []
  composerAttachments.value = []
  skillMenuOpen.value = false
  sending.value = true
  try {
    await workspace.value.send({
      groupId,
      text,
      targetKinds: targets,
      skillHints,
      attachments,
      mode,
      maxRounds: maxRounds.value,
    })
    snapshot.value = normalizeSnapshot(await workspace.value.get())
  } catch (error) {
    if (contextVersion === composerContextVersion.value && groupId === activeGroup.value?.id) {
      draft.value = previousDraft
      selectedSkills.value = previousSkills
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
  if (saving.value) return
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
  if (saving.value) return
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
    closeModal({ force: true })
  } catch (error) {
    formError.value = translateError(error)
  } finally {
    saving.value = false
  }
}

async function removeProvider() {
  if (saving.value) return
  if (!providerRemoveArmed.value) {
    providerRemoveArmed.value = true
    return
  }
  saving.value = true
  try {
    await provider.value.delete()
    await Promise.all([loadProviderStatus(), refreshAgents()])
    closeModal({ force: true })
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
  providerRemoveArmed.value = false
  installConfirmKind.value = ''
  return true
}

function notify(message) {
  toastMessage.value = message
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toastMessage.value = '' }, 3600)
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
    unsubscribeRunFinished = workspace.value.onRunFinished?.(handleRunFinished) || null
    unsubscribeOpenGroup = workspace.value.onOpenGroup?.(handleOpenGroup) || null
    unsubscribeInstaller = installer.value.onChanged?.((value) => { installerState.value = value }) || null
    const [nextSnapshot, nextInstaller, nextProvider, nextDirectory] = await Promise.all([
      settleWithin(workspace.value.get()),
      settleWithin(installer.value.state()),
      settleWithin(provider.value.status()),
      settleWithin(workspace.value.defaultDirectory()),
    ])
    if (nextSnapshot) snapshot.value = normalizeSnapshot(nextSnapshot)
    installerState.value = nextInstaller || installerState.value
    providerStatus.value = nextProvider || providerStatus.value
    defaultDirectory.value = nextDirectory || ''
  } catch (error) {
    showError(error)
  } finally {
    booting.value = false
  }
  if (!onboardingSeen()) {
    onboardingIndex.value = 0
    onboardingVisible.value = true
    beginOnboardingDetection()
  } else {
    void refreshAgents()
  }
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

function handleWindowKeydown(event) {
  if (trapOverlayFocus(event) || event.key !== 'Escape') return
  if (skillMenuOpen.value) {
    skillMenuOpen.value = false
    return
  }
  if (onboardingVisible.value) {
    completeOnboarding()
    return
  }
  if (modal.value) closeModal()
}

function handlePopState() {
  if (!blockingOverlayOpen.value) return
  if (modal.value && saving.value) {
    history.pushState({ roundrelayOverlay: true }, '', window.location.href)
    modalHistoryPushed = true
    return
  }
  modalHistoryPushed = false
  if (onboardingVisible.value) completeOnboarding()
  else closeModal()
}

watch(theme, applyTheme)
watch(onboardingVisible, (value) => { if (value) focusOverlay(onboardingDialog) })
watch(modal, (value, previous) => {
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
watch(blockingOverlayOpen, (value, previous) => {
  document.body.classList.toggle('modal-open', Boolean(value))
  if (value && !previous) {
    history.pushState({ roundrelayOverlay: true }, '', window.location.href)
    modalHistoryPushed = true
  } else if (!value && previous && modalHistoryPushed) {
    modalHistoryPushed = false
    history.back()
  }
})
watch(() => snapshot.value.groups.map(group => group.id).join('\u0000'), () => {
  openPendingRequestedGroup()
  flushPendingRunFinishedEvents()
})
watch(() => snapshot.value.messages.map(message => message.id).join('\u0000'), flushPendingRunFinishedEvents)
watch(activeGroupMemberSignature, () => {
  composerContextVersion.value += 1
  const abandonedAttachments = composerAttachments.value
  const group = activeGroup.value
  cancelInlineTitleEdit({ restoreFocus: false })
  activeTurnId.value = ''
  discussionMode.value = group?.conversationType === 'direct' ? 'manual' : 'auto'
  targetKinds.value = group ? [...group.agentKinds] : []
  selectedSkills.value = []
  composerAttachments.value = []
  void discardAttachments(abandonedAttachments)
  skillMenuOpen.value = false
  void scrollToLatest()
})
watch(activeRun, (value) => { if (value) cancelInlineTitleEdit({ restoreFocus: false }) })
watch(skillTargetSignature, () => {
  const targets = new Set(composerTargetKinds.value)
  selectedSkills.value = selectedSkills.value.filter(skill => targets.has(skill.targetKind))
  skillOptions.value = []
  skillActiveIndex.value = 0
  skillLoadToken += 1
  if (skillMenuOpen.value && currentSkillTrigger.value) void loadSkillsForTargets()
})
watch(() => filteredSkillOptions.value.length, (length) => {
  skillActiveIndex.value = length ? Math.min(skillActiveIndex.value, length - 1) : 0
})
watch(
  [draft, () => composerAttachments.value.length, activeGroupMemberSignature],
  scheduleComposerResize,
  { flush: 'post' },
)
watch(() => activeMessages.value.length, scrollToLatest)
watch(activeRunTopicSignature, (value) => { if (value) void focusRunTopic() })
watch(readyAgentSignature, (value) => { if (value) void loadAgentSkillStats() })
watch(() => installerState.value.phase, (phase, previous) => {
  if (phase === 'completed' && previous !== 'completed') void refreshAgents()
})

onMounted(() => {
  window.addEventListener('keydown', handleWindowKeydown)
  window.addEventListener('popstate', handlePopState)
  void boot()
})

onBeforeUnmount(() => {
  composerContextVersion.value += 1
  const abandonedAttachments = composerAttachments.value
  composerAttachments.value = []
  void discardAttachments(abandonedAttachments)
  window.removeEventListener('keydown', handleWindowKeydown)
  window.removeEventListener('popstate', handlePopState)
  document.body.classList.remove('modal-open')
  skillLoadToken += 1
  agentSkillStatsToken += 1
  unsubscribeWorkspace?.()
  unsubscribeInstaller?.()
  unsubscribeRunFinished?.()
  unsubscribeOpenGroup?.()
  pendingRunFinishedEvents.clear()
  for (const timer of copiedMessageTimers.values()) clearTimeout(timer)
  copiedMessageTimers.clear()
  clearTimeout(toastTimer)
})
</script>
