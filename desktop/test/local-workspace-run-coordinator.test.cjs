const assert = require('node:assert/strict')
const fs = require('node:fs')
const test = require('node:test')

const coordinatorApi = require('../src/local-workspace-run-coordinator.cjs')
const { LocalWorkspaceRunCoordinator } = coordinatorApi
const { LocalWorkspace } = require('../src/local-workspace.cjs')
const { fixture: workspaceFixture } = require('./local-workspace-test-helpers.cjs')

function fixture(overrides = {}) {
  const preparingRuns = new Map()
  const activeRuns = new Map()
  const calls = []
  let shuttingDown = false
  let nextRunId = 0
  let runSilenceWarningMs = overrides.runSilenceWarningMs ?? 20
  const coordinator = new LocalWorkspaceRunCoordinator({
    preparingRuns,
    activeRuns,
    createRunId: () => `run-${++nextRunId}`,
    getRunSilenceWarningMs: () => runSilenceWarningMs,
    setTimeout: overrides.setTimeout,
    clearTimeout: overrides.clearTimeout,
    isShuttingDown: () => shuttingDown,
    setShuttingDown: (value) => {
      shuttingDown = value
      calls.push(['shutdown', value])
    },
    checkpointRun: (...args) => calls.push(['checkpoint', ...args]),
    finishRunCheckpoint: (...args) => calls.push(['ledger-finish', ...args]),
    scheduleRunCheckpoint: (...args) => calls.push(['schedule', ...args]),
    emitChanged: overrides.emitChanged || (() => calls.push(['changed'])),
    emit: (...args) => calls.push(['emit', ...args]),
  })
  return {
    activeRuns,
    calls,
    coordinator,
    isShuttingDown: () => shuttingDown,
    preparingRuns,
    setRunSilenceWarningMs: value => { runSilenceWarningMs = value },
  }
}

test('run coordinator exposes one class and LocalWorkspace keeps its public lifecycle methods', () => {
  assert.deepEqual(Object.keys(coordinatorApi), ['LocalWorkspaceRunCoordinator'])
  const methods = [
    'createRunController', 'isGroupBusy', 'reserveRun', 'releasePreparation', 'beginRun',
    'finishRun', 'ensureRunHarness', 'emitRunEvent', 'clearAgentSilence',
    'armAgentSilence', 'clearRunSilence', 'stop', 'stopAll',
  ]
  for (const method of methods) assert.equal(typeof LocalWorkspace.prototype[method], 'function')
})

test('LocalWorkspace collaborators share the original run Map identities', (t) => {
  const { directory, options } = workspaceFixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)

  assert.equal(workspace.runCoordinator.preparingRuns, workspace.preparingRuns)
  assert.equal(workspace.runLedgerCoordinator.preparingRuns, workspace.preparingRuns)
  assert.equal(workspace.runCoordinator.activeRuns, workspace.activeRuns)
  assert.equal(workspace.runMessages.activeRuns, workspace.activeRuns)
  assert.equal(workspace.agentInvocation.activeRuns, workspace.activeRuns)
  assert.equal(workspace.runLedgerCoordinator.timers, workspace.runCheckpointTimers)
})

test('controller construction copies targets and keeps its completion state idempotent', async () => {
  const { coordinator } = fixture()
  const targets = ['codex', 'hermes']
  const controller = coordinator.createController('auto', targets, 'root-1', 20)
  targets.push('kimi')

  assert.equal(controller.runId, 'run-1')
  assert.deepEqual(controller.targetKinds, ['codex', 'hermes'])
  assert.equal(controller.maxRounds, 10)
  assert.equal(controller.unlimitedRounds, false)
  assert.equal(controller.signal.aborted, false)
  assert.equal(controller.agentFailureReasons instanceof Map, true)
  assert.equal(controller.silenceTimers instanceof Map, true)

  let completed = 0
  controller.done.then(() => { completed += 1 })
  controller.resolveDone()
  controller.resolveDone()
  await controller.done
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(completed, 1)
})

test('reservation migrates the same controller into active state and preserves lifecycle order', async () => {
  const { activeRuns, calls, coordinator, preparingRuns } = fixture()
  const reservation = coordinator.reserve('group-1', 'auto', ['codex'], 'root-1', 3)

  assert.equal(preparingRuns.get('group-1'), reservation)
  assert.deepEqual(calls.map(call => call[0]), ['checkpoint', 'changed'])
  assert.equal(calls[0][3], 'preparing')

  calls.length = 0
  const started = coordinator.begin(
    'group-1', 'auto', ['codex'], 'root-1', reservation, 3,
  )
  assert.equal(started, reservation)
  assert.equal(preparingRuns.has('group-1'), false)
  assert.equal(activeRuns.get('group-1'), reservation)
  assert.deepEqual(calls.map(call => call[0]), ['checkpoint', 'changed'])
  assert.equal(calls[0][3], 'running')

  calls.length = 0
  coordinator.finish('group-1', reservation, 'completed')
  await reservation.done
  assert.equal(activeRuns.has('group-1'), false)
  assert.deepEqual(calls.map(call => call[0]), ['ledger-finish', 'changed', 'emit'])
  assert.equal(calls[0][3], 'completed')
  assert.equal(calls[2][1], 'run-finished')
  assert.equal(calls[2][2].status, 'completed')
})

