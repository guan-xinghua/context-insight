// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom
// 数据仓同 sid 双记录导入 UI IT：sid@recording 复合键只用于选择集与状态
// 更新定位，真实 sid 一律流入消费路径——
//   ① 双记录条目（capture + native）勾选导入 → 导入中列表 label 匹配
//      importedPreviews（按真实 sid），显示导入结果的 firstQuery 而非裸
//      复合键；recording 标记可见（·capture / ·native）
//   ② handleDone 写入 ImportHistory：taskId = 真实 sid（无 @ 后缀——
//      delete-session/dbMeta 消费方按裸 sid 查行）、filePath 目录形态按
//      记录类（capture=<sid> / native=<sid>.native）
//   ③ 全选 checkbox 键与行选择一致（同 sid 双记录两条目各自独立勾选）

import { describe, it, expect, afterEach, afterAll, beforeAll, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { LocalFileImport } from '@/components/LocalFileImport'
import { BAY_NAME } from '@/lib/branding'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SID = 'cc-dual-ui-0001'
const HISTORY_KEY = 'context-import-history'

let root: Root | null = null
// import action 请求体留档（断言 recording 定位参数）
const importBodies: Array<Record<string, unknown>> = []

const seedLakeConfig = (): void => {
  // 单源预检种子：fetch mock 已应答 /api/settings/lake-config（configured），
  // localStorage 不再参与远端决议（legacy 键残留无害）。fetch 全 mock 不触网
}

beforeAll(() => {
  localStorage.clear()
  // handleDone 完成后 window.location.reload()——测试环境替换为 spy
  vi.stubGlobal('location', { ...window.location, reload: vi.fn() })
  ;(globalThis as { fetch: typeof fetch }).fetch = (() => {
    const json = (data: unknown) => Promise.resolve(new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } }))
    return ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/api/settings/lake-config')) {
        return json({ configured: true, address: 'https://example.com/lake.git', branch: 'main' })
      }
      if (url.includes('/api/ingest/lake')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        if (body.action === 'list') {
          return json({
            dirs: ['dual-it'],
            sessions: [
              { sid: SID, recording: 'capture', fileCount: 2, author: 'a', submitter: '测试者', description: 'wire 捕获', commitTime: '2026-09-17T10:00:00Z', framework: 'claude-code', ccVersion: '2.1.0-claude-proxy', paradigm: 'dual-it' },
              { sid: SID, recording: 'native', fileCount: 2, author: 'a', submitter: '测试者', description: '原生会话', commitTime: '2026-09-17T09:00:00Z', framework: 'claude-code', ccVersion: null, paradigm: 'dual-it' },
            ],
          })
        }
        if (body.action === 'import') {
          importBodies.push(body)
          const isNative = body.recording === 'native'
          return json({ result: { sessionId: SID, imported: true, query: isNative ? 'native-q1' : 'wire-q1', framework: 'claude-code', version: isNative ? null : '2.1.0-claude-proxy' } })
        }
        return json({})
      }
      return json({})
    }) as typeof fetch
  })()
})

beforeAll(() => {
  seedLakeConfig()
})

afterAll(() => {
  localStorage.clear()
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  importBodies.length = 0
  localStorage.clear()
  seedLakeConfig()
})

async function flush(ms = 1400): Promise<void> {
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

/** 行 checkbox：数据仓会话表内第一列（全选 checkbox 在表格外，用 role 定位行内） */
function rowCheckboxes(): HTMLInputElement[] {
  return [...document.querySelectorAll('[data-slot="dialog-content"] table tbody tr [role="checkbox"]')] as HTMLInputElement[]
}

/** 渲染 + 打开对话框 + 选数据仓源（点击即拉取列表）+ 进范式会话表 */
async function openLakeTable(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(createElement(LocalFileImport)) })
  await flush(150)
  await aclick(findButtonByText('Import Session'))
  await flush(150)
  // 点 lake 源按钮即触发 handleOpenLake（拉列表）→ 范式选择步；
  // 范式按钮文本带会话计数（如 "dual-it2"），用包含匹配
  await aclick(findButtonByText(BAY_NAME, true))
  await flush(250)
  await aclick(findButtonByText('dual-it'))
  await flush(150)
}

