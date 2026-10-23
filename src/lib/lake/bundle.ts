// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// bundle 编排层（lake-bundle 板块）：
// list / upload / import。bundle = opsbot workflow 包（workflow.json +
// sessions/），仓内布局 opsbot-bundle/<runId>/（mirror 层三函数）。上传数据流
// （与会话上传同款「导入后上传」——数据源 = insight，sessions/runs 归一基础）：
// 已导入 run → staging（run 目录 manifest/report 落盘件 + 成员会话按
// stageInsightSession 装配〔本机源直传优先、DB 导出兜底〕+ 合成
// bundle.meta.json）→ 治理（jsonl 全量清洗 + .json 深度清洗 + 复检熔断 +
// 大小限）→ mirror.push。导入 = 物化（mirror）→ 解压回明文 → run 域
// import-service job 管线（复用）。不涉及 cpx 捕获语义——bundle 内会话正文
// 即普通 claude-jsonl 件。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listBundles, materializeBundle, uploadBundleFolder, type LakeRemote, type LakeBundleEntry, type UploadResult } from './mirror';
import { defaultLakeRemote } from './remote';
import { requirePushCredentials } from './auth';
import { parseSubmitInfo, extractSubmitter } from './notes';
import { governText, redactInPlace, scanResidue, GovernanceError, MAX_SESSION_BYTES } from './governance';
import { xLake } from './export';
import { stageInsightSession, type SessionRow } from './index';
import { envelopeFields } from '../shared/envelope';
import { decompressToPlain, compressCaptureFile } from '@/lib/compression';
import { validateBundleDir, createImportJob, getImportJob, type ImportJobState } from '@/lib/run/import-service';
import { readRun, runsRoot, runDir } from '@/lib/run/run-store';
import { WORKFLOW_SCHEMA_FILE, type RunWorkflowData, type RunMember } from '@/lib/run/model';
import { createLogger } from '@/lib/logger';
import type { PrismaClient } from '@prisma/client';
import { BUNDLE_MANIFEST_FILE, BUNDLE_META_FILE } from './bundle-layout';

const bundleLog = createLogger('lake-bundle');

export type { LakeBundleEntry };

// bundle 总量上限（压缩后字节，防误传巨型包）。可变引用（测试注入小阈值
// 验证熔断路径）；生产初值经 env LAKE_MAX_BUNDLE_MB 覆写。单会话上限沿用
// MAX_SESSION_BYTES（lake/index.ts，env LAKE_MAX_SESSION_MB）。
export const MAX_BUNDLE_BYTES = { value: (() => {
  const v = Number(process.env.LAKE_MAX_BUNDLE_MB);
  return Number.isFinite(v) && v > 0 ? Math.floor(v * 1024 * 1024) : 1024 * 1024 * 1024;
})() };

// 单会话上限复用会话侧同款常量（governance.ts，env LAKE_MAX_SESSION_MB）。

export interface LakeBundleView extends LakeBundleEntry {
  imported: boolean;
}

/** bundle 列表（含 imported 标记：run-store 已有该 runId 即已导入）。 */
export function listLakeBundles(remote?: LakeRemote, root?: string): LakeBundleView[] {
  return listBundles(remote ?? defaultLakeRemote()).map(e => ({ ...e, imported: readRun(e.runId, root) != null }));
}

// ── 成员收集：manifest 全树（含子图内层）的 session 成员 → (sessionId, location) ──

function collectSessionMembers(data: RunWorkflowData): { sessionId: string; location: string }[] {
  const out: { sessionId: string; location: string }[] = [];
  const walk = (members: RunMember[]): void => {
    for (const m of members) {
      if (m.kind === 'session' && m.sessionId && m.location) {
        out.push({ sessionId: m.sessionId, location: m.location });
      }
      if (m.data?.members) walk(m.data.members);
    }
  };
  walk(data.members);
  return out;
}

/** 上传时合成 bundle.meta.json（cc-bundle-meta，x_lake 信封）：提交信息
 *  快照（与 commit message 同源同值）+ 展示快照（name/规模），列表
 *  归属的权威字段（读方 meta 优先、git log 推导回落——与会话 meta 同款）。 */
function synthesizeBundleMeta(
  stagingBundle: string,
  runId: string,
  manifest: { name?: string | null },
  sessionCount: number,
  description: string | null,
): void {
  const submit = parseSubmitInfo(description);
  const data: Record<string, unknown> = { runId, uploadedAt: new Date().toISOString() };
  if (submit.author) data.submitter = submit.author;
  if (submit.description) data.description = submit.description;
  if (submit.remark) data.remark = submit.remark;
  if (typeof manifest.name === 'string' && manifest.name) data.name = manifest.name;
  if (sessionCount > 0) data.sessionCount = sessionCount;
  fs.writeFileSync(
    path.join(stagingBundle, BUNDLE_META_FILE),
    JSON.stringify(envelopeFields(xLake('cc-bundle-meta', data)), null, 2) + '\n',
  );
}

// ── 治理：jsonl 全量清洗（慢路径——bundle 会话无 cpx governed 标记）+
// .json 深度清洗（redactInPlace 结构层）+ 复检熔断 + 大小限（压缩后字节）──

