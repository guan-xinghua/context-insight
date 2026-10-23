// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the License).
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 方案一 IT（同 sid 双会话共存）：先导 lake wire 捕获、再导同 sid 的 claude
// 原生会话文件——两者是同一场对话的两种记录（wire 回放 vs 本地逐条），在
// (taskId, framework) 唯一索引下以记录类区分各占一行、互不合并：
//   ① 原生 → 新行（claude-code）；捕获 → 另一新行（claude-code-proxy），两行共存
//   ② 捕获重导 → merge 进捕获行（不再误并原生行）；原生重导 → merge 进原生行
//   ③ 存量兼容：旧捕获行（framework 无 -proxy 后缀 + version 带 marker）按
//      version 标记归类匹配——重导捕获 merge 该行并矫正 framework，不建重复行
//   ④ 归一谓词：isClaudeFormatSession 放行 -proxy 变体；agentFrameworkOf 剥后缀
//   ⑤ 迁移分叉守护：误标行（framework=claude-code + version 带 opencode-proxy
//      marker）后缀化必须按 version 推导（→ opencode-proxy），按现值追加会得
//      claude-code-proxy 与导入匹配分叉 → 旧行残留永不合并

import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prisma } from '../setup';
import { POST } from '@/app/api/ingest/import-file/route';
import { isClaudeFormatSession, agentFrameworkOf } from '@/lib/shared/session-format';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'coexist-it-'));
const SID = 'coexist-it-sid';

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/ingest/import-file', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function writeFixture(name: string, lines: unknown[]): string {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n'));
  return p;
}

// 原生 claude 会话文件：无 source 标记、无 x_lake / system / tools wire 字段
const NATIVE_FILE = writeFixture('native.jsonl', [
  { type: 'user', message: { role: 'user', content: 'native-command-q' } },
  { type: 'assistant', message: { role: 'assistant', content: 'native-a1' } },
  { type: 'user', message: { role: 'user', content: 'native-q2' } },
]);

// cpx wire 捕获：行级 source 标记 + x_lake wire 证据（分类器规则 2）；
// x_lake 用未知 schema 只当分类证据，不进 adapter 的声明式分发
const CAPTURE_FILE = writeFixture('capture.jsonl', [
  { type: 'user', message: { role: 'user', content: 'wire-q1' }, source: 'claude-proxy', x_lake: { schema: 'it-wire-evidence', version: 1, data: {} } },
  { type: 'assistant', message: { role: 'assistant', content: 'wire-a1' }, source: 'claude-proxy', x_lake: { schema: 'it-wire-evidence', version: 1, data: {} } },
]);

// opencode 代理捕获（分叉守护用）：marker → 记录类 opencode-proxy
const OPENCODE_CAPTURE_FILE = writeFixture('capture-opencode.jsonl', [
  { type: 'user', message: { role: 'user', content: 'oc-wire-q1' }, source: 'opencode-proxy', x_lake: { schema: 'it-wire-evidence', version: 1, data: {} } },
  { type: 'assistant', message: { role: 'assistant', content: 'oc-wire-a1' }, source: 'opencode-proxy', x_lake: { schema: 'it-wire-evidence', version: 1, data: {} } },
]);

async function rows() {
  return prisma.session.findMany({ where: { taskId: SID }, orderBy: { createdAt: 'asc' } });
}

