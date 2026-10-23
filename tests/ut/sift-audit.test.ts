// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  stripSkillContent,
  stripSkillRuntimeTail,
  recoverSkillBody,
  recoverPlanFileDeclaration,
  recoverMainAgentWorkflowBody,
  resolveWorkflowSkillName,
  recoverWorkflowDeclaration,
  recoverCombinedWorkflowDeclaration,
  buildAuditArgs,
  buildStructuredRecords,
  buildTranscriptArgs,
  auditKindsForEvents,
  isDispatchOnlyAgent,
  dispatchOnlySkillNames,
  getInflightAudit,
} from "@/lib/sift-audit";

/** 造一个最小 mock prisma：只实现 recoverSkillBody 用到的两个方法。 */
function makePrisma(opts: {
  skillEvent?: { turnId: string } | null
  toolCalls?: Array<{ toolName: string; argsJson: string | null; resultJson: string | null }>
}) {
  return {
    skillEvent: {
      findFirst: async () => opts.skillEvent ?? null,
    },
    toolCall: {
      findMany: async () => opts.toolCalls ?? [],
    },
  } as unknown as Parameters<typeof recoverSkillBody>[2];
}

describe("stripSkillContent", () => {
  it("剥掉 <skill_content name=…> 外壳、返回内部正文（trim）", () => {
    const resultJson =
      '<skill_content name="acme-crash-debug">\n# Skill: acme-crash-debug\n调试算子卡死\n</skill_content>';
    expect(stripSkillContent(resultJson)).toBe("# Skill: acme-crash-debug\n调试算子卡死");
  });

  it("name 属性带别的值也能剥", () => {
    expect(stripSkillContent('<skill_content name="foo-bar">BODY</skill_content>')).toBe("BODY");
  });

  it("多行正文完整保留", () => {
    const inner = "line1\n\nline2\n- a\n- b";
    expect(stripSkillContent(`<skill_content name="x">${inner}</skill_content>`)).toBe(inner);
  });

  it("没有 skill_content 外壳 → null", () => {
    expect(stripSkillContent("just some text without wrapper")).toBeNull();
  });

  it("空串 / null-ish → null", () => {
    expect(stripSkillContent("")).toBeNull();
    expect(stripSkillContent(null as unknown as string)).toBeNull();
  });

  it("S2：body 尾部带 Base directory/Relative paths/Note/<skill_files> 运行时注入块 → 全剥", () => {
    const inner = "# Skill: ops-registry-invoke-glacier\n\n## 核心原则\n\n- 只做编排派发";
    const tail = "\n\nBase directory for this skill: /workspace/gaoyifan/code/skills-dev/plugins-official/harness-l2-apply_adam_w/.opencode/skills/ops-registry-invoke\nRelative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.\nNote: file list is sampled.\n\n<skill_files>\n<file>/workspace/gaoyifan/a.md</file>\n<file>/workspace/gaoyifan/b.md</file>\n</skill_files>";
    expect(stripSkillContent(`<skill_content name="x">${inner}${tail}</skill_content>`)).toBe(inner);
  });

  it("S3：turn0 注入体剥尾部保留用户请求（行级过滤，不删无关注释）", () => {
    const body = "# 基于 ACLIB 的算子开发工作流\n\n你是纯编排者，读取 STATE.md 按顺序派发。";
    const withTail = body + "\n\nBase directory for this skill: /home/hwd/x/.opencode/skills/ops-registry-invoke-glacier\nRelative paths in this skill (e.g., scripts/) are relative to this base directory.\n\nsoftplus_v2_grad";
    const stripped = stripSkillRuntimeTail(withTail);
    expect(stripped).toBe(body + "\n\nsoftplus_v2_grad");
    expect(stripped).not.toContain("Base directory");
    expect(stripped).not.toContain("Relative paths");
  });

  it("无尾部标记 → 原文不变（trimEnd）", () => {
    expect(stripSkillRuntimeTail("# 规程\n\n用户请求")).toBe("# 规程\n\n用户请求");
  });
});

describe("recoverSkillBody", () => {
  const SID = "ses_cuid_1";

  it("invoke 事件 + 同 turn 的 skill ToolCall(resultJson 含正文) → 剥壳返回", async () => {
    const prisma = makePrisma({
      skillEvent: { turnId: "t1" },
      toolCalls: [
        {
          toolName: "skill",
          argsJson: '{"name":"acme-crash-debug"}',
          resultJson: '<skill_content name="acme-crash-debug">\nBODY\n</skill_content>',
        },
      ],
    });
    expect(await recoverSkillBody(SID, "acme-crash-debug", prisma)).toBe("BODY");
  });

  it("无 invoke 事件（只有 dispatch）→ null", async () => {
    const prisma = makePrisma({ skillEvent: null });
    expect(await recoverSkillBody(SID, "x", prisma)).toBeNull();
  });

  it("invoke 事件在、但 ToolCall 的 resultJson 空 → null", async () => {
    const prisma = makePrisma({
      skillEvent: { turnId: "t1" },
      toolCalls: [{ toolName: "skill", argsJson: '{"name":"x"}', resultJson: null }],
    });
    expect(await recoverSkillBody(SID, "x", prisma)).toBeNull();
  });

  it("toolName 是 task/dispatch（非 invoke）→ 被滤掉、无候选 → null", async () => {
    const prisma = makePrisma({
      skillEvent: { turnId: "t1" },
      toolCalls: [{ toolName: "task", argsJson: '{"name":"x"}', resultJson: "<skill_content>x</skill_content>" }],
    });
    expect(await recoverSkillBody(SID, "x", prisma)).toBeNull();
  });

  it("按 argsJson.name 精确匹配（同 turn 多 skill 时挑对的那个）", async () => {
    const prisma = makePrisma({
      skillEvent: { turnId: "t1" },
      toolCalls: [
        { toolName: "skill", argsJson: '{"name":"other"}', resultJson: '<skill_content name="other">WRONG</skill_content>' },
        { toolName: "skill", argsJson: '{"name":"want"}', resultJson: '<skill_content name="want">RIGHT</skill_content>' },
      ],
    });
    expect(await recoverSkillBody(SID, "want", prisma)).toBe("RIGHT");
  });
});

describe("buildAuditArgs", () => {
  it("拼出 sift audit 的参数数组：位置参 skill 目录 + --db/--session/-o + --kind skill", () => {
    // --kind skill 必带（--db 路是 per-skill 对账）：不带会拿本 skill 的 SKILL.md 去对账整条
    // session（含别的 skill 跑的 turn）。sift 靠 SKILL.md 的 name + --kind skill 切本 skill 的段。
    expect(
      buildAuditArgs({
        skillPath: "/tmp/x/myskill",
        dbPath: "/a/b.db",
        sessionId: "ses_1",
        outputDir: "/tmp/out",
      }),
    ).toEqual([
      "audit",
      "/tmp/x/myskill",
      "--db",
      "/a/b.db",
      "--session",
      "ses_1",
      "-o",
      "/tmp/out",
      "--kind",
      "skill",
      "--turn-refs",
    ]);
  });
});

