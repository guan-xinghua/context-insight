// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE,
// See LICENSE in the root of the software repository for the full text of the License.

// Turn 详情 API 读侧缓存 IT（点击 turn 的首次/重复延迟优化）：
//   ① 结果一致性：同 turn 两次 GET 响应深度相等（缓存命中不改变语义）
//   ② 文件级失效：捕获文件内容变化（mtime+size 键控）后 systemPrompt 反映新值
//   ③ 重建缓存：inputMessagesJson 未入库时按前序重建，两次调用结果一致且
//      inputMessagesCount 与重建列表长度对齐（头 = 列表）
//   ④ LRU 基元：容量逐出 + TTL 过期
//   ⑤ systemOverhead 缓存：跨 turn 复用不改变返回值

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { prisma } from './setup';
import { GET, __clearTurnDetailCaches } from '@/app/api/observe/session/turns/[turnId]/route';
import { __clearFullContextCaches } from '@/lib/ingest/adapters/claude-jsonl-full-context';
import { LruCache } from '@/lib/lru-cache';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-detail-cache-'));
const createdSessionIds: string[] = [];

function writeCapture(file: string, systemPrompt: string): void {
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: '开始任务' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'ok' }, x_cannbay: { schema: 'cc-wire-round', version: 1, data: { system: systemPrompt, tools: [{ name: 'Read', description: 'read file' }] } } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: '第二步' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'done' }, x_cannbay: { schema: 'cc-wire-round', version: 1, data: { system: systemPrompt, tools: [{ name: 'Read', description: 'read file' }], requestParams: { temperature: 0.3, maxTokens: 8192, model: 'test-model' } } } }),
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const t = new Date();
  fs.utimesSync(file, t, t);
}

async function seed(opts: { systemPrompt: string }): Promise<{ sessionId: string; turns: Array<{ id: string; role: string; turnIndex: number }> }> {
  const capture = path.join(tmpRoot, `cap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jsonl`);
  writeCapture(capture, opts.systemPrompt);
  const session = await prisma.session.create({ data: { taskId: path.basename(capture, '.jsonl'), framework: 'claude-code', sourcePath: capture } });
  createdSessionIds.push(session.id);
  const t0 = await prisma.turn.create({ data: { sessionId: session.id, turnIndex: 0, role: 'user', content: '开始任务' } });
  const t1 = await prisma.turn.create({ data: { sessionId: session.id, turnIndex: 1, role: 'assistant', content: 'ok', inputMessagesTokens: 120, outputTokens: 10 } });
  const t2 = await prisma.turn.create({ data: { sessionId: session.id, turnIndex: 2, role: 'user', content: '第二步' } });
  const t3 = await prisma.turn.create({ data: { sessionId: session.id, turnIndex: 3, role: 'assistant', content: 'done', inputMessagesTokens: 200, outputTokens: 20 } });
  return { sessionId: session.id, turns: [t0, t1, t2, t3] };
}

function makeGet(turnId: string) {
  return GET(new NextRequest(`http://localhost/api/observe/session/turns/${turnId}`), { params: Promise.resolve({ turnId }) });
}

afterEach(() => {
  __clearTurnDetailCaches();
  __clearFullContextCaches();
});

describe('Turn 详情读侧缓存', () => {
  it('① ② 同 turn 两次 GET 深度相等；捕获文件变更后 systemPrompt 反映新值（stat 失效）', async () => {
    const { turns } = await seed({ systemPrompt: 'SYSTEM-V1' });
    const r1 = await makeGet(turns[3].id);
    expect(r1.status).toBe(200);
    const d1 = await r1.json();
    expect(d1.systemPrompt).toBe('SYSTEM-V1');
    expect(d1.fullContext?.tools?.[0]?.name).toBe('Read');

    const r2 = await makeGet(turns[3].id);
    expect(await r2.json()).toEqual(d1);

    const capture = d1.sessionId; // sessionId 未直接给路径——从 d1 拿不到，改由 seed 返回路径断言前先重取
    void capture;
    // 文件变更（V1→V2，mtime+size 变化）→ 缓存失效，新值生效
    const srcRow = await prisma.session.findUnique({ where: { id: (await prisma.turn.findUnique({ where: { id: turns[3].id } }))!.sessionId } });
    writeCapture(srcRow!.sourcePath!, 'SYSTEM-V2-BIGGER-PROMPT');
    const r3 = await makeGet(turns[3].id);
    const d3 = await r3.json();
    expect(d3.systemPrompt).toBe('SYSTEM-V2-BIGGER-PROMPT');
  });

  it('③ 重建缓存：inputMessagesJson 未入库时按前序重建，两次一致且 count=列表长', async () => {
    const { turns } = await seed({ systemPrompt: 'SYS' });
    const r1 = await makeGet(turns[1].id);
    const d1 = await r1.json();
    expect(d1.inputMessagesJson).toBeTruthy();
    const list = JSON.parse(d1.inputMessagesJson);
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0);
    expect(d1.inputMessagesCount).toBe(list.length);
    const r2 = await makeGet(turns[1].id);
    expect(await r2.json()).toEqual(d1);
  });

  it('⑤ systemOverhead 缓存跨 turn 复用：同会话不同 turn 返回一致的开销值', async () => {
    const { turns } = await seed({ systemPrompt: 'SYS' });
    const d1 = await (await makeGet(turns[1].id)).json();
    const d3 = await (await makeGet(turns[3].id)).json();
    expect(d1.systemOverheadTokens).toBe(d3.systemOverheadTokens);
  });
});

describe('LruCache 基元', () => {
  it('④ 容量逐出 + TTL 过期', async () => {
    const c = new LruCache<string, number>(2);
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3); // 逐出 a
    expect(c.get('a')).toBeUndefined();
    expect(c.get('b')).toBe(2);
    expect(c.get('c')).toBe(3);
    const t = new LruCache<string, number>(4, 10);
    t.set('k', 42);
    expect(t.get('k')).toBe(42);
    await new Promise(r => setTimeout(r, 20));
    expect(t.get('k')).toBeUndefined();
  });
});
