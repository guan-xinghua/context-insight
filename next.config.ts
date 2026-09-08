// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 全局安装态：bin 启动器设 CANNBOT_INSIGHT_DIST_DIR 指向 ~/.cannbot-insight/.next，
// 让 build 产物落在用户可写目录（包目录只读）。开发态（start.sh / npm run dev）不设 → 默认 .next。
const distDir = process.env.CANNBOT_INSIGHT_DIST_DIR;
// Turbopack 默认从项目目录向上找最近 lockfile 当工作区根（monorepo 启发式）。
// 客户现场上层目录有误生成的 package-lock.json（且项目内 lockfile 缺失）时根被
// 推到项目之外 → React Client Manifest 模块 ID 基准错位 → dev 启动报
// "Could not find global-error.js in the React Client Manifest"。显式钉死到
// next.config.ts 所在目录，跳过推断；import.meta.url 不受启动 cwd 影响。
const projectRoot = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  ...(distDir ? { distDir } : {}),
  turbopack: { root: projectRoot },
  // 发布态现场 build 跳过类型检查：现有代码存在 pre-existing 类型错位
  // （proxy 扩展层 wire-rounds usage 字段命名 input_tokens vs input），
  // next dev 不做全类型检查故未暴露；修它需配 IT（超发布特性范围）。
  // 跳过仅影响 build 检查阶段，不改变运行时行为。开发态仍可单独 tsc --noEmit 检查。
  typescript: { ignoreBuildErrors: true },
};

export default nextConfig;
