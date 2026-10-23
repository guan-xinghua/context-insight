// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Run 域存储层：数据主目录 runs/<runId>/ 的目录管理（design.md §3）。
// manifest 原样落盘（统一命名 manifest.json）+ import.json sidecar 元数据。
// 无索引文件：run 量级小，列表 = 扫描目录（每目录一次 JSON 读 + 纯函数索引）。

import fs from 'node:fs';
import path from 'node:path';
import { expandHome } from '@/lib/ingest/import-paths';
import { buildIndex, parseManifest, type RunIndex } from './reader';
import { buildViewModel } from './view-model';
import type { RunManifest } from './model';

/** 导入元数据（import.json，信封冻结）。 */
export interface RunImportMeta {
  schema: 'insight-run-import';
  version: 1;
  data: {
    importedAt: string;
    sourceDir: string;
    manifestFile: string;
    exportDataComplete: boolean;
    sessions: {
      total: number;
      imported: number;      // 本次新导入
      existing: number;      // 已存在幂等跳过
      missingFile: number;   // 目录里没有可导入的 jsonl
      failed: number;
    };
    failures: { sid: string; error: string }[];
    warnings: string[];
    /** 本 run 导入时实际创建/收编的会话行（(taskId, framework) 精确对）：
     *  Sessions 域隔离（首页排除）与 run 删除级联的唯一依据。收编规则 =
     *  行的 sourcePath 落在包 sessions/ 目录内（重导入时既有行也归 run，
     *  用户自有会话不受影响）。可选字段：旧版 sidecar 无此字段 = 空。 */
    ownedSessions?: { sid: string; framework: string | null }[];
  };
}

export interface StoredRun {
  runId: string;
  manifest: RunManifest;
  index: RunIndex;
  meta: RunImportMeta | null;
}

export interface RunListItem {
  runId: string;
  name: string | null;
  status: string;              // view-model 汇总口径（展示用）
  exportDataComplete: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  importedAt: string | null;
  generations: number[];
  nodeCount: number;           // 图节点实例数（(nodeId, generation) 聚簇）
  memberCount: number;         // 全树成员数
  sessionMemberCount: number;  // 指向会话正文的成员数
  rollbackCount: number;
  subgraphCount: number;
  warnings: string[];
}

const MANIFEST_FILE = 'manifest.json';
const META_FILE = 'import.json';

/** 数据主目录（与 lake-config/proxy 同源锚定：CONTEXT_INSIGHT_HOME 优先）。 */
export function insightDataHome(): string {
  return path.resolve(expandHome(process.env.CONTEXT_INSIGHT_HOME ?? '~/.context-insight'));
}

export function runsRoot(): string {
  return path.join(insightDataHome(), 'runs');
}

/** runId（= manifest id）做目录名的安全闸：防路径注入/穿越，形态外的 id 拒绝。 */
export function isSafeRunId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && !id.includes('..');
}

export function runDir(root: string, runId: string): string {
  if (!isSafeRunId(runId)) {
    throw new Error(`非法 runId（目录名安全闸）: ${JSON.stringify(runId)}`);
  }
  return path.join(root, runId);
}

/** 落盘：manifest 原样 + 元数据 sidecar。同 runId 覆盖（幂等重导入）。 */
export function saveRun(manifest: RunManifest, meta: RunImportMeta | null, root?: string): string {
  const dir = runDir(root ?? runsRoot(), manifest.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2), 'utf-8');
  if (meta) fs.writeFileSync(path.join(dir, META_FILE), JSON.stringify(meta, null, 2), 'utf-8');
  return dir;
}

/** 读取单个 run（manifest + 索引 + 元数据）；目录缺失/清单损坏返回 null。 */
export function readRun(runId: string, root?: string): StoredRun | null {
  let dir: string;
  try {
    dir = runDir(root ?? runsRoot(), runId);
  } catch {
    return null;
  }
  const manifestPath = path.join(dir, MANIFEST_FILE);
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const manifest = parseManifest(raw);
    let meta: RunImportMeta | null = null;
    const metaPath = path.join(dir, META_FILE);
    if (fs.existsSync(metaPath)) {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        if (
          typeof parsed === 'object' && parsed !== null
          && (parsed as { schema?: unknown }).schema === 'insight-run-import'
        ) {
          meta = parsed as RunImportMeta;
        }
      } catch { /* 坏 sidecar 不阻断 run 读取 */ }
    }
    return { runId, manifest, index: buildIndex(manifest), meta };
  } catch {
    return null;
  }
}

/** 列表：扫描 runs/ 下全部 run 目录，坏目录降级为带警告的占位条目。 */
export function listRuns(root?: string): { runs: RunListItem[]; warnings: string[] } {
  const rootDir = root ?? runsRoot();
  const warnings: string[] = [];
  const runs: RunListItem[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return { runs, warnings };  // 目录不存在 = 空（首用态）
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const stored = readRun(entry.name, rootDir);
    if (!stored) {
      warnings.push(`runs/${entry.name} 清单缺失或无法解析，已跳过`);
      continue;
    }
    runs.push(toListItem(stored));
  }
  runs.sort((a, b) => (b.importedAt ?? '').localeCompare(a.importedAt ?? ''));
  return { runs, warnings };
}

export function toListItem(stored: StoredRun): RunListItem {
  const vm = buildViewModel(stored.index);
  const sessionMembers = stored.index.graphMembers.filter(m => m.member.sessionId);
  return {
    runId: stored.runId,
    name: stored.manifest.name ?? null,
    status: vm.status,
    exportDataComplete: stored.manifest.data.exportDataComplete === true,
    startedAt: stored.manifest.startedAt ?? null,
    finishedAt: stored.manifest.finishedAt ?? null,
    importedAt: stored.meta?.data.importedAt ?? null,
    generations: vm.generations,
    nodeCount: vm.nodes.length,
    memberCount: stored.index.members.length,
    sessionMemberCount: sessionMembers.length,
    rollbackCount: vm.rollbacks.length,
    subgraphCount: vm.views.length - 1,
    warnings: vm.warnings,
  };
}

/** 删除 run 目录（不级联删除已导入会话——会话是独立资产）。 */
export function deleteRun(runId: string, root?: string): boolean {
  let dir: string;
  try {
    dir = runDir(root ?? runsRoot(), runId);
  } catch {
    return false;
  }
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}
