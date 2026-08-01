import { describe, expect, it } from 'vitest'
import { parseAgentRoutingPrefix } from '../../agent-routing.js'
import { AGENTS } from '../../catalog.js'

const GROUP_KINDS = ['codex', 'hermes', 'kimi', 'claude', 'qwen']

describe('Agent prefix routing', () => {
  it.each([
    ['Codex、Hermes，帮我检查', ['codex', 'hermes']],
    ['请 Codex 和 Claude 回答', ['codex', 'claude']],
    ['Codex Hermes 一起看', ['codex', 'hermes']],
    ['Kimi Code and Qwen Code review this', ['kimi', 'qwen']],
  ])('routes complete Agent names only at the beginning of a message', (text, expected) => {
    expect(parseAgentRoutingPrefix(text, AGENTS, GROUP_KINDS)).toEqual({
      targetKinds: expected,
      all: false,
    })
  })

  it('does not route an Agent mentioned later in the message', () => {
    expect(parseAgentRoutingPrefix('比较 Codex 和 Claude 的方案', AGENTS, GROUP_KINDS)).toEqual({
      targetKinds: [],
      all: false,
    })
    expect(parseAgentRoutingPrefix('Codexical is not Codex', AGENTS, GROUP_KINDS)).toEqual({
      targetKinds: [],
      all: false,
    })
  })

  it.each(['你们继续讨论', '大家一起看', '所有 Agent 回答', 'everyone review this', 'all of you continue'])
  ('routes group-wide address phrases to every member', (text) => {
    expect(parseAgentRoutingPrefix(text, AGENTS, GROUP_KINDS)).toEqual({
      targetKinds: GROUP_KINDS,
      all: true,
    })
  })
})
