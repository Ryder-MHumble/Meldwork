const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const {
  LOCAL_IPC_CHANNELS,
  PROVIDER_AGENT_KINDS,
  PROVIDER_METADATA,
  deferred,
  eventFor,
  loadMain,
  pngHeader,
  waitFor,
} = require('./main-security-test-harness.cjs')

test('local desktop authorization requires the current main frame and exact frontend file', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-main-security-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { main } = loadMain(directory)
  const frontend = path.join(directory, 'frontend', 'index.html')
  const frontendUrl = `${pathToFileURL(frontend).href}?desktop=1#/chat`
  const trusted = eventFor(frontendUrl)

  assert.equal(main.isTrustedLocalRenderer(trusted.event, trusted.sender, frontend), true)
  assert.equal(main.isTrustedLocalWebContents(trusted.sender, frontend), true)
  assert.equal(main.isTrustedLocalRenderer({
    sender: trusted.sender,
    senderFrame: { url: frontendUrl, processId: 1, routingId: 999 },
  }, trusted.sender, frontend), false)
  assert.equal(main.isTrustedLocalRenderer(
    eventFor(pathToFileURL(path.join(directory, 'offline.html')).href).event,
    trusted.sender,
    frontend,
  ), false)
})

test('a second desktop process exits before ready initialization', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-single-instance-denied-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory, { singleInstanceLock: false })

  assert.equal(harness.singleInstanceLockCalls, 1)
  assert.equal(harness.quitCount, 1)
  assert.equal(harness.readyRegistered, false)
  assert.equal(harness.workspaceInstances.length, 0)
  assert.equal(harness.windows.length, 0)
})

test('controlled media protocol serves attachment bytes with range support and rejects invalid ids', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-media-protocol-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const mediaBytes = Buffer.from('ID3-audio-payload')
  const { harness } = loadMain(directory, {
    mediaMetadata: {
      id: 'generated-audio', name: 'briefing.mp3', mimeType: 'audio/mpeg', size: mediaBytes.length,
    },
    mediaBytes,
  })

  assert.equal(harness.registeredSchemes.some(entry => (
    entry.scheme === 'meldwork-media'
      && entry.privileges?.secure === true
      && entry.privileges?.standard === true
  )), true)
  await harness.ready()
  const handler = harness.protocolHandlers.get('meldwork-media')
  assert.equal(typeof handler, 'function')

  const response = await handler(new Request(
    'meldwork-media://attachment/generated-audio',
    { headers: { Range: 'bytes=4-8' } },
  ))
  assert.equal(response.status, 206)
  assert.equal(response.headers.get('content-type'), 'audio/mpeg')
  assert.equal(response.headers.get('content-range'), `bytes 4-8/${mediaBytes.length}`)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), mediaBytes.subarray(4, 9))

  const readsBeforeInvalid = harness.attachmentInstances[0].readWithMetadataCalls.length
  const invalid = await handler(new Request('meldwork-media://attachment/..%2Fsecret'))
  assert.equal(invalid.status, 404)
  assert.equal(harness.attachmentInstances[0].readWithMetadataCalls.length, readsBeforeInvalid)
})

test('every local IPC handler rejects an untrusted renderer before dispatch', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-ipc-security-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory)
  await harness.ready()

  assert.deepEqual([...harness.ipcHandlers.keys()], LOCAL_IPC_CHANNELS)
  const trustedEvent = harness.event()
  const untrustedEvent = {
    sender: trustedEvent.sender,
    senderFrame: {
      ...trustedEvent.senderFrame,
      routingId: trustedEvent.senderFrame.routingId + 1,
    },
  }
  for (const channel of LOCAL_IPC_CHANNELS) {
    await assert.rejects(
      async () => harness.ipcHandlers.get(channel)(untrustedEvent),
      { message: 'DESKTOP_CLIENT_ACCESS_DENIED' },
      channel,
    )
  }
})

test('ready activates one fixed local workspace and loads the bundled frontend', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-ready-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory)

  await harness.ready()

  assert.equal(harness.workspaceInstances.length, 1)
  assert.equal(
    harness.workspaceInstances[0].input.storagePath,
    path.join(directory, 'roundrelay-workspace.json'),
  )
  assert.equal(
    harness.workspaceInstances[0].input.runLedger.storagePath,
    path.join(directory, 'roundrelay-run-ledger.json'),
  )
  assert.equal(harness.workspaceInstances[0].refreshCount, 0)
  assert.equal(harness.providerInstances[0].input.storagePath,
    path.join(directory, 'roundrelay-provider.json'))
  assert.equal(harness.customAgentStoreInstances[0].input.storagePath,
    path.join(directory, 'roundrelay-custom-agents.json'))
  assert.deepEqual(
    [...harness.providerInstances[0].input.allowedKinds].sort(),
    [...PROVIDER_AGENT_KINDS].sort(),
  )
  assert.equal(harness.knowledgeBaseStoreInstances[0].input.storagePath,
    path.join(directory, 'roundrelay-knowledge-base.json'))
  assert.equal(harness.attachmentInstances[0].input.rootPath,
    path.join(directory, 'attachments'))
  assert.equal(harness.skillCatalogInstances[0].input.home,
    path.join(directory, 'Home'))
  await harness.workspaceInstances[0].input.detectAgents()
  assert.equal(harness.installerInstances[0].detectedCount, 1)
  assert.equal(harness.customAgentStoreInstances[0].detectCount, 1)
  assert.equal(typeof harness.workspaceInstances[0].input.resolveAttachments, 'function')
  assert.equal(typeof harness.workspaceInstances[0].input.validateSkillSelections, 'function')
  assert.equal(typeof harness.workspaceInstances[0].input.validateKnowledgeBaseSelections, 'function')
  assert.equal(typeof harness.workspaceInstances[0].input.imageAttachmentLimit, 'function')
  assert.equal(typeof harness.workspaceInstances[0].input.agentLabel, 'function')
  assert.deepEqual(harness.attachmentInstances[0].cleanupCalls, [[]])
  assert.equal(harness.windows.length, 1)
  assert.equal(harness.windows[0].input.icon?.isEmpty?.(), false)
  assert.match(harness.nativeImagePathCalls[0], /frontend[\\/]public[\\/]logos[\\/]meldwork-app\.png$/)
  if (process.platform === 'darwin') assert.equal(harness.dockIconCalls.length, 1)
  assert.equal(
    harness.windows[0].input.backgroundColor,
    process.platform === 'darwin' ? '#e7edef' : '#f3f6f8',
  )
  if (process.platform === 'darwin') {
    assert.equal(harness.windows[0].input.titleBarStyle, 'hiddenInset')
    assert.deepEqual(harness.windows[0].input.trafficLightPosition, { x: 18, y: 16 })
  } else {
    assert.equal('titleBarStyle' in harness.windows[0].input, false)
    assert.equal('trafficLightPosition' in harness.windows[0].input, false)
  }
  assert.equal(
    harness.windows[0].loads[0].filename,
    path.resolve(__dirname, '../../frontend/dist/index.html'),
  )
  assert.deepEqual(harness.windows[0].loads[0].options, { hash: '/chat' })
  assert.equal([...harness.ipcHandlers.keys()].some(name => name.includes('cloud')), false)
  assert.equal([...harness.ipcHandlers.keys()].some(name => name.includes('configure')), false)
  assert.equal(harness.ipcListeners.size, 0)
})

