const ALL_AGENT_PREFIXES = [
  /^(?:你们|各位|大家(?!庭))/u,
  /^(?:所有|全部|全体)(?:的)?\s*(?:agents?|智能体|助手)/iu,
  /^(?:everyone|all\s+agents?|all\s+of\s+you)\b/iu,
]

function skipCourtesyPrefix(value) {
  let offset = value.search(/\S/u)
  if (offset < 0) return value.length

  const chinese = /^(?:请|麻烦|劳烦)\s*/u.exec(value.slice(offset))
  if (chinese) return offset + chinese[0].length

  const english = /^please(?:\s+|\s*[,，:：]\s*)/iu.exec(value.slice(offset))
  return english ? offset + english[0].length : offset
}

function agentAliases(profile) {
  const label = String(profile?.label || '').trim()
  const shortLabel = label.replace(/\s+(?:code|cli)$/iu, '').trim()
  return [...new Set([profile?.kind, label, shortLabel]
    .map(value => String(value || '').trim())
    .filter(Boolean))]
}

function aliasMatches(value, lowerValue, offset, alias) {
  if (!lowerValue.startsWith(alias.lower, offset)) return false
  const next = value[offset + alias.value.length] || ''
  return !next || !/[A-Za-z0-9_.-]/u.test(next)
}

function skipRecipientSeparators(value, offset) {
  let cursor = offset
  while (cursor < value.length) {
    const separators = /^[\s,，、/&+]+/u.exec(value.slice(cursor))
    if (separators) {
      cursor += separators[0].length
      continue
    }
    const connector = /^(?:and\b|和|与|及)\s*/iu.exec(value.slice(cursor))
    if (connector) {
      cursor += connector[0].length
      continue
    }
    break
  }
  return cursor
}

export function parseAgentRoutingPrefix(text, profiles, groupKinds) {
  const value = String(text || '')
  const availableKinds = [...new Set((Array.isArray(groupKinds) ? groupKinds : [])
    .map(kind => String(kind || ''))
    .filter(Boolean))]
  if (!value.trim() || !availableKinds.length) return { targetKinds: [], all: false }

  const available = new Set(availableKinds)
  const offset = skipCourtesyPrefix(value)
  const remaining = value.slice(offset)
  if (ALL_AGENT_PREFIXES.some(pattern => pattern.test(remaining))) {
    return { targetKinds: availableKinds, all: true }
  }

  const aliases = (Array.isArray(profiles) ? profiles : [])
    .filter(profile => available.has(String(profile?.kind || '')))
    .flatMap(profile => agentAliases(profile).map(alias => ({
      kind: String(profile.kind),
      value: alias,
      lower: alias.toLocaleLowerCase(),
    })))
    .sort((left, right) => right.value.length - left.value.length)
  const lowerValue = value.toLocaleLowerCase()
  const selected = new Set()
  let cursor = offset

  while (cursor < value.length) {
    const match = aliases.find(alias => aliasMatches(value, lowerValue, cursor, alias))
    if (!match) break
    selected.add(match.kind)
    const next = skipRecipientSeparators(value, cursor + match.value.length)
    if (next <= cursor) break
    cursor = next
  }

  return {
    targetKinds: availableKinds.filter(kind => selected.has(kind)),
    all: false,
  }
}
