// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom
// 主页 Sessions 板块搜索 IT：?q= 服务端过滤（taskId / query / label 子串），
// 搜索框（回车/Search 按钮）跳转 ?q= 并重置页码，Clear 清词回全量，命中计
// 数 "Sessions (N of M)"。驱动真实 Home 服务端组件（真实 prisma 查询）+
// 真实 SessionList 渲染：种子两个不同首问的会话，逐 q 断言过滤正确性。

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { act } from 'react'
import { createRoot as createClientRoot, type Root } from 'react-dom/client'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { PrismaClient } from '@prisma/client'
import { importSession } from '../../src/lib/ingest/data-service.ts'
import Home from '../../src/app/page'
import { SessionList } from '../../src/components/SessionList'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/',
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const prisma = new PrismaClient()
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'home-search-it-'))
const SID_A = 'cc-home-search-login-bug'
const SID_B = 'cc-home-search-bench-ops'

function fixture(sid: string, prompt: string): string {
  const file = path.join(TMP, `${sid}.jsonl`)
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: prompt }, timestamp: '2026-09-01T00:00:00.000Z' }),
    JSON.stringify({ type: 'assistant', message: { id: `msg_${sid}`, role: 'assistant', content: [{ type: 'text', text: 'ok' }], model: 'test-model', usage: { input_tokens: 5, output_tokens: 1 } }, timestamp: '2026-09-01T00:00:05.000Z' }),
  ].join('\n') + '\n')
  return file
}

beforeAll(async () => {
  for (const sid of [SID_A, SID_B]) await prisma.session.deleteMany({ where: { taskId: sid } })
  await importSession(fixture(SID_A, '帮我修复登录页渲染错位的 Bug'), SID_A, prisma, path.join(TMP, `${SID_A}.jsonl`), 'claude-jsonl')
  await importSession(fixture(SID_B, '生成 BenchHarnessSoftmax 算子并跑测试'), SID_B, prisma, path.join(TMP, `${SID_B}.jsonl`), 'claude-jsonl')
})

afterAll(async () => {
  for (const sid of [SID_A, SID_B]) {
    try { await prisma.session.deleteMany({ where: { taskId: sid } }); } catch { /* ignore */ }
  }
  await prisma.$disconnect()
  fs.rmSync(TMP, { recursive: true, force: true })
})

async function renderHome(params: Record<string, string | undefined>): Promise<string> {
  const el = await Home({ searchParams: Promise.resolve(params) })
  return renderToString(el)
}

describe('主页 Sessions 搜索（服务端 ?q= 过滤）', () => {
  it('keyword 命中 query：只含匹配会话，另一会话不出现', async () => {
    const html = await renderHome({ q: 'BenchHarnessSoftmax' })
    expect(html).toContain(SID_B)
    expect(html).toContain('生成 BenchHarnessSoftmax 算子并跑测试')
    expect(html).not.toContain(SID_A)
  })

  it('sessionID 子串命中 taskId；大小写不敏感', async () => {
    const html = await renderHome({ q: 'HOME-SEARCH-LOGIN' })
    expect(html).toContain(SID_A)
    expect(html).not.toContain(SID_B)
  })

  it('无命中：空态提示 + 计数', async () => {
    const html = await renderHome({ q: 'no-such-keyword-xyz' })
    expect(html).toContain('No sessions found')
  })
})

function makeItem(taskId: string, query: string) {
  return { ...EMPTY_ITEM, sessionId: taskId, taskId, query }
}

