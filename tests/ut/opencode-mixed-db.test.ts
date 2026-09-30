// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details on how to use this file in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO WARRANTIES OF NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// opencode 混合代际库 IT（两代表共存的会话粒度路由回归锁）。现场形态：2.x
// 首跑把全部 1.x 会话回填进 session_v2/session_message（保时间戳），之后
// 1.x 继续只写 v1 表——v2 副本自回填时刻停更。按库级 "v2 优先" 读取会把
// 回填后的新消息全部丢掉（实测 2.26GB 活库：活跃会话 8 条 v1-only 消息），
// 探针同理漏计 → 增量刷新静默停摆。本文件锁死：列表合并、readSession/
// readSessionMeta 的会话粒度路由、子代理并集、导入全链、以及「v1-only
// 追加必须被探针感知」的停摆锁。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { PrismaClient } from '@prisma/client';
import {
  listSessions,
  listSubagentSessions,
  readSession,
  readSessionMeta,
  readSessionWithDb,
} from '@/lib/ingest/adapters/opencode-db';
import { importSession, deltaRefreshSession } from '@/lib/ingest/data-service';
import { probeAutoRefresh } from '@/lib/ingest/auto-refresh-probe';
import { detectSqliteSource } from '@/lib/ingest/sqlite-detect';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-mixed-it-'));
const DB_FILE = path.join(TMP, 'opencode.db');

const MAIN_ID = 'ses_mixmain001ffeMixedAaa';   // 双表；v1 回填后继续写（v1 读方）
const TIE_ID = 'ses_mixtie001ffeMixedBbb';     // 双表；平局 + v1 独有旧行（v1 读方）
const V2ONLY_ID = 'ses_mixv2only1ffeMixedCcc'; // 仅 session_v2（v2 读方）
const SUB_ID = 'ses_mixsub001ffeMixedDdd';     // 子代理；双表；v1 继续写（v1 读方）
const V1ONLY_ID = 'ses_mixv1only1ffeMixedEee'; // 仅 session（v1 读方）

const T = 1791000000000;

const prisma = new PrismaClient();
const createdSessionIds: string[] = [];

let mixedSessions: ReturnType<typeof listSessions>;
let mainRows: ReturnType<typeof readSession>;

beforeAll(() => {
  const sql = fs.readFileSync(path.resolve(__dirname, 'data/e2e/opencode-mixed-sample.sql'), 'utf-8');
  const db = new Database(DB_FILE);
  db.exec(sql);
  db.close();

  mixedSessions = listSessions(DB_FILE);
  mainRows = readSession(DB_FILE, MAIN_ID);
});

