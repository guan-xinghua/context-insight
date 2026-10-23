// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// bundle 导入编排（design.md §5）：校验 → manifest 落盘 → 会话全量立即导入
// （用户决策 #2）→ import.json 汇总。分钟级导入不做同步长请求——job 化 +
// 进度轮询（对齐 opsbot upload-to-lake 先例）；manifest 先落盘 + 会话导入
// 幂等 = 崩溃/重启后重新发起即续传。会话枚举走 lake 双记录布局约定
// （<sid>.native/ 目录，sessionFolderOf/parseSessionFolder 语义），逐会话复用
// 现有 importSession 管线（exportDeclaredFramework 通路回原生 framework 行）。

import fs from 'node:fs';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { importSession } from '@/lib/ingest/data-service';
import { logInfo, logError } from '@/lib/logger';
import { parseManifest, buildIndex, type RunIndex } from './reader';
import { MANIFEST_FILENAMES, WORKFLOW_SCHEMA_FILE, type RunManifest } from './model';
import { validateWithBundleSchema } from './schema-validate';
import { saveRun, runsRoot, readRun, isSafeRunId } from './run-store';

export interface BundleValidation {
  ok: boolean;
  status: number;               // 失败时直接回给路由的 HTTP 状态
  error?: string;
  reason?: string;
  manifestPath?: string;
  manifestFile?: string;
  sessionsDir?: string;
  manifest?: RunManifest;
}

/** manifest 落盘时的统一命名（与 run-store 的 MANIFEST_FILE 对齐）。 */
export function bundleManifestFile(dirPath: string): string {
  return MANIFEST_FILENAMES.find(n => fs.existsSync(path.join(dirPath, n))) ?? MANIFEST_FILENAMES[0];
}

/** 校验 bundle 目录（同步、可 4xx 快速失败，不起 job）。结构校验走包内
 * workflow.schema.json + parse + index（含关系端点解析），坏清单在入口拒绝
 * 而不是 job 中途炸。schema 是随包权威：导入时落盘 runs/<id>、上传时原样
 * 进仓，lake 重导入的包同样带 schema——不设豁免分支（存量无 schema 的仓
 * 内包不再兼容）。 */
