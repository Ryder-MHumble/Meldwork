const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

function testFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) return testFiles(filename)
    return entry.isFile() && entry.name.endsWith('.test.cjs') ? [filename] : []
  })
}

const result = spawnSync(process.execPath, ['--test', ...testFiles('test').sort()], {
  stdio: 'inherit',
})

if (result.error) throw result.error
process.exitCode = result.status ?? 1
