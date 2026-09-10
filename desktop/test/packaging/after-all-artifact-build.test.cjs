const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const afterAllArtifactBuild = require('../../scripts/after-all-artifact-build.cjs')

test('DMG post-processing ignores non-DMG release artifacts', () => {
  assert.deepEqual(afterAllArtifactBuild.selectDmgArtifacts([
    '/dist/Meldwork-arm64.zip',
    '/dist/Meldwork-arm64.dmg.blockmap',
    '/dist/Meldwork-arm64.dmg',
  ]), ['/dist/Meldwork-arm64.dmg'])
})

test('DMG post-processing removes Finder-visible root resources', () => {
  assert.deepEqual(afterAllArtifactBuild.ROOT_HIDDEN_RESOURCES, [
    '.background.tiff',
    '.VolumeIcon.icns',
  ])
})

test('DMG post-processing locates electron-builder bundled Python', () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-dmg-cache-'))
  const pythonPath = path.join(
    cacheRoot,
    'dmg-builder@1.2.5',
    'bundle',
    'python',
    'bin',
    'python3.14',
  )
  fs.mkdirSync(path.dirname(pythonPath), { recursive: true })
  fs.writeFileSync(pythonPath, '')

  try {
    assert.equal(afterAllArtifactBuild.findBundledPython(cacheRoot), pythonPath)
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true })
  }
})

test('DMG post-processing extracts the mounted device and volume path', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-dmg-plist-'))
  const plist = '<plist />'
  const run = (file, args) => {
    assert.equal(file, 'plutil')
    assert.deepEqual(args.slice(0, 4), ['-convert', 'json', '-o', '-'])
    return JSON.stringify({
      'system-entities': [
        { 'dev-entry': '/dev/disk8', 'potentially-mountable': false },
        { 'dev-entry': '/dev/disk8s1', 'mount-point': '/Volumes/Meldwork' },
      ],
    })
  }

  try {
    assert.deepEqual(afterAllArtifactBuild.parseAttachedVolume(plist, workDir, run), {
      device: '/dev/disk8s1',
      mountPath: '/Volumes/Meldwork',
    })
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
  }
})
