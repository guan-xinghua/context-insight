// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details on how to use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// opencode v2 (2.0.28) 结果负载归一 + shell 命令面全链 IT：现场回归锁。
// 历史缺陷（真机 2.0.18/2.0.28 会话实测）：
//   ① v2 结果 = 内容块数组被整体 stringify 落库 → read 行级解析 / 文件还原 /
//      skill 内容全链失效（包装率 v2.0.28 = 4373/4445，v1 = 0）
//   ② shell 隐式读（cat/sed）不采集 → Files 分析缺失（v2 shell:read ≈ 3:1）
//   ③ merge 路径纯增量合并 → 结果归一修复后存量会话重导入无法自愈
// 数据流：fixture v2 库（read/shell/skill 三工具：`path`/`command`/`id` 参数键 +
// 内容块数组结果 + <skill_content> 协议壳）→ importSession → DB
// （ToolCall.resultJson 解包、SkillEvent 真名）→ file-reads API（Files 恢复：
// read 显式 + shell 隐式）→ skill-content API（壳剥除）→ 结果漂移自愈
// （模拟存量 JSON 壳 → 重导入 → 解包且不重复落行）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { readSession } from '@/lib/ingest/adapters/opencode-db';
import { importSession } from '@/lib/ingest/data-service';
import { GET as fileReadsGET } from '@/app/api/observe/session/file-reads/route';
import { GET as skillContentGET } from '@/app/api/observe/session/skill-content/route';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-v2-cmd-it-'));
const DB = path.join(TMP, 'opencode.db');
const SID = 'ses_v2cmd001ffeV2SampleFff';
const READ_RESULT = 'Read file /home/demo/cmdproj/src/app.py, lines 1-4\n1: import os\n2: \n3: def main():\n4:     pass';

const prisma = new PrismaClient();
let prismaSessionId: string | null = null;

