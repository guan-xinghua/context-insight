// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 测试库隔离泄漏守卫（纯函数）：vitest 3 经 Vite loadEnv 把包根 .env* 合入
// process.env（不覆盖已有值，shell 显式导出优先）。pretest 的 ensure-test-db
// 会在 fresh clone 创建 .env（DATABASE_URL="file:./dev.db"，server 运行时
// 引导），该值泄漏进测试进程后击穿 setup.ts 的 `||= "file:./test.db"` 默认——
// 隔离 canary（tests/ut/test-db-isolation.test.ts）红、全套件写生产库 dev.db。
// 判定：process.env 值与 .env* 提供的一致 = 泄漏（shell 显式值不与 .env 相撞；
// 刻意复刻同值时回落 test.db 也是安全向）。删除动作由 setup.ts 执行。

import fs from 'node:fs';
import path from 'node:path';

const ENV_FILES = ['.env.test.local', '.env.test', '.env.local', '.env'];

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function readDatabaseUrlFrom(file: string): string | null {
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('#')) continue;
    const m = /^DATABASE_URL\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    return stripQuotes(m[1].replace(/\s+#.*$/, '').trim());
  }
  return null;
}

export function envFileDatabaseUrl(envDir: string): string | null {
  for (const name of ENV_FILES) {
    const value = readDatabaseUrlFrom(path.join(envDir, name));
    if (value !== null) return value;
  }
  return null;
}

export function isEnvFileLeakedUrl(current: string | undefined, envDir: string): boolean {
  if (!current) return false;
  const fromFile = envFileDatabaseUrl(envDir);
  return fromFile !== null && fromFile === current;
}