export function validateBundleDir(dirPath: string): BundleValidation {
  if (!dirPath || typeof dirPath !== 'string') {
    return { ok: false, status: 400, error: 'Missing required field: dirPath' };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dirPath);
  } catch {
    return { ok: false, status: 404, error: `Bundle 目录不存在: ${dirPath}`, reason: 'bundle-dir-not-found' };
  }
  if (!stat.isDirectory()) {
    return { ok: false, status: 400, error: `Bundle 路径必须是目录: ${dirPath}`, reason: 'bundle-dir-not-a-dir' };
  }
  const manifestFile = bundleManifestFile(dirPath);
  const manifestPath = path.join(dirPath, manifestFile);
  if (!fs.existsSync(manifestPath)) {
    return {
      ok: false,
      status: 400,
      error: `Bundle 目录缺少 workflow.json（尝试过: ${MANIFEST_FILENAMES.join(', ')}）`,
      reason: 'bundle-manifest-missing',
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (e) {
    return {
      ok: false,
      status: 400,
      error: `workflow.json 不是合法 JSON: ${e instanceof Error ? e.message : String(e)}`,
      reason: 'bundle-manifest-invalid-json',
    };
  }
  // 结构校验只走包内 workflow.schema.json（单一权威随包分发）；缺 schema 或
  // 结构不符都在此拒绝，不回落手写结构校验。
  const schemaCheck = validateWithBundleSchema(dirPath, raw);
  if (!schemaCheck.ok) {
    return {
      ok: false,
      status: 400,
      error: `workflow.json 结构校验失败: ${schemaCheck.errors.join('；')}`,
      reason: 'bundle-manifest-schema-invalid',
    };
  }
  try {
    // parseManifest（version 前向兼容闸 + 类型归一）+ buildIndex（关系端点解析）
    const manifest = parseManifest(raw);
    // id 即 run 目录名（runs/<id>）：入口同步拒绝非法目录名，避免 job 中途在 saveRun 炸
    if (!isSafeRunId(manifest.id)) {
      return {
        ok: false,
        status: 400,
        error: `workflow.json 的 id 不能作为 run 目录名（目录名安全闸）: ${JSON.stringify(manifest.id)}`,
        reason: 'bundle-invalid-run-id',
      };
    }
    buildIndex(manifest);
    const sessionsDir = path.join(dirPath, 'sessions');
    return {
      ok: true,
      status: 200,
      manifestPath,
      manifestFile,
      sessionsDir: fs.existsSync(sessionsDir) ? sessionsDir : undefined,
      manifest,
    };
  } catch (e) {
    return {
      ok: false,
      status: 400,
      error: `workflow.json 校验失败: ${e instanceof Error ? e.message : String(e)}`,
      reason: 'bundle-manifest-invalid',
    };
  }
}

// ── job 注册表（进程内；单实例部署模型，完成态保留 10 分钟）─────────

export type ImportJobStep = 'validate' | 'store' | 'import' | 'done' | 'error';

export interface ImportJobState {
  jobId: string;
  dirPath: string;
  runId: string;
  step: ImportJobStep;
  total: number;
  imported: number;
  existing: number;
  missingFile: number;
  failed: number;
  currentSid: string | null;
  error: string | null;
  warnings: string[];
  startedAt: string;
  finishedAt: string | null;
}

const jobs = new Map<string, ImportJobState>();
const FINISHED_TTL_MS = 10 * 60 * 1000;

function evictStaleJobs(): void {
  const now = Date.now();
  for (const [jobId, job] of jobs) {
    if (job.finishedAt && now - Date.parse(job.finishedAt) > FINISHED_TTL_MS) {
      jobs.delete(jobId);
    }
  }
}

export function getImportJob(jobId: string): ImportJobState | null {
  evictStaleJobs();
  return jobs.get(jobId) ?? null;
}

/** 供测试与 CLI 复用的 job 启动（fire-and-forget；校验由调用方先行）。
 *  cleanupDir：随 job 生存的临时目录（lake bundle 物化件）——终态（done/
 *  error）后删除，目录生命周期由 job 自管。 */
export function createImportJob(
  dirPath: string,
  manifest: RunManifest,
  opts?: { prisma?: PrismaClient; root?: string; cleanupDir?: string },
): string {
  const jobId = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const state: ImportJobState = {
    jobId,
    dirPath,
    runId: manifest.id,
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
  jobs.set(jobId, state);
  // 后台执行不抛出（错误进 job 状态）；不 await——路由立即返回 jobId。
  // cleanupDir 在 promise 落定（成功/失败皆然）后清理
  void runImportJob(state, dirPath, manifest, opts)
    .catch(e => {
      state.step = 'error';
      state.error = e instanceof Error ? e.message : String(e);
      state.finishedAt = new Date().toISOString();
      logError('run:import', '导入 job 异常终止', { jobId, error: state.error });
    })
    .finally(() => {
      if (opts?.cleanupDir) fs.rmSync(opts.cleanupDir, { recursive: true, force: true });
    });
  return jobId;
}

// ── 会话目录枚举（lake 双记录布局：<sid>.native/，容错无后缀目录）────

export interface BundleSessionEntry {
  sid: string;
  dir: string;
  jsonlPath: string | null;     // null = 目录里没有可导入的 jsonl（.jsonl/.gz/.7z 三形态）
}

const NATIVE_SUFFIX = '.native';

function findJsonlIn(dir: string, sid: string): string | null {
  for (const name of [`${sid}.jsonl`, `${sid}.jsonl.gz`, `${sid}.jsonl.7z`]) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function enumerateBundleSessions(sessionsDir: string): BundleSessionEntry[] {
  const entries: BundleSessionEntry[] = [];
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return entries;
  }
  for (const entry of dirents) {
    if (!entry.isDirectory()) continue;
    const sid = entry.name.endsWith(NATIVE_SUFFIX)
      ? entry.name.slice(0, -NATIVE_SUFFIX.length)
      : entry.name; // 容错：无 .native 后缀的目录按 parseSessionFolder 语义视为捕获位
    if (sid.length === 0) continue;
    const dir = path.join(sessionsDir, entry.name);
    entries.push({ sid, dir, jsonlPath: findJsonlIn(dir, sid) });
  }
  return entries.sort((a, b) => a.sid.localeCompare(b.sid));
}

/** manifest 引用的 sid 优先（run 视图尽快完整），未引用目录随后（照样导入）。 */
export function orderSessionsByManifest(
  entries: BundleSessionEntry[],
  index: RunIndex,
): { ordered: BundleSessionEntry[]; unreferenced: BundleSessionEntry[]; missingOnDisk: string[] } {
  const referenced = new Set(
    index.members.map(m => m.member.sessionId).filter((sid): sid is string => typeof sid === 'string' && sid.length > 0),
  );
  const bySid = new Map(entries.map(e => [e.sid, e]));
  const ordered: BundleSessionEntry[] = [];
  for (const sid of referenced) {
    const entry = bySid.get(sid);
    if (entry) ordered.push(entry);
  }
  const unreferenced = entries.filter(e => !referenced.has(e.sid));
  const missingOnDisk = [...referenced].filter(sid => !bySid.has(sid));
  return { ordered: [...ordered, ...unreferenced], unreferenced, missingOnDisk };
}

// ── job 主体 ──────────────────────────────────────────────────

/** 核心导入流程（awaitable：测试直接调用；生产经 createImportJob 后台跑）。 */
export async function runImportJob(
  state: ImportJobState,
  dirPath: string,
  manifest: RunManifest,
  opts?: { prisma?: PrismaClient; root?: string },
): Promise<void> {
  const warnings: string[] = [...state.warnings];
  // validateBundleDir 已做过完整结构校验；此处重建索引供会话排序用
  const index: RunIndex = buildIndex(manifest);
  const manifestFile = bundleManifestFile(dirPath);
  const rootDir = opts?.root ?? runsRoot();
  const sessionsDir = path.join(dirPath, 'sessions');

  // owned 会话行登记（Sessions 域隔离 + 删除级联依据）：种子 = 该 run 上一轮
  // sidecar 已登记的行（重导入时 existing 行保持登记，不因覆盖写丢失），
  // 导入循环中再按 sourcePath 收编新行。
  const owned = new Map<string, { sid: string; framework: string | null }>();
  const ownedKey = (sid: string, fw: string | null) => `${sid}\u0000${fw ?? ''}`;
  for (const prev of readRun(manifest.id, rootDir)?.meta?.data.ownedSessions ?? []) {
    owned.set(ownedKey(prev.sid, prev.framework), prev);
  }

  // 1. store：manifest 先落盘（幂等覆盖；半途失败后 run 视图对缺正文成员
  //    渲染"正文缺失"，重新导入即补齐）
  state.step = 'store';
  const startedAt = new Date().toISOString();
  const runDirPath = saveRun(
    manifest,
    {
      schema: 'insight-run-import',
      version: 1,
      data: {
        importedAt: startedAt,
        sourceDir: dirPath,
        manifestFile,
        exportDataComplete: manifest.data.exportDataComplete === true,
        sessions: { total: 0, imported: 0, existing: 0, missingFile: 0, failed: 0 },
        failures: [],
        warnings,
        ownedSessions: [...owned.values()],
      },
    },
    rootDir,
  );
  // 随包 schema 原样落盘（与 manifest 同存 run 目录）：上传链路据此把
  // schema 带进数据仓包。缺文件 = 结构校验未过，正常导入不会到这。
  const schemaSrc = path.join(dirPath, WORKFLOW_SCHEMA_FILE);
  if (fs.existsSync(schemaSrc)) {
    fs.copyFileSync(schemaSrc, path.join(runDirPath, WORKFLOW_SCHEMA_FILE));
  }

  // 2. import：全量立即导入（用户决策 #2）
  state.step = 'import';
  const entries = enumerateBundleSessions(sessionsDir);
  const { ordered, unreferenced, missingOnDisk } = orderSessionsByManifest(entries, index);
  state.total = ordered.length;
  if (unreferenced.length > 0) {
    warnings.push(`${unreferenced.length} 个会话目录未被 manifest 引用（照样导入）: ${unreferenced.map(e => e.sid).join(', ')}`);
  }
  for (const sid of missingOnDisk) {
    warnings.push(`manifest 引用的会话 ${sid} 不在包内（exportDataComplete=${manifest.data.exportDataComplete === true}）`);
  }

  const failures: { sid: string; error: string }[] = [];
  for (const entry of ordered) {
    state.currentSid = entry.sid;
    if (!entry.jsonlPath) {
      state.missingFile += 1;
      warnings.push(`会话 ${entry.sid} 目录无 jsonl，跳过`);
      continue;
    }
    try {
      // 现有管线：claude-jsonl 适配器 + readCcSessionMeta 的 insight-export
      // framework 声明通路（回原生 framework 行）；(taskId, framework) 唯一
      // 索引保证重导入幂等
      const result = await importSession(entry.jsonlPath, entry.sid, opts?.prisma, entry.jsonlPath, 'claude-jsonl');
      if (result.imported) {
        state.imported += 1;
      } else {
        state.existing += 1;
      }
      // owned 收编：该 sid 下 sourcePath 落在包 sessions/ 内的行归本 run
      // （新导入行必然命中；重导入的既有行同样命中——但用户导入前自有的
      // 同 sid 会话 sourcePath 在包外，不收编、不隔离、不被级联删除）
      if (opts?.prisma) {
        const rows = await opts.prisma.session.findMany({
          where: { taskId: entry.sid },
          select: { taskId: true, framework: true, sourcePath: true },
        });
        for (const row of rows) {
          // 路径边界：`sessions/` 旁的同名前缀目录（sessions-export/ 等）不得误收编——
          // 必须是 sessionsDir 自身或其直接子路径（startsWith 前缀匹配会漏掉分隔符边界）
          if (row.sourcePath && (row.sourcePath === sessionsDir || row.sourcePath.startsWith(sessionsDir + path.sep))) {
            owned.set(ownedKey(row.taskId, row.framework), { sid: row.taskId, framework: row.framework });
          }
        }
      }
    } catch (e) {
      state.failed += 1;
      const message = e instanceof Error ? e.message : String(e);
      failures.push({ sid: entry.sid, error: message });
      // 失败隔离：单会话失败记录并继续，不阻断整包
    }
  }
  state.currentSid = null;

  // 3. finalize：import.json 汇总
  saveRun(
    manifest,
    {
      schema: 'insight-run-import',
      version: 1,
      data: {
        importedAt: startedAt,
        sourceDir: dirPath,
        manifestFile,
        exportDataComplete: manifest.data.exportDataComplete === true,
        sessions: {
          total: state.total,
          imported: state.imported,
          existing: state.existing,
          missingFile: state.missingFile,
          failed: state.failed,
        },
        failures,
        warnings,
        ownedSessions: [...owned.values()],
      },
    },
    rootDir,
  );
  state.warnings = warnings;
  state.step = 'done';
  state.finishedAt = new Date().toISOString();
  logInfo('run:import', 'bundle 导入完成', {
    runId: manifest.id,
    total: state.total,
    imported: state.imported,
    existing: state.existing,
    failed: state.failed,
  });
}
