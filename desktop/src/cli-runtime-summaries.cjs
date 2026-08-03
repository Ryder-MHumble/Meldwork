const RUNTIME_SENSITIVE_FIELD = /(?:api[_-]?key|access[_-]?key(?:[_-]?id)?|secret[_-]?access[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|database[_-]?url|connection[_-]?string|dsn|token|secret|password|credential|authorization|private[_-]?key)/i

function codexProgressTitle(item) {
  const type = String(item?.type || '').toLowerCase()
  const descriptor = [type, item?.name, item?.tool, item?.command]
    .map(value => String(value || '').toLowerCase())
    .join(' ')
  if (/image[_ -]?(?:generation|gen)|imagegen|generate[_ -]?image/.test(descriptor)) return 'image_generation'
  if (/audio[_ -]?(?:generation|gen)|generate[_ -]?audio|text[_ -]?to[_ -]?speech/.test(descriptor)) {
    return 'audio_generation'
  }
  if (/video[_ -]?(?:generation|gen)|generate[_ -]?video/.test(descriptor)) return 'video_generation'
  if (type === 'reasoning' || /\breasoning\b/.test(descriptor)) return 'reasoning'
  if (/apply_patch|write[_ -]?file|edit[_ -]?file|create[_ -]?file|\b(?:mkdir|tee|cp|mv)\b/.test(descriptor)) {
    return 'write_file'
  }
  if (/\b(?:rg|grep|find|search|glob)\b/.test(descriptor)) return 'search'
  if (/read[_ -]?file|\b(?:cat|sed|head|tail|ls|stat|file|ffprobe)\b|git (?:show|diff)/.test(descriptor)) {
    return 'read_file'
  }
  if (type === 'command_execution') return 'Bash'
  if (/tool|mcp/.test(type)) return 'tool'
  return 'process'
}

function runtimeToolTitle(event) {
  const part = event?.part && typeof event.part === 'object' ? event.part : {}
  const classified = codexProgressTitle({
    type: [event?.type, event?.sessionUpdate, part.type, event?.kind, part.kind]
      .filter(Boolean).join(' '),
    name: event?.name || event?.toolName || part.name,
    tool: event?.tool || event?.tool_name || part.tool,
  })
  if (!['process', 'tool'].includes(classified)) return classified
  const name = String(
    event?.name || event?.toolName || event?.tool_name || event?.tool
      || part.name || part.toolName || part.tool_name || part.tool || '',
  )
  return /^[A-Za-z0-9_.:-]{1,80}$/u.test(name) ? name : 'tool'
}

function runtimeEventId(event) {
  const part = event?.part && typeof event.part === 'object' ? event.part : {}
  return event?.toolCallId || event?.tool_call_id || event?.id
    || part.toolCallId || part.tool_call_id || part.id || ''
}

function redactRuntimeStructure(value, seen = new WeakSet(), depth = 0) {
  if (value == null || typeof value !== 'object') return value
  if (depth >= 6) return '[truncated]'
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  if (Array.isArray(value)) {
    return value.slice(0, 50).map(item => redactRuntimeStructure(item, seen, depth + 1))
  }
  let redactedFields = 0
  return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => {
    if (RUNTIME_SENSITIVE_FIELD.test(key)) {
      redactedFields += 1
      return [`credential${redactedFields > 1 ? redactedFields : ''}`, '[redacted]']
    }
    return [key, redactRuntimeStructure(item, seen, depth + 1)]
  }))
}

function runtimeInputSummary(value) {
  if (value == null) return ''
  if (typeof value === 'string') return `text (${value.length} chars)`
  if (['number', 'boolean', 'bigint'].includes(typeof value)) return String(value)
  if (Array.isArray(value)) return `${value.length} items`
  if (typeof value !== 'object') return ''
  const safe = redactRuntimeStructure(value)
  return Object.entries(safe).slice(0, 10).map(([key, item]) => {
    if (item === '[redacted]') return `${key}: [redacted]`
    if (['command', 'cmd'].includes(key.toLowerCase()) && typeof item === 'string') {
      return `operation: ${runtimeCommandSummary(item)}`
    }
    if (['path', 'file', 'filename', 'cwd', 'url'].includes(key.toLowerCase())) {
      return `${key}: provided`
    }
    if (['number', 'boolean', 'bigint'].includes(typeof item)) return `${key}: ${String(item)}`
    if (typeof item === 'string') {
      const simple = ['action', 'kind', 'method', 'mode', 'name', 'tool'].includes(key.toLowerCase())
        && /^[A-Za-z0-9_.:-]{1,80}$/u.test(item)
      return `${key}: ${simple ? item : `text (${item.length} chars)`}`
    }
    if (Array.isArray(item)) return `${key}: ${item.length} items`
    return `${key}: object (${Object.keys(item || {}).length} fields)`
  }).join(', ')
}

