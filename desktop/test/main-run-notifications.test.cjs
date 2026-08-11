const test = require('node:test')
const assert = require('node:assert/strict')
const { createRunNotificationCoordinator } = require('../src/main-run-notifications.cjs')

function createWindow({ focused = false, minimized = false, trusted = true } = {}) {
  return {
    destroyed: false,
    focused,
    minimized,
    focusCount: 0,
    restoreCount: 0,
    showCount: 0,
    webContents: {
      sent: [],
      trusted,
      send(...args) { this.sent.push(args) },
    },
    focus() {
      this.focusCount += 1
      this.focused = true
    },
    isDestroyed() { return this.destroyed },
    isFocused() { return this.focused },
    isMinimized() { return this.minimized },
    restore() {
      this.restoreCount += 1
      this.minimized = false
    },
    show() { this.showCount += 1 },
  }
}

function createHarness(options = {}) {
  let currentWindow = options.window === undefined ? createWindow() : options.window
  let ready = options.ready !== false
  let shutdown = options.shutdown === true
  const notifications = []

  class TestNotification {
    static isSupported() { return options.notificationsSupported !== false }

    constructor(input) {
      this.input = input
      this.listeners = new Map()
      this.showCount = 0
      notifications.push(this)
    }

    emit(name) { this.listeners.get(name)?.() }
    on(name, listener) { this.listeners.set(name, listener) }
    show() { this.showCount += 1 }
  }

  const coordinator = createRunNotificationCoordinator({
    Notification: TestNotification,
    app: {
      getLocale: () => options.locale || 'en-US',
      isReady: () => ready,
    },
    appIconImage: () => ({ image: true }),
    appIconPath: () => '/private/icon.png',
    createWindow: () => {
      currentWindow = createWindow(options.createdWindowOptions)
      return currentWindow
    },
    getMainWindow: () => currentWindow,
    isLocalAgentKind: kind => ['codex', 'hermes'].includes(kind),
    isShutdownStarted: () => shutdown,
    isTrustedLocalWebContents: webContents => webContents?.trusted === true,
    normalizeRunEvent: options.normalizeRunEvent || (value => value),
  })

  return {
    coordinator,
    getWindow: () => currentWindow,
    notifications,
    setReady: value => { ready = value },
    setShutdown: value => { shutdown = value },
    setWindow: value => { currentWindow = value },
  }
}

test('run notification coordinator keeps a narrow stable API', () => {
  const { coordinator } = createHarness()

  assert.deepEqual(Object.keys(coordinator).sort(), [
    'activateMainWindow',
    'flushPendingOpenGroup',
    'notifyRunFinished',
    'notifyWorkspaceRunEvent',
  ])
})

test('run completion sends only normalized fields and opens its group from the notification', () => {
  const window = createWindow({ minimized: true })
  const { coordinator, notifications } = createHarness({ locale: 'zh-CN', window })

  coordinator.notifyRunFinished({
    groupId: '历史群聊 1',
    runId: 'run:trace.1',
    mode: 'auto',
    status: 'partial',
    threadRootId: 'thread-1',
    targetKinds: ['hermes', '../../private', 'hermes'],
    completedKinds: ['hermes'],
    failedKinds: ['codex', '../../private'],
    startedAt: 100,
    finishedAt: 200,
    path: '/private/workspace',
    sessionRef: 'secret-session',
  })

  assert.deepEqual(window.webContents.sent, [['local-workspace:run-finished', {
    groupId: '历史群聊 1',
    runId: 'run:trace.1',
    mode: 'auto',
    status: 'partial',
    threadRootId: 'thread-1',
    targetKinds: ['hermes'],
    completedKinds: ['hermes'],
    failedKinds: ['codex'],
    startedAt: 100,
    finishedAt: 200,
  }]])
  assert.equal(notifications.length, 1)
  assert.deepEqual(notifications[0].input, {
    title: 'Meldwork · 部分完成',
    body: '1 个 Agent 完成，1 个未完成',
    icon: { image: true },
  })
  assert.equal(notifications[0].showCount, 1)

  notifications[0].emit('click')
  assert.equal(window.restoreCount, 1)
  assert.equal(window.showCount, 1)
  assert.equal(window.focusCount, 1)
  assert.deepEqual(window.webContents.sent.at(-1), [
    'local-workspace:open-group', { groupId: '历史群聊 1' },
  ])
})

test('notifications describe each terminal outcome in Chinese and English', () => {
  const cases = [
    ['completed', 'Meldwork · Run completed', '1 Agent completed the reply'],
    ['partial', 'Meldwork · Partially completed', '1 Agent completed, 1 Agent did not'],
    ['failed', 'Meldwork · Run failed', '1 Agent failed. Open the conversation for details'],
    ['stopped', 'Meldwork · Run stopped', 'The conversation was stopped as requested'],
    ['timeout', 'Meldwork · Run timed out', 'The conversation exceeded its time limit and stopped'],
    ['round-limit', 'Meldwork · Round limit reached', 'The automatic discussion reached its configured round limit'],
    ['interrupted', 'Meldwork · Run interrupted', 'The unfinished conversation run was interrupted'],
    ['budget-exhausted', 'Meldwork · Budget exhausted', 'This run reached its configured budget limit'],
    ['circuit-breaker', 'Meldwork · Run paused', 'Repeated failures triggered protection. Open the conversation for details'],
  ]

  for (const [status, title, body] of cases) {
    const { coordinator, notifications } = createHarness()
    coordinator.notifyRunFinished({
      groupId: `group-${status}`,
      status,
      targetKinds: ['codex', 'hermes'],
      completedKinds: ['codex'],
      failedKinds: ['hermes'],
    })
    assert.deepEqual(notifications[0].input, { title, body, icon: { image: true } })
  }

  const chinese = createHarness({ locale: 'zh-CN' })
  chinese.coordinator.notifyRunFinished({ groupId: 'group-timeout', status: 'timeout' })
  assert.deepEqual(chinese.notifications[0].input, {
    title: 'Meldwork · 运行超时',
    body: '会话超过时间限制，已停止运行',
    icon: { image: true },
  })
})

