const DEFAULT_TASK_CONCURRENCY = 2
const DEFAULT_WORKSPACE_CONCURRENCY = 2
const DEFAULT_GLOBAL_CONCURRENCY = 4

function positiveLimit(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 1) return fallback
  return Math.min(1024, Math.floor(number))
}

function schedulerError(code) {
  return Object.assign(new Error(code), { code })
}

function resourceKey(value, code) {
  const key = String(value || '')
  if (!key || key.length > 256 || /[\u0000-\u001f\u007f]/.test(key)) throw schedulerError(code)
  return key
}

class RunScheduler {
  constructor(options = {}) {
    this.limits = Object.freeze({
      task: positiveLimit(options.taskLimit, DEFAULT_TASK_CONCURRENCY),
      workspace: positiveLimit(options.workspaceLimit, DEFAULT_WORKSPACE_CONCURRENCY),
      global: positiveLimit(options.globalLimit, DEFAULT_GLOBAL_CONCURRENCY),
    })
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.activeGlobal = 0
    this.activeTasks = new Map()
    this.activeWorkspaces = new Map()
    this.queue = []
    this.sequence = 0
  }

  resourceCount(collection, key) {
    return collection.get(key) || 0
  }

  canGrant(entry) {
    return this.activeGlobal < this.limits.global
      && this.resourceCount(this.activeTasks, entry.taskId) < this.limits.task
      && this.resourceCount(this.activeWorkspaces, entry.workspaceKey) < this.limits.workspace
  }

  changeCount(collection, key, change) {
    const next = this.resourceCount(collection, key) + change
    if (next > 0) collection.set(key, next)
    else collection.delete(key)
  }

  grant(entry) {
    this.activeGlobal += 1
    this.changeCount(this.activeTasks, entry.taskId, 1)
    this.changeCount(this.activeWorkspaces, entry.workspaceKey, 1)
    entry.signal?.removeEventListener('abort', entry.abortHandler)
    let released = false
    const lease = Object.freeze({
      leaseId: entry.requestId,
      taskId: entry.taskId,
      workspaceKey: entry.workspaceKey,
      queuedAt: entry.queuedAt,
      acquiredAt: this.now(),
      release: () => {
        if (released) return false
        released = true
        this.activeGlobal -= 1
        this.changeCount(this.activeTasks, entry.taskId, -1)
        this.changeCount(this.activeWorkspaces, entry.workspaceKey, -1)
        this.drain()
        return true
      },
    })
    entry.resolve(lease)
  }

  drain() {
    for (let index = 0; index < this.queue.length;) {
      const entry = this.queue[index]
      if (entry.cancelled) {
        this.queue.splice(index, 1)
        continue
      }
      if (!this.canGrant(entry)) {
        index += 1
        continue
      }
      this.queue.splice(index, 1)
      this.grant(entry)
    }
  }

  acquire(input = {}) {
    let taskId
    let workspaceKey
    try {
      taskId = resourceKey(input.taskId, 'RUN_SCHEDULER_TASK_REQUIRED')
      workspaceKey = resourceKey(input.workspaceKey, 'RUN_SCHEDULER_WORKSPACE_REQUIRED')
    } catch (error) {
      return Promise.reject(error)
    }
    const signal = input.signal
    if (signal?.aborted) return Promise.reject(schedulerError('RUN_SCHEDULER_ABORTED'))
    return new Promise((resolve, reject) => {
      const entry = {
        requestId: `lease-${++this.sequence}`,
        taskId,
        workspaceKey,
        queuedAt: this.now(),
        signal,
        resolve,
        reject,
        cancelled: false,
        abortHandler: null,
      }
      entry.abortHandler = () => {
        if (entry.cancelled) return
        entry.cancelled = true
        const index = this.queue.indexOf(entry)
        if (index >= 0) this.queue.splice(index, 1)
        reject(schedulerError('RUN_SCHEDULER_ABORTED'))
        this.drain()
      }
      signal?.addEventListener('abort', entry.abortHandler, { once: true })
      this.queue.push(entry)
      this.drain()
    })
  }

  async withLease(input, operation) {
    if (typeof operation !== 'function') throw schedulerError('RUN_SCHEDULER_OPERATION_REQUIRED')
    const lease = await this.acquire(input)
    try {
      return await operation(lease)
    } finally {
      lease.release()
    }
  }

  snapshot() {
    return {
      limits: { ...this.limits },
      active: {
        global: this.activeGlobal,
        tasks: [...this.activeTasks.entries()].map(([taskId, count]) => ({ taskId, count })),
        workspaces: [...this.activeWorkspaces.entries()]
          .map(([workspaceKey, count]) => ({ workspaceKey, count })),
      },
      queued: this.queue.filter(entry => !entry.cancelled).map(entry => ({
        requestId: entry.requestId,
        taskId: entry.taskId,
        workspaceKey: entry.workspaceKey,
        queuedAt: entry.queuedAt,
      })),
    }
  }
}

const processRunScheduler = new RunScheduler()

module.exports = {
  DEFAULT_GLOBAL_CONCURRENCY,
  DEFAULT_TASK_CONCURRENCY,
  DEFAULT_WORKSPACE_CONCURRENCY,
  RunScheduler,
  processRunScheduler,
}
