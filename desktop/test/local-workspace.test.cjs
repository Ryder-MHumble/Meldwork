const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { LocalWorkspace } = require('../src/local-workspace.cjs')

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-workspace-'))
  let id = 0
  const calls = []
  const agents = [
    { kind: 'codex', name: 'Codex CLI', executable: '/tmp/codex', version: '1' },
    { kind: 'hermes', name: 'Hermes CLI', executable: '/tmp/hermes', version: '2' },
    { kind: 'workbuddy', name: 'WorkBuddy CLI', executable: '/tmp/codebuddy', version: '3' },
    { kind: 'kimi', name: 'Kimi CLI', executable: '/tmp/kimi', version: '4' },
    { kind: 'openclaw', name: 'OpenClaw CLI', executable: '/tmp/openclaw', version: '5' },
  ]
  const options = {
    storagePath: path.join(directory, 'workspace.json'),
    detectAgents: async () => agents,
    credentialState: async () => ({ state: 'ready', source: 'native-credential' }),
    sharedProviderReady: () => false,
    resolveAttachments: async refs => refs.map(ref => ({
      id: ref.id,
      name: ref.name,
      mimeType: ref.mimeType,
      size: ref.size,
      path: path.join(directory, 'attachments', `${ref.id}.png`),
    })),
    validateSkillSelections: (_kind, selections) => selections,
    imageAttachmentLimit: kind => ({ codex: 4, hermes: 1, opencode: 4 })[kind] || 0,
    runAgent: async (agent, prompt, workdir, runOptions) => {
      calls.push({ agent, prompt, workdir, runOptions })
      return {
        text: `${agent.kind} reply ${calls.length}`,
        sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
      }
    },
    now: () => '2026-07-28T00:00:00.000Z',
    createId: () => `id-${++id}`,
  }
  return { directory, calls, options }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

test('installed Agents distinguish ready, unverified, and missing credential states', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const readinessAgents = []
  options.credentialState = async (kind, agent) => {
    readinessAgents.push(agent)
    if (kind === 'hermes') return { state: 'missing', source: 'shared-provider-required' }
    if (kind === 'kimi') return { state: 'unknown', source: 'unverified' }
    return { state: 'ready', source: 'native-credential' }
  }
  const workspace = new LocalWorkspace(options)

  const snapshot = await workspace.refreshAgents()
  const codex = snapshot.agents.find(agent => agent.kind === 'codex')
  const hermes = snapshot.agents.find(agent => agent.kind === 'hermes')
  const kimi = snapshot.agents.find(agent => agent.kind === 'kimi')

  assert.equal(codex.installed, true)
  assert.equal(codex.available, true)
  assert.equal(codex.showInSidebar, true)
  assert.equal(hermes.installed, true)
  assert.equal(hermes.available, false)
  assert.equal(hermes.credentialState, 'missing')
  assert.equal(hermes.showInSidebar, false)
  assert.equal(kimi.available, false)
  assert.equal(kimi.credentialState, 'unknown')
  assert.equal(kimi.showInSidebar, false)
  assert.equal(readinessAgents.find(agent => agent.kind === 'kimi').executable, '/tmp/kimi')
})

test('an unverified installed Agent stays unavailable until credentials are detected', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let kimiState = { state: 'unknown', source: 'unverified' }
  options.credentialState = async kind => kind === 'kimi'
    ? kimiState
    : { state: 'ready', source: 'native-credential' }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()

  assert.throws(() => workspace.createGroup({
    name: '首次验证', agentKinds: ['kimi'], workdir: directory,
  }), { message: 'LOCAL_GROUP_AGENT_REQUIRED' })

  kimiState = { state: 'ready', source: 'native-credential' }
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '首次验证', agentKinds: ['kimi'], workdir: directory,
  })
  await workspace.sendMessage({ groupId: group.id, text: '测试', targetKinds: ['kimi'] })

  assert.equal(calls[0].agent.kind, 'kimi')
  const kimi = workspace.snapshot().agents.find(agent => agent.kind === 'kimi')
  assert.equal(kimi.credentialState, 'ready')
  assert.equal(kimi.available, true)
  assert.equal(kimi.availabilitySource, 'verified-run')
})

test('an authentication failure keeps an Agent unavailable when later detection is unverified', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let nativeState = { state: 'ready', source: 'native-credential' }
  options.credentialState = async () => nativeState
  options.runAgent = async () => { throw new Error('Please log in first') }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '待验证', agentKinds: ['kimi'], workdir: directory,
  })

  await workspace.sendMessage({ groupId: group.id, text: '测试', targetKinds: ['kimi'] })
  assert.equal(workspace.snapshot().agents.find(agent => agent.kind === 'kimi').available, false)

  nativeState = { state: 'unknown', source: 'unverified' }
  await workspace.refreshAgents()
  const kimi = workspace.snapshot().agents.find(agent => agent.kind === 'kimi')
  assert.equal(kimi.credentialState, 'missing')
  assert.equal(kimi.available, false)
  assert.equal(kimi.availabilitySource, 'runtime-auth-failure')
})

test('runtime authentication failures require an explicit retry before native evidence recovers', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let nativeState = { state: 'ready', source: 'native-credential' }
  options.credentialState = async () => nativeState
  options.runAgent = async () => { throw new Error('Please log in first') }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '凭据恢复', agentKinds: ['kimi'], workdir: directory,
  })
  await workspace.sendMessage({ groupId: group.id, text: '测试', targetKinds: ['kimi'] })

  await workspace.refreshAgents()

  let kimi = workspace.snapshot().agents.find(agent => agent.kind === 'kimi')
  assert.equal(kimi.credentialState, 'missing')
  assert.equal(kimi.available, false)
  assert.equal(kimi.availabilitySource, 'runtime-auth-failure')

  assert.equal(workspace.clearRuntimeCredentialFailures(), true)
  await workspace.refreshAgents()

  kimi = workspace.snapshot().agents.find(agent => agent.kind === 'kimi')
  assert.equal(kimi.credentialState, 'ready')
  assert.equal(kimi.available, true)
  assert.equal(kimi.availabilitySource, 'native-credential')
})

