const { execFileSync } = require('node:child_process')

function releaseError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function hasValue(env, name) {
  return typeof env[name] === 'string' && env[name].trim().length > 0
}

function completeGroup(env, names) {
  return names.every(name => hasValue(env, name))
}

function partialGroup(env, names) {
  return names.some(name => hasValue(env, name))
}

function notarizationStrategy(env) {
  const appleIdNames = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']
  if (partialGroup(env, appleIdNames)) {
    if (!completeGroup(env, appleIdNames)) {
      throw releaseError('PUBLIC_RELEASE_APPLE_ID_CREDENTIALS_INCOMPLETE')
    }
    return 'apple-id'
  }

  const apiKeyNames = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']
  if (partialGroup(env, apiKeyNames)) {
    if (!completeGroup(env, apiKeyNames)) {
      throw releaseError('PUBLIC_RELEASE_API_KEY_CREDENTIALS_INCOMPLETE')
    }
    return 'api-key'
  }

  if (hasValue(env, 'APPLE_KEYCHAIN') && !hasValue(env, 'APPLE_KEYCHAIN_PROFILE')) {
    throw releaseError('PUBLIC_RELEASE_KEYCHAIN_PROFILE_INCOMPLETE')
  }
  if (hasValue(env, 'APPLE_KEYCHAIN_PROFILE')) return 'keychain-profile'
  throw releaseError('PUBLIC_RELEASE_NOTARIZATION_CREDENTIALS_MISSING')
}

function signingStrategy(env, execFile = execFileSync) {
  if (hasValue(env, 'CSC_LINK') || hasValue(env, 'CSC_KEY_PASSWORD')) {
    if (!hasValue(env, 'CSC_LINK') || !hasValue(env, 'CSC_KEY_PASSWORD')) {
      throw releaseError('PUBLIC_RELEASE_CERTIFICATE_CREDENTIALS_INCOMPLETE')
    }
    return 'certificate-file'
  }

  if (hasValue(env, 'CSC_NAME')) {
    if (!env.CSC_NAME.includes('Developer ID Application')) {
      throw releaseError('PUBLIC_RELEASE_SIGNING_IDENTITY_INVALID')
    }
    return 'named-identity'
  }

  let identities = ''
  try {
    identities = execFile('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    throw releaseError('PUBLIC_RELEASE_SIGNING_IDENTITY_MISSING')
  }
  if (!String(identities).includes('Developer ID Application:')) {
    throw releaseError('PUBLIC_RELEASE_SIGNING_IDENTITY_MISSING')
  }
  return 'keychain-identity'
}

function assertPublicReleaseEnvironment({
  platform = process.platform,
  env = process.env,
  execFile = execFileSync,
} = {}) {
  if (platform !== 'darwin') throw releaseError('PUBLIC_RELEASE_MACOS_REQUIRED')
  const signing = signingStrategy(env, execFile)
  const notarization = notarizationStrategy(env)
  try {
    execFile('/usr/bin/xcrun', ['--find', 'notarytool'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    throw releaseError('PUBLIC_RELEASE_NOTARYTOOL_MISSING')
  }
  return { signing, notarization }
}

if (require.main === module) {
  try {
    const result = assertPublicReleaseEnvironment()
    process.stdout.write(
      `Public release preflight passed (signing=${result.signing}, notarization=${result.notarization}).\n`,
    )
  } catch (error) {
    process.stderr.write(`${error?.code || 'PUBLIC_RELEASE_PREFLIGHT_FAILED'}\n`)
    process.exitCode = 1
  }
}

module.exports = {
  assertPublicReleaseEnvironment,
  notarizationStrategy,
  signingStrategy,
}
