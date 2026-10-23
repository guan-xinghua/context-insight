// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import type { PrismaClient } from "@prisma/client";
import {
  DEFAULT_PLUGIN,
  getWorkflowExtractPlugin,
  resolvePluginFromRaw,
  resetWorkflowExtractConfigCache,
  setWorkflowExtractPluginForTests,
  ensureWorkflowExtractPluginLoaded,
  type WorkflowExtractPlugin,
} from "@/lib/workflow-extract-config";
import { recoverPlanFileDeclaration, recoverCombinedWorkflowDeclaration } from "@/lib/sift-audit";

/** 造 mock prisma：recoverPlanFileDeclaration 只查 toolCall.findMany。 */
function makePlanPrisma(tcs: Array<{ toolName: string; argsJson: string | null; resultJson: string | null }>) {
  return { toolCall: { findMany: async () => tcs } } as unknown as PrismaClient;
}

/** 另一领域的插件：MILESTONES.md 白名单，其余回退默认。 */
const MILESTONE_PLUGIN: WorkflowExtractPlugin = {
  name: "example-milestone",
  description: "里程碑领域测试插件",
  regulation: DEFAULT_PLUGIN.regulation,
  plan: {
    fileNames: ["MILESTONES.md"],
    bodyMinChars: 100,
    excludedDirs: ["resources", "templates"],
  },
};

afterEach(() => {
  setWorkflowExtractPluginForTests(null);
  resetWorkflowExtractConfigCache();
});

