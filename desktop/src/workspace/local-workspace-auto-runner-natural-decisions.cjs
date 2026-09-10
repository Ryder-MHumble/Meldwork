const { parseTaskDecision } = require('../collaboration/task-decision.cjs')

const v4NaturalDecisionMethods = {
  v4NaturalRouteDecision(decision, activeKinds) {
    const participants = Array.isArray(activeKinds) ? activeKinds : []
    if (decision == null) return { status: 'none', kinds: [] }
    let parsed
    try { parsed = parseTaskDecision(decision) }
    catch { return { status: 'invalid', kinds: [] } }
    const requested = parsed.nextKinds || []
    if (requested.some(kind => !participants.includes(kind))) return { status: 'invalid', kinds: [] }
    if (!requested.length) return { status: 'none', kinds: [] }
    return { status: 'valid', kinds: participants.filter(kind => requested.includes(kind)) }
  },

  async v4NaturalRoundOutcome(group, controller, threadRootId, round, activeKinds) {
    const messages = this.v4NaturalDiscussionRoundMessages(group, controller, threadRootId, round)
    const owner = this.v4NaturalOwner(group, controller, threadRootId)
    const routes = messages.map(message => this.v4NaturalRouteDecision(
      message.trace?.context?.taskDecision, activeKinds,
    ))
    if (routes.some(route => route.status === 'invalid')) {
      this.addMessage(group.id, 'system', 'Discussion stopped without a valid task completion decision.',
        '', threadRootId, { key: 'system.autoTaskDecisionMissing' })
      return { status: 'partial' }
    }
    const nextKinds = this.v4NaturalNextKinds(group, controller, threadRootId, round, activeKinds)
    if (nextKinds.length) return { nextKinds, ownerReview: false }
    if (!activeKinds.includes(owner)) return { status: 'partial' }
    const ownerMessage = messages.find(message => message.agentKind === owner)
    const decision = ownerMessage?.trace?.context?.taskDecision
    if (decision?.handoffTo && !activeKinds.includes(decision.handoffTo)) return { status: 'partial' }
    if (decision?.status === 'continue') return { nextKinds: [owner], ownerReview: false }
    const sawAllContributions = messages.length === 1
      || (controller.discussionStyle === 'sequential' && messages.at(-1)?.agentKind === owner)
    if (!ownerMessage || !sawAllContributions) return { nextKinds: [owner], ownerReview: true }
    if (!decision) {
      this.addMessage(group.id, 'system', 'Discussion stopped without a valid task completion decision.',
        '', threadRootId, { key: 'system.autoTaskDecisionMissing' })
      return { status: 'partial' }
    }
    if (decision.status === 'completed') return { status: controller.failedKinds.length ? 'partial' : 'completed' }
    if (decision.status === 'needs-human' && this.requestTaskDecision) {
      const response = await this.requestTaskDecision(group, controller, ownerMessage)
      if (response?.status === 'approved') return { nextKinds: [owner], ownerReview: true }
      if (response?.status === 'rejected') {
        controller.stopReason = 'human_gate_rejected'
        return { status: 'stopped' }
      }
    }
    this.addMessage(group.id, 'system', decision.reason, '', threadRootId, {
      key: decision.status === 'needs-human' ? 'system.autoTaskNeedsHuman' : 'system.autoTaskBlocked',
      params: { reason: decision.reason },
    })
    return { status: 'partial' }
  },

  v4NaturalNextKinds(group, controller, threadRootId, round, activeKinds) {
    const current = this.v4NaturalDiscussionRoundMessages(group, controller, threadRootId, round)
    const selected = new Set(current.flatMap(message => (
      this.v4NaturalRouteDecision(message.trace?.context?.taskDecision, activeKinds).kinds
        .filter(kind => kind !== message.agentKind)
    )))
    if (!selected.size) return []
    return activeKinds.filter(kind => selected.has(kind))
  },

  v4NaturalOwner(group, controller, threadRootId) {
    let owner = controller.targetKinds[0] || ''
    for (const message of this.state().messages) {
      if (message.groupId !== group.id || message.threadRootId !== threadRootId
          || message.role !== 'agent' || message.agentKind !== owner
          || message.trace?.phase !== 'discussion'
          || !this.v4NaturalMessageMatchesBinding(message, controller)) continue
      const decision = message.trace?.context?.taskDecision
      if (decision?.status === 'continue' && decision.handoffTo
          && controller.targetKinds.includes(decision.handoffTo)) owner = decision.handoffTo
    }
    return owner
  },

  v4NaturalDiscussionIsRepeating(group, controller, threadRootId, round, activeKinds) {
    const window = Math.max(4, activeKinds.length * 2)
    if (round < window + 2) return false
    const firstRound = round - window + 1
    const previous = new Map()
    const observedRounds = new Set()
    const messages = this.state().messages
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      const messageRound = Number(message.trace?.round) || 0
      if (message.groupId !== group.id || message.threadRootId !== threadRootId
          || message.role !== 'agent' || message.trace?.phase !== 'discussion'
          || message.trace?.runId !== controller.runId || messageRound < 2
          || messageRound > round || !this.v4NaturalMessageMatchesBinding(message, controller)) continue
      const contribution = this.v4NaturalMessageContent(message)
      if (contribution.partial) return false
      const content = contribution.text
        .replace(/@[A-Za-z0-9][A-Za-z0-9_-]*/gu, '')
        .replace(/\s+/gu, ' ').trim()
      if (previous.has(message.agentKind) && previous.get(message.agentKind) !== content) return false
      if (messageRound >= firstRound) {
        observedRounds.add(messageRound)
        previous.set(message.agentKind, content)
      } else {
        previous.delete(message.agentKind)
        if (observedRounds.size === window && previous.size === 0) return true
      }
    }
    return false
  },

  v4NaturalStopRepeatingDiscussion(group, controller, threadRootId, round, activeKinds) {
    if (!this.v4NaturalDiscussionIsRepeating(group, controller, threadRootId, round, activeKinds)) return false
    this.addMessage(
      group.id, 'system',
      'Automatic discussion stopped because repeated handoffs produced no new contribution.',
      '', threadRootId, { key: 'system.autoDiscussionStalled' },
    )
    return true
  },
}

module.exports = { v4NaturalDecisionMethods }
