const test = require('node:test')
const assert = require('node:assert/strict')

const verifyDeveloperIdSignature = require('../scripts/after-sign.cjs')

function context(platform = 'darwin') {
  return {
    electronPlatformName: platform,
    appOutDir: '/tmp/meldwork-public',
    packager: {
      appInfo: {
        id: 'com.rydersun.meldwork',
        productFilename: 'Meldwork',
      },
    },
  }
}

function signedResult(details) {
  return (file, args) => ({
    status: 0,
    stdout: '',
    stderr: args[0] === '-dv' ? details : '',
  })
}

test('public afterSign accepts only the permanent Developer ID identity', () => {
  const details = [
    'Identifier=com.rydersun.meldwork',
    'flags=0x10000(runtime) hashes=3+7 location=embedded',
    'Authority=Developer ID Application: Ryder Sun (TEAM123456)',
    'TeamIdentifier=TEAM123456',
  ].join('\n')

  assert.doesNotThrow(() => verifyDeveloperIdSignature(context(), signedResult(details)))
})

test('public afterSign rejects ad-hoc, unhardened, or mismatched signatures', () => {
  const base = [
    'Identifier=com.rydersun.meldwork',
    'flags=0x10000(runtime) hashes=3+7 location=embedded',
    'Authority=Developer ID Application: Ryder Sun (TEAM123456)',
    'TeamIdentifier=TEAM123456',
  ]
  assert.throws(
    () => verifyDeveloperIdSignature(context(), signedResult(base.filter(line => !line.startsWith('Authority=')).join('\n'))),
    { message: 'PUBLIC_RELEASE_DEVELOPER_ID_REQUIRED' },
  )
  assert.throws(
    () => verifyDeveloperIdSignature(context(), signedResult(base.map(line => line.startsWith('flags=') ? 'flags=0x0(none)' : line).join('\n'))),
    { message: 'PUBLIC_RELEASE_HARDENED_RUNTIME_REQUIRED' },
  )
  assert.throws(
    () => verifyDeveloperIdSignature(context(), signedResult(base.map(line => line.startsWith('Identifier=') ? 'Identifier=com.example.other' : line).join('\n'))),
    { message: 'PUBLIC_RELEASE_BUNDLE_ID_MISMATCH' },
  )
})

test('public afterSign ignores non-macOS packages', () => {
  let called = false
  verifyDeveloperIdSignature(context('win32'), () => { called = true })
  assert.equal(called, false)
})
