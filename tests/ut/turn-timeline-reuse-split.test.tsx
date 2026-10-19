// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// 复用会话（同 sid 首发+返工）在 turns 页的 lane 拆分 IT：现场 ses_ecb797cb
// turn10 派「P1 需求分析」、turn19 派「P1 返工 r1」复用同一子代理会话——
// 旧逻辑 lane 按 sid 取全会话 turn，两个 lane 互相包含（turn10 的展开里
// 能看到返工段的 turn，反之亦然）。修复后 lane 只取桥 [dispatch,
// response] 窗口内的 turn，各归各。
import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TurnTimeline } from '@/components/observe/TurnTimeline'

const T0 = '2026-10-13T09:12:00.000Z'   // 首发派发（17:12 CST）
const R1 = '2026-10-13T09:33:51.000Z'   // 返工派发（17:33 CST）
const SID = 'ses-reuse-p1'

function mkTurn(turnIndex: number, over: Record<string, unknown> = {}) {
  return {
    turnId: `t-${turnIndex}`,
    turnIndex,
    role: 'assistant',
    contentSummary: `turn ${turnIndex}`,
    agentName: null,
    isSubagent: false,
    subagentName: null,
    subagentSessionId: null,
    parentExecutionId: null,
    totalTokens: 100,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    latencyMs: 0,
    createdAt: null,
    completedAt: null,
    model: null,
    toolCalls: [],
    skillEvents: [],
    ...over,
  }
}

const subTurn = (turnIndex: number, createdAt: string) => mkTurn(turnIndex, {
  isSubagent: true,
  subagentSessionId: SID,
  subagentName: 'P1 需求分析',
  createdAt,
  contentSummary: `子代理 turn ${turnIndex}`,
})

describe('TurnTimeline 复用会话 lane 按派发窗拆分', () => {
  const turns = [
    mkTurn(10, { toolCalls: [{ toolCallId: 'tc-10', toolName: 'task', state: 'completed', durationMs: 5 }], createdAt: T0 }),
    mkTurn(19, { toolCalls: [{ toolCallId: 'tc-19', toolName: 'task', state: 'completed', durationMs: 5 }], createdAt: R1 }),
    // 首发段 2 条（窗口内），返工段 2 条（窗口外，须被 turn10 的 lane 排除）
    subTurn(11, '2026-10-13T09:12:31.000Z'),
    subTurn(12, '2026-10-13T09:20:00.000Z'),
    subTurn(20, '2026-10-13T09:34:10.000Z'),
    subTurn(21, '2026-10-13T09:38:00.000Z'),
  ]
  const bridges = [
    {
      bridgeId: 'br-first', dispatchTurnId: 't-10', dispatchContent: 'P1 需求分析',
      dispatchTimestamp: T0, responseTimestamp: '2026-10-13T09:24:00.000Z',
      subagentSessionId: SID, subagentType: 'ascendc-ops-architect', subagentName: 'P1 需求分析',
      agentName: null, status: 'completed', subagentTokens: 500, subagentLatencyMs: 720_000,
      dispatchBackground: false,
    },
    {
      bridgeId: 'br-rework', dispatchTurnId: 't-19', dispatchContent: 'P1 返工 r1',
      dispatchTimestamp: R1, responseTimestamp: '2026-10-13T09:40:18.000Z',
      subagentSessionId: SID, subagentType: 'ascendc-ops-architect', subagentName: 'P1 返工 r1',
      agentName: null, status: 'completed', subagentTokens: 400, subagentLatencyMs: 387_000,
      dispatchBackground: false,
    },
  ]

  it('turn10 与 turn19 的 lane 各只含自己窗口的 2 条 turn（不再全会话 4 条互相包含）', () => {
    const html = renderToStaticMarkup(createElement(TurnTimeline, {
      turns, bridges,
      selectedTurnId: null,
      onSelectTurn: () => {},
    }))
    expect(html.match(/2 turns/g)?.length).toBe(2) // 两个 lane 各 2 条
    expect(html).not.toContain('4 turns')
  })

  it('两 lane 的步骤名各自显示（需求分析 / 返工 r1）', () => {
    const html = renderToStaticMarkup(createElement(TurnTimeline, {
      turns, bridges,
      selectedTurnId: null,
      onSelectTurn: () => {},
    }))
    expect(html).toContain('P1 需求分析')
    expect(html).toContain('P1 返工 r1')
  })

  it('首窗 response 越过下次派发时，lane 上界钳到下次派发（不吞下窗 turn）', () => {
    // completedAt 越界形态：首发桥 response 09:35 > 返工派发 09:33:51——
    // 不钳的话 [09:12, 09:35] 会把 09:34:10 的下窗 turn 吞进首发 lane
    const overshootBridges = bridges.map(b => b.bridgeId === 'br-first'
      ? { ...b, responseTimestamp: '2026-10-13T09:35:00.000Z' }
      : b)
    const html = renderToStaticMarkup(createElement(TurnTimeline, {
      turns, bridges: overshootBridges,
      selectedTurnId: null,
      onSelectTurn: () => {},
    }))
    // 首发 lane 仍只含窗口内 2 条（09:12:31 / 09:20:00），09:34:10 被钳掉——
    // 不钳会变 3 turns
    expect(html).not.toContain('3 turns')
    expect(html.match(/2 turns/g)?.length).toBe(2)
  })
})
