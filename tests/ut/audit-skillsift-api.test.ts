// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { describe, it, expect, vi, beforeEach } from "vitest"
import fs from "node:fs"
import path from "node:path"

const FAKE_REPORT = {
  skill_name: "acme-crash-debug",
  transcript_sources: ["opencode"],
  summary: { total: 2, pass: 1, fail: 1, na: 0 },
  findings: [
    { instruction_text: "do x", source: "STEP", verdict: "PASS", method: "LLM", category: "step", evidence: "ok", seq: 0 },
  ],
}

let lastWrittenSkillMd: string | null = null

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock("node:child_process", () => ({ spawn: spawnMock }))

const { llmExtractMock } = vi.hoisted(() => ({ llmExtractMock: vi.fn() }))
vi.mock("@/lib/llm-workflow-extract", () => ({ llmExtractWorkflowDeclaration: llmExtractMock }))

const fakePrisma = {
  session: { findFirst: vi.fn() },
  skillEvent: { findFirst: vi.fn(), findMany: vi.fn() },
  interactionBridge: { findMany: vi.fn() },
  toolCall: { findMany: vi.fn() },
  turn: { findMany: vi.fn(), findFirst: vi.fn() },
}
vi.mock("@/lib/db", () => ({ prisma: fakePrisma }))

const { POST } = await import("@/app/api/ai/audit-skillsift/route")

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/ai/audit-skillsift", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

/** 手写最小事件面（on/emit），与 node:events 的测试 mock 惯用法零重合。 */
class FakeStream {
  private readonly handlers = new Map<string, Array<(chunk: unknown) => void>>()
  on(event: string, fn: (chunk: unknown) => void): this {
    const list = this.handlers.get(event) ?? []
    list.push(fn)
    this.handlers.set(event, list)
    return this
  }
  emit(event: string, chunk?: unknown): void {
    for (const fn of this.handlers.get(event) ?? []) fn(chunk)
  }
}

/** spawn 桩用的假子进程：事件面 + 标准流，kill 只记标记。 */
class FakeChild extends FakeStream {
  readonly stdout = new FakeStream()
  readonly stderr = new FakeStream()
  killed = false
  kill(): boolean {
    this.killed = true
    return true
  }
}

/** 从 CLI 参数里取 -o 指定的输出目录。 */
function outputDirOf(args: string[]): string | undefined {
  for (let i = 0; i + 1 < args.length; i += 1) {
    if (args[i] === "-o") return args[i + 1]
  }
  return undefined
}

/** spawn 桩：伪造 sift CLI——抓取写入的 SKILL.md、往 -o 目录落假报告文件，随后异步收尾 close 0。 */
function happySpawn() {
  return vi.fn((_cmd: string, args: string[]) => {
    const child = new FakeChild()
    setTimeout(() => {
      try {
        lastWrittenSkillMd = fs.readFileSync(path.join(args[1], "SKILL.md"), "utf8")
      } catch {
        lastWrittenSkillMd = null
      }
      const outDir = outputDirOf(args)
      if (outDir) {
        fs.mkdirSync(outDir, { recursive: true })
        fs.writeFileSync(path.join(outDir, "audit-report.json"), JSON.stringify(FAKE_REPORT))
        fs.writeFileSync(path.join(outDir, "audit-report.html"), "<!doctype html><body>STUB AUDIT HTML</body>")
      }
      child.emit("close", 0)
    }, 0)
    return child
  })
}

async function readNdjson(res: Response): Promise<unknown[]> {
  const text = await res.text()
  return text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
}

function seedSkillBody(): void {
  fakePrisma.skillEvent.findFirst.mockResolvedValue({ turnId: "t1" })
  fakePrisma.toolCall.findMany.mockResolvedValue([
    {
      toolName: "skill",
      argsJson: '{"name":"acme-crash-debug"}',
      resultJson: '<skill_content name="acme-crash-debug">BODY</skill_content>',
    },
  ])
}

