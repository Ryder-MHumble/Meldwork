const { spawn } = require('node:child_process')
const { Readable, Writable } = require('node:stream')
const { AGENT_PROFILES, prepareCommand } = require('./cli-discovery.cjs')
const {
  acpRuntimeEvents,
  createAcpRuntimeState,
  createRuntimeEventEmitter,
  redactChildSecrets,
} = require('./cli-runtime-events.cjs')
const {
  KILL_SETTLE_MS,
  TERMINATE_GRACE_MS,
  agentExecutionError,
  childEnvironment,
  failedAgentProcessError,
} = require('./cli-process-support.cjs')

const ACP_CANCEL_GRACE_MS = 250
const ACP_MAX_LINE_BYTES = 1024 * 1024
const ACP_MAX_INPUT_BYTES = 16 * 1024 * 1024
const ACP_MAX_REPLY_BYTES = 10 * 1024 * 1024
let acpSdkPromise

function loadAcpSdk() {
  acpSdkPromise ||= Promise.all([
    import('@agentclientprotocol/sdk'),
    import('@agentclientprotocol/sdk/dist/schema/zod.gen.js'),
  ]).then(([sdk, validators]) => ({ ...sdk, validators }))
  return acpSdkPromise
}

function acpTransportError(diagnostic) {
  return agentExecutionError('LOCAL_AGENT_PROCESS_FAILED', diagnostic)
}

function validateAcpInboundMessage(message, validators, replyState, protocolLabel) {
  if (!message || typeof message !== 'object' || Array.isArray(message)
      || message.jsonrpc !== '2.0') {
    throw acpTransportError(`${protocolLabel} returned an invalid protocol message.`)
  }

  const hasId = Object.hasOwn(message, 'id')
  if (typeof message.method === 'string') {
    if (message.method === 'session/update' && !hasId) {
      const parsed = validators.zSessionNotification.safeParse(message.params)
      if (!parsed.success) {
        throw acpTransportError(`${protocolLabel} returned invalid session update parameters.`)
      }
      const update = parsed.data.update
      if (replyState.collecting !== false
          && update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
        replyState.bytes += Buffer.byteLength(update.content.text, 'utf8')
        if (replyState.bytes > ACP_MAX_REPLY_BYTES) {
          throw acpTransportError(`${protocolLabel} reply exceeded the safe output limit.`)
        }
      }
      return message
    }
    if (message.method === 'session/request_permission' && hasId) {
      const validId = typeof message.id === 'string'
        || (Number.isInteger(message.id) && message.id >= 0)
      if (!validId || !validators.zRequestPermissionRequest.safeParse(message.params).success) {
        throw acpTransportError(`${protocolLabel} returned an invalid permission request.`)
      }
      return message
    }
    throw acpTransportError(`${protocolLabel} requested an unsupported client method.`)
  }

  if (!Number.isInteger(message.id) || message.id < 0) {
    throw acpTransportError(`${protocolLabel} returned an invalid response identifier.`)
  }
  const hasResult = Object.hasOwn(message, 'result')
  const hasError = Object.hasOwn(message, 'error')
  if (hasResult === hasError) {
    throw acpTransportError(`${protocolLabel} returned an invalid response payload.`)
  }
  if (hasError) {
    const error = message.error
    if (!error || typeof error !== 'object' || Array.isArray(error)
        || !Number.isFinite(error.code) || typeof error.message !== 'string') {
      throw acpTransportError(`${protocolLabel} returned an invalid error response.`)
    }
  }
  return message
}

function boundedAcpStream(
  output, input, validators, replyState = { bytes: 0, collecting: true },
  protocolLabel = 'ACP Agent',
) {
  const textEncoder = new TextEncoder()
  const readable = new ReadableStream({
    async start(controller) {
      const reader = input.getReader()
      let pending = Buffer.alloc(0)
      let inputBytes = 0
      const parseLine = (line) => {
        const text = line.toString('utf8').trim()
        if (!text) return
        let message
        try {
          message = JSON.parse(text)
        } catch {
          throw acpTransportError(`${protocolLabel} returned malformed JSON.`)
        }
        controller.enqueue(validateAcpInboundMessage(message, validators, replyState, protocolLabel))
      }
      const append = (left, right) => {
        const size = left.length + right.length
        if (size > ACP_MAX_LINE_BYTES) {
          throw acpTransportError(`${protocolLabel} message exceeded the safe line limit.`)
        }
        return left.length ? Buffer.concat([left, right], size) : Buffer.from(right)
      }
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          if (!value?.byteLength) continue
          const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
          inputBytes += chunk.length
          if (inputBytes > ACP_MAX_INPUT_BYTES) {
            throw acpTransportError(`${protocolLabel} input exceeded the safe total limit.`)
          }
          let offset = 0
          while (offset < chunk.length) {
            const newline = chunk.indexOf(0x0a, offset)
            if (newline === -1) {
              pending = append(pending, chunk.subarray(offset))
              break
            }
            const line = append(pending, chunk.subarray(offset, newline))
            pending = Buffer.alloc(0)
            parseLine(line)
            offset = newline + 1
          }
        }
        if (pending.length) parseLine(pending)
        controller.close()
      } catch (error) {
        controller.error(error)
      } finally {
        reader.releaseLock()
      }
    },
  })
  const writable = new WritableStream({
    async write(message) {
      const writer = output.getWriter()
      try {
        await writer.write(textEncoder.encode(`${JSON.stringify(message)}\n`))
      } finally {
        writer.releaseLock()
      }
    },
  })
  return { readable, writable }
}

