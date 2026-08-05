const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { agentRuntimeError } = require('../src/agent-runtime-contract.cjs')
const { LocalWorkspace } = require('../src/local-workspace.cjs')
const { createWorkflowDefinition } = require('../src/orchestration-records.cjs')
const { RunLedger } = require('../src/run-ledger.cjs')
const { parseWorkflowOutcome } = require('../src/workflow-output.cjs')
const { deferred, fixture } = require('./local-workspace-test-helpers.cjs')

function roleReviewWorkflow({ arbiter = false } = {}) {
  const roles = { primary: 'codex', reviewer: 'hermes' }
  const nodes = [
    {
      nodeId: 'primary', role: 'primary', agentKind: 'codex',
      dependsOn: [], parallelSafe: false, criterionIds: [],
    },
    {
      nodeId: 'review', role: 'reviewer', agentKind: 'hermes',
      dependsOn: ['primary'], parallelSafe: false, criterionIds: ['artifact-ready'],
    },
  ]
  if (arbiter) {
    roles.arbiter = 'kimi'
    nodes.push({
      nodeId: 'arbitrate', role: 'arbiter', agentKind: 'kimi',
      dependsOn: ['review'], parallelSafe: false, criterionIds: ['artifact-ready'],
    })
  }
  return createWorkflowDefinition({
    taskId: 'task-role-review-production',
    template: 'role-review',
    roles,
    criteria: [{
      criterionId: 'artifact-ready',
      kind: 'artifact',
      description: 'The concrete Artifact is complete.',
      required: true,
      requiredEvidenceLevel: 'observed',
    }],
    nodes,
  })
}

function parallelRoleReviewWorkflow() {
  return createWorkflowDefinition({
    taskId: 'task-role-review-parallel',
    template: 'role-review',
    roles: { primary: 'codex', reviewer: 'hermes' },
    criteria: [{
      criterionId: 'artifact-ready',
      kind: 'artifact',
      description: 'The concrete Artifact bundle is complete.',
      required: true,
      requiredEvidenceLevel: 'observed',
    }],
    nodes: [
      {
        nodeId: 'primary-a', role: 'primary', agentKind: 'codex',
        dependsOn: [], parallelSafe: true, criterionIds: [],
      },
      {
        nodeId: 'primary-b', role: 'primary', agentKind: 'workbuddy',
        dependsOn: [], parallelSafe: true, criterionIds: [],
      },
      {
        nodeId: 'review', role: 'reviewer', agentKind: 'hermes',
        dependsOn: ['primary-a', 'primary-b'], parallelSafe: false,
        criterionIds: ['artifact-ready'],
      },
    ],
  })
}

function reviewReply(prompt, decision = 'accept') {
  const payload = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1))
  const contract = payload.outputContract
  const accepted = decision === 'accept'
  return JSON.stringify({
    version: 1,
    kind: contract.kind,
    artifactId: contract.artifactId,
    decision,
    summary: accepted ? 'The Artifact satisfies the criterion.' : 'The Artifact needs review.',
    criteria: contract.criteria.map(criterion => ({
      criterionId: criterion.criterionId,
      status: accepted ? 'pass' : 'fail',
      summary: accepted ? 'The immutable Evidence supports acceptance.' : 'Human review is required.',
      evidenceIds: [criterion.evidenceIds[0]],
    })),
  })
}

function explicitArtifactCapture(options) {
  options.captureArtifactOutputs = async () => ({ captured: true })
  options.captureAgentOutcomeDescriptors = async ({ agentKind }) => (
    agentKind === 'codex'
      ? [{
          type: 'document',
          name: 'implementation.txt',
          content: Buffer.from('immutable primary Artifact', 'utf8'),
          mediaType: 'text/plain',
        }]
      : []
  )
}

function pendingGate(workspace, timeoutMs = 2000) {
  const current = workspace.listHumanGates({ pendingOnly: true })[0]
  if (current) return Promise.resolve(current)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      workspace.off('changed', changed)
      reject(new Error('TEST_HUMAN_GATE_TIMEOUT'))
    }, timeoutMs)
    const changed = () => {
      const gate = workspace.listHumanGates({ pendingOnly: true })[0]
      if (!gate) return
      clearTimeout(timer)
      workspace.off('changed', changed)
      resolve(gate)
    }
    workspace.on('changed', changed)
  })
}

async function waitForRunStatus(ledger, runId, status, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const record = ledger.get(runId)
    if (record?.status === status) return record
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`TEST_RUN_STATUS_TIMEOUT:${runId}`)
}

function storedOutcomeRecords(workspace, category) {
  const categoryPath = path.join(workspace.outcomeStore.rootPath, category)
  if (!fs.existsSync(categoryPath)) return []
  return fs.readdirSync(categoryPath).flatMap(shard => (
    fs.readdirSync(path.join(categoryPath, shard)).map(filename => (
      JSON.parse(fs.readFileSync(path.join(categoryPath, shard, filename), 'utf8'))
    ))
  ))
}

function workflowInput(groupId, workflow, extra = {}) {
  return {
    groupId,
    text: 'Produce the requested implementation without leaking this task transcript.',
    targetKinds: [...new Set(workflow.nodes.map(node => node.agentKind))],
    workflow,
    ...extra,
  }
}

function hasFinalWorkflowRefs(message) {
  const refs = message?.trace?.context?.outcomeRefs || {}
  return (refs.reviewerFindingIds || []).length > 0
    || (refs.adoptionIds || []).length > 0
    || (refs.workflowOutcomeRefs || []).length > 0
}

