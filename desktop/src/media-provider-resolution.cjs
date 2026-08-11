function providerHost(baseUrl) {
  try { return new URL(baseUrl).hostname.toLowerCase() } catch { return '' }
}

function mediaProviderScore(type, requestedKind, candidateKind, status = {}) {
  const host = providerHost(status.baseUrl)
  const model = String(status.model || '').toLowerCase()
  let score = candidateKind === requestedKind ? 20 : 0
  if (candidateKind === 'codex') score += 5
  if (host === 'api.openai.com') score += 80
  if (host === 'hub.zgci.org') score += type === 'video' ? 120 : 70
  if (host === 'helper.ihainan.me' && /h3/.test(model)) score += type === 'video' ? 110 : -100
  if (type === 'video' && /(h3|sora|video|hailuo|minimax)/.test(model)) score += 30
  if (type === 'image' && /(image|dall-e|flux|qwen)/.test(model)) score += 30
  if (type === 'audio' && /(audio|speech|tts|voice)/.test(model)) score += 30
  return score
}

function resolveMediaProvider({
  requestedKind, type, kinds, statusFor, credentialsFor, excludedKinds = [],
  fallbackProviders = [],
}) {
  const excluded = new Set(excludedKinds)
  const configuredFallbacks = (Array.isArray(fallbackProviders) ? fallbackProviders : [])
    .map((provider) => {
      const kind = String(provider?.kind || '').trim()
      if (!kind || excluded.has(kind)) return null
      const status = provider?.status
      const credentials = provider?.credentials
      return status?.configured && credentials?.OPENAI_API_KEY
        ? { kind, status, credentials, fallback: true }
        : null
    })
    .filter(Boolean)
  const candidates = [
    ...[...new Set([requestedKind, 'codex', ...(kinds || [])])]
    .filter(kind => kind && !excluded.has(kind))
    .map((kind) => {
      try {
        const status = statusFor(kind)
        return status?.configured ? { kind, status } : null
      } catch {
        return null
      }
    })
    .filter(Boolean),
    ...configuredFallbacks,
  ]
    .sort((left, right) => (
      mediaProviderScore(type, requestedKind, right.kind, right.status)
      - mediaProviderScore(type, requestedKind, left.kind, left.status)
    ))
  for (const candidate of candidates) {
    try {
      const credentials = candidate.fallback ? candidate.credentials : credentialsFor(candidate.kind)
      if (!credentials?.OPENAI_API_KEY) continue
      return {
        apiKey: credentials.OPENAI_API_KEY,
        baseUrl: candidate.status.baseUrl,
        model: candidate.status.model,
        sourceKind: candidate.kind,
      }
    } catch { /* try the next configured secure profile */ }
  }
  throw new Error('MEDIA_GENERATION_PROVIDER_UNAVAILABLE')
}

module.exports = { mediaProviderScore, resolveMediaProvider }
