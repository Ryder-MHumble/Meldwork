const { execFileSync } = require('node:child_process')
const path = require('node:path')

const UNUSED_INFO_PLIST_KEYS = Object.freeze([
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription',
  'NSAudioCaptureUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
  'NSAppTransportSecurity:NSAllowsArbitraryLoads',
])

const ELECTRON_FUSES = Object.freeze({
  runAsNode: false,
  enableCookieEncryption: false,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
})

async function afterPack(context, execFile = execFileSync) {
  if (context.electronPlatformName !== 'darwin') return
  const appName = `${context.packager.appInfo.productFilename}.app`
  const appPath = path.join(context.appOutDir, appName)
  const infoPlistPath = path.join(appPath, 'Contents', 'Info.plist')

  for (const key of UNUSED_INFO_PLIST_KEYS) {
    try {
      execFile('/usr/libexec/PlistBuddy', ['-c', `Delete :${key}`, infoPlistPath], {
        stdio: 'ignore',
      })
    } catch {
      // Electron may stop emitting a default key in a future release.
    }
  }

  const fuseConfig = await context.packager.generateFuseConfig(ELECTRON_FUSES)
  await context.packager.addElectronFuses(context, fuseConfig)

  execFile('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  })
}

afterPack.UNUSED_INFO_PLIST_KEYS = UNUSED_INFO_PLIST_KEYS
afterPack.ELECTRON_FUSES = ELECTRON_FUSES

module.exports = afterPack
