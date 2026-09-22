// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE,
// See LICENSE in the root of the software repository for the full text of the License.

// 增量刷新漂移检测 IT（现场回归锁：opencode 升级引入 step 部件 → 旧消息
// 多产空轮 → 位次错位 → 角色互相覆写 + 计数膨胀）：
//   ① 尾部追加（正常增量）：不触发漂移，走快路径——旧行 id 保留、只加新轮
//   ② 中段回溯插入（旧消息间多出一条新消息/空轮）：触发漂移 → 全量替换，
//      角色保真（user 还是 user、assistant 还是 assistant）、轮数 = 源数
//   ③ 源回缩（旧消息被删）：触发漂移 → 全量替换，轮数回落
//   ④ 旧消息内容被改写（非前缀延长）：触发漂移
//   ⑤ 全量替换后 Session 聚合必须同步重算（不残留替换前脏值，且漂移
//      一次性触发后无后续刷新可矫正）+ addedTurns 报净增不报总轮数

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { importSession, deltaRefreshSession } from '@/lib/ingest/data-service';
import { detectRankedPrefixDrift } from '@/lib/ingest/merge';

const prisma = new PrismaClient();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-drift-it-'));
const TASK_ID = 'cc-delta-drift-it';
const DB_FILE = path.join(TMP, 'opencode.db');

const createdSessionIds: string[] = [];

function writeDb(messages: Array<{ role: string; text: string; at: number }>): void {
  fs.rmSync(DB_FILE, { force: true });
  const db = new Database(DB_FILE);
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, version TEXT, directory TEXT, summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER)');
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER, time_updated INTEGER)');
  db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
  db.prepare('INSERT INTO session VALUES (?, NULL, NULL, NULL, NULL, NULL, NULL)').run(TASK_ID);
  let seq = 0;
  for (const m of messages) {
    const data: Record<string, unknown> = { role: m.role, time: { created: m.at, completed: m.at + 1000 } };
    if (m.role === 'assistant') data.agent = 'build';
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(`msg_${seq}`, TASK_ID, JSON.stringify(data), m.at, m.at);
    if (m.text) {
      db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run(
        `part_${seq}`, `msg_${seq}`, TASK_ID, m.at, m.at, JSON.stringify({ type: 'text', text: m.text }));
    }
    seq++;
  }
  db.close();
}

async function turnRows() {
  const s = await prisma.session.findFirstOrThrow({ where: { taskId: TASK_ID } });
  return prisma.turn.findMany({ where: { sessionId: s.id }, orderBy: { turnIndex: 'asc' } });
}

beforeAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: TASK_ID } });
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: TASK_ID } }).catch(() => {});
  await prisma.$disconnect();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('增量刷新漂移检测', () => {
  it('① 尾部追加：快路径，不触发全量替换，旧行 id 保留', async () => {
    const t0 = 1789300000000;
    writeDb([
      { role: 'user', text: '问题一', at: t0 },
      { role: 'assistant', text: '回答一', at: t0 + 1000 },
    ]);
    await importSession(DB_FILE, TASK_ID, prisma, DB_FILE, 'opencode-db');
    const before = await turnRows();
    expect(before.length).toBe(2);
    const beforeIds = before.map(t => t.id);

    // 追加一轮
    writeDb([
      { role: 'user', text: '问题一', at: t0 },
      { role: 'assistant', text: '回答一', at: t0 + 1000 },
      { role: 'user', text: '问题二', at: t0 + 2000 },
      { role: 'assistant', text: '回答二', at: t0 + 3000 },
    ]);
    const r = await deltaRefreshSession(TASK_ID, prisma);
    expect(r.addedTurns).toBe(2); // 只加了 2（快路径）
    const after = await turnRows();
    expect(after.length).toBe(4);
    expect(after.slice(0, 2).map(t => t.id)).toEqual(beforeIds); // 旧行原封
  });

  it('② 中段回溯插入（旧消息间多出一条）：漂移 → 全量替换，角色保真', async () => {
    const t0 = 1789300000000;
    writeDb([
      { role: 'user', text: '问题一', at: t0 },
      { role: 'assistant', text: '回答一', at: t0 + 1000 },
      { role: 'user', text: '问题二', at: t0 + 2000 },
      { role: 'assistant', text: '回答二', at: t0 + 3000 },
    ]);
    // 旧消息之间插入一条（模拟 opencode 升级后旧消息多产出一条）
    writeDb([
      { role: 'user', text: '问题一', at: t0 },
      { role: 'assistant', text: '回答一', at: t0 + 1000 },
      { role: 'assistant', text: '新插入的空轮', at: t0 + 1500 },
      { role: 'user', text: '问题二', at: t0 + 2000 },
      { role: 'assistant', text: '回答二', at: t0 + 3000 },
    ]);
    const r = await deltaRefreshSession(TASK_ID, prisma);
    expect(r.fullRebuild).toBe(true);
    expect(r.rebuiltTurns).toBe(5); // 全量替换：重建 5 轮
    expect(r.addedTurns).toBe(1); // 相对替换前（4 轮）的净增，不把总轮数报成新增
    const after = await turnRows();
    expect(after.length).toBe(5); // 计数不膨胀
    // 角色保真：user 行内容是用户文本，assistant 行内容是回答
    const users = after.filter(t => t.role === 'user').map(t => t.content);
    expect(users).toEqual(['问题一', '问题二']);
    const assistants = after.filter(t => t.role === 'assistant').map(t => t.content);
    expect(assistants).toContain('回答一');
    expect(assistants).toContain('回答二');
  });

  it('③ 源回缩（旧消息被删）：漂移 → 全量替换，轮数回落', async () => {
    const t0 = 1789300000000;
    writeDb([
      { role: 'user', text: '问题一', at: t0 },
      { role: 'assistant', text: '回答一', at: t0 + 1000 },
    ]);
    const r = await deltaRefreshSession(TASK_ID, prisma);
    expect(r.fullRebuild).toBe(true);
    expect(r.rebuiltTurns).toBe(2);
    expect(r.addedTurns).toBe(0); // 回缩：净增 0（不报负数）
    expect((await turnRows()).length).toBe(2);
  });

  it('④ 旧消息内容改写（非前缀延长）与纯单元：detectRankedPrefixDrift 判定', () => {
    const mk = (i: number, role: string, content: string, sub: string | null = null) =>
      ({ turnIndex: i, subagentSessionId: sub, role, agentName: role === 'assistant' ? 'build' : null, content });
    // 一致前缀 → 不漂移
    expect(detectRankedPrefixDrift(
      [mk(0, 'user', 'q'), mk(1, 'assistant', 'a1')],
      [mk(0, 'user', 'q'), mk(1, 'assistant', 'a1'), mk(2, 'user', 'q2')],
    )).toBe(false);
    // 尾部增长（in-flight 补全）→ 不漂移
    expect(detectRankedPrefixDrift(
      [mk(0, 'assistant', '部分内')],
      [mk(0, 'assistant', '部分内容补全')],
    )).toBe(false);
    // 角色错位 → 漂移
    expect(detectRankedPrefixDrift(
      [mk(0, 'user', 'q'), mk(1, 'assistant', 'a')],
      [mk(0, 'user', 'q'), mk(1, 'user', 'a'), mk(2, 'assistant', 'b')],
    )).toBe(true);
    // 内容改写 → 漂移
    expect(detectRankedPrefixDrift(
      [mk(0, 'assistant', '旧内容')],
      [mk(0, 'assistant', '完全不同的内容')],
    )).toBe(true);
    // 回缩 → 漂移
    expect(detectRankedPrefixDrift(
      [mk(0, 'user', 'q'), mk(1, 'assistant', 'a')],
      [mk(0, 'user', 'q')],
    )).toBe(true);
  });

  it('⑤ 漂移全量替换后 Session 聚合同步重算（不残留替换前脏值）', async () => {
    // 现场回归锁：漂移替换曾跳过聚合重算，Session 行残留位次错乱期的脏聚合；
    // 且漂移典型场景一次性触发后 countChanged/timeChanged 均不再变化，没有
    // 后续刷新能矫正——必须在替换事务提交的同一次刷新内重算
    const t0 = 1789300000000;
    // 污染 Session 聚合（模拟替换前的脏值）
    const s = await prisma.session.findFirstOrThrow({ where: { taskId: TASK_ID } });
    await prisma.session.update({
      where: { id: s.id },
      data: { totalToolCallCount: 999999, totalTokens: 888888, endTime: new Date(0) },
    });
    // 触发漂移：旧消息之间插入一条（身份字段同位、内容改写）
    writeDb([
      { role: 'user', text: '问题一', at: t0 },
      { role: 'assistant', text: '中段插入', at: t0 + 500 },
      { role: 'assistant', text: '回答一', at: t0 + 1000 },
    ]);
    const r = await deltaRefreshSession(TASK_ID, prisma);
    expect(r.fullRebuild).toBe(true);
    const after = await prisma.session.findFirstOrThrow({ where: { taskId: TASK_ID } });
    expect(after.totalToolCallCount).toBe(0); // 999999 脏值已被重算覆盖
    expect(after.totalTokens).not.toBe(888888);
    expect(after.endTime?.getTime()).toBeGreaterThan(t0); // 1970 脏值重算为源内时间
  });
});

