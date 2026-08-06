const path = require('node:path')
const { spawnSync } = require('node:child_process')

function releaseError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function runCodesign(spawn, args) {
  const result = spawn('/usr/bin/codesign', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result?.status !== 0) throw releaseError('PUBLIC_RELEASE_SIGNATURE_INVALID')
  return `${result.stdout || ''}\n${result.stderr || ''}`
}

function verifyDeveloperIdSignature(context, spawn = spawnSync) {
  if (context.electronPlatformName !== 'darwin') return
  const appName = `${context.packager.appInfo.productFilename}.app`
  const appPath = path.join(context.appOutDir, appName)

  runCodesign(spawn, ['--verify', '--deep', '--strict', '--verbose=2', appPath])
  const details = runCodesign(spawn, ['-dv', '--verbose=4', appPath])
  if (!/^Authority=Developer ID Application:/m.test(details)) {
    throw releaseError('PUBLIC_RELEASE_DEVELOPER_ID_REQUIRED')
  }
  const teamId = details.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim()
  if (!teamId || teamId === 'not set') throw releaseError('PUBLIC_RELEASE_TEAM_ID_MISSING')
  if (!/^flags=.*\bruntime\b/m.test(details)) {
    throw releaseError('PUBLIC_RELEASE_HARDENED_RUNTIME_REQUIRED')
  }

  const expectedId = String(context.packager.appInfo.id || '')
  const actualId = details.match(/^Identifier=(.+)$/m)?.[1]?.trim()
  if (expectedId && actualId !== expectedId) {
    throw releaseError('PUBLIC_RELEASE_BUNDLE_ID_MISMATCH')
  }
}

module.exports = verifyDeveloperIdSignature
module.exports.verifyDeveloperIdSignature = verifyDeveloperIdSignature
