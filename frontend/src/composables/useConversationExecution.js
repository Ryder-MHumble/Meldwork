import { computed } from 'vue'
import { MAX_ATTACHMENTS } from './useComposerAttachments.js'

const ROLE_REVIEW_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (!value || typeof value !== 'object') throw new Error('ROLE_REVIEW_INPUT_INVALID')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('ROLE_REVIEW_INPUT_INVALID')
  }
  return `{${Object.keys(value).sort().map(key => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(',')}}`
}

async function sha256Hex(value) {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('ROLE_REVIEW_CRYPTO_UNAVAILABLE')
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function roleReviewTaskId() {
  const suffix = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `role-review-${suffix}`
}

export async function createRoleReviewWorkflow({
  taskId,
  primaryKinds,
  reviewerKind,
  arbiterKind = '',
  criteria,
}) {
  const normalizedTaskId = String(taskId || '')
  const primaries = [...new Set((primaryKinds || []).map(String).filter(Boolean))]
  const reviewer = String(reviewerKind || '')
  const arbiter = String(arbiterKind || '')
  const descriptions = (criteria || []).map(value => String(value || '').trim()).filter(Boolean)
  const participants = [...primaries, reviewer, arbiter].filter(Boolean)
  if (!ROLE_REVIEW_TASK_ID.test(normalizedTaskId)
      || !primaries.length
      || !reviewer
      || new Set(participants).size !== participants.length
      || !descriptions.length
      || descriptions.length > 32
      || descriptions.some(description => description.length > 1200)) {
    throw new Error('ROLE_REVIEW_INPUT_INVALID')
  }

  const criterionIds = descriptions.map((_, index) => `criterion-${index + 1}`)
  const primaryNodes = primaries.map((agentKind, index) => ({
    nodeId: `primary-${index + 1}`,
    role: 'primary',
    agentKind,
    dependsOn: [],
    parallelSafe: primaries.length > 1,
    criterionIds: [],
  }))
  const roles = { primary: primaries[0], reviewer }
  if (arbiter) roles.arbiter = arbiter
  const nodes = [
    ...primaryNodes,
    {
      nodeId: 'review',
      role: 'reviewer',
      agentKind: reviewer,
      dependsOn: primaryNodes.map(node => node.nodeId),
      parallelSafe: false,
      criterionIds,
    },
  ]
  if (arbiter) {
    nodes.push({
      nodeId: 'arbitrate',
      role: 'arbiter',
      agentKind: arbiter,
      dependsOn: ['review'],
      parallelSafe: false,
      criterionIds,
    })
  }
  const body = {
    version: 1,
    recordType: 'workflow-definition',
    taskId: normalizedTaskId,
    template: 'role-review',
    roles,
    criteria: descriptions.map((description, index) => ({
      criterionId: criterionIds[index],
      kind: 'artifact',
      description,
      required: true,
      requiredEvidenceLevel: 'observed',
    })),
    nodes,
  }
  return {
    workflowId: `workflow-${await sha256Hex(canonicalJson(body))}`,
    ...body,
  }
}

export function useConversationExecution({
  activeGroup,
  activeRun,
  attachmentLimitMessage,
  composerAttachmentSupported,
  composerAttachments,
  composerContextVersion,
  composerMode,
  composerTargetKinds,
  composerTargetsReady,
  discardAttachments,
  draft,
  importingAttachment,
  maxRounds,
  normalizeSnapshot,
  notify,
  readyAgentKinds,
  restoreComposerContext,
  roundSettingsOpen,
  safeAttachmentPayload,
  sending,
  serializeComposerContext,
  showError,
  snapshot,
  t,
  unlimitedRounds,
  workspace,
  captureComposerContext,
  clearComposerContext,
}) {
  const canSendMessage = computed(() => (
    composerTargetsReady.value
    && (composerMode.value !== 'auto' || composerTargetKinds.value.length >= 2)
    && !importingAttachment.value
    && composerAttachmentSupported.value
    && Boolean(draft.value.trim() || composerAttachments.value.length)
  ))

  async function sendMessage() {
    if (!activeGroup.value || sending.value || activeRun.value || importingAttachment.value) return
    const groupId = activeGroup.value.id
    const contextVersion = composerContextVersion.value
    const text = draft.value.trim()
    const attachments = composerAttachments.value.map(safeAttachmentPayload)
    const mode = composerMode.value
    if (!text && !attachments.length) {
      notify(t('composer.messageRequired'))
      return
    }
    const targets = [...composerTargetKinds.value]
    if (!targets.length) {
      notify(t('composer.selectTarget'))
      return
    }
    if (mode === 'auto' && targets.length < 2) {
      notify(t('error.autoAgentCount'))
      return
    }
    if (targets.some(kind => !readyAgentKinds.value.has(kind))) {
      notify(t('error.agentUnavailable'))
      return
    }
    if (!composerAttachmentSupported.value || attachments.length > MAX_ATTACHMENTS) {
      notify(attachmentLimitMessage())
      return
    }
    const { mentionedAgentKinds, skillHints, knowledgeBaseHints } = serializeComposerContext(targets)
    const previousComposerContext = captureComposerContext()
    const previousAttachments = composerAttachments.value.map(attachment => ({ ...attachment }))
    clearComposerContext()
    composerAttachments.value = []
    roundSettingsOpen.value = false
    sending.value = true
    try {
      await workspace.value.send({
        groupId,
        text,
        targetKinds: targets,
        ...(mentionedAgentKinds.length ? { mentionedAgentKinds } : {}),
        skillHints,
        knowledgeBaseHints,
        attachments,
        mode,
        maxRounds: maxRounds.value,
        ...(mode === 'auto' && unlimitedRounds.value ? { unlimitedRounds: true } : {}),
      })
      snapshot.value = normalizeSnapshot(await workspace.value.get())
    } catch (error) {
      if (contextVersion === composerContextVersion.value && groupId === activeGroup.value?.id) {
        restoreComposerContext(previousComposerContext)
        composerAttachments.value = previousAttachments
      } else {
        void discardAttachments(previousAttachments)
      }
      showError(error)
    } finally {
      sending.value = false
    }
  }

  async function sendRoleReview({
    text,
    primaryKinds,
    reviewerKind,
    arbiterKind = '',
    criteria,
  } = {}) {
    if (!activeGroup.value || sending.value || activeRun.value || importingAttachment.value) return
    const groupId = activeGroup.value.id
    const contextVersion = composerContextVersion.value
    const taskText = String(text || '').trim()
    const primaries = [...new Set((primaryKinds || []).map(String).filter(Boolean))]
    const reviewer = String(reviewerKind || '')
    const arbiter = String(arbiterKind || '')
    const targets = [...new Set([...primaries, reviewer, arbiter].filter(Boolean))]
    const groupKinds = new Set(activeGroup.value.agentKinds || [])
    if (!taskText) {
      notify(t('composer.messageRequired'))
      return
    }
    if (!primaries.length || !reviewer || targets.some(kind => !groupKinds.has(kind))) {
      notify(t('roleReview.invalidRoles'))
      return
    }
    if (targets.some(kind => !readyAgentKinds.value.has(kind))) {
      notify(t('error.agentUnavailable'))
      return
    }
    const attachments = composerAttachments.value.map(safeAttachmentPayload)
    if (attachments.length > MAX_ATTACHMENTS) {
      notify(attachmentLimitMessage())
      return
    }
    const serializedContext = serializeComposerContext(primaries)
    const primarySet = new Set(primaries)
    const mentionedAgentKinds = serializedContext.mentionedAgentKinds
      .filter(kind => primarySet.has(kind))
    const previousComposerContext = {
      ...captureComposerContext(),
      draft: taskText,
    }
    const previousAttachments = composerAttachments.value.map(attachment => ({ ...attachment }))
    sending.value = true
    let workflow
    try {
      workflow = await createRoleReviewWorkflow({
        taskId: roleReviewTaskId(),
        primaryKinds: primaries,
        reviewerKind: reviewer,
        arbiterKind: arbiter,
        criteria,
      })
    } catch (error) {
      showError(error)
      sending.value = false
      return
    }
    clearComposerContext()
    composerAttachments.value = []
    roundSettingsOpen.value = false
    try {
      await workspace.value.send({
        groupId,
        text: taskText,
        targetKinds: targets,
        ...(mentionedAgentKinds.length ? { mentionedAgentKinds } : {}),
        skillHints: serializedContext.skillHints,
        knowledgeBaseHints: serializedContext.knowledgeBaseHints,
        attachments,
        workflow,
      })
      snapshot.value = normalizeSnapshot(await workspace.value.get())
    } catch (error) {
      if (contextVersion === composerContextVersion.value && groupId === activeGroup.value?.id) {
        restoreComposerContext(previousComposerContext)
        composerAttachments.value = previousAttachments
      } else {
        void discardAttachments(previousAttachments)
      }
      showError(error)
    } finally {
      sending.value = false
    }
  }

  async function stopRun() {
    const groupId = activeGroup.value?.id
    const runId = activeRun.value?.runId
    if (!groupId || !runId) return
    try { await workspace.value.stop(groupId, runId) } catch (error) { showError(error) }
  }

  return { canSendMessage, sendMessage, sendRoleReview, stopRun }
}