function governStagedBundle(stagingBundle: string, runId: string): void {
  const listFiles = (): string[] => {
    const all = fs.readdirSync(stagingBundle, { recursive: true, withFileTypes: true });
    const out: string[] = [];
    for (const d of all) {
      if (!d.isDirectory()) out.push(path.relative(stagingBundle, path.join(d.parentPath, d.name)));
    }
    return out;
  };
  const files = listFiles();
  const unexpected = files.filter(f => !f.endsWith('.jsonl.7z') && !f.endsWith('.jsonl.gz') && !f.endsWith('.jsonl') && !f.endsWith('.json'));
  if (unexpected.length > 0) {
    throw new GovernanceError(`上传熔断：staging 存在白名单外文件（仅允许 .jsonl/.jsonl.7z/.jsonl.gz/.json）：${unexpected.join(', ')}`);
  }

  // jsonl：解压 → 清洗 → 复检 → 压回（bundle 会话 producer 非 cpx，恒走慢路径）
  const residues: string[] = [];
  for (const rel of files.filter(f => f.endsWith('.jsonl') || f.endsWith('.jsonl.7z') || f.endsWith('.jsonl.gz'))) {
    const plain = decompressToPlain(path.join(stagingBundle, rel));
    const { output, residue } = governText(fs.readFileSync(plain, 'utf8'));
    if (residue.length > 0) residues.push(...residue.map(r => `${rel}: ${r}`));
    fs.writeFileSync(plain, output);
  }
  // .json（manifest/report/meta/会话 meta）：深度清洗（结构层值域，JSON 结构
  // 保持）→ 复检。manifest 里的 output.text 成员输出摘要同样是不可信输入。
  // workflow.schema.json 是随包权威件（非不可信捕获内容）：redact/重格式化
  // 会破坏与 opsbot 内置权威的字节一致性，整组豁免。
  for (const rel of files.filter(f => f.endsWith('.json') && path.basename(f) !== WORKFLOW_SCHEMA_FILE)) {
    const file = path.join(stagingBundle, rel);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      residues.push(`${rel}: JSON 解析失败`);
      continue;
    }
    const changed = redactInPlace(parsed);
    // 复检用紧凑序列化：scanResidue 的结构层检查按行 JSON.parse，多行美化
    // 形态每行不是合法 JSON 会漏检嵌套敏感键
    const residue = scanResidue(JSON.stringify(parsed));
    if (residue.length > 0) residues.push(...residue.map(r => `${rel}: ${r}`));
    if (changed) fs.writeFileSync(file, JSON.stringify(parsed, null, 2) + '\n');
  }
  if (residues.length > 0) {
    throw new GovernanceError(`上传熔断：清洗后仍检出疑似密钥残留，已拒绝上传。检出项（值已截断）：\n${residues.slice(0, 10).join('\n')}`);
  }

  // 治理通过 → jsonl 压回 7z（出仓形态），大小限按压缩后字节
  for (const rel of listFiles().filter(f => f.endsWith('.jsonl'))) {
    compressCaptureFile(path.join(stagingBundle, rel));
  }

  // 大小限（压缩后字节）：重新列目录（.jsonl 已压成 .jsonl.7z，旧清单路径失效）
  const perSession = new Map<string, number>();
  let totalBytes = 0;
  for (const rel of listFiles()) {
    const file = path.join(stagingBundle, rel);
    const size = fs.statSync(file).size;
    totalBytes += size;
    if (rel.startsWith('sessions/')) {
      const seg = rel.slice('sessions/'.length).split('/')[0];
      perSession.set(seg, (perSession.get(seg) ?? 0) + size);
    }
  }
  for (const [seg, bytes] of perSession) {
    if (bytes > MAX_SESSION_BYTES.value) {
      throw new GovernanceError(`会话 "${seg}" 超单会话上限（${(bytes / 1024 / 1024).toFixed(1)}MB > ${(MAX_SESSION_BYTES.value / 1024 / 1024).toFixed(0)}MB，压缩后）`);
    }
  }
  if (totalBytes > MAX_BUNDLE_BYTES.value) {
    throw new GovernanceError(`Bundle "${runId}" 超总量上限（${(totalBytes / 1024 / 1024).toFixed(1)}MB > ${(MAX_BUNDLE_BYTES.value / 1024 / 1024).toFixed(0)}MB，压缩后）`);
  }
}

export interface BundleUploadResult extends UploadResult {
  runId: string;
  sessionCount: number;
  /** manifest 引用但 insight 无会话行（导入时缺文件/已删除）——上传继续，
   *  包内缺该正文，重导入侧呈现 missingFile（与会话级容忍一致） */
  missingSessions: string[];
  warnings: string[];
}

/** 已导入 run 整包上传数据仓 opsbot-bundle/<runId>/（原子整体替换）。数据源
 *  = insight（与会话上传同款「导入后上传」链路）：manifest 取 run
 *  目录落盘件，成员会话按
 *  stageInsightSession 装配（本机源直传优先、DB 导出兜底）。 */
