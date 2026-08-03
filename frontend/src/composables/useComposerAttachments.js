import { computed, ref } from 'vue'
import { errorCode } from '../desktop.js'
import { useAttachmentPreviews } from './useAttachmentPreviews.js'

export const MAX_ATTACHMENTS = 4

const MAX_ATTACHMENT_BYTES = 128 * 1024 * 1024
const ATTACHMENT_TYPES = new Set(['image', 'audio', 'video'])

export function useComposerAttachments({
  activeGroup,
  attachmentsApi,
  composerContextVersion,
  composerTargetKinds,
  composerTargetsReady,
  mergedCatalog,
  notify,
  showError,
  t,
}) {
  const composerAttachments = ref([])
  const attachmentImportOperations = ref([])
  let attachmentImportSequence = 0

  function attachmentKind(attachment) {
    const mimeType = String(attachment?.mimeType || '').toLowerCase()
    if (mimeType.startsWith('image/')) return 'image'
    if (mimeType.startsWith('audio/')) return 'audio'
    if (mimeType.startsWith('video/')) return 'video'
    return 'file'
  }

  function normalizeAttachment(attachment) {
    const id = String(attachment?.id || '')
    const name = String(attachment?.name || '')
    const mimeType = String(attachment?.mimeType || '')
    const size = Number(attachment?.size || 0)
    const previewDataUrl = String(attachment?.previewDataUrl || '')
    const kind = attachmentKind({ mimeType })
    if (!id || !name || !ATTACHMENT_TYPES.has(kind) || (kind === 'image' && !previewDataUrl)) return null
    return {
      id,
      name,
      mimeType,
      size: Number.isFinite(size) ? size : 0,
      ...(previewDataUrl ? { previewDataUrl } : {}),
    }
  }

  const {
    attachmentPreviewUrl,
    forgetAttachmentPreviews,
    rememberAttachmentPreview,
    vAttachmentPreview,
  } = useAttachmentPreviews({
    api: () => attachmentsApi.value,
    normalize: normalizeAttachment,
  })

  const importingAttachment = computed(() => attachmentImportOperations.value
    .some(operation => operation.contextVersion === composerContextVersion.value))
  function attachmentLimitFor(type) {
    const normalizedType = String(type || '')
    if (!ATTACHMENT_TYPES.has(normalizedType)) return 0
    const targets = composerTargetKinds.value
    if (!targets.length) return 0
    const limits = targets.map((kind) => {
      const agent = mergedCatalog.value.find(item => item.kind === kind)
      if (Array.isArray(agent?.attachmentTypes) && agent.attachmentTypes.includes(normalizedType)) {
        return MAX_ATTACHMENTS
      }
      return normalizedType === 'image'
        ? Math.max(0, Math.floor(Number(agent?.imageLimit) || 0))
        : 0
    })
    return Math.min(MAX_ATTACHMENTS, ...limits)
  }

  const composerAttachmentLimit = computed(() => Math.max(
    ...[...ATTACHMENT_TYPES].map(type => attachmentLimitFor(type)),
  ))
  const composerAttachmentSupported = computed(() => composerAttachments.value.every((attachment) => {
    const type = attachmentKind(attachment)
    if (!ATTACHMENT_TYPES.has(type)) return false
    return composerAttachments.value.filter(item => attachmentKind(item) === type).length <= attachmentLimitFor(type)
  }))
  const attachmentActionLabel = computed(() => {
    if (!composerTargetKinds.value.length) return t('composer.selectTarget')
    if (!composerTargetsReady.value) return t('error.agentUnavailable')
    return composerAttachmentLimit.value > 0 ? t('composer.attachMedia') : t('composer.attachmentsUnsupported')
  })

  function safeAttachmentPayload(attachment) {
    return {
      id: String(attachment.id),
      name: String(attachment.name),
      mimeType: String(attachment.mimeType),
      size: Number(attachment.size) || 0,
    }
  }

  function messageAttachments(message) {
    return Array.isArray(message?.attachments) ? message.attachments : []
  }

  function isImageAttachment(attachment) {
    return attachmentKind(attachment) === 'image'
  }

  function attachmentMediaUrl(attachment) {
    const id = String(attachment?.id || '')
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)
        || !['audio', 'video'].includes(attachmentKind(attachment))) return ''
    return `meldwork-media://attachment/${id}`
  }

  async function discardAttachments(values) {
    if (typeof attachmentsApi.value?.discard !== 'function') return
    const ids = [...new Set(values
      .map(value => String(typeof value === 'string' ? value : value?.id || ''))
      .filter(Boolean))]
    if (!ids.length) return
    try {
      const result = await attachmentsApi.value.discard(ids)
      forgetAttachmentPreviews(Array.isArray(result?.discardedIds) ? result.discardedIds : [])
    } catch (error) {
      console.error('[Meldwork]', errorCode(error))
    }
  }

  function attachmentLimitMessage() {
    if (composerAttachmentLimit.value <= 0) return t('composer.attachmentsUnsupported')
    return composerAttachmentLimit.value < MAX_ATTACHMENTS
      ? t('composer.attachmentTypeLimit')
      : t('composer.attachmentLimit')
  }

  function addAttachments(values) {
    const normalized = values.map(normalizeAttachment).filter(Boolean)
    normalized.forEach(rememberAttachmentPreview)
    const existingIds = new Set(composerAttachments.value.map(attachment => attachment.id))
    const available = normalized.filter(attachment => !existingIds.has(attachment.id))
    const counts = new Map([...ATTACHMENT_TYPES].map(type => [
      type,
      composerAttachments.value.filter(attachment => attachmentKind(attachment) === type).length,
    ]))
    const accepted = []
    const overflow = []
    for (const attachment of available) {
      const type = attachmentKind(attachment)
      const used = counts.get(type) || 0
      if (used >= attachmentLimitFor(type) || accepted.length + composerAttachments.value.length >= MAX_ATTACHMENTS) {
        overflow.push(attachment)
        continue
      }
      counts.set(type, used + 1)
      accepted.push(attachment)
    }
    composerAttachments.value = [...composerAttachments.value, ...accepted]
    if (overflow.length) {
      notify(attachmentLimitMessage())
      void discardAttachments(overflow)
    }
  }

  function beginAttachmentImport() {
    const groupId = String(activeGroup.value?.id || '')
    if (!groupId) return null
    const operation = {
      id: ++attachmentImportSequence,
      groupId,
      contextVersion: composerContextVersion.value,
    }
    attachmentImportOperations.value = [...attachmentImportOperations.value, operation]
    return operation
  }

  function finishAttachmentImport(operation) {
    attachmentImportOperations.value = attachmentImportOperations.value.filter(item => item.id !== operation.id)
  }

  function attachmentImportIsCurrent(operation) {
    return operation.contextVersion === composerContextVersion.value
      && operation.groupId === String(activeGroup.value?.id || '')
  }

  function removeAttachment(id) {
    composerAttachments.value = composerAttachments.value.filter(attachment => attachment.id !== id)
    void discardAttachments([id])
  }

  async function pickAttachments() {
    const pick = attachmentsApi.value?.pickAttachments
    if (typeof pick !== 'function') {
      notify(t('composer.attachmentsUnavailable'))
      return
    }
    if (!composerTargetKinds.value.length) {
      notify(t('composer.selectTarget'))
      return
    }
    if (!composerTargetsReady.value) {
      notify(t('error.agentUnavailable'))
      return
    }
    if (composerAttachmentLimit.value <= 0) {
      notify(t('composer.attachmentsUnsupported'))
      return
    }
    const remainingCapacity = Math.min(
      Math.max(0, MAX_ATTACHMENTS - composerAttachments.value.length),
      composerAttachmentLimit.value,
    )
    if (!remainingCapacity) {
      notify(attachmentLimitMessage())
      return
    }
    const operation = beginAttachmentImport()
    if (!operation) return
    try {
      const result = await pick(remainingCapacity)
      const values = Array.isArray(result) ? result : (Array.isArray(result?.attachments) ? result.attachments : [])
      if (attachmentImportIsCurrent(operation)) {
        addAttachments(values)
        if (result?.truncated) notify(attachmentLimitMessage())
      } else {
        void discardAttachments(values)
      }
    } catch (error) {
      if (attachmentImportIsCurrent(operation)) showError(error)
    } finally {
      finishAttachmentImport(operation)
    }
  }

  async function handleComposerPaste(event) {
    const importAttachment = attachmentsApi.value?.importAttachment
    if (typeof importAttachment !== 'function') return
    const files = [...new Map([
      ...Array.from(event.clipboardData?.files || []),
      ...Array.from(event.clipboardData?.items || [])
        .filter(item => item.kind === 'file')
        .map(item => item.getAsFile?.())
        .filter(Boolean),
    ].map(file => [`${file.name}:${file.size}:${file.lastModified}:${file.type}`, file])).values()]
    if (!files.length) return
    event.preventDefault()
    if (importingAttachment.value) {
      notify(t('composer.attachmentImporting'))
      return
    }
    if (!composerTargetKinds.value.length) {
      notify(t('composer.selectTarget'))
      return
    }
    if (!composerTargetsReady.value) {
      notify(t('error.agentUnavailable'))
      return
    }
    const room = Math.max(0, MAX_ATTACHMENTS - composerAttachments.value.length)
    if (!room) {
      notify(attachmentLimitMessage())
      return
    }
    if (files.length > room) notify(attachmentLimitMessage())
    const operation = beginAttachmentImport()
    if (!operation) return
    try {
      const imported = []
      const attachmentCounts = new Map([...ATTACHMENT_TYPES].map(type => [
        type,
        composerAttachments.value.filter(attachment => attachmentKind(attachment) === type).length,
      ]))
      for (const file of files.slice(0, room)) {
        if (!attachmentImportIsCurrent(operation)) break
        try {
          const type = attachmentKind({ mimeType: file.type })
          if (!ATTACHMENT_TYPES.has(type) || (attachmentCounts.get(type) || 0) >= attachmentLimitFor(type)) {
            notify(attachmentLimitMessage())
            continue
          }
          if (Number(file.size) > MAX_ATTACHMENT_BYTES) {
            throw Object.assign(new Error('LOCAL_ATTACHMENT_TOO_LARGE'), {
              code: 'LOCAL_ATTACHMENT_TOO_LARGE',
            })
          }
          const bytes = new Uint8Array(await file.arrayBuffer())
          const attachment = await importAttachment({
            name: String(file.name || t('composer.pastedAttachment')),
            mimeType: String(file.type || 'application/octet-stream'),
            bytes,
          })
          if (!attachmentImportIsCurrent(operation)) {
            void discardAttachments([attachment])
            break
          }
          imported.push(attachment)
          attachmentCounts.set(type, (attachmentCounts.get(type) || 0) + 1)
        } catch (error) {
          if (attachmentImportIsCurrent(operation)) showError(error)
        }
      }
      if (attachmentImportIsCurrent(operation)) addAttachments(imported)
      else void discardAttachments(imported)
    } finally {
      finishAttachmentImport(operation)
    }
  }

  return {
    attachmentActionLabel,
    attachmentKind,
    attachmentLimitMessage,
    attachmentMediaUrl,
    attachmentPreviewUrl,
    composerAttachmentLimit,
    composerAttachmentSupported,
    composerAttachments,
    discardAttachments,
    handleComposerPaste,
    importingAttachment,
    isImageAttachment,
    messageAttachments,
    pickAttachments,
    removeAttachment,
    safeAttachmentPayload,
    vAttachmentPreview,
  }
}