afterEach(async () => {
  await prisma.session.deleteMany({ where: { taskId: SID } }).catch(() => {});
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('同 sid 双会话共存（方案一）', () => {
  it('① 原生与捕获各建一行：framework 记录类区分，轮次各自独立', async () => {
    const r1 = await POST(req({ source: 'claude-jsonl', sessionId: SID, filePath: NATIVE_FILE }));
    const d1 = await r1.json();
    expect(d1.imported).toBe(true);
    expect(d1.framework).toBe('claude-code');

    const r2 = await POST(req({ source: 'claude-jsonl', sessionId: SID, filePath: CAPTURE_FILE }));
    const d2 = await r2.json();
    expect(d2.imported).toBe(true); // 异类 → 新建，不再「已存在」
    expect(d2.framework).toBe('claude-code-proxy');

    const rs = await rows();
    expect(rs.length).toBe(2);
    const native = rs.find(r => r.framework === 'claude-code')!;
    const capture = rs.find(r => r.framework === 'claude-code-proxy')!;
    expect(native).toBeTruthy();
    expect(capture).toBeTruthy();
    expect(capture.version).toContain('claude-proxy');

    // 轮次各自独立：原生行 3 轮，捕获行 2 轮
    expect(await prisma.turn.count({ where: { sessionId: native.id } })).toBe(3);
    expect(await prisma.turn.count({ where: { sessionId: capture.id } })).toBe(2);
  });

  it('② 重导走同类 merge：捕获并入捕获行、原生并入原生行，行数不膨胀', async () => {
    await POST(req({ source: 'claude-jsonl', sessionId: SID, filePath: NATIVE_FILE }));
    await POST(req({ source: 'claude-jsonl', sessionId: SID, filePath: CAPTURE_FILE }));

    const rCap = await POST(req({ source: 'claude-jsonl', sessionId: SID, filePath: CAPTURE_FILE }));
    const dCap = await rCap.json();
    expect(dCap.imported).toBe(false);
    expect(dCap.reason).toBe('already-exists');
    expect(dCap.framework).toBe('claude-code-proxy');

    const rNat = await POST(req({ source: 'claude-jsonl', sessionId: SID, filePath: NATIVE_FILE }));
    const dNat = await rNat.json();
    expect(dNat.imported).toBe(false);
    expect(dNat.reason).toBe('already-exists');
    expect(dNat.framework).toBe('claude-code');

    expect((await rows()).length).toBe(2);
    const rs = await rows();
    const native = rs.find(r => r.framework === 'claude-code')!;
    const capture = rs.find(r => r.framework === 'claude-code-proxy')!;
    expect(await prisma.turn.count({ where: { sessionId: native.id } })).toBe(3);
    expect(await prisma.turn.count({ where: { sessionId: capture.id } })).toBe(2);
  });

  it('③ 存量兼容：旧捕获行（framework 无后缀 + version 带 marker）按标记归类，重导 merge 不建重复行', async () => {
    // 构造迁移前的旧行形态：framework=claude-code、version 带 -claude-proxy marker
    await prisma.session.create({
      data: {
        taskId: SID, framework: 'claude-code', version: '2.1.100-claude-proxy',
        label: 'legacy capture row', startTime: new Date(0),
      },
    });

    const r = await POST(req({ source: 'claude-jsonl', sessionId: SID, filePath: CAPTURE_FILE }));
    const d = await r.json();
    expect(d.imported).toBe(false); // 按记录类命中旧行 → merge
    expect(d.reason).toBe('already-exists');
    expect(d.framework).toBe('claude-code-proxy'); // merge 回填矫正 framework

    const rs = await rows();
    expect(rs.length).toBe(1); // 不建重复行
    expect(rs[0].framework).toBe('claude-code-proxy');
    expect(rs[0].version).toContain('claude-proxy');
  });

  it('④ 归一谓词：isClaudeFormatSession 放行 -proxy 变体；agentFrameworkOf 剥后缀', () => {
    expect(isClaudeFormatSession('claude-code-proxy', null)).toBe(true);
    expect(isClaudeFormatSession('claude-code', null)).toBe(true);
    expect(isClaudeFormatSession('opencode-proxy', null)).toBe(false);
    expect(isClaudeFormatSession('opencode-proxy', '1.0-opencode-proxy')).toBe(true);
    expect(agentFrameworkOf('claude-code-proxy')).toBe('claude-code');
    expect(agentFrameworkOf('opencode-proxy')).toBe('opencode');
    expect(agentFrameworkOf('opencode')).toBe('opencode');
    expect(agentFrameworkOf(null)).toBeNull();
  });

  it('⑤ 迁移分叉守护：误标行后缀化按 version 推导，重导 merge 不残留', async () => {
    // 迁移前的误标遗留形态：framework=claude-code（误标史）+ version 带
    // opencode-proxy marker——按现值追加得 claude-code-proxy，与导入匹配
    // （按 version 推导 opencode-proxy）分叉，旧行残留永不合并
    await prisma.session.create({
      data: {
        taskId: SID, framework: 'claude-code', version: '1.2.3-opencode-proxy',
        label: 'mislabeled legacy row', startTime: new Date(0),
      },
    });

    // 直接执行本仓迁移 SQL（锁产物本身；WHERE 追加本用例 taskId 限定，避免
    // 全库 UPDATE 波及并行测试文件的行——SET/CASE 推导逻辑保持原样）
    const migSql = fs.readFileSync(
      path.resolve(__dirname, '../../prisma/migrations/20260916000001_proxy_framework_split/migration.sql'),
      'utf8',
    ).split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n').replace(/;\s*$/, '');
    await prisma.$executeRawUnsafe(`${migSql} AND "taskId" = '${SID}'`);

    // 后缀化按 version 推导：opencode-proxy（旧实现会得到 claude-code-proxy）
    const afterMig = (await rows())[0];
    expect(afterMig.framework).toBe('opencode-proxy');

    // 收敛：重导 opencode-proxy 捕获按记录类命中该行（不再分叉建新行）
    const r = await POST(req({ source: 'claude-jsonl', sessionId: SID, filePath: OPENCODE_CAPTURE_FILE }));
    const d = await r.json();
    expect(d.imported).toBe(false);
    expect(d.reason).toBe('already-exists');
    expect(d.framework).toBe('opencode-proxy');

    const rs = await rows();
    expect(rs.length).toBe(1); // 无 claude-code-proxy 残留行
    expect(rs[0].framework).toBe('opencode-proxy');
  });
});
