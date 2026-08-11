const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { MediaGenerationRuntime } = require('../src/media-generation-runtime.cjs')

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const MP3 = Buffer.from('49443304000000000000', 'hex')
const MP4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(8)])

function response(body, options = {}) {
  return new Response(body, {
    status: options.status || 200,
    headers: options.headers || { 'content-type': 'application/json' },
  })
}

function fixture(t, fetchFn, provider = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-media-generation-'))
  const workdir = path.join(directory, 'workspace')
  fs.mkdirSync(workdir)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const runtime = new MediaGenerationRuntime({
    getProvider: () => ({
      apiKey: 'test-api-key', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-codex',
      ...provider,
    }),
    fetchFn,
    createId: () => 'media-id',
    pollIntervalMs: 0,
  })
  return { workdir, runtime }
}

test('writes a base64 image response to the controlled output directory and traces it', async (t) => {
  const calls = []
  const { workdir, runtime } = fixture(t, async (url, init) => {
    calls.push([String(url), init])
    return response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }))
  })
  const events = []
  const result = await runtime.generate({
    kind: 'codex', request: { type: 'image', prompt: 'a lighthouse at dawn' }, workdir,
    onEvent: event => events.push(event),
  })

  assert.deepEqual(result, { type: 'image', filename: 'generated-image-media-id.png' })
  assert.deepEqual(fs.readFileSync(path.join(workdir, '.meldwork-output', result.filename)), PNG)
  assert.equal(calls[0][0], 'https://api.openai.com/v1/images/generations')
  assert.equal(JSON.parse(calls[0][1].body).model, 'gpt-image-1')
  assert.equal(calls[0][1].headers.Authorization, 'Bearer test-api-key')
  assert.deepEqual(events.map(event => [event.type, event.status, event.title]), [
    ['tool_start', 'running', 'image_generation'],
    ['tool_result_summary', 'completed', 'image_generation'],
  ])
})

test('accepts non-Codex Agents and resolves media independently from the chat runtime', async (t) => {
  const providerRequests = []
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-media-generation-'))
  const workdir = path.join(directory, 'workspace')
  fs.mkdirSync(workdir)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const runtime = new MediaGenerationRuntime({
    getProvider: (kind, type) => {
      providerRequests.push([kind, type])
      return { apiKey: 'shared-key', baseUrl: 'https://api.openai.com/v1', model: 'chat-model' }
    },
    fetchFn: async () => response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] })),
    createId: () => 'media-id',
  })

  await runtime.generate({
    kind: 'hermes', request: { type: 'image', prompt: 'a geometric poster' }, workdir,
  })

  assert.deepEqual(providerRequests, [['hermes', 'image']])
})

test('maps ZGCI image requests to the deployed Qwen Image model', async (t) => {
  const calls = []
  const { workdir, runtime } = fixture(t, async (url, init = {}) => {
    calls.push([String(url), init])
    return response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }))
  }, {
    apiKey: 'stored-zgci-credential', baseUrl: 'https://hub.zgci.org/v1', model: 'glm',
  })

  const result = await runtime.generate({
    kind: 'codex', request: { type: 'image', prompt: 'a geometric poster' }, workdir,
  })

  assert.equal(result.filename, 'generated-image-media-id.png')
  assert.equal(calls[0][0], 'https://hub.zgci.org/v1/images/generations')
  assert.equal(JSON.parse(calls[0][1].body).model, 'Qwen-Image-2512')
})

test('writes binary audio output and uses the audio endpoint', async (t) => {
  const { workdir, runtime } = fixture(t, async (url) => {
    assert.equal(String(url), 'https://api.openai.com/v1/audio/speech')
    return response(MP3, { headers: { 'content-type': 'audio/mpeg' } })
  })
  const result = await runtime.generate({
    kind: 'codex', request: { type: 'audio', prompt: 'hello world' }, workdir,
  })

  assert.equal(result.filename, 'generated-audio-media-id.mp3')
  assert.deepEqual(fs.readFileSync(path.join(workdir, '.meldwork-output', result.filename)), MP3)
})

