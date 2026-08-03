const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { getEventListeners } = require('node:events')
const { LocalWorkspace } = require('../src/local-workspace.cjs')
const { RunLedger } = require('../src/run-ledger.cjs')

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-workspace-'))
 let id = 0
  let runId = 0
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
    validateKnowledgeBaseSelections: (_kinds, selections) => selections,
    imageAttachmentLimit: kind => ({ codex: 4, hermes: 1, opencode: 4 })[kind] || 0,
    captureAgentOutputs: async () => null,
    importAgentOutputs: async () => [],
    runAgent: async (agent, prompt, workdir, runOptions) => {
      calls.push({ agent, prompt, workdir, runOptions })
      return {
        text: `${agent.kind} reply ${calls.length}`,
        sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
      }
    },
   now: () => '2026-07-28T00:00:00.000Z',
   createId: () => `id-${++id}`,
    createRunId: () => `run-${++runId}`,
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

test('Custom Agent kinds keep their dynamic label across execution and reload', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const kind = 'custom-0123456789abcdef'
  options.detectAgents = async () => [{
    kind,
    name: 'Repository Reviewer CLI',
    executable: '/tmp/review-agent',
    version: '1.0.0',
    custom: true,
  }]
  options.agentLabel = selectedKind => selectedKind === kind ? 'Repository Reviewer' : ''
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    conversationType: 'direct',
    directAgentKind: kind,
    agentKinds: [kind],
    workdir: directory,
  })

  await workspace.sendMessage({ groupId: group.id, text: 'Review this change', targetKinds: [kind] })

  assert.match(calls[0].prompt, /as Repository Reviewer\./)
  const reply = workspace.snapshot().messages.find(message => message.role === 'agent')
  assert.equal(reply.agentKind, kind)
  assert.equal(reply.senderName, 'Repository Reviewer')

  const reloaded = new LocalWorkspace(options)
  assert.equal(reloaded.snapshot().groups[0].directAgentKind, kind)
  assert.equal(reloaded.snapshot().messages.find(message => message.role === 'agent').senderName,
    'Repository Reviewer')
})

test('native readiness remains visible while a Meldwork Provider profile is active', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let codexNativeState = { state: 'ready', source: 'native-auth-status' }
  options.credentialState = async kind => kind === 'codex'
    ? codexNativeState
    : { state: 'ready', source: 'native-credential' }
  options.sharedProviderReady = kind => kind === 'codex'
  const workspace = new LocalWorkspace(options)

  let snapshot = await workspace.refreshAgents()
  let codex = snapshot.agents.find(agent => agent.kind === 'codex')
  assert.equal(codex.credentialState, 'ready')
  assert.equal(codex.availabilitySource, 'native-auth-status')
  assert.equal(codex.available, true)

  codexNativeState = { state: 'missing', source: 'native-auth-status' }
  snapshot = await workspace.refreshAgents()
  codex = snapshot.agents.find(agent => agent.kind === 'codex')
  assert.equal(codex.credentialState, 'ready')
  assert.equal(codex.availabilitySource, 'shared-provider')
  assert.equal(codex.available, true)
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
  await workspace.sendMessage({
    groupId: group.id,
    text: '开始讨论',
    targetKinds: ['codex'],
    mentionedAgentKinds: ['codex'],
  })

  const restored = new LocalWorkspace(options)
  assert.equal(restored.snapshot().groups[0].name, '本地测试群')
  assert.equal(restored.snapshot().messages.length, 2)
  assert.deepEqual(restored.snapshot().messages[0].targetKinds, ['codex'])
  assert.equal('executable' in workspace.snapshot().agents[0], false)
})

test('version 1 conversations migrate from the former read-only default to workspace write', (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(options.storagePath, `${JSON.stringify({
    version: 1,
    groups: [{
      id: 'legacy-group',
      name: 'Legacy group',
      agentKinds: ['codex'],
      workdir: directory,
      allowWrite: false,
    }],
    messages: [],
    sessions: {},
  })}\n`)

  const restored = new LocalWorkspace(options)

  assert.equal(restored.state.version, 3)
  assert.equal(restored.snapshot().groups[0].allowWrite, true)
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
  await assert.rejects(
    workspace.sendMessage({
      groupId: group.id,
      text: 'Invalid mention',
      targetKinds: ['codex'],
      mentionedAgentKinds: ['hermes'],
    }),
    { message: 'LOCAL_MESSAGE_TARGET_REQUIRED' },
  )
  assert.equal(workspace.snapshot().messages.filter(message => message.role === 'user').length, 1)
})

test('Knowledge bases are validated, persisted, and injected only into selected Agents', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const vaultPath = path.join(directory, 'Obsidian Vault')
  const validationCalls = []
  let injectUnexpectedTarget = false
  options.validateKnowledgeBaseSelections = (targetKinds, selections) => {
    validationCalls.push({ targetKinds, selections })
    return selections.map((selection) => {
      if (selection.kind === 'obsidian') {
        return {
          kind: 'obsidian',
          name: 'Obsidian',
          accessMode: 'vault',
          location: vaultPath,
          targetKinds: injectUnexpectedTarget ? ['codex', 'hermes'] : selection.targetKinds,
        }
      }
      return {
        kind: 'dingtalk',
        name: 'DingTalk',
        accessMode: 'cli',
        commandName: 'dws',
        targetKinds: selection.targetKinds,
      }
    })
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Knowledge routing', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const requestedHints = [
    { kind: 'obsidian', targetKinds: ['codex'] },
    { kind: 'dingtalk', targetKinds: ['hermes'] },
  ]

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Compare the configured sources',
    targetKinds: ['codex', 'hermes'],
    knowledgeBaseHints: requestedHints,
  })

  assert.deepEqual(validationCalls[0], {
    targetKinds: ['codex', 'hermes'],
    selections: requestedHints,
  })
  assert.match(calls[0].prompt, /read from the local vault at/)
  assert.match(calls[0].prompt, new RegExp(vaultPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(calls[0].prompt, /configured dws command-line connection/)
  assert.match(calls[1].prompt, /configured dws command-line connection/)
  assert.doesNotMatch(calls[1].prompt, /read from the local vault at/)
  assert.match(calls[0].prompt, /do not modify source content/)

  const storedHints = workspace.snapshot().messages[0].knowledgeBaseHints
  assert.deepEqual(storedHints, [
    {
      kind: 'obsidian', name: 'Obsidian', accessMode: 'vault',
      location: vaultPath, targetKinds: ['codex'],
    },
    {
      kind: 'dingtalk', name: 'DingTalk', accessMode: 'cli',
      commandName: 'dws', targetKinds: ['hermes'],
    },
  ])
  const restored = new LocalWorkspace(options)
  assert.deepEqual(restored.snapshot().messages[0].knowledgeBaseHints, storedHints)

  await assert.rejects(workspace.sendMessage({
    groupId: group.id,
    text: 'Reject an out-of-scope source',
    targetKinds: ['codex'],
    knowledgeBaseHints: [{ kind: 'dingtalk', targetKinds: ['hermes'] }],
  }), { message: 'LOCAL_KNOWLEDGE_BASE_SELECTION_INVALID' })

  injectUnexpectedTarget = true
  await assert.rejects(workspace.sendMessage({
    groupId: group.id,
    text: 'Reject invalid main-process validation output',
    targetKinds: ['codex'],
    knowledgeBaseHints: [{ kind: 'obsidian', targetKinds: ['codex'] }],
  }), { message: 'LOCAL_KNOWLEDGE_BASE_SELECTION_INVALID' })
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

test('message deletion persists replies individually and removes a whole group topic from history', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Message cleanup', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const root = workspace.addMessage(group.id, 'user', 'Remove this topic', '', '', null, {
    attachments: [{
      id: 'attachment-root', name: 'root.png', mimeType: 'image/png', size: 10,
    }],
  })
  const reply = workspace.addMessage(group.id, 'agent', 'Remove only this reply', 'codex', root.id, null, {
    attachments: [{
      id: 'attachment-reply', name: 'reply.png', mimeType: 'image/png', size: 10,
    }],
  })
  const retainedReply = workspace.addMessage(group.id, 'agent', 'Remove with the topic', 'hermes', root.id)
  const topicStatus = workspace.addMessage(
    group.id,
    'system',
    'Topic stopped',
    '',
    root.id,
    { key: 'system.autoStopped', params: {} },
  )
  const otherRoot = workspace.addMessage(group.id, 'user', 'Keep this topic')
  const otherReply = workspace.addMessage(group.id, 'agent', 'Keep this reply', 'codex', otherRoot.id)

  assert.deepEqual(workspace.deleteMessage(group.id, reply.id), {
    deletedMessageIds: [reply.id],
  })
  let messages = workspace.snapshot().messages
  assert.equal(messages.some(message => message.id === reply.id), false)
  assert.equal(messages.some(message => message.id === retainedReply.id), true)
  assert.equal(new LocalWorkspace(options).snapshot().messages.some(message => message.id === reply.id), false)

  const deleted = workspace.deleteMessage(group.id, root.id)
  assert.deepEqual(new Set(deleted.deletedMessageIds), new Set([
    root.id, retainedReply.id, topicStatus.id,
  ]))
  messages = workspace.snapshot().messages
  assert.deepEqual(messages.map(message => message.id), [otherRoot.id, otherReply.id])
  assert.deepEqual(
    new LocalWorkspace(options).snapshot().messages.map(message => message.id),
    [otherRoot.id, otherReply.id],
  )
})

test('deleting a direct-chat user turn removes its inferred replies without touching later turns', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    conversationType: 'direct', directAgentKind: 'codex', agentKinds: ['codex'], workdir: directory,
  })
  const firstRoot = workspace.addMessage(group.id, 'user', 'First turn')
  const firstReply = workspace.addMessage(group.id, 'agent', 'First answer', 'codex')
  const firstFailure = workspace.addMessage(
    group.id,
    'system',
    'First failure',
    'codex',
    '',
    { key: 'system.agentCallFailed', params: { agent: 'Codex', reason: 'failed' } },
  )
  const secondRoot = workspace.addMessage(group.id, 'user', 'Second turn')
  const secondReply = workspace.addMessage(group.id, 'agent', 'Second answer', 'codex')

  const deleted = workspace.deleteMessage(group.id, firstRoot.id)

  assert.deepEqual(new Set(deleted.deletedMessageIds), new Set([
    firstRoot.id, firstReply.id, firstFailure.id,
  ]))
  assert.deepEqual(workspace.snapshot().messages.map(message => message.id), [secondRoot.id, secondReply.id])
  assert.deepEqual(
    new LocalWorkspace(options).snapshot().messages.map(message => message.id),
    [secondRoot.id, secondReply.id],
  )
})

test('message deletion rejects active, unknown, and cross-conversation targets', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const firstGroup = workspace.createGroup({
    name: 'First', agentKinds: ['codex'], workdir: directory,
  })
  const secondGroup = workspace.createGroup({
    name: 'Second', agentKinds: ['codex'], workdir: directory,
  })
  const firstMessage = workspace.addMessage(firstGroup.id, 'user', 'First message')
  const secondMessage = workspace.addMessage(secondGroup.id, 'user', 'Second message')

  assert.throws(
    () => workspace.deleteMessage(firstGroup.id, secondMessage.id),
    { message: 'LOCAL_MESSAGE_NOT_FOUND' },
  )
  assert.throws(
    () => workspace.deleteMessage(firstGroup.id, 'missing-message'),
    { message: 'LOCAL_MESSAGE_NOT_FOUND' },
  )

  workspace.activeRuns.set(
    firstGroup.id,
    workspace.createRunController('manual', ['codex'], firstMessage.id),
  )
  assert.throws(
    () => workspace.deleteMessage(firstGroup.id, firstMessage.id),
    { message: 'LOCAL_GROUP_RUNNING' },
  )
  workspace.activeRuns.delete(firstGroup.id)
  assert.equal(workspace.snapshot().messages.some(message => message.id === firstMessage.id), true)
})

test('WebP attachment metadata is rejected before a message or Agent run is recorded', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Unsupported image', agentKinds: ['codex'], workdir: directory,
  })

  await assert.rejects(
    workspace.sendMessage({
      groupId: group.id,
      text: 'Inspect',
      attachments: [{
        id: 'attachment-webp', name: 'preview.webp', mimeType: 'image/webp', size: 10,
      }],
    }),
    { message: 'LOCAL_ATTACHMENT_REFERENCE_INVALID' },
  )
  assert.equal(calls.length, 0)
  assert.equal(workspace.snapshot().messages.length, 0)
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

test('stopAll records an in-flight Agent and its ledger checkpoint as interrupted', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const started = deferred()
  const checkpoints = []
  options.runAbortGraceMs = 20
  options.runLedger = {
    recoverInterrupted: () => [],
    list: () => [],
    checkpoint: record => checkpoints.push(structuredClone(record)),
    finish: () => {},
  }
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => await new Promise((
    _resolve, reject,
  ) => {
    started.resolve()
    if (runOptions.signal.aborted) {
      reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED'))
      return
    }
    runOptions.signal.addEventListener(
      'abort', () => reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED')), { once: true },
    )
  })
  const finished = []
  const workspace = new LocalWorkspace(options)
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Shutdown trace', agentKinds: ['codex'], workdir: directory,
  })

  const send = workspace.sendMessage({
    groupId: group.id, text: 'Keep the shutdown evidence', targetKinds: ['codex'],
  })
  await started.promise
  await Promise.all([send, workspace.stopAll()])

  const interruption = workspace.snapshot().messages.find(message => (
    message.system?.key === 'system.agentInterrupted' && message.agentKind === 'codex'
  ))
  assert.equal(interruption.trace.status, 'interrupted')
  assert.equal(finished[0].status, 'interrupted')
  const terminalCheckpoint = checkpoints.findLast(record => record.status === 'interrupted')
  assert.equal(terminalCheckpoint.agentRuns[0].status, 'interrupted')
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
  stored.messages[0].targetKinds = ['codex', 'unknown-agent', 'codex']
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
  assert.deepEqual(restoredSnapshot.messages[0].targetKinds, ['codex'])
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