test('authoritative native logout overrides historical successful runs', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let nativeState = { state: 'ready', source: 'native-auth-status' }
  options.credentialState = async () => nativeState
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '退出登录', agentKinds: ['codex'], workdir: directory,
  })
  await workspace.sendMessage({ groupId: group.id, text: '测试', targetKinds: ['codex'] })

  nativeState = { state: 'missing', source: 'native-auth-status' }
  await workspace.refreshAgents()

  const codex = workspace.snapshot().agents.find(agent => agent.kind === 'codex')
  assert.equal(codex.credentialState, 'missing')
  assert.equal(codex.available, false)
  assert.equal(codex.availabilitySource, 'native-auth-status')
})

test('a slow readiness refresh cannot overwrite a concurrent runtime authentication failure', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let refreshing = false
  let releaseClaude
  options.credentialState = async (kind) => {
    if (refreshing && kind === 'kimi') return { state: 'unknown', source: 'unverified' }
    if (refreshing && kind === 'hermes') {
      return new Promise(resolve => { releaseClaude = resolve })
    }
    return { state: 'ready', source: 'native-credential' }
  }
  options.runAgent = async () => { throw new Error('Please log in first') }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '并发刷新', agentKinds: ['kimi'], workdir: directory,
  })

  refreshing = true
  const refresh = workspace.refreshAgents()
  while (!releaseClaude) await new Promise(resolve => setImmediate(resolve))
  await workspace.sendMessage({ groupId: group.id, text: '测试', targetKinds: ['kimi'] })
  releaseClaude({ state: 'ready', source: 'native-credential' })
  await refresh

  const kimi = workspace.snapshot().agents.find(agent => agent.kind === 'kimi')
  assert.equal(kimi.credentialState, 'missing')
  assert.equal(kimi.available, false)
  assert.equal(kimi.availabilitySource, 'runtime-auth-failure')
})

test('sidebar visibility can be disabled, persists, and cannot be enabled for unavailable Agents', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.credentialState = async kind => kind === 'hermes'
    ? { state: 'missing', source: 'none' }
    : { state: 'ready', source: 'native-credential' }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()

  workspace.setSidebarVisibility('codex', false)
  assert.equal(workspace.snapshot().agents.find(agent => agent.kind === 'codex').showInSidebar, false)
  assert.throws(() => workspace.setSidebarVisibility('hermes', true), {
    message: 'LOCAL_AGENT_UNAVAILABLE',
  })

  const restored = new LocalWorkspace(options)
  await restored.refreshAgents()
  assert.equal(restored.snapshot().agents.find(agent => agent.kind === 'codex').showInSidebar, false)
})

test('groups and messages persist without exposing executable paths', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '本地测试群',
    agentKinds: ['codex', 'hermes'],
    workdir: directory,
  })
  await workspace.sendMessage({ groupId: group.id, text: '开始讨论', targetKinds: ['codex'] })

  const restored = new LocalWorkspace(options)
  assert.equal(restored.snapshot().groups[0].name, '本地测试群')
  assert.equal(restored.snapshot().messages.length, 2)
  assert.equal('executable' in workspace.snapshot().agents[0], false)
})

test('Skills are validated and injected only into their selected target Agent', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const validationCalls = []
  options.validateSkillSelections = (kind, selections) => {
    validationCalls.push({ kind, selections })
    return selections
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Skill routing', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const review = {
    targetKind: 'codex', namespace: 'quality', slug: 'review', name: 'Review code',
  }
  const research = {
    targetKind: 'hermes', namespace: 'research', slug: 'sources', name: 'Find sources',
  }

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Compare the implementation',
    targetKinds: ['codex', 'hermes'],
    skillHints: [review, research],
  })

  assert.deepEqual(validationCalls, [
    { kind: 'codex', selections: [review] },
    { kind: 'hermes', selections: [research] },
  ])
  assert.match(calls[0].prompt, /quality\/review: Review code/)
  assert.doesNotMatch(calls[0].prompt, /research\/sources|Find sources/)
  assert.match(calls[1].prompt, /research\/sources: Find sources/)
  assert.doesNotMatch(calls[1].prompt, /quality\/review|Review code/)
  assert.equal(calls[0].runOptions.skills, undefined)
  assert.deepEqual(calls[1].runOptions.skills, ['sources'])
  assert.deepEqual(workspace.snapshot().messages[0].skillHints, [review, research])

  await assert.rejects(
    workspace.sendMessage({
      groupId: group.id,
      text: 'Invalid target',
      targetKinds: ['codex'],
      skillHints: [research],
    }),
    { message: 'LOCAL_SKILL_SELECTION_INVALID' },
  )
  assert.equal(workspace.snapshot().messages.filter(message => message.role === 'user').length, 1)
})

test('image-only messages persist safe metadata and pass resolved paths to supported CLIs', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Image review', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const attachment = {
    id: 'attachment-1', name: 'diagram.png', mimeType: 'image/png', size: 128,
  }

  await workspace.sendMessage({
    groupId: group.id,
    text: '',
    targetKinds: ['codex', 'hermes'],
    attachments: [attachment],
  })

  const expectedPath = path.join(directory, 'attachments', 'attachment-1.png')
  assert.deepEqual(calls.map(call => call.runOptions.attachments), [
    [expectedPath], [expectedPath],
  ])
  const storedMessage = workspace.snapshot().messages[0]
  assert.equal(storedMessage.content, '')
  assert.deepEqual(storedMessage.attachments, [attachment])
  assert.equal(JSON.stringify(storedMessage).includes(expectedPath), false)

  const restored = new LocalWorkspace(options)
  assert.deepEqual(restored.snapshot().messages[0].attachments, [attachment])
})

test('image capability failures happen before a message or Agent run is recorded', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const mixed = workspace.createGroup({
    name: 'Mixed image support', agentKinds: ['codex', 'workbuddy'], workdir: directory,
  })
  const first = { id: 'attachment-1', name: 'one.png', mimeType: 'image/png', size: 10 }
  const second = { id: 'attachment-2', name: 'two.png', mimeType: 'image/png', size: 10 }

  await assert.rejects(
    workspace.sendMessage({
      groupId: mixed.id,
      text: 'Inspect',
      targetKinds: ['codex', 'workbuddy'],
      attachments: [first],
    }),
    { message: 'LOCAL_AGENT_IMAGE_UNSUPPORTED' },
  )

  const hermes = workspace.createGroup({
    name: 'Hermes image limit', agentKinds: ['hermes'], workdir: directory,
  })
  await assert.rejects(
    workspace.sendMessage({
      groupId: hermes.id,
      text: 'Inspect both',
      attachments: [first, second],
    }),
    { message: 'LOCAL_AGENT_IMAGE_LIMIT' },
  )
  assert.equal(calls.length, 0)
  assert.equal(workspace.snapshot().messages.length, 0)
})

