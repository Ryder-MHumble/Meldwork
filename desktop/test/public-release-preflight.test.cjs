const test = require('node:test')
const assert = require('node:assert/strict')

const {
  assertPublicReleaseEnvironment,
  notarizationStrategy,
  signingStrategy,
} = require('../scripts/public-release-preflight.cjs')

test('public release preflight accepts an encrypted certificate and API key credentials', () => {
  const calls = []
  const result = assertPublicReleaseEnvironment({
    platform: 'darwin',
    env: {
      CSC_LINK: '/private/certificate.p12',
      CSC_KEY_PASSWORD: 'secret',
      APPLE_API_KEY: '/private/AuthKey.p8',
      APPLE_API_KEY_ID: 'KEY123',
      APPLE_API_ISSUER: 'issuer-id',
    },
    execFile: (file, args) => {
      calls.push([file, args])
      return '/usr/bin/notarytool\n'
    },
  })

  assert.deepEqual(result, { signing: 'certificate-file', notarization: 'api-key' })
  assert.deepEqual(calls, [['/usr/bin/xcrun', ['--find', 'notarytool']]])
})

test('public release preflight accepts valid local Developer ID and Keychain profile credentials', () => {
  const calls = []
  const result = assertPublicReleaseEnvironment({
    platform: 'darwin',
    env: { APPLE_KEYCHAIN_PROFILE: 'meldwork-notary' },
    execFile: (file, args) => {
      calls.push([file, args])
      if (file === '/usr/bin/security') {
        return '1) ABCDEF "Developer ID Application: Ryder Sun (TEAM123456)"\n'
      }
      return '/usr/bin/notarytool\n'
    },
  })

  assert.deepEqual(result, { signing: 'keychain-identity', notarization: 'keychain-profile' })
  assert.equal(calls.length, 2)
})

test('public release preflight rejects non-macOS and incomplete credentials', () => {
  assert.throws(
    () => assertPublicReleaseEnvironment({ platform: 'linux', env: {} }),
    { message: 'PUBLIC_RELEASE_MACOS_REQUIRED' },
  )
  assert.throws(
    () => signingStrategy({ CSC_LINK: '/private/certificate.p12' }),
    { message: 'PUBLIC_RELEASE_CERTIFICATE_CREDENTIALS_INCOMPLETE' },
  )
  assert.throws(
    () => notarizationStrategy({ APPLE_ID: 'release@example.com' }),
    { message: 'PUBLIC_RELEASE_APPLE_ID_CREDENTIALS_INCOMPLETE' },
  )
  assert.throws(
    () => notarizationStrategy({}),
    { message: 'PUBLIC_RELEASE_NOTARIZATION_CREDENTIALS_MISSING' },
  )
})

test('public release preflight rejects an unrelated or missing signing identity', () => {
  assert.throws(
    () => signingStrategy({ CSC_NAME: 'www.dingtalkcs.com' }),
    { message: 'PUBLIC_RELEASE_SIGNING_IDENTITY_INVALID' },
  )
  assert.throws(
    () => signingStrategy({}, () => '0 valid identities found\n'),
    { message: 'PUBLIC_RELEASE_SIGNING_IDENTITY_MISSING' },
  )
})
