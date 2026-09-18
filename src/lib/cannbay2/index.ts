// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// cannbay2 编排层（route 唯一入口）：list / import / upload。
// 上传数据流：源（proxy 捕获 / native claude jsonl 原文件 / opencode DB 导出）
// → staging → 治理（清洗 + 复检熔断，governance.ts）→ mirror.uploadFolder。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { listSessions, listOverview, materializeSession, uploadFolder, listParadigmDirs, type Cannbay2Remote, type Cannbay2SessionEntry, type Cannbay2Overview, type UploadResult } from './mirror';
import { readCcSessionMeta } from '../ingest/proxy-classify';
import { isProxyVersion } from '../shared/session-format';
import { defaultCannbay2Remote } from './remote';
import { governText } from './governance';
import { exportSessionToClaudeJsonl, xCannbay } from './export';
import { importSession } from '@/lib/ingest/data-service';
import type { PrismaClient } from '@prisma/client';

export type { Cannbay2SessionEntry, Cannbay2Overview };

// atomgit 单文件上限兜底（按压缩后字节）。导出为可变引用（测试注入小阈值
// 验证熔断路径）；生产初值可经 env CANNBAY2_MAX_SESSION_MB 覆写（LFS 模式
// 下平台限制在 LFS 对象侧，git blob 的 100MiB 钳制不再适用）
export const MAX_SESSION_BYTES = { value: (() => {
  const v = Number(process.env.CANNBAY2_MAX_SESSION_MB);
  return Number.isFinite(v) && v > 0 ? Math.floor(v * 1024 * 1024) : 100 * 1024 * 1024;
})() };

export class GovernanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GovernanceError';
  }
}

type PrismaLike = PrismaClient;

export function listCannbay2Sessions(remote?: Cannbay2Remote): Cannbay2SessionEntry[] {
  return listSessions(remote);
}