test('a failed run-start notification does not leave an active run behind', (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  workspace.on('changed', () => { throw new Error('listener failed') })

  assert.throws(
    () => workspace.beginRun('group-id', 'manual', ['codex'], 'thread-id'),
    { message: 'listener failed' },
  )
  assert.deepEqual(workspace.snapshot().runningGroupIds, [])
})

test('manual send reserves its group throughout asynchronous attachment preflight', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const attachmentGate = deferred()
  options.resolveAttachments = async (refs) => {
    await attachmentGate.promise
    return refs.map(ref => ({
      ...ref,
      path: path.join(directory, 'attachments', `${ref.id}.png`),
    }))
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '预处理占位', agentKinds: ['codex'], workdir: directory,
  })
  const first = workspace.sendMessage({
    groupId: group.id,
    text: 'First',
    targetKinds: ['codex'],
    attachments: [{
      id: 'attachment-first', name: 'first.png', mimeType: 'image/png', size: 10,
    }],
  })

  assert.equal(workspace.snapshot().runs[0].phase, 'preparing')
  await assert.rejects(
    workspace.sendMessage({ groupId: group.id, text: 'Second', targetKinds: ['codex'] }),
    { message: 'LOCAL_GROUP_RUNNING' },
  )
  assert.throws(
    () => workspace.updateGroup(group.id, { workdir: path.join(directory, 'other') }),
    { message: 'LOCAL_GROUP_RUNNING' },
  )
  assert.throws(
    () => workspace.deleteGroup(group.id),
    { message: 'LOCAL_GROUP_RUNNING' },
  )

  attachmentGate.resolve()
  await first

  assert.equal(calls.length, 1)
  assert.deepEqual(
    workspace.snapshot().messages.filter(message => message.role === 'user')
      .map(message => message.content),
    ['First'],
  )
  assert.deepEqual(workspace.snapshot().runningGroupIds, [])
})

test('automatic discussion cannot overtake a manual send in preflight', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const attachmentGate = deferred()
  options.resolveAttachments = async (refs) => {
    await attachmentGate.promise
    return refs.map(ref => ({
      ...ref,
      path: path.join(directory, 'attachments', `${ref.id}.png`),
    }))
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '发送与自动讨论互斥', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', 'Existing topic')
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Manual follow-up',
    targetKinds: ['codex'],
    attachments: [{
      id: 'attachment-follow-up', name: 'follow-up.png', mimeType: 'image/png', size: 10,
    }],
  })

  assert.throws(
    () => workspace.startAuto({ groupId: group.id, maxRounds: 2 }),
    { message: 'LOCAL_GROUP_RUNNING' },
  )
  attachmentGate.resolve()
  await send

  assert.deepEqual(calls.map(call => call.agent.kind), ['codex'])
  assert.equal(workspace.snapshot().messages.some(message => (
    ['system.autoRoundLimit', 'system.autoTimeout'].includes(message.system?.key)
  )), false)
})

test('stopAll waits for an in-flight preflight and prevents it from launching an Agent', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const attachmentEntered = deferred()
  const attachmentGate = deferred()
  options.resolveAttachments = async (refs) => {
    attachmentEntered.resolve()
    await attachmentGate.promise
    return refs.map(ref => ({
      ...ref,
      path: path.join(directory, 'attachments', `${ref.id}.png`),
    }))
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '关闭时预处理', agentKinds: ['codex'], workdir: directory,
  })
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Do not launch',
    targetKinds: ['codex'],
    attachments: [{
      id: 'attachment-shutdown', name: 'shutdown.png', mimeType: 'image/png', size: 10,
    }],
  })
  const stoppedSend = assert.rejects(send, { message: 'LOCAL_AGENT_EXECUTION_STOPPED' })
  await attachmentEntered.promise

  let shutdownComplete = false
  const shutdown = workspace.stopAll().then(() => { shutdownComplete = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(shutdownComplete, false)

  attachmentGate.resolve()
  await Promise.all([stoppedSend, shutdown])

  assert.equal(shutdownComplete, true)
  assert.equal(calls.length, 0)
  assert.equal(workspace.snapshot().messages.length, 0)
  assert.deepEqual(workspace.snapshot().runningGroupIds, [])
})

test('a stale controller cannot clear a newer active run for the same group', (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  const first = workspace.beginRun('group-id', 'manual', ['codex'], '')
  const second = workspace.createRunController('manual', ['hermes'], '')
  workspace.activeRuns.set('group-id', second)

  workspace.finishRun('group-id', first, 'completed')
  assert.equal(workspace.activeRuns.get('group-id'), second)

  workspace.finishRun('group-id', second, 'stopped')
  assert.equal(workspace.activeRuns.has('group-id'), false)
})

test('run-finished listener failures do not change a completed manual result', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Best effort event', agentKinds: ['codex'], workdir: directory,
  })
  workspace.on('run-finished', () => { throw new Error('listener failed') })

  await assert.doesNotReject(workspace.sendMessage({
    groupId: group.id,
    text: 'Complete despite notification failure',
    targetKinds: ['codex'],
  }))

  assert.deepEqual(workspace.snapshot().runningGroupIds, [])
  assert.equal(
    workspace.snapshot().messages.some(message => message.agentKind === 'codex'),
    true,
  )
})

