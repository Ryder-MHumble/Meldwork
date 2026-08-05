const fs = require('node:fs')
const path = require('node:path')

const { ContentBlobStore } = require('./content-blob-store.cjs')
const {
  KNOWLEDGE_CONNECTOR_CONTRACT_VERSION,
  createKnowledgeCitationRecord,
  createKnowledgeSnapshotRecord,
  isSafeKnowledgeLocator,
  normalizeCitationRequest,
  normalizeCitationResult,
  normalizeFetchResult,
  normalizeKnowledgeConnectorInstance,
  normalizeKnowledgeContent,
  normalizeProbeResult,
  normalizeSearchRequest,
  normalizeSearchResults,
  normalizeSourceDescriptor,
  normalizeSourceRequest,
  publicKnowledgeConnectorInstance,
  stableKnowledgeSourceId,
} = require('./knowledge-connector-contract.cjs')
const { redactSecrets } = require('./secret-redaction.cjs')

const DEFAULT_FILESYSTEM_CONNECTOR_ID = 'knowledge.filesystem'
const MAX_FILES_SCANNED = 4096
const MAX_DIRECTORY_DEPTH = 64
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/

function connectorError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function fail(code) {
  throw connectorError(code)
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return Boolean(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative))
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
    fail('KNOWLEDGE_FILESYSTEM_SOURCE_CHANGED')
  }
  return bytes
}

function mediaTypeFor(locator) {
  switch (path.posix.extname(locator).toLowerCase()) {
    case '.md': return 'text/markdown'
    case '.json': return 'application/json'
    case '.csv': return 'text/csv'
    case '.yaml':
    case '.yml': return 'application/yaml'
    default: return 'text/plain'
  }
}

function safeTitle(locator) {
  const title = path.posix.basename(locator).slice(0, 240)
  return redactSecrets(title) === title ? title : 'Knowledge source'
}

function snippetFor(content, query) {
  const compact = content.replace(/\s+/g, ' ').trim()
  const match = compact.toLowerCase().indexOf(query.toLowerCase())
  if (match < 0) return compact.slice(0, 1000)
  const start = Math.max(0, match - 200)
  return compact.slice(start, start + 1000)
}