describe("buildTranscriptArgs", () => {
  it("kind=skill：拼出 --transcript 参数 + --kind skill + --turn-refs", () => {
    expect(
      buildTranscriptArgs({
        skillPath: "/tmp/x/myskill",
        transcriptPath: "/tmp/s.json",
        outputDir: "/tmp/out",
        kind: "skill",
      }),
    ).toEqual([
      "audit",
      "/tmp/x/myskill",
      "--transcript",
      "/tmp/s.json",
      "-o",
      "/tmp/out",
      "--kind",
      "skill",
      "--turn-refs",
    ]);
  });

  it("kind=agent：--kind agent + --turn-refs（审被 dispatch 的 agent，按 agent 归属切）", () => {
    expect(
      buildTranscriptArgs({
        skillPath: "/tmp/x/developer",
        transcriptPath: "/tmp/s.json",
        outputDir: "/tmp/out",
        kind: "agent",
      }),
    ).toEqual([
      "audit",
      "/tmp/x/developer",
      "--transcript",
      "/tmp/s.json",
      "-o",
      "/tmp/out",
      "--kind",
      "agent",
      "--turn-refs",
    ]);
  });
});

describe("auditKindsForEvents", () => {
  // Skills tab 每行按 events 的 eventType 决定该跑哪种对账:invoke/use → skill 面
  // (Skill 调用,正文从 session 恢复);dispatch → agent 面(被 dispatch,.md 从 AGENTS_ROOT 读)。
  // dispatch-only 行(如 developer)原来挂 skill 对账按钮必 404(无 invoke 正文可恢复)→ 路由到 agent 对账。
  it("invoke-only → [skill](纯 skill,对 skill 声明)", () => {
    expect(auditKindsForEvents([{ eventType: "invoke" }, { eventType: "invoke" }])).toEqual(["skill"]);
  });

  it("'use' 也算 skill 面(Skill 调用的别名 eventType)", () => {
    expect(auditKindsForEvents([{ eventType: "use" }])).toEqual(["skill"]);
  });

  it("dispatch-only → [agent](纯 agent,如 developer;原 skill 对账会 404)", () => {
    expect(auditKindsForEvents([{ eventType: "dispatch" }, { eventType: "dispatch" }])).toEqual(["agent"]);
  });

  it("dual-nature(invoke+dispatch 同名,如 st-verifier)→ [skill, agent] 两面", () => {
    expect(auditKindsForEvents([{ eventType: "invoke" }, { eventType: "dispatch" }])).toEqual(["skill", "agent"]);
  });

  it("空 events → [](无锚点,不显示对账按钮)", () => {
    expect(auditKindsForEvents([])).toEqual([]);
  });

  it("未知 eventType → [](既非 invoke/use 也非 dispatch,不当工具用)", () => {
    expect(auditKindsForEvents([{ eventType: "load" }, { eventType: "whatever" }])).toEqual([]);
  });
});

describe("recoverMainAgentWorkflowBody", () => {
  // 主 agent 通常只 dispatch、不 invoke skill，其 workflow 声明是 session 首条
  // user/system turn（S3：opencode ≥1.17 注入体带 Base directory 标记被 adapter
  // 重分类为 system）的注入系统提示。内容过短（<500）→ null。
  const body = "# 基于 ACLIB 的算子开发工作流\n\n你是纯编排者（Orchestrator），" + "x".repeat(500);
  const shortQuery = "帮我写个 hello world";
  const makeTurnPrisma = (content: string | null) =>
    ({ turn: { findFirst: vi.fn().mockResolvedValue(content === null ? null : { content }) } }) as unknown as PrismaClient;

  it("首条 user turn 内容 ≥500 → 返回正文", async () => {
    const prisma = makeTurnPrisma(body);
    const r = await recoverMainAgentWorkflowBody("ses_1", prisma);
    expect(r).toBe(body);
    expect(prisma.turn.findFirst).toHaveBeenCalledWith({
      where: { sessionId: "ses_1", role: { in: ["user", "system"] }, isSubagent: false },
      orderBy: { turnIndex: "asc" },
    });
  });

  it("首条 user turn 过短（<500）→ null（视为普通短查询，非 workflow 声明）", async () => {
    const prisma = makeTurnPrisma(shortQuery);
    expect(await recoverMainAgentWorkflowBody("ses_1", prisma)).toBeNull();
  });

  it("S3：首条 system turn（注入体带 Base directory 尾部）→ 剥运行时尾部、保留用户请求", async () => {
    const s3Turn0 = body + "\n\nBase directory for this skill: /home/hwd/skills-dev/plugins-official/glacier-softplus_v2_grad/.opencode/skills/ops-registry-invoke-glacier\nRelative paths in this skill (e.g., scripts/, references/) are relative to this base directory.\n\nsoftplus_v2_grad";
    const prisma = makeTurnPrisma(s3Turn0);
    const r = await recoverMainAgentWorkflowBody("ses_1", prisma);
    expect(r).toBe(body + "\n\nsoftplus_v2_grad");
    expect(r).not.toContain("Base directory for this skill");
    expect(r).not.toContain("Relative paths in this skill");
  });

  it("S3：短 system turn（continue / agent 注册注入）→ null", async () => {
    const prisma = makeTurnPrisma("continue");
    expect(await recoverMainAgentWorkflowBody("ses_1", prisma)).toBeNull();
    const prisma2 = makeTurnPrisma("Available agent types: developer, verifier");
    expect(await recoverMainAgentWorkflowBody("ses_1", prisma2)).toBeNull();
  });

  it("无 user turn → null", async () => {
    const prisma = makeTurnPrisma(null);
    expect(await recoverMainAgentWorkflowBody("ses_1", prisma)).toBeNull();
  });

  it("content 为空 → null", async () => {
    const prisma = { turn: { findFirst: vi.fn().mockResolvedValue({ content: null }) } } as unknown as PrismaClient;
    expect(await recoverMainAgentWorkflowBody("ses_1", prisma)).toBeNull();
  });
});

