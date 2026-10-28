// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// lake 编排层（route 唯一入口）：list / import / upload。
// 上传数据流：源（proxy 捕获 / native claude jsonl 原文件 / opencode DB 导出）
// → staging → 治理（清洗 + 复检熔断，governance.ts）→ mirror.uploadFolder。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { listSessions, listOverview, materializeSession, uploadFolder, listParadigmDirs, ensureLfsBootstrapForRead, type LakeRemote, type LakeSessionEntry, type LakeOverview, type UploadResult, type RecordingClass } from './mirror';
import { readCcSessionMeta } from '../ingest/proxy-classify';
import { isProxyVersion } from '../shared/session-format';
import { computeSessionActiveSplit } from '../active-time';
import { defaultLakeRemote } from './remote';
import { requirePushCredentials } from './auth';
import { parseSubmitInfo, extractSubmitter, type SessionSubmitInfo } from './notes';
import { governText, GovernanceError, MAX_SESSION_BYTES } from './governance';
import { exportSessionToClaudeJsonl, xLake } from './export';
import { BUNDLE_ROOT_DIR } from './bundle-layout';
import { readEnvelope, envelopeFields } from '../shared/envelope';
import { readCaptureText, ensure7z, compressCaptureFile, decompressToPlain } from '@/lib/compression';
import { importSession } from '@/lib/ingest/data-service';
import {
  resolveNativeCounterpart,
  defaultNativeDiscoveryRoots,
  type NativeDiscoveryRoots,
} from '@/lib/ingest/native-counterpart';
import { createLogger } from '@/lib/logger';

const lakeLog = createLogger('lake');
import type { PrismaClient } from '@prisma/client';

export type { LakeSessionEntry, LakeOverview };
export { listParadigmDirs } from './mirror';
// 治理常量/错误已挪至 governance.ts（会话与 bundle 上传共用），re-export 保兼容
export { GovernanceError, MAX_SESSION_BYTES } from './governance';

type PrismaLike = PrismaClient;

export function listLakeSessions(remote?: LakeRemote): LakeSessionEntry[] {
  return listSessions(remote);
}

/** 列表 + 顶层目录合并读取（单轮 mirror fetch 服务导入对话框的范式下拉+会话表）。 */
export function listLakeOverview(remote?: LakeRemote): LakeOverview {
  return listOverview(remote);
}

// patch 后从 DB 回读准确的 framework/version（meta 缺失时管线推断的兜底值），
// 供导入完成态显示类型徽标 —— 与本地导入路径的响应形状对齐。
// 按行 id 取行（importSession 返回的 sessionId 即行 id）：同 sid 双行
// （方案一）下裸 taskId findFirst 会读到另一行的 framework/version。
async function readSessionType(prisma: PrismaLike, rowId: string): Promise<{ framework: string | null; version: string | null }> {
  try {
    const s = await prisma.session.findUnique({ where: { id: rowId }, select: { framework: true, version: true } });
    return { framework: s?.framework ?? null, version: s?.version ?? null };
  } catch {
    return { framework: null, version: null };
  }
}

export async function importLakeSession(sid: string, prisma: PrismaLike, remote?: LakeRemote, recording: RecordingClass = 'capture') {
  const startedAt = Date.now();
  const impLog = createLogger('import');
  impLog.info('lake import start', { sid, recording });
  try {
    // LFS 模式：物化前自举 git-lfs（materializeSession 是同步函数无法内嵌；
    // 仓内指针 blob 的 --filters smudge 依赖它）——数据仓导入与上传同享
    // 「零手工安装」
    if ((remote ?? defaultLakeRemote()).lfs) await ensureLfsBootstrapForRead();
    const mainJsonl = materializeSession(sid, remote, recording);
    const result = await importSession(mainJsonl, sid, prisma, mainJsonl, 'claude-jsonl');
    // x_lake 补列（docs/lake-schema-spec.md）：核心管线无通道、只存在于
    // 声明里的列（Turn.ttftMs/temperature/maxTokens/modelId/providerId、
    // ToolCall.errorType/errorMessage/durationMs/startedAt、Session.framework/
    // version）在 lake 编排层恢复 —— 核心红线不动。补列/回读都按
    // result.sessionId（行 id）定位，同 sid 双行不串行
    await patchXLakeColumns(mainJsonl, result.sessionId, prisma).catch(e => {
      impLog.warn('x_lake 补列失败（不阻塞导入）', { sid, error: e instanceof Error ? e.message : String(e) });
    });
    const out = { ...result, ...(await readSessionType(prisma, result.sessionId)) };
    impLog.info('lake import done', { sid, recording, sessionId: result.sessionId, imported: result.imported, ms: Date.now() - startedAt });
    return out;
  } catch (e) {
    impLog.error('lake import failed', { sid, recording, error: e instanceof Error ? e.message : String(e), ms: Date.now() - startedAt });
    throw e;
  }
}

