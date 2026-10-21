// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom
// 会话页 lake 上传入口 IT：标题栏 Export HTML 旁新增 Upload to Lake
// 按钮，唤醒与主页面共用的上传弹窗（UploadToLakeDialog 共享组件）——
// 范式目录/提交人/内容描述（预填首问）/任务结果必选同款表单。驱动真实
// session 页面组件 + 回放真实 API 数据（复用 session-turn-accumulate fixture），
// 完成完整交互后断言上传请求体（taskId=当前会话 / category / opGen / 提交人
// 预填链路）。同时锁主页 SessionList 行入口与弹窗的共用不改行为（opgen-ui
// 测试覆盖）。session.user=null → 提交人需手填（fixture 形态）。

import { describe, it, expect, afterEach, afterAll, beforeAll, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { BAY_NAME } from '@/lib/branding'

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('framework=opencode'),
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, refresh: () => {} }),
}))

// fixture 随测试目录迁移落在 tests/ut/data/（上游变基适配时本文件移入
// tests/e2e/ 而数据未跟迁，路径漏适配曾致 readJson ENOENT）
const DATA = path.resolve(__dirname, '..', 'ut', 'data', 'session-turn-accumulate')
const TASK_ID = 'ses_066d0d8aaffegJAFUjUGyxKm8z'

function readJson(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf-8'))
}

let root: Root | null = null
let uploadBody: Record<string, unknown> | null = null

beforeAll(() => {
  localStorage.setItem('cannbot-insight-lake-config', JSON.stringify({ address: 'https://example.com/lake.git' }))
  const origFetch = globalThis.fetch
  ;(globalThis as { fetch: typeof fetch }).fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const json = (data: unknown) => Promise.resolve(new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } }))
    // 上传前预检：服务端已配远端（单源 lake-config.json）+ 已存凭据——
    // 两关都过才真正发 upload，否则弹凭据引导框、请求不发出
    if (url.includes('/api/settings/lake-config')) return json({ configured: true, address: 'https://example.com/lake.git', branch: 'main' })
    if (url.includes('/api/settings/lake-auth')) return json({ remotes: [{ url: 'https://example.com/lake.git', username: 'tester', tokenMasked: 'glpat-****' }] })
    if (url.includes('/api/ingest/lake')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      // 弹窗取范式走 action:'list'（dirs+sessions 单轮合并；旧 'dirs' 动作已无前端调用方）
      if (body.action === 'list') return json({ dirs: ['others'], sessions: [] })
      if (body.action === 'upload') {
        uploadBody = body
        return json({ folder: 'others/x/', unchanged: false, gitattributesFixed: false, sid: body.taskId })
      }
      return json({})
    }
    const detail = url.match(/\/api\/observe\/session\/turns\/([^?]+)/)
    if (detail) return json({})
    // 服务端配置预检（单源化后弹窗上传前置）：未配 → 令牌引导、不发上传
    if (url.includes('/api/settings/lake-config')) return json({ configured: true, address: 'https://example.com/lake.git', branch: 'main' })
    if (url.includes('/api/observe/session/turns') && url.includes('includeToolDetail=true')) return json(readJson('turns-full.json'))
    if (url.includes('/api/observe/session/turns')) return json(readJson('turns-plain.json'))
    if (url.includes('/api/observe/session?')) return json(readJson('session.json'))
    if (url.includes('/api/observe/session/bridges')) return json(readJson('bridges.json'))
    if (url.includes('/api/observe/executions')) return json(readJson('executions.json'))
    if (url.includes('/auto-refresh')) return json({ settled: false })
    for (const [frag, file] of [['wire-rounds', 'wire-rounds.json'], ['file-reads', 'file-reads.json'], ['llm-workflow-extract', 'llm-workflow-extract.json'], ['skill-coverage', 'skill-coverage.json'], ['/session/workflow', 'workflow.json'], ['context-windows', 'context-windows.json']]) {
      if (url.includes(frag)) return json(readJson(file))
    }
    if (url.includes('/api/')) return json({})
    return origFetch(input as RequestInfo)
  }) as typeof fetch
})

afterAll(() => {
  localStorage.clear()
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  uploadBody = null
})

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })
  }
}

function findButtonByText(text: string): HTMLButtonElement | null {
  return [...document.querySelectorAll('button')].find(b => b.textContent?.includes(text)) ?? null
}

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