test('workspace loading allowlists local group and message fields', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '',
    icon: 'legacy-icon',
    agentKinds: ['codex'],
    workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Local topic',
    targetKinds: ['codex'],
    contextMessages: [{ sender: 'Remote participant', text: 'REMOTE_ONLY_MARKER' }],
  })

  assert.equal(group.name, '')
  assert.equal('icon' in group, false)
  assert.doesNotMatch(calls[0].prompt, /REMOTE_ONLY_MARKER|Remote participant/)

  const stored = JSON.parse(fs.readFileSync(options.storagePath, 'utf8'))
  stored.groups[0].icon = 'legacy-icon'
  stored.groups[0].channelId = 'remote-channel'
  stored.groups[0].participants = [{ type: 'human', id: 'remote-user' }]
  stored.messages[0].emoji = 'legacy-reaction'
  stored.messages[0].reactions = [{ name: 'thumbs-up' }]
  stored.messages[0].sticker = { id: 'legacy-sticker' }
  stored.messages[0].attachments = [{
    id: 'attachment-safe',
    name: 'diagram.png',
    mimeType: 'image/png',
    size: 128,
    path: '/private/attachment.png',
    previewDataUrl: 'data:image/png;base64,private',
  }]
  stored.messages[0].skillHints = [{
    targetKind: 'codex',
    namespace: 'global',
    slug: 'review',
    name: 'Review',
    path: '/private/SKILL.md',
  }]
  stored.messages[1].elapsedMs = 12.4
  stored.messages[1].toolCalls = [
    ...Array.from({ length: 8 }, () => ({ title: 'write_file', status: 'completed' })),
    { title: '/private/tool-output', status: 'unknown' },
  ]
  stored.messages[1].executable = '/private/agent'
  stored.remoteChannels = [{ id: 'remote-channel' }]
  fs.writeFileSync(options.storagePath, `${JSON.stringify(stored)}\n`)
  const restored = new LocalWorkspace(options)
  const restoredSnapshot = restored.snapshot()
  for (const key of ['icon', 'channelId', 'participants']) {
    assert.equal(key in restoredSnapshot.groups[0], false)
  }
  for (const key of ['emoji', 'reactions', 'sticker']) {
    assert.equal(key in restoredSnapshot.messages[0], false)
  }
  assert.deepEqual(restoredSnapshot.messages[0].attachments, [{
    id: 'attachment-safe', name: 'diagram.png', mimeType: 'image/png', size: 128,
  }])
  assert.deepEqual(restoredSnapshot.messages[0].skillHints, [{
    targetKind: 'codex', namespace: 'global', slug: 'review', name: 'Review',
  }])
  assert.equal(restoredSnapshot.messages[1].elapsedMs, 12)
  assert.equal(restoredSnapshot.messages[1].toolCalls.length, 8)
  assert.deepEqual(restoredSnapshot.messages[1].toolCalls.at(-1), {
    title: 'process', status: 'completed',
  })
  assert.equal('executable' in restoredSnapshot.messages[1], false)
  assert.equal(JSON.stringify(restoredSnapshot).includes('/private/'), false)
  assert.equal(JSON.stringify(restoredSnapshot).includes('previewDataUrl'), false)
  assert.equal('remoteChannels' in restored.state, false)
})

test('direct conversations persist one Agent and reuse its main session history', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const direct = workspace.createGroup({
    name: 'Codex', workdir: directory,
    agentKinds: ['codex', 'hermes'],
    conversationType: 'direct', directAgentKind: 'codex',
  })

  await workspace.sendMessage({ groupId: direct.id, text: '第一条' })
  await workspace.sendMessage({ groupId: direct.id, text: '第二条' })

  assert.deepEqual(direct.agentKinds, ['codex'])
  assert.equal(direct.conversationType, 'direct')
  assert.equal(direct.directAgentKind, 'codex')
  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'codex'])
  assert.deepEqual(calls.map(call => call.runOptions.sessionRef), ['', 'codex-session'])
  const restored = new LocalWorkspace(options)
  assert.deepEqual(restored.snapshot().groups[0], direct)
})

test('Gemini and OpenCode messages keep their Agent names', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Agent names', agentKinds: ['codex'], workdir: directory,
  })

  workspace.addMessage(group.id, 'agent', 'Gemini reply', 'gemini')
  workspace.addMessage(group.id, 'agent', 'OpenCode reply', 'opencode')

  assert.deepEqual(
    workspace.snapshot().messages.map(message => message.senderName),
    ['Gemini', 'OpenCode'],
  )
})

test('native session references are reused per topic and agent', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '会话测试', agentKinds: ['codex', 'hermes', 'workbuddy'], workdir: directory,
  })
  await workspace.sendMessage({ groupId: group.id, text: '第一条', targetKinds: ['codex'] })
  const rootId = workspace.snapshot().messages[0].id
  await workspace.sendMessage({
    groupId: group.id, text: '第二条', targetKinds: ['codex'], threadRootId: rootId,
  })
  const hermesKey = workspace.sessionKey(group.id, 'hermes', rootId)
  workspace.state.sessions[hermesKey] = `roundrelay-${group.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)}-hermes`
  workspace.save()
  await workspace.sendMessage({
    groupId: group.id, text: 'Hermes', targetKinds: ['hermes'], threadRootId: rootId,
  })
  await workspace.sendMessage({
    groupId: group.id, text: 'Hermes 继续', targetKinds: ['hermes'], threadRootId: rootId,
  })
  await workspace.sendMessage({
    groupId: group.id, text: 'WorkBuddy', targetKinds: ['workbuddy'], threadRootId: rootId,
  })
  await workspace.sendMessage({
    groupId: group.id, text: 'WorkBuddy 继续', targetKinds: ['workbuddy'], threadRootId: rootId,
  })

  assert.equal(calls[0].runOptions.sessionRef, '')
  assert.equal(calls[1].runOptions.sessionRef, 'codex-session')
  assert.equal(calls[2].runOptions.sessionRef, '')
  assert.equal(calls[3].runOptions.sessionRef, 'hermes-session')
  assert.equal(calls[4].runOptions.sessionRef, '')
  assert.equal(calls[5].runOptions.sessionRef, 'workbuddy-session')
})

