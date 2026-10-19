// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// V2 泳道点击二元性 IT：测时距功能上线后把旧块「点条子跳 turns」的交互盖掉了。
// 约定改为单击/双击分治——泳道空白小、条子占满横向空间，所以：
//   单击（任意位置，含条子上）= 测时距两点标记；落点防抖 DBLCLICK_GUARD_MS，
//     以便让位给双击；
//   双击条子 = onViewTurns 跳转，并取消双击前置两击挂起的测距点。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { AgentSwimlaneV2 } from '@/components/observe/AgentSwimlaneV2'
import type { AgentItem, BridgeItem } from '../../src/components/observe/AgentCallGraph'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLElement | null = null

afterEach(() => {
  if (root) act(() => { root!.unmount() })
  container?.remove()
  root = null
  container = null
})

const T0 = '2026-10-15T10:00:00Z'
const at = (ms: number) => new Date(new Date(T0).getTime() + ms).toISOString()

function mkAgent(over: {
  executionId: string
  span: { start: number; end: number }
  isSubagent?: boolean
  agentSessionId?: string
  agentName?: string
}): AgentItem {
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
    createdAt: new Date(over.span.start).toISOString(),
    latencyMs: over.span.end - over.span.start,
    firstPrompt: null,
    activeIntervals: null,
    span: over.span,
  } as unknown as AgentItem
}

function mkBridges(sessions: Array<{ sub: string; type: string; step?: string; ts?: string; resp?: string; status?: string }>): BridgeItem[] {
  return sessions.map(({ sub, type, step, ts, resp, status }) => ({
    dispatchExecutionId: `exec-${sub}`,
    dispatchContent: step ?? `step-${sub}`,
    dispatchTimestamp: ts ?? null,
    responseTimestamp: resp ?? null,
    subagentSessionId: sub,
    subagentType: type,
    status: status ?? 'completed',
    dispatchBackground: false,
  } as unknown as BridgeItem))
}

async function renderV2(agents: AgentItem[], bridges: BridgeItem[], onViewTurns: (id: string | null) => void, lanes: string[] = []) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  let el: HTMLElement | null = null
  await act(async () => {
    root!.render(createElement(AgentSwimlaneV2, { agents, bridges, onViewTurns, lanes }))
    el = container
  })
  return el!
}

