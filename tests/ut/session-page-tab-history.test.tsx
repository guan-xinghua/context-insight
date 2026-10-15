// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. Do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom
// 交互级 IT（视图导航语义）：会话页整体只占一条浏览器历史——切 tab / 跨 tab
// 跳转一律 router.replace（URL 原位更新，地址栏仍反映当前视图，深链/刷新/
// 分享不变），push 全程为零 → Back（页内按钮与浏览器返回键）直接回到上一个
// 大页面，而非在 tab 间逐级回退。tab 内选中走纯 state（URL 不动，选中态权威
// 在用户）；页面级 forward/back（popstate 换 URL 重渲染）的 URL→视图恢复
// 能力保留。本用例回放真实 session 页面组件全链验证。

import { describe, it, expect, vi, beforeAll } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import fs from 'node:fs'
import path from 'node:path'

// 可变 URL 状态：router.replace 记账 + 更新当前 URL（地址栏镜像）；测试模拟
// popstate 时直接改 currentUrl 再重渲染（Next 在 history 变化后正是以新
// searchParams 重渲染）。pushCalls 必须全程为空——这是「back 直出会话页」
// 的核心断言。
let currentUrl = '?framework=opencode'
const pushCalls: string[] = []
const replaceCalls: string[] = []
let backCalls = 0

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(currentUrl),
  useRouter: () => ({
    push: (u: string) => { pushCalls.push(u); currentUrl = u },
    replace: (u: string) => { replaceCalls.push(u); currentUrl = u },
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
let rootTurns: Array<{ turnId: string; turnIndex: number }>

function readJson(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf-8'))
}

beforeAll(async () => {
  sessionJson = readJson('session.json') as object
  const plain = JSON.parse(fs.readFileSync(path.join(DATA, 'turns-plain.json'), 'utf-8'))
  executions = JSON.parse(fs.readFileSync(path.join(DATA, 'executions.json'), 'utf-8'))
  bridges = JSON.parse(fs.readFileSync(path.join(DATA, 'bridges.json'), 'utf-8'))
  turnsPlain = { items: (plain.items ?? []).slice(0, 30) }
  rootTurns = ((plain.items ?? []) as Array<{ turnId: string; turnIndex: number; isSubagent?: boolean }>)
    .filter(t => !t.isSubagent)
})

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function installFetchRouter(): void {
  const origFetch = globalThis.fetch
  ;(globalThis as { fetch: typeof fetch }).fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('/api/observe/session/turns?')) return Promise.resolve(jsonResponse(turnsPlain))
    if (url.includes('/api/observe/session/turns/')) {
      const id = decodeURIComponent(url.split('/turns/')[1] ?? '')
      const t = ((turnsPlain as { items: Array<{ turnId: string }> }).items).find(x => x.turnId === id)
      return Promise.resolve(jsonResponse({ ...t, toolCalls: [], skillEvents: [] }))
    }
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

function findTurnRow(root: HTMLElement, turnIndex: number): HTMLButtonElement | null {
  for (const btn of root.querySelectorAll('button')) {
    const m = btn.textContent?.trim().match(/^#(\d+)\b/)
    if (m && Number(m[1]) === turnIndex) return btn as HTMLButtonElement
  }
  return null
}

const isActive = (btn: HTMLButtonElement | null): boolean =>
  !!btn && btn.className.includes('border-primary')

const isSel = (btn: HTMLButtonElement | null): boolean => !!btn && btn.className.includes('ring-2')

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })
  }
}