test('Custom Agent IPC keeps executable paths private and refreshes the local catalog', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-custom-agent-ipc-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const selectedExecutable = '/private/tools/review-agent'
  const { harness } = loadMain(directory, {
    dialogResult: { canceled: false, filePaths: [selectedExecutable] },
  })
  await harness.ready()

  const result = await harness.ipcHandlers.get('local-custom-agent:create')(
    harness.event(),
    {
      label: 'Review Agent',
      description: 'Reviews repository changes.',
      args: ['review', '--format=text'],
      promptMode: 'stdin',
      executable: '/renderer/must-not-control-this',
    },
  )

  assert.equal(result.canceled, false)
  assert.equal(result.agent.kind, 'custom-0123456789abcdef')
  assert.equal(result.agent.commandName, 'review-agent')
  assert.equal('executable' in result.agent, false)
  assert.equal('args' in result.agent, false)
  assert.doesNotMatch(JSON.stringify(result), /private\/tools|renderer\/must-not-control/)
  assert.deepEqual(harness.customAgentStoreInstances[0].created, [{
    input: {
      label: 'Review Agent',
      description: 'Reviews repository changes.',
      args: ['review', '--format=text'],
      promptMode: 'stdin',
    },
    executable: selectedExecutable,
  }])
  assert.equal(harness.workspaceInstances[0].refreshCount, 1)

  const customReply = await harness.workspaceInstances[0].input.runAgent(
    { kind: result.agent.kind },
    'Review this change',
    '/tmp/project',
    { signal: new AbortController().signal },
  )
  assert.deepEqual(customReply, { text: 'custom reply', sessionRef: '' })
  assert.equal(harness.customAgentRunCalls.length, 1)
  assert.equal(harness.runAgentCalls.length, 0)

  const catalog = await harness.ipcHandlers.get('local-agent-installer:catalog')(harness.event())
  const custom = catalog.agents.find(agent => agent.kind === 'custom-0123456789abcdef')
  assert.equal(custom.custom, true)
  assert.equal(custom.commandName, 'review-agent')
  assert.equal('executable' in custom, false)
  assert.equal('args' in custom, false)
  assert.deepEqual(
    await harness.ipcHandlers.get('local-agent-installer:skills')(
      harness.event(), 'custom-0123456789abcdef',
    ),
    { supported: false, skills: [], total: 0, limit: 0 },
  )
})

test('Custom Agent deletion is blocked while a local conversation references it', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-custom-agent-delete-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const kind = 'custom-0123456789abcdef'
  const { harness } = loadMain(directory, {
    customAgents: [{
      kind,
      label: 'Review Agent',
      description: '',
      commandName: 'review-agent',
      promptMode: 'stdin',
      custom: true,
      installed: true,
    }],
    workspaceSnapshot: {
      agents: [],
      groups: [{ id: 'group-1', agentKinds: [kind] }],
      messages: [],
      localOnly: true,
    },
  })
  await harness.ready()

  await assert.rejects(
    harness.ipcHandlers.get('local-custom-agent:delete')(harness.event(), kind),
    { message: 'CUSTOM_AGENT_IN_USE' },
  )
  assert.deepEqual(harness.customAgentStoreInstances[0].removed, [])

  harness.workspaceInstances[0].state.groups = []
  assert.deepEqual(
    await harness.ipcHandlers.get('local-custom-agent:delete')(harness.event(), kind),
    { deleted: true, kind },
  )
  assert.deepEqual(harness.customAgentStoreInstances[0].removed, [kind])
})

test('a second desktop launch restores and focuses the existing window', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-single-instance-focus-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory, {
    windowFocused: false,
    windowMinimized: true,
  })
  await harness.ready()

  harness.appListeners.get('second-instance')()

  assert.equal(harness.windows.length, 1)
  assert.equal(harness.windows[0].restoreCount, 1)
  assert.equal(harness.windows[0].showCount, 1)
  assert.equal(harness.windows[0].focusCount, 1)
})

