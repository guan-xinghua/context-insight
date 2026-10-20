// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License).
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 定长截断 UTF-16 安全修复端到端：emoji 恰落在 200 码元截断边界时，
// 修复前 contentSummary 携带孤立代理（半个字符）→ Prisma createMany 报
// "unexpected end of hex escape" → 整会话导入失败；修复后截断退一码元，
// 全会话正常落库。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PrismaClient } from '@prisma/client';
import { importSession } from '../../src/lib/ingest/data-service';
import { readSession } from '../../src/lib/ingest/adapters/claude-jsonl';
import { splitIntoTurns } from '../../src/lib/ingest/turn-split';
import { truncateUtf16Safe } from '../../src/lib/shared/text-strip';

const prisma = new PrismaClient();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'utf16-trunc-'));
const SID = 'utf16-trunc-it';

// 'A'×197 + 😀 + 🎉×50：第 199 码元（0 基）恰是 🎉 的高位代理，
// substring(0, 200) 会把它切成两半
const EDGE_CONTENT = 'A'.repeat(197) + '😀' + '🎉'.repeat(50);

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xDC00 && n <= 0xDFFF)) return true;
    } else if (c >= 0xDC00 && c <= 0xDFFF) {
      const p = s.charCodeAt(i - 1);
      if (!(p >= 0xD800 && p <= 0xDBFF)) return true;
    }
  }
  return false;
}

const BASE = '2026-10-20T10:00:00.000Z';
const LINES = [
  { type: 'user', message: { role: 'user', content: '验证 emoji 截断边界导入' }, timestamp: BASE },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: EDGE_CONTENT }], model: 'm', usage: { input_tokens: 10, output_tokens: 5 } }, timestamp: '2026-10-20T10:00:01.000Z' },
];

beforeAll(async () => {
  const file = path.join(TMP, `${SID}.jsonl`);
  fs.writeFileSync(file, LINES.map(l => JSON.stringify(l)).join('\n') + '\n');
  await prisma.session.deleteMany({ where: { taskId: SID } });
  await importSession(file, SID, prisma, file, 'claude-jsonl');
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: SID } }).catch(() => {});
  await prisma.$disconnect();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('truncateUtf16Safe：纯函数', () => {
  it('切点落在代理对中间 → 退一码元，绝不产生孤立代理', () => {
    const out = truncateUtf16Safe(EDGE_CONTENT, 200);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(hasLoneSurrogate(out)).toBe(false);
    expect(out.endsWith('😀')).toBe(true); // 完整字符保留，🎉 整体舍去
  });

  it('窗口内全 BMP / 短串直通', () => {
    expect(truncateUtf16Safe('短文本', 200)).toBe('短文本');
    expect(truncateUtf16Safe('x'.repeat(250), 200)).toHaveLength(200);
    expect(hasLoneSurrogate(truncateUtf16Safe('😀'.repeat(150), 200))).toBe(false);
  });
});

describe('emoji 截断边界：管线与导入', () => {
  it('splitIntoTurns 的 contentSummary 无孤立代理', () => {
    const file = path.join(TMP, `${SID}.jsonl`);
    const { turns } = splitIntoTurns(readSession(file, SID), SID);
    expect(turns.some(t => (t.contentSummary ?? '').includes('😀'))).toBe(true);
    for (const t of turns) expect(hasLoneSurrogate(t.contentSummary ?? '')).toBe(false);
  });

  it('importSession 整会话成功落库（修复前此处 500）', async () => {
    const session = await prisma.session.findFirst({ where: { taskId: SID } });
    expect(session).toBeTruthy();
    const turn = await prisma.turn.findFirst({ where: { sessionId: session!.id, role: 'assistant' } });
    expect(turn).toBeTruthy();
    expect(hasLoneSurrogate(turn!.contentSummary ?? '')).toBe(false);
  });
});
