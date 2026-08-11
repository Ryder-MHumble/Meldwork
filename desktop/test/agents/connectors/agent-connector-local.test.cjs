const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { createAgentConnectorManifest, serializeAgentConnectorManifest } = require('../../../src/agents/connectors/agent-connector-manifest.cjs')
const { AgentConnectorInstanceStore } = require('../../../src/agents/connectors/agent-connector-instance-store.cjs')
const { isSupportedAgentKind } = require('../../../src/workspace/local-workspace-contracts.cjs')
const {
  LocalAgentConnectors,
  SAMPLE_AGENT_CONNECTOR_MANIFEST,
  SAMPLE_CREDENTIAL_AGENT_CONNECTOR_MANIFEST,
  semanticVersionFrom,
} = require('../../../src/agents/connectors/agent-connector-local.cjs')

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`sealed:${value}`, 'utf8'),
    decryptString: value => {
      const text = Buffer.from(value).toString('utf8')
      if (!text.startsWith('sealed:')) throw new Error('ciphertext invalid')
      return text.slice('sealed:'.length)
    },
  }
}

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-agent-connectors-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const calls = []
  const instanceStoragePath = path.join(directory, 'instances.json')
  const credentialStoragePath = path.join(directory, 'private', 'credentials.json')
  const createInstanceStore = () => new AgentConnectorInstanceStore({
    instanceStoragePath,
    credentialStoragePath,
    safeStorage: fakeSafeStorage(),
  })
  const instanceStore = createInstanceStore()
  const connectors = new LocalAgentConnectors({
    manifestDirectory: path.join(directory, 'manifests'),
    instanceStore,
    runAgent: async (...args) => {
      calls.push(args)
      return options.runAgent ? options.runAgent(...args) : {
        text: 'Delegated result', sessionRef: 'codex-session', outcome: 'completed',
      }
    },
    seedSample: options.seedSample,
  })
  return {
    calls,
    connectors,
    createInstanceStore,
    credentialStoragePath,
    directory,
    instanceStore,
    instanceStoragePath,
  }
}

function codex(version = 'codex-cli 0.147.0') {
  return {
    kind: 'codex', name: 'Codex CLI', version, executable: '/private/bin/codex',
    compatibilityState: 'compatible',
  }
}

test('production bootstrap does not add the sample Agent unless it was explicitly installed', (t) => {
  const { connectors, directory } = fixture(t)
  assert.deepEqual(connectors.refresh([codex()]), [])
  assert.deepEqual(connectors.catalog(), [])
  assert.deepEqual(fs.readdirSync(path.join(directory, 'manifests')), [])
})

test('discovers an explicitly installed approved sample and exposes generic sanitized catalog metadata', async (t) => {
  const { calls, connectors } = fixture(t, { seedSample: true })
  assert.deepEqual(connectors.refresh([codex()]), [])
  const configured = connectors.configure({
    manifestId: SAMPLE_AGENT_CONNECTOR_MANIFEST.manifestId,
    label: 'Codex review account',
    credentials: null,
  })
  const [agent] = connectors.detectAgents()
  assert.equal(agent.kind, configured.instanceId)
  assert.match(agent.kind, /^custom-[a-f0-9]{16}$/)
  assert.equal(isSupportedAgentKind(agent.kind), true)
  assert.equal(agent.connectorId, SAMPLE_AGENT_CONNECTOR_MANIFEST.connectorId)
  assert.equal(agent.upstreamVersion, '0.147.0')
  assert.equal(agent.credentialConfigured, false)
  assert.equal(Object.hasOwn(agent, 'executable'), false)
  assert.equal(Object.hasOwn(agent, 'credentialRef'), false)
  const [catalog] = connectors.catalog()
  assert.equal(catalog.kind, agent.kind)
  assert.equal(catalog.connector, true)
  assert.equal(catalog.providerMode, 'connector')
  assert.equal(catalog.description, SAMPLE_AGENT_CONNECTOR_MANIFEST.description)
  assert.doesNotMatch(JSON.stringify(catalog), /private\/bin|credential-ref/i)

  const result = await connectors.run(agent, 'Review this', '/tmp/workspace', {
    runId: 'run-1', agentRunId: 'agent-run-1', sandbox: 'read-only',
  })
  assert.equal(result.outcome, 'completed')
  assert.equal(result.text, 'Delegated result')
  assert.equal(result.connector.connectorVersion, '1.0.0')
  assert.equal(result.connector.upstreamVersion, '0.147.0')
  assert.equal(Object.hasOwn(result.connector, 'credentialRefId'), false)
  assert.deepEqual(result.connectorEventState.events.map(event => event.type), ['Completed'])
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0].executable, '/private/bin/codex')
  assert.equal(calls[0][3].sandbox, 'read-only')
})

