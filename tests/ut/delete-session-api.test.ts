// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { prisma } from '../setup';
import { DELETE } from '@/app/api/ingest/delete-session/route';

const createdSessionIds: string[] = [];

// 本文件全部 seed 前缀：beforeAll/afterAll 按前缀自愈——vitest 中途被杀
// （Ctrl+C/超时强杀）时 afterEach 不执行，seed 会泄漏进共享 test.db 并出现在
// 下次跑测试的用例视野（batch-del-* 空会话事故）；前缀清理保证下次跑测试自动清掉残留
const SEED_PREFIXES = ['batch-del-', 'collide-', 'partial-', 'dual-del-', 'cascade-single-', 'cascade-batch-'];

async function healSeededLeaks() {
  await prisma.session.deleteMany({
    where: { OR: SEED_PREFIXES.map(p => ({ taskId: { startsWith: p } })) },
  }).catch(() => {});
}

beforeAll(healSeededLeaks);
afterAll(healSeededLeaks);

// DB 级 IT：多会话 seed + DELETE 路由级联，本体 <1s；满载并行下测试库
// SQLite 锁竞争偶发超默认 5s（全量单跑正常、偶发超时实测），15s 为容错上限
const DB_IT_TIMEOUT_MS = 15_000;

async function seedSession(taskId: string, framework: string = 'unknown') {
  const session = await prisma.session.create({ data: { taskId, framework } });
  createdSessionIds.push(session.id);
  return session;
}

// Seed a session WITH child rows (turn + toolCall + skillEvent) so cascade
// deletion can be verified. Without explicit cascade these would orphan.
async function seedSessionWithChildren(taskId: string, framework: string = 'opencode') {
  const session = await prisma.session.create({ data: { taskId, framework } });
  createdSessionIds.push(session.id);
  const turn = await prisma.turn.create({
    data: { sessionId: session.id, turnIndex: 0, role: 'user', content: 'hi' },
  });
  const toolCall = await prisma.toolCall.create({
    data: { turnId: turn.id, toolCallId: 'tc-1', toolName: 'Read', state: 'completed' },
  });
  const skillEvent = await prisma.skillEvent.create({
    data: { turnId: turn.id, skillName: 'demo', eventType: 'invoke', success: true },
  });
  return { session, turn, toolCall, skillEvent };
}

afterEach(async () => {
  for (const id of createdSessionIds.splice(0)) {
    await prisma.session.delete({ where: { id } }).catch(() => {});
  }
});

