// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details on how to use this file in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// opencode 2.x（session_v2 / session_message schema）适配 IT：现场回归锁
// （客户报错 "no such table: session"——opencode 2.0 起会话表改名 session_v2、
// 消息改事件溯源单表）。覆盖：schema 嗅探、listSessions 聚合、readSession
// 全类型映射（含工具内联/compaction/system/synthetic/skill 与控制面跳过）、
// 子代理链、readSessionMeta、导入全链（adapter → turn-split → SkillEvent →
// 聚合）、未知 schema 的类型化错误与路由 400。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { materializeV1Fixture } from '../helpers/materialize-v1-fixture';
import { NextRequest } from 'next/server';
import { PrismaClient } from '@prisma/client';
import {
  listSessions,
  listSubagentSessions,
  readSession,
  readSessionMeta,
  NotOpencodeDbError,
} from '@/lib/ingest/adapters/opencode-db';
import { importSession } from '@/lib/ingest/data-service';
import { detectSqliteSource } from '@/lib/ingest/sqlite-detect';
import { POST as listSessionsRoute } from '@/app/api/ingest/import-file/sessions/route';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-v2-it-'));
const V2_DB = path.join(TMP, 'opencode.db');
const ALIEN_DB = path.join(TMP, 'alien.db');
// v1 夹具物化私有副本（.db 二进制被 gitignore 吞掉从未入库，CI 全新 clone 缺件
// 会让 v1 回归用例静默拿到 0 会话）；afterAll 清 path.dirname
const V1_DB = materializeV1Fixture('v2-adapter');

const MAIN_ID = 'ses_v2main001ffeV2SampleAaa';
const SUB_ID = 'ses_v2sub001ffeV2SampleBbb';
const FAIL_ID = 'ses_v2fail001ffeV2SampleCcc';

const prisma = new PrismaClient();
const createdSessionIds: string[] = [];

// materialized in beforeAll（describe 体在收集期执行，不能提前读库）
let v2Sessions: ReturnType<typeof listSessions>;
let v2MainRows: ReturnType<typeof readSession>;

beforeAll(() => {
  const sql = fs.readFileSync(path.resolve(__dirname, 'data/e2e/opencode-v2-sample.sql'), 'utf-8');
  const db = new Database(V2_DB);
  db.exec(sql);
  db.close();

  const alien = new Database(ALIEN_DB);
  alien.exec('CREATE TABLE something_else (id TEXT PRIMARY KEY)');
  alien.close();

  v2Sessions = listSessions(V2_DB);
  v2MainRows = readSession(V2_DB, MAIN_ID);
});

