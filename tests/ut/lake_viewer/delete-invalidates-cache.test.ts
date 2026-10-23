// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 删除后 lake_viewer 导入态失效 IT（现场：先进入 lake viewer（清单缓存已热）→
// 主界面删除 session → 再进 lake viewer 仍显示「已导入」，点击直达 URL 404 且
// 无法重导）。根因：runs.ts 的 insightCache（30s TTL）/lakeCache（60s）只在
// import 与 notes 路由失效，/api/ingest/delete-session 删完不清——TTL 窗口
// 内已导入态保持陈旧。本 IT 先拉清单热缓存，再走删除路由，随后立刻重拉：
// 修复前 imported 仍 true（复现），删除路由失效缓存后应立即变 false。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { makeBareLake } from './helpers/makeLake';
import { seedLakeConfig } from '../../helpers/lake-env';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lake-viewer-delcache-'));
seedLakeConfig(TMP, { address: path.join(TMP, 'lake.git') });
process.env.LAKE_LFS = '0';
process.env.LAKE_VIEWER_CACHE_DIR = path.join(TMP, 'cache');
process.env.SCORING_DATA_DIR = path.join(TMP, 'scorecards');

const SID = 'del-aaaa1111';
const prisma = new PrismaClient();

const { listRuns } = await import('../../../src/app/lake_viewer/_lib/runs');
const { DELETE } = await import('../../../src/app/api/ingest/delete-session/route');

let seededId: string;

beforeAll(async () => {
  makeBareLake(path.join(TMP, 'lake.git'), [
    {
      time: '2026-10-01T10:00:00+08:00',
      message: '提交人: tester 内容描述: 删除失效夹具 备注: 无',
      sessions: [
        { sid: SID, paradigm: 'elementwise', framework: 'claude-code', ccVersion: '1.2.3' },
      ],
    },
  ]);
  await prisma.session.deleteMany({ where: { taskId: SID } });
  const row = await prisma.session.create({
    data: {
      taskId: SID,
      framework: 'claude-code',
      version: '1.2.3',
      startTime: new Date('2026-10-01T10:05:00+08:00'),
      endTime: new Date('2026-10-01T10:35:00+08:00'),
      totalTokens: 12_000,
    },
    select: { id: true },
  });
  seededId = row.id;
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: SID } }).catch(() => {});
  await prisma.$disconnect();
  fs.rmSync(TMP, { recursive: true, force: true });
});

async function importedFlag(): Promise<boolean | undefined> {
  const r = await listRuns({ paradigm: 'elementwise' });
  return r.items.find(x => x.sid === SID)?.imported;
}

describe('删除 session 后 lake_viewer 导入态立即失效', () => {
  it('删除前：已导入（清单可见，缓存变热）', async () => {
    expect(await importedFlag()).toBe(true);
  });

  it('走删除路由删掉 DB 行后，清单立即回到未导入（不等 30s TTL）', async () => {
    const res = await DELETE(new NextRequest('http://localhost/api/ingest/delete-session', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: SID, framework: 'claude-code' }),
    }));
    expect(res.status).toBe(200);
    // DB 行确已删除（防误判：未删而清单陈旧也会让 imported 假阴）
    await expect(prisma.session.findUnique({ where: { id: seededId } })).resolves.toBeNull();
    expect(await importedFlag()).toBe(false);
  });
});