function abortFailure(signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED'))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

test('rejects workflow Agents outside the group before reserving or invoking a run', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runLedger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Codex only', agentKinds: ['codex'], workdir: directory,
  })
  const workflow = roleReviewWorkflow()
  let reservations = 0
  const reserveRun = workspace.roleReviewRunner.reserveRun
  workspace.roleReviewRunner.reserveRun = (...args) => {
    reservations += 1
    return reserveRun(...args)
  }

  await assert.rejects(
    workspace.sendMessage(workflowInput(group.id, workflow)),
    { message: 'LOCAL_ROLE_REVIEW_GROUP_MISMATCH' },
  )

  assert.equal(reservations, 0)
  assert.equal(calls.length, 0)
  assert.equal(workspace.snapshot().messages.length, 0)
  assert.equal(options.runLedger.list(group.id).length, 0)
  assert.equal(workspace.isGroupBusy(group.id), false)
})

test('production Role Review overlaps distinct Primary Agents and reviews their bundle', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runLedger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.captureArtifactOutputs = async () => ({ captured: true })
  options.captureAgentOutcomeDescriptors = async ({ agentKind }) => (
    ['codex', 'workbuddy'].includes(agentKind)
      ? [{
          type: 'document',
          name: `${agentKind}-implementation.txt`,
          content: Buffer.from(`${agentKind} immutable Artifact`, 'utf8'),
          mediaType: 'text/plain',
        }]
      : []
  )
  const primaryKinds = new Set(['codex', 'workbuddy'])
  let activePrimaries = 0
  let maxActivePrimaries = 0
  let primaryStarts = 0
  let releasePrimaries
  let rejectPrimaries
  const primaryGate = new Promise((resolve, reject) => {
    releasePrimaries = resolve
    rejectPrimaries = reject
  })
  const primaryTimer = setTimeout(() => {
    rejectPrimaries(new Error('Production Primary branches did not overlap'))
  }, 1500)
  t.after(() => clearTimeout(primaryTimer))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (primaryKinds.has(agent.kind)) {
      activePrimaries += 1
      primaryStarts += 1
      maxActivePrimaries = Math.max(maxActivePrimaries, activePrimaries)
      if (primaryStarts === 2) {
        clearTimeout(primaryTimer)
        releasePrimaries()
      }
      await primaryGate
      runOptions.onProgress({
        id: `${agent.kind}-progress`,
        title: agent.kind === 'codex' ? 'search' : 'write_file',
        status: 'completed',
      })
      activePrimaries -= 1
      return { text: `${agent.kind} primary result`, sessionRef: `${agent.kind}-session` }
    }
    assert.equal(activePrimaries, 0)
    assert.equal(runOptions.sandbox, 'read-only')
    assert.equal(runOptions.sessionRef, '')
    assert.match(prompt, /role-review-primary-bundle/)
    return { text: reviewReply(prompt), sessionRef: 'must-not-persist' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Parallel production review',
    agentKinds: ['codex', 'workbuddy', 'hermes'],
    workdir: directory,
    allowWrite: true,
  })
  const workflow = parallelRoleReviewWorkflow()

  const result = await workspace.sendMessage(workflowInput(group.id, workflow))

  assert.equal(maxActivePrimaries, 2)
  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'workbuddy', 'hermes'])
  assert.equal(result.status, 'completed')
  assert.equal(result.primaryOutcomes.length, 2)
  const bundle = workspace.outcomeStore.getArtifact(result.primaryBundle.artifactId)
  const bundleContent = JSON.parse(workspace.contentBlobStore.read(bundle.contentRef).toString('utf8'))
  assert.equal(bundle.type, 'bundle')
  assert.deepEqual(bundleContent.composedBy, { kind: 'system', actorId: 'meldwork' })
  assert.deepEqual(bundleContent.children.map(child => child.nodeId), ['primary-a', 'primary-b'])
  assert.equal(new Set(bundleContent.children.map(child => child.artifactId)).size, 2)
  assert.equal(result.workflowOutcome.artifactId, bundle.artifactId)
  assert.equal(result.outcomeRefs.artifactIds.includes(bundle.artifactId), true)
  for (const child of bundleContent.children) {
    assert.equal(result.outcomeRefs.artifactIds.includes(child.artifactId), true)
  }
  const agentMessages = workspace.snapshot().messages.filter(message => message.role === 'agent')
  assert.equal(agentMessages.length, 3)
  assert.equal(agentMessages.every(message => (
    message.trace.context.outcomeRefs.artifactIds.includes(bundle.artifactId)
  )), true)
  assert.deepEqual(
    agentMessages.find(message => message.agentKind === 'codex').toolCalls,
    [{ title: 'search', status: 'completed' }],
  )
  assert.deepEqual(
    agentMessages.find(message => message.agentKind === 'workbuddy').toolCalls,
    [{ title: 'write_file', status: 'completed' }],
  )
})