function makeFulfilledThenable<T>(value: T): Promise<T> {
  const thenable = {
    status: 'fulfilled' as const,
    value,
    then(onFulfilled?: (v: T) => unknown) {
      if (typeof onFulfilled === 'function') Promise.resolve(value).then(onFulfilled)
      return this
    },
  }
  return thenable as unknown as Promise<T>
}

describe('会话页 lake 上传入口（共享弹窗）', () => {
  it('Export HTML 旁的上传按钮唤醒共用弹窗，完整提交携带当前会话 taskId/category/opGen', { timeout: 30_000 }, async () => {
    const { default: SessionPage } = await import('@/app/session/[taskId]/page')
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(createElement(SessionPage, { params: makeFulfilledThenable({ taskId: TASK_ID }) } as never))
    })
    await flush()
    expect(document.body.textContent).toContain('Session:')
    expect(findButtonByText('Turns'), '页面加载失败').toBeTruthy()

    // ① 标题栏按钮存在（Export HTML 之后）；title 跟随 BAY_NAME 品牌
    const htmlBtn = document.querySelector('button[title="Export HTML"]')
    const uploadBtn = document.querySelector(`button[title="Upload to ${BAY_NAME}"]`)
    expect(htmlBtn, 'Export HTML 按钮未找到').toBeTruthy()
    expect(uploadBtn, '会话页上传按钮未找到').toBeTruthy()
    expect(uploadBtn!.compareDocumentPosition(htmlBtn!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()

    // ② 唤醒共用弹窗（同款表单齐全）。后续查询一律收敛到弹窗作用域
    // （[data-slot="dialog-content"]）——keep-mounted 隐藏 tab 里有同名元素
    await act(async () => { click(uploadBtn!) })
    await flush()
    expect(document.body.textContent).toContain(`上传到 ${BAY_NAME}`)
    const dlg = document.querySelector('[data-slot="dialog-content"]') as HTMLElement
    expect(dlg, '上传弹窗未渲染').toBeTruthy()
    for (const label of ['范式目录', '提交人', '内容描述', '任务结果']) {
      expect(dlg.textContent).toContain(label)
    }
    // 内容描述预填会话首问（fixture query 含 /ops-registry）
    const textarea = [...dlg.querySelectorAll('textarea')].find(t => t.placeholder?.includes('预填会话首问')) as HTMLTextAreaElement | undefined
    expect(textarea, '上传弹窗内容描述框未找到').toBeTruthy()
    expect(textarea!.value.includes('/ops-registry-invoke-glacier')).toBe(true)

    // ③ 完整提交：范式 + 提交人 + 任务结果（必选）
    const select = dlg.querySelector('select') as HTMLSelectElement
    expect(select, '范式下拉未找到（默认仓形态）').toBeTruthy()
    const submitterInput = [...dlg.querySelectorAll('input')].find(i => i.placeholder?.includes('真实姓名')) as HTMLInputElement
    // 原生 setter 绕过 React 的 value tracker（直接赋 .value 会让后续派发的
    // input/change 事件被 React 判定为无变化、吞掉 onChange）
    const setSelect = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    const setInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setSelect.call(select, 'others')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {
      setInput.call(submitterInput, '张三')
      submitterInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const confirm = [...dlg.querySelectorAll('button')].find(b => b.textContent?.includes('确认上传')) as HTMLButtonElement
    expect(confirm, '确认上传按钮未找到').toBeTruthy()
    expect(confirm.disabled).toBe(true)
    await act(async () => { click([...dlg.querySelectorAll('button')].find(b => b.textContent?.trim() === '成功')!) })
    await flush()
    expect(confirm.disabled).toBe(false)
    await act(async () => { click(confirm) })
    await flush()

    // ④ 请求体：当前会话 taskId + 范式 + opGen + 提交人
    expect(uploadBody, '上传请求未发出').toBeTruthy()
    expect(uploadBody!.taskId).toBe(TASK_ID)
    expect(uploadBody!.category).toBe('others')
    expect(uploadBody!.opGen).toBe('success')
    expect(String(uploadBody!.description)).toContain('提交人: 张三')
    expect(String(uploadBody!.description)).toContain('日志路径:')

    // ⑤ 成功后弹窗自动关闭
    expect(document.body.textContent).not.toContain('确认上传')

    container.remove()
  })
})
