const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const {
  ContentBlobStore,
  normalizeContentBlobRef,
} = require('../attachments/content-blob-store.cjs')
const {
  normalizeLocalSkillSnapshotProvenance,
} = require('./local-skill-contract.cjs')

const LOCAL_SKILL_SNAPSHOT_VERSION = 1
const MAX_SKILL_DEPTH = 8
const MAX_SKILL_DIRECTORIES = 512
const MAX_SKILL_FILES = 256
const MAX_SKILL_FILE_BYTES = 8 * 1024 * 1024
const MAX_SKILL_TOTAL_BYTES = 32 * 1024 * 1024
const MAX_RELATIVE_PATH_BYTES = 1024
const MAX_PATH_SEGMENT_BYTES = 255
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const READ_ONLY_DIRECTORY_MODE = 0o500
const READ_ONLY_FILE_MODE = 0o400
const SHA256 = /^[a-f0-9]{64}$/
const SNAPSHOT_ID = /^skill-snapshot-[a-f0-9]{64}$/
const COORDINATE = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,119}$/u
const TARGET_KIND = /^[a-z0-9][a-z0-9._-]{0,63}$/

function localSkillSnapshotError(code, cause) {
  const error = new Error(code)
  error.code = code
  if (cause) error.cause = cause
  return error
}

function fail(code) {
  throw localSkillSnapshotError(code)
}

function isSnapshotError(error) {
  return /^LOCAL_SKILL_SNAPSHOT_[A-Z0-9_]+$/.test(String(error?.message || ''))
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function sortedKeys(value) {
  if (!isPlainObject(value)) return ''
  const keys = Reflect.ownKeys(value)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return keys.every(key => typeof key === 'string' && descriptors[key].enumerable
    && typeof descriptors[key].get !== 'function'
    && typeof descriptors[key].set !== 'function')
    ? keys.sort().join(',')
    : ''
}

function canonicalValue(value, seen) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('LOCAL_SKILL_SNAPSHOT_MANIFEST_INVALID')
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (!value || typeof value !== 'object' || seen.has(value)) {
    fail('LOCAL_SKILL_SNAPSHOT_MANIFEST_INVALID')
  }
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return `[${value.map(item => canonicalValue(item, seen)).join(',')}]`
    }
    if (!isPlainObject(value)) fail('LOCAL_SKILL_SNAPSHOT_MANIFEST_INVALID')
    const keys = Reflect.ownKeys(value)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (!keys.every(key => typeof key === 'string' && descriptors[key].enumerable
        && typeof descriptors[key].get !== 'function'
        && typeof descriptors[key].set !== 'function')) {
      fail('LOCAL_SKILL_SNAPSHOT_MANIFEST_INVALID')
    }
    return `{${keys.sort().map(key => (
      `${JSON.stringify(key)}:${canonicalValue(value[key], seen)}`
    )).join(',')}}`
  } finally {
    seen.delete(value)
  }
}

function canonicalSkillSnapshotJson(value) {
  return canonicalValue(value, new Set())
}

function manifestHash(manifest) {
  return crypto.createHash('sha256').update(canonicalSkillSnapshotJson(manifest)).digest('hex')
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function realpath(filename) {
  return fs.realpathSync.native ? fs.realpathSync.native(filename) : fs.realpathSync(filename)
}

function isInsideOrEqual(root, candidate) {
  if (candidate === root) return true
  const relative = path.relative(root, candidate)
  return Boolean(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative))
}

