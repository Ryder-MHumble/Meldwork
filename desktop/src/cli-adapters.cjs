const { spawn } = require('node:child_process')
const {
  ALLOWED_KINDS,
  detectAgents,
  prepareCommand,
  resolveExecutable,
  searchPath,
} = require('./cli-discovery.cjs')
const {
  classifyCliOutcome,
  claudeQwenRuntimeEvents,
  codexProgressEvent,
  codexRuntimeEvents,
  createClaudeQwenRuntimeState,
  createJsonLineParser,
  createRuntimeEventEmitter,
  hermesSessionRef,
  jsonCliRuntimeEvents,
  normalizeOpenClawOutput,
  parseClaudeQwenOutput,
  parseCodexOutput,
  parseGeminiOutput,
  parseJsonOutputEvents,
  parseKimiOutput,
  parseMimoOutput,
  parseOpenCodeOutput,
  parseOpenCodeReviewOutput,
  parseWorkBuddyOutput,
  readHermesFinalResponse,
  readHermesMessageWatermark,
  redactChildSecrets,
  runtimeCommandSummary,
  stripAnsi,
  structuredCliError,
} = require('./cli-runtime-events.cjs')
const { runAcpAgent } = require('./cli-acp-runner.cjs')
const { imageAttachmentLimit, invocation } = require('./cli-invocations.cjs')
const {
  normalizeExternalRunRef,
  requireTerminalAgentResult,
} = require('./agent-runtime-contract.cjs')
const {
  KILL_SETTLE_MS,
  TERMINATE_GRACE_MS,
  agentExecutionError,
  childEnvironment,
  failedAgentProcessError,
} = require('./cli-process-support.cjs')

const MAX_PROGRESS_STEPS = 8
const MAX_HERMES_PROGRESS_PENDING_CHARS = 64 * 1024
const MAX_STDOUT_CAPTURE_BYTES = 10 * 1024 * 1024
const MAX_STDERR_CAPTURE_BYTES = 1024 * 1024
const OUTPUT_TRUNCATION_MARKER = Buffer.from('\n[output truncated]\n')

function createBoundedOutputCapture(maxBytes) {
  const headLimit = Math.floor(maxBytes / 2)
  const tailLimit = maxBytes - headLimit
  const head = []
  const tail = []
  let headBytes = 0
  let tailBytes = 0
  let totalBytes = 0

  return {
    push(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (!bytes.length) return
      totalBytes = Math.min(maxBytes + 1, totalBytes + bytes.length)
      const headRemaining = headLimit - headBytes
      const headLength = Math.min(headRemaining, bytes.length)
      if (headLength > 0) {
        head.push(Buffer.from(bytes.subarray(0, headLength)))
        headBytes += headLength
      }
      if (headLength >= bytes.length) return
      const remainder = bytes.subarray(headLength)
      if (remainder.length >= tailLimit) {
        tail.length = 0
        tail.push(Buffer.from(remainder.subarray(remainder.length - tailLimit)))
        tailBytes = tailLimit
        return
      }
      tail.push(Buffer.from(remainder))
      tailBytes += remainder.length
      while (tailBytes > tailLimit) {
        const overflow = tailBytes - tailLimit
        if (tail[0].length <= overflow) {
          tailBytes -= tail.shift().length
        } else {
          tail[0] = Buffer.from(tail[0].subarray(overflow))
          tailBytes -= overflow
        }
      }
    },
    text() {
      const headBuffer = Buffer.concat(head, headBytes)
      const tailBuffer = Buffer.concat(tail, tailBytes)
      if (totalBytes <= maxBytes) {
        return Buffer.concat([headBuffer, tailBuffer], totalBytes).toString('utf8')
      }
      const markerOffset = Math.min(OUTPUT_TRUNCATION_MARKER.length, tailBuffer.length)
      return Buffer.concat([
        headBuffer,
        OUTPUT_TRUNCATION_MARKER,
        tailBuffer.subarray(markerOffset),
      ], maxBytes).toString('utf8')
    },
  }
}