interface DbTurnPayload {
  ttftMs?: number;
  temperature?: number;
  maxTokens?: number;
  modelId?: string;
  providerId?: string;
  toolCalls?: Array<{ toolUseId: string; state?: string; errorType?: string; errorMessage?: string; durationMs?: number; startedAt?: string }>;
}

// 按声明补列。匹配按文件进行：主文件声明 ↔ 非 subagent assistant 轮，
// subagents/<subId>.jsonl 声明 ↔ 对应 subagent 轮。安全性规则：单文件
// assistant 轮数 ≠ 声明数 → 该文件放弃（形状不符时不猜，宁缺勿错）；
// 单条 toolUseId 匹配不到 → 跳过该条。
// sessionRowId：目标行 id（importSession 返回值）——同 sid 双行下裸
// taskId findFirst 会补到另一行上。
async function patchXLakeColumns(mainJsonl: string, sessionRowId: string, prisma: PrismaLike): Promise<void> {
  // 物化 stem 按记录类带后缀（capture=<sid>，native=<sid>.native）——与
  // materializeSession 的 subagents 物化目录对齐；先剥 .7z/.gz 再剥 .jsonl
  // （basename 后缀逐字匹配，一次传 .jsonl.7z 剥不掉）
  const matStem = path.basename(mainJsonl.replace(/\.(7z|gz)$/, ''), '.jsonl');
  const fileGroups: Array<{ subId: string | null; payloads: DbTurnPayload[] }> = [];
  const collect = (file: string, subId: string | null): void => {
    // .jsonl.7z（物化压缩件）/ .jsonl.gz（存量）/ .jsonl（旧明文仓件）三形态
    let text: string | null = null;
    if (fs.existsSync(file)) text = readCaptureText(file);
    else if (fs.existsSync(`${file}.7z`)) text = readCaptureText(`${file}.7z`);
    else if (fs.existsSync(`${file}.gz`)) text = readCaptureText(`${file}.gz`);
    if (text == null) return;
    const payloads: DbTurnPayload[] = [];
    for (const ln of text.split('\n')) {
      if (!ln.trim()) continue;
      try {
        const parsedLn = JSON.parse(ln);
        const xb = readEnvelope(parsedLn);
        if (xb?.schema === 'cc-db-turn' && xb.data) payloads.push(xb.data as DbTurnPayload);
      } catch { /* 截断行跳过 */ }
    }
    if (payloads.length > 0) fileGroups.push({ subId, payloads });
  };
  collect(mainJsonl, null);
  const subagentsDir = path.join(path.dirname(mainJsonl), matStem, 'subagents');
  if (fs.existsSync(subagentsDir)) {
    for (const entry of fs.readdirSync(subagentsDir, { withFileTypes: true })) {
      if (entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.gz') || entry.name.endsWith('.jsonl.7z'))) {
        collect(path.join(subagentsDir, entry.name), entry.name.replace(/\.jsonl(\.7z|\.gz)?$/, ''));
      }
    }
  }

  const session = await prisma.session.findUnique({ where: { id: sessionRowId } });
  if (!session) return;

  for (const { subId, payloads } of fileGroups) {
    const turns = await prisma.turn.findMany({
      where: {
        sessionId: session.id, role: 'assistant', isSubagent: subId != null,
        ...(subId != null ? { subagentSessionId: subId } : {}),
      },
      orderBy: { turnIndex: 'asc' },
    });
    if (turns.length !== payloads.length) continue;
    for (let i = 0; i < turns.length; i++) {
      const d = payloads[i];
      const turnPatch: Record<string, unknown> = {};
      if (d.ttftMs != null) turnPatch.ttftMs = d.ttftMs;
      if (d.temperature != null) turnPatch.temperature = d.temperature;
      if (d.maxTokens != null) turnPatch.maxTokens = d.maxTokens;
      if (d.modelId != null) turnPatch.modelId = d.modelId;
      if (d.providerId != null) turnPatch.providerId = d.providerId;
      if (Object.keys(turnPatch).length > 0) {
        await prisma.turn.update({ where: { id: turns[i].id }, data: turnPatch });
      }
      for (const tc of d.toolCalls ?? []) {
        if (!tc?.toolUseId) continue;
        const tcPatch: Record<string, unknown> = {};
        if (tc.state != null) tcPatch.state = tc.state;
        if (tc.errorType != null) tcPatch.errorType = tc.errorType;
        if (tc.errorMessage != null) tcPatch.errorMessage = tc.errorMessage;
        if (tc.durationMs != null) tcPatch.durationMs = tc.durationMs;
        if (tc.startedAt != null) tcPatch.startedAt = new Date(tc.startedAt);
        if (Object.keys(tcPatch).length > 0) {
          await prisma.toolCall.updateMany({
            where: { turnId: turns[i].id, toolCallId: tc.toolUseId },
            data: tcPatch,
          });
        }
      }
    }
  }

  // cc-session-meta：framework/version 恢复（重导入不再错变 claude-code）。
  // 仅 insight-export 生效：cpx 捕获的 version/framework 由导入管线按行
  // 标记计算 —— version 形如 '2.1.234.467-claude-proxy'（徽标靠 -proxy
  // 后缀），meta 里的纯 ccVersion 会把徽标覆盖掉。
  const meta = readCcSessionMeta(mainJsonl);
  if (meta?.producer === 'insight-export' && meta.framework) {
    const sessionPatch: Record<string, unknown> = { framework: meta.framework };
    if (meta.ccVersion) sessionPatch.version = meta.ccVersion;
    await prisma.session.update({ where: { id: session.id }, data: sessionPatch });
  }
}