function normalizeCoordinates(value) {
  if (sortedKeys(value) !== 'name,namespace,slug,targetKind') {
    fail('LOCAL_SKILL_SNAPSHOT_COORDINATES_INVALID')
  }
  const targetKind = String(value.targetKind || '')
  const namespace = String(value.namespace || '')
  const slug = String(value.slug || '')
  const name = String(value.name || '')
  if (!TARGET_KIND.test(targetKind) || !COORDINATE.test(namespace) || !COORDINATE.test(slug)
      || name !== name.trim() || !name || name.length > 100
      || /[\\/\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(name)
      || path.isAbsolute(name) || path.win32.isAbsolute(name)) {
    fail('LOCAL_SKILL_SNAPSHOT_COORDINATES_INVALID')
  }
  return { targetKind, namespace, slug, name }
}

function validatePathSegment(segment) {
  if (!segment || segment === '.' || segment === '..'
      || Buffer.byteLength(segment, 'utf8') > MAX_PATH_SEGMENT_BYTES
      || /[\\/\u0000-\u001f\u007f-\u009f]/u.test(segment)) {
    fail('LOCAL_SKILL_SNAPSHOT_PATH_INVALID')
  }
  return segment
}

function normalizeRelativePath(value) {
  if (typeof value !== 'string' || !value
      || Buffer.byteLength(value, 'utf8') > MAX_RELATIVE_PATH_BYTES
      || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)
      || path.posix.normalize(value) !== value) {
    fail('LOCAL_SKILL_SNAPSHOT_PATH_INVALID')
  }
  const segments = value.split('/')
  if (segments.length - 1 > MAX_SKILL_DEPTH) fail('LOCAL_SKILL_SNAPSHOT_DEPTH_LIMIT')
  for (const segment of segments) validatePathSegment(segment)
  return segments.join('/')
}

function portablePathKey(value) {
  return value.normalize('NFC').toLowerCase()
}

function isSensitiveEntryName(name, directory) {
  const lower = name.normalize('NFKC').toLowerCase()
  if (directory) {
    return new Set(['.ssh', '.gnupg', '.aws', '.azure']).has(lower)
  }
  if (/^\.env(?:\.|$)/.test(lower)) return true
  if (new Set([
    '.dockercfg',
    '.git-credentials',
    '.netrc',
    '.npmrc',
    '.pypirc',
  ]).has(lower)) return true
  if (/^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/.test(lower)) return true
  if (/\.(?:key|pem|p12|pfx|jks|keystore)$/.test(lower)) return true
  return /^(?:credentials?|secrets?|tokens?|api[-_]?keys?|client[-_]?secrets?|private[-_]?keys?|service[-_]?accounts?|access[-_]?tokens?|refresh[-_]?tokens?)(?:\.(?:json|ya?ml|toml|ini|conf|txt))?$/.test(lower)
}

function statFingerprint(stat) {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.nlink,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].map(value => String(value)).join(':')
}

function sameStat(left, right) {
  return statFingerprint(left) === statFingerprint(right)
}

function readExactFile(descriptor, size) {
  const bytes = Buffer.allocUnsafe(size)
  let offset = 0
  while (offset < size) {
    const count = fs.readSync(descriptor, bytes, offset, size - offset, offset)
    if (count === 0) break
    offset += count
  }
  const extra = Buffer.allocUnsafe(1)
  if (offset !== size || fs.readSync(descriptor, extra, 0, 1, size) !== 0) {
    fail('LOCAL_SKILL_SNAPSHOT_SOURCE_CHANGED')
  }
  return bytes
}

function readStableSourceFile(filename, rootRealPath, initialStat) {
  let descriptor
  try {
    const noFollow = process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW || 0)
    descriptor = fs.openSync(filename, fs.constants.O_RDONLY | noFollow)
    const openedStat = fs.fstatSync(descriptor, { bigint: true })
    if (!openedStat.isFile() || !sameStat(initialStat, openedStat)) {
      fail('LOCAL_SKILL_SNAPSHOT_SOURCE_CHANGED')
    }
    const size = Number(openedStat.size)
    const bytes = readExactFile(descriptor, size)
    const finalStat = fs.fstatSync(descriptor, { bigint: true })
    const pathStat = fs.lstatSync(filename, { bigint: true })
    if (pathStat.isSymbolicLink() || !pathStat.isFile()
        || !sameStat(openedStat, finalStat) || !sameStat(finalStat, pathStat)
        || !isInsideOrEqual(rootRealPath, realpath(filename))) {
      fail('LOCAL_SKILL_SNAPSHOT_SOURCE_CHANGED')
    }
    return bytes
  } catch (error) {
    if (isSnapshotError(error)) throw error
    if (['ELOOP', 'EMLINK'].includes(error.code)) fail('LOCAL_SKILL_SNAPSHOT_SYMLINK')
    if (error.code === 'ENOENT') fail('LOCAL_SKILL_SNAPSHOT_SOURCE_CHANGED')
    throw localSkillSnapshotError('LOCAL_SKILL_SNAPSHOT_SOURCE_UNAVAILABLE', error)
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch { /* already closed */ }
    }
  }
}

