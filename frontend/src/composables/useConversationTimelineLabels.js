export function useConversationTimelineLabels({
  activeGroup,
  locale,
  t,
  topicReplyLabel,
}) {
  function runStatusLabel(status) {
    const normalized = String(status || '').trim().toLowerCase()
    if (normalized === 'in_progress') return t('run.status.running')
    const key = {
      pending: 'pending',
      queued: 'queued',
      preparing: 'preparing',
      running: 'running',
      streaming: 'streaming',
      waiting: 'waiting',
      completed: 'completed',
      succeeded: 'succeeded',
      failed: 'failed',
      skipped: 'skipped',
      partial: 'partial',
      cancelled: 'cancelled',
      stopped: 'stopped',
      timeout: 'timeout',
      interrupted: 'interrupted',
      'not-started': 'notStarted',
      'round-limit': 'roundLimit',
    }[normalized] || 'unknown'
    return t(`run.status.${key}`)
  }

  function traceEventTypeLabel(type) {
    const key = {
      status: 'trace.eventStatus',
      reasoning_summary: 'trace.eventReasoning',
      plan: 'trace.eventPlan',
      tool_start: 'trace.eventToolStart',
      tool_update: 'trace.eventToolUpdate',
      tool_result_summary: 'trace.eventToolResult',
      warning: 'trace.eventWarning',
    }[String(type || '').toLowerCase()] || 'trace.eventOther'
    return t(key)
  }

  function traceEventTitle(event) {
    const title = String(event?.title || '').trim()
    const connectorTitleKey = {
      connector_fallback: 'trace.eventConnectorFallback',
      connector_limited: 'trace.eventConnectorLimited',
    }[title.toLowerCase()]
    if (connectorTitleKey) return t(connectorTitleKey)
    if (!title || ['agent', 'waiting_for_output'].includes(title.toLowerCase())) return ''
    return title
  }

  function localizedStepTitle(step, index) {
    const key = String(step?.title || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
    const known = {
      reasoning: 'run.step.reasoning',
      process: 'run.step.process',
      write_file: 'run.step.writeFile',
      edit_file: 'run.step.writeFile',
      read_file: 'run.step.readFile',
      search: 'run.step.search',
      image_generation: 'run.step.imageGeneration',
      audio_generation: 'run.step.audioGeneration',
      video_generation: 'run.step.videoGeneration',
      tool: 'run.step.tool',
    }[key]
    if (known) return t(known)
    if (locale.value === 'en' && step?.title) return step.title
    return t('run.step.generic', { count: index + 1 })
  }

  function formatElapsed(milliseconds) {
    const value = Number(milliseconds)
    if (!Number.isFinite(value) || value < 0) return ''
    if (value < 60000) {
      const seconds = Math.max(0.1, Math.round(value / 100) / 10)
      return t('conversation.seconds', { count: seconds })
    }
    const minutes = Math.round(value / 6000) / 10
    return t('conversation.minutes', { count: minutes })
  }

  function messageElapsedLabel(message) {
    const elapsed = message?.elapsedMs ?? message?.metadata?.elapsedMs
    const duration = formatElapsed(elapsed)
    return duration ? t('conversation.elapsed', { duration }) : ''
  }

  function turnRailLabel(turn) {
    const values = {
      query: turn.query,
      time: turn.time || t('conversation.timeUnknown'),
      status: runStatusLabel(turn.status),
    }
    if (activeGroup.value?.conversationType === 'direct') {
      return t('conversation.turnRailDirectLabel', values)
    }
    return t('conversation.turnRailLabel', {
      ...values,
      replies: topicReplyLabel(turn.replyCount),
    })
  }

  return {
    localizedStepTitle,
    messageElapsedLabel,
    runStatusLabel,
    traceEventTitle,
    traceEventTypeLabel,
    turnRailLabel,
  }
}
