// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License).
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// skill 相关工具调用行的展开 IT：此前 skillCalls 分支是死行——无点击、无
// Args/Result 渲染。现场 #8（ses_f5fe259d8ffe…）：task 派发调用（Args 1022
// 字符 prompt、Result 3595 字符 subagent 报告）只显示"⚡ task completed
// → Skills"一行，点开什么都没有。
import { describe, it, expect, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { ToolCallList } from '@/components/observe/ToolCallList'

let root: Root | null = null
let container: HTMLElement | null = null

afterEach(() => {
  if (root) act(() => { root!.unmount() })
  container?.remove()
  root = null
  container = null
})

const SKILL_TASK_CALL = {
  id: 'tc_task_1',
  toolCallId: 'call_task_1',
  toolName: 'task',
  argsJson: JSON.stringify({ description: 'P1 需求分析', prompt: '执行需求分析任务，方法论以 skill skills/ops-requirement-analysis-irflow/ 为准' }),
  resultJson: '<task id="ses_x" state="completed">\n<task_result>\n全部自检通过。**状态**: ✅通过\n</task_result>\n</task>',
  state: 'ok',
  errorType: null,
  errorMessage: null,
  durationMs: 320_000,
  isSkillRelated: true,
}

describe('ToolCallList skill 行展开', () => {
  it('点击 skill 行展开 Args/Result（此前死行：Args 1K/Result 3.5K 不可见）', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(createElement(ToolCallList, { toolCalls: [SKILL_TASK_CALL] }))
    })

    // 折叠态：标题行可见，内容不渲染
    expect(container.textContent).toContain('task')
    expect(container.textContent).not.toContain('执行需求分析任务')

    // 点击行 → 展开，Args 与 Result 可见
    const row = container.querySelector('[role="button"]') as HTMLElement
    expect(row).toBeTruthy()
    await act(async () => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.textContent).toContain('Args')
    expect(container.textContent).toContain('Result')
    expect(container.textContent).toContain('执行需求分析任务')
    expect(container.textContent).toContain('全部自检通过')
  })
})