test('different topics do not share native sessions or local transcript context', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '话题隔离', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id, text: '第一话题的唯一内容', targetKinds: ['codex'],
  })
  const firstRoot = workspace.snapshot().messages[0].id
  await workspace.sendMessage({
    groupId: group.id, text: '继续第一话题', targetKinds: ['codex'], threadRootId: firstRoot,
  })
  await workspace.sendMessage({
    groupId: group.id, text: '第二话题的唯一内容', targetKinds: ['codex'],
  })
  const secondRoot = workspace.snapshot().messages.findLast(
    message => message.role === 'user' && !message.threadRootId,
  ).id
  await workspace.sendMessage({
    groupId: group.id, text: '继续第二话题', targetKinds: ['codex'], threadRootId: secondRoot,
  })

  assert.deepEqual(calls.map(call => call.runOptions.sessionRef), [
    '', 'codex-session', '', 'codex-session',
  ])
  assert.match(calls[2].prompt, /第二话题的唯一内容/)
  assert.doesNotMatch(calls[2].prompt, /第一话题的唯一内容/)
})

test('Kimi captures its native session while OpenClaw isolates topics with stable keys', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const first = workspace.createGroup({
    name: '会话 A', agentKinds: ['kimi', 'openclaw'], workdir: directory, allowWrite: true,
  })
  const second = workspace.createGroup({
    name: '会话 B', agentKinds: ['openclaw'], workdir: directory,
  })

  await workspace.sendMessage({ groupId: first.id, text: 'Kimi 1', targetKinds: ['kimi'] })
  const firstRoot = workspace.snapshot().messages[0].id
  const openClawKey = workspace.sessionKey(first.id, 'openclaw', firstRoot)
  workspace.state.sessions[openClawKey] = 'explicit:roundrelay-legacy-openclaw'
  workspace.save()
  await workspace.sendMessage({
    groupId: first.id, text: 'Kimi 2', targetKinds: ['kimi'], threadRootId: firstRoot,
  })
  await workspace.sendMessage({
    groupId: first.id, text: 'OpenClaw 1', targetKinds: ['openclaw'], threadRootId: firstRoot,
  })
  await workspace.sendMessage({
    groupId: first.id, text: 'OpenClaw 2', targetKinds: ['openclaw'], threadRootId: firstRoot,
  })
  await workspace.sendMessage({ groupId: second.id, text: 'OpenClaw B', targetKinds: ['openclaw'] })

  const sessionRefs = calls.map(call => call.runOptions.sessionRef)
  assert.deepEqual(sessionRefs.slice(0, 2), ['', 'kimi-session'])
  assert.match(sessionRefs[2], /^agent:main:desktop-roundrelay-[a-zA-Z0-9-]+-openclaw$/)
  assert.equal(sessionRefs[3], sessionRefs[2])
  assert.notEqual(sessionRefs[4], sessionRefs[2])
  assert.notEqual(workspace.state.sessions[openClawKey], 'explicit:roundrelay-legacy-openclaw')
  assert.equal(calls[0].runOptions.sandbox, 'workspace-write')
  assert.equal(calls[1].runOptions.sandbox, 'workspace-write')
})

test('group write authorization is explicit, persisted, and passed to local CLIs', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '写入授权', agentKinds: ['codex', 'kimi'], workdir: directory,
  })

  await workspace.sendMessage({ groupId: group.id, text: '只读', targetKinds: ['codex'] })
  assert.equal(calls[0].runOptions.sandbox, undefined)
  workspace.updateGroup(group.id, { allowWrite: true })
  await workspace.sendMessage({ groupId: group.id, text: '允许写入', targetKinds: ['kimi'] })

  assert.equal(calls[1].runOptions.sandbox, 'workspace-write')
  const restored = new LocalWorkspace(options)
  assert.equal(restored.snapshot().groups[0].allowWrite, true)
})

test('group settings cannot change execution context during an active run', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let releaseRun
  const runGate = new Promise(resolve => { releaseRun = resolve })
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    await runGate
    return { text: `${agent.kind} done`, sessionRef: runOptions.sessionRef || 'session-1' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '运行中配置', agentKinds: ['codex'], workdir: directory,
  })

  const send = workspace.sendMessage({ groupId: group.id, text: '开始', targetKinds: ['codex'] })
  await new Promise(resolve => setImmediate(resolve))
  assert.throws(
    () => workspace.updateGroup(group.id, { workdir: path.join(directory, 'other'), allowWrite: true }),
    { message: 'LOCAL_GROUP_RUNNING' },
  )
  releaseRun()
  await send
  assert.equal(workspace.getGroup(group.id).workdir, directory)
  assert.equal(workspace.getGroup(group.id).allowWrite, false)
})

test('one failed agent persists only its stable error code in a multi-agent message', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const diagnostic = 'Hermes executable /private/agents/hermes failed: upstream untranslated text'
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'hermes') {
      const error = new Error('LOCAL_AGENT_PROCESS_FAILED')
      Object.defineProperty(error, 'diagnostic', { value: diagnostic, enumerable: false })
      throw error
    }
    return { text: 'Codex 正常回复', sessionRef: 'codex-session' }
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '部分失败', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id, text: '@所有人 测试', targetKinds: ['codex', 'hermes'],
  })

  const snapshot = workspace.snapshot()
  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes'])
  assert.deepEqual(
    snapshot.messages.map(message => [message.role, message.agentKind, message.content]),
    [
      ['user', '', '@所有人 测试'],
      ['agent', 'codex', 'Codex 正常回复'],
      ['system', 'hermes', 'Hermes failed: LOCAL_AGENT_PROCESS_FAILED'],
    ],
  )
  const [root, codexReply, hermesError] = snapshot.messages
  assert.equal(codexReply.threadRootId, root.id)
  assert.equal(hermesError.threadRootId, root.id)
  assert.deepEqual(hermesError.system, {
    key: 'system.agentCallFailed',
    params: { agent: 'Hermes', reason: 'LOCAL_AGENT_PROCESS_FAILED' },
  })
  const serialized = fs.readFileSync(options.storagePath, 'utf8')
  assert.match(serialized, /LOCAL_AGENT_PROCESS_FAILED/)
  assert.doesNotMatch(serialized, /\/private\/agents\/hermes|upstream untranslated text/)
  assert.doesNotMatch(JSON.stringify(snapshot), /\/private\/agents\/hermes|upstream untranslated text/)
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'partial')
})

