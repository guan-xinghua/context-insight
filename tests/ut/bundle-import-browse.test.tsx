// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// BundleImport 浏览流组件 IT（页面级验证，与 LocalFileImport 同款 Dialog 交互）：
// 打开弹窗 → Browse 进入目录浏览 → bundle 目录绿色高亮（Bundle 类型标签 +
// 计数）→ 点击 bundle 目录直接触发 import-bundle POST → 轮询到 done →
// Done 关闭弹窗 + router.refresh。普通目录点击只导航、文件点击不导入。

import { describe, it, expect, afterEach, vi, beforeAll } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { BundleImport } from '@/components/run/BundleImport'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const refreshSpy = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, refresh: refreshSpy }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/runs',
}))

interface Entry {
  name: string
  fullPath: string
  isDir: boolean
  size: number
  mtime: number
  isImportableFile: boolean
  importableType: string | null
  isBundleDir?: boolean
}

// /bundles：一个 bundle 目录 + 一个普通目录 + 散文件
const bundlesDir = (): Entry[] => [
  { name: 'my-run', fullPath: '/bundles/my-run', isDir: true, size: 0, mtime: 1790000001000, isImportableFile: false, importableType: null, isBundleDir: true },
  { name: 'plain-dir', fullPath: '/bundles/plain-dir', isDir: true, size: 0, mtime: 1790000002000, isImportableFile: false, importableType: null, isBundleDir: false },
  { name: 'notes.txt', fullPath: '/bundles/notes.txt', isDir: false, size: 10, mtime: 1790000003000, isImportableFile: false, importableType: null },
]

// /bundles/my-run：包内部（workflow.json + sessions/）
const bundleInside = (): Entry[] => [
  { name: 'workflow.json', fullPath: '/bundles/my-run/workflow.json', isDir: false, size: 61000, mtime: 1790000004000, isImportableFile: false, importableType: null },
  { name: 'sessions', fullPath: '/bundles/my-run/sessions', isDir: true, size: 0, mtime: 1790000005000, isImportableFile: false, importableType: null },
]

const importCalls: { dirPath?: string }[] = []

beforeAll(() => {
  ;(globalThis as { fetch: typeof fetch }).fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('/api/ingest/browse-directory')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { dirPath?: string }
      const isBundleInside = body.dirPath === '/bundles/my-run'
      return Promise.resolve(new Response(JSON.stringify({
        isDirectory: true,
        entries: isBundleInside ? bundleInside() : bundlesDir(),
        parentPath: isBundleInside ? '/bundles' : '/',
        currentPath: body.dirPath ?? '/',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    }
    if (url.includes('/api/ingest/import-bundle/status')) {
      return Promise.resolve(new Response(JSON.stringify({
        job: {
          jobId: 'job-1', runId: 'minidemo01', step: 'done', total: 4,
          imported: 3, existing: 1, missingFile: 0, failed: 0,
          currentSid: null, error: null, warnings: [],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    }
    if (url.includes('/api/ingest/import-bundle')) {
      importCalls.push(JSON.parse(String(init?.body ?? '{}')))
      return Promise.resolve(new Response(JSON.stringify({ ok: true, jobId: 'job-1', runId: 'minidemo01' }), { status: 200, headers: { 'content-type': 'application/json' } }))
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } }))
  }) as typeof fetch
})

let root: Root | null = null

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

async function openDialog(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(createElement(BundleImport)) })
  await flush()
  click(findButtonByText('导入 Bundle')!)
  await flush()
}

async function openBrowseStep(): Promise<void> {
  await openDialog()
  click(findButtonByText('Browse')!)
  await flush()
}

function visibleRows(): HTMLElement[] {
  return [...document.querySelectorAll('tbody tr')] as HTMLElement[]
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  importCalls.length = 0
  refreshSpy.mockClear()
})

describe('BundleImport（LocalFileImport 同款 Dialog 流）：目录浏览选包导入', () => {
  it('Browse → bundle 目录高亮 + 计数 → 点击 bundle 目录直接导入 → 轮询到 done → Done 关闭', async () => {
    await openBrowseStep()

    // 浏览步：3 行；bundle 目录有 Bundle 类型标签与计数
    expect(visibleRows()).toHaveLength(3)
    expect(document.body.textContent).toContain('my-run')
    expect(document.body.textContent).toContain('Bundle')
    expect(document.body.textContent).toContain('plain-dir')
    expect(document.body.textContent).toContain('Directory')
    expect(document.body.textContent).toContain('1 bundle directories found')

    // 点击 bundle 目录行 → 直接触发导入 job（POST 带包路径）
    const bundleRow = visibleRows().find(tr => tr.textContent?.includes('my-run'))!
    click(bundleRow)
    await flush()
    expect(importCalls).toEqual([{ dirPath: '/bundles/my-run' }])
    // 导入步已渲染（job 初始 validate 态）
    expect(document.body.textContent).toContain('校验 manifest')

    // 等 1s 轮询打到 done：进度满格 + 完成摘要 + Done 按钮
    await act(async () => { await new Promise(r => setTimeout(r, 1300)) })
    expect(document.body.textContent).toContain('Progress: 4/4')
    expect(document.body.textContent).toContain('Import complete')
    expect(document.body.textContent).toContain('完成：新导入 3 · 已存在 1')
    expect(refreshSpy).toHaveBeenCalled()

    // Done 关闭弹窗：回到收起态（input 步内容不再渲染）
    click(findButtonByText('Done')!)
    await flush()
    expect(document.body.textContent).not.toContain('Bundle 目录')
  })

  it('普通目录点击只导航；文件点击不触发导入；主目录快捷键可达浏览步', async () => {
    await openBrowseStep()

    // 普通目录点击 = 导航（currentDir 变化），不触发导入
    const plainRow = visibleRows().find(tr => tr.textContent?.includes('plain-dir'))!
    click(plainRow)
    await flush()
    expect(document.body.textContent).toContain('/bundles/plain-dir')
    expect(importCalls).toHaveLength(0)

    // 文件行点击不导入（bundle 导入目标是目录）
    const fileRow = visibleRows().find(tr => tr.textContent?.includes('notes.txt'))!
    click(fileRow)
    await flush()
    expect(importCalls).toHaveLength(0)

    // Back 回 input 步；主目录快捷按钮重新进入浏览步
    click(findButtonByText('Back')!)
    await flush()
    expect(document.body.textContent).toContain('Bundle 目录')
    click(findButtonByText('主目录')!)
    await flush()
    expect(document.querySelector('input[placeholder*="Filter by directory name"]')).not.toBeNull()
    expect(importCalls).toHaveLength(0)
  })
})