describe("recoverPlanFileDeclaration（named-Read 单路：计划文件名白名单）", () => {
  // 主 agent 编排 计划文件提取：单次查 Read 工具调用，内存过滤。
  // 仅 basename 命中插件 plan.fileNames（默认只 STATE.md）的 Read 算计划声明。
  // 返回 { content, source }：source = basename。
  // todowrite / named-Write / scan 兜底 / isPlanLike 内容特征均已移除
  // （自评循环 / 终态自证 / 误报噪声 / 文件名白名单已是强信号）。
  const planBody = "# 工作流\n\n## Tasks\n\n- [x] 1. 创建工作区\n- [ ] 2. 初始化日志\n- [ ] 3. 派发 developer\n" + "x".repeat(120);
  const makePlanPrisma = (tcs: Array<{ toolName: string; argsJson: string | null; resultJson: string | null }>) =>
    ({ toolCall: { findMany: vi.fn().mockResolvedValue(tcs) } }) as unknown as PrismaClient;

  // ── named-Read 提取 ──

  it("STATE.md Read → source=STATE.md，剥行号 + [x]→[ ]", async () => {
    const withNums = planBody.split("\n").map((l, i) => `${i + 1}: ${l}`).join("\n");
    const prisma = makePlanPrisma([
      { toolName: "read", argsJson: '{"filePath":"/x/STATE.md"}', resultJson: `<content>${withNums}</content>` },
    ]);
    const r = await recoverPlanFileDeclaration("ses_1", prisma);
    expect(r).not.toBeNull();
    expect(r!.source).toBe("STATE.md");
    expect(r!.content).toContain("[ ] 1. 创建工作区");
    expect(r!.content).not.toContain("[x]");
    expect(r!.content).not.toMatch(/^\s*\d+:/m);
  });

  it("白名单外计划文件名（TODO.md / TASKS.md 等）→ null（默认白名单只 STATE.md）", async () => {
    for (const name of ["TODO.md", "TASKS.md", "WORKFLOW.md", "BACKLOG.md"]) {
      const prisma = makePlanPrisma([
        { toolName: "read", argsJson: `{"filePath":"/x/${name}"}`, resultJson: `<content>${planBody}</content>` },
      ]);
      expect(await recoverPlanFileDeclaration("ses_1", prisma)).toBeNull();
    }
  });

  it("文件名大小写不敏感（state.md）→ named 桶，source 保留原大小写", async () => {
    const prisma = makePlanPrisma([
      { toolName: "read", argsJson: '{"filePath":"/x/state.md"}', resultJson: `<content>${planBody}</content>` },
    ]);
    const r = await recoverPlanFileDeclaration("ses_1", prisma);
    expect(r!.source).toBe("state.md");
  });

  it("file_path 字段（非 filePath）→ 仍能提取 basename", async () => {
    const prisma = makePlanPrisma([
      { toolName: "read", argsJson: '{"file_path":"/x/STATE.md"}', resultJson: `<content>${planBody}</content>` },
    ]);
    const r = await recoverPlanFileDeclaration("ses_1", prisma);
    expect(r!.source).toBe("STATE.md");
  });

  it("多次读 STATE.md → 取首次实质读取（早读=承诺态，≥60% 桶内最长）", async () => {
    const early = "# plan-v1\n\n## Tasks\n\n- [ ] a\n- [ ] b\n" + "x".repeat(120);
    const late = "# plan-v2 终态\n\n## Tasks\n\n- [x] a\n- [ ] b\n- [ ] c 追加\n" + "x".repeat(200);
    const prisma = makePlanPrisma([
      { toolName: "read", argsJson: '{"filePath":"/a/STATE.md"}', resultJson: `<content>${early}</content>` },
      { toolName: "read", argsJson: '{"filePath":"/a/STATE.md"}', resultJson: `<content>${late}</content>` },
    ]);
    const r = await recoverPlanFileDeclaration("ses_1", prisma);
    expect(r!.content).toContain("plan-v1");
    expect(r!.content).not.toContain("终态");
  });

  it("首次读是部分读取（<60% 桶内最长）→ 跳过、取后续完整读取", async () => {
    const partial = "# 残片\n\n## Tasks\n\n- [ ] a\n";
    const full = "# full\n\n## Tasks\n\n- [ ] a\n- [ ] b\n- [ ] c\n" + "x".repeat(200);
    const prisma = makePlanPrisma([
      { toolName: "read", argsJson: '{"filePath":"/a/STATE.md"}', resultJson: `<content>${partial}</content>` },
      { toolName: "read", argsJson: '{"filePath":"/a/STATE.md"}', resultJson: `<content>${full}</content>` },
    ]);
    const r = await recoverPlanFileDeclaration("ses_1", prisma);
    expect(r!.content).toContain("full");
  });

  it("skill 打包目录（resources/templates）下的文件 → 不进计划层（防与规程层同文双计）", async () => {
    const prisma = makePlanPrisma([
      { toolName: "read", argsJson: '{"filePath":"/x/ops-registry-invoke-workflow/resources/task-prompts.md"}', resultJson: `<content>${planBody}</content>` },
    ]);
    expect(await recoverPlanFileDeclaration("ses_1", prisma)).toBeNull();
  });

  // ── 已移除路径的回归锁（todowrite / Write / 非白名单 → null）──

  it("非白名单文件 + 内容 plan-like（checklist ≥3）→ null（scan 兜底已移除）", async () => {
    const body = "# my plan\n\n- [ ] task A\n- [ ] task B\n- [ ] task C\n" + "x".repeat(120);
    const prisma = makePlanPrisma([
      { toolName: "read", argsJson: '{"filePath":"/x/work-plan.md"}', resultJson: `<content>${body}</content>` },
    ]);
    expect(await recoverPlanFileDeclaration("ses_1", prisma)).toBeNull();
  });

  it("非白名单文件 + 普通源码内容 → null", async () => {
    const body = "export function foo() {\n  return 42;\n}\n" + "x".repeat(120);
    const prisma = makePlanPrisma([
      { toolName: "read", argsJson: '{"filePath":"/x/foo.ts"}', resultJson: `<content>${body}</content>` },
    ]);
    expect(await recoverPlanFileDeclaration("ses_1", prisma)).toBeNull();
  });

  it("STATE.md Write → null（Write 产物不作为计划层）", async () => {
    const prisma = makePlanPrisma([
      { toolName: "write", argsJson: JSON.stringify({ filePath: "/x/STATE.md", content: planBody }), resultJson: null },
    ]);
    expect(await recoverPlanFileDeclaration("ses_1", prisma)).toBeNull();
  });

  it("todowrite ≥3 todos → null（todowrite 已从计划层移除）", async () => {
    const todos = [
      { content: "1.1 开发准备：创建算子目录", status: "in_progress", priority: "high" },
      { content: "1.2 需求分析：生成REQUIREMENTS.md", status: "pending", priority: "high" },
      { content: "1.3 方案设计：生成DESIGN.md和PLAN.md", status: "pending", priority: "high" },
      { content: "1.4 测试设计：生成TEST.md", status: "pending", priority: "high" },
    ];
    const prisma = makePlanPrisma([
      { toolName: "todowrite", argsJson: JSON.stringify({ todos }), resultJson: null },
    ]);
    expect(await recoverPlanFileDeclaration("ses_1", prisma)).toBeNull();
  });

  it("非白名单的 plan-like 文件不干扰 named 提取（被白名单过滤忽略）", async () => {
    const namedShort = "# short STATE\n\n## Tasks\n\n- [ ] a\n" + "x".repeat(120);
    const scanLong = "## Tasks\n\n- [ ] a\n- [ ] b\n- [ ] c\n" + "x".repeat(300);
    const prisma = makePlanPrisma([
      { toolName: "read", argsJson: '{"filePath":"/x/STATE.md"}', resultJson: `<content>${namedShort}</content>` },
      { toolName: "read", argsJson: '{"filePath":"/x/work.md"}', resultJson: `<content>${scanLong}</content>` },
    ]);
    const r = await recoverPlanFileDeclaration("ses_1", prisma);
    expect(r!.source).toBe("STATE.md");
    expect(r!.content).toContain("short STATE");
  });

  // ── 边界：跳过 + 容错 ──

  it("无文件工具调用 → null", async () => {
    expect(await recoverPlanFileDeclaration("ses_1", makePlanPrisma([]))).toBeNull();
  });

  it("计划文件过短（<100 字）→ null（不 substantial）", async () => {
    const prisma = makePlanPrisma([
      { toolName: "read", argsJson: '{"filePath":"/x/STATE.md"}', resultJson: `<content>1: 短</content>` },
    ]);
    expect(await recoverPlanFileDeclaration("ses_1", prisma)).toBeNull();
  });

  it("STATE.md Read 但内容是迭代表格（无 plan 特征）→ 仍提取（isPlanLike 已砍，白名单即判定）", async () => {
    const body = "# 迭代执行计划\n\n## 迭代一穿刺列表\n\n| 任务类型 | TilingKey | Dtype |\n|---------|-----------|-------|\n| 主线 | FLOAT | fp32 |\n" + "x".repeat(120);
    const prisma = makePlanPrisma([
      { toolName: "read", argsJson: '{"filePath":"/x/STATE.md"}', resultJson: `<content>${body}</content>` },
    ]);
    const r = await recoverPlanFileDeclaration("ses_1", prisma);
    expect(r!.source).toBe("STATE.md");
    expect(r!.content).toContain("迭代执行计划");
  });

  it("Read resultJson 无 <content>（文件不存在）→ 跳过该 tc", async () => {
    const prisma = makePlanPrisma([
      { toolName: "read", argsJson: '{"filePath":"/x/STATE.md"}', resultJson: "<path>/x/STATE.md</path><error>not found</error>" },
    ]);
    expect(await recoverPlanFileDeclaration("ses_1", prisma)).toBeNull();
  });

  it("Write argsJson 非 JSON → 跳过该 tc（不提取也不崩）", async () => {
    const prisma = makePlanPrisma([
      { toolName: "write", argsJson: "not-json", resultJson: null },
    ]);
    expect(await recoverPlanFileDeclaration("ses_1", prisma)).toBeNull();
  });

  it("argsJson 为 null → 跳过（无 basename，不入 named 桶）", async () => {
    const prisma = makePlanPrisma([
      { toolName: "read", argsJson: null, resultJson: `<content>${planBody}</content>` },
    ]);
    expect(await recoverPlanFileDeclaration("ses_1", prisma)).toBeNull();
  });

  // ── 场景：S1/S2 的计划层取值 ──

  it("S1 场景：STATE.md Read → named-Read（todowrite 被忽略）", async () => {
    const stateRead = "# 工作流 STATE\n\n## Tasks\n\n- [x] 1. 创建开发工作区\n  - 执行者：developer\n  - 验收标准：test -d\n- [ ] 2. 初始化日志\n- [ ] 3. 派发 developer\n" + "x".repeat(120);
    const todos = [
      { content: "Dispatch developer to create docs", status: "in_progress" },
      { content: "Dispatch developer to init log", status: "pending" },
      { content: "Dispatch verifier to check", status: "pending" },
    ];
    const prisma = makePlanPrisma([
      { toolName: "read", argsJson: '{"filePath":"/x/STATE.md"}', resultJson: `<content>${stateRead}</content>` },
      { toolName: "todowrite", argsJson: JSON.stringify({ todos }), resultJson: null },
    ]);
    const r = await recoverPlanFileDeclaration("ses_1", prisma);
    expect(r!.source).toBe("STATE.md");
    expect(r!.content).toContain("创建开发工作区");
  });

  it("S2 场景：PLAN.md（非白名单）Read + todowrite → null（白名单不命中且无兜底）", async () => {
    const planRead = "# BenchNoHarnessLstm 迭代执行计划\n\n## 迭代一穿刺列表\n\n| 任务类型 | TilingKey | Dtype | 验证目标 |\n|---------|-----------|-------|---------|\n| 主线 | FLOAT,1,0,0,0 | fp32 | 完整正确性 |\n" + "x".repeat(120);
    const todos = [
      { content: "1.1 开发准备：创建算子目录", status: "in_progress", priority: "high" },
      { content: "1.2 需求分析：生成REQUIREMENTS.md", status: "pending", priority: "high" },
      { content: "1.3 方案设计：生成DESIGN.md和PLAN.md", status: "pending", priority: "high" },
      { content: "1.4 测试设计：生成TEST.md", status: "pending", priority: "high" },
      { content: "设计阶段完成后暂停", status: "pending", priority: "high" },
    ];
    const prisma = makePlanPrisma([
      { toolName: "read", argsJson: '{"filePath":"/x/PLAN.md"}', resultJson: `<content>${planRead}</content>` },
      { toolName: "todowrite", argsJson: JSON.stringify({ todos }), resultJson: null },
    ]);
    expect(await recoverPlanFileDeclaration("ses_1", prisma)).toBeNull();
  });
});