function click(node: Element) {
  act(() => { node.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

function dblclick(node: Element) {
  act(() => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  })
}

const settleMeasure = () => new Promise(r => setTimeout(r, 300))


describe('AgentSwimlaneV2 点击二元性：跳转 × 测时距', () => {
  const agents = [
    mkAgent({ executionId: 'root', span: { start: Date.parse(T0), end: Date.parse(T0) + 200_000 }, isSubagent: false, agentName: 'build' }),
    mkAgent({ executionId: 'subA', span: { start: Date.parse(T0) + 10_000, end: Date.parse(T0) + 60_000 }, agentSessionId: 'ses_g1', agentName: '⑦ group 同步' }),
    mkAgent({ executionId: 'subB', span: { start: Date.parse(T0) + 20_000, end: Date.parse(T0) + 70_000 }, agentSessionId: 'ses_g2', agentName: '⑥ base 切分' }),
  ]

  it('双击条子 → onViewTurns(该子代理会话)；前置两击不得落进测距', async () => {
    const onViewTurns = vi.fn()
    const el = await renderV2(agents, mkBridges([
      { sub: 'ses_g1', type: 'design-sync-planner' },
      { sub: 'ses_g2', type: 'design-tiling-splitter' },
    ]), onViewTurns)

    const bar = el.querySelector<HTMLElement>('[data-bar="subA"]')
    expect(bar).toBeTruthy()
    dblclick(bar!)

    expect(onViewTurns).toHaveBeenCalledTimes(1)
    expect(onViewTurns).toHaveBeenCalledWith('ses_g1', undefined)
    // 双击到达时取消挂起的单击测距点
    expect(el.textContent).not.toContain('已标记起点')
    await settleMeasure()
    expect(el.textContent).not.toContain('已标记起点')
  })

  it('单击泳道（含条子上单击）→ 防抖窗口后测距两点生效；不触发跳转', async () => {
    const onViewTurns = vi.fn()
    const el = await renderV2(agents, mkBridges([
      { sub: 'ses_g1', type: 'design-sync-planner' },
      { sub: 'ses_g2', type: 'design-tiling-splitter' },
    ]), onViewTurns)

    const lane1 = el.querySelector<HTMLElement>('[data-lane="slot-1"]')
    const lane2 = el.querySelector<HTMLElement>('[data-lane="slot-2"]')
    expect(lane1).toBeTruthy()
    expect(lane2).toBeTruthy()
    const barOnLane1 = lane1!.querySelector<HTMLElement>('[data-bar="subA"]')!

    // 单击立即不出点（防抖窗口内可能是双击第一击）
    click(barOnLane1)
    expect(el.textContent).not.toContain('已标记起点')
    await settleMeasure()
    expect(el.textContent).toContain('已标记起点') // 条子上的单击也是测距

    click(lane2!) // 第二击：终点 → 出现时长
    await settleMeasure()
    expect(el.textContent).not.toContain('已标记起点')
    expect(el.textContent).toContain('测距')
    expect(onViewTurns).not.toHaveBeenCalled()
  })

  it('类型配色不回绕：14 个类型 14 个图例色互不相同（撞色会让图例对不上条子）', async () => {
    const types = Array.from({ length: 14 }, (_, i) => `type-${i + 1}`)
    const many = [
      mkAgent({ executionId: 'root', span: { start: Date.parse(T0), end: Date.parse(T0) + 200_000 }, isSubagent: false, agentName: 'build' }),
      ...types.map((t, i) => mkAgent({
        executionId: `x${i}`,
        span: { start: Date.parse(T0) + i * 1_000, end: Date.parse(T0) + i * 1_000 + 500 },
        agentSessionId: `ses_${t}`,
      })),
    ]
    const el = await renderV2(many, mkBridges(types.map(t => ({ sub: `ses_${t}`, type: t }))), () => {})

    const swatches = [...el.querySelectorAll<HTMLElement>('label span.rounded-full')]
    expect(swatches.length).toBe(14)
    const colors = new Set(swatches.map(d => d.style.backgroundColor))
    expect(colors.size).toBe(14)
  })

  it('全不选 → 只剩 root；再勾单个类型 → 只显示该类型条子', async () => {
    const three = [
      mkAgent({ executionId: 'root', span: { start: Date.parse(T0), end: Date.parse(T0) + 200_000 }, isSubagent: false, agentName: 'build' }),
      mkAgent({ executionId: 'subA', span: { start: Date.parse(T0) + 10_000, end: Date.parse(T0) + 60_000 }, agentSessionId: 'ses_g1' }),
      mkAgent({ executionId: 'subB', span: { start: Date.parse(T0) + 20_000, end: Date.parse(T0) + 70_000 }, agentSessionId: 'ses_g2' }),
      mkAgent({ executionId: 'subC', span: { start: Date.parse(T0) + 90_000, end: Date.parse(T0) + 120_000 }, agentSessionId: 'ses_g3' }),
    ]
    const el = await renderV2(three, mkBridges([
      { sub: 'ses_g1', type: 'design-sync-planner' },
      { sub: 'ses_g2', type: 'design-tiling-splitter' },
      { sub: 'ses_g3', type: 'design-merger' },
    ]), () => {})
    expect(el.querySelectorAll('[data-bar]').length).toBe(4)

    // 「全部」主复选框（context 页同款）：全勾 ↔ 全清 单框双态
    const master = () => el.querySelector<HTMLInputElement>('input[data-legend-all]')!
    expect(master()).toBeTruthy()
    expect(master().checked).toBe(true) // 初始全可见
    act(() => { master().dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(el.querySelectorAll('[data-bar="root"]')).toHaveLength(1) // root 常显
    expect(el.querySelectorAll('[data-bar="subA"],[data-bar="subB"],[data-bar="subC"]')).toHaveLength(0)
    expect(master().checked).toBe(false)

    const cb = el.querySelector<HTMLInputElement>('input[data-legend="design-tiling-splitter"]')
    expect(cb).toBeTruthy()
    act(() => { cb!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(el.querySelectorAll('[data-bar="subB"]')).toHaveLength(1)
    expect(el.querySelectorAll('[data-bar="subA"],[data-bar="subC"]')).toHaveLength(0)
    expect(master().checked).toBe(false) // 部分可见 → 主框不勾

    act(() => { master().dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(el.querySelectorAll('[data-bar]')).toHaveLength(4)
    expect(master().checked).toBe(true)
  })

  it('同会话多次派发：按派发拆成两根条，各自步骤/状态独立（返工位置可见）', async () => {
    const agents = [
      mkAgent({ executionId: 'root', span: { start: Date.parse(T0), end: Date.parse(T0) + 200_000 }, isSubagent: false, agentName: 'build' }),
      mkAgent({ executionId: 'subA', span: { start: Date.parse(T0) + 10_000, end: Date.parse(T0) + 120_000 }, agentSessionId: 'ses_g1' }),
    ]
    // 故意倒序传入：靠 dispatchTimestamp 排序恢复首发（#0）在前
    const jump = vi.fn()
    const el = await renderV2(agents, mkBridges([
      { sub: 'ses_g1', type: 'ascendc-ops-architect', step: 'P1 返工 r1', ts: '2026-10-15T10:01:00Z', resp: '2026-10-15T10:02:00Z', status: 'completed' },
      { sub: 'ses_g1', type: 'ascendc-ops-architect', step: 'P1 需求分析', ts: '2026-10-15T10:00:10Z', resp: '2026-10-15T10:00:50Z', status: 'error' },
    ]), jump)

    // 一会话两派发 → 两根条：#0 首发、#1 返工
    const bars = [...el.querySelectorAll<HTMLElement>('[data-bar^="subA#"]')]
    expect(bars.map(b => b.getAttribute('data-bar'))).toEqual(['subA#0', 'subA#1'])

    await act(async () => { bars[0].dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    let tip = el.querySelector<HTMLElement>('[data-tooltip]')
    expect(tip?.textContent).toContain('P1 需求分析')
    expect(tip?.textContent).not.toContain('返工')
    expect(tip?.textContent).toContain('error') // 各自状态：首发 error

    await act(async () => { bars[1].dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    tip = el.querySelector<HTMLElement>('[data-tooltip]')
    expect(tip?.textContent).toContain('P1 返工 r1')
    expect(tip?.textContent).toContain('completed') // 返工修好

    // 双击透传各自派发时刻：页面侧据此把返工条定位到返工起点（不跳会话头）
    const fresh = [...el.querySelectorAll<HTMLElement>('[data-bar^="subA#"]')]
    dblclick(fresh[0])
    dblclick(fresh[1])
    expect(jump).toHaveBeenNthCalledWith(1, 'ses_g1', Date.parse('2026-10-15T10:00:10Z'))
    expect(jump).toHaveBeenNthCalledWith(2, 'ses_g1', Date.parse('2026-10-15T10:01:00Z'))
  })

  it('多派发但缺时间戳：回落整段一根条，浮窗拼接全部步骤 + 次数；状态取最新', async () => {
    const agents = [
      mkAgent({ executionId: 'root', span: { start: Date.parse(T0), end: Date.parse(T0) + 200_000 }, isSubagent: false, agentName: 'build' }),
      mkAgent({ executionId: 'subA', span: { start: Date.parse(T0) + 10_000, end: Date.parse(T0) + 60_000 }, agentSessionId: 'ses_g1' }),
    ]
    // 无时间戳 → 排序无从恢复，按传入序（API 返回即时间序）拼接
    const el = await renderV2(agents, mkBridges([
      { sub: 'ses_g1', type: 'ascendc-ops-architect', step: 'P1 需求分析', status: 'error' },
      { sub: 'ses_g1', type: 'ascendc-ops-architect', step: 'P1 返工 r1', status: 'completed' },
    ]), () => {})

    expect(el.querySelectorAll('[data-bar^="subA#"]')).toHaveLength(0)
    const bar = el.querySelector<HTMLElement>('[data-bar="subA"]')!
    expect(bar).toBeTruthy()
    await act(async () => { bar.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    const tip = el.querySelector<HTMLElement>('[data-tooltip]')
    expect(tip?.textContent).toContain('P1 需求分析 · P1 返工 r1')
    expect(tip?.textContent).toContain('2 次派发')
    expect(tip?.textContent).toContain('completed')
  })

  it('跨天会话时间轴：刻度对齐本地午夜整点并带日期（不再出现 08:38 这类怪时刻）', async () => {
    const start = Date.parse('2026-09-16T12:38:20Z')
    const agents = [
      mkAgent({ executionId: 'root', span: { start, end: start + 87 * 3_600_000 }, isSubagent: false, agentName: 'build' }),
      mkAgent({ executionId: 'subA', span: { start: start + 20 * 3_600_000, end: start + 24 * 3_600_000 }, agentSessionId: 'ses_g1' }),
    ]
    const el = await renderV2(agents, mkBridges([{ sub: 'ses_g1', type: 'design-merger' }]), () => {})

    const labels = [...el.querySelectorAll<HTMLElement>('.tabular-nums')].map(e => e.textContent ?? '')
    const tickLabels = labels.filter(t => /^\d{2}-\d{2} \d{2}:\d{2}$|^\d{2}:\d{2}/.test(t))
    expect(tickLabels.length).toBeGreaterThanOrEqual(3)
    for (const t of tickLabels) {
      expect(t).toMatch(/^\d{2}-\d{2} \d{2}:00$/) // 天级间隔：日期 + 整点
    }
    expect(tickLabels).toContain('09-17 00:00')
    expect(tickLabels).toContain('09-19 00:00')
  })

  it('车道钉死：声明 lanes 后 base/group/empty 各占固定槽，跨波次不漂移', async () => {
    const T = Date.parse(T0)
    const w = (at: number) => [
      mkAgent({ executionId: `b${at}`, span: { start: T + at, end: T + at + 50_000 }, agentSessionId: `ses_b${at}` }),
      mkAgent({ executionId: `g${at}`, span: { start: T + at + 1_000, end: T + at + 50_000 }, agentSessionId: `ses_g${at}` }),
      mkAgent({ executionId: `e${at}`, span: { start: T + at + 2_000, end: T + at + 50_000 }, agentSessionId: `ses_e${at}` }),
    ]
    const agents = [
      mkAgent({ executionId: 'root', span: { start: T, end: T + 400_000 }, isSubagent: false, agentName: 'build' }),
      ...w(0), ...w(100_000), ...w(200_000),
      mkAgent({ executionId: 'serial', span: { start: T + 3_000, end: T + 40_000 }, agentSessionId: 'ses_serial' }),
    ]
    const step = (sid: string) => sid.startsWith('ses_b') ? '④ base 泳道模板计算流'
      : sid.startsWith('ses_g') ? '④ group 泳道模板计算流'
      : sid.startsWith('ses_e') ? '④ empty 泳道模板计算流' : 'P1 需求分析'
    const bridges = mkBridges([
      ...[0, 100_000, 200_000].flatMap(at => ['b', 'g', 'e'].map(k => ({ sub: `ses_${k}${at}`, type: 'design-merger', step: step(`ses_${k}${at}`) }))),
      { sub: 'ses_serial', type: 'ascendc-ops-architect', step: 'P1 需求分析' },
    ])
    const el = await renderV2(agents, bridges, () => {}, ['base', 'group', 'empty'])

    const laneOfBar = (ex: string) => el.querySelector(`[data-bar="${ex}"]`)?.closest('[data-lane]')?.getAttribute('data-lane')
    // 车道槽标签
    const labels = [...el.querySelectorAll('[data-lane]')].map(d => d.getAttribute('data-lane'))
    expect(labels).toContain('slot-1') // 标签列仍在（data-lane 稳定），显示名另行
    // 三波次同道恒定同槽；未分类另槽
    for (const at of [0, 100_000, 200_000]) {
      expect(laneOfBar(`b${at}`)).toBe(laneOfBar('b0'))
      expect(laneOfBar(`g${at}`)).toBe(laneOfBar('g0'))
      expect(laneOfBar(`e${at}`)).toBe(laneOfBar('e0'))
    }
    expect(laneOfBar('g0')).not.toBe(laneOfBar('b0'))
    expect(laneOfBar('e0')).not.toBe(laneOfBar('b0'))
    expect(laneOfBar('serial')).not.toBe(laneOfBar('b0'))
    expect(laneOfBar('serial')).not.toBe(laneOfBar('g0'))
    expect(laneOfBar('serial')).not.toBe(laneOfBar('e0'))
  })

  it('整段条车道匹配取桥派发内容（agentName 是类型名时不错漏到贪心槽）', async () => {
    const T = Date.parse(T0)
    const agents = [
      mkAgent({ executionId: 'root', span: { start: T, end: T + 400_000 }, isSubagent: false, agentName: 'build' }),
      // worker：agentName 含车道词（旧口径也能命中）
      mkAgent({ executionId: 'w1', span: { start: T + 10_000, end: T + 60_000 }, agentSessionId: 'ses_w1', agentName: '④ base 模板计算流' }),
      // reviewer：agentName=类型名（不含车道词），车道只在桥派发内容里
      mkAgent({ executionId: 'r1', span: { start: T + 70_000, end: T + 120_000 }, agentSessionId: 'ses_r1', agentName: 'design-step-reviewer' }),
    ]
    const el = await renderV2(agents, mkBridges([
      { sub: 'ses_w1', type: 'design-kernel-coder', step: '④ base 模板计算流' },
      { sub: 'ses_r1', type: 'design-step-reviewer', step: '④ base R 门控' },
    ]), () => {}, ['base', 'group', 'empty'])

    const laneOfBar = (ex: string) => el.querySelector(`[data-bar="${ex}"]`)?.closest('[data-lane]')?.getAttribute('data-lane')
    expect(laneOfBar('w1')).toBe(laneOfBar('r1')) // 都钉在 base 槽
    expect(laneOfBar('r1')).toBe('slot-1')
  })

  it('root 条子双击 → onViewTurns(null)（跳 turns 不高亮）', async () => {
    const onViewTurns = vi.fn()
    const el = await renderV2(agents, [], onViewTurns)
    const rootBar = el.querySelector<HTMLElement>('[data-bar="root"]')
    dblclick(rootBar!)
    expect(onViewTurns).toHaveBeenCalledWith(null, undefined)
  })
})
