// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 隔离 canary（根治回归锁）：测试库与真实 prisma/dev.db 物理隔离。历史缺陷：
// 测试直连共享 dev.db（生产库），漏清理的夹具会话（scoring-v2-docslast/
// docstail/noverify「改代码」等）直接出现在用户 Insight 列表里、删除后下次
// 跑测试又回来。本锁钉死写入面：经共享 PrismaClient 写入的 sentinel 在真实
// dev.db 中必须查无此行——setup.ts 默认库被改回 dev.db 时本用例立刻红。
// （sentinel 同时须在当前连接的测试库中可查回，证明断言在真写、而非
// 「哪里都没写成功」的假绿。）

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { prisma } from '../setup';

const REAL_DB = path.resolve(__dirname, '../../prisma/dev.db');
const SENTINEL = 'isolation-canary-0001';

afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: SENTINEL } }).catch(() => {});
});

describe('测试库与真实 dev.db 物理隔离', () => {
  it('Prisma 写入只落测试库，真实 dev.db 查无 sentinel', async () => {
    await prisma.session.create({ data: { taskId: SENTINEL, framework: 'canary' } });

    const mine = await prisma.session.findFirst({ where: { taskId: SENTINEL } });
    expect(mine).not.toBeNull();

    if (fs.existsSync(REAL_DB)) {
      const db = new Database(REAL_DB, { readonly: true });
      try {
        const row = db.prepare('SELECT id FROM Session WHERE taskId = ?').get(SENTINEL);
        expect(row).toBeUndefined();
      } finally {
        db.close();
      }
    }
  });
});