test('direct conversations force manual mode and reuse their group Agent session', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const direct = workspace.createGroup({
    name: 'Codex', workdir: directory,
    agentKinds: ['codex', 'hermes'],
    conversationType: 'direct', directAgentKind: 'codex',
  })

  await workspace.sendMessage({ groupId: direct.id, text: '第一条', mode: 'auto', maxRounds: 10 })
  await workspace.sendMessage({ groupId: direct.id, text: '第二条' })

  assert.deepEqual(direct.agentKinds, ['codex'])
  assert.equal(direct.conversationType, 'direct')
  assert.equal(direct.directAgentKind, 'codex')
  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'codex'])
  assert.deepEqual(calls.map(call => call.runOptions.sessionRef), ['', 'codex-session'])
  assert.equal(calls.some(call => call.prompt.includes('ROUNDRELAY_CONSENSUS')), false)
  assert.equal(workspace.snapshot().messages.some(message => message.threadRootId), false)
  const restored = new LocalWorkspace(options)
  assert.deepEqual(restored.snapshot().groups[0], direct)
})

test('writable conversations persist validated Agent media outputs and enforce the delivery contract', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const captureCalls = []
  const importCalls = []
  const generated = [
    { id: 'generated-image', name: 'poster.png', mimeType: 'image/png', size: 128 },
    { id: 'generated-audio', name: 'briefing.mp3', mimeType: 'audio/mpeg', size: 256 },
    { id: 'generated-video', name: 'demo.mp4', mimeType: 'video/mp4', size: 512 },
  ]
  options.captureAgentOutputs = async (workdir) => {
    captureCalls.push(workdir)
    return { marker: 'before-run' }
  }
  options.importAgentOutputs = async (input) => {
    importCalls.push(input)
    return generated
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const direct = workspace.createGroup({
    name: 'Codex media', workdir: directory, allowWrite: true,
    conversationType: 'direct', directAgentKind: 'codex', agentKinds: ['codex'],
  })

  await workspace.sendMessage({ groupId: direct.id, text: '生成一张图、一段音频和一个视频' })

  assert.deepEqual(captureCalls, [directory])
  assert.equal(importCalls.length, 1)
  assert.equal(importCalls[0].workdir, directory)
  assert.deepEqual(importCalls[0].baseline, { marker: 'before-run' })
  assert.equal(Number.isFinite(importCalls[0].startedAt), true)
  assert.match(calls[0].prompt, /\.meldwork-output\//)
  assert.match(calls[0].prompt, /do not claim it was generated unless a real file exists/i)
  const reply = workspace.snapshot().messages.find(message => message.role === 'agent')
  assert.deepEqual(reply.attachments, generated)
  assert.equal(JSON.stringify(reply).includes(directory), false)

  const restored = new LocalWorkspace(options)
  const restoredReply = restored.snapshot().messages.find(message => message.role === 'agent')
  assert.deepEqual(restoredReply.attachments, generated)
})

test('read-only conversations forbid false media claims and do not scan for generated files', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let captureCount = 0
  let importCount = 0
  options.captureAgentOutputs = async () => { captureCount += 1; return {} }
  options.importAgentOutputs = async () => { importCount += 1; return [] }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const direct = workspace.createGroup({
    name: 'Read only Codex', workdir: directory,
    conversationType: 'direct', directAgentKind: 'codex', agentKinds: ['codex'],
    allowWrite: false,
  })

  await workspace.sendMessage({ groupId: direct.id, text: '生成图片' })

  assert.equal(captureCount, 0)
  assert.equal(importCount, 0)
  assert.match(calls[0].prompt, /read-only/i)
  assert.match(calls[0].prompt, /do not claim that a media file was generated/i)
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

test('group messages create distinct visual roots while native sessions stay group scoped', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '会话测试', agentKinds: ['codex', 'hermes', 'workbuddy'], workdir: directory,
  })
  await workspace.sendMessage({ groupId: group.id, text: '第一条', targetKinds: ['codex'] })
  const firstRoot = workspace.snapshot().messages[0]
  await workspace.sendMessage({
    groupId: group.id, text: '第二条', targetKinds: ['codex'], threadRootId: firstRoot.id,
  })

  const userMessages = workspace.snapshot().messages.filter(message => message.role === 'user')
  const agentMessages = workspace.snapshot().messages.filter(message => message.role === 'agent')
  assert.equal(userMessages.length, 2)
  assert.equal(userMessages.every(message => !message.threadRootId), true)
  assert.notEqual(userMessages[0].id, userMessages[1].id)
  assert.deepEqual(agentMessages.map(message => message.threadRootId), userMessages.map(message => message.id))
  assert.deepEqual(calls.map(call => call.runOptions.sessionRef), ['', 'codex-session'])
  assert.equal(
    workspace.sessionKey(group.id, 'codex', userMessages[0].id),
    workspace.sessionKey(group.id, 'codex', userMessages[1].id),
  )
})

test('group-scoped sessions migrate the exact root or the most recently active legacy root', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return {
      text: `${agent.kind} agrees\n[[ROUNDRELAY_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '旧会话迁移', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const oldestRoot = workspace.addMessage(group.id, 'user', '最早旧话题')
  const currentRoot = workspace.addMessage(group.id, 'user', '当前旧话题')
  const recentRoot = workspace.addMessage(group.id, 'user', '最近活跃话题')
  workspace.addMessage(group.id, 'agent', '最近活跃话题结论', 'hermes', recentRoot.id)
  workspace.state.sessions[`${group.id}:codex:thread:${recentRoot.id}`] = 'codex-recent-root'
  workspace.state.sessions[`${group.id}:codex:thread:${currentRoot.id}`] = 'codex-current-root'
  workspace.state.sessions[`${group.id}:hermes:thread:orphan-root`] = 'hermes-orphan-root'
  workspace.state.sessions[`${group.id}:hermes:thread:${oldestRoot.id}`] = 'hermes-oldest-root'
  workspace.state.sessions[`${group.id}:hermes:thread:${recentRoot.id}`] = 'hermes-recent-root'
  workspace.save()

  workspace.startAuto({ groupId: group.id, threadRootId: currentRoot.id, maxRounds: 1 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.runOptions.sessionRef), [
    'codex-current-root', 'hermes-recent-root',
  ])
  assert.equal(calls.every(call => call.prompt.includes('最近活跃话题结论')), true)
  assert.equal(workspace.state.sessions[`${group.id}:codex`], 'codex-current-root')
  assert.equal(workspace.state.sessions[`${group.id}:hermes`], 'hermes-recent-root')
  assert.equal(Object.keys(workspace.state.sessions).some(key => (
    key.startsWith(`${group.id}:codex:thread:`)
      || key.startsWith(`${group.id}:hermes:thread:`)
  )), false)
  delete workspace.state.sessions[`${group.id}:codex`]
  delete workspace.state.sessions[`${group.id}:hermes`]
  assert.equal(workspace.sessionRef(group, 'codex', currentRoot.id), '')
  assert.equal(workspace.sessionRef(group, 'hermes', recentRoot.id), '')
  assert.doesNotMatch(JSON.stringify(workspace.snapshot()), /sessionRef|codex-current-root|hermes-recent-root/)
})

test('legacy GEO conversations keep their task and reuse one session per Agent', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return {
      text: `${agent.kind} completed the GEO turn\n[[ROUNDRELAY_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-group-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Test', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const intro = workspace.addMessage(group.id, 'user', '你们好，互相介绍下自己吧')
  workspace.addMessage(group.id, 'agent', 'Codex 自我介绍', 'codex', intro.id)
  workspace.addMessage(group.id, 'agent', 'Hermes 自我介绍', 'hermes', intro.id)
  const task = workspace.addMessage(
    group.id,
    'user',
    '这是一个 GEO 调研任务，请结合各自特点分配岗位并开始。',
  )
  workspace.addMessage(group.id, 'agent', 'Codex 负责技术与证据研究', 'codex', task.id)
  workspace.addMessage(group.id, 'agent', 'Hermes 负责市场与内容策略', 'hermes', task.id)
  const scope = workspace.addMessage(
    group.id,
    'user',
    '通用课题，海外为主，目标是培养商业和市场洞悉力并完成行业摸底。',
  )
  workspace.state.sessions[`${group.id}:codex:thread:${task.id}`] = 'codex-old-task'
  workspace.state.sessions[`${group.id}:codex:thread:${scope.id}`] = 'codex-old-scope'
  workspace.state.sessions[`${group.id}:hermes:thread:${task.id}`] = 'hermes-old-task'
  workspace.state.sessions[`${group.id}:hermes:thread:${scope.id}`] = 'hermes-old-scope'
  workspace.save()

  const firstFinished = new Promise(resolve => workspace.once('run-finished', resolve))
  const first = await workspace.sendMessage({
    groupId: group.id,
    text: '你们自己讨论吧，等干完了再跟我说。',
    mode: 'auto',
    maxRounds: 2,
  })
  await firstFinished
  const secondFinished = new Promise(resolve => workspace.once('run-finished', resolve))
  const second = await workspace.sendMessage({
    groupId: group.id,
    text: '继续完成上面的 GEO 调研，不要重新询问任务。',
    mode: 'auto',
    maxRounds: 2,
  })
  await secondFinished

  assert.ok(first.threadRootId)
  assert.ok(second.threadRootId)
  assert.notEqual(first.threadRootId, second.threadRootId)
  assert.deepEqual(calls.map(call => call.runOptions.sessionRef), [
    'codex-old-scope',
    'hermes-old-scope',
    'codex-old-scope',
    'hermes-old-scope',
  ])
  assert.equal(calls.every(call => call.prompt.includes('GEO 调研任务')), true)
  assert.equal(calls.every(call => call.prompt.includes('海外为主')), true)
  assert.equal(calls.every(call => call.prompt.includes('商业和市场洞悉力')), true)
  assert.equal(Object.keys(workspace.state.sessions).some(key => key.includes(':thread:')), false)
  assert.equal(workspace.state.sessions[`${group.id}:codex`], 'codex-old-scope')
  assert.equal(workspace.state.sessions[`${group.id}:hermes`], 'hermes-old-scope')
})

test('prompts retain bounded topic and stable user turns plus group-wide final messages', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '全群上下文',
    topic: `GEO 产品定位 ${'T'.repeat(240)} TOPIC_TAIL_SHOULD_BE_BOUNDED`,
    agentKinds: ['codex', 'hermes'],
    workdir: directory,
  })
  workspace.addMessage(group.id, 'user', '问候：请使用中文')
  workspace.addMessage(group.id, 'user', 'GEO 任务：分析检索可见性')
  workspace.addMessage(group.id, 'user', '补充约束：不引入云端存储')
  for (let index = 0; index < 20; index += 1) {
    workspace.addMessage(group.id, 'agent', `已持久化的最终正文 ${index}`, index % 2 ? 'hermes' : 'codex', `old-root-${index}`, null, {
      elapsedMs: 12,
      toolCalls: [{ title: 'write_file', status: 'completed' }],
    })
  }
  workspace.addMessage(
    group.id,
    'system',
    'PROCESS_METADATA_SHOULD_NOT_REACH_AGENT',
    '',
    'old-root-19',
    { key: 'system.agentCallFailed', params: { reason: 'private' } },
  )

  await workspace.sendMessage({
    groupId: group.id,
    text: '当前新指令：给出最终建议',
    targetKinds: ['codex'],
  })

  const prompt = calls.at(-1).prompt
  assert.match(prompt, /Group topic: GEO 产品定位/)
  assert.doesNotMatch(prompt, /TOPIC_TAIL_SHOULD_BE_BOUNDED/)
  assert.match(prompt, /问候：请使用中文/)
  assert.match(prompt, /GEO 任务：分析检索可见性/)
  assert.match(prompt, /补充约束：不引入云端存储/)
  assert.match(prompt, /当前新指令：给出最终建议/)
  assert.equal(prompt.match(/当前新指令：给出最终建议/g)?.length, 1)
  assert.match(prompt, /Hermes: 已持久化的最终正文 19/)
  assert.doesNotMatch(prompt, /PROCESS_METADATA_SHOULD_NOT_REACH_AGENT|write_file|elapsedMs/)
})

