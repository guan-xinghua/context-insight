// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Overview 泳道 API 的 per-turn 活跃区间口径 IT（完整数据流：wire jsonl → adapter
// → turn-split → Prisma → GET /api/observe/session）：
// proxy（cpx 捕获）单行 assistant 的 completedAt 系统性缺失（createdAt_ts 就是
// 响应完成时刻），API 必须用 latencyMs（= wire duration_ms）还原在途窗口
// [t - latency, t]——与 session-duration.ts 的 turnWindow / active-time.ts 的
// expandLatency 同口径。不还原的话每条区间都塌成零宽 [t, t]，前端
// filter(seg => seg.end > seg.start) 把它们全丢掉，活跃/休眠可视化整体失效。
// native 行必须保持原口径不展开：它的 latencyMs 可能是「到下一轮的间隔」
// （含小时级空闲段），展开会把空闲画成活跃。
import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prisma } from '../setup';
import { POST } from '@/app/api/ingest/import-file/route';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swimlane-iv-'));
const createdSessionIds: string[] = [];

interface Interval { start: number; end: number }
interface ApiAgent {
  executionId: string;
  isSubagent: boolean;
  span: Interval | null;
  activeIntervals: Interval[];
}

// 行载荷：proxy 版 = cpx 捕获的真实形状（wire 单行 assistant：顶层 duration_ms +
// 行级 source + x_cannbay cc-wire-round 声明 + 同名 .meta.json）；native 版用同一组
// 时间戳与 duration_ms，但去掉全部 proxy 标记（= 原生 claude jsonl 形状）。
// 两版只有 proxy 判定信号不同，用于把「展开与否」锁在 isProxyVersion 上，
// 而不是锁在 latencyMs 有无上。
function writeCapture(name: string, sid: string, proxy: boolean): string {
  const file = path.join(tmpDir, name);
  const at = (h: number, m: number, s: number) => `2026-08-25T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.000Z`;
  const user = (text: string, ts: string, round: number) => ({
    type: 'user', message: { role: 'user', content: text }, timestamp: ts,
    ...(proxy ? { source: 'cannbot-proxy' } : {}),
    ...(proxy ? { x_cannbay: { schema: 'cc-wire-input', version: 1, data: { roundIndex: round, kind: 'user' } } } : {}),
  });
  const assistant = (text: string, ts: string, round: number, durationMs: number) => ({
    type: 'assistant',
    message: { role: 'assistant', id: `msg_${sid}_${round}`, content: [{ type: 'text', text }], model: 'glm-5.2', usage: { input_tokens: 100 + round * 20, output_tokens: 20 + round * 10 } },
    timestamp: ts, duration_ms: durationMs, stopReason: 'stop', ttftMs: 200 - round * 50,
    ...(proxy ? { source: 'cannbot-proxy', version: '1.1.2' } : {}),
    ...(proxy ? {
      x_cannbay: {
        schema: 'cc-wire-round', version: 1,
        data: { roundIndex: round, protocol: 'openai', latencyMs: durationMs, ttftMs: 200 - round * 50, stopReason: 'stop', status: 200 },
      },
    } : {}),
  });
  fs.writeFileSync(file, [
    user('第一轮提问', at(10, 0, 0), 0),
    assistant('第一轮回答', at(10, 0, 5), 0, 1200),
    user('第二轮提问', at(10, 3, 0), 1),
    assistant('第二轮回答', at(10, 3, 5), 1, 800),
  ].map(l => JSON.stringify(l)).join('\n') + '\n');
  if (proxy) {
    fs.writeFileSync(file.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({
      x_cannbay: { schema: 'cc-session-meta', version: 1, data: { producer: 'cpx', framework: 'cannbot', protocol: 'openai', ccVersion: '1.1.2', sid } },
    }));
  }
  return file;
}

function importReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/ingest/import-file', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function importCapture(sid: string, proxy: boolean): Promise<{ root: ApiAgent; sessionId: string }> {
  const file = writeCapture(`${sid}.jsonl`, sid, proxy);
  await prisma.session.deleteMany({ where: { taskId: sid } });
  const res = await POST(importReq({ source: 'claude-jsonl', sessionId: sid, filePath: file }));
  expect(res.status).toBe(200);
  const session = await prisma.session.findFirst({ where: { taskId: sid }, select: { id: true, version: true } });
  expect(session).not.toBeNull();
  createdSessionIds.push(session!.id);
  expect(session!.version?.endsWith('-proxy') ?? false).toBe(proxy);

  const root = await fetchRoot(sid);
  return { root, sessionId: session!.id };
}

async function fetchRoot(sid: string): Promise<ApiAgent> {
  const { GET } = await import('@/app/api/observe/session/route');
  const apiRes = await GET(new NextRequest(`http://localhost/api/observe/session?taskId=${sid}`));
  expect(apiRes.status).toBe(200);
  const data = (await apiRes.json()) as { agents: ApiAgent[] };
  const root = data.agents.find(a => !a.isSubagent);
  expect(root).toBeTruthy();
  return root!;
}

const at = (h: number, m: number, s: number, ms = 0) =>
  Date.parse(`2026-08-25T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}Z`);

afterEach(async () => {
  for (const id of createdSessionIds.splice(0)) {
    try { await prisma.session.delete({ where: { id } }); } catch { /* ignore */ }
  }
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('GET /api/observe/session — 泳道 per-turn 活跃区间', () => {
  it('proxy 会话：assistant 行按 latencyMs 展开成 [t-latency, t]，零宽区间消失', async () => {
    const { root } = await importCapture('swimlane-iv-proxy', true);

    // a1：10:00:05 完成、duration_ms 1200 → 在途窗口 [10:00:03.800, 10:00:05]
    expect(root.activeIntervals).toContainEqual({ start: at(10, 0, 3, 800), end: at(10, 0, 5) });
    // a2：10:03:05 完成、duration_ms 800 → [10:03:04.200, 10:03:05]
    expect(root.activeIntervals).toContainEqual({ start: at(10, 3, 4, 200), end: at(10, 3, 5) });
    // 修复前这两条都是零宽 [t, t]（被前端 filter 丢掉 → 该 turn 画成休眠）
    expect(root.activeIntervals).not.toContainEqual({ start: at(10, 0, 5), end: at(10, 0, 5) });
    expect(root.activeIntervals.some(iv => iv.end === iv.start)).toBe(false);

    // span（整根条子的浅色底）仍以 turn 位置为准，不因展开而左移
    expect(root.span).toEqual({ start: at(10, 0, 0), end: at(10, 3, 5) });
  });

  it('native 会话：同一份行载荷不展开（区间口径不变，assistant 行仍是 [t, t]）', async () => {
    const { root } = await importCapture('swimlane-iv-native', false);

    // native 单行 assistant 的 completedAt == createdAt_ts（适配器口径），
    // latencyMs 照样是 1200 但不在展开范围内
    expect(root.activeIntervals).toContainEqual({ start: at(10, 0, 5), end: at(10, 0, 5) });
    expect(root.activeIntervals).not.toContainEqual({ start: at(10, 0, 3, 800), end: at(10, 0, 5) });
  });

  it('isSubagent=true 但 subagentSessionId 为 null 的异常行不并进主 agent 的 span/活跃段', async () => {
    const { root, sessionId } = await importCapture('swimlane-iv-null-sid', true);
    expect(root.span).toEqual({ start: at(10, 0, 0), end: at(10, 3, 5) });

    // schema 允许该组合（其余按 subagentSessionId 分组的查询都过滤 not null）；
    // 身份键若用 `?? ''` 就会与 root 撞车，把这行并进主 agent
    await prisma.turn.create({
      data: {
        sessionId,
        turnIndex: 999,
        role: 'assistant',
        isSubagent: true,
        subagentSessionId: null,
        createdAt_ts: new Date(at(10, 30, 0)),
        completedAt: new Date(at(10, 40, 0)),
        latencyMs: 600_000,
      },
    });

    const after = await fetchRoot('swimlane-iv-null-sid');
    expect(after.span).toEqual(root.span);
    expect(after.activeIntervals).toEqual(root.activeIntervals);
  });
});
