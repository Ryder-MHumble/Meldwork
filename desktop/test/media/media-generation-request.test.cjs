const test = require('node:test')
const assert = require('node:assert/strict')

const { mediaGenerationRequest } = require('../../src/media/media-generation-request.cjs')

test('identifies explicit image, audio, and video generation requests', () => {
  assert.deepEqual(mediaGenerationRequest('请生成一张赛博朋克城市海报'), {
    type: 'image', prompt: '请生成一张赛博朋克城市海报',
  })
  assert.deepEqual(mediaGenerationRequest('Create a short video of an astronaut walking on Mars'), {
    type: 'video', prompt: 'Create a short video of an astronaut walking on Mars',
  })
  assert.deepEqual(mediaGenerationRequest('帮我制作一段中文配音音频'), {
    type: 'audio', prompt: '帮我制作一段中文配音音频',
  })
})

test('does not turn capability questions into paid media requests', () => {
  assert.equal(mediaGenerationRequest('Codex 可以生成图片吗？'), null)
  assert.equal(mediaGenerationRequest('How to generate a video with Codex?'), null)
  assert.equal(mediaGenerationRequest('解释一下图片生成接口'), null)
})
