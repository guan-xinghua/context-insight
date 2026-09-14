// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE,
// See LICENSE in the root of the software repository for the full text of the License.

// opencode 自动同步探针新鲜度窗口 IT（客户现场回归锁：遗弃的未完成消息
// 堵死 settled，54 分钟积压不导入）：
//   ① 未完成 assistant 最近更新 → streaming=true（真在写，不同步是对的）
//   ② 未完成 assistant 更新于 10 分钟前（Esc 打断/崩溃残留）→ 不算流式，
//      settled 恢复 true，轮次间歇可以同步
//   ③ 未完成 assistant 的 time_updated 超前系统时钟（VM 时钟回拨残留）
//      → 负年龄同样不算活跃，settled 恢复
//   ④ 混合场景：遗弃 + 活跃并存 → 活跃者说了算（streaming=true）

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { probeAutoRefresh } from '@/lib/ingest/auto-refresh-probe';

const prisma = new PrismaClient();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-probe-it-'));
const TASK_ID = 'ses-opencode-probe-it';
const DB_FILE = path.join(TMP, 'opencode.db');

const createdSessionIds: string[] = [];

function msgRow(sessionId: string, role: string, completed: boolean, timeUpdated: number, seq: number) {
  const time = { created: timeUpdated - 1000, ...(completed ? { completed: timeUpdated } : {}) };
  return {
    id: `msg_${seq}`,
    session_id: sessionId,
    data: JSON.stringify({ role, time, content: [{ type: 'text', text: `m${seq}` }] }),
    time_created: timeUpdated - 1000,
    time_updated: timeUpdated,
  };
}

function buildDb(incompleteRows: Array<{ updatedMs: number; completed: boolean }>, userAtMs = Date.now() - 2000): void {
  fs.rmSync(DB_FILE, { force: true });
  const db = new Database(DB_FILE);
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT)');
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER, time_updated INTEGER)');
  db.prepare('INSERT INTO session VALUES (?, NULL)').run(TASK_ID);
  let seq = 0;
  const now = Date.now();
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(
    `msg_${seq}`, TASK_ID, JSON.stringify({ role: 'user', time: { created: userAtMs }, content: 'q' }), userAtMs, userAtMs);
  seq++;
  for (const r of incompleteRows) {
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(...Object.values(msgRow(TASK_ID, 'assistant', r.completed, r.updatedMs, seq++)) as [string, string, string, number, number]);
  }
  db.close();
}

beforeAll(async () => {
  const s = await prisma.session.create({ data: { taskId: TASK_ID, framework: 'opencode', sourcePath: DB_FILE } });
  createdSessionIds.push(s.id);
});

afterAll(async () => {
  for (const id of createdSessionIds.splice(0)) {
    await prisma.session.delete({ where: { id } }).catch(() => {});
  }
  await prisma.$disconnect();
  fs.rmSync(TMP, { recursive: true, force: true });
});

async function probe() {
  const s = await prisma.session.findFirst({ where: { taskId: TASK_ID }, select: { id: true, taskId: true, sourcePath: true, framework: true, version: true } });
  if (!s) throw new Error('session missing');
  return probeAutoRefresh(s, prisma);
}

describe('opencode 探针新鲜度窗口', () => {
  it('① 最近更新（10 秒前）的未完成 assistant → streaming=true', async () => {
    buildDb([{ updatedMs: Date.now() - 10_000, completed: false }]);
    const p = await probe();
    expect(p.streaming).toBe(true);
    expect(p.settled).toBe(false);
  });

  it('② 遗弃的未完成（10 分钟前更新，completed 永缺）→ 不再堵塞 settled', async () => {
    buildDb([{ updatedMs: Date.now() - 10 * 60_000, completed: false }], Date.now() - 12 * 60_000);
    const p = await probe();
    expect(p.streaming).toBe(false);
    expect(p.settled).toBe(true); // latest 是 assistant（user 早于遗弃消息）→ pendingInput false
  });

  it('③ 时钟回拨残留（time_updated 超前系统时钟 30 分钟）→ 负年龄不算活跃', async () => {
    buildDb([{ updatedMs: Date.now() + 30 * 60_000, completed: false }], Date.now() - 40 * 60_000);
    const p = await probe();
    expect(p.streaming).toBe(false);
    expect(p.settled).toBe(true);
  });

  it('④ 遗弃 + 活跃并存 → 活跃者说了算', async () => {
    buildDb([
      { updatedMs: Date.now() + 30 * 60_000, completed: false },
      { updatedMs: Date.now() - 5_000, completed: false },
    ]);
    const p = await probe();
    expect(p.streaming).toBe(true);
    expect(p.settled).toBe(false);
  });
});