function scanSourceDirectory(sourceDirectory, includeBytes) {
  let rootStat
  let rootRealPath
  try {
    rootStat = fs.lstatSync(sourceDirectory, { bigint: true })
    if (rootStat.isSymbolicLink()) fail('LOCAL_SKILL_SNAPSHOT_SYMLINK')
    if (!rootStat.isDirectory()) fail('LOCAL_SKILL_SNAPSHOT_SOURCE_UNSAFE')
    rootRealPath = realpath(sourceDirectory)
    const pathStat = fs.lstatSync(sourceDirectory, { bigint: true })
    const resolvedStat = fs.lstatSync(rootRealPath, { bigint: true })
    if (pathStat.isSymbolicLink() || !pathStat.isDirectory()
        || !sameStat(rootStat, pathStat) || !sameStat(pathStat, resolvedStat)) {
      fail('LOCAL_SKILL_SNAPSHOT_SOURCE_CHANGED')
    }
  } catch (error) {
    if (isSnapshotError(error)) throw error
    throw localSkillSnapshotError('LOCAL_SKILL_SNAPSHOT_SOURCE_UNAVAILABLE', error)
  }

  const files = []
  const inventory = []
  const portablePaths = new Set()
  let directoryCount = 0
  let totalBytes = 0

  function visit(directory, relativeParts, depth) {
    if (depth > MAX_SKILL_DEPTH) fail('LOCAL_SKILL_SNAPSHOT_DEPTH_LIMIT')
    let before
    let entries
    try {
      before = fs.lstatSync(directory, { bigint: true })
      if (before.isSymbolicLink()) fail('LOCAL_SKILL_SNAPSHOT_SYMLINK')
      if (!before.isDirectory() || !isInsideOrEqual(rootRealPath, realpath(directory))) {
        fail('LOCAL_SKILL_SNAPSHOT_SOURCE_UNSAFE')
      }
      directoryCount += 1
      if (directoryCount > MAX_SKILL_DIRECTORIES) {
        fail('LOCAL_SKILL_SNAPSHOT_DIRECTORY_LIMIT')
      }
      inventory.push({
        type: 'directory',
        relativePath: relativeParts.join('/'),
        fingerprint: statFingerprint(before),
      })
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch (error) {
      if (isSnapshotError(error)) throw error
      throw localSkillSnapshotError('LOCAL_SKILL_SNAPSHOT_SOURCE_UNAVAILABLE', error)
    }

    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    for (const entry of entries) {
      validatePathSegment(entry.name)
      const filename = path.join(directory, entry.name)
      const nextParts = [...relativeParts, entry.name]
      const relativePath = normalizeRelativePath(nextParts.join('/'))
      const key = portablePathKey(relativePath)
      if (portablePaths.has(key)) fail('LOCAL_SKILL_SNAPSHOT_PATH_COLLISION')
      portablePaths.add(key)

      let stat
      try { stat = fs.lstatSync(filename, { bigint: true }) } catch (error) {
        if (error.code === 'ENOENT') fail('LOCAL_SKILL_SNAPSHOT_SOURCE_CHANGED')
        throw localSkillSnapshotError('LOCAL_SKILL_SNAPSHOT_SOURCE_UNAVAILABLE', error)
      }
      if (stat.isSymbolicLink()) fail('LOCAL_SKILL_SNAPSHOT_SYMLINK')
      if (entry.isSymbolicLink()) fail('LOCAL_SKILL_SNAPSHOT_SYMLINK')
      if (stat.isDirectory()) {
        if (isSensitiveEntryName(entry.name, true)) {
          fail('LOCAL_SKILL_SNAPSHOT_SENSITIVE_PATH')
        }
        visit(filename, nextParts, depth + 1)
        continue
      }
      if (!stat.isFile()) fail('LOCAL_SKILL_SNAPSHOT_SPECIAL_FILE')
      if (isSensitiveEntryName(entry.name, false)) {
        fail('LOCAL_SKILL_SNAPSHOT_SENSITIVE_PATH')
      }
      files.push({ relativePath, stat, filename })
      if (files.length > MAX_SKILL_FILES) fail('LOCAL_SKILL_SNAPSHOT_FILE_LIMIT')
      const size = Number(stat.size)
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_SKILL_FILE_BYTES) {
        fail('LOCAL_SKILL_SNAPSHOT_FILE_TOO_LARGE')
      }
      totalBytes += size
      if (totalBytes > MAX_SKILL_TOTAL_BYTES) {
        fail('LOCAL_SKILL_SNAPSHOT_TOTAL_TOO_LARGE')
      }
      inventory.push({
        type: 'file',
        relativePath,
        fingerprint: statFingerprint(stat),
      })
      if (includeBytes) {
        files[files.length - 1].bytes = readStableSourceFile(filename, rootRealPath, stat)
      }
    }

    let after
    try { after = fs.lstatSync(directory, { bigint: true }) } catch {
      fail('LOCAL_SKILL_SNAPSHOT_SOURCE_CHANGED')
    }
    if (after.isSymbolicLink() || !after.isDirectory() || !sameStat(before, after)) {
      fail('LOCAL_SKILL_SNAPSHOT_SOURCE_CHANGED')
    }
  }

  visit(rootRealPath, [], 0)
  const entry = files.find(file => !file.relativePath.includes('/')
    && file.relativePath.toLowerCase() === 'skill.md')?.relativePath
  if (!entry) fail('LOCAL_SKILL_SNAPSHOT_ENTRY_MISSING')
  return { entry, files, inventory, totalBytes }
}