describe('数据仓同 sid 双记录导入（复合键不外泄）', () => {
  it('双记录勾选导入：label 按真实 sid 匹配 + history taskId/filePath 走真实 sid', async () => {
    await openLakeTable()

    // 同 sid 两条目：行 checkbox 各自独立勾选
    const boxes = rowCheckboxes()
    expect(boxes.length).toBe(2)
    await aclick(boxes[0])
    await aclick(boxes[1])
    await flush(100)
    // 请求体按各自记录类定位
    await aclick(findButtonByText('Import 2 Selected'))
    // 自动 handleDone（完成 +1s）前截取导入中列表：label 按记录类匹配各自
    // 的 preview（同 sid 双 preview 共享 id，只按 id 查会两条都显示第一条的
    // firstQuery）；复合键不得外泄（裸显 sid@recording 即泄漏）
    await flush(300)
    const bodyText = document.body.textContent ?? ''
    expect(bodyText).toContain('·capture')
    expect(bodyText).toContain('·native')
    expect(bodyText).not.toContain(`${SID}@capture`)
    expect(bodyText).not.toContain(`${SID}@native`)
    // 等 handleDone（完成 +1s 自动触发）写完 history
    await flush(1600)

    // import 请求体：sid = 真实 sid（无 @），recording 各自带
    expect(importBodies.length).toBe(2)
    for (const b of importBodies) {
      expect(b.sid).toBe(SID)
    }
    expect(importBodies.some(b => b.recording === 'capture')).toBe(true)
    expect(importBodies.some(b => b.recording === 'native')).toBe(true)

    // handleDone 写入 history：taskId = 真实 sid、filePath 目录形态按记录类
    const history = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') as Array<{ taskId: string; filePath: string | null; query: string | null }>
    expect(history.length).toBe(2)
    expect(history.every(e => e.taskId === SID)).toBe(true) // delete-session/dbMeta 按裸 sid 消费
    // query 按记录类各归各（同 sid 双 preview 按 recording 匹配，不串第一条）
    expect(history.some(e => e.query === 'wire-q1')).toBe(true)
    expect(history.some(e => e.query === 'native-q1')).toBe(true)
    // filePath 目录 = 范式目录 + 记录类目录形态（默认仓条目实际位于
    // <paradigm>/<sid>[.native]/——显示 sessions/ 是假路径）
    const paths = history.map(e => e.filePath ?? '')
    expect(paths.some(p => p.endsWith(`dual-it/${SID}.native`))).toBe(true)
    expect(paths.some(p => p.endsWith(`dual-it/${SID}`))).toBe(true)
  })

  it('全选 checkbox 键与行选择一致（双记录独立全选/取消）', async () => {
    await openLakeTable()

    // 全选（表格外的主 checkbox）
    const selectAll = [...document.querySelectorAll('[data-slot="dialog-content"] [role="checkbox"]')]
      .find(c => !c.closest('tr')) as HTMLInputElement
    expect(selectAll).toBeTruthy()
    await aclick(selectAll)
    await flush(100)
    // 两行都被勾上（旧实现按裸 sid 增删，与行键 sid@recording 不匹配）
    const boxes = rowCheckboxes()
    expect(boxes.length).toBe(2)
    expect(boxes.every(b => b.getAttribute('aria-checked') === 'true')).toBe(true)

    // 再点全选 → 全部取消
    await aclick(selectAll)
    await flush(100)
    expect(rowCheckboxes().some(b => b.getAttribute('aria-checked') === 'true')).toBe(false)
  })
})
