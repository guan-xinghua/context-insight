// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License).
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// wire-rounds delta IT：?delta=1 只回每轮新增段（append-only 历史增量，
// O(N²)→O(N)，数千轮会话曾爆 V8 字符串上限），前缀还原后与全量模式逐字节一致。
import { describe, it, expect, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prisma } from '../setup';
import { GET } from '@/app/api/observe/session/wire-rounds/route';

// 路由级 IT（seed + 读捕获文件 + 双请求对比）：本体 <1s，满载并行下测试库
// 锁竞争偶发超默认 5s，30s 为容错上限（与 GIT_PIPELINE_TIMEOUT_MS 同口径）
const ROUTE_IT_TIMEOUT_MS = 30_000;

const TASK = `wire-delta-${Date.now()}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-delta-'));
const SRC = path.join(TMP, 'session.jsonl');

const lines = [
  { type: 'system', timestamp: '2026-09-01T00:00:00Z', message: { role: 'system', content: [{ type: 'text', text: 'sys-a' }] } },
  { type: 'user', timestamp: '2026-09-01T00:00:01Z', message: { role: 'user', content: [{ type: 'text', text: 'q1' }] } },
  { type: 'assistant', timestamp: '2026-09-01T00:00:05Z', message: { role: 'assistant', content: [{ type: 'text', text: 'a1' }], model: 'gpt-6-astra', usage: { input_tokens: 100, output_tokens: 5 } } },
  { type: 'user', timestamp: '2026-09-01T00:01:00Z', message: { role: 'user', content: [{ type: 'text', text: 'q2' }] } },
  { type: 'assistant', timestamp: '2026-09-01T00:01:05Z', message: { role: 'assistant', content: [{ type: 'text', text: 'a2' }], model: 'gpt-6-astra', usage: { input_tokens: 200, output_tokens: 7 } } },
];
fs.writeFileSync(SRC, lines.map(l => JSON.stringify(l)).join('\n') + '\n');

await prisma.session.create({ data: { taskId: TASK, framework: 'claude-code', sourcePath: SRC } });

afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: TASK } });
  fs.rmSync(TMP, { recursive: true, force: true });
});

const req = (qs: string) => new NextRequest(`http://x/api/observe/session/wire-rounds?${qs}`);

// 与 WireRounds.expandDeltaRounds 同逻辑的前缀还原（客户端行为在此侧复刻验证）
type DeltaRound = { newFrom: number; requestMessages: unknown[] };
function expandDeltaRounds(rounds: DeltaRound[]): void {
  let acc: unknown[] = [];
  for (const r of rounds) {
    const snap = acc.slice(0, r.newFrom).concat(r.requestMessages);
    r.requestMessages = snap;
    acc = snap;
  }
}

describe('wire-rounds ?delta=1', () => {
  it('全量模式：快照随轮累积，newFrom 分界与 usage 口径正确', async () => {
    const res = await GET(req(`taskId=${TASK}`));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.delta).toBe(false);
    expect(j.totalRounds).toBe(2);
    expect(j.rounds[0].requestMessages.length).toBe(2);
    expect(j.rounds[1].newFrom).toBe(2);
    expect(j.rounds[1].requestMessages.length).toBe(4);
    expect(j.rounds[1].usage).toEqual({ input: 200, output: 7 });
  }, ROUTE_IT_TIMEOUT_MS);

  it('delta 模式：只回新增段，还原后与全量逐字节一致', async () => {
    const fullJ = await (await GET(req(`taskId=${TASK}`))).json();
    const dJ = await (await GET(req(`taskId=${TASK}&delta=1`))).json();
    expect(dJ.delta).toBe(true);
    expect(dJ.totalRounds).toBe(fullJ.totalRounds);
    expect(dJ.rounds[0].requestMessages.length).toBe(2);
    expect(dJ.rounds[1].requestMessages.length).toBe(2);

    expandDeltaRounds(dJ.rounds as DeltaRound[]);
    expect(dJ.rounds).toEqual(fullJ.rounds);
  }, ROUTE_IT_TIMEOUT_MS);
});
