// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom
// Import Session 会话选择步搜索 IT：SQLite (auto) 载入 sessions 后，选择表
// 上方提供 keyword / sessionID 过滤（firstQuery 或 id 子串、大小写不敏感），
// 全选作用于当前过滤视图（与 lake 列表同款语义），空结果显示 no-match
// 提示。驱动真实 LocalFileImport 组件走完 input → select 全链路。

import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { LocalFileImport } from '@/components/LocalFileImport'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null

const PREVIEW = [
  { id: 'ses_alpha-0001', createdAt: '2026-09-01T10:00:00Z', endedAt: '2026-09-01T11:00:00Z', firstQuery: '帮我修复登录页的 Bug', turnCount: 5, totalTokens: 12000 },
  { id: 'ses_beta-0002', createdAt: '2026-09-01T12:00:00Z', endedAt: null, firstQuery: '生成 BenchHarness 算子', turnCount: 8, totalTokens: 34000 },
  { id: 'ses_gamma-0003', createdAt: '2026-09-02T09:00:00Z', endedAt: '2026-09-02T09:30:00Z', firstQuery: '分析 lake 上传失败原因', turnCount: 3, totalTokens: 9000 },
]

beforeAll(() => {
  ;(globalThis as { fetch: typeof fetch }).fetch = (() => {
    const json = (data: unknown) => Promise.resolve(new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } }))
    return ((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/api/ingest/import-file/sessions')) return json({ sessions: PREVIEW })
      return json({})
    }) as typeof fetch
  })()
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
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

/** 选择表数据行数（含勾选框的 tbody 行；no-match 提示行不含） */
function visibleRowCount(): number {
  return [...document.querySelectorAll('tbody tr')].filter(r => r.querySelector('input[type="checkbox"]')).length
}

async function openSelectStep(): Promise<HTMLInputElement> {
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
  await act(async () => { click(findButtonByText('Load Sessions')!) })
  await flush()
  expect(document.body.textContent).toContain('Select sessions to import')

  const search = [...document.querySelectorAll('input')].find(i => i.placeholder?.includes('keyword or session ID')) as HTMLInputElement
  expect(search, '搜索框未找到').toBeTruthy()
  return search
}

describe('Import Session 选择步搜索（keyword / sessionID）', () => {
  it('keyword 过滤 firstQuery（大小写不敏感）+ 计数 N of M shown', async () => {
    const search = await openSelectStep()
    expect(document.body.textContent).toContain('Select all (3 sessions)')
    expect(visibleRowCount()).toBe(3)

    setInputValue(search, 'BENCHHARNESS')
    await flush()
    expect(visibleRowCount()).toBe(1)
    expect(document.body.textContent).toContain('1 of 3 shown')
    expect(document.body.textContent).toContain('生成 BenchHarness 算子')
    expect(document.body.textContent).not.toContain('帮我修复登录页')

    setInputValue(search, '上传失败')
    await flush()
    expect(visibleRowCount()).toBe(1)
    expect(document.body.textContent).toContain('分析 lake 上传失败原因')
  })

  it('sessionID 子串过滤 + 空结果提示 + 全选作用于过滤视图', async () => {
    const search = await openSelectStep()

    setInputValue(search, 'beta-0002')
    await flush()
    expect(visibleRowCount()).toBe(1)
    expect(document.body.textContent).toContain('生成 BenchHarness 算子')

    // 全选（过滤视图）：勾选后 Import 显示 1 Selected
    const selectAll = [...document.querySelectorAll('input[type="checkbox"]')]
      .find(c => c.closest('div')?.className.includes('flex items-center gap-2 mb-2')) as HTMLInputElement
    expect(selectAll, '全选框未找到').toBeTruthy()
    await act(async () => { click(selectAll) })
    await flush()
    expect(findButtonByText('Import 1 Selected')).toBeTruthy()

    // 无命中：no-match 提示；已选不丢（仍 1 Selected）
    setInputValue(search, 'no-such-session-xyz')
    await flush()
    expect(document.body.textContent).toContain('No sessions match your search')
    expect(findButtonByText('Import 1 Selected')).toBeTruthy()
  })
})