test('running snapshots expose queued and active agents with the topic root', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let releaseCodex
  options.runAgent = async (agent, _prompt, _workdir, runOptions) => {
    if (agent.kind === 'codex') {
      await new Promise(resolve => { releaseCodex = resolve })
    }
    return { text: `${agent.kind} done`, sessionRef: runOptions.sessionRef || `${agent.kind}-session` }
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '运行状态', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  const send = workspace.sendMessage({ groupId: group.id, text: '开始', targetKinds: ['codex', 'hermes'] })
  await new Promise(resolve => setImmediate(resolve))
  const running = workspace.snapshot()

  assert.equal(running.runs.length, 1)
  assert.deepEqual(running.runs[0].targetKinds, ['codex', 'hermes'])
  assert.deepEqual(running.runs[0].completedKinds, [])
  assert.equal(running.runs[0].currentKind, 'codex')
  assert.equal(running.runs[0].threadRootId, running.messages[0].id)

  releaseCodex()
  await send
  assert.deepEqual(workspace.snapshot().runs, [])
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'completed')
  assert.equal(finished[0].groupId, group.id)
  assert.equal(finished[0].threadRootId, running.messages[0].id)
})

test('Hermes progress stays bounded metadata while later Agents receive only its final reply', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let releaseHermes
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'hermes') {
      for (let index = 0; index < 9; index += 1) {
        runOptions.onProgress({ title: 'write_file', status: 'completed' })
      }
      runOptions.onProgress({ title: '/private/review diff', status: 'unknown' })
      await new Promise(resolve => { releaseHermes = resolve })
      return { text: 'Hermes authoritative final', sessionRef: 'hermes-session' }
    }
    return { text: 'WorkBuddy used the final', sessionRef: 'workbuddy-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '最终结果传递', agentKinds: ['hermes', 'workbuddy'], workdir: directory,
  })

  const send = workspace.sendMessage({
    groupId: group.id,
    text: '开始研究',
    targetKinds: ['hermes', 'workbuddy'],
  })
  await new Promise(resolve => setImmediate(resolve))

  const active = workspace.snapshot().runs[0]
  assert.equal(active.currentKind, 'hermes')
  assert.equal(active.progress.length, 8)
  assert.deepEqual(active.progress.at(-1), { title: 'process', status: 'completed' })
  assert.doesNotMatch(JSON.stringify(active.progress), /private|review diff/)

  releaseHermes()
  await send

  assert.match(calls[1].prompt, /Hermes: Hermes authoritative final/)
  assert.doesNotMatch(calls[1].prompt, /write_file|review diff|elapsedMs|private/)
  const hermesReply = workspace.snapshot().messages.find(message => message.agentKind === 'hermes')
  assert.equal(hermesReply.content, 'Hermes authoritative final')
  assert.equal(hermesReply.toolCalls.length, 8)
  assert.equal(Number.isSafeInteger(hermesReply.elapsedMs), true)
  assert.equal(hermesReply.elapsedMs >= 0, true)

  const persisted = JSON.parse(fs.readFileSync(options.storagePath, 'utf8'))
  const persistedReply = persisted.messages.find(message => message.agentKind === 'hermes')
  assert.equal(persistedReply.content, 'Hermes authoritative final')
  assert.equal(persistedReply.toolCalls.length, 8)
  assert.equal(typeof persistedReply.elapsedMs, 'number')
})

test('all failed agents resolve after persisting one user message and recording failures', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    throw new Error(`${agent.kind} failed`)
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '全部失败', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  const result = await workspace.sendMessage({
    groupId: group.id,
    text: '@所有人 测试',
    targetKinds: ['codex', 'hermes'],
    attachments: [{ id: 'failure-image', name: 'failure.png', mimeType: 'image/png', size: 3 }],
  })

  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes'])
  const userMessages = result.messages.filter(message => message.role === 'user')
  assert.equal(userMessages.length, 1)
  assert.equal(userMessages[0].content, '@所有人 测试')
  assert.deepEqual(userMessages[0].attachments, [
    { id: 'failure-image', name: 'failure.png', mimeType: 'image/png', size: 3 },
  ])
  assert.deepEqual(
    workspace.snapshot().messages.filter(message => message.role === 'system')
      .map(message => message.content),
    ['Codex failed: codex failed', 'Hermes failed: hermes failed'],
  )
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'failed')
})

