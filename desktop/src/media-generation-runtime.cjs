const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const OUTPUT_DIRECTORY = '.meldwork-output'
const MAX_MEDIA_BYTES = 128 * 1024 * 1024
const POLL_INTERVAL_MS = 10_000
const PROVIDER_ATTEMPTS = 3
const RETRYABLE_PROVIDER_STATUSES = new Set([429, 502, 503, 504])
const SUPPORTED_TYPES = new Set(['image', 'audio', 'video'])

function mediaError(code, detail = '') {
  const error = new Error(code)
  error.code = code
  if (detail) error.diagnostic = detail.slice(0, 800)
  return error
}

function requestUrl(baseUrl, suffix) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  if (!base) throw mediaError('MEDIA_GENERATION_PROVIDER_UNAVAILABLE')
  return `${base}${suffix}`
}

function responseExtension(type, contentType = '', sourceUrl = '') {
  const normalized = String(contentType || '').toLowerCase().split(';')[0]
  const byContentType = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
    'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/mp4': 'm4a',
    'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
  }
  if (byContentType[normalized]) return byContentType[normalized]
  try {
    const extension = path.extname(new URL(sourceUrl).pathname).slice(1).toLowerCase()
    if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp3', 'wav', 'm4a', 'mp4', 'mov', 'webm']
      .includes(extension)) return extension === 'jpeg' ? 'jpg' : extension
  } catch { /* no usable source URL */ }
  return { image: 'png', audio: 'mp3', video: 'mp4' }[type]
}

function base64Bytes(value) {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(MAX_MEDIA_BYTES * 1.4)) {
    throw mediaError('MEDIA_GENERATION_INVALID_RESPONSE')
  }
  const normalized = value.replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw mediaError('MEDIA_GENERATION_INVALID_RESPONSE')
  }
  const bytes = Buffer.from(normalized, 'base64')
  if (!bytes.length || bytes.length > MAX_MEDIA_BYTES) {
    throw mediaError('MEDIA_GENERATION_INVALID_RESPONSE')
  }
  return bytes
}

function responsePayload(payload) {
  const item = Array.isArray(payload?.data) ? payload.data[0] : payload
  if (!item || typeof item !== 'object') return null
  if (typeof item.b64_json === 'string') return { bytes: base64Bytes(item.b64_json) }
  if (typeof item.base64 === 'string') return { bytes: base64Bytes(item.base64) }
  if (typeof item.url === 'string') return { url: item.url }
  if (typeof payload?.url === 'string') return { url: payload.url }
  return null
}

function firstValue(payload, keys) {
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = firstValue(item, keys)
      if (found != null && found !== '') return found
    }
    return null
  }
  if (!payload || typeof payload !== 'object') return null
  for (const key of keys) {
    if (payload[key] != null && payload[key] !== '') return payload[key]
  }
  for (const value of Object.values(payload)) {
    const found = firstValue(value, keys)
    if (found != null && found !== '') return found
  }
  return null
}

function nestedResponsePayload(payload) {
  const direct = responsePayload(payload)
  if (direct) return direct
  const encoded = firstValue(payload, ['b64_json', 'base64', 'video_base64'])
  if (typeof encoded === 'string') return { bytes: base64Bytes(encoded) }
  const url = firstValue(payload, ['url', 'download_url', 'downloadUrl', 'video_url', 'videoUrl'])
  return typeof url === 'string' ? { url } : null
}

function outputDirectory(workdir) {
  if (typeof workdir !== 'string' || !path.isAbsolute(workdir)) {
    throw mediaError('MEDIA_GENERATION_WORKDIR_INVALID')
  }
  let realWorkdir
  try { realWorkdir = fs.realpathSync(workdir) } catch { throw mediaError('MEDIA_GENERATION_WORKDIR_INVALID') }
  const directory = path.join(realWorkdir, OUTPUT_DIRECTORY)
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    const stat = fs.lstatSync(directory)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('unsafe output directory')
    const realDirectory = fs.realpathSync(directory)
    const relative = path.relative(realWorkdir, realDirectory)
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('outside workdir')
    }
    return realDirectory
  } catch {
    throw mediaError('MEDIA_GENERATION_OUTPUT_UNAVAILABLE')
  }
}

