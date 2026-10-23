// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// IT：测试库隔离泄漏守卫矩阵——vitest .env 合入 process.env 击穿 test.db 默认
// 的堵漏回归锁。纯函数矩阵覆盖 .env* 优先级 / 引号 / 注释行 / 缺失 / 显式值
// 保留；端到端锁（真实 .env 在场时 canary 绿）见 test-db-isolation.test.ts。

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { envFileDatabaseUrl, isEnvFileLeakedUrl } from '../db-env-guard';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'db-env-guard-it-'));
const dirs: string[] = [];

function mkEnvDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'case-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('envFileDatabaseUrl：.env* 提供的 DATABASE_URL 解析', () => {
  it('无任何 .env* 文件 → null', () => {
    const dir = mkEnvDir({});
    expect(envFileDatabaseUrl(dir)).toBeNull();
  });

  it('.env 双引号值（ensure-test-db 引导格式）→ 去引号原值', () => {
    const dir = mkEnvDir({ '.env': 'DATABASE_URL="file:./dev.db"\n' });
    expect(envFileDatabaseUrl(dir)).toBe('file:./dev.db');
  });

  it('单引号 / 无引号 / 尾随空白 / 行内注释 → 均归一为裸值', () => {
    const single = mkEnvDir({ '.env': "DATABASE_URL='file:./a.db'\n" });
    expect(envFileDatabaseUrl(single)).toBe('file:./a.db');
    const bare = mkEnvDir({ '.env': 'DATABASE_URL =  file:./b.db  \n' });
    expect(envFileDatabaseUrl(bare)).toBe('file:./b.db');
    const commented = mkEnvDir({ '.env': 'DATABASE_URL=file:./c.db # server runtime\n' });
    expect(envFileDatabaseUrl(commented)).toBe('file:./c.db');
  });

  it('注释行与 CRLF 不干扰解析', () => {
    const dir = mkEnvDir({ '.env': '# DATABASE_URL="file:./old.db"\r\nOTHER=1\r\nDATABASE_URL="file:./dev.db"\r\n' });
    expect(envFileDatabaseUrl(dir)).toBe('file:./dev.db');
  });

  it('.env 存在但无 DATABASE_URL 行 → null', () => {
    const dir = mkEnvDir({ '.env': 'CONTEXT_LOG=0\n' });
    expect(envFileDatabaseUrl(dir)).toBeNull();
  });

  it('优先级：.env.local 覆盖 .env；.env.test 覆盖 .env.local；.env.test.local 最高', () => {
    const local = mkEnvDir({
      '.env': 'DATABASE_URL="file:./dev.db"\n',
      '.env.local': 'DATABASE_URL="file:./local.db"\n',
    });
    expect(envFileDatabaseUrl(local)).toBe('file:./local.db');

    const testMode = mkEnvDir({
      '.env': 'DATABASE_URL="file:./dev.db"\n',
      '.env.local': 'DATABASE_URL="file:./local.db"\n',
      '.env.test': 'DATABASE_URL="file:./test.db"\n',
    });
    expect(envFileDatabaseUrl(testMode)).toBe('file:./test.db');

    const top = mkEnvDir({
      '.env': 'DATABASE_URL="file:./dev.db"\n',
      '.env.local': 'DATABASE_URL="file:./local.db"\n',
      '.env.test': 'DATABASE_URL="file:./test.db"\n',
      '.env.test.local': 'DATABASE_URL="file:./top.db"\n',
    });
    expect(envFileDatabaseUrl(top)).toBe('file:./top.db');
  });
});

describe('isEnvFileLeakedUrl：泄漏判定', () => {
  it('进程值与 .env 提供值一致 → 泄漏（setup.ts 应剥除回落 test.db）', () => {
    const dir = mkEnvDir({ '.env': 'DATABASE_URL="file:./dev.db"\n' });
    expect(isEnvFileLeakedUrl('file:./dev.db', dir)).toBe(true);
  });

  it('进程值与 .env 不同（shell 显式指定）→ 非泄漏，保留显式值', () => {
    const dir = mkEnvDir({ '.env': 'DATABASE_URL="file:./dev.db"\n' });
    expect(isEnvFileLeakedUrl('file:/tmp/opencode/explicit.db', dir)).toBe(false);
  });

  it('进程值未设置 → 非泄漏（走 ||= 默认）', () => {
    const dir = mkEnvDir({ '.env': 'DATABASE_URL="file:./dev.db"\n' });
    expect(isEnvFileLeakedUrl(undefined, dir)).toBe(false);
  });

  it('.env 不在场 → 任何进程值都视为显式（不误伤 CI 指定库）', () => {
    const dir = mkEnvDir({});
    expect(isEnvFileLeakedUrl('file:./dev.db', dir)).toBe(false);
  });
});