test('delegate failures preserve the upstream classification in the terminal Connector state', async (t) => {
  const upstreamError = Object.assign(new Error('LOCAL_AGENT_AUTH_REQUIRED'), {
    code: 'LOCAL_AGENT_AUTH_REQUIRED',
    failure: {
      code: 'LOCAL_AGENT_AUTH_REQUIRED',
      category: 'authentication',
      retryable: true,
    },
  })
  const { connectors } = fixture(t, {
    seedSample: true,
    runAgent: async () => { throw upstreamError },
  })
  connectors.refresh([codex()])
  connectors.configure({
    manifestId: SAMPLE_AGENT_CONNECTOR_MANIFEST.manifestId,
    label: 'Codex review account',
    credentials: null,
  })
  const [agent] = connectors.detectAgents()
  const result = await connectors.run(agent, 'Review this', '/tmp/workspace', {
    runId: 'run-2', agentRunId: 'agent-run-2', sandbox: 'read-only',
  })
  assert.equal(result.outcome, 'failed')
  assert.deepEqual(result.failure, {
    code: 'LOCAL_AGENT_AUTH_REQUIRED', category: 'authentication', retryable: true,
  })
  assert.equal(result.connectorEventState.status, 'failed')
  assert.deepEqual(result.connectorEventState.events.map(event => ({
    type: event.type,
    code: event.code,
    category: event.category,
    retryable: event.retryable,
  })), [{
    type: 'Failed',
    code: 'LOCAL_AGENT_AUTH_REQUIRED',
    category: 'authentication',
    retryable: true,
  }])
  assert.doesNotMatch(JSON.stringify(result), /LOCAL_AGENT_INCOMPLETE_RESPONSE/)
})

test('untrusted and incompatible local Manifests fail closed', (t) => {
  const { connectors, directory, instanceStore } = fixture(t)
  const manifestDirectory = path.join(directory, 'manifests')
  fs.mkdirSync(manifestDirectory, { recursive: true })
  const {
    manifestId: _manifestId,
    schemaVersion: _schemaVersion,
    recordType: _recordType,
    ...sampleInput
  } = SAMPLE_AGENT_CONNECTOR_MANIFEST
  const untrusted = createAgentConnectorManifest({
    ...sampleInput,
    connectorId: 'external.untrusted',
  })
  fs.writeFileSync(
    path.join(manifestDirectory, `${untrusted.manifestId}.json`),
    serializeAgentConnectorManifest(untrusted),
  )
  fs.writeFileSync(
    path.join(manifestDirectory, `${SAMPLE_AGENT_CONNECTOR_MANIFEST.manifestId}.json`),
    serializeAgentConnectorManifest(SAMPLE_AGENT_CONNECTOR_MANIFEST),
  )
  instanceStore.create({
    manifestId: SAMPLE_AGENT_CONNECTOR_MANIFEST.manifestId,
    connectorId: SAMPLE_AGENT_CONNECTOR_MANIFEST.connectorId,
    connectorVersion: SAMPLE_AGENT_CONNECTOR_MANIFEST.connectorVersion,
    label: 'Incompatible Codex account',
    credentials: null,
  })
  assert.deepEqual(connectors.refresh([codex('codex-cli 1000000.0.0')]), [])
  assert.equal(connectors.diagnostics().some(item => (
    item.code === 'AGENT_CONNECTOR_MANIFEST_UNTRUSTED'
  )), true)
  assert.equal(connectors.diagnostics().some(item => (
    item.code === 'AGENT_CONNECTOR_UPSTREAM_INCOMPATIBLE'
  )), true)
  assert.equal(semanticVersionFrom('not a version'), '')
})

test('restores multiple credential-bearing accounts and drops invalid references', async (t) => {
  const {
    calls, connectors, createInstanceStore, credentialStoragePath, directory,
  } = fixture(t, { seedSample: true })
  connectors.refresh([codex()])
  const first = connectors.configure({
    manifestId: SAMPLE_CREDENTIAL_AGENT_CONNECTOR_MANIFEST.manifestId,
    label: 'Codex account A',
    credentials: { 'openai-api-key': 'connector-secret-a' },
  })
  const second = connectors.configure({
    manifestId: SAMPLE_CREDENTIAL_AGENT_CONNECTOR_MANIFEST.manifestId,
    label: 'Codex account B',
    credentials: { 'openai-api-key': 'connector-secret-b' },
  })
  assert.notEqual(first.instanceId, second.instanceId)
  assert.equal(first.credentialConfigured, true)
  assert.equal(second.credentialConfigured, true)
  assert.doesNotMatch(JSON.stringify(connectors.list()), /credential-ref|connector-secret/i)

  const restarted = new LocalAgentConnectors({
    manifestDirectory: path.join(directory, 'manifests'),
    instanceStore: createInstanceStore(),
    runAgent: connectors.runAgent,
  })
  const agents = restarted.refresh([codex()])
  assert.deepEqual(agents.map(agent => agent.label), ['Codex account A', 'Codex account B'])
  assert.equal(agents.every(agent => agent.credentialConfigured), true)

  await restarted.run(agents[0], 'Review this', '/tmp/workspace', {
    runId: 'run-3', agentRunId: 'agent-run-3', sandbox: 'read-only',
  })
  assert.equal(calls.at(-1)[3].env.OPENAI_API_KEY, 'connector-secret-a')
  assert.equal(calls.at(-1)[3].connectorCredentialIsolation, true)
  assert.equal(Object.hasOwn(calls.at(-1)[3], 'credentialRefId'), false)

  const records = createInstanceStore().listRecords()
  const firstRecord = records.find(item => item.instanceId === first.instanceId)
  const credentialDocument = JSON.parse(fs.readFileSync(credentialStoragePath, 'utf8'))
  credentialDocument.credentials[firstRecord.credentialRef].encrypted = 'not-base64'
  fs.writeFileSync(credentialStoragePath, JSON.stringify(credentialDocument))
  const remaining = restarted.refresh([codex()])
  assert.deepEqual(remaining.map(agent => agent.label), ['Codex account B'])
  assert.equal(restarted.diagnostics().some(item => (
    item.code === 'AGENT_CONNECTOR_CREDENTIAL_UNAVAILABLE'
  )), true)

  restarted.delete(second.instanceId)
  assert.deepEqual(restarted.detectAgents(), [])
})
