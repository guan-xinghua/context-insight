// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 无桥子代理兜底 lane IT：上游 meta 登记为空 / 异步派发回执无子会话 id 时
// 建桥三路全断，子代理 turns 此前在 Turns 时间线整组不可见（能搜到、看不到；
// 现场 2.1.308 异步 Agent 会话 196/223/366 三个子代理）。兜底：无桥子代理
// 按 turnIndex 就近挂到主链最近轮下，slate「未关联」徽标区分精确 lane。
import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TurnTimeline } from '@/components/observe/TurnTimeline'
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

function render(turns: Array<ReturnType<typeof makeTurn>>, bridges: BridgeItem[] = []) {
  return renderToStaticMarkup(
    createElement(TurnTimeline, {
      turns,
      bridges,
      selectedTurnId: null,
      onSelectTurn: () => {},
    }),
  )
}

describe('无桥子代理兜底 lane', () => {
  it('无任何桥时：孤儿子代理挂到主链最近轮下，带「未关联」徽标与轮数', () => {
    const html = render([
      makeTurn(0, 'user', { contentSummary: '开始任务' }),
      makeTurn(1, 'assistant'),
      makeTurn(196, 'user', { isSubagent: true, subagentSessionId: 'sub-orphan-1', contentSummary: '探查开始' }),
      makeTurn(197, 'assistant', { isSubagent: true, subagentSessionId: 'sub-orphan-1' }),
    ])
    expect(html).toContain('未关联子代理')
    expect(html).toContain('未关联')
    // lane 摘要行含轮数（2 turns）
    expect(html).toContain('2 turns')
  })

  it('时间锚定：孤儿挂到「启动时刻主链所在轮」，而非主链末轮', () => {
    // 主链 #0(20:00) #50(21:00) #91(23:38)；孤儿 21:18 启动 → 应挂 #50 而非 #91
    const html = render([
      makeTurn(0, 'user', { contentSummary: 'turn-0', createdAt: '2026-10-22T12:00:00Z' }),
      makeTurn(50, 'assistant', { contentSummary: 'turn-50', createdAt: '2026-10-22T13:00:00Z' }),
      makeTurn(91, 'assistant', { contentSummary: 'turn-91', createdAt: '2026-10-22T15:38:00Z' }),
      makeTurn(196, 'user', { isSubagent: true, subagentSessionId: 'sub-orphan-1', contentSummary: '孤儿启动', createdAt: '2026-10-22T13:18:00Z' }),
    ])
    const laneIdx = html.indexOf('未关联子代理')
    const i50 = html.indexOf('turn-50')
    const i91 = html.indexOf('turn-91')
    expect(laneIdx).toBeGreaterThan(i50)   // 在 #50 之后（挂 #50 下）
    expect(laneIdx).toBeLessThan(i91)      // 且在 #91 之前（不再堆到末尾）
  })

  it('有桥的子代理不走兜底：无「未关联」徽标', () => {
    const html = render(
      [
        makeTurn(0, 'user', { contentSummary: '开始任务' }),
        makeTurn(1, 'assistant'),
        makeTurn(2, 'assistant', { isSubagent: true, subagentSessionId: 'sub-ok', subagentName: '探索' }),
      ],
      [{
        bridgeId: 'b1', dispatchTurnId: 't-1', dispatchContent: '去探查', dispatchTimestamp: null,
        responseTimestamp: null, subagentSessionId: 'sub-ok', subagentName: '探索',
        subagentType: 'Explore', status: 'completed', dispatchBackground: false,
      } as unknown as BridgeItem],
    )
    expect(html).toContain('探索')
    expect(html).not.toContain('未关联')
  })

  it('自锚桥（派发端=子代理自身 turn）锚不到主链：兜底必须接管，不因「有桥」失效', () => {
    // 真机后台 Agent 现场：SubagentHandback 被误识为派发后时间邻近自匹配，
    // dispatchTurnId 指向子代理自己的 turn——泳道只挂主链根 turn，此桥永不
    // 渲染；若仍按「存在桥」抑制兜底，子代理 turns 整组不可见
    const html = render(
      [
        makeTurn(0, 'user', { contentSummary: '开始任务' }),
        makeTurn(1, 'assistant'),
        makeTurn(2, 'assistant', { turnId: 'sub-t9', isSubagent: true, subagentSessionId: 'sub-self', contentSummary: '子代理终局' }),
      ],
      [{
        bridgeId: 'b-self', dispatchTurnId: 'sub-t9', dispatchContent: null, dispatchTimestamp: null,
        responseTimestamp: null, subagentSessionId: 'sub-self', subagentName: null,
        subagentType: null, status: 'completed', dispatchBackground: false,
      } as unknown as BridgeItem],
    )
    expect(html).toContain('未关联子代理')
    expect(html).toContain('1 turns')
  })

  it('孤儿 lane 失败态与耗时从 turns 推导（不恒 completed/0）', () => {
    const html = render([
      makeTurn(0, 'user', { contentSummary: '开始任务' }),
      makeTurn(1, 'assistant'),
      makeTurn(196, 'user', { isSubagent: true, subagentSessionId: 'sub-err', contentSummary: '启动', createdAt: '2026-10-22T12:00:00Z' }),
      makeTurn(197, 'assistant', { isSubagent: true, subagentSessionId: 'sub-err', createdAt: '2026-10-22T12:05:00Z', finishReason: 'error' }),
    ])
    // error 态走红框样式（lane view 以 status === "error" 判红）
    expect(html).toContain('border-red-300')
    // 首末 createdAt 差 5 分钟 → formatLatency 输出 5.0min
    expect(html).toContain('5.0min')
  })

  it('嵌套派发的桥（派发端在已安置子代理的 turns 里）不重复走兜底', () => {
    // 嵌套子 lane 挂在父 lane 内部（默认折叠，静态标记不可见），此处锁的是
    // 锚定语义：sub-child 视为已安置（不再额外生成「未关联」孤儿 lane）
    const html = render(
      [
        makeTurn(0, 'user', { contentSummary: '开始任务' }),
        makeTurn(1, 'assistant'),
        makeTurn(2, 'assistant', { turnId: 'sub-p1', isSubagent: true, subagentSessionId: 'sub-parent', subagentName: '父代理' }),
        makeTurn(3, 'assistant', { turnId: 'sub-c1', isSubagent: true, subagentSessionId: 'sub-child', subagentName: '嵌套子代理' }),
      ],
      [
        {
          bridgeId: 'b-parent', dispatchTurnId: 't-1', dispatchContent: '去探查', dispatchTimestamp: null,
          responseTimestamp: null, subagentSessionId: 'sub-parent', subagentName: '父代理',
          subagentType: 'Explore', status: 'completed', dispatchBackground: false,
        },
        {
          bridgeId: 'b-child', dispatchTurnId: 'sub-p1', dispatchContent: '嵌套派发', dispatchTimestamp: null,
          responseTimestamp: null, subagentSessionId: 'sub-child', subagentName: '嵌套子代理',
          subagentType: 'Explore', status: 'completed', dispatchBackground: false,
        },
      ] as unknown as BridgeItem[],
    )
    expect(html).toContain('父代理')
    expect(html).not.toContain('未关联')
  })
})
