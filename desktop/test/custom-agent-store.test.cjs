const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { PassThrough } = require('node:stream')
const { CustomAgentStore } = require('../src/custom-agent-store.cjs')

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-custom-agent-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const executable = path.join(directory, 'review-agent')
  fs.writeFileSync(executable, '#!/bin/sh\nprintf "review-agent 1.0.0\\n"\n', { mode: 0o700 })
  fs.chmodSync(executable, 0o700)
  const store = new CustomAgentStore({
    storagePath: path.join(directory, 'custom-agents.json'),
    createId: () => options.id || '0123456789abcdef',
    execFileFn: options.execFileFn || (async () => ({ stdout: 'review-agent 1.0.0\n', stderr: '' })),
    now: () => '2026-08-03T00:00:00.000Z',
  })
  return { directory, executable, store }
}

test('stores private definitions while exposing only sanitized Custom Agent metadata', async (t) => {
  const { directory, executable, store } = fixture(t)
  const profile = store.create({
    label: 'Review Agent',
    description: 'Reviews the current repository.',
    args: ['review', '--format=text'],
    promptMode: 'stdin',
  }, executable)

  assert.equal(profile.kind, 'custom-0123456789abcdef')
  assert.equal(profile.commandName, 'review-agent')
  assert.equal(profile.custom, true)
  assert.equal(profile.installed, true)
  assert.equal('executable' in profile, false)
  assert.equal('args' in profile, false)

  const storagePath = path.join(directory, 'custom-agents.json')
  const persisted = JSON.parse(fs.readFileSync(storagePath, 'utf8'))
  assert.equal(persisted.agents[0].executable, fs.realpathSync(executable))
  assert.deepEqual(persisted.agents[0].args, ['review', '--format=text'])
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(storagePath).mode & 0o777, 0o600)
  }

  const detected = await store.detectAgents()
  assert.equal(detected[0].version, 'review-agent 1.0.0')
  assert.equal(detected[0].executable, fs.realpathSync(executable))
  const catalog = await store.catalog()
  assert.equal(catalog[0].version, 'review-agent 1.0.0')
  assert.equal('executable' in catalog[0], false)
  assert.equal('args' in catalog[0], false)
})

test('rejects secret-like fixed arguments and invalid executable selections', (t) => {
  const { directory, executable, store } = fixture(t)

  assert.throws(() => store.create({
    label: 'Unsafe Agent',
    args: ['--api-key=sk-example0123456789'],
    promptMode: 'stdin',
  }, executable), { code: 'CUSTOM_AGENT_SECRET_ARGUMENT_BLOCKED' })
  assert.throws(() => store.create({
    label: 'Missing Agent',
    args: [],
    promptMode: 'stdin',
  }, path.join(directory, 'missing')), { code: 'CUSTOM_AGENT_EXECUTABLE_INVALID' })
  assert.deepEqual(store.list(), [])
})

test('runs a Custom Agent without a shell and redacts its private executable path', async (t) => {
  const { executable, store } = fixture(t)
  store.create({
    label: 'Review Agent',
    args: ['review', '--format=text'],
    promptMode: 'argument',
  }, executable)
  let invocation
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  child.kill = () => true
  const spawnFn = (command, args, options) => {
    invocation = { command, args, options }
    setImmediate(() => {
      child.stdout.write(`Completed with ${command}`)
      child.emit('close', 0)
    })
    return child
  }

  const result = await store.run('custom-0123456789abcdef', 'Review this change', '/tmp', {
    spawnFn,
  })

  assert.equal(invocation.command, fs.realpathSync(executable))
  assert.deepEqual(invocation.args, ['review', '--format=text', 'Review this change'])
  assert.equal(invocation.options.shell, false)
  assert.equal(invocation.options.cwd, '/tmp')
  assert.equal(result.text, 'Completed with review-agent')
  assert.equal(result.sessionRef, '')
})

test('cancels the Custom Agent process through the shared AbortSignal', async (t) => {
  const { executable, store } = fixture(t)
  store.create({ label: 'Review Agent', args: [], promptMode: 'stdin' }, executable)
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  child.kill = () => {
    setImmediate(() => child.emit('close', null))
    return true
  }
  const controller = new AbortController()
  const run = store.run('custom-0123456789abcdef', 'Review this change', '/tmp', {
    signal: controller.signal,
    spawnFn: () => child,
  })
  controller.abort()

  await assert.rejects(run, { code: 'LOCAL_AGENT_EXECUTION_STOPPED' })
})
