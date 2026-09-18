// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom
// Recent Imports 同 sid 双记录删除 IT：双记录导入产生两条同 taskId 的
// ImportHistory 条目（framework 区分：capture 行 = claude-code-proxy，native
// 行 = claude-code）——
//   ① 删除其中一条：DELETE /api/ingest/delete-session 请求体带 framework
//      消歧（不带会命中两行全部级联删除），localStorage 只清点击的那条
//   ② 类型徽标事实源（dbMeta）按行定位键查找——两条各显各的 framework，
//      不再都显示首行的
//   ③ framework 缺失的旧条目：回落裸 taskId 语义（删除不带 framework、
//      徽标走裸键兜底）

import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { ImportHistory, type ImportHistoryEntry } from '@/components/ImportHistory'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SID = 'cc-hist-dual-0001'
const HISTORY_KEY = 'cannbot-import-history'

let root: Root | null = null
const deleteBodies: Array<Record<string, unknown>> = []
// /api/observe/data 返回的行集（按用例可改：双行触发旧条目删除确认）
let dbRows: Array<{ taskId: string; framework: string | null; version: string | null }> = [
  { taskId: SID, framework: 'claude-code-proxy', version: '2.1.0-claude-proxy' },
  { taskId: SID, framework: 'claude-code', version: '2.1.0' },
]

beforeAll(() => {
  localStorage.clear()
  vi.stubGlobal('location', { ...window.location, reload: vi.fn() })
  ;(globalThis as { fetch: typeof fetch }).fetch = (() => {
    const json = (data: unknown) => Promise.resolve(new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } }))
    return ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/api/ingest/delete-session')) {
        deleteBodies.push(JSON.parse(String(init?.body ?? '{}')))
        return json({ deleted: 1 })
      }
      if (url.includes('/api/observe/data')) {
        // DB 侧行集（默认同 sid 两行）——徽标事实源 + 旧条目删除确认的探测源
        return json({ items: dbRows })
      }
      return json({})
    }) as typeof fetch
  })()
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  deleteBodies.length = 0
  dbRows = [
    { taskId: SID, framework: 'claude-code-proxy', version: '2.1.0-claude-proxy' },
    { taskId: SID, framework: 'claude-code', version: '2.1.0' },
  ]
  localStorage.clear()
})

async function flush(ms = 300): Promise<void> {
  const steps = Math.max(1, Math.ceil(ms / 50))
  for (let i = 0; i < steps; i++) {
    await act(async () => { await new Promise(r => setTimeout(r, 50)) })
  }
}

function deleteButtons(): HTMLButtonElement[] {
  return [...document.querySelectorAll('button[title="Delete from Insight"]')] as HTMLButtonElement[]
}

function seedEntries(entries: ImportHistoryEntry[]): void {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(entries))
}

function storedEntries(): ImportHistoryEntry[] {
  return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]')
}

