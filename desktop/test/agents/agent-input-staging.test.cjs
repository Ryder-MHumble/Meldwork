const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  cleanupStagedAgentInputs,
  stageAgentInputs,
  stagedAgentInputPrompt,
} = require('../../src/agents/agent-input-staging.cjs')

test('stages non-image inputs as temporary relative paths and cleans them up', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-agent-input-'))
  const sourceRoot = path.join(directory, 'private')
  const workdir = path.join(directory, 'workspace')
  fs.mkdirSync(sourceRoot)
  fs.mkdirSync(workdir)
  const documentPath = path.join(sourceRoot, 'document.pdf')
  const imagePath = path.join(sourceRoot, 'image.png')
  fs.writeFileSync(documentPath, '%PDF-1.7\n')
  fs.writeFileSync(imagePath, 'image')
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const staged = stageAgentInputs(workdir, [
    { path: imagePath, name: 'image.png', mimeType: 'image/png', size: 5 },
    { path: documentPath, name: 'private report.pdf', mimeType: 'application/pdf', size: 9 },
  ])
  const prompt = stagedAgentInputPrompt(staged)

  assert.deepEqual(staged.nativeImagePaths, [imagePath])
  assert.equal(staged.files.length, 1)
  assert.match(staged.files[0].relativePath, /^\.meldwork-input\/\.run-[^/]+\/1-private report\.pdf$/)
  assert.equal(path.isAbsolute(staged.files[0].relativePath), false)
  assert.equal(prompt.includes(sourceRoot), false)
  assert.match(prompt, /private report\.pdf/)
  assert.equal(fs.readFileSync(path.join(workdir, staged.files[0].relativePath), 'utf8'), '%PDF-1.7\n')

  cleanupStagedAgentInputs(staged)
  assert.equal(fs.existsSync(path.join(workdir, '.meldwork-input')), false)
})

test('stages images beyond the native limit as temporary file inputs', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-agent-input-'))
  const sourceRoot = path.join(directory, 'private')
  const workdir = path.join(directory, 'workspace')
  fs.mkdirSync(sourceRoot)
  fs.mkdirSync(workdir)
  const firstPath = path.join(sourceRoot, 'first.png')
  const secondPath = path.join(sourceRoot, 'second.png')
  fs.writeFileSync(firstPath, 'first')
  fs.writeFileSync(secondPath, 'second')
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const staged = stageAgentInputs(workdir, [
    { path: firstPath, name: 'first.png', mimeType: 'image/png', size: 5 },
    { path: secondPath, name: 'second.png', mimeType: 'image/png', size: 6 },
  ], 1)

  assert.deepEqual(staged.nativeImagePaths, [firstPath])
  assert.equal(staged.files.length, 1)
  assert.match(staged.files[0].relativePath, /second\.png$/)
  assert.match(stagedAgentInputPrompt(staged), /second\.png/)
  assert.equal(fs.readFileSync(path.join(workdir, staged.files[0].relativePath), 'utf8'), 'second')
})

test('rejects unsafe staged sources without leaving an input directory', {
  skip: process.platform === 'win32',
}, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-agent-input-'))
  const workdir = path.join(directory, 'workspace')
  const source = path.join(directory, 'source.pdf')
  const link = path.join(directory, 'link.pdf')
  fs.mkdirSync(workdir)
  fs.writeFileSync(source, '%PDF-1.7\n')
  fs.symlinkSync(source, link)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  assert.throws(() => stageAgentInputs(workdir, [{
    path: link, name: 'report.pdf', mimeType: 'application/pdf', size: 9,
  }]), { message: 'LOCAL_ATTACHMENT_STAGE_UNAVAILABLE' })
  assert.equal(fs.existsSync(path.join(workdir, '.meldwork-input')), false)
})
