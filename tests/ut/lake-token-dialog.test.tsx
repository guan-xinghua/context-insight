// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// the CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OR MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom
// LakeTokenDialog 保存失败反馈 IT：unconfigured 语境「连接数据仓」先 PUT
// /api/settings/lake-config 落地址——修复前 `if (!cfgRes.ok) throw` 落在
// try/catch 之外，而 handleSave 由 onClick/Enter 直接调用（不 await），
// throw 变 unhandled promise rejection：setError 不触发、弹窗零反馈（地址
// 含非法字符被 PUT 400 拒时用户只看到按钮点了没反应）；非 JSON 错误响应
// （网关 502 HTML）上 json() 同样裸抛。本文件锁定：失败必反馈、凭据 PUT
// 不被带跑、成功链路（地址+凭据两连 PUT）行为不变。

import { describe, it, expect, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { LakeTokenDialog } from '@/components/LakeTokenDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let configPutResponse: () => Response
let authPuts: Array<Record<string, unknown>> = []
const onOpenChange = vi.fn()
const onSaved = vi.fn()

function installFetch(): void {
  const json = (data: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }))
  ;(globalThis as { fetch: typeof fetch }).fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('/api/settings/lake-config') && init?.method === 'PUT') return Promise.resolve(configPutResponse())
    if (url.includes('/api/settings/lake-config')) return json({ configured: false, address: '', branch: 'main' })
    if (url.includes('/api/settings/lake-auth') && init?.method === 'PUT') {
      authPuts.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return json({ username: 'oauth2', tokenMasked: 'ab…CD', verifiedAt: null, reachable: true })
    }
    if (url.includes('/api/settings/lake-auth')) return json({ remotes: [] })
    return json({})
  }) as typeof fetch
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  authPuts = []
  onOpenChange.mockClear()
  onSaved.mockClear()
})

async function flush(ms = 200): Promise<void> {
  const steps = Math.max(1, Math.ceil(ms / 50))
  for (let i = 0; i < steps; i++) {
    await act(async () => { await new Promise(r => setTimeout(r, 50)) })
  }
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function renderAndFill(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(createElement(LakeTokenDialog, { open: true, reason: 'unconfigured', onOpenChange, onSaved })) })
  await flush(200)
  setInputValue(document.getElementById('cb-token-addr') as HTMLInputElement, 'https://example.com/lake.git')
  setInputValue(document.getElementById('cb-token-secret') as HTMLInputElement, 'glpat-xxxx1234')
  await flush(50)
}

async function clickConnect(): Promise<void> {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent?.includes('连接数据仓'))
  if (!b) throw new Error('connect button not found')
  await act(async () => { b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
  await flush(300)
}

describe('unconfigured 首次配置：地址 PUT 失败必须显式反馈（不再静默）', () => {
  it('PUT 400（地址含非法字符）→ 错误文案可见、凭据 PUT 不发、弹窗不关', async () => {
    configPutResponse = () => new Response(JSON.stringify({ error: '数据湖地址含非法字符' }), { status: 400, headers: { 'content-type': 'application/json' } })
    installFetch()
    await renderAndFill()
    await clickConnect()

    expect(document.body.textContent ?? '').toContain('数据湖地址含非法字符')
    expect(authPuts).toEqual([])
    expect(onSaved).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it('非 JSON 错误响应（网关 502 HTML）→ 兜底文案可见，不崩不静默', async () => {
    configPutResponse = () => new Response('<html>bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } })
    installFetch()
    await renderAndFill()
    await clickConnect()

    expect(document.body.textContent ?? '').toContain('地址保存失败')
    expect(authPuts).toEqual([])
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it('成功链路：地址 PUT → 凭据 PUT → 回执展示（行为不变）', async () => {
    configPutResponse = () => new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
    installFetch()
    await renderAndFill()
    await clickConnect()

    expect(authPuts).toHaveLength(1)
    expect(authPuts[0]).toMatchObject({ url: 'https://example.com/lake.git', username: 'oauth2' })
    expect(document.body.textContent ?? '').toContain('令牌已保存')
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ username: 'oauth2', tokenMasked: 'ab…CD' }))
  })
})
