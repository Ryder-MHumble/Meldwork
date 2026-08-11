const SENSITIVE_ASSIGNMENT_KEY = /(?:api[_ -]?key|access[_ -]?key|secret[_ -]?access[_ -]?key|access[_ -]?token|refresh[_ -]?token|auth[_ -]?token|database[_ -]?url|connection[_ -]?string|dsn|token|secret|password|credential|authorization|private[_ -]?key|session[_ -]?ref)/i
const BASIC_AUTH_CANDIDATE = /\bBasic[ \t]+([A-Za-z0-9+/]+={0,2})(?![A-Za-z0-9+/=])/gi
const JOSE_COMPACT_CANDIDATE = /(?<![0-9A-Za-z_-])(?:[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){4}|[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2})(?![0-9A-Za-z_-])/g

function decodeCanonicalBase64(value, encoding) {
  try {
    const decoded = Buffer.from(value, encoding)
    if (!decoded.length) return null
    const normalized = value.replace(/=+$/, '')
    return decoded.toString(encoding).replace(/=+$/, '') === normalized ? decoded : null
  } catch {
    return null
  }
}

function isBasicCredential(value) {
  return decodeCanonicalBase64(value, 'base64')?.includes(0x3a) === true
}

function hasJoseHeader(value) {
  const headerBytes = decodeCanonicalBase64(value.split('.')[0], 'base64url')
  if (!headerBytes) return false
  try {
    const header = JSON.parse(headerBytes.toString('utf8'))
    if (!header || typeof header !== 'object' || Array.isArray(header)) return false
    return [header.alg, header.enc].some(item => typeof item === 'string' && item.trim())
  } catch {
    return false
  }
}

function redactSecrets(value) {
  let text = String(value || '')
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi, '[redacted private key]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(BASIC_AUTH_CANDIDATE, (match, credential) => (
      isBasicCredential(credential) ? 'Basic [redacted]' : match
    ))
    .replace(/\b(sk|rk|pk|ghp|github_pat|xox[baprs]?)[_-][A-Za-z0-9_-]{12,}\b/gi, '[redacted]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]')
    .replace(/(?<![0-9A-Za-z_-])AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g, '[redacted]')
    .replace(JOSE_COMPACT_CANDIDATE, match => (hasJoseHeader(match) ? '[redacted]' : match))
    .replace(
      /([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi,
      '$1[redacted]@',
    )
  if (SENSITIVE_ASSIGNMENT_KEY.test(text)) {
    text = text.replace(/(["']?)[A-Za-z0-9_.-]*(?:api[_ -]?key|access[_ -]?key(?:[_ -]?id)?|secret[_ -]?access[_ -]?key|access[_ -]?token|refresh[_ -]?token|auth[_ -]?token|database[_ -]?url|connection[_ -]?string|dsn|token|secret|password|credential|authorization|private[_ -]?key|session[_ -]?ref(?:erence)?)[A-Za-z0-9_.-]*\1\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|\[[^\]\r\n]*\]|[^\s,;}\]]+)/gi, 'credential=[redacted]')
  }
  return text
}

module.exports = { redactSecrets }
