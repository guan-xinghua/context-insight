// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Regression: the UI labeled EVERY imported:false as "Already exists". A
// missing capture file also yields imported:false — the API must distinguish
// (404 file-not-found / reason:no-interactions / reason:already-exists) so
// the message reflects the real cause.

import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../setup';
import { POST } from '@/app/api/ingest/import-file/route';

const createdSessionIds: string[] = [];

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/ingest/import-file', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(async () => {
  for (const id of createdSessionIds.splice(0)) {
    try { await prisma.session.delete({ where: { id } }); } catch { /* ignore */ }
  }
});

describe('POST /api/ingest/import-file — failure reasons', () => {
  it('missing file → 404 with reason file-not-found (NOT "already exists")', async () => {
    const res = await POST(req({
      source: 'claude-jsonl',
      sessionId: 'no-such-file-sid',
      filePath: '/root/.cannbot-insight/proxy/definitely-missing-capture.jsonl',
    }));
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.reason).toBe('file-not-found');
    expect(data.error).toContain('File not found');
  });

  it('existing file that parses to 0 interactions → placeholder session (imported-empty) + cleanup', async () => {
    // 共享 dev.db 自愈预清理：历史运行中断泄漏的同名会话会让本用例走 merge
    // 路径（imported:false）而永久失败
    await prisma.session.deleteMany({ where: { taskId: 'empty-session-it' } });
    const emptyFile = path.join(__dirname, './data/claude-sessions/empty-session.jsonl');
    fs.writeFileSync(emptyFile, '');
    try {
      const res = await POST(req({ source: 'claude-jsonl', sessionId: 'empty-session-it', filePath: emptyFile }));
      expect(res.status).toBe(200);
      const data = await res.json();
      // b17e13b7 起空 claude 捕获文件导入为占位 session（“捕获中”，等 merge 填充）
      expect(data.imported).toBe(true);
      expect(data.reason).toBe('imported-empty');
      const s = await prisma.session.findFirst({ where: { taskId: 'empty-session-it' } });
      expect(s).not.toBeNull();
      expect(s!.label).toContain('捕获中');
      createdSessionIds.push(s!.id);
    } finally {
      fs.unlinkSync(emptyFile);
    }
  });

  it('re-import of an existing session → reason already-exists', async () => {
    const FIXTURE = path.join(__dirname, './data/claude-sessions/system-reminder-strip.jsonl');
    const sid = 'import-reason-it';
    const first = await POST(req({ source: 'claude-jsonl', sessionId: sid, filePath: FIXTURE }));
    const d1 = await first.json();
    if (d1.imported) {
      const s = await prisma.session.findFirst({ where: { taskId: sid } });
      if (s) createdSessionIds.push(s.id);
    }
    const second = await POST(req({ source: 'claude-jsonl', sessionId: sid, filePath: FIXTURE }));
    expect(second.status).toBe(200);
    const d2 = await second.json();
    expect(d2.imported).toBe(false);
    expect(d2.reason).toBe('already-exists');
    expect(d2.query).toBeTruthy();
  });
});

