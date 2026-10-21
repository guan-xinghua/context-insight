// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// Perf TopDown「含 root」勾选生效 IT：
//   ① 勾选后主 agent 的 assistant 轮聚合为一行参与 Top 排序——无子代理的会话
//      也能看到主 agent 的 turn 排序（此前 TopDown 只认子代理，纯主会话整节隐藏）
//   ② 聚合口径与性能效率序列一致：剔 compaction/continuation 轮、派发轮、
//      非 assistant 轮（user 轮即使 latencyMs>0 也不进排序）
//   ③ 展开主 agent 行 → turn 按 TIME 降序，点击行回调 onJumpToTurn(turnIndex)
//   ④ 默认不勾选：有子代理时 TopDown 只有子代理行，无「主 agent」行
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { PerfPanorama } from '@/components/observe/PerfPanorama'
import type { TurnPerf } from '@/components/observe/perf-shared'

let root: Root | null = null
let container: HTMLElement | null = null

afterEach(() => {
  vi.unstubAllGlobals()
  if (root) { act(() => { root!.unmount() }) }
  container?.remove()
  root = null
  container = null
})

function turn(over: Partial<TurnPerf> & Pick<TurnPerf, 'turnId' | 'turnIndex'>): TurnPerf {
  return {
    role: 'assistant', agentName: null, isSubagent: false,
    subagentName: null, subagentSessionId: null, subagentType: null, dispatchStep: null,
    contentSummary: null, createdAt: '2026-09-15T10:01:00Z',
    totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, contextWindowPct: null,
    latencyMs: 0, model: 'glm-5.3', toolCalls: [],
    ...over,
  }
}

const ROOT_EXEC = {
  executionId: 'exec-root', agentName: 'main', isSubagent: false, subagentName: null,
  agentSessionId: null, depth: 0,
  tokens: 2850, inputTokens: 1000, outputTokens: 380, reasoningTokens: 120,
  cacheReadInputTokens: 1300, cacheCreationInputTokens: 50, cost: 0,
  latencyMs: 15_000, toolCallCount: 2, toolCallErrorCount: 0, llmCallCount: 2,
  model: 'glm-5.3', createdAt: '2026-09-15T10:00:00Z',
}

const SUB_EXEC = {
  executionId: 'exec-sub-1', agentName: 'general', isSubagent: true, subagentName: '探索',
  agentSessionId: 'ses_sub_root_1', depth: 1,
  tokens: 5000, inputTokens: 4000, outputTokens: 800, reasoningTokens: 200,
  cacheReadInputTokens: 3000, cacheCreationInputTokens: 0, cost: 0,
  latencyMs: 120_000, toolCallCount: 2, toolCallErrorCount: 0, llmCallCount: 3,
  model: 'glm-5.3', createdAt: '2026-09-15T10:00:00Z',
}

/** 渲染 PerfPanorama 并 stub 三个数据接口 */
async function renderPerf(items: { exec: unknown[]; turns: unknown[]; bridges: unknown[] }, onJumpToTurn?: (n: number) => void) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const json = (data: unknown) => Promise.resolve(new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } }))
    if (url.includes('/api/observe/executions')) return json({ items: items.exec })
    if (url.includes('/api/observe/session/turns')) return json({ items: items.turns })
    if (url.includes('/api/observe/session/bridges')) return json({ items: items.bridges })
    return json({})
  }))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(PerfPanorama, { taskId: 'perf-topdown-root', onJumpToTurn }))
  })
  await act(async () => { })
}

/** 主 agent 行内的展开箭头（role=button 的 ▶ span） */
function rootRowToggle(): HTMLElement | null {
  return [...container!.querySelectorAll<HTMLElement>('[role="button"]')]
    .find(el => (el.textContent ?? '').trim() === '▶' &&
      (el.parentElement?.textContent ?? '').includes('主 agent')) ?? null
}

/** 展开后 drill-down 的 turn 序号（font-mono 的 #N span） */
function drillTurnIndexes(): number[] {
  const out: number[] = []
  for (const s of container!.querySelectorAll('span.font-mono')) {
    const m = /^#(\d+)$/.exec(s.textContent ?? '')
    if (m) out.push(Number(m[1]))
  }
  return out
}

