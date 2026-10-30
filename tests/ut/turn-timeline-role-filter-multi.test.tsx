// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom
// Turns 角色筛选多选 IT：左上角筛选 chips 从单选（filterRole: string | null，
// 点第二个角色顶掉第一个）升级为多选并集（filterRoles: Set<string>）——
// 逐 chip 点选/取消的完整状态机在真实 React 树上点击驱动验证：
// 初始全显 → 单选 user → 加选 assistant（并集）→ 取消 user → All 一键清空回全显。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { TurnTimeline } from '@/components/observe/TurnTimeline'

function makeTurn(turnIndex: number, role: string, summary: string) {
  return {
    turnId: `t-${turnIndex}`,
    turnIndex,
    role,
    contentSummary: summary,
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
  }
}

// 2 user / 2 assistant / 1 system——summary 用互不为子串的独特字面量，
// 避免「turn 1」这类文本被计数徽章等周边文案误命中。
const turns = [
  makeTurn(0, 'user', 'uq-user-zero'),
  makeTurn(1, 'assistant', 'uq-assistant-one'),
  makeTurn(2, 'system', 'uq-system-two'),
  makeTurn(3, 'user', 'uq-user-three'),
  makeTurn(4, 'assistant', 'uq-assistant-four'),
]

/** 筛选 chips 区的真实 <button>（turn 行是 role="button" 的 span，不会混入）。 */
function chip(label: string): HTMLButtonElement | null {
  for (const b of document.querySelectorAll('button')) {
    if ((b.textContent ?? '').startsWith(label)) return b as HTMLButtonElement
  }
  return null
}

const ALL_SUMMARIES = ['uq-user-zero', 'uq-assistant-one', 'uq-system-two', 'uq-user-three', 'uq-assistant-four']
const html = (): string => document.body.innerHTML

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterAll(() => {
  delete (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
})

describe('TurnTimeline 角色筛选多选', () => {
  it('单选 → 加选并集 → 取消单角色 → All 清空，全程 chip 高亮态与列表同步', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root: Root = createRoot(host)
    await act(async () => {
      root.render(createElement(TurnTimeline, {
        turns,
        bridges: [],
        selectedTurnId: null,
        onSelectTurn: () => {},
      }))
    })

    // 初始：全显 + All 高亮 + 三个角色 chip 均未选
    for (const s of ALL_SUMMARIES) expect(html()).toContain(s)
    expect(chip('All')!.className).toContain('bg-primary')
    expect(chip('👤 user')!.className).not.toContain('bg-primary')

    // 单选 user：只剩 2 个 user turn
    await act(async () => { chip('👤 user')!.click() })
    expect(html()).toContain('uq-user-zero')
    expect(html()).toContain('uq-user-three')
    expect(html()).not.toContain('uq-assistant-one')
    expect(html()).not.toContain('uq-system-two')
    expect(html()).not.toContain('uq-assistant-four')
    expect(chip('👤 user')!.className).toContain('bg-primary')
    expect(chip('All')!.className).not.toContain('bg-primary')

    // 加选 assistant：user + assistant 并集（多选核心行为——不再顶掉第一个）
    await act(async () => { chip('🤖 assistant')!.click() })
    expect(html()).toContain('uq-user-zero')
    expect(html()).toContain('uq-user-three')
    expect(html()).toContain('uq-assistant-one')
    expect(html()).toContain('uq-assistant-four')
    expect(html()).not.toContain('uq-system-two')
    expect(chip('👤 user')!.className).toContain('bg-primary')
    expect(chip('🤖 assistant')!.className).toContain('bg-primary')

    // 取消 user：只剩 assistant
    await act(async () => { chip('👤 user')!.click() })
    expect(html()).not.toContain('uq-user-zero')
    expect(html()).not.toContain('uq-user-three')
    expect(html()).toContain('uq-assistant-one')
    expect(html()).toContain('uq-assistant-four')
    expect(html()).not.toContain('uq-system-two')

    // All 一键清空：回全显
    await act(async () => { chip('All')!.click() })
    for (const s of ALL_SUMMARIES) expect(html()).toContain(s)
    expect(chip('All')!.className).toContain('bg-primary')

    await act(async () => { root.unmount() })
    host.remove()
  })
})