test('polls an async video job and downloads the completed media locally', async (t) => {
  const calls = []
  const { workdir, runtime } = fixture(t, async (url, init = {}) => {
    calls.push([String(url), init.method || 'GET'])
    if (String(url).endsWith('/videos')) {
      return response(JSON.stringify({ id: 'video-1', status: 'queued' }))
    }
    if (String(url).endsWith('/videos/video-1')) {
      return response(JSON.stringify({ status: 'completed', url: 'https://download.example/video.mp4' }))
    }
    return response(MP4, { headers: { 'content-type': 'video/mp4' } })
  })
  const result = await runtime.generate({
    kind: 'codex', request: { type: 'video', prompt: 'a sunset over water' }, workdir,
  })

  assert.equal(result.filename, 'generated-video-media-id.mp4')
  assert.deepEqual(fs.readFileSync(path.join(workdir, '.meldwork-output', result.filename)), MP4)
  assert.deepEqual(calls.map(call => call[0]), [
    'https://api.openai.com/v1/videos',
    'https://api.openai.com/v1/videos/video-1',
    'https://download.example/video.mp4',
  ])
})

test('uses the legacy H3 submit, status, and content endpoints with secure provider credentials', async (t) => {
  const calls = []
  const { workdir, runtime } = fixture(t, async (url, init = {}) => {
    calls.push([String(url), init])
    if (String(url).endsWith('/v1/videogen')) {
      return response(JSON.stringify({ task_id: 'h3-task', status: 'queued', progress: 0 }))
    }
    if (String(url).endsWith('/v1/videogen/h3-task')) {
      return response(JSON.stringify({ task_id: 'h3-task', status: 'completed', progress: 100 }))
    }
    return response(MP4, { headers: { 'content-type': 'video/mp4' } })
  }, {
    apiKey: 'stored-h3-credential',
    baseUrl: 'https://helper.ihainan.me',
    model: 'minimax-h3',
  })

  const result = await runtime.generate({
    kind: 'codex', request: { type: 'video', prompt: 'a sunlit city street' }, workdir,
  })

  assert.equal(result.filename, 'generated-video-media-id.mp4')
  assert.deepEqual(fs.readFileSync(path.join(workdir, '.meldwork-output', result.filename)), MP4)
  assert.deepEqual(calls.map(([url]) => url), [
    'https://helper.ihainan.me/v1/videogen',
    'https://helper.ihainan.me/v1/videogen/h3-task',
    'https://helper.ihainan.me/v1/videogen/h3-task/content',
  ])
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    prompt: 'a sunlit city street', seconds: 4, steps: 20, size: '1280x720',
  })
  for (const [, init] of calls) {
    assert.equal(init.headers.Authorization, `Basic ${Buffer.from('stored-h3-credential').toString('base64')}`)
  }
})

test('uses the current ZGCI H3 videos workflow and model mapping', async (t) => {
  const calls = []
  const { workdir, runtime } = fixture(t, async (url, init = {}) => {
    calls.push([String(url), init])
    if (String(url).endsWith('/query/video_generation')) {
      return response(JSON.stringify({
        task_id: 'zgci-task', status: 'completed', file_id: 'zgci-file',
      }))
    }
    if (String(url).endsWith('/video_generation')) {
      return response(JSON.stringify({ task_id: 'zgci-task', status: 'queued' }))
    }
    if (String(url).endsWith('/files/retrieve')) {
      return response(MP4, { headers: { 'content-type': 'video/mp4' } })
    }
    throw new Error(`Unexpected request: ${url}`)
  }, {
    apiKey: 'stored-zgci-credential',
    baseUrl: 'https://hub.zgci.org/v1',
    model: 'glm',
  })

  const result = await runtime.generate({
    kind: 'openclaw', request: { type: 'video', prompt: 'a calm city sunrise' }, workdir,
  })

  assert.equal(result.filename, 'generated-video-media-id.mp4')
  assert.deepEqual(calls.map(([url]) => url), [
    'https://hub.zgci.org/v1/video_generation',
    'https://hub.zgci.org/v1/query/video_generation',
    'https://hub.zgci.org/v1/files/retrieve',
  ])
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    model: 'H3', prompt: 'a calm city sunrise', duration_seconds: 8,
    size: '1280x720', fps: 24,
  })
  assert.deepEqual(JSON.parse(calls[1][1].body), { task_id: 'zgci-task' })
  assert.deepEqual(JSON.parse(calls[2][1].body), { file_id: 'zgci-file' })
})

