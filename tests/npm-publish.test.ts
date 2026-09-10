// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// npm 发布就绪 IT：发布到公共 registry 前，用 `npm pack --dry-run`（零网络、零落盘）
// 从 npm 的真实视角验证将要发布的包内容与元数据——
//   ① 产物清单：bin 启动器 / postinstall / 源码 / prisma schema / export-view bundle / LICENSE 在包内
//   ② 裁剪生效：tests / docs / 运行时数据 / lockfile 不进包（.npmignore 兜住）
//   ③ package.json 发布就绪：无 private、版本与展示版本单一源 version.ts 单轨一致、
//      bin（cannbot-insight/cbi）与 postinstall 钩子齐备
//   ④ package-lock.json 顶部版本与 package.json 同值（单轨不漂移）

import { describe, it, expect } from "vitest"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { VERSION } from "../src/lib/version"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PKG_DIR = path.resolve(__dirname, "..")

const pkgJson = JSON.parse(fs.readFileSync(path.join(PKG_DIR, "package.json"), "utf8"))
const lockJson = JSON.parse(fs.readFileSync(path.join(PKG_DIR, "package-lock.json"), "utf8"))

interface PackFile { path: string; size: number }

function packDryRun(): PackFile[] {
  const r = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: PKG_DIR,
    encoding: "utf8",
    timeout: 120_000,
  })
  if (r.status !== 0) {
    throw new Error(`npm pack --dry-run 失败:\n${r.stderr}\n${r.stdout}`)
  }
  const parsed = JSON.parse(r.stdout) as Array<{ files: PackFile[] }>
  expect(parsed.length).toBe(1)
  return parsed[0].files
}

describe("npm publish readiness (npm pack --dry-run)", () => {
  it("产物含运行必需文件：bin 启动器 / postinstall / 源码 / prisma / export-view / LICENSE / CLI bundle", () => {
    const files = packDryRun().map((f) => f.path)
    for (const must of [
      "bin/cannbot-insight.mjs",
      "scripts/postinstall.mjs",
      "src/lib/version.ts",
      "src/lib/ingest/adapters/claude-jsonl.ts",
      "prisma/schema.prisma",
      "public/export-view.js",
      "dist/cli.mjs",
      "LICENSE",
      "README.md",
    ]) {
      expect(files, `缺少发布必需文件: ${must}`).toContain(must)
    }
  }, 120_000)

  it("裁剪生效：tests/docs/运行时数据/lockfile 不进包", () => {
    const files = packDryRun().map((f) => f.path)
    const forbidden = (p: string) =>
      p === "tests" || p.startsWith("tests/") ||
      p === "docs" || p.startsWith("docs/") ||
      p === ".env" ||
      p.endsWith("dev.db") || p.endsWith("dev.db-journal") ||
      p === "package-lock.json" ||
      p === ".next" || p.startsWith(".next/")
    const leaked = files.filter(forbidden)
    expect(leaked, `以下文件不应进包: ${leaked.join(", ")}`).toEqual([])
  }, 120_000)

  it("package.json 发布就绪：无 private、版本单轨、bin 与 postinstall 齐备", () => {
    expect(pkgJson.private, "private:true 会阻断 npm publish").toBeUndefined()
    expect(pkgJson.version, "package.json 版本须与展示版本单一源 version.ts 同值（单轨）").toBe(VERSION)
    expect(pkgJson.bin).toMatchObject({
      "cannbot-insight": "./bin/cannbot-insight.mjs",
      "cbi": "./bin/cannbot-insight.mjs",
    })
    expect(pkgJson.scripts?.postinstall).toBe("node scripts/postinstall.mjs")
    expect(pkgJson.license).toBeTruthy()
    expect(pkgJson.engines?.node).toMatch(/>=20/)
  }, 120_000)

  it("package-lock.json 顶部版本与 package.json 同值（单轨不漂移）", () => {
    expect(lockJson.version).toBe(pkgJson.version)
    expect(lockJson.packages?.[""]?.version).toBe(pkgJson.version)
  })

  it("CLI bundle 可运行：dist/cli.mjs --version 输出与展示版本一致（node_modules 内别名免疫）", () => {
    const build = spawnSync(process.execPath, ["scripts/build-cli.mjs"], { cwd: PKG_DIR, encoding: "utf8", timeout: 120_000 })
    expect(build.status, `build-cli.mjs 失败:\n${build.stderr}`).toBe(0)
    const r = spawnSync(process.execPath, ["dist/cli.mjs", "--version"], { cwd: PKG_DIR, encoding: "utf8", timeout: 60_000 })
    expect(r.status, `dist/cli.mjs --version 失败:\n${r.stderr}`).toBe(0)
    expect(r.stdout.trim()).toBe(VERSION)
  }, 120_000)
})
