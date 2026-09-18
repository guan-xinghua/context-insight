// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the License).
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// audit-session-py 路由 IT：smart-agent 运行中守卫（409）透传、上游错误、
// NDJSON 正常透传、provider 缺失 400。mock prisma + 导出器 + global.fetch，
// 走完整 route POST 数据流（与 Python 侧 smart-agent/tests/test_server.py 的
// 409 守卫用例成对——两侧口径改动必须同步）。

import { describe, it, expect, vi, beforeEach } from "vitest"

const { exportMock, agentIoMock } = vi.hoisted(() => ({
  exportMock: vi.fn(),
  agentIoMock: vi.fn(),
}))

vi.mock("@/lib/db", () => ({
  prisma: { session: { findFirst: vi.fn() }, turn: { findMany: vi.fn() }, interactionBridge: { findMany: vi.fn() } },
}))
vi.mock("@/lib/export/markdown-exporter", () => ({ exportSessionToMarkdown: exportMock }))
vi.mock("@/lib/export/agent-io-export", () => ({ buildAgentIO: agentIoMock }))

const { POST } = await import("@/app/api/ai/audit-session-py/route")

const PROVIDER = { baseUrl: "http://llm.test/v1", apiKey: "k", model: "m" }

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/ai/audit-session-py", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  exportMock.mockReset().mockResolvedValue("trajectory text")
  agentIoMock.mockReset().mockResolvedValue({ agents: [] })
})

describe("audit-session-py 路由", () => {
  it("smart-agent 409（同 session 运行中守卫）→ 原样透传 409 与错误消息", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "该 session 的上一轮审计仍在进行中（已运行约 3.2 分钟），请等待完成后再生成" }), { status: 409 }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const res = await POST(makeRequest({ taskId: "t1", provider: PROVIDER, mode: "agent" }))
    expect(res.status).toBe(409)
    const data = await res.json()
    expect(data.error).toContain("仍在进行中")
    vi.unstubAllGlobals()
  })

  it("上游 500 → 500（不误吞成 409）", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "boom" }), { status: 500 }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const res = await POST(makeRequest({ taskId: "t1", provider: PROVIDER }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("boom")
    vi.unstubAllGlobals()
  })

  it("上游 NDJSON 流 → Content-Type/正文透传", async () => {
    const ndjson = '{"stage":"compress-done"}\n{"stage":"result"}\n'
    const fetchMock = vi.fn().mockResolvedValue(new Response(ndjson, { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)

    const res = await POST(makeRequest({ taskId: "t1", provider: PROVIDER }))
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toContain("application/x-ndjson")
    expect(await res.text()).toBe(ndjson)
    vi.unstubAllGlobals()
  })

  it("provider 缺失 → 400，不触达上游", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const res = await POST(makeRequest({ taskId: "t1", provider: { baseUrl: "http://x" } }))
    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it("taskId 含路径分隔符 → 400，不触达导出器/上游（0000026 修复）", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const res = await POST(makeRequest({ taskId: "x/../../../tmp/evil", provider: PROVIDER, mode: "agent" }))
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toContain("Invalid taskId")
    expect(exportMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it("v4 模式先做确定性 agent-IO 提取再打上游", async () => {
    agentIoMock.mockResolvedValue({ agents: [{ id: "main" }, { id: "sub-1" }] })
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"stage":"result"}\n', { status: 200 }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const res = await POST(makeRequest({ taskId: "t1", provider: PROVIDER, mode: "v4" }))
    expect(res.status).toBe(200)
    expect(agentIoMock).toHaveBeenCalledWith("t1", expect.anything(), undefined)
    const upstreamBody = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body)
    expect(upstreamBody.mode).toBe("v4")
    expect(upstreamBody.agentIo.agents).toHaveLength(2)
    vi.unstubAllGlobals()
  })
})
