const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')

const AGENT_LABELS = {
  codex: 'Codex',
  hermes: 'Hermes',
  openclaw: 'OpenClaw',
  workbuddy: 'WorkBuddy',
  kimi: 'Kimi',
  claude: 'Claude',
  qwen: 'Qwen',
  gemini: 'Gemini',
  opencode: 'OpenCode',
}

function emptyState() {
  return {
    version: 1,
    groups: [],
    messages: [],
    sessions: {},
    agentPreferences: {},
    agentRuntime: {},
  }
}

function credentialFailure(error) {
  return /api[ _-]?key|credential|auth(?:entication|orization)?|login|log in|unauthorized|forbidden|401|403|令牌|凭据|登录|认证/i
    .test(String(error?.message || error || ''))
}

function cleanText(value, limit = 20000) {
  return String(value || '').trim().slice(0, limit)
}

function cleanInline(value, limit = 80) {
  return cleanText(value, limit).replace(/[\n\r\[\]`]/g, ' ').replace(/\s+/g, ' ')
}

function normalizeSystemParams(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const params = {}
  for (const [rawKey, rawValue] of Object.entries(input).slice(0, 12)) {
    const key = cleanInline(rawKey, 60)
    if (!key) continue
    if (typeof rawValue === 'string') params[key] = cleanText(rawValue, 1000)
    else if (typeof rawValue === 'boolean') params[key] = rawValue
    else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) params[key] = rawValue
  }
  return params
}

function normalizeLoadedGroup(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const id = cleanText(input.id, 100)
  const agentKinds = [...new Set((Array.isArray(input.agentKinds) ? input.agentKinds : [])
    .map(kind => cleanInline(kind, 40))
    .filter(kind => Object.hasOwn(AGENT_LABELS, kind)))]
  if (!id || !agentKinds.length) return null

  const group = {
    id,
    name: cleanText(input.name, 60),
    topic: cleanText(input.topic, 200),
    agentKinds,
    workdir: path.resolve(cleanText(input.workdir, 1000) || process.cwd()),
    allowWrite: input.allowWrite === true,
    createdAt: cleanText(input.createdAt, 80),
    updatedAt: cleanText(input.updatedAt, 80),
  }
  if (input.conversationType === 'direct') {
    const directAgentKind = Object.hasOwn(AGENT_LABELS, cleanInline(input.directAgentKind, 40))
      ? cleanInline(input.directAgentKind, 40)
      : agentKinds[0]
    group.conversationType = 'direct'
    group.directAgentKind = directAgentKind
    group.agentKinds = [directAgentKind]
  }
  return group
}

function normalizeLoadedMessage(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const id = cleanText(input.id, 100)
  const groupId = cleanText(input.groupId, 100)
  const role = ['user', 'agent', 'system'].includes(input.role) ? input.role : ''
  const requestedAgentKind = cleanInline(input.agentKind, 40)
  const agentKind = Object.hasOwn(AGENT_LABELS, requestedAgentKind) ? requestedAgentKind : ''
  if (!id || !groupId || !role || (role === 'agent' && !agentKind)) return null

  const message = {
    id,
    groupId,
    role,
    agentKind,
    senderName: role === 'user' ? 'User' : (role === 'agent' ? AGENT_LABELS[agentKind] : 'System'),
    content: cleanText(input.content),
    createdAt: cleanText(input.createdAt, 80),
  }
  const threadRootId = cleanText(input.threadRootId, 100)
  if (threadRootId) message.threadRootId = threadRootId
  const systemKey = role === 'system' ? cleanInline(input.system?.key, 100) : ''
  if (systemKey) {
    message.system = {
      key: systemKey,
      params: normalizeSystemParams(input.system?.params),
    }
  }
  return message
}

class LocalWorkspace extends EventEmitter {
  constructor(options) {
    super()
    this.storagePath = options.storagePath
    this.detectAgentsFn = options.detectAgents
    this.runAgentFn = options.runAgent
    this.credentialStateFn = options.credentialState || (async () => ({ state: 'unknown', source: 'unverified' }))
    this.sharedProviderReadyFn = options.sharedProviderReady || (() => false)
    this.now = options.now || (() => new Date().toISOString())
    this.createId = options.createId || randomUUID
    this.detectedAgents = []
    this.activeRuns = new Map()
    this.state = this.load()
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.storagePath, 'utf8'))
      if (parsed?.version !== 1 || !Array.isArray(parsed.groups)
          || !Array.isArray(parsed.messages) || typeof parsed.sessions !== 'object') {
        return emptyState()
      }
      const groups = parsed.groups.map(normalizeLoadedGroup).filter(Boolean)
      const groupIds = new Set(groups.map(group => group.id))
      const messages = parsed.messages
        .map(normalizeLoadedMessage)
        .filter(message => message && groupIds.has(message.groupId))
      return {
        version: 1,
        groups,
        messages,
        sessions: parsed.sessions && typeof parsed.sessions === 'object' && !Array.isArray(parsed.sessions)
          ? { ...parsed.sessions }
          : {},
        agentPreferences: parsed.agentPreferences
          && typeof parsed.agentPreferences === 'object' && !Array.isArray(parsed.agentPreferences)
          ? { ...parsed.agentPreferences }
          : {},
        agentRuntime: parsed.agentRuntime
          && typeof parsed.agentRuntime === 'object' && !Array.isArray(parsed.agentRuntime)
          ? { ...parsed.agentRuntime }
          : {},
      }
    } catch {
      return emptyState()
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.storagePath), { recursive: true })
    const tempPath = `${this.storagePath}.tmp`
    fs.writeFileSync(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(tempPath, this.storagePath)
  }

  snapshot() {
    return {
      agents: this.detectedAgents.map(({ executable, ...agent }) => agent),
      groups: this.state.groups,
      messages: this.state.messages,
      runningGroupIds: [...this.activeRuns.keys()],
      runs: [...this.activeRuns.entries()].map(([groupId, run]) => ({
        groupId,
        mode: run.mode || 'manual',
        targetKinds: run.targetKinds || [],
        completedKinds: run.completedKinds || [],
        currentKind: run.currentKind || '',
        threadRootId: run.threadRootId || '',
        startedAt: run.startedAt || Date.now(),
      })),
    }
  }

  emitChanged() {
    this.emit('changed', this.snapshot())
  }

  async refreshAgents() {
    const detected = await this.detectAgentsFn()
    const nativeStates = await Promise.all(detected.map(
      agent => this.credentialStateFn(agent.kind, agent),
    ))
    this.detectedAgents = detected.map((agent, index) => {
      const native = nativeStates[index]
      const runtime = this.state.agentRuntime[agent.kind]
      const sharedProviderReady = Boolean(this.sharedProviderReadyFn(agent.kind))
      const nativeState = ['ready', 'missing'].includes(native?.state) ? native.state : 'unknown'
      const sharedProviderRequired = native?.source === 'shared-provider-required'
      const runtimeMissing = runtime?.credentialState === 'missing'
      const verifiedReady = runtime?.credentialState === 'ready'
        || this.state.messages.some(message => message.role === 'agent' && message.agentKind === agent.kind)
      const credentialState = sharedProviderReady
        ? 'ready'
        : sharedProviderRequired
          ? 'missing'
          : runtimeMissing
            ? 'missing'
            : nativeState === 'missing'
              ? 'missing'
              : nativeState === 'ready'
                ? 'ready'
                : verifiedReady
                  ? 'ready'
                  : 'unknown'
      const available = credentialState === 'ready'
      const preferred = this.state.agentPreferences[agent.kind]?.showInSidebar
      return {
        ...agent,
        installed: true,
        credentialState,
        availabilitySource: sharedProviderReady
          ? 'shared-provider'
          : runtimeMissing
              ? 'runtime-auth-failure'
            : nativeState === 'missing'
              ? (native.source || 'none')
              : nativeState === 'ready'
                ? (native.source || 'native-credential')
                : verifiedReady
                  ? 'verified-run'
                  : 'unverified',
        available,
        showInSidebar: available && (typeof preferred === 'boolean' ? preferred : true),
      }
    })
    this.emitChanged()
    return this.snapshot()
  }

  setSidebarVisibility(kind, visible) {
    const agent = this.detectedAgents.find(item => item.kind === kind)
    if (!agent) throw new Error('LOCAL_AGENT_NOT_INSTALLED')
    if (visible && !agent.available) throw new Error('LOCAL_AGENT_UNAVAILABLE')
    this.state.agentPreferences[kind] = { showInSidebar: Boolean(visible) }
    agent.showInSidebar = agent.available && Boolean(visible)
    this.save()
    this.emitChanged()
    return this.snapshot()
  }

  markRuntimeCredential(kind, credentialState) {
    this.state.agentRuntime[kind] = {
      credentialState,
      checkedAt: this.now(),
    }
    const agent = this.detectedAgents.find(item => item.kind === kind)
    if (agent) {
      agent.credentialState = credentialState
      agent.available = credentialState !== 'missing'
      agent.availabilitySource = credentialState === 'ready'
        ? 'verified-run'
        : 'runtime-auth-failure'
      const preferred = this.state.agentPreferences[kind]?.showInSidebar
      agent.showInSidebar = agent.available && (typeof preferred === 'boolean' ? preferred : true)
    }
    this.save()
    this.emitChanged()
  }

  clearRuntimeCredentialFailures() {
    let changed = false
    for (const [kind, runtime] of Object.entries(this.state.agentRuntime)) {
      if (runtime?.credentialState !== 'missing') continue
      delete this.state.agentRuntime[kind]
      changed = true
    }
    if (changed) this.save()
    return changed
  }

  createGroup(input) {
    const available = new Set(this.detectedAgents.filter(agent => agent.available).map(agent => agent.kind))
    const conversationType = input.conversationType === 'direct' ? 'direct' : 'group'
    const directAgentKind = conversationType === 'direct'
      ? cleanInline(input.directAgentKind, 40)
      : ''
    const requestedKinds = conversationType === 'direct' ? [directAgentKind] : (input.agentKinds || [])
    const agentKinds = [...new Set(requestedKinds.filter(kind => available.has(kind)))]
    if (!agentKinds.length) throw new Error('LOCAL_GROUP_AGENT_REQUIRED')
    const name = cleanText(input.name, 60)
      || (conversationType === 'direct' ? (AGENT_LABELS[directAgentKind] || directAgentKind) : '')
    const workdir = path.resolve(cleanText(input.workdir, 1000) || process.cwd())
    const timestamp = this.now()
    const group = {
      id: this.createId(),
      name,
      topic: cleanText(input.topic, 200),
      agentKinds,
      workdir,
      allowWrite: input.allowWrite === true,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    if (conversationType === 'direct') {
      group.conversationType = 'direct'
      group.directAgentKind = directAgentKind
    }
    this.state.groups.unshift(group)
    this.save()
    this.emitChanged()
    return group
  }

  updateGroup(groupId, input) {
    const group = this.getGroup(groupId)
    if (input.name != null) group.name = cleanText(input.name, 60) || group.name
    if (input.topic != null) group.topic = cleanText(input.topic, 200)
    if (input.workdir != null) group.workdir = path.resolve(cleanText(input.workdir, 1000))
    if (input.allowWrite != null) group.allowWrite = input.allowWrite === true
    if (input.agentKinds != null) {
      const available = new Set(this.detectedAgents.filter(agent => agent.available).map(agent => agent.kind))
      const kinds = [...new Set(input.agentKinds.filter(kind => available.has(kind)))]
      if (!kinds.length) throw new Error('LOCAL_GROUP_AGENT_REQUIRED')
      group.agentKinds = kinds
    }
    if (group.conversationType === 'direct') group.agentKinds = [group.directAgentKind]
    group.updatedAt = this.now()
    this.save()
    this.emitChanged()
    return group
  }

  deleteGroup(groupId) {
    if (this.activeRuns.has(groupId)) throw new Error('LOCAL_GROUP_RUNNING')
    const before = this.state.groups.length
    this.state.groups = this.state.groups.filter(group => group.id !== groupId)
    if (before === this.state.groups.length) throw new Error('LOCAL_GROUP_NOT_FOUND')
    this.state.messages = this.state.messages.filter(message => message.groupId !== groupId)
    for (const key of Object.keys(this.state.sessions)) {
      if (key.startsWith(`${groupId}:`)) delete this.state.sessions[key]
    }
    this.save()
    this.emitChanged()
  }

  getGroup(groupId) {
    const group = this.state.groups.find(item => item.id === groupId)
    if (!group) throw new Error('LOCAL_GROUP_NOT_FOUND')
    return group
  }

  addMessage(groupId, role, content, agentKind = '', threadRootId = '', system = null) {
    const message = {
      id: this.createId(),
      groupId,
      role,
      agentKind,
      senderName: role === 'user' ? 'User' : (AGENT_LABELS[agentKind] || 'System'),
      content: cleanText(content),
      createdAt: this.now(),
    }
    if (threadRootId) message.threadRootId = threadRootId
    if (role === 'system' && system?.key) {
      message.system = {
        key: cleanInline(system.key, 100),
        params: system.params && typeof system.params === 'object' ? system.params : {},
      }
    }
    this.state.messages.push(message)
    const group = this.getGroup(groupId)
    group.updatedAt = message.createdAt
    this.save()
    this.emitChanged()
    return message
  }

  sessionKey(groupId, kind, threadRootId = '') {
    const root = cleanText(threadRootId, 100)
    return root ? `${groupId}:${kind}:thread:${root}` : `${groupId}:${kind}`
  }

  sessionRef(group, kind, threadRootId = '') {
    const key = this.sessionKey(group.id, kind, threadRootId)
    let stored = String(this.state.sessions[key] || '')
    if (kind === 'hermes' && /^roundrelay-[a-zA-Z0-9]+-hermes$/.test(stored)) {
      delete this.state.sessions[key]
      this.save()
      stored = ''
    }
    if (kind === 'openclaw' && stored && !stored.startsWith('agent:main:desktop-')) {
      delete this.state.sessions[key]
      this.save()
      stored = ''
    }
    if (!stored && kind === 'openclaw') {
      const groupScope = group.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)
      const threadScope = threadRootId
        ? `-${createHash('sha256').update(String(threadRootId)).digest('hex').slice(0, 12)}`
        : ''
      const stableId = `roundrelay-${groupScope}${threadScope}-${kind}`
      this.state.sessions[key] = `agent:main:desktop-${stableId}`
      this.save()
      stored = this.state.sessions[key]
    }
    return stored
  }

  recentTranscript(groupId, threadRootId = '') {
    const root = cleanText(threadRootId, 100)
    return this.state.messages
      .filter(message => message.groupId === groupId && (
        root
          ? String(message.id) === root || String(message.threadRootId || '') === root
          : !message.threadRootId
      ))
      .slice(-16)
      .map(message => `${message.senderName}: ${message.content}`)
      .join('\n')
      .slice(-12000)
  }

  promptFor(group, kind, mode, threadRootId = '') {
    const label = AGENT_LABELS[kind] || kind
    const instruction = mode === 'auto'
      ? 'Read the most recent messages, respond directly to the previous participant, and advance the discussion. Do not speak for other Agents.'
      : 'Respond directly to the user and account for the other participants\' views. Do not speak for other Agents.'
    return [
      `You are participating in the local "${group.name || 'RoundRelay group'}" conversation as ${label}. Reply in the language used by the user unless they request another language.`,
      instruction,
      'Recent conversation:',
      this.recentTranscript(group.id, threadRootId),
    ].filter(Boolean).join('\n')
  }

  async invokeAgent(group, kind, mode, signal, threadRootId = '') {
    const agent = this.detectedAgents.find(item => item.kind === kind && item.available)
    if (!agent) throw new Error('LOCAL_AGENT_UNAVAILABLE')
    const key = this.sessionKey(group.id, kind, threadRootId)
    let result
    try {
      result = await this.runAgentFn(
        agent,
        this.promptFor(group, kind, mode, threadRootId),
        group.workdir,
        {
          sessionRef: this.sessionRef(group, kind, threadRootId),
          signal,
          sandbox: group.allowWrite ? 'workspace-write' : undefined,
        },
      )
      this.markRuntimeCredential(kind, 'ready')
    } catch (error) {
      if (credentialFailure(error)) this.markRuntimeCredential(kind, 'missing')
      throw error
    }
    if (result.sessionRef && result.sessionRef !== this.state.sessions[key]) {
      this.state.sessions[key] = result.sessionRef
      this.save()
    }
    return this.addMessage(group.id, 'agent', result.text, kind, threadRootId)
  }

  async sendMessage(input) {
    const group = this.getGroup(input.groupId)
    if (this.activeRuns.has(group.id)) throw new Error('LOCAL_GROUP_RUNNING')
    const text = cleanText(input.text)
    if (!text) throw new Error('LOCAL_MESSAGE_REQUIRED')
    const requested = input.targetKinds?.length ? input.targetKinds : group.agentKinds
    const targetKinds = [...new Set(requested.filter(kind => group.agentKinds.includes(kind)))]
    if (!targetKinds.length) throw new Error('LOCAL_MESSAGE_TARGET_REQUIRED')
    const inputThreadRootId = cleanText(input.threadRootId, 100)
    const userMessage = this.addMessage(group.id, 'user', text, '', inputThreadRootId)
    const threadRootId = inputThreadRootId
      || (group.agentKinds.length > 1 ? userMessage.id : '')
    const controller = new AbortController()
    controller.mode = 'manual'
    controller.targetKinds = targetKinds
    controller.completedKinds = []
    controller.currentKind = ''
    controller.threadRootId = threadRootId
    controller.startedAt = Date.now()
    this.activeRuns.set(group.id, controller)
    this.emitChanged()
    const promise = (async () => {
      try {
        const failures = []
        let successCount = 0
        for (const kind of targetKinds) {
          controller.currentKind = kind
          this.emitChanged()
          try {
            await this.invokeAgent(group, kind, 'manual', controller.signal, threadRootId)
            successCount += 1
          } catch (error) {
            const label = AGENT_LABELS[kind] || kind
            const reason = cleanText(error?.message || error, 2000) || 'LOCAL_AGENT_UNKNOWN_FAILURE'
            failures.push(`${label}: ${reason}`)
            this.addMessage(
              group.id,
              'system',
              `${label} failed: ${reason}`,
              kind,
              threadRootId,
              { key: 'system.agentCallFailed', params: { agent: label, reason } },
            )
          }
          controller.completedKinds.push(kind)
          controller.currentKind = ''
          this.emitChanged()
        }
        if (!successCount) {
          const error = new Error('LOCAL_AGENT_ALL_CALLS_FAILED')
          error.failures = failures
          throw error
        }
        return this.snapshot()
      } finally {
        this.activeRuns.delete(group.id)
        this.emitChanged()
      }
    })()
    controller.promise = promise
    return await promise
  }

  startAuto(input) {
    const group = this.getGroup(input.groupId)
    if (this.activeRuns.has(group.id)) throw new Error('LOCAL_GROUP_RUNNING')
    if (group.agentKinds.length < 2) throw new Error('LOCAL_AUTO_AGENT_COUNT')
    const maxTurns = Math.max(2, Math.min(12, Number(input.maxTurns) || 4))
    const latestRoot = this.state.messages.findLast(message => (
      message.groupId === group.id && message.role === 'user' && !message.threadRootId
    ))
    const threadRootId = cleanText(input.threadRootId, 100) || latestRoot?.id || ''
    if (!threadRootId) throw new Error('LOCAL_AUTO_THREAD_REQUIRED')
    const controller = new AbortController()
    controller.mode = 'auto'
    controller.targetKinds = group.agentKinds
    controller.completedKinds = []
    controller.currentKind = ''
    controller.threadRootId = threadRootId
    controller.startedAt = Date.now()
    this.activeRuns.set(group.id, controller)
    this.emitChanged()
    const promise = (async () => {
      try {
        for (let index = 0; index < maxTurns && !controller.signal.aborted; index += 1) {
          const kind = group.agentKinds[index % group.agentKinds.length]
          controller.currentKind = kind
          this.emitChanged()
          await this.invokeAgent(group, kind, 'auto', controller.signal, threadRootId)
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          const reason = cleanText(error?.message || error, 2000) || 'LOCAL_AGENT_UNKNOWN_FAILURE'
          this.addMessage(
            group.id,
            'system',
            `Automatic discussion stopped: ${reason}`,
            '',
            threadRootId,
            { key: 'system.autoStopped', params: { reason } },
          )
        }
      } finally {
        this.activeRuns.delete(group.id)
        this.emitChanged()
      }
    })()
    controller.promise = promise
    return { started: true, maxTurns }
  }

  stop(groupId) {
    const controller = this.activeRuns.get(groupId)
    if (!controller) return false
    controller.abort()
    return true
  }

  async stopAll() {
    const pending = []
    for (const controller of this.activeRuns.values()) {
      controller.abort()
      if (controller.promise) pending.push(controller.promise)
    }
    await Promise.allSettled(pending)
  }
}

module.exports = { LocalWorkspace, emptyState }