/** 列表 + 顶层目录合并读取（单轮 mirror fetch 服务导入对话框的范式下拉+会话表）。 */
export function listCannbay2Overview(remote?: Cannbay2Remote): Cannbay2Overview {
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

export async function importCannbay2Session(sid: string, prisma: PrismaLike, remote?: Cannbay2Remote) {
  const mainJsonl = materializeSession(sid, remote);
  const result = await importSession(mainJsonl, sid, prisma, mainJsonl, 'claude-jsonl');
  // x_cannbay 补列（docs/cannbay-schema-spec.md）：核心管线无通道、只存在于
  // 声明里的列（Turn.ttftMs/temperature/maxTokens/modelId/providerId、
  // ToolCall.errorType/errorMessage/durationMs/startedAt、Session.framework/
  // version）在 cannbay2 编排层恢复 —— 核心红线不动。补列/回读都按
  // result.sessionId（行 id）定位，同 sid 双行不串行
  await patchXCannbayColumns(mainJsonl, result.sessionId, prisma).catch(() => { /* 补列失败不阻塞导入 */ });
  return { ...result, ...(await readSessionType(prisma, result.sessionId)) };
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
async function patchXCannbayColumns(mainJsonl: string, sessionRowId: string, prisma: PrismaLike): Promise<void> {
  const sid = path.basename(mainJsonl, '.jsonl');
  const fileGroups: Array<{ subId: string | null; payloads: DbTurnPayload[] }> = [];
  const collect = (file: string, subId: string | null): void => {
    // .jsonl.gz（物化压缩件）/ .jsonl（旧明文仓件）双形态
    let text: string | null = null;
    if (fs.existsSync(file)) text = fs.readFileSync(file, 'utf8');
    else if (fs.existsSync(`${file}.gz`)) text = zlib.gunzipSync(fs.readFileSync(`${file}.gz`)).toString('utf8');
    if (text == null) return;
    const payloads: DbTurnPayload[] = [];
    for (const ln of text.split('\n')) {
      if (!ln.trim()) continue;
      try {
        const xb = (JSON.parse(ln) as { x_cannbay?: { schema?: string; data?: DbTurnPayload } }).x_cannbay;
        if (xb?.schema === 'cc-db-turn' && xb.data) payloads.push(xb.data);
      } catch { /* 截断行跳过 */ }
    }
    if (payloads.length > 0) fileGroups.push({ subId, payloads });
  };
  collect(mainJsonl, null);
  const subagentsDir = path.join(path.dirname(mainJsonl), sid, 'subagents');
  if (fs.existsSync(subagentsDir)) {
    for (const entry of fs.readdirSync(subagentsDir, { withFileTypes: true })) {
      if (entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.gz'))) {
        collect(path.join(subagentsDir, entry.name), entry.name.replace(/\.jsonl(\.gz)?$/, ''));
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

interface SessionRow {
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

// 收集待传文件到 staging 的 sessions/<sid>/ 布局，返回 staging 根目录。
// - sourcePath 是本机存在的 jsonl（proxy 捕获 / native claude）：原文件直传，
//   subagents 在 <dirname>/<fileSid>/subagents/（proxy 落盘约定）
// - 其余一律 DB 导出兜底：opencode（无捕获文件）、v1 数据仓下载的 .db 快照
//   会话（sourcePath 是 .db）、源文件已被删除/移动的会话。导出件不含
//   Full Context（system/tools），管线数据齐全。
async function stageSessionFiles(session: SessionRow, prisma: PrismaLike): Promise<{ stagingDir: string; sid: string }> {
  const sid = session.taskId;
  // staging 必须在镜像缓存目录之外：首次 clone / 镜像自愈会 rmSync 整个缓存目录
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), `cannbay2-staging-${sid}-`));
  const sessionDir = path.join(stagingDir, 'sessions', sid);
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(sessionDir, { recursive: true });

  // 原文件直传条件：sourcePath 是本机存在的 jsonl（明文或 .gz）且非 native
  // opencode（native opencode 的 sourcePath 是 .db / 目录约定）。proxy 捕获的
  // opencode 会话（framework=opencode + version 带 -proxy）是 jsonl，直传。
  // 源可以已是压缩态（cpx 退出即压，proxy/COMPRESSION-DESIGN.md）——staging
  // 保持源形态拷贝，governStagedSession 统一解压到明文域治理后再压回。
  const sourceResolved = session.sourcePath
    ? (fs.existsSync(session.sourcePath) ? session.sourcePath
      : fs.existsSync(`${session.sourcePath}.gz`) ? `${session.sourcePath}.gz` : null)
    : null;
  const hasJsonlSource = (session.framework !== 'opencode' || isProxyVersion(session.version))
    && !!sourceResolved
    && (sourceResolved.endsWith('.jsonl') || sourceResolved.endsWith('.jsonl.gz'));
  if (hasJsonlSource) {
    fs.copyFileSync(sourceResolved!, path.join(sessionDir, `${sid}${sourceResolved!.endsWith('.gz') ? '.jsonl.gz' : '.jsonl'}`));
    // writer 落盘约定（writer.ts）：主捕获带 cpx- 前缀、伴生 meta 与子代理目录
    // 用裸 sid。sourcePath 可能是任一形态（直捕 cpx-<sid>.jsonl[.gz] / norm
    // <sid>.jsonl[.gz]），统一剥前缀/后缀后定位伴生文件。注意 basename 的
    // 后缀参数是逐字匹配——先剥 .gz 再剥 .jsonl，不能一次传 '.jsonl.gz'。
    const fileSid = path.basename(sourceResolved!.replace(/\.gz$/, ''), '.jsonl').replace(/^cpx-/, '');
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
          x_cannbay: xCannbay('cc-session-meta', {
            producer: 'insight-upload',
            framework: session.framework,
            ccVersion: session.version ?? undefined,
            sid,
          }),
        }, null, 2) + '\n',
      );
    }
    // subagents 随行：裸 sid 目录（<proxy>/<sid>/subagents/，见上方 fileSid 注释）。
    // 白名单拷贝：只带 .jsonl/.jsonl.gz/.json —— 捕获目录里的杂散文件
    // （.txt/.log/.env…）不清洗也不该出公开仓
    const subagentsDir = path.join(path.dirname(sourceResolved!), fileSid, 'subagents');
    if (fs.existsSync(subagentsDir)) {
      const dest = path.join(sessionDir, 'subagents');
      fs.mkdirSync(dest, { recursive: true });
      for (const entry of fs.readdirSync(subagentsDir, { withFileTypes: true })) {
        if (entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.gz') || entry.name.endsWith('.json'))) {
          fs.copyFileSync(path.join(subagentsDir, entry.name), path.join(dest, entry.name));
        }
      }
    }
  } else {
    const written = await exportSessionToClaudeJsonl(prisma, session.taskId, stagingDir);
    const mainFile = path.join(stagingDir, 'sessions', sid, `${sid}.jsonl`);
    if (!written.includes(path.posix.join('sessions', sid, `${sid}.jsonl`)) || fs.statSync(mainFile).size === 0) {
      throw new Error(`Session "${sid}" has no uploadable content (no local jsonl source, DB export empty)`);
    }
  }
  return { stagingDir, sid };
}