function inventoriesMatch(left, right) {
  return left.length === right.length && left.every((entry, index) => (
    entry.type === right[index].type
      && entry.relativePath === right[index].relativePath
      && entry.fingerprint === right[index].fingerprint
  ))
}

function normalizeBlobRef(value) {
  if (sortedKeys(value) !== 'algorithm,hash,size') {
    fail('LOCAL_SKILL_SNAPSHOT_MANIFEST_INVALID')
  }
  try { return normalizeContentBlobRef(value) } catch {
    fail('LOCAL_SKILL_SNAPSHOT_MANIFEST_INVALID')
  }
}

function normalizeManifest(value) {
  if (sortedKeys(value) !== 'coordinates,entry,fileCount,files,totalBytes,version'
      || value.version !== LOCAL_SKILL_SNAPSHOT_VERSION
      || !Array.isArray(value.files) || !value.files.length
      || !Number.isSafeInteger(value.fileCount) || value.fileCount < 1
      || value.fileCount > MAX_SKILL_FILES || value.fileCount !== value.files.length
      || !Number.isSafeInteger(value.totalBytes) || value.totalBytes < 0
      || value.totalBytes > MAX_SKILL_TOTAL_BYTES) {
    fail('LOCAL_SKILL_SNAPSHOT_MANIFEST_INVALID')
  }
  for (let index = 0; index < value.files.length; index += 1) {
    if (!Object.hasOwn(value.files, index)) fail('LOCAL_SKILL_SNAPSHOT_MANIFEST_INVALID')
  }
  const coordinates = normalizeCoordinates(value.coordinates)
  const entry = normalizeRelativePath(value.entry)
  const paths = new Set()
  const portablePaths = new Set()
  let totalBytes = 0
  let previous = ''
  const files = value.files.map((file) => {
    if (sortedKeys(file) !== 'blobRef,contentHash,relativePath'
        || typeof file.contentHash !== 'string' || !SHA256.test(file.contentHash)) {
      fail('LOCAL_SKILL_SNAPSHOT_MANIFEST_INVALID')
    }
    const relativePath = normalizeRelativePath(file.relativePath)
    const blobRef = normalizeBlobRef(file.blobRef)
    if (blobRef.hash !== file.contentHash || blobRef.size > MAX_SKILL_FILE_BYTES
        || (previous && relativePath <= previous) || paths.has(relativePath)
        || portablePaths.has(portablePathKey(relativePath))) {
      fail('LOCAL_SKILL_SNAPSHOT_MANIFEST_INVALID')
    }
    previous = relativePath
    paths.add(relativePath)
    portablePaths.add(portablePathKey(relativePath))
    totalBytes += blobRef.size
    return { relativePath, blobRef, contentHash: file.contentHash }
  })
  if (totalBytes !== value.totalBytes || totalBytes > MAX_SKILL_TOTAL_BYTES
      || !paths.has(entry) || entry.includes('/') || entry.toLowerCase() !== 'skill.md') {
    fail('LOCAL_SKILL_SNAPSHOT_MANIFEST_INVALID')
  }
  return {
    version: LOCAL_SKILL_SNAPSHOT_VERSION,
    coordinates,
    entry,
    files,
    fileCount: files.length,
    totalBytes,
  }
}

