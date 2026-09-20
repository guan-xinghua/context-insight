// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom
// 导入失败可见性 IT：此前导入完成后（无论成败）1s 自动关闭对话框 + 有成功时
// 整页 reload，报错一闪而过用户看不到。修复后：全部成功才自动关闭；有任何
// 失败则驻留结果视图，报错完整展示（独立换行、不截断），用户手动 Done 关闭。
// 覆盖两条导入链路（共享同一套 allDone/hasError 状态机）：
//   ① CANNbay 导入（handleImportCannbay）——客户现场 Main jsonl missing 形态
//   ② 本地单文件 JSONL 导入（handleLoadSessions 直导分支）

import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { LocalFileImport } from '@/components/LocalFileImport'
import { BAY_NAME } from '@/lib/branding'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SID = 'err-ses-0001'
const HISTORY_KEY = 'cannbot-import-history'

let root: Root | null = null

const CANNBAY_ERROR = `Main jsonl missing for session "${SID}.native"`
const LOCAL_ERROR = 'No parseable records (corrupt file)'
const reloadSpy = vi.fn()

beforeAll(() => {
  localStorage.clear()
  vi.stubGlobal('location', { ...window.location, reload: reloadSpy })
  ;(globalThis as { fetch: typeof fetch }).fetch = (() => {
    const json = (data: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }))
    return ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/api/ingest/cannbay2')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        if (body.action === 'list') {
          return json({
            dirs: ['err-it'],
            sessions: [
              { sid: SID, recording: 'native', fileCount: 2, author: 'a', submitter: '测试者', description: '原生会话', commitTime: '2026-09-17T09:00:00Z', framework: 'claude-code', ccVersion: null, paradigm: 'err-it' },
            ],
          })
        }
        if (body.action === 'import') {
          return json({ error: CANNBAY_ERROR }, 500)
        }
        return json({})
      }
      if (url.includes('/api/ingest/import-file')) {
        return json({ error: LOCAL_ERROR }, 400)
      }
      return json({})
    }) as typeof fetch
  })()
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  localStorage.clear()
})

async function flush(ms = 160): Promise<void> {
  const steps = Math.max(1, Math.ceil(ms / 50))
  for (let i = 0; i < steps; i++) {
    await act(async () => { await new Promise(r => setTimeout(r, 50)) })
  }
}

function findButtonByText(text: string, exact = false): HTMLButtonElement | null {
  return [...document.querySelectorAll('button')].find(b => exact ? b.textContent?.trim() === text : b.textContent?.includes(text)) ?? null
}

async function aclick(el: Element | null): Promise<void> {
  if (el == null) throw new Error('click target not found')
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function renderAndOpen(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(createElement(LocalFileImport)) })
  await flush(150)
  await aclick(findButtonByText('Import Session'))
  await flush(150)
}

describe('导入失败驻留 + 报错完整可见（不自动关闭）', () => {
  it('CANNbay 导入失败：报错可见、对话框不自动关闭、有 Done 手动关闭', async () => {
    await renderAndOpen()
    await aclick(findButtonByText(BAY_NAME))
    await flush(250)
    await aclick(findButtonByText('err-it'))
    await flush(150)
    // 勾选会话行 → 导入
    const checkbox = [...document.querySelectorAll('[data-slot="dialog-content"] table tbody tr [role="checkbox"]')][0] as HTMLInputElement
    await aclick(checkbox)
    await flush(100)
    await aclick(findButtonByText('Import 1 Selected'))
    await flush(300)

    // 报错完整可见（独立换行展示真实错误，非「详见控制台」占位）
    const bodyText = document.body.textContent ?? ''
    expect(bodyText).toContain(CANNBAY_ERROR)
    expect(bodyText).toContain('Failed')

    // 越过 1s 自动关闭窗口后仍驻留：不自动 Done（无 reload、无 history）
    await flush(1600)
    expect(document.body.textContent ?? '').toContain(CANNBAY_ERROR)
    expect(reloadSpy).not.toHaveBeenCalled()
    expect(localStorage.getItem(HISTORY_KEY)).toBeNull()
    // Done 按钮在，供用户看清报错后手动关闭
    expect(findButtonByText('Done')).toBeTruthy()

    // 手动 Done 关闭对话框（此时无成功项，不写 history、不 reload）
    await aclick(findButtonByText('Done'))
    await flush(100)
    expect(document.body.textContent ?? '').not.toContain(CANNBAY_ERROR)
  })

  it('本地 JSONL 导入失败：报错可见、不自动关闭', async () => {
    await renderAndOpen()
    // 默认 sourceType = claude-jsonl；填入单文件路径后按钮变「Import」
    const input = [...document.querySelectorAll('input')].find(i => i.placeholder?.includes('session.jsonl')) as HTMLInputElement
    expect(input, 'File Path 输入框未找到').toBeTruthy()
    setInputValue(input, '/tmp/cpx-ses_badfile.jsonl')
    await flush(100)
    await aclick(findButtonByText('Import', true))
    await flush(300)

    const bodyText = document.body.textContent ?? ''
    expect(bodyText).toContain(LOCAL_ERROR)
    expect(bodyText).toContain('Failed')

    // 越过 1s 自动关闭窗口后仍驻留
    await flush(1600)
    expect(document.body.textContent ?? '').toContain(LOCAL_ERROR)
    expect(reloadSpy).not.toHaveBeenCalled()
    expect(findButtonByText('Done')).toBeTruthy()
  })
})
