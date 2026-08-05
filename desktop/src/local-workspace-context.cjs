const { createHash } = require('node:crypto')

const {
  evidenceCapsuleText,
  normalizeSessionMeta,
  packContextEntries,
} = require('./run-harness.cjs')
const {
  AGENT_LABELS,
  RECENT_TRANSCRIPT_MESSAGE_LIMIT,
  RECENT_TRANSCRIPT_TEXT_LIMIT,
  SESSION_KEY,
  STABLE_CONTEXT_TEXT_LIMIT,
  STABLE_USER_TURN_TEXT_LIMIT,
  STABLE_USER_TURNS_PER_EDGE,
  cleanText,
  isTracedAgentTerminalMessage,
  knowledgeBaseHintsPrompt,
  normalizeSessionRef,
  skillHintsPrompt,
} = require('./local-workspace-inputs.cjs')

function sessionKey(groupId, kind, taskId = '') {
  const existingKey = taskId
    ? `${groupId}:task:${taskId}:${kind}`
    : `${groupId}:${kind}`
  if (SESSION_KEY.test(existingKey)) return existingKey
  const digest = createHash('sha256')
    .update(JSON.stringify([
      taskId ? 'task' : 'conversation',
      String(groupId || ''),
      String(taskId || ''),
      String(kind || ''),
    ]))
    .digest('hex')
  return `session:${digest}`
}

function clearSessionState(state, groupId) {
  const existingPrefix = `${groupId}:`
  const group = state.groups.find(item => item.id === groupId)
  const kinds = new Set([...Object.keys(AGENT_LABELS), ...(group?.agentKinds || [])])
  const taskIds = state.messages
    .filter(message => message.groupId === groupId && message.role === 'user')
    .map(message => message.id)
  const derivedKeys = new Set()
  for (const kind of kinds) {
    derivedKeys.add(sessionKey(groupId, kind))
    for (const taskId of taskIds) derivedKeys.add(sessionKey(groupId, kind, taskId))
  }
  for (const key of Object.keys(state.sessions)) {
    if (key.startsWith(existingPrefix) || derivedKeys.has(key)) delete state.sessions[key]
  }
  for (const key of Object.keys(state.sessionMeta)) {
    if (key.startsWith(existingPrefix) || derivedKeys.has(key)) delete state.sessionMeta[key]
  }
}

function openClawSessionRef(group, generation = '', taskId = '') {
  const groupScope = createHash('sha256')
    .update(JSON.stringify([String(group.id || ''), String(taskId || '')]))
    .digest('hex')
    .slice(0, 20)
  const safeGeneration = String(generation || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 32)
  const suffix = safeGeneration ? `-${safeGeneration}` : ''
  return `agent:main:desktop-roundrelay-${groupScope}-openclaw${suffix}`
}

function completeSessionMeta(meta, scope, taskId) {
  return normalizeSessionMeta({
    ...meta,
    sessionScope: scope,
    originTaskId: taskId,
    inheritedTaskIds: [],
    provenanceCompleteness: 'complete',
  })
}

function unknownLegacySessionMeta(meta) {
  return normalizeSessionMeta({
    ...meta,
    sessionScope: 'unknown-legacy',
    originTaskId: '',
    inheritedTaskIds: [],
    provenanceCompleteness: 'unknown-legacy',
  })
}

