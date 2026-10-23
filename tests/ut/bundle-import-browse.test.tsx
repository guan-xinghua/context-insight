// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// BundleImport 组件 IT（页面级验证，与 LocalFileImport 同款 Dialog 交互）：
// - 本地来源：Browse 进入目录浏览 → bundle 目录绿色高亮（Bundle 类型标签 +
//   计数）→ 点击直接触发 import-bundle POST → 轮询到 done → Done 关闭 +
//   router.refresh。普通目录点击只导航、文件点击不导入。
// - 数据仓来源（与 sessions 页数据仓导入步同构的两阶段流）：Bay 按钮 →
//   目录选择阶段（顶层目录网格 + 专区计数）→ 进目录 → 过滤/全选/勾选 →
//   批量导入 → 逐项状态（pending/importing/success）轮询到完成。

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
const lakeCalls: Array<{ action?: string; runId?: string }> = []
// 数据仓顶层目录（与会话范式注册表同源）：bundle 专区 + 两个会话范式目录
const LAKE_DIRS = ['elementwise', 'opsbot-bundle', 'reduction']
// 可变响应：默认 bundle-list 成功（items + dirs）；错误用例临时切换
const lakeListResponse: { status: number; value: Record<string, unknown> } = {
  status: 200,
  value: {
    dirs: LAKE_DIRS,
    items: [
      { runId: 'lakerun01', name: '数据仓包 A', status: 'passed', memberCount: 5, sessionCount: 3, submitter: '张三', uploadedAt: '2026-10-17T02:00:00.000Z', commitTime: '2026-10-17T02:00:00.000Z', fileCount: 12, imported: true },
      { runId: 'lakerun02', name: '数据仓包 B', status: 'failed', memberCount: 2, sessionCount: 1, submitter: '李四', uploadedAt: null, commitTime: '2026-10-16T08:00:00.000Z', fileCount: 4, imported: false },
    ],
  },
}

beforeAll(() => {
  ;(globalThis as { fetch: typeof fetch }).fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('/api/settings/lake-config')) {
      return Promise.resolve(new Response(JSON.stringify({ configured: true, address: 'https://example.com/lake.git', branch: 'main' }), { status: 200, headers: { 'content-type': 'application/json' } }))
    }
    if (url.includes('/api/ingest/lake')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string; runId?: string }
      if (body.action === 'bundle-import') {
        lakeCalls.push(body)
        return Promise.resolve(new Response(JSON.stringify({ jobId: 'job-lake', state: { runId: body.runId, step: 'validate' } }), { status: 200, headers: { 'content-type': 'application/json' } }))
      }
      return Promise.resolve(new Response(JSON.stringify(lakeListResponse.value), { status: lakeListResponse.status, headers: { 'content-type': 'application/json' } }))
    }
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
  lakeCalls.length = 0
  refreshSpy.mockClear()
  lakeListResponse.status = 200
  lakeListResponse.value = {
    dirs: LAKE_DIRS,
    items: [
      { runId: 'lakerun01', name: '数据仓包 A', status: 'passed', memberCount: 5, sessionCount: 3, submitter: '张三', uploadedAt: '2026-10-17T02:00:00.000Z', commitTime: '2026-10-17T02:00:00.000Z', fileCount: 12, imported: true },
      { runId: 'lakerun02', name: '数据仓包 B', status: 'failed', memberCount: 2, sessionCount: 1, submitter: '李四', uploadedAt: null, commitTime: '2026-10-16T08:00:00.000Z', fileCount: 4, imported: false },
    ],
  }
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