export interface SessionRow {
  id: string;
  taskId: string;
  framework: string;
  version: string | null;
  sourcePath: string | null;
  // 会话指标快照源（annotateSessionMeta 写入 meta，viewer 免导入展示）
  startTime: Date;
  endTime: Date | null;
  totalTokens: number;
  model: string | null;
}

// 装配一个 insight 会话到 parentDir/<dirName>/（会话上传 = sessions/<sid>，
// bundle 成员上传 = manifest location）。直传优先（本机源文件字节保真），
// 无源走 DB 导出兜底——bundle 上传（bundle.ts）复用同一装配，sessions/runs
// 上传链路同源（数据集归一基础）。
// - sourcePath 是本机存在的 jsonl（proxy 捕获 / native claude）：原文件直传，
//   subagents 在 <dirname>/<fileSid>/subagents/（proxy 落盘约定）
// - 其余一律 DB 导出兜底：opencode（无捕获文件）、v1 数据仓下载的 .db 快照
//   会话（sourcePath 是 .db）、源文件已被删除/移动的会话。导出件不含
//   Full Context（system/tools），管线数据齐全。
export async function stageInsightSession(
  session: SessionRow,
  prisma: PrismaLike,
  parentDir: string,
  dirName: string = session.taskId,
): Promise<void> {
  const sid = session.taskId;
  const sessionDir = path.join(parentDir, dirName);
  fs.mkdirSync(sessionDir, { recursive: true });

  // 原文件直传条件：sourcePath 是本机存在的 jsonl（明文/.7z/.gz）且非 native
  // opencode（native opencode 的 sourcePath 是 .db / 目录约定）。proxy 捕获的
  // opencode 会话（framework=opencode + version 带 -proxy）是 jsonl，直传。
  // 源可以已是压缩态（cpx 退出即压，proxy/COMPRESSION-DESIGN.md）——staging
  // 统一 ensure7z 出仓（存量 gz 源借此迁移到新格式）。
  const sourceResolved = session.sourcePath
    ? (fs.existsSync(session.sourcePath) ? session.sourcePath
      : fs.existsSync(`${session.sourcePath}.7z`) ? `${session.sourcePath}.7z`
      : fs.existsSync(`${session.sourcePath}.gz`) ? `${session.sourcePath}.gz` : null)
    : null;
  const hasJsonlSource = (session.framework !== 'opencode' || isProxyVersion(session.version))
    && !!sourceResolved
    && (sourceResolved.endsWith('.jsonl') || sourceResolved.endsWith('.jsonl.7z') || sourceResolved.endsWith('.jsonl.gz'));
  if (hasJsonlSource) {
    const srcExt = sourceResolved!.endsWith('.7z') ? '.jsonl.7z' : sourceResolved!.endsWith('.gz') ? '.jsonl.gz' : '.jsonl';
    fs.copyFileSync(sourceResolved!, path.join(sessionDir, `${sid}${srcExt}`));
    ensure7z(path.join(sessionDir, `${sid}${srcExt}`));
    // writer 落盘约定（writer.ts）：主捕获带 cpx- 前缀、伴生 meta 与子代理目录
    // 用裸 sid。sourcePath 可能是任一形态（直捕 cpx-<sid>.jsonl[.7z|.gz]），
    // 统一剥前缀/后缀后定位伴生文件。注意 basename 的后缀参数是逐字匹配——
    // 先剥 .7z/.gz 再剥 .jsonl，不能一次传 '.jsonl.7z'。
    const fileSid = path.basename(sourceResolved!.replace(/\.(7z|gz)$/, ''), '.jsonl').replace(/^cpx-/, '');
    // 主会话 meta（cc-session-meta，若存在）随行上传 —— 文件级 producer/framework 声明。
    // 伴生 meta 命名随 writer 代际：旧代 = <sid>.meta.json（裸 sid）、现 writer =
    // cpx-<sid>.meta.json（captureStem 带前缀）—— 双候选都试。
    // 无伴生 meta（native claude 原文件）时从 DB 合成一份：producer='insight-upload'
    // 为展示专用值 —— 分类器只认 'cpx'、重导入 patch 只认 'insight-export'，
    // 故对导入行为零影响，仅让 list 的 type 列可见。
    const metaCandidates = [
      path.join(path.dirname(sourceResolved!), `${fileSid}.meta.json`),
      path.join(path.dirname(sourceResolved!), `cpx-${fileSid}.meta.json`),
    ];
    const siblingMeta = metaCandidates.find(m => fs.existsSync(m));
    if (siblingMeta) {
      fs.copyFileSync(siblingMeta, path.join(sessionDir, `${sid}.meta.json`));
    } else {
      fs.writeFileSync(
        path.join(sessionDir, `${sid}.meta.json`),
        JSON.stringify({
          ...envelopeFields(xLake('cc-session-meta', {
            producer: 'insight-upload',
            framework: session.framework,
            ccVersion: session.version ?? undefined,
            sid,
          })),
        }, null, 2) + '\n',
      );
    }
    // subagents 随行：裸 sid 目录（<proxy>/<sid>/subagents/，见上方 fileSid 注释）。
    // 白名单拷贝：只带 .jsonl/.jsonl.7z/.jsonl.gz/.json —— 捕获目录里的杂散文件
    // （.txt/.log/.env…）不清洗也不该出公开仓；拷入后 ensure7z 统一出仓形态
    const subagentsDir = path.join(path.dirname(sourceResolved!), fileSid, 'subagents');
    if (fs.existsSync(subagentsDir)) {
      const dest = path.join(sessionDir, 'subagents');
      fs.mkdirSync(dest, { recursive: true });
      for (const entry of fs.readdirSync(subagentsDir, { withFileTypes: true })) {
        if (entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.7z') || entry.name.endsWith('.jsonl.gz') || entry.name.endsWith('.json'))) {
          fs.copyFileSync(path.join(subagentsDir, entry.name), path.join(dest, entry.name));
          if (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.gz')) {
            ensure7z(path.join(dest, entry.name));
          }
        }
      }
    }
  } else {
    // DB 导出固定写 <scratch>/sessions/<sid>/——导完整体挪到目标位（bundle
    // 成员的 location 是任意包内相对路径，不保证 sessions/<sid> 形态）
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `lake-export-${sid}-`));
    try {
      const written = await exportSessionToClaudeJsonl(prisma, session.taskId, scratch, session.framework);
      const mainFile = path.join(scratch, 'sessions', sid, `${sid}.jsonl`);
      if (!written.includes(path.posix.join('sessions', sid, `${sid}.jsonl`)) || !fs.existsSync(mainFile) || fs.statSync(mainFile).size === 0) {
        throw new Error(`Session "${sid}" has no uploadable content (no local jsonl source, DB export empty)`);
      }
      fs.rmSync(sessionDir, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(sessionDir), { recursive: true });
      fs.renameSync(path.join(scratch, 'sessions', sid), sessionDir);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
}