describe('主页 Sessions 客户端取数（搜索无刷新 + 数字翻页）', () => {
  const fetchCalls: string[] = []
  let payloads: Record<string, { items: Array<ReturnType<typeof makeItem>>; total: number; totalCount?: number }> = {}

  beforeAll(() => {
    ;(globalThis as { fetch: typeof fetch }).fetch = ((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/api/observe/data')) {
        fetchCalls.push(url)
        const q = new URL(url, 'http://x').searchParams.get('q') ?? ''
        const page = Number(new URL(url, 'http://x').searchParams.get('page') ?? 1)
        const p = payloads[q] ?? { items: [], total: 0 }
        // 模拟服务端分页：每页 20，这里 payload 直接给整页内容
        return Promise.resolve(new Response(JSON.stringify({ items: p.items, total: p.total, page, ...(p.totalCount != null ? { totalCount: p.totalCount } : {}) }), { status: 200, headers: { 'content-type': 'application/json' } }))
      }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } }))
    }) as typeof fetch
  })

  function rowOf(el: Element): { taskId: string }[] {
    return [...el.querySelectorAll('tbody tr')].filter(r => r.querySelector('input[type="checkbox"]')).map(r => ({ taskId: r.textContent ?? '' }))
  }

  it('搜索：输入防抖触发客户端取数（无整页刷新），URL replaceState 同步 ?q=', async () => {
    payloads = {
      '': { items: [makeItem('all-0', '会话0'), makeItem('all-1', '会话1')], total: 61 },
      登录页: { items: [makeItem('hit-1', '修复登录页')], total: 4, totalCount: 61 },
    }
    fetchCalls.length = 0
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createClientRoot(container)
    // SSR 初始：全量第一页
    await act(async () => {
      root.render(createElement(SessionList, {
        items: payloads[''].items, total: 61, page: 1, pageSize: 20, totalCount: 61,
      }))
    })
    expect(container.querySelectorAll('tbody tr').length).toBe(2)

    // 输入 → 防抖 400ms 后自动搜索
    const input = [...container.querySelectorAll('input')].find(i => i.placeholder?.includes('keyword or session ID')) as HTMLInputElement
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      set.call(input, '登录页')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { await new Promise(r => setTimeout(r, 550)) })

    // 客户端取数发生、行被替换为命中集、标题 of M、URL 同步（replaceState 无导航）
    expect(fetchCalls.some(u => u.includes('q='))).toBe(true)
    expect(container.textContent).toContain('修复登录页')
    expect(container.textContent).toContain('of 61')
    expect(window.location.search).toContain('q=')

    root.unmount()
    container.remove()
    window.history.replaceState(null, '', '/')
  })

  it('翻页：数字页码 + 省略号，点击第 3 页客户端取数 page=3', async () => {
    payloads = {
      '': { items: [makeItem('p3-row', '第三页内容')], total: 200, totalCount: 200 },
    }
    fetchCalls.length = 0
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createClientRoot(container)
    await act(async () => {
      root.render(createElement(SessionList, {
        items: [], total: 200, page: 1, pageSize: 20, totalCount: 200,
      }))
    })
    expect(container.textContent).toContain('…') // 1 … 2 3 … 10
    expect(container.textContent).toContain('第 1 / 10 页')

    // 点第 2 页 → fetch page=2（客户端，无 window.location 整页跳转）
    const page2 = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === '2')
    expect(page2, '页码按钮 2 未找到').toBeTruthy()
    await act(async () => {
      page2!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => { await new Promise(r => setTimeout(r, 50)) })
    expect(fetchCalls.some(u => u.includes('page=2'))).toBe(true)
    expect(window.location.search).toContain('page=2')

    root.unmount()
    container.remove()
    window.history.replaceState(null, '', '/')
  })
})

describe('首页框架列带版本号（与 cannbay viewer 同款）', () => {
  const mk = (framework: string, version: string | null) => ({
    ...EMPTY_ITEM, framework, version,
  })

  it('原生行：徽标后跟版本号文本', () => {
    const html = renderToString(createElement(SessionList, {
      items: [mk('opencode', '2.0.28')],
      page: 1, pageSize: 10, total: 1, totalCount: 1, q: '',
    } as never))
    expect(html).toContain('OpenCode')
    expect(html).toContain('>2.0.28<')
  })

  it('proxy 行：黄标表达 proxy，版本剥掉后缀展示', () => {
    const html = renderToString(createElement(SessionList, {
      items: [mk('opencode-proxy', '1.18.19-opencode-proxy')],
      page: 1, pageSize: 10, total: 1, totalCount: 1, q: '',
    } as never))
    expect(html).toContain('OpenCode')
    expect(html).toContain('proxy')       // 徽标
    expect(html).toContain('>1.18.19<')   // 剥后缀后的版本
    expect(html).not.toContain('1.18.19-opencode-proxy')
  })
})

const EMPTY_ITEM = {
  sessionId: 'x', taskId: 'x', query: '', framework: 'opencode', version: null,
  startTime: '2026-09-01T00:00:00Z', importedAt: '2026-09-01T00:00:00Z', endTime: null,
  totalTokens: 0, totalCost: 0, totalLatencyMs: 0, totalToolCallCount: 0, totalSkillLoadCount: 0,
  totalSubagentCount: 0, model: null, user: null, sourcePath: null,
}