test('run completion uses sanitized renderer events and a localized background notification', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-notification-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory, { locale: 'zh-CN', windowFocused: false })
  await harness.ready()
  const window = harness.windows[0]
  const workspace = harness.workspaceInstances[0]

  workspace.emit('run-finished', {
    groupId: '历史群聊 1',
    runId: 'run:trace.1',
    mode: 'auto',
    status: 'partial',
    threadRootId: 'thread-1',
    targetKinds: ['hermes', '../../private', 'hermes'],
    completedKinds: ['hermes'],
    failedKinds: ['codex', '../../private', 'codex'],
    startedAt: 100,
    finishedAt: 200,
    path: '/private/workspace',
    sessionRef: 'secret-session',
    content: 'secret message body',
  })

  const finished = window.webContents.sent.find(([channel]) => (
    channel === 'local-workspace:run-finished'
  ))
  assert.deepEqual(finished, ['local-workspace:run-finished', {
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
  }])
  assert.equal(harness.notificationInstances.length, 1)
  const notification = harness.notificationInstances[0]
  assert.equal(notification.input.title, 'Meldwork')
  assert.equal(notification.input.body, '会话运行已结束')
  assert.equal(notification.input.icon?.isEmpty?.(), false)
  assert.equal(notification.showCount, 1)
  assert.doesNotMatch(
    JSON.stringify(notification.input),
    /private|secret-session|secret message|历史群聊|thread-1/,
  )

  notification.emit('click')
  assert.equal(window.showCount, 1)
  assert.equal(window.focusCount, 1)
  assert.deepEqual(window.webContents.sent.at(-1), [
    'local-workspace:open-group', { groupId: '历史群聊 1' },
  ])

  workspace.emit('run-finished', {
    groupId: 'group-1', status: 'completed', targetKinds: [], completedKinds: [],
  })
  assert.equal(harness.notificationInstances.length, 1)
})

test('runtime trace IPC forwards only sanitized allowlisted fields', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-run-event-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory)
  await harness.ready()
  const window = harness.windows[0]
  const workspace = harness.workspaceInstances[0]

  workspace.emit('run-event', {
    runId: 'run-1',
    agentRunId: 'run-1:1:codex:agent-1',
    groupId: '历史群聊 1',
    threadRootId: 'thread-1',
    agentKind: 'codex',
    round: 1,
    seq: 2,
    timestamp: 100,
    id: 'tool-1',
    type: 'tool_result_summary',
    status: 'completed',
    title: 'search',
    summary: 'Read /Users/private/work with token=private-value',
    command: 'rg private',
    executable: '/tmp/codex',
    sessionRef: 'private-session',
    env: { SECRET: 'private' },
  })

  assert.deepEqual(window.webContents.sent.at(-1), [
    'local-workspace:run-event',
    {
      runId: 'run-1',
      agentRunId: 'run-1:1:codex:agent-1',
      groupId: '历史群聊 1',
      threadRootId: 'thread-1',
      agentKind: 'codex',
      round: 1,
      seq: 2,
      timestamp: 100,
      status: 'completed',
      id: 'tool-1',
      type: 'tool_result_summary',
      title: 'search',
      summary: 'Read [path] with credential=[redacted]',
    },
  ])

  const sentCount = window.webContents.sent.length
  workspace.emit('run-event', {
    runId: 'run-2', agentRunId: 'agent-2', groupId: 'group-1',
    agentKind: '../../private', round: 1, seq: 1, timestamp: 100,
    type: 'status', status: 'running',
  })
  assert.equal(window.webContents.sent.length, sentCount)
})

test('a completion notification restores a closed window and opens its local group', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-notification-restore-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory, { deferRestoredWindowLoad: true })
  await harness.ready()
  const originalWindow = harness.windows[0]
  const workspace = harness.workspaceInstances[0]
  originalWindow.windowListeners.get('closed')()

  workspace.emit('run-finished', {
    groupId: 'group-restore',
    status: 'completed',
    targetKinds: ['codex'],
    completedKinds: ['codex'],
  })

  assert.equal(harness.notificationInstances.length, 1)
  assert.equal(harness.notificationInstances[0].input.title, 'Meldwork')
  assert.equal(harness.notificationInstances[0].input.body, 'Conversation run finished')
  assert.equal(harness.notificationInstances[0].input.icon?.isEmpty?.(), false)
  assert.equal(originalWindow.webContents.sent.length, 0)

  harness.notificationInstances[0].emit('click')

  assert.equal(harness.windows.length, 2)
  const restoredWindow = harness.windows[1]
  assert.equal(restoredWindow.showCount, 1)
  assert.equal(restoredWindow.focusCount, 1)
  assert.equal(restoredWindow.webContents.mainFrame.url, 'about:blank')
  assert.deepEqual(restoredWindow.webContents.sent, [])

  restoredWindow.finishLoad()
  assert.deepEqual(restoredWindow.webContents.sent.at(-1), [
    'local-workspace:open-group', { groupId: 'group-restore' },
  ])
  restoredWindow.finishLoad()
  assert.equal(restoredWindow.webContents.sent.length, 1)
})

test('attachment storage initialization failure does not block text chat startup', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-attachment-fallback-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory, {
    attachmentInitError: new Error('sensitive local storage path'),
  })

  await harness.ready()

  assert.equal(harness.attachmentConstructionCount, 1)
  assert.equal(harness.attachmentInstances.length, 0)
  assert.equal(harness.windows.length, 1)
  await assert.doesNotReject(
    harness.ipcHandlers.get('local-workspace:send')(
      harness.event(),
      { groupId: 'group-1', text: 'text still works', targetKinds: ['codex'], attachments: [] },
    ),
  )
  for (const [channel, args] of [
    ['local-attachments:pick', []],
    ['local-attachments:import', [{ name: 'x.png', mimeType: 'image/png', bytes: [1] }]],
    ['local-attachments:preview', ['attachment-1']],
    ['local-attachments:discard', [['attachment-1']]],
  ]) {
    await assert.rejects(
      async () => harness.ipcHandlers.get(channel)(harness.event(), ...args),
      { message: 'LOCAL_ATTACHMENT_STORAGE_UNAVAILABLE' },
    )
  }
})

