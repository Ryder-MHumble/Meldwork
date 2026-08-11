const RUN_FINISHED_STATUSES = new Set([
  'completed', 'partial', 'failed', 'stopped', 'timeout', 'round-limit', 'interrupted',
  'budget-exhausted', 'circuit-breaker',
])
const LOCAL_IDENTIFIER = /^[A-Za-z0-9_-]{1,100}$/
const LOCAL_GROUP_IDENTIFIER = /^[^\u0000-\u001f\u007f]{1,100}$/u
const LOCAL_RUN_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/

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
    const notification = new Notification({
      title: 'Meldwork',
      body: locale.startsWith('zh') ? '会话运行已结束' : 'Conversation run finished',
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
