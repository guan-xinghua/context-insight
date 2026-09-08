// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// P1 IT：.jsonl.gz（gzip at rest，cpx 压缩捕获形态）导入全链路放行。
// 历史卡点四处：browse-directory extname 判定 / UI 单文件快速通道 /
// adapter 目录扫描 / import-file existsSync 预检——本文件从 API 与 adapter
// 层逐点验证，并锁定 verbatim 布局（cpx- 前缀 + <sid>/subagents/）直读导入
// 的 taskId 语义（前缀剥掉，与 cpx 退出自动导入落同一 taskId）。

import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { prisma } from './setup';
import { POST as importFilePOST } from '@/app/api/ingest/import-file/route';
import { POST as browseDirPOST } from '@/app/api/ingest/browse-directory/route';
import { listSessions, readSession } from '@/lib/ingest/adapters/claude-jsonl';

// ── fixture：proxy 捕获目录布局（verbatim 形态，gzip at rest）──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'import-gz-it-'));
const SID = 'ses_gzit0001ffeetestAA';
const SUB_ID = 'sub-gz-it-aaa';
const MAIN_GZ = path.join(TMP, `cpx-${SID}.jsonl.gz`);

const mainLines = [
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: '帮我压测 .jsonl.gz 导入' },
    timestamp: '2026-09-03T03:00:00.000Z',
  }),
  JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg_gz_1',
      role: 'assistant',
      content: [
        { type: 'text', text: '开始处理' },
        { type: 'tool_use', id: 'toolu_gz_1', name: 'Task', input: { description: 'researcher', subagent_type: 'general-purpose', prompt: 'gz fixture research' } },
      ],
      model: 'test-model',
      usage: { input_tokens: 100, output_tokens: 20 },
    },
    timestamp: '2026-09-03T03:00:05.000Z',
  }),
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_gz_1', content: 'dispatched' }] },
    timestamp: '2026-09-03T03:00:06.000Z',
  }),
  JSON.stringify({
    type: 'assistant',
    message: { id: 'msg_gz_2', role: 'assistant', content: [{ type: 'text', text: '完成' }], model: 'test-model', usage: { input_tokens: 120, output_tokens: 8 } },
    timestamp: '2026-09-03T03:00:10.000Z',
  }),
].join('\n') + '\n';

fs.writeFileSync(MAIN_GZ, zlib.gzipSync(Buffer.from(mainLines, 'utf8')));
fs.mkdirSync(path.join(TMP, SID, 'subagents'), { recursive: true });
fs.writeFileSync(
  path.join(TMP, SID, 'subagents', `${SUB_ID}.jsonl`),
  [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'gz fixture research' }, timestamp: '2026-09-03T03:00:07.000Z' }),
    JSON.stringify({ type: 'assistant', message: { id: 'msg_gz_sub_1', role: 'assistant', content: [{ type: 'text', text: 'found it' }], model: 'test-model', usage: { input_tokens: 50, output_tokens: 5 } }, timestamp: '2026-09-03T03:00:09.000Z' }),
  ].join('\n') + '\n',
);
fs.writeFileSync(
  path.join(TMP, SID, 'subagents', `${SUB_ID}.meta.json`),
  JSON.stringify({ toolUseId: 'toolu_gz_1', name: 'researcher', agentType: 'general-purpose' }),
);
// 明文 native 回归件 + 杂散文件（browse 判定负样本）
fs.writeFileSync(path.join(TMP, 'plain-native.jsonl'), mainLines);
fs.writeFileSync(path.join(TMP, 'stray-note.txt'), 'not importable');