test('changed failures abort and release newly reserved or active controllers', async () => {
  const expected = new Error('listener failed')
  const first = fixture({ emitChanged: () => { throw expected } })
  let reservation
  assert.throws(() => {
    reservation = first.coordinator.reserve('group-1', 'manual', ['codex'])
  }, expected)
  assert.equal(first.preparingRuns.has('group-1'), false)
  reservation = first.calls[0][2]
  assert.equal(reservation.signal.aborted, true)

  const second = fixture({ emitChanged: () => { throw expected } })
  let active
  assert.throws(() => {
    active = second.coordinator.begin('group-2', 'manual', ['codex'], '')
  }, expected)
  assert.equal(second.activeRuns.has('group-2'), false)
  active = second.calls[0][2]
  assert.equal(active.signal.aborted, true)

  await Promise.all([reservation.done, active.done])
})

test('stale finish keeps a newer active controller while still publishing completion', async () => {
  const { activeRuns, calls, coordinator } = fixture()
  const stale = coordinator.createController('manual', ['codex'], 'root-1')
  const current = coordinator.createController('manual', ['hermes'], 'root-2')
  activeRuns.set('group-1', current)

  coordinator.finish('group-1', stale, 'completed')
  await stale.done

  assert.equal(activeRuns.get('group-1'), current)
  assert.deepEqual(calls.map(call => call[0]), ['ledger-finish', 'emit'])
  assert.equal(calls[1][2].runId, stale.runId)
})

test('RunHarness and silence warnings remain lazy, dynamic, and checkpointed in order', () => {
  let scheduled = null
  const cleared = []
  const fakeSetTimeout = (handler, delay) => {
    const timer = { unref() {} }
    scheduled = { delay, handler, timer }
    return timer
  }
  const {
    calls, coordinator, setRunSilenceWarningMs,
  } = fixture({
    clearTimeout: timer => cleared.push(timer),
    runSilenceWarningMs: 20,
    setTimeout: fakeSetTimeout,
  })
  const controller = coordinator.createController('manual', ['codex'], 'root-1')
  controller.groupId = 'group-1'
  const group = { id: 'group-1' }
  const harness = coordinator.ensureHarness(group, controller, 'root-1')
  assert.equal(coordinator.ensureHarness(group, controller, 'other-root'), harness)

  controller.harness = {
    markSilent: () => {
      calls.push(['mark-silent'])
      return { type: 'warning', title: 'waiting_for_output' }
    },
  }
  setRunSilenceWarningMs(75)
  coordinator.armAgentSilence(controller, 'codex', 1, 'agent-run-1')
  assert.equal(scheduled.delay, 75)
  scheduled.handler()

  assert.deepEqual(calls.slice(-3).map(call => call[0]), ['mark-silent', 'emit', 'schedule'])
  assert.equal(calls.at(-2)[1], 'run-event')
  coordinator.clearRunSilence(controller)
  assert.deepEqual(cleared, [scheduled.timer])
  assert.equal(controller.silenceTimers.size, 0)
})

test('stopAll deduplicates controllers, preserves stop reasons, and waits for done', async () => {
  const { activeRuns, coordinator, isShuttingDown, preparingRuns } = fixture()
  const controller = coordinator.createController('manual', ['codex'], '')
  controller.stopReason = 'user'
  let aborts = 0
  const abort = controller.abort.bind(controller)
  controller.abort = () => {
    aborts += 1
    abort()
  }
  preparingRuns.set('group-1', controller)
  activeRuns.set('group-1', controller)

  let settled = false
  const stopping = coordinator.stopAll().then(() => { settled = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(isShuttingDown(), true)
  assert.equal(aborts, 1)
  assert.equal(controller.stopReason, 'user')
  assert.equal(settled, false)
  assert.throws(
    () => coordinator.reserve('group-2', 'manual', ['codex']),
    { message: 'LOCAL_AGENT_EXECUTION_STOPPED' },
  )

  controller.resolveDone()
  await stopping
  assert.equal(settled, true)
})