function resolveSessionState({
  state, group, kind, threadRootId = '', taskId = '', save,
}) {
  const scopedTaskId = group.conversationType === 'direct'
    ? ''
    : cleanText(taskId || threadRootId, 100)
  const currentTaskId = cleanText(taskId || threadRootId, 100)
  const key = sessionKey(group.id, kind, scopedTaskId)
  const globalKey = sessionKey(group.id, kind)
  const legacyPrefix = `${group.id}:${kind}:thread:`
  let stateChanged = false
  const validStoredRef = (candidateKey) => {
    let candidate = normalizeSessionRef(state.sessions[candidateKey])
    if (!candidate && (
      Object.hasOwn(state.sessions, candidateKey)
      || Object.hasOwn(state.sessionMeta, candidateKey)
    )) {
      delete state.sessions[candidateKey]
      delete state.sessionMeta[candidateKey]
      stateChanged = true
    }
    if (kind === 'openclaw' && candidate) {
      const legacyScope = group.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)
      const legacyBase = `agent:main:desktop-roundrelay-${legacyScope}-openclaw`
      if (candidate === legacyBase || candidate.startsWith(`${legacyBase}-`)) {
        const generation = candidate.slice(legacyBase.length).replace(/^-/, '')
        candidate = openClawSessionRef(group, generation, scopedTaskId)
        state.sessions[candidateKey] = candidate
        stateChanged = true
      }
    }
    if (kind === 'hermes' && /^roundrelay-[a-zA-Z0-9]+-hermes$/.test(candidate)) {
      delete state.sessions[candidateKey]
      delete state.sessionMeta[candidateKey]
      stateChanged = true
      candidate = ''
    }
    if (kind === 'openclaw' && candidate && !candidate.startsWith('agent:main:desktop-')) {
      delete state.sessions[candidateKey]
      delete state.sessionMeta[candidateKey]
      stateChanged = true
      candidate = ''
    }
    return candidate
  }

  const currentLegacyKey = scopedTaskId
    ? `${legacyPrefix}${scopedTaskId}`
    : ''
  let migration = ''
  let created = false
  let stored = validStoredRef(key)
  if (!stored && currentLegacyKey) {
    const legacyRef = validStoredRef(currentLegacyKey)
    if (legacyRef) {
      state.sessions[key] = legacyRef
      state.sessionMeta[key] = completeSessionMeta(
        state.sessionMeta[currentLegacyKey], 'task', scopedTaskId,
      )
      delete state.sessions[currentLegacyKey]
      delete state.sessionMeta[currentLegacyKey]
      stored = legacyRef
      migration = 'migrated'
      stateChanged = true
    }
  }
  if (!stored && scopedTaskId && globalKey !== key) {
    const legacyRef = validStoredRef(globalKey)
    if (legacyRef) {
      state.sessions[key] = legacyRef
      state.sessionMeta[key] = unknownLegacySessionMeta(state.sessionMeta[globalKey])
      delete state.sessions[globalKey]
      delete state.sessionMeta[globalKey]
      stored = legacyRef
      migration = 'unknown-legacy'
      stateChanged = true
    }
  }
  if (!stored && kind === 'openclaw') {
    state.sessions[key] = openClawSessionRef(group, '', scopedTaskId)
    state.sessionMeta[key] = completeSessionMeta(
      state.sessionMeta[key], scopedTaskId ? 'task' : 'conversation', currentTaskId,
    )
    stateChanged = true
    stored = state.sessions[key]
    created = true
  }
  let meta = normalizeSessionMeta(state.sessionMeta[key])
  if (stored && !meta.sessionScope) {
    meta = unknownLegacySessionMeta(meta)
    state.sessionMeta[key] = meta
    stateChanged = true
  }
  if (stateChanged) save()
  const provenance = created || !stored
    ? {
        scope: scopedTaskId ? 'task' : 'conversation',
        reuse: false,
        origin: 'created',
        originTaskId: currentTaskId || null,
        inheritedTaskIds: [],
        completeness: 'complete',
      }
    : meta.sessionScope === 'unknown-legacy'
      ? {
          scope: 'unknown-legacy',
          reuse: true,
          origin: 'unknown-legacy',
          originTaskId: null,
          inheritedTaskIds: [],
          completeness: 'unknown-legacy',
        }
      : {
          scope: meta.sessionScope,
          reuse: true,
          origin: migration === 'migrated' ? 'migrated' : 'resumed',
          originTaskId: meta.originTaskId || currentTaskId || null,
          inheritedTaskIds: [...(meta.inheritedTaskIds || [])],
          completeness: meta.provenanceCompleteness || 'partial',
        }
  return { key, sessionRef: stored, sessionMeta: meta, provenance }
}

function resolveSessionRef(options) {
  return resolveSessionState(options).sessionRef
}

function promptMessageText(message, limit = 20000) {
  const attachmentNote = message.attachments?.length
    ? `[Attached files: ${message.attachments.map(item => item.name).join(', ')}]`
    : ''
  return cleanText([message.content, attachmentNote].filter(Boolean).join(' '), limit)
}

