const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { atomicWritePrivateFile } = require('./private-file.cjs')

const OPENCLAW_PROVIDER_ID = 'roundrelay-desktop'
const READ_ONLY_TOOLS = [
  'read', 'web_search', 'web_fetch', 'memory_search', 'memory_get', 'session_status',
]
const WRITE_TOOLS = ['write', 'edit', 'apply_patch']
const DENIED_TOOLS = [
  'exec', 'process', 'code_execution', 'browser', 'canvas', 'gateway', 'nodes', 'cron',
  'message', 'sessions_send', 'sessions_spawn', 'subagents',
]

function normalizeProvider(input) {
  const apiKey = String(input?.OPENAI_API_KEY || '').trim()
  const baseUrl = String(input?.OPENAI_BASE_URL || '').trim().replace(/\/$/, '')
  const model = String(input?.OPENAI_MODEL || '').trim()
  let parsed
  try { parsed = new URL(baseUrl) } catch { throw new Error('OPENCLAW_PROVIDER_INVALID') }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  if (!apiKey || apiKey.length > 8192 || !model || model.length > 120
      || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback))
      || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('OPENCLAW_PROVIDER_INVALID')
  }
  return { apiKey, baseUrl, model }
}

function managedOpenClawOptions({
  storageRoot, workdir, sessionRef = '', allowWrite = false, provider,
}) {
  if (!path.isAbsolute(storageRoot) || !path.isAbsolute(workdir)) {
    throw new Error('OPENCLAW_RUNTIME_INVALID_SCOPE')
  }
  const normalized = normalizeProvider(provider)
  const resolvedStorageRoot = path.resolve(storageRoot)
  const resolvedWorkdir = path.resolve(workdir)
  const scope = crypto.createHash('sha256')
    .update(`${sessionRef || 'configure'}\0${resolvedWorkdir}`)
    .digest('hex')
    .slice(0, 24)
  const runtimeRoot = path.join(resolvedStorageRoot, 'openclaw-managed', scope)
  const home = path.join(runtimeRoot, 'home')
  const state = path.join(runtimeRoot, 'state')
  const configPath = path.join(
    runtimeRoot,
    allowWrite ? 'openclaw.workspace-write.json' : 'openclaw.read-only.json',
  )
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  fs.mkdirSync(state, { recursive: true, mode: 0o700 })

  const modelRef = `${OPENCLAW_PROVIDER_ID}/${normalized.model}`
  const allowedTools = allowWrite
    ? [...READ_ONLY_TOOLS, ...WRITE_TOOLS]
    : READ_ONLY_TOOLS
  const config = {
    agents: {
      defaults: {
        workspace: resolvedWorkdir,
        model: { primary: modelRef },
        skipBootstrap: true,
      },
    },
    models: {
      mode: 'replace',
      providers: {
        [OPENCLAW_PROVIDER_ID]: {
          baseUrl: normalized.baseUrl,
          apiKey: {
            source: 'env', provider: 'default', id: 'ROUNDRELAY_OPENCLAW_API_KEY',
          },
          api: 'openai-completions',
          models: [{ id: normalized.model, name: normalized.model, input: ['text'] }],
        },
      },
    },
    tools: {
      allow: allowedTools,
      deny: DENIED_TOOLS,
      fs: { workspaceOnly: true },
      exec: { security: 'deny', ask: 'always' },
      elevated: { enabled: false },
    },
  }
  const contents = `${JSON.stringify(config, null, 2)}\n`
  let current = ''
  try { current = fs.readFileSync(configPath, 'utf8') } catch { /* first use */ }
  if (current !== contents) atomicWritePrivateFile(configPath, contents)

  return {
    env: {
      OPENCLAW_HOME: home,
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_WORKSPACE_DIR: resolvedWorkdir,
      ROUNDRELAY_OPENCLAW_API_KEY: normalized.apiKey,
    },
  }
}

module.exports = { managedOpenClawOptions }
