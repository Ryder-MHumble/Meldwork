const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { RunLedger } = require('../../src/runs/run-ledger.cjs')
const { fixture } = require('../support/local-workspace-test-helpers.cjs')

const requests = [
  'Do not generate an image. Explain the API contract only.',
  'Create a test for the video generation API; no media service calls.',
  'Please quote the phrase "generate an audio clip" without executing it.',
  '请不要生成图片，只讨论接口设计。',
  'Generate an image using your own available tools.',
]

for (const workflow of ['direct', 'manual', 'legacy-auto', 'agent-led', 'sequential']) {
  test(`${workflow} leaves media intent and execution to the selected Agent`, async t => {
    const { directory, options } = fixture()
    const calls = []
    let mediaCalls = 0
    const natural = ['agent-led', 'sequential'].includes(workflow)
    const ledger = new RunLedger({ storagePath: path.join(directory, 'ledger.json') })
    const workspace = new LocalWorkspace({
      ...options,
      runLedger: ledger,
      naturalAgentResponses: natural,
      generateMedia: async () => { mediaCalls += 1; throw new Error('UNEXPECTED_MEDIA_DISPATCH') },
      runAgent: async (agent, prompt) => {
        calls.push({ kind: agent.kind, prompt })
        const text = 'The configured Providers do not offer the required media model.'
        const receipt = natural ? `\n[[MELDWORK_COLLABORATION:${JSON.stringify({
          summary: text,
          taskDecision: { status: 'completed', reason: 'The requested explanation is delivered.',
            deliverables: ['Explanation in this response.'], nextKinds: [] },
        })}]]` : ''
        return { outcome: 'completed', text: text + receipt }
      },
    })
    t.after(async () => {
      await workspace.stopAll()
      fs.rmSync(directory, { recursive: true, force: true })
    })
    await workspace.refreshAgents()
    const group = workspace.createGroup({
      name: 'Native execution', workdir: directory, allowWrite: true,
      agentKinds: ['hermes'],
      ...(workflow === 'direct' ? { conversationType: 'direct', directAgentKind: 'hermes' } : {}),
    })
    for (const text of requests) {
      const before = calls.length
      await workspace.sendMessage({
        groupId: group.id, text, targetKinds: ['hermes'],
        mode: ['direct', 'manual'].includes(workflow) ? 'manual' : 'auto',
        maxRounds: natural ? 3 : 1,
        ...(natural ? { protocol: 'v4', discussionStyle: workflow } : {}),
      })
      await workspace.activeRuns.get(group.id)?.promise
      assert.ok(calls.length > before)
      assert.ok(calls.slice(before).every(call => call.kind === 'hermes' && call.prompt.includes(text)))
    }
    assert.equal(mediaCalls, 0)
    assert.ok(calls.every(call => !/Meldwork generated|shared media generator was unavailable/.test(call.prompt)))
    const replies = workspace.snapshot().messages.filter(message => message.role === 'agent')
    assert.ok(replies.length >= requests.length)
    assert.ok(replies.every(message => message.content === 'The configured Providers do not offer the required media model.'))
    const root = workspace.state.messages.find(message => message.role === 'user')
    const recovered = await workspace.autoRunner.automaticContext(group, { targetKinds: ['hermes'] }, root.id)
    assert.equal(Object.hasOwn(recovered, 'rootMediaRequest'), false)
  })
}