// 会话上传的 staging 装配（sessions/<sid>/ 布局），返回 staging 根目录。
async function stageSessionFiles(session: SessionRow, prisma: PrismaLike): Promise<{ stagingDir: string; sid: string }> {
  const sid = session.taskId;
  // staging 必须在镜像缓存目录之外：首次 clone / 镜像自愈会 rmSync 整个缓存目录
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), `lake-staging-${sid}-`));
  await stageInsightSession(session, prisma, path.join(stagingDir, 'sessions'), sid);
  return { stagingDir, sid };
}

// 治理 staging 内 sessions/<sid>/ 全部文件。
// 快路径（直传）：全部 .jsonl 是 .7z 且伴生 meta 声明 producer=cpx +
// governed=true（cpx 压缩时打的信任标记，spec §4.4 —— 字节流已经 cpx 落盘
// 入口 redactor 全量清洗，与治理正则 parity 锁定同源）。免解压重洗重压，
// 仅保留白名单 + 大小限检。
// 慢路径（兜底永在）：明文源 / 无标记 / 非 cpx producer（insight-export、
// native claude 等）→ 解压 → 明文治理（清洗可审计）→ 7z 压缩出仓。
function governStagedSession(stagingDir: string, sid: string): void {
  const sessionDir = path.join(stagingDir, 'sessions', sid);
  const listFiles = (): string[] => {
    const all = fs.readdirSync(sessionDir, { recursive: true, withFileTypes: true });
    const out: string[] = [];
    for (const d of all) {
      if (!d.isDirectory()) out.push(path.relative(sessionDir, path.join(d.parentPath, d.name)));
    }
    return out;
  };
  const files = listFiles();
  const unexpected = files.filter(f => !f.endsWith('.jsonl.7z') && !f.endsWith('.jsonl.gz') && !f.endsWith('.jsonl') && !f.endsWith('.json'));
  if (unexpected.length > 0) {
    throw new GovernanceError(`上传熔断：staging 存在白名单外文件（仅允许 .jsonl/.jsonl.7z/.jsonl.gz/.json）：${unexpected.join(', ')}`);
  }
  const jsonlFiles = files.filter(f => f.endsWith('.jsonl') || f.endsWith('.jsonl.7z') || f.endsWith('.jsonl.gz'));
  // meta 伴生文件是 <sid>.meta.json（staging 必备）——此前误读 <sid>.jsonl.gz
  // （gzip 二进制 JSON.parse 必败 → 快路径永假，governed 信任标记从未生效，
  // 全量走慢路径解压重洗重压；与 cpx v0.1.4 同款 bug，insight 侧补修）
  const meta = readCcSessionMeta(path.join(sessionDir, `${sid}.meta.json`));
  const fastPath = meta?.producer === 'cpx' && meta.governed === true
    && jsonlFiles.length > 0 && jsonlFiles.every(f => f.endsWith('.7z'));
  if (fastPath) {
    // 直传：大小限检按既有压缩字节
    let totalBytes = 0;
    for (const rel of jsonlFiles) totalBytes += fs.statSync(path.join(sessionDir, rel)).size;
    if (totalBytes > MAX_SESSION_BYTES.value) {
      throw new GovernanceError(`Session "${sid}" exceeds single-file size limit (${(totalBytes / 1024 / 1024).toFixed(1)}MB > ${(MAX_SESSION_BYTES.value / 1024 / 1024).toFixed(0)}MB)`);
    }
    return;
  }
  // ① 源若已压缩 → staging 内解压回明文（治理域）。压缩态不以 .jsonl
  // 结尾——后续所有 endsWith('.jsonl') 分支都只作用于明文形态。
  for (const rel of files.filter(f => f.endsWith('.7z') || f.endsWith('.gz'))) {
    decompressToPlain(path.join(sessionDir, rel));
  }
  // ② 明文治理（清洗 + 复检）—— 重新枚举：① 之后明文集合 = 全部 .jsonl
  const residues: string[] = [];
  for (const rel of listFiles().filter(f => f.endsWith('.jsonl'))) {
    const file = path.join(sessionDir, rel);
    const { output, residue } = governText(fs.readFileSync(file, 'utf8'));
    if (residue.length > 0) residues.push(...residue.map(r => `${rel}: ${r}`));
    fs.writeFileSync(file, output);
  }
  if (residues.length > 0) {
    throw new GovernanceError(`上传熔断：清洗后仍检出疑似密钥残留，已拒绝上传。检出项（值已截断）：\n${residues.slice(0, 10).join('\n')}`);
  }
  // ③ 治理通过 → 7z 压缩出仓；大小检查按压缩后字节（平台限的是传输形态）
  let totalBytes = 0;
  for (const rel of listFiles().filter(f => f.endsWith('.jsonl'))) {
    const file = path.join(sessionDir, rel);
    const z7File = compressCaptureFile(file);
    totalBytes += fs.statSync(z7File).size;
  }
  if (totalBytes > MAX_SESSION_BYTES.value) {
    throw new GovernanceError(`Session "${sid}" exceeds single-file size limit (${(totalBytes / 1024 / 1024).toFixed(1)}MB > ${(MAX_SESSION_BYTES.value / 1024 / 1024).toFixed(0)}MB，7z 压缩后仍超限)`);
  }
}