describe("resolveWorkflowSkillName + recoverWorkflowDeclaration", () => {
  // root 对账声明 = workflow skill 的编排规程（slice.py："root 声明常是 workflow 级 SKILL.md"）
  // 从主 agent Skill invoke 定位 skillName → recoverSkillResourceFile / recoverSkillBody 恢复
  const makeWfPrisma = (opts: {
    skillEvent?: { skillName: string; turnId?: string } | null
    resourceTcs?: Array<{ toolName: string; argsJson: string; resultJson: string | null }>
    skillBodyTcs?: Array<{ toolName: string; argsJson: string | null; resultJson: string | null }>
    turn0?: { content: string } | null
  }) => ({
    skillEvent: {
      findFirst: vi.fn()
        // resolveWorkflowSkillName 调用（isSubagent=false, eventType=invoke）
        .mockResolvedValueOnce(opts.skillEvent ?? null)
        // recoverSkillBody 调用（如果退到 fallback）
        .mockResolvedValueOnce(opts.skillEvent?.turnId ? { turnId: opts.skillEvent.turnId } : null),
    },
    toolCall: {
      findMany: vi.fn()
        // recoverSkillResourceFile 调用
        .mockResolvedValueOnce(opts.resourceTcs ?? [])
        // recoverSkillBody 调用（如果退到 fallback）
        .mockResolvedValueOnce(opts.skillBodyTcs ?? []),
    },
    turn: {
      findFirst: vi.fn().mockResolvedValue(opts.turn0 ?? null),
    },
  }) as unknown as PrismaClient;

  const resourceBody = "# Task 调用参数\n\n## 1.1 开发准备\n\n- [ ] 开发日志已创建\n- [ ] 问题目录已创建\n- [ ] 环境检查已执行\n" + "x".repeat(120);
  const skillBodyContent = "# Skill: ops-registry-invoke-workflow\n\n## 核心原则\n\n- 测试驱动\n- 阶段递进\n- 阶段门控\n" + "x".repeat(120);

  it("resolveWorkflowSkillName → 主 agent 首 invoke 的 skillName", async () => {
    const prisma = {
      skillEvent: { findFirst: vi.fn().mockResolvedValue({ skillName: "ops-registry-invoke-glacier" }) },
    } as unknown as PrismaClient;
    const name = await resolveWorkflowSkillName("ses_1", prisma);
    expect(name).toBe("ops-registry-invoke-glacier");
  });

  it("resolveWorkflowSkillName → 无 invoke → null", async () => {
    const prisma = {
      skillEvent: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    expect(await resolveWorkflowSkillName("ses_1", prisma)).toBeNull();
  });

  it("recoverWorkflowDeclaration → skill resources 文件（task-prompts.md）优先", async () => {
    const prisma = makeWfPrisma({
      skillEvent: { skillName: "ops-registry-invoke-workflow" },
      resourceTcs: [
        { toolName: "read", argsJson: '{"filePath":"/x/ops-registry-invoke-workflow/resources/task-prompts.md"}', resultJson: `<content>${resourceBody}</content>` },
      ],
    });
    const r = await recoverWorkflowDeclaration("ses_1", prisma);
    expect(r).not.toBeNull();
    expect(r!.source).toBe("task-prompts.md");
    expect(r!.content).toContain("开发准备");
  });

  it("recoverWorkflowDeclaration → 无 resources → 退 SKILL.md body", async () => {
    const prisma = makeWfPrisma({
      skillEvent: { skillName: "ops-registry-invoke-workflow", turnId: "t1" },
      resourceTcs: [], // 无 resource 文件
      skillBodyTcs: [
        { toolName: "skill", argsJson: '{"name":"ops-registry-invoke-workflow"}', resultJson: `<skill_content name="ops-registry-invoke-workflow">${skillBodyContent}</skill_content>` },
      ],
    });
    const r = await recoverWorkflowDeclaration("ses_1", prisma);
    expect(r).not.toBeNull();
    expect(r!.source).toBe("ops-registry-invoke-workflow (SKILL.md)");
    expect(r!.content).toContain("核心原则");
  });

  it("recoverWorkflowDeclaration → 无 Skill invoke → null", async () => {
    const prisma = makeWfPrisma({ skillEvent: null });
    expect(await recoverWorkflowDeclaration("ses_1", prisma)).toBeNull();
  });

  it("recoverWorkflowDeclaration → resources 内容过短 → 退 SKILL.md body", async () => {
    const prisma = makeWfPrisma({
      skillEvent: { skillName: "ops-registry-invoke-workflow", turnId: "t1" },
      resourceTcs: [
        { toolName: "read", argsJson: '{"filePath":"/x/ops-registry-invoke-workflow/resources/task-prompts.md"}', resultJson: `<content>1: 短</content>` },
      ],
      skillBodyTcs: [
        { toolName: "skill", argsJson: '{"name":"ops-registry-invoke-workflow"}', resultJson: `<skill_content name="ops-registry-invoke-workflow">${skillBodyContent}</skill_content>` },
      ],
    });
    const r = await recoverWorkflowDeclaration("ses_1", prisma);
    expect(r!.source).toBe("ops-registry-invoke-workflow (SKILL.md)");
  });

  it("recoverWorkflowDeclaration → filePath 不含 skillName → 不算 resource", async () => {
    const prisma = makeWfPrisma({
      skillEvent: { skillName: "ops-registry-invoke-workflow", turnId: "t1" },
      resourceTcs: [
        // filePath 不含 skillName → 不是 skill 的 resource 文件
        { toolName: "read", argsJson: '{"filePath":"/x/other-file.md"}', resultJson: `<content>${resourceBody}</content>` },
      ],
      skillBodyTcs: [
        { toolName: "skill", argsJson: '{"name":"ops-registry-invoke-workflow"}', resultJson: `<skill_content name="ops-registry-invoke-workflow">${skillBodyContent}</skill_content>` },
      ],
    });
    const r = await recoverWorkflowDeclaration("ses_1", prisma);
    // resource 不匹配 → 退 SKILL.md body
    expect(r!.source).toBe("ops-registry-invoke-workflow (SKILL.md)");
  });

  it("S1 型：无 Skill invoke → 退 turn0 ≥500（注入编排规程）", async () => {
    // S1 的 turn0 是 1809 字的编排规程（"你是纯编排者，读取 STATE.md..."）
    const turn0Body = "# 基于 ACLIB 的算子开发工作流\n\n你是纯编排者（Orchestrator），读取 STATE.md 按顺序派发 SubAgent。" + "x".repeat(500);
    const prisma = {
      skillEvent: { findFirst: vi.fn().mockResolvedValue(null) }, // 无 Skill invoke
      turn: { findFirst: vi.fn().mockResolvedValue({ content: turn0Body }) },
    } as unknown as PrismaClient;
    const r = await recoverWorkflowDeclaration("ses_1", prisma);
    expect(r).not.toBeNull();
    expect(r!.source).toBe("turn0 (注入编排规程)");
    expect(r!.content).toContain("纯编排者");
  });

  it("S3 型：无 Skill invoke + turn0 为 system（opencode ≥1.17 skill 注入）→ 剥尾部提取", async () => {
    const turn0Body = "# 基于 ACLIB 的算子开发工作流\n\n你是纯编排者（Orchestrator），读取 STATE.md 按顺序派发 SubAgent。" + "x".repeat(500);
    const s3Turn0 = turn0Body + "\n\nBase directory for this skill: /home/hwd/x/.opencode/skills/ops-registry-invoke-glacier\nRelative paths in this skill (e.g., scripts/) are relative to this base directory.\n\nsoftplus_v2_grad";
    const prisma = {
      skillEvent: { findFirst: vi.fn().mockResolvedValue(null) }, // 无 Skill invoke（主 agent 只 dispatch）
      turn: { findFirst: vi.fn().mockResolvedValue({ content: s3Turn0, role: "system" }) },
    } as unknown as PrismaClient;
    const r = await recoverWorkflowDeclaration("ses_1", prisma);
    expect(r).not.toBeNull();
    expect(r!.source).toBe("turn0 (注入编排规程)");
    expect(r!.content).toContain("纯编排者");
    expect(r!.content).toContain("softplus_v2_grad"); // 用户请求保留
    expect(r!.content).not.toContain("Base directory for this skill");
  });

  it("S1 型：无 invoke + turn0 <500 → null（短用户任务不是编排规程）", async () => {
    const prisma = {
      skillEvent: { findFirst: vi.fn().mockResolvedValue(null) },
      turn: { findFirst: vi.fn().mockResolvedValue({ content: "帮我写个 hello world" }) },
    } as unknown as PrismaClient;
    expect(await recoverWorkflowDeclaration("ses_1", prisma)).toBeNull();
  });
});

describe("recoverCombinedWorkflowDeclaration（root 组合声明：规程层 + 计划层）", () => {
  // root 对账送组合声明：规程层（recoverWorkflowDeclaration）+ 计划层（recoverPlanFileDeclaration）
  // 分层拼接。双层 → 带分层标题；单层 → 原文直出（与该层单独使用逐字节一致）；皆无 → null。
  const resourceBody = "# Task 调用参数\n\n## 1.1 开发准备\n\n- [ ] 开发日志已创建\n- [ ] 问题目录已创建\n- [ ] 环境检查已执行\n" + "x".repeat(120);
  const stateBody = "# STATE\n\n## Tasks\n\n- [ ] 1. 派发 developer\n- [ ] 2. 验收 st-verifier\n- [ ] 3. 收尾归档\n" + "y".repeat(120);
  const turn0Body = "# 基于 ACLIB 的算子开发工作流\n\n你是纯编排者（Orchestrator），读取 STATE.md 按顺序派发 SubAgent。" + "x".repeat(500);

  /** mock 调用序列：resolveWorkflowSkillName → (resources 命中则止) → recoverPlanFileDeclaration。 */
  const makeS2Prisma = (planTcs: Array<{ toolName: string; argsJson: string; resultJson: string | null }>) =>
    ({
      skillEvent: { findFirst: vi.fn().mockResolvedValueOnce({ skillName: "ops-registry-invoke-workflow" }) },
      toolCall: {
        findMany: vi.fn()
          // recoverSkillResourceFile（命中）
          .mockResolvedValueOnce([
            { toolName: "read", argsJson: '{"filePath":"/x/ops-registry-invoke-workflow/resources/task-prompts.md"}', resultJson: `<content>${resourceBody}</content>` },
          ])
          // recoverPlanFileDeclaration
          .mockResolvedValueOnce(planTcs),
      },
      turn: { findFirst: vi.fn() },
    }) as unknown as PrismaClient;

  it("双层（S2：resources 规程 + STATE.md 计划）→ 分层拼接，规程在前计划在后", async () => {
    const prisma = makeS2Prisma([
      { toolName: "read", argsJson: '{"filePath":"/repo/STATE.md"}', resultJson: `<content>${stateBody}</content>` },
    ]);
    const r = await recoverCombinedWorkflowDeclaration("ses_1", prisma);
    expect(r).not.toBeNull();
    expect(r!.content).toContain("## 一、编排规程");
    expect(r!.content).toContain("开发准备");
    expect(r!.content).toContain("## 二、任务计划");
    expect(r!.content).toContain("派发 developer");
    expect(r!.content.indexOf("## 一、编排规程")).toBeLessThan(r!.content.indexOf("## 二、任务计划"));
    expect(r!.source).toBe("规程: task-prompts.md + 计划: STATE.md");
    expect(r!.layers).toHaveLength(2);
    expect(r!.layers[0]).toMatchObject({ kind: "regulation", label: "编排规程", source: "task-prompts.md" });
    expect(r!.layers[1]).toMatchObject({ kind: "plan", label: "任务计划", source: "STATE.md" });
    // 层正文与单层提取一致（徽章匹配的锚点）
    expect(r!.layers[0].content).toContain("开发准备");
    expect(r!.layers[1].content).toContain("派发 developer");
  });

  it("双层（S1：turn0 注入规程 + STATE.md 计划）→ source 标 turn0 来源", async () => {
    const prisma = {
      skillEvent: { findFirst: vi.fn().mockResolvedValue(null) },
      toolCall: {
        findMany: vi.fn().mockResolvedValue([
          { toolName: "read", argsJson: '{"filePath":"/repo/STATE.md"}', resultJson: `<content>${stateBody}</content>` },
        ]),
      },
      turn: { findFirst: vi.fn().mockResolvedValue({ content: turn0Body }) },
    } as unknown as PrismaClient;
    const r = await recoverCombinedWorkflowDeclaration("ses_1", prisma);
    expect(r!.source).toBe("规程: turn0 (注入编排规程) + 计划: STATE.md");
    expect(r!.content).toContain("纯编排者");
    expect(r!.content).toContain("## 二、任务计划");
  });

  it("仅规程层 → 原文直出（无分层标题，与旧单层行为逐字节一致）", async () => {
    const prisma = makeS2Prisma([]);
    const r = await recoverCombinedWorkflowDeclaration("ses_1", prisma);
    expect(r!.source).toBe("task-prompts.md");
    expect(r!.content).toBe(resourceBody);
    expect(r!.content).not.toContain("## 一、编排规程");
    expect(r!.layers).toHaveLength(1);
    expect(r!.layers[0].kind).toBe("regulation");
  });

  it("仅计划层（无 invoke、turn0 短）→ 计划直出（STATE.md-only session 的 root 回归）", async () => {
    const prisma = {
      skillEvent: { findFirst: vi.fn().mockResolvedValue(null) },
      toolCall: {
        findMany: vi.fn().mockResolvedValue([
          { toolName: "read", argsJson: '{"filePath":"/repo/STATE.md"}', resultJson: `<content>${stateBody}</content>` },
        ]),
      },
      turn: { findFirst: vi.fn().mockResolvedValue({ content: "短任务" }) },
    } as unknown as PrismaClient;
    const r = await recoverCombinedWorkflowDeclaration("ses_1", prisma);
    expect(r!.source).toBe("STATE.md");
    expect(r!.content).toBe(stateBody);
    expect(r!.layers).toHaveLength(1);
    expect(r!.layers[0].kind).toBe("plan");
  });

  it("两层皆无 → null", async () => {
    const prisma = {
      skillEvent: { findFirst: vi.fn().mockResolvedValue(null) },
      toolCall: { findMany: vi.fn().mockResolvedValue([]) },
      turn: { findFirst: vi.fn().mockResolvedValue({ content: "短" }) },
    } as unknown as PrismaClient;
    expect(await recoverCombinedWorkflowDeclaration("ses_1", prisma)).toBeNull();
  });
});

describe("isDispatchOnlyAgent", () => {
  // Skills 表据此过滤：仅 dispatch（子代理分派，如 blackbox-designer）不展示为 skill。
  it("dispatch-only → true（子代理，应从 Skills 表隐藏）", () => {
    expect(isDispatchOnlyAgent([{ eventType: "dispatch" }, { eventType: "dispatch" }])).toBe(true);
  });

  it("dispatch + unload → true（unload 不算 skill 调用）", () => {
    expect(isDispatchOnlyAgent([{ eventType: "dispatch" }, { eventType: "unload" }])).toBe(true);
  });

  it("有 invoke → false（真 skill）", () => {
    expect(isDispatchOnlyAgent([{ eventType: "dispatch" }, { eventType: "invoke" }])).toBe(false);
  });

  it("有 load/use → false（真 skill）", () => {
    expect(isDispatchOnlyAgent([{ eventType: "load" }])).toBe(false);
    expect(isDispatchOnlyAgent([{ eventType: "use" }])).toBe(false);
  });

  it("空 events → true（无 skill 调用证据，按子代理处理）", () => {
    expect(isDispatchOnlyAgent([])).toBe(true);
  });
});

describe("dispatchOnlySkillNames", () => {
  // 全页统一过滤：返回仅 dispatch 的 skillName 集合，Overview/Skills 图表据此排除子代理。
  it("只列出仅有 dispatch 事件的 name", () => {
    const ev = [
      { skillName: "blackbox-designer", eventType: "dispatch" },
      { skillName: "real-skill", eventType: "invoke" },
      { skillName: "real-skill", eventType: "dispatch" },
      { skillName: "bare-dispatch", eventType: "dispatch" },
    ];
    const set = dispatchOnlySkillNames(ev);
    expect(set.has("blackbox-designer")).toBe(true);
    expect(set.has("bare-dispatch")).toBe(true);
    expect(set.has("real-skill")).toBe(false);
    expect(set.size).toBe(2);
  });

  it("load/use 也算 skill 事件（不归入排除集）", () => {
    const set = dispatchOnlySkillNames([
      { skillName: "a", eventType: "load" },
      { skillName: "b", eventType: "use" },
      { skillName: "c", eventType: "dispatch" },
    ]);
    expect(set.has("a")).toBe(false);
    expect(set.has("b")).toBe(false);
    expect(set.has("c")).toBe(true);
  });

  it("空 events → 空集", () => {
    expect(dispatchOnlySkillNames([]).size).toBe(0);
  });
});

describe("getInflightAudit", () => {
  // SiftAuditDialog 的 POST 在 useEffect 里,dev 下 remount(HMR / Fast Refresh 回退全页刷新)
  // 会重跑 effect → 不去重就再发一次不可中止的 POST(服务端 execFileSync 单跑可达 30 分钟)→
  // 堆叠抢 LLM 端点限流(实测 opdef-developer:两轮重叠,先起的被杀)。去重:同 key 在飞就复用。

  it("首次调用 → 执行 fetcher、缓存 promise", async () => {
    const cache = new Map<string, Promise<string>>();
    let calls = 0;
    const p = getInflightAudit("k", () => { calls++; return Promise.resolve("R"); }, cache);
    expect(calls).toBe(1);
    expect(cache.has("k")).toBe(true);
    await expect(p).resolves.toBe("R");
  });

  it("同 key 在飞 → 复用同一 promise,不再调 fetcher(去重核心)", async () => {
    const cache = new Map<string, Promise<string>>();
    let calls = 0;
    let resolve1!: (v: string) => void;
    const p1 = getInflightAudit("k", () => { calls++; return new Promise<string>(r => { resolve1 = r; }); }, cache);
    const p2 = getInflightAudit("k", () => { calls++; return Promise.resolve("OTHER"); }, cache);
    expect(calls).toBe(1);          // 第二次没调 fetcher
    expect(p2).toBe(p1);            // 复用同一个 promise
    resolve1("R");
    await expect(p1).resolves.toBe("R");
  });

  it("settle 后清缓存 → 下次 open 重新调 fetcher(不复用旧的)", async () => {
    const cache = new Map<string, Promise<string>>();
    let calls = 0;
    await getInflightAudit("k", () => { calls++; return Promise.resolve("R"); }, cache);
    expect(cache.has("k")).toBe(false);     // resolve 后清了
    await getInflightAudit("k", () => { calls++; return Promise.resolve("R2"); }, cache);
    expect(calls).toBe(2);                  // 第二次重新调了
  });

  it("不同 key → 独立(各自调 fetcher,不互斥)", async () => {
    const cache = new Map<string, Promise<number>>();
    let calls = 0;
    await getInflightAudit("a", () => { calls++; return Promise.resolve(1); }, cache);
    await getInflightAudit("b", () => { calls++; return Promise.resolve(2); }, cache);
    expect(calls).toBe(2);
  });

  it("reject 也 settle(清缓存 + 复用同一拒绝,失败不重发)", async () => {
    const cache = new Map<string, Promise<string>>();
    let calls = 0;
    const p1 = getInflightAudit("k", () => { calls++; return Promise.reject(new Error("boom")); }, cache);
    const p2 = getInflightAudit("k", () => { calls++; return Promise.resolve("X"); }, cache);
    expect(calls).toBe(1);
    await expect(p1).rejects.toThrow("boom");
    await expect(p2).rejects.toThrow("boom");   // 复用同一拒绝,没重发
    expect(cache.has("k")).toBe(false);
  });
});

describe("buildStructuredRecords", () => {
  // 最小 prisma mock:turn.findMany + toolCall.findMany(忽略 where,按数组序返回)。
  function makeStructuredPrisma(opts: {
    turns: Array<{
      id: string; turnIndex: number; role: string; content: string | null; agentName: string | null;
      isSubagent?: boolean; subagentSessionId?: string | null; parentExecutionId?: string | null;
    }>;
    toolCalls: Array<{ turnId: string; toolName: string; argsJson: string | null; resultJson: string | null }>;
    bridges?: Array<{ subagentSessionId: string | null; subagentType: string | null; dispatchTurnId: string | null }>;
    dispatchEvents?: Array<{ turnId: string; skillName: string }>;
  }) {
    return {
      turn: { findMany: async () => opts.turns },
      toolCall: { findMany: async () => opts.toolCalls },
      interactionBridge: { findMany: async () => opts.bridges ?? [] },
      skillEvent: { findMany: async () => opts.dispatchEvents ?? [] },
    } as unknown as PrismaClient;
  }

  it("Turn+ToolCall → {format, records}:按 turnIndex 排序,tool_calls 映射 name/input;不带 result(audit 不读工具结果)", async () => {
    const prisma = makeStructuredPrisma({
      turns: [
        { id: "t1", turnIndex: 1, role: "user", content: "分析崩溃", agentName: null },
        { id: "t2", turnIndex: 2, role: "assistant", content: "调用 skill 排查", agentName: "kernel-developer" },
      ],
      toolCalls: [
        { turnId: "t2", toolName: "skill", argsJson: '{"name":"acme-crash-debug"}', resultJson: '<skill_content name="x">B</skill_content>' },
        { turnId: "t2", toolName: "read", argsJson: '{"file_path":"x.py"}', resultJson: "content" },
      ],
    });
    const out = await buildStructuredRecords("ses_1", prisma);
    expect(out.format).toBe("sift-records");
    expect(out.records).toHaveLength(2);
    expect(out.records[0]).toMatchObject({ role: "user", text: "分析崩溃", parent_tool_use_id: null });
    const asst = out.records[1] as Record<string, unknown>;
    expect(asst).toMatchObject({ role: "assistant", text: "调用 skill 排查", agent: "kernel-developer" });
    const tcs = asst.tool_calls as Array<Record<string, unknown>>;
    // result(resultJson)恒不带:audit 判定只读 user_turns + tool 输入(input)+ assistant 文本,
    // 工具结果是死重量。即便 resultJson 非空也不回传(见下条 payload 守卫测试)。
    expect(tcs[0]).toEqual({ name: "skill", input: { name: "acme-crash-debug" } });
    expect(tcs[1]).toEqual({ name: "read", input: { file_path: "x.py" } });
    expect("result" in tcs[0]).toBe(false);
    expect("result" in tcs[1]).toBe(false);
  });

  it("子代理 turn 的 agent 用角色名（bridge.subagentType），不用任务标题（agentName）——sift --kind agent 切片匹配前提", async () => {
    const prisma = makeStructuredPrisma({
      turns: [
        { id: "t0", turnIndex: 0, role: "user", content: "开始", agentName: null },
        // agentName = 任务标题（meta.name）；角色名在 bridge.subagentType
        { id: "t1", turnIndex: 1, role: "assistant", content: "写设计", agentName: "Task10 书写DESIGN §5-§8", isSubagent: true, subagentSessionId: "sub-1" },
        // general 形态：subagentType=general → join dispatchTurnId→SkillEvent.skillName
        { id: "t2", turnIndex: 2, role: "assistant", content: "验收", agentName: "Task 15.5 评审", isSubagent: true, subagentSessionId: "sub-2" },
      ],
      toolCalls: [],
      bridges: [
        { subagentSessionId: "sub-1", subagentType: "designer", dispatchTurnId: null },
        { subagentSessionId: "sub-2", subagentType: "general", dispatchTurnId: "t-dispatch-2" },
      ],
      dispatchEvents: [{ turnId: "t-dispatch-2", skillName: "design-verifier" }],
    });
    const out = await buildStructuredRecords("ses_1", prisma);
    expect((out.records[1] as Record<string, unknown>).agent).toBe("designer");
    expect((out.records[2] as Record<string, unknown>).agent).toBe("design-verifier");
  });

  it("无角色名映射的子代理 → 回退 agentName（原生 opencode agent 字段直用）", async () => {
    const prisma = makeStructuredPrisma({
      turns: [
        { id: "t1", turnIndex: 0, role: "assistant", content: "干活", agentName: "build", isSubagent: true, subagentSessionId: "sub-x" },
      ],
      toolCalls: [],
      bridges: [],
    });
    const out = await buildStructuredRecords("ses_1", prisma);
    expect((out.records[0] as Record<string, unknown>).agent).toBe("build");
  });

  it("resultJson 巨大也不进 payload(audit 不读工具结果 → 不回传 result,免 10MB+ 撑爆结构化输入)", async () => {
    // 真实 session 的 resultJson 常达 10MB+(Read 整文件 / 大输出),而 audit 判定只读
    // user_turns + tool 输入 + assistant 文本——工具结果对 verdict 零贡献。回传它会让
    // --transcript 的 session.json 撑到 20MB+,序列化/落盘/解析全慢。守卫:再大也不进 payload。
    const prisma = makeStructuredPrisma({
      turns: [{ id: "t1", turnIndex: 0, role: "assistant", content: null, agentName: null }],
      toolCalls: [
        { turnId: "t1", toolName: "read", argsJson: '{"file_path":"big.py"}', resultJson: "X".repeat(2_000_000) },
      ],
    });
    const out = await buildStructuredRecords("ses_1", prisma);
    const tc = ((out.records[0] as Record<string, unknown>).tool_calls as Record<string, unknown>[])[0];
    expect(tc).toEqual({ name: "read", input: { file_path: "big.py" } });
    expect("result" in tc).toBe(false);
    expect(JSON.stringify(out).length).toBeLessThan(100_000);   // 2MB resultJson 没泄进 payload
  });

  it("dispatch 类(task)带 result(子代理最终报告,层3 派发-回报对证据源);其他工具不带", async () => {
    const prisma = makeStructuredPrisma({
      turns: [{ id: "t1", turnIndex: 0, role: "assistant", content: "编排", agentName: null }],
      toolCalls: [
        { turnId: "t1", toolName: "task", argsJson: '{"subagent_type":"verifier","prompt":"验收 Task 47"}', resultJson: "<task>…</task>\nFAILED: 254/275" },
        { turnId: "t1", toolName: "read", argsJson: '{"file_path":"x.py"}', resultJson: "content" },
      ],
    });
    const out = await buildStructuredRecords("ses_1", prisma);
    const tcs = (out.records[0] as Record<string, unknown>).tool_calls as Array<Record<string, unknown>>;
    expect(tcs[0]).toMatchObject({
      name: "task",
      input: { subagent_type: "verifier", prompt: "验收 Task 47" },
      result: "<task>…</task>\nFAILED: 254/275",
    });
    expect("result" in tcs[1]).toBe(false);   // 非 dispatch 不带
  });

  it("dispatch result 截断 4096;超大 dispatch resultJson 也不爆 payload", async () => {
    const prisma = makeStructuredPrisma({
      turns: [{ id: "t1", turnIndex: 0, role: "assistant", content: null, agentName: null }],
      toolCalls: [
        { turnId: "t1", toolName: "task", argsJson: '{"prompt":"p"}', resultJson: "R".repeat(2_000_000) },
        { turnId: "t1", toolName: "agent", argsJson: '{"subagent_type":"dev"}', resultJson: "A".repeat(5000) },
      ],
    });
    const out = await buildStructuredRecords("ses_1", prisma);
    const tcs = (out.records[0] as Record<string, unknown>).tool_calls as Array<Record<string, unknown>>;
    expect((tcs[0].result as string).length).toBe(4096);
    expect((tcs[1].result as string).length).toBe(4096);   // agent 形态同样截断
    expect(JSON.stringify(out).length).toBeLessThan(100_000);
  });

  it("dispatch resultJson 空 → 不带 result 键(reader 容错,不产 tool_result)", async () => {
    const prisma = makeStructuredPrisma({
      turns: [{ id: "t1", turnIndex: 0, role: "assistant", content: null, agentName: null }],
      toolCalls: [
        { turnId: "t1", toolName: "task", argsJson: '{"prompt":"p"}', resultJson: null },
      ],
    });
    const out = await buildStructuredRecords("ses_1", prisma);
    const tcs = (out.records[0] as Record<string, unknown>).tool_calls as Array<Record<string, unknown>>;
    expect(tcs[0]).toEqual({ name: "task", input: { prompt: "p" } });
    expect("result" in tcs[0]).toBe(false);
  });

  it("无 turn → records 空(仍带 format 标记)", async () => {
    const prisma = makeStructuredPrisma({ turns: [], toolCalls: [] });
    const out = await buildStructuredRecords("ses_x", prisma);
    expect(out.format).toBe("sift-records");
    expect(out.records).toEqual([]);
  });

  it("argsJson 坏 / 空 → input 为 {}", async () => {
    const prisma = makeStructuredPrisma({
      turns: [{ id: "t1", turnIndex: 0, role: "assistant", content: null, agentName: null }],
      toolCalls: [
        { turnId: "t1", toolName: "bash", argsJson: "not-json", resultJson: null },
        { turnId: "t1", toolName: "write", argsJson: null, resultJson: null },
      ],
    });
    const out = await buildStructuredRecords("ses_1", prisma);
    const tcs = (out.records[0] as Record<string, unknown>).tool_calls as Array<Record<string, unknown>>;
    expect(tcs[0].input).toEqual({});
    expect(tcs[1].input).toEqual({});
    // result 恒不带(audit 不读工具结果)→ 无 result 键
    expect("result" in tcs[0]).toBe(false);
    // content 为 null 的 turn → 不带 text 键
    expect("text" in (out.records[0] as Record<string, unknown>)).toBe(false);
  });

  it("子 agent turn 的 parent_tool_use_id = subagentSessionId;主 turn 仍 null(scope-aware 切段)", async () => {
    // sift 切片器(slice.py _scope_of)按 parent_tool_use_id 归作用域:None=主,其他值=
    // 某子 agent。之前 buildStructuredRecords 恒 null → 子 agent 里跑的 skill 段被主 scope 的
    // last-invoked-owns 污染(主 scope 噪声混进段)。修:子 agent turn 指到自己的 subagentSessionId。
    // 零嵌套数据下即正确(无需合成 Agent tool_use;见 slice.py 的 scope 归段 + depth-1 closure)。
    const prisma = makeStructuredPrisma({
      turns: [
        { id: "t1", turnIndex: 0, role: "user", content: "main turn", agentName: null },
        { id: "t2", turnIndex: 1, role: "assistant", content: "subagent turn", agentName: "developer",
          isSubagent: true, subagentSessionId: "sub-ses-1" },
      ],
      toolCalls: [],
    });
    const out = await buildStructuredRecords("ses_1", prisma);
    expect((out.records[0] as Record<string, unknown>).parent_tool_use_id).toBeNull();
    expect((out.records[1] as Record<string, unknown>).parent_tool_use_id).toBe("sub-ses-1");
  });

  it("不同 subagentSessionId → 不同 scope(同 agent 两次独立 dispatch 不被合并)", async () => {
    // agentName 不能当 scope key:同 agent 多次 dispatch 会合并成一段。subagentSessionId 每次
    // dispatch 唯一,正确区分独立 run。
    const prisma = makeStructuredPrisma({
      turns: [
        { id: "a1", turnIndex: 0, role: "assistant", content: null, agentName: "dev",
          isSubagent: true, subagentSessionId: "sub-1" },
        { id: "a2", turnIndex: 1, role: "assistant", content: null, agentName: "dev",
          isSubagent: true, subagentSessionId: "sub-1" },
        { id: "b1", turnIndex: 2, role: "assistant", content: null, agentName: "dev",
          isSubagent: true, subagentSessionId: "sub-2" },
      ],
      toolCalls: [],
    });
    const out = await buildStructuredRecords("ses_1", prisma);
    const ptids = out.records.map((r) => (r as Record<string, unknown>).parent_tool_use_id);
    expect(ptids).toEqual(["sub-1", "sub-1", "sub-2"]);
  });

  it("子 agent turn 无 subagentSessionId → 回退 parentExecutionId(仍隔离出主 scope)", async () => {
    // 数据质量缺口:isSubagent=true 但 subagentSessionId 缺。用 parentExecutionId(每次 dispatch
    // 唯一)兜底,仍把该 run 隔离出主 scope,不退化回 flat。
    const prisma = makeStructuredPrisma({
      turns: [
        { id: "t1", turnIndex: 0, role: "assistant", content: null, agentName: "dev",
          isSubagent: true, subagentSessionId: null, parentExecutionId: "exec-1" },
      ],
      toolCalls: [],
    });
    const out = await buildStructuredRecords("ses_1", prisma);
    expect((out.records[0] as Record<string, unknown>).parent_tool_use_id).toBe("exec-1");
  });
});
