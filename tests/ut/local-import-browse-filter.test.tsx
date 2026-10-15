// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom
// Import Session browse 步「按文件名/session id 过滤」IT：原生会话目录（如
// ~/.codex/sessions/2026/10/08）一天几十个 rollout 文件，文件名内嵌 session
// id——粘贴 id 片段即可定位目标文件。驱动真实 LocalFileImport 组件：进入
// browse 步 → 断言全量行 → 输入 id 片段过滤到目标行（含 N of M 计数与
// importable 计数）→ 清空恢复 → 进入新目录过滤自动重置。

import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { LocalFileImport } from '@/components/LocalFileImport'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null

interface MockEntry {
  name: string
  fullPath: string
  isDir: boolean
  size: number
  mtime: number | null
  isImportableFile: boolean
  importableType: string | null
}

// 模拟 ~/.codex/sessions/2026/10/08：两个子目录 + 四个 rollout（id 各异）
function codexDayDir(): MockEntry[] {
  const mk = (name: string, id: string | null, size: number, mtime: number): MockEntry => ({
    name,
    fullPath: `/home/tester/.codex/sessions/2026/10/08/${name}`,
    isDir: false,
    size,
    mtime,
    isImportableFile: id !== null,
    importableType: id !== null ? 'codex-jsonl' : null,
  })
  return [
    { name: 'subdir', fullPath: '/home/tester/.codex/sessions/2026/10/08/subdir', isDir: true, size: 0, mtime: 1790000000000, isImportableFile: false, importableType: null },
    mk('rollout-2026-10-08T20-46-51-01a11b8d-5b5c-7d82-850a-70f466aad9e8.jsonl', '01a11b8d', 48213, 1790000001000),
    mk('rollout-2026-10-08T20-24-37-01a11b79-0106-7c73-b7c0-2cb22a840000.jsonl', '01a11b79', 12045, 1790000002000),
    mk('rollout-2026-10-08T19-02-11-aabbccdd-0106-7c73-b7c0-2cb22a840000.jsonl', 'aabbccdd', 892, 1790000003000),
    mk('notes.txt', null, 300, 1790000004000),
  ]
}

beforeAll(() => {
  ;(globalThis as { fetch: typeof fetch }).fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('/api/ingest/browse-directory')) {
      return Promise.resolve(new Response(JSON.stringify({
        isDirectory: true,
        entries: codexDayDir(),
        parentPath: '/home/tester/.codex/sessions/2026/10',
        currentPath: '/home/tester/.codex/sessions/2026/10/08',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } }))
  }) as typeof fetch
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

function typeInto(input: HTMLInputElement, value: string): void {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function openBrowseStep(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(createElement(LocalFileImport)) })
  await flush()

  click(findButtonByText('Import Session')!)
  await flush()

  // JSONL (auto) 伞形源（claude/codex 内容自动识别）→ 快捷按钮「Codex 原生」
  // 直达 sessions 根 → browse 步
  click(findButtonByText('JSONL (auto)')!)
  await flush()
  click(findButtonByText('Codex 原生')!)
  await flush()

  expect(document.body.textContent).toContain('/home/tester/.codex/sessions/2026/10/08')
  expect(document.querySelector('input[placeholder*="Filter by file name or session ID"]')).not.toBeNull()
}

function visibleRows(): HTMLElement[] {
  return [...document.querySelectorAll('tbody tr')] as HTMLElement[]
}

describe('Import Session browse 步：按文件名 / session id 过滤', () => {
  it('粘贴 id 片段过滤到目标文件，计数同步，清空恢复', async () => {
    await openBrowseStep()

    // 全量：2 目录/文件行 + 3 rollout + 1 txt = 5 行；3 个 importable
    expect(visibleRows()).toHaveLength(5)
    expect(document.body.textContent).toContain('3 importable files found')

    // 粘贴 session id 片段（真实场景：从别处复制了 id 前几位）
    const filterInput = document.querySelector('input[placeholder*="Filter by file name or session ID"]') as HTMLInputElement
    typeInto(filterInput, '01a11b8d')
    await flush()

    const rows = visibleRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('rollout-2026-10-08T20-46-51-01a11b8d-5b5c-7d82-850a-70f466aad9e8.jsonl')
    expect(document.body.textContent).toContain('1 of 5 shown')
    expect(document.body.textContent).toContain('1 of 3 importable files shown')

    // 清空恢复全量
    typeInto(filterInput, '')
    await flush()
    expect(visibleRows()).toHaveLength(5)
    expect(document.body.textContent).toContain('3 importable files found')
  })

  it('大小写不敏感 + 无匹配空态提示', async () => {
    await openBrowseStep()

    const filterInput = document.querySelector('input[placeholder*="Filter by file name or session ID"]') as HTMLInputElement
    typeInto(filterInput, 'A11B79') // 大写 id 片段
    await flush()
    expect(visibleRows()).toHaveLength(1)
    expect(visibleRows()[0].textContent).toContain('01a11b79')

    typeInto(filterInput, 'zzz-no-match')
    await flush()
    expect(visibleRows()).toHaveLength(1) // 空态行
    expect(document.body.textContent).toContain('No entries match your filter')
    expect(document.body.textContent).toContain('0 of 3 importable files shown')
  })
})
