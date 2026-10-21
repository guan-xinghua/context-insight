// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Mate 评审 GUIDE 读取兜底 IT：
//   现场（npm 安装）构建产物 .next/server/assets/GUIDE.<hash>.md 缺失
//   （包不带 .next、首启现场构建，构建中断/损坏）时，五维评审曾整片
//   ENOENT 失败（现场案例：node_modules/cannbot-insight/.next/server/
//   assets/GUIDE.05zsj0zhcfc4-.md 不存在）。src/ 随包发布——回落源文件，
//   且兜底命中必须 logWarn 留痕（cbi -f 重建的行动信号，不静默带病跑）。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'node:path'
import { readGuide, readGuideFile } from '@/lib/scoring/mate-agent/runner'

const warnMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>()
  return { ...actual, logWarn: warnMock }
})

const SRC_GUIDE = path.resolve(__dirname, '../../src/lib/scoring/mate-agent/GUIDE.md')

beforeEach(() => warnMock.mockClear())

describe('Mate Agent GUIDE 读取兜底', () => {
  it('主路径存在 → 直接读主路径（vitest 下主路径即源文件），不告警', async () => {
    const text = await readGuide()
    expect(text).toContain('评审')
    expect(warnMock).not.toHaveBeenCalled()
  })

  it('主路径缺失（.next asset 损坏场景）→ 回落随包源文件 + logWarn 留痕', async () => {
    const text = await readGuideFile(
      '/nonexistent/.next/server/assets/GUIDE.05zsj0zhcfc4-.md',
      SRC_GUIDE,
    )
    expect(text.length).toBeGreaterThan(100)
    expect(text).toContain('Mate Agent')
    expect(warnMock).toHaveBeenCalledTimes(1)
    expect(String(warnMock.mock.calls[0])).toContain('cbi -f')
  })

  it('双路径都缺失 → 仍抛错（如实暴露安装损坏，不静默空内容）', async () => {
    await expect(
      readGuideFile('/nonexistent/a.md', '/nonexistent/b.md'),
    ).rejects.toThrow(/ENOENT/)
  })
})