describe("workflow-extract-config（主 agent 组合声明提取插件）", () => {
  it("默认插件 = workflow-ops 现值（STATE.md 白名单 / 阈值），native 行为不变", () => {
    const p = getWorkflowExtractPlugin();
    expect(p.name).toBe("workflow-ops");
    expect(p.plan.fileNames).toEqual(["STATE.md"]);
    expect(p.plan.fileNames).not.toContain("MILESTONES.md");
    expect(p.plan.bodyMinChars).toBe(100);
    expect(p.regulation.turn0MinChars).toBe(500);
    expect(p.regulation.resourceDirs).toEqual(["resources"]);
    expect(p.plan.excludedDirs).toEqual(["resources", "templates"]);
  });

  it("换插件后计划文件识别跟着变：MILESTONES.md 进 named 桶（默认插件不识别）", async () => {
    const body = "# 里程碑\n\n## Milestones\n\n- [ ] M1 数据管道\n- [ ] M2 模型评测\n- [ ] M3 上线\n" + "x".repeat(120);
    const prisma = makePlanPrisma([
      { toolName: "read", argsJson: '{"filePath":"/x/MILESTONES.md"}', resultJson: `<content>${body}</content>` },
    ]);

    // 默认插件：MILESTONES.md 不在白名单 → null（scan 兜底已移除，宁漏不可误）
    const byDefault = await recoverPlanFileDeclaration("ses_1", prisma);
    expect(byDefault).toBeNull();

    // 里程碑插件：MILESTONES.md 进 named 桶
    setWorkflowExtractPluginForTests(MILESTONE_PLUGIN);
    const byPlugin = await recoverPlanFileDeclaration("ses_1", prisma);
    expect(byPlugin?.source).toBe("MILESTONES.md");
  });

  it("换插件后 STATE.md 反而不再识别（领域白名单是全集替换，非追加）", async () => {
    const body = "# STATE\n\n## Tasks\n\n- [ ] 1. 派发 developer\n- [ ] 2. 验收\n- [ ] 3. 归档\n" + "x".repeat(120);
    const prisma = makePlanPrisma([
      { toolName: "read", argsJson: '{"filePath":"/repo/STATE.md"}', resultJson: `<content>${body}</content>` },
    ]);

    setWorkflowExtractPluginForTests(MILESTONE_PLUGIN);
    // STATE.md 不在里程碑白名单 → null（领域白名单是全集替换，非追加）
    const r = await recoverPlanFileDeclaration("ses_1", prisma);
    expect(r).toBeNull();
  });

  it("换插件后 plan-like 标题集已删（isPlanLike 砍掉后不再有内容特征过滤）", async () => {
    // 无 checklist、无编号、无计划标题的正文 —— 白名单命中即提取（内容不再过滤）
    const body = "## 里程碑\n\n只写里程碑说明，无 checklist 无编号。" + "x".repeat(120);
    const prisma = makePlanPrisma([
      { toolName: "read", argsJson: '{"filePath":"/x/MILESTONES.md"}', resultJson: `<content>${body}</content>` },
    ]);

    // 默认插件：MILESTONES.md 不在白名单 → null
    expect(await recoverPlanFileDeclaration("ses_1", prisma)).toBeNull();

    // 里程碑插件：白名单命中 → named 提取（内容特征不参与判定）
    setWorkflowExtractPluginForTests(MILESTONE_PLUGIN);
    const r = await recoverPlanFileDeclaration("ses_1", prisma);
    expect(r?.source).toBe("MILESTONES.md");
  });

  it("组合声明随插件变：计划层 source 用插件识别的文件名", async () => {
    const stateBody = "# 里程碑\n\n## Milestones\n\n- [ ] M1\n- [ ] M2\n- [ ] M3\n" + "x".repeat(120);
    const prisma = {
      skillEvent: { findFirst: async () => null },
      toolCall: { findMany: async () => [
        { toolName: "read", argsJson: '{"filePath":"/x/MILESTONES.md"}', resultJson: `<content>${stateBody}</content>` },
      ] },
      turn: { findFirst: async () => null },
    } as unknown as PrismaClient;

    setWorkflowExtractPluginForTests(MILESTONE_PLUGIN);
    const r = await recoverCombinedWorkflowDeclaration("ses_1", prisma);
    expect(r).not.toBeNull();
    expect(r!.layers).toHaveLength(1);
    expect(r!.layers[0]).toMatchObject({ kind: "plan", source: "MILESTONES.md" });
  });

  it("插件 plan.excludedDirs 变更：非默认排除目录的计划文件可进计划层", async () => {
    // skill 打包目录假设改为 assets/：assets/ 下的任务清单被排除，resources/ 下的不再被排除
    const plugin: WorkflowExtractPlugin = {
      ...MILESTONE_PLUGIN,
      plan: { ...MILESTONE_PLUGIN.plan, fileNames: ["STATE.md"], excludedDirs: ["assets"] },
    };
    const body = "# STATE\n\n## Tasks\n\n- [ ] 1. a\n- [ ] 2. b\n- [ ] 3. c\n" + "x".repeat(120);
    const prisma = makePlanPrisma([
      { toolName: "read", argsJson: '{"filePath":"/skill/x/resources/STATE.md"}', resultJson: `<content>${body}</content>` },
      { toolName: "read", argsJson: '{"filePath":"/skill/x/assets/STATE.md"}', resultJson: `<content>${body}</content>` },
    ]);

    setWorkflowExtractPluginForTests(plugin);
    // resources/ 不再是排除目录 → 该路径的 STATE.md 可进 named 桶
    const r = await recoverPlanFileDeclaration("ses_1", prisma);
    expect(r?.source).toBe("STATE.md");
  });

  it("setWorkflowExtractPluginForTests(null) + reset → 回默认插件", () => {
    setWorkflowExtractPluginForTests(MILESTONE_PLUGIN);
    expect(getWorkflowExtractPlugin().name).toBe("example-milestone");
    setWorkflowExtractPluginForTests(null);
    resetWorkflowExtractConfigCache();
    expect(getWorkflowExtractPlugin().name).toBe("workflow-ops");
  });

  it("resolvePluginFromRaw：部分字段覆盖、缺省/非法回退默认", () => {
    const p = resolvePluginFromRaw("custom", {
      plan: {
        fileNames: ["MILESTONES.md"],
        bodyMinChars: 0, // 非法（≤0）→ 回退默认 100
      },
      regulation: { turn0MinChars: 800 }, // 其余 regulation 字段缺省 → 默认
    });
    expect(p.name).toBe("custom");
    expect(p.plan.fileNames).toEqual(["MILESTONES.md"]);
    expect(p.plan.bodyMinChars).toBe(100);
    expect(p.plan.excludedDirs).toEqual(DEFAULT_PLUGIN.plan.excludedDirs);
    expect(p.regulation.turn0MinChars).toBe(800);
    expect(p.regulation.resourceDirs).toEqual(DEFAULT_PLUGIN.regulation.resourceDirs);
  });

  it("ensureWorkflowExtractPluginLoaded：无配置文件 → 幂等返回默认，不抛错", () => {
    // 仓库根无 workflow-extract-plugins.json（gitignore；CI 必然如此）→ DEFAULT。
    // 本地若手动创建了该文件，跳过路径断言（只验证幂等 + 不抛错）。
    const hasLocalConfig = fs.existsSync("workflow-extract-plugins.json");
    const p1 = ensureWorkflowExtractPluginLoaded();
    const p2 = ensureWorkflowExtractPluginLoaded();
    expect(p2).toBe(p1);
    if (!hasLocalConfig) {
      expect(p1.name).toBe("workflow-ops");
      expect(getWorkflowExtractPlugin().name).toBe("workflow-ops");
    }
    resetWorkflowExtractConfigCache();
  });
});

describe("客户端可达性静态锁（node:fs 不得进 client bundle）", () => {
  // 回归背景：sift-audit.ts 被 session page 的客户端组件 import，它顶层 import 的模块
  // 全部进 client bundle——曾把含 node:fs 的 workflow-extract-config 拖进客户端触发
  // Turbopack "does not support external modules (node:fs)"。此锁保证同类回归在测试期
  // 即被发现（无需起 dev server 等构建报错）。
  const CLIENT_REACHABLE = [
    "src/lib/sift-audit.ts",
    "src/lib/workflow-extract-plugin.ts",
    "src/lib/skill-audit-job.ts",
    "src/lib/sift-audit-types.ts",
    "src/lib/agent-role-name-map.ts",
  ];

  it.each(CLIENT_REACHABLE)("%s 顶层不 import node:fs / node:path / node:child_process / server-only 加载器", (file) => {
    const src = fs.readFileSync(file, "utf-8");
    expect(src).not.toMatch(/from\s+["']node:(fs|path|child_process)/);
    // workflow-extract-config 是 server-only fs 加载器，客户端可达文件不得引入
    expect(src).not.toContain('from "@/lib/workflow-extract-config"');
    expect(src).not.toContain('from "./workflow-extract-config"');
  });
});