function officialModel(type, provider) {
  let host = ''
  try { host = new URL(provider.baseUrl).hostname.toLowerCase() } catch { /* validated upstream */ }
  if (host === 'api.openai.com') {
    return { image: 'gpt-image-1', audio: 'gpt-4o-mini-tts', video: 'sora-2' }[type]
  }
  if (host === 'hub.zgci.org') {
    return { image: 'qwen-image', audio: 'cosy-voice', video: 'minimax-h3' }[type]
  }
  return provider.model
}

function h3Provider(provider) {
  let host = ''
  try { host = new URL(provider.baseUrl).hostname.toLowerCase() } catch { return false }
  return host === 'helper.ihainan.me' && /(?:^|[-_/])(?:minimax-)?h3(?:$|[-_/])/i.test(provider.model)
}

function zgciProvider(provider) {
  try { return new URL(provider.baseUrl).hostname.toLowerCase() === 'hub.zgci.org' } catch { return false }
}

function providerModelUnavailable(error) {
  const diagnostic = String(error?.diagnostic || '').toLowerCase()
  return diagnostic.includes('model_not_found') || diagnostic.includes('no available channel for model')
}

function providerRetryExhausted(error) {
  const match = /^MEDIA_GENERATION_HTTP_(\d+)$/.exec(String(error?.code || error?.message || ''))
  return RETRYABLE_PROVIDER_STATUSES.has(Number(match?.[1]))
}

function sleep(delayMs, signal) {
  if (signal?.aborted) return Promise.reject(mediaError('LOCAL_AGENT_EXECUTION_STOPPED'))
  return new Promise((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    const timer = setTimeout(done, delayMs)
    const abort = () => {
      clearTimeout(timer)
      reject(mediaError('LOCAL_AGENT_EXECUTION_STOPPED'))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

async function boundedResponseBytes(response, maximum = MAX_MEDIA_BYTES) {
  const advertisedLength = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(advertisedLength) && advertisedLength > maximum) {
    throw mediaError('MEDIA_GENERATION_INVALID_RESPONSE')
  }
  const reader = response.body?.getReader?.()
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > maximum) throw mediaError('MEDIA_GENERATION_INVALID_RESPONSE')
    return bytes
  }
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value)
      total += chunk.length
      if (total > maximum) throw mediaError('MEDIA_GENERATION_INVALID_RESPONSE')
      chunks.push(chunk)
    }
  } finally {
    reader.releaseLock?.()
  }
  return Buffer.concat(chunks, total)
}

class MediaGenerationRuntime {
  constructor({
    getProvider,
    fetchFn = globalThis.fetch,
    createId = crypto.randomUUID,
    pollIntervalMs = POLL_INTERVAL_MS,
  } = {}) {
    if (typeof getProvider !== 'function' || typeof fetchFn !== 'function' || typeof createId !== 'function') {
      throw mediaError('MEDIA_GENERATION_RUNTIME_INVALID')
    }
    this.getProvider = getProvider
    this.fetch = fetchFn
    this.createId = createId
    this.pollIntervalMs = Math.max(0, Number(pollIntervalMs) || 0)
  }

  emit(onEvent, type, status, id, summary = '') {
    try {
      onEvent?.({
        id: `media-${id}`,
        type: status === 'running' ? 'tool_start' : 'tool_result_summary',
        status,
        title: `${type}_generation`,
        summary,
      })
    } catch { /* trace delivery is best effort */ }
  }

