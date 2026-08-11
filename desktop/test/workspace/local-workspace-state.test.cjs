const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadWorkspaceState } = require('../../src/workspace/local-workspace-state.cjs')

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-workspace-state-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return path.join(directory, 'workspace.json')
}

test('distinguishes missing, corrupt, unreadable, unsupported, and valid workspace state', (t) => {
  const storagePath = fixture(t)

  assert.deepEqual(loadWorkspaceState(storagePath), {
    state: {
      version: 3, groups: [], messages: [], sessions: {}, sessionMeta: {},
      agentPreferences: {}, agentRuntime: {},
    },
    status: 'missing',
    trusted: true,
    diagnostic: '',
  })

  fs.writeFileSync(storagePath, '{invalid json')
  assert.equal(loadWorkspaceState(storagePath).status, 'corrupt')
  assert.equal(loadWorkspaceState(storagePath).diagnostic, 'LOCAL_WORKSPACE_STATE_CORRUPT')

  fs.writeFileSync(storagePath, JSON.stringify({ version: 99, groups: [], messages: [], sessions: {} }))
  assert.equal(loadWorkspaceState(storagePath).status, 'unsupported')
  assert.equal(loadWorkspaceState(storagePath).diagnostic, 'LOCAL_WORKSPACE_STATE_UNSUPPORTED')

  fs.rmSync(storagePath)
  fs.mkdirSync(storagePath)
  assert.equal(loadWorkspaceState(storagePath).status, 'unreadable')
  assert.equal(loadWorkspaceState(storagePath).diagnostic, 'LOCAL_WORKSPACE_STATE_UNREADABLE')

  fs.rmSync(storagePath, { recursive: true })
  fs.writeFileSync(storagePath, JSON.stringify({ version: 3, groups: [], messages: [], sessions: {} }))
  assert.equal(loadWorkspaceState(storagePath).status, 'ready')
  assert.equal(loadWorkspaceState(storagePath).trusted, true)
})
