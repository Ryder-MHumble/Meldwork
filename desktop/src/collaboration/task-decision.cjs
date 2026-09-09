const { redactSecrets } = require('../security/secret-redaction.cjs')

function parseTaskDecision(input) {
  const invalid = () => { throw new Error('LOCAL_RUN_TASK_DECISION_INVALID') }
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['status', 'reason', 'deliverables', 'handoffTo', 'nextKinds'].includes(key))
      || !['completed', 'continue', 'blocked', 'needs-human'].includes(input.status)) invalid()
  const text = (value, limit) => {
    if (typeof value !== 'string' || !value.trim() || value.length > limit
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) invalid()
    return redactSecrets(value.trim())
  }
  const reason = text(input.reason, 1600)
  if (!Array.isArray(input.deliverables) || input.deliverables.length > 16) invalid()
  const deliverables = input.deliverables.map(value => text(value, 800))
  if (input.status === 'completed' && !deliverables.length) invalid()
  if (input.handoffTo != null && (input.status !== 'continue'
      || typeof input.handoffTo !== 'string'
      || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(input.handoffTo))) invalid()
  if (input.nextKinds != null && (!Array.isArray(input.nextKinds)
      || input.nextKinds.length > 32
      || input.nextKinds.some(kind => typeof kind !== 'string'
        || !/^[a-z0-9][a-z0-9-]{0,79}$/i.test(kind))
      || (input.nextKinds.length > 0 && input.status !== 'continue'))) invalid()
  const nextKinds = input.nextKinds?.map(kind => kind.toLowerCase())
  if (nextKinds && new Set(nextKinds).size !== nextKinds.length) invalid()
  return {
    status: input.status, reason, deliverables,
    ...(input.handoffTo != null ? { handoffTo: input.handoffTo } : {}),
    ...(nextKinds ? { nextKinds } : {}),
  }
}

module.exports = { parseTaskDecision }
