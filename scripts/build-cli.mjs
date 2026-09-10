// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// CLI 单文件 bundle（npm prepack 钩子）：src/cli/index.ts → dist/cli.mjs。
// 动机：tsx 在 node_modules 内的文件上硬性禁用 tsconfig paths（isDependencyPath），
// npm 全局安装态（包位于 lib/node_modules/<name>）下 `--import tsx` 起 src/cli/index.ts
// 会在 `@/lib/...` 别名导入上 ERR_MODULE_NOT_FOUND。esbuild 在打包期解析别名，
// 产物运行时零别名依赖；bin 启动器优先用 dist/cli.mjs，仓内开发态（无 dist）回退 tsx。
// packages:"external" —— 只打包自有 src，依赖（commander/ink/react/@prisma/client 等）
// 运行时从包内 node_modules 正常解析（native/生成码不进 bundle）。
import esbuild from "esbuild"
import path from "node:path"
import fs from "node:fs"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "..")

const atAliasPlugin = {
  name: "at-alias",
  setup(build) {
    build.onResolve({ filter: /^@\// }, (args) => {
      const rel = args.path.replace(/^@\//, "")
      const base = path.resolve(root, "src", rel)
      for (const ext of ["", ".tsx", ".ts", "/index.tsx", "/index.ts", "/index.js"]) {
        const candidate = base + ext
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return { path: candidate }
        }
      }
      throw new Error(`@/ 别名解析失败: ${args.path}`)
    })
  },
}

await esbuild.build({
  entryPoints: [path.resolve(root, "src/cli/index.ts")],
  bundle: true,
  outfile: path.resolve(root, "dist/cli.mjs"),
  format: "esm",
  platform: "node",
  target: "node20",
  packages: "external",
  loader: { ".ts": "ts", ".tsx": "tsx" },
  plugins: [atAliasPlugin],
  resolveExtensions: [".tsx", ".ts", ".jsx", ".js", ".json"],
  legalComments: "none",
  logLevel: "info",
}).catch((e) => {
  console.error(e)
  process.exit(1)
})
