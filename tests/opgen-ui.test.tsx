// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom
// 算子生成标注 UI IT：
//   ① SessionList 上传弹窗——「算子生成结果」三态选择器（不标注/成功/失败），
//      勾选"成功"后确认上传 → 请求体携带 opGen:'success'；缺省不携带
//   ② LocalFileImport CANNBay 列表——「算子生成」列渲染 成功/失败/— 徽标

import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { SessionList } from '@/components/SessionList'
import { LocalFileImport } from '@/components/LocalFileImport'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(''),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
const uploadBodies: Array<Record<string, unknown>> = []

beforeAll(() => {
  ;(globalThis as { fetch: typeof fetch }).fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const json = (data: unknown) => Promise.resolve(new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } }))
    if (url.includes('/api/ingest/cannbay2')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      if (body.action === 'dirs') return json({ dirs: ['others'] })
      if (body.action === 'list') {
        return json({ sessions: [
          { sid: 'sid-ok', fileCount: 2, author: 'a', submitter: '测试者', description: '成功的会话', commitTime: '2026-09-02T03:00:00Z', framework: 'claude-code', producer: 'cpx', paradigm: 'others', opGen: 'success' },
          { sid: 'sid-fail', fileCount: 2, author: 'a', submitter: '测试者', description: '失败的会话', commitTime: '2026-09-02T02:00:00Z', framework: 'opencode', producer: 'cpx', paradigm: 'others', opGen: 'failure' },
          { sid: 'sid-plain', fileCount: 2, author: 'a', submitter: '测试者', description: '未标注的会话', commitTime: '2026-09-02T01:00:00Z', framework: 'opencode', producer: 'cpx', paradigm: 'others' },
        ] })
      }
      if (body.action === 'upload') {
        uploadBodies.push(body)
        return json({ folder: 'others/x/', unchanged: false, gitattributesFixed: false, sid: body.taskId })
      }
      return json({})
    }
    return json({})
  }) as typeof fetch
}) as unknown as void

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  uploadBodies.length = 0
})

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })
  }
}

function findButtonByText(text: string): HTMLButtonElement | null {
  // includes 匹配：范式按钮文本带计数后缀（"others 3"）
  return [...document.querySelectorAll('button')].find(b => b.textContent?.includes(text)) ?? null
}

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

const ITEM = {
  sessionId: 's1', taskId: 'ses_opgen-ui-0001', framework: 'claude-code', label: '标注 UI 测试', query: '生成算子',
  turnCount: 2, model: 'test-model', totalTokens: 100, totalCost: 0, startTime: '2026-09-02T03:00:00Z', endTime: '2026-09-02T03:05:00Z',
  version: null, user: '张三', sourcePath: '/tmp/x.jsonl', importedAt: '2026-09-02T04:00:00Z', totalLatencyMs: 1000, totalToolCallCount: 2, totalSkillLoadCount: 0, totalSubagentCount: 0,
}

describe('算子生成标注 UI', () => {
  it('① 上传弹窗：未选算子生成结果时确认上传禁用（必选）；选"成功"后可提交且携带 opGen:success', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => { root!.render(createElement(SessionList, { items: [ITEM], total: 1, page: 1, pageSize: 16 })) })
    await flush()

    // 打开上传弹窗（行内 Upload 按钮，title=Upload to CANNBay）
    const uploadBtn = document.querySelector('button[title="Upload to CANNBay"]') as HTMLButtonElement
    expect(uploadBtn, '上传按钮未找到').toBeTruthy()
    await act(async () => { click(uploadBtn) })
    await flush()
    expect(document.body.textContent).toContain('算子生成结果')

    // 填范式目录（默认仓必选）+ 提交人
    const select = document.querySelector('select') as HTMLSelectElement
    expect(select, '范式目录下拉未找到').toBeTruthy()
    await act(async () => {
      select.value = 'others'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const submitterInput = [...document.querySelectorAll('input')].find(i => i.placeholder?.includes('真实姓名')) as HTMLInputElement
    await act(async () => {
      submitterInput.value = '张三'
      submitterInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()

    // 未选算子生成结果 → 确认上传禁用（必选校验），无请求发出
    const submitBtn = findButtonByText('确认上传')!
    expect(submitBtn.disabled).toBe(true)
    await act(async () => { click(submitBtn) })
    await flush()
    expect(uploadBodies.length).toBe(0)

    // 选择"成功" → 按钮解禁，请求体携带 opGen:'success'
    await act(async () => { click(findButtonByText('成功')!) })
    await flush()
    expect(submitBtn.disabled).toBe(false)
    await act(async () => { click(submitBtn) })
    await flush()
    expect(uploadBodies.length).toBe(1)
    expect(uploadBodies[0].opGen).toBe('success')

    container.remove()
  })

  it('①续：勾选"失败"上传 → 请求体携带 opGen:"failure"', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => { root!.render(createElement(SessionList, { items: [ITEM], total: 1, page: 1, pageSize: 16 })) })
    await flush()

    await act(async () => { click(document.querySelector('button[title="Upload to CANNBay"]')!) })
    await flush()

    const select = document.querySelector('select') as HTMLSelectElement
    await act(async () => {
      select.value = 'others'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const submitterInput = [...document.querySelectorAll('input')].find(i => i.placeholder?.includes('真实姓名')) as HTMLInputElement
    await act(async () => {
      submitterInput.value = '张三'
      submitterInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { click(findButtonByText('失败')!) })
    await flush()

    await act(async () => { click(findButtonByText('确认上传')!) })
    await flush()
    expect(uploadBodies.length).toBe(1)
    expect(uploadBodies[0].opGen).toBe('failure')

    container.remove()
  })

  it('② CANNBay 列表：「算子生成」列 成功/失败/— 三态徽标', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => { root!.render(createElement(LocalFileImport)) })
    await flush()

    await act(async () => { click(findButtonByText('Import Session')!) })
    await flush()
    await act(async () => { click(findButtonByText('CANNBay')!) })
    await flush()
    // 范式选择步 → 点 others
    await act(async () => { click(findButtonByText('others')!) })
    await flush()

    expect(document.body.textContent).toContain('算子生成')
    const cells = [...document.querySelectorAll('td')]
    const has = (sid: string, text: string) => {
      const row = cells.find(c => c.textContent?.includes(sid))
      return row?.parentElement?.textContent?.includes(text) ?? false
    }
    expect(has('sid-ok', '成功')).toBe(true)
    expect(has('sid-fail', '失败')).toBe(true)
    expect(has('sid-plain', '—')).toBe(true)

    container.remove()
  })
})
