import { describe, expect, it } from 'vitest'
import {
  DESKTOP_ERROR_MESSAGE_KEYS,
  messageKeys,
  setLocale,
  t,
  translateError,
  translateSystemMessage,
} from '../../i18n.js'

describe('RoundRelay i18n', () => {
  it('keeps English and Chinese keys in sync', () => {
    expect(messageKeys('en')).toEqual(messageKeys('zh'))
  })

  it('interpolates values in both languages', () => {
    setLocale('en')
    expect(t('home.readyCount', { ready: 3, installed: 5 })).toBe('3 ready, 5 installed')

    setLocale('zh')
    expect(t('home.readyCount', { ready: 3, installed: 5 })).toBe('3 个可用，5 个已安装')
  })

  it('maps every stable desktop error code from direct and wrapped errors', () => {
    for (const language of ['en', 'zh']) {
      setLocale(language)
      for (const [code, key] of Object.entries(DESKTOP_ERROR_MESSAGE_KEYS)) {
        expect(translateError({ code }), code).toBe(t(key))
        expect(translateError(new Error(`Error invoking remote method: Error: ${code}`)), code).toBe(t(key))
      }
    }
  })

  it('covers every renderer-facing installer and Provider error code', () => {
    const expectedCodes = [
      'INSTALL_AGENT_ALREADY_INSTALLED',
      'INSTALL_AGENT_BUSY',
      'INSTALL_AGENT_COMMAND_BLOCKED',
      'INSTALL_AGENT_DOWNLOAD_BLOCKED',
      'INSTALL_AGENT_DOWNLOAD_FAILED',
      'INSTALL_AGENT_FAILED',
      'INSTALL_AGENT_NODE_REQUIRED',
      'INSTALL_AGENT_PLATFORM_UNSUPPORTED',
      'INSTALL_AGENT_PROCESS_FAILED',
      'INSTALL_AGENT_UNSUPPORTED',
      'INSTALL_AGENT_VERIFY_FAILED',
      'PROVIDER_CREDENTIAL_REQUIRED',
      'PROVIDER_CREDENTIAL_UNAVAILABLE',
      'PROVIDER_ENCRYPTION_FAILED',
      'PROVIDER_ENCRYPTION_UNAVAILABLE',
      'PROVIDER_INSECURE_BASE_URL',
      'PROVIDER_INVALID_CREDENTIAL',
      'PROVIDER_INVALID_METADATA',
      'PROVIDER_STORAGE_PATH_REQUIRED',
      'OPENCLAW_PROVIDER_INVALID',
    ]

    expect(expectedCodes.filter(code => !DESKTOP_ERROR_MESSAGE_KEYS[code])).toEqual([])
  })

  it('maps stable desktop errors and localizes system message parameters', () => {
    const systemMessage = reason => ({
      content: `Hermes failed: ${reason}`,
      system: {
        key: 'system.agentCallFailed',
        params: { agent: 'Hermes', reason },
      },
    })

    setLocale('en')
    expect(translateError(new Error('PROVIDER_CREDENTIAL_REQUIRED')))
      .toBe("Configure this Agent's Provider before running it.")
    expect(translateError(new Error('LOCAL_AGENT_AUTH_REQUIRED')))
      .toBe('Sign in to this Agent or configure its credentials, then try again.')
    expect(translateError(new Error('LOCAL_AGENT_PROCESS_FAILED')))
      .toBe('The Agent process failed before completing the task.')
    expect(translateError(new Error('LOCAL_AGENT_TIMEOUT')))
      .toBe('This Agent took too long to respond. Try again or start a new conversation.')
    expect(translateSystemMessage(systemMessage('LOCAL_AGENT_EXECUTION_STOPPED')))
      .toBe('Hermes failed: Agent execution stopped.')
    expect(translateSystemMessage(systemMessage('LOCAL_AGENT_TIMEOUT')))
      .toBe('Hermes failed: This Agent took too long to respond. Try again or start a new conversation.')
    expect(translateSystemMessage(systemMessage('LOCAL_AGENT_AUTH_REQUIRED')))
      .toBe('Hermes failed: Sign in to this Agent or configure its credentials, then try again.')
    expect(translateSystemMessage(systemMessage('LOCAL_AGENT_PROCESS_FAILED')))
      .toBe('Hermes failed: The Agent process failed before completing the task.')

    setLocale('zh')
    expect(translateError(new Error('PROVIDER_CREDENTIAL_REQUIRED')))
      .toBe('请先配置该 Agent 的独立 Provider，再运行。')
    expect(translateError(new Error('LOCAL_AGENT_AUTH_REQUIRED')))
      .toBe('请先登录该 Agent 或完成凭据配置后再试。')
    expect(translateError(new Error('LOCAL_AGENT_PROCESS_FAILED')))
      .toBe('Agent 进程在任务完成前执行失败。')
    expect(translateError(new Error('LOCAL_AGENT_TIMEOUT')))
      .toBe('该 Agent 响应超时，请重试或新建会话后继续。')
    expect(translateSystemMessage(systemMessage('LOCAL_AGENT_EXECUTION_STOPPED')))
      .toBe('Hermes 调用失败：Agent 执行已停止。')
    expect(translateSystemMessage(systemMessage('LOCAL_AGENT_TIMEOUT')))
      .toBe('Hermes 调用失败：该 Agent 响应超时，请重试或新建会话后继续。')
    expect(translateSystemMessage(systemMessage('LOCAL_AGENT_AUTH_REQUIRED')))
      .toBe('Hermes 调用失败：请先登录该 Agent 或完成凭据配置后再试。')
    expect(translateSystemMessage(systemMessage('LOCAL_AGENT_PROCESS_FAILED')))
      .toBe('Hermes 调用失败：Agent 进程在任务完成前执行失败。')
  })

  it('localizes automatic discussion limits and falls back for unknown system keys', () => {
    const roundLimit = {
      content: 'Automatic discussion reached its round limit.',
      system: { key: 'system.autoRoundLimit', params: { rounds: 3 } },
    }
    const timeout = {
      content: 'Automatic discussion reached its total runtime limit.',
      system: { key: 'system.autoTimeout', params: {} },
    }
    const unknown = {
      content: 'Readable fallback from the desktop process.',
      system: { key: 'system.futureMessage', params: {} },
    }

    setLocale('en')
    expect(translateSystemMessage(roundLimit))
      .toBe('Automatic discussion reached the 3-round limit without reaching consensus.')
    expect(translateSystemMessage(timeout))
      .toBe('Automatic discussion reached the total runtime limit without reaching consensus.')
    expect(translateSystemMessage(unknown)).toBe(unknown.content)

    setLocale('zh')
    expect(translateSystemMessage(roundLimit)).toBe('自动讨论已达到 3 轮上限，尚未达成共识。')
    expect(translateSystemMessage(timeout)).toBe('自动讨论已达到总运行时长上限，尚未达成共识。')
    expect(translateSystemMessage(unknown)).toBe(unknown.content)
  })
})
