// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// Overview 泳道 IT（slots 布局）：
// 1) 泳道 = 1 条「主 agent」+ N（5）个「并发槽 N」。subagent 按开始时间丢进「最早空闲」
//    的槽——并发的分到不同槽，后续不重叠的复用回前面的槽。
// 2) 同槽内渲染矩形重叠时往下分轨（>5 并发挤槽兜底），不同轨 top 不同、互不压盖。
// 3) 「休眠阈值」档位切换只在前端重聚类活跃段：阈值越大，段越少（更多连成一片）。
// 4) 悬停详情：同泳道大量同名条仅靠 agentName 无法区分，tooltip 须带上该 execution 的
//    首个任务 prompt（API 已返回 firstPrompt）。
import { describe, it, expect, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { AgentCallGraph } from '@/components/observe/AgentCallGraph'
import type { BridgeItem } from '../../src/components/observe/AgentCallGraph'

let root: Root | null = null
let container: HTMLElement | null = null

afterEach(() => {
  if (root) act(() => { root!.unmount() })
  container?.remove()
  root = null
  container = null
})

interface Span { start: number; end: number }

function mkAgent(over: {
  executionId: string
  createdAt: string
  latencyMs: number
  isSubagent?: boolean
  agentSessionId?: string
  agentName?: string
  firstPrompt?: string | null
  span?: Span | null
  activeIntervals?: Span[]
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
    activeIntervals: over.activeIntervals ?? [],
    firstPrompt: over.firstPrompt ?? null,
  }
}

const T0 = '2026-09-15T21:34:48.000Z'
const T = (offsetMs: number) => new Date(Date.parse(T0) + offsetMs).toISOString()
const at = (offsetMs: number) => Date.parse(T0) + offsetMs

async function renderGraph(
  agents: ReturnType<typeof mkAgent>[],
  bridges: Array<Partial<BridgeItem>> = [],
  isProxy = false,
) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(AgentCallGraph, { agents, bridges: bridges as BridgeItem[], isProxy, onViewTurns: () => {} }))
  })
  return container
}

const barsInLane = (el: HTMLElement, lane: string) =>
  [...el.querySelectorAll<HTMLElement>(`[data-lane="${lane}"] [data-bar]`)]
    .map(b => b.getAttribute('data-bar')!)