describe('POST /api/ingest/import-file — empty claude capture placeholder', () => {
  const tmpCapture = path.join(__dirname, './data/claude-sessions/live-capture-it.jsonl');

  afterEach(async () => {
    try { fs.unlinkSync(tmpCapture); } catch { /* */ }
    const s = await prisma.session.findFirst({ where: { taskId: 'live-capture-it' } });
    if (s) { try { await prisma.session.delete({ where: { id: s.id } }); } catch { /* */ } }
  });

  it('empty capture file imports as a visible placeholder session', async () => {
    fs.writeFileSync(tmpCapture, '');
    const res = await POST(req({ source: 'claude-jsonl', sessionId: 'live-capture-it', filePath: tmpCapture }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.imported).toBe(true);
    expect(data.reason).toBe('imported-empty');
    const s = await prisma.session.findFirst({ where: { taskId: 'live-capture-it' } });
    expect(s).not.toBeNull();
    expect(s!.framework).toBe('claude-code');
    expect(s!.label).toContain('捕获中');
    expect(s!.sourcePath).toBe(tmpCapture);
  });

  it('re-import after the file fills up MERGES turns into the same session (dynamic refresh flow)', async () => {
    fs.writeFileSync(tmpCapture, '');
    await POST(req({ source: 'claude-jsonl', sessionId: 'live-capture-it', filePath: tmpCapture }));
    const s1 = await prisma.session.findFirst({ where: { taskId: 'live-capture-it' } });
    expect(s1).not.toBeNull();
    expect(await prisma.turn.count({ where: { sessionId: s1!.id } })).toBe(0);

    // the proxy appends real content (copy the fixture conversation in)
    fs.appendFileSync(tmpCapture, fs.readFileSync(path.join(__dirname, './data/claude-sessions/system-reminder-strip.jsonl')));
    const res2 = await POST(req({ source: 'claude-jsonl', sessionId: 'live-capture-it', filePath: tmpCapture }));
    expect(res2.status).toBe(200);
    const s2 = await prisma.session.findFirst({ where: { taskId: 'live-capture-it' } });
    expect(s2!.id).toBe(s1!.id); // same session, not a duplicate
    const turns = await prisma.turn.count({ where: { sessionId: s2!.id } });
    expect(turns).toBeGreaterThan(0);
    expect(s2!.query).toBeTruthy();
  });
});

describe('GET /api/observe/session/wire-rounds — direct-from-file round view', () => {
  it('rebuilds each wire request from the capture file (ground truth for LLM Input comparison)', async () => {
    const FIXTURE = path.join(__dirname, './data/claude-sessions/system-reminder-strip.jsonl');
    const sid = 'wire-rounds-it';
    const first = await POST(req({ source: 'claude-jsonl', sessionId: sid, filePath: FIXTURE }));
    const d1 = await first.json();
    if (d1.imported) {
      const s = await prisma.session.findFirst({ where: { taskId: sid } });
      if (s) createdSessionIds.push(s.id);
    }
    const { GET } = await import('@/app/api/observe/session/wire-rounds/route');
    const res = await GET(new NextRequest(`http://localhost/api/observe/session/wire-rounds?taskId=${sid}`));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.totalRounds).toBe(2); // fixture: 2 assistant responses
    // round 1 request = the accumulated messages before the first response
    const r1 = data.rounds[0];
    expect(r1.requestMessages.length).toBe(1); // the first user line (reminder + prompt in ONE message)
    // round 2 carries round 1's history plus the new messages
    const r2 = data.rounds[1];
    expect(r2.requestMessages.length).toBeGreaterThan(r1.requestMessages.length);
    expect(r2.requestMessages[0].role).toBe('user');
    expect(r2.requestMessages[0].content.json).toContain('system-reminder');
  });

  it('maps anthropic-style usage (input_tokens/output_tokens) to the page口径 input/output', async () => {
    // wire 捕获里 usage 是 anthropic 键名；页面消费 {input,output}——归一错位会让
    // tokens 显示成 "-"（回归：曾直接 cast 键名对不上）
    const file = path.join(__dirname, './data/claude-sessions/wire-usage-map.jsonl');
    const ts = (i: number) => new Date(Date.UTC(2026, 8, 2, 10, 0, i)).toISOString();
    fs.writeFileSync(file, [
      { type: 'user', message: { role: 'user', content: '跑一下' }, timestamp: ts(0) },
      { type: 'assistant', message: { id: 'msg_w1', role: 'assistant', content: [{ type: 'text', text: '好' }], model: 'test-model', usage: { input_tokens: 120, output_tokens: 30 } }, timestamp: ts(1) },
    ].map(l => JSON.stringify(l)).join('\n') + '\n');
    try {
      const sid = 'wire-usage-map-it';
      await prisma.session.deleteMany({ where: { taskId: sid } });
      await POST(req({ source: 'claude-jsonl', sessionId: sid, filePath: file }));
      const { GET } = await import('@/app/api/observe/session/wire-rounds/route');
      const res = await GET(new NextRequest(`http://localhost/api/observe/session/wire-rounds?taskId=${sid}`));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.totalRounds).toBe(1);
      expect(data.rounds[0].usage).toEqual({ input: 120, output: 30 });
      const s = await prisma.session.findFirst({ where: { taskId: sid } });
      if (s) createdSessionIds.push(s.id);
    } finally {
      fs.unlinkSync(file);
    }
  });

  it('404 when the session is unknown', async () => {
    const { GET } = await import('@/app/api/observe/session/wire-rounds/route');
    const res = await GET(new NextRequest('http://localhost/api/observe/session/wire-rounds?taskId=no-such-sid'));
    expect(res.status).toBe(404);
  });
});