test('resumed group sessions receive only transcript messages after their own final reply', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return {
      text: `${agent.kind} final ${calls.length}`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '增量上下文', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id, text: '第一条稳定约束', targetKinds: ['codex', 'hermes'],
  })
  await workspace.sendMessage({
    groupId: group.id, text: '第二条当前任务', targetKinds: ['codex'],
  })
  await workspace.sendMessage({
    groupId: group.id, text: '第三条继续任务', targetKinds: ['codex'],
  })

  const recentSection = prompt => prompt.split('Recent conversation across the group:\n')[1] || ''
  const secondCodexRecent = recentSection(calls[2].prompt)
  const thirdCodexRecent = recentSection(calls[3].prompt)
  assert.deepEqual(calls.map(call => call.runOptions.sessionRef), [
    '', '', 'codex-session', 'codex-session',
  ])
  assert.match(calls[1].prompt, /User: 第一条稳定约束/)
  assert.match(calls[1].prompt, /Codex: codex final 1/)
  assert.match(secondCodexRecent, /Hermes: hermes final 2/)
  assert.doesNotMatch(secondCodexRecent, /第一条稳定约束|第二条当前任务|codex final 1/)
  assert.match(calls[2].prompt, /Stable user instructions and constraints:\n[\s\S]*第一条稳定约束/)
  assert.match(calls[2].prompt, /Stable user instructions and constraints:\n[\s\S]*第二条当前任务/)
  assert.equal(calls[2].prompt.match(/第二条当前任务/g)?.length, 1)
  assert.match(calls[3].prompt, /Stable user instructions and constraints:\n[\s\S]*第三条继续任务/)
  assert.equal(calls[3].prompt.match(/第三条继续任务/g)?.length, 1)
  assert.doesNotMatch(thirdCodexRecent, /第二条当前任务|第三条继续任务|codex final 3|hermes final 2/)
  assert.ok(thirdCodexRecent.length < secondCodexRecent.length)
})

test('Kimi and OpenClaw keep stable group-scoped native sessions', async (t) => {
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
  const openClawKey = workspace.sessionKey(first.id, 'openclaw')
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
  assert.equal(workspace.sessionKey(first.id, 'openclaw', firstRoot), openClawKey)
  assert.equal(calls[0].runOptions.sandbox, 'workspace-write')
  assert.equal(calls[1].runOptions.sandbox, 'workspace-write')
})

test('group write authorization defaults on, can be disabled, and is passed to local CLIs', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '写入授权', agentKinds: ['codex', 'kimi'], workdir: directory,
  })

  await workspace.sendMessage({ groupId: group.id, text: '默认写入', targetKinds: ['codex'] })
  assert.equal(calls[0].runOptions.sandbox, 'workspace-write')
  assert.match(calls[0].prompt, /execute the work instead of returning only a plan/i)
  workspace.updateGroup(group.id, { allowWrite: false })
  await workspace.sendMessage({ groupId: group.id, text: '切换只读', targetKinds: ['kimi'] })

  assert.equal(calls[1].runOptions.sandbox, undefined)
  const restored = new LocalWorkspace(options)
  assert.equal(restored.snapshot().groups[0].allowWrite, false)
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
    () => workspace.updateGroup(group.id, { workdir: path.join(directory, 'other'), allowWrite: false }),
    { message: 'LOCAL_GROUP_RUNNING' },
  )
  releaseRun()
  await send
  assert.equal(workspace.getGroup(group.id).workdir, directory)
  assert.equal(workspace.getGroup(group.id).allowWrite, true)
})

test('changing a group workdir clears native sessions while equivalent paths retain them', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const firstWorkdir = path.join(directory, 'workspace-a')
  const secondWorkdir = path.join(directory, 'workspace-b')
  fs.mkdirSync(firstWorkdir)
  fs.mkdirSync(secondWorkdir)
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '工作区会话隔离', agentKinds: ['codex'], workdir: firstWorkdir,
  })

  await workspace.sendMessage({ groupId: group.id, text: 'A1', targetKinds: ['codex'] })
  workspace.updateGroup(group.id, { workdir: path.join(firstWorkdir, '.') })
  await workspace.sendMessage({ groupId: group.id, text: 'A2', targetKinds: ['codex'] })
  workspace.updateGroup(group.id, { workdir: secondWorkdir })
  assert.equal(workspace.state.sessions[workspace.sessionKey(group.id, 'codex')], undefined)
  await workspace.sendMessage({ groupId: group.id, text: 'B1', targetKinds: ['codex'] })

  assert.deepEqual(calls.map(call => call.workdir), [firstWorkdir, firstWorkdir, secondWorkdir])
  assert.deepEqual(calls.map(call => call.runOptions.sessionRef), ['', 'codex-session', ''])
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
  assert.equal(hermesError.trace.status, 'failed')
  assert.equal(hermesError.trace.agentRunId.includes(':hermes:'), true)
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
  assert.deepEqual(running.runs[0].failedKinds, [])
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

test('running snapshots distinguish failed Agents from successful completions', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let releaseHermes
  let markHermesStarted
  const hermesStarted = new Promise(resolve => { markHermesStarted = resolve })
  options.runAgent = async (agent, _prompt, _workdir, runOptions) => {
    if (agent.kind === 'codex') throw new Error('LOCAL_AGENT_PROCESS_FAILED')
    markHermesStarted()
    await new Promise(resolve => { releaseHermes = resolve })
    return { text: 'Hermes done', sessionRef: runOptions.sessionRef || 'hermes-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '失败状态', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  const send = workspace.sendMessage({
    groupId: group.id, text: '开始', targetKinds: ['codex', 'hermes'],
  })
  await hermesStarted
  const running = workspace.snapshot().runs[0]

  assert.deepEqual(running.completedKinds, ['codex'])
  assert.deepEqual(running.failedKinds, ['codex'])
  assert.equal(running.currentKind, 'hermes')

  releaseHermes()
  await send
})

test('legacy progress stays out of Harness trace while later Agents receive the final reply', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let releaseHermes
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'hermes') {
      runOptions.onEvent({
        id: 'hermes-connector', type: 'warning', status: 'waiting', title: 'connector_limited',
      })
      for (let index = 0; index < 9; index += 1) {
        runOptions.onProgress({
          title: 'write_file', status: 'completed', detail: 'raw-progress-output',
          command: 'cat /private/secret',
        })
      }
      runOptions.onProgress({
        title: '/private/review diff', status: 'unknown', detail: 'raw-review-output',
      })
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
  assert.equal(active.agentRuns[0].events.some(event => event.type.startsWith('tool_')), false)
  assert.equal(active.agentRuns[0].events.some(event => event.title === 'connector_limited'), true)

  releaseHermes()
  await send

  assert.match(calls[1].prompt, /Hermes: Hermes authoritative final/)
  assert.match(calls[1].prompt, /E-R0-HERMES-\d+ \[warning\] connector_limited/)
  assert.doesNotMatch(calls[1].prompt, /\[tool_result_summary\] (?:write_file|process)/)
  assert.doesNotMatch(calls[1].prompt, /raw-progress-output|raw-review-output|cat \/private|elapsedMs|private\/review diff/)
  const hermesReply = workspace.snapshot().messages.find(message => message.agentKind === 'hermes')
  assert.equal(hermesReply.content, 'Hermes authoritative final')
  assert.equal(hermesReply.toolCalls.length, 8)
  assert.deepEqual(hermesReply.trace.events.map(event => [event.type, event.title]), [
    ['warning', 'connector_limited'],
  ])
  assert.doesNotMatch(JSON.stringify(hermesReply.trace), /raw-progress-output|raw-review-output|cat \/private|review diff/)
  assert.equal(Number.isSafeInteger(hermesReply.elapsedMs), true)
  assert.equal(hermesReply.elapsedMs >= 0, true)

  const persisted = JSON.parse(fs.readFileSync(options.storagePath, 'utf8'))
  const persistedReply = persisted.messages.find(message => message.agentKind === 'hermes')
  assert.equal(persistedReply.content, 'Hermes authoritative final')
  assert.equal(persistedReply.toolCalls.length, 8)
  assert.equal(typeof persistedReply.elapsedMs, 'number')
})

test('running progress updates an existing Codex event instead of appending duplicates', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const release = deferred()
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    runOptions.onProgress({ id: 'item-1', title: 'search', status: 'in_progress' })
    runOptions.onProgress({ id: 'item-1', title: 'search', status: 'completed' })
    await release.promise
    return { text: 'done', sessionRef: 'codex-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Codex progress', agentKinds: ['codex'], workdir: directory,
  })

  const send = workspace.sendMessage({ groupId: group.id, text: 'Search' })
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(workspace.snapshot().runs[0].progress, [
    { title: 'search', status: 'completed' },
  ])
  release.resolve()
  await send
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

test('auto send preflights atomically, persists one root, and starts at round one', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const firstCallEntered = deferred()
  const firstCallGate = deferred()
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (calls.length === 1) {
      firstCallEntered.resolve()
      await firstCallGate.promise
    }
    return {
      text: `${agent.kind} agrees\n[[ROUNDRELAY_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  options.validateKnowledgeBaseSelections = (_targetKinds, selections) => selections.map(selection => ({
    ...selection,
    name: 'DingTalk',
    accessMode: 'cli',
    commandName: 'dws',
  }))
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '原子自动讨论', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const attachment = {
    id: 'auto-send-image', name: 'context.png', mimeType: 'image/png', size: 20,
  }
  const skill = {
    targetKind: 'hermes', namespace: 'global', slug: 'research', name: 'Research',
  }
  const knowledgeBase = { kind: 'dingtalk', targetKinds: ['hermes'] }

  const started = await workspace.sendMessage({
    groupId: group.id,
    text: '直接开始自动讨论',
    mode: 'auto',
    maxRounds: 2,
    targetKinds: ['codex', 'hermes'],
    attachments: [attachment],
    skillHints: [skill],
    knowledgeBaseHints: [knowledgeBase],
  })
  await firstCallEntered.promise

  const active = workspace.snapshot()
  const root = active.messages.find(message => message.role === 'user')
  assert.deepEqual(started, { started: true, maxRounds: 2, threadRootId: root.id })
  assert.equal(active.messages.filter(message => message.role === 'user').length, 1)
  assert.equal(root.threadRootId, undefined)
  assert.deepEqual(root.targetKinds, ['codex', 'hermes'])
  assert.deepEqual(root.knowledgeBaseHints, [{
    kind: 'dingtalk', name: 'DingTalk', accessMode: 'cli',
    commandName: 'dws', targetKinds: ['hermes'],
  }])
  assert.deepEqual(active.runs.map(run => ({
    mode: run.mode,
    currentRound: run.currentRound,
    maxRounds: run.maxRounds,
    threadRootId: run.threadRootId,
  })), [{ mode: 'auto', currentRound: 1, maxRounds: 2, threadRootId: root.id }])
  assert.equal(calls.length, 1)
  assert.match(calls[0].prompt, /ROUNDRELAY_CONSENSUS/)
  assert.doesNotMatch(JSON.stringify(active), /sessionRef/)

  const pending = workspace.activeRuns.get(group.id).promise
  firstCallGate.resolve()
  await pending

  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes'])
  assert.equal(calls.every(call => call.prompt.includes('ROUNDRELAY_CONSENSUS')), true)
  assert.deepEqual(calls.map(call => call.runOptions.attachments), [
    [path.join(directory, 'attachments', 'auto-send-image.png')],
    [path.join(directory, 'attachments', 'auto-send-image.png')],
  ])
  assert.deepEqual(calls[1].runOptions.skills, ['research'])
  assert.doesNotMatch(calls[0].prompt, /configured dws command-line connection/)
  assert.match(calls[1].prompt, /configured dws command-line connection/)
  assert.deepEqual(
    workspace.snapshot().messages.filter(message => message.role === 'agent')
      .map(message => message.threadRootId),
    [root.id, root.id],
  )
  assert.equal(finished.length, 1)
  assert.equal(finished[0].mode, 'auto')
  assert.equal(finished[0].status, 'completed')
})

test('unlimited automatic discussion continues past a finite cap until consensus', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const firstCallEntered = deferred()
  const firstCallGate = deferred()
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (calls.length === 1) {
      firstCallEntered.resolve()
      await firstCallGate.promise
    }
    const agreed = calls.length > 2
    return {
      text: `${agent.kind} response\n[[ROUNDRELAY_CONSENSUS:${agreed ? 'agree' : 'continue'}]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '不限轮次讨论', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  const started = await workspace.sendMessage({
    groupId: group.id,
    text: '讨论到达成共识',
    mode: 'auto',
    maxRounds: 1,
    unlimitedRounds: true,
  })
  await firstCallEntered.promise

  const active = workspace.snapshot().runs[0]
  assert.deepEqual(started, {
    started: true,
    maxRounds: 0,
    threadRootId: active.threadRootId,
    unlimitedRounds: true,
  })
  assert.equal(active.currentRound, 1)
  assert.equal(active.maxRounds, 0)
  assert.equal(active.unlimitedRounds, true)

  const pending = workspace.activeRuns.get(group.id).promise
  firstCallGate.resolve()
  await pending

  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes', 'codex', 'hermes'])
  assert.equal(finished[0].status, 'completed')
  assert.equal(workspace.snapshot().messages.some(message => (
    message.system?.key === 'system.autoRoundLimit'
  )), false)
})

test('auto send rejects failed preflight without persisting a root or starting an Agent', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.validateSkillSelections = () => { throw new Error('LOCAL_SKILL_SELECTION_INVALID') }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '自动预检失败', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  await assert.rejects(workspace.sendMessage({
    groupId: group.id,
    text: '不应持久化',
    mode: 'auto',
    targetKinds: ['codex', 'hermes'],
    skillHints: [{
      targetKind: 'hermes', namespace: 'global', slug: 'research', name: 'Research',
    }],
  }), { message: 'LOCAL_SKILL_SELECTION_INVALID' })

  assert.equal(calls.length, 0)
  assert.equal(workspace.snapshot().messages.length, 0)
  assert.deepEqual(workspace.snapshot().runningGroupIds, [])
  assert.deepEqual(finished, [])
})

