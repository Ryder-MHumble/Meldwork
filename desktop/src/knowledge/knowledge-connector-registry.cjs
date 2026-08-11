const { canonicalJson } = require('../collaboration/outcome-records.cjs')
const {
  assertKnowledgeConnector,
  normalizeCitationRequest,
  normalizeCitationResult,
  normalizeFetchResult,
  normalizeKnowledgeConnectorInstance,
  normalizeProbeResult,
  normalizeSearchRequest,
  normalizeSearchResults,
  normalizeSourceRequest,
  parseKnowledgeSnapshotRecord,
  parsePublicKnowledgeConnectorInstance,
  publicKnowledgeConnectorInstance,
  stableKnowledgeSourceId,
} = require('./knowledge-connector-contract.cjs')

const MAX_KNOWLEDGE_CONNECTORS = 64
const MAX_KNOWLEDGE_INSTANCES = 128
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/

function registryError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function fail(code) {
  throw registryError(code)
}

function clone(value) {
  return JSON.parse(canonicalJson(value))
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const item of Object.values(value)) deepFreeze(item)
  return value
}

class KnowledgeConnectorRegistry {
  constructor(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)
        || Object.keys(options).some(key => key !== 'connectors')
        || (options.connectors !== undefined && !Array.isArray(options.connectors))) {
      fail('KNOWLEDGE_CONNECTOR_REGISTRY_OPTIONS_INVALID')
    }
    this.connectors = new Map()
    this.instances = new Map()
    for (const connector of options.connectors || []) this.register(connector)
  }

  register(input) {
    const connector = assertKnowledgeConnector(input)
    if (this.connectors.has(connector.connectorId)) {
      fail('KNOWLEDGE_CONNECTOR_CONFLICT')
    }
    if (this.connectors.size >= MAX_KNOWLEDGE_CONNECTORS) {
      fail('KNOWLEDGE_CONNECTOR_REGISTRY_LIMIT')
    }
    this.connectors.set(connector.connectorId, connector)
    return deepFreeze({
      connectorId: connector.connectorId,
      contractVersion: connector.contractVersion,
    })
  }

  listConnectors() {
    return [...this.connectors.values()]
      .map(connector => ({
        connectorId: connector.connectorId,
        contractVersion: connector.contractVersion,
      }))
      .sort((left, right) => left.connectorId.localeCompare(right.connectorId))
      .map(item => deepFreeze(item))
  }

  listInstances() {
    return [...this.instances.values()]
      .map(clone)
      .sort((left, right) => left.instanceId.localeCompare(right.instanceId))
      .map(item => deepFreeze(item))
  }

  async authorize(connectorId, input) {
    const connector = this.requireConnector(connectorId)
    const privateInstance = normalizeKnowledgeConnectorInstance(input, connectorId)
    if (this.instances.has(privateInstance.instanceId)) {
      fail('KNOWLEDGE_CONNECTOR_INSTANCE_CONFLICT')
    }
    if (this.instances.size >= MAX_KNOWLEDGE_INSTANCES) {
      fail('KNOWLEDGE_CONNECTOR_INSTANCE_LIMIT')
    }
    try {
      const publicInstance = parsePublicKnowledgeConnectorInstance(
        await connector.authorize(privateInstance),
      )
      const expected = publicKnowledgeConnectorInstance(privateInstance)
      if (canonicalJson(publicInstance) !== canonicalJson(expected)) {
        fail('KNOWLEDGE_CONNECTOR_AUTHORIZATION_RESULT_INVALID')
      }
      const stored = deepFreeze(clone(publicInstance))
      this.instances.set(stored.instanceId, stored)
      return deepFreeze(clone(stored))
    } catch (error) {
      try { await connector.revoke(privateInstance.instanceId) } catch { /* best effort */ }
      throw error
    }
  }

  async revoke(instanceId) {
    const { connector, instance } = this.resolve(instanceId)
    const revoked = parsePublicKnowledgeConnectorInstance(await connector.revoke(instanceId))
    const expected = { ...clone(instance), authorized: false }
    if (canonicalJson(revoked) !== canonicalJson(expected)) {
      fail('KNOWLEDGE_CONNECTOR_REVOKE_RESULT_INVALID')
    }
    this.instances.delete(instanceId)
    return deepFreeze(clone(revoked))
  }

  async probe(instanceId) {
    const { connector, instance } = this.resolve(instanceId)
    return deepFreeze(normalizeProbeResult(await connector.probe(instanceId), instance))
  }

  async search(instanceId, input) {
    const { connector, instance } = this.resolve(instanceId)
    const request = normalizeSearchRequest(input, instance.egressLimit)
    const results = await connector.search(instanceId, request)
    return deepFreeze(normalizeSearchResults(results, instance, request.limit))
  }

  async fetch(instanceId, input) {
    const { connector, instance } = this.resolve(instanceId)
    const request = this.ownedSourceRequest(instance, input)
    return deepFreeze(normalizeFetchResult(
      await connector.fetch(instanceId, request),
      instance.egressLimit.maxContentBytes,
      instance,
    ))
  }

  async snapshot(instanceId, input) {
    const { connector, instance } = this.resolve(instanceId)
    if (instance.snapshotCapability !== 'immutable') {
      fail('KNOWLEDGE_SNAPSHOT_UNSUPPORTED')
    }
    const request = this.ownedSourceRequest(instance, input)
    const snapshot = parseKnowledgeSnapshotRecord(await connector.snapshot(instanceId, request))
    if (snapshot.connectorId !== instance.connectorId
        || snapshot.instanceId !== instance.instanceId
        || snapshot.scopeId !== instance.scope.scopeId
        || snapshot.sourceId !== request.sourceId || snapshot.locator !== request.locator
        || snapshot.contentRef.size > instance.egressLimit.maxContentBytes) {
      fail('KNOWLEDGE_SNAPSHOT_RESULT_INVALID')
    }
    return deepFreeze(snapshot)
  }

  async citation(instanceId, input) {
    const { connector, instance } = this.resolve(instanceId)
    const request = normalizeCitationRequest(input)
    if (request.verification === 'snapshot') {
      const { snapshot } = request
      if (instance.snapshotCapability !== 'immutable'
          || snapshot.connectorId !== instance.connectorId
          || snapshot.instanceId !== instance.instanceId
          || snapshot.scopeId !== instance.scope.scopeId
          || snapshot.contentRef.size > instance.egressLimit.maxContentBytes) {
        fail('KNOWLEDGE_CITATION_REQUEST_INVALID')
      }
    } else {
      this.ownedSourceRequest(instance, {
        sourceId: request.sourceId,
        locator: request.locator,
      })
    }
    const connectorRequest = request.verification === 'snapshot'
      ? { snapshot: request.snapshot }
      : {
        sourceId: request.sourceId,
        locator: request.locator,
        contentHash: request.contentHash,
      }
    const result = normalizeCitationResult(
      await connector.citation(instanceId, connectorRequest),
      instance.egressLimit.maxContentBytes,
      instance,
    )
    if (result.citation.verification !== request.verification
        || (request.verification === 'snapshot'
          && result.citation.snapshotId !== request.snapshot.snapshotId)
        || (request.verification === 'live'
          && result.citation.contentHash !== request.contentHash)) {
      fail('KNOWLEDGE_CITATION_RESULT_INVALID')
    }
    return deepFreeze(result)
  }

  requireConnector(connectorId) {
    if (typeof connectorId !== 'string' || !PUBLIC_ID.test(connectorId)) {
      fail('KNOWLEDGE_CONNECTOR_ID_INVALID')
    }
    const connector = this.connectors.get(connectorId)
    if (!connector) fail('KNOWLEDGE_CONNECTOR_NOT_FOUND')
    return connector
  }

  resolve(instanceId) {
    if (typeof instanceId !== 'string' || !PUBLIC_ID.test(instanceId)) {
      fail('KNOWLEDGE_CONNECTOR_INSTANCE_INVALID')
    }
    const instance = this.instances.get(instanceId)
    if (!instance) fail('KNOWLEDGE_CONNECTOR_INSTANCE_NOT_FOUND')
    const connector = this.connectors.get(instance.connectorId)
    if (!connector) fail('KNOWLEDGE_CONNECTOR_NOT_FOUND')
    return { connector, instance }
  }

  ownedSourceRequest(instance, input) {
    const request = normalizeSourceRequest(input)
    if (stableKnowledgeSourceId(instance.connectorId, instance.scope.scopeId, request.locator)
        !== request.sourceId) {
      fail('KNOWLEDGE_SOURCE_SCOPE_MISMATCH')
    }
    return request
  }
}

module.exports = {
  KnowledgeConnectorRegistry,
  MAX_KNOWLEDGE_CONNECTORS,
  MAX_KNOWLEDGE_INSTANCES,
}
