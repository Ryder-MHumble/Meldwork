const VERSION_PATTERN = /\bv?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?\b/

const AGENT_COMPATIBILITY = Object.freeze({
  codex: profile('0.137.0', '0.146.0', [
    probe('codex-exec', ['exec', '--help'], [
      '--json', '--sandbox', '--skip-git-repo-check', '--image',
      'read-only', 'workspace-write',
    ]),
    probe('codex-resume', ['exec', 'resume', '--help'], [
      '--json', '--skip-git-repo-check',
    ]),
  ], ['0.146.0-alpha.9.2']),
  hermes: profile('0.19.1', '0.20.0', [
    probe('hermes-chat', ['chat', '--help'], [
      '--quiet', '--query', '--provider', '--model', '--resume',
      '--image', '--yolo',
    ]),
  ]),
  openclaw: exactProfile('2026.7.1-2', [
    probe('openclaw-agent', ['agent', '--help'], [
      '--local', '--agent', '--session-key', '--message', '--json',
    ]),
  ]),
  workbuddy: profile('2.115.0', '2.132.0', [
    probe('workbuddy-print', ['--help'], [
      '--print', '--output-format', '--permission-mode', '--max-turns', '--resume',
      'json', 'plan', 'acceptEdits',
    ]),
  ]),
  kimi: profile('0.19.2', '0.32.0', [
    probe('kimi-stream', ['--help'], [
      '--output-format', '--auto', '--session', '--prompt', 'stream-json',
    ]),
    probe('kimi-acp', ['acp', '--help'], []),
  ]),
  mimo: profile('0.1.0', '0.1.9', [
    probe('mimo-run', ['run', '--help'], [
      '--pure', '--agent', '--format', '--dir', '--session', 'json',
    ]),
  ]),
  claude: profile('2.1.165', '2.1.221', [
    probe('claude-print', ['--help'], [
      '--print', '--output-format', '--include-partial-messages', '--verbose',
      '--permission-mode', '--resume', 'stream-json', 'plan', 'acceptEdits',
    ]),
  ]),
  gemini: exactProfile('0.53.1', [
    probe('gemini-stream', ['--help'], [
      '--output-format', '--approval-mode', '--resume', '--prompt', 'stream-json',
    ]),
  ]),
  opencode: profile('1.18.9', '1.18.12', [
    probe('opencode-run', ['run', '--help'], [
      '--format', '--agent', '--session', '--file', 'json',
    ]),
  ]),
  qwen: profile('0.10.0', '0.21.5', [
    probe('qwen-stream', ['--help'], [
      '--output-format', '--include-partial-messages', '--approval-mode',
      '--auth-type', '--model', '--resume', 'stream-json', 'plan', 'auto-edit',
    ]),
  ]),
  opencodereview: profile('1.8.4', '1.8.6', [
    probe('opencodereview-review', ['review', '--help'], [
      '--audience', '--format', '--repo', '--background', 'json', 'agent',
    ]),
  ]),
})

function probe(id, args, requiredText) {
  return Object.freeze({
    id,
    args: Object.freeze([...args]),
    requiredText: Object.freeze([...requiredText]),
  })
}

function profile(minVersion, maxVersion, probes, prereleaseVersions = []) {
  return Object.freeze({
    minVersion,
    maxVersion,
    supportedVersionRange: `${minVersion}..${maxVersion}`,
    probes: Object.freeze(probes),
    prereleaseVersions: Object.freeze([...prereleaseVersions]),
  })
}

function exactProfile(version, probes) {
  return Object.freeze({
    exactVersion: version,
    supportedVersionRange: version,
    probes: Object.freeze(probes),
  })
}

function extractAgentVersion(value) {
  const match = String(value || '').match(VERSION_PATTERN)
  if (!match) return ''
  return `${match[1]}.${match[2]}.${match[3]}${match[4] ? `-${match[4]}` : ''}`
}

function compareReleaseVersions(left, right) {
  const parse = (value) => {
    const match = String(value || '').match(/^(\d+)\.(\d+)\.(\d+)$/)
    return match ? match.slice(1).map(Number) : null
  }
  const leftParts = parse(left)
  const rightParts = parse(right)
  if (!leftParts || !rightParts) return null
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index]
  }
  return 0
}

function assessAgentVersion(kind, rawVersion) {
  const contract = AGENT_COMPATIBILITY[kind]
  const resolvedVersion = extractAgentVersion(rawVersion)
  const base = {
    resolvedVersion,
    supportedVersionRange: contract?.supportedVersionRange || '',
  }
  if (!contract || !resolvedVersion) {
    return {
      ...base,
      compatibilityState: 'incompatible',
      incompatibilityReason: 'LOCAL_AGENT_VERSION_UNSUPPORTED',
    }
  }
  const supported = contract.exactVersion
    ? resolvedVersion === contract.exactVersion
    : contract.prereleaseVersions.includes(resolvedVersion)
      || (!resolvedVersion.includes('-')
        && compareReleaseVersions(resolvedVersion, contract.minVersion) >= 0
        && compareReleaseVersions(resolvedVersion, contract.maxVersion) <= 0)
  return supported
    ? {
        ...base,
        compatibilityState: 'compatible',
        incompatibilityReason: '',
      }
    : {
        ...base,
        compatibilityState: 'incompatible',
        incompatibilityReason: 'LOCAL_AGENT_VERSION_UNSUPPORTED',
      }
}

function capabilityProbes(kind) {
  return AGENT_COMPATIBILITY[kind]?.probes || []
}

module.exports = {
  AGENT_COMPATIBILITY,
  assessAgentVersion,
  capabilityProbes,
  extractAgentVersion,
}