test('parallel Primary HTTP 401 fails fast without failing the active peer or changing membership', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runLedger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.captureArtifactOutputs = async () => ({ captured: true })
  options.captureAgentOutcomeDescriptors = async ({ agentKind }) => (
    agentKind === 'workbuddy'
      ? [{
          type: 'document',
          name: 'workbuddy-implementation.txt',
          content: Buffer.from('workbuddy immutable Artifact', 'utf8'),
          mediaType: 'text/plain',
        }]
      : []
  )
  const workbuddyStarted = deferred()
  const releaseWorkbuddy = deferred()
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'codex') {
      throw agentRuntimeError('LOCAL_AGENT_AUTH_REQUIRED', 'HTTP 401: Invalid token')
    }
    if (agent.kind === 'workbuddy') {
      workbuddyStarted.resolve()
      await releaseWorkbuddy.promise
      return { text: 'workbuddy primary result', sessionRef: 'workbuddy-session' }
    }
    throw new Error('UNEXPECTED_REVIEWER_INVOCATION')
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Parallel 401 recovery',
    agentKinds: ['codex', 'workbuddy', 'hermes'],
    workdir: directory,
    allowWrite: true,
  })

  const send = workspace.sendMessage(workflowInput(group.id, parallelRoleReviewWorkflow()))
  await workbuddyStarted.promise
  releaseWorkbuddy.resolve()
  await assert.rejects(send, { message: 'HTTP 401; authentication failed; Agent retained' })

  assert.equal(calls.filter(call => call.agent.kind === 'codex').length, 1)
  assert.equal(calls.some(call => /infrastructure recovery turn/i.test(call.prompt)), false)
  assert.deepEqual(workspace.getGroup(group.id).agentKinds, ['codex', 'workbuddy', 'hermes'])
  assert.equal(workspace.snapshot().messages.some(message => (
    message.agentKind === 'workbuddy' && message.system?.key === 'system.agentCallFailed'
  )), false)
})

test('production sendMessage route reviews the explicit Artifact in isolated roles and persists refs', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  options.runLedger = new RunLedger({ storagePath: ledgerPath, now: () => 1000 })
  explicitArtifactCapture(options)
  const rawReviewReplies = new Map()
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'codex') {
      assert.equal(runOptions.sandbox, 'workspace-write')
      assert.equal(runOptions.attachments.length, 1)
      return { text: 'primary conclusion must not be reviewed', sessionRef: 'codex-session' }
    }
    assert.equal(runOptions.sandbox, 'read-only')
    assert.equal(runOptions.sessionRef, '')
    assert.deepEqual(runOptions.attachments, [])
    assert.match(prompt, /immutable primary Artifact/)
    assert.doesNotMatch(prompt, /primary conclusion|task transcript|context\.png/)
    const text = reviewReply(prompt, agent.kind === 'hermes' ? 'reject' : 'accept')
    rawReviewReplies.set(agent.kind, text)
    return {
      text,
      sessionRef: `${agent.kind}-must-not-persist`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Production role review',
    agentKinds: ['codex', 'hermes', 'kimi'],
    workdir: directory,
    allowWrite: true,
  })
  const workflow = roleReviewWorkflow({ arbiter: true })

  const result = await workspace.sendMessage(workflowInput(group.id, workflow, {
    attachments: [{ id: 'context', name: 'context.png', mimeType: 'image/png', size: 20 }],
    skillHints: [{ targetKind: 'codex', namespace: 'global', slug: 'review', name: 'Review' }],
    knowledgeBaseHints: [{
      kind: 'dingtalk', name: 'DingTalk', accessMode: 'cli',
      commandName: 'dws', targetKinds: ['codex'],
    }],
  }))

  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes', 'kimi'])
  assert.equal(result.status, 'completed')
  assert.equal(result.workflowOutcome.status, 'accepted')
  const artifact = workspace.outcomeStore.getArtifact(result.workflowOutcome.artifactId)
  assert.equal(artifact.name, 'implementation.txt')
  assert.equal(workspace.contentBlobStore.read(artifact.contentRef).toString('utf8'), 'immutable primary Artifact')
  assert.deepEqual(
    parseWorkflowOutcome(workspace.contentBlobStore.read(result.workflowOutcomeRef)),
    result.workflowOutcome,
  )

  const agentMessages = workspace.snapshot().messages.filter(message => message.role === 'agent')
  assert.equal(agentMessages.length, 3)
  for (const message of agentMessages) {
    const refs = message.trace.context.outcomeRefs
    assert.equal(refs.artifactIds.includes(artifact.artifactId), true)
    assert.equal(refs.reviewerFindingIds.length, 2)
    assert.deepEqual(refs.adoptionIds, [result.adoptionRecord.adoptionId])
    assert.deepEqual(refs.workflowOutcomeRefs, [result.workflowOutcomeRef])
  }
  const terminal = options.runLedger.get(result.runId)
  assert.equal(terminal.status, 'completed')
  assert.equal(terminal.agentRuns.length, 3)
  assert.equal(terminal.agentRuns.every(run => (
    run.context.outcomeRefs.workflowOutcomeRefs[0].hash === result.workflowOutcomeRef.hash
  )), true)
  for (const finding of result.findingRecords) {
    const message = agentMessages.find(candidate => (
      candidate.trace.agentRunId === finding.reviewer.agentRunId
    ))
    const agentRun = terminal.agentRuns.find(candidate => (
      candidate.agentRunId === finding.reviewer.agentRunId
    ))
    assert.equal(message.content, finding.summary)
    assert.equal(agentRun.output, finding.summary)
    assert.doesNotMatch(message.content, /^\s*\{/u)
    assert.doesNotMatch(agentRun.output, /^\s*\{/u)
    const conclusion = agentRun.context.outcomeRefs.artifactIds
      .map(artifactId => workspace.outcomeStore.getArtifact(artifactId))
      .find(candidate => candidate.name === `${finding.reviewer.agentKind}-conclusion.txt`)
    assert.deepEqual(conclusion.producedBy, {
      runId: finding.reviewer.runId,
      agentRunId: finding.reviewer.agentRunId,
      agentKind: finding.reviewer.agentKind,
    })
    assert.equal(
      workspace.contentBlobStore.read(conclusion.contentRef).toString('utf8'),
      rawReviewReplies.get(finding.reviewer.agentKind),
    )
    const evidence = agentRun.context.outcomeRefs.evidenceIds
      .map(evidenceId => workspace.outcomeStore.getEvidence(evidenceId))
      .find(candidate => candidate.subject?.artifactId === conclusion.artifactId)
    assert.equal(evidence.refs.some(ref => (
      ref.type === 'blob' && ref.contentHash === conclusion.contentHash
    )), true)
    assert.equal(message.trace.context.outcomeRefs.artifactIds.includes(
      conclusion.artifactId,
    ), true)
    assert.equal(message.trace.context.outcomeRefs.evidenceIds.includes(
      evidence.evidenceId,
    ), true)
    assert.equal(message.trace.context.outcomeRefs.reviewerFindingIds.includes(
      finding.reviewerFindingId,
    ), true)
  }
  assert.equal(agentMessages.find(message => message.agentKind === 'codex').content,
    'primary conclusion must not be reviewed')
  assert.equal(terminal.agentRuns.find(run => run.kind === 'codex').output,
    'primary conclusion must not be reviewed')

  const restarted = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath, now: () => 2000 }),
  })
  const restoredMessages = restarted.snapshot().messages.filter(message => message.role === 'agent')
  assert.equal(restoredMessages.length, 3)
  assert.equal(restoredMessages.every(message => (
    message.trace.context.outcomeRefs.workflowOutcomeRefs[0].hash
      === result.workflowOutcomeRef.hash
  )), true)
  for (const finding of result.findingRecords) {
    const message = restoredMessages.find(candidate => (
      candidate.trace.agentRunId === finding.reviewer.agentRunId
    ))
    assert.equal(message.content, finding.summary)
  }
})

