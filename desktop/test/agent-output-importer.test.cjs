const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { AttachmentStore } = require('../src/attachment-store.cjs')
const {
  captureAgentOutputState,
  importAgentOutputs,
} = require('../src/agent-output-importer.cjs')

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
])
const MP3 = Buffer.from('49443304000000000000', 'hex')
const MP4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(8)])

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-agent-output-'))
  const workdir = path.join(directory, 'workspace')
  const output = path.join(workdir, '.meldwork-output')
  fs.mkdirSync(output, { recursive: true })
  let sequence = 0
  const store = new AttachmentStore({
    rootPath: path.join(directory, 'attachments'),
    createId: () => `generated-${++sequence}`,
  })
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return { directory, workdir, output, store }
}

test('imports only new or changed top-level media from the controlled output directory', (t) => {
  const { directory, workdir, output, store } = fixture(t)
  fs.writeFileSync(path.join(output, 'old.png'), PNG)
  fs.writeFileSync(path.join(output, 'ignore.txt'), 'not media')
  const baseline = captureAgentOutputState(workdir)
  const startedAt = Date.now()

  fs.writeFileSync(path.join(output, 'poster.png'), PNG)
  fs.writeFileSync(path.join(output, 'voice.mp3'), MP3)
  fs.writeFileSync(path.join(output, 'demo.mp4'), MP4)
  fs.writeFileSync(path.join(output, 'renamed.jpg'), PNG)
  fs.mkdirSync(path.join(output, 'nested'))
  fs.writeFileSync(path.join(output, 'nested', 'hidden.png'), PNG)
  if (process.platform !== 'win32') {
    const outside = path.join(directory, 'outside.png')
    fs.writeFileSync(outside, PNG)
    fs.symlinkSync(outside, path.join(output, 'linked.png'))
  }

  const imported = importAgentOutputs({ workdir, baseline, startedAt }, store)

  assert.deepEqual(imported.map(item => item.name).sort(), [
    'demo.mp4', 'poster.png', 'voice.mp3',
  ])
  assert.equal(imported.length, 3)
  assert.equal(imported.some(item => item.name === 'old.png'), false)
  assert.equal(imported.some(item => item.name === 'hidden.png'), false)
  assert.equal(imported.some(item => item.name === 'linked.png'), false)
})

test('requires a matching pre-run baseline and refuses symlinked output directories', {
  skip: process.platform === 'win32',
}, (t) => {
  const { directory, workdir, output, store } = fixture(t)
  fs.writeFileSync(path.join(output, 'poster.png'), PNG)

  assert.deepEqual(importAgentOutputs({ workdir, baseline: null, startedAt: Date.now() }, store), [])

  fs.rmSync(output, { recursive: true })
  const outside = path.join(directory, 'outside-output')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'outside.png'), PNG)
  fs.symlinkSync(outside, output)

  assert.deepEqual(captureAgentOutputState(workdir).files, {})
  assert.deepEqual(importAgentOutputs({
    workdir,
    baseline: { workdirRealPath: fs.realpathSync(workdir), files: {} },
    startedAt: Date.now(),
  }, store), [])
})
