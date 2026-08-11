const test = require('node:test')
const assert = require('node:assert/strict')

const knowledgeBaseApi = require('../../src/knowledge/local-knowledge-base.cjs')

test('keeps the Knowledge Base facade API stable after internal module extraction', () => {
  assert.deepEqual(Object.keys(knowledgeBaseApi).sort(), [
    'KNOWLEDGE_BASE_SOURCES',
    'knowledgeBaseGuideUrl',
    'knowledgeBaseSelectionHint',
    'resolveCommandPath',
    'resolveKnowledgeBaseSources',
  ])
})