describe('session 页视图导航：会话页单条 history，Back 直回上个大页面', () => {
  it('深链直达 → 切 tab/跨 tab 跳转全 replace 零 push → tab 内选中不动 URL → popstate 恢复 → Back 走 router.back', async () => {
    installFetchRouter()
    const { default: SessionPage } = await import('@/app/session/[taskId]/page')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    const render = () => act(async () => {
      root.render(createElement(SessionPage, { params: makeFulfilledThenable({ taskId: TASK_ID }) } as never))
    })
    const turnA = rootTurns[0]
    const turnB = rootTurns[1]
    expect(turnA && turnB, 'fixture 需要至少 2 个 root 轮').toBeTruthy()

    // ① 深链：?tab=turns 直达（URL → 视图）
    currentUrl = '?framework=opencode&tab=turns'
    await render()
    await flush()
    expect(isActive(findTabButton(container, 'Turns')), '深链应直达 Turns tab').toBe(true)

    // ② 点 Trace tab：URL 原位 replace（地址栏反映当前视图），push 全程为零
    const traceTab = findTabButton(container, 'Trace')
    expect(traceTab, 'Trace tab 按钮未找到').toBeTruthy()
    await act(async () => { traceTab!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()
    expect(isActive(findTabButton(container, 'Trace'))).toBe(true)
    expect(replaceCalls.at(-1)).toBe('?framework=opencode&tab=trace')
    expect(pushCalls, '切 tab 不得压 history——Back 必须直出会话页').toEqual([])

    // ③ 再点 Context：连续切 tab 仍只有 replace，不累积 history 条目
    const ctxTab = findTabButton(container, 'Context')
    expect(ctxTab, 'Context tab 按钮未找到').toBeTruthy()
    await act(async () => { ctxTab!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()
    expect(isActive(findTabButton(container, 'Context'))).toBe(true)
    expect(replaceCalls.at(-1)).toBe('?framework=opencode&tab=context')
    expect(pushCalls).toEqual([])

    // ④ errorTurn 深链（Overview 错误卡入口）：数据就绪后跳 turns 并定位，
    //    URL 订正为真实视图（?tab=turns&turn= 经 replace 写入），push 仍零
    currentUrl = `?framework=opencode&errorTurn=${turnA.turnIndex}`
    await render()
    await flush()
    expect(isActive(findTabButton(container, 'Turns')), 'errorTurn 深链应落到 Turns tab').toBe(true)
    expect(isSel(findTurnRow(container, turnA.turnIndex)), 'errorTurn 深链应选中目标轮').toBe(true)
    const expectedUrl = new URLSearchParams(`framework=opencode&errorTurn=${turnA.turnIndex}`)
    expectedUrl.set('tab', 'turns')
    expectedUrl.set('turn', turnA.turnId)
    expect(replaceCalls.at(-1), '跳转应把地址栏订正为当前视图（replace）').toBe(`?${expectedUrl.toString()}`)
    expect(pushCalls).toEqual([])
    const replaceCountAfterJump = replaceCalls.length

    // ⑤ tab 内选中（时间线点轮）：纯 state，URL 不动、不新增 replace——
    //    选中态权威在用户，深链旧值不被弹写
    const rowB = findTurnRow(container, turnB.turnIndex)
    expect(rowB, 'B 轮行未找到').toBeTruthy()
    await act(async () => { rowB!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()
    expect(isSel(findTurnRow(container, turnB.turnIndex)), '手动应选中 B 轮').toBe(true)
    expect(isSel(findTurnRow(container, turnA.turnIndex))).toBe(false)
    expect(replaceCalls.length, 'tab 内选中不得写 URL').toBe(replaceCountAfterJump)

    // ⑥ 模拟页面级 popstate（forward/back 回会话页）：换 URL 重渲染 →
    //    视图随 URL 恢复（能力保留，供页面级前进/后退）
    currentUrl = '?framework=opencode&tab=trace'
    await render()
    await flush()
    expect(isActive(findTabButton(container, 'Trace')), 'URL 恢复应回到 Trace tab').toBe(true)

    // ⑦ 界面 Back 按钮走 router.back()（history 单条，回上一个大页面），
    //    而非硬跳首页
    const uiBack = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Back')
    expect(uiBack, '界面 Back 按钮未找到').toBeTruthy()
    const backBefore = backCalls
    await act(async () => { uiBack!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(backCalls).toBe(backBefore + 1)
    expect(pushCalls, 'Back 不得经 push 硬跳').toEqual([])

    root.unmount()
    container.remove()
  }, 120_000)
})