test('auto send rolls back its root when the reserved run is cancelled during handoff', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  const finished = []
  let stopped = false
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '自动交接取消', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  workspace.on('changed', (snapshot) => {
    if (stopped || !snapshot.messages.some(message => message.role === 'user')) return
    if (!snapshot.runs.some(run => run.groupId === group.id && run.phase === 'preparing')) return
    stopped = true
    const run = snapshot.runs.find(item => item.groupId === group.id)
    workspace.stop(group.id, run.runId)
  })

  await assert.rejects(workspace.sendMessage({
    groupId: group.id,
    text: '取消时不应留下消息',
    mode: 'auto',
    maxRounds: 2,
  }), { message: 'LOCAL_AGENT_EXECUTION_STOPPED' })

  assert.equal(stopped, true)
  assert.equal(calls.length, 0)
  assert.equal(workspace.snapshot().messages.length, 0)
  assert.deepEqual(workspace.snapshot().runningGroupIds, [])
  assert.deepEqual(finished, [])
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
  assert.deepEqual(
    workspace.snapshot().messages.filter(message => message.role === 'agent')
      .map(message => message.trace.round),
    [1, 1, 2, 2],
  )
  const reloaded = new LocalWorkspace(options)
  await reloaded.refreshAgents()
  assert.deepEqual(
    reloaded.snapshot().messages.filter(message => message.role === 'agent')
      .map(message => message.trace.round),
    [1, 1, 2, 2],
  )
  assert.deepEqual(workspace.snapshot().runningGroupIds, [])
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'completed')
  assert.equal(finished[0].mode, 'auto')
})

for (const acpKind of ['hermes', 'kimi']) {
  test(`automatic dialogue starts a fresh ${acpKind} ACP session each round`, async (t) => {
    const { directory, calls, options } = fixture()
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    options.runAgent = async (agent, prompt, workdir, runOptions) => {
      calls.push({ agent, prompt, workdir, runOptions })
      const agentCallCount = calls.filter(call => call.agent.kind === agent.kind).length
      if (agent.kind === acpKind) {
        await runOptions.onSessionRef(`${acpKind}-acp-session-${agentCallCount}`, { transport: 'acp' })
      }
      const consensus = agentCallCount > 1 ? 'agree' : 'continue'
      const sessionRef = agent.kind === acpKind
        ? `${acpKind}-acp-session-${agentCallCount}`
        : runOptions.sessionRef || `${agent.kind}-session-${agentCallCount}`
      return {
        text: `${agent.kind} ${consensus}\n[[ROUNDRELAY_CONSENSUS:${consensus}]]`,
        sessionRef,
      }
    }
    const workspace = new LocalWorkspace(options)
    await workspace.refreshAgents()
    const group = workspace.createGroup({
      name: `${acpKind} ACP discussion`, agentKinds: ['codex', acpKind], workdir: directory,
    })

    const started = await workspace.sendMessage({
      groupId: group.id,
      text: 'Check ACP session isolation',
      mode: 'auto',
      maxRounds: 2,
    })
    assert.equal(started.started, true)
    await workspace.activeRuns.get(group.id).promise

    const acpCalls = calls.filter(call => call.agent.kind === acpKind)
    assert.deepEqual(acpCalls.map(call => call.runOptions.sessionRef), ['', ''])
    assert.equal(acpCalls[1].runOptions.sessionTransport, '')
    assert.match(acpCalls[1].prompt, new RegExp(`${acpKind} continue`))
    assert.equal(
      workspace.state.sessions[workspace.sessionKey(group.id, acpKind)],
      `${acpKind}-acp-session-2`,
    )
    assert.equal(workspace.state.sessionMeta[workspace.sessionKey(group.id, acpKind)].transport, 'acp')
  })
}

test('automatic dialogue queues only the explicitly targeted group members', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return {
      text: `${agent.kind} agrees\n[[ROUNDRELAY_CONSENSUS:agree]]`,
      sessionRef: `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  const runFinished = deferred()
  workspace.on('run-finished', (result) => {
    finished.push(result)
    runFinished.resolve()
  })
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '定向自动讨论',
    agentKinds: ['codex', 'hermes', 'workbuddy', 'kimi', 'openclaw'],
    workdir: directory,
  })

  await assert.rejects(workspace.sendMessage({
    groupId: group.id,
    text: 'Only Codex',
    mode: 'auto',
    targetKinds: ['codex'],
    maxRounds: 1,
  }), { message: 'LOCAL_AUTO_AGENT_COUNT' })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Codex、Hermes 和 Kimi 讨论',
    mode: 'auto',
    targetKinds: ['codex', 'hermes', 'kimi'],
    mentionedAgentKinds: ['codex', 'hermes', 'kimi'],
    maxRounds: 1,
  })
  await runFinished.promise

  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes', 'kimi'])
  assert.deepEqual(
    workspace.snapshot().messages.find(message => message.role === 'user')?.targetKinds,
    ['codex', 'hermes', 'kimi'],
  )
  assert.deepEqual(finished[0].targetKinds, ['codex', 'hermes', 'kimi'])

  calls.length = 0
  const nextRoot = workspace.addMessage(group.id, 'user', '另一组继续讨论')
  workspace.startAuto({
    groupId: group.id,
    threadRootId: nextRoot.id,
    targetKinds: ['workbuddy', 'openclaw'],
    maxRounds: 1,
  })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), ['workbuddy', 'openclaw'])
  assert.deepEqual(finished[1].targetKinds, ['workbuddy', 'openclaw'])
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
  const runId = workspace.activeRuns.get(group.id).runId
  await secondRound

  assert.equal(workspace.stop(group.id, 'stale-run'), false)
  assert.equal(activeSignal.aborted, false)
  assert.equal(workspace.stop(group.id, runId), true)
  await pending

  assert.equal(activeSignal.aborted, true)
  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes', 'codex'])
  assert.equal(workspace.stop(group.id, runId), false)
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
  const ledgerPath = path.join(directory, 'run-ledger.json')
  options.runLedger = new RunLedger({ storagePath: ledgerPath })
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
  const runId = workspace.activeRuns.get(group.id).runId
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
  assert.equal(options.runLedger.get(runId).agentRuns.filter(agentRun => (
    agentRun.kind === 'hermes' && agentRun.status === 'failed'
  )).length, 2)

  const recovered = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath }),
  })
  assert.equal(recovered.snapshot().messages.filter(message => (
    message.agentKind === 'hermes'
      && message.system?.key === 'system.agentCallFailed'
  )).length, 1)

  const repeated = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath }),
  })
  assert.equal(repeated.snapshot().messages.filter(message => (
    message.agentKind === 'hermes'
      && message.system?.key === 'system.agentCallFailed'
  )).length, 1)
  assert.equal(new RunLedger({ storagePath: ledgerPath }).get(runId).agentRuns.filter(agentRun => (
    agentRun.kind === 'hermes' && agentRun.status === 'failed'
  )).length, 2)
})

test('automatic dialogue retains distinct streamed conclusions for the same failure', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  options.runLedger = new RunLedger({ storagePath: ledgerPath })
  let hermesAttempts = 0
  options.runAgent = async (agent, _prompt, _workdir, runOptions) => {
    if (agent.kind === 'hermes') {
      hermesAttempts += 1
      runOptions.onEvent({
        type: 'answer_delta',
        status: 'running',
        delta: `Hermes partial conclusion ${hermesAttempts}`,
      })
      throw new Error('LOCAL_AGENT_PROCESS_FAILED')
    }
    return {
      text: `${agent.kind} continue\n[[ROUNDRELAY_CONSENSUS:continue]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Distinct failure evidence', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', 'Preserve distinct partial conclusions')

  workspace.startAuto({ groupId: group.id, maxRounds: 2 })
  await workspace.activeRuns.get(group.id).promise

  const liveFailures = workspace.snapshot().messages.filter(message => (
    message.agentKind === 'hermes' && message.system?.key === 'system.agentCallFailed'
  ))
  assert.equal(liveFailures.length, 2)
  assert.match(liveFailures[0].content, /Hermes partial conclusion 1/)
  assert.match(liveFailures[1].content, /Hermes partial conclusion 2/)

  const restored = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath }),
  })
  const restoredFailures = restored.snapshot().messages.filter(message => (
    message.agentKind === 'hermes' && message.system?.key === 'system.agentCallFailed'
  ))
  assert.equal(restoredFailures.length, 2)
  assert.deepEqual(restoredFailures.map(message => message.content), liveFailures.map(message => message.content))
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

