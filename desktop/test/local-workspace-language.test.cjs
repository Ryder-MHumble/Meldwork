const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { LocalWorkspace } = require('../src/local-workspace.cjs')
const { fixture } = require('./local-workspace-test-helpers.cjs')

function assertLanguageContract(prompt, language) {
  assert.match(prompt, /Response language contract:/)
  assert.match(
    prompt,
    new RegExp(`The latest user message is written primarily in ${language}\\.`),
  )
  assert.match(
    prompt,
    /Do not infer response language from the app UI locale, operating-system locale, Agent name, attachment filenames, or earlier conversation turns\./,
  )
}

test('latest user text is the only response-language signal in bootstrap and continuation prompts', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)

  await workspace.refreshAgents()
  const cases = [
    {
      group: {
        name: '中文界面 / 中文系统',
        topic: '历史讨论要求中文',
        locale: 'zh',
        systemLocale: 'zh-CN',
      },
      historyUser: '请始终使用中文回答之前的问题。',
      historyAgent: '历史结论：后续输出必须全部使用中文。',
      latest: 'Please summarize the attached report and provide the final recommendation in English.',
      attachment: '中文附件-研究报告.png',
      language: 'English',
    },
    {
      group: {
        name: 'English UI / English OS',
        topic: 'Earlier English task and English UI',
        locale: 'en',
        systemLocale: 'en-US',
      },
      historyUser: 'Keep all previous answers in English.',
      historyAgent: 'Earlier conclusion: continue every response in English.',
      latest: '请阅读附件并用中文给出最终建议。',
      attachment: 'english-report.png',
      language: 'Chinese',
    },
  ]

  for (const entry of cases) {
    const group = workspace.createGroup({
      ...entry.group,
      agentKinds: ['codex'],
      workdir: directory,
    })
    group.uiLocale = entry.group.locale
    group.osLocale = entry.group.systemLocale
    const historyUser = workspace.addMessage(group.id, 'user', entry.historyUser)
    workspace.addMessage(
      group.id,
      'agent',
      entry.historyAgent,
      'codex',
      historyUser.id,
    )
    const latestUser = workspace.addMessage(
      group.id,
      'user',
      entry.latest,
      '',
      '',
      null,
      {
        attachments: [{
          id: `${entry.language.toLowerCase()}-attachment`,
          name: entry.attachment,
          mimeType: 'image/png',
          size: 128,
        }],
      },
    )
    const packed = workspace.packedPromptContext(group.id, '', latestUser.id)

    assert.equal(packed.latestUserLanguage, entry.language)
    assert.equal(packed.latestUserMessageId, latestUser.id)
    for (const promptMode of ['bootstrap', 'continuation']) {
      const prompt = workspace.promptFor(
        group,
        'codex',
        'manual',
        latestUser.id,
        [],
        [],
        '',
        packed,
        promptMode,
      )
      assertLanguageContract(prompt, entry.language)
    }
  }
})
