// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

/**
 * 主 agent 组合声明提取插件的**客户端安全核心**（无 fs/path/child_process import）。
 *
 * sift-audit.ts 被客户端组件（session page → SkillDetail/SkillAuditTab）引用，凡它 import
 * 的模块都会进 client bundle——所以 fs 读配置的逻辑必须隔离在 server-only 的
 * `workflow-extract-config.ts`（镜像 agent-md-scan.ts 的隔离模式）：
 *
 * - 本模块：类型 + cann-ops 默认值 + 纯合并 + 生效插件的内存 holder（fs-free）。
 * - workflow-extract-config.ts（server-only）：读 workflow-extract-plugins.json，
 *   `ensureWorkflowExtractPluginLoaded()` 把结果灌进本模块 holder。API 路由入口调用
 *   一次激活；不激活（单测直调 recover*）→ 回退 DEFAULT_PLUGIN（cann-ops 现行为）。
 *
 * 提取管线本身（两层模型、计划层 named-Read 过滤、首次实质读取）是领域无关引擎，不进配置。
 */

export interface RegulationPluginConfig {
  /** skill 编排模板所在目录（filePath 含其一即认作 resource 候选）。 */
  resourceDirs: string[];
  /** turn0 注入编排规程的最小长度（低于视为普通短用户任务）。 */
  turn0MinChars: number;
  /** 规程层正文（resources / SKILL.md body）的最小长度。 */
  bodyMinChars: number;
}

export interface PlanPluginConfig {
  /** 计划文件名白名单（basename，大小写不敏感）。 */
  fileNames: string[];
  /** 计划层正文的最小长度。 */
  bodyMinChars: number;
  /** skill 打包目录（这些目录下的文件是 skill 声明素材，不进计划层，防与规程层同文双计）。 */
  excludedDirs: string[];
}

export interface WorkflowExtractPlugin {
  name: string;
  description: string;
  regulation: RegulationPluginConfig;
  plan: PlanPluginConfig;
}

/** cann-ops 默认插件：与重构前 sift-audit.ts 的硬编码值逐一相等（native 行为不变）。 */
export const DEFAULT_PLUGIN: WorkflowExtractPlugin = {
  name: "cann-ops",
  description: "算子生成任务（CANN ops workflow）的定制提取——STATE.md 任务清单 + workflow skill 编排规程",
  regulation: {
    resourceDirs: ["resources"],
    turn0MinChars: 500,
    bodyMinChars: 100,
  },
  plan: {
    fileNames: ["STATE.md"],
    bodyMinChars: 100,
    excludedDirs: ["resources", "templates"],
  },
};

/** workflow-extract-plugins.json 的文件 shape（server-only 加载器解析用）。 */
export interface PluginFileConfig {
  active?: string;
  plugins?: Record<string, PartialPluginConfig>;
}

function nonEmptyArray(a: string[] | undefined): string[] | null {
  return a && a.length > 0 ? a : null;
}

function positiveInt(n: number | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/** resolvePluginFromRaw 的入参：JSON 里的（深层）部分字段，缺省回退默认。 */
export type PartialPluginConfig = {
  description?: string;
  regulation?: Partial<RegulationPluginConfig>;
  plan?: Partial<PlanPluginConfig>;
};

/**
 * 纯合并：JSON 里的部分字段覆盖 cann-ops 默认值（缺省/非法字段回退默认）。
 * 导出供 server 加载器与测试复用。
 */
export function resolvePluginFromRaw(name: string, raw: PartialPluginConfig): WorkflowExtractPlugin {
  const d = DEFAULT_PLUGIN;
  return {
    name,
    description: raw.description ?? d.description,
    regulation: {
      resourceDirs: nonEmptyArray(raw.regulation?.resourceDirs) ?? d.regulation.resourceDirs,
      turn0MinChars: positiveInt(raw.regulation?.turn0MinChars) ?? d.regulation.turn0MinChars,
      bodyMinChars: positiveInt(raw.regulation?.bodyMinChars) ?? d.regulation.bodyMinChars,
    },
    plan: {
      fileNames: nonEmptyArray(raw.plan?.fileNames) ?? d.plan.fileNames,
      bodyMinChars: positiveInt(raw.plan?.bodyMinChars) ?? d.plan.bodyMinChars,
      excludedDirs: nonEmptyArray(raw.plan?.excludedDirs) ?? d.plan.excludedDirs,
    },
  };
}

/** 测试注入（优先级最高）；用后配 resetWorkflowExtractPlugin 清除。 */
let testOverride: WorkflowExtractPlugin | null = null;
/** server 加载器（ensureWorkflowExtractPluginLoaded）灌入的文件插件。 */
let loadedPlugin: WorkflowExtractPlugin | null = null;

/** 测试注入（优先级最高）。 */
export function setWorkflowExtractPluginForTests(p: WorkflowExtractPlugin | null): void {
  testOverride = p;
}

/** server 加载器灌入文件插件（仅 workflow-extract-config.ts 调用）。 */
export function setLoadedWorkflowExtractPlugin(p: WorkflowExtractPlugin | null): void {
  loadedPlugin = p;
}

/** 清空测试注入 + 文件加载缓存（回到 DEFAULT_PLUGIN）。 */
export function resetWorkflowExtractPlugin(): void {
  testOverride = null;
  loadedPlugin = null;
}

/** 取当前生效的提取插件：测试注入 > server 加载的文件插件 > 代码默认（cann-ops）。 */
export function getWorkflowExtractPlugin(): WorkflowExtractPlugin {
  if (testOverride) return testOverride;
  if (loadedPlugin) return loadedPlugin;
  return DEFAULT_PLUGIN;
}