describe('opencode 标题作 Query（title 优先决议）', () => {
  const TITLE_TASK = 'cc-title-query-it';
  const TITLE_DB = path.join(TMP, 'opencode-title.db');

  function writeTitleDb(title: string | null): void {
    fs.rmSync(TITLE_DB, { force: true });
    const db = new Database(TITLE_DB);
    // 真实 opencode.db 布局：session 表含 title 列（title-gen 产物）
    db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, version TEXT, directory TEXT, summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER)');
    db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER, time_updated INTEGER)');
    db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
    db.prepare('INSERT INTO session VALUES (?, NULL, ?, NULL, NULL, NULL, NULL, NULL)').run(TITLE_TASK, title);
    const t0 = 1789300000000;
    // 首条 user 是后台任务通知（曾误导 Query 的形态），其后才是真人输入
    const rows: Array<[string, string | null]> = [
      ['user', '<task id="ses_bg1" state="completed">\n<summary>Background task completed</summary>\n</task>'],
      ['user', '请实现 ConfusionMulGrad 算子'],
      ['assistant', '好的，开始。'],
    ];
    let seq = 0;
    for (const [role, text] of rows) {
      const data: Record<string, unknown> = { role, time: { created: t0 + seq * 1000, completed: t0 + seq * 1000 + 900 } };
      if (role === 'assistant') data.agent = 'build';
      db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(`m${seq}`, TITLE_TASK, JSON.stringify(data), t0 + seq * 1000, t0 + seq * 1000);
      if (text) {
        db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run(
          `p${seq}`, `m${seq}`, TITLE_TASK, t0 + seq * 1000, t0 + seq * 1000, JSON.stringify({ type: 'text', text }));
      }
      seq++;
    }
    db.close();
  }

  it('小模型生成的标题直接作 Query（任务通知不掺和）', async () => {
    await prisma.session.deleteMany({ where: { taskId: TITLE_TASK } }).catch(() => {});
    writeTitleDb('ConfusionMulGrad Ascend C 算子开发');
    await importSession(TITLE_DB, TITLE_TASK, prisma, TITLE_DB, 'opencode-db');
    const s = await prisma.session.findFirstOrThrow({ where: { taskId: TITLE_TASK } });
    expect(s.query).toBe('ConfusionMulGrad Ascend C 算子开发');
  });

  it('缺省占位标题（New session - …）回落：任务通知跳过、取真人输入', async () => {
    await prisma.session.deleteMany({ where: { taskId: TITLE_TASK } });
    writeTitleDb('New session - 2026-09-18T08:32:09.590Z');
    await importSession(TITLE_DB, TITLE_TASK, prisma, TITLE_DB, 'opencode-db');
    const s = await prisma.session.findFirstOrThrow({ where: { taskId: TITLE_TASK } });
    expect(s.query).toBe('请实现 ConfusionMulGrad 算子');
  });

  it('delta 刷新（快路径回写）同样保持标题决议', async () => {
    await prisma.session.deleteMany({ where: { taskId: TITLE_TASK } });
    writeTitleDb('ConfusionMulGrad Ascend C 算子开发');
    await importSession(TITLE_DB, TITLE_TASK, prisma, TITLE_DB, 'opencode-db');
    // 手动污染 query（模拟旧版残留），刷新后应回到标题
    const s = await prisma.session.findFirstOrThrow({ where: { taskId: TITLE_TASK } });
    await prisma.session.update({ where: { id: s.id }, data: { query: '<task id="x" state="completed">旧残留</task>' } });
    await deltaRefreshSession(TITLE_TASK, prisma);
    const after = await prisma.session.findFirstOrThrow({ where: { taskId: TITLE_TASK } });
    expect(after.query).toBe('ConfusionMulGrad Ascend C 算子开发');
  });

  afterAll(async () => {
    await prisma.session.deleteMany({ where: { taskId: TITLE_TASK } }).catch(() => {});
  });
});