test('workspace run IPC requires an explicit non-empty Agent target contract', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-target-contract-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory)
  await harness.ready()

  for (const [channel, input] of [
    ['local-workspace:send', { groupId: 'group-1', text: 'Do the work' }],
    ['local-workspace:send', { groupId: 'group-1', text: 'Do the work', targetKinds: [] }],
  ]) {
    await assert.rejects(
      async () => harness.ipcHandlers.get(channel)(harness.event(), input),
      { message: 'LOCAL_MESSAGE_TARGET_REQUIRED' },
      channel,
    )
  }
})

test('workspace stop IPC forwards only a validated group and run pair', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-stop-contract-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory)
  await harness.ready()
  const stop = harness.ipcHandlers.get('local-workspace:stop')
  const workspace = harness.workspaceInstances[0]

  assert.equal(await stop(harness.event(), 'group-1', 'run:trace.1'), true)
  assert.equal(await stop(harness.event(), '历史群聊 1', 'run-legacy'), true)
  assert.deepEqual(workspace.stopCalls, [
    { groupId: 'group-1', runId: 'run:trace.1' },
    { groupId: '历史群聊 1', runId: 'run-legacy' },
  ])

  assert.equal(await stop(harness.event(), 'group-1', ''), false)
  assert.equal(await stop(harness.event(), 'group\ninvalid', 'run-2'), false)
  assert.equal(await stop(harness.event(), 'group-1', '../run'), false)
  assert.equal(workspace.stopCalls.length, 2)
})

test('startup attachment cleanup receives every persisted message reference once', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-attachment-cleanup-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'roundrelay-workspace.json'), JSON.stringify({
    version: 2,
    groups: [{ id: 'one' }, { id: 'two' }],
    messages: [
      { groupId: 'one', attachments: [{ id: 'shared' }, { id: 'only-one' }] },
      { groupId: 'two', attachments: [{ id: 'shared' }] },
    ],
    sessions: {},
  }))
  const { harness } = loadMain(directory, {
    workspaceSnapshot: {
      agents: [],
      groups: [{ id: 'one' }, { id: 'two' }],
      messages: [
        { groupId: 'one', attachments: [{ id: 'shared' }, { id: 'only-one' }] },
        { groupId: 'two', attachments: [{ id: 'shared' }] },
      ],
      localOnly: true,
    },
  })

  await harness.ready()

  assert.deepEqual(harness.attachmentInstances[0].cleanupCalls, [['shared', 'only-one']])
})

test('startup attachment cleanup failure keeps the validated store available', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-attachment-cleanup-fallback-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory, {
    attachmentCleanupError: new Error('temporary cleanup failure'),
  })

  await harness.ready()

  assert.deepEqual(harness.attachmentInstances[0].cleanupCalls, [[]])
  await assert.doesNotReject(
    harness.ipcHandlers.get('local-attachments:pick')(harness.event(), 1),
  )
})

test('startup skips destructive attachment cleanup when the workspace file is malformed', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-attachment-corrupt-workspace-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'roundrelay-workspace.json'), '{not-json')
  const { harness } = loadMain(directory)

  await harness.ready()

  assert.equal(harness.windows.length, 1)
  assert.deepEqual(harness.attachmentInstances[0].cleanupCalls, [])
})

test('ready creates the desktop window without eagerly duplicating renderer Agent detection', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-ready-window-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory)

  await harness.ready()
  assert.equal(harness.windows.length, 1)
  assert.equal(harness.workspaceInstances[0].refreshCount, 0)
})

test('Electron safeStorage stays lazy until after the desktop window exists', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-ready-safe-storage-'))
  const safeStorageAccesses = []
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory, {
    onSafeStorageAccess: windowCount => safeStorageAccesses.push(windowCount),
  })

  await harness.ready()
  assert.deepEqual(safeStorageAccesses, [])

  assert.equal(harness.providerInstances[0].input.safeStorage.isEncryptionAvailable(), true)
  assert.deepEqual(safeStorageAccesses, [1])
})

test('window navigation permits only local app pages and credential-free HTTPS links', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-navigation-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory)
  await harness.ready()
  const window = harness.windows[0]

  assert.equal(harness.permissionHandlers.check(), false)
  let granted = true
  harness.permissionHandlers.request(null, 'camera', value => { granted = value })
  assert.equal(granted, false)
  assert.equal(harness.permissionHandlers.device(), false)

  assert.deepEqual(window.openHandler({ url: 'https://example.com/docs' }), { action: 'deny' })
  assert.deepEqual(window.openHandler({ url: 'http://example.com' }), { action: 'deny' })
  assert.deepEqual(window.openHandler({ url: 'https://user:pass@example.com' }), { action: 'deny' })
  assert.deepEqual(harness.externalUrls, ['https://example.com/docs'])

  const navigate = window.webContents.listeners.get('will-navigate')
  let prevented = 0
  navigate({ preventDefault: () => { prevented += 1 } }, window.loads[0].url)
  assert.equal(prevented, 0)

  navigate(
    { preventDefault: () => { prevented += 1 } },
    pathToFileURL(path.join(directory, 'untrusted.html')).href,
  )
  navigate({ preventDefault: () => { prevented += 1 } }, 'https://example.com/help')
  navigate({ preventDefault: () => { prevented += 1 } }, 'javascript:alert(1)')
  assert.equal(prevented, 3)
  assert.deepEqual(harness.externalUrls, [
    'https://example.com/docs',
    'https://example.com/help',
  ])
})