function normalizeLocalSkillSnapshot(value) {
  const keys = sortedKeys(value)
  if (!['manifest,manifestHash,snapshotId', 'manifest,manifestHash,provenance,snapshotId'].includes(keys)
      || typeof value.manifestHash !== 'string' || !SHA256.test(value.manifestHash)
      || typeof value.snapshotId !== 'string' || !SNAPSHOT_ID.test(value.snapshotId)) {
    fail('LOCAL_SKILL_SNAPSHOT_INVALID')
  }
  const manifest = normalizeManifest(value.manifest)
  const hash = manifestHash(manifest)
  if (value.manifestHash !== hash || value.snapshotId !== `skill-snapshot-${hash}`) {
    fail('LOCAL_SKILL_SNAPSHOT_ID_MISMATCH')
  }
  const provenance = Object.hasOwn(value, 'provenance')
    ? normalizeLocalSkillSnapshotProvenance(value.provenance, value.manifestHash)
    : null
  return deepFreeze({
    snapshotId: value.snapshotId,
    manifestHash: value.manifestHash,
    manifest,
    ...(provenance ? { provenance } : {}),
  })
}

function bindLocalSkillSnapshotProvenance(value, provenance) {
  const snapshot = normalizeLocalSkillSnapshot(value)
  if (snapshot.provenance) fail('LOCAL_SKILL_PROVENANCE_INVALID')
  return normalizeLocalSkillSnapshot({ ...snapshot, provenance })
}

function expectedDirectories(files) {
  const directories = new Set([''])
  for (const file of files) {
    let current = path.posix.dirname(file.relativePath)
    while (current !== '.') {
      directories.add(current)
      current = path.posix.dirname(current)
    }
  }
  return [...directories].sort((left, right) => (
    left.split('/').length - right.split('/').length || (left < right ? -1 : left > right ? 1 : 0)
  ))
}

function writePrivateFile(filename, bytes) {
  let descriptor
  try {
    descriptor = fs.openSync(filename, 'wx', PRIVATE_FILE_MODE)
    fs.writeFileSync(descriptor, bytes)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.chmodSync(filename, READ_ONLY_FILE_MODE)
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch { /* already closed */ }
    }
    try { fs.unlinkSync(filename) } catch { /* absent */ }
    throw error
  }
}

function makeTreeWritableForCleanup(directory) {
  try {
    const stat = fs.lstatSync(directory)
    if (stat.isSymbolicLink() || !stat.isDirectory()) return
    fs.chmodSync(directory, PRIVATE_DIRECTORY_MODE)
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name)
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        makeTreeWritableForCleanup(filename)
      } else if (!entry.isSymbolicLink()) {
        try { fs.chmodSync(filename, PRIVATE_FILE_MODE) } catch { /* best effort */ }
      }
    }
  } catch { /* best effort */ }
}

class LocalSkillSnapshotStore {
  constructor({ contentBlobStore, rootPath } = {}) {
    if (!(contentBlobStore instanceof ContentBlobStore)) {
      fail('LOCAL_SKILL_SNAPSHOT_CONTENT_BLOB_STORE_REQUIRED')
    }
    if (typeof rootPath !== 'string' || !rootPath || rootPath.length > 4096) {
      fail('LOCAL_SKILL_SNAPSHOT_ROOT_REQUIRED')
    }
    this.contentBlobStore = contentBlobStore
    this.rootPath = path.resolve(rootPath)
    if (this.rootPath === path.parse(this.rootPath).root) {
      fail('LOCAL_SKILL_SNAPSHOT_ROOT_UNSAFE')
    }
    this.rootRealPath = this.prepareRoot()
  }

