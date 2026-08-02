import { describe, expect, it } from 'vitest'
import { parseAgentRoutingPrefix } from '../../agent-routing.js'
import { AGENTS } from '../../catalog.js'

const GROUP_KINDS = ['codex', 'hermes', 'kimi', 'openclaw', 'claude', 'qwen']

describe('Agent prefix routing', () => {
  it.each([
    ['Codex、Hermes，帮我检查', ['codex', 'hermes']],
    ['请 Codex 和 Claude 回答', ['codex', 'claude']],
    ['Codex Hermes 一起看', ['codex', 'hermes']],
    ['Kimi Code and Qwen Code review this', ['kimi', 'qwen']],
    ['openclaw和claude code你们俩互相了解下对方', ['openclaw', 'claude']],
  ])('routes complete Agent names at the beginning of a message', (text, expected) => {
    expect(parseAgentRoutingPrefix(text, AGENTS, GROUP_KINDS)).toEqual({
      targetKinds: expected,
      all: false,
    })
  })

  it.each([
    ['帮我让 OpenClaw 和 Claude 看一下', ['openclaw', 'claude']],
    ['比较 Codex 和 Claude 的方案', ['codex', 'claude']],
    ['Could Codex and Claude compare their approaches?', ['codex', 'claude']],
  ])('treats multiple complete Agent names anywhere as explicit recipients', (text, expected) => {
    expect(parseAgentRoutingPrefix(text, AGENTS, GROUP_KINDS)).toEqual({
      targetKinds: expected,
      all: false,
    })
  })

  it('does not route one incidental later mention or a partial Agent name', () => {
    expect(parseAgentRoutingPrefix('比较 Codex 的方案', AGENTS, GROUP_KINDS)).toEqual({
      targetKinds: [],
      all: false,
    })
    expect(parseAgentRoutingPrefix('Codexical is not a target', AGENTS, GROUP_KINDS)).toEqual({
      targetKinds: [],
      all: false,
    })
  })

  it.each([
    ['OpenClaw 不要运行，让 Claude Code 回答', ['claude']],
    ['不要让 OpenClaw 回答，请 Claude Code 回复', ['claude']],
    ['OpenClaw 不参与，只让 Claude Code 回答', ['claude']],
    ['不让 OpenClaw 运行，让 Claude Code 回答', ['claude']],
    ['OpenClaw should not run; Claude Code should answer', ['claude']],
    ["Don't let OpenClaw run; Claude Code should answer", ['claude']],
  ])('excludes explicitly negated Agents from natural routing', (text, expected) => {
    expect(parseAgentRoutingPrefix(text, AGENTS, GROUP_KINDS)).toEqual({
      targetKinds: expected,
      all: false,
    })
  })

  it('does not mistake a shared execution constraint for Agent negation', () => {
    expect(parseAgentRoutingPrefix('OpenClaw 和 Claude Code，不要修改文件', AGENTS, GROUP_KINDS)).toEqual({
      targetKinds: ['openclaw', 'claude'],
      all: false,
    })
  })

  it.each([
    ['请让 OpenClaw 先说，然后 Claude Code 再补充', ['openclaw', 'claude']],
    ['OpenClaw 负责调研，Claude Code 负责复核', ['openclaw', 'claude']],
  ])('routes multiple non-adjacent Agent assignments', (text, expected) => {
    expect(parseAgentRoutingPrefix(text, AGENTS, GROUP_KINDS)).toEqual({
      targetKinds: expected,
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