test('automatic dialogue defaults to six rounds and hides consensus markers at the cap', async (t) => {
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

  assert.deepEqual(started, { started: true, maxRounds: 6 })
  assert.deepEqual(calls.map(call => call.agent.kind), [
    'codex', 'hermes', 'codex', 'hermes', 'codex', 'hermes',
    'codex', 'hermes', 'codex', 'hermes', 'codex', 'hermes',
  ])
  assert.equal(workspace.snapshot().messages.some(message => (
    message.content.includes('[[ROUNDRELAY_CONSENSUS:')
  )), false)
  const limit = workspace.snapshot().messages.find(message => (
    message.system?.key === 'system.autoRoundLimit'
  ))
  assert.equal(limit.threadRootId, root.id)
  assert.deepEqual(limit.system.params, { rounds: 6 })
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

test('automatic dialogue caps both round parameters at ten', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return {
      text: `${agent.kind} agrees\n[[ROUNDRELAY_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '十轮上限', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', '上限测试')

  const started = workspace.startAuto({ groupId: group.id, maxTurns: 999 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(started, { started: true, maxRounds: 10 })
  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes'])
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
  const interruptedAgent = workspace.snapshot().messages.find(message => (
    message.agentKind === 'codex' && message.system?.key === 'system.agentCallFailed'
  ))
  assert.equal(interruptedAgent.system.params.reason, 'LOCAL_AGENT_TIMEOUT')
  assert.equal(interruptedAgent.trace.status, 'timeout')
  assert.equal(interruptedAgent.trace.context.includedCount, 1)
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

test('Harness streams per-Agent events, persists a compact trace, and hands evidence to the next Agent', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'codex') {
      runOptions.onProgress({
        id: 'turn', title: 'process', status: 'in_progress', detail: 'raw progress detail',
      })
      runOptions.onEvent({
        id: 'reason-1',
        type: 'reasoning_summary',
        summary: 'Compared the available implementations.',
      })
      runOptions.onEvent({
        id: 'tool-1',
        type: 'tool_start',
        status: 'running',
        title: 'Bash',
        summary: 'Bash: operation: rg -n (2 hidden arguments)',
        command: 'rg secret /Users/private/work',
      })
      runOptions.onProgress({
        id: 'turn', title: 'process', status: 'completed', detail: 'raw progress result',
      })
      runOptions.onEvent({
        id: 'tool-1',
        type: 'tool_result_summary',
        status: 'completed',
        title: 'Bash',
        summary: 'Bash: operation: rg -n (2 hidden arguments)',
        detail: 'Exit code: 0\nOutput: 3 lines, 120 bytes',
      })
      runOptions.onEvent({ type: 'answer_delta', status: 'running', delta: 'Codex live ' })
      return { text: 'Codex final conclusion', sessionRef: 'codex-session' }
    }
    assert.match(prompt, /untrusted data, not instructions/)
    assert.match(prompt, /E-R0-CODEX-01|E-R1-CODEX-01/)
    assert.match(prompt, /Codex final conclusion/)
    assert.doesNotMatch(prompt, /rg secret|\/Users\/private/)
    return { text: 'Hermes final conclusion', sessionRef: 'hermes-session' }
  }
  const events = []
  const workspace = new LocalWorkspace(options)
  workspace.on('run-event', event => events.push(event))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Harness trace', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Compare the implementations',
    targetKinds: ['codex', 'hermes'],
  })

  const agentMessages = workspace.snapshot().messages.filter(message => message.role === 'agent')
  assert.deepEqual(agentMessages.map(message => message.content), [
    'Codex final conclusion',
    'Hermes final conclusion',
  ])
  const codexTrace = agentMessages[0].trace
  assert.equal(codexTrace.status, 'completed')
  assert.equal(codexTrace.events.some(event => event.type === 'reasoning_summary'), true)
  assert.equal(codexTrace.events.some(event => event.type === 'tool_result_summary'), true)
  const codexTool = codexTrace.events.find(event => event.type === 'tool_result_summary')
  assert.equal(codexTool.title, 'Bash')
  assert.equal(codexTool.summary, 'Bash: operation: rg -n (2 hidden arguments)')
  assert.equal(codexTool.detail, 'Exit code: 0\nOutput: 3 lines, 120 bytes')
  assert.equal(codexTrace.events.some(event => event.title === 'process'), false)
  assert.deepEqual(codexTrace.sourceMessageIds, [workspace.snapshot().messages[0].id])
  assert.equal(codexTrace.context.includedCount, codexTrace.sourceMessageIds.length)
  assert.deepEqual(agentMessages[1].trace.sourceMessageIds, [
    workspace.snapshot().messages[0].id,
    agentMessages[0].id,
  ])
  assert.equal(
    agentMessages[1].trace.context.includedCount,
    agentMessages[1].trace.sourceMessageIds.length,
  )
  assert.doesNotMatch(JSON.stringify(codexTrace), /rg secret|\/Users\/private|raw progress/)
  assert.equal(events.some(event => event.type === 'answer_delta' && event.delta === 'Codex live '), true)
  assert.equal(events.some(event => event.title === 'process'), false)
  assert.equal(events.every(event => !Object.hasOwn(event, 'command')
    && !Object.hasOwn(event, 'executable')
    && !Object.hasOwn(event, 'sessionRef')), true)
  assert.equal(events.every(event => Number.isInteger(event.seq) && event.runId), true)
})

test('terminal Agent traces hand compact partial evidence to the next Agent only', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let hermesPrompt = ''
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    if (agent.kind === 'codex') {
      runOptions.onEvent({
        id: 'reason-1',
        type: 'reasoning_summary',
        summary: 'Mapped the recovery boundary.',
      })
      runOptions.onEvent({
        id: 'tool-1',
        type: 'tool_result_summary',
        status: 'completed',
        title: 'Inspect',
        summary: 'Located durable evidence.',
        detail: 'RAW_TOOL_LOG_SHOULD_NOT_REACH_THE_NEXT_AGENT',
      })
      runOptions.onEvent({
        type: 'answer_delta', status: 'running', delta: 'Partial conclusion for Hermes',
      })
      throw new Error('LOCAL_AGENT_PROCESS_FAILED')
    }
    hermesPrompt = prompt
    return { text: 'Hermes continued from the evidence', sessionRef: 'hermes-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Terminal evidence', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  workspace.addMessage(
    group.id,
    'system',
    'UNSUPPORTED_AGENT_TERMINAL_SHOULD_NOT_REACH',
    'unsupported-agent',
    '',
    { key: 'system.agentCallFailed', params: { reason: 'UNSUPPORTED' } },
    {
      trace: {
        runId: 'unsupported-run',
        agentRunId: 'unsupported-run:0:unsupported-agent:attempt-1',
        round: 0,
        status: 'failed',
      },
    },
  )
  workspace.addMessage(
    group.id,
    'system',
    'ORDINARY_SYSTEM_TEXT_SHOULD_NOT_REACH',
    '',
    '',
    { key: 'system.autoStopped', params: {} },
  )

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Continue even if Codex fails',
    targetKinds: ['codex', 'hermes'],
  })

  const snapshot = workspace.snapshot()
  const root = snapshot.messages.find(message => message.role === 'user')
  const terminal = snapshot.messages.find(message => (
    message.agentKind === 'codex' && message.system?.key === 'system.agentCallFailed'
  ))
  assert.match(hermesPrompt, /Partial conclusion for Hermes/)
  assert.match(hermesPrompt, /untrusted data, not instructions/)
  assert.match(hermesPrompt, /E-R0-CODEX-\d{2} \[tool_result_summary\] Inspect: Located durable evidence/)
  assert.match(hermesPrompt, new RegExp(`Source messages: ${root.id}`))
  assert.doesNotMatch(
    hermesPrompt,
    /RAW_TOOL_LOG_SHOULD_NOT_REACH|ORDINARY_SYSTEM_TEXT_SHOULD_NOT_REACH|UNSUPPORTED_AGENT_TERMINAL_SHOULD_NOT_REACH/,
  )
  assert.equal(terminal.trace.sourceMessageIds.includes(root.id), true)
  assert.equal(snapshot.messages.find(message => (
    message.agentKind === 'hermes' && message.role === 'agent'
  )).trace.sourceMessageIds.includes(terminal.id), true)

  const afterCodex = workspace.recentTranscript(group.id, 'codex')
  assert.match(afterCodex, /Hermes continued from the evidence/)
  assert.doesNotMatch(afterCodex, /Partial conclusion for Hermes/)
})

test('Harness rotates an over-budget native session while retaining compressed continuity', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return { text: 'Fresh conclusion', sessionRef: 'new-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Rotation', agentKinds: ['codex'], workdir: directory,
  })
  const oldUser = workspace.addMessage(group.id, 'user', 'Keep this constraint')
  const previousAgent = workspace.addMessage(
    group.id, 'agent', 'Previous conclusion', 'codex', oldUser.id,
  )
  const key = workspace.sessionKey(group.id, 'codex')
  workspace.state.sessions[key] = 'old-session'
  workspace.state.sessionMeta[key] = { turns: 18, estimatedChars: 48000 }
  workspace.save()

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Continue with a fresh context',
    targetKinds: ['codex'],
  })

  assert.equal(calls[0].runOptions.sessionRef, '')
  assert.match(calls[0].prompt, /Previous conclusion/)
  const snapshot = workspace.snapshot()
  const currentUser = snapshot.messages.find(message => (
    message.role === 'user' && message.content === 'Continue with a fresh context'
  ))
  const trace = snapshot.messages.at(-1).trace
  assert.equal(trace.context.sessionRotated, true)
  assert.deepEqual(trace.sourceMessageIds, [oldUser.id, currentUser.id, previousAgent.id])
  assert.equal(trace.context.includedCount, trace.sourceMessageIds.length)
  assert.equal(workspace.state.sessions[key], 'new-session')
  assert.equal(workspace.state.sessionMeta[key].turns, 1)
  assert.equal(workspace.state.sessionMeta[key].estimatedChars > calls[0].prompt.length, true)
})

test('Hermes rebuilds full context when an ACP session must switch to legacy for a skill', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.detectAgents = async () => [{
    kind: 'hermes',
    name: 'Hermes CLI',
    executable: '/tmp/hermes',
    version: '2',
    acpAvailable: true,
  }]
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    await runOptions.onSessionRef('hermes-legacy-session', { transport: 'legacy' })
    return { text: 'Legacy conclusion', sessionRef: 'hermes-legacy-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Hermes transport switch', agentKinds: ['hermes'], workdir: directory,
  })
  const oldUser = workspace.addMessage(group.id, 'user', 'Keep the original constraint')
  const previousAgent = workspace.addMessage(
    group.id, 'agent', 'Previous Hermes conclusion', 'hermes', oldUser.id,
  )
  const key = workspace.sessionKey(group.id, 'hermes')
  workspace.state.sessions[key] = 'hermes-acp-session'
  workspace.state.sessionMeta[key] = { turns: 2, estimatedChars: 1200, transport: 'acp' }
  workspace.save()

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Continue with the selected skill',
    targetKinds: ['hermes'],
    skillHints: [{
      targetKind: 'hermes', namespace: 'global', slug: 'research', name: 'Research',
    }],
  })

  assert.equal(calls[0].runOptions.sessionRef, '')
  assert.equal(calls[0].runOptions.sessionTransport, '')
  assert.deepEqual(calls[0].runOptions.skills, ['research'])
  assert.match(calls[0].prompt, /Previous Hermes conclusion/)
  assert.equal(workspace.state.sessions[key], 'hermes-legacy-session')
  assert.equal(workspace.state.sessionMeta[key].transport, 'legacy')
  assert.equal(workspace.state.sessionMeta[key].turns, 1)
  const snapshot = workspace.snapshot()
  const currentUser = snapshot.messages.find(message => (
    message.role === 'user' && message.content === 'Continue with the selected skill'
  ))
  const trace = snapshot.messages.at(-1).trace
  assert.equal(trace.context.sessionRotated, true)
  assert.deepEqual(trace.sourceMessageIds, [oldUser.id, currentUser.id, previousAgent.id])
  assert.equal(trace.context.includedCount, trace.sourceMessageIds.length)
})

test('Hermes clears a stale ACP session and rebuilds full context before legacy fallback', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.detectAgents = async () => [{
    kind: 'hermes',
    name: 'Hermes CLI',
    executable: '/tmp/hermes',
    version: '2',
    acpAvailable: true,
  }]
  let recoveredPrompt = ''
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    const recovery = await runOptions.onSessionInvalidated({
      kind: 'hermes', sessionRef: runOptions.sessionRef, transport: 'acp',
    })
    recoveredPrompt = recovery.prompt
    await runOptions.onSessionRef('hermes-recovered-session', { transport: 'legacy' })
    return { text: 'Recovered conclusion', sessionRef: 'hermes-recovered-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Hermes stale ACP', agentKinds: ['hermes'], workdir: directory,
  })
  const oldUser = workspace.addMessage(group.id, 'user', 'Keep the original constraint')
  const previousAgent = workspace.addMessage(
    group.id, 'agent', 'Previous Hermes conclusion', 'hermes', oldUser.id,
  )
  const key = workspace.sessionKey(group.id, 'hermes')
  workspace.state.sessions[key] = 'hermes-stale-acp-session'
  workspace.state.sessionMeta[key] = { turns: 2, estimatedChars: 1200, transport: 'acp' }
  workspace.save()

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Continue after recovering the session',
    targetKinds: ['hermes'],
  })

  assert.equal(calls[0].runOptions.sessionRef, 'hermes-stale-acp-session')
  assert.doesNotMatch(calls[0].prompt, /Previous Hermes conclusion/)
  assert.match(recoveredPrompt, /Previous Hermes conclusion/)
  assert.match(recoveredPrompt, /Continue after recovering the session/)
  assert.equal(workspace.state.sessions[key], 'hermes-recovered-session')
  assert.equal(workspace.state.sessionMeta[key].transport, 'legacy')
  assert.equal(workspace.state.sessionMeta[key].turns, 1)
  const snapshot = workspace.snapshot()
  const currentUser = snapshot.messages.find(message => (
    message.role === 'user' && message.content === 'Continue after recovering the session'
  ))
  const trace = snapshot.messages.at(-1).trace
  assert.equal(trace.context.sessionRotated, true)
  assert.deepEqual(trace.sourceMessageIds, [oldUser.id, currentUser.id, previousAgent.id])
  assert.equal(trace.context.includedCount, trace.sourceMessageIds.length)
})

test('Harness rotates an over-budget OpenClaw managed session to a new key', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return { text: 'Fresh OpenClaw conclusion', sessionRef: runOptions.sessionRef }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'OpenClaw rotation', agentKinds: ['openclaw'], workdir: directory,
  })
  const oldUser = workspace.addMessage(group.id, 'user', 'Keep the prior constraint')
  const previousAgent = workspace.addMessage(
    group.id, 'agent', 'Prior OpenClaw conclusion', 'openclaw', oldUser.id,
  )
  const key = workspace.sessionKey(group.id, 'openclaw')
  const previousSessionRef = workspace.openClawSessionRef(group)
  workspace.state.sessions[key] = previousSessionRef
  workspace.state.sessionMeta[key] = { turns: 18, estimatedChars: 48000 }
  workspace.save()

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Continue with bounded context',
    targetKinds: ['openclaw'],
  })

  assert.notEqual(calls[0].runOptions.sessionRef, previousSessionRef)
  assert.match(calls[0].runOptions.sessionRef, new RegExp(`^${previousSessionRef}-[a-f0-9]{12}$`))
  assert.match(calls[0].prompt, /Prior OpenClaw conclusion/)
  const snapshot = workspace.snapshot()
  const currentUser = snapshot.messages.find(message => (
    message.role === 'user' && message.content === 'Continue with bounded context'
  ))
  const trace = snapshot.messages.at(-1).trace
  assert.equal(trace.context.sessionRotated, true)
  assert.deepEqual(trace.sourceMessageIds, [oldUser.id, currentUser.id, previousAgent.id])
  assert.equal(trace.context.includedCount, trace.sourceMessageIds.length)
  assert.equal(workspace.state.sessions[key], calls[0].runOptions.sessionRef)
  assert.equal(workspace.state.sessionMeta[key].turns, 1)
})

test('legacy sessions resume once and initialize bounded session metadata', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Legacy session metadata', agentKinds: ['codex'], workdir: directory,
  })
  const key = workspace.sessionKey(group.id, 'codex')
  workspace.state.sessions[key] = 'legacy-codex-session'
  workspace.save()

  await workspace.sendMessage({ groupId: group.id, text: 'Resume safely', targetKinds: ['codex'] })

  assert.equal(calls[0].runOptions.sessionRef, 'legacy-codex-session')
  assert.equal(workspace.state.sessionMeta[key].turns, 1)
  assert.equal(workspace.state.sessionMeta[key].estimatedChars > 0, true)
})

test('per-Agent watchdog persists a timeout trace and continues the automatic round', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgentTimeoutMs = 8
  options.runAbortGraceMs = 20
  options.runSilenceWarningMs = 100
  const lateCallbacksDone = deferred()
  let timedOutSignal
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'codex') {
      timedOutSignal = runOptions.signal
      return await new Promise((resolve) => {
        runOptions.signal.addEventListener('abort', () => {
          setImmediate(() => {
            runOptions.onProgress({
              id: 'late-progress', title: 'search', status: 'completed', detail: 'late raw data',
            })
            runOptions.onEvent({
              id: 'late-tool', type: 'tool_result_summary', title: 'search',
              status: 'completed', summary: 'late event',
            })
            runOptions.onSessionRef('late-session')
            resolve({ text: 'late answer', sessionRef: 'late-session' })
            lateCallbacksDone.resolve()
          })
        }, { once: true })
      })
    }
    return {
      text: 'Hermes continued\n[[ROUNDRELAY_CONSENSUS:continue]]',
      sessionRef: 'hermes-session',
    }
  }
  const events = []
  const finished = []
  const workspace = new LocalWorkspace(options)
  workspace.on('run-event', event => events.push(event))
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Agent watchdog', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Continue after one Agent times out',
    mode: 'auto',
    maxRounds: 1,
  })
  await workspace.activeRuns.get(group.id).promise
  await lateCallbacksDone.promise

  assert.equal(timedOutSignal.aborted, true)
  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes'])
  const failure = workspace.snapshot().messages.find(message => (
    message.agentKind === 'codex' && message.system?.key === 'system.agentCallFailed'
  ))
  assert.equal(failure.system.params.reason, 'LOCAL_AGENT_TIMEOUT')
  assert.equal(failure.trace.status, 'timeout')
  assert.equal(finished[0].status, 'round-limit')
  assert.equal(events.some(event => (
    event.agentKind === 'codex' && event.type === 'status' && event.status === 'timeout'
  )), true)
  assert.equal(events.some(event => ['late-progress', 'late-tool'].includes(event.id)), false)
  assert.equal(workspace.state.sessions[workspace.sessionKey(group.id, 'codex')], undefined)
})

test('manual Agent watchdog finishes the run as timeout and removes the parent abort listener', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgentTimeoutMs = 8
  options.runAbortGraceMs = 20
  options.runSilenceWarningMs = 100
  const started = deferred()
  let timedOutSignal
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    timedOutSignal = runOptions.signal
    started.resolve()
    return await new Promise(() => {})
  }
  const finished = []
  const workspace = new LocalWorkspace(options)
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Manual watchdog', agentKinds: ['codex'], workdir: directory,
    conversationType: 'direct', directAgentKind: 'codex',
  })

  const send = workspace.sendMessage({ groupId: group.id, text: 'Do not wait forever' })
  await started.promise
  const parentSignal = workspace.activeRuns.get(group.id).signal
  assert.equal(getEventListeners(parentSignal, 'abort').length, 1)
  await send

  assert.equal(timedOutSignal.aborted, true)
  assert.equal(getEventListeners(parentSignal, 'abort').length, 0)
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'timeout')
  const failure = workspace.snapshot().messages.find(message => (
    message.agentKind === 'codex' && message.system?.key === 'system.agentCallFailed'
  ))
  assert.equal(failure.system.params.reason, 'LOCAL_AGENT_TIMEOUT')
  assert.equal(failure.trace.status, 'timeout')
})

test('terminal Agent states persist conclusion text already streamed through answer deltas', async (t) => {
  const scenarios = [
    {
      name: 'failure',
      action: 'fail',
      expectedKey: 'system.agentCallFailed',
      expectedPrefix: 'Codex failed: LOCAL_AGENT_PROCESS_FAILED',
    },
    {
      name: 'timeout',
      action: 'timeout',
      expectedKey: 'system.agentCallFailed',
      expectedPrefix: 'Codex failed: LOCAL_AGENT_TIMEOUT',
    },
    {
      name: 'stop',
      action: 'stop',
      expectedKey: 'system.agentStopped',
      expectedPrefix: 'Codex was stopped.',
    },
    {
      name: 'interruption',
      action: 'interrupt',
      expectedKey: 'system.agentInterrupted',
      expectedPrefix: 'Codex was interrupted when Meldwork closed.',
    },
  ]

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (t) => {
      const { directory, options } = fixture()
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
      const started = deferred()
      const conclusion = `${scenario.name} streamed conclusion`
      options.runAbortGraceMs = 20
      options.runSilenceWarningMs = 100
      if (scenario.action === 'timeout') options.runAgentTimeoutMs = 8
      options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
        runOptions.onEvent({
          type: 'reasoning_summary', status: 'running', summary: 'Trace-only reasoning summary',
        })
        runOptions.onEvent({ type: 'answer_delta', status: 'running', delta: conclusion })
        started.resolve()
        if (scenario.action === 'fail') throw new Error('LOCAL_AGENT_PROCESS_FAILED')
        return await new Promise((_resolve, reject) => {
          runOptions.signal.addEventListener(
            'abort', () => reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED')), { once: true },
          )
        })
      }
      const workspace = new LocalWorkspace(options)
      await workspace.refreshAgents()
      const group = workspace.createGroup({
        name: `Streamed ${scenario.name}`, agentKinds: ['codex'], workdir: directory,
      })

      const send = workspace.sendMessage({
        groupId: group.id, text: `Exercise ${scenario.name}`, targetKinds: ['codex'],
      })
      await started.promise
      if (scenario.action === 'stop') {
        const runId = workspace.activeRuns.get(group.id).runId
        assert.equal(workspace.stop(group.id, runId), true)
        await send
      } else if (scenario.action === 'interrupt') {
        await Promise.all([send, workspace.stopAll()])
      } else {
        await send
      }

      const terminal = workspace.snapshot().messages.find(message => (
        message.agentKind === 'codex' && message.system?.key === scenario.expectedKey
      ))
      assert.equal(terminal.content, `${scenario.expectedPrefix}\n${conclusion}`)
      assert.doesNotMatch(terminal.content, /Trace-only reasoning summary/)
      const persisted = JSON.parse(fs.readFileSync(options.storagePath, 'utf8'))
      assert.equal(
        persisted.messages.find(message => message.id === terminal.id).content,
        terminal.content,
      )
    })
  }
})

test('completed Agents clear watchdog and silence timers', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgentTimeoutMs = 5
  options.runSilenceWarningMs = 5
  let completedSignal
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    completedSignal = runOptions.signal
    return { text: 'Completed immediately', sessionRef: 'codex-session' }
  }
  const events = []
  const workspace = new LocalWorkspace(options)
  workspace.on('run-event', event => events.push(event))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Timer cleanup', agentKinds: ['codex'], workdir: directory,
  })

  await workspace.sendMessage({ groupId: group.id, text: 'Finish', targetKinds: ['codex'] })
  await new Promise(resolve => setTimeout(resolve, 20))

  assert.equal(completedSignal.aborted, false)
  assert.equal(events.some(event => event.type === 'warning'), false)
  assert.deepEqual(workspace.snapshot().runningGroupIds, [])
})

test('progress heartbeats reset the soft silence warning', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runSilenceWarningMs = 30
  options.runAgentTimeoutMs = 500
  const heartbeatsComplete = deferred()
  const releaseAgent = deferred()
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    for (let tick = 0; tick < 8; tick += 1) {
      await new Promise(resolve => setTimeout(resolve, 5))
      runOptions.onProgress({ id: 'heartbeat', title: 'process', status: 'in_progress' })
    }
    heartbeatsComplete.resolve()
    await releaseAgent.promise
    return { text: 'Finished after progress', sessionRef: 'codex-session' }
  }
  const events = []
  const workspace = new LocalWorkspace(options)
  workspace.on('run-event', event => events.push(event))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Progress heartbeat', agentKinds: ['codex'], workdir: directory,
  })

  const send = workspace.sendMessage({
    groupId: group.id, text: 'Keep reporting', targetKinds: ['codex'],
  })
  await heartbeatsComplete.promise

  assert.equal(events.some(event => event.type === 'warning'), false)
  assert.equal(events.some(event => event.type.startsWith('tool_') || event.title === 'process'), false)

  await new Promise(resolve => setTimeout(resolve, 45))
  const warning = events.find(event => event.type === 'warning')
  assert.equal(warning?.title, 'waiting_for_output')

  releaseAgent.resolve()
  await send
  const reply = workspace.snapshot().messages.find(message => message.agentKind === 'codex')
  assert.equal(reply.trace.events.some(event => event.title === 'process'), false)
})

test('Harness emits a soft waiting warning without cancelling a long-running Agent', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runSilenceWarningMs = 5
  const gate = deferred()
  options.runAgent = async () => {
    await gate.promise
    return { text: 'Eventually finished', sessionRef: 'codex-session' }
  }
  const events = []
  const workspace = new LocalWorkspace(options)
  workspace.on('run-event', event => events.push(event))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Silence warning', agentKinds: ['codex'], workdir: directory,
  })

  const send = workspace.sendMessage({ groupId: group.id, text: 'Wait', targetKinds: ['codex'] })
  await new Promise(resolve => setTimeout(resolve, 25))
  const warning = events.find(event => event.type === 'warning')
  assert.equal(warning?.status, 'waiting')
  assert.equal(warning?.title, 'waiting_for_output')
  assert.equal(workspace.snapshot().runningGroupIds.includes(group.id), true)
  gate.resolve()
  await send
  assert.equal(workspace.snapshot().messages.at(-1).content, 'Eventually finished')
})

test('Automatic Harness conclusions stream without exposing the consensus control marker', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    runOptions.onEvent({ type: 'reasoning_summary', summary: agent.kind + ' compared the proposals' })
    runOptions.onEvent({ type: 'answer_delta', status: 'running', delta: agent.kind + ' conclusion\n[[ROUNDRELAY_CONSENSUS:' })
    runOptions.onEvent({ type: 'answer_delta', status: 'running', delta: 'agree]]' })
    return {
      text: agent.kind + ' conclusion\n[[ROUNDRELAY_CONSENSUS:agree]]',
      sessionRef: runOptions.sessionRef || agent.kind + '-session',
    }
  }
  const events = []
  const workspace = new LocalWorkspace(options)
  workspace.on('run-event', event => events.push(event))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Automatic harness', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  const started = await workspace.sendMessage({
    groupId: group.id,
    text: 'Reach consensus',
    mode: 'auto',
    maxRounds: 1,
  })
  assert.equal(started.started, true)
  await workspace.activeRuns.get(group.id).promise

  const answerText = events.filter(event => event.type === 'answer_delta')
    .map(event => event.delta)
    .join('')
  assert.doesNotMatch(answerText, /ROUNDRELAY_CONSENSUS/)
  assert.equal(events.some(event => event.type === 'reasoning_summary'), true)
  assert.deepEqual(
    workspace.snapshot().messages.filter(message => message.role === 'agent')
      .map(message => message.content),
    ['codex conclusion', 'hermes conclusion'],
  )
})

test('Run Ledger checkpoints bounded trace state and is cleared with its conversation', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const checkpoints = []
  const finishes = []
  const deletedGroups = []
  options.runLedger = {
    recoverInterrupted: () => [],
    checkpoint: record => checkpoints.push(structuredClone(record)),
    finish: (runId, status, reason) => finishes.push({ runId, status, reason }),
    deleteGroup: groupId => deletedGroups.push(groupId),
  }
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    runOptions.onEvent({
      id: 'plan-1', type: 'plan', status: 'running', summary: 'Inspect the current implementation.',
    })
    return { text: 'Ledger-backed result', sessionRef: 'codex-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Ledger lifecycle', agentKinds: ['codex'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id, text: 'Trace this run', targetKinds: ['codex'],
  })

  assert.equal(checkpoints.some(record => record.status === 'preparing'), true)
  assert.equal(checkpoints.some(record => record.status === 'running'), true)
  const terminal = checkpoints.findLast(record => record.status === 'completed')
  assert.equal(terminal.agentRuns[0].status, 'completed')
  assert.equal(terminal.agentRuns[0].events.some(event => event.type === 'plan'), true)
  assert.equal(terminal.agentRuns[0].context.includedCount, 1)
  assert.deepEqual(finishes, [{ runId: terminal.runId, status: 'completed', reason: '' }])

  workspace.deleteGroup(group.id)
  assert.deepEqual(deletedGroups, [group.id])
})

test('Run Ledger finalization retries the full terminal snapshot before finish', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const ledger = new RunLedger({ storagePath: ledgerPath, now: () => 1000 })
  options.runLedger = ledger
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Retry terminal checkpoint', agentKinds: ['codex'], workdir: directory,
  })
  const controller = workspace.createRunController('manual', ['codex'], 'root-1')
  controller.groupId = group.id
  controller.startedAt = 1000
  let agentRuns = [{
    agentRunId: `${controller.runId}:0:codex:agent-1`,
    kind: 'codex',
    status: 'running',
    output: 'Stale output',
  }]
  controller.harness = { snapshot: () => structuredClone(agentRuns) }
  assert.equal(workspace.checkpointRun(group.id, controller, 'running'), true)

  const persist = ledger.persist.bind(ledger)
  let failed = false
  ledger.persist = (runs) => {
    if (!failed) {
      failed = true
      throw new Error('RUN_LEDGER_WRITE_FAILED')
    }
    return persist(runs)
  }
  agentRuns = [{
    ...agentRuns[0],
    status: 'completed',
    output: 'Fresh terminal output',
  }]

  workspace.finishRunCheckpoint(group.id, controller, 'completed')
  assert.equal(ledger.get(controller.runId).status, 'running')
  assert.equal(ledger.get(controller.runId).agentRuns[0].output, 'Stale output')

  workspace.finishRunCheckpoint(group.id, controller, 'completed')
  const finished = ledger.get(controller.runId)
  assert.equal(finished.status, 'completed')
  assert.equal(finished.agentRuns[0].status, 'completed')
  assert.equal(finished.agentRuns[0].output, 'Fresh terminal output')
})

test('a Unicode group identifier preserves native sessions and every runtime path', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const groupId = '历史群聊 1'
  let id = 0
  const checkpoints = []
  const ledgerFinishes = []
  options.createId = () => id++ === 0 ? groupId : `message-${id}`
  options.runLedger = {
    recoverInterrupted: () => [],
    list: () => [],
    checkpoint: record => checkpoints.push(structuredClone(record)),
    finish: (runId, status) => ledgerFinishes.push({ runId, status }),
  }
  const events = []
  const finished = []
  const workspace = new LocalWorkspace(options)
  workspace.on('run-event', event => events.push(event))
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Unicode group', agentKinds: ['codex'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id, text: 'Send through every lifecycle boundary', targetKinds: ['codex'],
  })
  await workspace.sendMessage({
    groupId: group.id, text: 'Reuse the native session', targetKinds: ['codex'],
  })

  const sessionKey = workspace.sessionKey(group.id, 'codex')
  const persisted = JSON.parse(fs.readFileSync(options.storagePath, 'utf8'))
  assert.equal(workspace.sessionKey('group-1', 'codex'), 'group-1:codex')
  assert.match(sessionKey, /^session:[a-f0-9]{64}$/)
  assert.doesNotMatch(sessionKey, /历史群聊/)
  assert.equal(persisted.sessions[sessionKey], 'codex-session')
  assert.deepEqual(calls.map(call => call.runOptions.sessionRef), ['', 'codex-session'])

  const restarted = new LocalWorkspace(options)
  await restarted.refreshAgents()
  await restarted.sendMessage({
    groupId: group.id, text: 'Reuse after restart', targetKinds: ['codex'],
  })

  assert.equal(group.id, groupId)
  assert.equal(checkpoints.length > 0, true)
  assert.equal(checkpoints.every(record => record.groupId === groupId), true)
  assert.deepEqual(ledgerFinishes.map(item => item.status), [
    'completed', 'completed', 'completed',
  ])
  assert.equal(events.length > 0, true)
  assert.equal(events.every(event => event.groupId === groupId), true)
  assert.equal(finished.every(result => result.groupId === groupId), true)
  assert.deepEqual(calls.map(call => call.runOptions.sessionRef), [
    '', 'codex-session', 'codex-session',
  ])
  assert.equal(restarted.snapshot().messages.every(message => message.groupId === groupId), true)
})

test('conversation deletion remains retryable when a corrupt Run Ledger blocks cleanup', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let deleteAttempts = 0
  options.runLedger = {
    recoverInterrupted: () => [],
    deleteGroup: () => {
      deleteAttempts += 1
      if (deleteAttempts === 1) throw new Error('RUN_LEDGER_LOAD_FAILED')
    },
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Ledger cleanup failure', agentKinds: ['codex'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', 'Keep this conversation until cleanup succeeds')
  const beforeDisk = fs.readFileSync(options.storagePath, 'utf8')

  assert.throws(() => workspace.deleteGroup(group.id), { message: 'RUN_LEDGER_LOAD_FAILED' })
  assert.equal(workspace.snapshot().groups.some(item => item.id === group.id), true)
  assert.equal(workspace.snapshot().messages.some(message => message.groupId === group.id), true)
  assert.equal(fs.readFileSync(options.storagePath, 'utf8'), beforeDisk)

  workspace.deleteGroup(group.id)
  assert.equal(workspace.snapshot().groups.some(item => item.id === group.id), false)
  assert.equal(deleteAttempts, 2)
})

test('conversation state rolls back when workspace deletion persistence fails', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const deletedGroups = []
  options.runLedger = {
    recoverInterrupted: () => [],
    deleteGroup: groupId => deletedGroups.push(groupId),
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Workspace cleanup failure', agentKinds: ['codex'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', 'Keep the local state retryable')
  const save = workspace.save.bind(workspace)
  workspace.save = () => { throw new Error('WORKSPACE_SAVE_FAILED') }

  assert.throws(() => workspace.deleteGroup(group.id), { message: 'WORKSPACE_SAVE_FAILED' })
  assert.equal(workspace.snapshot().groups.some(item => item.id === group.id), true)
  assert.equal(workspace.snapshot().messages.some(message => message.groupId === group.id), true)
  assert.deepEqual(deletedGroups, [group.id])

  workspace.save = save
  workspace.deleteGroup(group.id)
  assert.equal(workspace.snapshot().groups.some(item => item.id === group.id), false)
  assert.deepEqual(deletedGroups, [group.id, group.id])
})

test('restart recovery persists the last nonterminal Agent trace as interrupted', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const initial = new LocalWorkspace(options)
  await initial.refreshAgents()
  const group = initial.createGroup({
    name: 'Interrupted recovery', agentKinds: ['codex'], workdir: directory,
  })
  const root = initial.addMessage(group.id, 'user', 'Keep the last useful evidence')
  const recoveredOptions = {
    ...options,
    runLedger: {
      recoverInterrupted: () => [{
        runId: 'run-crashed',
        groupId: group.id,
        threadRootId: root.id,
        targetKinds: ['codex'],
        agentRuns: [{
          agentRunId: 'run-crashed:1:codex:agent-1',
          kind: 'codex',
          round: 1,
          status: 'interrupted',
          sourceMessageIds: [root.id],
          context: { includedCount: 1, omittedCount: 2, charCount: 640 },
          events: [{
            type: 'reasoning_summary', status: 'running',
            summary: 'Located the failing lifecycle boundary.',
          }],
        }],
      }],
    },
  }

  const restored = new LocalWorkspace(recoveredOptions)
  const interrupted = restored.snapshot().messages.find(message => (
    message.system?.key === 'system.agentInterrupted'
  ))

  assert.equal(interrupted.threadRootId, root.id)
  assert.equal(interrupted.trace.status, 'interrupted')
  assert.equal(interrupted.trace.summary, 'Located the failing lifecycle boundary.')
  assert.deepEqual(interrupted.trace.sourceMessageIds, [root.id])
  assert.equal(interrupted.trace.context.omittedCount, 2)
})

test('restart reconciles after recovery message persistence fails and then deduplicates', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const initial = new LocalWorkspace(options)
  await initial.refreshAgents()
  const group = initial.createGroup({
    name: 'Retry interrupted recovery', agentKinds: ['codex'], workdir: directory,
  })
  const root = initial.addMessage(group.id, 'user', 'Recover this once')
  const seeded = new RunLedger({ storagePath: ledgerPath, now: () => 1000 })
  seeded.checkpoint({
    runId: 'run-crashed',
    groupId: group.id,
    threadRootId: root.id,
    targetKinds: ['codex'],
    status: 'running',
    agentRuns: [{
      agentRunId: 'run-crashed:1:codex:agent-1',
      kind: 'codex',
      round: 1,
      status: 'running',
      output: 'Useful partial output',
      sourceMessageIds: [root.id],
    }],
  })

  class FailingRecoveryWorkspace extends LocalWorkspace {
    save() { throw new Error('WORKSPACE_SAVE_FAILED') }
  }
  assert.throws(() => new FailingRecoveryWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath, now: () => 2000 }),
  }), { message: 'WORKSPACE_SAVE_FAILED' })
  assert.equal(
    new RunLedger({ storagePath: ledgerPath }).get('run-crashed').agentRuns[0].status,
    'interrupted',
  )

  const recoveredStartup = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath, now: () => 3000 }),
  })
  const restored = recoveredStartup.snapshot().messages.filter(message => (
    message.trace?.agentRunId === 'run-crashed:1:codex:agent-1'
  ))
  assert.equal(restored.length, 1)
  assert.equal(restored[0].system.key, 'system.agentInterrupted')
  assert.equal(restored[0].trace.status, 'interrupted')

  const repeatedStartup = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath, now: () => 4000 }),
  })
  assert.equal(repeatedStartup.snapshot().messages.filter(message => (
    message.trace?.agentRunId === 'run-crashed:1:codex:agent-1'
  )).length, 1)
})

test('restart reconciliation enriches an existing terminal message with Ledger output once', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const initial = new LocalWorkspace(options)
  await initial.refreshAgents()
  const group = initial.createGroup({
    name: 'Existing terminal recovery', agentKinds: ['codex'], workdir: directory,
  })
  const root = initial.addMessage(group.id, 'user', 'Preserve the streamed conclusion')
  initial.addMessage(
    group.id,
    'system',
    'Codex failed: LOCAL_AGENT_PROCESS_FAILED',
    'codex',
    root.id,
    {
      key: 'system.agentCallFailed',
      params: { agent: 'Codex', reason: 'LOCAL_AGENT_PROCESS_FAILED' },
    },
    {
      trace: {
        runId: 'run-existing-terminal',
        agentRunId: 'run-existing-terminal:0:codex:agent-1',
        round: 0,
        status: 'failed',
      },
    },
  )
  const ledger = new RunLedger({ storagePath: ledgerPath, now: () => 1000 })
  ledger.checkpoint({
    runId: 'run-existing-terminal',
    groupId: group.id,
    threadRootId: root.id,
    targetKinds: ['codex'],
    status: 'failed',
    agentRuns: [{
      agentRunId: 'run-existing-terminal:0:codex:agent-1',
      kind: 'codex',
      round: 0,
      status: 'failed',
      output: 'Conclusion recovered from answer deltas',
      reason: 'LOCAL_AGENT_PROCESS_FAILED',
    }],
  })

  const restored = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath, now: () => 2000 }),
  })
  const matching = restored.snapshot().messages.filter(message => (
    message.trace?.agentRunId === 'run-existing-terminal:0:codex:agent-1'
  ))
  assert.equal(matching.length, 1)
  assert.equal(
    matching[0].content,
    'Codex failed: LOCAL_AGENT_PROCESS_FAILED\nConclusion recovered from answer deltas',
  )

  const repeated = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath, now: () => 3000 }),
  })
  const repeatedMatching = repeated.snapshot().messages.filter(message => (
    message.trace?.agentRunId === 'run-existing-terminal:0:codex:agent-1'
  ))
  assert.equal(repeatedMatching.length, 1)
  assert.equal(
    repeatedMatching[0].content.match(/Conclusion recovered from answer deltas/g)?.length,
    1,
  )
})

test('restart keeps a long failure prefix aligned with its streamed conclusion', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const longReason = `LOCAL_AGENT_PROCESS_FAILED:${'x'.repeat(1200)}`
  const boundedReason = longReason.slice(0, 1000)
  const conclusion = 'Conclusion streamed before the long failure.'
  options.runLedger = new RunLedger({ storagePath: ledgerPath, now: () => 1000 })
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    runOptions.onEvent({ type: 'answer_delta', status: 'running', delta: conclusion })
    throw new Error(longReason)
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Long failure restart', agentKinds: ['codex'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id, text: 'Fail after streaming', targetKinds: ['codex'],
  })

  const persisted = JSON.parse(fs.readFileSync(options.storagePath, 'utf8'))
  const persistedFailure = persisted.messages.find(message => (
    message.system?.key === 'system.agentCallFailed'
  ))
  const persistedPrefix = `Codex failed: ${persistedFailure.system.params.reason}`
  assert.equal(persistedFailure.system.params.reason, boundedReason)
  assert.equal(persistedFailure.content, `${persistedPrefix}\n${conclusion}`)

  const restored = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath, now: () => 2000 }),
  })
  const restoredFailure = restored.snapshot().messages.find(message => (
    message.system?.key === 'system.agentCallFailed'
  ))
  const restoredPrefix = `Codex failed: ${restoredFailure.system.params.reason}`
  assert.equal(restoredFailure.system.params.reason, persistedFailure.system.params.reason)
  assert.equal(restoredFailure.content.startsWith(`${restoredPrefix}\n`), true)
  assert.equal(restoredFailure.content.includes(conclusion), true)
  assert.equal(restoredFailure.content.indexOf(conclusion), restoredFailure.content.lastIndexOf(conclusion))
})

test('maximum Harness conclusion survives terminal persistence and authoritative restart repair', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const conclusion = 'x'.repeat(20000)
  const prefix = 'Codex failed: LOCAL_AGENT_PROCESS_FAILED'
  options.runLedger = new RunLedger({ storagePath: ledgerPath, now: () => 1000 })
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    for (let offset = 0; offset < conclusion.length; offset += 4000) {
      runOptions.onEvent({
        type: 'answer_delta', status: 'running', delta: conclusion.slice(offset, offset + 4000),
      })
    }
    throw new Error('LOCAL_AGENT_PROCESS_FAILED')
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Maximum terminal conclusion', agentKinds: ['codex'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id, text: 'Stream the maximum output', targetKinds: ['codex'],
  })

  const liveFailure = workspace.snapshot().messages.find(message => (
    message.system?.key === 'system.agentCallFailed'
  ))
  assert.equal(liveFailure.content, `${prefix}\n${conclusion}`)
  const persisted = JSON.parse(fs.readFileSync(options.storagePath, 'utf8'))
  const persistedFailure = persisted.messages.find(message => message.id === liveFailure.id)
  assert.equal(persistedFailure.content, liveFailure.content)

  persistedFailure.content = `${prefix}\n${conclusion.slice(0, 250)}`
  fs.writeFileSync(options.storagePath, `${JSON.stringify(persisted, null, 2)}\n`)

  const restored = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath, now: () => 2000 }),
  })
  const restoredFailure = restored.snapshot().messages.find(message => (
    message.trace?.agentRunId === liveFailure.trace.agentRunId
  ))
  assert.equal(restoredFailure.content, `${prefix}\n${conclusion}`)
  const repaired = JSON.parse(fs.readFileSync(options.storagePath, 'utf8'))
  assert.equal(
    repaired.messages.find(message => message.id === liveFailure.id).content,
    restoredFailure.content,
  )

  const repeated = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath, now: () => 3000 }),
  })
  assert.equal(
    repeated.snapshot().messages.find(message => message.id === liveFailure.id).content,
    `${prefix}\n${conclusion}`,
  )
})

test('restart reconciles every terminal Agent checkpoint with its real status and output', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const initial = new LocalWorkspace(options)
  await initial.refreshAgents()
  const group = initial.createGroup({
    name: 'Terminal checkpoint recovery', agentKinds: ['codex'], workdir: directory,
  })
  const root = initial.addMessage(group.id, 'user', 'Restore terminal attempts')
  const ledger = new RunLedger({ storagePath: ledgerPath, now: () => 1000 })
  ledger.checkpoint({
    runId: 'run-terminal',
    groupId: group.id,
    threadRootId: root.id,
    targetKinds: ['codex'],
    status: 'completed',
    agentRuns: [
      { agentRunId: 'agent-completed', kind: 'codex', status: 'completed', output: 'Completed output' },
      { agentRunId: 'agent-partial', kind: 'codex', status: 'partial', output: 'Partial output' },
      { agentRunId: 'agent-failed', kind: 'codex', status: 'failed', output: 'Failure output', reason: 'LOCAL_AGENT_UNKNOWN_FAILURE' },
      { agentRunId: 'agent-failed-other-output', kind: 'codex', status: 'failed', output: 'Distinct failure output', reason: 'LOCAL_AGENT_UNKNOWN_FAILURE' },
      { agentRunId: 'agent-failed-other-reason', kind: 'codex', status: 'failed', reason: 'LOCAL_AGENT_AUTH_FAILED' },
      { agentRunId: 'agent-timeout', kind: 'codex', status: 'timeout', output: 'Timeout output', reason: 'LOCAL_AGENT_TIMEOUT' },
      { agentRunId: 'agent-stopped', kind: 'codex', status: 'stopped', output: 'Stopped output' },
      { agentRunId: 'agent-interrupted', kind: 'codex', status: 'interrupted', output: 'Interrupted output' },
    ],
  })

  const restored = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath, now: () => 2000 }),
  })
  const byAgentRunId = new Map(restored.snapshot().messages
    .filter(message => message.trace?.agentRunId)
    .map(message => [message.trace.agentRunId, message]))

  assert.equal(byAgentRunId.get('agent-completed').role, 'agent')
  assert.equal(byAgentRunId.get('agent-completed').content, 'Completed output')
  assert.equal(byAgentRunId.get('agent-completed').trace.status, 'completed')
  assert.equal(byAgentRunId.get('agent-partial').role, 'agent')
  assert.equal(byAgentRunId.get('agent-partial').content, 'Partial output')
  assert.equal(byAgentRunId.get('agent-partial').trace.status, 'partial')
  assert.equal(byAgentRunId.get('agent-failed').system.key, 'system.agentCallFailed')
  assert.match(byAgentRunId.get('agent-failed').content, /Failure output/)
  assert.equal(byAgentRunId.get('agent-failed').trace.status, 'failed')
  assert.match(byAgentRunId.get('agent-failed-other-output').content, /Distinct failure output/)
  assert.equal(
    byAgentRunId.get('agent-failed-other-reason').system.params.reason,
    'LOCAL_AGENT_AUTH_FAILED',
  )
  assert.equal(byAgentRunId.get('agent-timeout').system.params.reason, 'LOCAL_AGENT_TIMEOUT')
  assert.match(byAgentRunId.get('agent-timeout').content, /Timeout output/)
  assert.equal(byAgentRunId.get('agent-timeout').trace.status, 'timeout')
  assert.equal(byAgentRunId.get('agent-stopped').system.key, 'system.agentStopped')
  assert.equal(byAgentRunId.get('agent-stopped').trace.status, 'stopped')
  assert.equal(byAgentRunId.get('agent-interrupted').system.key, 'system.agentInterrupted')
  assert.equal(byAgentRunId.get('agent-interrupted').trace.status, 'interrupted')

  const repeated = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath, now: () => 3000 }),
  })
  assert.equal(repeated.snapshot().messages.filter(message => (
    message.trace?.runId === 'run-terminal'
  )).length, 8)
})

test('stopping during output capture prevents the Agent from launching', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const captureEntered = deferred()
  const captureGate = deferred()
  options.runAbortGraceMs = 20
  let captureSignal
  options.captureAgentOutputs = async (_workdir, captureOptions) => {
    captureSignal = captureOptions.signal
    captureEntered.resolve()
    return await captureGate.promise
  }
  const finished = []
  const workspace = new LocalWorkspace(options)
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Stop during capture', agentKinds: ['codex'], workdir: directory,
  })

  const send = workspace.sendMessage({ groupId: group.id, text: 'Generate a file' })
  await captureEntered.promise
  const runId = workspace.activeRuns.get(group.id).runId
  assert.equal(workspace.stop(group.id, runId), true)
  await send

  assert.equal(captureSignal.aborted, true)
  assert.equal(calls.length, 0)
  assert.equal(finished[0].status, 'stopped')
  assert.equal(workspace.snapshot().messages.some(message => message.role === 'agent'), false)
  const stoppedTrace = workspace.snapshot().messages.find(message => (
    message.system?.key === 'system.agentStopped' && message.agentKind === 'codex'
  ))
  assert.equal(stoppedTrace.trace.status, 'stopped')
  assert.equal(stoppedTrace.trace.agentRunId.includes(runId), true)
  captureGate.resolve({ marker: 'late capture' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(workspace.snapshot().messages.some(message => message.role === 'agent'), false)
})

test('stopping during output import never persists the late completed reply', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const importEntered = deferred()
  const importGate = deferred()
  options.runAbortGraceMs = 20
  let importSignal
  options.importAgentOutputs = async (input) => {
    importSignal = input.signal
    importEntered.resolve()
    return await importGate.promise
  }
  const finished = []
  const workspace = new LocalWorkspace(options)
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Stop during import', agentKinds: ['codex'], workdir: directory,
  })

  const send = workspace.sendMessage({ groupId: group.id, text: 'Generate a file' })
  await importEntered.promise
  const runId = workspace.activeRuns.get(group.id).runId
  assert.equal(workspace.stop(group.id, runId), true)
  await send

  assert.equal(importSignal.aborted, true)
  assert.equal(finished[0].status, 'stopped')
  assert.equal(workspace.snapshot().messages.some(message => message.role === 'agent'), false)
  importGate.resolve([
    { id: 'late-image', name: 'late.png', mimeType: 'image/png', size: 10 },
  ])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(workspace.snapshot().messages.some(message => message.role === 'agent'), false)
})

test('a stopped run keeps the group lock until the Agent cleanup settles', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAbortGraceMs = 100
  const firstStarted = deferred()
  let attempts = 0
  let cleanupFinished = false
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    attempts += 1
    if (attempts > 1) return { text: 'Second run', sessionRef: 'codex-session-2' }
    return await new Promise((resolve, reject) => {
      runOptions.signal.addEventListener('abort', () => {
        setTimeout(() => {
          cleanupFinished = true
          reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED'))
        }, 30)
      }, { once: true })
      firstStarted.resolve()
    })
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Cleanup lock', agentKinds: ['codex'], workdir: directory,
  })

  const firstSend = workspace.sendMessage({ groupId: group.id, text: 'First run' })
  await firstStarted.promise
  const runId = workspace.activeRuns.get(group.id).runId
  assert.equal(workspace.stop(group.id, runId), true)
  await assert.rejects(
    workspace.sendMessage({ groupId: group.id, text: 'Too early' }),
    { message: 'LOCAL_GROUP_RUNNING' },
  )
  await firstSend

  assert.equal(cleanupFinished, true)
  await workspace.sendMessage({ groupId: group.id, text: 'Second run' })
  assert.equal(workspace.snapshot().messages.at(-1).content, 'Second run')
})

test('a stop acknowledgement keeps deletion blocked until run cleanup settles', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const started = deferred()
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => await new Promise((resolve, reject) => {
    started.resolve()
    runOptions.signal.addEventListener('abort', () => {
      setImmediate(() => reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED')))
    }, { once: true })
  })
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Stop then delete', agentKinds: ['codex'], workdir: directory,
  })

  const send = workspace.sendMessage({ groupId: group.id, text: 'Stop this run' })
  await started.promise
  const runId = workspace.activeRuns.get(group.id).runId
  assert.equal(workspace.stop(group.id, runId), true)
  assert.throws(() => workspace.deleteGroup(group.id), { message: 'LOCAL_GROUP_RUNNING' })

  await send
  assert.doesNotThrow(() => workspace.deleteGroup(group.id))
  assert.equal(workspace.snapshot().groups.some(item => item.id === group.id), false)
})

test('a stopped run keeps the group lock until output import cleanup settles', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAbortGraceMs = 100
  const importStarted = deferred()
  let attempts = 0
  let importCleanupFinished = false
  options.importAgentOutputs = async (input) => {
    attempts += 1
    if (attempts > 1) return []
    return await new Promise((resolve) => {
      input.signal.addEventListener('abort', () => {
        setTimeout(() => {
          importCleanupFinished = true
          resolve([])
        }, 30)
      }, { once: true })
      importStarted.resolve()
    })
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Import cleanup lock', agentKinds: ['codex'], workdir: directory,
  })

  const firstSend = workspace.sendMessage({ groupId: group.id, text: 'First import' })
  await importStarted.promise
  const runId = workspace.activeRuns.get(group.id).runId
  assert.equal(workspace.stop(group.id, runId), true)
  await assert.rejects(
    workspace.sendMessage({ groupId: group.id, text: 'Too early' }),
    { message: 'LOCAL_GROUP_RUNNING' },
  )
  await firstSend

  assert.equal(importCleanupFinished, true)
  await workspace.sendMessage({ groupId: group.id, text: 'After cleanup' })
  assert.equal(workspace.snapshot().messages.some(message => (
    message.role === 'user' && message.content === 'After cleanup'
  )), true)
})

test('the Agent watchdog covers output capture and import phases', async (t) => {
  const phases = ['capture', 'import']
  for (const phase of phases) {
    await t.test(phase, async (subtest) => {
      const { directory, calls, options } = fixture()
      subtest.after(() => fs.rmSync(directory, { recursive: true, force: true }))
      options.runAgentTimeoutMs = 8
      options.runAbortGraceMs = 20
      if (phase === 'capture') options.captureAgentOutputs = async () => await new Promise(() => {})
      else options.importAgentOutputs = async () => await new Promise(() => {})
      const finished = []
      const workspace = new LocalWorkspace(options)
      workspace.on('run-finished', result => finished.push(result))
      await workspace.refreshAgents()
      const group = workspace.createGroup({
        name: `Watchdog ${phase}`, agentKinds: ['codex'], workdir: directory,
      })

      await workspace.sendMessage({ groupId: group.id, text: 'Do not hang' })

      assert.equal(calls.length, phase === 'capture' ? 0 : 1)
      assert.equal(finished[0].status, 'timeout')
      const failure = workspace.snapshot().messages.find(message => (
        message.system?.key === 'system.agentCallFailed'
      ))
      assert.equal(failure.system.params.reason, 'LOCAL_AGENT_TIMEOUT')
      assert.equal(failure.trace.status, 'timeout')
      assert.equal(workspace.snapshot().messages.some(message => message.role === 'agent'), false)
    })
  }
})

test('session references stay opaque and OpenClaw group scopes do not collide', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const privateSessionRef = '/Users/private/token=secret'
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    runOptions.onSessionRef(privateSessionRef)
    return { text: 'Safe reply', sessionRef: privateSessionRef }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Opaque sessions', agentKinds: ['codex'], workdir: directory,
  })

  await workspace.sendMessage({ groupId: group.id, text: 'Keep the session private' })

  assert.equal(workspace.state.sessions[workspace.sessionKey(group.id, 'codex')], undefined)
  assert.doesNotMatch(fs.readFileSync(options.storagePath, 'utf8'), /Users\/private|token=secret/)
  assert.equal(workspace.persistSessionRef(
    workspace.sessionKey(group.id, 'codex'),
    'sk-abcdefghijklmnop1234',
  ), false)
  const first = workspace.openClawSessionRef({ id: 'group-abcdefghijkl-1' })
  const second = workspace.openClawSessionRef({ id: 'group-abcdefghijkl-2' })
  assert.notEqual(first, second)
  assert.match(first, /^agent:main:desktop-roundrelay-[a-f0-9]{20}-openclaw$/)
  assert.match(second, /^agent:main:desktop-roundrelay-[a-f0-9]{20}-openclaw$/)

  const legacyGroup = { id: 'group-abcdefghijkl-1' }
  const legacyKey = workspace.sessionKey(legacyGroup.id, 'openclaw')
  workspace.state.sessions[legacyKey] = 'agent:main:desktop-roundrelay-groupabcdefg-openclaw'
  workspace.state.sessionMeta[legacyKey] = { turns: 4, estimatedChars: 1200 }
  assert.equal(workspace.sessionRef(legacyGroup, 'openclaw'), first)
  assert.equal(workspace.state.sessionMeta[legacyKey], undefined)
})
