// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// import-from-cannbay 路由安全 IT：仓内提交的 symlink（词法 isPathInside 拦不住，
// existsSync/Database 均跟随链接）必须被真实路径校验拒绝——sink 不得触达克隆
// 目录外的本地文件。与 security-guards.test.ts 的词法遍历用例成对。

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// 路由在模块加载时读取 CANNBAY_CACHE_DIR，须在 import 前指向隔离临时目录；
// 预置 .git 让 ensureCannbayClone 走 fetch 增量路径（不真 clone）。
const CLONE_DIR = path.join(os.tmpdir(), `cannbay-import-symlink-test-${process.pid}`);
const OUTSIDE_DIR = path.join(os.tmpdir(), `cannbay-import-outside-${process.pid}`);
for (const d of [CLONE_DIR, OUTSIDE_DIR]) fs.rmSync(d, { recursive: true, force: true });
fs.mkdirSync(path.join(CLONE_DIR, ".git"), { recursive: true });
fs.mkdirSync(OUTSIDE_DIR, { recursive: true });
fs.writeFileSync(path.join(OUTSIDE_DIR, "secret.db"), Buffer.from("secret"));
process.env.CANNBAY_CACHE_DIR = CLONE_DIR;

const execMock = vi.fn((_cmd: string, _args: string[]) => Buffer.alloc(0));
vi.mock("node:child_process", () => ({ execFileSync: execMock }));

const dbOpenedPaths: string[] = [];
const dbMock = vi.fn((p: string) => {
  dbOpenedPaths.push(p);
  return {
    prepare: () => ({ get: () => ({ taskId: "tid", query: "q" }) }),
    close: () => {},
  };
});
vi.mock("better-sqlite3", () => ({ default: dbMock }));

const importMock = vi.fn(async (_fullPath: string) => ({ sessionId: "tid", imported: true, query: "q" }));
vi.mock("@/lib/ingest/data-service", () => ({ importSession: importMock }));

vi.mock("@/lib/db", () => ({ prisma: {} }));

const { POST } = await import("@/app/api/ingest/import-from-cannbay/route");

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/ingest/import-from-cannbay", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

afterAll(() => {
  for (const d of [CLONE_DIR, OUTSIDE_DIR]) fs.rmSync(d, { recursive: true, force: true });
});

describe("import-from-cannbay · symlink 逃逸", () => {
  beforeEach(() => {
    execMock.mockReset();
    execMock.mockImplementation(() => Buffer.alloc(0));
    dbMock.mockClear();
    dbOpenedPaths.length = 0;
    importMock.mockClear();
    fs.rmSync(CLONE_DIR, { recursive: true, force: true });
    fs.mkdirSync(path.join(CLONE_DIR, ".git"), { recursive: true });
  });

  it("仓内 symlink 指向克隆目录外 → 拒绝导入，不开库不触 importSession", async () => {
    fs.mkdirSync(path.join(CLONE_DIR, "evil"), { recursive: true });
    fs.symlinkSync(path.join(OUTSIDE_DIR, "secret.db"), path.join(CLONE_DIR, "evil", "x.db"));

    const res = await POST(makeRequest({ action: "import", filenames: ["evil/x.db"] }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.results[0].imported).toBe(false);
    expect(json.results[0].error).toContain("Invalid filename");
    expect(dbOpenedPaths).toEqual([]);
    expect(importMock).not.toHaveBeenCalled();
  });

  it("克隆内普通 .db 正常导入（正对照，守卫不误伤）", async () => {
    fs.writeFileSync(path.join(CLONE_DIR, "ok.db"), Buffer.from("db"));

    const res = await POST(makeRequest({ action: "import", filenames: ["ok.db"] }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.results[0].imported).toBe(true);
    expect(dbOpenedPaths).toEqual([path.join(CLONE_DIR, "ok.db")]);
    expect(importMock).toHaveBeenCalledTimes(1);
    expect(importMock.mock.calls[0][0]).toBe(path.join(CLONE_DIR, "ok.db"));
  });

  it("list 不列出 symlink 条目（仅物化后的普通文件可见）", async () => {
    fs.symlinkSync(path.join(OUTSIDE_DIR, "secret.db"), path.join(CLONE_DIR, "link.db"));
    fs.writeFileSync(path.join(CLONE_DIR, "real.db"), Buffer.from("db"));

    const res = await POST(makeRequest({ action: "list" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    const names = json.sessions.map((s: { filename: string }) => s.filename);
    expect(names).toContain("real.db");
    expect(names).not.toContain("link.db");
  });
});
