// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// run 域 store IT：runs/ 目录管理（落盘/列表/读取/覆盖幂等/删除）+
// runId 目录名安全闸 + CANNBOT_INSIGHT_HOME 锚定。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseAndIndex } from '@/lib/run/reader';
import {
  saveRun,
  readRun,
  listRuns,
  deleteRun,
  runDir,
  isSafeRunId,
  runsRoot,
  type RunImportMeta,
} from '@/lib/run/run-store';

const FIXTURE = path.resolve(__dirname, './data/run/graph-demo-rollback-manifest.json');
const manifest = parseAndIndex(JSON.parse(fs.readFileSync(FIXTURE, 'utf-8'))).manifest;

const miniManifest = parseAndIndex(
  JSON.parse(fs.readFileSync(path.resolve(__dirname, './data/run/mini-bundle/workflow.json'), 'utf-8')),
).manifest;

function makeMeta(sourceDir: string): RunImportMeta {
  return {
    schema: 'insight-run-import',
    version: 1,
    data: {
      importedAt: '2026-10-14T10:00:00+08:00',
      sourceDir,
      manifestFile: 'workflow.json',
      exportDataComplete: true,
      sessions: { total: 3, imported: 3, existing: 0, missingFile: 0, failed: 0 },
      failures: [],
      warnings: [],
    },
  };
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-runs-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('run-store：目录管理', () => {
  it('save + read 往返：manifest 原样 + meta sidecar', () => {
    saveRun(miniManifest, makeMeta('/bundle/mini'), tmpRoot);
    const stored = readRun(miniManifest.id, tmpRoot)!;
    expect(stored).not.toBeNull();
    expect(stored.manifest.name).toBe('mini-bundle');
    expect(stored.index.graphMembers.length).toBeGreaterThan(0);
    expect(stored.meta?.data.sessions.imported).toBe(3);
    // manifest 原样落盘（未知字段不丢）
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(runDir(tmpRoot, miniManifest.id), 'manifest.json'), 'utf-8'),
    ) as Record<string, unknown>;
    expect(onDisk.schema).toBe('cannbot.workflow-bundle');
  });

  it('重复导入同 runId：覆盖幂等（最新 meta 生效）', () => {
    saveRun(miniManifest, makeMeta('/first'), tmpRoot);
    saveRun(miniManifest, { ...makeMeta('/second') }, tmpRoot);
    const stored = readRun(miniManifest.id, tmpRoot)!;
    expect(stored.meta?.data.sourceDir).toBe('/second');
    // 单目录单 run
    expect(listRuns(tmpRoot).runs).toHaveLength(1);
  });

  it('listRuns：多 run 列表 + 派生统计（40 节点/2 回滚/1 子图）', () => {
    saveRun(manifest, makeMeta('/bundle/graph-demo'), tmpRoot);
    saveRun(miniManifest, makeMeta('/bundle/mini'), tmpRoot);
    const { runs, warnings } = listRuns(tmpRoot);
    expect(warnings).toHaveLength(0);
    expect(runs).toHaveLength(2);
    const demo = runs.find(r => r.runId === manifest.id)!;
    expect(demo.name).toBe('graph-demo');
    expect(demo.nodeCount).toBe(40);
    expect(demo.memberCount).toBe(76);
    expect(demo.rollbackCount).toBe(2);
    expect(demo.subgraphCount).toBe(3);
    expect(demo.generations).toEqual([0, 1, 2]);
    expect(demo.status).toBe('failed');
    expect(demo.importedAt).toBe('2026-10-14T10:00:00+08:00');
  });

  it('坏目录降级：清单损坏 → 警告占位不炸列表', () => {
    fs.mkdirSync(path.join(tmpRoot, 'broken-run'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'broken-run', 'manifest.json'), '{ not json');
    saveRun(miniManifest, makeMeta('/ok'), tmpRoot);
    const { runs, warnings } = listRuns(tmpRoot);
    expect(runs.map(r => r.runId)).toEqual([miniManifest.id]);
    expect(warnings.some(w => w.includes('broken-run'))).toBe(true);
  });

  it('deleteRun：只删 run 目录（不触会话）；缺失返回 false', () => {
    saveRun(miniManifest, makeMeta('/x'), tmpRoot);
    expect(deleteRun(miniManifest.id, tmpRoot)).toBe(true);
    expect(readRun(miniManifest.id, tmpRoot)).toBeNull();
    expect(deleteRun(miniManifest.id, tmpRoot)).toBe(false);
  });

  it('runId 安全闸：路径穿越/特殊字符拒绝', () => {
    expect(isSafeRunId('d01dfbaa')).toBe(true);
    expect(isSafeRunId('WC7D09351F7D2B9E0')).toBe(true);
    expect(isSafeRunId('../escape')).toBe(false);
    expect(isSafeRunId('a/b')).toBe(false);
    expect(isSafeRunId('')).toBe(false);
    expect(() => runDir(tmpRoot, '../evil')).toThrow(/安全闸/);
    expect(readRun('../evil', tmpRoot)).toBeNull();
  });
});

describe('run-store：数据主目录锚定', () => {
  const ORIG = process.env.CANNBOT_INSIGHT_HOME;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.CANNBOT_INSIGHT_HOME;
    else process.env.CANNBOT_INSIGHT_HOME = ORIG;
  });

  it('runsRoot 跟随 CANNBOT_INSIGHT_HOME（测试隔离锚点）', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-home-'));
    try {
      process.env.CANNBOT_INSIGHT_HOME = home;
      expect(runsRoot()).toBe(path.join(home, 'runs'));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