function permissionRejection(options) {
  return (options || []).find(option => (
    ['reject_once', 'reject_always'].includes(option.kind)
      || /reject|deny/i.test(`${option.optionId || ''} ${option.name || ''}`)
  ))
}

function destroyChildPipes(child) {
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    if (!stream?.destroyed) stream?.destroy()
  }
}

async function terminateChild(child, platform, spawnFn) {
  if (child.exitCode != null || child.signalCode != null) return
  await new Promise((resolve) => {
    let settled = false
    let forceKillTimeout
    let forceSettleTimeout
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(forceKillTimeout)
      clearTimeout(forceSettleTimeout)
      child.removeListener('close', finish)
      child.removeListener('error', finish)
      resolve()
    }
    child.once('close', finish)
    child.once('error', finish)
    if (platform === 'win32' && child.pid) {
      const killer = spawnFn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true,
      })
      killer.on('error', () => {})
      killer.unref()
      forceSettleTimeout = setTimeout(finish, TERMINATE_GRACE_MS + KILL_SETTLE_MS)
      return
    }
    const signalTree = (signal) => {
      if (child.pid) {
        try {
          process.kill(-child.pid, signal)
          return
        } catch { /* fall back to the direct child */ }
      }
      try {
        child.kill(signal)
      } catch { /* the process has already exited */ }
    }
    signalTree('SIGTERM')
    forceKillTimeout = setTimeout(() => signalTree('SIGKILL'), TERMINATE_GRACE_MS)
    forceSettleTimeout = setTimeout(finish, TERMINATE_GRACE_MS + KILL_SETTLE_MS)
  })
}

async function settleWithin(promise, timeoutMs) {
  let timeout
  await Promise.race([
    Promise.resolve(promise).catch(() => {}),
    new Promise((resolve) => {
      timeout = setTimeout(resolve, timeoutMs)
      timeout.unref?.()
    }),
  ])
  clearTimeout(timeout)
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode != null || child.signalCode != null) return true
  return new Promise((resolve) => {
    let timeout
    const finish = (exited) => {
      clearTimeout(timeout)
      child.removeListener('close', onExit)
      child.removeListener('error', onExit)
      resolve(exited)
    }
    const onExit = () => finish(true)
    child.once('close', onExit)
    child.once('error', onExit)
    timeout = setTimeout(() => finish(false), timeoutMs)
    timeout.unref?.()
  })
}

async function closeAcpChild(child, platform, spawnFn) {
  if (child.exitCode != null || child.signalCode != null) return
  if (!child.stdin?.destroyed && !child.stdin?.writableEnded) {
    try { child.stdin.end() } catch { /* the process has already closed its input */ }
  }
  if (await waitForChildExit(child, TERMINATE_GRACE_MS)) return
  await terminateChild(child, platform, spawnFn)
  destroyChildPipes(child)
}

function acpProtocolError(error, childEnv, sessionRef = '') {
  if (/^LOCAL_AGENT_[A-Z_]+$/.test(String(error?.message || ''))) return error
  const detail = redactChildSecrets(error?.diagnostic || error?.message || error, childEnv).trim()
  return detail
    ? failedAgentProcessError(detail, { sessionRef })
    : agentExecutionError('LOCAL_AGENT_PROCESS_FAILED')
}

function allowAcpSetupFallback(error) {
  if (!error || typeof error !== 'object'
      || error.message === 'LOCAL_AGENT_EXECUTION_STOPPED'
      || error.acpFallbackAllowed === true) return error
  Object.defineProperty(error, 'acpFallbackAllowed', { value: true })
  return error
}

