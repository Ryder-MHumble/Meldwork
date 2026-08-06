const test = require('node:test')
const assert = require('node:assert/strict')
const afterPack = require('../scripts/after-pack.cjs')
const publicBuild = require('../electron-builder.public.cjs')

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

test('public release config requires signing, Developer ID verification, and notarization', () => {
  assert.equal(publicBuild.appId, 'com.rydersun.meldwork')
  assert.equal(publicBuild.forceCodeSigning, true)
  assert.equal(publicBuild.afterSign, 'scripts/after-sign.cjs')
  assert.equal(publicBuild.mac.notarize, true)
})

test('packaged application carries the open-source and commercial licensing notices', () => {
  const mappings = publicBuild.extraResources
  assert.equal(mappings.some(entry => entry.from === '../LICENSE' && entry.to === 'LICENSE'), true)
  assert.equal(mappings.some(entry => entry.from === '../NOTICE' && entry.to === 'NOTICE'), true)
  assert.equal(
    mappings.some(entry => entry.from === '../COMMERCIAL_USE.md' && entry.to === 'COMMERCIAL_USE.md'),
    true,
  )
})
