const fs = require('node:fs')
const path = require('node:path')

const OUTPUT_DIRECTORY = '.meldwork-output'
const MAX_OUTPUT_ATTACHMENTS = 4
const MAX_SCANNED_ENTRIES = 512
const SUPPORTED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.mp3', '.wav', '.m4a', '.mp4', '.mov', '.webm',
])

function isInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return Boolean(relative && relative !== '..'
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function safeWorkdir(workdir) {
  if (typeof workdir !== 'string' || !path.isAbsolute(workdir) || workdir.length > 4096) return ''
  try {
    const stat = fs.statSync(workdir)
    return stat.isDirectory() ? fs.realpathSync(workdir) : ''
  } catch {
    return ''
  }
}

function safeOutputDirectory(workdirRealPath) {
  if (!workdirRealPath) return ''
  const outputPath = path.join(workdirRealPath, OUTPUT_DIRECTORY)
  try {
    const stat = fs.lstatSync(outputPath)
    if (stat.isSymbolicLink() || !stat.isDirectory()) return ''
    const realPath = fs.realpathSync(outputPath)
    return isInside(workdirRealPath, realPath) ? realPath : ''
  } catch {
    return ''
  }
}

function outputFiles(outputRealPath) {
  if (!outputRealPath) return []
  let entries
  try { entries = fs.readdirSync(outputRealPath, { withFileTypes: true }) } catch { return [] }
  const files = []
  for (const entry of entries.slice(0, MAX_SCANNED_ENTRIES)) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue
    if (!SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
    const filename = path.join(outputRealPath, entry.name)
    try {
      const stat = fs.lstatSync(filename)
      if (!stat.isFile() || stat.isSymbolicLink()) continue
      const realPath = fs.realpathSync(filename)
      if (!isInside(outputRealPath, realPath)) continue
      files.push({
        name: entry.name,
        path: realPath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
      })
    } catch { /* a changing output file is skipped until a later run */ }
  }
  return files
}

function captureAgentOutputState(workdir) {
  const workdirRealPath = safeWorkdir(workdir)
  const files = {}
  for (const file of outputFiles(safeOutputDirectory(workdirRealPath))) {
    files[file.name] = {
      size: file.size,
      mtimeMs: file.mtimeMs,
      ctimeMs: file.ctimeMs,
    }
  }
  return { workdirRealPath, files }
}

function sameFileState(left, right) {
  return left && right
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
}

function importAgentOutputs(input, attachmentStore) {
  if (input?.signal?.aborted) return []
  if (!input?.baseline || !attachmentStore || typeof attachmentStore.importFile !== 'function') return []
  const workdirRealPath = safeWorkdir(input.workdir)
  if (!workdirRealPath || input.baseline.workdirRealPath !== workdirRealPath) return []
  const startedAt = Number(input.startedAt)
  if (!Number.isFinite(startedAt) || startedAt <= 0) return []
  const baselineFiles = input.baseline.files && typeof input.baseline.files === 'object'
    && !Array.isArray(input.baseline.files)
    ? input.baseline.files
    : {}
  const candidates = outputFiles(safeOutputDirectory(workdirRealPath))
    .filter(file => !sameFileState(baselineFiles[file.name], file))
    .filter(file => Math.max(file.mtimeMs, file.ctimeMs) >= startedAt - 2000)
    .sort((left, right) => (
      Math.max(right.mtimeMs, right.ctimeMs) - Math.max(left.mtimeMs, left.ctimeMs)
      || left.name.localeCompare(right.name)
    ))

  const imported = []
  if (input.signal?.aborted) return imported
  for (const file of candidates) {
    if (input.signal?.aborted || imported.length >= MAX_OUTPUT_ATTACHMENTS) break
    try { imported.push(attachmentStore.importFile(file.path)) } catch { /* invalid media is ignored */ }
  }
  return imported
}

module.exports = {
  captureAgentOutputState,
  importAgentOutputs,
}