async function runAcpAgent(agent, prompt, workdir, options, spec) {
  const platform = options.platform || process.platform
  const spawnFn = options.spawnFn || spawn
  const prepared = prepareCommand(spec.command, spec.args, { platform })
  const childEnv = childEnvironment(agent, workdir, options, platform)
  const runtimeEvents = createRuntimeEventEmitter(options, childEnv)
  const protocolLabel = `${agent.name || AGENT_PROFILES[agent.kind]?.label || 'Agent'} ACP`
  let sdk
  try {
    const loadAcpSdkFn = options.loadAcpSdkFn || loadAcpSdk
    sdk = await loadAcpSdkFn()
  } catch (error) {
    throw allowAcpSetupFallback(acpProtocolError(error, childEnv))
  }
  if (options.signal?.aborted) throw agentExecutionError('LOCAL_AGENT_EXECUTION_STOPPED')

  let child
  try {
    child = spawnFn(prepared.command, prepared.args, {
      cwd: workdir,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: platform !== 'win32',
      windowsHide: true,
    })
  } catch (error) {
    throw allowAcpSetupFallback(agentExecutionError(
      'LOCAL_AGENT_SPAWN_FAILED',
      redactChildSecrets(error?.message || error, childEnv),
    ))
  }

  const { ClientSideConnection, PROTOCOL_VERSION, validators } = sdk
  const stderr = []
  let stderrBytes = 0
  let connection
  let sessionRef = String(options.sessionRef || '')
  const resumedSessionRef = sessionRef
  let ending = false
  let abortRequested = false
  let cancelPromise = Promise.resolve()
  let stopPromise
  let rejectAbort
  let timeout
  const reply = []
  const replyState = { bytes: 0, collecting: false }
  const runtimeState = createAcpRuntimeState()
  let promptStarted = false
  const abortPromise = new Promise((_, reject) => { rejectAbort = reject })
  const stopChild = () => {
    stopPromise ||= closeAcpChild(child, platform, spawnFn)
    return stopPromise
  }
  const abort = () => {
    if (ending || abortRequested) return
    abortRequested = true
    if (connection && sessionRef) {
      try {
        cancelPromise = Promise.resolve(connection.cancel({ sessionId: sessionRef }))
          .catch(() => {})
      } catch { /* the ACP stream has already closed */ }
    }
    rejectAbort(agentExecutionError('LOCAL_AGENT_EXECUTION_STOPPED'))
  }
  const childFailure = new Promise((_, reject) => {
    child.once('error', (error) => {
      reject(abortRequested
        ? agentExecutionError('LOCAL_AGENT_EXECUTION_STOPPED')
        : agentExecutionError(
            'LOCAL_AGENT_SPAWN_FAILED',
            redactChildSecrets(error?.message || error, childEnv),
          ))
    })
    child.once('close', () => {
      if (ending) return
      if (abortRequested) {
        reject(agentExecutionError('LOCAL_AGENT_EXECUTION_STOPPED'))
        return
      }
      const detail = redactChildSecrets(Buffer.concat(stderr).toString('utf8').trim(), childEnv)
      reject(failedAgentProcessError(detail, { sessionRef: resumedSessionRef }))
    })
  })
  child.stderr.on('data', (chunk) => {
    stderrBytes += chunk.length
    if (stderrBytes <= 1024 * 1024) stderr.push(chunk)
  })
  timeout = setTimeout(abort, 2 * 60 * 60 * 1000)
  if (options.signal?.aborted) abort()
  else options.signal?.addEventListener('abort', abort, { once: true })

  const client = {
    async requestPermission(params) {
      const denied = permissionRejection(params.options)
      return denied
        ? { outcome: { outcome: 'selected', optionId: denied.optionId } }
        : { outcome: { outcome: 'cancelled' } }
    },
    async sessionUpdate(params) {
      if (!replyState.collecting) return
      const update = params.update
      if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
        reply.push(update.content.text)
      }
      for (const event of acpRuntimeEvents(update, runtimeState)) runtimeEvents.emit(event)
    },
  }
  const protocol = (async () => {
    const stream = boundedAcpStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout),
      validators,
      replyState,
      protocolLabel,
    )
    connection = new ClientSideConnection(() => client, stream)
    await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    if (sessionRef) {
      await connection.resumeSession({ sessionId: sessionRef, cwd: workdir, mcpServers: [] })
    } else {
      const session = await connection.newSession({ cwd: workdir, mcpServers: [] })
      sessionRef = session.sessionId
    }
    const safeSessionRef = redactChildSecrets(sessionRef, childEnv)
    const publicSessionRef = safeSessionRef.includes('[redacted]') ? '' : safeSessionRef
    await connection.setSessionMode({ sessionId: sessionRef, modeId: spec.acpMode })
    if (publicSessionRef && typeof options.onSessionRef === 'function') {
      await options.onSessionRef(publicSessionRef, { transport: 'acp' })
    }
    replyState.bytes = 0
    replyState.collecting = true
    let promptResult
    try {
      promptStarted = true
      promptResult = await connection.prompt({
        sessionId: sessionRef,
        prompt: [{ type: 'text', text: prompt }],
      })
    } finally {
      replyState.collecting = false
    }
    const text = redactChildSecrets(reply.join('').trim(), childEnv)
    if (!text) throw agentExecutionError('LOCAL_AGENT_EMPTY_RESPONSE')
    runtimeEvents.emitFinalAnswer(text)
    return {
      text,
      sessionRef: publicSessionRef,
      completed: promptResult?.stopReason === 'end_turn',
    }
  })().catch((error) => {
    const normalized = acpProtocolError(error, childEnv, resumedSessionRef)
    if (!promptStarted) allowAcpSetupFallback(normalized)
    throw normalized
  })

  try {
    return await Promise.race([protocol, abortPromise, childFailure])
  } catch (error) {
    if (!promptStarted) allowAcpSetupFallback(error)
    throw error
  } finally {
    ending = true
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
    if (abortRequested) await settleWithin(cancelPromise, ACP_CANCEL_GRACE_MS)
    await stopChild()
  }
}

module.exports = { runAcpAgent }
