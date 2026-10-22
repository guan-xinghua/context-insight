// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// bundle 导入端到端 IT（完整数据流：bundle 目录 → job 编排 → importSession
// 管线 → test.db 断言 → run-store 落盘断言）：
// - meta 的 insight-export framework 声明回原生行（opencode），无 meta 走
//   claude-jsonl 缺省（claude-code）
// - 未引用会话目录照样导入（用户决策 #2：导入即全量）
// - 重跑幂等（(taskId, framework) 唯一索引 → existing 计数）
// fixture：tests/ut/data/run/mini-bundle/（3 引用会话 + 1 未引用 + 回滚 + 子图）

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { parseManifest, buildIndex } from '@/lib/run/reader';
import {
  runImportJob,
  validateBundleDir,
  enumerateBundleSessions,
  orderSessionsByManifest,
  type ImportJobState,
} from '@/lib/run/import-service';
import { readRun } from '@/lib/run/run-store';
import { excludedSessionIds, deleteOwnedSessionRows } from '@/lib/run/session-scope';

const BUNDLE = path.resolve(__dirname, './data/run/mini-bundle');
const prisma = new PrismaClient();
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-run-import-'));
const MINI_SIDS = ['ses_mini_a', 'ses_mini_b', 'ses_mini_c', 'ses_mini_unref'];

// 结构校验权威：临时构造的 bundle 也要带 workflow.schema.json（与真实导出件同源）
const SCHEMA_TEXT = fs.readFileSync(path.resolve(__dirname, './data/run/workflow-bundle.v1.schema.json'), 'utf-8');

function writeBundleSchema(dir: string): void {
  fs.writeFileSync(path.join(dir, 'workflow.schema.json'), SCHEMA_TEXT, 'utf-8');
}

