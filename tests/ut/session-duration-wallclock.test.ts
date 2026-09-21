// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS PROGRAM IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Session Duration / LLM Active 口径 IT：
// ① 列表 Duration = 墙钟（客户端用 startTime/endTime 自算，API 不再派生 durationMs）
// ② 详情 / 单会话 stats 返回 llmActiveMs（assistant turn 在途窗口区间并集，并行去重叠）
// ③ llmActiveMs 并集去重：合成两重叠窗口 [{0,50s},{10s,60s}] → 并集 60s ≠ Σ 100s
// 夹具构造两轮 proxy 捕获（duration_ms=50s × 2，时间戳仅跨 3s）：
//   Σ latency=100s（双计）≫ 墙钟 3s；llmActiveMs 取窗口并集（proxy 行窗口=[createdAt−lat, createdAt]）。
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { NextRequest } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { importSession } from '../../src/lib/ingest/data-service.ts';
import { sessionDurationMs, computeLlmActiveMs } from '../../src/lib/session-duration.ts';

const prisma = new PrismaClient();
const dataRoute = await import('../../src/app/api/observe/data/route.ts');
const sessionRoute = await import('../../src/app/api/observe/session/route.ts');
const statsRoute = await import('../../src/app/api/observe/stats/route.ts');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'session-duration-it-'));
const SID = 'cc-duration-llmactive';

function fixture(): string {
  const file = path.join(TMP, `${SID}.jsonl`);
  const t = (s: number) => new Date(Date.parse('2026-09-01T10:00:00.000Z') + s * 1000).toISOString();
  const user = (ts: string, text: string) =>
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, timestamp: ts });
  const assistant = (ts: string, text: string) =>
    JSON.stringify({
      type: 'assistant',
      source: 'claude-code-proxy',
      duration_ms: 50000,
      message: { id: `msg_${ts}`, role: 'assistant', content: [{ type: 'text', text }], model: 'test-model', usage: { input_tokens: 5, output_tokens: 1 } },
      timestamp: ts,
    });
  fs.writeFileSync(file, [
    user(t(0), 'duration llm active it'),
    assistant(t(1), 'round 1 response'),
    user(t(2), 'next round'),
    assistant(t(3), 'round 2 response'),
  ].join('\n') + '\n');
  return file;
}

afterAll(async () => {
  try { await prisma.session.deleteMany({ where: { taskId: SID } }); } catch { /* ignore */ }
  await prisma.$disconnect();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('Session Duration 墙钟 + LLM Active 区间并集', () => {
  it('列表不派生 durationMs、start/end 可推墙钟；详情/单会话 stats 返回 llmActiveMs', async () => {
    await importSession(fixture(), SID, prisma, path.join(TMP, `${SID}.jsonl`), 'claude-jsonl');

    const row = await prisma.session.findFirst({ where: { taskId: SID } });
    expect(row).not.toBeNull();
    // 前置自检：夹具构造出「Σ latency(100s) ≫ 墙钟(3s)」的形态
    expect(row!.totalLatencyMs).toBe(100000);
    expect(row!.endTime!.getTime() - row!.startTime.getTime()).toBe(3000);

    // ① 列表 API：不派生 durationMs；start/end/Σ 三字段齐全供客户端自算墙钟；
    //    llmActiveMs 随列表批算（首页 Duration 列 = LLM 推理时间）
    const listRes = await dataRoute.GET(new NextRequest('http://localhost/api/observe/data?pageSize=100'));
    expect(listRes.status).toBe(200);
    const listData = await listRes.json();
    const item = (listData.items ?? []).find((i: { taskId: string }) => i.taskId === SID);
    expect(item).toBeDefined();
    expect(item.durationMs).toBeUndefined();
    expect(item.totalLatencyMs).toBe(100000);
    expect(sessionDurationMs(item.startTime, item.endTime, item.totalLatencyMs)).toBe(3000);
    expect(item.llmActiveMs).toBe(52000);

    // ② 详情 API：llmActiveMs = 两轮 proxy 窗口并集
    //    round1: createdAt=t(1), lat=50s → window [t(-49), t(1)]
    //    round2: createdAt=t(3), lat=50s → window [t(-47), t(3)]
    //    两窗口重叠（t(-47)..t(1)），并集 = t(-49)..t(3) = 52s ≠ Σ 100s
    const detailRes = await sessionRoute.GET(new NextRequest(`http://localhost/api/observe/session?taskId=${SID}`));
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json();
    expect(detail.llmActiveMs).toBe(52000);
    expect(detail.totalLatencyMs).toBe(100000);
    expect(detail.durationMs).toBeUndefined();

    // ③ 单会话 stats：同 llmActiveMs
    const statsRes = await statsRoute.GET(new NextRequest(`http://localhost/api/observe/stats?taskId=${SID}`));
    expect(statsRes.status).toBe(200);
    const stats = await statsRes.json();
    expect(stats.llmActiveMs).toBe(52000);
    expect(stats.totalLatencyMs).toBe(100000);
    expect(stats.durationMs).toBeUndefined();
    expect(sessionDurationMs(stats.startTime, stats.endTime, stats.totalLatencyMs)).toBe(3000);
  });

  it('llmActiveMs 并集去重：合成两重叠窗口 → 60s ≠ Σ 100s', () => {
    const turns = [
      { createdAt_ts: new Date(Date.parse('2026-09-01T10:00:50.000Z')), completedAt: null, latencyMs: 50000 }, // [0, 50s]
      { createdAt_ts: new Date(Date.parse('2026-09-01T10:01:00.000Z')), completedAt: null, latencyMs: 50000 }, // [10s, 60s]
    ];
    expect(computeLlmActiveMs(turns)).toBe(60000); // 并集 60s，非 Σ 100s
    expect(computeLlmActiveMs(turns)).not.toBe(100000);

    // 无 completedAt 且无 latency 的 turn 不产生窗口
    expect(computeLlmActiveMs([{ createdAt_ts: '2026-09-01T10:00:00.000Z', completedAt: null, latencyMs: 0 }])).toBe(0);

    // completedAt 有值（opencode / claude 多行）：窗口 = [created, completed]
    expect(computeLlmActiveMs([
      { createdAt_ts: '2026-09-01T10:00:00.000Z', completedAt: '2026-09-01T10:00:30.000Z', latencyMs: 0 },
    ])).toBe(30000);
  });
});
