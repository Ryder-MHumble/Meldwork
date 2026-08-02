const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

function loadPreload(protocol) {
  const invocations = []
  const listeners = new Map()
  let exposedName
  let exposed
  const electron = {
    contextBridge: {
      exposeInMainWorld: (name, value) => { exposedName = name; exposed = value },
    },
    ipcRenderer: {
      invoke: (channel, ...args) => {
        invocations.push({ channel, args })
        return Promise.resolve({ configured: true })
      },
      on: (channel, listener) => listeners.set(channel, listener),
      removeListener: (channel, listener) => {
        if (listeners.get(channel) === listener) listeners.delete(channel)
      },
      send: () => {},
    },
  }
  const originalLoad = Module._load
  const originalWindow = global.window
  const originalLocation = global.location
  const originalLocalStorage = global.localStorage
  const originalSetInterval = global.setInterval
  Module._load = function load(request, parent, isMain) {
    if (request === 'electron') return electron
    return originalLoad.call(this, request, parent, isMain)
  }
  global.window = { addEventListener: () => {} }
  global.location = { protocol }
  global.localStorage = { getItem: () => '' }
  global.setInterval = () => 0
  const filename = require.resolve('../src/preload.cjs')
  delete require.cache[filename]
  try {
    require(filename)
  } finally {
    Module._load = originalLoad
    global.window = originalWindow
    global.location = originalLocation
    global.localStorage = originalLocalStorage
    global.setInterval = originalSetInterval
    delete require.cache[filename]
  }
  return { api: exposed, exposedName, invocations, listeners }
}

test('local preload exposes the local-only RoundRelay API and narrow Provider methods', async () => {
  const { api, exposedName, invocations } = loadPreload('file:')

  assert.equal(exposedName, 'roundrelayDesktop')
  assert.equal(Object.isFrozen(api), true)
  assert.equal(api.localOnly, true)
  assert.equal(api.platform, process.platform)
  assert.equal(Object.isFrozen(api.localAgentProvider), true)
  assert.deepEqual(
    Object.keys(api.localWorkspace).sort(),
    [
      'createGroup', 'defaultDirectory', 'deleteGroup', 'get', 'onChanged',
      'onOpenGroup', 'onRunEvent', 'onRunFinished', 'pickDirectory', 'refreshAgents', 'send',
      'stop', 'updateGroup',
    ].sort(),
  )
  assert.equal('configure' in api.localWorkspace, false)
  assert.equal('cancelConfigure' in api.localWorkspace, false)
  assert.deepEqual(
    Object.keys(api.localAgentProvider).sort(),
    ['activate', 'delete', 'probe', 'save', 'status'],
  )
  assert.equal('envForAgent' in api.localAgentProvider, false)
  assert.equal('read' in api.localAgentProvider, false)

  await api.localAgentProvider.status('hermes')
  await api.localAgentProvider.probe('hermes')
  await api.localAgentProvider.save('hermes', {
    provider: 'Example', baseUrl: 'https://api.example.com/v1',
    model: 'example-model', apiKey: 'test-renderer-key', preset: 'custom',
  })
  await api.localAgentProvider.activate('hermes', 'custom')
  await api.localAgentProvider.delete('hermes', 'custom')
  assert.deepEqual(invocations.map(call => call.channel), [
    'local-agent-provider:status',
    'local-agent-provider:probe',
    'local-agent-provider:save',
    'local-agent-provider:activate',
    'local-agent-provider:delete',
  ])
  assert.deepEqual(invocations.map(call => call.args[0]), [
    'hermes', 'hermes', 'hermes', 'hermes', 'hermes',
  ])
})

test('local preload exposes only narrow knowledge source methods', async () => {
  const { api, invocations } = loadPreload('file:')

  assert.equal(Object.isFrozen(api.localKnowledgeBase), true)
  assert.deepEqual(
    Object.keys(api.localKnowledgeBase).sort(),
    ['openGuide', 'pickObsidianVault', 'status'],
  )
  assert.equal('readVault' in api.localKnowledgeBase, false)
  assert.equal('runCommand' in api.localKnowledgeBase, false)

  await api.localKnowledgeBase.status()
  await api.localKnowledgeBase.openGuide('feishu', 'login')
  await api.localKnowledgeBase.pickObsidianVault()

  assert.deepEqual(invocations, [
    { channel: 'local-knowledge-base:status', args: [] },
    { channel: 'local-knowledge-base:open-guide', args: ['feishu', 'login'] },
    { channel: 'local-knowledge-base:pick-obsidian-vault', args: [] },
  ])
})

