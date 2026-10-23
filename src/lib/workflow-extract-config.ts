// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_PLUGIN,
  getWorkflowExtractPlugin,
  resolvePluginFromRaw,
  resetWorkflowExtractPlugin,
  setLoadedWorkflowExtractPlugin,
  setWorkflowExtractPluginForTests,
  type PluginFileConfig,
  type WorkflowExtractPlugin,
} from "./workflow-extract-plugin";

/**
 * 主 agent 组合声明提取插件的**server-only 加载器**（fs/path）。
 *
 * Server-only：sift-audit.ts 被客户端组件引用（session page → SkillDetail/SkillAuditTab），
 * 它 import 的模块全部进 client bundle——故 fs 读取必须隔离在本文件（镜像 agent-md-scan.ts
 * 的隔离模式），由 API 路由入口 import 并调用。**禁止**被 sift-audit.ts / 组件等客户端
 * 可达文件 import（Turbopack 会报 "does not support external modules (node:fs)"）。
 *
 * 加载部署根的 `workflow-extract-plugins.json`（schema 见 .example；缺省字段回退 workflow-ops
 * 默认），`ensureWorkflowExtractPluginLoaded()` 进程内只读一次并灌进 plugin 核心的 holder。
 * 换领域 = 复制 example 改约定 + active 切 key，零代码改动。
 */

const CONFIG_FILENAME = "workflow-extract-plugins.json";

let loaded = false;

/**
 * 读 workflow-extract-plugins.json 并激活（进程内一次；幂等）。
 * 无文件 / 坏 JSON / 空 plugins → 保持 DEFAULT_PLUGIN（workflow-ops）。
 * API 路由入口（audit-skillsift / main-agent-workflow / skill-content）在提取前调用。
 */
export function ensureWorkflowExtractPluginLoaded(): WorkflowExtractPlugin {
  if (loaded) return getWorkflowExtractPlugin();
  loaded = true;
  try {
    const configPath = path.join(process.cwd(), CONFIG_FILENAME);
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as PluginFileConfig;
      const entries = Object.entries(raw.plugins ?? {});
      if (entries.length > 0) {
        const key = raw.active && raw.plugins?.[raw.active] ? raw.active : entries[0][0];
        setLoadedWorkflowExtractPlugin(resolvePluginFromRaw(key, raw.plugins![key]));
        return getWorkflowExtractPlugin();
      }
    }
  } catch (e) {
    console.warn(`Failed to load ${CONFIG_FILENAME}, using default plugin:`, e);
  }
  setLoadedWorkflowExtractPlugin(null);
  return DEFAULT_PLUGIN;
}

/** 测试用：清空加载标记 + holder（回 DEFAULT_PLUGIN；也清测试注入）。 */
export function resetWorkflowExtractConfigCache(): void {
  loaded = false;
  resetWorkflowExtractPlugin();
}

export {
  DEFAULT_PLUGIN,
  getWorkflowExtractPlugin,
  resolvePluginFromRaw,
  setWorkflowExtractPluginForTests,
  resetWorkflowExtractPlugin,
};
export type { WorkflowExtractPlugin, RegulationPluginConfig, PlanPluginConfig, PluginFileConfig } from "./workflow-extract-plugin";