class FilesystemKnowledgeConnector {
  constructor(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)
        || Object.keys(options).some(key => ![
          'connectorId', 'contentBlobStore', 'rootPath', 'scopeId',
        ].includes(key))) {
      fail('KNOWLEDGE_FILESYSTEM_OPTIONS_INVALID')
    }
    this.connectorId = options.connectorId || DEFAULT_FILESYSTEM_CONNECTOR_ID
    if (!PUBLIC_ID.test(this.connectorId) || !PUBLIC_ID.test(String(options.scopeId || ''))
        || typeof options.rootPath !== 'string' || !options.rootPath
        || options.rootPath.length > 4096
        || !(options.contentBlobStore instanceof ContentBlobStore)) {
      fail('KNOWLEDGE_FILESYSTEM_OPTIONS_INVALID')
    }
    this.contractVersion = KNOWLEDGE_CONNECTOR_CONTRACT_VERSION
    this.scopeId = options.scopeId
    this.rootPath = path.resolve(options.rootPath)
    if (this.rootPath === path.parse(this.rootPath).root) {
      fail('KNOWLEDGE_FILESYSTEM_ROOT_UNSAFE')
    }
    this.contentBlobStore = options.contentBlobStore
    this.instances = new Map()
    this.rootRealPath = this.prepareRoot()
  }

  authorize(input) {
    const instance = normalizeKnowledgeConnectorInstance(input, this.connectorId)
    if (instance.scope.kind !== 'filesystem' || instance.scope.scopeId !== this.scopeId
        || instance.accessMode !== 'read-only'
        || instance.snapshotCapability !== 'immutable'
        || instance.credentialLifecycle !== 'none' || instance.credentialRef !== null) {
      fail('KNOWLEDGE_FILESYSTEM_AUTHORIZATION_INVALID')
    }
    this.assertRoot()
    const existing = this.instances.get(instance.instanceId)
    if (existing && JSON.stringify(existing) !== JSON.stringify(instance)) {
      fail('KNOWLEDGE_CONNECTOR_INSTANCE_CONFLICT')
    }
    this.instances.set(instance.instanceId, instance)
    return publicKnowledgeConnectorInstance(instance)
  }

  revoke(instanceId) {
    const instance = this.requireInstance(instanceId)
    this.instances.delete(instance.instanceId)
    return publicKnowledgeConnectorInstance(instance, false)
  }

  probe(instanceId) {
    const instance = this.requireInstance(instanceId)
    this.assertRoot()
    return normalizeProbeResult({
      status: 'ready',
      instance: publicKnowledgeConnectorInstance(instance),
    }, instance)
  }

  search(instanceId, input) {
    const instance = this.requireInstance(instanceId)
    const request = normalizeSearchRequest(input, instance.egressLimit)
    const results = []
    const state = { scanned: 0, stopped: false }
    this.assertRoot()
    this.searchDirectory({
      directory: this.rootPath,
      segments: [],
      depth: 0,
      instance,
      request,
      results,
      state,
    })
    return normalizeSearchResults(results, instance, request.limit)
  }

  fetch(instanceId, input) {
    const instance = this.requireInstance(instanceId)
    const request = this.normalizeOwnedSourceRequest(instance, input)
    const content = this.readSource(request.locator, instance.egressLimit.maxContentBytes)
    return normalizeFetchResult({
      content: content.content,
      source: this.sourceDescriptor(instance, request.locator, content, ''),
    }, instance.egressLimit.maxContentBytes, instance)
  }

  snapshot(instanceId, input) {
    const instance = this.requireInstance(instanceId)
    const fetched = this.fetch(instanceId, input)
    const contentRef = this.contentBlobStore.put(fetched.content, {
      mediaType: fetched.source.mediaType,
    })
    return createKnowledgeSnapshotRecord({
      connectorId: this.connectorId,
      instanceId: instance.instanceId,
      scopeId: instance.scope.scopeId,
      sourceId: fetched.source.sourceId,
      locator: fetched.source.locator,
      title: fetched.source.title,
      contentRef,
      contentHash: fetched.source.contentHash,
      mediaType: fetched.source.mediaType,
    })
  }

  citation(instanceId, input) {
    const instance = this.requireInstance(instanceId)
    const request = normalizeCitationRequest(input)
    if (request.verification === 'snapshot') {
      const { snapshot } = request
      if (snapshot.connectorId !== this.connectorId
          || snapshot.instanceId !== instance.instanceId
          || snapshot.scopeId !== instance.scope.scopeId) {
        fail('KNOWLEDGE_SNAPSHOT_SCOPE_MISMATCH')
      }
      let bytes
      try { bytes = this.contentBlobStore.read(snapshot.contentRef) } catch {
        fail('KNOWLEDGE_SNAPSHOT_UNAVAILABLE')
      }
      const content = normalizeKnowledgeContent(bytes, instance.egressLimit.maxContentBytes)
      const citation = createKnowledgeCitationRecord({
        connectorId: this.connectorId,
        instanceId: instance.instanceId,
        scopeId: instance.scope.scopeId,
        sourceId: snapshot.sourceId,
        locator: snapshot.locator,
        contentHash: snapshot.contentHash,
        snapshotId: snapshot.snapshotId,
        contentRef: snapshot.contentRef,
        verification: 'snapshot',
      })
      return normalizeCitationResult({ citation, content: content.content },
        instance.egressLimit.maxContentBytes, instance)
    }

    const sourceRequest = this.normalizeOwnedSourceRequest(instance, {
      sourceId: request.sourceId,
      locator: request.locator,
    })
    const fetched = this.fetch(instance.instanceId, sourceRequest)
    if (fetched.source.contentHash !== request.contentHash) {
      fail('KNOWLEDGE_CITATION_SOURCE_CHANGED')
    }
    const citation = createKnowledgeCitationRecord({
      connectorId: this.connectorId,
      instanceId: instance.instanceId,
      scopeId: instance.scope.scopeId,
      sourceId: fetched.source.sourceId,
      locator: fetched.source.locator,
      contentHash: fetched.source.contentHash,
      snapshotId: null,
      contentRef: null,
      verification: 'live',
    })
    return normalizeCitationResult({ citation, content: fetched.content },
      instance.egressLimit.maxContentBytes, instance)
  }

  prepareRoot() {
    try {
      const stat = fs.lstatSync(this.rootPath)
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        fail('KNOWLEDGE_FILESYSTEM_ROOT_UNSAFE')
      }
      return fs.realpathSync(this.rootPath)
    } catch (error) {
      if (error?.message === 'KNOWLEDGE_FILESYSTEM_ROOT_UNSAFE') throw error
      fail('KNOWLEDGE_FILESYSTEM_ROOT_UNAVAILABLE')
    }
  }

  assertRoot() {
    try {
      const stat = fs.lstatSync(this.rootPath)
      if (stat.isSymbolicLink() || !stat.isDirectory()
          || fs.realpathSync(this.rootPath) !== this.rootRealPath) {
        fail('KNOWLEDGE_FILESYSTEM_ROOT_UNSAFE')
      }
    } catch (error) {
      if (error?.message === 'KNOWLEDGE_FILESYSTEM_ROOT_UNSAFE') throw error
      fail('KNOWLEDGE_FILESYSTEM_ROOT_UNAVAILABLE')
    }
  }

  requireInstance(instanceId) {
    if (typeof instanceId !== 'string' || !PUBLIC_ID.test(instanceId)) {
      fail('KNOWLEDGE_CONNECTOR_INSTANCE_INVALID')
    }
    const instance = this.instances.get(instanceId)
    if (!instance) fail('KNOWLEDGE_CONNECTOR_INSTANCE_NOT_AUTHORIZED')
    return instance
  }

  normalizeOwnedSourceRequest(instance, input) {
    const request = normalizeSourceRequest(input)
    if (stableKnowledgeSourceId(this.connectorId, instance.scope.scopeId, request.locator)
        !== request.sourceId) {
      fail('KNOWLEDGE_SOURCE_SCOPE_MISMATCH')
    }
    return request
  }

  resolveSource(locator) {
    if (!isSafeKnowledgeLocator(locator)) fail('KNOWLEDGE_FILESYSTEM_TRAVERSAL_REJECTED')
    this.assertRoot()
    const segments = locator.split('/')
    let current = this.rootPath
    try {
      for (let index = 0; index < segments.length; index += 1) {
        current = path.join(current, segments[index])
        const stat = fs.lstatSync(current)
        if (stat.isSymbolicLink()) fail('KNOWLEDGE_FILESYSTEM_SYMLINK_REJECTED')
        if (index < segments.length - 1 && !stat.isDirectory()) {
          fail('KNOWLEDGE_SOURCE_NOT_FOUND')
        }
        if (index === segments.length - 1 && !stat.isFile()) {
          fail('KNOWLEDGE_SOURCE_NOT_FOUND')
        }
      }
      const realPath = fs.realpathSync(current)
      if (!isInside(this.rootRealPath, realPath)) {
        fail('KNOWLEDGE_FILESYSTEM_TRAVERSAL_REJECTED')
      }
      return current
    } catch (error) {
      if (/^KNOWLEDGE_[A-Z0-9_]+$/.test(String(error?.message || ''))) throw error
      if (error.code === 'ENOENT') fail('KNOWLEDGE_SOURCE_NOT_FOUND')
      if (error.code === 'ELOOP') fail('KNOWLEDGE_FILESYSTEM_SYMLINK_REJECTED')
      fail('KNOWLEDGE_FILESYSTEM_SOURCE_UNAVAILABLE')
    }
  }

  readSource(locator, maxBytes) {
    const filename = this.resolveSource(locator)
    let descriptor
    try {
      const fileStat = fs.lstatSync(filename)
      if (fileStat.isSymbolicLink()) fail('KNOWLEDGE_FILESYSTEM_SYMLINK_REJECTED')
      if (!fileStat.isFile()) fail('KNOWLEDGE_SOURCE_NOT_FOUND')
      if (fileStat.size <= 0 || fileStat.size > maxBytes) {
        fail('KNOWLEDGE_CONTENT_LIMIT_EXCEEDED')
      }
      const noFollow = process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW || 0)
      descriptor = fs.openSync(filename, fs.constants.O_RDONLY | noFollow)
      const openedStat = fs.fstatSync(descriptor)
      const openedRealPath = fs.realpathSync(filename)
      if (!openedStat.isFile() || openedStat.size !== fileStat.size
          || openedStat.dev !== fileStat.dev || openedStat.ino !== fileStat.ino
          || !isInside(this.rootRealPath, openedRealPath)) {
        fail('KNOWLEDGE_FILESYSTEM_SOURCE_CHANGED')
      }
      return normalizeKnowledgeContent(
        readExactFile(descriptor, openedStat.size),
        maxBytes,
      )
    } catch (error) {
      if (/^KNOWLEDGE_[A-Z0-9_]+$/.test(String(error?.message || ''))) throw error
      if (error.code === 'ENOENT') fail('KNOWLEDGE_SOURCE_NOT_FOUND')
      if (error.code === 'ELOOP') fail('KNOWLEDGE_FILESYSTEM_SYMLINK_REJECTED')
      fail('KNOWLEDGE_FILESYSTEM_SOURCE_UNAVAILABLE')
    } finally {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor) } catch { /* already closed */ }
      }
    }
  }

  sourceDescriptor(instance, locator, content, query) {
    return normalizeSourceDescriptor({
      sourceId: stableKnowledgeSourceId(this.connectorId, instance.scope.scopeId, locator),
      connectorId: this.connectorId,
      scopeId: instance.scope.scopeId,
      locator,
      title: safeTitle(locator),
      mediaType: mediaTypeFor(locator),
      contentHash: content.contentHash,
      size: content.size,
      snippet: snippetFor(content.content, query),
    })
  }

  searchDirectory(options) {
    if (options.state.stopped || options.depth > MAX_DIRECTORY_DEPTH) return
    let names
    try { names = fs.readdirSync(options.directory).sort((left, right) => left.localeCompare(right)) } catch {
      fail('KNOWLEDGE_FILESYSTEM_SOURCE_UNAVAILABLE')
    }
    for (const name of names) {
      if (options.state.stopped) return
      const segments = [...options.segments, name]
      const locator = segments.join('/')
      if (!isSafeKnowledgeLocator(locator)) continue
      const filename = path.join(options.directory, name)
      let stat
      try { stat = fs.lstatSync(filename) } catch {
        fail('KNOWLEDGE_FILESYSTEM_SOURCE_UNAVAILABLE')
      }
      if (stat.isSymbolicLink()) fail('KNOWLEDGE_FILESYSTEM_SYMLINK_REJECTED')
      if (stat.isDirectory()) {
        let realPath
        try { realPath = fs.realpathSync(filename) } catch {
          fail('KNOWLEDGE_FILESYSTEM_SOURCE_UNAVAILABLE')
        }
        if (!isInside(this.rootRealPath, realPath)) {
          fail('KNOWLEDGE_FILESYSTEM_TRAVERSAL_REJECTED')
        }
        this.searchDirectory({
          ...options,
          directory: filename,
          segments,
          depth: options.depth + 1,
        })
        continue
      }
      if (!stat.isFile()) continue
      options.state.scanned += 1
      if (options.state.scanned > MAX_FILES_SCANNED) {
        options.state.stopped = true
        return
      }
      if (stat.size <= 0 || stat.size > options.instance.egressLimit.maxContentBytes) continue
      let content
      try {
        content = this.readSource(locator, options.instance.egressLimit.maxContentBytes)
      } catch (error) {
        if (['KNOWLEDGE_CONTENT_INVALID', 'KNOWLEDGE_CONTENT_LIMIT_EXCEEDED']
          .includes(error?.message)) continue
        throw error
      }
      const query = options.request.query.toLowerCase()
      if (!locator.toLowerCase().includes(query)
          && !content.content.toLowerCase().includes(query)) continue
      options.results.push(this.sourceDescriptor(
        options.instance,
        locator,
        content,
        options.request.query,
      ))
      if (options.results.length >= options.request.limit) {
        options.state.stopped = true
        return
      }
    }
  }
}

module.exports = {
  DEFAULT_FILESYSTEM_CONNECTOR_ID,
  FilesystemKnowledgeConnector,
}
