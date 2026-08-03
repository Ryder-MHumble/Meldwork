const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { atomicWritePrivateFile } = require('../src/private-file.cjs')

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roundrelay-private-file-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('private file writes replace contents atomically with restrictive permissions', (t) => {
  const directory = fixture(t)
  const filename = path.join(directory, 'nested', 'private.json')

  atomicWritePrivateFile(filename, 'first')
  atomicWritePrivateFile(filename, 'second')

  assert.equal(fs.readFileSync(filename, 'utf8'), 'second')
  assert.equal(fs.statSync(filename).mode & 0o777, 0o600)
  assert.deepEqual(fs.readdirSync(path.dirname(filename)), ['private.json'])
})

test('private file writes remove their temporary file when replacement fails', (t) => {
  const directory = fixture(t)
  const filename = path.join(directory, 'occupied')
  fs.mkdirSync(filename)

  assert.throws(() => atomicWritePrivateFile(filename, 'blocked'))
  assert.deepEqual(fs.readdirSync(directory), ['occupied'])
})

test('permission failures leave the previous destination unchanged', (t) => {
  const directory = fixture(t)
  const filename = path.join(directory, 'private.json')
  atomicWritePrivateFile(filename, 'first')
  const chmodSync = fs.chmodSync
  fs.chmodSync = () => { throw new Error('CHMOD_FAILED') }
  t.after(() => { fs.chmodSync = chmodSync })

  assert.throws(
    () => atomicWritePrivateFile(filename, 'second'),
    { message: 'CHMOD_FAILED' },
  )
  assert.equal(fs.readFileSync(filename, 'utf8'), 'first')
  assert.deepEqual(fs.readdirSync(directory), ['private.json'])
})