// 提交约定（mirror.parseCommitSubject 消费）：`提交人:<姓名> 内容描述:<描述>`。
// extractSubmitter 实现挪至 notes.ts（会话与 bundle 上传共用），此处经导入使用。

// 范式目录网关（与提交人同级强制）：显式给 category 时必须是数据仓现存
// 顶层目录（动态白名单，防 typo 凭空造目录）。范式注册表 = 数据仓顶层
// 目录，insight 零范式知识（sessions/ 存量区特判已退役——普通目录同待遇）。
function validateCategory(remote: LakeRemote, category?: string): string | undefined {
  const value = category?.trim() || undefined;
  // bundle 专区不是会话范式：会话上传禁止落入（bundle 目录由 bundle 通道
  // 原子管理，混入的会话目录列表不可见、永无法清理）
  if (value === BUNDLE_ROOT_DIR) throw new Error(`"${BUNDLE_ROOT_DIR}" 是 bundle 专区，不能作为会话上传目录`);
  // category 缺省落上传缺省目录（rootDir；''=仓库根根级位）
  if (value) {
    if (!/^[\w.-]+$/.test(value)) throw new Error(`Invalid paradigm dir: "${value.slice(0, 40)}"`);
    if (!listParadigmDirs(remote).includes(value)) {
      throw new Error(`范式目录 "${value}" 在数据仓中不存在：请先在数据仓新建该顶层目录后重试`);
    }
  }
  return value;
}

