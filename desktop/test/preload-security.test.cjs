const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

function loadPreload(protocol) {
  const invocations = []
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
      on: () => {},
      removeListener: () => {},
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
  return { api: exposed, exposedName, invocations }
}

test('local preload exposes the local-only RoundRelay API and narrow Provider methods', async () => {
  const { api, exposedName, invocations } = loadPreload('file:')

  assert.equal(exposedName, 'roundrelayDesktop')
  assert.equal(Object.isFrozen(api), true)
  assert.equal(api.localOnly, true)
  assert.equal(Object.isFrozen(api.localAgentProvider), true)
  assert.deepEqual(
    Object.keys(api.localWorkspace).sort(),
    [
      'createGroup', 'defaultDirectory', 'deleteGroup', 'get', 'onChanged',
      'pickDirectory', 'refreshAgents', 'send', 'startAuto', 'stop', 'updateGroup',
    ].sort(),
  )
  assert.equal('configure' in api.localWorkspace, false)
  assert.equal('cancelConfigure' in api.localWorkspace, false)
  assert.deepEqual(
    Object.keys(api.localAgentProvider).sort(),
    ['delete', 'probe', 'save', 'status'],
  )
  assert.equal('envForAgent' in api.localAgentProvider, false)
  assert.equal('read' in api.localAgentProvider, false)

  await api.localAgentProvider.status()
  await api.localAgentProvider.probe()
  await api.localAgentProvider.save({
    provider: 'Example', baseUrl: 'https://api.example.com/v1',
    model: 'example-model', apiKey: 'test-renderer-key',
  })
  await api.localAgentProvider.delete()
  assert.deepEqual(invocations.map(call => call.channel), [
    'local-agent-provider:status',
    'local-agent-provider:probe',
    'local-agent-provider:save',
    'local-agent-provider:delete',
  ])
})

test('local preload exposes only the narrow Agent installer methods', async () => {
  const { api, invocations } = loadPreload('file:')

  assert.equal(Object.isFrozen(api.agentInstaller), true)
  assert.deepEqual(
    Object.keys(api.agentInstaller).sort(),
    ['cancel', 'catalog', 'onChanged', 'setSidebarVisibility', 'start', 'state'],
  )
  await api.agentInstaller.setSidebarVisibility('hermes', true)
  assert.deepEqual(invocations, [
    { channel: 'local-agent-installer:set-sidebar-visibility', args: ['hermes', true] },
  ])
})

test('remote preload does not expose local credentials, workspace, or installer APIs', () => {
  const { api, exposedName } = loadPreload('https:')

  assert.equal(exposedName, 'roundrelayDesktop')
  assert.equal(api.isDesktop, true)
  assert.equal(api.localOnly, true)
  assert.equal('getAuthToken' in api, false)
  assert.equal('localWorkspace' in api, false)
  assert.equal('agentInstaller' in api, false)
  assert.equal('localAgentProvider' in api, false)
})
