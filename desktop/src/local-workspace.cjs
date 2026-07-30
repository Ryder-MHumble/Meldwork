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
const AUTO_CONSENSUS_MARKER = /\[\[ROUNDRELAY_CONSENSUS:(agree|continue)\]\]/gi
const AUTO_FINAL_CONSENSUS_MARKER = /(?:^|\r?\n)[ \t]*\[\[ROUNDRELAY_CONSENSUS:(agree|continue)\]\][ \t]*$/i
const DEFAULT_AUTO_RUN_TIMEOUT_MS = 30 * 60 * 1000
const MAX_MESSAGE_ATTACHMENTS = 4
const MAX_SKILL_HINTS = 4
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
const ATTACHMENT_MIME_TYPES = new Set(['image/png', 'image/jpeg'])
const ATTACHMENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const RUN_STATUSES = new Set([
  'completed', 'partial', 'failed', 'stopped', 'timeout', 'round-limit',
])
const PROGRESS_TITLES = new Set(['process', 'write_file'])

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

function cleanProgressSteps(value) {
  return (Array.isArray(value) ? value : []).slice(-8).map((step) => {
    const requestedTitle = cleanInline(step?.title, 80).toLowerCase()
    return {
      title: PROGRESS_TITLES.has(requestedTitle) ? requestedTitle : 'process',
      status: ['completed', 'failed', 'in_progress'].includes(step?.status)
        ? step.status
        : 'completed',
    }
  })
}

function cleanElapsedMs(value) {
  return Number.isFinite(value) && value >= 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.round(value))
    : null
}

