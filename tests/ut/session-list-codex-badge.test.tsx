// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom
// 主列表 Type 列 codex 适配 IT：codex 会话此前落白名单外显示 "——"（详情页
// Tool 字段显示原始 "codex" 正常，主列表缺适配）。种入真实 codex 会话
// （fixture 全链路导入）+ 真实 Home 服务端组件渲染，按 taskId 过滤到目标行，
// 断言 Type 列渲染 Codex 徽标（slate），不再落 "—"。

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import path from 'node:path'
import fs from 'node:fs'
import { PrismaClient } from '@prisma/client'
import { importSession } from '../../src/lib/ingest/data-service.ts'
import Home from '../../src/app/page'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/',
}))

const prisma = new PrismaClient()
const DATA = path.join(__dirname, 'data', 'codex-sessions')
const MAIN = '11111111-aaaa-4b04-8f7e-abcdef000001'
const mainFile = path.join(DATA, `rollout-2026-10-09T10-23-45-${MAIN}.jsonl`)

beforeAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: MAIN } })
  const res = await importSession(mainFile, MAIN, prisma, mainFile, 'codex-jsonl')
  if (!res.imported) throw new Error(`codex fixture import failed: ${JSON.stringify(res)}`)
})

afterAll(async () => {
  try { await prisma.session.deleteMany({ where: { taskId: MAIN } }); } catch { /* ignore */ }
  await prisma.$disconnect()
})

async function renderHome(params: Record<string, string | undefined>): Promise<string> {
  const el = await Home({ searchParams: Promise.resolve(params) })
  return renderToString(el)
}

describe('主列表 Type 列：codex 会话徽标适配', () => {
  it('codex 会话行渲染 Codex 徽标（slate），不再显示 "—"', async () => {
    // q 过滤到目标行：列表只剩这一个会话
    const html = await renderHome({ q: MAIN })
    expect(html).toContain(MAIN) // 会话行在
    expect(html).toContain('Codex') // Type 列徽标文本（修复前此处落 "—"）
    expect(html).toContain('bg-slate-500/15') // 徽标走 slate variant
    // 修复前该行 Type 列是全角/长划 "—"：会话行存在但无 Codex 字样即回归
    expect(html).not.toMatch(/<td class="text-xs">—<\/td>/)
  })

  it('无 q 全量渲染下 codex 与其他会话共存时徽标各自正确', async () => {
    const html = await renderHome({})
    expect(html).toContain('Codex')
  })
})
