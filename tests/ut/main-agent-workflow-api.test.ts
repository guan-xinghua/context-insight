// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { describe, it, expect, vi, beforeEach } from "vitest"

const fakePrisma = {
  session: { findFirst: vi.fn() },
  skillEvent: { findFirst: vi.fn() },
  toolCall: { findMany: vi.fn() },
  turn: { findFirst: vi.fn() },
}
vi.mock("@/lib/db", () => ({ prisma: fakePrisma }))

const { GET } = await import("@/app/api/observe/session/main-agent-workflow/route")

function makeRequest(qs: string): Request {
  return new Request(`http://localhost/api/observe/session/main-agent-workflow?${qs}`)
}

const RESOURCE_BODY = "# Task 调用参数\n\n## 1.1 开发准备\n\n- [ ] 开发日志已创建\n- [ ] 问题目录已创建\n- [ ] 环境检查已执行\n" + "x".repeat(120)
const STATE_BODY = "# STATE\n\n## Tasks\n\n- [ ] 1. 派发 developer\n- [ ] 2. 验收 st-verifier\n- [ ] 3. 收尾归档\n" + "y".repeat(120)
const TURN0_BODY = "# 基于 ACLNN 的算子开发工作流\n\n你是纯编排者（Orchestrator），读取 STATE.md 按顺序派发 SubAgent。" + "x".repeat(500)

describe("main-agent-workflow route（root 组合声明可用性）", () => {
  beforeEach(() => {
    fakePrisma.session.findFirst.mockReset()
    fakePrisma.skillEvent.findFirst.mockReset()
    fakePrisma.toolCall.findMany.mockReset()
    fakePrisma.turn.findFirst.mockReset()
    fakePrisma.session.findFirst.mockResolvedValue({ id: "ses_cuid_1" })
  })

  it("缺 taskId → 400", async () => {
    const res = await GET(makeRequest(""))
    expect(res.status).toBe(400)
  })

  it("session 不存在 → 404", async () => {
    fakePrisma.session.findFirst.mockResolvedValue(null)
    const res = await GET(makeRequest("taskId=ses_1"))
    expect(res.status).toBe(404)
  })

  it("双层（resources 规程 + STATE.md 计划）→ available + name + 组合 source", async () => {
    // skillEvent.findFirst 被调两次（组合声明内部 resolveWorkflowSkillName + 路由取 name）→ 持久 mock
    fakePrisma.skillEvent.findFirst.mockResolvedValue({ skillName: "ops-registry-invoke-workflow" })
    fakePrisma.toolCall.findMany
      .mockResolvedValueOnce([
        { toolName: "read", argsJson: '{"filePath":"/x/ops-registry-invoke-workflow/resources/task-prompts.md"}', resultJson: `<content>${RESOURCE_BODY}</content>` },
      ])
      .mockResolvedValueOnce([
        { toolName: "read", argsJson: '{"filePath":"/repo/STATE.md"}', resultJson: `<content>${STATE_BODY}</content>` },
      ])
    const res = await GET(makeRequest("taskId=ses_1"))
    expect(res.status).toBe(200)
    const d = await res.json()
    expect(d.available).toBe(true)
    expect(d.name).toBe("ops-registry-invoke-workflow")
    expect(d.source).toBe("规程: task-prompts.md + 计划: STATE.md")
  })

  it("仅计划层（无 invoke、turn0 短）→ available（root 回归 STATE.md-only session）", async () => {
    fakePrisma.skillEvent.findFirst.mockResolvedValue(null)
    fakePrisma.toolCall.findMany.mockResolvedValue([
      { toolName: "read", argsJson: '{"filePath":"/repo/STATE.md"}', resultJson: `<content>${STATE_BODY}</content>` },
    ])
    fakePrisma.turn.findFirst.mockResolvedValue({ content: "短任务" })
    const res = await GET(makeRequest("taskId=ses_1"))
    expect(res.status).toBe(200)
    const d = await res.json()
    expect(d.available).toBe(true)
    expect(d.name).toBe("主 agent 编排")
    expect(d.source).toBe("STATE.md")
  })

  it("仅规程层（turn0 注入、无计划）→ available + turn0 source", async () => {
    fakePrisma.skillEvent.findFirst.mockResolvedValue(null)
    fakePrisma.toolCall.findMany.mockResolvedValue([])
    fakePrisma.turn.findFirst.mockResolvedValue({ content: TURN0_BODY })
    const res = await GET(makeRequest("taskId=ses_1"))
    const d = await res.json()
    expect(d.available).toBe(true)
    expect(d.source).toBe("turn0 (注入编排规程)")
  })

  it("两层皆无 → available=false", async () => {
    fakePrisma.skillEvent.findFirst.mockResolvedValue(null)
    fakePrisma.toolCall.findMany.mockResolvedValue([])
    fakePrisma.turn.findFirst.mockResolvedValue({ content: "短" })
    const res = await GET(makeRequest("taskId=ses_1"))
    const d = await res.json()
    expect(d.available).toBe(false)
    expect(d.name).toBeNull()
    expect(d.source).toBeNull()
  })
})
