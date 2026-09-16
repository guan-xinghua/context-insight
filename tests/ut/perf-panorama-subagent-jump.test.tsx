// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License).
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// Perf 页柱子（subagent 执行段）↔ Turns 页对应 IT：
//   ① 柱子/横轴标签带 <title>（subagent 名 + 明细 + 跳转提示）——横轴原本
//      只有 #N 序号，56 根柱子无法与 Turns 的 subagent 对应
//   ② 点击柱子 → onJumpToSubagent(agentSessionId)，page 侧定位该 subagent
//      首个 turn 并高亮 lane
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { PerfPanorama } from '@/components/observe/PerfPanorama'

let root: Root | null = null
let container: HTMLElement | null = null

afterEach(() => {
  vi.unstubAllGlobals()
  if (root) { act(() => { root!.unmount() }) }
  container?.remove()
  root = null
  container = null
})

const SUB_EXEC = {
  executionId: 'exec-sub-1',
  agentName: 'general',
  isSubagent: true,
  subagentName: '探索',
  agentSessionId: 'ses_sub_jump_1',
  depth: 1,
  tokens: 5000,
  inputTokens: 4000,
  outputTokens: 800,
  reasoningTokens: 200,
  cacheReadInputTokens: 3000,
  cacheCreationInputTokens: 0,
  cost: 0,
  latencyMs: 120_000,
  toolCallCount: 2,
  toolCallErrorCount: 0,
  llmCallCount: 3,
  model: 'glm-5.3',
  createdAt: '2026-09-15T10:00:00Z',
}

describe('PerfPanorama subagent 柱子 → Turns 对应', () => {
  it('柱子带 title（名字+明细+提示）；点击触发 onJumpToSubagent(agentSessionId)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const json = (data: unknown) => Promise.resolve(new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } }))
      if (url.includes('/api/observe/executions')) return json({ items: [SUB_EXEC] })
      if (url.includes('/api/observe/session/turns')) return json({ items: [] })
      if (url.includes('/api/observe/session/bridges')) return json({ items: [] })
      return json({})
    }))

    const jumped: string[] = []
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(createElement(PerfPanorama, {
        taskId: 'perf-jump-test',
        onJumpToSubagent: (sid) => { jumped.push(sid) },
      }))
    })
    await act(async () => { })

    // ① Duration 图柱子的 title：subagent 名 + 跳转提示
    const titles = [...container.querySelectorAll('svg title')].map(t => t.textContent ?? '')
    const barTitle = titles.find(t => t.includes('探索') && t.includes('点击跳转'))
    expect(barTitle).toBeTruthy()
    expect(barTitle).toContain('general')

    // ② 点击柱子 → 回调带 agentSessionId
    const barGroup = [...container.querySelectorAll('svg g')].find(g => {
      const t = g.querySelector('title')
      return t?.textContent?.includes('探索') && (t.textContent?.includes('总耗时') || t.textContent?.includes('tokens'))
    })
    expect(barGroup).toBeTruthy()
    await act(async () => {
      barGroup!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(jumped).toEqual(['ses_sub_jump_1'])
  })
})
