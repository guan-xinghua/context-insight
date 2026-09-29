// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// the CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OR MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom
// 设置页 legacy localStorage 预填 IT：升级用户机器上只有旧键
// <slug>-cannbay-config（上一版 saveCannbayConfig 写入，当前代码不再写
// localStorage），服务端 lake-config.json 未配置时表单必须由旧键预填——
// 修复前 loadLakeConfig 只读新键，升级用户打开设置页表单全空（地址/分支/
// 目录全部重填）。同时锁定：新键优先于旧键；clearLakeConfig（保存/恢复
// 默认值路径）新旧两键同清，旧键不再永久残留。

import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import SettingsPage from '@/app/settings/page'
import { LAKE_CONFIG_STORAGE_KEY } from '@/lib/lake-config'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const LEGACY_KEY = 'cannbot-insight-cannbay-config'
const LEGACY_CFG = {
  address: 'https://legacy.example.com/old-lake.git',
  authMode: 'token',
  branch: 'dev',
  directory: 'dirA/dirB',
}

let root: Root | null = null

beforeAll(() => {
  ;(globalThis as { fetch: typeof fetch }).fetch = (() => {
    const json = (data: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }))
    return ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/api/settings/lake-config')) return json({ configured: false })
      if (url.includes('/api/settings/lake-auth')) return json({ remotes: [] })
      if (url.includes('/api/')) return json({})
      return Promise.reject(new Error(`unexpected fetch: ${url} ${init?.method ?? ''}`))
    }) as typeof fetch
  })()
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  localStorage.clear()
})

async function flush(ms = 200): Promise<void> {
  const steps = Math.max(1, Math.ceil(ms / 50))
  for (let i = 0; i < steps; i++) {
    await act(async () => { await new Promise(r => setTimeout(r, 50)) })
  }
}

async function renderSettings(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(createElement(SettingsPage)) })
  await flush(300)
}

function inputByPlaceholder(fragment: string): HTMLInputElement {
  const input = [...document.querySelectorAll('input')].find(i => i.placeholder?.includes(fragment))
  if (!input) throw new Error(`input not found: ${fragment}`)
  return input as HTMLInputElement
}

function buttonByText(text: string): HTMLButtonElement {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent?.includes(text))
  if (!b) throw new Error(`button not found: ${text}`)
  return b as HTMLButtonElement
}

async function aclick(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

describe('设置页 legacy localStorage 预填（旧键 cannbay-config 回落）', () => {
  it('仅有旧键 + 服务端未配置 → 地址/分支/目录由旧键预填（保存即迁移的前提）', async () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify(LEGACY_CFG))
    await renderSettings()

    expect(inputByPlaceholder('your-lake.git').value).toBe(LEGACY_CFG.address)
    expect(inputByPlaceholder('main（默认）').value).toBe(LEGACY_CFG.branch)
    expect(inputByPlaceholder('留空 = 根目录').value).toBe(LEGACY_CFG.directory)
  })

  it('新旧两键并存 → 新键优先', async () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify(LEGACY_CFG))
    localStorage.setItem(LAKE_CONFIG_STORAGE_KEY, JSON.stringify({ ...LEGACY_CFG, address: 'https://new.example.com/lake.git' }))
    await renderSettings()

    expect(inputByPlaceholder('your-lake.git').value).toBe('https://new.example.com/lake.git')
  })

  it('恢复默认值 → 新旧两键同清（旧键不再永久残留）', async () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify(LEGACY_CFG))
    localStorage.setItem(LAKE_CONFIG_STORAGE_KEY, JSON.stringify(LEGACY_CFG))
    await renderSettings()

    await aclick(buttonByText('恢复默认值'))
    await flush(100)

    expect(localStorage.getItem(LEGACY_KEY)).toBeNull()
    expect(localStorage.getItem(LAKE_CONFIG_STORAGE_KEY)).toBeNull()
  })
})
