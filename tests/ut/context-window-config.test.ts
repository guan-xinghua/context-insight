// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License).
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 内置表解析 IT：chdir 到空目录 + resetConfigCache，脱离本机 context-windows.json
// 本地覆盖（该文件按设计被 gitignore、各机器内容不一），只锁内置表行为。
import { describe, it, expect, beforeEach, afterAll } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { getContextWindowLimit, resetConfigCache } from "../../src/lib/context-window-config.ts"

describe("getContextWindowLimit 内置表解析", () => {
  const origCwd = process.cwd()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctxwin-"))

  beforeEach(() => {
    process.chdir(tmp)
    resetConfigCache()
  })

  afterAll(() => {
    process.chdir(origCwd)
    resetConfigCache()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("glm 家族：全系 1M（5 / 5.1 曾误标 200K）", () => {
    expect(getContextWindowLimit("glm-5")).toBe(1_000_000)
    expect(getContextWindowLimit("glm-5.1")).toBe(1_000_000)
    expect(getContextWindowLimit("glm-5.2")).toBe(1_000_000)
    expect(getContextWindowLimit("glm-5.3")).toBe(1_000_000)
  })

  it("gpt-6-astra = 1.05M（未登记时曾落 200K fallback 高估占比 5 倍）", () => {
    expect(getContextWindowLimit("gpt-6-astra")).toBe(1_050_000)
  })

  it("未登记型号走子串兜底：glm-5.9 → glm-5 的 1M（先于 fallback 默认命中）", () => {
    expect(getContextWindowLimit("glm-5.9")).toBe(1_000_000)
  })

  it("横线 snapshot id：glm-5-2-260617 → 1M（现场 opencode-proxy 会话曾落 glm-5 子串，141.6% 假超限）", () => {
    expect(getContextWindowLimit("glm-5-2-260617")).toBe(1_000_000)
  })

  it("完全未登记型号与 null model 走 fallback 默认 1M", () => {
    expect(getContextWindowLimit("zzz-unknown-999")).toBe(1_000_000)
    expect(getContextWindowLimit(null)).toBe(1_000_000)
  })

  it("带日期后缀命中长键：glm-5.3-20260101 → 1M（不被短键 glm-5 遮蔽成 200K）", () => {
    expect(getContextWindowLimit("glm-5.3-20260101")).toBe(1_000_000)
  })

  it("vendor 前缀路径形态：openrouter/glm-5.3 → 1M", () => {
    expect(getContextWindowLimit("openrouter/glm-5.3")).toBe(1_000_000)
  })
})