// 治理 staging 内 sessions/<sid>/ 全部文件。
// 快路径（直传）：全部 .jsonl 是 .gz 且伴生 meta 声明 producer=cpx +
// governed=true（cpx 压缩时打的信任标记，spec §4.4 —— 字节流已经 cpx 落盘
// 咽喉 redactor 全量清洗，与治理正则 parity 锁定同源）。免解压重洗重压，
// 仅保留白名单 + 大小限检。
// 慢路径（兜底永在）：明文源 / 无标记 / 非 cpx producer（insight-export、
// native claude 等）→ 解压 → 明文治理（清洗可审计）→ 压缩出仓。
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
  const unexpected = files.filter(f => !f.endsWith('.jsonl.gz') && !f.endsWith('.jsonl') && !f.endsWith('.json'));
  if (unexpected.length > 0) {
    throw new GovernanceError(`上传熔断：staging 存在白名单外文件（仅允许 .jsonl/.jsonl.gz/.json）：${unexpected.join(', ')}`);
  }
  const jsonlFiles = files.filter(f => f.endsWith('.jsonl') || f.endsWith('.jsonl.gz'));
  const meta = readCcSessionMeta(path.join(sessionDir, `${sid}.jsonl.gz`));
  const fastPath = meta?.producer === 'cpx' && meta.governed === true
    && jsonlFiles.length > 0 && jsonlFiles.every(f => f.endsWith('.jsonl.gz'));
  if (fastPath) {
    // 直传：大小限检按既有压缩字节
    let totalBytes = 0;
    for (const rel of jsonlFiles) totalBytes += fs.statSync(path.join(sessionDir, rel)).size;
    if (totalBytes > MAX_SESSION_BYTES.value) {
      throw new GovernanceError(`Session "${sid}" exceeds single-file size limit (${(totalBytes / 1024 / 1024).toFixed(1)}MB > ${(MAX_SESSION_BYTES.value / 1024 / 1024).toFixed(0)}MB)`);
    }
    return;
  }
  // ① 源若已压缩 → staging 内解压回明文（治理域）。.jsonl.gz 不以 .jsonl
  // 结尾——后续所有 endsWith('.jsonl') 分支都只作用于明文形态。
  for (const rel of files.filter(f => f.endsWith('.jsonl.gz'))) {
    const file = path.join(sessionDir, rel);
    fs.writeFileSync(file.replace(/\.gz$/, ''), zlib.gunzipSync(fs.readFileSync(file)));
    fs.rmSync(file);
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
  // ③ 治理通过 → 压缩出仓；大小检查按压缩后字节（atomgit 限的是传输形态）
  let totalBytes = 0;
  for (const rel of listFiles().filter(f => f.endsWith('.jsonl'))) {
    const file = path.join(sessionDir, rel);
    const gzFile = `${file}.gz`;
    fs.writeFileSync(gzFile, zlib.gzipSync(fs.readFileSync(file)));
    fs.rmSync(file);
    totalBytes += fs.statSync(gzFile).size;
  }
  if (totalBytes > MAX_SESSION_BYTES.value) {
    throw new GovernanceError(`Session "${sid}" exceeds single-file size limit (${(totalBytes / 1024 / 1024).toFixed(1)}MB > ${(MAX_SESSION_BYTES.value / 1024 / 1024).toFixed(0)}MB，gzip 压缩后仍超限)`);
  }
}

// 提交约定（mirror.parseCommitSubject 消费）：`提交人:<姓名> 内容描述:<描述>`。// 提交人强制非空 —— 空提交人的 commit author 会顶替为机器身份 cannbot-insight，
// 列表"用户名"列失真。网关层校验，Web/CLI/TUI 三端统一拦截。
// 行内匹配：\s* 不跨行（\s 含 \n 会让"提交人:\n内容描述:x"吃下一行冒名通过）
export function extractSubmitter(description: string | undefined): { submitter: string; error: string | null } {
  const m = (description ?? '').match(/提交人[ \t]*[:：][ \t]*(.*)/);
  const submitter = m ? m[1].trim() : '';
  if (!submitter) {
    return { submitter: '', error: '提交人不能为空：请在提交信息中填写「提交人: <姓名>」（如「提交人: 张三」），不能使用默认值' };
  }
  return { submitter, error: null };
}

// 范式目录网关（与提交人同级强制）：多根远端（默认仓）必填 category 且必须
// 是数据仓现存顶层目录（动态白名单，防 typo 凭空造目录）；单根远端（自定义
// 数据湖）不启用范式目录。范式注册表 = 数据仓顶层目录，insight 零范式知识。
function validateCategory(remote: Cannbay2Remote, category?: string): string | undefined {
  const value = category?.trim() || undefined;
  if (remote.paradigmRoots) {
    if (!value) {
      throw new Error('范式目录必填：请选择上传目标范式目录（数据仓顶层目录，新增范式请先在数据仓建目录）');
    }
    if (!/^[\w.-]+$/.test(value)) throw new Error(`Invalid paradigm dir: "${value.slice(0, 40)}"`);
    if (value === remote.rootDir) throw new Error(`"${value}" 是存量会话区，不能作为范式目录`);
    if (!listParadigmDirs(remote).includes(value)) {
      throw new Error(`范式目录 "${value}" 在数据仓中不存在：请先在数据仓新建该顶层目录后重试`);
    }
  } else if (value) {
    throw new Error('自定义数据湖远端不支持范式目录上传（范式目录仅对默认仓启用）');
  }
  return value;
}