  create(input) {
    if (sortedKeys(input) !== 'name,namespace,slug,sourceDirectory,targetKind'
        || typeof input.sourceDirectory !== 'string'
        || !path.isAbsolute(input.sourceDirectory) || input.sourceDirectory.length > 4096) {
      fail('LOCAL_SKILL_SNAPSHOT_INPUT_INVALID')
    }
    const coordinates = normalizeCoordinates({
      targetKind: input.targetKind,
      namespace: input.namespace,
      slug: input.slug,
      name: input.name,
    })
    const sourceDirectory = path.resolve(input.sourceDirectory)
    const captured = scanSourceDirectory(sourceDirectory, true)
    let verified
    try { verified = scanSourceDirectory(sourceDirectory, false) } catch (error) {
      throw localSkillSnapshotError('LOCAL_SKILL_SNAPSHOT_SOURCE_CHANGED', error)
    }
    if (!inventoriesMatch(captured.inventory, verified.inventory)
        || captured.entry !== verified.entry || captured.totalBytes !== verified.totalBytes) {
      fail('LOCAL_SKILL_SNAPSHOT_SOURCE_CHANGED')
    }

    const files = captured.files
      .slice()
      .sort((left, right) => (
        left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0
      ))
      .map((file) => {
        let blobRef
        try { blobRef = this.contentBlobStore.put(file.bytes) } catch (error) {
          if (error?.code === 'CONTENT_BLOB_TAMPERED') {
            throw localSkillSnapshotError('LOCAL_SKILL_SNAPSHOT_BLOB_TAMPERED', error)
          }
          throw localSkillSnapshotError('LOCAL_SKILL_SNAPSHOT_BLOB_UNAVAILABLE', error)
        }
        return {
          relativePath: file.relativePath,
          blobRef,
          contentHash: blobRef.hash,
        }
      })
    const manifest = normalizeManifest({
      version: LOCAL_SKILL_SNAPSHOT_VERSION,
      coordinates,
      entry: captured.entry,
      files,
      fileCount: files.length,
      totalBytes: captured.totalBytes,
    })
    const hash = manifestHash(manifest)
    return normalizeLocalSkillSnapshot({
      snapshotId: `skill-snapshot-${hash}`,
      manifestHash: hash,
      manifest,
    })
  }

