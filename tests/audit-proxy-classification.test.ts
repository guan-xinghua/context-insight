// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// audit-proxy-classification IT：子进程跑真实脚本（npx tsx，与文档用法等价），
// 验证期望 framework 直接取自统一分类器 proxy-classify —— codex/cannbot 会话
// （version 形如 <ver>-codex-proxy / <ver>-cannbot-proxy）不再被整体误报 BAD
// （历史缺陷：脚本内另建 marker→framework 三元映射漏了 codex/cannbot，落 null
// 分支后所有 codex 会话恒 BAD 且 --fix 空转）；同时对真实错分仍能检出。
// 只跑审计模式（只读，不动 dev.db 其他行）。
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { importSession } from '../src/lib/ingest/data-service.ts';

const REPO_ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-proxy-it-'));
const prisma = new PrismaClient();

const SID_CODEX = 'audit-codex-0001';
const SID_CANNBOT = 'audit-cannbot-0001';

function writeCaptureFixture(sid: string, marker: string): string {
  // 目录名带 /proxy/ ——审计脚本的 sourcePath contains '/proxy/' 过滤前提
  const file = path.join(TMP, 'proxy', `${sid}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: `${marker} audit IT` }, timestamp: '2026-08-27T10:00:00.000Z', source: marker }),
    JSON.stringify({
      type: 'assistant',
      message: { id: `m_${sid}`, role: 'assistant', content: [{ type: 'text', text: 'ok' }], model: 'test-model', usage: { input_tokens: 5, output_tokens: 1 } },
      timestamp: '2026-08-27T10:00:03.000Z',
      source: marker,
      // wire 证据（system/tools）：行级 source 标记分类的交叉校验前提
      system: 'You are a coding agent', tools: [{ name: 'shell' }],
    }),
  ].join('\n') + '\n');
  return file;
}

function runAudit(): string {
  return execSync('npx tsx scripts/audit-proxy-classification.mts', {
    cwd: REPO_ROOT,
    stdio: 'pipe',
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  }).toString();
}

afterAll(async () => {
  for (const sid of [SID_CODEX, SID_CANNBOT]) {
    try { await prisma.session.deleteMany({ where: { taskId: sid } }); } catch { /* ignore */ }
  }
  await prisma.$disconnect();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('audit-proxy-classification：期望 framework 取自统一分类器（无重复映射）', () => {
  it('codex / cannbot 捕获会话导入后分类正确，审计不误报 BAD', { timeout: 60_000 }, async () => {
    const codexFile = writeCaptureFixture(SID_CODEX, 'codex-proxy');
    const cannbotFile = writeCaptureFixture(SID_CANNBOT, 'cannbot-proxy');
    await importSession(codexFile, SID_CODEX, prisma, codexFile, 'claude-jsonl');
    await importSession(cannbotFile, SID_CANNBOT, prisma, cannbotFile, 'claude-jsonl');

    // 前置：导入管线自身分类正确（framework + -proxy 版本后缀）
    const codex = await prisma.session.findFirst({ where: { taskId: SID_CODEX } });
    expect(codex?.framework).toBe('codex');
    expect(codex?.version?.endsWith('-proxy')).toBe(true);
    const cannbot = await prisma.session.findFirst({ where: { taskId: SID_CANNBOT } });
    expect(cannbot?.framework).toBe('cannbot');
    expect(cannbot?.version?.endsWith('-proxy')).toBe(true);

    // 审计：两类会话都不出现在 BAD 列表（历史缺陷：codex 恒 BAD）
    const out = runAudit();
    expect(out).not.toContain(`BAD ${SID_CODEX}`);
    expect(out).not.toContain(`BAD ${SID_CANNBOT}`);
    expect(out).toMatch(/total=\d+ bad=\d+/);
  });

  it('真实错分（codex 会话 framework 被改成 claude-code）仍被检出 BAD', { timeout: 60_000 }, async () => {
    const s = await prisma.session.findFirst({ where: { taskId: SID_CODEX } });
    expect(s).toBeDefined();
    await prisma.session.update({ where: { id: s!.id }, data: { framework: 'claude-code' } });

    const out = runAudit();
    expect(out).toContain(`BAD ${SID_CODEX}`);
    expect(out).toContain('marker=codex-proxy');
    // cannbot 未被污染，仍不误报
    expect(out).not.toContain(`BAD ${SID_CANNBOT}`);
    // 收尾还原（复用导入分类），避免污染后续用例
    await prisma.session.update({ where: { id: s!.id }, data: { framework: 'codex' } });
  });
});