function req(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const TASK_IDS = [SID, 'plain-native'];

afterEach(async () => {
  for (const taskId of TASK_IDS) {
    const s = await prisma.session.findFirst({ where: { taskId } });
    if (s) {
      await prisma.session.delete({ where: { id: s.id } }).catch(() => {});
    }
  }
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('import .jsonl.gz 放行：API → adapter → DB 全链路', () => {
  it('import-file API：verbatim cpx-<sid>.jsonl.gz 直读导入，taskId 剥前缀，sourcePath 定型 .gz，子代理并库', async () => {
    const res = await importFilePOST(req('http://localhost/api/ingest/import-file', {
      source: 'claude-jsonl',
      sessionId: SID,
      filePath: MAIN_GZ,
    }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.imported).toBe(true);
    expect(data.reason).toBe('imported');

    const s = await prisma.session.findFirst({ where: { taskId: SID }, include: { turns: true } });
    expect(s).not.toBeNull();
    // sourcePath 稳定指向压缩态文件（wireRounds/fullContext 按需重读的入口）
    expect(s!.sourcePath).toBe(MAIN_GZ);
    // 主会话 turns 落库（user + assistant）
    const mainTurns = s!.turns.filter(t => !t.isSubagent && t.role === 'assistant');
    expect(mainTurns.length).toBeGreaterThan(0);
    // 子代理并库：verbatim 布局 <sid>/subagents/ 被发现（sessionId 无前缀直中）
    const subTurns = s!.turns.filter(t => t.isSubagent);
    expect(subTurns.length).toBeGreaterThan(0);
    expect(subTurns.every(t => t.subagentSessionId === SUB_ID)).toBe(true);
  });

  it('import-file API 预检双形态：手输 x.jsonl 而盘上只有 x.jsonl.gz → 不被 404 拦截', async () => {
    const res = await importFilePOST(req('http://localhost/api/ingest/import-file', {
      source: 'claude-jsonl',
      sessionId: SID,
      // 明文路径（不存在），盘上是对应 .gz —— 预检放行 + adapter 双向互找
      filePath: MAIN_GZ.replace(/\.gz$/, ''),
    }));
    expect(res.status).not.toBe(404);
    const data = await res.json();
    expect(data.imported).toBe(true);
    const s = await prisma.session.findFirst({ where: { taskId: SID } });
    expect(s).not.toBeNull();
  });

  it('browse-directory API：.jsonl.gz 判为可导入（claude-jsonl），.txt 不可导入，明文 .jsonl 回归不变', async () => {
    const res = await browseDirPOST(req('http://localhost/api/ingest/browse-directory', { dirPath: TMP }));
    expect(res.status).toBe(200);
    const data = await res.json();
    const byName = new Map<string, { isImportableFile: boolean; importableType: string | null }>(
      (data.entries as Array<{ name: string; isImportableFile: boolean; importableType: string | null }>).map(e => [e.name, e]),
    );
    expect(byName.get(`cpx-${SID}.jsonl.gz`)!.isImportableFile).toBe(true);
    expect(byName.get(`cpx-${SID}.jsonl.gz`)!.importableType).toBe('claude-jsonl');
    expect(byName.get('plain-native.jsonl')!.isImportableFile).toBe(true);
    expect(byName.get('stray-note.txt')!.isImportableFile).toBe(false);
  });

  it('adapter listSessions 目录扫描：收 .jsonl.gz，id 剥 .gz 后缀与 cpx- 前缀（与自动导入同 taskId）', () => {
    const sessions = listSessions(TMP);
    const ids = sessions.map(s => s.id);
    expect(ids).toContain(SID);          // cpx-<SID>.jsonl.gz → <SID>
    expect(ids).toContain('plain-native'); // 明文回归
    expect(ids).not.toContain(`cpx-${SID}`); // 前缀身份不再产生（防同会话双身份入库）
    const gzEntry = sessions.find(s => s.id === SID)!;
    expect(gzEntry.turnCount).toBe(4);   // gzip 透明解压后逐行可解析
  });

  it('adapter readSession 双形态：filePath 指向明文（盘上仅 .gz）仍可解析出 interactions', () => {
    const raw = readSession(MAIN_GZ.replace(/\.gz$/, ''), SID);
    expect(raw.length).toBeGreaterThan(0);
  });
});
