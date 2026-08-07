const assert = require('node:assert/strict')
const test = require('node:test')

const contracts = require('../src/local-workspace-contracts.cjs')
const inputs = require('../src/local-workspace-inputs.cjs')
const messageRecords = require('../src/local-workspace-message-records.cjs')
const runtimeContracts = require('../src/local-workspace-runtime-contracts.cjs')
const localWorkspaceApi = require('../src/local-workspace.cjs')

const EXPECTED_EXPORTS = [
  'AGENT_LABELS',
  'AGENT_TERMINAL_SYSTEM_KEYS',
  'ATTACHMENT_ID',
  'AUTO_CONSENSUS_MARKER',
  'CUSTOM_AGENT_KIND',
  'DEFAULT_AUTO_ROUNDS',
  'DEFAULT_RUN_ABORT_GRACE_MS',
  'DEFAULT_RUN_AGENT_TIMEOUT_MS',
  'DEFAULT_RUN_SILENCE_WARNING_MS',
  'HERMES_WORKSPACE_ACP_ENABLED',
  'KNOWLEDGE_BASE_KINDS',
  'MAX_ATTACHMENT_BYTES',
  'MAX_KNOWLEDGE_BASE_HINTS',
  'MAX_MESSAGE_ATTACHMENTS',
  'MAX_SKILL_HINTS',
  'MAX_SYSTEM_PARAM_TEXT_CHARS',
  'RECENT_TRANSCRIPT_MESSAGE_LIMIT',
  'RECENT_TRANSCRIPT_TEXT_LIMIT',
  'RECOVERABLE_AGENT_STATUSES',
  'RUN_LEDGER_CHECKPOINT_DELAY_MS',
  'RUN_STATUSES',
  'SESSION_KEY',
  'STABLE_CONTEXT_TEXT_LIMIT',
  'STABLE_USER_TURN_TEXT_LIMIT',
  'STABLE_USER_TURNS_PER_EDGE',
  'USER_ATTACHMENT_MIME_TYPES',
  'abortableOperation',
  'agentStoppedError',
  'attachmentLimitError',
  'attachmentType',
  'cleanCurrentRound',
  'cleanElapsedMs',
  'cleanInline',
  'cleanProgressSteps',
  'cleanRunMaxRounds',
  'cleanText',
  'credentialFailure',
  'defaultAgentLabel',
  'emptyState',
  'isTracedAgentTerminalMessage',
  'isSupportedAgentKind',
  'knowledgeBaseHintsPrompt',
  'normalizeAttachmentMetadata',
  'normalizeAutoRounds',
  'normalizeKnowledgeBaseHint',
  'normalizeLoadedGroup',
  'normalizeLoadedMessage',
  'normalizeSessionRef',
  'normalizeSkillHint',
  'normalizeTargetKinds',
  'parseAutoReply',
  'settleWithin',
  'skillHintsPrompt',
  'terminalMessageContent',
  'terminalMessageContentLimit',
  'terminalStatusPrefix',
  'terminalStatusPrefixFromMessage',
]

test('local workspace input facade preserves its exact public API', () => {
  assert.deepEqual(Object.keys(inputs).sort(), EXPECTED_EXPORTS.sort())
})

test('local workspace input facade forwards domain exports without wrappers', () => {
  assert.equal(inputs.AGENT_LABELS, contracts.AGENT_LABELS)
  assert.equal(inputs.CUSTOM_AGENT_KIND, contracts.CUSTOM_AGENT_KIND)
  assert.equal(inputs.SESSION_KEY, contracts.SESSION_KEY)
  assert.equal(inputs.AGENT_TERMINAL_SYSTEM_KEYS, runtimeContracts.AGENT_TERMINAL_SYSTEM_KEYS)
  assert.equal(inputs.AUTO_CONSENSUS_MARKER, runtimeContracts.AUTO_CONSENSUS_MARKER)
  assert.equal(inputs.RUN_STATUSES, runtimeContracts.RUN_STATUSES)
  assert.equal(inputs.ATTACHMENT_ID, messageRecords.ATTACHMENT_ID)
  assert.equal(inputs.KNOWLEDGE_BASE_KINDS, messageRecords.KNOWLEDGE_BASE_KINDS)
  assert.equal(inputs.USER_ATTACHMENT_MIME_TYPES, messageRecords.USER_ATTACHMENT_MIME_TYPES)
  assert.equal(inputs.cleanText, contracts.cleanText)
  assert.equal(inputs.normalizeLoadedMessage, messageRecords.normalizeLoadedMessage)
  assert.equal(inputs.normalizeAttachmentMetadata, messageRecords.normalizeAttachmentMetadata)
  assert.equal(inputs.abortableOperation, runtimeContracts.abortableOperation)
  assert.equal(inputs.parseAutoReply, runtimeContracts.parseAutoReply)
  assert.equal(inputs.terminalMessageContent, runtimeContracts.terminalMessageContent)
})

test('local workspace coordinator keeps its public export unchanged', () => {
  assert.deepEqual(Object.keys(localWorkspaceApi), ['LocalWorkspace'])
})

test('persisted message normalization keeps collection ordering and terminal limits', () => {
  const validAttachment = index => ({
    id: `attachment-${index}`,
    name: `${index}.png`,
    mimeType: 'image/png',
    size: index,
  })
  const message = inputs.normalizeLoadedMessage({
    id: 'message-id',
    groupId: 'group-id',
    role: 'user',
    content: 'x'.repeat(20001),
    attachments: [
      { ...validAttachment(1), mimeType: 'image/webp' },
      validAttachment(2),
      validAttachment(3),
      validAttachment(4),
      validAttachment(5),
    ],
  })
  assert.equal(message.content.length, 20000)
  assert.deepEqual(message.attachments, [
    { ...validAttachment(1), mimeType: 'image/webp' },
    validAttachment(2), validAttachment(3), validAttachment(4),
  ])

  const terminal = inputs.normalizeLoadedMessage({
    id: 'terminal-id',
    groupId: 'group-id',
    role: 'system',
    agentKind: 'codex',
    content: 'x'.repeat(20001),
    system: { key: 'system.agentCallFailed', params: {} },
  })
  assert.equal(terminal.content.length, 20001)
})

test('runtime contracts preserve consensus and cleanup semantics', async () => {
  assert.deepEqual(
    inputs.parseAutoReply('done\n[[ROUNDRELAY_CONSENSUS:agree]]'),
    { text: 'done', consensus: true },
  )
  assert.deepEqual(
    inputs.parseAutoReply('[[ROUNDRELAY_CONSENSUS:agree]]\ndone'),
    { text: 'done', consensus: false },
  )

  let abortHandler
  let removedHandler
  const signal = {
    aborted: false,
    addEventListener(_event, handler) { abortHandler = handler },
    removeEventListener(_event, handler) { removedHandler = handler },
  }
  assert.equal(await inputs.abortableOperation(() => 'done', signal), 'done')
  assert.equal(removedHandler, abortHandler)
  assert.equal(await inputs.settleWithin(Promise.reject(new Error('failed')), 20), true)
  assert.equal(await inputs.settleWithin(new Promise(() => {}), 5), false)
})