test('Role Review retains raw structured output when conclusion provenance is unavailable', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runLedger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  explicitArtifactCapture(options)
  let rawReviewReply = ''
  options.runAgent = async (agent, prompt) => {
    const text = agent.kind === 'codex' ? 'primary result' : reviewReply(prompt)
    if (agent.kind === 'hermes') rawReviewReply = text
    return { text, sessionRef: `${agent.kind}-session` }
  }
  const workspace = new LocalWorkspace(options)
  const recordAgentOutcomes = workspace.recordAgentOutcomes.bind(workspace)
  workspace.recordAgentOutcomes = input => (
    input.agentKind === 'hermes' ? {} : recordAgentOutcomes(input)
  )
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Missing review provenance',
    agentKinds: ['codex', 'hermes'],
    workdir: directory,
    allowWrite: true,
  })

  const result = await workspace.sendMessage(workflowInput(group.id, roleReviewWorkflow()))
  const reviewerMessage = workspace.snapshot().messages.find(message => (
    message.role === 'agent' && message.agentKind === 'hermes'
  ))
  const reviewerRun = options.runLedger.get(result.runId).agentRuns.find(
    run => run.kind === 'hermes',
  )

  assert.equal(result.workflowOutcome.status, 'accepted')
  assert.equal(reviewerMessage.content, rawReviewReply)
  assert.equal(reviewerRun.output, rawReviewReply)
  assert.equal(reviewerMessage.trace.context.outcomeRefs.reviewerFindingIds.length, 1)
  assert.equal(reviewerRun.context.outcomeRefs.reviewerFindingIds.length, 1)
  assert.equal(reviewerRun.context.outcomeRefs.artifactIds.some((artifactId) => (
    workspace.outcomeStore.getArtifact(artifactId).producedBy.agentRunId
      === reviewerRun.agentRunId
  )), false)
})

test('checkpoint failure rolls back final workflow refs from messages and the failed Run', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  options.runLedger = new RunLedger({ storagePath: ledgerPath })
  explicitArtifactCapture(options)
  let rawReviewReply = ''
  options.runAgent = async (agent, prompt) => {
    const text = agent.kind === 'codex' ? 'primary result' : reviewReply(prompt)
    if (agent.kind === 'hermes') rawReviewReply = text
    return { text, sessionRef: `${agent.kind}-session` }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Checkpoint rollback',
    agentKinds: ['codex', 'hermes'],
    workdir: directory,
    allowWrite: true,
  })
  const checkpointRun = workspace.checkpointRun.bind(workspace)
  let rejectedCheckpoint = false
  workspace.checkpointRun = (groupId, controller, status = '') => {
    const finalRefsAttached = controller.harness?.agentRuns?.some(run => (
      (run.context?.outcomeRefs?.workflowOutcomeRefs || []).length > 0
    ))
    if (!rejectedCheckpoint && finalRefsAttached && !status) {
      rejectedCheckpoint = true
      return false
    }
    return checkpointRun(groupId, controller, status)
  }

  await assert.rejects(
    workspace.sendMessage(workflowInput(group.id, roleReviewWorkflow())),
    { message: 'LOCAL_RUN_PERSIST_FAILED' },
  )

  assert.equal(rejectedCheckpoint, true)
  const agentMessages = workspace.snapshot().messages.filter(message => message.role === 'agent')
  assert.equal(agentMessages.length, 2)
  assert.equal(agentMessages.some(hasFinalWorkflowRefs), false)
  assert.equal(agentMessages.find(message => message.agentKind === 'hermes').content, rawReviewReply)
  const terminal = options.runLedger.list(group.id)[0]
  assert.equal(terminal.status, 'failed')
  assert.equal(terminal.agentRuns.some(run => (
    (run.context?.outcomeRefs?.workflowOutcomeRefs || []).length > 0
  )), false)
  assert.equal(terminal.agentRuns.find(run => run.kind === 'hermes').output, rawReviewReply)

  const restarted = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath }),
  })
  assert.equal(restarted.snapshot().messages.some(hasFinalWorkflowRefs), false)
})

