// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom
// 回归 IT（?turn= 深链弹回）：深链选中 A 轮 → 手动选 B 轮 → 5s 自动同步（poll
// → refresh-session → loadAllData → setTurns）刷新 turns 后，选中态不得弹回
// URL 里的 A 轮（修复前 effect 依赖含 turns，每次同步重放 URL 旧轮）；换一个
// turn 深链（值变化）仍要重新应用。真实组件 + 真实 poll 链路回放。

import { describe, it, expect, vi, beforeAll } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import fs from 'node:fs'
import path from 'node:path'

let currentUrl = '?framework=opencode'
const fetchLog: string[] = []
let autoRefreshCalls = 0
let turnsPayload: { items: Array<Record<string, unknown>> }

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(currentUrl),
  useRouter: () => ({
    push: (u: string) => { currentUrl = u },
    replace: () => {},
    back: () => {},
    refresh: () => {},
  }),
}))

const DATA = path.resolve(__dirname, 'data', 'session-turn-accumulate')
const TASK_ID = 'ses_066d0d8aaffegJAFUjUGyxKm8z'

interface FixtureTurn {
  turnId: string
  turnIndex: number
  role: string
  isSubagent?: boolean
  contentSummary?: string
  [k: string]: unknown
}

let sessionJson: object
let executions: object
let bridges: object

function readJson(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf-8'))
}

beforeAll(() => {
  sessionJson = readJson('session.json') as object
  executions = JSON.parse(fs.readFileSync(path.join(DATA, 'executions.json'), 'utf-8'))
  bridges = JSON.parse(fs.readFileSync(path.join(DATA, 'bridges.json'), 'utf-8'))
  const plain = JSON.parse(fs.readFileSync(path.join(DATA, 'turns-plain.json'), 'utf-8'))
  turnsPayload = { items: (plain.items ?? []).slice(0, 30) }
})

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function installFetchRouter(): void {
  const origFetch = globalThis.fetch
  ;(globalThis as { fetch: typeof fetch }).fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    fetchLog.push(url)
    if (url.includes('/api/ingest/refresh-session')) return Promise.resolve(jsonResponse({ addedTurns: 1 }))
    if (url.includes('/api/observe/auto-refresh')) {
      autoRefreshCalls += 1
      // 首轮 init（记录基线 maxTimeUpdated），次轮 timeChanged+countChanged 触发 refresh
      return Promise.resolve(jsonResponse(autoRefreshCalls === 1
        ? { settled: true, maxTimeUpdated: 100 }
        : { settled: true, maxTimeUpdated: 200, countChanged: true }))
    }
    if (url.includes('/api/observe/session/turns?')) return Promise.resolve(jsonResponse(turnsPayload))
    if (url.includes('/api/observe/session/turns/')) {
      const id = decodeURIComponent(url.split('/turns/')[1] ?? '')
      const t = (turnsPayload.items as unknown as FixtureTurn[]).find(x => x.turnId === id)
      return Promise.resolve(jsonResponse({ ...t, toolCalls: [], skillEvents: [] }))
    }
    if (url.includes('/api/observe/session?')) return Promise.resolve(jsonResponse(sessionJson))
    if (url.includes('/api/observe/session/bridges')) return Promise.resolve(jsonResponse(bridges))
    if (url.includes('/api/observe/executions')) return Promise.resolve(jsonResponse(executions))
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

function findTurnRow(root: HTMLElement, turnIndex: number): HTMLButtonElement | null {
  for (const btn of root.querySelectorAll('button')) {
    const m = btn.textContent?.trim().match(/^#(\d+)\b/)
    if (m && Number(m[1]) === turnIndex) return btn as HTMLButtonElement
  }
  return null
}

const isSel = (btn: HTMLButtonElement | null): boolean => !!btn && btn.className.includes('ring-2')

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })
  }
}

describe('session 页 ?turn= 深链不随自动同步弹回（选中态权威在用户）', () => {
  it('深链选中 A → 手动选 B → 自动同步 setTurns 后仍停在 B；换深链到 C 重新应用', async () => {
    installFetchRouter()
    const { default: SessionPage } = await import('@/app/session/[taskId]/page')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    const render = () => act(async () => {
      root.render(createElement(SessionPage, { params: makeFulfilledThenable({ taskId: TASK_ID }) } as never))
    })

    // 挑三个可展示的 root 轮（排除命令/续写类展示折叠，取普通 assistant 轮）
    const items = turnsPayload.items as unknown as FixtureTurn[]
    const candidates = items.filter(t => !t.isSubagent && t.role === 'assistant'
      && !/^(<|compact|continue|resume)/i.test((t.contentSummary ?? '').trim()))
    const [turnA, turnB, turnC] = candidates
    expect(turnA && turnB && turnC, 'fixture 需要至少 3 个 root assistant 轮').toBeTruthy()
    // 自动同步后追加的「新轮」（证明 setTurns 真实发生）
    const extraTurn: FixtureTurn = { ...candidates[candidates.length - 1]!, turnId: 'turn-extra-9999', turnIndex: 999_999 }

    // ① 深链 ?turn=A → 选中 A
    currentUrl = `?framework=opencode&tab=turns&turn=${turnA.turnId}`
    await render()
    await flush()
    expect(isSel(findTurnRow(container, turnA.turnIndex)), '深链应选中 A 轮').toBe(true)

    // ② 手动选 B（用户选中态覆盖深链）
    const rowB = findTurnRow(container, turnB.turnIndex)
    expect(rowB, 'B 轮行未找到').toBeTruthy()
    await act(async () => { rowB!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()
    expect(isSel(findTurnRow(container, turnB.turnIndex)), '手动应选中 B 轮').toBe(true)
    expect(isSel(findTurnRow(container, turnA.turnIndex))).toBe(false)

    // ③ 等真实 poll 链路（5s interval：首轮 init，次轮触发 refresh →
    //    loadAllData → setTurns 换新数组）——修复前 effect 重放 ?turn=A 弹回
    turnsPayload = { items: [...items, extraTurn] }
    await act(async () => { await new Promise(r => setTimeout(r, 11_000)) })
    await flush()
    expect(fetchLog.some(u => u.includes('/api/ingest/refresh-session')), '自动同步链路应已触发').toBe(true)
    expect(findTurnRow(container, extraTurn.turnIndex), '新轮应已入列（setTurns 确实发生）').toBeTruthy()
    expect(isSel(findTurnRow(container, turnB.turnIndex)), '同步刷新后选中不应弹回 ?turn= 旧轮 A').toBe(true)
    expect(isSel(findTurnRow(container, turnA.turnIndex))).toBe(false)

    // ④ 换一个 turn 深链（URL 值变化，popstate 形态）→ 重新应用
    currentUrl = `?framework=opencode&tab=turns&turn=${turnC.turnId}`
    await render()
    await flush()
    expect(isSel(findTurnRow(container, turnC.turnIndex)), '新 turn 深链应重新应用').toBe(true)

    root.unmount()
    container.remove()
  }, 120_000)
})
