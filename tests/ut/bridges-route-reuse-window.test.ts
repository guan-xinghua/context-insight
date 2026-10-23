// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// bridges 读侧 route 的复用会话窗口 IT：现场 ses_ecb797cb——ingest 已按窗口
// 写对 response，但 route 拿「全会话 turn」重算 timing 又把它盖回会话全局
// 末条（两桥 response 同为 17:40，泳道/turns 页窗口互相包含）。锁两件事：
// ① route 重算必须带同款窗口配对；② 库里还是旧值（未重导）也能读时自愈。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { prisma } from '../setup';
import { GET } from '@/app/api/observe/session/bridges/route';

const TASK = 'bridges-route-reuse-it';
const SID = 'ses-route-reuse-p1';
const T0 = new Date('2026-10-13T09:12:00.862Z');
const REWORK_AT = new Date('2026-10-13T09:33:51.044Z');
// 旧口径的脏值：两桥 response 都是会话全局末条（17:40:18）
const STALE_END = new Date('2026-10-13T09:40:18.267Z');

beforeAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: TASK } });
  const session = await prisma.session.create({
    data: { taskId: TASK, framework: 'opencode' },
  });
  for (const [i, d] of [T0, REWORK_AT].entries()) {
    await prisma.interactionBridge.create({
      data: {
        sessionId: session.id,
        dispatchExecutionId: `exec-${i}`,
        dispatchContent: i === 0 ? 'P1 需求分析' : 'P1 返工 r1',
        dispatchTimestamp: d,
        responseTimestamp: STALE_END, // 库里存旧值：读侧必须自愈
        subagentSessionId: SID,
        subagentType: 'acme-ops-architect',
        status: 'completed',
      },
    });
  }
  const mk = (idx: number, at: Date, ms: number) => prisma.turn.create({
    data: {
      sessionId: session.id, turnIndex: idx, role: 'assistant', isSubagent: true,
      subagentSessionId: SID, createdAt: at, createdAt_ts: at, latencyMs: ms,
    },
  });
  // 首发段 2 条（末条 09:23:34 + 25s ≈ 09:23:59.5）+ 返工段 2 条（末条 09:39:55 + 23s ≈ 09:40:18）
  await mk(4022, new Date('2026-10-13T09:12:31.000Z'), 2_000);
  await mk(4049, new Date('2026-10-13T09:23:34.078Z'), 25_487);
  await mk(4050, new Date('2026-10-13T09:34:09.000Z'), 18_793);
  await mk(4071, new Date('2026-10-13T09:39:55.078Z'), 23_189);
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: TASK } }).catch(() => {});
});

describe('bridges route：复用会话读侧窗口自愈', () => {
  it('首发桥 response=首发段末条完成时刻，早于返工 dispatch（不再盖回会话全局末条）', async () => {
    const res = await GET(new NextRequest(
      `http://localhost/api/observe/session/bridges?taskId=${TASK}&framework=opencode`));
    expect(res.status).toBe(200);
    const items = (await res.json()).items as Array<{ dispatchContent: string | null; dispatchTimestamp: string | null; responseTimestamp: string | null; subagentLatencyMs: number }>;
    const first = items.find(b => b.dispatchContent === 'P1 需求分析')!;
    const rework = items.find(b => b.dispatchContent === 'P1 返工 r1')!;
    expect(new Date(first.responseTimestamp!).getTime()).toBe(new Date('2026-10-13T09:23:59.565Z').getTime());
    expect(new Date(first.responseTimestamp!).getTime()).toBeLessThan(new Date(rework.dispatchTimestamp ?? first.responseTimestamp!).getTime() || REWORK_AT.getTime());
    expect(new Date(rework.responseTimestamp!).getTime()).toBe(new Date('2026-10-13T09:40:18.267Z').getTime());
  });

  it('窗口内 turn 的 completedAt 越过下次派发时，response 钳到下次派发时刻', async () => {
    const task = `${TASK}-clamp`;
    const sid = 'ses-route-reuse-clamp';
    const d1 = new Date('2026-10-13T10:00:00.000Z');
    const d2 = new Date('2026-10-13T10:20:00.000Z');
    const session = await prisma.session.create({ data: { taskId: task, framework: 'opencode' } });
    try {
      for (const [i, d] of [d1, d2].entries()) {
        await prisma.interactionBridge.create({
          data: {
            sessionId: session.id, dispatchExecutionId: `exec-c${i}`,
            dispatchContent: i === 0 ? '② 模板划分首发' : '② 模板划分返工',
            dispatchTimestamp: d, responseTimestamp: new Date('2026-10-13T11:05:00.000Z'),
            subagentSessionId: sid, status: 'completed',
          },
        });
      }
      // 首窗末条 createdAt 在窗内、completedAt 越过 d2（后台仍在跑、下次派发先到）
      await prisma.turn.create({ data: { sessionId: session.id, turnIndex: 0, role: 'assistant', isSubagent: true, subagentSessionId: sid, createdAt: new Date('2026-10-13T10:05:00.000Z'), createdAt_ts: new Date('2026-10-13T10:05:00.000Z'), latencyMs: 3_600_000 } });
      await prisma.turn.create({ data: { sessionId: session.id, turnIndex: 1, role: 'assistant', isSubagent: true, subagentSessionId: sid, createdAt: new Date('2026-10-13T10:25:00.000Z'), createdAt_ts: new Date('2026-10-13T10:25:00.000Z'), latencyMs: 60_000 } });

      const res = await GET(new NextRequest(
        `http://localhost/api/observe/session/bridges?taskId=${task}&framework=opencode`));
      const items = (await res.json()).items as Array<{ dispatchContent: string | null; responseTimestamp: string | null }>;
      const first = items.find(b => b.dispatchContent === '② 模板划分首发')!;
      const rework = items.find(b => b.dispatchContent === '② 模板划分返工')!;
      // 不钳：completedAt 11:05 会越过 d2，读侧 [d1, resp] 吞下 10:25 的下窗 turn
      expect(new Date(first.responseTimestamp!).getTime()).toBe(d2.getTime());
      // 末次派发无下界约束，不钳
      expect(new Date(rework.responseTimestamp!).getTime()).toBe(new Date('2026-10-13T10:26:00.000Z').getTime());
    } finally {
      await prisma.session.deleteMany({ where: { taskId: task } }).catch(() => {});
    }
  });
});