describe('BundleImport 数据仓来源：两阶段目录/列表（与 sessions 页同构）+ 批量导入', () => {
  /** 行 checkbox：数据仓 bundle 表内第一列（全选 checkbox 在表格外） */
  function rowCheckboxes(): HTMLElement[] {
    return [...document.querySelectorAll('[data-slot="dialog-content"] table tbody tr [role="checkbox"]')] as HTMLElement[]
  }

  function dirButton(dir: string): HTMLButtonElement {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent?.startsWith(dir))
    if (!btn) throw new Error(`dir button not found: ${dir}`)
    return btn
  }

  /** 打开弹窗 → 切数据仓源（点击即拉目录 + 列表）→ 停在目录选择阶段 */
  async function openLakePhase1(): Promise<void> {
    await openDialog()
    click([...document.querySelectorAll('button')].find(b => b.textContent?.includes('contextBay'))!)
    await flush()
  }

  it('目录选择阶段（顶层目录网格 + 专区计数）→ 进专区 → 勾选多包批量导入 → 逐项状态轮询到完成', async () => {
    await openLakePhase1()

    // 阶段1：远端信息 + 顶层目录网格；bundle 专区计真实数，会话范式目录计 0
    expect(document.body.textContent).toContain('https://example.com/lake.git')
    expect(document.body.textContent).toContain('elementwise')
    expect(document.body.textContent).toContain('reduction')
    expect(dirButton('opsbot-bundle').textContent).toContain('2')
    expect(dirButton('elementwise').textContent).toContain('0')

    // 进专区 → 阶段2 列表（已导入徽标/规模/提交人/提交信息列）
    click(dirButton('opsbot-bundle'))
    await flush()
    expect(document.body.textContent).toContain('数据仓包 A')
    expect(document.body.textContent).toContain('已导入')
    expect(document.body.textContent).toContain('5 成员 · 3 会话')
    expect(document.body.textContent).toContain('张三')
    expect(document.body.textContent).toContain('12 files · lakerun01')
    expect(document.body.textContent).toContain('2 bundles')

    // 勾选两行 → 批量导入（Import N Selected 按钮）
    const boxes = rowCheckboxes()
    expect(boxes).toHaveLength(2)
    click(boxes[0])
    click(boxes[1])
    await flush()
    click(findButtonByText('Import 2 Selected')!)
    await flush()

    // 逐项顺序发起（runId 通道）；本地导入通道不触发
    expect(lakeCalls).toEqual([
      { action: 'bundle-import', runId: 'lakerun01' },
      { action: 'bundle-import', runId: 'lakerun02' },
    ])
    expect(importCalls).toHaveLength(0)
    expect(document.body.textContent).toContain('Progress: 0/2')
    expect(document.body.textContent).toContain('数据仓包 A')

    // 轮询到 done（status 端点复用本地导入同款 mock）→ 逐项完成摘要 + 刷新
    await act(async () => { await new Promise(r => setTimeout(r, 1300)) })
    expect(document.body.textContent).toContain('Progress: 2/2')
    expect(document.body.textContent).toContain('Bundle import complete')
    expect(document.body.textContent).toContain('新导入 3 · 已存在 1')
    expect(refreshSpy).toHaveBeenCalled()

    // Done 关闭弹窗：回到收起态
    click(findButtonByText('Done')!)
    await flush()
    expect(document.body.textContent).not.toContain('数据仓包 A')
  })

  it('会话范式目录恒空态（bundle 只在专区）；目录选择可返回阶段1', async () => {
    await openLakePhase1()

    click(dirButton('elementwise'))
    await flush()
    expect(document.body.textContent).toContain('该目录是会话范式目录')
    expect(document.body.textContent).toContain('0 bundles')

    // 目录选择返回阶段1（目录网格重现）
    click(findButtonByText('目录选择')!)
    await flush()
    expect(document.body.textContent).toContain('reduction')
  })

  it('数据仓列表失败（非凭据类错误）→ 错误展示，不进 lake 步', async () => {
    lakeListResponse.status = 500
    lakeListResponse.value = { error: '数据仓读取失败：远端不可达' }

    await openLakePhase1()

    expect(document.body.textContent).toContain('数据仓读取失败：远端不可达')
    // 停在 input 步（来源选择器仍在；lake 来源选中，本地表单按设计隐藏）
    expect(document.body.textContent).toContain('导入来源')
    expect(lakeCalls).toHaveLength(0)
  })

  it('专区空列表 → 阶段2 空态提示（含上传引导）→ Back 两跳回 input 步', async () => {
    lakeListResponse.value = { dirs: LAKE_DIRS, items: [] }
    await openLakePhase1()

    expect(dirButton('opsbot-bundle').textContent).toContain('0')
    click(dirButton('opsbot-bundle'))
    await flush()
    expect(document.body.textContent).toContain('专区暂无 bundle 包')
    expect(document.body.textContent).toContain('0 bundles')

    // 阶段2 无 Back：目录选择 → 阶段1 → Back → input 步
    click(findButtonByText('目录选择')!)
    await flush()
    click(findButtonByText('Back')!)
    await flush()
    expect(document.body.textContent).toContain('导入来源')
  })

  it('数据仓无 bundle 专区 → 阶段1 黄字引导（不阻断目录浏览）', async () => {
    lakeListResponse.value = { dirs: ['elementwise', 'reduction'], items: [] }
    await openLakePhase1()

    expect(document.body.textContent).toContain('数据仓暂无 bundle 专区')
    expect(document.body.textContent).toContain('elementwise')
  })
})