describe('Recent Imports 同 sid 双记录删除', () => {
  it('① 删除单条：DELETE 带 framework 消歧，localStorage 只清该条', async () => {
    seedEntries([
      { taskId: SID, importedAt: '2026-09-17T10:00:00Z', turnCount: 2, status: 'success', query: 'wire-q1', filePath: 'cannbay@x@main:sessions/' + SID, sourceType: 'cannbot-insight', framework: 'claude-code-proxy', version: '2.1.0-claude-proxy' },
      { taskId: SID, importedAt: '2026-09-17T10:00:01Z', turnCount: 2, status: 'success', query: 'native-q1', filePath: 'cannbay@x@main:sessions/' + SID + '.native', sourceType: 'cannbot-insight', framework: 'claude-code', version: '2.1.0' },
    ])
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => { root!.render(createElement(ImportHistory)) })
    await flush()

    // 两条目都在（同 taskId 双记录）
    const btns = deleteButtons()
    expect(btns.length).toBe(2)

    // 删除第一条（capture 行）
    await act(async () => { btns[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    await flush()

    // 请求体带 framework 消歧（不带会删两行）
    expect(deleteBodies.length).toBe(1)
    expect(deleteBodies[0].taskId).toBe(SID)
    expect(deleteBodies[0].framework).toBe('claude-code-proxy')

    // localStorage 只清 capture 条目，native 条目保留
    const left = storedEntries()
    expect(left.length).toBe(1)
    expect(left[0].framework).toBe('claude-code')
  })

  it('② 徽标事实源按行定位：capture 条目显 proxy 徽标、native 条目不显', async () => {
    seedEntries([
      { taskId: SID, importedAt: '2026-09-17T10:00:00Z', turnCount: 2, status: 'success', query: 'wire-q1', filePath: 'cannbay@x@main:sessions/' + SID, sourceType: 'cannbot-insight', framework: 'claude-code-proxy', version: '2.1.0-claude-proxy' },
      { taskId: SID, importedAt: '2026-09-17T10:00:01Z', turnCount: 2, status: 'success', query: 'native-q1', filePath: 'cannbay@x@main:sessions/' + SID + '.native', sourceType: 'cannbot-insight', framework: 'claude-code', version: '2.1.0' },
    ])
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => { root!.render(createElement(ImportHistory)) })
    await flush()

    const rows = [...document.querySelectorAll('tr')].filter(r => r.querySelector('button[title="Delete from Insight"]'))
    expect(rows.length).toBe(2)
    // dbMeta 按行定位键：capture 行带 proxy 徽标（version 带 -proxy marker），
    // native 行不带——旧行为两条都查首行（capture），native 错显 proxy
    expect(rows[0].textContent).toContain('proxy')
    expect(rows[1].textContent).not.toContain('proxy')
  })

  it('③ 旧条目（framework 缺失）：删除不带 framework、只清 null 条目', async () => {
    // 单行场景（DB 只有 null-framework 条目对应的一行）——不触发多行确认
    dbRows = [{ taskId: SID, framework: 'claude-code', version: '2.1.0' }]
    seedEntries([
      { taskId: SID, importedAt: '2026-09-16T10:00:00Z', turnCount: 1, status: 'success', query: 'legacy', filePath: '/old/path.jsonl', sourceType: 'claude-jsonl' },
      { taskId: SID, importedAt: '2026-09-17T10:00:00Z', turnCount: 2, status: 'success', query: 'native-q1', filePath: 'cannbay@x@main:sessions/' + SID + '.native', sourceType: 'cannbot-insight', framework: 'claude-code', version: '2.1.0' },
    ])
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => { root!.render(createElement(ImportHistory)) })
    await flush()

    const btns = deleteButtons()
    expect(btns.length).toBe(2)
    await act(async () => { btns[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    await flush()

    // 旧条目无 framework → 请求体不带 framework 字段（route 按 taskId 消歧）
    expect(deleteBodies.length).toBe(1)
    expect(deleteBodies[0].framework).toBeUndefined()
    // 只清 null-framework 条目，带 framework 的新条目保留
    const left = storedEntries()
    expect(left.length).toBe(1)
    expect(left[0].framework).toBe('claude-code')
  })

  it('④ 旧条目 + DB 双行：delete-session 409 驱动确认弹窗，确认后带 confirmAll 重发', async () => {
    seedEntries([
      { taskId: SID, importedAt: '2026-09-16T10:00:00Z', turnCount: 1, status: 'success', query: 'legacy', filePath: '/old/path.jsonl', sourceType: 'claude-jsonl' },
    ])
    // DELETE mock：首次 409（服务端检出多行——事实源判定，不受前端列表
    // 拉取窗口截断影响），confirmAll 重发后 200
    ;(globalThis as { fetch: typeof fetch }).fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/api/ingest/delete-session')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        deleteBodies.push(body)
        // 服务端守卫语义：无 confirmAll 且多行 → 409；confirmAll → 200 全删
        if (body.confirmAll !== true) {
          return Promise.resolve(new Response(JSON.stringify({
            error: 'Multiple sessions (2) share taskId (dual recording) — delete-all requires confirmation',
            multiRow: true, rowCount: 2, taskId: SID,
          }), { status: 409, headers: { 'content-type': 'application/json' } }))
        }
        return Promise.resolve(new Response(JSON.stringify({ deleted: 2, taskId: SID }), { status: 200, headers: { 'content-type': 'application/json' } }))
      }
      if (url.includes('/api/observe/data')) return Promise.resolve(new Response(JSON.stringify({ items: dbRows }), { status: 200, headers: { 'content-type': 'application/json' } }))
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } }))
    }) as typeof fetch

    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => { root!.render(createElement(ImportHistory)) })
    await flush()

    // 点击删除 → 服务端 409 → 弹确认（首删未执行、条目保留）
    await act(async () => { deleteButtons()[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    await flush(200)
    expect(deleteBodies.length).toBe(1)
    expect(deleteBodies[0].confirmAll).toBeUndefined()
    const bodyText = document.body.textContent ?? ''
    expect(bodyText).toContain('删除全部记录')
    expect(bodyText).toContain('2 份记录')

    // 取消 → 不删除、条目保留
    const cancelBtn = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === '取消')
    await act(async () => { cancelBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    await flush(200)
    expect(deleteBodies.length).toBe(1)
    expect(storedEntries().length).toBe(1)

    // 再次删除 → 仍 409 弹窗 → 确认「删除全部」→ 带 confirmAll 重发 → 删除完成
    await act(async () => { deleteButtons()[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    await flush(200)
    const confirmBtn = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === '删除全部')
    await act(async () => { confirmBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    await flush()
    // 三次请求：首删（409）→ 再删（409）→ confirmAll 重发（200 全删）
    expect(deleteBodies.length).toBe(3)
    expect(deleteBodies[2].confirmAll).toBe(true)
    expect(storedEntries().length).toBe(0)
  })
})