test('maps ZGCI audio requests to CosyVoice', async (t) => {
  const calls = []
  const { workdir, runtime } = fixture(t, async (url, init = {}) => {
    calls.push([String(url), init])
    return response(Buffer.from('RIFFaudio'), { headers: { 'content-type': 'audio/wav' } })
  }, {
    apiKey: 'stored-zgci-credential',
    baseUrl: 'https://hub.zgci.org/v1',
    model: 'glm',
  })

  const result = await runtime.generate({
    kind: 'hermes', request: { type: 'audio', prompt: '欢迎使用 Meldwork' }, workdir,
  })

  assert.equal(result.filename, 'generated-audio-media-id.wav')
  assert.equal(calls[0][0], 'https://hub.zgci.org/v1/audio/speech')
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    model: 'CosyVoice3-0.5B',
    input: '欢迎使用 Meldwork',
    voice: 'mm_Southern_Young_Man',
    response_format: 'wav',
  })
})

test('keeps provider errors secret-free and does not write a false attachment', async (t) => {
  const { workdir, runtime } = fixture(t, async () => (
    response('invalid token test-api-key', { status: 401, headers: { 'content-type': 'text/plain' } })
  ))
  await assert.rejects(
    runtime.generate({
      kind: 'codex', request: { type: 'image', prompt: 'a test image' }, workdir,
    }),
    { message: 'MEDIA_GENERATION_HTTP_401' },
  )
  assert.equal(fs.existsSync(path.join(workdir, '.meldwork-output', 'generated-image-media-id.png')), false)
})

test('retries transient provider failures before writing generated media', async (t) => {
  let attempts = 0
  const { workdir, runtime } = fixture(t, async () => {
    attempts += 1
    if (attempts < 3) return response('temporarily unavailable', { status: 503 })
    return response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }))
  })

  const result = await runtime.generate({
    kind: 'hermes', request: { type: 'image', prompt: 'a calm lake' }, workdir,
  })

  assert.equal(attempts, 3)
  assert.equal(result.filename, 'generated-image-media-id.png')
  assert.deepEqual(fs.readFileSync(path.join(workdir, '.meldwork-output', result.filename)), PNG)
})

test('stops after three transient provider failures without writing an attachment', async (t) => {
  let attempts = 0
  const { workdir, runtime } = fixture(t, async () => {
    attempts += 1
    return response('still unavailable', { status: 503 })
  })

  await assert.rejects(
    runtime.generate({
      kind: 'hermes', request: { type: 'image', prompt: 'a calm lake' }, workdir,
    }),
    { message: 'MEDIA_GENERATION_HTTP_503' },
  )
  assert.equal(attempts, 3)
  assert.equal(fs.existsSync(path.join(workdir, '.meldwork-output', 'generated-image-media-id.png')), false)
})