test('workspace save failure compensates the Ledger and keeps final refs uncommitted', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  options.runLedger = new RunLedger({ storagePath: ledgerPath })
  explicitArtifactCapture(options)
  let rawReviewReply = ''
  options.runAgent = async (agent, prompt) => {
    const text = agent.kind === 'codex' ? 'primary result' : reviewReply(prompt)
    if (agent.kind === 'hermes') rawReviewReply = text
    return { text, sessionRef: `${agent.kind}-session` }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Workspace rollback',
    agentKinds: ['codex', 'hermes'],
    workdir: directory,
    allowWrite: true,
  })
  const save = workspace.save.bind(workspace)
  let rejectedSave = false
  workspace.save = () => {
    if (!rejectedSave && workspace.state.messages.some(hasFinalWorkflowRefs)) {
      rejectedSave = true
      throw new Error('TEST_WORKSPACE_SAVE_FAILED')
    }
    return save()
  }

  await assert.rejects(
    workspace.sendMessage(workflowInput(group.id, roleReviewWorkflow())),
    { message: 'TEST_WORKSPACE_SAVE_FAILED' },
  )

  assert.equal(rejectedSave, true)
  assert.equal(workspace.snapshot().messages.some(hasFinalWorkflowRefs), false)
  assert.equal(workspace.snapshot().messages.find(
    message => message.role === 'agent' && message.agentKind === 'hermes',
  ).content, rawReviewReply)
  const terminal = options.runLedger.list(group.id)[0]
  assert.equal(terminal.status, 'failed')
  assert.equal(terminal.agentRuns.some(run => (
    (run.context?.outcomeRefs?.workflowOutcomeRefs || []).length > 0
  )), false)
  assert.equal(terminal.agentRuns.find(run => run.kind === 'hermes').output, rawReviewReply)

  const restarted = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath }),
  })
  assert.equal(restarted.snapshot().messages.some(hasFinalWorkflowRefs), false)
})

test('changed listener failure after outcome commit does not fail the Role Review run', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  options.runLedger = new RunLedger({ storagePath: ledgerPath })
  explicitArtifactCapture(options)
  options.runAgent = async (agent, prompt) => ({
    text: agent.kind === 'codex' ? 'primary result' : reviewReply(prompt),
    sessionRef: `${agent.kind}-session`,
  })
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Changed listener failure',
    agentKinds: ['codex', 'hermes'],
    workdir: directory,
    allowWrite: true,
  })
  let listenerFailures = 0
  workspace.on('changed', () => {
    if (listenerFailures === 0 && workspace.state.messages.some(hasFinalWorkflowRefs)) {
      listenerFailures += 1
      throw new Error('TEST_CHANGED_LISTENER_FAILED')
    }
  })

  const result = await workspace.sendMessage(workflowInput(group.id, roleReviewWorkflow()))
  const terminal = options.runLedger.get(result.runId)
  const finding = result.findingRecords[0]
  const reviewerMessage = workspace.snapshot().messages.find(message => (
    message.trace?.agentRunId === finding.reviewer.agentRunId
  ))
  const reviewerRun = terminal.agentRuns.find(run => (
    run.agentRunId === finding.reviewer.agentRunId
  ))

  assert.equal(listenerFailures, 1)
  assert.equal(terminal.status, 'completed')
  assert.equal(workspace.snapshot().messages.filter(message => message.role === 'agent')
    .every(hasFinalWorkflowRefs), true)
  assert.equal(reviewerMessage.content, finding.summary)
  assert.equal(reviewerRun.output, finding.summary)
})

test('human decision Gate finalizes accept, reject, and reopen outcomes with traceable Evidence', async (t) => {
  for (const scenario of [
    { optionId: 'accept-artifact', gateStatus: 'approved', status: 'accepted' },
    { optionId: 'reject-artifact', gateStatus: 'rejected', status: 'rejected' },
    { optionId: 'reopen-task', gateStatus: 'rejected', status: 'reopened' },
  ]) {
    await t.test(scenario.status, async (subtest) => {
      const { directory, options } = fixture()
      subtest.after(() => fs.rmSync(directory, { recursive: true, force: true }))
      explicitArtifactCapture(options)
      options.runAgent = async (agent, prompt) => ({
        text: agent.kind === 'codex' ? 'primary result' : reviewReply(prompt, 'reject'),
        sessionRef: `${agent.kind}-session`,
      })
      const workspace = new LocalWorkspace(options)
      await workspace.refreshAgents()
      const group = workspace.createGroup({
        name: `Human ${scenario.status}`,
        agentKinds: ['codex', 'hermes'],
        workdir: directory,
        allowWrite: true,
      })
      const workflow = roleReviewWorkflow()

      const send = workspace.sendMessage(workflowInput(group.id, workflow))
      const gate = await pendingGate(workspace)
      assert.equal(gate.type, 'decision')
      assert.equal(gate.summary, 'Role review requires a human decision.')
      assert.deepEqual(gate.options.map(option => option.optionId), [
        'accept-artifact', 'reject-artifact', 'reopen-task',
      ])
      workspace.decideHumanGate(gate.gateId, {
        status: scenario.gateStatus,
        optionId: scenario.optionId,
        actorId: 'local-user',
      })
      const result = await send

      assert.equal(result.status, 'completed')
      assert.equal(result.decision, scenario.status)
      assert.equal(result.workflowOutcome.status, scenario.status)
      assert.equal(result.adoptionRecord.status, scenario.status)
      assert.equal(result.humanDecisionEvidence.kind, 'human-decision')
      assert.equal(result.humanDecisionEvidence.level, 'human-accepted')
      assert.equal(result.humanDecisionEvidence.recordedBy.actorId, 'local-user')
      assert.equal(result.outcomeRefs.workflowOutcomeRefs.length, 2)
      assert.equal(workspace.snapshot().messages.filter(message => message.role === 'agent')
        .every(message => message.trace.context.outcomeRefs.evidenceIds.includes(
          result.humanDecisionEvidence.evidenceId,
        )), true)
    })
  }
})

