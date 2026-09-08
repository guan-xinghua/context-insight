// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom
// Import Session 快捷路径 IT：JsonL/SQLite 导入的 File Path 下方提供默认路径
// 一键直达按钮（免逐级 Browse），`~` 路径由 browse-directory 服务端展开。
// 驱动真实 LocalFileImport 组件（含 Dialog 打开）：按 sourceType 断言按钮集，
// 点击"cpx proxy 捕获"→ fetch 携带 ~/.cannbot-insight/proxy → 进入 browse
// 步并展示服务端返回的展开路径。

import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { LocalFileImport } from '@/components/LocalFileImport'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
const browsedPaths: string[] = []

beforeAll(() => {
  const origFetch = globalThis.fetch
  ;(globalThis as { fetch: typeof fetch }).fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('/api/ingest/browse-directory')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { dirPath: string }
      browsedPaths.push(body.dirPath)
      return Promise.resolve(new Response(JSON.stringify({
        isDirectory: true,
        entries: [],
        parentPath: '/home/tester',
        currentPath: `/home/tester${body.dirPath.slice(1)}`,
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } }))
  }) as typeof fetch
  void origFetch
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  browsedPaths.length = 0
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

describe('LocalFileImport 快捷路径按钮', () => {
  it('JSONL 源：cpx/Claude 原生/主目录按钮就位，点击 cpx → 直达 ~/.cannbot-insight/proxy 并进入 browse', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => { root!.render(createElement(LocalFileImport)) })
    await flush()

    // 打开 Import Session 弹窗
    const trigger = findButtonByText('Import Session')
    expect(trigger, 'Import Session 触发按钮未找到').toBeTruthy()
    await act(async () => { click(trigger!) })
    await flush()
    expect(document.body.textContent).toContain('Source Type')

    // 默认 JSONL 源：快捷按钮集 = cpx 捕获 + Claude 原生 + 主目录
    for (const label of ['cpx proxy 捕获', 'Claude 原生', '主目录']) {
      expect(findButtonByText(label), `快捷按钮缺: ${label}`).toBeTruthy()
    }

    // 点击 cpx 捕获 → fetch 携带 ~ 路径 → browse 步展示服务端展开的 currentPath
    browsedPaths.length = 0
    await act(async () => { click(findButtonByText('cpx proxy 捕获')!) })
    await flush()
    expect(browsedPaths).toEqual(['~/.cannbot-insight/proxy'])
    expect(document.body.textContent).toContain('/home/tester/.cannbot-insight/proxy')
    expect(document.body.textContent).toContain('importable files found')

    container.remove()
  })

  it('SQLite 源：按钮集切换为 opencode 数据 + 主目录（无 cpx/Claude 原生）', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => { root!.render(createElement(LocalFileImport)) })
    await flush()

    await act(async () => { click(findButtonByText('Import Session')!) })
    await flush()

    await act(async () => { click(findButtonByText('SQLite (auto)')!) })
    await flush()
    expect(findButtonByText('opencode 数据'), 'SQLite 源缺 opencode 快捷按钮').toBeTruthy()
    expect(findButtonByText('主目录')).toBeTruthy()
    expect(findButtonByText('cpx proxy 捕获'), 'SQLite 源不应出现 cpx 按钮').toBeNull()
    expect(findButtonByText('Claude 原生'), 'SQLite 源不应出现 Claude 原生按钮').toBeNull()

    browsedPaths.length = 0
    await act(async () => { click(findButtonByText('opencode 数据')!) })
    await flush()
    expect(browsedPaths).toEqual(['~/.local/share/opencode'])

    container.remove()
  })
})
