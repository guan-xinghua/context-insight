// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// Runs 页渲染 IT：页面直读 run-store（CONTEXT_INSIGHT_HOME 可注入），已导入
// 的 run 必须出现在列表。回归锁：曾因未声明动态渲染被构建期静态预渲染成
// 「空列表」缓存——导入成功后页面仍显示暂无 Run。此处在组件层锁数据接线
// （store → page → RunList），构建产物层面的 force-dynamic 声明一并断言。

import { describe, it, expect, afterEach, afterAll, beforeAll, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import RunsPage, { dynamic as runsPageDynamic } from '@/app/runs/page';
import { parseAndIndex } from '@/lib/run/reader';
import { saveRun, type RunImportMeta } from '@/lib/run/run-store';

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, refresh: () => {} }),
  usePathname: () => '/runs',
  useSearchParams: () => new URLSearchParams(''),
}))

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-runs-page-'));
const ORIG_HOME = process.env.CONTEXT_INSIGHT_HOME;

beforeAll(() => {
  process.env.CONTEXT_INSIGHT_HOME = tmpHome;
  const manifest = parseAndIndex(
    JSON.parse(fs.readFileSync(path.resolve(__dirname, './data/run/mini-bundle/workflow.json'), 'utf-8')),
  ).manifest;
  const meta: RunImportMeta = {
    schema: 'insight-run-import',
    version: 1,
    data: {
      importedAt: '2026-10-15T10:00:00+08:00',
      sourceDir: '/bundle/mini',
      manifestFile: 'workflow.json',
      exportDataComplete: true,
      sessions: { total: 3, imported: 3, existing: 0, missingFile: 0, failed: 0 },
      failures: [],
      warnings: [],
    },
  };
  saveRun(manifest, meta);
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  if (ORIG_HOME === undefined) delete process.env.CONTEXT_INSIGHT_HOME;
  else process.env.CONTEXT_INSIGHT_HOME = ORIG_HOME;
})

let root: Root | null = null

describe('Runs 页：store → page → RunList 数据接线', () => {
  it('已导入的 run 渲染进列表（非空态），不显示「暂无导入的 Run」', async () => {
    const tree = await RunsPage()
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(tree)
    })

    expect(document.body.textContent).toContain('mini-bundle')
    expect(document.body.textContent).not.toContain('暂无导入的 Run')
    // 导入入口挂在 header 动作区（与首页 Import Session 同位同尺寸），
    // 且 runs 页不出现数据仓 viewer 入口
    expect(document.body.textContent).toContain('导入 Bundle')
    expect(document.body.textContent).not.toContain('Viewer')
  })

  it('header 恢复设置入口（bundle 上传的数据仓远端/凭据在设置页配置）', async () => {
    const tree = await RunsPage()
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(tree)
    })

    const settingsLink = document.querySelector('a[href="/settings"]') as HTMLAnchorElement | null
    expect(settingsLink).not.toBeNull()
    expect(settingsLink!.textContent).toContain('设置')
  })

  it('页面声明 force-dynamic（fs 数据源禁止构建期静态预渲染）', () => {
    expect(runsPageDynamic).toBe('force-dynamic')
  })
})

describe('Runs 页 Run 上传流（导入后上传，与会话页同款）', () => {
  const lakeCalls: Array<{ action?: string; runId?: string; description?: string }> = []
  let lakeResponse: { status: number; value: Record<string, unknown> } = { status: 200, value: {} }
  const origFetch = globalThis.fetch

  beforeAll(() => {
    ;(globalThis as { fetch: typeof fetch }).fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/api/ingest/lake')) {
        lakeCalls.push(JSON.parse(String(init?.body ?? '{}')))
        return Promise.resolve(new Response(JSON.stringify(lakeResponse.value), { status: lakeResponse.status, headers: { 'content-type': 'application/json' } }))
      }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } }))
    }) as typeof fetch
  })

  afterAll(() => {
    ;(globalThis as { fetch: typeof fetch }).fetch = origFetch
  })

  const setInputValue = (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }

  const click = (el: Element): void => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  }

  const settle = async (): Promise<void> => {
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })
  }

  async function renderPage(): Promise<void> {
    const tree = await RunsPage()
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => { root!.render(tree) })
    await settle()
  }

  it('行内上传按钮 → 表单（提交人必填）→ POST bundle-upload（runId 通道）→ 成功提示', async () => {
    lakeCalls.length = 0
    lakeResponse = { status: 200, value: { runId: 'minidemo01', unchanged: false, sessionCount: 3, missingSessions: [], warnings: [] } }
    await renderPage()

    const uploadBtn = document.querySelector('button[aria-label^="上传 run"]') as HTMLButtonElement
    expect(uploadBtn).not.toBeNull()
    click(uploadBtn)
    await settle()
    expect(document.body.textContent).toContain('上传 Run 到')

    // 提交人未填：上传按钮禁用
    const submitBtn = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === '上传') as HTMLButtonElement
    expect(submitBtn.disabled).toBe(true)

    setInputValue(document.querySelector('input[placeholder="如：张三"]') as HTMLInputElement, '张三')
    setInputValue(document.querySelector('input[placeholder="这个包是什么（可选）"]') as HTMLInputElement, '演示 run')
    await settle()
    expect(submitBtn.disabled).toBe(false)
    click(submitBtn)
    await settle()

    expect(lakeCalls).toEqual([{ action: 'bundle-upload', runId: 'minidemo01', description: '提交人: 张三\n内容描述: 演示 run' }])
    expect(document.body.textContent).toContain('已上传 3 个成员会话')
  })

  it('治理熔断（422）→ 错误展示；缺行成员提示（warnings）', async () => {
    lakeCalls.length = 0
    lakeResponse = { status: 422, value: { error: '上传熔断：清洗后仍检出疑似密钥残留', governance: true } }
    await renderPage()
    click(document.querySelector('button[aria-label^="上传 run"]')!)
    await settle()
    setInputValue(document.querySelector('input[placeholder="如：张三"]') as HTMLInputElement, '张三')
    await settle()
    click([...document.querySelectorAll('button')].find(b => b.textContent?.trim() === '上传')!)
    await settle()
    expect(document.body.textContent).toContain('上传熔断')
    expect(lakeCalls).toHaveLength(1)

    // 成功但缺行成员：warnings 呈现（包内缺正文，不阻断）
    lakeResponse = { status: 200, value: { runId: 'minidemo01', unchanged: false, sessionCount: 2, missingSessions: ['S9'], warnings: ['成员会话 S9 不在 insight（导入缺文件或已删除），包内缺该正文'] } }
    click([...document.querySelectorAll('button')].find(b => b.textContent?.trim() === '关闭')!)
    await settle()
    click(document.querySelector('button[aria-label^="上传 run"]')!)
    await settle()
    setInputValue(document.querySelector('input[placeholder="如：张三"]') as HTMLInputElement, '李四')
    await settle()
    click([...document.querySelectorAll('button')].find(b => b.textContent?.trim() === '上传')!)
    await settle()
    expect(document.body.textContent).toContain('已上传 2 个成员会话')
    expect(document.body.textContent).toContain('S9')
  })
})