test('role-review decision Gate survives restart and persists the final Adoption', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const ledger = new RunLedger({ storagePath: ledgerPath })
  options.runLedger = ledger
  explicitArtifactCapture(options)
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return {
      text: agent.kind === 'codex' ? 'primary result' : reviewReply(prompt, 'reject'),
      sessionRef: `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Restarted role review',
    agentKinds: ['codex', 'hermes'],
    workdir: directory,
    allowWrite: true,
  })
  const workflow = roleReviewWorkflow()

  const send = workspace.sendMessage(workflowInput(group.id, workflow))
  const pending = await pendingGate(workspace)
  const request = workspace.humanGateStore.request(pending.gateId)
  const runId = pending.runId
  await workspace.stopAll()
  await assert.rejects(send, { message: 'LOCAL_AGENT_EXECUTION_STOPPED' })

  assert.equal(ledger.get(runId).status, 'waiting')
  assert.equal(storedOutcomeRecords(workspace, 'adoptions').length, 0)

  const restartedLedger = new RunLedger({ storagePath: ledgerPath })
  const restarted = new LocalWorkspace({ ...options, runLedger: restartedLedger })
  const finished = deferred()
  restarted.once('run-finished', event => finished.resolve(event))
  await restarted.refreshAgents()
  assert.equal(restarted.listHumanGates({ pendingOnly: true })[0].gateId, pending.gateId)

  restarted.decideHumanGate(pending.gateId, {
    status: 'approved', optionId: 'accept-artifact', actorId: 'local-user',
  })
  const terminal = await waitForRunStatus(restartedLedger, runId, 'completed')
  const event = await Promise.race([
    finished.promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('TEST_RUN_EVENT_TIMEOUT')), 5000)),
  ])
  const adoptions = storedOutcomeRecords(restarted, 'adoptions')

  assert.equal(terminal.runId, runId)
  assert.equal(event.runId, runId)
  assert.deepEqual(event.completedKinds, ['codex', 'hermes'])
  assert.equal(calls.length, 2)
  assert.equal(adoptions.length, 1)
  assert.equal(adoptions[0].artifactId, request.artifactId)
  assert.equal(adoptions[0].status, 'accepted')
  assert.deepEqual(adoptions[0].actor, { kind: 'human', actorId: 'local-user' })
  assert.equal(terminal.agentRuns.length, 2)
  const terminalRefs = terminal.agentRuns.map(run => run.context.outcomeRefs)
  assert.equal(terminalRefs.every(refs => (
    refs.adoptionIds.includes(adoptions[0].adoptionId)
      && refs.workflowOutcomeRefs.length === 2
      && refs.workflowOutcomeRefs.some(ref => ref.hash === request.workflowOutcomeRef.hash)
  )), true)
  const humanEvidence = terminalRefs[0].evidenceIds
    .map(evidenceId => restarted.outcomeStore.getEvidence(evidenceId))
    .find(evidence => evidence.kind === 'human-decision')
  assert.ok(humanEvidence)
  assert.equal(humanEvidence.recordedBy.actorId, 'local-user')
  assert.equal(terminalRefs.every(refs => refs.evidenceIds.includes(humanEvidence.evidenceId)), true)
  const outcomeStatuses = terminalRefs[0].workflowOutcomeRefs.map(ref => (
    parseWorkflowOutcome(restarted.contentBlobStore.read(ref)).status
  )).sort()
  assert.deepEqual(outcomeStatuses, ['accepted', 'decision-required'])
  const agentMessages = restarted.snapshot().messages.filter(message => message.role === 'agent')
  assert.equal(agentMessages.length, 2)
  assert.equal(agentMessages.every(message => (
    message.trace.context.outcomeRefs.adoptionIds.includes(adoptions[0].adoptionId)
      && message.trace.context.outcomeRefs.evidenceIds.includes(humanEvidence.evidenceId)
      && message.trace.context.outcomeRefs.workflowOutcomeRefs.length === 2
  )), true)
})

test('Role Review applies budget validation and fails a Reviewer 401 without losing isolation', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  options.runLedger = new RunLedger({ storagePath: ledgerPath, now: () => 1000 })
  explicitArtifactCapture(options)
  let reviewerAttempts = 0
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'codex') return { text: 'primary result', sessionRef: 'codex-session' }
    reviewerAttempts += 1
    assert.equal(runOptions.sandbox, 'read-only')
    assert.equal(runOptions.sessionRef, '')
    assert.deepEqual(runOptions.attachments, [])
    if (reviewerAttempts === 1) {
      throw agentRuntimeError('LOCAL_AGENT_AUTH_REQUIRED', 'HTTP 401: Invalid token')
    }
    return { text: reviewReply(prompt), sessionRef: 'must-not-persist' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Budgeted retry', agentKinds: ['codex', 'hermes'], workdir: directory, allowWrite: true,
  })
  const workflow = roleReviewWorkflow()

  await assert.rejects(
    workspace.sendMessage(workflowInput(group.id, workflow, {
      budget: { limits: { outboundBytes: -1 } },
    })),
    { message: 'RUN_BUDGET_LIMIT_INVALID' },
  )
  assert.equal(workspace.isGroupBusy(group.id), false)
  assert.equal(workspace.snapshot().messages.length, 0)

  await assert.rejects(
    workspace.sendMessage(workflowInput(group.id, workflow, {
      budget: {
        limits: { outboundBytes: 100000 },
        enforcement: { outboundBytes: 'hard' },
      },
    })),
    { message: 'HTTP 401; authentication failed; Agent retained' },
  )
  assert.equal(reviewerAttempts, 1)
  const reviewerCalls = calls.filter(call => call.agent.kind === 'hermes')
  assert.equal(reviewerCalls.length, 1)
  assert.equal(options.runLedger.list(group.id)[0].budget.limits.outboundBytes, 100000)
})

test('manual retry replays the same isolated Reviewer workflow slot', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runLedger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  explicitArtifactCapture(options)
  const reviewerStarted = deferred()
  let reviewerAttempts = 0
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'codex') return { text: 'primary result', sessionRef: 'codex-session' }
    reviewerAttempts += 1
    assert.equal(runOptions.sandbox, 'read-only')
    assert.equal(runOptions.sessionRef, '')
    assert.deepEqual(runOptions.attachments, [])
    if (reviewerAttempts === 1) {
      reviewerStarted.resolve()
      return abortFailure(runOptions.signal)
    }
    return { text: reviewReply(prompt), sessionRef: 'must-not-persist' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Retry isolated Reviewer',
    agentKinds: ['codex', 'hermes'],
    workdir: directory,
    allowWrite: true,
  })

  const send = workspace.sendMessage(workflowInput(group.id, roleReviewWorkflow()))
  await reviewerStarted.promise
  const active = workspace.activeRuns.get(group.id)
  assert.equal(active.workflowType, 'role-review')
  assert.equal(workspace.controlAgent(group.id, active.runId, 'hermes', 'retry'), true)
  const result = await send

  const reviewerCalls = calls.filter(call => call.agent.kind === 'hermes')
  assert.equal(reviewerCalls.length, 2)
  assert.equal(reviewerCalls[0].prompt, reviewerCalls[1].prompt)
  assert.equal(result.workflowOutcome.status, 'accepted')
  assert.equal(workspace.snapshot().messages.some(message => (
    message.system?.key === 'system.agentStopped'
      || message.system?.key === 'system.agentCallFailed'
  )), false)
  const terminal = options.runLedger.get(result.runId)
  assert.equal(terminal.status, 'completed')
  assert.equal(terminal.agentRuns.filter(run => run.kind === 'hermes').length, 2)
})

test('manual cancel records a stopped Reviewer interruption and stops the workflow Run', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runLedger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  explicitArtifactCapture(options)
  const reviewerStarted = deferred()
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    if (agent.kind === 'codex') return { text: 'primary result', sessionRef: 'codex-session' }
    reviewerStarted.resolve()
    return abortFailure(runOptions.signal)
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', event => finished.push(event))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Cancel isolated Reviewer',
    agentKinds: ['codex', 'hermes'],
    workdir: directory,
    allowWrite: true,
  })

  const send = workspace.sendMessage(workflowInput(group.id, roleReviewWorkflow()))
  await reviewerStarted.promise
  const active = workspace.activeRuns.get(group.id)
  const runId = active.runId
  assert.equal(workspace.controlAgent(group.id, runId, 'hermes', 'cancel'), true)
  await assert.rejects(send, { message: 'LOCAL_AGENT_EXECUTION_STOPPED' })

  const interruption = workspace.snapshot().messages.find(message => (
    message.agentKind === 'hermes' && message.system?.key === 'system.agentStopped'
  ))
  assert.ok(interruption)
  assert.equal(interruption.trace.status, 'stopped')
  assert.equal(workspace.snapshot().messages.some(message => (
    message.agentKind === 'hermes' && message.system?.key === 'system.agentCallFailed'
  )), false)
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'stopped')
  assert.equal(finished[0].failedKinds.includes('hermes'), true)
  assert.equal(finished[0].completedKinds.includes('hermes'), false)
  assert.equal(options.runLedger.get(runId).status, 'stopped')
})

test('manual replace completes a Reviewer slot with an unused independent Agent', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runLedger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  explicitArtifactCapture(options)
  const reviewerStarted = deferred()
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'codex') return { text: 'primary result', sessionRef: 'codex-session' }
    if (agent.kind === 'hermes') {
      reviewerStarted.resolve()
      return abortFailure(runOptions.signal)
    }
    assert.equal(agent.kind, 'kimi')
    assert.equal(runOptions.sandbox, 'read-only')
    assert.equal(runOptions.sessionRef, '')
    assert.deepEqual(runOptions.attachments, [])
    return { text: reviewReply(prompt), sessionRef: 'must-not-persist' }
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', event => finished.push(event))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Replace Reviewer independently',
    agentKinds: ['codex', 'hermes', 'kimi'],
    workdir: directory,
    allowWrite: true,
  })

  const send = workspace.sendMessage(workflowInput(group.id, roleReviewWorkflow()))
  await reviewerStarted.promise
  const active = workspace.activeRuns.get(group.id)
  assert.equal(active.workflowRole, 'reviewer')
  assert.equal(
    workspace.controlAgent(group.id, active.runId, 'hermes', 'replace', 'codex'),
    false,
  )
  assert.equal(active.agentControllers.get('hermes').agentController.signal.aborted, false)
  assert.equal(
    workspace.controlAgent(group.id, active.runId, 'hermes', 'replace', 'kimi'),
    true,
  )
  const result = await send

  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes', 'kimi'])
  assert.equal(result.status, 'completed')
  assert.equal(result.findingRecords[0].reviewer.agentKind, 'kimi')
  assert.equal(workspace.snapshot().messages.some(message => (
    message.agentKind === 'hermes' && message.system?.key === 'system.agentStopped'
  )), true)
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'completed')
  assert.equal(finished[0].failedKinds.includes('hermes'), true)
  assert.equal(finished[0].completedKinds.includes('kimi'), true)
  const terminal = options.runLedger.get(active.runId)
  assert.equal(terminal.status, 'completed')
  assert.equal(terminal.targetKinds.includes('kimi'), true)
  assert.equal(terminal.attemptHistory.some(entry => (
    entry.agentKind === 'hermes'
      && entry.policyAction === 'replace_agent'
      && entry.recoveryAgentKind === 'kimi'
  )), true)
})

test('Reviewer HTTP 401 fails once, retains the Agent, and releases the group lock', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runLedger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  explicitArtifactCapture(options)
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'hermes') {
      assert.equal(runOptions.sandbox, 'read-only')
      assert.equal(runOptions.sessionRef, '')
      assert.deepEqual(runOptions.attachments, [])
      throw agentRuntimeError('LOCAL_AGENT_AUTH_REQUIRED', 'HTTP 401: Invalid token')
    }
    return { text: 'codex result', sessionRef: 'codex-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Reviewer removal', agentKinds: ['codex', 'hermes'], workdir: directory, allowWrite: true,
  })
  const workflow = roleReviewWorkflow()

  await assert.rejects(
    workspace.sendMessage(workflowInput(group.id, workflow)),
    { message: 'HTTP 401; authentication failed; Agent retained' },
  )

  const reviewerCalls = calls.filter(call => call.agent.kind === 'hermes')
  assert.equal(reviewerCalls.length, 1)
  assert.equal(reviewerCalls.every(call => (
    call.runOptions.sandbox === 'read-only'
      && call.runOptions.sessionRef === ''
      && call.runOptions.attachments.length === 0
  )), true)
  assert.equal(calls.some(call => /infrastructure recovery turn/i.test(call.prompt)), false)
  assert.deepEqual(workspace.getGroup(group.id).agentKinds, ['codex', 'hermes'])
  assert.equal(workspace.isGroupBusy(group.id), false)
  const failures = workspace.snapshot().messages.filter(message => (
    message.agentKind === 'hermes' && message.system?.key === 'system.agentCallFailed'
  ))
  assert.equal(failures.length, 1)
  assert.equal(failures[0].system.params.reason, 'HTTP 401; authentication failed; Agent retained')

  await workspace.sendMessage({ groupId: group.id, text: 'Continue after removal', targetKinds: ['codex'] })
  assert.equal(workspace.snapshot().messages.at(-1).content, 'codex result')
})

test('stopping an isolated Reviewer keeps the lock through cleanup and releases it afterward', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  explicitArtifactCapture(options)
  const reviewerStarted = deferred()
  let reviewerCalls = 0
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    if (agent.kind === 'codex') return { text: 'codex result', sessionRef: 'codex-session' }
    reviewerCalls += 1
    reviewerStarted.resolve()
    return await new Promise((resolve, reject) => {
      runOptions.signal.addEventListener('abort', () => {
        setTimeout(() => reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED')), 20)
      }, { once: true })
    })
  }
  const workspace = new LocalWorkspace({ ...options, runAbortGraceMs: 100 })
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Stop role review', agentKinds: ['codex', 'hermes'], workdir: directory, allowWrite: true,
  })
  const workflow = roleReviewWorkflow()

  const send = workspace.sendMessage(workflowInput(group.id, workflow))
  await reviewerStarted.promise
  const runId = workspace.activeRuns.get(group.id).runId
  assert.equal(workspace.stop(group.id, runId), true)
  await assert.rejects(
    workspace.sendMessage({ groupId: group.id, text: 'Too early', targetKinds: ['codex'] }),
    { message: 'LOCAL_GROUP_RUNNING' },
  )
  await assert.rejects(send, { message: 'LOCAL_AGENT_EXECUTION_STOPPED' })

  assert.equal(reviewerCalls, 1)
  assert.equal(workspace.isGroupBusy(group.id), false)
  await workspace.sendMessage({ groupId: group.id, text: 'After cleanup', targetKinds: ['codex'] })
  assert.equal(workspace.snapshot().messages.at(-1).content, 'codex result')
})