function freshState(runId: string, dirPath: string): ImportJobState {
  return {
    jobId: 'test-job',
    dirPath,
    runId,
    step: 'validate',
    total: 0,
    imported: 0,
    existing: 0,
    missingFile: 0,
    failed: 0,
    currentSid: null,
    error: null,
    warnings: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
}

afterAll(async () => {
  try {
    await prisma.session.deleteMany({ where: { taskId: { in: MINI_SIDS } } });
  } catch { /* ignore */ }
  await prisma.$disconnect();
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe('validateBundleDir：入口校验', () => {
  it('合法 mini-bundle：manifest 解析 + sessions 目录定位', () => {
    const v = validateBundleDir(BUNDLE);
    expect(v.ok).toBe(true);
    expect(v.manifest?.id).toBe('minidemo01');
    expect(v.manifestFile).toBe('workflow.json');
    expect(v.sessionsDir).toBe(path.join(BUNDLE, 'sessions'));
  });

  it('目录不存在 → 404；缺 workflow.json → 400', () => {
    expect(validateBundleDir('/nonexistent/bundle')).toMatchObject({ ok: false, status: 404 });
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-empty-bundle-'));
    try {
      expect(validateBundleDir(empty)).toMatchObject({ ok: false, status: 400, reason: 'bundle-manifest-missing' });
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('关系端点悬空 → 400（buildIndex 双闸，不进 job）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-bad-bundle-'));
    try {
      fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'workflow.json'),
        JSON.stringify({
          schema: 'cannbot.workflow-bundle', version: 1, id: 'badbundle', kind: 'workflow', name: 'bad',
          startedAt: null, finishedAt: null,
          data: {
            exportDataComplete: true,
            members: [{ id: 'M1', kind: 'process', name: 'x', startedAt: null, finishedAt: null }],
            relations: [{ from: 'M1', to: 'GHOST', annotation: { type: 'depends_on' } }],
          },
        }),
      );
      writeBundleSchema(dir);
      expect(validateBundleDir(dir)).toMatchObject({ ok: false, status: 400, reason: 'bundle-manifest-invalid' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('id 不能作为 run 目录名（含 / 或 ..）→ 400 入口拒绝，不进 job', () => {
    for (const badId of ['a/b', '../escape', 'x..y']) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-badid-bundle-'));
      try {
        fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'workflow.json'),
          JSON.stringify({
            schema: 'cannbot.workflow-bundle', version: 1, id: badId, kind: 'workflow', name: 'bad-id',
            startedAt: null, finishedAt: null,
            data: { exportDataComplete: true, members: [], relations: [] },
          }),
        );
        writeBundleSchema(dir);
        expect(validateBundleDir(dir)).toMatchObject({ ok: false, status: 400, reason: 'bundle-invalid-run-id' });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('manifest.json 别名同样被识别（与 browse 共用 MANIFEST_FILENAMES 双文件名）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-manifest-alias-'));
    try {
      fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'manifest.json'),
        JSON.stringify({
          schema: 'cannbot.workflow-bundle', version: 1, id: 'alias01', kind: 'workflow', name: 'alias',
          startedAt: null, finishedAt: null,
          data: { exportDataComplete: true, members: [], relations: [] },
        }),
      );
      writeBundleSchema(dir);
      const v = validateBundleDir(dir);
      expect(v.ok).toBe(true);
      expect(v.manifestFile).toBe('manifest.json');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('会话枚举与排序（lake 双记录布局）', () => {
  it('枚举 <sid>.native 目录并按 sid 定位 jsonl', () => {
    const entries = enumerateBundleSessions(path.join(BUNDLE, 'sessions'));
    expect(entries.map(e => e.sid).sort()).toEqual([...MINI_SIDS].sort());
    expect(entries.find(e => e.sid === 'ses_mini_a')!.jsonlPath).toBe(
      path.join(BUNDLE, 'sessions/ses_mini_a.native/ses_mini_a.jsonl'),
    );
  });

  it('manifest 引用优先 + 未引用殿后 + 包内缺失清单', () => {
    const entries = enumerateBundleSessions(path.join(BUNDLE, 'sessions'));
    const manifest = parseManifest(
      JSON.parse(fs.readFileSync(path.join(BUNDLE, 'workflow.json'), 'utf-8')),
    );
    // 造一个"manifest 引用但包内没有"的 sid：改内存对象后重建真实索引
    const ghostManifest = JSON.parse(JSON.stringify(manifest));
    (ghostManifest.data.members[0] as Record<string, unknown>).sessionId = 'ses_ghost';
    const { ordered, unreferenced, missingOnDisk } = orderSessionsByManifest(entries, buildIndex(ghostManifest));
    expect(ordered.map(e => e.sid)).toEqual(['ses_mini_a', 'ses_mini_b', 'ses_mini_c', 'ses_mini_unref']);
    expect(unreferenced.map(e => e.sid)).toEqual(['ses_mini_unref']);
    expect(missingOnDisk).toEqual(['ses_ghost']);
  });
});

describe('runImportJob：全量导入端到端（test.db）', () => {
  it('首轮：4 会话全导入，framework 按 meta 声明回原生行，import.json 汇总', async () => {
    const manifest = parseManifest(
      JSON.parse(fs.readFileSync(path.join(BUNDLE, 'workflow.json'), 'utf-8')),
    );
    const state = freshState(manifest.id, BUNDLE);
    await runImportJob(state, BUNDLE, manifest, { prisma, root: TMP_ROOT });

    expect(state.step).toBe('done');
    expect(state.total).toBe(4);
    expect(state.imported).toBe(4);
    expect(state.failed).toBe(0);
    // 未引用目录照样导入 → 警告透传
    expect(state.warnings.some(w => w.includes('ses_mini_unref'))).toBe(true);

    const rows = await prisma.session.findMany({
      where: { taskId: { in: MINI_SIDS } },
      select: { taskId: true, framework: true, turns: { select: { id: true } } },
    });
    expect(rows).toHaveLength(4);
    const fw = Object.fromEntries(rows.map(r => [r.taskId, r.framework]));
    // meta（insight-export）声明 opencode → 原生行；无 meta → claude-jsonl 缺省
    expect(fw.ses_mini_a).toBe('opencode');
    expect(fw.ses_mini_c).toBe('opencode');
    expect(fw.ses_mini_b).toBe('claude-code');
    expect(fw.ses_mini_unref).toBe('claude-code');
    // 管线完整走通：simple-session.jsonl 1 问 1 答至少 1 turn
    expect(rows.every(r => r.turns.length >= 1)).toBe(true);

    // run-store 落盘：manifest + import.json
    const stored = readRun(manifest.id, TMP_ROOT)!;
    expect(stored).not.toBeNull();
    expect(stored.meta?.data.sessions).toMatchObject({ total: 4, imported: 4, failed: 0 });
    expect(stored.index.relations).toHaveLength(7);
  });

  it('重跑：幂等（imported=0 / existing=4），meta 覆盖更新', async () => {
    const manifest = parseManifest(
      JSON.parse(fs.readFileSync(path.join(BUNDLE, 'workflow.json'), 'utf-8')),
    );
    const state = freshState(manifest.id, BUNDLE);
    await runImportJob(state, BUNDLE, manifest, { prisma, root: TMP_ROOT });

    expect(state.step).toBe('done');
    expect(state.imported).toBe(0);
    expect(state.existing).toBe(4);
    const rows = await prisma.session.findMany({ where: { taskId: { in: MINI_SIDS } } });
    expect(rows).toHaveLength(4); // 不重复入库
    const stored = readRun(manifest.id, TMP_ROOT)!;
    expect(stored.meta?.data.sessions).toMatchObject({ total: 4, imported: 0, existing: 4 });
  });

  it('会话目录存在但无 jsonl：missingFile 计数 + sid 收进 warnings（可定位缺正文会话）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-missingfile-bundle-'));
    try {
      fs.mkdirSync(path.join(dir, 'sessions', 'ses_empty.native'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'workflow.json'),
        JSON.stringify({
          schema: 'cannbot.workflow-bundle', version: 1, id: 'missingfile01', kind: 'workflow', name: 'missing-file',
          data: {
            exportDataComplete: false,
            members: [
              {
                id: 'S_EMPTY', kind: 'session', name: '空目录会话',
                startedAt: null, finishedAt: null,
                sessionId: 'ses_empty', location: 'sessions/ses_empty.native',
                annotation: { graph: { role: 'execute', nodeId: 'n', generation: 0, attempt: 1 } },
              },
            ],
            relations: [],
          },
        }),
      );
      const manifest = parseManifest(
        JSON.parse(fs.readFileSync(path.join(dir, 'workflow.json'), 'utf-8')),
      );
      const state = freshState(manifest.id, dir);
      await runImportJob(state, dir, manifest, { prisma, root: TMP_ROOT });

      expect(state.step).toBe('done');
      expect(state.total).toBe(1);
      expect(state.missingFile).toBe(1);
      expect(state.imported).toBe(0);
      expect(state.failed).toBe(0);
      // 缺正文的 sid 必须可定位（对照 missingOnDisk 的 warning 行为）
      expect(state.warnings.some(w => w.includes('ses_empty') && w.includes('无 jsonl'))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('owned 收编路径边界（sessions/ 前缀隔离，防误收编数据丢失）', () => {
  const BOUNDARY_SID = 'ses_boundary_a';
  const BOUNDARY_JSONL = [
    '{"type":"user","message":{"role":"user","content":"What is 2+2?"}}',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"2+2 equals 4."}],"model":"claude-haiku-3-20250415","usage":{"input_tokens":10,"output_tokens":5}},"duration_ms":1000}',
    '{"type":"result","subtype":"success","result":"4","cost_usd":0.001,"duration_ms":2000}',
  ].join('\n');

  it('sessions-export/ 同 sid 前缀目录不得收编为 owned（旧 startsWith 前缀匹配会误收）', async () => {
    const bundle = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-boundary-bundle-'));
    const sessionDir = path.join(bundle, 'sessions', `${BOUNDARY_SID}.native`);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, `${BOUNDARY_SID}.jsonl`), BOUNDARY_JSONL);
    // sessions/ 旁的同名前缀目录：其内同 sid 会话与包内成员同 sid，但路径在包外
    fs.mkdirSync(path.join(bundle, 'sessions-export'), { recursive: true });
    fs.writeFileSync(
      path.join(bundle, 'workflow.json'),
      JSON.stringify({
        schema: 'cannbot.workflow-bundle', version: 1, id: 'boundary01', kind: 'workflow', name: 'boundary',
        data: {
          exportDataComplete: false,
          members: [
            {
              id: 'S_BOUNDARY', kind: 'session', name: '边界会话',
              startedAt: null, finishedAt: null,
              sessionId: BOUNDARY_SID, location: `sessions/${BOUNDARY_SID}.native`,
              annotation: { graph: { role: 'execute', nodeId: 'n', generation: 0, attempt: 1 } },
            },
          ],
          relations: [],
        },
      }),
    );
    // 用户自有行：同 sid，framework 独立，sourcePath 落在 sessions-export/ 前缀目录
    const own = await prisma.session.create({
      data: {
        taskId: BOUNDARY_SID,
        framework: 'custom-fw',
        sourcePath: path.join(bundle, 'sessions-export', `${BOUNDARY_SID}.jsonl`),
      },
    });
    try {
      const manifest = parseManifest(
        JSON.parse(fs.readFileSync(path.join(bundle, 'workflow.json'), 'utf-8')),
      );
      const root = path.join(TMP_ROOT, 'boundary');
      const state = freshState(manifest.id, bundle);
      await runImportJob(state, bundle, manifest, { prisma, root });

      const owned = readRun(manifest.id, root)?.meta?.data.ownedSessions ?? [];
      // 包内 run 行进 owned（无 meta 声明 → claude-jsonl 缺省 framework）
      expect(owned.some(o => o.sid === BOUNDARY_SID && o.framework === 'claude-code')).toBe(true);
      // sessions-export/ 前缀目录的用户自有行不得收编（数据丢失防线）
      expect(owned.some(o => o.sid === BOUNDARY_SID && o.framework === 'custom-fw')).toBe(false);
    } finally {
      await prisma.session.delete({ where: { id: own.id } }).catch(() => {});
      await prisma.session.deleteMany({ where: { taskId: BOUNDARY_SID } }).catch(() => {});
      fs.rmSync(bundle, { recursive: true, force: true });
    }
  });
});

describe('Sessions 域隔离（ownedSessions sidecar，用户决策：run 会话不进 Sessions 视图）', () => {
  it('sidecar 登记 4 个 owned 行（(taskId, framework) 精确对），重导入覆盖写不丢失', () => {
    const stored = readRun('minidemo01', TMP_ROOT)!;
    const owned = stored.meta?.data.ownedSessions ?? [];
    expect(owned).toHaveLength(4);
    const bySid = Object.fromEntries(owned.map(o => [o.sid, o.framework]));
    expect(bySid.ses_mini_a).toBe('opencode');
    expect(bySid.ses_mini_b).toBe('claude-code');
    expect(bySid.ses_mini_c).toBe('opencode');
    expect(bySid.ses_mini_unref).toBe('claude-code');
  });

  it('排除集命中 owned 行；同 sid 用户自有行（sourcePath 包外）不受影响', async () => {
    // 用户自有行：同 sid、不同 framework（导入 run 前就存在的会话）
    const own = await prisma.session.create({
      data: { taskId: 'ses_mini_a', framework: 'custom-fw', sourcePath: '/home/user/own.jsonl' },
    });
    try {
      const excluded = await excludedSessionIds(prisma, TMP_ROOT);
      const rows = await prisma.session.findMany({
        where: { taskId: { in: ['ses_mini_a', 'ses_mini_b', 'ses_mini_c', 'ses_mini_unref'] } },
        select: { id: true, taskId: true, framework: true },
      });
      expect(rows).toHaveLength(5); // 4 run 行 + 1 自有行
      const runOwnedIds = rows.filter(r => r.framework !== 'custom-fw').map(r => r.id);
      for (const id of runOwnedIds) expect(excluded).toContain(id);
      expect(excluded).not.toContain(own.id);
      expect(excluded).toHaveLength(4);
    } finally {
      await prisma.session.delete({ where: { id: own.id } }).catch(() => {});
    }
  });

  it('run 删除级联：owned 行含子行清理，自有行保留', async () => {
    const own = await prisma.session.create({
      data: { taskId: 'ses_mini_a', framework: 'custom-fw', sourcePath: '/home/user/own.jsonl' },
    });
    try {
      const stored = readRun('minidemo01', TMP_ROOT)!;
      const owned = stored.meta!.data.ownedSessions!;
      expect(owned.length).toBe(4);
      const deleted = await deleteOwnedSessionRows(prisma, TMP_ROOT, owned);
      expect(deleted).toBe(4);
      const remaining = await prisma.session.findMany({
        where: { taskId: { in: MINI_SIDS } },
        select: { taskId: true, framework: true },
      });
      expect(remaining).toEqual([{ taskId: 'ses_mini_a', framework: 'custom-fw' }]);
    } finally {
      await prisma.session.delete({ where: { id: own.id } }).catch(() => {});
    }
  });
});
