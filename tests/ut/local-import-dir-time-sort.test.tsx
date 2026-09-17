// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom
// Import Session · JSONL 目录浏览时间列 IT：browse 步新增 Modified 时间列 +
// 排序箭头——默认降序（最新在前，方便按时间找会话捕获文件），点击箭头切升序。
// 驱动真实 LocalFileImport 走 input → browse 全链路（mock browse-directory
// 返回乱序 mtime 的 entries），断言 DOM 行序随排序方向翻转、目录恒置顶、
// mtime 渲染为本地时间文本；另直测 sortDirEntries 两个方向的纯排序语义。

import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { LocalFileImport, sortDirEntries } from '@/components/LocalFileImport'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null

const T = (h: number) => new Date(`2026-09-0${h}T12:00:00Z`).getTime()

const ENTRIES = [
  { name: 'cpx-ses_old.jsonl.gz', fullPath: '/cap/cpx-ses_old.jsonl.gz', isDir: false, size: 100, mtime: T(1), isImportableFile: true, importableType: 'claude-jsonl' },
  { name: 'cpx-ses_new.jsonl.gz', fullPath: '/cap/cpx-ses_new.jsonl.gz', isDir: false, size: 200, mtime: T(3), isImportableFile: true, importableType: 'claude-jsonl' },
  { name: 'subagents', fullPath: '/cap/subagents', isDir: true, size: 0, mtime: T(2), isImportableFile: false, importableType: null },
  { name: 'cpx-ses_mid.jsonl', fullPath: '/cap/cpx-ses_mid.jsonl', isDir: false, size: 150, mtime: T(2), isImportableFile: true, importableType: 'claude-jsonl' },
]

beforeAll(() => {
  ;(globalThis as { fetch: typeof fetch }).fetch = (() => {
    const json = (data: unknown) => Promise.resolve(new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } }))
    return ((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/api/ingest/browse-directory')) {
        return json({ isDirectory: true, entries: ENTRIES, parentPath: '/', currentPath: '/cap' })
      }
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
  return [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === text || b.textContent?.includes(text)) ?? null
}

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

/** browse 表数据行的文件名序列（空目录提示行不含） */
function browseRowNames(): string[] {
  return [...document.querySelectorAll('table tbody tr')]
    .map(tr => tr.querySelector('td:nth-child(2) span')?.textContent ?? '')
    .filter(n => n && n !== 'Empty directory')
}

/** Modified 表头排序控件（span role=button） */
function modifiedHeader(): HTMLElement | null {
  return ([...document.querySelectorAll('table thead th span[role="button"]')] as HTMLElement[]).find(s => s.textContent?.includes('Modified')) ?? null
}

async function renderAndGoBrowse() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(LocalFileImport))
  })
  await flush()
  // 打开 Import Session 对话框（默认 sourceType=claude-jsonl）
  await act(async () => { click(findButtonByText('Import Session')!) })
  await flush()
  const browse = findButtonByText('Browse')
  expect(browse, 'Browse 按钮未找到').toBeTruthy()
  await act(async () => { click(browse!) })
  await flush()
}

describe('Import Session · 目录浏览时间列排序', () => {
  it('默认降序（最新在前）+ 目录置顶；Modified 表头带降序箭头；mtime 渲染为时间文本', async () => {
    await renderAndGoBrowse()
    expect(modifiedHeader()).toBeTruthy()
    expect(modifiedHeader()!.querySelector('svg')).toBeTruthy()
    expect(modifiedHeader()!.textContent).toContain('Modified')
    // 目录置顶，其余按 mtime 降序：new(3) > mid(2) > old(1)
    expect(browseRowNames()).toEqual(['subagents', 'cpx-ses_new.jsonl.gz', 'cpx-ses_mid.jsonl', 'cpx-ses_old.jsonl.gz'])
    // 时间列渲染了格式化文本（非空非占位）
    const firstFileRow = [...document.querySelectorAll('table tbody tr')][1]
    expect(firstFileRow.querySelector('td:nth-child(3)')?.textContent).toMatch(/\d/)
  })

  it('点击 Modified 箭头 → 升序（最早在前），目录仍置顶', async () => {
    await renderAndGoBrowse()
    const header = modifiedHeader()!
    await act(async () => { click(header) })
    await flush()
    // 升序：old(1) < mid(2) < new(3)
    expect(browseRowNames()).toEqual(['subagents', 'cpx-ses_old.jsonl.gz', 'cpx-ses_mid.jsonl', 'cpx-ses_new.jsonl.gz'])
  })

  it('sortDirEntries 纯排序语义：两方向 + 目录置顶 + mtime 缺失兜底 + 同时间按名', () => {
    const mk = (name: string, isDir: boolean, mtime?: number | null) =>
      ({ name, fullPath: `/${name}`, isDir, size: 0, mtime, isImportableFile: !isDir, importableType: isDir ? null : 'claude-jsonl' })
    const entries = [mk('z-new', false, 300), mk('a-dir', true, 999), mk('m-old', false, 100), mk('legacy', false, undefined)]
    expect(sortDirEntries(entries, false).map(e => e.name)).toEqual(['a-dir', 'z-new', 'm-old', 'legacy'])
    expect(sortDirEntries(entries, true).map(e => e.name)).toEqual(['a-dir', 'legacy', 'm-old', 'z-new'])
    const same = [mk('b', false, 5), mk('a', false, 5)]
    expect(sortDirEntries(same, false).map(e => e.name)).toEqual(['a', 'b'])
  })
})