test('automatic dialogue continues complete rounds until every Agent agrees', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const replies = [
    'Codex still has one edge case.\n[[ROUNDRELAY_CONSENSUS:continue]]',
    'Hermes agrees that clarification is needed.\n[[ROUNDRELAY_CONSENSUS:continue]]',
    'Codex accepts the current conclusion.\n[[ROUNDRELAY_CONSENSUS:agree]]',
    'Hermes accepts the current conclusion.\n[[ROUNDRELAY_CONSENSUS:agree]]',
  ]
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return {
      text: replies[calls.length - 1],
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '自动讨论', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const root = workspace.addMessage(group.id, 'user', '讨论本地 Agent 架构')
  workspace.startAuto({ groupId: group.id, maxRounds: 4 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes', 'codex', 'hermes'])
  assert.deepEqual(calls.map(call => call.runOptions.sessionRef), [
    '', '', 'codex-session', 'hermes-session',
  ])
  assert.equal(calls.every(call => call.prompt.includes('[[ROUNDRELAY_CONSENSUS:agree]]')), true)
  assert.deepEqual(
    workspace.snapshot().messages.filter(message => message.role === 'agent')
      .map(message => message.threadRootId),
    [root.id, root.id, root.id, root.id],
  )
  assert.deepEqual(
    workspace.snapshot().messages.filter(message => message.role === 'agent')
      .map(message => message.content),
    [
      'Codex still has one edge case.',
      'Hermes agrees that clarification is needed.',
      'Codex accepts the current conclusion.',
      'Hermes accepts the current conclusion.',
    ],
  )
  assert.deepEqual(workspace.snapshot().runningGroupIds, [])
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'completed')
  assert.equal(finished[0].mode, 'auto')
})

test('automatic dialogue carries root images until delivery and preloads Hermes root skills', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let hermesAttempts = 0
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'hermes' && hermesAttempts++ === 0) {
      throw new Error('LOCAL_AGENT_PROCESS_FAILED')
    }
    const consensus = calls.length >= 4 ? 'agree' : 'continue'
    return {
      text: `${agent.kind} reply\n[[ROUNDRELAY_CONSENSUS:${consensus}]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '附件自动讨论', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const attachment = {
    id: 'attachment-auto', name: 'architecture.png', mimeType: 'image/png', size: 128,
  }
  const skill = {
    targetKind: 'hermes', namespace: 'global', slug: 'research', name: 'Research',
  }
  workspace.addMessage(group.id, 'user', '审查这张架构图', '', '', null, {
    attachments: [attachment], skillHints: [skill],
  })

  workspace.startAuto({ groupId: group.id, maxRounds: 2 })
  await workspace.activeRuns.get(group.id).promise

  const attachmentPath = path.join(directory, 'attachments', 'attachment-auto.png')
  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes', 'codex', 'hermes'])
  assert.deepEqual(calls.map(call => call.runOptions.attachments), [
    [attachmentPath], [attachmentPath], [], [attachmentPath],
  ])
  assert.deepEqual(calls.filter(call => call.agent.kind === 'hermes')
    .map(call => call.runOptions.skills), [['research'], ['research']])
})

test('automatic dialogue rejects unequal image context before starting any Agent', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '附件能力预检', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', '比较两张图', '', '', null, {
    attachments: [
      { id: 'attachment-a', name: 'a.png', mimeType: 'image/png', size: 128 },
      { id: 'attachment-b', name: 'b.png', mimeType: 'image/png', size: 128 },
    ],
  })

  assert.throws(
    () => workspace.startAuto({ groupId: group.id, maxRounds: 2 }),
    { message: 'LOCAL_AGENT_IMAGE_LIMIT' },
  )
  assert.deepEqual(workspace.snapshot().runningGroupIds, [])
  assert.equal(calls.length, 0)
})

test('automatic dialogue requires one final standalone consensus marker', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const replies = [
    [
      'Codex quoted [[ROUNDRELAY_CONSENSUS:agree]] but still has a reservation.',
      '[[ROUNDRELAY_CONSENSUS:agree]]',
    ].join('\n'),
    'Hermes accepts the current conclusion.\n[[ROUNDRELAY_CONSENSUS:agree]]',
    'Codex has resolved the reservation.\n[[ROUNDRELAY_CONSENSUS:agree]]',
    'Hermes confirms the final conclusion.\n[[ROUNDRELAY_CONSENSUS:agree]]',
  ]
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return {
      text: replies[calls.length - 1],
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '严格共识', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', '避免引用标记造成误判')

  workspace.startAuto({ groupId: group.id, maxRounds: 2 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes', 'codex', 'hermes'])
  assert.equal(workspace.snapshot().messages.some(message => (
    message.content.includes('[[ROUNDRELAY_CONSENSUS:')
  )), false)
  assert.equal(workspace.snapshot().messages.some(message => (
    message.system?.key === 'system.autoRoundLimit'
  )), false)
})

test('automatic dialogue does not count an incomplete Agent turn as agreement', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return {
      text: `${agent.kind} agrees.\n[[ROUNDRELAY_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
      completed: calls.length !== 1,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '完整回复', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', '截断回复不能作为共识')

  workspace.startAuto({ groupId: group.id, maxRounds: 2 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes', 'codex', 'hermes'])
  assert.equal(workspace.snapshot().messages.some(message => (
    message.system?.key === 'system.autoRoundLimit'
  )), false)
})

test('stopping automatic dialogue cancels the active round without a limit message', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let activeSignal
  let secondRoundStarted
  const secondRound = new Promise(resolve => { secondRoundStarted = resolve })
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (calls.length < 3) {
      return {
        text: `${agent.kind} continue\n[[ROUNDRELAY_CONSENSUS:continue]]`,
        sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
      }
    }
    activeSignal = runOptions.signal
    secondRoundStarted()
    await new Promise((resolve, reject) => {
      if (runOptions.signal.aborted) {
        reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED'))
        return
      }
      runOptions.signal.addEventListener(
        'abort', () => reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED')), { once: true },
      )
    })
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '停止自动讨论', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', '讨论到手动停止为止')

  workspace.startAuto({ groupId: group.id, maxRounds: 4 })
  const pending = workspace.activeRuns.get(group.id).promise
  await secondRound

  assert.equal(workspace.stop(group.id), true)
  await pending

  assert.equal(activeSignal.aborted, true)
  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes', 'codex'])
  assert.equal(workspace.stop(group.id), false)
  assert.deepEqual(workspace.snapshot().runningGroupIds, [])
  assert.equal(workspace.snapshot().messages.some(message => (
    ['system.autoRoundLimit', 'system.autoTimeout'].includes(message.system?.key)
  )), false)
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'stopped')
})

test('automatic dialogue isolates duplicate failures and retries every Agent next round', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let hermesAttempts = 0
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'hermes' && hermesAttempts++ < 2) {
      throw new Error('LOCAL_AGENT_PROCESS_FAILED')
    }
    const consensus = calls.length >= 7 ? 'agree' : 'continue'
    return {
      text: `${agent.kind} reply\n[[ROUNDRELAY_CONSENSUS:${consensus}]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '失败恢复', agentKinds: ['codex', 'hermes', 'workbuddy'], workdir: directory,
  })
  const root = workspace.addMessage(group.id, 'user', '继续讨论直至共识')

  workspace.startAuto({ groupId: group.id, maxRounds: 3 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), [
    'codex', 'hermes', 'workbuddy',
    'codex', 'hermes', 'workbuddy',
    'codex', 'hermes', 'workbuddy',
  ])
  assert.deepEqual(
    workspace.snapshot().messages.filter(message => message.role === 'system')
      .map(message => ({
        agentKind: message.agentKind,
        content: message.content,
        threadRootId: message.threadRootId,
        system: message.system,
      })),
    [{
      agentKind: 'hermes',
      content: 'Hermes failed: LOCAL_AGENT_PROCESS_FAILED',
      threadRootId: root.id,
      system: {
        key: 'system.agentCallFailed',
        params: { agent: 'Hermes', reason: 'LOCAL_AGENT_PROCESS_FAILED' },
      },
    }],
  )
})

test('automatic dialogue keeps the round-limit diagnostic when every Agent fails', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    throw new Error('LOCAL_AGENT_PROCESS_FAILED')
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '全员失败', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const root = workspace.addMessage(group.id, 'user', '失败也要保留终止诊断')

  workspace.startAuto({ groupId: group.id, maxRounds: 2 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), [
    'codex', 'hermes', 'codex', 'hermes',
  ])
  const limit = workspace.snapshot().messages.find(message => (
    message.system?.key === 'system.autoRoundLimit'
  ))
  assert.equal(limit.threadRootId, root.id)
  assert.deepEqual(limit.system.params, { rounds: 2 })
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'failed')
})

test('automatic dialogue resumes a session captured before a failed turn', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let kimiAttempts = 0
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'kimi' && kimiAttempts++ === 0) {
      await runOptions.onSessionRef('kimi-created-before-failure')
      throw new Error('LOCAL_AGENT_PROCESS_FAILED')
    }
    return {
      text: `${agent.kind} reply\n[[ROUNDRELAY_CONSENSUS:${calls.length > 2 ? 'agree' : 'continue'}]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '失败后复用会话', agentKinds: ['kimi', 'codex'], workdir: directory,
  })
  const root = workspace.addMessage(group.id, 'user', '失败重试不能创建新会话')

  workspace.startAuto({ groupId: group.id, maxRounds: 2 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), ['kimi', 'codex', 'kimi', 'codex'])
  assert.equal(calls[0].runOptions.sessionRef, '')
  assert.equal(calls[2].runOptions.sessionRef, 'kimi-created-before-failure')
  assert.equal(
    workspace.state.sessions[workspace.sessionKey(group.id, 'kimi', root.id)],
    'kimi-created-before-failure',
  )
})

