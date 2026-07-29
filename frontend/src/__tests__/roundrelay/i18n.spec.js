import { describe, expect, it } from 'vitest'
import {
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
      .toBe('Configure a shared Provider before running this Agent.')
    expect(translateError(new Error('LOCAL_AGENT_AUTH_REQUIRED')))
      .toBe('Sign in to this Agent or configure its credentials, then try again.')
    expect(translateError(new Error('LOCAL_AGENT_PROCESS_FAILED')))
      .toBe('The Agent process failed before completing the task.')
    expect(translateSystemMessage(systemMessage('LOCAL_AGENT_EXECUTION_STOPPED')))
      .toBe('Hermes failed: Agent execution stopped.')
    expect(translateSystemMessage(systemMessage('LOCAL_AGENT_AUTH_REQUIRED')))
      .toBe('Hermes failed: Sign in to this Agent or configure its credentials, then try again.')
    expect(translateSystemMessage(systemMessage('LOCAL_AGENT_PROCESS_FAILED')))
      .toBe('Hermes failed: The Agent process failed before completing the task.')

    setLocale('zh')
    expect(translateError(new Error('PROVIDER_CREDENTIAL_REQUIRED')))
      .toBe('请先配置共享 Provider，再运行该 Agent。')
    expect(translateError(new Error('LOCAL_AGENT_AUTH_REQUIRED')))
      .toBe('请先登录该 Agent 或完成凭据配置后再试。')
    expect(translateError(new Error('LOCAL_AGENT_PROCESS_FAILED')))
      .toBe('Agent 进程在任务完成前执行失败。')
    expect(translateSystemMessage(systemMessage('LOCAL_AGENT_EXECUTION_STOPPED')))
      .toBe('Hermes 调用失败：Agent 执行已停止。')
    expect(translateSystemMessage(systemMessage('LOCAL_AGENT_AUTH_REQUIRED')))
      .toBe('Hermes 调用失败：请先登录该 Agent 或完成凭据配置后再试。')
    expect(translateSystemMessage(systemMessage('LOCAL_AGENT_PROCESS_FAILED')))
      .toBe('Hermes 调用失败：Agent 进程在任务完成前执行失败。')
  })
})
