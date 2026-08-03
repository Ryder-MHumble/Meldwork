const test = require('node:test')
const assert = require('node:assert/strict')

const installerApi = require('../src/agent-installer.cjs')

test('keeps the Agent Installer facade API stable after internal module extraction', () => {
  assert.deepEqual(Object.keys(installerApi).sort(), [
    'AgentInstaller',
    'defaultDownloadScript',
    'defaultFindCommand',
    'defaultRunProcess',
    'installRecipe',
    'prepareInstallCommand',
    'validateScriptUrl',
  ])
})