describe('AgentCallGraph 泳道分行（slots 布局）', () => {
  it('泳道固定为「主 agent + 并发槽 1..5」；并发的分不同槽，后续复用最早空闲槽', async () => {
    const agents = [
      mkAgent({ executionId: 'root', createdAt: T0, latencyMs: 5_000, isSubagent: false, agentName: 'build' }),
      // subA/subB 并发（重叠）→ 必须落不同槽；subC 明显更晚 → 复用回槽 1
      mkAgent({ executionId: 'subA', createdAt: T(10_000), latencyMs: 5_000, agentSessionId: 'ses_g1', span: { start: at(10_000), end: at(15_000) } }),
      mkAgent({ executionId: 'subB', createdAt: T(12_000), latencyMs: 5_000, agentSessionId: 'ses_g2', span: { start: at(12_000), end: at(17_000) } }),
      mkAgent({ executionId: 'subC', createdAt: T(100_000), latencyMs: 5_000, agentSessionId: 'ses_g3', span: { start: at(100_000), end: at(105_000) } }),
    ]
    const el = await renderGraph(agents)

    // 6 条泳道：主 agent + 并发槽 1..5（即便空槽也在）
    const labels = [...el.querySelectorAll<HTMLElement>('[data-lane-label]')]
    expect(labels.map(l => l.getAttribute('data-lane-label'))).toEqual(
      ['__root', 'slot-1', 'slot-2', 'slot-3', 'slot-4', 'slot-5'])
    expect(labels.map(l => l.textContent)).toEqual(
      ['主 agent', '并发槽 1', '并发槽 2', '并发槽 3', '并发槽 4', '并发槽 5'])

    expect(barsInLane(el, '__root')).toEqual(['root'])
    expect(barsInLane(el, 'slot-1')).toEqual(['subA', 'subC']) // 并发避开、后续复用
    expect(barsInLane(el, 'slot-2')).toEqual(['subB'])
    expect(barsInLane(el, 'slot-3')).toEqual([])
  })

  it('并发超过槽位数时挤进最早空闲槽 → 同槽内重叠的条分轨（top 不同）', async () => {
    // 6 个并发 subagent，5 个槽装满后第 6 个回落到槽 1 → 槽 1 内两条重叠 → 分 2 轨
    const agents = [
      mkAgent({ executionId: 'root', createdAt: T0, latencyMs: 5_000, isSubagent: false, agentName: 'build' }),
      ...[0, 1, 2, 3, 4, 5].map(i => mkAgent({
        executionId: `s${i + 1}`,
        createdAt: T(2_000 + i * 100),
        latencyMs: 30_000,
        agentSessionId: `ses_g${i + 1}`,
        span: { start: at(2_000 + i * 100), end: at(32_000 + i * 100) },
      })),
    ]
    const el = await renderGraph(agents)

    const lane1 = el.querySelector<HTMLElement>('[data-lane="slot-1"]')!
    const laneBars = [...lane1.querySelectorAll<HTMLElement>('[data-bar]')]
    expect(laneBars.map(b => b.getAttribute('data-bar'))).toEqual(['s1', 's6'])

    const topOf = (bar: HTMLElement) =>
      parseFloat(bar.querySelector<HTMLElement>('.cursor-pointer')!.style.top)
    expect(topOf(laneBars[0])).not.toBe(topOf(laneBars[1])) // 分轨，不再压盖
    // 2 轨 → laneHeight = 2*12 + 3*3 = 33px
    expect(lane1.style.height).toBe('33px')

    // 分轨只是「画在不同 top」，两根条子的横向范围仍然重叠；外层定位 div 铺满整条
    // 泳道高且参与命中测试，就会盖掉另一轨条子的交互层。所以外层必须
    // pointer-events-none，命中测试只能落在浅色底子元素（pointer-events-auto）上。
    for (const bar of laneBars) {
      expect(bar.classList.contains('pointer-events-none')).toBe(true)
      expect(bar.querySelector<HTMLElement>('.cursor-pointer')!.classList.contains('pointer-events-auto'))
        .toBe(true)
    }
  })

  it('休眠阈值档位：阈值放大后相邻活跃段合并（段数变少）', async () => {
    // 两个 turn：[0, 60s] 与 [11min, 12min]，间隔 10min
    const agents = [
      mkAgent({
        executionId: 'root', createdAt: T0, latencyMs: 60_000, isSubagent: false, agentName: 'build',
        span: { start: at(0), end: at(20 * 60_000) },
        activeIntervals: [
          { start: at(0), end: at(60_000) },
          { start: at(11 * 60_000), end: at(12 * 60_000) },
        ],
      }),
    ]
    const el = await renderGraph(agents)
    const darkOf = (id: string) =>
      el.querySelectorAll(`[data-bar="${id}"] .pointer-events-none`).length

    // 默认 5min 阈值：间隔 10min > 5min → 2 段
    expect(darkOf('root')).toBe(2)

    // 切 15min：间隔 10min ≤ 15min → 合并成 1 段
    const btn = [...el.querySelectorAll<HTMLButtonElement>('button')]
      .find(b => b.textContent === '15min')!
    await act(async () => { btn.click() })
    expect(darkOf('root')).toBe(1)
  })

  it('悬停同名 subagent 条：tooltip 显示 agentName + 该 execution 的首个任务 prompt', async () => {
    const agents = [
      mkAgent({ executionId: 'root', createdAt: T0, latencyMs: 5_000, isSubagent: false, agentName: 'build' }),
      mkAgent({
        executionId: 'sub1', createdAt: T(10_000), latencyMs: 5_100, agentSessionId: 'ses_g1', agentName: 'design',
        firstPrompt: '为 NPU 编译器后端设计寄存器分配算法的内存布局优化方案',
      }),
      mkAgent({
        executionId: 'sub2', createdAt: T(70_000), latencyMs: 3_000, agentSessionId: 'ses_g2', agentName: 'design',
        firstPrompt: 'review tiling 流水线的调度冲突',
      }),
    ]
    const el = await renderGraph(agents)
    expect(el.querySelector('[data-tooltip]')).toBeNull()

    const hover = async (id: string) => {
      const hit = el.querySelector<HTMLElement>(`[data-bar="${id}"] .cursor-pointer`)!
      await act(async () => { hit.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
      return el.querySelector<HTMLElement>('[data-tooltip]')
    }

    const tip1 = await hover('sub1')
    expect(tip1).not.toBeNull()
    expect(tip1!.textContent).toContain('design')
    expect(tip1!.textContent).toContain('寄存器分配算法')
    expect(tip1!.textContent).not.toContain('tiling')

    const tip2 = await hover('sub2')
    expect(tip2!.textContent).toContain('tiling 流水线')
    expect(tip2!.textContent).not.toContain('寄存器分配')
  })

  it('原生泛化名（全体 design）+ 桥类型：泳道按真类型分组、tooltip 显示类型（resolveSubagentIdentity 唯一入口）', async () => {
    // 现场：ses_f13c4507 原生 opencode，agentName 全体 "design" → 泳道图例
    // 只有一条 design；桥里才有真类型（design-step-reviewer / design-kernel-coder）
    const agents = [
      mkAgent({ executionId: 'root', createdAt: T0, latencyMs: 5_000, isSubagent: false, agentName: 'build' }),
      mkAgent({ executionId: 'sub1', createdAt: T(10_000), latencyMs: 5_100, agentSessionId: 'ses_g1', agentName: 'design' }),
      mkAgent({ executionId: 'sub2', createdAt: T(70_000), latencyMs: 3_000, agentSessionId: 'ses_g2', agentName: 'design' }),
    ]
    const bridges = [
      { bridgeId: 'b1', subagentSessionId: 'ses_g1', subagentType: 'design-step-reviewer', subagentName: 'design', dispatchContent: 'R⑥ 门控审核', status: 'completed' },
      { bridgeId: 'b2', subagentSessionId: 'ses_g2', subagentType: 'design-kernel-coder', subagentName: 'design', dispatchContent: '⑨ group kernel', status: 'completed' },
    ]
    const el = await renderGraph(agents, bridges)
    // 图例 = 类型去重（不再全体 "design" 一项）：两类各一项
    const legend = [...el.querySelectorAll('.text-xs .text-muted-foreground')].map(n => n.textContent)
    expect(legend).toContain('design-step-reviewer')
    expect(legend).toContain('design-kernel-coder')
    expect(legend.filter(x => x === 'design')).toHaveLength(0)
    // tooltip 标签 = 类型（不再是泛化 agentName）
    const hit = el.querySelector<HTMLElement>('[data-bar="sub1"] .cursor-pointer')!
    await act(async () => { hit.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    const tip = el.querySelector<HTMLElement>('[data-tooltip]')
    expect(tip!.textContent).toContain('design-step-reviewer')
  })

  it('proxy 形态：subagentName 即步骤、桥类型仍在——泳道按类型分组不受步骤文本影响', async () => {
    const agents = [
      mkAgent({ executionId: 'root', createdAt: T0, latencyMs: 5_000, isSubagent: false, agentName: 'build' }),
      mkAgent({ executionId: 'sub1', createdAt: T(10_000), latencyMs: 5_100, agentSessionId: 'ses_g1', agentName: '⑦ group 同步' }),
    ]
    const bridges = [
      { bridgeId: 'b1', subagentSessionId: 'ses_g1', subagentType: 'design-sync-planner', subagentName: 'design', dispatchContent: '⑦ group 同步', status: 'completed' },
    ]
    const el = await renderGraph(agents, bridges, true)
    const legend = [...el.querySelectorAll('.text-xs .text-muted-foreground')].map(n => n.textContent)
    expect(legend).toContain('design-sync-planner')
    expect(legend.filter(x => x === '⑦ group 同步')).toHaveLength(0)
  })
})
