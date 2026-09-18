// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom
// Import Session 加载反馈 IT：Load Sessions 扫描目录/读库期间（请求在途）
// 前端给出转圈指示（content 区 Loading sessions... + 按钮转圈禁用 + Browse
// 防误触），成功进入选择步或失败报错后 Loading 态复位。驱动真实
// LocalFileImport 组件走 input → select 全链路。

import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { LocalFileImport } from '@/components/LocalFileImport'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null

const PREVIEW = [
  { id: 'ses_alpha-0001', createdAt: '2026-09-01T10:00:00Z', endedAt: null, firstQuery: '帮我修复登录页的 Bug', turnCount: 5, totalTokens: 12000 },
]

// 挂起的 sessions 响应：由测试显式 resolve，模拟数秒的目录扫描/读库耗时
let resolveSessions: ((sessions: unknown[]) => void) | null = null
// 每个用例可改写的行为：hang = 挂起等测试放行；reject = 立即网络失败
let sessionsBehavior: 'hang' | 'reject' = 'hang'

beforeAll(() => {
  ;(globalThis as { fetch: typeof fetch }).fetch = (() => {
    const json = (data: unknown) => Promise.resolve(new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } }))
    return ((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/api/ingest/import-file/sessions')) {
        if (sessionsBehavior === 'reject') return Promise.reject(new Error('network down'))
        return new Promise<Response>(resolve => {
          resolveSessions = (sessions) => resolve(new Response(JSON.stringify({ sessions }), { status: 200, headers: { 'content-type': 'application/json' } }))
        })
      }
      return json({})
    }) as typeof fetch
  })()
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  resolveSessions = null
  sessionsBehavior = 'hang'
})

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })
  }
}

function findButtonByText(text: string): HTMLButtonElement | null {
  return [...document.querySelectorAll('button')].find(b => b.textContent?.includes(text)) ?? null
}

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** 打开对话框并走到 SQLite (auto) + 已填路径的 input 步 */
async function openInputStep(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(createElement(LocalFileImport)) })
  await flush()

  await act(async () => { click(findButtonByText('Import Session')!) })
  await flush()
  await act(async () => { click(findButtonByText('SQLite (auto)')!) })
  await flush()
  const pathInput = [...document.querySelectorAll('input')].find(i => i.placeholder?.includes('sessions.db')) as HTMLInputElement
  expect(pathInput, 'File Path 输入框未找到').toBeTruthy()
  setInputValue(pathInput, '/tmp/fake-sessions.db')
}

describe('Import Session Load Sessions 加载反馈', () => {
  it('请求在途：转圈指示 + 按钮/Browse 禁用，完成后进入选择步并消失', async () => {
    await openInputStep()
    await act(async () => { click(findButtonByText('Load Sessions')!) })
    await flush()

    expect(document.body.textContent).toContain('Loading sessions...')
    const loadingBtn = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('Loading...'))
    expect(loadingBtn, '按钮未进入 Loading 态').toBeTruthy()
    expect(loadingBtn!.disabled).toBe(true)
    expect(findButtonByText('Browse')?.disabled).toBe(true)

    await act(async () => { resolveSessions?.(PREVIEW) })
    await flush()

    expect(document.body.textContent).toContain('Select sessions to import')
    expect(document.body.textContent).not.toContain('Loading sessions...')
    expect(findButtonByText('Load Sessions')).toBe(null)
  })

  it('请求失败：错误提示 + Loading 态复位（按钮恢复可用）', async () => {
    sessionsBehavior = 'reject'
    await openInputStep()
    await act(async () => { click(findButtonByText('Load Sessions')!) })
    await flush()

    expect(document.body.textContent).toContain('network down')
    expect(document.body.textContent).not.toContain('Loading sessions...')
    const loadBtn = findButtonByText('Load Sessions')
    expect(loadBtn, '按钮应恢复 Load Sessions 文案').toBeTruthy()
    expect(loadBtn!.disabled).toBe(false)
  })
})