test('automatic dialogue defaults to three rounds and hides consensus markers at the cap', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return {
      text: `${agent.kind} has not agreed.\n[[ROUNDRELAY_CONSENSUS:continue]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '安全上限', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const root = workspace.addMessage(group.id, 'user', '讨论一个无法快速收敛的问题')

  const started = workspace.startAuto({ groupId: group.id })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(started, { started: true, maxRounds: 3 })
  assert.deepEqual(calls.map(call => call.agent.kind), [
    'codex', 'hermes', 'codex', 'hermes', 'codex', 'hermes',
  ])
  assert.equal(workspace.snapshot().messages.some(message => (
    message.content.includes('[[ROUNDRELAY_CONSENSUS:')
  )), false)
  const limit = workspace.snapshot().messages.find(message => (
    message.system?.key === 'system.autoRoundLimit'
  ))
  assert.equal(limit.threadRootId, root.id)
  assert.deepEqual(limit.system.params, { rounds: 3 })
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'round-limit')
  assert.equal(finished[0].threadRootId, root.id)
  assert.doesNotMatch(
    fs.readFileSync(options.storagePath, 'utf8'),
    /"status"\s*:\s*"round-limit"|run-finished/,
  )
})

test('automatic dialogue accepts legacy maxTurns as a round limit', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return {
      text: `${agent.kind} continue\n[[ROUNDRELAY_CONSENSUS:continue]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '旧参数', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', '兼容旧参数')

  const started = workspace.startAuto({ groupId: group.id, maxTurns: 2 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(started, { started: true, maxRounds: 2 })
  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes', 'codex', 'hermes'])
})

test('automatic dialogue aborts the active Agent at the total runtime limit', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.autoRunTimeoutMs = 20
  let activeSignal
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    activeSignal = runOptions.signal
    await new Promise((resolve, reject) => {
      if (runOptions.signal.aborted) {
        reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED'))
        return
      }
      runOptions.signal.addEventListener(
        'abort', () => reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED')), { once: true },
      )
    })
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '运行时限', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const root = workspace.addMessage(group.id, 'user', '讨论不能无限占用本地进程')

  workspace.startAuto({ groupId: group.id, maxRounds: 8 })
  await workspace.activeRuns.get(group.id).promise

  assert.equal(activeSignal.aborted, true)
  assert.deepEqual(calls.map(call => call.agent.kind), ['codex'])
  const timeout = workspace.snapshot().messages.find(message => (
    message.system?.key === 'system.autoTimeout'
  ))
  assert.equal(timeout.threadRootId, root.id)
  assert.deepEqual(timeout.system.params, {})
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'timeout')
  assert.equal(finished[0].threadRootId, root.id)
})

test('automatic dialogue keeps its stable diagnostic and emits a failed terminal event', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '异常兜底', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const root = workspace.addMessage(group.id, 'user', '内部异常不能形成未处理拒绝')
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  const emitChanged = workspace.emitChanged.bind(workspace)
  let emitCount = 0
  workspace.emitChanged = () => {
    emitCount += 1
    if (emitCount === 2) throw new Error(`/private/workspace/${group.id}`)
    emitChanged()
  }

  workspace.startAuto({ groupId: group.id, maxRounds: 2 })
  await workspace.activeRuns.get(group.id).promise

  const stopped = workspace.snapshot().messages.find(message => (
    message.system?.key === 'system.autoStopped'
  ))
  assert.equal(stopped.threadRootId, root.id)
  assert.equal(stopped.content, 'Automatic discussion stopped: LOCAL_AGENT_UNKNOWN_FAILURE')
  assert.deepEqual(stopped.system.params, { reason: 'LOCAL_AGENT_UNKNOWN_FAILURE' })
  assert.deepEqual(workspace.snapshot().runningGroupIds, [])
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'failed')
  assert.equal(finished[0].threadRootId, root.id)
})

test('automatic dialogue requires a topic root and accepts an explicit one', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => ({
    text: `${agent.kind} agrees.\n[[ROUNDRELAY_CONSENSUS:agree]]`,
    sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
  })
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '话题要求', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  assert.throws(
    () => workspace.startAuto({ groupId: group.id, maxRounds: 1 }),
    { message: 'LOCAL_AUTO_THREAD_REQUIRED' },
  )

  workspace.startAuto({ groupId: group.id, maxRounds: 1, threadRootId: 'topic-root' })
  await workspace.activeRuns.get(group.id).promise
  assert.deepEqual(
    workspace.snapshot().messages.filter(message => message.role === 'agent')
      .map(message => message.threadRootId),
    ['topic-root', 'topic-root'],
  )
})
