const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const afterPack = require('../scripts/after-pack.cjs')
const publicBuild = require('../electron-builder.public.cjs')
const desktopPackage = require('../package.json')

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

test('DMG uses the branded background and fixed drag layout', () => {
  const dmg = desktopPackage.build.dmg
  assert.equal(dmg.background, 'build/dmg-background-ai-v2.png')
  assert.deepEqual(dmg.window, { width: 540, height: 380 })
  assert.equal(dmg.iconSize, 128)
  assert.deepEqual(dmg.contents, [
    { x: 145, y: 210, type: 'file' },
    { x: 395, y: 210, type: 'link', path: '/Applications' },
  ])

  const background = fs.readFileSync(path.join(__dirname, '..', dmg.background))
  assert.equal(background.readUInt32BE(16), 540)
  assert.equal(background.readUInt32BE(20), 380)
})
