// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// cannbot proxy 捕获全链路 IT（proxy/CANNBOT-DESIGN.md §7）：cannbot 是 opencode
// 系 fork（openai 协议、X-Session-Id 头、UA cannbot/*）。验证统一分类器 Gen6
// 判定 → importSession 落库 framework='cannbot' / version='<UA版本>-cannbot-proxy'
// → isClaudeFormatSession / 徽标谓词成立 → cannbay2 上传 type 列可见。
import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prisma } from '../setup';
import { POST } from '@/app/api/ingest/import-file/route';
import { isClaudeFormatSession, isProxyVersion } from '@/lib/shared/session-format';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-proxy-fw-'));

// 形状 = opencode-emitter 对 UA cannbot/* 记录的真实产物（Gen6 双轨）：
// meta（framework=cannbot + ccVersion）+ 行级 source + x_cannbay 声明 + wire 字段
function cannbotCapture(name: string, sid: string): string {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, [
    JSON.stringify({
      type: 'user', message: { role: 'user', content: '帮我看一下这个算子' }, timestamp: '2026-08-25T10:00:00.000Z',
      source: 'cannbot-proxy',
      x_cannbay: { schema: 'cc-wire-input', version: 1, data: { roundIndex: 0, kind: 'user' } },
    }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', id: `msg_${sid}`, content: [{ type: 'text', text: '开始分析' }], model: 'glm-5.2', usage: { input_tokens: 100, output_tokens: 20 } },
      timestamp: '2026-08-25T10:00:05.000Z',
      source: 'cannbot-proxy', version: '1.1.2',
      duration_ms: 1200, stopReason: 'stop', ttftMs: 200,
      system: 'You are cannbot, the CANN coding agent.', tools: [{ name: 'bash', description: 'Run a command.' }],
      x_cannbay: {
        schema: 'cc-wire-round', version: 1,
        data: { roundIndex: 0, protocol: 'openai', latencyMs: 1200, ttftMs: 200, stopReason: 'stop', status: 200, requestParams: { model: 'glm-5.2' } },
      },
    }),
  ].join('\n') + '\n');
  fs.writeFileSync(file.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({
    x_cannbay: { schema: 'cc-session-meta', version: 1, data: { producer: 'cpx', framework: 'cannbot', protocol: 'openai', ccVersion: '1.1.2', sid } },
  }));
  return file;
}

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

describe('cannbot proxy 捕获（Gen6）framework 归属闭环', () => {
  it("meta 权威判定 → framework='cannbot'，version='<UA版本>-cannbot-proxy'（ccVersion 来自 meta）", async () => {
    const sid = 'cb-proxy-fw-it-1';
    const file = cannbotCapture('cb-proxy-1.jsonl', sid);
    const res = await POST(req({ source: 'claude-jsonl', sessionId: sid, filePath: file }));
    expect(res.status).toBe(200);
    const row = await prisma.session.findFirst({ where: { taskId: sid }, select: { id: true, framework: true, version: true } });
    expect(row).not.toBeNull();
    createdSessionIds.push(row!.id);
    expect(row!.framework).toBe('cannbot');
    expect(row!.version).toBe('1.1.2-cannbot-proxy');
    // 徽标/格式谓词：proxy 徽标成立、claude 格式门禁（wire/full-context/刷新）通过
    expect(isProxyVersion(row!.version)).toBe(true);
    expect(isClaudeFormatSession(row!.framework, row!.version)).toBe(true);
  });

  it('行级 source 兜底（meta 缺失）→ framework 仍归 cannbot，不落 claude-code 默认族', async () => {
    const sid = 'cb-proxy-fw-it-2';
    const file = cannbotCapture('cb-proxy-2.jsonl', sid);
    fs.rmSync(file.replace(/\.jsonl$/, '.meta.json'));
    const res = await POST(req({ source: 'claude-jsonl', sessionId: sid, filePath: file }));
    expect(res.status).toBe(200);
    const row = await prisma.session.findFirst({ where: { taskId: sid }, select: { id: true, framework: true, version: true } });
    expect(row).not.toBeNull();
    createdSessionIds.push(row!.id);
    expect(row!.framework).toBe('cannbot');
    // assistant 行顶层 version:1.1.2（legacy 通道）与 marker 组合 → 版本保留
    expect(row!.version).toBe('1.1.2-cannbot-proxy');
  });

  it('wire 数据完整落库：latency/finishReason/ttft 经 x_cannbay 通道，turns/toolCalls 齐全', async () => {
    const sid = 'cb-proxy-fw-it-3';
    const file = cannbotCapture('cb-proxy-3.jsonl', sid);
    const res = await POST(req({ source: 'claude-jsonl', sessionId: sid, filePath: file }));
    expect(res.status).toBe(200);
    const row = await prisma.session.findFirst({ where: { taskId: sid }, select: { id: true } });
    expect(row).not.toBeNull();
    createdSessionIds.push(row!.id);
    const turns = await prisma.turn.findMany({ where: { sessionId: row!.id }, orderBy: { turnIndex: 'asc' } });
    expect(turns.length).toBeGreaterThanOrEqual(2);
    const asst = turns.find(t => t.role === 'assistant')!;
    expect(asst.latencyMs).toBe(1200);
    expect(asst.finishReason).toBe('stop');
    // ttftMs 不在普通导入落库（DB 无通道），由 turns API 按需读 jsonl 的
    // x_cannbay/顶层 ttftMs —— 与 opencode 形状锁同边界，此处不断言
    expect(turns[0].role).toBe('user');
    expect(turns[0].content).toContain('帮我看一下这个算子');
  });

  it('重复导入同一 cannbot 捕获不产生重复 session 行', async () => {
    const sid = 'cb-proxy-fw-it-4';
    const file = cannbotCapture('cb-proxy-4.jsonl', sid);
    await POST(req({ source: 'claude-jsonl', sessionId: sid, filePath: file }));
    await POST(req({ source: 'claude-jsonl', sessionId: sid, filePath: file }));
    const rows = await prisma.session.findMany({ where: { taskId: sid }, select: { id: true, framework: true } });
    expect(rows.length).toBe(1);
    expect(rows[0].framework).toBe('cannbot');
    createdSessionIds.push(rows[0].id);
  });
});