afterAll(async () => {
  for (const id of createdSessionIds.splice(0)) {
    await prisma.session.delete({ where: { id } }).catch(() => {});
  }
  await prisma.$disconnect();
  fs.rmSync(path.dirname(V1_DB), { recursive: true, force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('opencode v2 schema 嗅探', () => {
  it('detectSqliteSource：session_v2 库 → opencode-db（v1 session 表已不存在）', () => {
    expect(detectSqliteSource(V2_DB)).toBe('opencode-db');
  });

  it('非 opencode 库 → null（不被 v2 误认）', () => {
    expect(detectSqliteSource(ALIEN_DB)).toBeNull();
  });
});

describe('opencode v2 listSessions', () => {
  it('顶层会话两条（子代理被 parent_id 过滤），按活跃度排序', () => {
    expect(v2Sessions.map(s => s.id)).toEqual([FAIL_ID, MAIN_ID]);
  });

  it('主会话：首问/轮数/模型/tokens 五项求和/版本', () => {
    const main = v2Sessions.find(s => s.id === MAIN_ID)!;
    expect(main.firstQuery).toBe('Help me fix the build failure in sample project');
    // 12 rows in session_message (seq 4..15), control-plane rows excluded:
    // 8 importable rows (user/assistant×3/system/compaction/synthetic/skill)
    expect(main.turnCount).toBe(8);
    expect(main.modelName).toBe('gateway/model-a1');
    // assistant tokens only: 1575 + 1485 + 1040 (compaction type excluded)
    expect(main.totalTokens).toBe(4100);
    expect(main.version).toBe('2.0.18');
    expect(main.createdAt).toBe(new Date(1790000000000).toISOString());
    expect(main.endedAt).toBe(new Date(1790000014000).toISOString());
  });

  it('失败会话：title null / 无 assistant → 模型与 tokens 为空', () => {
    const failed = v2Sessions.find(s => s.id === FAIL_ID)!;
    expect(failed.modelName).toBeNull();
    expect(failed.totalTokens).toBe(0);
    expect(failed.turnCount).toBe(1);   // user 行计入，idle 控制面行不计入
    expect(failed.firstQuery).toContain('fail before the first response');
  });

  it('v1 行为回归：现存 v1 夹具不受影响', () => {
    const v1 = listSessions(V1_DB);
    expect(v1.length).toBe(2);
  });
});

describe('opencode v2 readSession（全类型映射）', () => {
  it('12 行消息 → 8 行交互（idle/shell/agent-switched/model-switched 跳过）', () => {
    expect(v2MainRows.map(r => r.role)).toEqual([
      'user', 'assistant', 'assistant', 'assistant', 'system', 'assistant', 'user', 'user',
    ]);
  });

  it('assistant 行：thinking 包裹 + 文本 + 内联工具展开 + usage/latency/finish/model', () => {
    const first = v2MainRows[1]!;
    expect(first.content).toContain('<thinking>');
    expect(first.content).toContain('Let me inspect the project.');
    expect(first.agent).toBe('build');
    expect(first.model).toBe('gateway/model-a1');
    expect(first.modelID).toBe('model-a1');
    expect(first.providerID).toBe('gateway');
    expect(first.finish_reason).toBe('tool-calls');
    expect(first.latency).toBe(2900);
    expect(first.usage).toMatchObject({ total: 1575, input: 1200, output: 45, reasoning: 30, cacheRead: 300, cacheWrite: 0, cost: 0.012 });
    expect(first.tool_calls).toHaveLength(1);
    const skill = first.tool_calls![0]!;
    expect(skill).toMatchObject({ toolCallId: 'call_skill_001', toolName: 'skill', state: 'completed' });
    expect(JSON.parse(skill.argsJson!)).toEqual({ skill: 'demo-skill' });
    expect(skill.resultJson).toContain('demo-skill loaded');
  });

  it('工具错误态：state=error，resultJson 取 error 载荷', () => {
    const second = v2MainRows[2]!;
    const read = second.tool_calls![0]!;
    expect(read).toMatchObject({ toolCallId: 'call_read_002', toolName: 'read', state: 'error' });
    expect(JSON.parse(read.argsJson!)).toEqual({ filePath: 'missing.txt' });
    expect(read.resultJson).toContain('file not found');
  });

  it('末段 assistant：finish=stop 无工具', () => {
    const third = v2MainRows[3]!;
    expect(third.finish_reason).toBe('stop');
    expect(third.tool_calls).toBeNull();
    expect(third.content).toContain('missing.txt is referenced but does not exist');
  });

  it('system 行保真；compaction → agent=compaction + summary 为内容', () => {
    expect(v2MainRows[4]).toMatchObject({ role: 'system', content: 'Environment switched to debug mode' });
    expect(v2MainRows[5]).toMatchObject({ role: 'assistant', agent: 'compaction' });
    expect(v2MainRows[5]!.content).toContain('Compacted summary');
  });

  it('synthetic / skill → user 行', () => {
    expect(v2MainRows[6]).toMatchObject({ role: 'user', content: 'Subagent task completed, merging results' });
    expect(v2MainRows[7]).toMatchObject({ role: 'user', content: 'Contents of demo-skill SKILL.md body' });
  });

  it('子代理会话：parent_id + @agent 标题解析 + task 工具 dispatch 元数据并入参数', () => {
    const sub = readSession(V2_DB, SUB_ID);
    expect(sub.length).toBe(2);
    for (const row of sub) {
      expect(row.subagent_session_id).toBe(SUB_ID);
      expect(row.subagent_name).toBe('build');
    }
    const task = sub[1]!.tool_calls!.find(t => t.toolName === 'task')!;
    const args = JSON.parse(task.argsJson!) as Record<string, unknown>;
    expect(args.subagent_session_id).toBe('ses_v2subsub001ffeV2SampleDdd');
    expect(args.subagent_model).toEqual({ id: 'model-a1', providerID: 'gateway' });
    const bash = sub[1]!.tool_calls!.find(t => t.toolName === 'bash')!;
    expect(bash.state).toBe('completed');
    expect(bash.resultJson).toContain('missing.txt not found');
  });

  it('子代理枚举与 readSessionMeta（v2 列映射）', () => {
    expect(listSubagentSessions(V2_DB, MAIN_ID)).toEqual([SUB_ID]);
    const db = new Database(V2_DB, { readonly: true });
    try {
      const main = readSessionMeta(db, MAIN_ID);
      expect(main).toMatchObject({
        parentId: null,
        title: 'Fix build failure in sample project',
        version: '2.0.18',
        directory: '/home/demo/proj',
        summaryAdditions: 12,
        summaryDeletions: 3,
        summaryFiles: 2,
      });
      expect(readSessionMeta(db, SUB_ID).parentId).toBe(MAIN_ID);
    } finally {
      db.close();
    }
  });
});

describe('opencode v2 导入全链（adapter → turn-split → SkillEvent → 聚合）', () => {
  it('主会话导入：Session/Turn/ToolCall/SkillEvent 全部落库', async () => {
    const result = await importSession(V2_DB, MAIN_ID, prisma, V2_DB, 'opencode-db');
    expect(result.imported).toBe(true);
    expect(result.query).toContain('build failure');

    const session = await prisma.session.findFirstOrThrow({ where: { taskId: MAIN_ID } });
    createdSessionIds.push(session.id);

    expect(session.framework).toBe('opencode');
    expect(session.version).toBe('2.0.18');
    expect(session.totalTokens).toBeGreaterThan(0);

    const turns = await prisma.turn.findMany({ where: { sessionId: session.id }, orderBy: { turnIndex: 'asc' } });
    expect(turns.length).toBeGreaterThanOrEqual(4);

    const toolCalls = await prisma.toolCall.findMany({ where: { turn: { sessionId: session.id } } });
    const toolNames = toolCalls.map(t => t.toolName);
    for (const name of ['skill', 'read', 'task', 'bash']) {
      expect(toolNames).toContain(name);
    }

    const skillEvents = await prisma.skillEvent.findMany({ where: { turn: { sessionId: session.id } } });
    expect(skillEvents.map(e => e.skillName)).toContain('demo-skill');

    const subTurns = await prisma.turn.findMany({ where: { sessionId: session.id, subagentName: 'build' } });
    expect(subTurns.length).toBeGreaterThan(0);
  });

  it('同库再导同会话 → already-exists（合并路径不重复建行）', async () => {
    const again = await importSession(V2_DB, MAIN_ID, prisma, V2_DB, 'opencode-db');
    expect(again.imported).toBe(false);
    expect(again.query).toContain('build failure');
  });
});

describe('未知 schema 的类型化错误（客户报错回归锁）', () => {
  it('listSessions 对非 opencode 库抛 NotOpencodeDbError（含表清单），不再是裸 no such table', () => {
    try {
      listSessions(ALIEN_DB);
      expect.unreachable('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(NotOpencodeDbError);
      const err = e as NotOpencodeDbError;
      expect(err.tables).toContain('something_else');
      expect(err.message).toContain('opencode');
      expect(err.message).not.toContain('no such table');
    }
  });

  it('readSession 同样抛类型化错误', () => {
    expect(() => readSession(ALIEN_DB, 'whatever')).toThrow(NotOpencodeDbError);
  });

  it('路由层：/api/ingest/import-file/sessions → 400 + reason=not-opencode-db', async () => {
    const req = new NextRequest('http://localhost/api/ingest/import-file/sessions', {
      method: 'POST',
      body: JSON.stringify({ source: 'opencode-db', filePath: ALIEN_DB }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await listSessionsRoute(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.reason).toBe('not-opencode-db');
    expect(data.error).toContain('opencode');
  });
});

describe('opencode v2 会话列表路由', () => {
  it('POST /api/ingest/import-file/sessions → 200 返回两条顶层会话', async () => {
    const req = new NextRequest('http://localhost/api/ingest/import-file/sessions', {
      method: 'POST',
      body: JSON.stringify({ source: 'opencode-db', filePath: V2_DB }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await listSessionsRoute(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect((data.sessions as Array<{ id: string }>).map(s => s.id).sort()).toEqual([FAIL_ID, MAIN_ID].sort());
  });
});
