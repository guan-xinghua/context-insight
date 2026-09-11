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
