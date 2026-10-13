// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Pre-test guard: 测试库隔离。测试一律写独立 prisma/test.db，真实 prisma/dev.db
// （常驻 server 的生产库）从物理上与测试断开——夹具会话不可能再泄进用户数据
// （历史缺陷：测试直连共享 dev.db，漏清理的夹具会出现在会话列表里、删了下次
// 跑测试又回来）。每次运行**重建** test.db：上一轮夹具残留随建随清，run-to-run
// 确定性；schema 沿用 tracked migrations（migrate deploy）。`.env` 引导保留
// （server 侧 fresh clone 兜底，与 start.sh 默认一致；测试在 setup.ts 里先于
// PrismaClient 构造把 DATABASE_URL 指向 test.db，不读 .env）。Run via the
// `pretest` hook（npm 只对 `test` 名挂钩，test:e2e / test:cov 已显式串联）。

import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(PKG_DIR + '/');

if (!existsSync(path.join(PKG_DIR, '.env'))) {
  writeFileSync(path.join(PKG_DIR, '.env'), 'DATABASE_URL="file:./dev.db"\n');
  console.warn('[ensure-test-db] .env created with default DATABASE_URL');
}

// 重建 test.db（worker 拉起前的单进程窗口执行，无并发）：先删主文件与
// WAL/journal 边车，再重放 migrations——fresh clone 与存量环境同一条路
const TEST_DB = path.join(PKG_DIR, 'prisma', 'test.db');
for (const suffix of ['', '-wal', '-shm', '-journal']) {
  const f = TEST_DB + suffix;
  if (existsSync(f)) rmSync(f);
}
const prismaBin = require.resolve('prisma/build/index.js');
const r = spawnSync(process.execPath, [prismaBin, 'migrate', 'deploy'], {
  cwd: PKG_DIR,
  stdio: 'inherit',
  // 绝对路径显式传入：压过 .env 的 dev.db（prisma CLI env 优先于 .env）
  env: { ...process.env, DATABASE_URL: `file:${TEST_DB}` },
});
if (r.status !== 0) {
  console.error(`[ensure-test-db] prisma migrate deploy failed: exit ${r.status}`);
  process.exit(1);
}
console.warn('[ensure-test-db] prisma/test.db rebuilt via migrations');

// 并发自愈：test.db 切 WAL（幂等）。默认 rollback-journal（delete）模式每次
// 写锁全库，满并行用例的读写互斥是偶发 SQLITE_BUSY → 用例超时类 flake 的
// 系统性根因；WAL 下读不阻塞写。切不上（被长事务占住等）只警告不拦测试
// ——退化为现状行为。
try {
  const mod = require('better-sqlite3');
  const Database = mod.default ?? mod;
  const db = new Database(TEST_DB, { timeout: 10_000 });
  const mode = db.pragma('journal_mode = WAL', { simple: true });
  db.close();
  if (mode === 'wal') console.warn('[ensure-test-db] test.db journal_mode=WAL');
  else console.warn(`[ensure-test-db] journal_mode=${mode}（WAL 未生效，跳过）`);
} catch (e) {
  console.warn(`[ensure-test-db] WAL 切换失败（不影响继续）: ${e instanceof Error ? e.message : e}`);
}
