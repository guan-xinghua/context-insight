// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// Overview 泳道 IT（本轮 UX 修复）：
// 1) 分行：装箱必须按「渲染矩形」（left% + 最小宽度地板 2%），不能按原始时间
//    跨度——切片跨度（start→next）首尾相接、时间上永不重叠，按时间装箱恒为单轨，
//    多行机制（trackCount/laneHeight）沦为死代码；被地板撑宽的短条在同一行互相
//    压盖（现场：65h 跨度 68 agents，design 泳道单行压盖 8 层，只有最顶层可点）。
//    压盖的条分行；首尾相接的顺序条保持同轨，不因逐条错位而轨道爆炸。
// 2) 悬停详情：同泳道大量同名条（如 65 个 design）仅靠 agentName 无法区分，
//    tooltip 须带上该 execution 的首个任务 prompt（API 已返回 firstPrompt）。
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
  firstPrompt?: string | null
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
    firstPrompt: over.firstPrompt ?? null,
  }
}

const T0 = '2026-09-15T21:34:48.000Z'

async function renderGraph(agents: ReturnType<typeof mkAgent>[]) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(AgentCallGraph, { agents, bridges: [], onViewTurns: () => {} }))
  })
  return [...container.querySelectorAll<HTMLElement>('.absolute.rounded-sm')]
}

describe('AgentCallGraph 泳道分行（渲染矩形装箱）', () => {
  it('地板撑宽后压盖的条分行：并发起跑 subA/subB 不同 top，后续顺序条回收低轨', async () => {
    // total = 73s；slices: root 10s / subA 1s / subB 59s / subC 3s(latency 兜底)
    // subA 渲染 [13.70%, 15.70%]（1.37% 被地板撑到 2%），subB 起点 15.07% 落在其内 → 压盖
    // 修复前：切片时间相接 → 全部 track 0，subA/subB 同 top 互相压盖
    const agents = [
      mkAgent({ executionId: 'root', createdAt: T0, latencyMs: 5_000, isSubagent: false, agentName: 'build' }),
      mkAgent({ executionId: 'subA', createdAt: '2026-09-15T21:34:58.000Z', latencyMs: 5_100, agentSessionId: 'ses_g1' }),
      mkAgent({ executionId: 'subB', createdAt: '2026-09-15T21:34:59.000Z', latencyMs: 5_100, agentSessionId: 'ses_g2' }),
      mkAgent({ executionId: 'subC', createdAt: '2026-09-15T21:35:58.000Z', latencyMs: 3_000, agentSessionId: 'ses_g3' }),
    ]
    const bars = await renderGraph(agents)
    expect(bars.length).toBe(4)

    const near = (got: number, want: number) => Math.abs(got - want) < 0.1
    const top = (b: HTMLElement) => parseFloat(b.style.top)
    const left = (b: HTMLElement) => parseFloat(b.style.left)

    // DOM 顺序：总控(root) → 通用泳道 packed 顺序（subA, subB, subC）
    expect(near(left(bars[1]), (10 / 73) * 100)).toBe(true)
    expect(near(left(bars[2]), (11 / 73) * 100)).toBe(true)
    expect(top(bars[1])).toBe(3)          // subA → 轨 0
    expect(top(bars[2])).toBe(3 + 12 + 3) // subB → 轨 1（压盖 → 分行，修复前同轨压盖）
    expect(top(bars[3])).toBe(3)          // subC 起点 95.89% 早于轨 0 末端 → 回收轨 0

    // 通用泳道 2 轨 → laneHeight = 2*12 + 3*3 = 33px；总控单轨 = max(22, 18) = 22px
    expect(bars[1].parentElement!.style.height).toBe('33px')
    expect(bars[0].parentElement!.style.height).toBe('22px')
  })

  it('首尾相接的顺序长条同轨不分行（轨道防爆回归）', async () => {
    // sub1 切片 60s 无地板膨胀 [13.70%, 95.89%]，sub2 起点 95.89% 恰好相接 → 同轨
    const agents = [
      mkAgent({ executionId: 'root', createdAt: T0, latencyMs: 5_000, isSubagent: false, agentName: 'build' }),
      mkAgent({ executionId: 'sub1', createdAt: '2026-09-15T21:34:58.000Z', latencyMs: 5_100, agentSessionId: 'ses_g1' }),
      mkAgent({ executionId: 'sub2', createdAt: '2026-09-15T21:35:58.000Z', latencyMs: 3_000, agentSessionId: 'ses_g2' }),
    ]
    const bars = await renderGraph(agents)
    expect(bars.length).toBe(3)
    const top = (b: HTMLElement) => parseFloat(b.style.top)
    expect(top(bars[1])).toBe(3)
    expect(top(bars[2])).toBe(3)
    expect(bars[1].parentElement!.style.height).toBe('22px')
  })

  it('悬停同名 subagent 条：tooltip 显示 agentName + 该 execution 的首个任务 prompt', async () => {
    const agents = [
      mkAgent({ executionId: 'root', createdAt: T0, latencyMs: 5_000, isSubagent: false, agentName: 'build' }),
      mkAgent({
        executionId: 'sub1', createdAt: '2026-09-15T21:34:58.000Z', latencyMs: 5_100,
        agentSessionId: 'ses_g1', agentName: 'design',
        firstPrompt: '为 NPU 编译器后端设计寄存器分配算法的内存布局优化方案',
      }),
      mkAgent({
        executionId: 'sub2', createdAt: '2026-09-15T21:35:58.000Z', latencyMs: 3_000,
        agentSessionId: 'ses_g2', agentName: 'design',
        firstPrompt: 'review tiling 流水线的调度冲突',
      }),
    ]
    const bars = await renderGraph(agents)
    expect(container!.querySelector('.pointer-events-none')).toBeNull()

    await act(async () => {
      bars[1].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    const tip1 = container!.querySelector<HTMLElement>('.pointer-events-none')
    expect(tip1).not.toBeNull()
    expect(tip1!.textContent).toContain('design')
    expect(tip1!.textContent).toContain('寄存器分配算法')
    expect(tip1!.textContent).not.toContain('tiling')

    await act(async () => {
      bars[2].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    const tip2 = container!.querySelector<HTMLElement>('.pointer-events-none')
    expect(tip2!.textContent).toContain('tiling 流水线')
    expect(tip2!.textContent).not.toContain('寄存器分配')
  })
})