// 上传时补丁 meta（cc-session-meta 可选字段，spec §4.4"加可选字段不升版本"）：
// ① opGen——任务结果标注（人工勾选），列表"任务结果"列消费；
// ② 会话指标快照 startTime/endTime/durationMs/activeMs/totalTokens + 主模型
//   model——上传时刻从 DB 会话行取值，与导入后列表展示同源同值，lake
//   viewer 未导入行也能显示
//   开始/耗时/Token（含任务耗时优化图），无需先导入 insight。耗时快照
//   优先 activeMs（活跃口径，与会话详情 Wall Clock 拆分同源），durationMs
//   （墙钟）保留供回落。
//   提交人/内容描述/备注（spec §4.4 可选字段，D 根治层）——列表归属的权威
//   快照：读方 meta 优先、git log 推导回落（存量数据）。与提交信息格式
//   约定解耦后，任何后续维护提交（viewer 标记、meta 回填等）都无法污染
//   列表展示的提交人/描述
// 三条 staging 路径（cpx 伴生 meta 拷贝 / 合成 insight-upload / DB 导出
// insight-export）都落同一 meta 文件——此处一个补丁点全覆盖。
async function annotateSessionMeta(
  stagingDir: string, sid: string, session: SessionRow, prisma: PrismaLike,
  opGen?: 'success' | 'failure',
  submit?: SessionSubmitInfo,
): Promise<void> {
  const metaPath = path.join(stagingDir, 'sessions', sid, `${sid}.meta.json`);
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    const xb = readEnvelope(meta);
    if (xb?.schema !== 'cc-session-meta' || !xb.data || typeof xb.data !== 'object') return;
    if (opGen === 'success' || opGen === 'failure') xb.data.opGen = opGen;
    // 提交信息快照：与 commit message 同源同值（parseSubmitInfo 同一套标签
    // 解析），空字段不落键。author ↔ meta 字段名 submitter
    if (submit?.author) xb.data.submitter = submit.author;
    if (submit?.description) xb.data.description = submit.description;
    if (submit?.remark) xb.data.remark = submit.remark;
    const start = session.startTime instanceof Date ? session.startTime : null;
    const end = session.endTime instanceof Date ? session.endTime : null;
    if (start) {
      xb.data.startTime = start.toISOString();
      if (end && end.getTime() > start.getTime()) {
        xb.data.endTime = end.toISOString();
        xb.data.durationMs = end.getTime() - start.getTime();
      }
    }
    // 活跃时长快照：与会话详情 Wall Clock 拆分同口径（wire 调用区间展开 +
    // 5min 阈值聚类）；无 turns 留空，读方回落墙钟
    try {
      const split = await computeSessionActiveSplit(
        () => prisma.turn.findMany({
          where: { sessionId: session.id },
          select: { createdAt_ts: true, createdAt: true, latencyMs: true, role: true },
        }),
        start ? start.getTime() : 0,
        end ? end.getTime() : null,
        isProxyVersion(session.version),
      );
      if (split != null) xb.data.activeMs = split.activeMs;
    } catch { /* turns 查询失败：跳过 activeMs，不阻断上传 */ }
    if (Number.isFinite(session.totalTokens)) xb.data.totalTokens = session.totalTokens;
    if (typeof session.model === 'string' && session.model) xb.data.model = session.model;
    // 双名对称写回（setOpGen 同款）：此前仅胜出键被更新，另一键留旧值
    Object.assign(meta, envelopeFields(xb));
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
  } catch { /* meta 缺失/畸形：跳过标注，不阻断上传 */ }
}

