const path = require('node:path')
const { fileURLToPath } = require('node:url')

function isCurrentMainFrame(event, expectedWebContents) {
  const senderFrame = event?.senderFrame
  const mainFrame = event?.sender?.mainFrame
  return Boolean(
    expectedWebContents
    && event?.sender === expectedWebContents
    && senderFrame
    && mainFrame
    && senderFrame.processId === mainFrame.processId
    && senderFrame.routingId === mainFrame.routingId,
  )
}

function isTrustedLocalRenderer(event, expectedWebContents, expectedFrontendPath) {
  if (!isCurrentMainFrame(event, expectedWebContents)) return false
  try {
    const senderUrl = new URL(event.senderFrame.url)
    return senderUrl.protocol === 'file:'
      && path.resolve(fileURLToPath(senderUrl)) === path.resolve(expectedFrontendPath)
  } catch {
    return false
  }
}

function isTrustedLocalWebContents(webContents, expectedFrontendPath) {
  if (!webContents?.mainFrame) return false
  return isTrustedLocalRenderer(
    { sender: webContents, senderFrame: webContents.mainFrame },
    webContents,
    expectedFrontendPath,
  )
}

function isAllowedExternalUrl(value) {
  try {
    const target = new URL(value)
    return target.protocol === 'https:' && !target.username && !target.password
  } catch {
    return false
  }
}

function isAllowedLocalNavigation(value, allowedPaths) {
  try {
    const target = new URL(value)
    if (target.protocol !== 'file:') return false
    const targetPath = path.resolve(fileURLToPath(target))
    return allowedPaths.some(candidate => targetPath === path.resolve(candidate))
  } catch {
    return false
  }
}

module.exports = {
  isAllowedExternalUrl,
  isAllowedLocalNavigation,
  isTrustedLocalRenderer,
  isTrustedLocalWebContents,
}
