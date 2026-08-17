const { spawn } = require('node:child_process')
const fs = require('node:fs')
const https = require('node:https')
const os = require('node:os')
const path = require('node:path')
const {
  abortError,
  installEnvironment,
  installerError,
  validateScriptUrl,
} = require('./agent-installer-contract.cjs')

const MAX_SCRIPT_BYTES = 4 * 1024 * 1024
const TERMINATE_GRACE_MS = 500
const KILL_SETTLE_MS = 500

function downloadResponse(url, signal, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const parsed = validateScriptUrl(url)
    let settled = false
    let request
    const abort = () => request?.destroy(abortError())
    const settle = (callback) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      callback()
    }
    request = https.get(parsed, { timeout: 30000 }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume()
        if (redirects >= 3 || !response.headers.location) {
          settle(() => reject(installerError('INSTALL_AGENT_DOWNLOAD_FAILED')))
          return
        }
        let next
        try {
          next = new URL(response.headers.location, parsed).toString()
        } catch {
          settle(() => reject(installerError('INSTALL_AGENT_DOWNLOAD_FAILED')))
          return
        }
        settle(() => downloadResponse(next, signal, redirects + 1).then(resolve, reject))
        return
      }
      if (response.statusCode !== 200) {
        response.resume()
        settle(() => reject(installerError('INSTALL_AGENT_DOWNLOAD_FAILED')))
        return
      }
      settle(() => resolve(response))
    })
    request.on('timeout', () => request.destroy(installerError('INSTALL_AGENT_DOWNLOAD_FAILED')))
    request.on('error', error => settle(() => reject(
      error?.name === 'AbortError' || String(error?.code || '').startsWith('INSTALL_AGENT_')
        ? error
        : installerError('INSTALL_AGENT_DOWNLOAD_FAILED'),
    )))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}

async function defaultDownloadScript(url, signal) {
  if (signal?.aborted) throw abortError()
  const parsed = validateScriptUrl(url)
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'meldwork-agent-install-'))
  const extension = parsed.pathname.endsWith('.ps1') ? '.ps1' : '.sh'
  const target = path.join(directory, `installer${extension}`)
  let bytes = 0
  const chunks = []
  let response
  const abort = () => response?.destroy(abortError())
  try {
    response = await downloadResponse(url, signal)
    if (signal?.aborted) throw abortError()
    signal?.addEventListener('abort', abort, { once: true })
    for await (const chunk of response) {
      bytes += chunk.length
      if (bytes > MAX_SCRIPT_BYTES) throw installerError('INSTALL_AGENT_DOWNLOAD_FAILED')
      chunks.push(chunk)
    }
    await fs.promises.writeFile(target, Buffer.concat(chunks), { mode: 0o700 })
    return target
  } catch (error) {
    await fs.promises.rm(directory, { recursive: true, force: true })
    if (error?.name === 'AbortError'
      || String(error?.code || '').startsWith('INSTALL_AGENT_')) throw error
    throw installerError('INSTALL_AGENT_DOWNLOAD_FAILED')
  } finally {
    signal?.removeEventListener('abort', abort)
  }
}

async function defaultRemoveDownload(target) {
  if (!target) return
  const directory = path.dirname(target)
  if (!path.basename(directory).startsWith('meldwork-agent-install-')) return
  await fs.promises.rm(directory, { recursive: true, force: true })
}

function defaultRunProcess(command, args, {
  signal,
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  spawnFn = spawn,
} = {}) {
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, args, {
      env: installEnvironment(platform, env, home),
      shell: false,
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
      detached: platform !== 'win32',
    })
    let settled = false
    let stopRequested = false
    let forceKillTimeout
    let forceSettleTimeout
    const finish = callback => {
      if (settled) return
      settled = true
      clearTimeout(forceKillTimeout)
      clearTimeout(forceSettleTimeout)
      signal?.removeEventListener('abort', abort)
      callback()
    }
    const rejectCancelled = () => finish(() => reject(abortError()))
    const signalProcessTree = processSignal => {
      if (platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, processSignal)
          return
        } catch { /* fall back to the direct child */ }
      }
      try {
        child.kill(processSignal)
      } catch { /* the process has already exited */ }
    }
    const abort = () => {
      if (settled || stopRequested) return
      stopRequested = true
      if (platform === 'win32' && child.pid) {
        const killer = spawnFn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore', windowsHide: true,
        })
        killer.on('error', () => {})
        killer.unref()
        forceSettleTimeout = setTimeout(rejectCancelled, KILL_SETTLE_MS)
        return
      }
      signalProcessTree('SIGTERM')
      forceKillTimeout = setTimeout(() => {
        if (settled) return
        signalProcessTree('SIGKILL')
        forceSettleTimeout = setTimeout(rejectCancelled, KILL_SETTLE_MS)
      }, TERMINATE_GRACE_MS)
    }
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    child.on('error', error => finish(() => reject(signal?.aborted ? abortError() : error)))
    child.on('close', code => finish(() => {
      if (signal?.aborted) reject(abortError())
      else if (code === 0) resolve()
      else reject(installerError('INSTALL_AGENT_PROCESS_FAILED'))
    }))
  })
}

module.exports = {
  defaultDownloadScript,
  defaultRemoveDownload,
  defaultRunProcess,
}
