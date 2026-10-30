// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom
// IT（LLM 提取轮询语义）：「重试」的 restart=1 只随首发请求，轮询不带——
// 否则每次轮询都会重启服务端已失败的 job，且每次都恰好拿到重启瞬间的 loading:true，
// 失败态永远轮不到：UI 无限「提取中…」、服务端每 5s 重 spawn claude CLI（本用例锁的就是
// 这个回归：提取失败时应停在失败态展示「重试」，而非无限轮询）。

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

const { SkillDetail } = await import('@/components/observe/SkillDetail')

/** llm-workflow-extract 请求的 URL 流水（断言 restart 参数逐次取值）。 */
const extractUrls: string[] = []
/** 脚本化响应队列：每个 llm-workflow-extract 请求弹出一个。 */
const extractQueue: Array<Record<string, unknown>> = []

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

const origFetch = globalThis.fetch

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;(globalThis as { fetch: typeof fetch }).fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('/llm-workflow-extract')) {
      extractUrls.push(url)
      return Promise.resolve(jsonResponse(extractQueue.shift() ?? { loading: false, error: 'no scripted response' }))
    }
    // 其余端点（skill-content / skill-coverage 等）一律空 200，不影响本用例语义
    return Promise.resolve(jsonResponse({}))
  }) as typeof fetch
  vi.useFakeTimers()
})

afterAll(() => {
  vi.useRealTimers()
  ;(globalThis as { fetch: typeof fetch }).fetch = origFetch
})

/** 微任务冲刷（fake timers 下不能用真实 setTimeout 等待——用 0ms 异步推进）。 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  }
}

/** 轮询节奏推进：5s 定时器到期 + 其间微任务（fetch 链）一并冲刷。 */
async function advancePollCycle(): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  await flushMicrotasks()
}

function findExtractButton(root: HTMLElement): HTMLElement | null {
  for (const el of root.querySelectorAll('[role="button"]')) {
    const t = el.textContent?.trim()
    if (t === '提取' || t === '重试') return el as HTMLElement
  }
  return null
}

function findLlmRow(root: HTMLElement): HTMLElement | null {
  for (const span of root.querySelectorAll('span')) {
    if (span.textContent?.includes('workflow（LLM提取）')) return span.closest('tr') as HTMLElement
  }
  return null
}

describe('SkillDetail LLM 提取轮询：restart=1 只随首发请求', () => {
  it('提取失败 → 重试首发达 restart=1，后续轮询 restart=0，settle 后轮询停止于失败态', async () => {
    // 响应脚本：首发 loading → 失败（CLI ENOENT）→ [点重试] 重启 loading → 再失败
    const cliError = 'claude CLI 启动失败（/usr/local/bin/claude）：spawn ENOENT'
    extractQueue.push(
      { loading: true, content: null, source: null, error: null },
      { loading: false, content: null, source: null, error: cliError },
      { loading: true, content: null, source: null, error: null },
      { loading: false, content: null, source: null, error: cliError },
    )

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root: Root = createRoot(host)
    await act(async () => {
      root.render(createElement(SkillDetail, {
        taskId: 'ses-poll-test',
        // 最小一行 skill：空表会让组件提前 return「No skill data」，llm 行不渲染
        sessionSkills: [{ skillName: 'demo-skill', version: 1, invocationCount: 1 }],
        skillEvents: [],
        onAuditSkill: () => {},
        framework: 'claude-code',
      }))
    })
    await flushMicrotasks()

    expect(findLlmRow(host)).toBeTruthy()
    const btn = findExtractButton(host)
    expect(btn?.textContent?.trim()).toBe('提取')

    // ① 首点「提取」：restart=0 启动 job → 轮询到失败态
    await act(async () => { btn?.click() })
    await flushMicrotasks()
    await advancePollCycle()
    expect(extractUrls).toHaveLength(2)
    expect(extractUrls[0]).toContain('restart=0')
    expect(extractUrls[1]).toContain('restart=0')
    // 失败态可见：按钮变「重试」、错误提示挂在 title 上
    const retryBtn = findExtractButton(host)
    expect(retryBtn?.textContent?.trim()).toBe('重试')
    expect(retryBtn?.getAttribute('title')).toContain(cliError)

    // ② 点「重试」：首发带 restart=1（重启服务端失败 job）
    await act(async () => { retryBtn?.click() })
    await flushMicrotasks()
    expect(extractUrls).toHaveLength(3)
    expect(extractUrls[2]).toContain('restart=1')

    // ③ 后续轮询：必须 restart=0（回归点：此前固定 restart=1 → 无限重启死循环）
    await advancePollCycle()
    expect(extractUrls).toHaveLength(4)
    expect(extractUrls[3]).not.toContain('restart=1')
    expect(extractUrls[3]).toContain('restart=0')
    // settle 于失败态：仍展示「重试」，而非「提取中…」
    const finalBtn = findExtractButton(host)
    expect(finalBtn?.textContent?.trim()).toBe('重试')

    // ④ 轮询已停：再推进 2 个周期无新请求
    await advancePollCycle()
    await advancePollCycle()
    expect(extractUrls).toHaveLength(4)

    await act(async () => { root.unmount() })
    host.remove()
  })
})