function normalizeOutput(kind, stdout, sessionRef = '') {
  if (kind === 'codex') {
    const parsed = parseCodexOutput(stdout)
    return {
      text: parsed.text,
      sessionRef: parsed.sessionRef || sessionRef,
      ...classifyCliOutcome(kind, stdout),
    }
  }
  if (kind === 'openclaw') {
    return {
      text: normalizeOpenClawOutput(stdout),
      sessionRef,
      ...classifyCliOutcome(kind, stdout),
    }
  }
  if (kind === 'hermes') {
    return {
      text: stripAnsi(stdout).trim(),
      sessionRef,
      ...classifyCliOutcome(kind, stdout),
    }
  }
  if (kind === 'workbuddy') {
    const parsed = parseWorkBuddyOutput(stdout)
    return {
      text: parsed.text,
      sessionRef: parsed.sessionRef || sessionRef,
      ...classifyCliOutcome(kind, stdout),
    }
  }
  if (kind === 'kimi') {
    const parsed = parseKimiOutput(stdout)
    return {
      text: parsed.text,
      sessionRef: parsed.sessionRef || sessionRef,
      ...classifyCliOutcome(kind, stdout),
    }
  }
  if (kind === 'mimo') {
    return { ...parseMimoOutput(stdout), ...classifyCliOutcome(kind, stdout) }
  }
  if (kind === 'gemini') {
    const parsed = parseGeminiOutput(stdout)
    return {
      text: parsed.text,
      sessionRef: parsed.sessionRef || sessionRef,
      ...classifyCliOutcome(kind, stdout),
    }
  }
  if (kind === 'opencode') {
    const parsed = parseOpenCodeOutput(stdout)
    return {
      text: parsed.text,
      sessionRef: parsed.sessionRef || sessionRef,
      ...classifyCliOutcome(kind, stdout),
    }
  }
  if (['claude', 'qwen'].includes(kind)) {
    const parsed = parseClaudeQwenOutput(stdout)
    return {
      text: parsed.text,
      sessionRef: parsed.sessionRef || sessionRef,
      ...classifyCliOutcome(kind, stdout),
    }
  }
  if (kind === 'opencodereview') return parseOpenCodeReviewOutput(stdout)
  return { text: String(stdout || '').trim(), sessionRef, outcome: 'partial' }
}