function parseAutoReply(value) {
  const raw = String(value || '').trim()
  const finalMarker = raw.match(AUTO_FINAL_CONSENSUS_MARKER)
  const markerCount = raw.match(AUTO_CONSENSUS_MARKER)?.length || 0
  const text = raw.replace(AUTO_CONSENSUS_MARKER, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const consensus = markerCount === 1
    && finalMarker?.[1].toLowerCase() === 'agree'
  return { text, consensus }
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

function normalizeAttachmentMetadata(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const id = String(input.id || '')
  const name = cleanInline(input.name, 160)
  const mimeType = String(input.mimeType || '').toLowerCase()
  const size = Number(input.size)
  if (!ATTACHMENT_ID.test(id) || !name || !ATTACHMENT_MIME_TYPES.has(mimeType)
      || !Number.isSafeInteger(size) || size <= 0 || size > MAX_ATTACHMENT_BYTES) {
    return null
  }
  return { id, name, mimeType, size }
}

function normalizeSkillHint(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const targetKind = cleanInline(input.targetKind, 40)
  const namespace = cleanInline(input.namespace, 100)
  const slug = cleanInline(input.slug, 100)
  const name = cleanInline(input.name, 100)
  if (!Object.hasOwn(AGENT_LABELS, targetKind) || !namespace || !slug || !name) return null
  return { targetKind, namespace, slug, name }
}

function skillHintsPrompt(hints) {
  if (!hints.length) return ''
  return [
    'The user explicitly selected these local skills for this Agent. Load and follow them when relevant:',
    ...hints.map(skill => `- ${skill.namespace}/${skill.slug}: ${skill.name}`),
  ].join('\n')
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
  if (role === 'agent') {
    const elapsedMs = cleanElapsedMs(input.elapsedMs)
    const toolCalls = cleanProgressSteps(input.toolCalls)
    if (elapsedMs != null) message.elapsedMs = elapsedMs
    if (toolCalls.length) message.toolCalls = toolCalls
  }
  if (role === 'user') {
    const attachments = (Array.isArray(input.attachments) ? input.attachments : [])
      .slice(0, MAX_MESSAGE_ATTACHMENTS)
      .map(normalizeAttachmentMetadata)
      .filter(Boolean)
    const skillHints = (Array.isArray(input.skillHints) ? input.skillHints : [])
      .slice(0, MAX_SKILL_HINTS)
      .map(normalizeSkillHint)
      .filter(Boolean)
    if (attachments.length) message.attachments = attachments
    if (skillHints.length) message.skillHints = skillHints
  }
  return message
}

class LocalWorkspace extends EventEmitter {
  constructor(options) {
    super()
    this.storagePath = options.storagePath
    this.detectAgentsFn = options.detectAgents
    this.runAgentFn = options.runAgent
    this.resolveAttachmentsFn = options.resolveAttachments || (async (attachments) => {
      if (attachments?.length) throw new Error('LOCAL_ATTACHMENT_STORAGE_UNAVAILABLE')
      return []
    })
    this.validateSkillSelectionsFn = options.validateSkillSelections || ((_kind, selections) => selections)
    this.imageAttachmentLimitFn = options.imageAttachmentLimit || (() => 0)
    this.credentialStateFn = options.credentialState || (async () => ({ state: 'unknown', source: 'unverified' }))
    this.sharedProviderReadyFn = options.sharedProviderReady || (() => false)
    this.autoRunTimeoutMs = Number.isFinite(options.autoRunTimeoutMs)
      && options.autoRunTimeoutMs > 0
      ? options.autoRunTimeoutMs
      : DEFAULT_AUTO_RUN_TIMEOUT_MS
    this.now = options.now || (() => new Date().toISOString())
    this.createId = options.createId || randomUUID
    this.detectedAgents = []
    this.preparingRuns = new Map()
    this.activeRuns = new Map()
    this.shuttingDown = false
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
    const runEntries = [
      ...[...this.preparingRuns.entries()].map(entry => [...entry, 'preparing']),
      ...[...this.activeRuns.entries()].map(entry => [...entry, 'running']),
    ]
    return {
      agents: this.detectedAgents.map(({ executable, ...agent }) => agent),
      groups: this.state.groups,
      messages: this.state.messages,
      runningGroupIds: runEntries.map(([groupId]) => groupId),
      runs: runEntries.map(([groupId, run, phase]) => ({
        groupId,
        phase,
        mode: run.mode || 'manual',
        targetKinds: run.targetKinds || [],
        completedKinds: run.completedKinds || [],
        currentKind: run.currentKind || '',
        progress: cleanProgressSteps(run.progress),
        threadRootId: run.threadRootId || '',
        startedAt: run.startedAt || Date.now(),
      })),
    }
  }

  emitChanged() {
    this.emit('changed', this.snapshot())
  }

  createRunController(mode, targetKinds, threadRootId) {
    const controller = new AbortController()
    let done = false
    let resolveDone
    controller.done = new Promise(resolve => { resolveDone = resolve })
    controller.resolveDone = () => {
      if (done) return
      done = true
      resolveDone()
    }
    controller.mode = mode
    controller.targetKinds = [...targetKinds]
    controller.completedKinds = []
    controller.currentKind = ''
    controller.progress = []
    controller.threadRootId = threadRootId
    controller.startedAt = Date.now()
    controller.stopReason = ''
    return controller
  }

  isGroupBusy(groupId) {
    return this.preparingRuns.has(groupId) || this.activeRuns.has(groupId)
  }

  reserveRun(groupId, mode, targetKinds, threadRootId = '') {
    if (this.shuttingDown) throw new Error('LOCAL_AGENT_EXECUTION_STOPPED')
    if (this.isGroupBusy(groupId)) throw new Error('LOCAL_GROUP_RUNNING')
    const controller = this.createRunController(mode, targetKinds, threadRootId)
    this.preparingRuns.set(groupId, controller)
    try {
      this.emitChanged()
    } catch (error) {
      if (this.preparingRuns.get(groupId) === controller) this.preparingRuns.delete(groupId)
      controller.abort()
      controller.resolveDone()
      throw error
    }
    return controller
  }

  releasePreparation(groupId, controller) {
    if (this.preparingRuns.get(groupId) !== controller) return false
    this.preparingRuns.delete(groupId)
    try {
      this.emitChanged()
    } finally {
      controller.resolveDone()
    }
    return true
  }

  beginRun(groupId, mode, targetKinds, threadRootId, reservation = null) {
    if (this.shuttingDown) throw new Error('LOCAL_AGENT_EXECUTION_STOPPED')
    let controller = reservation
    if (controller) {
      if (this.preparingRuns.get(groupId) !== controller || controller.signal.aborted) {
        throw new Error('LOCAL_AGENT_EXECUTION_STOPPED')
      }
      if (this.activeRuns.has(groupId)) throw new Error('LOCAL_GROUP_RUNNING')
      this.preparingRuns.delete(groupId)
    } else {
      if (this.isGroupBusy(groupId)) throw new Error('LOCAL_GROUP_RUNNING')
      controller = this.createRunController(mode, targetKinds, threadRootId)
    }
    controller.mode = mode
    controller.targetKinds = [...targetKinds]
    controller.completedKinds = []
    controller.currentKind = ''
    controller.progress = []
    controller.threadRootId = threadRootId
    controller.startedAt = Date.now()
    controller.stopReason = ''
    this.activeRuns.set(groupId, controller)
    try {
      this.emitChanged()
    } catch (error) {
      if (this.activeRuns.get(groupId) === controller) this.activeRuns.delete(groupId)
      controller.abort()
      controller.resolveDone()
      throw error
    }
    return controller
  }

  finishRun(groupId, controller, status) {
    if (controller.finished) return
    controller.finished = true
    const ownsActiveRun = this.activeRuns.get(groupId) === controller
    if (ownsActiveRun) this.activeRuns.delete(groupId)
    const payload = {
      groupId: cleanText(groupId, 100),
      mode: controller.mode === 'auto' ? 'auto' : 'manual',
      status: RUN_STATUSES.has(status) ? status : 'failed',
      threadRootId: cleanText(controller.threadRootId, 100),
      targetKinds: controller.targetKinds.filter(kind => Object.hasOwn(AGENT_LABELS, kind)),
      completedKinds: controller.completedKinds.filter(kind => Object.hasOwn(AGENT_LABELS, kind)),
      startedAt: Number.isFinite(controller.startedAt) ? controller.startedAt : Date.now(),
      finishedAt: Date.now(),
    }
    try {
      if (ownsActiveRun) this.emitChanged()
    } catch {}
    try {
      this.emit('run-finished', payload)
    } catch {}
    controller.resolveDone()
  }

  recordAgentFailure(groupId, kind, error, threadRootId, reportedFailures = null) {
    const label = AGENT_LABELS[kind] || kind
    const reason = cleanText(error?.message || error, 2000) || 'LOCAL_AGENT_UNKNOWN_FAILURE'
    const failureKey = `${kind}:${reason}`
    if (!reportedFailures || !reportedFailures.has(failureKey)) {
      reportedFailures?.add(failureKey)
      this.addMessage(
        groupId,
        'system',
        `${label} failed: ${reason}`,
        kind,
        threadRootId,
        { key: 'system.agentCallFailed', params: { agent: label, reason } },
      )
    }
    return { label, reason }
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
    if (this.isGroupBusy(group.id)) throw new Error('LOCAL_GROUP_RUNNING')
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
    if (this.isGroupBusy(groupId)) throw new Error('LOCAL_GROUP_RUNNING')
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

  addMessage(
    groupId, role, content, agentKind = '', threadRootId = '', system = null, metadata = {},
  ) {
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
    if (role === 'agent') {
      const elapsedMs = cleanElapsedMs(metadata.elapsedMs)
      const toolCalls = cleanProgressSteps(metadata.toolCalls)
      if (elapsedMs != null) message.elapsedMs = elapsedMs
      if (toolCalls.length) message.toolCalls = toolCalls
    }
    if (role === 'user') {
      const attachments = (Array.isArray(metadata.attachments) ? metadata.attachments : [])
        .map(normalizeAttachmentMetadata)
        .filter(Boolean)
      const skillHints = (Array.isArray(metadata.skillHints) ? metadata.skillHints : [])
        .map(normalizeSkillHint)
        .filter(Boolean)
      if (attachments.length) message.attachments = attachments
      if (skillHints.length) message.skillHints = skillHints
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

  persistSessionRef(key, sessionRef) {
    const next = String(sessionRef || '')
    if (!next || next === this.state.sessions[key]) return
    this.state.sessions[key] = next
    this.save()
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
      .map((message) => {
        const attachmentNote = message.attachments?.length
          ? `[Attached images: ${message.attachments.map(item => item.name).join(', ')}]`
          : ''
        return `${message.senderName}: ${[message.content, attachmentNote].filter(Boolean).join(' ')}`
      })
      .join('\n')
      .slice(-12000)
  }

  promptFor(group, kind, mode, threadRootId = '', skillHints = []) {
    const label = AGENT_LABELS[kind] || kind
    const instruction = mode === 'auto'
      ? [
          'Read the most recent messages, respond directly to the previous participant, and advance the discussion. Do not speak for other Agents.',
          'End your reply with exactly one standalone line: [[ROUNDRELAY_CONSENSUS:agree]] or [[ROUNDRELAY_CONSENSUS:continue]].',
          'Use agree only when you fully accept the current shared conclusion and add no new proposal, condition, or reservation. Otherwise use continue.',
        ].join('\n')
      : 'Respond directly to the user and account for the other participants\' views. Do not speak for other Agents.'
    return [
      `You are participating in the local "${group.name || 'RoundRelay group'}" conversation as ${label}. Reply in the language used by the user unless they request another language.`,
      instruction,
      'Recent conversation:',
      this.recentTranscript(group.id, threadRootId),
      skillHintsPrompt(skillHints),
    ].filter(Boolean).join('\n')
  }

  async invokeAgent(group, kind, mode, signal, threadRootId = '', context = {}) {
    const agent = this.detectedAgents.find(item => item.kind === kind && item.available)
    if (!agent) throw new Error('LOCAL_AGENT_UNAVAILABLE')
    const key = this.sessionKey(group.id, kind, threadRootId)
    const startedAt = Date.now()
    const activeRun = this.activeRuns.get(group.id)
    const onProgress = (step) => {
      if (!activeRun || activeRun.currentKind !== kind) return
      activeRun.progress = cleanProgressSteps([...(activeRun.progress || []), step])
      this.emitChanged()
    }
    let result
    try {
      result = await this.runAgentFn(
        agent,
        this.promptFor(group, kind, mode, threadRootId, context.skillHints || []),
        group.workdir,
        {
          sessionRef: this.sessionRef(group, kind, threadRootId),
          onSessionRef: sessionRef => this.persistSessionRef(key, sessionRef),
          signal,
          sandbox: group.allowWrite ? 'workspace-write' : undefined,
          onProgress,
          attachments: context.attachments || [],
          ...(kind === 'hermes'
            ? { skills: (context.skillHints || []).map(skill => skill.slug) }
            : {}),
        },
      )
      this.markRuntimeCredential(kind, 'ready')
    } catch (error) {
      if (credentialFailure(error)) this.markRuntimeCredential(kind, 'missing')
      throw error
    }
    this.persistSessionRef(key, result.sessionRef)
    const reply = mode === 'auto'
      ? parseAutoReply(result.text)
      : { text: result.text, consensus: false }
    if (!reply.text) throw new Error('LOCAL_AGENT_EMPTY_RESPONSE')
    const progress = activeRun?.progress?.length ? activeRun.progress : result.progress
    const toolCalls = cleanProgressSteps(progress).map(step => ({
      ...step,
      status: step.status === 'in_progress' ? 'completed' : step.status,
    }))
    if (activeRun) activeRun.progress = toolCalls
    const message = this.addMessage(
      group.id,
      'agent',
      reply.text,
      kind,
      threadRootId,
      null,
      { elapsedMs: Date.now() - startedAt, toolCalls },
    )
    return { message, consensus: reply.consensus && result.completed !== false }
  }

  async resolveAttachments(attachmentRefs) {
    if (!Array.isArray(attachmentRefs)) throw new Error('LOCAL_ATTACHMENT_REFERENCE_INVALID')
    if (attachmentRefs.length > MAX_MESSAGE_ATTACHMENTS) {
      throw new Error('LOCAL_ATTACHMENT_COUNT_LIMIT')
    }
    const resolved = attachmentRefs.length
      ? await this.resolveAttachmentsFn(attachmentRefs)
      : []
    if (!Array.isArray(resolved) || resolved.length !== attachmentRefs.length) {
      throw new Error('LOCAL_ATTACHMENT_REFERENCE_INVALID')
    }
    return resolved.map((attachment) => {
      const metadata = normalizeAttachmentMetadata(attachment)
      if (!metadata || typeof attachment.path !== 'string' || !path.isAbsolute(attachment.path)) {
        throw new Error('LOCAL_ATTACHMENT_REFERENCE_INVALID')
      }
      return { ...metadata, path: path.normalize(attachment.path) }
    })
  }

  async sendMessage(input) {
    const group = this.getGroup(input.groupId)
    if (this.isGroupBusy(group.id)) throw new Error('LOCAL_GROUP_RUNNING')
    const text = cleanText(input.text)
    const requested = input.targetKinds?.length ? input.targetKinds : group.agentKinds
    const targetKinds = [...new Set(requested.filter(kind => group.agentKinds.includes(kind)))]
    if (!targetKinds.length) throw new Error('LOCAL_MESSAGE_TARGET_REQUIRED')
    if (input.skillHints != null && !Array.isArray(input.skillHints)) {
      throw new Error('LOCAL_SKILL_SELECTION_INVALID')
    }
    const requestedSkillHints = input.skillHints || []
    if (requestedSkillHints.length > MAX_SKILL_HINTS) throw new Error('LOCAL_SKILL_LIMIT')
    if (requestedSkillHints.some(skill => !targetKinds.includes(String(skill?.targetKind || '')))) {
      throw new Error('LOCAL_SKILL_SELECTION_INVALID')
    }
    const inputThreadRootId = cleanText(input.threadRootId, 100)
    const reservation = this.reserveRun(
      group.id, 'manual', targetKinds, inputThreadRootId,
    )
    const promise = (async () => {
      let controller = null
      let successCount = 0
      let runStatus = 'failed'
      try {
        const attachments = await this.resolveAttachments(input.attachments || [])
        if (reservation.signal.aborted || this.shuttingDown) {
          throw new Error('LOCAL_AGENT_EXECUTION_STOPPED')
        }
        if (!text && !attachments.length) throw new Error('LOCAL_MESSAGE_REQUIRED')
        for (const kind of targetKinds) {
          const limit = Number(this.imageAttachmentLimitFn(kind)) || 0
          if (attachments.length && !limit) throw new Error('LOCAL_AGENT_IMAGE_UNSUPPORTED')
          if (attachments.length > limit) throw new Error('LOCAL_AGENT_IMAGE_LIMIT')
        }

        const skillHintsByKind = new Map()
        for (const kind of targetKinds) {
          const scoped = requestedSkillHints.filter(skill => skill?.targetKind === kind)
          const validated = await this.validateSkillSelectionsFn(kind, scoped)
          if (reservation.signal.aborted || this.shuttingDown) {
            throw new Error('LOCAL_AGENT_EXECUTION_STOPPED')
          }
          if (!Array.isArray(validated) || validated.some(skill => skill?.targetKind !== kind)) {
            throw new Error('LOCAL_SKILL_SELECTION_INVALID')
          }
          skillHintsByKind.set(kind, validated)
        }
        const skillHints = targetKinds.flatMap(kind => skillHintsByKind.get(kind) || [])
        controller = this.beginRun(
          group.id, 'manual', targetKinds, inputThreadRootId, reservation,
        )
        if (controller.signal.aborted) throw new Error('LOCAL_AGENT_EXECUTION_STOPPED')
        const userMessage = this.addMessage(
          group.id,
          'user',
          text,
          '',
          inputThreadRootId,
          null,
          {
            attachments: attachments.map(({ path: _path, ...metadata }) => metadata),
            skillHints,
          },
        )
        const threadRootId = inputThreadRootId
          || (group.agentKinds.length > 1 ? userMessage.id : '')
        controller.threadRootId = threadRootId
        for (const kind of targetKinds) {
          if (controller.signal.aborted) break
          controller.currentKind = kind
          controller.progress = []
          this.emitChanged()
          try {
            await this.invokeAgent(group, kind, 'manual', controller.signal, threadRootId, {
              skillHints: skillHintsByKind.get(kind) || [],
              attachments: attachments.map(attachment => attachment.path),
            })
            successCount += 1
          } catch (error) {
            if (controller.signal.aborted) break
            this.recordAgentFailure(group.id, kind, error, threadRootId)
          }
          controller.completedKinds.push(kind)
          controller.currentKind = ''
          controller.progress = []
          this.emitChanged()
        }
        if (controller.signal.aborted) {
          runStatus = 'stopped'
          return this.snapshot()
        }
        if (!successCount) {
          return this.snapshot()
        }
        runStatus = successCount === targetKinds.length ? 'completed' : 'partial'
        return this.snapshot()
      } finally {
        if (controller) {
          controller.currentKind = ''
          controller.progress = []
          if (controller.signal.aborted) runStatus = 'stopped'
          else if (runStatus === 'failed' && successCount > 0) runStatus = 'partial'
          this.finishRun(group.id, controller, runStatus)
        } else {
          this.releasePreparation(group.id, reservation)
        }
      }
    })()
    reservation.promise = promise
    return await promise
  }

  startAuto(input) {
    const group = this.getGroup(input.groupId)
    if (this.isGroupBusy(group.id)) throw new Error('LOCAL_GROUP_RUNNING')
    if (group.agentKinds.length < 2) throw new Error('LOCAL_AUTO_AGENT_COUNT')
    const requestedRounds = Number(input.maxRounds ?? input.maxTurns)
    const maxRounds = Math.max(1, Math.min(12, requestedRounds || 3))
    const latestRoot = this.state.messages.findLast(message => (
      message.groupId === group.id && message.role === 'user' && !message.threadRootId
    ))
    const threadRootId = cleanText(input.threadRootId, 100) || latestRoot?.id || ''
    if (!threadRootId) throw new Error('LOCAL_AUTO_THREAD_REQUIRED')
    const rootMessage = this.state.messages.find(message => (
      message.id === threadRootId && message.groupId === group.id && message.role === 'user'
    ))
    const rootAttachmentCount = Array.isArray(rootMessage?.attachments)
      ? rootMessage.attachments.length
      : 0
    for (const kind of group.agentKinds) {
      const limit = Number(this.imageAttachmentLimitFn(kind)) || 0
      if (rootAttachmentCount && !limit) throw new Error('LOCAL_AGENT_IMAGE_UNSUPPORTED')
      if (rootAttachmentCount > limit) throw new Error('LOCAL_AGENT_IMAGE_LIMIT')
    }
    const controller = this.beginRun(group.id, 'auto', group.agentKinds, threadRootId)
    const timeout = setTimeout(() => {
      if (controller.signal.aborted) return
      controller.stopReason = 'timeout'
      controller.abort()
    }, this.autoRunTimeoutMs)
    const promise = (async () => {
      let runStatus = 'failed'
      let totalSuccesses = 0
      try {
        const rootAttachments = await this.resolveAttachments(rootMessage?.attachments || [])
        const rootSkillsByKind = new Map()
        for (const kind of controller.targetKinds) {
          const scoped = (rootMessage?.skillHints || []).filter(skill => skill.targetKind === kind)
          if (!scoped.length) {
            rootSkillsByKind.set(kind, [])
            continue
          }
          try {
            const validated = await this.validateSkillSelectionsFn(kind, scoped)
            rootSkillsByKind.set(
              kind,
              Array.isArray(validated) && validated.every(skill => skill?.targetKind === kind)
                ? validated
                : [],
            )
          } catch {
            rootSkillsByKind.set(kind, [])
          }
        }
        const attachmentRecipients = new Set()
        let consensusReached = false
        const reportedFailures = new Set()
        for (let round = 0; round < maxRounds && !controller.signal.aborted; round += 1) {
          let agreements = 0
          let successes = 0
          controller.completedKinds = []
          for (const kind of controller.targetKinds) {
            if (controller.signal.aborted) break
            controller.currentKind = kind
            controller.progress = []
            this.emitChanged()
            try {
              const attachments = attachmentRecipients.has(kind)
                ? []
                : rootAttachments.map(attachment => attachment.path)
              const result = await this.invokeAgent(
                group, kind, 'auto', controller.signal, threadRootId, {
                  attachments,
                  skillHints: rootSkillsByKind.get(kind) || [],
                },
              )
              if (attachments.length) attachmentRecipients.add(kind)
              successes += 1
              if (result.consensus) agreements += 1
            } catch (error) {
              if (controller.signal.aborted) break
              this.recordAgentFailure(
                group.id, kind, error, threadRootId, reportedFailures,
              )
            }
            controller.completedKinds.push(kind)
            controller.currentKind = ''
            controller.progress = []
            this.emitChanged()
          }
          totalSuccesses += successes
          if (controller.signal.aborted) break
          if (successes === controller.targetKinds.length
              && agreements === controller.targetKinds.length) {
            consensusReached = true
            break
          }
        }
        if (controller.stopReason === 'timeout') runStatus = 'timeout'
        else if (controller.signal.aborted) runStatus = 'stopped'
        else if (consensusReached) runStatus = 'completed'
        else runStatus = totalSuccesses > 0 ? 'round-limit' : 'failed'
        if (runStatus === 'timeout') {
          this.addMessage(
            group.id,
            'system',
            'Automatic discussion reached its runtime limit without consensus.',
            '',
            threadRootId,
            { key: 'system.autoTimeout', params: {} },
          )
        } else if (runStatus === 'round-limit' || runStatus === 'failed') {
          this.addMessage(
            group.id,
            'system',
            `Automatic discussion reached the ${maxRounds}-round safety limit without consensus.`,
            '',
            threadRootId,
            { key: 'system.autoRoundLimit', params: { rounds: maxRounds } },
          )
        }
      } catch (error) {
        runStatus = controller.signal.aborted
          ? (controller.stopReason === 'timeout' ? 'timeout' : 'stopped')
          : 'failed'
        if (!controller.signal.aborted) {
          const rawReason = cleanText(error?.message || error, 2000)
          const reason = /^[A-Z][A-Z0-9_]+$/.test(rawReason)
            ? rawReason
            : 'LOCAL_AGENT_UNKNOWN_FAILURE'
          try {
            this.addMessage(
              group.id,
              'system',
              `Automatic discussion stopped: ${reason}`,
              '',
              threadRootId,
              { key: 'system.autoStopped', params: { reason } },
            )
          } catch { /* persistence failures cannot be reported through the same store */ }
        }
      } finally {
        clearTimeout(timeout)
        controller.currentKind = ''
        controller.progress = []
        if (controller.stopReason === 'timeout') runStatus = 'timeout'
        else if (controller.signal.aborted) runStatus = 'stopped'
        this.finishRun(group.id, controller, runStatus)
      }
    })()
    controller.promise = promise
    return { started: true, maxRounds }
  }

  stop(groupId) {
    const controller = this.activeRuns.get(groupId) || this.preparingRuns.get(groupId)
    if (!controller) return false
    controller.stopReason ||= 'user'
    controller.abort()
    return true
  }

  async stopAll() {
    this.shuttingDown = true
    const controllers = new Set([
      ...this.preparingRuns.values(),
      ...this.activeRuns.values(),
    ])
    for (const controller of controllers) {
      controller.stopReason ||= 'shutdown'
      controller.abort()
    }
    await Promise.allSettled([...controllers].map(controller => controller.done))
  }
}

module.exports = { LocalWorkspace }
