// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License).
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// 同名 subagent 统一编号 IT：
//   ① 纯函数——按组首 turn 时间先后编号（非数据序）、多 agentName 独立计数、
//      0-token 组也参与（Turn 页无图可画也有身份）、root 不编号、匿名组可寻址
//   ② 一致性——同一 turns 喂 TurnTimeline 与 ContextTracker，两处 "general #N"
//      指向同一 subagentSessionId（修复前 Context 图例按 peak 降序、Turn 页无编号）
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { buildSubagentNumbers, subagentGroupKey } from '@/lib/subagent-numbering'
import { TurnTimeline } from '@/components/observe/TurnTimeline'
import { ContextTracker } from '@/components/observe/ContextTracker'

interface TurnFixture {
  turnId: string
  turnIndex: number
  role: string
  contentSummary: string | null
  agentName: string | null
  isSubagent: boolean
  subagentName: string | null
  subagentSessionId: string | null
  parentExecutionId: string | null
  totalTokens: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  inputMessagesCount: number
  inputMessagesTokens: number
  contextWindowPct: number | null
  latencyMs: number
  createdAt: string | null
  completedAt: string | null
  model: string | null
  toolCalls: Array<{ toolCallId: string; toolName: string; state: string; durationMs: number }>
  skillEvents: Array<{ skillName: string; eventType: string; success: boolean; errorMessage: string | null }>
}

function makeTurn(over: Partial<TurnFixture> & Pick<TurnFixture, 'turnId' | 'turnIndex' | 'createdAt'>): TurnFixture {
  return {
    role: 'assistant',
    contentSummary: null,
    agentName: null,
    isSubagent: false,
    subagentName: null,
    subagentSessionId: null,
    parentExecutionId: null,
    totalTokens: 100,
    inputTokens: 100,
    outputTokens: 10,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    inputMessagesCount: 1,
    inputMessagesTokens: 100,
    contextWindowPct: 1,
    latencyMs: 500,
    completedAt: null,
    model: null,
    toolCalls: [],
    skillEvents: [],
    ...over,
  }
}

