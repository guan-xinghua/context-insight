// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    // 输出降噪：dot 只留进度点与末尾汇总（默认逐文件 ✓ 行不打）；
    // passed-only 静默通过用例的 console/stderr，失败用例的照常输出定位
    reporters: ["dot"],
    silent: "passed-only",
    exclude: ["tests/**/*.bench.ts", "tests/**/*.bench.tsx", "node_modules", "dist", ".next"],
    // COVERAGE=1（scripts/run-tests.sh → npm run test:cov → --coverage）：
    // v8 provider 统计 src/ 全量（不挑文件），终端只打 text-summary 摘要，
    // 逐文件明细看 lcov/html（落 coverage/，供流水线归档与人工查看）
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text-summary", "lcov", "html"],
    },
    // cpx 网关测试已随包独立到 packages/cpx（自带 vitest，npm run test）；
    // 这里只跑 insight 自己的用例（Prisma 集成测试需要 @ alias + react 插件）
    projects: [
      {
        plugins: [react()],
        resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
        test: {
          name: "insight",
          include: ["tests/ut/**/*.test.ts", "tests/ut/**/*.test.tsx", "tests/e2e/**/*.test.ts", "tests/e2e/**/*.test.tsx"],
          setupFiles: ["./tests/setup.ts"],
          // upload/git 类 IT 在全量并行的资源竞争下偶发超 5s 默认预算（隔离跑 <2s），
          // 统一放宽到 30s：慢机器/满并行都有余量，不拖慢正常通过
          testTimeout: 30_000,
        },
      },
    ],
  },
});
