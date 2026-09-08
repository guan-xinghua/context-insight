// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 会话列表默认排序 IT：按导入时间（Session.createdAt，行创建）而非会话产生
// 时间（startTime）。A 产生时间新但先导入，B 产生时间旧但后导入 → B 排前。
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { NextRequest } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { importSession } from '../src/lib/ingest/data-service.ts';

const prisma = new PrismaClient();
const route = await import('../src/app/api/observe/data/route.ts');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'session-order-it-'));
const SID_NEW_FIRST = 'cc-order-newer-start'; // 产生时间新（2026-06），先导入
const SID_OLD_LAST = 'cc-order-older-start'; // 产生时间旧（2026-01），后导入

function fixture(sid: string, ts: string): string {
  const file = path.join(TMP, `${sid}.jsonl`);
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: `order it ${sid}` }, timestamp: ts }),
    JSON.stringify({ type: 'assistant', message: { id: `msg_${sid}`, role: 'assistant', content: [{ type: 'text', text: 'ok' }], model: 'test-model', usage: { input_tokens: 5, output_tokens: 1 } }, timestamp: ts }),
  ].join('\n') + '\n');
  return file;
}

afterAll(async () => {
  for (const sid of [SID_NEW_FIRST, SID_OLD_LAST]) {
    try { await prisma.session.deleteMany({ where: { taskId: sid } }); } catch { /* ignore */ }
  }
  await prisma.$disconnect();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('会话列表默认按导入时间排序', () => {
  it('后导入的旧会话排在新会话之前（startTime 顺序相反）', async () => {
    await importSession(fixture(SID_NEW_FIRST, '2026-06-01T00:00:00.000Z'), SID_NEW_FIRST, prisma, path.join(TMP, `${SID_NEW_FIRST}.jsonl`), 'claude-jsonl');
    await importSession(fixture(SID_OLD_LAST, '2026-01-01T00:00:00.000Z'), SID_OLD_LAST, prisma, path.join(TMP, `${SID_OLD_LAST}.jsonl`), 'claude-jsonl');

    const rows = await prisma.session.findMany({ where: { taskId: { in: [SID_NEW_FIRST, SID_OLD_LAST] } }, select: { taskId: true, startTime: true, createdAt: true } });
    const newerStart = rows.find(r => r.taskId === SID_NEW_FIRST)!;
    const olderStart = rows.find(r => r.taskId === SID_OLD_LAST)!;
    // 前置自检：startTime 顺序与导入顺序相反（否则用例构造无效）
    expect(newerStart.startTime.getTime()).toBeGreaterThan(olderStart.startTime.getTime());
    expect(olderStart.createdAt.getTime()).toBeGreaterThanOrEqual(newerStart.createdAt.getTime());

    const res = await route.GET(new NextRequest('http://localhost/api/observe/data?pageSize=100'));
    expect(res.status).toBe(200);
    const data = await res.json();
    const items = (data.items ?? []) as Array<{ taskId: string; importedAt?: string }>;
    const idxNew = items.findIndex(i => i.taskId === SID_NEW_FIRST);
    const idxOld = items.findIndex(i => i.taskId === SID_OLD_LAST);
    expect(idxNew).toBeGreaterThanOrEqual(0);
    expect(idxOld).toBeGreaterThanOrEqual(0);
    // 导入时间序：后导入的（产生时间更旧的）排在前
    expect(idxOld).toBeLessThan(idxNew);
    // Import Time 列数据源：列表项携带导入时间（ISO，与 DB createdAt 一致）
    for (const idx of [idxNew, idxOld]) {
      expect(typeof items[idx].importedAt).toBe('string');
      expect(Number.isNaN(Date.parse(items[idx].importedAt!))).toBe(false);
    }
    expect(Date.parse(items[idxOld].importedAt!)).toBeGreaterThanOrEqual(Date.parse(items[idxNew].importedAt!));
  });
});