function makeDeleteRequest(body: unknown) {
  return new NextRequest('http://localhost/api/ingest/delete-session', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('delete-session API (batch)', () => {
  it('deletes multiple sessions by explicit (taskId, framework) list', async () => {
    const a = await seedSession(`batch-del-${Date.now()}-a`, 'opencode');
    const b = await seedSession(`batch-del-${Date.now()}-b`, 'claude-code');
    const c = await seedSession(`batch-del-${Date.now()}-c`, 'unknown');

    const res = await DELETE(makeDeleteRequest({
      sessions: [
        { taskId: a.taskId, framework: 'opencode' },
        { taskId: b.taskId, framework: 'claude-code' },
        { taskId: c.taskId, framework: 'unknown' },
      ],
    }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.deleted).toBe(3);
    expect(data.batch).toBe(3);

    const remaining = await prisma.session.findMany({
      where: { id: { in: [a.id, b.id, c.id] } },
    });
    expect(remaining).toHaveLength(0);
    for (const id of [a.id, b.id, c.id]) {
      createdSessionIds.splice(createdSessionIds.indexOf(id), 1);
    }
  }, DB_IT_TIMEOUT_MS);

  it('scopes deletion by framework when taskId collides across frameworks', async () => {
    const stamp = `${Date.now()}`;
    const keep = await seedSession(`collide-${stamp}`, 'claude-code');
    const drop = await seedSession(`collide-${stamp}`, 'opencode');

    const res = await DELETE(makeDeleteRequest({
      sessions: [{ taskId: `collide-${stamp}`, framework: 'opencode' }],
    }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.deleted).toBe(1);

    const survivor = await prisma.session.findUnique({ where: { id: keep.id } });
    expect(survivor).not.toBeNull();
    const gone = await prisma.session.findUnique({ where: { id: drop.id } });
    expect(gone).toBeNull();
    createdSessionIds.splice(createdSessionIds.indexOf(drop.id), 1);
  }, DB_IT_TIMEOUT_MS);

  it('skips list entries missing taskId but still deletes valid ones', async () => {
    const a = await seedSession(`partial-${Date.now()}`, 'opencode');

    const res = await DELETE(makeDeleteRequest({
      sessions: [
        { taskId: a.taskId, framework: 'opencode' },
        { framework: 'opencode' },
        { taskId: '', framework: 'unknown' },
      ],
    }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.deleted).toBe(1);
    expect(data.batch).toBe(3);

    const gone = await prisma.session.findUnique({ where: { id: a.id } });
    expect(gone).toBeNull();
    createdSessionIds.splice(createdSessionIds.indexOf(a.id), 1);
  }, DB_IT_TIMEOUT_MS);

  it('returns deleted:0 for an empty batch list without touching existing rows', async () => {
    const res = await DELETE(makeDeleteRequest({ sessions: [] }));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.deleted).toBe(0);
    expect(data.batch).toBe(0);
  }, DB_IT_TIMEOUT_MS);

  it('still rejects a missing taskId in the single-session path', async () => {
    const res = await DELETE(makeDeleteRequest({}));
    expect(res.status).toBe(400);
  }, DB_IT_TIMEOUT_MS);
});

describe('delete-session API (dual-row guard: 409 without framework)', () => {
  it('无 framework 且同 taskId 多行（双记录）→ 409 + rowCount，不执行删除；confirmAll 后放行全删', async () => {
    const sid = `dual-del-${Date.now()}`;
    await seedSession(sid, 'claude-code-proxy');
    await seedSession(sid, 'claude-code');

    // 无消歧 → 409（数据保全：多行不删）
    const guard = await DELETE(makeDeleteRequest({ taskId: sid }));
    expect(guard.status).toBe(409);
    const guardData = await guard.json();
    expect(guardData.multiRow).toBe(true);
    expect(guardData.rowCount).toBe(2);
    expect(await prisma.session.count({ where: { taskId: sid } })).toBe(2);

    // 带 framework 消歧 → 精确删单行，另一行保留
    const scoped = await DELETE(makeDeleteRequest({ taskId: sid, framework: 'claude-code' }));
    expect(scoped.status).toBe(200);
    expect((await scoped.json()).deleted).toBe(1);
    expect(await prisma.session.count({ where: { taskId: sid } })).toBe(1);

    // 单行残留 + 无 framework → 不触发 409，直接删
    const single = await DELETE(makeDeleteRequest({ taskId: sid }));
    expect(single.status).toBe(200);
    expect(await prisma.session.count({ where: { taskId: sid } })).toBe(0);
  }, DB_IT_TIMEOUT_MS);

  it('无 framework 多行 + confirmAll: true → 跳过守卫全删', async () => {
    const sid = `dual-del-confirm-${Date.now()}`;
    await seedSession(sid, 'claude-code-proxy');
    await seedSession(sid, 'claude-code');

    const res = await DELETE(makeDeleteRequest({ taskId: sid, confirmAll: true }));
    expect(res.status).toBe(200);
    expect((await res.json()).deleted).toBe(2);
    expect(await prisma.session.count({ where: { taskId: sid } })).toBe(0);
  }, DB_IT_TIMEOUT_MS);
});

describe('delete-session API (cascade: no orphan child rows)', () => {
  it('single delete cascades to turns/toolCalls/skillEvents', async () => {
    const { session, turn, toolCall, skillEvent } = await seedSessionWithChildren(`cascade-single-${Date.now()}`);

    const res = await DELETE(makeDeleteRequest({ taskId: session.taskId }));
    expect(res.status).toBe(200);

    expect(await prisma.session.findUnique({ where: { id: session.id } })).toBeNull();
    expect(await prisma.turn.findUnique({ where: { id: turn.id } })).toBeNull();
    expect(await prisma.toolCall.findUnique({ where: { id: toolCall.id } })).toBeNull();
    expect(await prisma.skillEvent.findUnique({ where: { id: skillEvent.id } })).toBeNull();
    createdSessionIds.splice(createdSessionIds.indexOf(session.id), 1);
  }, DB_IT_TIMEOUT_MS);

  it('batch delete cascades to child rows', async () => {
    const { session, turn, toolCall, skillEvent } = await seedSessionWithChildren(`cascade-batch-${Date.now()}`);

    const res = await DELETE(makeDeleteRequest({
      sessions: [{ taskId: session.taskId, framework: 'opencode' }],
    }));
    expect(res.status).toBe(200);

    expect(await prisma.turn.findUnique({ where: { id: turn.id } })).toBeNull();
    expect(await prisma.toolCall.findUnique({ where: { id: toolCall.id } })).toBeNull();
    expect(await prisma.skillEvent.findUnique({ where: { id: skillEvent.id } })).toBeNull();
    createdSessionIds.splice(createdSessionIds.indexOf(session.id), 1);
  }, DB_IT_TIMEOUT_MS);
});
