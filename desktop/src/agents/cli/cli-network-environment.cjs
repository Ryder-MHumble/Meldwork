const NETWORK_ENV_KEYS = Object.freeze([
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'NODE_USE_ENV_PROXY',
])

function networkEnvironment(source = {}, platform = process.platform) {
  const result = {}
  for (const [key, value] of Object.entries(source)) {
    const allowed = platform === 'win32'
      ? NETWORK_ENV_KEYS.find(name => name.toLowerCase() === key.toLowerCase())
      : NETWORK_ENV_KEYS.find(name => name === key)
    if (allowed && typeof value === 'string') result[allowed] = value
  }
  return result
}

module.exports = { NETWORK_ENV_KEYS, networkEnvironment }
