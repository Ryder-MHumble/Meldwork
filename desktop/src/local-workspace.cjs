const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const AGENT_LABELS = {
  codex: 'Codex',
  hermes: 'Hermes',
  openclaw: 'OpenClaw',
  workbuddy: 'WorkBuddy',
  kimi: 'Kimi',
  mimo: 'MiMo',
  claude: 'Claude',
  qwen: 'Qwen',
  gemini: 'Gemini',
  opencode: 'OpenCode',
}
const AUTO_CONSENSUS_MARKER = /\[\[ROUNDRELAY_CONSENSUS:(agree|continue)\]\]/gi
const AUTO_FINAL_CONSENSUS_MARKER = /(?:^|\r?\n)[ \t]*\[\[ROUNDRELAY_CONSENSUS:(agree|continue)\]\][ \t]*$/i
const DEFAULT_AUTO_RUN_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_AUTO_ROUNDS = 6
const MAX_AUTO_ROUNDS = 10
const MAX_MESSAGE_ATTACHMENTS = 4
const MAX_SKILL_HINTS = 4
const MAX_ATTACHMENT_BYTES = 128 * 1024 * 1024
const STABLE_USER_TURNS_PER_EDGE = 3
const STABLE_USER_TURN_TEXT_LIMIT = 700
const RECENT_TRANSCRIPT_MESSAGE_LIMIT = 20
const RECENT_TRANSCRIPT_TEXT_LIMIT = 12000
const USER_ATTACHMENT_MIME_TYPES = new Set(['image/png', 'image/jpeg'])
const ATTACHMENT_MIME_TYPES = new Set([
  ...USER_ATTACHMENT_MIME_TYPES,
  'audio/mpeg', 'audio/wav', 'audio/mp4',
  'video/mp4', 'video/quicktime', 'video/webm',
])
const ATTACHMENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const RUN_STATUSES = new Set([
  'completed', 'partial', 'failed', 'stopped', 'timeout', 'round-limit',
])
const PROGRESS_TITLES = new Set([
  'reasoning', 'process', 'read_file', 'write_file', 'search',
  'image_generation', 'audio_generation', 'video_generation', 'tool',
])

