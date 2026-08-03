import { ref } from 'vue'
import en from './locales/en.js'
import zh from './locales/zh.js'

const messages = { en, zh }

function initialLocale() {
  try {
    const saved = localStorage.getItem('roundrelay-locale')
    if (saved === 'en' || saved === 'zh') return saved
  } catch { /* localStorage may be unavailable */ }
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

export const locale = ref(initialLocale())

export function setLocale(value) {
  locale.value = value === 'zh' ? 'zh' : 'en'
  if (typeof document !== 'undefined') document.documentElement.lang = locale.value === 'zh' ? 'zh-CN' : 'en'
  try { localStorage.setItem('roundrelay-locale', locale.value) } catch { /* noop */ }
}

function expandParam(name, params, depth, trail) {
  const value = String(params[name])
  if (depth <= 0) return value
  return value.replace(/\{([^{}]+)\}/g, (placeholder, nestedName) => {
    if (!Object.hasOwn(params, nestedName) || trail.has(nestedName)) return placeholder
    return expandParam(nestedName, params, depth - 1, new Set([...trail, nestedName]))
  })
}

export function t(key, params = {}, options = {}) {
  const template = messages[locale.value]?.[key] ?? messages.en[key] ?? key
  const values = params && typeof params === 'object' ? params : {}
  const expandedNames = new Set(Array.isArray(options?.expand) ? options.expand : [])
  const requestedDepth = Number(options?.maxDepth)
  const maxDepth = Number.isInteger(requestedDepth) ? Math.max(0, Math.min(5, requestedDepth)) : 3
  return template.replace(/\{([^{}]+)\}/g, (placeholder, name) => {
    if (!Object.hasOwn(values, name)) return placeholder
    return expandedNames.has(name)
      ? expandParam(name, values, maxDepth, new Set([name]))
      : String(values[name])
  })
}

export function messageKeys(language) {
  return Object.keys(messages[language] || {}).sort()
}

export const DESKTOP_ERROR_MESSAGE_KEYS = Object.freeze({
  LOCAL_WORKSPACE_UNAVAILABLE: 'error.workspaceUnavailable',
  LOCAL_GROUP_AGENT_REQUIRED: 'error.groupAgentRequired',
  LOCAL_GROUP_NOT_FOUND: 'error.groupNotFound',
  INSTALL_AGENT_BUSY: 'error.installBusy',
  INSTALL_AGENT_NODE_REQUIRED: 'error.installNode',
  INSTALL_AGENT_PLATFORM_UNSUPPORTED: 'error.installUnsupported',
  INSTALL_AGENT_UNSUPPORTED: 'error.installUnsupported',
  INSTALL_AGENT_DOWNLOAD_BLOCKED: 'error.installDownloadBlocked',
  INSTALL_AGENT_DOWNLOAD_FAILED: 'error.installDownloadFailed',
  INSTALL_AGENT_COMMAND_BLOCKED: 'error.installCommandBlocked',
  INSTALL_AGENT_PROCESS_FAILED: 'error.installProcessFailed',
  INSTALL_AGENT_ALREADY_INSTALLED: 'error.installAlreadyInstalled',
  INSTALL_AGENT_FAILED: 'error.installFailed',
  INSTALL_AGENT_VERIFY_FAILED: 'error.installVerify',
  PROVIDER_CREDENTIAL_REQUIRED: 'error.providerRequired',
  PROVIDER_ENCRYPTION_FAILED: 'error.providerEncryption',
  PROVIDER_ENCRYPTION_UNAVAILABLE: 'error.providerEncryption',
  PROVIDER_INVALID_CREDENTIAL: 'error.providerEncryption',
  PROVIDER_CREDENTIAL_UNAVAILABLE: 'error.providerEncryption',
  PROVIDER_INVALID_METADATA: 'error.providerMetadata',
  PROVIDER_INSECURE_BASE_URL: 'error.providerMetadata',
  PROVIDER_STORAGE_PATH_REQUIRED: 'error.generic',
  OPENCLAW_PROVIDER_INVALID: 'error.providerMetadata',
  LOCAL_GROUP_RUNNING: 'error.groupRunning',
  LOCAL_MESSAGE_NOT_FOUND: 'error.messageNotFound',
  LOCAL_MESSAGE_REQUIRED: 'error.messageRequired',
  LOCAL_MESSAGE_TARGET_REQUIRED: 'error.messageTargetRequired',
  LOCAL_AGENT_NOT_INSTALLED: 'error.agentUnavailable',
  LOCAL_AGENT_UNAVAILABLE: 'error.agentUnavailable',
  LOCAL_AGENT_ALL_CALLS_FAILED: 'error.allAgentsFailed',
  LOCAL_AUTO_AGENT_COUNT: 'error.autoAgentCount',
  LOCAL_AUTO_THREAD_REQUIRED: 'error.autoThreadRequired',
  LOCAL_AGENT_EXECUTION_STOPPED: 'error.executionStopped',
  LOCAL_AGENT_TIMEOUT: 'error.agentTimeout',
  LOCAL_CLI_WRAPPER_UNSUPPORTED: 'error.cliWrapperUnsupported',
  CODEX_SANDBOX_UNSUPPORTED: 'error.codexSandboxUnsupported',
  LOCAL_AGENT_KIND_UNSUPPORTED: 'error.agentKindUnsupported',
  LOCAL_AGENT_AUTH_REQUIRED: 'error.agentAuthRequired',
  LOCAL_AGENT_PROCESS_FAILED: 'error.agentProcessFailed',
  LOCAL_AGENT_EXITED: 'error.agentExited',
  LOCAL_AGENT_EMPTY_RESPONSE: 'error.agentEmptyResponse',
  LOCAL_AGENT_UNKNOWN_FAILURE: 'error.agentUnknownFailure',
  LOCAL_AGENT_SPAWN_FAILED: 'error.agentSpawnFailed',
  CUSTOM_AGENT_LIMIT: 'error.customAgentLimit',
  CUSTOM_AGENT_LABEL_REQUIRED: 'error.customAgentLabel',
  CUSTOM_AGENT_DESCRIPTION_INVALID: 'error.customAgentDescription',
  CUSTOM_AGENT_ARGUMENTS_INVALID: 'error.customAgentArguments',
  CUSTOM_AGENT_SECRET_ARGUMENT_BLOCKED: 'error.customAgentSecret',
  CUSTOM_AGENT_PROMPT_MODE_INVALID: 'error.customAgentPromptMode',
  CUSTOM_AGENT_EXECUTABLE_INVALID: 'error.customAgentExecutable',
  CUSTOM_AGENT_EXECUTABLE_UNSUPPORTED: 'error.customAgentExecutableUnsupported',
  CUSTOM_AGENT_ID_UNAVAILABLE: 'error.customAgentUnavailable',
  CUSTOM_AGENT_NOT_FOUND: 'error.customAgentUnavailable',
  CUSTOM_AGENT_IN_USE: 'error.customAgentInUse',
  CUSTOM_AGENT_PROMPT_INVALID: 'error.customAgentPrompt',
  CUSTOM_AGENT_OUTPUT_LIMIT: 'error.customAgentOutputLimit',
  CUSTOM_AGENT_SPAWN_FAILED: 'error.customAgentSpawn',
  CUSTOM_AGENT_PROCESS_FAILED: 'error.customAgentProcess',
  LOCAL_AGENT_IMAGE_UNSUPPORTED: 'error.imageUnsupported',
  LOCAL_AGENT_IMAGE_LIMIT: 'error.imageLimit',
  LOCAL_AGENT_MEDIA_UNSUPPORTED: 'error.mediaUnsupported',
  LOCAL_AGENT_MEDIA_LIMIT: 'error.mediaLimit',
  LOCAL_ATTACHMENT_BYTES_INVALID: 'error.attachmentInvalid',
  LOCAL_ATTACHMENT_COUNT_LIMIT: 'error.attachmentLimit',
  LOCAL_ATTACHMENT_CREATE_ID_INVALID: 'error.attachmentUnavailable',
  LOCAL_ATTACHMENT_FILE_MISSING: 'error.attachmentUnavailable',
  LOCAL_ATTACHMENT_ID_CONFLICT: 'error.attachmentUnavailable',
  LOCAL_ATTACHMENT_ID_INVALID: 'error.attachmentInvalid',
  LOCAL_ATTACHMENT_INPUT_INVALID: 'error.attachmentInvalid',
  LOCAL_ATTACHMENT_NOT_FOUND: 'error.attachmentUnavailable',
  LOCAL_ATTACHMENT_REFERENCE_INVALID: 'error.attachmentInvalid',
  LOCAL_ATTACHMENT_ROOT_REQUIRED: 'error.attachmentUnavailable',
  LOCAL_ATTACHMENT_ROOT_UNSAFE: 'error.attachmentUnavailable',
  LOCAL_ATTACHMENT_SOURCE_INVALID: 'error.attachmentInvalid',
  LOCAL_ATTACHMENT_SOURCE_UNAVAILABLE: 'error.attachmentUnavailable',
  LOCAL_ATTACHMENT_SOURCE_UNSAFE: 'error.attachmentUnavailable',
  LOCAL_ATTACHMENT_STORAGE_UNAVAILABLE: 'error.attachmentUnavailable',
  LOCAL_ATTACHMENT_TAMPERED: 'error.attachmentUnavailable',
  LOCAL_ATTACHMENT_TOO_LARGE: 'error.attachmentTooLarge',
  LOCAL_ATTACHMENT_TYPE_MISMATCH: 'error.attachmentType',
  LOCAL_ATTACHMENT_TYPE_UNSUPPORTED: 'error.attachmentType',
  LOCAL_SKILL_LIMIT: 'error.skillLimit',
  LOCAL_SKILL_SELECTION_INVALID: 'error.skillInvalid',
  LOCAL_KNOWLEDGE_BASE_SELECTION_INVALID: 'error.knowledgeBaseInvalid',
})

const LEGACY_ERROR_PATTERNS = [
  [/Desktop workspace is unavailable/i, 'error.workspaceUnavailable'],
  [/PROVIDER_ENCRYPTION/i, 'error.providerEncryption'],
  [/active run/i, 'error.groupRunning'],
]

function translatedErrorKey(error) {
  const raw = String(error?.code || error?.message || error || '').trim()
  const codes = raw.toUpperCase().match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) || []
  for (const code of codes) {
    if (DESKTOP_ERROR_MESSAGE_KEYS[code]) return DESKTOP_ERROR_MESSAGE_KEYS[code]
  }
  return LEGACY_ERROR_PATTERNS.find(([pattern]) => pattern.test(raw))?.[1] || ''
}

export function translateError(error) {
  const key = translatedErrorKey(error)
  return key ? t(key) : t('error.generic')
}

export function translateSystemMessage(message) {
  const key = String(message?.system?.key || '')
  const hasTranslation = Object.hasOwn(messages[locale.value] || {}, key) || Object.hasOwn(messages.en, key)
  if (!key || !hasTranslation) return String(message?.content || '')
  const params = { ...(message.system?.params || {}) }
  const reasonKey = translatedErrorKey(params.reason)
  if (reasonKey) params.reason = t(reasonKey)
  return t(key, params)
}

setLocale(locale.value)
