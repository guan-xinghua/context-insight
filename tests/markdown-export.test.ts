// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Markdown 导出格式锁（IT）：fixture JSONL 走真实导入管线 → 导出 → 断言
// 标题/编号规则/元数据行/§N 轮次标题/正文渲染。数据驱动，任何环境必跑
//（旧版依赖本机 dev.db 恰好有会话，干净环境永远 skipIf 跳过——且其断言
//  `# Session:` / `Root Agent` / `**User**:` 与现行导出格式不符，从未生效过）。

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PrismaClient } from '@prisma/client';
import { exportSessionToMarkdown } from '../src/lib/export/markdown-exporter';
import { importSession } from '../src/lib/ingest/data-service';

const prisma = new PrismaClient();
const SID = 'markdown-export-it';

interface Line { type: string; message: Record<string, unknown>; timestamp: string; [k: string]: unknown }

const BASE = '2026-08-30T10:00:00.000Z';
let ts = 0;
const stamp = () => new Date(new Date(BASE).getTime() + ts++ * 1000).toISOString();

const FIXTURE_LINES: Line[] = [
  { type: 'user', message: { role: 'user', content: '帮我把 alpha 改成 2' }, timestamp: stamp() },
  {
    type: 'assistant',
    message: {
      id: 'msg_a1', role: 'assistant',
      content: [{ type: 'text', text: '已把 alpha 改成 2 并跑过测试。' }],
      model: 'test-model',
      usage: { input_tokens: 100, output_tokens: 20 },
    },
    timestamp: stamp(),
  },
];

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'md-export-it-'));
const FIXTURE = path.join(TMP, `${SID}.jsonl`);
fs.writeFileSync(FIXTURE, FIXTURE_LINES.map(l => JSON.stringify(l)).join('\n') + '\n');

afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: SID } }).catch(() => {});
  await prisma.$disconnect();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('markdown-export（fixture 驱动，不依赖本机数据）', () => {
  it('导入 fixture 并导出：标题（首条用户消息）+ 编号规则块', async () => {
    await prisma.session.deleteMany({ where: { taskId: SID } });
    await importSession(FIXTURE, SID, prisma, FIXTURE, 'claude-jsonl');
    const md = await exportSessionToMarkdown(SID, prisma);
    expect(md).toBeTruthy();
    expect(md.startsWith('# ')).toBe(true);
    expect(md).toContain('帮我把 alpha 改成 2');
    expect(md).toContain('> **编号规则**');
    expect(md).toContain('§1, §2, §3… → 主 Agent 每个 turn');
  });

  it('元数据行：Session/Framework/Model 与 Duration/Tokens/Cost', async () => {
    const md = await exportSessionToMarkdown(SID, prisma);
    expect(md).toContain(`**Session:** ${SID}`);
    expect(md).toContain('**Framework:**');
    expect(md).toContain('**Model:**');
    expect(md).toContain('**Duration:**');
    expect(md).toContain('**Tokens:**');
    expect(md).toContain('**Cost:**');
  });

  it('轮次渲染：§N User 与 §N Assistant 标题 + 正文', async () => {
    const md = await exportSessionToMarkdown(SID, prisma);
    expect(md).toMatch(/## §\d+ User/);
    expect(md).toMatch(/## §\d+ Assistant/);
    expect(md).toContain('已把 alpha 改成 2 并跑过测试。');
  });

  it('导出幂等：两次导出逐字节一致', async () => {
    const first = await exportSessionToMarkdown(SID, prisma);
    const second = await exportSessionToMarkdown(SID, prisma);
    expect(second).toBe(first);
  });
});