function getReq(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`);
}

beforeAll(() => {
  const sql = fs.readFileSync(path.resolve(__dirname, 'data/e2e/opencode-v2-commands-sample.sql'), 'utf-8');
  const db = new Database(DB);
  db.exec(sql);
  db.close();
});

afterAll(async () => {
  if (prismaSessionId) {
    await prisma.session.delete({ where: { id: prismaSessionId } }).catch(() => { /* ignore */ });
  }
  await prisma.$disconnect();
  fs.rmSync(TMP, { recursive: true, force: true });
});

async function ensureImported(): Promise<void> {
  if (prismaSessionId) return;
  await importSession(DB, SID, prisma, DB, 'opencode-db');
  const s = await prisma.session.findFirstOrThrow({ where: { taskId: SID } });
  prismaSessionId = s.id;
}

describe('opencode v2 结果负载归一 + shell 命令面（全链）', () => {
  it('readSession：内容块数组解包为文本（无 JSON 壳）', () => {
    const rows = readSession(DB, SID);
    const tcs = rows.flatMap(r => r.tool_calls ?? []);
    const read = tcs.find(t => t.toolCallId === 'call_r1')!;
    expect(read.resultJson).toBe(READ_RESULT);
    const shell = tcs.find(t => t.toolCallId === 'call_s1')!;
    expect(shell.resultJson).toBe('a-contents\nb-contents');
    const skill = tcs.find(t => t.toolCallId === 'call_k1')!;
    expect(skill.resultJson).toBe('<skill_content name="demo-v2-skill">\n# Demo V2 Skill\n\nSkill body line.\n</skill_content>');
  });

  it('导入：ToolCall.resultJson 落库即解包；SkillEvent 真名', async () => {
    await ensureImported();
    const tcs = await prisma.toolCall.findMany({ where: { turn: { session: { taskId: SID } } } });
    expect(tcs.length).toBe(3);
    const read = tcs.find(t => t.toolCallId === 'call_r1')!;
    expect(read.resultJson).not.toMatch(/^\[\{"type":"text"/); // 旧缺陷：JSON 壳
    expect(read.resultJson).toContain('1: import os');
    const events = await prisma.skillEvent.findMany({ where: { turn: { session: { taskId: SID } } } });
    expect(events.map(e => e.skillName)).toEqual(['demo-v2-skill']);
  });

  it('file-reads API：read 显式读 + shell 隐式读（cat 全文 / sed 范围）', async () => {
    await ensureImported();
    const res = await fileReadsGET(getReq(`/api/observe/session/file-reads?taskId=${SID}`));
    expect(res.status).toBe(200);
    const data = await res.json();
    const paths: string[] = data.files.map((f: { path: string }) => f.path);
    expect(paths).toContain('/home/demo/cmdproj/src/app.py'); // read `path` 键（v2）
    expect(paths).toContain('/home/demo/cmdproj/a.txt'); // shell cat（旧缺陷：整页缺失）
    expect(paths).toContain('/home/demo/cmdproj/b.txt'); // shell sed
    const b = data.files.find((f: { path: string }) => f.path === '/home/demo/cmdproj/b.txt');
    expect(b.reads[0].range).toMatchObject({ start: 5, end: 9 }); // sed -n 5,9p
  });

  it('skill-content API：剥 <skill_content> 协议壳恢复正文', async () => {
    await ensureImported();
    const res = await skillContentGET(
      getReq(`/api/observe/session/skill-content?taskId=${SID}&skillName=demo-v2-skill`)
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.source).toBe('skill-tool');
    expect(data.content).toContain('# Demo V2 Skill');
    expect(data.content).not.toContain('<skill_content'); // 旧缺陷：壳残留
  });

  it('结果漂移自愈：存量 JSON 壳重导入后解包且不重复落行', async () => {
    await ensureImported();
    // 模拟存量脏行：旧适配器整体 stringify 的 JSON 壳（真机 dev.db 实际存在）
    const wrapped = JSON.stringify([{ type: 'text', text: 'Read file /home/demo/cmdproj/src/app.py, lines 1-4\n1: import os' }]);
    await prisma.toolCall.updateMany({
      where: { toolCallId: 'call_r1', turn: { session: { taskId: SID } } },
      data: { resultJson: wrapped },
    });

    const again = await importSession(DB, SID, prisma, DB, 'opencode-db'); // merge 路径
    expect(again.imported).toBe(false);

    const tcs = await prisma.toolCall.findMany({ where: { turn: { session: { taskId: SID } } } });
    expect(tcs.length).toBe(3); // 不重复落行（旧缺陷：纯增量无法自愈）
    const read = tcs.find(t => t.toolCallId === 'call_r1')!;
    expect(read.resultJson).toBe(READ_RESULT); // 解包自愈（来源侧为权威）
  });
});

describe('湖原生导出（claude-jsonl 嵌套壳）结果归一（全链）', () => {
  // 湖物化的 v2 原生记录：claude 布局，tool_result.content 是**字符串**，
  // 值为 stringify 的内容块数组（真机 ecb 会话 276/276 全此形态）。
  // 历史缺陷：claude-jsonl 适配器字符串直通 → 壳原样落库，read 行级解析 /
  // 文件还原全链失效；merge 纯增量使重导入无法自愈。
  const SID2 = 'opencode-v2-lake-it';
  const FIXTURE = path.join(__dirname, 'data', 'claude-sessions', 'opencode-v2-lake-native.jsonl');
  const READ_TEXT = 'Read file /home/demo/lake/src/app.py, lines 1-3\n1: import os\n2: \n3: def main():';

  it('导入：嵌套壳剥出文本；file-reads 双路（read 显式 + shell 隐式）命中', async () => {
    const r = await importSession(FIXTURE, SID2, prisma, FIXTURE, 'claude-jsonl');
    expect(r.imported).toBe(true);
    const s = await prisma.session.findFirstOrThrow({ where: { taskId: SID2 } });
    prismaSessionId = s.id;

    const tcs = await prisma.toolCall.findMany({ where: { turn: { session: { taskId: SID2 } } } });
    expect(tcs.length).toBe(2);
    const read = tcs.find(t => t.toolCallId === 'toolu_v2lake_read')!;
    expect(read.resultJson).toBe(READ_TEXT); // 嵌套壳剥出（旧缺陷：壳原样落库）
    const shell = tcs.find(t => t.toolCallId === 'toolu_v2lake_shell')!;
    expect(shell.resultJson).toBe('a-content\nb-content');

    const res = await fileReadsGET(getReq(`/api/observe/session/file-reads?taskId=${SID2}`));
    expect(res.status).toBe(200);
    const data = await res.json();
    const paths: string[] = data.files.map((f: { path: string }) => f.path);
    expect(paths).toContain('/home/demo/lake/src/app.py'); // read `path` 键
    expect(paths).toContain('/home/demo/lake/a.txt'); // shell cat
    expect(paths).toContain('/home/demo/lake/b.txt'); // shell sed
  });

  it('嵌套壳漂移自愈：存量壳重导入后剥出且不重复落行', async () => {
    const wrapped = JSON.stringify([{ type: 'text', text: 'Read file /home/demo/lake/src/app.py, lines 1-3\n1: import os' }]);
    await prisma.toolCall.updateMany({
      where: { toolCallId: 'toolu_v2lake_read', turn: { session: { taskId: SID2 } } },
      data: { resultJson: wrapped },
    });

    const again = await importSession(FIXTURE, SID2, prisma, FIXTURE, 'claude-jsonl'); // merge 路径
    expect(again.imported).toBe(false);

    const tcs = await prisma.toolCall.findMany({ where: { turn: { session: { taskId: SID2 } } } });
    expect(tcs.length).toBe(2); // 不重复落行
    const read = tcs.find(t => t.toolCallId === 'toolu_v2lake_read')!;
    expect(read.resultJson).toBe(READ_TEXT); // 剥壳自愈
  });
});
