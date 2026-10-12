// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details on how to use this file in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// opencode 2.x 增量刷新 IT：deltaRefreshSession 与 probeAutoRefresh 在
// session_v2 / session_message schema 上的增量导入与活跃度探测（v2 库此前
// 探针静默退化为 NO_CHANGE、增量报 no such table——本文件锁死两条链路）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { importSession, deltaRefreshSession } from '@/lib/ingest/data-service';
import { probeAutoRefresh } from '@/lib/ingest/auto-refresh-probe';

const prisma = new PrismaClient();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-v2-refresh-'));
const DB_FILE = path.join(TMP, 'opencode.db');

const DRIFT_ID = 'ses_v2drift001ffeV2SampleEee';
// 每个 probe 用例独立 id + 各自建行（对齐 ⑥ IDLE_ID 的自包含模式）——
// 用例间零共享：任一用例可单独跑、任意顺序跑，锁冲突不再级联放大
const PROBE_ID_STREAMING = 'ses_v2probe001ffeV2SampleF01';
const PROBE_ID_ABANDONED = 'ses_v2probe001ffeV2SampleF02';
const PROBE_ID_PENDING = 'ses_v2probe001ffeV2SampleF03';
const PROBE_ID_SETTLED = 'ses_v2probe001ffeV2SampleF04';
const PROBE_ID_SUBPARENT = 'ses_v2probe001ffeV2SampleF05';
const PROBE_SUB_ID = 'ses_v2probesub1ffeV2SampleG05';

const createdSessionIds: string[] = [];

interface V2Msg {
  id: string;
  sessionId: string;
  type: string;
  seq: number;
  data: Record<string, unknown>;
  at: number;
}

function v2UserMsg(sessionId: string, seq: number, text: string, at: number): V2Msg {
  return { id: `msg_${sessionId}_${seq}`, sessionId, type: 'user', seq, data: { time: { created: at }, text }, at };
}

function v2AssistantMsg(sessionId: string, seq: number, text: string, at: number, completed = true): V2Msg {
  const data: Record<string, unknown> = {
    time: { created: at, ...(completed ? { completed: at + 1000 } : {}) },
    agent: 'build',
    model: { id: 'model-a1', providerID: 'gateway' },
    finish: 'stop',
    tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 0, write: 0 } },
    content: [{ type: 'text', text }],
  };
  return { id: `msg_${sessionId}_${seq}`, sessionId, type: 'assistant', seq, data, at };
}

