// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom
// Import Session 会话列表「按 session id 搜索」IT：select 步此前只有搜索框
// （匹配 firstQuery / id 子串）但表格不显示 Session ID——codex 等 jsonl 源
// firstQuery 常为空，会话不可辨识。驱动真实 LocalFileImport 组件验证：
// Session ID 列渲染（含 firstQuery 为空的行）、粘贴 id 片段过滤到目标行。

import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { LocalFileImport } from '@/components/LocalFileImport'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
const listedSources: string[] = []

const MOCK_SESSIONS = [
  // codex 典型形态：firstQuery 为空（注入被跳过后无真实提示）——ID 是唯一辨识位
  { id: 'aaaa1111-0000-4000-8000-000000000001', createdAt: '2026-10-09T02:00:00.000Z', endedAt: '2026-10-09T02:05:00.000Z', firstQuery: null, turnCount: 3, model: 'test-model-pro', totalTokens: 1200 },
  { id: 'bbbb2222-0000-4000-8000-000000000002', createdAt: '2026-10-09T01:00:00.000Z', endedAt: null, firstQuery: '阅读 demo 项目', turnCount: 1, model: 'test-model-pro', totalTokens: 300 },
  { id: 'cccc3333-0000-4000-8000-000000000003', createdAt: '2026-10-08T22:00:00.000Z', endedAt: null, firstQuery: '另一个问题', turnCount: 2, model: 'test-model-pro', totalTokens: 800 },
]

beforeAll(() => {
  const origFetch = globalThis.fetch
  ;(globalThis as { fetch: typeof fetch }).fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('/api/ingest/import-file/sessions')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { source: string }
      listedSources.push(body.source)
      return Promise.resolve(new Response(JSON.stringify({ sessions: MOCK_SESSIONS }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } }))
  }) as typeof fetch
  void origFetch
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  listedSources.length = 0
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

function typeInto(input: HTMLInputElement, value: string): void {
  // React 受控输入需走原型 value setter（直接赋值会被 value tracker 吞掉）
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function openSelectStep(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(createElement(LocalFileImport)) })
  await flush()

  click(findButtonByText('Import Session')!)
  await flush()

  // 选 Codex 源 → 输入 sessions 目录（非单文件 → 走列表选择步）
  click(findButtonByText('Codex')!)
  await flush()
  const pathInput = document.querySelector('input[placeholder*="rollout"]') as HTMLInputElement
  expect(pathInput).not.toBeNull()
  typeInto(pathInput, '/home/tester/.codex/sessions')
  click(findButtonByText('Load Sessions')!)
  await flush()
}

describe('Import Session 会话列表：Session ID 列 + 按 id 搜索', () => {
  it('select 步渲染 Session ID 列（含 firstQuery 为空的行），id 子串过滤命中目标行', async () => {
    await openSelectStep()

    // 走到了 select 步（sessions 路由被 codex-jsonl 源调用）
    expect(listedSources).toContain('codex-jsonl')
    expect(document.querySelector('input[placeholder*="Search by keyword or session ID"]')).not.toBeNull()

    // Session ID 列存在：3 行 id 全部在 DOM（CSS truncate 只裁显示，文本完整可搜可复制）
    const tableText = document.querySelector('table')?.textContent ?? ''
    for (const s of MOCK_SESSIONS) {
      expect(tableText).toContain(s.id)
    }

    // 按 id 片段过滤：只剩 aaaa 一行（firstQuery 为空的行也能被 id 定位）
    const searchInput = document.querySelector('input[placeholder*="Search by keyword or session ID"]') as HTMLInputElement
    typeInto(searchInput, 'aaaa1111')
    await flush()
    const rowsAfterFilter = [...document.querySelectorAll('tbody tr')].filter(
      tr => tr.textContent !== null && !tr.textContent.includes('No sessions match'),
    )
    expect(rowsAfterFilter).toHaveLength(1)
    expect(rowsAfterFilter[0].textContent).toContain('aaaa1111-0000-4000-8000-000000000001')
    expect(document.body.textContent).toContain('1 of 3 shown')

    // 清空过滤恢复全部
    typeInto(searchInput, '')
    await flush()
    const rowsRestored = [...document.querySelectorAll('tbody tr')].filter(
      tr => tr.textContent !== null && !tr.textContent.includes('No sessions found'),
    )
    expect(rowsRestored).toHaveLength(3)
  })

  it('id 列点击复制：navigator.clipboard 收到完整 session id', async () => {
    const copied: string[] = []
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: (t: string) => { copied.push(t); return Promise.resolve() } },
      configurable: true,
    })
    await openSelectStep()

    const idCell = [...document.querySelectorAll('tbody span[role="button"]')].find(
      el => el.textContent?.includes('bbbb2222'),
    )
    expect(idCell).toBeTruthy()
    click(idCell!)
    await flush()
    expect(copied).toEqual(['bbbb2222-0000-4000-8000-000000000002'])
  })
})
