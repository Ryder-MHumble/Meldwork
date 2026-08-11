const path = require('node:path')
const { KNOWLEDGE_BASE_SOURCES } = require('./local-knowledge-base-catalog.cjs')
const {
  classifyLoginState,
  classifyPermissionState,
  commandBaseName,
  parseProbeJson,
  pathDetails,
  pathExists,
  probeArgsFor,
  reportedProbeErrorCode,
  resolveCommandPath,
  runProbe,
  runtimeOptions,
  sourceCommandDetails,
  stableProbeErrorCode,
} = require('./local-knowledge-base-probe-runtime.cjs')

async function probeCloudSource(source, options = {}) {
  const commandPath = await resolveCommandPath(source.commandCandidates, options)
  if (!commandPath) {
    return {
      kind: source.kind,
      label: source.label,
      badge: source.badge,
      type: source.type,
      installed: false,
      configured: false,
      connected: false,
      loginState: 'missing',
      permissionState: 'unknown',
      readable: false,
      writable: false,
      probeState: 'ready',
      errorCode: '',
    }
  }
  const primaryProbe = await runProbe(commandPath, probeArgsFor(source, commandPath, 'login', options), options)
  const primaryOutput = String(primaryProbe.stdout || '')
  const primaryJson = parseProbeJson(primaryOutput)
  const loginState = source.kind === 'feishu'
    && commandBaseName(commandPath, options) === 'lark-cli'
    && primaryJson?.identities?.user?.status === 'missing'
    ? 'missing'
    : classifyLoginState(primaryOutput, primaryProbe.code, primaryProbe.stderr)
  const primaryProbeErrorCode = primaryProbe.errorCode || reportedProbeErrorCode(primaryOutput)
  const primaryErrorCode = primaryProbeErrorCode && loginState !== 'missing'
    ? primaryProbeErrorCode
    : ''
  let permissionState = 'unknown'
  let permissionProbe = null
  const permissionArgs = probeArgsFor(source, commandPath, 'permission', options)
  if (loginState === 'ready' && permissionArgs.length) {
    permissionProbe = await runProbe(commandPath, permissionArgs, options)
    permissionState = classifyPermissionState(
      permissionProbe.stdout,
      permissionProbe.code,
      loginState,
      permissionProbe.stderr,
    )
  }
  const permissionProbeErrorCode = permissionProbe
    ? permissionProbe.errorCode || reportedProbeErrorCode(permissionProbe.stdout)
    : ''
  const permissionErrorCode = permissionProbeErrorCode && permissionState !== 'needs-grant'
    ? permissionProbeErrorCode
    : ''
  const probeState = primaryErrorCode || permissionErrorCode ? 'error' : 'ready'
  const configured = loginState === 'ready'
  const connected = configured && probeState === 'ready'
  const readable = connected && permissionState === 'ready'
  return {
    kind: source.kind,
    label: source.label,
    badge: source.badge,
    type: source.type,
    installed: true,
    configured,
    connected,
    loginState,
    permissionState,
    readable,
    writable: false,
    ...sourceCommandDetails(source, commandPath, options),
    probeState,
    errorCode: primaryErrorCode || permissionErrorCode,
  }
}

async function probeObsidianSource(source, options = {}) {
  const commandPath = await resolveCommandPath(source.commandCandidates, options)
  const versionProbe = commandPath
    ? await runProbe(commandPath, probeArgsFor(source, commandPath, 'version', options), options)
    : null
  let appPath = ''
  if (!commandPath || !versionProbe?.ok) {
    const { platform, home, pathApi } = runtimeOptions(options)
    const appCandidates = platform === 'darwin'
      ? [
          '/Applications/Obsidian.app',
          pathApi.join(home, 'Applications', 'Obsidian.app'),
        ]
      : platform === 'win32'
        ? [
            path.win32.join('C:\\', 'Program Files', 'Obsidian', 'Obsidian.exe'),
            path.win32.join('C:\\', 'Program Files (x86)', 'Obsidian', 'Obsidian.exe'),
          ]
        : []
    for (const candidate of appCandidates) {
      if (await pathExists(candidate, options)) {
        appPath = candidate
        break
      }
    }
  }
  const installed = Boolean(appPath || (commandPath && versionProbe?.ok))
  const probeErrorCode = versionProbe?.errorCode && !appPath ? versionProbe.errorCode : ''
  return {
    kind: source.kind,
    label: source.label,
    badge: source.badge,
    type: source.type,
    installed,
    loginState: 'ready',
    permissionState: 'ready',
    commandName: commandPath ? commandBaseName(commandPath, options) : 'Obsidian app',
    probeState: probeErrorCode ? 'error' : 'ready',
    errorCode: probeErrorCode,
  }
}

