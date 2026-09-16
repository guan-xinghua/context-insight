// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License).
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// Overview 泳道图墙钟口径 IT：execution 的墙钟跨度 = start→next 切片（与
// Perf 柱状图同口径），最后一项 latencyMs 兜底。此前直接用
// Execution.latencyMs（首口径）——现场 subagent 跑数分钟、4.8M tokens，
// 泳道条只显示首轮的 5.1s。
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
  }
}

const T0 = '2026-09-15T21:34:48.000Z'

describe('AgentCallGraph 泳道墙钟 = start→next 切片', () => {
  it('sub1 跨度 = 到 sub2 开始的 60s（非首口径 5.1s）；最后项 latencyMs 兜底', async () => {
    const agents = [
      mkAgent({ executionId: 'root', createdAt: T0, latencyMs: 5_000, isSubagent: false, agentName: 'build' }),
      mkAgent({ executionId: 'sub1', createdAt: '2026-09-15T21:34:58.000Z', latencyMs: 5_100, agentSessionId: 'ses_g1' }),
      mkAgent({ executionId: 'sub2', createdAt: '2026-09-15T21:35:58.000Z', latencyMs: 3_000, agentSessionId: 'ses_g2' }),
    ]
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(createElement(AgentCallGraph, { agents, bridges: [], onViewTurns: () => {} }))
    })

    const bars = [...container.querySelectorAll<HTMLElement>('.absolute.rounded-sm')]
    expect(bars.length).toBe(3)
    // totalDuration = max(0+10s, 10s+60s, 70s+3s) - 0 = 73s
    // root 10s ≈ 13.7%、sub1 60s ≈ 82.2%、sub2 3s（兜底）≈ 4.1%
    const pct = (ms: number) => (ms / 73_000) * 100
    const widths = bars.map(b => parseFloat(b.style.width))
    const near = (got: number, want: number) => Math.abs(got - want) < 0.5
    expect(widths.some(w => near(w, pct(60_000)))).toBe(true)   // sub1：切片 60s（修复前是 5.1s ≈ 7%）
    expect(widths.some(w => near(w, pct(10_000)))).toBe(true)   // root：切片 10s
    expect(widths.some(w => near(w, pct(3_000)))).toBe(true)    // sub2：latencyMs 兜底
    expect(widths.some(w => near(w, pct(5_100)))).toBe(false)   // 首口径 5.1s 不再出现
  })
})