function stableUserMessages(state, groupId, threadRootId = '') {
  const userMessages = state.messages.filter(message => (
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
  return selected.filter((message) => {
    if (seen.has(message.id)) return false
    seen.add(message.id)
    return true
  })
}

function stableUserInstructions(state, groupId, threadRootId = '') {
  return stableUserMessages(state, groupId, threadRootId)
    .map(message => promptMessageText(message, STABLE_USER_TURN_TEXT_LIMIT))
    .filter(Boolean)
    .join('\n')
}

function recentTranscriptEntries(state, groupId, afterAgentKind = '') {
  let afterIndex = -1
  if (afterAgentKind) {
    for (let index = state.messages.length - 1; index >= 0; index -= 1) {
      const message = state.messages[index]
      if (message.groupId === groupId && message.agentKind === afterAgentKind
          && (message.role === 'agent' || isTracedAgentTerminalMessage(message))) {
        afterIndex = index
        break
      }
    }
  }
  return state.messages
    .filter((message, index) => (
      index > afterIndex && message.groupId === groupId
        && (['user', 'agent'].includes(message.role) || isTracedAgentTerminalMessage(message))
    ))
    .slice(-RECENT_TRANSCRIPT_MESSAGE_LIMIT)
}

function packedPromptContext({ state, groupId, afterAgentKind = '', threadRootId = '', agentLabel }) {
  const stableMessages = stableUserMessages(state, groupId, threadRootId)
  const stableMessageIds = new Set(stableMessages.map(message => message.id))
  const stable = packContextEntries(
    stableMessages.map(message => ({
      id: message.id,
      sender: message.senderName,
      text: promptMessageText(message, STABLE_USER_TURN_TEXT_LIMIT),
      priority: 3,
    })),
    { budget: STABLE_CONTEXT_TEXT_LIMIT, entryLimit: STABLE_USER_TURN_TEXT_LIMIT, maxEntries: 8 },
  )
  const recent = packContextEntries(
    recentTranscriptEntries(state, groupId, afterAgentKind)
      .filter(message => !stableMessageIds.has(message.id))
      .map((message) => {
        const traced = (message.role === 'agent' && message.trace)
          || isTracedAgentTerminalMessage(message)
        return {
          id: message.id,
          sender: traced ? '' : message.senderName,
          text: traced
            ? evidenceCapsuleText(message, agentLabel(message.agentKind))
            : promptMessageText(message),
          priority: message.role === 'user' ? 3 : (traced ? 2 : 1),
        }
      }),
    {
      budget: RECENT_TRANSCRIPT_TEXT_LIMIT,
      entryLimit: 3000,
      maxEntries: RECENT_TRANSCRIPT_MESSAGE_LIMIT,
    },
  )
  const sourceMessageIds = [...new Set([
    ...stable.sourceMessageIds,
    ...recent.sourceMessageIds,
  ])].slice(0, 32)
  const selectedSourceIds = new Set(sourceMessageIds)
  const sourceEntries = [...stable.sourceEntries, ...recent.sourceEntries]
    .filter((entry, index, entries) => (
      selectedSourceIds.has(entry.id)
      && entries.findIndex(candidate => candidate.id === entry.id) === index
    ))
  return {
    stableText: stable.text || '(none)',
    recentText: recent.text || '(none)',
    sourceMessageIds,
    sourceEntries,
    context: {
      includedCount: sourceMessageIds.length,
      omittedCount: stable.omittedCount + recent.omittedCount,
      charCount: stable.charCount + recent.charCount,
    },
  }
}

function promptFor({
  group,
  kind,
  mode,
  skillHints = [],
  knowledgeBaseHints = [],
  packed,
  agentLabel,
}) {
  const label = agentLabel(kind)
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
          'Deliverable capture contract: Save or copy each final document, code file, diff, structured-data file, media file, or bundle into .meldwork-output/ in the conversation working directory.',
          'Only files created or changed during this run are captured as durable outputs. Do not claim a deliverable exists until the real file has been written there.',
          'When the user asks for an image, audio, or video, do not claim it was generated unless a real file exists.',
          'Supported chat attachments include common images, media, documents, source code, configuration text, and archives. Other recognized outputs remain durable Artifacts.',
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
    packed.stableText,
    'Recent conversation across the group:',
    packed.recentText,
    skillHintsPrompt(skillHints),
    knowledgeBaseHintsPrompt(knowledgeBaseHints),
  ].filter(Boolean).join('\n')
}

module.exports = {
  clearSessionState,
  openClawSessionRef,
  packedPromptContext,
  promptFor,
  promptMessageText,
  recentTranscriptEntries,
  resolveSessionRef,
  resolveSessionState,
  sessionKey,
  stableUserInstructions,
  stableUserMessages,
}
