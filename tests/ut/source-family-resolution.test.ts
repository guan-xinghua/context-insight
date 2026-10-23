// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 源族解析 IT（agent-source-framework：伞形 source + resolveSource 单点）。
// 数据流：jsonl/db 夹具 → import-file / import-file/sessions 两条路由 →
// 响应（taskId/framework/version/source 标记）与 DB 落库行。
// 锁定的行为：
// - 伞形 'jsonl' 双向识别：claude 布局 / codex rollout 各落正确 framework，
//   sessionId 由解析后源的命名规则服务端推导（响应回传 taskId 对账）
// - DSH 原生日志并入 jsonl 族：伞形识别 + 传错源纠偏 + taskId 取日志父目录名
// - 显式传错源 → 族内纠偏（原散装 sqlite detect 先例的泛化）
// - 伞形 + 无人认领 → 400 unresolved-source（不再硬塞给适配器炸 500）
// - 改名 rollout 推导不出 sessionId → 400 session-id-underivable
// - sessions 族扫描：混合目录条目带成员 source 标记；claude 扫描不吞 rollout
//   与 DSH 日志
// - sqlite 双源安全网无回归（声明 opencode-db 传 cannbot 导出库被纠正）
import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { prisma } from '../setup';
import { POST } from '@/app/api/ingest/import-file/route';
import { POST as postSessions } from '@/app/api/ingest/import-file/sessions/route';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'source-family-'));
const mixedDir = path.join(tmpRoot, 'mixed');
fs.mkdirSync(mixedDir, { recursive: true });
const createdSids: string[] = [];

function claudeCapture(): string {
  return [
    JSON.stringify({ type: 'user', message: { role: 'user', content: '族识别测试：设计一个算子' }, timestamp: '2026-10-12T10:00:00.000Z' }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', id: 'msg-fam-1', content: [{ type: 'text', text: '收到，开始设计' }], model: 'glm-5.2', usage: { input_tokens: 10, output_tokens: 5 } },
      timestamp: '2026-10-12T10:00:05.000Z',
    }),
  ].join('\n') + '\n';
}

function codexRollout(sid: string): string {
  const line = (ordinal: number, type: string, payload: Record<string, unknown>): string =>
    JSON.stringify({ timestamp: `2026-10-12T10:00:${String(ordinal).padStart(2, '0')}.000Z`, ordinal, type, payload });
  return [
    line(0, 'session_meta', { id: sid, timestamp: '2026-10-12T10:00:00.000Z', cli_version: '0.161.0', thread_source: 'user' }),
    line(1, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '设计一个融合算子' }] }),
    line(2, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '好的，IR 流水线方案如下' }] }),
    line(3, 'token_usage_record', { usage: { input_tokens: 100, output_tokens: 50 } }),
  ].join('\n') + '\n';
}

const claudeFile = path.join(mixedDir, 'ses_fam_claude_1.jsonl');
fs.writeFileSync(claudeFile, claudeCapture());
const codexSid = 'fam_codex_1';
const codexFile = path.join(mixedDir, `rollout-2026-10-12T10-00-00-${codexSid}.jsonl`);
fs.writeFileSync(codexFile, codexRollout(codexSid));

// DSH 原生日志：文件名固定 session.v4.jsonl，id = 所在目录名（族识别走内容
// 探测，taskId 推导走父目录名规则）
function dshLog(sid: string): string {
  return [
    JSON.stringify({ type: 'session', version: 4, id: sid, createdAt: 1790000000000, cwd: '/tmp/demo' }),
    JSON.stringify({ type: 'turn/start', seq: 0, time: 1790000000010, data: { turn: 1 } }),
    JSON.stringify({ type: 'user/message', seq: 1, time: 1790000000020, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '族识别测试：DSH 原生日志' }] } }),
    JSON.stringify({ type: 'assistant/message', seq: 2, time: 1790000000030, data: { text: '收到，开始设计' } }),
    JSON.stringify({ type: 'turn/end', seq: 3, time: 1790000000040, data: { reason: { kind: 'end_turn' } } }),
  ].join('\n') + '\n';
}
const dshSid = 'fam_dsh_1';
const dshDir = path.join(mixedDir, dshSid);
fs.mkdirSync(dshDir);
const dshFile = path.join(dshDir, 'session.v4.jsonl');
fs.writeFileSync(dshFile, dshLog(dshSid));

