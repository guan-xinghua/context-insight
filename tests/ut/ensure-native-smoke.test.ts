// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License).
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// ensure-native 自愈链路的离线确定性 IT（零网络/零工具链依赖）：pretest 已保证
// 二进制新鲜（本文件运行时 better-sqlite3 必然健康），据此锁三个隐含契约：
//   ① childSmoke 生成的源码是合法 ESM 且真实加载二进制（spawn exit 0）
//   ② --input-type=module -e 裸导入按 cwd 解析——守卫只在 pretest 把 cwd
//      固定为包目录时成立；离开包目录必须失败（假设变化时此用例报警）
//   ③ 进程内 probe 与子进程 childSmoke 是两份手写冒烟，双轨必须同健康
//      （同步此前只靠注释里一句 "Keep the two in sync"）
import { describe, it, expect } from "vitest"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { NATIVES, smokeProbe } from "../../scripts/ensure-native.mjs"

// 子进程冒烟本体 <1s（spawn + 裸导入 + 内存库三查询）；60s 仅作容错上限——
// 环境异常应显式报错，而不是挂到 vitest 全局超时才死
const SPAWN_SMOKE_TIMEOUT_MS = 60_000

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PKG_DIR = path.resolve(__dirname, "../..")

function sqliteNative() {
  const native = NATIVES.find((n) => n.name === "better-sqlite3")
  expect(native, "NATIVES 里应注册 better-sqlite3").toBeTruthy()
  return native!
}

describe("ensure-native 子进程冒烟契约（离线）", () => {
  it("childSmoke 源码在包目录 cwd 下 spawn exit 0：合法 ESM + 二进制真实可加载", () => {
    const native = sqliteNative()
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", native.childSmoke(native.name)], {
      cwd: PKG_DIR,
      encoding: "utf8",
    })
    expect(r.status, `子进程 stderr:\n${r.stderr}`).toBe(0)
  }, SPAWN_SMOKE_TIMEOUT_MS)

  it("cwd 离开包目录裸导入即失败：守护「-e 裸导入按 cwd 解析」的前提", () => {
    const native = sqliteNative()
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ensure-native-cwd-"))
    try {
      const r = spawnSync(process.execPath, ["--input-type=module", "-e", native.childSmoke(native.name)], {
        cwd: tmp,
        encoding: "utf8",
      })
      expect(r.status, "裸导入应按 cwd 解析而失败；若 exit 0 说明解析前提已变化（如 Node 改了 -e 解析）").not.toBe(0)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }, SPAWN_SMOKE_TIMEOUT_MS)

  it("进程内 probe 与子进程 childSmoke 双轨同健康（两份手写冒烟不漂移）", async () => {
    const native = sqliteNative()
    const mod = await import("better-sqlite3")
    await native.probe(mod)
    const probe = smokeProbe(native)
    expect(probe.ok, `子进程冒烟失败:\n${probe.err}`).toBe(true)
  }, SPAWN_SMOKE_TIMEOUT_MS)
})