function runtimeCommandTokens(value) {
  const input = String(value || '')
  const tokens = []
  let word = ''
  let quote = ''
  let escaped = false
  const pushWord = () => {
    if (!word) return
    tokens.push({ type: 'word', value: word })
    word = ''
  }
  const pushOperator = (operator) => {
    pushWord()
    if (operator === ';' && tokens.at(-1)?.type === 'operator') return
    tokens.push({ type: 'operator', value: operator })
  }

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    if (escaped) {
      if (char !== '\n' && char !== '\r') word += char
      escaped = false
      continue
    }
    if (quote) {
      if (char === quote) {
        quote = ''
        continue
      }
      if (char === '\\' && quote === '"' && index + 1 < input.length) {
        index += 1
        word += input[index]
        continue
      }
      word += char
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '\r' || char === '\n') {
      if (char === '\r' && input[index + 1] === '\n') index += 1
      pushOperator(';')
      continue
    }
    if (/\s/u.test(char)) {
      pushWord()
      continue
    }
    if (char === '&' && input[index + 1] === '&') {
      pushOperator('&&')
      index += 1
      continue
    }
    if (char === '|') {
      pushOperator(input[index + 1] === '|' ? '||' : '|')
      if (input[index + 1] === '|') index += 1
      continue
    }
    if (char === ';') {
      pushOperator(';')
      continue
    }
    if (char === '>' || char === '<') {
      if (/^\d+$/u.test(word)) word = ''
      else pushWord()
      if (input[index + 1] === char) index += 1
      tokens.push({ type: 'redirect' })
      continue
    }
    word += char
  }
  pushWord()
  return tokens
}

function unwrapRuntimeShellCommand(tokens) {
  if (tokens.length !== 3 || tokens.some(token => token.type !== 'word')
      || !['-c', '-lc'].includes(tokens[1].value)) return tokens
  const rawShell = String(tokens[0].value || '')
  const shell = rawShell.split(/[\\/]/u).at(-1).toLowerCase()
  if (!['sh', 'bash', 'zsh'].includes(shell)) return tokens
  const unwrapped = runtimeCommandTokens(tokens[2].value)
  return unwrapped.length ? unwrapped : tokens
}