test('falls back to another secure Provider when the first lacks the media model', async (t) => {
  const providerRequests = []
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-media-generation-'))
  const workdir = path.join(directory, 'workspace')
  fs.mkdirSync(workdir)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const providers = [
    {
      apiKey: 'unsupported-key', baseUrl: 'https://hub.zgci.org/v1', model: 'glm',
      sourceKind: 'openclaw',
    },
    {
      apiKey: 'media-key', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1',
      sourceKind: 'opencodereview',
    },
  ]
  const runtime = new MediaGenerationRuntime({
    getProvider: (_kind, _type, excludedKinds = []) => {
      providerRequests.push([...excludedKinds])
      return providers.find(provider => !excludedKinds.includes(provider.sourceKind))
    },
    fetchFn: async (_url, init = {}) => {
      if (init.headers.Authorization === 'Bearer unsupported-key') {
        return response(JSON.stringify({
          error: { code: 'model_not_found', message: 'No available channel for model minimax-h3' },
        }), { status: 503 })
      }
      if (String(_url).endsWith('/videos')) {
        return response(JSON.stringify({ id: 'video-1', status: 'completed' }))
      }
      return response(MP4, { headers: { 'content-type': 'video/mp4' } })
    },
    createId: () => 'media-id',
    pollIntervalMs: 0,
  })

  const result = await runtime.generate({
    kind: 'hermes', request: { type: 'video', prompt: 'a calm lake' }, workdir,
  })

  assert.deepEqual(providerRequests, [[], ['openclaw']])
  assert.equal(result.filename, 'generated-video-media-id.mp4')
  assert.deepEqual(fs.readFileSync(path.join(workdir, '.meldwork-output', result.filename)), MP4)
})

test('reports a stable model-unavailable error after all secure Providers are exhausted', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-media-generation-'))
  const workdir = path.join(directory, 'workspace')
  fs.mkdirSync(workdir)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const runtime = new MediaGenerationRuntime({
    getProvider: (_kind, _type, excludedKinds = []) => {
      if (excludedKinds.includes('openclaw')) {
        throw new Error('MEDIA_GENERATION_PROVIDER_UNAVAILABLE')
      }
      return {
        apiKey: 'unsupported-key', baseUrl: 'https://hub.zgci.org/v1', model: 'glm',
        sourceKind: 'openclaw',
      }
    },
    fetchFn: async () => response(JSON.stringify({
      error: { code: 'model_not_found', message: 'No available channel for model minimax-h3' },
    }), { status: 503 }),
    createId: () => 'media-id',
    pollIntervalMs: 0,
  })

  await assert.rejects(
    runtime.generate({
      kind: 'hermes', request: { type: 'video', prompt: 'a calm lake' }, workdir,
    }),
    { code: 'MEDIA_GENERATION_MODEL_UNAVAILABLE' },
  )
})

test('falls back to another secure Provider after transient retries are exhausted', async (t) => {
  const providerRequests = []
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-media-generation-'))
  const workdir = path.join(directory, 'workspace')
  fs.mkdirSync(workdir)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const providers = [
    {
      apiKey: 'unavailable-key', baseUrl: 'https://hub.zgci.org/v1', model: 'glm',
      sourceKind: 'openclaw',
    },
    {
      apiKey: 'media-key', baseUrl: 'https://hub.zgci.org/v1', model: 'glm',
      sourceKind: 'opencodereview',
    },
  ]
  let unavailableAttempts = 0
  const runtime = new MediaGenerationRuntime({
    getProvider: (_kind, _type, excludedKinds = []) => {
      providerRequests.push([...excludedKinds])
      const provider = providers.find(candidate => !excludedKinds.includes(candidate.sourceKind))
      if (!provider) throw new Error('MEDIA_GENERATION_PROVIDER_UNAVAILABLE')
      return provider
    },
    fetchFn: async (_url, init = {}) => {
      if (init.headers.Authorization === 'Bearer unavailable-key') {
        unavailableAttempts += 1
        return response('temporarily unavailable', { status: 503 })
      }
      if (String(_url).endsWith('/images/generations')) {
        return response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }))
      }
      throw new Error(`Unexpected request: ${_url}`)
    },
    createId: () => 'media-id',
    pollIntervalMs: 0,
  })

  const result = await runtime.generate({
    kind: 'hermes', request: { type: 'image', prompt: 'a calm lake' }, workdir,
  })

  assert.equal(unavailableAttempts, 3)
  assert.deepEqual(providerRequests, [[], ['openclaw']])
  assert.equal(result.filename, 'generated-image-media-id.png')
  assert.deepEqual(fs.readFileSync(path.join(workdir, '.meldwork-output', result.filename)), PNG)
})