test('Provider IPC accepts the complete user payload and supports local deletion', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-provider-ipc-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory)
  await harness.ready()
  const input = { ...PROVIDER_METADATA, apiKey: 'renderer-provider-key', preset: 'custom' }

  const initial = await harness.ipcHandlers.get('local-agent-provider:status')(
    harness.event(), 'hermes',
  )
  assert.equal(initial.configured, false)
  assert.deepEqual(harness.providerInstances[0].statusCalls, [{ kind: 'hermes', input: undefined }])

  await harness.ipcHandlers.get('local-agent-provider:probe')(harness.event(), 'hermes')
  assert.deepEqual(harness.providerInstances[0].statusCalls, [
    { kind: 'hermes', input: undefined },
    { kind: 'hermes', input: { probeEncryption: true } },
  ])

  const saved = await harness.ipcHandlers.get('local-agent-provider:save')(
    harness.event(), 'hermes', input,
  )
  assert.deepEqual(harness.providerInstances[0].saved, [{ kind: 'hermes', input }])
  assert.equal(saved.configured, true)
  assert.equal(harness.workspaceInstances[0].refreshCount, 1)
  assert.deepEqual(harness.workspaceInstances[0].runtimeCredentialMarks, [
    { kind: 'hermes', credentialState: 'unknown' },
  ])

  const activated = await harness.ipcHandlers.get('local-agent-provider:activate')(
    harness.event(), 'hermes', 'custom',
  )
  assert.deepEqual(harness.providerInstances[0].activated, [{ kind: 'hermes', preset: 'custom' }])
  assert.equal(activated.activePreset, 'custom')
  assert.equal(harness.workspaceInstances[0].refreshCount, 2)
  assert.deepEqual(harness.workspaceInstances[0].runtimeCredentialMarks, [
    { kind: 'hermes', credentialState: 'unknown' },
    { kind: 'hermes', credentialState: 'unknown' },
  ])

  await assert.rejects(
    async () => harness.ipcHandlers.get('local-agent-provider:status')(harness.event(), 'not-an-agent'),
    { message: 'PROVIDER_AGENT_UNSUPPORTED' },
  )

  const deleted = await harness.ipcHandlers.get('local-agent-provider:delete')(
    harness.event(), 'hermes', 'custom',
  )
  assert.deepEqual(harness.providerInstances[0].deleted, [{ kind: 'hermes', preset: 'custom' }])
  assert.equal(deleted.configured, false)
  assert.equal(harness.workspaceInstances[0].refreshCount, 3)
  assert.deepEqual(harness.workspaceInstances[0].runtimeCredentialMarks, [
    { kind: 'hermes', credentialState: 'unknown' },
    { kind: 'hermes', credentialState: 'unknown' },
    { kind: 'hermes', credentialState: 'unknown' },
  ])
})

test('Knowledge base IPC exposes status, safe guides, and a local Obsidian directory picker', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-knowledge-base-ipc-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const vaultPath = path.join(directory, 'Obsidian Vault')
  const { harness } = loadMain(directory, {
    dialogResult: { canceled: false, filePaths: [vaultPath] },
    knowledgeBaseGuideUrl: (kind, action) => (
      kind === 'unsafe'
        ? 'http://example.com/unsafe'
        : `https://example.com/${kind}/${action}`
    ),
  })
  await harness.ready()

  const status = await harness.ipcHandlers.get('local-knowledge-base:status')(harness.event())
  assert.deepEqual(status, [{ kind: 'obsidian', installed: true, vaultPath: '' }])
  assert.equal(harness.knowledgeBaseResolveCalls[0].home, path.join(directory, 'Home'))

  const opened = await harness.ipcHandlers.get('local-knowledge-base:open-guide')(
    harness.event(), 'feishu', 'login',
  )
  assert.equal(opened, true)
  assert.deepEqual(harness.externalUrls, ['https://example.com/feishu/login'])

  const unsafe = await harness.ipcHandlers.get('local-knowledge-base:open-guide')(
    harness.event(), 'unsafe', 'login',
  )
  assert.equal(unsafe, false)
  assert.deepEqual(harness.externalUrls, ['https://example.com/feishu/login'])

  const picked = await harness.ipcHandlers.get('local-knowledge-base:pick-obsidian-vault')(
    harness.event(),
  )
  assert.deepEqual(harness.dialogCalls[0][1], {
    properties: ['openDirectory', 'createDirectory'],
  })
  assert.deepEqual(harness.knowledgeBaseStoreInstances[0].savedVaultPaths, [vaultPath])
  assert.deepEqual(picked, [{ kind: 'obsidian', installed: true, vaultPath }])
})

test('Knowledge base status IPC shares concurrent source probes', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-knowledge-base-single-flight-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const result = deferred()
  const expected = [{ kind: 'feishu', installed: true, ready: true }]
  const { harness } = loadMain(directory, {
    resolveKnowledgeBaseSources: () => result.promise,
  })
  await harness.ready()
  const status = harness.ipcHandlers.get('local-knowledge-base:status')

  const first = status(harness.event())
  const second = status(harness.event())
  await waitFor(() => harness.knowledgeBaseResolveCalls.length === 1)
  assert.equal(harness.knowledgeBaseResolveCalls.length, 1)

  result.resolve(expected)
  assert.deepEqual(await Promise.all([first, second]), [expected, expected])

  assert.deepEqual(await status(harness.event()), expected)
  assert.equal(harness.knowledgeBaseResolveCalls.length, 2)
})

