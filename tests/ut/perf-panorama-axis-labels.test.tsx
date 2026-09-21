// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// Perf 页 Task Duration / Token consumption 横轴 IT:
//   横轴原本只有 #N 序号,柱子无法与具体 agent 关联;现每根柱子下直接标注
//   agent 名(subagentName ?? agentName,按 agent 固定色,-/空格断行 ≤2 行,
//   超宽截断 …),#N 保留用于 Task Detail 交叉引用,点击仍跳转 Turns
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { PerfPanorama } from '@/components/observe/PerfPanorama'

let root: Root | null = null
let container: HTMLElement | null = null

afterEach(() => {
  vi.unstubAllGlobals()
  if (root) { act(() => { root!.unmount() }) }
  container?.remove()
  root = null
  container = null
})

const baseExec = {
  isSubagent: true,
  depth: 1,
  tokens: 5000,
  inputTokens: 4000,
  outputTokens: 800,
  reasoningTokens: 200,
  cacheReadInputTokens: 3000,
  cacheCreationInputTokens: 0,
  cost: 0,
  latencyMs: 120_000,
  toolCallCount: 2,
  toolCallErrorCount: 0,
  llmCallCount: 3,
  model: 'glm-5.3',
}

const EXECS = [
  { ...baseExec, executionId: 'exec-1', agentName: 'design-task-generator', subagentName: null, agentSessionId: 'ses_axis_1', createdAt: '2026-09-15T10:00:00Z' },
  { ...baseExec, executionId: 'exec-2', agentName: 'general', subagentName: '探索', agentSessionId: 'ses_axis_2', createdAt: '2026-09-15T10:05:00Z' },
  { ...baseExec, executionId: 'exec-3', agentName: 'developer', subagentName: null, agentSessionId: 'ses_axis_3', createdAt: '2026-09-15T10:10:00Z' },
  { ...baseExec, executionId: 'exec-4', agentName: 'general', subagentName: '很长很长很长很长很长很长很长很长', agentSessionId: 'ses_axis_4', createdAt: '2026-09-15T10:15:00Z' },
]

async function renderPanorama(onJumpToSubagent?: (sid: string) => void) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const json = (data: unknown) => Promise.resolve(new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } }))
    if (url.includes('/api/observe/executions')) return json({ items: EXECS })
    if (url.includes('/api/observe/session/turns')) return json({ items: [] })
    if (url.includes('/api/observe/session/bridges')) return json({ items: [] })
    return json({})
  }))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(PerfPanorama, { taskId: 'perf-axis-test', onJumpToSubagent }))
  })
  await act(async () => { })
}

describe('PerfPanorama 横轴 agent 名标注', () => {
  it('柱下直接显示 agent 名:#N 保留、长名断行、超宽截断、按 agent 固定色', async () => {
    await renderPanorama()
    const textEls = [...container!.querySelectorAll('svg text')]
    const texts = textEls.map(t => t.textContent ?? '')

    // #N 序号保留(Duration + Token 两图各一份)
    expect(texts.filter(t => t === '#1').length).toBe(2)

    // agent 名直接可见,无需悬停
    expect(texts.filter(t => t === '探索').length).toBe(2)
    expect(texts.filter(t => t === 'developer').length).toBe(2)

    // 'design-task-generator' 断行为 'design-task-' + 'generator' 两行
    expect(texts.filter(t => t === 'design-task-').length).toBe(2)
    expect(texts.filter(t => t === 'generator').length).toBe(2)

    // 超宽 CJK 名截断为 ≤5 字 + …
    const truncated = texts.filter(t => t.endsWith('…') && t.includes('很'))
    expect(truncated.length).toBeGreaterThanOrEqual(2)
    expect(truncated[0].length).toBeLessThanOrEqual(6)

    // 名字按 agent 固定色渲染(developer → AGENT_COLORS.developer)
    const devText = textEls.find(t => t.textContent === 'developer')
    expect(devText?.getAttribute('fill')).toBe('#4E79A7')

    // legend 移到卡片头右上(HTML),不再占用 svg 底部与横轴 agent 名冲突
    const spans = [...container!.querySelectorAll('span')].map(s => s.textContent ?? '')
    expect(spans).toContain('LLM 耗时')
    expect(spans).toContain('LLM 外耗时')
    expect(spans).toContain('Cache Write')
    expect(texts.some(t => t.includes('LLM') || t.includes('Cache'))).toBe(false)
  })

  it('点击横轴标签仍触发 onJumpToSubagent(agentSessionId)', async () => {
    const jumped: string[] = []
    await renderPanorama((sid) => { jumped.push(sid) })
    const labelGroup = [...container!.querySelectorAll('svg g')].find(g =>
      [...g.querySelectorAll('text')].some(t => t.textContent === 'design-task-')
    )
    expect(labelGroup).toBeTruthy()
    await act(async () => {
      labelGroup!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(jumped).toEqual(['ses_axis_1'])
  })
})