  async post(provider, suffix, body, signal) {
    for (let attempt = 1; attempt <= PROVIDER_ATTEMPTS; attempt += 1) {
      let response
      try {
        response = await this.fetch(requestUrl(provider.baseUrl, suffix), {
          method: 'POST',
          headers: {
            Authorization: h3Provider(provider)
              ? `Basic ${Buffer.from(provider.apiKey, 'utf8').toString('base64')}`
              : `Bearer ${provider.apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json, image/*, audio/*, video/*',
          },
          body: JSON.stringify(body),
          signal,
        })
      } catch (error) {
        if (signal?.aborted) throw mediaError('LOCAL_AGENT_EXECUTION_STOPPED')
        throw mediaError('MEDIA_GENERATION_NETWORK_FAILED', error?.message || '')
      }
      if (response?.ok) return response

      const status = Number(response?.status) || 0
      let detail = ''
      try { detail = await response.text() } catch { /* no response detail */ }
      const error = mediaError(`MEDIA_GENERATION_HTTP_${status}`, detail)
      if (providerModelUnavailable(error)
          || !RETRYABLE_PROVIDER_STATUSES.has(status)
          || attempt === PROVIDER_ATTEMPTS) throw error
      await sleep(Math.min(this.pollIntervalMs, 1_000) * attempt, signal)
    }
    throw mediaError('MEDIA_GENERATION_NETWORK_FAILED')
  }

  async getJson(provider, suffix, signal) {
    let response
    try {
      response = await this.fetch(requestUrl(provider.baseUrl, suffix), {
        headers: {
          Authorization: h3Provider(provider)
            ? `Basic ${Buffer.from(provider.apiKey, 'utf8').toString('base64')}`
            : `Bearer ${provider.apiKey}`,
          Accept: 'application/json',
        },
        signal,
      })
    } catch (error) {
      if (signal?.aborted) throw mediaError('LOCAL_AGENT_EXECUTION_STOPPED')
      throw mediaError('MEDIA_GENERATION_NETWORK_FAILED', error?.message || '')
    }
    if (!response?.ok) {
      let detail = ''
      try { detail = await response.text() } catch { /* no response detail */ }
      throw mediaError(`MEDIA_GENERATION_HTTP_${Number(response?.status) || 0}`, detail)
    }
    try { return await response.json() } catch { throw mediaError('MEDIA_GENERATION_INVALID_RESPONSE') }
  }

  async download(url, signal, provider = null) {
    let parsed
    try { parsed = new URL(url) } catch { throw mediaError('MEDIA_GENERATION_INVALID_RESPONSE') }
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
      throw mediaError('MEDIA_GENERATION_INVALID_RESPONSE')
    }
    let response
    const providerHost = (() => {
      try { return new URL(provider?.baseUrl || '').hostname.toLowerCase() } catch { return '' }
    })()
    const headers = providerHost && parsed.hostname.toLowerCase() === providerHost
      ? { Authorization: `Bearer ${provider.apiKey}` }
      : undefined
    try { response = await this.fetch(parsed, { headers, signal }) } catch (error) {
      if (signal?.aborted) throw mediaError('LOCAL_AGENT_EXECUTION_STOPPED')
      throw mediaError('MEDIA_GENERATION_DOWNLOAD_FAILED', error?.message || '')
    }
    if (!response?.ok) throw mediaError(`MEDIA_GENERATION_DOWNLOAD_HTTP_${Number(response.status) || 0}`)
    const bytes = await boundedResponseBytes(response)
    if (!bytes.length || bytes.length > MAX_MEDIA_BYTES) throw mediaError('MEDIA_GENERATION_INVALID_RESPONSE')
    return { bytes, contentType: response.headers?.get?.('content-type') || '', sourceUrl: parsed.href }
  }

  async videoResponse(provider, body, signal, submitSuffix = '/videos') {
    let response = await this.post(provider, submitSuffix, body, signal)
    const contentType = response.headers?.get?.('content-type') || ''
    if (!/application\/json/i.test(contentType)) {
      const bytes = await boundedResponseBytes(response)
      return { bytes, contentType }
    }
    let payload
    try { payload = await response.json() } catch { throw mediaError('MEDIA_GENERATION_INVALID_RESPONSE') }
    let output = responsePayload(payload)
    while (!output && payload?.id && ['queued', 'in_progress', 'processing'].includes(payload.status)) {
      await sleep(this.pollIntervalMs, signal)
      payload = await this.getJson(provider, `/videos/${encodeURIComponent(payload.id)}`, signal)
      if (payload?.status === 'failed') throw mediaError('MEDIA_GENERATION_FAILED')
      output = responsePayload(payload)
    }
    if (!output && payload?.id && ['completed', 'succeeded', 'success'].includes(payload.status)) {
      output = { url: requestUrl(provider.baseUrl, `/videos/${encodeURIComponent(payload.id)}/content`) }
    }
    if (!output) throw mediaError('MEDIA_GENERATION_INVALID_RESPONSE')
    return output
  }

  async h3VideoResponse(provider, body, signal, onEvent, id) {
    const submitted = await this.post(provider, '/v1/videogen', body, signal)
    let task
    try { task = await submitted.json() } catch { throw mediaError('MEDIA_GENERATION_INVALID_RESPONSE') }
    const taskId = typeof task?.task_id === 'string' ? task.task_id : ''
    if (!taskId) throw mediaError('MEDIA_GENERATION_INVALID_RESPONSE')

    let status = String(task.status || 'queued')
    while (['queued', 'in_progress'].includes(status)) {
      const progress = Number(task.progress)
      const progressText = Number.isFinite(progress) ? ` ${Math.max(0, Math.min(100, progress))}%` : ''
      this.emit(onEvent, 'video', 'running', id, `Generating video: ${status}${progressText}`)
      await sleep(this.pollIntervalMs, signal)
      task = await this.getJson(provider, `/v1/videogen/${encodeURIComponent(taskId)}`, signal)
      status = String(task?.status || '')
    }
    if (status !== 'completed') throw mediaError('MEDIA_GENERATION_FAILED')

    let response
    try {
      response = await this.fetch(requestUrl(provider.baseUrl, `/v1/videogen/${encodeURIComponent(taskId)}/content`), {
        headers: {
          Authorization: `Basic ${Buffer.from(provider.apiKey, 'utf8').toString('base64')}`,
          Accept: 'video/mp4',
        },
        signal,
      })
    } catch (error) {
      if (signal?.aborted) throw mediaError('LOCAL_AGENT_EXECUTION_STOPPED')
      throw mediaError('MEDIA_GENERATION_DOWNLOAD_FAILED', error?.message || '')
    }
    if (!response?.ok) throw mediaError(`MEDIA_GENERATION_DOWNLOAD_HTTP_${Number(response?.status) || 0}`)
    return {
      bytes: await boundedResponseBytes(response),
      contentType: response.headers?.get?.('content-type') || 'video/mp4',
    }
  }

  async zgciH3VideoResponse(provider, prompt, signal, onEvent, id) {
    const submitted = await this.post(provider, '/video_generation', {
      model: 'H3',
      prompt,
      duration_seconds: 8,
      size: '1280x720',
      fps: 24,
    }, signal)
    let task
    try { task = await submitted.json() } catch { throw mediaError('MEDIA_GENERATION_INVALID_RESPONSE') }
    const taskId = firstValue(task, ['task_id', 'taskId', 'id'])
    if (typeof taskId !== 'string' || !taskId) throw mediaError('MEDIA_GENERATION_INVALID_RESPONSE')

    const successStates = new Set(['success', 'succeeded', 'completed', 'complete', 'done'])
    const failureStates = new Set(['failed', 'error', 'cancelled', 'canceled'])
    let status = String(firstValue(task, ['status', 'state', 'task_status', 'taskStatus']) || '').toLowerCase()
    while (!successStates.has(status)) {
      if (failureStates.has(status)) throw mediaError('MEDIA_GENERATION_FAILED')
      this.emit(onEvent, 'video', 'running', id, status ? `Generating video: ${status}` : 'Generating video')
      await sleep(this.pollIntervalMs, signal)
      const response = await this.post(provider, '/query/video_generation', { task_id: taskId }, signal)
      try { task = await response.json() } catch { throw mediaError('MEDIA_GENERATION_INVALID_RESPONSE') }
      status = String(firstValue(task, ['status', 'state', 'task_status', 'taskStatus']) || '').toLowerCase()
    }

    const direct = nestedResponsePayload(task)
    if (direct) return direct
    const fileId = firstValue(task, ['file_id', 'fileId', 'video_file_id', 'videoFileId'])
    if (typeof fileId !== 'string' || !fileId) throw mediaError('MEDIA_GENERATION_INVALID_RESPONSE')
    const retrieved = await this.post(provider, '/files/retrieve', { file_id: fileId }, signal)
    const contentType = retrieved.headers?.get?.('content-type') || ''
    if (!/application\/json/i.test(contentType)) {
      return { bytes: await boundedResponseBytes(retrieved), contentType }
    }
    let payload
    try { payload = await retrieved.json() } catch { throw mediaError('MEDIA_GENERATION_INVALID_RESPONSE') }
    const output = nestedResponsePayload(payload)
    if (!output) throw mediaError('MEDIA_GENERATION_INVALID_RESPONSE')
    return output
  }

  async generate({ kind, request, workdir, signal, onEvent } = {}) {
    const type = String(request?.type || '')
    const prompt = String(request?.prompt || '').trim()
    if (!kind || !SUPPORTED_TYPES.has(type) || !prompt || prompt.length > 12000) {
      throw mediaError('MEDIA_GENERATION_REQUEST_INVALID')
    }
    const id = String(this.createId()).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48) || 'media'
    this.emit(onEvent, type, 'running', id, `Generating ${type}`)
    try {
      let output
      let provider
      let providerFallbackError = null
      const excludedKinds = []
      while (!output) {
        try {
          provider = await this.getProvider(kind, type, excludedKinds)
        } catch (error) {
          if (providerModelUnavailable(providerFallbackError)) {
            throw mediaError('MEDIA_GENERATION_MODEL_UNAVAILABLE', providerFallbackError.diagnostic)
          }
          if (providerFallbackError) throw providerFallbackError
          throw error
        }
        if (!provider?.apiKey || !provider?.baseUrl || !provider?.model) {
          throw mediaError('MEDIA_GENERATION_PROVIDER_UNAVAILABLE')
        }
        const mediaModel = officialModel(type, provider)
        const body = type === 'image'
          ? { model: mediaModel, prompt, response_format: 'b64_json' }
          : type === 'audio'
            ? zgciProvider(provider)
              ? {
                  model: mediaModel,
                  input: prompt,
                  voice: 'mm_Southern_Young_Man',
                  response_format: 'wav',
                }
              : { model: mediaModel, input: prompt, voice: 'alloy', response_format: 'mp3' }
            : { model: mediaModel, prompt, seconds: '4', size: '1280x720' }
        try {
          if (type === 'video') {
            output = zgciProvider(provider)
              ? await this.videoResponse(provider, body, signal, '/video/generations')
              : h3Provider(provider)
                ? await this.h3VideoResponse(provider, { prompt, seconds: 4, steps: 20, size: '1280x720' }, signal, onEvent, id)
                : await this.videoResponse(provider, body, signal)
          }
          else {
            const suffix = type === 'image' ? '/images/generations' : '/audio/speech'
            const response = await this.post(provider, suffix, body, signal)
            const contentType = response.headers?.get?.('content-type') || ''
            if (/application\/json/i.test(contentType)) {
              let payload
              try { payload = await response.json() } catch { throw mediaError('MEDIA_GENERATION_INVALID_RESPONSE') }
              output = responsePayload(payload)
              if (!output) throw mediaError('MEDIA_GENERATION_INVALID_RESPONSE')
            } else {
              output = { bytes: await boundedResponseBytes(response), contentType }
            }
          }
        } catch (error) {
          if ((!providerModelUnavailable(error) && !providerRetryExhausted(error)) || !provider.sourceKind
              || excludedKinds.includes(provider.sourceKind)) throw error
          providerFallbackError = error
          excludedKinds.push(provider.sourceKind)
        }
      }
      const downloaded = output.url ? await this.download(output.url, signal, provider) : output
      const bytes = Buffer.from(downloaded.bytes || [])
      if (!bytes.length || bytes.length > MAX_MEDIA_BYTES) throw mediaError('MEDIA_GENERATION_INVALID_RESPONSE')
      const extension = responseExtension(type, downloaded.contentType, downloaded.sourceUrl || output.url)
      const filename = `generated-${type}-${id}.${extension}`
      const destination = path.join(outputDirectory(workdir), filename)
      fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 })
      this.emit(onEvent, type, 'completed', id, filename)
      return { filename, type }
    } catch (error) {
      this.emit(onEvent, type, 'failed', id, String(error?.code || error?.message || 'generation failed'))
      throw error
    }
  }
}

module.exports = { MediaGenerationRuntime, mediaError }