test('Knowledge base selections derive safe access from main-process source status', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-knowledge-base-selection-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const source = {
    kind: 'dingtalk',
    label: 'DingTalk',
    accessMode: 'cli',
    commandName: 'dws',
    ready: true,
  }
  const hintCalls = []
  const { harness } = loadMain(directory, {
    knowledgeBaseSources: [source],
    knowledgeBaseSelectionHint: (cachedSource, targetKinds) => {
      hintCalls.push({ cachedSource, targetKinds })
      return cachedSource?.kind === 'dingtalk' ? {
        kind: 'dingtalk',
        name: 'DingTalk',
        accessMode: 'cli',
        commandName: cachedSource.commandName,
        targetKinds,
      } : null
    },
  })
  await harness.ready()

  const validate = harness.workspaceInstances[0].input.validateKnowledgeBaseSelections
  const validated = await validate(['codex', 'hermes'], [{
    kind: 'dingtalk',
    targetKinds: ['hermes'],
    commandName: 'renderer-controlled-command',
  }])

  assert.deepEqual(validated, [{
    kind: 'dingtalk', name: 'DingTalk', accessMode: 'cli',
    commandName: 'dws', targetKinds: ['hermes'],
  }])
  assert.deepEqual(hintCalls, [{ cachedSource: source, targetKinds: ['hermes'] }])
  assert.equal(harness.knowledgeBaseResolveCalls.length, 1)

  await assert.rejects(validate(['codex'], [{
    kind: 'dingtalk', targetKinds: ['hermes'],
  }]), { message: 'LOCAL_KNOWLEDGE_BASE_SELECTION_INVALID' })
})

test('directory picker uses the operating system localized title', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-directory-dialog-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory)
  await harness.ready()

  const selected = await harness.ipcHandlers.get('local-workspace:pick-directory')(harness.event())

  assert.equal(selected, '')
  assert.equal(harness.dialogCalls.length, 1)
  assert.deepEqual(harness.dialogCalls[0][1], {
    properties: ['openDirectory', 'createDirectory'],
  })
})

test('Skills IPC uses the installed-Agent gate and the shared local catalog', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-skills-ipc-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const skillsResult = {
    supported: true,
    total: 1,
    limit: 100,
    skills: [{ targetKind: 'codex', namespace: 'global', slug: 'review', name: 'Review' }],
  }
  const { harness } = loadMain(directory, { skillsResult })
  await harness.ready()

  const result = await harness.ipcHandlers.get('local-agent-installer:skills')(
    harness.event(), 'codex',
  )

  assert.deepEqual(result, skillsResult)
  assert.equal(harness.installerInstances[0].skillsKind, 'codex')
  assert.deepEqual(harness.installerInstances[0].input.listSkills('codex'), skillsResult)
  assert.deepEqual(harness.skillCatalogInstances[0].listCalls, ['codex'])
})

test('image IPC returns bounded previews and never exposes imported file paths', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-image-ipc-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const first = path.join(directory, 'diagram.png')
  const second = path.join(directory, 'flow.png')
  const third = path.join(directory, 'overflow.png')
  const { harness } = loadMain(directory, {
    dialogResult: { canceled: false, filePaths: [first, second, third] },
  })
  await harness.ready()

  const picked = await harness.ipcHandlers.get('local-attachments:pick')(
    harness.event(), 2,
  )
  assert.equal(picked.attachments.length, 2)
  assert.equal(picked.truncated, true)
  assert.deepEqual(harness.attachmentInstances[0].importedFiles, [first, second])
  assert.deepEqual(harness.dialogCalls[0][1], {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Media', extensions: ['png', 'jpg', 'jpeg', 'mp3', 'wav', 'm4a', 'mp4', 'mov', 'webm'] }],
  })
  for (const attachment of picked.attachments) {
    assert.deepEqual(Object.keys(attachment).sort(), [
      'id', 'mimeType', 'name', 'previewDataUrl', 'size',
    ])
    assert.equal(attachment.previewDataUrl, 'data:image/png;base64,AQID')
    assert.equal(JSON.stringify(attachment).includes(directory), false)
  }

  const imported = await harness.ipcHandlers.get('local-attachments:import')(
    harness.event(),
    { name: 'paste.png', mimeType: 'image/png', bytes: [1, 2, 3] },
  )
  assert.equal(imported.name, 'paste.png')
  assert.equal(imported.previewDataUrl, 'data:image/png;base64,AQID')
  assert.deepEqual(harness.attachmentInstances[0].importedBuffers, [
    { name: 'paste.png', mimeType: 'image/png', bytes: [1, 2, 3] },
  ])

  const previewed = await harness.ipcHandlers.get('local-attachments:preview')(
    harness.event(), picked.attachments[0].id,
  )
  assert.equal(previewed.previewDataUrl, 'data:image/png;base64,AQID')
  assert.deepEqual(harness.attachmentInstances[0].readWithMetadataCalls, [
    picked.attachments[0].id,
    picked.attachments[1].id,
    imported.id,
    picked.attachments[0].id,
  ])
  assert.deepEqual(harness.attachmentInstances[0].resolved, [])
  assert.equal('path' in previewed, false)
})

test('image picker does not import files after application shutdown starts', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-image-shutdown-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const dialogResult = deferred()
  const selected = path.join(directory, 'late-selection.png')
  const { harness } = loadMain(directory, { dialogResult: dialogResult.promise })
  await harness.ready()

  const picking = harness.ipcHandlers.get('local-attachments:pick')(harness.event())
  await waitFor(() => harness.dialogCalls.length === 1)
  harness.appListeners.get('before-quit')({ preventDefault: () => {} })
  dialogResult.resolve({ canceled: false, filePaths: [selected] })

  await assert.rejects(picking, { message: 'DESKTOP_CLIENT_SHUTTING_DOWN' })
  assert.deepEqual(harness.attachmentInstances[0].importedFiles, [])
})