describe('buildSubagentNumbers：时间序统一编号', () => {
  it('同名组按首 turn 时间先后编号（与数据出现顺序无关）', () => {
    const turns = [
      makeTurn({ turnId: 'r0', turnIndex: 0, createdAt: '2026-09-15T10:00:00Z', role: 'user' }),
      // 数据序 C 最先出现，但时间最晚 → #3
      makeTurn({ turnId: 'c1', turnIndex: 1, createdAt: '2026-09-15T10:10:00Z', agentName: 'general', isSubagent: true, subagentSessionId: 'sub-c' }),
      makeTurn({ turnId: 'b1', turnIndex: 1, createdAt: '2026-09-15T10:00:00Z', agentName: 'general', isSubagent: true, subagentSessionId: 'sub-b' }),
      makeTurn({ turnId: 'a1', turnIndex: 1, createdAt: '2026-09-15T10:05:00Z', agentName: 'general', isSubagent: true, subagentSessionId: 'sub-a' }),
    ]
    const nums = buildSubagentNumbers(turns)
    expect(nums.get('sub-b')).toBe(1)
    expect(nums.get('sub-a')).toBe(2)
    expect(nums.get('sub-c')).toBe(3)
    expect(nums.has('root')).toBe(false)
  })

  it('不同 agentName 各自独立计数；唯一名不编号（codex 场景）', () => {
    const turns = [
      makeTurn({ turnId: 'g1', turnIndex: 1, createdAt: '2026-09-15T10:00:00Z', agentName: 'general', isSubagent: true, subagentSessionId: 's-g1' }),
      makeTurn({ turnId: 'e1', turnIndex: 2, createdAt: '2026-09-15T10:01:00Z', agentName: 'Explore', isSubagent: true, subagentSessionId: 's-e1' }),
      makeTurn({ turnId: 'g2', turnIndex: 3, createdAt: '2026-09-15T10:02:00Z', agentName: 'general', isSubagent: true, subagentSessionId: 's-g2' }),
    ]
    const nums = buildSubagentNumbers(turns)
    expect(nums.get('s-g1')).toBe(1)
    expect(nums.get('s-g2')).toBe(2)
    expect(nums.has('s-e1')).toBe(false)
  })

  it('三个唯一名（codex 多子代理实测场景）均无编号', () => {
    const turns = [
      makeTurn({ turnId: 'r0', turnIndex: 0, createdAt: '2026-10-09T16:24:00Z', role: 'user' }),
      makeTurn({ turnId: 'v1', turnIndex: 1, createdAt: '2026-10-09T16:25:01Z', agentName: 'Volta', isSubagent: true, subagentSessionId: 's-volta' }),
      makeTurn({ turnId: 'f1', turnIndex: 2, createdAt: '2026-10-09T16:25:03Z', agentName: 'Franklin', isSubagent: true, subagentSessionId: 's-franklin' }),
      makeTurn({ turnId: 'a1', turnIndex: 3, createdAt: '2026-10-09T16:25:07Z', agentName: 'Avicenna', isSubagent: true, subagentSessionId: 's-avicenna' }),
    ]
    const nums = buildSubagentNumbers(turns)
    expect(nums.size).toBe(0)
  })

  it('全 0 token 组也占号（Turn 页有身份，Context 页可跳过不画）', () => {
    const turns = [
      makeTurn({ turnId: 'z0', turnIndex: 1, createdAt: '2026-09-15T10:00:00Z', agentName: 'general', isSubagent: true, subagentSessionId: 's-zero', totalTokens: 0, inputTokens: 0, inputMessagesTokens: 0 }),
      makeTurn({ turnId: 'g1', turnIndex: 2, createdAt: '2026-09-15T10:05:00Z', agentName: 'general', isSubagent: true, subagentSessionId: 's-live' }),
    ]
    const nums = buildSubagentNumbers(turns)
    expect(nums.get('s-zero')).toBe(1)
    expect(nums.get('s-live')).toBe(2)
  })

  it('匿名组可用 anon-<turnIndex> 寻址；匿名互为同名 → 编号消歧', () => {
    const turns = [
      makeTurn({ turnId: 'n1', turnIndex: 7, createdAt: '2026-09-15T10:00:00Z', agentName: 'general', isSubagent: true, subagentSessionId: null }),
      makeTurn({ turnId: 'n2', turnIndex: 9, createdAt: '2026-09-15T10:05:00Z', agentName: 'general', isSubagent: true, subagentSessionId: null }),
    ]
    const nums = buildSubagentNumbers(turns)
    expect(subagentGroupKey(turns[0])).toBe('anon-7')
    expect(subagentGroupKey(turns[1])).toBe('anon-9')
    expect(nums.get('anon-7')).toBe(1)
    expect(nums.get('anon-9')).toBe(2)
  })
})

// ② 一致性：同一份数据，TurnTimeline lane 徽标与 ContextTracker 图例的
// "general #1" 必须是同一个 subagentSessionId（sub-b，时间最早者）
const T0 = '2026-09-15T10:00:00Z'
const sharedTurns: TurnFixture[] = [
  makeTurn({ turnId: 'r0', turnIndex: 0, createdAt: T0, role: 'user', agentName: 'build' }),
  makeTurn({ turnId: 'b1', turnIndex: 1, createdAt: '2026-09-15T10:01:00Z', agentName: 'general', isSubagent: true, subagentName: '探索', subagentSessionId: 'sub-b' }),
  makeTurn({ turnId: 'a1', turnIndex: 2, createdAt: '2026-09-15T10:05:00Z', agentName: 'general', isSubagent: true, subagentName: '探索', subagentSessionId: 'sub-a' }),
  makeTurn({ turnId: 'c1', turnIndex: 3, createdAt: '2026-09-15T10:10:00Z', agentName: 'general', isSubagent: true, subagentName: '探索', subagentSessionId: 'sub-c' }),
  makeTurn({ turnId: 'r1', turnIndex: 1, createdAt: '2026-09-15T10:12:00Z', role: 'assistant', agentName: 'build' }),
]

const sharedBridges = (['sub-b', 'sub-a', 'sub-c'] as const).map((sid, i) => ({
  bridgeId: `br-${i}`,
  dispatchTurnId: 'r1',
  dispatchContent: null,
  subagentSessionId: sid,
  subagentType: 'general',
  subagentName: '探索',
  agentName: 'general',
  status: 'completed',
  subagentTokens: 100,
  subagentLatencyMs: 1000,
}))