describe('Perf TopDown 含 root', () => {
  it('无子代理会话：勾选后主 agent 行出现，口径剔除非推理轮，drill-down 可跳转', async () => {
    const jumps: number[] = []
    await renderPerf({
      exec: [ROOT_EXEC],
      turns: [
        // user 轮 latencyMs>0：role 过滤剔出，不得进主 agent 统计
        turn({ turnId: 'tu0', turnIndex: 0, role: 'user', latencyMs: 5000 }),
        turn({ turnId: 'tr1', turnIndex: 1, latencyMs: 10_000, totalTokens: 1950, inputTokens: 600, outputTokens: 300, reasoningTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 50 }),
        // 派发轮：bridges.dispatchTurnId 命中 → 剔出
        turn({ turnId: 'td2', turnIndex: 2, latencyMs: 7777 }),
        turn({ turnId: 'tr3', turnIndex: 3, latencyMs: 5000, totalTokens: 900, inputTokens: 400, outputTokens: 80, reasoningTokens: 20, cacheReadTokens: 400 }),
        // compaction 轮 → 剔出
        turn({ turnId: 'tc4', turnIndex: 4, agentName: 'compaction', latencyMs: 88_888 }),
      ],
      bridges: [{
        bridgeId: 'b1', dispatchTurnId: 'td2', dispatchContent: '去做调研',
        subagentSessionId: 'ses_sub_root_1', subagentName: null,
        subagentLatencyMs: 0, subagentTokens: 0,
      }],
    }, n => jumps.push(n))

    // 默认不勾选：TopDown 整节隐藏（无子代理）
    expect(container!.textContent).not.toContain('Perf TopDown')
    expect(container!.textContent).toContain('暂无子代理 execution 数据')

    // 空态引导按钮 → 勾选「含 root」
    const btn = [...container!.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').includes('含 root'))
    expect(btn).toBeTruthy()
    await act(async () => { btn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })

    // ① 主 agent 行出现；表头切到 AGENT；合计 = 10000+5000（剔 7777/88888/5000）
    expect(container!.textContent).toContain('Perf TopDown')
    expect(container!.textContent).toContain('主 agent')
    expect(container!.textContent).toContain('AGENT')
    expect(container!.textContent).toContain('15.0s')

    // ③ 展开主 agent 行：turn 按 TIME 降序（#1 10000ms → #3 5000ms），无 #0/#2/#4
    await act(async () => { rootRowToggle()!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    expect(drillTurnIndexes()).toEqual([1, 3])

    // 点击首行（#1）→ onJumpToTurn(1)
    const row1 = [...container!.querySelectorAll('div')]
      .find(d => d.className.includes('cursor-pointer') && (d.textContent ?? '').includes('#1'))
    expect(row1).toBeTruthy()
    await act(async () => {
      row1!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(jumps).toEqual([1])
  })

  it('有子代理会话：默认只有子代理行；勾选后追加主 agent 行', async () => {
    await renderPerf({
      exec: [SUB_EXEC],
      turns: [
        turn({ turnId: 'tr1', turnIndex: 1, latencyMs: 8000, totalTokens: 900, outputTokens: 200 }),
        turn({
          turnId: 'ts2', turnIndex: 2, isSubagent: true,
          subagentSessionId: 'ses_sub_root_1', subagentName: '探索',
          latencyMs: 12_000, totalTokens: 5000,
        }),
      ],
      bridges: [],
    })

    // 默认：TopDown 只有子代理行，无「主 agent」
    expect(container!.textContent).toContain('Perf TopDown')
    expect(container!.textContent).toContain('SUBAGENT')
    expect(container!.textContent).toContain('探索')
    expect(container!.textContent).not.toContain('主 agent')

    // 勾选「含 root」→ 主 agent 行加入排序（click 走激活行为：翻转 checked 并派发 change）
    const cb = container!.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(cb).toBeTruthy()
    await act(async () => { cb.click() })
    expect(container!.textContent).toContain('主 agent')
    expect(container!.textContent).toContain('AGENT')
  })
})