function writeDb(sessions: Array<{ id: string; parentId: string | null; title: string | null; created: number }>, msgs: V2Msg[]): void {
  // 逐 session 重写而非删库重建：库是全文件共享夹具，重建会抹掉其它用例的
  // 数据，制造声明顺序依赖（用例必须可单独跑、任意顺序跑）
  const db = new Database(DB_FILE);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS session_v2 (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, title TEXT,
      version TEXT NOT NULL, directory TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
      summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER)`);
    db.exec(`CREATE TABLE IF NOT EXISTS session_message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`);
    const ids = sessions.map(x => x.id);
    const delS = db.prepare('DELETE FROM session_v2 WHERE id = ?');
    const delM = db.prepare('DELETE FROM session_message WHERE session_id = ?');
    // DELETE+INSERT 同事务：INSERT 半途抛出不留"行已删、数据未写"的中间态；
    // close 走 finally 即时释放句柄（均 review 完备性建议）
    db.transaction(() => {
      for (const id of ids) { delS.run(id); delM.run(id); }
      for (const s of sessions) {
        db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(s.id, 'global', s.parentId, s.title, '2.0.18', '/tmp', s.created, s.created + 5000, 0, 0, 0);
      }
      for (const m of msgs) {
        db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(m.id, m.sessionId, m.type, m.seq, m.at, m.at + 1000, JSON.stringify(m.data));
      }
    })();
  } finally {
    db.close();
  }
}

async function createProbeSession(taskId: string): Promise<string> {
  const s = await prisma.session.create({ data: { taskId, framework: 'opencode', sourcePath: DB_FILE } });
  createdSessionIds.push(s.id);
  return s.id;
}

async function probe(taskId: string) {
  const s = await prisma.session.findFirst({ where: { taskId }, select: { id: true, taskId: true, sourcePath: true, framework: true, version: true } });
  if (!s) throw new Error('session missing');
  return probeAutoRefresh(s, prisma);
}

beforeAll(() => {
  writeDb(
    [{ id: DRIFT_ID, parentId: null, title: 'drift base', created: 1790001000000 }],
    [
      v2UserMsg(DRIFT_ID, 4, 'first question', 1790001000100),
      v2AssistantMsg(DRIFT_ID, 5, 'first answer', 1790001000200),
    ],
  );
});

afterAll(async () => {
  for (const id of createdSessionIds.splice(0)) {
    await prisma.session.delete({ where: { id } }).catch(() => {});
  }
  await prisma.$disconnect();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('opencode v2 增量刷新（deltaRefreshSession）', () => {
  it('尾部追加 user+assistant → 增量导入新轮', async () => {
    const imported = await importSession(DB_FILE, DRIFT_ID, prisma, DB_FILE, 'opencode-db');
    expect(imported.imported).toBe(true);
    const row = await prisma.session.findFirstOrThrow({ where: { taskId: DRIFT_ID } });
    createdSessionIds.push(row.id);
    const before = await prisma.turn.count({ where: { sessionId: row.id } });
    expect(before).toBeGreaterThanOrEqual(2);

    const db = new Database(DB_FILE);
    const at = 1790002000000;
    const appendMsg = (m: V2Msg) =>
      db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(m.id, m.sessionId, m.type, m.seq, m.at, m.at + 1000, JSON.stringify(m.data));
    appendMsg(v2UserMsg(DRIFT_ID, 6, 'second question', at));
    appendMsg(v2AssistantMsg(DRIFT_ID, 7, 'second answer', at + 100));
    db.close();

    const result = await deltaRefreshSession(DRIFT_ID, prisma);
    expect(result.addedTurns).toBeGreaterThan(0);
    const after = await prisma.turn.count({ where: { sessionId: row.id } });
    expect(after).toBeGreaterThan(before);
  });
});

describe('opencode v2 活跃度探针（probeAutoRefresh）', () => {
  it('① 最近更新的未完成 assistant → streaming', async () => {
    await createProbeSession(PROBE_ID_STREAMING);
    writeDb(
      [{ id: PROBE_ID_STREAMING, parentId: null, title: null, created: 1790001000000 }],
      [
        v2UserMsg(PROBE_ID_STREAMING, 4, 'q', Date.now() - 2000),
        v2AssistantMsg(PROBE_ID_STREAMING, 5, 'partial', Date.now() - 10_000, false),
      ],
    );
    const p = await probe(PROBE_ID_STREAMING);
    expect(p.streaming).toBe(true);
    expect(p.settled).toBe(false);
  });

  it('② 遗弃的未完成（10 分钟前）→ 不堵塞 settled', async () => {
    await createProbeSession(PROBE_ID_ABANDONED);
    writeDb(
      [{ id: PROBE_ID_ABANDONED, parentId: null, title: null, created: 1790001000000 }],
      [
        v2UserMsg(PROBE_ID_ABANDONED, 4, 'q', Date.now() - 12 * 60_000),
        v2AssistantMsg(PROBE_ID_ABANDONED, 5, 'abandoned', Date.now() - 10 * 60_000, false),
      ],
    );
    const p = await probe(PROBE_ID_ABANDONED);
    expect(p.streaming).toBe(false);
    expect(p.settled).toBe(true);
  });

  it('③ 尾部 user → pendingInput', async () => {
    await createProbeSession(PROBE_ID_PENDING);
    writeDb(
      [{ id: PROBE_ID_PENDING, parentId: null, title: null, created: 1790001000000 }],
      [
        v2UserMsg(PROBE_ID_PENDING, 4, 'q', 1790001000000),
        v2AssistantMsg(PROBE_ID_PENDING, 5, 'a', 1790001000100),
        v2UserMsg(PROBE_ID_PENDING, 6, 'follow-up', 1790001002000),
      ],
    );
    const p = await probe(PROBE_ID_PENDING);
    expect(p.pendingInput).toBe(true);
    expect(p.settled).toBe(false);
  });

  it('④ 尾部已完成 assistant → settled 且计数变化可感', async () => {
    await createProbeSession(PROBE_ID_SETTLED);
    writeDb(
      [{ id: PROBE_ID_SETTLED, parentId: null, title: null, created: 1790001000000 }],
      [
        v2UserMsg(PROBE_ID_SETTLED, 4, 'q', 1790001000000),
        v2AssistantMsg(PROBE_ID_SETTLED, 5, 'a', 1790001000100),
      ],
    );
    const p = await probe(PROBE_ID_SETTLED);
    expect(p.settled).toBe(true);
    expect(p.sourceMessageCount).toBe(2);
    expect(p.countChanged).toBe(true);
  });

  it('⑤ 子代理消息经 session_v2.parent_id 计入父会话计数', async () => {
    await createProbeSession(PROBE_ID_SUBPARENT);
    writeDb(
      [
        { id: PROBE_ID_SUBPARENT, parentId: null, title: null, created: 1790001000000 },
        { id: PROBE_SUB_ID, parentId: PROBE_ID_SUBPARENT, title: '@(build) subagent', created: 1790001000000 },
      ],
      [
        v2UserMsg(PROBE_ID_SUBPARENT, 4, 'q', 1790001000000),
        v2AssistantMsg(PROBE_ID_SUBPARENT, 5, 'a', 1790001000100),
        v2UserMsg(PROBE_SUB_ID, 4, 'sub q', 1790001000200),
        v2AssistantMsg(PROBE_SUB_ID, 5, 'sub a', 1790001000300),
      ],
    );
    const p = await probe(PROBE_ID_SUBPARENT);
    expect(p.sourceMessageCount).toBe(4);
  });

  it('⑥ 控制面消息（idle 等）不计入探针：导入收敛后 countChanged 归 false，追加 idle 不再触发变化信号', async () => {
    const IDLE_ID = 'ses_v2probeidle1ffeV2SampleHhh';
    const t0 = 1790003000000;
    const ctrl = (seq: number, type: string, at: number): V2Msg =>
      ({ id: `msg_${IDLE_ID}_${seq}`, sessionId: IDLE_ID, type, seq, data: { time: { created: at } }, at });
    writeDb(
      [{ id: IDLE_ID, parentId: null, title: null, created: t0 }],
      [
        v2UserMsg(IDLE_ID, 4, 'q', t0),
        v2AssistantMsg(IDLE_ID, 5, 'a', t0 + 100),
        ctrl(6, 'idle', t0 + 200),
        ctrl(7, 'shell', t0 + 300),
        ctrl(8, 'future-thing', t0 + 400),
      ],
    );
    const imported = await importSession(DB_FILE, IDLE_ID, prisma, DB_FILE, 'opencode-db');
    expect(imported.imported).toBe(true);
    const row = await prisma.session.findFirstOrThrow({ where: { taskId: IDLE_ID } });
    createdSessionIds.push(row.id);
    expect(await prisma.turn.count({ where: { sessionId: row.id } })).toBe(2);

    const p1 = await probe(IDLE_ID);
    expect(p1.sourceMessageCount).toBe(2);
    expect(p1.ourTurnCount).toBe(2);
    expect(p1.countChanged).toBe(false);
    expect(p1.settled).toBe(true);

    const db = new Database(DB_FILE);
    const at = t0 + 5000;
    db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(`msg_${IDLE_ID}_9`, IDLE_ID, 'idle', 9, at, at + 1000, JSON.stringify({ time: { created: at }, outcome: 'succeeded' }));
    db.close();
    const p2 = await probe(IDLE_ID);
    expect(p2.sourceMessageCount).toBe(2);
    expect(p2.countChanged).toBe(false);
    expect(p2.maxTimeUpdated).toBe(p1.maxTimeUpdated);

    const db2 = new Database(DB_FILE);
    const at2 = t0 + 6000;
    db2.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(`msg_${IDLE_ID}_10`, IDLE_ID, 'user', 10, at2, at2 + 1000, JSON.stringify({ time: { created: at2 }, text: 'next' }));
    db2.close();
    const p3 = await probe(IDLE_ID);
    expect(p3.sourceMessageCount).toBe(3);
    expect(p3.countChanged).toBe(true);
  });
});
