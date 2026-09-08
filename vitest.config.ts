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
    exclude: ["tests/**/*.bench.ts", "tests/**/*.bench.tsx", "node_modules", "dist", ".next"],
    // cpx 网关测试已随包独立到 packages/cpx（自带 vitest，npm run test）；
    // 这里只跑 insight 自己的用例（Prisma 集成测试需要 @ alias + react 插件）
    projects: [
      {
        plugins: [react()],
        resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
        test: {
          name: "insight",
          include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
          setupFiles: ["./tests/setup.ts"],
        },
      },
    ],
  },
});
