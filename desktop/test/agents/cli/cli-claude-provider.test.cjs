const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const test = require('node:test')
const { invocation, runAgent } = require('../../../src/agents/cli/cli-adapters.cjs')
const { providerOptionsFor } = require('../../../src/providers/provider-options.cjs')

test('Claude credential helper reads a secret as data without shell expansion', {
  skip: process.platform === 'win32',
}, async () => {
  const secret = 'test-$(exit 37)-`exit 38`-"quoted"-$HOME-&-secret'
  const spec = invocation('claude', '/tmp/claude', '/tmp', '', {
    provider: { id: 'anthropic', model: 'test-model', baseUrl: 'https://example.com' },
    platform: 'linux',
  })
  const settings = JSON.parse(spec.args[spec.args.indexOf('--settings') + 1])
  const result = await promisify(execFile)('/bin/sh', ['-c', settings.apiKeyHelper], {
    env: { MELDWORK_PROVIDER_API_KEY: secret }, timeout: 5000,
  })
  assert.equal(result.stdout, secret)
  assert.equal(JSON.stringify(spec.args).includes(secret), false)
})

test('Claude Windows credential helper does not interpolate the key into cmd syntax', () => {
  const spec = invocation('claude', 'C:\\claude.exe', 'C:\\work', '', {
    provider: { id: 'anthropic', model: 'test-model' }, platform: 'win32',
  })
  const settings = JSON.parse(spec.args[spec.args.indexOf('--settings') + 1])
  assert.match(settings.apiKeyHelper, /GetEnvironmentVariable\('MELDWORK_PROVIDER_API_KEY'\)/)
  assert.doesNotMatch(settings.apiKeyHelper, /%MELDWORK_PROVIDER_API_KEY%/)
})

test('native Claude uses the selected Provider despite conflicting native settings', {
  skip: !process.env.MELDWORK_TEST_CLAUDE_EXECUTABLE,
  timeout: 40000,
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-claude-provider-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const requests = []
  const selectedKey = 'selected-validation-key'
  async function endpoint(label) {
    const server = http.createServer((req, res) => {
      req.resume()
      if (req.method === 'HEAD') { res.writeHead(200); res.end(); return }
      requests.push({ label, selectedKey: req.headers['x-api-key'] === selectedKey
        || req.headers.authorization === `Bearer ${selectedKey}` })
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const event of [
        { type: 'message_start', message: {
          id: 'msg_local', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
          content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 },
        } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'LOCAL_PROVIDER_OK' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      res.end()
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
    return `http://127.0.0.1:${server.address().port}`
  }
  const selected = await endpoint('selected')
  const native = await endpoint('native')
  const config = path.join(root, '.claude')
  fs.mkdirSync(config)
  const filename = path.join(config, 'settings.json')
  const settings = JSON.stringify({
    apiKeyHelper: 'exit 39', permissions: { deny: ['Bash(*)'] },
    env: {
      CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BASE_URL: native,
      ANTHROPIC_API_KEY: 'native-validation-key', ANTHROPIC_AUTH_TOKEN: 'native-validation-token',
      ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer native-header-token',
    },
  })
  fs.writeFileSync(filename, settings)
  const options = providerOptionsFor('claude', {
    OPENAI_API_KEY: selectedKey, OPENAI_BASE_URL: selected, OPENAI_MODEL: 'claude-sonnet-4-6',
  })
  const events = []
  const result = await runAgent({ kind: 'claude', executable: process.env.MELDWORK_TEST_CLAUDE_EXECUTABLE },
    'Reply with OK. Do not use tools.', root, {
      ...options, signal: AbortSignal.timeout(25000), onEvent: event => events.push(event),
      env: {
        ...options.env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: config,
        XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_STATE_HOME: root, XDG_CACHE_HOME: root,
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
        NO_PROXY: '*', no_proxy: '*', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    })
  assert.equal(result.text, 'LOCAL_PROVIDER_OK')
  assert.ok(requests.length > 0)
  assert.ok(requests.every(request => request.label === 'selected' && request.selectedKey))
  assert.equal(fs.readFileSync(filename, 'utf8'), settings)
  assert.equal(JSON.stringify(events).includes(selectedKey), false)
})