export async function uploadLakeBundle(
  prisma: PrismaClient,
  runId: string,
  description: string | undefined,
  remote?: LakeRemote,
): Promise<BundleUploadResult> {
  if (!/^[\w.-]+$/.test(runId)) throw new Error(`Invalid bundle id: "${runId}"`);
  const { submitter, error: submitterError } = extractSubmitter(description);
  if (submitterError) throw new Error(submitterError);
  const rem = remote ?? defaultLakeRemote();
  requirePushCredentials(rem.pushUrl, rem.pushAuth);
  const stored = readRun(runId);
  if (!stored) throw new Error(`Run "${runId}" 未导入——上传数据源是已导入的 run，请先在 Runs 页导入 bundle`);

  const dir = runDir(runsRoot(), runId);
  const t0 = Date.now();
  // staging 必须在镜像缓存目录之外：首次 clone / 镜像自愈会 rmSync 整个缓存目录
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), `lake-bundle-${runId}-`));
  try {
    const stagingBundle = path.join(stagingRoot, runId);
    fs.mkdirSync(stagingBundle, { recursive: true });
    // manifest：run 目录落盘件原样出仓（仓内锚定名 workflow.json，字节保真）
    fs.copyFileSync(path.join(dir, 'manifest.json'), path.join(stagingBundle, BUNDLE_MANIFEST_FILE));
    // schema：随包权威原样出仓（导入时已随 manifest 落盘 run 目录）；数据仓
    // 内的 bundle 恒带 schema，重导入不再豁免。旧版本导入的 run 缺 schema
    // → 显式拒绝（存量无需兼容，用带 schema 的 bundle 重新导入即可）。
    const schemaSrc = path.join(dir, WORKFLOW_SCHEMA_FILE);
    if (!fs.existsSync(schemaSrc)) {
      throw new Error(`Run "${runId}" 缺 ${WORKFLOW_SCHEMA_FILE}（旧版本导入的 run，无随包 schema）——请用带 schema 的 bundle 重新导入后上传`);
    }
    fs.copyFileSync(schemaSrc, path.join(stagingBundle, WORKFLOW_SCHEMA_FILE));

    const missingSessions: string[] = [];
    let sessionCount = 0;
    for (const { sessionId, location } of collectSessionMembers(stored.manifest.data)) {
      if (path.isAbsolute(location) || location.split('/').includes('..')) {
        throw new Error(`manifest 会话 location 越界（${sessionId}: "${location}"）`);
      }
      const session = await prisma.session.findFirst({ where: { taskId: sessionId } }) as SessionRow | null;
      if (!session) {
        missingSessions.push(sessionId);
        continue;
      }
      await stageInsightSession(session, prisma, stagingBundle, location);
      sessionCount += 1;
    }

    synthesizeBundleMeta(stagingBundle, runId, stored.manifest, sessionCount, description ?? null);
    governStagedBundle(stagingBundle, runId);
    const commitMessage = description!.trim() + `\n\nbundle: ${runId}`;
    const result = await uploadBundleFolder(stagingRoot, runId, commitMessage, rem);
    const warnings = missingSessions.map(sid => `成员会话 ${sid} 不在 insight（导入缺文件或已删除），包内缺该正文`);
    bundleLog.info('bundle upload done', { runId, submitter, unchanged: result.unchanged, sessions: sessionCount, missing: missingSessions.length, ms: Date.now() - t0 });
    return { ...result, runId, sessionCount, missingSessions, warnings };
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

export interface BundleImportHandle {
  jobId: string;
  state: ImportJobState;
}

/** 从数据仓导入 bundle：物化 → 解压回明文 → run 域导入 job（fire-and-forget，
 *  轮询 getImportJob；物化目录由 job 终态自清理）。 */
export function importLakeBundle(
  runId: string,
  opts?: { prisma?: PrismaClient; root?: string },
  remote?: LakeRemote,
): BundleImportHandle {
  if (!/^[\w.-]+$/.test(runId)) throw new Error(`Invalid bundle id: "${runId}"`);
  const rem = remote ?? defaultLakeRemote();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `lake-bundle-import-${runId}-`));
  let bundleDir: string;
  try {
    bundleDir = materializeBundle(runId, path.join(tmpRoot, runId), rem);
    // 压缩态 → 明文：还原成与本地 bundle 目录同构（import-service 消费明文 .jsonl）
    for (const rel of fs.readdirSync(bundleDir, { recursive: true, withFileTypes: true })) {
      if (!rel.isDirectory() && (rel.name.endsWith('.jsonl.7z') || rel.name.endsWith('.jsonl.gz'))) {
        decompressToPlain(path.join(rel.parentPath, rel.name));
      }
    }
    const validation = validateBundleDir(bundleDir);
    if (!validation.ok || !validation.manifest) {
      throw new Error(validation.error ?? `Bundle "${runId}" 物化后校验失败`);
    }
    const jobId = createImportJob(bundleDir, validation.manifest, { ...opts, cleanupDir: tmpRoot });
    return { jobId, state: getImportJob(jobId)! };
  } catch (e) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    throw e;
  }
}
