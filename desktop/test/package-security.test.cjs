const test = require('node:test')
const assert = require('node:assert/strict')
const afterPack = require('../scripts/after-pack.cjs')

test('packaged Electron disables runtime injection and enforces app.asar integrity', () => {
  assert.deepEqual(afterPack.ELECTRON_FUSES, {
    runAsNode: false,
    enableCookieEncryption: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
  })
})
