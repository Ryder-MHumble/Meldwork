const test = require('node:test')
const assert = require('node:assert/strict')

const {
  RunScheduler,
  processRunScheduler,
} = require('../src/run-scheduler.cjs')

function deferredState(promise) {
  const state = { settled: false, value: null }
  promise.then(
    value => { state.settled = true; state.value = value },
    error => { state.settled = true; state.value = error },
  )
  return state
}

test('exports one process-wide scheduler with bounded defaults and no run deadline', () => {
  assert.equal(processRunScheduler instanceof RunScheduler, true)
  assert.deepEqual(processRunScheduler.snapshot().limits, { task: 2, workspace: 2, global: 4 })
  assert.equal(Object.hasOwn(processRunScheduler.snapshot(), 'timeoutMs'), false)
})

test('grants FIFO leases when shared capacity becomes available and records fake-clock queue timing', async () => {
  let now = 100
  const scheduler = new RunScheduler({
    taskLimit: 2, workspaceLimit: 2, globalLimit: 1, now: () => now,
  })
  const first = await scheduler.acquire({ taskId: 'task-1', workspaceKey: 'workspace-a' })
  now = 200
  const secondPromise = scheduler.acquire({ taskId: 'task-2', workspaceKey: 'workspace-b' })
  const secondState = deferredState(secondPromise)
  now = 300
  const thirdPromise = scheduler.acquire({ taskId: 'task-3', workspaceKey: 'workspace-c' })
  const thirdState = deferredState(thirdPromise)
  await Promise.resolve()

  assert.equal(secondState.settled, false)
  assert.equal(thirdState.settled, false)
  assert.deepEqual(scheduler.snapshot().queued.map(item => item.taskId), ['task-2', 'task-3'])

  now = 400
  assert.equal(first.release(), true)
  const second = await secondPromise
  assert.equal(second.queuedAt, 200)
  assert.equal(second.acquiredAt, 400)
  await Promise.resolve()
  assert.equal(thirdState.settled, false)

  now = 500
  second.release()
  const third = await thirdPromise
  assert.equal(third.acquiredAt, 500)
  third.release()
  assert.equal(first.release(), false)
})

test('enforces Task and Workspace limits independently', async () => {
  const taskScheduler = new RunScheduler({ taskLimit: 1, workspaceLimit: 3, globalLimit: 3 })
  const taskLease = await taskScheduler.acquire({ taskId: 'same-task', workspaceKey: 'one' })
  const taskQueued = taskScheduler.acquire({ taskId: 'same-task', workspaceKey: 'two' })
  const taskState = deferredState(taskQueued)
  await Promise.resolve()
  assert.equal(taskState.settled, false)
  taskLease.release()
  ;(await taskQueued).release()

  const workspaceScheduler = new RunScheduler({ taskLimit: 3, workspaceLimit: 1, globalLimit: 3 })
  const workspaceLease = await workspaceScheduler.acquire({
    taskId: 'task-one', workspaceKey: 'same-workspace',
  })
  const workspaceQueued = workspaceScheduler.acquire({
    taskId: 'task-two', workspaceKey: 'same-workspace',
  })
  const workspaceState = deferredState(workspaceQueued)
  await Promise.resolve()
  assert.equal(workspaceState.settled, false)
  workspaceLease.release()
  ;(await workspaceQueued).release()
})

test('grants later eligible work when an earlier request is blocked by a scoped limit', async () => {
  const scheduler = new RunScheduler({ taskLimit: 1, workspaceLimit: 3, globalLimit: 2 })
  const active = await scheduler.acquire({ taskId: 'same-task', workspaceKey: 'workspace-a' })
  const blocked = scheduler.acquire({ taskId: 'same-task', workspaceKey: 'workspace-b' })
  const blockedState = deferredState(blocked)
  const eligible = await scheduler.acquire({ taskId: 'other-task', workspaceKey: 'workspace-c' })

  await Promise.resolve()
  assert.equal(blockedState.settled, false)
  assert.deepEqual(scheduler.snapshot().queued.map(item => item.taskId), ['same-task'])

  eligible.release()
  active.release()
  ;(await blocked).release()
})

test('removes an aborted queued request without blocking the next lease', async () => {
  const scheduler = new RunScheduler({ taskLimit: 3, workspaceLimit: 3, globalLimit: 1 })
  const first = await scheduler.acquire({ taskId: 'task-1', workspaceKey: 'workspace-a' })
  const controller = new AbortController()
  const aborted = scheduler.acquire({
    taskId: 'task-2', workspaceKey: 'workspace-b', signal: controller.signal,
  })
  const next = scheduler.acquire({ taskId: 'task-3', workspaceKey: 'workspace-c' })

  controller.abort()
  await assert.rejects(aborted, { message: 'RUN_SCHEDULER_ABORTED' })
  assert.deepEqual(scheduler.snapshot().queued.map(item => item.taskId), ['task-3'])
  first.release()
  ;(await next).release()
})

test('withLease releases capacity in finally after success or failure', async () => {
  const scheduler = new RunScheduler({ globalLimit: 1 })
  await assert.rejects(
    scheduler.withLease(
      { taskId: 'task-1', workspaceKey: 'workspace-a' },
      async () => { throw new Error('operation failed') },
    ),
    { message: 'operation failed' },
  )
  assert.equal(scheduler.snapshot().active.global, 0)

  const result = await scheduler.withLease(
    { taskId: 'task-2', workspaceKey: 'workspace-b' },
    async lease => lease.leaseId,
  )
  assert.match(result, /^lease-\d+$/)
  assert.equal(scheduler.snapshot().active.global, 0)
})
