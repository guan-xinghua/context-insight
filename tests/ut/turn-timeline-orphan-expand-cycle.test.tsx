// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// 孤儿/畸形桥展开态回归（PR #151 review，zhou-qilong 两条）：
// P1 自引用桥（派发端 turn 属于桥指向的子会话自身）建 lane 前剔除——修复前
//    展开孤儿 lane 后其内部仍渲染 b-self 嵌套 lane，双展开构成递归（评审实测
//    单 turn 内容渲染 78 次）；互引环（A↔B）由渲染路径防环截断兜底；
// P2 highlightSubagentTurnId 跳转自动展开：无桥 / 仅剩无效桥的 sid 此前直接
//    break，兜底泳道折叠、目标 turn 不在 DOM、无法滚动定位——现在展开
//    orphan-${sid} 泳道承载。
import { describe, it, expect } from 'vitest'
import { createElement, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { TurnTimeline, SubagentLaneView } from '@/components/observe/TurnTimeline'
import type { BridgeItem } from '../../src/components/observe/AgentCallGraph'

function makeTurn(turnIndex: number, role: string, over: Record<string, unknown> = {}) {
  return {
    turnId: `t-${turnIndex}`,
    turnIndex,
    role,
    contentSummary: `turn ${turnIndex}`,
    agentName: null,
    isSubagent: false,
    subagentName: null,
    subagentSessionId: null,
    parentExecutionId: null,
    totalTokens: 10,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    latencyMs: 0,
    createdAt: null,
    completedAt: null,
    finishReason: null,
    model: null,
    toolCalls: [],
    skillEvents: [],
    ...over,
  }
}

const SELF_REF_BRIDGE = {
  bridgeId: 'b-self', dispatchTurnId: 'sub-t9', dispatchContent: null, dispatchTimestamp: null,
  responseTimestamp: null, subagentSessionId: 'sub-self', subagentName: null,
  subagentType: null, status: 'completed', dispatchBackground: false,
} as unknown as BridgeItem

function renderTL(props: Record<string, unknown>): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(createElement(TurnTimeline, {
      selectedTurnId: null,
      onSelectTurn: () => {},
      ...props,
    } as never))
  })
  return container
}

function toggles(container: HTMLElement): Element[] {
  return Array.from(container.querySelectorAll('[role="button"]'))
    .filter(el => el.textContent?.trim() === '▶' || el.textContent?.trim() === '▼')
}

function clickToggle(el: Element) {
  act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

function countOf(container: HTMLElement, marker: string): number {
  return (container.innerHTML.match(new RegExp(marker, 'g')) ?? []).length
}

describe('P1 自引用桥：建 lane 前剔除（展开态回归）', () => {
  it('展开孤儿 lane 后无嵌套 b-self lane：toggle 不增殖、turn 内容恰好出现 1 次', () => {
    const container = renderTL({
      turns: [
        makeTurn(0, 'user', { contentSummary: '开始任务' }),
        makeTurn(1, 'assistant'),
        makeTurn(2, 'assistant', { turnId: 'sub-t9', isSubagent: true, subagentSessionId: 'sub-self', contentSummary: '子代理终局' }),
      ],
      bridges: [SELF_REF_BRIDGE],
    })
    // 折叠态：只有孤儿 lane 一个展开入口（b-self 的 lane 已被剔除）
    expect(toggles(container).length).toBe(1)
    clickToggle(toggles(container)[0])
    // 展开后：turn 可见且恰好 1 次（修复前 b-self 嵌套 lane 会出现，双展开后 78 次）
    expect(countOf(container, '子代理终局')).toBe(1)
    // 展开区内部不再出现新的展开入口（sub-t9 无有效 lane 可挂）
    expect(toggles(container).length).toBe(1)
    expect(toggles(container)[0].textContent?.trim()).toBe('▼')
  })
})

describe('P1 互引环：渲染路径截断（SubagentLaneView 直渲）', () => {
  it('A↔B 互引桥全展开：环处显示截断提示，内容不增殖', () => {
    const ta = makeTurn(10, 'user', { turnId: 'TA', isSubagent: true, subagentSessionId: 'sessA', contentSummary: 'MUT-A-START' })
    const tb = makeTurn(20, 'user', { turnId: 'TB', isSubagent: true, subagentSessionId: 'sessB', contentSummary: 'MUT-B-START' })
    const laneA = { bridgeId: 'laneA', sessionId: 'sessA', name: '代理A', type: null, background: false, summary: null, turns: [ta], status: 'completed', totalTokens: 0, latencyMs: 0, turnCount: 1 }
    const laneB = { bridgeId: 'laneB', sessionId: 'sessB', name: '代理B', type: null, background: false, summary: null, turns: [tb], status: 'completed', totalTokens: 0, latencyMs: 0, turnCount: 1 }
    // 互引：A 会话的 TA 派发出 B（laneB 挂 TA），B 会话的 TB 派发出 A（laneA 挂 TB）
    const byTurn = new Map([[ta.turnId, [laneB]], [tb.turnId, [laneA]]])
    const ctx = {
      subagentBlocksByTurnId: byTurn,
      expandedSubagents: new Set(['laneA', 'laneB']),
      onToggleBridge: () => {},
      selectedTurnId: null,
      onSelectTurn: () => {},
      selectedSubRef: null,
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(createElement(SubagentLaneView, {
        lane: laneA, ctx: ctx as never,
      } as never) as ReactElement)
    })
    // 环截断提示出现（laneA → laneB → laneA 第二次进入被 path 拦截）
    expect(container.textContent).toContain('环引用截断')
    // 内容各有界：不因递归增殖
    expect(countOf(container, 'MUT-A-START')).toBe(1)
    expect(countOf(container, 'MUT-B-START')).toBe(1)
  })
})

describe('P2 highlight 跳转自动展开孤儿 lane', () => {
  const ORPHAN_TURNS = () => [
    makeTurn(0, 'user', { contentSummary: '开始任务' }),
    makeTurn(1, 'assistant'),
    makeTurn(196, 'user', { isSubagent: true, subagentSessionId: 'sub-orphan-1', contentSummary: '探查开始' }),
  ]

  it('高亮无桥子代理 turnId：兜底泳道自动展开，目标内容进入 DOM', () => {
    const container = renderTL({ turns: ORPHAN_TURNS(), bridges: [], highlightSubagentTurnId: 't-196' })
    expect(container.textContent).toContain('探查开始')
    expect(toggles(container)[0].textContent?.trim()).toBe('▼')
  })

  it('高亮形态为 subagentSessionId：同样自动展开', () => {
    const container = renderTL({ turns: ORPHAN_TURNS(), bridges: [], highlightSubagentTurnId: 'sub-orphan-1' })
    expect(container.textContent).toContain('探查开始')
    expect(toggles(container)[0].textContent?.trim()).toBe('▼')
  })

  it('仅剩自引用无效桥：高亮走孤儿兜底而非 break（评审要求同口径）', () => {
    const container = renderTL({
      turns: [
        makeTurn(0, 'user', { contentSummary: '开始任务' }),
        makeTurn(1, 'assistant'),
        makeTurn(2, 'assistant', { turnId: 'sub-t9', isSubagent: true, subagentSessionId: 'sub-self', contentSummary: '子代理终局' }),
      ],
      bridges: [SELF_REF_BRIDGE],
      highlightSubagentTurnId: 'sub-self',
    })
    expect(container.textContent).toContain('子代理终局')
    expect(toggles(container)[0].textContent?.trim()).toBe('▼')
  })
})