  materialize(value) {
    const snapshot = normalizeLocalSkillSnapshot(value)
    this.assertRoot()
    const blobs = snapshot.manifest.files.map((file) => {
      try {
        const bytes = this.contentBlobStore.read(file.blobRef)
        const hash = crypto.createHash('sha256').update(bytes).digest('hex')
        if (bytes.length !== file.blobRef.size || hash !== file.contentHash) {
          fail('LOCAL_SKILL_SNAPSHOT_BLOB_TAMPERED')
        }
        return { file, bytes }
      } catch (error) {
        if (isSnapshotError(error)) throw error
        if (error?.code === 'CONTENT_BLOB_NOT_FOUND') {
          throw localSkillSnapshotError('LOCAL_SKILL_SNAPSHOT_BLOB_NOT_FOUND', error)
        }
        if (error?.code === 'CONTENT_BLOB_TAMPERED') {
          throw localSkillSnapshotError('LOCAL_SKILL_SNAPSHOT_BLOB_TAMPERED', error)
        }
        throw localSkillSnapshotError('LOCAL_SKILL_SNAPSHOT_BLOB_UNAVAILABLE', error)
      }
    })
    const directory = path.join(this.rootPath, snapshot.snapshotId)
    try {
      const stat = fs.lstatSync(directory)
      if (stat) {
        this.verifyMaterialization(directory, snapshot.manifest, blobs)
        return deepFreeze({
          snapshotId: snapshot.snapshotId,
          directory,
          entryPath: path.join(directory, ...snapshot.manifest.entry.split('/')),
        })
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        if (isSnapshotError(error)) throw error
        throw localSkillSnapshotError('LOCAL_SKILL_SNAPSHOT_MATERIALIZATION_TAMPERED', error)
      }
    }

    let temporaryDirectory = ''
    try {
      temporaryDirectory = fs.mkdtempSync(path.join(this.rootPath, '.skill-snapshot-'))
      fs.chmodSync(temporaryDirectory, PRIVATE_DIRECTORY_MODE)
      const directories = expectedDirectories(snapshot.manifest.files)
      for (const relativePath of directories.slice(1)) {
        const target = path.join(temporaryDirectory, ...relativePath.split('/'))
        fs.mkdirSync(target, { mode: PRIVATE_DIRECTORY_MODE })
        fs.chmodSync(target, PRIVATE_DIRECTORY_MODE)
      }
      for (const { file, bytes } of blobs) {
        writePrivateFile(
          path.join(temporaryDirectory, ...file.relativePath.split('/')),
          bytes,
        )
      }
      for (const relativePath of directories.slice(1).reverse()) {
        fs.chmodSync(
          path.join(temporaryDirectory, ...relativePath.split('/')),
          READ_ONLY_DIRECTORY_MODE,
        )
      }
      fs.chmodSync(temporaryDirectory, READ_ONLY_DIRECTORY_MODE)
      fs.renameSync(temporaryDirectory, directory)
      temporaryDirectory = ''
      this.verifyMaterialization(directory, snapshot.manifest, blobs)
    } catch (error) {
      if (temporaryDirectory) {
        makeTreeWritableForCleanup(temporaryDirectory)
        try { fs.rmSync(temporaryDirectory, { recursive: true, force: true }) } catch { /* best effort */ }
      }
      if (isSnapshotError(error)) throw error
      if (['EEXIST', 'ENOTEMPTY'].includes(error.code)) {
        this.verifyMaterialization(directory, snapshot.manifest, blobs)
      } else {
        throw localSkillSnapshotError('LOCAL_SKILL_SNAPSHOT_STORAGE_UNAVAILABLE', error)
      }
    }
    return deepFreeze({
      snapshotId: snapshot.snapshotId,
      directory,
      entryPath: path.join(directory, ...snapshot.manifest.entry.split('/')),
    })
  }

