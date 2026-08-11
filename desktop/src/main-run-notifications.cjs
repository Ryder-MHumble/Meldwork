const RUN_FINISHED_STATUSES = new Set([
  'completed', 'partial', 'failed', 'stopped', 'timeout', 'round-limit', 'interrupted',
  'budget-exhausted', 'circuit-breaker',
])
const LOCAL_IDENTIFIER = /^[A-Za-z0-9_-]{1,100}$/
const LOCAL_GROUP_IDENTIFIER = /^[^\u0000-\u001f\u007f]{1,100}$/u
const LOCAL_RUN_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/

function runNotificationCopy(payload, locale) {
  const zh = locale.startsWith('zh')
  const completed = payload.completedKinds.length
  const failed = payload.failedKinds.length
  if (zh) {
    return ({
      completed: {
        title: 'Meldwork · 运行完成',
        body: completed ? `${completed} 个 Agent 已完成回复` : '会话运行已完成',
      },
      partial: {
        title: 'Meldwork · 部分完成',
        body: `${completed} 个 Agent 完成，${failed} 个未完成`,
      },
      failed: {
        title: 'Meldwork · 运行失败',
        body: failed ? `${failed} 个 Agent 运行失败，请打开会话查看详情` : '会话运行失败，请打开查看详情',
      },
      stopped: { title: 'Meldwork · 运行已停止', body: '会话已按请求停止' },
      timeout: { title: 'Meldwork · 运行超时', body: '会话超过时间限制，已停止运行' },
      'round-limit': { title: 'Meldwork · 已达轮次上限', body: '自动讨论已达到设定轮次' },
      interrupted: { title: 'Meldwork · 运行中断', body: '未完成的会话运行已中断' },
      'budget-exhausted': { title: 'Meldwork · 预算已用完', body: '本次运行已达到预算上限' },
      'circuit-breaker': { title: 'Meldwork · 运行已暂停', body: '连续失败触发保护机制，请打开会话查看详情' },
    })[payload.status]
  }
  const agents = count => `${count} Agent${count === 1 ? '' : 's'}`
  return ({
    completed: {
      title: 'Meldwork · Run completed',
      body: completed ? `${agents(completed)} completed the reply` : 'Conversation run completed',
    },
    partial: {
      title: 'Meldwork · Partially completed',
      body: `${agents(completed)} completed, ${agents(failed)} did not`,
    },
    failed: {
      title: 'Meldwork · Run failed',
      body: failed ? `${agents(failed)} failed. Open the conversation for details` : 'Conversation run failed. Open it for details',
    },
    stopped: { title: 'Meldwork · Run stopped', body: 'The conversation was stopped as requested' },
    timeout: { title: 'Meldwork · Run timed out', body: 'The conversation exceeded its time limit and stopped' },
    'round-limit': { title: 'Meldwork · Round limit reached', body: 'The automatic discussion reached its configured round limit' },
    interrupted: { title: 'Meldwork · Run interrupted', body: 'The unfinished conversation run was interrupted' },
    'budget-exhausted': { title: 'Meldwork · Budget exhausted', body: 'This run reached its configured budget limit' },
    'circuit-breaker': { title: 'Meldwork · Run paused', body: 'Repeated failures triggered protection. Open the conversation for details' },
  })[payload.status]
}

function createRunNotificationCoordinator({
  Notification,
  app,
  appIconImage,
  appIconPath,
  createWindow,
  getMainWindow,
  isLocalAgentKind,
  isShutdownStarted,
  isTrustedLocalWebContents,
  normalizeRunEvent,
}) {
  let pendingOpenGroupId = ''

  function normalizeRunFinished(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null
    const groupId = String(input.groupId || '')
    const runId = String(input.runId || '')
    const status = String(input.status || '')
    if (!LOCAL_GROUP_IDENTIFIER.test(groupId) || !RUN_FINISHED_STATUSES.has(status)) return null
    const threadRootId = String(input.threadRootId || '')
    const kinds = value => [...new Set((Array.isArray(value) ? value : [])
      .filter(isLocalAgentKind))]
    return {
      groupId,
      runId: LOCAL_RUN_IDENTIFIER.test(runId) ? runId : '',
      mode: input.mode === 'auto' ? 'auto' : 'manual',
      status,
      threadRootId: LOCAL_IDENTIFIER.test(threadRootId) ? threadRootId : '',
      targetKinds: kinds(input.targetKinds),
      completedKinds: kinds(input.completedKinds),
      failedKinds: kinds(input.failedKinds),
      startedAt: Number.isFinite(input.startedAt) ? input.startedAt : 0,
      finishedAt: Number.isFinite(input.finishedAt) ? input.finishedAt : Date.now(),
    }
  }

  function normalizeRendererRunEvent(input) {
    const event = normalizeRunEvent(input)
    if (!event || !isLocalAgentKind(event.agentKind)) return null
    if (!LOCAL_GROUP_IDENTIFIER.test(event.groupId)) return null
    if (event.threadRootId && !LOCAL_IDENTIFIER.test(event.threadRootId)) return null
    return event
  }

  function notifyWorkspaceRunEvent(input) {
    const window = getMainWindow()
    if (!window || window.isDestroyed()
        || !isTrustedLocalWebContents(window.webContents)) return
    const event = normalizeRendererRunEvent(input)
    if (!event) return
    window.webContents.send('local-workspace:run-event', event)
  }

  function flushPendingOpenGroup() {
    const window = getMainWindow()
    if (!pendingOpenGroupId || !window || window.isDestroyed()
        || !isTrustedLocalWebContents(window.webContents)) return false
    const groupId = pendingOpenGroupId
    pendingOpenGroupId = ''
    window.webContents.send('local-workspace:open-group', { groupId })
    return true
  }

  function activateMainWindow() {
    if (isShutdownStarted()) return false
    let window = getMainWindow()
    if ((!window || window.isDestroyed()) && app.isReady()) {
      createWindow()
      window = getMainWindow()
    }
    if (!window || window.isDestroyed()) return false
    if (window.isMinimized?.()) window.restore?.()
    window.show?.()
    window.focus()
    return true
  }

  function openRunResult(groupId) {
    if (isShutdownStarted()) return
    pendingOpenGroupId = groupId
    if (!activateMainWindow()) return
    flushPendingOpenGroup()
  }

  function notifyRunFinished(input) {
    if (isShutdownStarted()) return
    const payload = normalizeRunFinished(input)
    if (!payload) return
    const window = getMainWindow()
    const availableWindow = window && !window.isDestroyed() ? window : null
    if (availableWindow && isTrustedLocalWebContents(availableWindow.webContents)) {
      availableWindow.webContents.send('local-workspace:run-finished', payload)
    }
    if (availableWindow
        && (typeof availableWindow.isFocused !== 'function' || availableWindow.isFocused())) return
    if (typeof Notification !== 'function' || Notification.isSupported?.() === false) return
    const locale = String(app.getLocale?.() || '').toLowerCase()
    const copy = runNotificationCopy(payload, locale)
    const notification = new Notification({
      title: copy.title,
      body: copy.body,
      icon: appIconImage() || appIconPath(),
    })
    notification.on('click', () => openRunResult(payload.groupId))
    notification.show()
  }

  return {
    activateMainWindow,
    flushPendingOpenGroup,
    notifyRunFinished,
    notifyWorkspaceRunEvent,
  }
}

module.exports = { createRunNotificationCoordinator }
