const { spawnSync } = require('node:child_process')
const { discoverTestFiles } = require('./test-discovery.cjs')

function option(name, fallback) {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1] || fallback
}

const suite = option('--suite', 'all')
const result = spawnSync(process.execPath, [
  '--test',
  '--test-concurrency=2',
  ...discoverTestFiles({ suite }),
], {
  stdio: 'inherit',
})

if (result.error) throw result.error
process.exitCode = result.status ?? 1
