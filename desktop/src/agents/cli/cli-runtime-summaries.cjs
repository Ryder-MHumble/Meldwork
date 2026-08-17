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

function runtimeCommandSummary(_value) {
  return 'command'
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