test('image dimensions are bounded before nativeImage decoding and checked again afterward', async (t) => {
  const firstDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-image-pixels-before-'))
  const secondDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-image-pixels-after-'))
  t.after(() => fs.rmSync(firstDirectory, { recursive: true, force: true }))
  t.after(() => fs.rmSync(secondDirectory, { recursive: true, force: true }))
  const oversizedBeforeDecode = loadMain(firstDirectory, {
    attachmentBytes: pngHeader(8193, 4096),
  })
  await oversizedBeforeDecode.harness.ready()

  await assert.rejects(
    async () => oversizedBeforeDecode.harness.ipcHandlers.get('local-attachments:import')(
      oversizedBeforeDecode.harness.event(),
      { name: 'large.png', mimeType: 'image/png', bytes: [1, 2, 3] },
    ),
    { message: 'LOCAL_ATTACHMENT_TOO_LARGE' },
  )
  assert.equal(oversizedBeforeDecode.harness.nativeImageCalls.length, 0)
  assert.equal(oversizedBeforeDecode.harness.attachmentInstances[0].discarded.length, 1)

  const oversizedAfterDecode = loadMain(secondDirectory, {
    attachmentBytes: pngHeader(1, 1),
    nativeImageSize: { width: 8193, height: 4096 },
  })
  await oversizedAfterDecode.harness.ready()
  await assert.rejects(
    async () => oversizedAfterDecode.harness.ipcHandlers.get('local-attachments:import')(
      oversizedAfterDecode.harness.event(),
      { name: 'decoded-large.png', mimeType: 'image/png', bytes: [1, 2, 3] },
    ),
    { message: 'LOCAL_ATTACHMENT_TOO_LARGE' },
  )
  assert.equal(oversizedAfterDecode.harness.nativeImageCalls.length, 1)
  assert.equal(oversizedAfterDecode.harness.attachmentInstances[0].discarded.length, 1)
})

test('discard IPC is idempotent and refuses to delete attachments referenced by messages', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-discard-ipc-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory, {
    workspaceSnapshot: {
      agents: [],
      groups: [{ id: 'group-1' }],
      messages: [{
        groupId: 'group-1',
        attachments: [{ id: 'referenced' }],
      }],
      localOnly: true,
    },
  })
  await harness.ready()
  const discard = harness.ipcHandlers.get('local-attachments:discard')

  assert.deepEqual(
    await discard(harness.event(), ['referenced', 'orphan', 'already-absent', 'orphan']),
    {
      discardedIds: ['orphan', 'already-absent'],
      retainedIds: ['referenced'],
    },
  )
  assert.deepEqual(harness.attachmentInstances[0].discarded, [
    ['orphan', 'already-absent'],
  ])
  assert.deepEqual(
    await discard(harness.event(), ['already-absent']),
    { discardedIds: ['already-absent'], retainedIds: [] },
  )
})

test('deleting a conversation removes only attachments no longer referenced elsewhere', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-delete-attachments-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory, {
    workspaceSnapshot: {
      agents: [],
      groups: [{ id: 'group-one' }, { id: 'group-two' }],
      messages: [
        {
          groupId: 'group-one',
          attachments: [{ id: 'shared' }, { id: 'only-one' }],
        },
        { groupId: 'group-two', attachments: [{ id: 'shared' }] },
      ],
      localOnly: true,
    },
  })
  await harness.ready()

  const snapshot = await harness.ipcHandlers.get('local-workspace:delete-group')(
    harness.event(), 'group-one',
  )

  assert.deepEqual(snapshot.groups, [{ id: 'group-two' }])
  assert.deepEqual(snapshot.messages, [
    { groupId: 'group-two', attachments: [{ id: 'shared' }] },
  ])
  assert.deepEqual(harness.attachmentInstances[0].discarded, [['only-one']])
})

test('deleting a message normalizes identifiers and discards only newly unreferenced attachments', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-delete-message-attachments-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory, {
    workspaceSnapshot: {
      agents: [],
      groups: [{ id: '42' }],
      messages: [
        {
          id: '7', groupId: '42', role: 'agent',
          attachments: [{ id: 'shared' }, { id: 'only-message' }],
        },
        {
          id: '8', groupId: '42', role: 'agent',
          attachments: [{ id: 'shared' }],
        },
      ],
      localOnly: true,
    },
  })
  await harness.ready()

  const snapshot = await harness.ipcHandlers.get('local-workspace:delete-message')(
    harness.event(), 42, 7,
  )

  assert.deepEqual(harness.workspaceInstances[0].deleteMessageCalls, [['42', '7']])
  assert.deepEqual(snapshot.messages, [{
    id: '8', groupId: '42', role: 'agent', attachments: [{ id: 'shared' }],
  }])
  assert.deepEqual(harness.attachmentInstances[0].discarded, [['only-message']])
})

test('configured Provider is injected only through local Agent execution options', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-provider-routing-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory, {
    providerConfigured: true,
    nativeEnvironment: kind => kind === 'hermes'
      ? { ANTHROPIC_API_KEY: 'native-hermes-key' }
      : {},
  })
  await harness.ready()

  await harness.workspaceInstances[0].input.runAgent(
    { kind: 'hermes', executable: '/tmp/hermes' },
    'hello', directory, { env: { CURRENT_RUN: '1' } },
  )

  const options = harness.runAgentCalls[0][3]
  assert.deepEqual(options.provider, { id: 'openai-api', model: 'example-model' })
  assert.equal(options.env.OPENAI_API_KEY, 'provider-key')
  assert.equal(options.env.OPENAI_BASE_URL, PROVIDER_METADATA.baseUrl)
  assert.equal(options.env.OPENAI_MODEL, PROVIDER_METADATA.model)
  assert.equal(options.env.HERMES_INFERENCE_PROVIDER, 'openai-api')
  assert.equal(options.env.HERMES_INFERENCE_MODEL, PROVIDER_METADATA.model)
  assert.equal(options.env.ANTHROPIC_API_KEY, 'native-hermes-key')
  assert.equal(options.env.CURRENT_RUN, '1')
})

