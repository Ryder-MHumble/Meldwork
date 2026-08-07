const { cleanText } = require('./local-workspace-contracts.cjs')

const MEDIA_TERMS = Object.freeze([
  ['video', /(?:视频|影片|短片|video|film)/i],
  ['audio', /(?:音频|语音|配音|音乐|audio|voice|speech|music)/i],
  ['image', /(?:图片|图像|照片|插画|海报|image|photo|illustration|poster)/i],
])
const REQUEST_TERM = /(?:请|帮我|给我|生成|创建|制作|画(?:一|个)?|做(?:一|个)?|create|generate|make|draw|render|produce)/i
const QUESTION_PREFIX = /^(?:能否|可以(?:吗)?|是否|怎么|如何|为什么|解释|说明|介绍|分析|can\s+(?:you|codex)|how\s+(?:do|to)|why\b)/i

function mediaGenerationRequest(value) {
  const prompt = cleanText(value, 12000)
  if (!prompt || QUESTION_PREFIX.test(prompt) || /(?:吗|？|\?)\s*$/.test(prompt)
      || !REQUEST_TERM.test(prompt)) return null
  const match = MEDIA_TERMS.find(([, expression]) => expression.test(prompt))
  return match ? { type: match[0], prompt } : null
}

module.exports = { mediaGenerationRequest }