async function probeRemoteSource(source, options = {}) {
  const storeState = options.store?.state?.() || {}
  const remoteState = storeState.knowledgeBases?.[source.kind] || {}
  const configured = Boolean(remoteState.configured || remoteState.connected)
  return {
    kind: source.kind,
    label: source.label,
    badge: source.badge,
    type: source.type,
    accessMode: source.accessMode,
    installed: configured,
    configured,
    connected: Boolean(remoteState.connected || remoteState.ready || configured),
    authState: configured ? (remoteState.authState || 'ready') : 'missing',
    permissionState: configured ? (remoteState.permissionState || 'ready') : 'unknown',
    readable: Boolean(remoteState.readable ?? configured),
    writable: Boolean(remoteState.writable ?? configured),
    vaultPath: String(remoteState.vaultPath || ''),
    probeState: 'ready',
    errorCode: '',
  }
}

async function resolveKnowledgeBaseSources(options = {}) {
  const storeState = options.store?.state?.() || { obsidianVaultPath: '' }
  const sources = []
  const targetKind = String(options.kind || '').trim()
  const catalog = targetKind
    ? KNOWLEDGE_BASE_SOURCES.filter(source => source.kind === targetKind)
    : KNOWLEDGE_BASE_SOURCES
  for (const source of catalog) {
    let resolved
    try {
      resolved = source.accessMode === 'vault'
        ? await probeObsidianSource(source, options)
        : source.accessMode === 'cli'
          ? await probeCloudSource(source, options)
          : await probeRemoteSource(source, options)
    } catch (error) {
      resolved = {
        kind: source.kind,
        label: source.label,
        badge: source.badge,
        type: source.type,
        accessMode: source.accessMode,
        installed: false,
        configured: false,
        connected: false,
        loginState: 'unknown',
        permissionState: 'unknown',
        readable: false,
        writable: false,
        probeState: 'error',
        errorCode: stableProbeErrorCode(error),
      }
    }
    const vaultPath = source.kind === 'obsidian' ? String(storeState.obsidianVaultPath || '') : ''
    const vaultDetails = source.kind === 'obsidian'
      ? await pathDetails(vaultPath, options)
      : null
    const probeReady = resolved.probeState === 'ready'
    const configured = source.accessMode === 'vault'
      ? Boolean(resolved.installed && vaultPath && vaultDetails?.directory)
      : Boolean(resolved.configured)
    const connected = source.accessMode === 'vault'
      ? Boolean(configured && probeReady)
      : Boolean(resolved.connected)
    const readable = source.accessMode === 'vault'
      ? Boolean(connected && vaultDetails?.readable)
      : Boolean(resolved.readable)
    const writable = source.accessMode === 'vault'
      ? Boolean(connected && vaultDetails?.writable)
      : Boolean(resolved.writable)
    const ready = probeReady && (source.accessMode === 'vault'
      ? Boolean(readable && writable)
      : source.accessMode === 'cli'
        ? Boolean(resolved.installed && resolved.loginState === 'ready' && resolved.permissionState === 'ready')
        : Boolean(resolved.configured && resolved.authState === 'ready' && resolved.permissionState === 'ready'))
    sources.push({
      kind: source.kind,
      label: source.label,
      badge: source.badge,
      type: source.type,
      accessMode: source.accessMode,
      installCommand: source.installCommand || '',
      loginCommand: resolved.loginCommand || source.loginCommand || '',
      statusCommand: resolved.statusCommand || source.statusCommand || '',
      permissionCommand: resolved.permissionCommand || source.permissionCommand || '',
      commandName: resolved.commandName || '',
      installed: Boolean(resolved.installed),
      configured,
      connected,
      loginState: resolved.loginState || 'unknown',
      permissionState: resolved.permissionState || 'unknown',
      authState: resolved.authState || 'unknown',
      readable,
      writable,
      probeState: resolved.probeState || 'ready',
      errorCode: resolved.errorCode || '',
      vaultPath,
      vaultDetails,
      ready,
    })
  }
  return sources
}

module.exports = { resolveKnowledgeBaseSources }
