const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT_HIDDEN_RESOURCES = ['.background.tiff', '.VolumeIcon.icns']

function selectDmgArtifacts(artifactPaths) {
  return artifactPaths.filter(artifactPath => artifactPath.endsWith('.dmg'))
}

function findBundledPython(cacheRoot = process.env.ELECTRON_BUILDER_CACHE) {
  const root = cacheRoot || path.join(os.homedir(), 'Library', 'Caches', 'electron-builder')
  const pending = [root]

  while (pending.length > 0) {
    const current = pending.pop()
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const candidate = path.join(current, entry.name)
      if (entry.isDirectory()) {
        pending.push(candidate)
      } else if (
        entry.isFile()
        && /^python3(?:\.\d+)?$/.test(entry.name)
        && path.basename(current) === 'bin'
        && candidate.includes(`${path.sep}dmg-builder@`)
      ) {
        return candidate
      }
    }
  }

  throw new Error(`Unable to locate dmg-builder's bundled Python under ${root}`)
}

function parseAttachedVolume(plist, workDir, run = execFileSync) {
  const plistPath = path.join(workDir, 'attach.plist')
  fs.writeFileSync(plistPath, plist)
  const parsed = JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', plistPath], {
    encoding: 'utf8',
  }))
  const mounted = parsed['system-entities'].find(entity => entity['mount-point'])
  if (!mounted) {
    throw new Error('hdiutil did not return a mounted DMG volume')
  }
  return { device: mounted['dev-entry'], mountPath: mounted['mount-point'] }
}

function repointDmgBackground(dmgPath, options = {}) {
  const run = options.execFile || execFileSync
  const pythonPath = options.pythonPath || findBundledPython(options.cacheRoot)
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-dmg-'))
  const readWriteDmg = path.join(workDir, 'writable.dmg')
  const repackedDmg = `${dmgPath}.repacked-${process.pid}.dmg`
  let device

  try {
    run('hdiutil', ['convert', dmgPath, '-format', 'UDRW', '-o', readWriteDmg], {
      stdio: 'pipe',
    })
    const attached = parseAttachedVolume(run('hdiutil', [
      'attach', readWriteDmg, '-nobrowse', '-readwrite', '-plist',
    ], { encoding: 'utf8' }), workDir, run)
    device = attached.device

    const backgroundPath = path.join(
      attached.mountPath,
      'Meldwork.app',
      'Contents',
      'Resources',
      'dmg-background.tiff',
    )
    if (!fs.existsSync(backgroundPath)) {
      throw new Error(`Packaged DMG background is missing: ${backgroundPath}`)
    }

    run(pythonPath, [
      path.join(__dirname, 'repoint-dmg-background.py'),
      path.join(attached.mountPath, '.DS_Store'),
      backgroundPath,
    ], { stdio: 'pipe' })

    for (const resource of ROOT_HIDDEN_RESOURCES) {
      fs.rmSync(path.join(attached.mountPath, resource), { force: true })
    }
    run('/usr/bin/SetFile', ['-a', 'c', attached.mountPath], { stdio: 'pipe' })
    run('/bin/sync', [], { stdio: 'pipe' })
    run('hdiutil', ['detach', device], { stdio: 'pipe' })
    device = null

    run('hdiutil', [
      'convert', readWriteDmg, '-format', 'UDZO', '-imagekey', 'zlib-level=9', '-o', repackedDmg,
    ], { stdio: 'pipe' })
    fs.renameSync(repackedDmg, dmgPath)
  } finally {
    if (device) {
      try {
        run('hdiutil', ['detach', '-force', device], { stdio: 'pipe' })
      } catch {}
    }
    fs.rmSync(repackedDmg, { force: true })
    fs.rmSync(workDir, { recursive: true, force: true })
  }
}

async function afterAllArtifactBuild(buildResult) {
  for (const dmgPath of selectDmgArtifacts(buildResult.artifactPaths)) {
    repointDmgBackground(dmgPath)
  }
  return []
}

afterAllArtifactBuild.ROOT_HIDDEN_RESOURCES = ROOT_HIDDEN_RESOURCES
afterAllArtifactBuild.selectDmgArtifacts = selectDmgArtifacts
afterAllArtifactBuild.findBundledPython = findBundledPython
afterAllArtifactBuild.parseAttachedVolume = parseAttachedVolume
afterAllArtifactBuild.repointDmgBackground = repointDmgBackground

module.exports = afterAllArtifactBuild
