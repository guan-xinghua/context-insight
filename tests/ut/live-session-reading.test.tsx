// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE,
// See LICENSE in the root of the software repository for the full text of the License.
// @vitest-environment happy-dom

// 活跃会话自动同步不打断阅读 IT（客户场景回归锁）：
// 导入仍在对话的会话 → 点击某 turn 阅读详情 → 会话持续写入触发自动同步 ——
//   ① 自动同步期间整页不得闪回 "Loading session…"（此前每次同步整页
//      unmount 重挂，正在读的 turn 上下文被反复冲掉）
//   ② 选中的 turn 详情保持不重载；时间线原地增长（新 turn 出现）
//   ③ 再点同一 turn / 点详情「刷新」按钮 → 详情重新拉取（live turn 取最新）
// 数据走真实管线：fixture 捕获文件 → importSession；页面 fetch 分发到真实
// 路由 handler（session/turns/executions/bridges/turn 详情/refresh-session），
// 仅 EventSource 桩控触发时机。

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, act, type Root } from 'react'
import { createRoot as createClientRoot } from 'react-dom/client'
import { NextRequest } from 'next/server'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { importSession } from '@/lib/ingest/data-service'
import SessionDetailPage from '@/app/session/[taskId]/page'
import { GET as sessionGet } from '@/app/api/observe/session/route'
import { GET as turnsGet } from '@/app/api/observe/session/turns/route'
import { GET as executionsGet } from '@/app/api/observe/executions/route'
import { GET as bridgesGet } from '@/app/api/observe/session/bridges/route'
import { GET as turnDetailGet } from '@/app/api/observe/session/turns/[turnId]/route'
import { POST as refreshSessionPost } from '@/app/api/ingest/refresh-session/route'

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const prisma = new PrismaClient()
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'live-refresh-it-'))
const TASK_ID = 'cc-live-refresh-reading'
const CAPTURE = path.join(TMP, `${TASK_ID}.jsonl`)

const fetchLog: string[] = []
// 同步窗口注入慢响应：让"刷新进行中"的 DOM 快照可采样（终态断言抓不到
// 瞬时闪断——旧代码同步完成后 UI 复原，终态与修复版无异）
let slowTurnsList = false

function writeCapture(lines: unknown[]): void {
  fs.writeFileSync(CAPTURE, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  const t = new Date()
  fs.utimesSync(CAPTURE, t, t)
}

function userMsg(content: string, ts: string) {
  return { type: 'user', message: { role: 'user', content }, timestamp: ts }
}
function assistantMsg(text: string, ts: string) {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }], model: 'test-model', usage: { input_tokens: 5, output_tokens: 2 } }, timestamp: ts }
}

beforeAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: TASK_ID } })
  writeCapture([
    userMsg('第一次提问 READING-MARK-ONE', '2026-09-01T00:00:00.000Z'),
    assistantMsg('FIRST-ANSWER', '2026-09-01T00:00:05.000Z'),
  ])
  await importSession(CAPTURE, TASK_ID, prisma, CAPTURE, 'claude-jsonl')

  // 页面 fetch 分发到真实路由 handler（数据真实、传输桩化）
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const u = new URL(url, 'http://localhost')
    const req = new NextRequest(u.toString(), { method: init?.method ?? 'GET', body: init?.body as string | undefined })
    fetchLog.push(`${req.method} ${u.pathname}`)
    if (u.pathname === '/api/observe/session') return sessionGet(req)
    if (u.pathname === '/api/observe/session/turns') {
      if (slowTurnsList) await new Promise(r => setTimeout(r, 500))
      return turnsGet(req)
    }
    if (u.pathname === '/api/observe/executions') return executionsGet(req)
    if (u.pathname === '/api/observe/session/bridges') return bridgesGet(req)
    if (u.pathname.startsWith('/api/observe/session/turns/')) {
      return turnDetailGet(req, { params: Promise.resolve({ turnId: decodeURIComponent(u.pathname.split('/').pop() ?? '') }) })
    }
    if (u.pathname === '/api/ingest/refresh-session') return refreshSessionPost(req)
    return new Response(JSON.stringify({ error: `unmocked ${u.pathname}` }), { status: 404 })
  }) as typeof fetch)

  // EventSource 桩：捕获 onmessage，测试手动触发自动同步
  const instances: Array<{ onmessage: ((e: { data: string }) => void) | null; onerror: (() => void) | null; close: () => void }> = []
  vi.stubGlobal('EventSource', class {
    onmessage: ((e: { data: string }) => void) | null = null
    onerror: (() => void) | null = null
    constructor(_url: string) { instances.push(this as never) }
    close() { /* noop */ }
  })
  ;(globalThis as unknown as { __esInstances: typeof instances }).__esInstances = instances

  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}
})

afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: TASK_ID } }).catch(() => {})
  await prisma.$disconnect()
  fs.rmSync(TMP, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

async function renderPage(): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createClientRoot(container)
  await act(async () => {
    root.render(createElement(SessionDetailPage, { params: Promise.resolve({ taskId: TASK_ID }) }))
  })
  return { container, root }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await act(async () => { await new Promise(r => setTimeout(r, 50)) })
  }
}

function turnRows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll('button')]
    .filter(b => /^#\d+$/.test(b.querySelector('span')?.textContent ?? '')) as HTMLElement[]
}

describe('活跃会话自动同步不打断阅读', () => {
  it('①②③ 同步不闪 Loading、详情保持；重选/刷新按钮重取详情', async () => {
    const { container, root } = await renderPage()
    await settle()
    expect(container.textContent).not.toContain('Loading session...')
    expect(turnRows(container).length).toBeGreaterThanOrEqual(2)

    // 点击第一个 user turn（含 READING-MARK-ONE）阅读
    const row = turnRows(container).find(b => b.textContent?.includes('READING-MARK-ONE'))
    expect(row).toBeTruthy()
    await act(async () => { row!.click() })
    await settle()
    expect(container.textContent).toContain('FIRST-ANSWER') // 详情已展示（下一轮 assistant）

    // 会话持续：捕获追加新轮次 → SSE 触发自动同步
    writeCapture([
      userMsg('第一次提问 READING-MARK-ONE', '2026-09-01T00:00:00.000Z'),
      assistantMsg('FIRST-ANSWER', '2026-09-01T00:00:05.000Z'),
      userMsg('第二问 NEW-TURN-MARK', '2026-09-01T00:01:00.000Z'),
      assistantMsg('SECOND-ANSWER', '2026-09-01T00:01:05.000Z'),
    ])
    const es = (globalThis as unknown as { __esInstances: Array<{ onmessage: ((e: { data: string }) => void) | null }> }).__esInstances.at(-1)!
    expect(es).toBeTruthy()
    slowTurnsList = true // 同步的 turns 拉取放慢 500ms，制造可采样的同步窗口
    await act(async () => {
      es.onmessage?.({ data: JSON.stringify({ settled: true, maxTimeUpdated: 1 }) }) // 初始化
      es.onmessage?.({ data: JSON.stringify({ settled: true, maxTimeUpdated: 2 }) }) // 触发同步
    })
    // 同步窗口中段（refresh 已触发、turns 列表仍在拉取）：整页不得闪回
    // Loading、正在读的详情不得消失 —— 旧代码在此刻整页 unmount
    await act(async () => { await new Promise(r => setTimeout(r, 250)) })
    expect(container.textContent).not.toContain('Loading session...')
    expect(container.textContent).toContain('FIRST-ANSWER')
    await settle()
    slowTurnsList = false

    // ① 同步期间整页未闪回 Loading（若闪断，详情与 mark 会消失）
    expect(container.textContent).not.toContain('Loading session...')
    // ② 正在读的详情原样保留；时间线原地增长。固定 settle（2s）在满载下
    // 偶发不够（同步拉取 500ms 慢窗 + 渲染链被调度挤后 → 只见首轮 2 行，
    // 本机两次间歇失败单跑均绿）——改为轮询等到行数达标，上限 6s
    for (let i = 0; i < 120 && turnRows(container).length < 4; i++) {
      await act(async () => { await new Promise(r => setTimeout(r, 50)) })
    }
    expect(turnRows(container).length).toBeGreaterThanOrEqual(4)
    expect(container.textContent).toContain('FIRST-ANSWER')
    expect(container.textContent).toContain('NEW-TURN-MARK')

    // ③ 再点同一 turn → 详情重新拉取（live turn 取最新的自然交互）
    const detailCallsBefore = fetchLog.filter(l => l.startsWith('GET /api/observe/session/turns/') && !l.includes('?')).length
    await act(async () => { row!.click() })
    await settle()
    const detailCallsAfter = fetchLog.filter(l => l.startsWith('GET /api/observe/session/turns/') && !l.includes('?')).length
    expect(detailCallsAfter).toBeGreaterThan(detailCallsBefore)
    expect(container.textContent).toContain('FIRST-ANSWER')

    // ③ 详情面板「⟳ 刷新」按钮同样重取
    const refreshBtn = [...container.querySelectorAll('span[role="button"]')].find(s => s.textContent?.includes('刷新')) as HTMLElement
    expect(refreshBtn).toBeTruthy()
    const before2 = fetchLog.filter(l => l.startsWith('GET /api/observe/session/turns/') && !l.includes('?')).length
    await act(async () => { refreshBtn.click() })
    await settle()
    expect(fetchLog.filter(l => l.startsWith('GET /api/observe/session/turns/') && !l.includes('?')).length).toBeGreaterThan(before2)
    expect(container.textContent).toContain('FIRST-ANSWER')

    root.unmount()
    container.remove()
  }, 60_000)
})