export async function uploadLakeSession(
  prisma: PrismaLike,
  taskId: string,
  description?: string,
  remote?: LakeRemote,
  category?: string,
  baseline?: boolean,
  opGen?: 'success' | 'failure',
  // 同 sid 双行（方案一）消歧：从捕获行页面上传必须带 framework 定行，
  // 否则裸 taskId findFirst 可能命中另一行（原生会话）——把错误数据传到
  // 共享数据仓；缺省回落单行解析（CLI/测试等单行场景）
  framework?: string | null,
): Promise<UploadResult & { sid: string }> {
  if (!/^[\w.-]+$/.test(taskId)) throw new Error(`Invalid session id: "${taskId}"`);
  const { submitter, error: submitterError } = extractSubmitter(description);
  if (submitterError) throw new Error(submitterError);
  const rem = remote ?? defaultLakeRemote();
  // https 远端推送凭据前置检查（本地 bare 测试远端不受影响）：无凭据直接
  // fail-fast 给配置指引——放行到 git push 只会在 401/终端提示上挂死，且
  // staging/治理全成白工
  requirePushCredentials(rem.pushUrl, rem.pushAuth);
  // baseline（范式基准会话）：仅默认仓且必须选中范式；位置即身份 —— 勾选即
  // 换（新会话进 <paradigm>/baseline/，原 baseline 会话同 commit 移回范式
  // 普通目录），无确认标记，远端现状即唯一事实源
  if (baseline && !category?.trim()) {
    throw new Error('baseline 上传必须选中范式目录');
  }
  const categoryValue = validateCategory(rem, category);
  const session = await prisma.session.findFirst({
    where: framework ? { taskId, framework } : { taskId },
  }) as SessionRow | null;
  if (!session) throw new Error(`Session not found: "${taskId}"`);

  // 记录类（同 sid 双记录·lake 侧）：wire 捕获行（version 带 -proxy 或
  // framework 带 -proxy 后缀）落裸 <sid>/（cpx 直传/存量数据零迁移）；
  // 其余（claude/opencode 原生行、insight 导出行）一律落 <sid>.native/——
  // 同 sid 的捕获与原生两份记录并存，互不覆盖
  const recording: RecordingClass =
    isProxyVersion(session.version) || session.framework?.endsWith('-proxy') ? 'capture' : 'native';

  const { stagingDir, sid } = await stageSessionFiles(session, prisma);
  try {
    // 提交信息快照与 commit message 同源：一次解析两处消费（meta 权威字段
    // + git log 人类可读）
    const submit = parseSubmitInfo(description ?? null);
    await annotateSessionMeta(stagingDir, sid, session, prisma, opGen, submit);
    governStagedSession(stagingDir, sid);
    // 范式行由服务端从结构化字段注入（git log 人类可读；列表 paradigm 以目录
    // 为准）。必须放在空行后的 body：git %s 会把 subject 折叠成单行，混进
    // subject 会污染 parseCommitSubject 的 description 提取
    const commitMessage = description!.trim() + (categoryValue ? `\n\n范式: ${categoryValue}${baseline ? '（baseline）' : ''}` : '');
    const tUp = Date.now();
    const result = await uploadFolder(stagingDir, sid, commitMessage, rem, categoryValue, baseline, recording);
    lakeLog.info('upload done', { sid, recording, category: categoryValue, baseline: baseline ?? false, submitter, unchanged: result.unchanged, ms: Date.now() - tUp });
    return { ...result, sid };
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

// ── 原生会话同步上传（组合层）─────────────────────────────────────────
// uploadLakeSession 是单会话上传原语；这里在它之上组合「捕获 + 原生」对位
// 上传：捕获行上传成功后解析原生对位（native-counterpart：DB 直查 → 磁盘
// 发现），磁盘命中的先导入 insight（幂等 merge，复用全部装配/治理），再以
// 原生行自己的 taskId/framework 走同一原语——同 sid 框架落 <sid>.native/，
// codex（原生 sid ≠ 捕获 sid）落 <uuid>.native/。捕获上传不因原生失败回滚，
// 原生结果独立上报（uploaded / not-found / failed）。
export interface NativeUploadOutcome {
  status: 'uploaded' | 'not-found' | 'failed';
  sid?: string;
  folder?: string;
  reason?: string;
}

export interface UploadSessionPairOptions {
  description?: string;
  category?: string;
  baseline?: boolean;
  opGen?: 'success' | 'failure';
  framework?: string | null;
  withNative?: boolean;
  // 测试注入：磁盘发现根目录（缺省本机默认根）
  nativeRoots?: NativeDiscoveryRoots;
}

export async function uploadLakeSessionWithNative(
  prisma: PrismaLike,
  taskId: string,
  opts: UploadSessionPairOptions = {},
  remote?: LakeRemote,
): Promise<UploadResult & { sid: string; native?: NativeUploadOutcome }> {
  const result = await uploadLakeSession(
    prisma, taskId, opts.description, remote, opts.category, opts.baseline, opts.opGen, opts.framework,
  );
  if (!opts.withNative) return result;
  const native = await uploadNativeCounterpart(prisma, taskId, opts, remote);
  return { ...result, native };
}

async function uploadNativeCounterpart(
  prisma: PrismaLike,
  taskId: string,
  opts: UploadSessionPairOptions,
  remote?: LakeRemote,
): Promise<NativeUploadOutcome> {
  try {
    const capture = await prisma.session.findFirst({
      where: opts.framework ? { taskId, framework: opts.framework } : { taskId },
      select: { taskId: true, framework: true, version: true, startTime: true, endTime: true, query: true },
    }) as { taskId: string; framework: string; version: string | null; startTime: Date; endTime: Date | null; query: string | null } | null;
    if (!capture) return { status: 'failed', reason: `Session not found: "${taskId}"` };
    if (!(isProxyVersion(capture.version) || capture.framework.endsWith('-proxy'))) {
      return { status: 'not-found', reason: '仅 wire 捕获会话支持同步上传原生会话' };
    }
    const resolution = await resolveNativeCounterpart(
      prisma,
      {
        taskId: capture.taskId,
        framework: capture.framework,
        startTime: capture.startTime ?? null,
        endTime: capture.endTime ?? null,
        query: capture.query ?? null,
      },
      opts.nativeRoots ?? defaultNativeDiscoveryRoots(),
    );
    if (resolution.status === 'not-found') return { status: 'not-found', reason: resolution.reason };

    let nativeTaskId: string;
    let nativeFramework: string;
    if (resolution.origin === 'disk') {
      // 磁盘命中先导入（幂等 merge）：行身份以导入结果为准（源描述符决定
      // framework），不假设与捕获行的 agent 框架一致
      await importSession(resolution.hit.path, resolution.hit.sessionId, prisma, resolution.hit.path, resolution.hit.sourceType);
      const row = await prisma.session.findFirst({
        where: { taskId: resolution.hit.sessionId },
        select: { taskId: true, framework: true },
      });
      if (!row) return { status: 'failed', reason: `原生会话导入未建行: ${resolution.hit.sessionId}` };
      nativeTaskId = row.taskId;
      nativeFramework = row.framework;
    } else {
      nativeTaskId = resolution.taskId;
      nativeFramework = resolution.framework;
    }
    // framework 必传：同 sid 双行下裸 taskId findFirst 会命中捕获行自己
    const nativeResult = await uploadLakeSession(
      prisma, nativeTaskId, opts.description, remote, opts.category, opts.baseline, opts.opGen, nativeFramework,
    );
    lakeLog.info('native counterpart uploaded', { captureSid: capture.taskId, nativeSid: nativeResult.sid });
    return { status: 'uploaded', sid: nativeResult.sid, folder: nativeResult.folder };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    lakeLog.warn('native counterpart upload failed', { captureSid: taskId, error: reason });
    return { status: 'failed', reason };
  }
}
