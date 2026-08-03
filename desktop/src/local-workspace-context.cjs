const { createHash } = require('node:crypto')

const {
  evidenceCapsuleText,
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

function sessionKey(groupId, kind) {
  const existingKey = `${groupId}:${kind}`
  if (SESSION_KEY.test(existingKey)) return existingKey
  const digest = createHash('sha256')
    .update(JSON.stringify([String(groupId || ''), String(kind || '')]))
    .digest('hex')
  return `session:${digest}`
}

function clearSessionState(state, groupId) {
  const existingPrefix = `${groupId}:`
  const derivedKeys = new Set(Object.keys(AGENT_LABELS).map(kind => sessionKey(groupId, kind)))
  for (const key of Object.keys(state.sessions)) {
    if (key.startsWith(existingPrefix) || derivedKeys.has(key)) delete state.sessions[key]
  }
  for (const key of Object.keys(state.sessionMeta)) {
    if (key.startsWith(existingPrefix) || derivedKeys.has(key)) delete state.sessionMeta[key]
  }
}

function openClawSessionRef(group, generation = '') {
  const groupScope = createHash('sha256').update(String(group.id || '')).digest('hex').slice(0, 20)
  const safeGeneration = String(generation || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 32)
  const suffix = safeGeneration ? `-${safeGeneration}` : ''
  return `agent:main:desktop-roundrelay-${groupScope}-openclaw${suffix}`
}

function resolveSessionRef({ state, group, kind, threadRootId = '', save }) {
  const key = sessionKey(group.id, kind)
  const legacyPrefix = `${group.id}:${kind}:thread:`
  let stateChanged = false
  const validStoredRef = (candidateKey) => {
    let candidate = normalizeSessionRef(state.sessions[candidateKey])
    if (!candidate && Object.hasOwn(state.sessions, candidateKey)) {
      delete state.sessions[candidateKey]
      stateChanged = true
    }
    if (kind === 'openclaw' && candidate) {
      const legacyScope = group.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)
      const legacyBase = `agent:main:desktop-roundrelay-${legacyScope}-openclaw`
      if (candidate === legacyBase || candidate.startsWith(`${legacyBase}-`)) {
        const generation = candidate.slice(legacyBase.length).replace(/^-/, '')
        candidate = openClawSessionRef(group, generation)
        state.sessions[candidateKey] = candidate
        delete state.sessionMeta[key]
        stateChanged = true
      }
    }
    if (kind === 'hermes' && /^roundrelay-[a-zA-Z0-9]+-hermes$/.test(candidate)) {
      delete state.sessions[candidateKey]
      stateChanged = true
      candidate = ''
    }
    if (kind === 'openclaw' && candidate && !candidate.startsWith('agent:main:desktop-')) {
      delete state.sessions[candidateKey]
      stateChanged = true
      candidate = ''
    }
    return candidate
  }

  const currentLegacyKey = threadRootId
    ? `${legacyPrefix}${cleanText(threadRootId, 100)}`
    : ''
  const legacyKeys = Object.keys(state.sessions).filter(candidate => (
    candidate.startsWith(legacyPrefix)
  ))
  const legacyActivity = (legacyKey) => {
    const rootId = legacyKey.slice(legacyPrefix.length)
    for (let index = state.messages.length - 1; index >= 0; index -= 1) {
      const message = state.messages[index]
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
      state.sessions[key] = legacyRef
      stateChanged = true
      stored = legacyRef
      break
    }
  }
  for (const legacyKey of legacyKeys) {
    if (!Object.hasOwn(state.sessions, legacyKey)) continue
    delete state.sessions[legacyKey]
    stateChanged = true
  }
  if (!stored && kind === 'openclaw') {
    state.sessions[key] = openClawSessionRef(group)
    stateChanged = true
    stored = state.sessions[key]
  }
  if (stateChanged) save()
  return stored
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
  return {
    stableText: stable.text || '(none)',
    recentText: recent.text || '(none)',
    sourceMessageIds,
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
  sessionKey,
  stableUserInstructions,
  stableUserMessages,
}
