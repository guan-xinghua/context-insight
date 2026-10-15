// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details on how you could use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// opencode 原生工具参数键全链 IT（历史缺陷回归锁）：
//   read 旧版 `path` 键 → Files 分析整页不可见；skill 新版 `id` 键 → 技能名
//   回落工具名字面量 "skill"。
// 数据流：fixture jsonl（opencode 形态 claude 布局）→ import-file 路由 →
//   DB（SkillEvent 真名）→ file-reads API（Files 恢复）→ skill-content API
//   （内容恢复）→ 名字漂移自愈（模拟旧行 → 重导入 → 真名回填且不重复落行）。
import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import path from 'node:path';
import { prisma } from '../setup';
import { POST as importFilePOST } from '@/app/api/ingest/import-file/route';
import { GET as fileReadsGET } from '@/app/api/observe/session/file-reads/route';
import { GET as skillContentGET } from '@/app/api/observe/session/skill-content/route';

const sid = 'opencode-tool-keys-it';
const fixture = path.join(__dirname, './data/claude-sessions/opencode-tool-keys.jsonl');

function importReq(): NextRequest {
  return new NextRequest('http://localhost/api/ingest/import-file', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'claude-jsonl', sessionId: sid, filePath: fixture }),
  });
}

function getReq(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`);
}

afterEach(async () => {
  const rows = await prisma.session.findMany({ where: { taskId: sid } });
  for (const row of rows) {
    await prisma.session.delete({ where: { id: row.id } }).catch(() => { /* ignore */ });
  }
});

describe('opencode 工具参数键（read `path` / skill `id`）全链识别', () => {
  it('导入 → SkillEvent 落真名（非工具名字面量）', async () => {
    const res = await importFilePOST(importReq());
    expect(res.status).toBe(200);

    const events = await prisma.skillEvent.findMany({
      where: { turn: { session: { taskId: sid } } },
      select: { skillName: true, eventType: true },
    });
    expect(events.length).toBe(1);
    expect(events[0].skillName).toBe('ops-spec-gen'); // 旧缺陷：回落 "skill" 字面量
    expect(events[0].eventType).toBe('invoke');
  });

  it('file-reads API：`path` 键 read 进入 Files 分析', async () => {
    await importFilePOST(importReq());

    const res = await fileReadsGET(getReq(`/api/observe/session/file-reads?taskId=${sid}`));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.summary.totalFiles).toBeGreaterThanOrEqual(1);
    const paths: string[] = data.files.map((f: { path: string }) => f.path);
    expect(paths).toContain('/home/u/.opencode/skills/ops-spec-gen/SKILL.md'); // 旧缺陷：整页不可见
  });

  it('skill-content API：`id` 键 skill 工具按真名恢复内容', async () => {
    await importFilePOST(importReq());

    const res = await skillContentGET(
      getReq(`/api/observe/session/skill-content?taskId=${sid}&skillName=ops-spec-gen`)
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.source).toBe('skill-tool');
    expect(data.content).toContain('real skill body here');
  });

  it('名字漂移自愈：存量旧行重导入后采纳真名且不重复', async () => {
    await importFilePOST(importReq());

    // 模拟存量脏行：旧提取约定产出的字面量名字（真机 dev.db 中实际存在）
    await prisma.skillEvent.updateMany({
      where: { turn: { session: { taskId: sid } } },
      data: { skillName: 'skill' },
    });

    const res = await importFilePOST(importReq()); // 重导入 → merge 路径
    expect(res.status).toBe(200);

    const events = await prisma.skillEvent.findMany({
      where: { turn: { session: { taskId: sid } } },
      select: { skillName: true },
    });
    expect(events.length).toBe(1); // 不重复落行（旧缺陷：追加真名 + 残留旧行双份）
    expect(events[0].skillName).toBe('ops-spec-gen'); // 真名自愈
  });
});