  prepareRoot() {
    try {
      try {
        const existing = fs.lstatSync(this.rootPath)
        if (existing.isSymbolicLink() || !existing.isDirectory()) {
          fail('LOCAL_SKILL_SNAPSHOT_ROOT_UNSAFE')
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        fs.mkdirSync(this.rootPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
      }
      const stat = fs.lstatSync(this.rootPath)
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        fail('LOCAL_SKILL_SNAPSHOT_ROOT_UNSAFE')
      }
      fs.chmodSync(this.rootPath, PRIVATE_DIRECTORY_MODE)
      return realpath(this.rootPath)
    } catch (error) {
      if (isSnapshotError(error)) throw error
      throw localSkillSnapshotError('LOCAL_SKILL_SNAPSHOT_STORAGE_UNAVAILABLE', error)
    }
  }

  assertRoot() {
    try {
      const stat = fs.lstatSync(this.rootPath)
      if (stat.isSymbolicLink() || !stat.isDirectory()
          || realpath(this.rootPath) !== this.rootRealPath
          || (process.platform !== 'win32'
            && (stat.mode & 0o777) !== PRIVATE_DIRECTORY_MODE)) {
        fail('LOCAL_SKILL_SNAPSHOT_ROOT_UNSAFE')
      }
    } catch (error) {
      if (isSnapshotError(error)) throw error
      throw localSkillSnapshotError('LOCAL_SKILL_SNAPSHOT_ROOT_UNSAFE', error)
    }
  }

  verifyMaterialization(directory, manifest, blobs) {
    try {
      const rootStat = fs.lstatSync(directory)
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()
          || (process.platform !== 'win32'
            && (rootStat.mode & 0o777) !== READ_ONLY_DIRECTORY_MODE)) {
        fail('LOCAL_SKILL_SNAPSHOT_MATERIALIZATION_TAMPERED')
      }
      const materializedRoot = realpath(directory)
      const resolvedRootStat = fs.statSync(materializedRoot)
      if (materializedRoot !== path.join(this.rootRealPath, path.basename(directory))
          || resolvedRootStat.dev !== rootStat.dev || resolvedRootStat.ino !== rootStat.ino) {
        fail('LOCAL_SKILL_SNAPSHOT_MATERIALIZATION_TAMPERED')
      }
      const expectedFiles = new Map(blobs.map(item => [item.file.relativePath, item.bytes]))
      const expectedDirs = new Set(expectedDirectories(manifest.files))
      const actualFiles = new Set()
      const actualDirs = new Set([''])

      const visit = (current, relativeParts) => {
        const entries = fs.readdirSync(current, { withFileTypes: true })
        entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
        for (const entry of entries) {
          validatePathSegment(entry.name)
          const relativePath = [...relativeParts, entry.name].join('/')
          const filename = path.join(current, entry.name)
          const stat = fs.lstatSync(filename)
          if (stat.isSymbolicLink()) fail('LOCAL_SKILL_SNAPSHOT_MATERIALIZATION_TAMPERED')
          if (stat.isDirectory()) {
            if ((process.platform !== 'win32'
                && (stat.mode & 0o777) !== READ_ONLY_DIRECTORY_MODE)
                || !expectedDirs.has(relativePath)
                || !isInsideOrEqual(materializedRoot, realpath(filename))) {
              fail('LOCAL_SKILL_SNAPSHOT_MATERIALIZATION_TAMPERED')
            }
            actualDirs.add(relativePath)
            visit(filename, [...relativeParts, entry.name])
            continue
          }
          if (!stat.isFile() || !expectedFiles.has(relativePath)
              || (process.platform !== 'win32'
                && (stat.mode & 0o777) !== READ_ONLY_FILE_MODE)
              || realpath(filename) !== path.join(materializedRoot, ...relativePath.split('/'))) {
            fail('LOCAL_SKILL_SNAPSHOT_MATERIALIZATION_TAMPERED')
          }
          let descriptor
          try {
            const noFollow = process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW || 0)
            descriptor = fs.openSync(filename, fs.constants.O_RDONLY | noFollow)
            const openedStat = fs.fstatSync(descriptor)
            if (!openedStat.isFile() || openedStat.size !== stat.size
                || openedStat.dev !== stat.dev || openedStat.ino !== stat.ino) {
              fail('LOCAL_SKILL_SNAPSHOT_MATERIALIZATION_TAMPERED')
            }
            const bytes = readExactFile(descriptor, openedStat.size)
            const finalStat = fs.fstatSync(descriptor)
            const pathStat = fs.lstatSync(filename)
            if (finalStat.size !== openedStat.size
                || finalStat.dev !== openedStat.dev || finalStat.ino !== openedStat.ino
                || pathStat.isSymbolicLink() || !pathStat.isFile()
                || pathStat.dev !== finalStat.dev || pathStat.ino !== finalStat.ino
                || !bytes.equals(expectedFiles.get(relativePath))) {
              fail('LOCAL_SKILL_SNAPSHOT_MATERIALIZATION_TAMPERED')
            }
          } finally {
            if (descriptor !== undefined) {
              try { fs.closeSync(descriptor) } catch { /* already closed */ }
            }
          }
          actualFiles.add(relativePath)
        }
      }

      visit(directory, [])
      if (actualFiles.size !== expectedFiles.size || actualDirs.size !== expectedDirs.size
          || [...expectedFiles.keys()].some(filename => !actualFiles.has(filename))
          || [...expectedDirs].some(dirname => !actualDirs.has(dirname))) {
        fail('LOCAL_SKILL_SNAPSHOT_MATERIALIZATION_TAMPERED')
      }
    } catch (error) {
      if (error?.code === 'LOCAL_SKILL_SNAPSHOT_MATERIALIZATION_TAMPERED') throw error
      throw localSkillSnapshotError('LOCAL_SKILL_SNAPSHOT_MATERIALIZATION_TAMPERED', error)
    }
  }
}

module.exports = {
  LOCAL_SKILL_SNAPSHOT_VERSION,
  LocalSkillSnapshotStore,
  MAX_SKILL_DEPTH,
  MAX_SKILL_DIRECTORIES,
  MAX_SKILL_FILES,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_TOTAL_BYTES,
  bindLocalSkillSnapshotProvenance,
  canonicalSkillSnapshotJson,
  normalizeLocalSkillSnapshot,
}
