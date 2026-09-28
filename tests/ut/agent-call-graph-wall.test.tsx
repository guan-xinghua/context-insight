// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// Overview 泳道条宽口径 IT：一根条子 = 该 agent 的「turns 跨度」。
// - 后端给了 span（首条 turn 的 createdAt_ts → 末条 turn 的 completedAt）：用 span。
// - 没给（存量/回退）：用 createdAt + latencyMs。
// 历史首口径是直接用 Execution.latencyMs——现场 subagent 跑数分钟、4.8M tokens，
// 泳道只显示首轮的 5.1s；现改由后端 span 兜住（不再是 start→next 切片）。
import { describe, it, expect, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { AgentCallGraph } from '@/components/observe/AgentCallGraph'

let root: Root | null = null
let container: HTMLElement | null = null

afterEach(() => {
  if (root) act(() => { root!.unmount() })
  container?.remove()
  root = null
  container = null
})

function mkAgent(over: {
  executionId: string
  createdAt: string
  latencyMs: number
  isSubagent?: boolean
  agentSessionId?: string
  agentName?: string
  span?: { start: number; end: number } | null
}) {
  return {
    executionId: over.executionId,
    agentName: over.agentName ?? 'general',
    agentSessionId: over.agentSessionId ?? null,
    isSubagent: over.isSubagent ?? true,
    parentExecutionId: null,
    tokens: 1000,
    maxSingleCallTokens: 500,
    cost: 0,
    toolCallCount: 3,
    skillLoadCount: 0,
    model: 'glm-5.3',
    createdAt: over.createdAt,
    latencyMs: over.latencyMs,
    span: over.span ?? null,
    firstPrompt: null,
  }
}

const T0 = '2026-09-15T21:34:48.000Z'
const T = (offsetMs: number) => new Date(Date.parse(T0) + offsetMs).toISOString()

async function renderGraph(agents: ReturnType<typeof mkAgent>[]) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(AgentCallGraph, { agents, bridges: [], onViewTurns: () => {} }))
  })
  return container
}

describe('AgentCallGraph 泳道条宽 = span（缺省回落 latencyMs）', () => {
  it('有 span 用 span；无 span 回落 createdAt+latencyMs', async () => {
    const agents = [
      mkAgent({ executionId: 'root', createdAt: T0, latencyMs: 5_000, isSubagent: false, agentName: 'build' }),
      // sub1：span 横跨 60s，但 latencyMs 只有 5.1s —— 条宽必须按 span 画
      mkAgent({
        executionId: 'sub1', createdAt: T(10_000), latencyMs: 5_100, agentSessionId: 'ses_g1',
        span: { start: Date.parse(T0) + 10_000, end: Date.parse(T0) + 70_000 },
      }),
      mkAgent({ executionId: 'sub2', createdAt: T(70_000), latencyMs: 3_000, agentSessionId: 'ses_g2' }),
    ]
    const el = await renderGraph(agents)

    // 轴：globalStart = T0；globalEnd = max(0+10s, 10s+2s, 70s+88s, 70s+3s, span.end=70s) = 73s
    const total = 73_000
    const pct = (ms: number) => (ms / total) * 100
    const near = (got: number, want: number) => Math.abs(got - want) < 0.5
    const widthOf = (id: string) =>
      parseFloat(el.querySelector<HTMLElement>(`[data-bar="${id}"]`)!.style.width)

    expect(near(widthOf('root'), pct(5_000))).toBe(true)  // 无 span → latencyMs 5s
    expect(near(widthOf('sub1'), pct(60_000))).toBe(true) // 有 span → 60s
    expect(near(widthOf('sub1'), pct(5_100))).toBe(false) // 不再用 latencyMs 5.1s
    expect(near(widthOf('sub2'), pct(3_000))).toBe(true)  // 无 span → latencyMs 3s
  })

  it('span 把轴右端撑开：条子不越界（left + width ≤ 100%）', async () => {
    // span.end 比任何 createdAt+wallMs 都晚 → globalEnd 必须吸收 span.end
    const lateEnd = Date.parse(T0) + 200_000
    const agents = [
      mkAgent({ executionId: 'root', createdAt: T0, latencyMs: 5_000, isSubagent: false, agentName: 'build' }),
      mkAgent({
        executionId: 'sub1', createdAt: T(10_000), latencyMs: 5_100, agentSessionId: 'ses_g1',
        span: { start: Date.parse(T0) + 10_000, end: lateEnd },
      }),
    ]
    const el = await renderGraph(agents)
    const bar = el.querySelector<HTMLElement>('[data-bar="sub1"]')!
    const left = parseFloat(bar.style.left)
    const width = parseFloat(bar.style.width)
    expect(left + width).toBeLessThanOrEqual(100.001)
  })
})
