// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// 泳道时间轴日期可见性 IT：
//   此前仅当刻度间隔 ≥12h（跨度数天）才显示 MM-DD，小时级刻度只有 HH:MM——
//   单日会话不知道是哪天。现在首个刻度与跨日后的首个刻度都带日期，
//   同日其余刻度保持纯 HH:MM（不逐个重复日期），≥12h 大间隔行为不变。
import { describe, it, expect, afterEach } from 'vitest'
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

function mkAgent(span: { start: number; end: number }): AgentItem {
  return {
    executionId: 'exec-axis-date',
    agentName: 'main',
    agentSessionId: null,
    isSubagent: false,
    parentExecutionId: null,
    tokens: 1000,
    maxSingleCallTokens: 500,
    cost: 0,
    toolCallCount: 1,
    skillLoadCount: 0,
    model: 'glm-5.3',
    createdAt: new Date(span.start).toISOString(),
    latencyMs: span.end - span.start,
    firstPrompt: null,
    activeIntervals: null,
    span,
  } as unknown as AgentItem
}

async function renderAxis(agents: AgentItem[]) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(AgentSwimlaneV2, { agents, bridges: [] as BridgeItem[], onViewTurns: () => {} }))
  })
  // 轴标签行：div 文本恰为 HH:MM 或 MM-DD HH:MM
  const labels = [...container.querySelectorAll('div')]
    .map(d => d.textContent ?? '')
    .filter(t => /^(\d{2}-\d{2} )?\d{2}:\d{2}$/.test(t))
  const dated = labels.filter(t => /^\d{2}-\d{2} \d{2}:\d{2}$/.test(t))
  return { labels, dated, plain: labels.length - dated.length }
}

describe('AgentSwimlaneV2 时间轴日期可见性', () => {
  it('同日会话（1h 刻度）：首个刻度带 MM-DD，其余同日刻度纯 HH:MM', async () => {
    const start = Date.UTC(2026, 9, 15, 1, 0, 0)
    const r = await renderAxis([mkAgent({ start, end: start + 5 * 3_600_000 })])
    expect(r.labels.length).toBeGreaterThanOrEqual(4)
    expect(r.dated.length).toBe(1)
    expect(r.dated[0]).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(r.plain).toBeGreaterThanOrEqual(3)
  })

  it('跨日会话（6h 刻度 <12h）：首刻度与跨日后首刻度都带日期，同日内的不带', async () => {
    const start = Date.UTC(2026, 9, 15, 0, 0, 0)
    const r = await renderAxis([mkAgent({ start, end: start + 30 * 3_600_000 })])
    // 30h 必跨本地午夜（任意时区）：带日期刻度 ≥2（首刻度 + 新日首个刻度）
    expect(r.dated.length).toBeGreaterThanOrEqual(2)
    expect(r.plain).toBeGreaterThanOrEqual(1)
  })
})