async function runAgent(agent, prompt, workdir, options = {}) {
  if (options.signal?.aborted) throw agentExecutionError('LOCAL_AGENT_EXECUTION_STOPPED')
  const platform = options.platform || process.platform
  const spawnFn = options.spawnFn || spawn
  let sessionRef = String(options.sessionRef || '')
  const hermesAcpAvailable = typeof options.hermesAcpAvailable === 'boolean'
    ? options.hermesAcpAvailable
    : agent.acpAvailable
  const spec = invocation(agent.kind, agent.executable, workdir, sessionRef, {
    sandbox: options.sandbox,
    provider: options.provider,
    attachments: options.attachments,
    skills: options.skills,
    hermesAcpAvailable,
    sessionTransport: options.sessionTransport,
  })
  if (agent.kind === 'hermes' && !spec.acpMode && options.sessionTransport === 'acp') {
    sessionRef = ''
  }
  if (spec.acpMode) {
    try {
      return await runAcpAgent(agent, prompt, workdir, options, spec)
    } catch (error) {
      if (agent.kind !== 'hermes' || error?.acpFallbackAllowed !== true
          || options.signal?.aborted) throw error
      let fallbackPrompt = prompt
      if (sessionRef && typeof options.onSessionInvalidated === 'function') {
        const recovery = await options.onSessionInvalidated({
          kind: agent.kind,
          sessionRef,
          transport: 'acp',
        })
        if (typeof recovery === 'string') fallbackPrompt = recovery
        else if (typeof recovery?.prompt === 'string') fallbackPrompt = recovery.prompt
      }
      try {
        options.onEvent?.({
          id: 'hermes-acp-fallback',
          type: 'warning',
          status: 'waiting',
          title: 'connector_fallback',
        })
      } catch { /* runtime events are best-effort */ }
      return runAgent(agent, fallbackPrompt, workdir, {
        ...options,
        sessionRef: '',
        sessionTransport: 'legacy',
        hermesAcpAvailable: false,
        onSessionInvalidated: undefined,
      })
    }
  }
  const args = [...spec.args]
  if (spec.promptArg) args.push(prompt)
  if (spec.suffixArgs) args.push(...spec.suffixArgs)
  const prepared = prepareCommand(spec.command, args, { platform })
  const childEnv = childEnvironment(agent, workdir, options, platform)
  const runtimeEvents = createRuntimeEventEmitter(options, childEnv)
  if (['hermes', 'openclaw', 'workbuddy', 'opencodereview'].includes(agent.kind)) {
    runtimeEvents.emit({
      id: `${agent.kind}-connector`,
      type: 'warning',
      status: 'waiting',
      title: 'connector_limited',
    })
  }
  let hermesMessageWatermark = null
  if (agent.kind === 'hermes') {
    const watermarkFn = options.hermesMessageWatermarkFn || readHermesMessageWatermark
    try {
      const watermark = watermarkFn({
        home: options.home,
        existsFn: options.hermesStateExistsFn,
        queryFn: options.hermesStateQueryFn,
      })
      if (Number.isSafeInteger(watermark) && watermark >= 0) {
        hermesMessageWatermark = watermark
      }
    } catch { /* a missing pre-run watermark makes final lookup ineligible */ }
  }
  return await new Promise((resolve, reject) => {
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
      reject(agentExecutionError(
        'LOCAL_AGENT_SPAWN_FAILED',
        redactChildSecrets(error?.message || error, childEnv),
      ))
      return
    }
    const stdout = createBoundedOutputCapture(MAX_STDOUT_CAPTURE_BYTES)
    const stderr = createBoundedOutputCapture(MAX_STDERR_CAPTURE_BYTES)
    let settled = false
    let stopRequested = false
    let timeout
    let forceKillTimeout
    let forceSettleTimeout
    const progress = []
    const progressIndexes = new Map()
    let anonymousProgressId = 0
    const emitProgress = (input) => {
      const event = {
        ...(input?.id ? { id: String(input.id) } : {}),
        title: String(input?.title || 'process'),
        status: ['completed', 'failed', 'in_progress'].includes(input?.status)
          ? input.status
          : 'completed',
      }
      const progressId = event.id || `anonymous-${++anonymousProgressId}`
      const existingIndex = progressIndexes.get(progressId)
      if (existingIndex != null) {
        progress[existingIndex] = event
      } else {
        if (progress.length >= MAX_PROGRESS_STEPS) return
        progressIndexes.set(progressId, progress.length)
        progress.push(event)
      }
      try { options.onProgress?.(event) } catch { /* progress is best-effort */ }
    }
    const hermesProgressBuffers = { stdout: '', stderr: '' }
    const hermesProgressDecoders = { stdout: new TextDecoder(), stderr: new TextDecoder() }
    const emitHermesProgress = (source, chunk, flush = false) => {
      if (agent.kind !== 'hermes') return
      const decoder = hermesProgressDecoders[source]
      hermesProgressBuffers[source] += decoder.decode(chunk || undefined, { stream: !flush })
      const lines = hermesProgressBuffers[source].split(/\r?\n/)
      hermesProgressBuffers[source] = flush ? '' : (lines.pop() || '')
      if (hermesProgressBuffers[source].length > MAX_HERMES_PROGRESS_PENDING_CHARS) {
        hermesProgressBuffers[source] = ''
      }
      for (const line of lines) {
        if (!/^┊\s*review diff$/i.test(stripAnsi(line).trim())) continue
        emitProgress({ title: 'write_file', status: 'completed' })
      }
    }
    const claudeQwenRuntimeState = createClaudeQwenRuntimeState()
    const runtimeStreamParser = [
      'codex', 'kimi', 'mimo', 'claude', 'qwen', 'gemini', 'opencode',
    ].includes(agent.kind)
      ? createJsonLineParser((event) => {
          if (agent.kind === 'codex') {
            const progressEvent = codexProgressEvent(event)
            if (progressEvent) emitProgress(progressEvent)
          }
          const events = agent.kind === 'codex'
            ? codexRuntimeEvents(event)
            : ['claude', 'qwen'].includes(agent.kind)
                ? claudeQwenRuntimeEvents(event, claudeQwenRuntimeState)
                : jsonCliRuntimeEvents(agent.kind, event)
          for (const runtimeEvent of events) runtimeEvents.emit(runtimeEvent)
        })
      : null
    const finish = (callback) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearTimeout(forceKillTimeout)
      clearTimeout(forceSettleTimeout)
      options.signal?.removeEventListener('abort', abort)
      callback()
    }
    const signalProcessTree = (signal) => {
      if (platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, signal)
          return
        } catch { /* fall back to the direct child */ }
      }
      try {
        child.kill(signal)
      } catch { /* the process has already exited */ }
    }
    const abort = () => {
      if (settled || stopRequested) return
      stopRequested = true
      if (platform === 'win32' && child.pid) {
        const killer = spawnFn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore', windowsHide: true,
        })
        killer.on('error', () => {})
        killer.unref()
        forceSettleTimeout = setTimeout(() => finish(() => {
          child.stdin.destroy()
          child.stdout.destroy()
          child.stderr.destroy()
          reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED'))
        }), KILL_SETTLE_MS)
        return
      }
      signalProcessTree('SIGTERM')
      forceKillTimeout = setTimeout(() => {
        if (settled) return
        signalProcessTree('SIGKILL')
        forceSettleTimeout = setTimeout(() => finish(() => {
          child.stdin.destroy()
          child.stdout.destroy()
          child.stderr.destroy()
          reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED'))
        }), KILL_SETTLE_MS)
      }, TERMINATE_GRACE_MS)
    }
    timeout = setTimeout(abort, 2 * 60 * 60 * 1000)
    if (options.signal?.aborted) abort()
    else options.signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk) => {
      stdout.push(chunk)
      runtimeStreamParser?.write(chunk)
      emitHermesProgress('stdout', chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr.push(chunk)
      emitHermesProgress('stderr', chunk)
    })
    child.on('error', error => finish(() => reject(
      stopRequested
        ? agentExecutionError('LOCAL_AGENT_EXECUTION_STOPPED')
        : agentExecutionError(
            'LOCAL_AGENT_SPAWN_FAILED',
            redactChildSecrets(error?.message || error, childEnv),
          ),
    )))
    child.on('close', (code, signal) => finish(() => {
      void (async () => {
        emitHermesProgress('stdout', null, true)
        emitHermesProgress('stderr', null, true)
        runtimeStreamParser?.end()
        if (stopRequested || options.signal?.aborted) {
          reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED'))
          return
        }
        if (code !== 0) {
          const rawStdout = stdout.text()
          const rawStderr = stderr.text().trim()
          const structuredDetail = structuredCliError(rawStdout)
          const detail = redactChildSecrets(
            [rawStderr, structuredDetail].filter(Boolean).join('\n'),
            childEnv,
          )
          reject(failedAgentProcessError(detail, { sessionRef }))
          return
        }
        const rawStderr = stderr.text()
        const nextSessionRef = agent.kind === 'hermes'
          ? hermesSessionRef(rawStderr) || sessionRef
          : sessionRef
        const result = normalizeOutput(
          agent.kind,
          stdout.text(),
          nextSessionRef,
        )
        if (result.error) {
          reject(failedAgentProcessError(
            redactChildSecrets(result.error, childEnv),
            { sessionRef },
          ))
          return
        }
        const redactedSessionRef = redactChildSecrets(result.sessionRef, childEnv)
        const publicSessionRef = redactedSessionRef.includes('[redacted]')
          ? ''
          : redactedSessionRef
        if (agent.kind === 'hermes') {
          if (publicSessionRef && typeof options.onSessionRef === 'function') {
            await options.onSessionRef(publicSessionRef, { transport: 'legacy' })
          }
          const finalResponseFn = options.hermesFinalResponseFn || readHermesFinalResponse
          let finalResponse = ''
          if (publicSessionRef && Number.isSafeInteger(hermesMessageWatermark)) {
            try {
              finalResponse = finalResponseFn(publicSessionRef, {
                home: options.home,
                afterMessageId: hermesMessageWatermark,
                existsFn: options.hermesStateExistsFn,
                queryFn: options.hermesStateQueryFn,
              })
            } catch { /* fall back to the official --quiet stdout */ }
          }
          const storedResponse = typeof finalResponse === 'string' ? finalResponse.trim() : ''
          if (storedResponse) result.text = storedResponse
        }
        if (progress.length) result.progress = progress
        const redactedText = redactChildSecrets(result.text, childEnv)
        let output
        try {
          output = requireTerminalAgentResult({
            text: redactedText,
            sessionRef: publicSessionRef,
            outcome: result.outcome,
            ...(result.failure ? { failure: result.failure } : {}),
            ...(result.diagnostic
              ? { diagnostic: redactChildSecrets(result.diagnostic, childEnv) }
              : {}),
          })
        } catch (error) {
          reject(error)
          return
        }
        if (!output.text) {
          reject(agentExecutionError('LOCAL_AGENT_EMPTY_RESPONSE'))
          return
        }
        const externalRunRef = normalizeExternalRunRef(
          redactChildSecrets(result.externalRunRef, childEnv),
        )
        if (externalRunRef) output.externalRunRef = externalRunRef
        if (result.progress?.length) output.progress = result.progress
        runtimeEvents.emitFinalAnswer(redactedText)
        resolve(output)
      })().catch(error => reject(error))
    }))
    if (spec.stdin) child.stdin.end(prompt)
    else child.stdin.end()
  })
}

module.exports = {
  ALLOWED_KINDS,
  detectAgents,
  imageAttachmentLimit,
  invocation,
  normalizeOutput,
  parseCodexOutput,
  parseGeminiOutput,
  parseKimiOutput,
  parseMimoOutput,
  parseOpenCodeOutput,
  parseOpenCodeReviewOutput,
  parseWorkBuddyOutput,
  prepareCommand,
  readHermesFinalResponse,
  readHermesMessageWatermark,
  resolveExecutable,
  runAgent,
  runtimeCommandSummary,
  searchPath,
}