function emptyState() {
  return {
    version: 2,
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

function normalizeAutoRounds(value) {
  const requested = Number(value)
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_AUTO_ROUNDS
  return Math.max(1, Math.min(MAX_AUTO_ROUNDS, Math.floor(requested)))
}

function cleanRunMaxRounds(value) {
  const requested = Number(value)
  if (!Number.isFinite(requested) || requested <= 0) return 0
  return Math.max(1, Math.min(MAX_AUTO_ROUNDS, Math.floor(requested)))
}

function cleanCurrentRound(value, maxRounds, unlimitedRounds = false) {
  const requested = Number(value)
  if (!Number.isFinite(requested) || requested <= 0) return 0
  if (unlimitedRounds) return Math.floor(requested)
  if (!maxRounds) return 0
  return Math.max(1, Math.min(maxRounds, Math.floor(requested)))
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

function normalizeTargetKinds(input) {
  return [...new Set((Array.isArray(input) ? input : [])
    .map(kind => cleanInline(kind, 40))
    .filter(kind => Object.hasOwn(AGENT_LABELS, kind)))]
}

function skillHintsPrompt(hints) {
  if (!hints.length) return ''
  return [
    'The user explicitly selected these local skills for this Agent. Load and follow them when relevant:',
    ...hints.map(skill => `- ${skill.namespace}/${skill.slug}: ${skill.name}`),
  ].join('\n')
}

function normalizeLoadedGroup(input, defaultAllowWrite = false) {
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
    allowWrite: defaultAllowWrite || input.allowWrite === true,
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
    const attachments = (Array.isArray(input.attachments) ? input.attachments : [])
      .slice(0, MAX_MESSAGE_ATTACHMENTS)
      .map(normalizeAttachmentMetadata)
      .filter(Boolean)
    if (elapsedMs != null) message.elapsedMs = elapsedMs
    if (toolCalls.length) message.toolCalls = toolCalls
    if (attachments.length) message.attachments = attachments
  }
  if (role === 'user') {
    const attachments = (Array.isArray(input.attachments) ? input.attachments : [])
      .slice(0, MAX_MESSAGE_ATTACHMENTS)
      .map(normalizeAttachmentMetadata)
      .filter(attachment => attachment && USER_ATTACHMENT_MIME_TYPES.has(attachment.mimeType))
    const skillHints = (Array.isArray(input.skillHints) ? input.skillHints : [])
      .slice(0, MAX_SKILL_HINTS)
      .map(normalizeSkillHint)
      .filter(Boolean)
    const targetKinds = normalizeTargetKinds(input.targetKinds)
    if (attachments.length) message.attachments = attachments
    if (skillHints.length) message.skillHints = skillHints
    if (targetKinds.length) message.targetKinds = targetKinds
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
    this.captureAgentOutputsFn = options.captureAgentOutputs || (async () => null)
    this.importAgentOutputsFn = options.importAgentOutputs || (async () => [])
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
      if (![1, 2].includes(parsed?.version) || !Array.isArray(parsed.groups)
          || !Array.isArray(parsed.messages) || typeof parsed.sessions !== 'object') {
        return emptyState()
      }
      const groups = parsed.groups
        .map(group => normalizeLoadedGroup(group, parsed.version === 1))
        .filter(Boolean)
      const groupIds = new Set(groups.map(group => group.id))
      const messages = parsed.messages
        .map(normalizeLoadedMessage)
        .filter(message => message && groupIds.has(message.groupId))
      return {
        version: 2,
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
      runs: runEntries.map(([groupId, run, phase]) => {
        const mode = run.mode === 'auto' ? 'auto' : 'manual'
        const unlimitedRounds = mode === 'auto' && run.unlimitedRounds === true
        const maxRounds = mode === 'auto' && !unlimitedRounds ? cleanRunMaxRounds(run.maxRounds) : 0
        return {
          groupId,
          phase,
          mode,
          targetKinds: run.targetKinds || [],
          completedKinds: run.completedKinds || [],
          failedKinds: run.failedKinds || [],
          currentKind: run.currentKind || '',
          currentRound: cleanCurrentRound(run.currentRound, maxRounds, unlimitedRounds),
          maxRounds,
          unlimitedRounds,
          progress: cleanProgressSteps(run.progress),
          threadRootId: run.threadRootId || '',
          startedAt: run.startedAt || Date.now(),
        }
      }),
    }
  }

  emitChanged() {
    this.emit('changed', this.snapshot())
  }

  createRunController(mode, targetKinds, threadRootId, maxRounds = 0, unlimitedRounds = false) {
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
    controller.failedKinds = []
    controller.currentKind = ''
    controller.progress = []
    controller.threadRootId = threadRootId
    controller.currentRound = 0
    controller.unlimitedRounds = mode === 'auto' && unlimitedRounds === true
    controller.maxRounds = mode === 'auto' && !controller.unlimitedRounds
      ? cleanRunMaxRounds(maxRounds)
      : 0
    controller.startedAt = Date.now()
    controller.stopReason = ''
    return controller
  }

  isGroupBusy(groupId) {
    return this.preparingRuns.has(groupId) || this.activeRuns.has(groupId)
  }

  reserveRun(
    groupId, mode, targetKinds, threadRootId = '', maxRounds = 0, unlimitedRounds = false,
  ) {
    if (this.shuttingDown) throw new Error('LOCAL_AGENT_EXECUTION_STOPPED')
    if (this.isGroupBusy(groupId)) throw new Error('LOCAL_GROUP_RUNNING')
    const controller = this.createRunController(
      mode, targetKinds, threadRootId, maxRounds, unlimitedRounds,
    )
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

  beginRun(
    groupId, mode, targetKinds, threadRootId, reservation = null, maxRounds = 0,
    unlimitedRounds = false,
  ) {
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
      controller = this.createRunController(
        mode, targetKinds, threadRootId, maxRounds, unlimitedRounds,
      )
    }
    controller.mode = mode
    controller.targetKinds = [...targetKinds]
    controller.completedKinds = []
    controller.failedKinds = []
    controller.currentKind = ''
    controller.progress = []
    controller.threadRootId = threadRootId
    controller.currentRound = 0
    controller.unlimitedRounds = mode === 'auto'
      && (unlimitedRounds === true || controller.unlimitedRounds === true)
    controller.maxRounds = mode === 'auto' && !controller.unlimitedRounds
      ? cleanRunMaxRounds(maxRounds || controller.maxRounds)
      : 0
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
      allowWrite: input.allowWrite !== false,
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
    if (input.workdir != null) {
      const nextWorkdir = path.resolve(cleanText(input.workdir, 1000))
      if (nextWorkdir !== group.workdir) {
        group.workdir = nextWorkdir
        for (const key of Object.keys(this.state.sessions)) {
          if (key.startsWith(`${group.id}:`)) delete this.state.sessions[key]
        }
      }
    }
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
      const attachments = (Array.isArray(metadata.attachments) ? metadata.attachments : [])
        .slice(0, MAX_MESSAGE_ATTACHMENTS)
        .map(normalizeAttachmentMetadata)
        .filter(Boolean)
      if (elapsedMs != null) message.elapsedMs = elapsedMs
      if (toolCalls.length) message.toolCalls = toolCalls
      if (attachments.length) message.attachments = attachments
    }
    if (role === 'user') {
      const attachments = (Array.isArray(metadata.attachments) ? metadata.attachments : [])
        .map(normalizeAttachmentMetadata)
        .filter(Boolean)
      const skillHints = (Array.isArray(metadata.skillHints) ? metadata.skillHints : [])
        .map(normalizeSkillHint)
        .filter(Boolean)
      const targetKinds = normalizeTargetKinds(metadata.targetKinds)
      if (attachments.length) message.attachments = attachments
      if (skillHints.length) message.skillHints = skillHints
      if (targetKinds.length) message.targetKinds = targetKinds
    }
    this.state.messages.push(message)
    const group = this.getGroup(groupId)
    group.updatedAt = message.createdAt
    this.save()
    this.emitChanged()
    return message
  }

  sessionKey(groupId, kind) {
    return `${groupId}:${kind}`
  }

  sessionRef(group, kind, threadRootId = '') {
    const key = this.sessionKey(group.id, kind)
    const legacyPrefix = `${group.id}:${kind}:thread:`
    let stateChanged = false
    const validStoredRef = (candidateKey) => {
      let candidate = String(this.state.sessions[candidateKey] || '')
      if (kind === 'hermes' && /^roundrelay-[a-zA-Z0-9]+-hermes$/.test(candidate)) {
        delete this.state.sessions[candidateKey]
        stateChanged = true
        candidate = ''
      }
      if (kind === 'openclaw' && candidate && !candidate.startsWith('agent:main:desktop-')) {
        delete this.state.sessions[candidateKey]
        stateChanged = true
        candidate = ''
      }
      return candidate
    }

    const currentLegacyKey = threadRootId
      ? `${legacyPrefix}${cleanText(threadRootId, 100)}`
      : ''
    const legacyKeys = Object.keys(this.state.sessions).filter(candidate => (
      candidate.startsWith(legacyPrefix)
    ))
    const legacyActivity = legacyKey => {
      const rootId = legacyKey.slice(legacyPrefix.length)
      for (let index = this.state.messages.length - 1; index >= 0; index -= 1) {
        const message = this.state.messages[index]
        if (message.groupId !== group.id) continue
        if (message.id === rootId || message.threadRootId === rootId) return index
      }
      return -1
    }
    const orderedLegacyKeys = [
      ...(currentLegacyKey && legacyKeys.includes(currentLegacyKey) ? [currentLegacyKey] : []),
      ...legacyKeys
        .filter(candidate => candidate !== currentLegacyKey)
        .sort((left, right) => (
          legacyActivity(right) - legacyActivity(left) || left.localeCompare(right)
        )),
    ]

    let stored = validStoredRef(key)
    if (!stored) {
      for (const legacyKey of orderedLegacyKeys) {
        const legacyRef = validStoredRef(legacyKey)
        if (!legacyRef) continue
        this.state.sessions[key] = legacyRef
        stateChanged = true
        stored = legacyRef
        break
      }
    }
    for (const legacyKey of legacyKeys) {
      if (!Object.hasOwn(this.state.sessions, legacyKey)) continue
      delete this.state.sessions[legacyKey]
      stateChanged = true
    }
    if (!stored && kind === 'openclaw') {
      const groupScope = group.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)
      const stableId = `roundrelay-${groupScope}-${kind}`
      this.state.sessions[key] = `agent:main:desktop-${stableId}`
      stateChanged = true
      stored = this.state.sessions[key]
    }
    if (stateChanged) this.save()
    return stored
  }

  persistSessionRef(key, sessionRef) {
    const next = String(sessionRef || '')
    if (!next || next === this.state.sessions[key]) return
    this.state.sessions[key] = next
    this.save()
  }

  promptMessageText(message, limit = 20000) {
    const attachmentNote = message.attachments?.length
      ? `[Attached files: ${message.attachments.map(item => item.name).join(', ')}]`
      : ''
    return cleanText([message.content, attachmentNote].filter(Boolean).join(' '), limit)
  }

  stableUserInstructions(groupId, threadRootId = '') {
    const userMessages = this.state.messages.filter(message => (
      message.groupId === groupId && message.role === 'user'
    ))
    const selected = [
      ...userMessages.slice(0, STABLE_USER_TURNS_PER_EDGE),
      ...userMessages.slice(-STABLE_USER_TURNS_PER_EDGE),
    ]
    const currentRoot = cleanText(threadRootId, 100)
    if (currentRoot) {
      const rootMessage = userMessages.find(message => message.id === currentRoot)
      if (rootMessage) selected.push(rootMessage)
    }
    const seen = new Set()
    return selected
      .filter((message) => {
        if (seen.has(message.id)) return false
        seen.add(message.id)
        return true
      })
      .map(message => `- ${this.promptMessageText(message, STABLE_USER_TURN_TEXT_LIMIT)}`)
      .filter(line => line !== '- ')
      .join('\n')
  }

  recentTranscript(groupId, afterAgentKind = '') {
    let afterIndex = -1
    if (afterAgentKind) {
      for (let index = this.state.messages.length - 1; index >= 0; index -= 1) {
        const message = this.state.messages[index]
        if (message.groupId === groupId && message.role === 'agent'
            && message.agentKind === afterAgentKind) {
          afterIndex = index
          break
        }
      }
    }
    return this.state.messages
      .filter((message, index) => (
        index > afterIndex && message.groupId === groupId
          && ['user', 'agent'].includes(message.role)
      ))
      .slice(-RECENT_TRANSCRIPT_MESSAGE_LIMIT)
      .map(message => `${message.senderName}: ${this.promptMessageText(message)}`)
      .join('\n')
      .slice(-RECENT_TRANSCRIPT_TEXT_LIMIT)
  }

  promptFor(group, kind, mode, threadRootId = '', skillHints = [], transcriptAfterKind = '') {
    const label = AGENT_LABELS[kind] || kind
    const instruction = mode === 'auto'
      ? [
          'Read the most recent messages, respond directly to the previous participant, and advance the discussion. Do not speak for other Agents.',
          'End your reply with exactly one standalone line: [[ROUNDRELAY_CONSENSUS:agree]] or [[ROUNDRELAY_CONSENSUS:continue]].',
          'Use agree only when you fully accept the current shared conclusion and add no new proposal, condition, or reservation. Otherwise use continue.',
        ].join('\n')
      : 'Respond directly to the user and account for the other participants\' views. Do not speak for other Agents.'
    const mediaDelivery = group.allowWrite
      ? [
          'Workspace access: You may create and edit files in the conversation working directory. When the user requests a deliverable, execute the work instead of returning only a plan.',
          'Media delivery contract: When the user asks for an image, audio, or video, do not claim it was generated unless a real file exists.',
          'Save or copy each final media file into .meldwork-output/ in the conversation working directory. Supported extensions: .png, .jpg, .jpeg, .mp3, .wav, .m4a, .mp4, .mov, .webm.',
          'Mention a delivered media file only after it has been written there.',
        ].join('\n')
      : [
          'This conversation is read-only. Do not claim that a media file was generated or delivered because no writable output can be attached.',
          'If the user requests generated media, explain that workspace write access must be enabled before a real file can be delivered.',
        ].join('\n')
    return [
      `You are participating in the local "${group.name || 'Meldwork group'}" conversation as ${label}. Reply in the language used by the user unless they request another language.`,
      `Group topic: ${cleanText(group.topic, 200) || '(not specified)'}`,
      instruction,
      mediaDelivery,
      'Stable user instructions and constraints:',
      this.stableUserInstructions(group.id, threadRootId) || '(none)',
      'Recent conversation across the group:',
      this.recentTranscript(group.id, transcriptAfterKind) || '(none)',
      skillHintsPrompt(skillHints),
    ].filter(Boolean).join('\n')
  }

  async invokeAgent(group, kind, mode, signal, threadRootId = '', context = {}) {
    const agent = this.detectedAgents.find(item => item.kind === kind && item.available)
    if (!agent) throw new Error('LOCAL_AGENT_UNAVAILABLE')
    const key = this.sessionKey(group.id, kind)
    const storedSessionRef = String(this.state.sessions[key] || '')
    const sessionRef = this.sessionRef(
      group, kind, context.sessionThreadRootId || threadRootId,
    )
    const transcriptAfterKind = storedSessionRef && storedSessionRef === sessionRef ? kind : ''
    const startedAt = Date.now()
    const activeRun = this.activeRuns.get(group.id)
    const onProgress = (step) => {
      if (!activeRun || activeRun.currentKind !== kind) return
      const next = [...(activeRun.progress || [])]
      const progressId = typeof step?.id === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(step.id)
        ? step.id
        : ''
      const existingIndex = progressId
        ? next.findIndex(item => item?.id === progressId)
        : -1
      if (existingIndex >= 0) next[existingIndex] = { ...step, id: progressId }
      else next.push(progressId ? { ...step, id: progressId } : step)
      activeRun.progress = next.slice(-8)
      this.emitChanged()
    }
    let outputBaseline = null
    if (group.allowWrite) {
      try { outputBaseline = await this.captureAgentOutputsFn(group.workdir) } catch { /* best effort */ }
    }
    let result
    try {
      result = await this.runAgentFn(
        agent,
        this.promptFor(
          group, kind, mode, threadRootId, context.skillHints || [], transcriptAfterKind,
        ),
        group.workdir,
        {
          sessionRef,
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
    let attachments = []
    if (group.allowWrite) {
      try {
        const imported = await this.importAgentOutputsFn({
          workdir: group.workdir,
          baseline: outputBaseline,
          startedAt,
          agentKind: kind,
        })
        attachments = (Array.isArray(imported) ? imported : [])
          .slice(0, MAX_MESSAGE_ATTACHMENTS)
          .map(normalizeAttachmentMetadata)
          .filter(Boolean)
      } catch { /* the reply remains available when no valid media was produced */ }
    }
    const message = this.addMessage(
      group.id,
      'agent',
      reply.text,
      kind,
      threadRootId,
      null,
      { elapsedMs: Date.now() - startedAt, toolCalls, attachments },
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
      if (!USER_ATTACHMENT_MIME_TYPES.has(metadata.mimeType)) {
        throw new Error('LOCAL_ATTACHMENT_REFERENCE_INVALID')
      }
      return { ...metadata, path: path.normalize(attachment.path) }
    })
  }

  async preflightMessage(targetKinds, input, reservation) {
    const text = cleanText(input.text)
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

    const requestedSkillHints = input.skillHints || []
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
    return {
      text,
      attachments,
      skillHintsByKind,
      skillHints: targetKinds.flatMap(kind => skillHintsByKind.get(kind) || []),
    }
  }

  startAutoRunner(
    group, threadRootId, maxRounds, reservation = null, preparedContext = null,
    unlimitedRounds = false,
  ) {
    const controller = this.beginRun(
      group.id, 'auto', group.agentKinds, threadRootId, reservation, maxRounds, unlimitedRounds,
    )
    const timeout = setTimeout(() => {
      if (controller.signal.aborted) return
      controller.stopReason = 'timeout'
      controller.abort()
    }, this.autoRunTimeoutMs)
    const promise = (async () => {
      let runStatus = 'failed'
      let totalSuccesses = 0
      try {
        let rootAttachments = preparedContext?.attachments
        let rootSkillsByKind = preparedContext?.skillHintsByKind
        if (!rootAttachments || !rootSkillsByKind) {
          const rootMessage = this.state.messages.find(message => (
            message.id === threadRootId && message.groupId === group.id && message.role === 'user'
          ))
          rootAttachments = await this.resolveAttachments(rootMessage?.attachments || [])
          rootSkillsByKind = new Map()
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
        }
        const attachmentRecipients = new Set()
        let consensusReached = false
        const reportedFailures = new Set()
        for (
          let round = 0;
          (controller.unlimitedRounds || round < maxRounds) && !controller.signal.aborted;
          round += 1
        ) {
          let agreements = 0
          let successes = 0
          controller.currentRound = round + 1
          controller.completedKinds = []
          controller.failedKinds = []
          this.emitChanged()
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
              controller.failedKinds.push(kind)
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
        } else if (!controller.unlimitedRounds && (runStatus === 'round-limit' || runStatus === 'failed')) {
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
    return controller
  }

  async sendMessage(input) {
    const group = this.getGroup(input.groupId)
    if (this.isGroupBusy(group.id)) throw new Error('LOCAL_GROUP_RUNNING')
    const mode = input.mode === 'auto' && group.conversationType !== 'direct'
      ? 'auto'
      : 'manual'
    if (mode === 'auto' && group.agentKinds.length < 2) {
      throw new Error('LOCAL_AUTO_AGENT_COUNT')
    }
    const requested = mode === 'auto'
      ? group.agentKinds
      : (input.targetKinds?.length ? input.targetKinds : group.agentKinds)
    const targetKinds = [...new Set(requested.filter(kind => group.agentKinds.includes(kind)))]
    if (!targetKinds.length) throw new Error('LOCAL_MESSAGE_TARGET_REQUIRED')
    if (input.mentionedAgentKinds != null && !Array.isArray(input.mentionedAgentKinds)) {
      throw new Error('LOCAL_MESSAGE_TARGET_REQUIRED')
    }
    const mentionedAgentKinds = normalizeTargetKinds(input.mentionedAgentKinds)
    if (mentionedAgentKinds.some(kind => !targetKinds.includes(kind))) {
      throw new Error('LOCAL_MESSAGE_TARGET_REQUIRED')
    }
    if (mode === 'auto' && targetKinds.some(kind => (
      !this.detectedAgents.some(agent => agent.kind === kind && agent.available)
    ))) {
      throw new Error('LOCAL_AGENT_UNAVAILABLE')
    }
    if (input.skillHints != null && !Array.isArray(input.skillHints)) {
      throw new Error('LOCAL_SKILL_SELECTION_INVALID')
    }
    const requestedSkillHints = input.skillHints || []
    if (requestedSkillHints.length > MAX_SKILL_HINTS) throw new Error('LOCAL_SKILL_LIMIT')
    if (requestedSkillHints.some(skill => !targetKinds.includes(String(skill?.targetKind || '')))) {
      throw new Error('LOCAL_SKILL_SELECTION_INVALID')
    }
    const unlimitedRounds = mode === 'auto' && input.unlimitedRounds === true
    const maxRounds = mode === 'auto' && !unlimitedRounds
      ? normalizeAutoRounds(input.maxRounds ?? input.maxTurns)
      : 0
    const requestedThreadRootId = mode === 'manual' ? cleanText(input.threadRootId, 100) : ''
    const reservation = this.reserveRun(
      group.id, mode, targetKinds, '', maxRounds, unlimitedRounds,
    )
    const promise = (async () => {
      let controller = null
      let autoStarted = false
      let successCount = 0
      let runStatus = 'failed'
      try {
        const prepared = await this.preflightMessage(targetKinds, input, reservation)
        if (mode === 'auto') {
          const previousUpdatedAt = group.updatedAt
          const userMessage = this.addMessage(
            group.id,
            'user',
            prepared.text,
            '',
            '',
            null,
            {
              attachments: prepared.attachments.map(({ path: _path, ...metadata }) => metadata),
              skillHints: prepared.skillHints,
              targetKinds: mentionedAgentKinds,
            },
          )
          try {
            controller = this.startAutoRunner(
              group, userMessage.id, maxRounds, reservation, prepared, unlimitedRounds,
            )
          } catch (error) {
            const messageIndex = this.state.messages.findIndex(message => message === userMessage)
            if (messageIndex >= 0) {
              this.state.messages.splice(messageIndex, 1)
              group.updatedAt = previousUpdatedAt
              this.save()
              try { this.emitChanged() } catch { /* preserve the run-start failure */ }
            }
            throw error
          }
          autoStarted = true
          return {
            started: true,
            maxRounds,
            threadRootId: userMessage.id,
            ...(unlimitedRounds ? { unlimitedRounds: true } : {}),
          }
        }

        controller = this.beginRun(group.id, 'manual', targetKinds, '', reservation)
        if (controller.signal.aborted) throw new Error('LOCAL_AGENT_EXECUTION_STOPPED')
        const userMessage = this.addMessage(
          group.id,
          'user',
          prepared.text,
          '',
          '',
          null,
          {
            attachments: prepared.attachments.map(({ path: _path, ...metadata }) => metadata),
            skillHints: prepared.skillHints,
            targetKinds: mentionedAgentKinds,
          },
        )
        const threadRootId = group.conversationType === 'direct' ? '' : userMessage.id
        controller.threadRootId = threadRootId
        for (const kind of targetKinds) {
          if (controller.signal.aborted) break
          controller.currentKind = kind
          controller.progress = []
          this.emitChanged()
          try {
            await this.invokeAgent(group, kind, 'manual', controller.signal, threadRootId, {
              skillHints: prepared.skillHintsByKind.get(kind) || [],
              attachments: prepared.attachments.map(attachment => attachment.path),
              sessionThreadRootId: requestedThreadRootId || threadRootId,
            })
            successCount += 1
          } catch (error) {
            if (controller.signal.aborted) break
            this.recordAgentFailure(group.id, kind, error, threadRootId)
            controller.failedKinds.push(kind)
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
        if (!successCount) return this.snapshot()
        runStatus = successCount === targetKinds.length ? 'completed' : 'partial'
        return this.snapshot()
      } finally {
        if (mode === 'auto') {
          if (!autoStarted) this.releasePreparation(group.id, reservation)
        } else if (controller) {
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
    const unlimitedRounds = input.unlimitedRounds === true
    const maxRounds = unlimitedRounds
      ? 0
      : normalizeAutoRounds(input.maxRounds ?? input.maxTurns)
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
    this.startAutoRunner(group, threadRootId, maxRounds, null, null, unlimitedRounds)
    return { started: true, maxRounds, ...(unlimitedRounds ? { unlimitedRounds: true } : {}) }
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
