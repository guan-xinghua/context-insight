// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom
// 交互级复现 IT（客户现场 bug）：Turns 页逐个点击 turn，LLM Input 块随点击
// 数累积（点#2→1 块，#3→2 块，#4→3 块，再点#2→4 块），只有最后一块可展开。
// 加载真实 session 页面组件 + 回放真实 API 数据（ses_066d0d8aa，cannbay2
// materialized 的 2954-turn 大会话，取前 30 条裁剪驱动），模拟完整点击序列，
// 断言任意时刻 LLM Input 块数量恒为 1。

import { describe, it, expect, vi, beforeAll } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import fs from 'node:fs'
import path from 'node:path'

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('framework=opencode'),
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, refresh: () => {} }),
}))

const DATA = path.resolve(__dirname, 'data', 'session-turn-accumulate')
const TASK_ID = 'ses_066d0d8aaffegJAFUjUGyxKm8z'

let sessionJson: object
let turnsFull: object
let turnsPlain: object
let executions: object
let bridges: object
let turnDetails: Record<string, object>

function readJson(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf-8'))
}

function firstN(items: Array<Record<string, unknown>>, n: number) {
  return items.slice(0, n)
}

beforeAll(async () => {
  sessionJson = readJson('session.json') as object
  const full = JSON.parse(fs.readFileSync(path.join(DATA, 'turns-full.json'), 'utf-8'))
  const plain = JSON.parse(fs.readFileSync(path.join(DATA, 'turns-plain.json'), 'utf-8'))
  executions = JSON.parse(fs.readFileSync(path.join(DATA, 'executions.json'), 'utf-8'))
  bridges = JSON.parse(fs.readFileSync(path.join(DATA, 'bridges.json'), 'utf-8'))
  // 裁剪：保留前 30 条（含用户点击的 #2/#3/#4），保持 shapes 原样
  turnsFull = { items: firstN(full.items ?? [], 30) }
  turnsPlain = { items: firstN(plain.items ?? [], 30) }
  turnDetails = {
    cmtjqe81lgy49hk5: JSON.parse(fs.readFileSync(path.join(DATA, 'turn-2.json'), 'utf-8')),
    cmtjqe81lzl9xsf7: JSON.parse(fs.readFileSync(path.join(DATA, 'turn-3.json'), 'utf-8')),
    cmtjqe81lc6kb4xa: JSON.parse(fs.readFileSync(path.join(DATA, 'turn-4.json'), 'utf-8')),
  }
})

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function installFetchRouter(): void {
  const origFetch = globalThis.fetch
  ;(globalThis as { fetch: typeof fetch }).fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const detail = url.match(/\/api\/observe\/session\/turns\/([^?]+)/)
    if (detail) {
      const d = turnDetails[detail[1]]
      if (d) return Promise.resolve(jsonResponse(d))
      return Promise.resolve(new Response('{}', { status: 404 }))
    }
    if (url.includes('/api/observe/session/turns') && url.includes('includeToolDetail=true')) {
      return Promise.resolve(jsonResponse(turnsFull))
    }
    if (url.includes('/api/observe/session/turns')) return Promise.resolve(jsonResponse(turnsPlain))
    if (url.includes('/api/observe/session?')) return Promise.resolve(jsonResponse(sessionJson))
    if (url.includes('/api/observe/session/bridges')) return Promise.resolve(jsonResponse(bridges))
    if (url.includes('/api/observe/executions')) return Promise.resolve(jsonResponse(executions))
    if (url.includes('/auto-refresh')) return Promise.resolve(jsonResponse({ settled: false }))
    // keep-mounted 各 tab 挂载即拉数据（hidden 也在 DOM）——真实端点响应回放
    if (url.includes('/wire-rounds')) return Promise.resolve(jsonResponse(readJson('wire-rounds.json')))
    if (url.includes('/file-reads')) return Promise.resolve(jsonResponse(readJson('file-reads.json')))
    if (url.includes('/llm-workflow-extract')) return Promise.resolve(jsonResponse(readJson('llm-workflow-extract.json')))
    if (url.includes('/skill-coverage')) return Promise.resolve(jsonResponse(readJson('skill-coverage.json')))
    if (url.includes('/session/workflow')) return Promise.resolve(jsonResponse(readJson('workflow.json')))
    if (url.includes('/context-windows')) return Promise.resolve(jsonResponse(readJson('context-windows.json')))
    if (url.includes('/api/')) return Promise.resolve(jsonResponse({}))
    return origFetch(input as RequestInfo)
  }) as typeof fetch
}

function makeFulfilledThenable<T>(value: T): Promise<T> {
  const thenable = {
    status: 'fulfilled' as const,
    value,
    then(onFulfilled?: (v: T) => unknown) {
      if (typeof onFulfilled === 'function') Promise.resolve(value).then(onFulfilled)
      return this
    },
  }
  return thenable as unknown as Promise<T>
}

/** 统计"活"的块标题（叶子 span 文本恰为 title） */
function countBlocks(root: HTMLElement, title: string): number {
  let n = 0
  for (const el of root.querySelectorAll('span')) {
    if (el.children.length === 0 && el.textContent?.trim() === title) n++
  }
  return n
}

function findTurnRow(root: HTMLElement, index: number): HTMLButtonElement | null {
  for (const btn of root.querySelectorAll('button')) {
    const first = btn.querySelector('span')
    if (first?.textContent?.trim() === `#${index}`) return btn as HTMLButtonElement
  }
  return null
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })
  }
}

describe('session 页 Turns 交互：LLM Input 块不随点击累积（客户现场回归）', () => {
  it('点击 #2→#3→#4→#2，任意时刻 LLM Input 块数量恒为 1', async () => {
    installFetchRouter()
    const { default: SessionPage } = await import('@/app/session/[taskId]/page')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)

    await act(async () => {
      root.render(createElement(SessionPage, { params: makeFulfilledThenable({ taskId: TASK_ID }) } as never))
    })
    await flush()

    // 切到 Turns tab
    const turnsTab = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('Turns'))
    expect(turnsTab, 'Turns tab 按钮未找到').toBeTruthy()
    await act(async () => { turnsTab!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()

    const seq = [2, 3, 4, 2]
    const inputCounts: number[] = []
    const outputCounts: number[] = []
    for (const idx of seq) {
      const row = findTurnRow(container, idx)
      expect(row, `#${idx} 时间线行未找到`).toBeTruthy()
      await act(async () => { row!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await flush()
      inputCounts.push(countBlocks(container, 'LLM Input'))
      outputCounts.push(countBlocks(container, 'LLM Output'))
    }
    // 任意时刻 Input/Output 各恰一块（修复前：Input 随点击累积 1→2→3→4，
    // 旧块是 React 丢失的孤儿 DOM 无事件响应 —— duplicate sibling key 所致）
    expect(inputCounts).toEqual([1, 1, 1, 1])
    expect(outputCounts).toEqual([1, 1, 1, 1])
    // 详情真实加载（非空壳）：选中 #2 后用户消息可数
    expect(container.querySelector('#turn-detail-top')).toBeTruthy()

    root.unmount()
    container.remove()
  }, 120_000)
})
