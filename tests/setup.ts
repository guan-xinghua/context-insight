// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";

// fresh clone 兜底（镜像 start.sh 默认值）：.env 由 pretest 的 ensure-test-db 创建，
// 但 vitest worker 进程不自动读 .env，缺此默认时全部套件死在 $connect
process.env.DATABASE_URL ||= "file:./dev.db";
// 测试进程统一加大 socket_timeout（Prisma sqlite URL 参数，单位秒）：全量并行
// worker 共写同一 dev.db，SQLite 单写者锁下默认 5s 偶发 "Socket timeout" flake
//（现场：opencode-v2-refresh ① 连锁 5 红）。仅测试侧放大等待——服务端运行时
// 仍走 .env 默认，不受影响；先设先赢（||=）语义下 CI 想覆盖可直接带参设置。
if (!process.env.DATABASE_URL.includes("socket_timeout=")) {
  process.env.DATABASE_URL += process.env.DATABASE_URL.includes("?") ? "&socket_timeout=60" : "?socket_timeout=60";
}

// 统一日志全局静音：被测模块（data-service/lake 层等）引入 logger 后，全量测试
// 会把日志写进真实 ~/.cannbot-insight/logs/。||= 语义 = 显式设置优先（CI 想开
// 日志设 CANNBOT_LOG=1 即可）；logger 自己的测试文件内在 beforeAll 删掉此变量
process.env.CANNBOT_LOG ||= "0";

const prisma = new PrismaClient();

beforeAll(async () => {
  // Probe native addons that vitest loads in-worker. A `node` upgrade leaves
  // the compiled binary on a stale ABI → "Module did not self-register" /
  // NODE_MODULE_VERSION mismatch, which surfaces as a dozen cryptic test
  // failures. Fail fast with one actionable message instead. (`npm run test`
  // auto-rebuilds via pretest; this guards bare `npx vitest` runs.)
  try {
    const mod = await import("better-sqlite3");
    const Database = (mod as { default?: unknown }).default ?? mod;
    const db = new (Database as new (s: string) => { close: () => void })(":memory:");
    db.close();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/NODE_MODULE_VERSION|did not self-register|was compiled against a different Node\.js version/i.test(msg)) {
      throw new Error(
        `Native addon better-sqlite3 is stale (Node ABI mismatch after a Node.js upgrade).\n` +
        `Run: npm rebuild better-sqlite3   (or: ./start.sh -u)\n` +
        `Original error: ${msg}`
      );
    }
    throw e;
  }
  // WAL 下 many-worker 并发首开 -shm 有瞬时锁竞争（偶发 SQLITE_CANTOPEN/
  // BUSY），有界重试即过；真实连接错误重试耗尽后原样抛出。满并行 worker
  // 冷启动（WAL 未初始化）时 3×(200/400/600ms) 预算偶发耗尽——那个 worker
  // 的整个测试文件红、重跑即绿（flaky 源头），改 6 次指数退避（最长 ~16s）
  let lastErr: unknown;
  for (let i = 0; i < 6; i++) {
    try {
      await prisma.$connect();
      lastErr = undefined;
      break;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 250 * 2 ** i));
    }
  }
  if (lastErr) throw lastErr;
});

afterAll(async () => {
  await prisma.$disconnect();
});

export { prisma };
