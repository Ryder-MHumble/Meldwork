const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const net = require('node:net')
const { spawn } = require('node:child_process')

const {
  discoverAgents,
  invocationFor,
  parentSessionDetached,
  parseAgentOutput,
} = require('../../../src/agents/cloud/cloud-agent-bridge-server.cjs')

test('detects a Bridge parent process detached from its SSH session', () => {
  assert.equal(parentSessionDetached(123, () => '123 (node) S 456 0 0 0'), false)
  assert.equal(parentSessionDetached(123, () => '123 (node) S 1 0 0 0'), true)
  assert.equal(parentSessionDetached(123, () => { throw new Error('gone') }), true)
})

test('starts the Bridge when the module is executed through node stdin', async () => {
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const selected = server.address().port
      server.close(error => error ? reject(error) : resolve(selected))
    })
  })
  const script = fs.readFileSync(
    require.resolve('../../../src/agents/cloud/cloud-agent-bridge-server.cjs'),
    'utf8',
  )
  const child = spawn(process.execPath, ['-'], {
    env: { ...process.env, MELDWORK_AGENT_BRIDGE_PORT: String(port) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  try {
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Bridge did not start')), 3000)
      child.once('error', reject)
      child.stdout.on('data', (chunk) => {
        if (!String(chunk).includes(`MELDWORK_AGENT_BRIDGE_READY ${port}`)) return
        clearTimeout(timer)
        resolve(true)
      })
    })
    child.stdin.end(script)
    assert.equal(await ready, true)
  } finally {
    child.kill('SIGTERM')
  }
})

test('discovers supported remote CLIs and keeps an unauthenticated CLI visible but unavailable', () => {
  const outputs = new Map([
    ['codex --version', { status: 0, stdout: 'codex-cli 0.146.1\n' }],
    ['codex login status', { status: 0, stdout: 'Logged in using an API key\n' }],
    ['hermes --version', { status: 0, stdout: 'Hermes Agent v0.19.1 (2026.7.30)\n' }],
    ['claude --version', { status: 0, stdout: '2.1.123 (Claude Code)\n' }],
    ['claude auth status', { status: 0, stdout: '{"loggedIn":false,"authMethod":"none"}\n' }],
  ])
  const agents = discoverAgents({
    spawnSync: (command, args) => outputs.get(`${command} ${args.join(' ')}`)
      || { status: 127, stdout: '' },
    listSkills: kind => kind === 'hermes'
      ? [{ namespace: 'hermes', slug: 'research', name: 'research' }]
      : [],
  })

  assert.deepEqual(agents.map(agent => [agent.id, agent.version, agent.available]), [
    ['codex', '0.146.1', true],
    ['hermes', '0.19.1', true],
    ['claude', '2.1.123', false],
  ])
  assert.deepEqual(agents[1].skills, [{ namespace: 'hermes', slug: 'research', name: 'research' }])
  assert.equal(agents[2].credentialState, 'missing')
})

test('builds read-only invocations and parses Hermes and Claude output', () => {
  assert.deepEqual(invocationFor('codex', 'hello', 'thread-1'), {
    command: 'codex',
    args: ['exec', 'resume', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', 'thread-1', '-'],
    input: 'hello',
  })
  assert.deepEqual(invocationFor('hermes', 'hello', ''), {
    command: 'hermes',
    args: ['chat', '--quiet', '--query', 'hello'],
    input: '',
  })
  assert.deepEqual(invocationFor('claude', 'hello', 'session-1'), {
    command: 'claude',
    args: [
      '--print', '--output-format', 'json', '--permission-mode', 'plan',
      '--resume', 'session-1', 'hello',
    ],
    input: '',
  })
  assert.deepEqual(parseAgentOutput('hermes', 'session_id: hermes-1\nremote answer\n'), {
    text: 'remote answer', sessionRef: 'hermes-1', outcome: 'completed',
  })
  assert.deepEqual(parseAgentOutput('codex', [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'codex answer' } }),
  ].join('\n')), {
    text: 'codex answer', sessionRef: 'thread-1', outcome: 'completed',
  })
  assert.deepEqual(parseAgentOutput('claude', JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    result: 'claude answer', session_id: 'claude-1',
  })), {
    text: 'claude answer', sessionRef: 'claude-1', outcome: 'completed',
  })
})