const cpxFile = path.join(tmpRoot, 'cpx-ses_fam_cpx1.jsonl');
fs.writeFileSync(cpxFile, claudeCapture());
const weirdFile = path.join(tmpRoot, 'weird.jsonl');
fs.writeFileSync(weirdFile, JSON.stringify({ hello: 'world' }) + '\n');
const renamedRollout = path.join(tmpRoot, 'renamed.jsonl');
fs.writeFileSync(renamedRollout, codexRollout('fam_renamed_1'));

function importReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/ingest/import-file', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function sessionsReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/ingest/import-file/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function cleanupSid(sid: string): Promise<void> {
  const row = await prisma.session.findFirst({ where: { taskId: sid }, select: { id: true } });
  if (row) await prisma.session.delete({ where: { id: row.id } }).catch(() => {});
}

afterEach(async () => {
  for (const sid of createdSids.splice(0)) await cleanupSid(sid);
});

describe('源族解析（伞形 jsonl + resolveSource 单点）', () => {
  it('伞形识别 claude 布局：无 sessionId → 服务端推导 + 响应回传 taskId', async () => {
    const res = await POST(importReq({ source: 'jsonl', filePath: claudeFile }));
    expect(res.status).toBe(200);
    const data = await res.json();
    createdSids.push(data.taskId);
    expect(data.taskId).toBe('ses_fam_claude_1');
    expect(data.imported).toBe(true);
    expect(data.framework).toBe('claude-code');
    const row = await prisma.session.findFirst({ where: { taskId: 'ses_fam_claude_1' }, select: { id: true, framework: true } });
    expect(row?.framework).toBe('claude-code');
    expect(await prisma.turn.count({ where: { sessionId: row!.id } })).toBe(2);
  });

  it('伞形识别 codex rollout：taskId 取 uuid 段 + version 落 cli_version', async () => {
    const res = await POST(importReq({ source: 'jsonl', filePath: codexFile }));
    expect(res.status).toBe(200);
    const data = await res.json();
    createdSids.push(data.taskId);
    expect(data.taskId).toBe(codexSid);
    expect(data.imported).toBe(true);
    expect(data.framework).toBe('codex');
    expect(data.version).toBe('0.161.0');
    const row = await prisma.session.findFirst({ where: { taskId: codexSid }, select: { id: true } });
    expect(await prisma.turn.count({ where: { sessionId: row!.id } })).toBe(2);
  });

  it('伞形识别 DSH 原生日志：taskId 取日志父目录名 + framework dsh', async () => {
    const res = await POST(importReq({ source: 'jsonl', filePath: dshFile }));
    expect(res.status).toBe(200);
    const data = await res.json();
    createdSids.push(data.taskId);
    expect(data.taskId).toBe(dshSid);
    expect(data.imported).toBe(true);
    expect(data.framework).toBe('dsh');
    const row = await prisma.session.findFirst({ where: { taskId: dshSid }, select: { id: true, framework: true } });
    expect(row?.framework).toBe('dsh');
    expect(await prisma.turn.count({ where: { sessionId: row!.id } })).toBe(2);
  });

  it('cpx- 前缀捕获：taskId 剥前缀落真实 sid', async () => {
    const res = await POST(importReq({ source: 'jsonl', filePath: cpxFile }));
    expect(res.status).toBe(200);
    const data = await res.json();
    createdSids.push(data.taskId);
    expect(data.taskId).toBe('ses_fam_cpx1');
    expect(data.framework).toBe('claude-code');
  });

  it('显式传错源 → 族内纠偏（内容真相赢）：claude 件传 codex 源 / rollout 传 claude 源', async () => {
    const r1 = await POST(importReq({ source: 'codex-jsonl', sessionId: 'fam_wrong_claude', filePath: claudeFile }));
    expect(r1.status).toBe(200);
    const d1 = await r1.json();
    createdSids.push(d1.taskId);
    expect(d1.framework).toBe('claude-code');

    const r2 = await POST(importReq({ source: 'claude-jsonl', sessionId: codexSid, filePath: codexFile }));
    expect(r2.status).toBe(200);
    const d2 = await r2.json();
    createdSids.push(d2.taskId);
    expect(d2.framework).toBe('codex');
    expect(d2.taskId).toBe(codexSid);

    // DSH 日志传 claude 源：文件名与内容都是 DSH 指纹，族内纠偏到 dsh-native
    const r3 = await POST(importReq({ source: 'claude-jsonl', filePath: dshFile }));
    expect(r3.status).toBe(200);
    const d3 = await r3.json();
    createdSids.push(d3.taskId);
    expect(d3.framework).toBe('dsh');
    expect(d3.taskId).toBe(dshSid);
  });

  it('伞形 + 无人认领的文件 → 400 unresolved-source（不硬塞适配器）', async () => {
    const res = await POST(importReq({ source: 'jsonl', filePath: weirdFile }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.reason).toBe('unresolved-source');
    expect(data.error).toContain('jsonl');
  });

  it('伞形 + 改名 rollout → 400 session-id-underivable；显式传 sessionId 则成功', async () => {
    const r1 = await POST(importReq({ source: 'jsonl', filePath: renamedRollout }));
    expect(r1.status).toBe(400);
    const d1 = await r1.json();
    expect(d1.reason).toBe('session-id-underivable');

    const r2 = await POST(importReq({ source: 'jsonl', sessionId: 'fam_renamed_1', filePath: renamedRollout }));
    expect(r2.status).toBe(200);
    const d2 = await r2.json();
    createdSids.push(d2.taskId);
    expect(d2.framework).toBe('codex');
    expect(d2.taskId).toBe('fam_renamed_1');
  });

  it('伞形 + 目录路径 → 400 umbrella-needs-file', async () => {
    const res = await POST(importReq({ source: 'jsonl', filePath: mixedDir }));
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe('umbrella-needs-file');
  });

  it('伞形 + 不存在文件 → 404 file-not-found（404 语义不被解析层吞掉）', async () => {
    const res = await POST(importReq({ source: 'jsonl', filePath: path.join(tmpRoot, 'nope.jsonl') }));
    expect(res.status).toBe(404);
    expect((await res.json()).reason).toBe('file-not-found');
  });

  it('sessions 族扫描：混合目录条目带成员 source 标记，claude 不吞 rollout / DSH 日志', async () => {
    const res = await postSessions(sessionsReq({ source: 'jsonl', filePath: mixedDir }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.sessions).toHaveLength(3);
    const claudeEntries = data.sessions.filter((s: { source: string }) => s.source === 'claude-jsonl');
    const codexEntries = data.sessions.filter((s: { source: string }) => s.source === 'codex-jsonl');
    const dshEntries = data.sessions.filter((s: { source: string }) => s.source === 'dsh-native');
    expect(claudeEntries).toHaveLength(1);
    expect(codexEntries).toHaveLength(1);
    expect(dshEntries).toHaveLength(1);
    expect(claudeEntries[0].id).toBe('ses_fam_claude_1');
    expect(codexEntries[0].id).toBe(codexSid);
    expect(dshEntries[0].id).toBe(dshSid);
    // rollout / DSH 日志绝不能以 claude 身份出现（collectJsonlFiles 曾按扩展名误吞）
    expect(claudeEntries.some((s: { id: string }) => s.id === codexSid || s.id === dshSid)).toBe(false);
  });

  it('sessions 伞形 + 不存在路径 → 200 空列表（族扫描各成员自然返回空，不抛 unresolved-source）', async () => {
    const res = await postSessions(sessionsReq({ source: 'jsonl', filePath: path.join(tmpRoot, 'no-such-dir') }));
    expect(res.status).toBe(200);
    expect((await res.json()).sessions).toEqual([]);
  });

  it('sqlite 安全网无回归：声明 opencode-db 传 cannbot 导出库 → 纠偏且条目带真实源', async () => {
    const dbPath = path.join(tmpRoot, 'context_session_fam1.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE "Session" (id TEXT PRIMARY KEY, taskId TEXT, query TEXT, model TEXT, startTime TEXT, endTime TEXT, totalLlmCallCount INTEGER, totalTokens INTEGER, version TEXT)');
    db.prepare('INSERT INTO "Session" VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('row1', 'fam_sqlite_1', 'sqlite 纠偏测试', null, '2026-10-12T10:00:00.000Z', null, 1, 10, null);
    db.close();

    const res = await postSessions(sessionsReq({ source: 'opencode-db', filePath: dbPath }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0].id).toBe('fam_sqlite_1');
    expect(data.sessions[0].source).toBe('context-insight');
  });
});