afterAll(async () => {
  for (const id of createdSessionIds.splice(0)) {
    await prisma.session.delete({ where: { id } }).catch(() => {});
  }
  await prisma.$disconnect();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('opencode 混合代际库：schema 嗅探与列表合并', () => {
  it('detectSqliteSource：双表共存 → opencode-db', () => {
    expect(detectSqliteSource(DB_FILE)).toBe('opencode-db');
  });

  it('列表 = 两代顶层会话并集，按会话粒度选代表', () => {
    expect(mixedSessions.map(s => s.id)).toEqual([V1ONLY_ID, MAIN_ID, TIE_ID, V2ONLY_ID]);
  });

  it('回填后继续写的会话：v1 代表（endedAt/轮数/首问都来自 v1 表）', () => {
    const main = mixedSessions.find(s => s.id === MAIN_ID)!;
    expect(main.endedAt).toBe(new Date(T + 9000).toISOString());
    expect(main.turnCount).toBe(5);          // v1 表 5 条（v2 副本只有 3 条）
    expect(main.firstQuery).toBe('Shared prompt: fix the mixed-schema build');
  });

  it('平局（回填保时间戳）：归 v1——v1 独有的旧行体现在首问与轮数', () => {
    const tie = mixedSessions.find(s => s.id === TIE_ID)!;
    expect(tie.firstQuery).toBe('v1-only intro that the backfill skipped'); // v2 副本首问是另一句
    expect(tie.turnCount).toBe(3);           // v1 表 3 条（v2 副本 2 条）
  });

  it('仅存一代的会话：各自代表（v2-only 由 v2 列出、v1-only 由 v1 列出）', () => {
    const v2only = mixedSessions.find(s => s.id === V2ONLY_ID)!;
    expect(v2only.turnCount).toBe(2);        // user + assistant（idle 控制面行不计入）
    expect(v2only.version).toBe('2.0.18');
    const v1only = mixedSessions.find(s => s.id === V1ONLY_ID)!;
    expect(v1only.turnCount).toBe(2);
    expect(v1only.version).toBe('1.18.31');
  });
});

describe('opencode 混合代际库：readSession 会话粒度路由', () => {
  it('主会话走 v1：回填后新消息在场，v2 副本内容不出场', () => {
    const texts = mainRows.map(r => r.content ?? '').join('\n');
    expect(texts).toContain('Post-backfill v1 answer at T+9000');
    expect(texts).toContain('v1 backfilled reply at T+3000');
    expect(texts).not.toContain('v2 backfilled reply');   // v2 副本标记串一律缺席
    expect(mainRows).toHaveLength(5);
  });

  it('平局会话走 v1：v1 独有旧行可见', () => {
    const rows = readSession(DB_FILE, TIE_ID);
    const texts = rows.map(r => r.content ?? '').join('\n');
    expect(texts).toContain('v1-only intro that the backfill skipped');
    expect(texts).not.toContain('v2 tie reply');
  });

  it('仅 v2 的会话走 v2：内容与 idle 跳过正确', () => {
    const rows = readSession(DB_FILE, V2ONLY_ID);
    expect(rows.map(r => r.role)).toEqual(['user', 'assistant']);
    expect(rows[1]!.content).toContain('v2-only session reply');
  });

  it('子代理走 v1 + 标题正则（@(explore) subagent → subagent_name）', () => {
    const rows = readSession(DB_FILE, SUB_ID);
    const texts = rows.map(r => r.content ?? '').join('\n');
    expect(texts).toContain('v1 subagent post-backfill reply');
    expect(texts).not.toContain('v2 subagent backfilled reply');
    for (const r of rows) {
      expect(r.subagent_name).toBe('explore');
      expect(r.subagent_session_id).toBe(SUB_ID);
    }
  });

  it('readSessionMeta 路由一致：v1 会话取 v1 行、v2-only 会话取 v2 行', () => {
    const db = new Database(DB_FILE, { readonly: true });
    try {
      expect(readSessionMeta(db, MAIN_ID).title).toBe('Mixed db main session');
      expect(readSessionMeta(db, MAIN_ID).parentId).toBeNull();
      expect(readSessionMeta(db, V2ONLY_ID).title).toBe('Pure 2.x session');
      // 共享连接路径（增量刷新用的入口）与会话级路由一致
      expect(readSessionWithDb(db, TIE_ID).map(r => r.content)).toEqual(readSession(DB_FILE, TIE_ID).map(r => r.content));
    } finally {
      db.close();
    }
  });

  it('listSubagentSessions：两代子代理取并集去重', () => {
    expect(listSubagentSessions(DB_FILE, MAIN_ID)).toEqual([SUB_ID]);
  });
});

describe('opencode 混合代际库：导入全链 + 增量刷新停摆锁（P1 回归）', () => {
  it('导入主会话：回填后新消息进 turn，子代理名来自 v1 标题', async () => {
    const result = await importSession(DB_FILE, MAIN_ID, prisma, DB_FILE, 'opencode-db');
    expect(result.imported).toBe(true);

    const row = await prisma.session.findFirstOrThrow({ where: { taskId: MAIN_ID } });
    createdSessionIds.push(row.id);

    const subTurns = await prisma.turn.findMany({ where: { sessionId: row.id, subagentName: 'explore' } });
    expect(subTurns.length).toBeGreaterThan(0);
  });

  it('停摆锁：v1-only 追加（回填后 1.x 继续写）必须被探针感知并增量导入', async () => {
    const s = await prisma.session.findFirstOrThrow({
      where: { taskId: MAIN_ID },
      select: { id: true, taskId: true, sourcePath: true, framework: true, version: true },
    });
    const p1 = await probeAutoRefresh(s, prisma);
    // 路由修复前：探针整库读停更的 v2 副本（主 3 + 子 2 = 5），v1 表不可见
    expect(p1.sourceMessageCount).toBe(8);   // v1：主 5 + 子 3

    const db = new Database(DB_FILE);
    const at = T + 9700;
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run('m_v1a6', MAIN_ID, at, at + 100, JSON.stringify({ role: 'user', time: { created: at }, agent: 'build', summary: { diffs: [] } }));
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run('p_v1a6', 'm_v1a6', MAIN_ID, at, at, JSON.stringify({ type: 'text', text: 'Post-backfill second question' }));
    const at2 = T + 9800;
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run('m_v1a7', MAIN_ID, at2, at2 + 100, JSON.stringify({ parentID: 'm_v1a6', role: 'assistant', mode: 'build', agent: 'build', cost: 0.01, tokens: { total: 900, input: 800, output: 80, reasoning: 20, cache: { write: 0, read: 0 } }, modelID: 'model-a1', providerID: 'gateway', time: { created: at2, completed: at2 }, finish: 'stop' }));
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run('p_v1a7', 'm_v1a7', MAIN_ID, at2, at2, JSON.stringify({ type: 'text', text: 'Post-backfill second v1 answer' }));
    db.close();

    // 路由修复前：追加落在 v1 表，停更的 v2 副本无感 → 计数不变、countChanged 不翻转
    const p2 = await probeAutoRefresh(s, prisma);
    expect(p2.sourceMessageCount).toBe(10);
    expect(p2.countChanged).toBe(true);

    const result = await deltaRefreshSession(MAIN_ID, prisma);
    expect(result.addedTurns).toBeGreaterThan(0);
  });
});
