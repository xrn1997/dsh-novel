// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiClientError, describeError } from '../../src/client/api.js'
import { CopyProvider, enTranslate, zhTranslate } from '../../src/client/copy/index.js'
import { ErrorBanner } from '../../src/client/views/bits.js'
import { Dialog } from '../../src/client/views/dialog.js'

/**
 * 错误文案的翻译边界：**只翻客户端自己造的那三条网络错误**（构造时带 `reason`），
 * 服务端错误原文原样透传：服务端文案不在这层。错误横幅的骨架文案（段徽标 / 未知错误 / 重试）
 * 与抽屉关闭钮同样随当前语言。
 */

afterEach(cleanup)

describe('describeError', () => {
  it('客户端网络错误按语言出话', () => {
    const notJson = new ApiClientError('NetworkError', 502, '响应不是 JSON（HTTP 502）', undefined, 'not-json')
    expect(describeError(notJson, enTranslate)).toBe('The response was not JSON (HTTP 502)')
    expect(describeError(notJson, zhTranslate)).toBe('响应不是 JSON（HTTP 502）')

    const requestFailed = new ApiClientError('NetworkError', 0, '网络请求失败: fetch failed', undefined, 'request-failed')
    expect(describeError(requestFailed, enTranslate)).toBe('Network request failed: fetch failed')
    expect(describeError(requestFailed, zhTranslate)).toBe('网络请求失败: fetch failed')

    const streamDown = new ApiClientError('NetworkError', 503, '事件流不可用（HTTP 503）', undefined, 'stream-unavailable')
    expect(describeError(streamDown, enTranslate)).toBe('Event stream unavailable (HTTP 503)')
    expect(describeError(streamDown, zhTranslate)).toBe('事件流不可用（HTTP 503）')
  })

  it('服务端错误原文原样透传：服务端文案不在这层', () => {
    const server = new ApiClientError('RuleError', 400, '段级定位：第 2 行')
    expect(describeError(server, enTranslate)).toBe('段级定位：第 2 行')
  })
})

describe('错误面英文渲染', () => {
  it('ErrorBanner 的段徽标、未知错误与重试走 en 字典', () => {
    render(createElement(CopyProvider, {
      value: enTranslate,
      children: createElement(ErrorBanner, {
        error: { code: 'RuleError', segment: { facet: 'content', segmentIndex: 2 } },
        onRetry: () => undefined,
      }),
    }))
    expect(screen.getByText('content#segment 2')).toBeTruthy()
    expect(screen.getByText('RuleError: Unknown error')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })

  it('抽屉档的关闭钮走 en 字典', () => {
    render(createElement(CopyProvider, {
      value: enTranslate,
      children: createElement(Dialog, {
        title: 'Book details', variant: 'drawer', onClose: () => undefined,
      }, createElement('div', null, 'body')),
    }))
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
  })
})
