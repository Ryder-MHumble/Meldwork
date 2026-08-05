const path = require('node:path')

const { ContentBlobStore } = require('./content-blob-store.cjs')
const {
  KNOWLEDGE_CONNECTOR_CONTRACT_VERSION,
  MAX_KNOWLEDGE_CONTENT_BYTES,
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

const DEFAULT_MEMORY_CONNECTOR_ID = 'knowledge.memory'
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/

function connectorError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function fail(code) {
  throw connectorError(code)
}

function snippetFor(content, query) {
  const compact = content.replace(/\s+/g, ' ').trim()
  const match = compact.toLowerCase().indexOf(query.toLowerCase())
  if (match < 0) return compact.slice(0, 1000)
  return compact.slice(Math.max(0, match - 200), Math.max(0, match - 200) + 1000)
}

function normalizeDocument(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).sort().join(',') !== 'content,locator,mediaType,title'
      || !isSafeKnowledgeLocator(input.locator)
      || typeof input.title !== 'string' || !input.title || input.title.length > 240
      || /[\u0000-\u001f\u007f]/.test(input.title) || redactSecrets(input.title) !== input.title
      || typeof input.mediaType !== 'string' || !MEDIA_TYPE.test(input.mediaType)
      || input.mediaType !== input.mediaType.toLowerCase()) {
    fail('KNOWLEDGE_MEMORY_DOCUMENT_INVALID')
  }
  const content = normalizeKnowledgeContent(input.content, MAX_KNOWLEDGE_CONTENT_BYTES)
  return Object.freeze({
    locator: input.locator,
    title: input.title,
    mediaType: input.mediaType,
    ...content,
  })
}

class MemoryKnowledgeConnector {
  constructor(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)
        || Object.keys(options).some(key => ![
          'connectorId', 'contentBlobStore', 'documents', 'scopeId',
        ].includes(key))) {
      fail('KNOWLEDGE_MEMORY_OPTIONS_INVALID')
    }
    this.connectorId = options.connectorId || DEFAULT_MEMORY_CONNECTOR_ID
    if (!PUBLIC_ID.test(this.connectorId) || !PUBLIC_ID.test(String(options.scopeId || ''))
        || !(options.contentBlobStore instanceof ContentBlobStore)
        || !Array.isArray(options.documents) || options.documents.length > 4096) {
      fail('KNOWLEDGE_MEMORY_OPTIONS_INVALID')
    }
    this.contractVersion = KNOWLEDGE_CONNECTOR_CONTRACT_VERSION
    this.scopeId = options.scopeId
    this.contentBlobStore = options.contentBlobStore
    this.instances = new Map()
    this.documents = new Map()
    for (const input of options.documents) {
      const document = normalizeDocument(input)
      if (this.documents.has(document.locator)) fail('KNOWLEDGE_MEMORY_DOCUMENT_CONFLICT')
      this.documents.set(document.locator, document)
    }
  }

  authorize(input) {
    const instance = normalizeKnowledgeConnectorInstance(input, this.connectorId)
    if (instance.scope.kind !== 'memory' || instance.scope.scopeId !== this.scopeId
        || instance.accessMode !== 'read-only'
        || instance.snapshotCapability !== 'immutable'
        || instance.credentialLifecycle !== 'none' || instance.credentialRef !== null) {
      fail('KNOWLEDGE_MEMORY_AUTHORIZATION_INVALID')
    }
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
    return normalizeProbeResult({
      status: 'ready',
      instance: publicKnowledgeConnectorInstance(instance),
    }, instance)
  }

  search(instanceId, input) {
    const instance = this.requireInstance(instanceId)
    const request = normalizeSearchRequest(input, instance.egressLimit)
    const query = request.query.toLowerCase()
    const results = [...this.documents.values()]
      .filter(document => document.size <= instance.egressLimit.maxContentBytes)
      .filter(document => document.locator.toLowerCase().includes(query)
        || document.title.toLowerCase().includes(query)
        || document.content.toLowerCase().includes(query))
      .sort((left, right) => left.locator.localeCompare(right.locator))
      .slice(0, request.limit)
      .map(document => this.sourceDescriptor(instance, document, request.query))
    return normalizeSearchResults(results, instance, request.limit)
  }

  fetch(instanceId, input) {
    const instance = this.requireInstance(instanceId)
    const request = this.normalizeOwnedSourceRequest(instance, input)
    const document = this.documents.get(request.locator)
    if (!document) fail('KNOWLEDGE_SOURCE_NOT_FOUND')
    if (document.size > instance.egressLimit.maxContentBytes) {
      fail('KNOWLEDGE_CONTENT_LIMIT_EXCEEDED')
    }
    return normalizeFetchResult({
      content: document.content,
      source: this.sourceDescriptor(instance, document, ''),
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

  sourceDescriptor(instance, document, query) {
    return normalizeSourceDescriptor({
      sourceId: stableKnowledgeSourceId(
        this.connectorId,
        instance.scope.scopeId,
        document.locator,
      ),
      connectorId: this.connectorId,
      scopeId: instance.scope.scopeId,
      locator: document.locator,
      title: document.title || path.posix.basename(document.locator),
      mediaType: document.mediaType,
      contentHash: document.contentHash,
      size: document.size,
      snippet: snippetFor(document.content, query),
    })
  }
}

module.exports = {
  DEFAULT_MEMORY_CONNECTOR_ID,
  MemoryKnowledgeConnector,
}