function runtimeCommandSummary(value) {
  const tokens = unwrapRuntimeShellCommand(runtimeCommandTokens(value))
  const segments = []
  let connector = ''
  let segment = []
  let hideRedirectTarget = false
  for (const token of tokens) {
    if (token.type === 'operator') {
      if (segment.length) segments.push({ connector, tokens: segment })
      connector = token.value
      segment = []
      hideRedirectTarget = false
      continue
    }
    if (token.type === 'redirect') {
      hideRedirectTarget = true
      continue
    }
    if (hideRedirectTarget) {
      hideRedirectTarget = false
      continue
    }
    if (token.type === 'word') segment.push(token.value)
  }
  if (segment.length) segments.push({ connector, tokens: segment })

  const safeSubcommands = new Set([
    'build', 'diff', 'exec', 'pack', 'run', 'show', 'status', 'test', 'typecheck',
  ])
  const summarizeSegment = (items) => {
    let index = 0
    if (items[index] === 'env') index += 1
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(items[index] || '')) index += 1
    const rawVerb = String(items[index] || '')
    const basename = rawVerb.split(/[\\/]/u).at(-1).replace(/\.(?:cmd|bat|exe)$/iu, '')
    const verb = /^[A-Za-z0-9_.+-]{1,80}$/u.test(basename) ? basename : 'shell'
    const remaining = items.slice(index + 1)
    const subcommandName = String(remaining[0] || '').toLowerCase()
    const subcommand = safeSubcommands.has(subcommandName) ? subcommandName : ''
    const flags = []
    let hiddenCount = 0
    remaining.forEach((token, remainingIndex) => {
      if (remainingIndex === 0 && subcommand) return
      if (flags.length < 6 && /^(?:-[A-Za-z0-9]|--[A-Za-z0-9][A-Za-z0-9-]*)$/u.test(token)) {
        flags.push(token)
      } else {
        hiddenCount += 1
      }
    })
    return [
      verb,
      subcommand,
      ...flags,
      hiddenCount ? `(${hiddenCount} hidden argument${hiddenCount === 1 ? '' : 's'})` : '',
    ].filter(Boolean).join(' ')
  }

  const visibleSegments = segments.slice(0, 3)
  const summary = visibleSegments.map((item, index) => [
    index ? item.connector : '',
    summarizeSegment(item.tokens),
  ].filter(Boolean).join(' ')).join(' ')
  const omitted = Math.max(0, segments.length - visibleSegments.length)
  return [summary || 'shell', omitted ? `(${omitted} more commands)` : '']
    .filter(Boolean)
    .join(' ')
}

function runtimeToolOperation(event) {
  const part = event?.part && typeof event.part === 'object' ? event.part : {}
  const name = event?.name || event?.toolName || event?.tool_name || event?.tool
    || event?.title || event?.kind || part.name || part.toolName || part.tool_name
    || part.tool || part.title || part.kind || event?.type || 'tool'
  const input = event?.command ?? event?.input ?? event?.arguments ?? event?.args
    ?? event?.rawInput ?? part.command ?? part.input ?? part.arguments ?? part.args ?? part.rawInput
  const detail = typeof event?.command === 'string'
    ? runtimeCommandSummary(event.command)
    : runtimeInputSummary(input)
  return detail ? `${name}: ${detail}` : String(name)
}

function runtimeToolResultDetail(event) {
  const part = event?.part && typeof event.part === 'object' ? event.part : {}
  const output = event?.aggregated_output ?? event?.output ?? event?.result ?? event?.content
    ?? event?.rawOutput ?? event?.error ?? part.aggregated_output ?? part.output ?? part.result
    ?? part.content ?? part.rawOutput ?? part.error
  const lines = []
  const exitCode = event?.exit_code ?? event?.exitCode ?? part.exit_code ?? part.exitCode
  if (Number.isInteger(exitCode)) lines.push(`Exit code: ${exitCode}`)
  if (typeof output === 'string' && output) {
    const withoutTrailingBreaks = output.replace(/(?:\r?\n)+$/u, '')
    const lineCount = withoutTrailingBreaks ? withoutTrailingBreaks.split(/\r?\n/).length : 0
    lines.push(`Output: ${lineCount} line${lineCount === 1 ? '' : 's'}, ${Buffer.byteLength(output, 'utf8')} bytes`)
  } else if (['number', 'boolean', 'bigint'].includes(typeof output)) {
    lines.push(`Result: ${String(output)}`)
  } else if (Array.isArray(output)) {
    lines.push(`Result: ${output.length} item${output.length === 1 ? '' : 's'}`)
  } else if (output && typeof output === 'object') {
    const safe = redactRuntimeStructure(output)
    const fields = Object.entries(safe).slice(0, 8).map(([key, value]) => {
      if (value === '[redacted]') return `${key}: [redacted]`
      if (['number', 'boolean', 'bigint'].includes(typeof value)) return `${key}: ${String(value)}`
      if (typeof value === 'string') return `${key}: text (${value.length} chars)`
      if (Array.isArray(value)) return `${key}: ${value.length} items`
      return `${key}: object`
    })
    if (fields.length) lines.push(`Result fields:\n${fields.join('\n')}`)
  }
  return lines.join('\n')
}

module.exports = {
  codexProgressTitle,
  runtimeCommandSummary,
  runtimeEventId,
  runtimeToolOperation,
  runtimeToolResultDetail,
  runtimeToolTitle,
}