describe("audit-skillsift route", () => {
  beforeEach(() => {
    lastWrittenSkillMd = null
    spawnMock.mockReset()
    llmExtractMock.mockReset()
    fakePrisma.session.findFirst.mockReset()
    fakePrisma.skillEvent.findFirst.mockReset()
    fakePrisma.skillEvent.findMany.mockReset().mockResolvedValue([])
    fakePrisma.interactionBridge.findMany.mockReset().mockResolvedValue([])
    fakePrisma.toolCall.findMany.mockReset()
    fakePrisma.turn.findMany.mockReset()
    fakePrisma.turn.findFirst.mockReset()
  })

  it("happy：恢复正文 → spawn sift → NDJSON result 事件", async () => {
    fakePrisma.session.findFirst.mockResolvedValue({ id: "ses_cuid_1", sourcePath: "/tmp/fake.db", framework: "opencode" })
    seedSkillBody()
    spawnMock.mockImplementation(happySpawn())

    const res = await POST(makeRequest({ taskId: "ses_1", skillName: "acme-crash-debug" }))
    expect(res.status).toBe(200)
    const events = await readNdjson(res)
    const last = events.at(-1) as { stage: string; report: { skill_name: string; summary: { fail: number } }; _html: string }
    expect(last.stage).toBe("result")
    expect(last.report.skill_name).toBe("acme-crash-debug")
    expect(last.report.summary.fail).toBe(1)
    expect(last._html).toContain("STUB AUDIT HTML")

    const [, args] = spawnMock.mock.calls[0]
    expect(args[0]).toBe("audit")
    expect(args).toContain("--db")
    expect(args).toContain("/tmp/fake.db")
    expect(args).toContain("--session")
    expect(args).toContain("ses_1")
    expect(lastWrittenSkillMd?.startsWith("---")).toBe(true)
    expect(lastWrittenSkillMd).toContain("name: acme-crash-debug")
    expect(lastWrittenSkillMd).toContain("BODY")
  })

  it("kind=root → skill resources 文件（task-prompts.md）恢复 → --kind root", async () => {
    const resourceContent = "# Task 调用参数\n\n## 1.1 开发准备\n\n- [ ] 开发日志已创建\n- [ ] 问题目录已创建\n- [ ] 环境检查已执行\n" + "x".repeat(120)
    fakePrisma.session.findFirst.mockResolvedValue({ id: "ses_cuid_1", sourcePath: "/tmp/fake.db", framework: "opencode" })
    fakePrisma.skillEvent.findFirst.mockResolvedValue({ skillName: "ops-registry-invoke-workflow" })
    fakePrisma.toolCall.findMany.mockResolvedValue([
      { toolName: "read", argsJson: '{"filePath":"/x/ops-registry-invoke-workflow/resources/task-prompts.md"}', resultJson: `<content>${resourceContent}</content>` },
    ])
    spawnMock.mockImplementation(happySpawn())

    const res = await POST(makeRequest({ taskId: "ses_1", skillName: "主 agent 编排", kind: "root" }))
    await readNdjson(res)
    expect(res.status).toBe(200)
    const [, args] = spawnMock.mock.calls[0]
    expect(args).toContain("--kind")
    expect(args[args.indexOf("--kind") + 1]).toBe("root")
    expect(lastWrittenSkillMd).toContain("开发准备")
    expect(lastWrittenSkillMd).toContain("name: main-agent-workflow")
    // resources 文件被计划层排除（skill 打包目录）→ 无计划层 → 单层直出，无分层标题
    expect(lastWrittenSkillMd).not.toContain("## 二、任务计划")
  })

  it("kind=root → 无 resources 文件 → 退 SKILL.md body（编排规程）", async () => {
    const skillBody = "# Skill: ops-registry-invoke-workflow\n\n## 核心原则\n\n- 测试驱动\n- 阶段递进\n- 阶段门控\n" + "x".repeat(120)
    fakePrisma.session.findFirst.mockResolvedValue({ id: "ses_cuid_1", sourcePath: "/tmp/fake.db", framework: "opencode" })
    // resolveWorkflowSkillName → skillName; recoverSkillBody → turnId
    fakePrisma.skillEvent.findFirst
      .mockResolvedValueOnce({ skillName: "ops-registry-invoke-workflow" })
      .mockResolvedValueOnce({ turnId: "t1" })
    // findMany #1: resource file (empty); #2: skill invoke ToolCall; #3: plan 文件（无）
    fakePrisma.toolCall.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { toolName: "skill", argsJson: '{"name":"ops-registry-invoke-workflow"}', resultJson: `<skill_content name="ops-registry-invoke-workflow">${skillBody}</skill_content>` },
      ])
      .mockResolvedValueOnce([])
    spawnMock.mockImplementation(happySpawn())

    const res = await POST(makeRequest({ taskId: "ses_1", skillName: "主 agent 编排", kind: "root" }))
    await readNdjson(res)
    expect(res.status).toBe(200)
    expect(lastWrittenSkillMd).toContain("核心原则")
    expect(lastWrittenSkillMd).toContain("name: main-agent-workflow")
    expect(lastWrittenSkillMd).not.toContain("## 二、任务计划")
  })

  it("kind=root → 规程层 + 计划层都有 → 分层拼接 + result 事件回传 _layers", async () => {
    const resourceContent = "# Task 调用参数\n\n## 1.1 开发准备\n\n- [ ] 开发日志已创建\n- [ ] 问题目录已创建\n- [ ] 环境检查已执行\n" + "x".repeat(120)
    const stateContent = "# STATE\n\n## Tasks\n\n- [ ] 1. 派发 developer\n- [ ] 2. 验收 st-verifier\n- [ ] 3. 收尾归档\n" + "y".repeat(120)
    fakePrisma.session.findFirst.mockResolvedValue({ id: "ses_cuid_1", sourcePath: "/tmp/fake.db", framework: "opencode" })
    // resolveWorkflowSkillName → skillName（resources 命中 → 不再走 recoverSkillBody）
    fakePrisma.skillEvent.findFirst.mockResolvedValueOnce({ skillName: "ops-registry-invoke-workflow" })
    // findMany #1: resource 文件；#2: 计划文件（STATE.md，非 skill 打包目录 → 进计划层）
    fakePrisma.toolCall.findMany
      .mockResolvedValueOnce([
        { toolName: "read", argsJson: '{"filePath":"/x/ops-registry-invoke-workflow/resources/task-prompts.md"}', resultJson: `<content>${resourceContent}</content>` },
      ])
      .mockResolvedValueOnce([
        { toolName: "read", argsJson: '{"filePath":"/repo/STATE.md"}', resultJson: `<content>${stateContent}</content>` },
      ])
    spawnMock.mockImplementation(happySpawn())

    const res = await POST(makeRequest({ taskId: "ses_1", skillName: "主 agent 编排", kind: "root" }))
    const events = (await readNdjson(res)) as Array<{ stage: string; _layers?: Array<{ kind: string; source: string }> }>
    expect(res.status).toBe(200)
    // 物化的 SKILL.md = 分层拼接（规程在前、计划在后）
    expect(lastWrittenSkillMd).toContain("## 一、编排规程")
    expect(lastWrittenSkillMd).toContain("开发准备")
    expect(lastWrittenSkillMd).toContain("## 二、任务计划")
    expect(lastWrittenSkillMd).toContain("派发 developer")
    expect(lastWrittenSkillMd!.indexOf("## 一、编排规程")).toBeLessThan(lastWrittenSkillMd!.indexOf("## 二、任务计划"))
    // result 事件带层信息（前端 finding 归层徽章）
    const last = events.at(-1)!
    expect(last.stage).toBe("result")
    expect(last._layers).toHaveLength(2)
    expect(last._layers![0].kind).toBe("regulation")
    expect(last._layers![0].source).toBe("task-prompts.md")
    expect(last._layers![1].kind).toBe("plan")
    expect(last._layers![1].source).toBe("STATE.md")
  })

  it("kind=root → 无主 agent Skill invoke → 404", async () => {
    fakePrisma.session.findFirst.mockResolvedValue({ id: "ses_cuid_1", sourcePath: "/tmp/fake.db", framework: "opencode" })
    fakePrisma.skillEvent.findFirst.mockResolvedValue(null)
    fakePrisma.toolCall.findMany.mockResolvedValue([])
    fakePrisma.turn.findFirst.mockResolvedValue(null)
    const res = await POST(makeRequest({ taskId: "ses_1", kind: "root" }))
    expect(res.status).toBe(404)
  })

  it("kind=llm-root → claude CLI 失败（认证 403）→ 502 + 具体原因（不吞成笼统 404）", async () => {
    fakePrisma.session.findFirst.mockResolvedValue({ id: "ses_cuid_1", sourcePath: "/tmp/fake.db", framework: "opencode" })
    llmExtractMock.mockRejectedValue(new Error("claude CLI 退出码 1：Failed to authenticate. API Error: 403 invalid api-key"))
    const res = await POST(makeRequest({ taskId: "ses_1", kind: "llm-root" }))
    expect(res.status).toBe(502)
    const d = await res.json()
    expect(d.error).toContain("403 invalid api-key")
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it("缺 taskId → 400", async () => {
    const res = await POST(makeRequest({ skillName: "x" }))
    expect(res.status).toBe(400)
  })

  it("session 无 sourcePath → 404", async () => {
    fakePrisma.session.findFirst.mockResolvedValue({ id: "ses_cuid_1", sourcePath: null })
    const res = await POST(makeRequest({ taskId: "ses_1", skillName: "x" }))
    expect(res.status).toBe(404)
  })

  it("session 不存在 → 404", async () => {
    fakePrisma.session.findFirst.mockResolvedValue(null)
    const res = await POST(makeRequest({ taskId: "ses_1", skillName: "x" }))
    expect(res.status).toBe(404)
  })

  it("skill 正文恢复不到 → 404", async () => {
    fakePrisma.session.findFirst.mockResolvedValue({ id: "ses_cuid_1", sourcePath: "/tmp/fake.db", framework: "opencode" })
    fakePrisma.skillEvent.findFirst.mockResolvedValue(null)
    const res = await POST(makeRequest({ taskId: "ses_1", skillName: "ghost" }))
    expect(res.status).toBe(404)
  })

  it("sift 不在 PATH（spawn ENOENT）→ NDJSON error 事件", async () => {
    fakePrisma.session.findFirst.mockResolvedValue({ id: "ses_cuid_1", sourcePath: "/tmp/fake.db", framework: "opencode" })
    seedSkillBody()
    spawnMock.mockImplementation(() => {
      const child = new FakeChild()
      setImmediate(() => child.emit("error", Object.assign(new Error("enoent"), { code: "ENOENT" })))
      return child
    })
    const res = await POST(makeRequest({ taskId: "ses_1", skillName: "acme-crash-debug" }))
    expect(res.status).toBe(200)
    const events = await readNdjson(res)
    const last = events.at(-1) as { stage: string; msg: string }
    expect(last.stage).toBe("error")
    expect(last.msg).toMatch(/sift 未找到/)
  })

  it("sift 非零退出 → NDJSON error 事件带 exit code", async () => {
    fakePrisma.session.findFirst.mockResolvedValue({ id: "ses_cuid_1", sourcePath: "/tmp/fake.db", framework: "opencode" })
    seedSkillBody()
    spawnMock.mockImplementation(() => {
      const child = new FakeChild()
      setImmediate(() => {
        child.stderr.emit("data", Buffer.from("切段为空"))
        child.emit("close", 2)
      })
      return child
    })
    const res = await POST(makeRequest({ taskId: "ses_1", skillName: "acme-crash-debug" }))
    expect(res.status).toBe(200)
    const events = await readNdjson(res)
    const last = events.at(-1) as { stage: string; msg: string }
    expect(last.stage).toBe("error")
    expect(last.msg).toMatch(/exit 2/)
  })

  it("framework=context-insight → --transcript 结构化 JSON(不走 --db)", async () => {
    fakePrisma.session.findFirst.mockResolvedValue({ id: "ses_cuid_1", sourcePath: "/tmp/fake.jsonl", framework: "context-insight" })
    seedSkillBody()
    fakePrisma.turn.findMany.mockResolvedValue([
      { id: "t1", turnIndex: 0, role: "assistant", content: "调用 skill", agentName: "kernel-developer" },
    ])
    spawnMock.mockImplementation(happySpawn())
    const res = await POST(
      makeRequest({ taskId: "ses_1", skillName: "acme-crash-debug", framework: "context-insight" }),
    )
    expect(res.status).toBe(200)
    const [, args] = spawnMock.mock.calls[0]
    expect(args).toContain("--transcript")
    expect(args).not.toContain("--db")
    expect(args.some((a: unknown) => typeof a === "string" && (a as string).endsWith("session.json"))).toBe(true)
  })

  it("framework=opencode + sourcePath=jsonl（lake 导入/proxy 捕获）→ --transcript（喂法按 sourcePath 形态，不看 framework）", async () => {
    // 回归：ses_0515cc95（lake 导入，meta framework=opencode，sourcePath 是物化 jsonl）
    // 走 --db 被 sift 当 sqlite 打开 → OpencodeDbError → exit 3 必失败。
    fakePrisma.session.findFirst.mockResolvedValue({
      id: "ses_cuid_1",
      sourcePath: "/tmp/lake-cache/materialized/ses_xxx.jsonl",
      framework: "opencode",
    })
    seedSkillBody()
    fakePrisma.turn.findMany.mockResolvedValue([
      { id: "t1", turnIndex: 0, role: "assistant", content: "调用 skill", agentName: "kernel-developer" },
    ])
    spawnMock.mockImplementation(happySpawn())
    const res = await POST(makeRequest({ taskId: "ses_1", skillName: "acme-crash-debug" }))
    expect(res.status).toBe(200)
    const [, args] = spawnMock.mock.calls[0]
    expect(args).toContain("--transcript")
    expect(args).not.toContain("--db")
    expect(args.some((a: unknown) => typeof a === "string" && (a as string).endsWith("session.json"))).toBe(true)
  })

  it("framework=opencode + sourcePath=jsonl.gz（压缩形态）→ --transcript", async () => {
    fakePrisma.session.findFirst.mockResolvedValue({
      id: "ses_cuid_1",
      sourcePath: "/tmp/cpx-ses_xxx.jsonl.gz",
      framework: "opencode",
    })
    seedSkillBody()
    fakePrisma.turn.findMany.mockResolvedValue([
      { id: "t1", turnIndex: 0, role: "assistant", content: "调用 skill", agentName: "kernel-developer" },
    ])
    spawnMock.mockImplementation(happySpawn())
    const res = await POST(makeRequest({ taskId: "ses_1", skillName: "acme-crash-debug" }))
    expect(res.status).toBe(200)
    const [, args] = spawnMock.mock.calls[0]
    expect(args).toContain("--transcript")
    expect(args).not.toContain("--db")
  })
})