test('run events require a trusted window and shutdown blocks notifications and navigation', () => {
  const normalized = []
  const window = createWindow({ trusted: false })
  const harness = createHarness({
    normalizeRunEvent: value => {
      normalized.push(value)
      return value
    },
    window,
  })

  const event = {
    runId: 'run-1', agentRunId: 'agent-1', groupId: 'group-1',
    threadRootId: 'thread-1', agentKind: 'codex', type: 'status', status: 'running',
  }
  harness.coordinator.notifyWorkspaceRunEvent(event)
  assert.equal(normalized.length, 0)

  window.webContents.trusted = true
  harness.coordinator.notifyWorkspaceRunEvent(event)
  assert.deepEqual(window.webContents.sent, [['local-workspace:run-event', event]])
  harness.coordinator.notifyWorkspaceRunEvent({ ...event, agentKind: '../../private' })
  assert.equal(window.webContents.sent.length, 1)

  harness.setShutdown(true)
  harness.coordinator.notifyRunFinished({ groupId: 'group-1', status: 'completed' })
  assert.equal(harness.notifications.length, 0)
  assert.equal(harness.coordinator.activateMainWindow(), false)
  assert.equal(window.showCount, 0)
  assert.equal(window.focusCount, 0)
  assert.equal(harness.coordinator.flushPendingOpenGroup(), false)
})

test('notification click recreates a missing window before opening the group', () => {
  const harness = createHarness({ window: null })

  harness.coordinator.notifyRunFinished({
    groupId: 'group-restore',
    status: 'completed',
    targetKinds: ['codex'],
    completedKinds: ['codex'],
  })
  assert.equal(harness.notifications.length, 1)
  harness.notifications[0].emit('click')

  const restored = harness.getWindow()
  assert.ok(restored)
  assert.equal(restored.showCount, 1)
  assert.equal(restored.focusCount, 1)
  assert.deepEqual(restored.webContents.sent.at(-1), [
    'local-workspace:open-group', { groupId: 'group-restore' },
  ])
})

test('notification click after shutdown does not activate a window or retain a pending group', () => {
  const harness = createHarness({ window: null })

  harness.coordinator.notifyRunFinished({ groupId: 'group-late', status: 'completed' })
  assert.equal(harness.notifications.length, 1)
  harness.setShutdown(true)
  harness.notifications[0].emit('click')
  assert.equal(harness.getWindow(), null)

  harness.setShutdown(false)
  harness.setWindow(createWindow())
  assert.equal(harness.coordinator.flushPendingOpenGroup(), false)
})

test('pending group waits for a trusted renderer and flushes exactly once after load', () => {
  const harness = createHarness({
    createdWindowOptions: { trusted: false },
    window: null,
  })

  harness.coordinator.notifyRunFinished({ groupId: 'group-pending', status: 'completed' })
  harness.notifications[0].emit('click')
  const restored = harness.getWindow()
  assert.deepEqual(restored.webContents.sent, [])
  assert.equal(harness.coordinator.flushPendingOpenGroup(), false)

  restored.webContents.trusted = true
  assert.equal(harness.coordinator.flushPendingOpenGroup(), true)
  assert.deepEqual(restored.webContents.sent, [[
    'local-workspace:open-group', { groupId: 'group-pending' },
  ]])
  assert.equal(harness.coordinator.flushPendingOpenGroup(), false)
  assert.equal(restored.webContents.sent.length, 1)
})

test('separate coordinator factories never share pending group state', () => {
  const first = createHarness({ ready: false, window: null })
  const second = createHarness()

  first.coordinator.notifyRunFinished({ groupId: 'group-first', status: 'completed' })
  first.notifications[0].emit('click')
  assert.equal(first.getWindow(), null)
  assert.equal(second.coordinator.flushPendingOpenGroup(), false)

  first.setReady(true)
  assert.equal(first.coordinator.activateMainWindow(), true)
  assert.equal(first.coordinator.flushPendingOpenGroup(), true)
  assert.deepEqual(first.getWindow().webContents.sent, [[
    'local-workspace:open-group', { groupId: 'group-first' },
  ]])
  assert.deepEqual(second.getWindow().webContents.sent, [])
})

test('run completion identifiers and timestamps fail closed at the coordinator boundary', () => {
  const window = createWindow({ focused: true })
  const { coordinator } = createHarness({ window })

  for (const invalid of [
    null,
    [],
    { groupId: 'bad\ngroup', status: 'completed' },
    { groupId: 'g'.repeat(101), status: 'completed' },
    { groupId: 'group-1', status: 'unknown' },
  ]) {
    coordinator.notifyRunFinished(invalid)
  }
  assert.deepEqual(window.webContents.sent, [])

  const before = Date.now()
  coordinator.notifyRunFinished({
    groupId: 'group-1',
    runId: 'bad/run',
    status: 'completed',
    threadRootId: 'bad:thread',
    startedAt: Number.NaN,
    finishedAt: Number.POSITIVE_INFINITY,
  })
  const after = Date.now()
  const payload = window.webContents.sent[0][1]
  assert.equal(payload.groupId, 'group-1')
  assert.equal(payload.runId, '')
  assert.equal(payload.threadRootId, '')
  assert.equal(payload.startedAt, 0)
  assert.equal(Number.isFinite(payload.finishedAt), true)
  assert.equal(payload.finishedAt >= before, true)
  assert.equal(payload.finishedAt <= after, true)
})
