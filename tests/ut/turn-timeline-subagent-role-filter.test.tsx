// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, FITNESS OR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom
// Turns 角色筛选对子代理生效 IT（issue: 过滤对于 subagent 失效）：
// filterRoles 此前只过滤主链 root turns，子代理 lane 内轮次无过滤直出——
// 选 assistant 后子代理的 system <total_tokens> 轮依然可见。修复后：
// lane 内轮次按同一份 filterRoles 过滤（含嵌套 lane），统计显示 可见/总数。
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { TurnTimeline } from '@/components/observe/TurnTimeline'

interface TurnOverrides {
  turnId?: string
  isSubagent?: boolean
  subagentSessionId?: string | null
  contentSummary?: string
}

function makeTurn(turnIndex: number, role: string, o: TurnOverrides = {}) {
  return {
    turnId: o.turnId ?? `t-${turnIndex}`,
    turnIndex,
    role,
    contentSummary: o.contentSummary ?? null,
    agentName: null,
    isSubagent: o.isSubagent ?? false,
    subagentName: o.isSubagent ? 'Designer' : null,
    subagentSessionId: o.subagentSessionId ?? null,
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

function makeBridge(bridgeId: string, dispatchTurnId: string, subagentSessionId: string) {
  return {
    bridgeId,
    dispatchTurnId,
    dispatchContent: `dispatch-${bridgeId}`,
    dispatchTimestamp: null,
    responseTimestamp: null,
    subagentSessionId,
    subagentType: 'designer',
    subagentName: 'Designer',
    agentName: 'Designer',
    status: 'completed',
    subagentTokens: 0,
    subagentLatencyMs: 0,
  }
}

function chip(label: string): HTMLButtonElement | null {
  for (const b of document.querySelectorAll('button')) {
    if ((b.textContent ?? '').startsWith(label)) return b as HTMLButtonElement
  }
  return null
}

const html = (): string => document.body.innerHTML

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterAll(() => {
  delete (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
})

// 断言失败时 host 泄漏在 document.body 里会让后续用例的 chip() 命中泄漏树的
// 按钮（跨树点击）——每用例兜底清场
afterEach(() => {
  document.body.innerHTML = ''
})

describe('TurnTimeline 角色筛选对子代理 lane 生效', () => {
  it('桥驱动 lane：选 assistant 后子代理 system/user 轮隐藏，统计显示 可见/总数；全过滤 lane 显示 0/N', async () => {
    const turns = [
      makeTurn(0, 'user', { contentSummary: 'root-user-zero' }),
      makeTurn(1, 'assistant', { contentSummary: 'root-assistant-one' }),
      makeTurn(2, 'system', { contentSummary: 'root-system-two' }),
      makeTurn(10, 'assistant', { turnId: 'sub-a', isSubagent: true, subagentSessionId: 'sess-sub', contentSummary: 'sub-assistant-ten' }),
      makeTurn(11, 'system', { turnId: 'sub-s', isSubagent: true, subagentSessionId: 'sess-sub', contentSummary: '<total_tokens> sub-system-eleven' }),
      makeTurn(12, 'user', { turnId: 'sub-u', isSubagent: true, subagentSessionId: 'sess-sub', contentSummary: 'sub-user-twelve' }),
      makeTurn(30, 'assistant', { turnId: 'sub-c', isSubagent: true, subagentSessionId: 'sess-c', contentSummary: 'sub-c-assistant' }),
    ]
    const bridges = [
      makeBridge('br-1', 't-1', 'sess-sub'),
      makeBridge('br-c', 't-2', 'sess-c'),
    ]

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root: Root = createRoot(host)
    await act(async () => {
      root.render(createElement(TurnTimeline, {
        turns,
        bridges,
        selectedTurnId: null,
        onSelectTurn: () => {},
        highlightSubagentTurnId: 'sub-a',
      }))
    })

    // 初始无筛选：子代理三种角色轮次全显，lane 统计为总数口径（无斜杠）
    expect(html()).toContain('sub-assistant-ten')
    expect(html()).toContain('sub-system-eleven')
    expect(html()).toContain('sub-user-twelve')
    expect(html()).toContain('3 turns')
    expect(html()).toContain('1 turns')

    // 单选 assistant（issue 现场：子代理 system <total_tokens> 轮此前不被过滤）
    await act(async () => { chip('🤖 assistant')!.click() })
    expect(html()).toContain('root-assistant-one')
    expect(html()).not.toContain('root-user-zero')
    expect(html()).not.toContain('root-system-two')
    expect(html()).toContain('sub-assistant-ten')
    expect(html()).not.toContain('sub-system-eleven')
    expect(html()).not.toContain('sub-user-twelve')
    expect(html()).toContain('1/3 turns')
    // 锚在 system 轮 t-2 的 sess-c：锚点轮被滤但其内 assistant 轮匹配 →
    // 锚点降级为占位行保住挂载点，lane 仍在（折叠态下以 1/1 计数可见，
    // 不再整组连坐消失；内层行的可见性由「占位行保留」专项用例锁）
    expect(html()).toContain('已按角色筛选隐藏')
    expect(html()).toContain('1/1 turns')

    // 加选 system：并集——子代理 assistant + system 轮可见
    await act(async () => { chip('⚙️ system')!.click() })
    expect(html()).toContain('root-system-two')
    expect(html()).toContain('sub-assistant-ten')
    expect(html()).toContain('sub-system-eleven')
    expect(html()).not.toContain('sub-user-twelve')
    expect(html()).toContain('2/3 turns')
    // sess-c 锚点轮（system）恢复完整行，其内 assistant 轮在并集内 → 1/1
    expect(html()).toContain('root-system-two')
    expect(html()).toContain('1/1 turns')

    // 取消 assistant（只剩 system）：sess-sub 锚点（assistant）被滤 → 占位行 +
    // 泳道内只剩 system 轮（1/3）；sess-c 锚点轮可见但内里唯一 assistant 轮被滤空 → 0/1
    await act(async () => { chip('🤖 assistant')!.click() })
    expect(html()).not.toContain('root-assistant-one')
    expect(html()).not.toContain('sub-assistant-ten')
    expect(html()).toContain('sub-system-eleven')
    expect(html()).toContain('1/3 turns')
    expect(html()).toContain('0/1 turns')
    expect(html()).not.toContain('2/3 turns')

    // All 清空回全显
    await act(async () => { chip('All')!.click() })
    expect(html()).toContain('sub-user-twelve')
    expect(html()).toContain('sub-assistant-ten')
    expect(html()).toContain('3 turns')
    expect(html()).not.toContain('1/3 turns')
    expect(html()).not.toContain('0/1 turns')
    expect(html()).not.toContain('已按角色筛选隐藏')

    await act(async () => { root.unmount() })
    host.remove()
  })

  it('嵌套 lane（子代理的子代理）：同口径过滤；派发轮被滤掉时嵌套 lane 随挂载点隐藏', async () => {
    const turns = [
      makeTurn(0, 'system', { contentSummary: 'root-system-zero' }),
      makeTurn(1, 'user', { contentSummary: 'root-dispatch-one' }),
      makeTurn(20, 'system', { turnId: 'nest-a-disp', isSubagent: true, subagentSessionId: 'sess-a', contentSummary: 'nest-dispatcher-twenty' }),
      makeTurn(22, 'user', { turnId: 'nest-a-user', isSubagent: true, subagentSessionId: 'sess-a', contentSummary: 'nest-a-user' }),
      makeTurn(21, 'system', { turnId: 'nest-b-sys', isSubagent: true, subagentSessionId: 'sess-b', contentSummary: 'nest-b-system' }),
      makeTurn(23, 'user', { turnId: 'nest-b-user', isSubagent: true, subagentSessionId: 'sess-b', contentSummary: 'nest-b-user' }),
    ]
    const bridges = [
      makeBridge('br-a', 't-1', 'sess-a'),
      makeBridge('br-b', 'nest-a-disp', 'sess-b'),
    ]

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root: Root = createRoot(host)
    await act(async () => {
      root.render(createElement(TurnTimeline, {
        turns,
        bridges,
        selectedTurnId: null,
        onSelectTurn: () => {},
        highlightSubagentTurnId: 'nest-b-user',
      }))
    })

    // 无筛选：两层 lane 全展开全显
    expect(html()).toContain('nest-dispatcher-twenty')
    expect(html()).toContain('nest-a-user')
    expect(html()).toContain('nest-b-system')
    expect(html()).toContain('nest-b-user')

    // 单选 user：锚点轮（user）可见完整行；sess-a 内 system 派发轮被滤但嵌套
    // lane 里有匹配的 user 轮 → 派发轮降级占位行，嵌套 lane 保留且只显示 user 轮
    await act(async () => { chip('👤 user')!.click() })
    expect(html()).toContain('root-dispatch-one')
    expect(html()).not.toContain('root-system-zero')
    expect(html()).not.toContain('nest-dispatcher-twenty')
    expect(html()).toContain('已按角色筛选隐藏')
    expect(html()).toContain('nest-a-user')
    expect(html()).toContain('1/2 turns')
    expect(html()).not.toContain('nest-b-system')
    expect(html()).toContain('nest-b-user')
    expect(html()).toContain('1/2 turns')

    // 加选 system：派发轮回来 → 嵌套 lane 重现，两级各全显（2/2）
    await act(async () => { chip('⚙️ system')!.click() })
    expect(html()).toContain('nest-dispatcher-twenty')
    expect(html()).toContain('nest-b-system')
    expect(html()).toContain('nest-b-user')
    expect(html()).toContain('2/2 turns')

    await act(async () => { root.unmount() })
    host.remove()
  })

  it('并行组 chip：筛选后 chip 计数显示 可见/总数（如 1/2t）', async () => {
    const turns = [
      makeTurn(1, 'assistant', { contentSummary: 'root-parallel-one' }),
      makeTurn(40, 'assistant', { turnId: 'p1-a', isSubagent: true, subagentSessionId: 'sess-p1', contentSummary: 'p1-assistant' }),
      makeTurn(41, 'system', { turnId: 'p2-s', isSubagent: true, subagentSessionId: 'sess-p2', contentSummary: 'p2-system' }),
      makeTurn(42, 'assistant', { turnId: 'p2-a', isSubagent: true, subagentSessionId: 'sess-p2', contentSummary: 'p2-assistant' }),
    ]
    const bridges = [
      makeBridge('br-p1', 't-1', 'sess-p1'),
      makeBridge('br-p2', 't-1', 'sess-p2'),
    ]

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root: Root = createRoot(host)
    await act(async () => {
      root.render(createElement(TurnTimeline, {
        turns,
        bridges,
        selectedTurnId: null,
        onSelectTurn: () => {},
        highlightSubagentTurnId: 'p1-a',
      }))
    })

    expect(html()).toContain('parallel subagents')
    expect(html()).toContain('1t')
    expect(html()).toContain('2t')
    // 组头汇总（无筛选）= 全量口径：3 turns
    expect(html()).toContain('3 turns')

    await act(async () => { chip('🤖 assistant')!.click() })
    expect(html()).toContain('1/1t')
    expect(html()).toContain('1/2t')
    // 组头汇总与 chip 同步切换 可见/总数（review：组头不得停留在未过滤总数）
    expect(html()).toContain('2/3 turns')
    expect(html()).not.toContain('p2-system')

    await act(async () => { root.unmount() })
    host.remove()
  })

  // cannbot-sentry #94 追加反馈：选 user 时桥接泳道整组消失（派发锚点轮几乎恒为
  // assistant，锚点被滤 → 泳道连坐）——占位行修复的最小复现
  it('选 user：assistant 派发锚点被滤但子代理 user 轮经占位行仍可见', async () => {
    const turns = [
      makeTurn(0, 'user', { contentSummary: 'root-user-zero' }),
      makeTurn(1, 'assistant', { contentSummary: 'root-dispatch-one' }),
      makeTurn(10, 'assistant', { turnId: 'sub-asst', isSubagent: true, subagentSessionId: 'sess-sub', contentSummary: 'sub-assistant-ten' }),
      makeTurn(11, 'user', { turnId: 'sub-usr', isSubagent: true, subagentSessionId: 'sess-sub', contentSummary: 'sub-user-eleven' }),
    ]
    const bridges = [makeBridge('br-1', 't-1', 'sess-sub')]

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root: Root = createRoot(host)
    await act(async () => {
      root.render(createElement(TurnTimeline, {
        turns,
        bridges,
        selectedTurnId: null,
        onSelectTurn: () => {},
        highlightSubagentTurnId: 'sub-usr',
      }))
    })

    // 无筛选：主链 2 轮 + 泳道 2 轮全显
    expect(html()).toContain('root-user-zero')
    expect(html()).toContain('root-dispatch-one')
    expect(html()).toContain('sub-assistant-ten')
    expect(html()).toContain('sub-user-eleven')
    expect(html()).toContain('2 turns')
    // chip 计数含子代理轮次（真机反馈：user (1) 贴在多行 user 的列表上像没认出 subagent 的 user）
    expect(html()).toContain('👤 user (2)')
    expect(html()).toContain('🤖 assistant (2)')
    expect(html()).toContain('All (4)')

    // 选 user：assistant 锚点轮本体隐藏 → 占位行保挂载点；泳道只剩 user 轮（1/2）
    await act(async () => { chip('👤 user')!.click() })
    expect(html()).toContain('root-user-zero')
    expect(html()).not.toContain('root-dispatch-one')
    expect(html()).toContain('已按角色筛选隐藏')
    expect(html()).toContain('sub-user-eleven')
    expect(html()).not.toContain('sub-assistant-ten')
    expect(html()).toContain('1/2 turns')
    // 有占位泳道在渲染，不得误报空态
    expect(html()).not.toContain('No turns match the current filters')

    // All 清空：占位行消失，全部恢复
    await act(async () => { chip('All')!.click() })
    expect(html()).toContain('root-dispatch-one')
    expect(html()).toContain('sub-assistant-ten')
    expect(html()).not.toContain('已按角色筛选隐藏')

    await act(async () => { root.unmount() })
    host.remove()
  })
})