describe('TurnTimeline ↔ ContextTracker 编号一致', () => {
  it('两处 "general #1" 同指时间最早的 sub-b，#2/#3 依次对应', () => {
    const timelineHtml = renderToStaticMarkup(createElement(TurnTimeline, {
      turns: sharedTurns,
      bridges: sharedBridges,
      selectedTurnId: null,
      onSelectTurn: () => {},
    }))
    const ctxHtml = renderToStaticMarkup(createElement(ContextTracker, {
      turns: sharedTurns,
      sessionModel: null,
    }))

    // 纯函数锚点：#1 = sub-b
    expect(buildSubagentNumbers(sharedTurns).get('sub-b')).toBe(1)

    // TurnTimeline lane 徽标：三档编号都在，且 bridge（sub-b，列表首 lane）显示 #1
    expect(timelineHtml).toContain('general #1')
    expect(timelineHtml).toContain('general #2')
    expect(timelineHtml).toContain('general #3')

    // ContextTracker 图例：同样三档编号
    expect(ctxHtml).toContain('general #1')
    expect(ctxHtml).toContain('general #2')
    expect(ctxHtml).toContain('general #3')
  })
})

// ③ 唯一名不编号（codex 多子代理实测报障：Volta#1/Franklin#1/Avicenna#1
// 的 #1 是纯噪音——编号只服务同名消歧，唯一名显示裸名）
describe('唯一名 subagent 渲染无 #N 后缀', () => {
  const codexTurns: TurnFixture[] = [
    makeTurn({ turnId: 'r0', turnIndex: 0, createdAt: '2026-10-09T16:24:00Z', role: 'user', agentName: 'codex' }),
    makeTurn({ turnId: 'v1', turnIndex: 1, createdAt: '2026-10-09T16:25:01Z', agentName: 'Volta', isSubagent: true, subagentName: 'Volta', subagentSessionId: 's-volta' }),
    makeTurn({ turnId: 'f1', turnIndex: 2, createdAt: '2026-10-09T16:25:03Z', agentName: 'Franklin', isSubagent: true, subagentName: 'Franklin', subagentSessionId: 's-franklin' }),
    makeTurn({ turnId: 'a1', turnIndex: 3, createdAt: '2026-10-09T16:25:07Z', agentName: 'Avicenna', isSubagent: true, subagentName: 'Avicenna', subagentSessionId: 's-avicenna' }),
    makeTurn({ turnId: 'r1', turnIndex: 1, createdAt: '2026-10-09T16:24:30Z', role: 'assistant', agentName: 'codex', toolCalls: [
      { toolCallId: 'tc-v', toolName: 'spawn_agent', state: 'completed', durationMs: 5 },
      { toolCallId: 'tc-f', toolName: 'spawn_agent', state: 'completed', durationMs: 5 },
      { toolCallId: 'tc-a', toolName: 'spawn_agent', state: 'completed', durationMs: 5 },
    ] }),
  ]
  const codexBridges = ([
    ['s-volta', 'Volta'],
    ['s-franklin', 'Franklin'],
    ['s-avicenna', 'Avicenna'],
  ] as const).map(([sid, name], i) => ({
    bridgeId: `br-${i}`,
    dispatchTurnId: 'r1',
    dispatchContent: `dispatch ${name}`,
    subagentSessionId: sid,
    subagentType: null,
    subagentName: name,
    agentName: name,
    status: 'completed',
    subagentTokens: 1000,
    subagentLatencyMs: 10000,
  }))

  it('TurnTimeline 泳道 chip 显示裸名（Volta 而非 Volta #1）', () => {
    const html = renderToStaticMarkup(createElement(TurnTimeline, {
      turns: codexTurns,
      bridges: codexBridges,
      selectedTurnId: null,
      onSelectTurn: () => {},
    }))
    expect(html).toContain('Volta')
    expect(html).toContain('Franklin')
    expect(html).toContain('Avicenna')
    expect(html).not.toContain('Volta #')
    expect(html).not.toContain('Franklin #')
    expect(html).not.toContain('Avicenna #')
  })

  it('ContextTracker 图例同样显示裸名', () => {
    const html = renderToStaticMarkup(createElement(ContextTracker, {
      turns: codexTurns,
      sessionModel: null,
    }))
    expect(html).not.toContain('Volta #')
    expect(html).not.toContain('Franklin #')
    expect(html).not.toContain('Avicenna #')
  })
})
