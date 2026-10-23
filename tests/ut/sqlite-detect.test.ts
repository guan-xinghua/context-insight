// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// SQLite 来源嗅探 IT：单一 SQLite 导入入口靠 schema 区分 opencode 库
// （小写表 session/message/part）与 context-insight 导出库（Prisma 大写表
// "Session"/"Turn"），路由层据此纠正用户选错的 source。
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import Database from "better-sqlite3"
import { NextRequest } from "next/server"
import { detectSqliteSource } from "@/lib/ingest/sqlite-detect"
import { POST as listSessionsRoute } from "@/app/api/ingest/import-file/sessions/route"

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-detect-"))
const opencodeDb = path.join(tmpDir, "sessions.db")
const opencodeV2Db = path.join(tmpDir, "opencode-v2.db")
const insightDb = path.join(tmpDir, "renamed-not-cannbot-prefix.db")

beforeAll(() => {
  const oc = new Database(opencodeDb)
  oc.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, version TEXT, time_created INTEGER);
    CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, time_created INTEGER);
    CREATE TABLE part (id TEXT, message_id TEXT);
  `)
  oc.prepare("INSERT INTO session (id, parent_id, title, version, time_created) VALUES ('ses_it_1', NULL, 't', 'v', 1000)").run()
  oc.close()

  // opencode 2.x schema: session table renamed to session_v2 (no legacy
  // session/message/part tables exist in this generation)
  const oc2 = new Database(opencodeV2Db)
  oc2.exec(`
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, version TEXT, time_created INTEGER);
    CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, data TEXT, time_created INTEGER);
  `)
  oc2.prepare("INSERT INTO session_v2 (id, parent_id, title, version, time_created) VALUES ('ses_it_v2_1', NULL, 't', '2.0.18', 1000)").run()
  oc2.close()

  const ci = new Database(insightDb)
  ci.exec(`
    CREATE TABLE "Session" (
      id TEXT PRIMARY KEY,
      taskId TEXT NOT NULL,
      query TEXT,
      model TEXT,
      startTime TEXT NOT NULL,
      endTime TEXT,
      totalLlmCallCount INTEGER NOT NULL DEFAULT 0,
      totalTokens INTEGER NOT NULL DEFAULT 0,
      version TEXT
    );
  `)
  ci.prepare(
    `INSERT INTO "Session" (id, taskId, query, model, startTime, endTime, totalLlmCallCount, totalTokens, version)
     VALUES ('cms_it_1', 'task-it-1', 'insight 归档会话', 'glm-5.2', '2026-08-18T10:00:00.000Z', NULL, 3, 500, NULL)`
  ).run()
  ci.close()
})

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe("detectSqliteSource（schema 嗅探）", () => {
  it("opencode 库（小写 session 表）→ opencode-db", () => {
    expect(detectSqliteSource(opencodeDb)).toBe("opencode-db")
  })

  it("opencode 2.x 库（session_v2 表，无 v1 session 表）→ opencode-db", () => {
    expect(detectSqliteSource(opencodeV2Db)).toBe("opencode-db")
  })

  it("context-insight 导出库（大写 Session 表）→ context-insight，与文件名无关", () => {
    expect(detectSqliteSource(insightDb)).toBe("context-insight")
  })

  it("缺失文件 / 非 sqlite 内容 / 无特征表 → null", () => {
    expect(detectSqliteSource(path.join(tmpDir, "nope.db"))).toBeNull()
    const garbage = path.join(tmpDir, "garbage.db")
    fs.writeFileSync(garbage, "not a sqlite file")
    expect(detectSqliteSource(garbage)).toBeNull()
    const empty = path.join(tmpDir, "empty.db")
    new Database(empty).close()
    expect(detectSqliteSource(empty)).toBeNull()
  })
})

describe("import-file/sessions 路由自动纠正", () => {
  const req = (body: object) =>
    new NextRequest("http://localhost/api/ingest/import-file/sessions", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    })

  it("source 选 opencode-db 但文件是 insight 归档库 → 按内容纠正并返回其 sessions", async () => {
    const res = await listSessionsRoute(req({ source: "opencode-db", filePath: insightDb }))
    expect(res.status).toBe(200)
    const data = await res.json()
    const ids = (data.sessions ?? []).map((s: { id: string }) => s.id)
    // context-insight adapter 的 SessionListItem.id = taskId
    expect(ids).toContain("task-it-1")
  })

  it("source 选 context-insight 但文件是 opencode 库 → 同样纠正", async () => {
    const res = await listSessionsRoute(req({ source: "context-insight", filePath: opencodeDb }))
    expect(res.status).toBe(200)
    const data = await res.json()
    const ids = (data.sessions ?? []).map((s: { id: string }) => s.id)
    expect(ids).toContain("ses_it_1")
  })

  it("source 选 context-insight 但文件是 opencode 2.x 库 → 同样纠正并列出会话", async () => {
    const res = await listSessionsRoute(req({ source: "context-insight", filePath: opencodeV2Db }))
    expect(res.status).toBe(200)
    const data = await res.json()
    const ids = (data.sessions ?? []).map((s: { id: string }) => s.id)
    expect(ids).toContain("ses_it_v2_1")
  })
})
