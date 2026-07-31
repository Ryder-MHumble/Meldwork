import { publicAsset } from './catalog.js'

function defaultState(accessMode) {
  if (accessMode === 'vault') {
    return {
      installed: false,
      vaultPath: '',
      configured: false,
      readable: false,
      writable: false,
      probeState: 'idle',
      errorCode: '',
    }
  }
  if (accessMode === 'cli') {
    return {
      installed: false,
      commandName: '',
      loginState: 'missing',
      permissionState: 'unknown',
      configured: false,
      readable: false,
      writable: false,
      probeState: 'idle',
      errorCode: '',
    }
  }
  return {
    configured: false,
    connected: false,
    authState: 'missing',
    permissionState: 'unknown',
    readable: false,
    writable: false,
    probeState: 'idle',
    errorCode: '',
  }
}

export const KNOWLEDGE_BASE_CATALOG = Object.freeze([
  {
    kind: 'feishu',
    accessMode: 'cli',
    logo: publicAsset('knowledge-base-logos/feishu.svg'),
    defaultState: defaultState('cli'),
  },
  {
    kind: 'dingtalk',
    accessMode: 'cli',
    logo: publicAsset('knowledge-base-logos/dingtalk.svg'),
    defaultState: defaultState('cli'),
  },
  {
    kind: 'obsidian',
    accessMode: 'vault',
    logo: publicAsset('knowledge-base-logos/obsidian.svg'),
    defaultState: defaultState('vault'),
  },
  {
    kind: 'notion',
    accessMode: 'oauth',
    logo: publicAsset('knowledge-base-logos/notion.svg'),
    defaultState: defaultState('oauth'),
  },
  {
    kind: 'confluence',
    accessMode: 'oauth',
    logo: publicAsset('knowledge-base-logos/confluence.svg'),
    defaultState: defaultState('oauth'),
  },
  {
    kind: 'googledrive',
    accessMode: 'oauth',
    logo: publicAsset('knowledge-base-logos/googledrive.svg'),
    defaultState: defaultState('oauth'),
  },
  {
    kind: 'sharepoint',
    accessMode: 'oauth',
    logo: publicAsset('knowledge-base-logos/sharepoint.svg'),
    defaultState: defaultState('oauth'),
  },
])