// 上传时补丁 meta（cc-session-meta 可选字段，spec §4.4"加可选字段不升版本"）：
// ① opGen——算子生成结果标注（人工勾选），列表"算子生成"列消费；
// ② 会话指标快照 startTime/endTime/durationMs/totalTokens + 主模型 model——
//   上传时刻从 DB 会话行取值，与导入后列表展示同源同值，cannbay viewer
//   未导入行也能显示
//   开始/耗时/Token（含算子生成耗时优化图），无需先导入 insight。
// 三条 staging 路径（cpx 伴生 meta 拷贝 / 合成 insight-upload / DB 导出
// insight-export）都落同一 meta 文件——此处一个补丁点全覆盖。
function annotateSessionMeta(stagingDir: string, sid: string, session: SessionRow, opGen?: 'success' | 'failure'): void {
  const metaPath = path.join(stagingDir, 'sessions', sid, `${sid}.meta.json`);
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    const xb = meta?.x_cannbay;
    if (xb?.schema !== 'cc-session-meta' || !xb.data || typeof xb.data !== 'object') return;
    if (opGen === 'success' || opGen === 'failure') xb.data.opGen = opGen;
    const start = session.startTime instanceof Date ? session.startTime : null;
    const end = session.endTime instanceof Date ? session.endTime : null;
    if (start) {
      xb.data.startTime = start.toISOString();
      if (end && end.getTime() > start.getTime()) {
        xb.data.endTime = end.toISOString();
        xb.data.durationMs = end.getTime() - start.getTime();
      }
    }
    if (Number.isFinite(session.totalTokens)) xb.data.totalTokens = session.totalTokens;
    if (typeof session.model === 'string' && session.model) xb.data.model = session.model;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
  } catch { /* meta 缺失/畸形：跳过标注，不阻断上传 */ }
}

export async function uploadCannbay2Session(
  prisma: PrismaLike,
  taskId: string,
  description?: string,
  remote?: Cannbay2Remote,
  category?: string,
  baseline?: boolean,
  opGen?: 'success' | 'failure',
  // 同 sid 双行（方案一）消歧：从捕获行页面上传必须带 framework 定行，
  // 否则裸 taskId findFirst 可能命中另一行（原生会话）——把错误数据传到
  // 共享数据仓；缺省回落单行解析（CLI/测试等单行场景）
  framework?: string | null,
): Promise<UploadResult & { sid: string }> {
  if (!/^[\w.-]+$/.test(taskId)) throw new Error(`Invalid session id: "${taskId}"`);
  const { error: submitterError } = extractSubmitter(description);
  if (submitterError) throw new Error(submitterError);
  const rem = remote ?? defaultCannbay2Remote();
  // baseline（范式基准会话）：仅默认仓且必须选中范式；位置即身份 —— 勾选即
  // 换（新会话进 <paradigm>/baseline/，原 baseline 会话同 commit 移回范式
  // 普通目录），无确认标记，远端现状即唯一事实源
  if (baseline && (!rem.paradigmRoots || !category?.trim())) {
    throw new Error('baseline 上传仅在默认仓且选中范式目录时可用');
  }
  const categoryValue = validateCategory(rem, category);
  const session = await prisma.session.findFirst({
    where: framework ? { taskId, framework } : { taskId },
  }) as SessionRow | null;
  if (!session) throw new Error(`Session not found: "${taskId}"`);

  const { stagingDir, sid } = await stageSessionFiles(session, prisma);
  try {
    annotateSessionMeta(stagingDir, sid, session, opGen);
    governStagedSession(stagingDir, sid);
    // 范式行由服务端从结构化字段注入（git log 人类可读；列表 paradigm 以目录
    // 为准）。必须放在空行后的 body：git %s 会把 subject 折叠成单行，混进
    // subject 会污染 parseCommitSubject 的 description 提取
    const commitMessage = description!.trim() + (categoryValue ? `\n\n范式: ${categoryValue}${baseline ? '（baseline）' : ''}` : '');
    const result = await uploadFolder(stagingDir, sid, commitMessage, rem, categoryValue, baseline);
    return { ...result, sid };
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}
