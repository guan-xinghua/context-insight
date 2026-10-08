// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software and you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom
// 交互级复现 IT（用户现场 bug）：会话页内切 tab / 评分证据跳 turn 全是纯
// React state，URL 与 browser history 不动 —— 点浏览器 back 直接退出会话页
// 回首页。修复后切 tab 经 router.push 进 history（?tab= / ?turn=），
// back/forward 由 URL 恢复视图。本用例回放真实 session 页面组件：
// 深链 ?tab= 直达、点 tab 推 URL、模拟 popstate（换 URL 重渲染）回退视图。

import { describe, it, expect, vi, beforeAll } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import fs from 'node:fs'
import path from 'node:path'

// 可变 URL 状态：router.push 记账 + 更新当前 URL；测试模拟 popstate 时
// 直接改 currentUrl 再重渲染（Next 在 history 回退后正是以新 searchParams 重渲染）
let currentUrl = '?framework=opencode'
const pushCalls: string[] = []
let backCalls = 0

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(currentUrl),
  useRouter: () => ({
    push: (u: string) => { pushCalls.push(u); currentUrl = u },
    replace: () => {},
    back: () => { backCalls++ },
    refresh: () => {},
  }),
}))

const DATA = path.resolve(__dirname, 'data', 'session-turn-accumulate')
const TASK_ID = 'ses_066d0d8aaffegJAFUjUGyxKm8z'

let sessionJson: object
let turnsPlain: object
let executions: object
let bridges: object

function readJson(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf-8'))
}

beforeAll(async () => {
  sessionJson = readJson('session.json') as object
  const plain = JSON.parse(fs.readFileSync(path.join(DATA, 'turns-plain.json'), 'utf-8'))
  executions = JSON.parse(fs.readFileSync(path.join(DATA, 'executions.json'), 'utf-8'))
  bridges = JSON.parse(fs.readFileSync(path.join(DATA, 'bridges.json'), 'utf-8'))
  turnsPlain = { items: (plain.items ?? []).slice(0, 30) }
})

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function installFetchRouter(): void {
  const origFetch = globalThis.fetch
  ;(globalThis as { fetch: typeof fetch }).fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
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

function findTabButton(root: HTMLElement, label: string): HTMLButtonElement | null {
  for (const btn of root.querySelectorAll('button')) {
    if (btn.textContent?.trim() === label) return btn as HTMLButtonElement
  }
  return null
}

const isActive = (btn: HTMLButtonElement | null): boolean =>
  !!btn && btn.className.includes('border-primary')

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })
  }
}

describe('session 页 tab 导航进 browser history（back 不再退出会话页）', () => {
  it('深链 ?tab= 直达 → 点 tab 推 URL → 模拟 back 恢复上一 tab', async () => {
    installFetchRouter()
    const { default: SessionPage } = await import('@/app/session/[taskId]/page')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    const render = () => act(async () => {
      root.render(createElement(SessionPage, { params: makeFulfilledThenable({ taskId: TASK_ID }) } as never))
    })

    // ① 深链：?tab=turns 直达（URL → state）
    currentUrl = '?framework=opencode&tab=turns'
    await render()
    await flush()
    expect(isActive(findTabButton(container, 'Turns')), '深链应直达 Turns tab').toBe(true)

    // ② 点 Trace tab：URL 进 history（state → URL）
    const traceTab = findTabButton(container, 'Trace')
    expect(traceTab, 'Trace tab 按钮未找到').toBeTruthy()
    await act(async () => { traceTab!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()
    expect(isActive(findTabButton(container, 'Trace'))).toBe(true)
    expect(pushCalls.at(-1)).toBe('?framework=opencode&tab=trace')

    // ③ 模拟浏览器 back：URL 回到 ?tab=turns，以新 searchParams 重渲染
    //   （Next popstate 后的行为）→ 视图恢复 Turns，而非退出会话页
    currentUrl = '?framework=opencode&tab=turns'
    await render()
    await flush()
    expect(isActive(findTabButton(container, 'Turns')), 'back 后应回到 Turns tab').toBe(true)
    expect(isActive(findTabButton(container, 'Trace'))).toBe(false)

    // ④ 再 back 到无 ?tab 的初始 URL → 回落 Overview（修复前：state 不变，
    //    back 直接离开 /session/<taskId> 回首页）
    currentUrl = '?framework=opencode'
    await render()
    await flush()
    expect(isActive(findTabButton(container, 'Overview')), 'back 到无 tab URL 应回落 Overview').toBe(true)

    // ⑤ 界面 Back 按钮走 router.back()（进 history），而非硬跳首页
    //   （修复前：window.location.href="/" —— score→turn 后点 Back 必回首页）
    const uiBack = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Back')
    expect(uiBack, '界面 Back 按钮未找到').toBeTruthy()
    const backBefore = backCalls
    await act(async () => { uiBack!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(backCalls).toBe(backBefore + 1)
    expect(pushCalls.map(c => c === '/' ? '/' : null).filter(Boolean)).toEqual([])

    root.unmount()
    container.remove()
  }, 120_000)
})
