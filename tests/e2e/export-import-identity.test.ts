// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// DB 导出→再导入的会话身份保持 IT（身份归会话、格式归文件）。
// 客户路径：会话列表「导出」→ cannbot_session_<taskId>.db → 别处导入。
// 修复前：导入链只认容器格式（srcType=cannbot-insight），源级 framework
// 兜底把容器身份冒充 agent 身份落库（framework='cannbot-insight'、version
// null），且记录类不命中既有行 → 同实例重导入产生重复行；导出件无格式头。
// 修复后：身份从导出件 Session 行的会话级声明读取（readSessionMeta 能力）
// 原样透传（含 -proxy 记录类后缀），重导入幂等 merge；导出件带 ExportMeta
// 格式头；deltaRefresh 按 sourcePath 文件事实路由适配器。

import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exportSession } from '../../src/lib/ingest/export-service.ts';
import { importSession, deltaRefreshSession } from '../../src/lib/ingest/data-service.ts';
import { listSessions, detectContent } from '../../src/lib/ingest/adapters/cannbot-insight.ts';

const prisma = new PrismaClient();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-identity-'));

const SEED_TURNS = [
  { turnIndex: 0, role: 'user', content: 'how to fuse matmul on npu' },
  { turnIndex: 1, role: 'assistant', content: 'use torch_npu.matmul then check the fuse pass report' },
];

async function seedSession(taskId: string, framework: string, version: string | null) {
  const session = await prisma.session.create({
    data: {
      taskId,
      label: `label of ${taskId}`,
      query: `query of ${taskId}`,
      framework,
      version,
      startTime: new Date('2026-10-01T10:00:00.000Z'),
      endTime: new Date('2026-10-01T10:30:00.000Z'),
      sourcePath: '/tmp/seed-source',
    },
  });
  await prisma.turn.createMany({
    data: SEED_TURNS.map(t => ({ ...t, sessionId: session.id })),
  });
}

function artifactPath(taskId: string): string {
  return path.join(tmpDir, `cannbot_session_${taskId}.db`);
}

const TASK_IDS = ['it-expid-proxy', 'it-expid-native', 'it-expid-merge', 'it-expid-refresh'];

afterAll(async () => {
  for (const taskId of TASK_IDS) {
    await prisma.session.deleteMany({ where: { taskId } }).catch(() => { /* best-effort */ });
  }
  await prisma.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('E2E: DB 导出→再导入的会话身份保持', () => {
  it('proxy 记录类：framework/version 原样透传（含 -proxy 后缀）', async () => {
    const taskId = 'it-expid-proxy';
    await seedSession(taskId, 'claude-code-proxy', '2.1.278-proxy');
    const artifact = artifactPath(taskId);
    await exportSession(taskId, artifact, prisma);

    // 删原行 = 模拟「导入到另一实例」的新库路径
    await prisma.session.deleteMany({ where: { taskId } });
    const res = await importSession(artifact, taskId, prisma, artifact, 'cannbot-insight');
    expect(res.imported).toBe(true);

    const row = await prisma.session.findFirst({ where: { taskId } });
    expect(row?.framework).toBe('claude-code-proxy');
    expect(row?.version).toBe('2.1.278-proxy');
  });

  it('原生会话：framework/version 透传，label 作为会话级声明进 query', async () => {
    const taskId = 'it-expid-native';
    await seedSession(taskId, 'codex', '0.162.0');
    const artifact = artifactPath(taskId);
    await exportSession(taskId, artifact, prisma);

    await prisma.session.deleteMany({ where: { taskId } });
    await importSession(artifact, taskId, prisma, artifact, 'cannbot-insight');

    const row = await prisma.session.findFirst({ where: { taskId } });
    expect(row?.framework).toBe('codex');
    expect(row?.version).toBe('0.162.0');
    // 会话级声明（label→title）优先于从轮次重推的 query
    expect(row?.query).toBe(`label of ${taskId}`);
  });

  it('同实例重导入：记录类命中既有行，幂等合并不产生重复行', async () => {
    const taskId = 'it-expid-merge';
    await seedSession(taskId, 'codex', '0.162.0');
    const artifact = artifactPath(taskId);
    await exportSession(taskId, artifact, prisma);

    const res = await importSession(artifact, taskId, prisma, artifact, 'cannbot-insight');
    expect(res.imported).toBe(false);

    const rows = await prisma.session.findMany({ where: { taskId } });
    expect(rows.length).toBe(1);
    expect(rows[0].framework).toBe('codex');
    expect(rows[0].version).toBe('0.162.0');
  });

  it('导出件自描述：ExportMeta 格式头（producer/schemaVersion）', async () => {
    const db = new Database(artifactPath('it-expid-merge'), { readonly: true });
    try {
      const rows = db.prepare('SELECT key, value FROM "ExportMeta"').all() as { key: string; value: string }[];
      const byKey = new Map(rows.map(r => [r.key, r.value]));
      expect(byKey.get('producer')).toBe('insight-export');
      expect(byKey.get('schemaVersion')).toBe('1');
    } finally {
      db.close();
    }
  });

  it('存量旧件兼容：无 ExportMeta 的导出件仍按 Session 表识别', async () => {
    const legacy = path.join(tmpDir, 'legacy_no_meta.db');
    fs.copyFileSync(artifactPath('it-expid-merge'), legacy);
    const db = new Database(legacy);
    db.exec('DROP TABLE "ExportMeta"');
    db.close();
    expect(detectContent(legacy)).toBe(true);
  });

  it('导入预览：listSessions 返回会话级 framework', async () => {
    const listed = listSessions(artifactPath('it-expid-merge'));
    const entry = listed.find(s => s.id === 'it-expid-merge');
    expect(entry?.framework).toBe('codex');
  });

  it('deltaRefresh 按 sourcePath 文件事实路由：正确标记的重导入行可增量刷新', async () => {
    const taskId = 'it-expid-refresh';
    await seedSession(taskId, 'claude-code-proxy', '2.1.278-proxy');
    const artifact = artifactPath(taskId);
    await exportSession(taskId, artifact, prisma);
    await prisma.session.deleteMany({ where: { taskId } });
    await importSession(artifact, taskId, prisma, artifact, 'cannbot-insight');

    // 该行 framework='claude-code-proxy' 而 sourcePath 是 insight 导出 db：
    // 按 framework 反查会路由到 claude-jsonl 去解析 sqlite（读到 0 条 →
    // 静默无增量）；只有按文件事实路由才能回到 cannbot 适配器。删掉最后
    // 一轮模拟「导出件是权威、本地库缺一条」的增量场景
    const row = await prisma.session.findFirst({ where: { taskId } });
    const turns = row
      ? await prisma.turn.findMany({ where: { sessionId: row.id }, orderBy: { turnIndex: 'asc' } })
      : [];
    expect(turns.length).toBe(2);
    await prisma.turn.delete({ where: { id: turns[turns.length - 1].id } });

    const r = await deltaRefreshSession(taskId, prisma);
    expect(r.addedTurns).toBe(1);
  });
});