test('OpenClaw native auth is routed through the app-owned isolated runtime', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-openclaw-native-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const credentialChecks = []
  const { harness } = loadMain(directory, {
    moduleMocks: {
      './local-agent-readiness.cjs': {
        nativeCredentialEnvironment: kind => kind === 'openclaw'
          ? {
            OPENCLAW_NATIVE_CONFIG: 'available',
            OPENAI_API_KEY: 'unrelated-openai-key',
            OPENROUTER_API_KEY: 'unrelated-openrouter-key',
          }
          : {},
        resolveNativeOpenClawRuntime: async () => ({
          model: 'native/model',
          provider: {
            id: 'native',
            baseUrl: 'https://native.example.com/v1',
            api: 'openai-completions',
            apiKey: 'native-openclaw-key',
            model: { id: 'model', name: 'Native Model', input: ['text'] },
          },
        }),
        resolveNativeCredentialState: async (kind, input) => {
          credentialChecks.push({ kind, input })
          return { state: 'ready', source: 'native-credential' }
        },
      },
    },
  })
  await harness.ready()
  const workspace = harness.workspaceInstances[0]

  const readiness = await workspace.input.credentialState('openclaw', {
    executable: '/tmp/openclaw',
  })
  assert.deepEqual(readiness, { state: 'ready', source: 'native-credential' })
  assert.deepEqual(credentialChecks, [{
    kind: 'openclaw',
    input: { executable: '/tmp/openclaw' },
  }])

  await workspace.input.runAgent(
    { kind: 'openclaw', executable: '/tmp/openclaw' },
    'hello', directory, { sessionRef: 'agent:main:desktop-native-openclaw' },
  )
  const options = harness.runAgentCalls[0][3]
  assert.equal(Object.hasOwn(options.env, 'OPENCLAW_NATIVE_CONFIG'), false)
  assert.equal(Object.hasOwn(options.env, 'OPENAI_API_KEY'), false)
  assert.equal(Object.hasOwn(options.env, 'OPENROUTER_API_KEY'), false)
  assert.equal(Object.hasOwn(options.env, 'MANAGED_OPENCLAW'), false)
  const isolated = JSON.parse(options.env.NATIVE_OPENCLAW)
  assert.equal(isolated.workdir, directory)
  assert.equal(isolated.sessionRef, 'agent:main:desktop-native-openclaw')
  assert.equal(isolated.allowWrite, false)
  assert.deepEqual(isolated.runtime, {
    model: 'native/model',
    provider: {
      id: 'native',
      baseUrl: 'https://native.example.com/v1',
      api: 'openai-completions',
      apiKey: 'native-openclaw-key',
      model: { id: 'model', name: 'Native Model', input: ['text'] },
    },
  })
})

test('manual Agent refreshes remain serialized', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-refresh-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const firstGate = deferred()
  const secondGate = deferred()
  const { harness } = loadMain(directory, {
    onRefresh: async (_workspace, count) => {
      if (count === 1) await firstGate.promise
      if (count === 2) await secondGate.promise
    },
  })
  await harness.ready()
  const handler = harness.ipcHandlers.get('local-workspace:refresh-agents')

  const first = handler(harness.event())
  const second = handler(harness.event())
  await waitFor(() => harness.workspaceInstances[0].refreshCount === 1)
  assert.equal(harness.workspaceInstances[0].maxConcurrentRefreshes, 1)

  firstGate.resolve()
  await waitFor(() => harness.workspaceInstances[0].refreshCount === 2)
  assert.equal(harness.workspaceInstances[0].maxConcurrentRefreshes, 1)
  secondGate.resolve()
  await Promise.all([first, second])
  assert.equal(harness.workspaceInstances[0].clearRuntimeCredentialFailuresCount, 0)
  assert.equal(harness.installerInstances[0].invalidateCount, 2)
  assert.equal(harness.skillCatalogInstances[0].invalidateCalls, 2)
})

test('before-quit waits for local workspace and installer cleanup', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-quit-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspaceStopGate = deferred()
  const installerIdleGate = deferred()
  const { harness } = loadMain(directory, {
    workspaceStopGate,
    installerIdleGate,
    windowFocused: false,
    installerState: { phase: 'installing', canCancel: true, taskId: 'task-1' },
  })
  await harness.ready()
  let prevented = 0

  harness.appListeners.get('before-quit')({ preventDefault: () => { prevented += 1 } })
  assert.equal(prevented, 1)
  assert.equal(harness.installerInstances[0].pendingCancelCount, 1)
  assert.deepEqual(harness.installerInstances[0].cancelled, ['task-1'])
  assert.equal(harness.quitCount, 0)

  harness.workspaceInstances[0].emit('run-finished', {
    groupId: 'group-1', status: 'stopped', targetKinds: [], completedKinds: [],
  })
  assert.equal(harness.notificationInstances.length, 0)

  for (const channel of LOCAL_IPC_CHANNELS) {
    await assert.rejects(
      Promise.resolve().then(() => harness.ipcHandlers.get(channel)(harness.event())),
      { message: 'DESKTOP_CLIENT_SHUTTING_DOWN' },
      `${channel} should reject after shutdown starts`,
    )
  }

  workspaceStopGate.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(harness.quitCount, 0)
  installerIdleGate.resolve()
  await waitFor(() => harness.quitCount === 1)
  assert.equal(harness.workspaceInstances[0].stopCount, 1)
})
