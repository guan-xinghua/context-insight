// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Pre-test guard: make the suite runnable on a fresh clone (CI included) where
// `.env` and `prisma/dev.db` are absent — both are gitignored local state that
// start.sh normally creates. Mirrors start.sh: write `.env` with the default
// DATABASE_URL (Prisma client auto-loads it), and apply tracked migrations when
// the db file is missing. Without this, every test file dies in setup.ts with
// "Environment variable not found: DATABASE_URL" / "no such table". Run via
// the `pretest` hook.

import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(PKG_DIR + '/');

if (!existsSync(path.join(PKG_DIR, '.env'))) {
  writeFileSync(path.join(PKG_DIR, '.env'), 'DATABASE_URL="file:./dev.db"\n');
  console.warn('[ensure-test-db] .env created with default DATABASE_URL');
}

if (!existsSync(path.join(PKG_DIR, 'prisma', 'dev.db'))) {
  const prismaBin = require.resolve('prisma/build/index.js');
  const r = spawnSync(process.execPath, [prismaBin, 'migrate', 'deploy'], { cwd: PKG_DIR, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`[ensure-test-db] prisma migrate deploy failed: exit ${r.status}`);
    process.exit(1);
  }
  console.warn('[ensure-test-db] prisma/dev.db created via migrations');
}

// 并发自愈：dev.db 切 WAL（幂等，worker 拉起前的单进程窗口执行，无竞争）。
// 默认 rollback-journal（delete）模式每次写锁全库，满并行用例 + 常驻 server
// 的读写互斥是偶发 SQLITE_BUSY → 路由 500 / 用例超时类 flake 的系统性根因；
// WAL 下读不阻塞写。对常驻生产 server 同样受益。切不上（被长事务占住等）
// 只警告不拦测试——退化为现状行为。

const dbFile = path.join(PKG_DIR, 'prisma', 'dev.db');
try {
  const mod = require('better-sqlite3');
  const Database = mod.default ?? mod;
  const db = new Database(dbFile, { timeout: 10_000 });
  const mode = db.pragma('journal_mode = WAL', { simple: true });
  db.close();
  if (mode === 'wal') console.warn('[ensure-test-db] dev.db journal_mode=WAL');
  else console.warn(`[ensure-test-db] journal_mode=${mode}（WAL 未生效，跳过）`);
} catch (e) {
  console.warn(`[ensure-test-db] WAL 切换失败（不影响继续）: ${e instanceof Error ? e.message : e}`);
}
