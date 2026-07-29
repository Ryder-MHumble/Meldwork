const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const afterPack = require('../scripts/after-pack.cjs')

function darwinContext({ addElectronFuses = async () => {}, generateFuseConfig } = {}) {
  return {
    electronPlatformName: 'darwin',
    appOutDir: '/tmp/roundrelay-pack',
    packager: {
      appInfo: { productFilename: 'RoundRelay' },
      addElectronFuses,
      generateFuseConfig: generateFuseConfig || (async config => config),
    },
  }
}

test('macOS packaging removes unused permission declarations before signing', async () => {
  const calls = []
  const generatedFuseConfigs = []
  const fuseCalls = []
  const appPath = path.join('/tmp/roundrelay-pack', 'RoundRelay.app')
  const infoPlistPath = path.join(appPath, 'Contents', 'Info.plist')
  const generatedFuseConfig = { version: 'test-v1' }
  const context = darwinContext({
    generateFuseConfig: async (config) => {
      generatedFuseConfigs.push(config)
      return generatedFuseConfig
    },
    addElectronFuses: async (...args) => { fuseCalls.push(args) },
  })

  await afterPack(context, (file, args, options) => {
    calls.push({ file, args, options })
  })

  assert.deepEqual(
    calls.slice(0, -1).map(call => call.args),
    afterPack.UNUSED_INFO_PLIST_KEYS.map(key => ['-c', `Delete :${key}`, infoPlistPath]),
  )
  assert.deepEqual(generatedFuseConfigs, [afterPack.ELECTRON_FUSES])
  assert.deepEqual(fuseCalls, [[context, generatedFuseConfig]])
  assert.deepEqual(calls.at(-1), {
    file: '/usr/bin/codesign',
    args: ['--force', '--deep', '--sign', '-', appPath],
    options: { stdio: 'inherit' },
  })
})

test('missing default plist keys do not prevent ad-hoc signing', async () => {
  const calls = []

  await afterPack(darwinContext(), (file, args) => {
    calls.push({ file, args })
    if (file === '/usr/libexec/PlistBuddy') throw new Error('missing key')
  })

  assert.equal(
    calls.filter(call => call.file === '/usr/libexec/PlistBuddy').length,
    afterPack.UNUSED_INFO_PLIST_KEYS.length,
  )
  assert.equal(calls.at(-1).file, '/usr/bin/codesign')
})

test('non-macOS packaging leaves the application untouched', async () => {
  let called = false

  await afterPack({ electronPlatformName: 'win32' }, () => { called = true })

  assert.equal(called, false)
})