test('local preload exposes cancellable read-only run lifecycle subscriptions', () => {
  const { api, invocations, listeners } = loadPreload('file:')
  const finished = []
  const events = []
  const opened = []
  const cancelFinished = api.localWorkspace.onRunFinished(result => finished.push(result))
  const cancelEvent = api.localWorkspace.onRunEvent(event => events.push(event))
  const cancelOpened = api.localWorkspace.onOpenGroup(request => opened.push(request))

  listeners.get('local-workspace:run-finished')({}, {
    groupId: 'group-1', status: 'completed',
  })
  listeners.get('local-workspace:run-event')({}, {
    runId: 'run-1', agentRunId: 'agent-1', type: 'status', status: 'running',
  })
  listeners.get('local-workspace:open-group')({}, { groupId: 'group-1' })
  assert.deepEqual(finished, [{ groupId: 'group-1', status: 'completed' }])
  assert.deepEqual(events, [{
    runId: 'run-1', agentRunId: 'agent-1', type: 'status', status: 'running',
  }])
  assert.deepEqual(opened, [{ groupId: 'group-1' }])
  assert.deepEqual(invocations, [])

  cancelFinished()
  cancelEvent()
  cancelOpened()
  assert.equal(listeners.has('local-workspace:run-finished'), false)
  assert.equal(listeners.has('local-workspace:run-event'), false)
  assert.equal(listeners.has('local-workspace:open-group'), false)
})

test('local preload binds stop requests to the visible run identifier', async () => {
  const { api, invocations } = loadPreload('file:')

  await api.localWorkspace.stop('group-1', 'run-1')

  assert.deepEqual(invocations, [
    { channel: 'local-workspace:stop', args: ['group-1', 'run-1'] },
  ])
})

test('local preload exposes only the narrow Agent installer methods', async () => {
  const { api, invocations } = loadPreload('file:')

  assert.equal(Object.isFrozen(api.agentInstaller), true)
  assert.deepEqual(
    Object.keys(api.agentInstaller).sort(),
    ['cancel', 'catalog', 'onChanged', 'setSidebarVisibility', 'skills', 'start', 'state'],
  )
  await api.agentInstaller.skills('codex')
  await api.agentInstaller.setSidebarVisibility('hermes', true)
  assert.deepEqual(invocations, [
    { channel: 'local-agent-installer:skills', args: ['codex'] },
    { channel: 'local-agent-installer:set-sidebar-visibility', args: ['hermes', true] },
  ])
})

test('local preload exposes image import without filesystem read or path resolution methods', async () => {
  const { api, invocations } = loadPreload('file:')

  assert.equal(Object.isFrozen(api.localAttachments), true)
  assert.deepEqual(
    Object.keys(api.localAttachments).sort(),
    ['discard', 'importImage', 'pickImages', 'preview'],
  )
  assert.equal('read' in api.localAttachments, false)
  assert.equal('resolve' in api.localAttachments, false)
  const bytes = Uint8Array.from([1, 2, 3])
  await api.localAttachments.pickImages(2)
  await api.localAttachments.importImage({
    name: 'diagram.png', mimeType: 'image/png', bytes,
  })
  bytes[0] = 9
  await api.localAttachments.preview('attachment-1')
  await api.localAttachments.discard(['attachment-1'])
  assert.deepEqual(invocations, [
    { channel: 'local-attachments:pick-images', args: [2] },
    {
      channel: 'local-attachments:import-image',
      args: [{ name: 'diagram.png', mimeType: 'image/png', bytes: Uint8Array.from([1, 2, 3]) }],
    },
    { channel: 'local-attachments:preview', args: ['attachment-1'] },
    { channel: 'local-attachments:discard', args: [['attachment-1']] },
  ])
})

test('local preload rejects unbounded or unsupported renderer image payloads before IPC', async () => {
  const { api, invocations } = loadPreload('file:')

  assert.throws(
    () => api.localAttachments.importImage({
      name: 'array.png', mimeType: 'image/png', bytes: [1, 2, 3],
    }),
    { code: 'LOCAL_ATTACHMENT_BYTES_INVALID' },
  )
  assert.throws(
    () => api.localAttachments.importImage({
      name: 'animation.gif', mimeType: 'image/gif', bytes: Uint8Array.from([1]),
    }),
    { code: 'LOCAL_ATTACHMENT_TYPE_UNSUPPORTED' },
  )
  assert.throws(
    () => api.localAttachments.importImage({
      name: 'preview.webp', mimeType: 'image/webp', bytes: Uint8Array.from([1]),
    }),
    { code: 'LOCAL_ATTACHMENT_TYPE_UNSUPPORTED' },
  )
  assert.throws(
    () => api.localAttachments.importImage({
      name: 'large.png', mimeType: 'image/png', bytes: new Uint8Array((8 * 1024 * 1024) + 1),
    }),
    { code: 'LOCAL_ATTACHMENT_TOO_LARGE' },
  )
  assert.deepEqual(invocations, [])
})

test('remote preload does not expose local credentials, workspace, or installer APIs', () => {
  const { api, exposedName } = loadPreload('https:')

  assert.equal(exposedName, 'roundrelayDesktop')
  assert.equal(api.isDesktop, true)
  assert.equal(api.localOnly, true)
  assert.equal('getAuthToken' in api, false)
  assert.equal('localWorkspace' in api, false)
  assert.equal('agentInstaller' in api, false)
  assert.equal('localAttachments' in api, false)
  assert.equal('localAgentProvider' in api, false)
  assert.equal('localKnowledgeBase' in api, false)
})
