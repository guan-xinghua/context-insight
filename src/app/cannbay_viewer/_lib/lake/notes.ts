// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 实验记录（notes）：会话级实验备注，存数据湖而非本地——<paradigm>/[baseline/]
// <sid>/<sid>.notes.jsonl，一行一条类型化记录，只追加不改写：
//   {"ts","type":"note","text"}
//   {"ts","type":"scorecard","totalScore","dimensions":[{dimensionId,name,score}],"computedAt"}
// 记录类型可扩展（后续评价维度/对比结论等直接加 type）——解析端未知 type 跳过，
// 旧版 viewer 不炸（与 cannbay-schema-spec 声明式分发同思路）。.notes 前缀与
// 捕获文件 <sid>.jsonl[.gz] 命名空间区分。读 = git show 按需拉单个 blob
// （partial clone）；追加 = temp index plumbing（read-tree → hash-object →
// update-index → write-tree → commit-tree → push）全程不 checkout——窄检出会把
// 会话目录里的大捕获 blob 一并物化，违背按需原则。跨机/跨进程竞态由 push 被拒
// → 重新 fetch 换父提交重试兜底（与 cpx uploadFolder 同思路，§10-2 先冗余后收敛）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureMirrorAsync, markLakePhase, resolveLakeRemote, revParseMain, runGit, runGitAsync, sessionFolderName } from './mirror';
import { redactLakeSecrets } from './remote';
import type { LakeRemote } from './remote';

export interface NoteEntry { ts: string; type: 'note'; text: string }

export interface ScorecardEntry {
  ts: string;
  type: 'scorecard';
  totalScore: number | null;
  dimensions: Array<{ dimensionId: string; name: string; score: number | null }>;
  computedAt: string;
}

export type LakeRecord = NoteEntry | ScorecardEntry

/** 会话提交信息：上传时人工填写、落在该会话目录最后触碰 commit 的 message 里 */
export interface SessionSubmitInfo { author: string | null; description: string | null; remark: string | null }

/** 记录定位：recording 缺省 capture（存量兼容）；native 会话的记录落在
 *  <sid>.native/ 目录内——写错位会在裸目录制造幻影会话条目。 */
export interface SessionLoc { sid: string; paradigm: string; isBaseline: boolean; recording?: 'capture' | 'native' }

const MAX_NOTE_CHARS = 10_000;
const PUSH_RETRIES = 3;

function validateSegment(kind: string, v: string): string {
  if (!/^[\w.-]+$/.test(v)) throw new Error(`无效${kind}: "${v.slice(0, 40)}"`);
  return v;
}

function sessionDir(s: SessionLoc): string {
  const folder = sessionFolderName(validateSegment('会话 id', s.sid), s.recording ?? 'capture');
  return `${validateSegment('范式目录', s.paradigm)}/${s.isBaseline ? 'baseline/' : ''}${folder}`;
}

export function notesPath(s: SessionLoc): string {
  return `${sessionDir(s)}/${s.sid}.notes.jsonl`;
}

/** 会话 meta（x_cannbay envelope）——opGen 等上传时标注落在这里 */
export function metaPath(s: SessionLoc): string {
  return `${sessionDir(s)}/${s.sid}.meta.json`;
}

// spawn 数组参数（无 shell 拼接面）；stdio 全 pipe，stdout 拿回内容。
// 按需拉 blob 可能秒级（劣化链路更久），必须异步等 close，绝不 execSync。
interface GitCapture { code: number | null; out: string; err: string }

function captureGitAsync(dir: string, args: string[], timeoutMs = 120_000): Promise<GitCapture> {
  return new Promise(resolve => {
    const child = spawn('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => errChunks.push(c));
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, out: Buffer.concat(chunks).toString('utf8'), err: Buffer.concat(errChunks).toString('utf8') });
    });
    child.on('error', () => { clearTimeout(timer); resolve({ code: null, out: '', err: 'spawn failed' }); });
  });
}

const ABSENT_HINT = /exists on disk, but not in|does not exist|path .* does not exist/i;

/**
 * 读湖内单文件内容；**只在路径确实不存在时返回 null**。blob 按需拉取的
 * 瞬态失败（超时 SIGKILL / 网络断 / spawn 失败）必须抛错——写路径把 null
 * 当「文件不存在」处理，误吞瞬态失败会让 append 只带新记录、抹掉全部历史。
 */
async function showFile(dir: string, refPath: string): Promise<string | null> {
  const r = await captureGitAsync(dir, ['-c', 'filter.lfs.process=', '-c', 'filter.lfs.smudge=cat', '-c', 'filter.lfs.clean=cat', '-c', 'filter.lfs.required=false', 'show', refPath]);
  if (r.code === 0) return r.out;
  if (ABSENT_HINT.test(r.err)) return null;
  throw new Error(`git show 失败（exit ${r.code}）：${r.err.slice(0, 200).trim() || '无 stderr'}`);
}

function parseRecord(raw: string): LakeRecord | null {
  let v: Record<string, unknown>;
  try { v = JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
  if (typeof v.ts !== 'string') return null;
  if (v.type === 'note' && typeof v.text === 'string') return { ts: v.ts, type: 'note', text: v.text };
  if (v.type === 'scorecard' && Array.isArray(v.dimensions)) {
    const dims = v.dimensions
      .filter((d): d is Record<string, unknown> => typeof d === 'object' && d !== null)
      .map(d => ({
        dimensionId: String(d.dimensionId ?? ''),
        name: String(d.name ?? ''),
        score: typeof d.score === 'number' ? d.score : null,
      }));
    return {
      ts: v.ts,
      type: 'scorecard',
      totalScore: typeof v.totalScore === 'number' ? v.totalScore : null,
      dimensions: dims,
      computedAt: typeof v.computedAt === 'string' ? v.computedAt : '',
    };
  }
  return null; // 未知记录类型：前向兼容跳过
}

export function parseRecords(content: string | null): LakeRecord[] {
  if (!content) return [];
  const out: LakeRecord[] = [];
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const rec = parseRecord(t);
    if (rec) out.push(rec);
  }
  return out;
}

export async function readRecords(s: SessionLoc, remote: LakeRemote = resolveLakeRemote()): Promise<LakeRecord[]> {
  const dir = await ensureMirrorAsync(remote);
  return parseRecords(await showFile(dir, `origin/${remote.branch}:${notesPath(s)}`));
}

// 提交信息字段以「下一标签或行尾」为界（格式：提交人: X 内容描述: Y 日志路径: Z 备注: W 框架/时间…）。
// 冒号认半角/全角两种形态（[:：]）——上传端校验与 cannbay2 的 parseCommitSubject
// 同口径，只认半角会把全角冒号上传的行解析成 null（描述/作者列显示 —）
const SUBMIT_LABELS = ['提交人', '内容描述', '日志路径', '备注', '框架', '时间'];

export function parseSubmitInfo(msg: string | null): SessionSubmitInfo {
  const empty: SessionSubmitInfo = { author: null, description: null, remark: null };
  if (!msg) return empty;
  const pick = (label: string): string | null => {
    const next = SUBMIT_LABELS.filter(l => l !== label).map(l => `${l}[:：]`).join('|');
    const m = msg.match(new RegExp(`${label}[:：]\\s*([^\\n]*?)(?=\\s*(?:${next})|$)`));
    return m ? (m[1].trim() || null) : null;
  };
  return { author: pick('提交人'), description: pick('内容描述'), remark: pick('备注') };
}

export async function readSubmitInfo(s: SessionLoc, remote: LakeRemote = resolveLakeRemote()): Promise<SessionSubmitInfo> {
  const dir = await ensureMirrorAsync(remote);
  // log 新→旧持续覆写 → 留存最老一条非 viewer 提交 = 当前位置的首传（与
  // readLakeSessions 归属同口径）：普通「提交人: …」格式的维护提交（meta
  // 指标回填、baseline 搬移）不该顶掉上传时填的提交人/内容描述
  const r = await captureGitAsync(dir, ['-c', 'core.quotepath=off', 'log', '--format=%x00%B', `origin/${remote.branch}`, '--', sessionDir(s)]);
  if (r.code !== 0) return parseSubmitInfo(null); // 降级为空提交信息，不拖垮面板
  let oldest = '';
  for (const message of r.out.split('\0')) {
    const t = message.trim();
    if (!t || t.startsWith('notes(viewer):')) continue;
    oldest = t;
  }
  return parseSubmitInfo(oldest || null);
}

// 进程内写串行：plumbing 读改写同 blob，并发 append 会互相丢行；跨机竞态走 push 重试
let writeQueue: Promise<unknown> = Promise.resolve();

/**
 * 401 挑战-应答式 push（与 cannbay2 pushMirror 同方案）：pushUrl 一律无凭据，
 * 凭据经一次性 credential helper 供给——atomgit 网关已拒"请求直带密码"的内嵌
 * URL（proactive Basic 直接拒；同凭据经 401 挑战后重试可通过，2026-09-14
 * 实测）。helper 脚本只落 0700 临时目录、用后即删，凭据不进命令行（失败消息
 * 不含凭据）。`-c credential.helper=` 先清空继承链（全局 store 等），保证显式
 * 凭据确定性生效。pushAuth=null（本地 bare / 匿名推）直推。
 */
async function pushLakeAsync(dir: string, remote: LakeRemote, commit: string): Promise<number> {
  const refspec = `${commit}:refs/heads/${remote.branch}`;
  if (!remote.pushAuth) {
    return runGitAsync(`git push --no-verify "${remote.pushUrl}" ${refspec}`, dir, 300_000);
  }
  const { username, password } = remote.pushAuth;
  if (/[\r\n]/.test(username) || /[\r\n]/.test(password)) {
    throw new Error('push 凭据含换行符（credential helper 协议非法）');
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cannbay-viewer-auth-'));
  try {
    const helper = path.join(tmp, 'helper.sh');
    fs.writeFileSync(
      helper,
      `#!/bin/sh\ncat <<'VIEWEREOF'\nusername=${username}\npassword=${password}\nVIEWEREOF\n`,
      { mode: 0o700 },
    );
    return await runGitAsync(
      `git -c credential.helper= -c credential.helper="${helper}" push --no-verify "${remote.pushUrl}" ${refspec}`,
      dir, 300_000,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** 前置条件失配（待改记录不存在/已被并发修改）——路由层映射 409 */
export class NotesConflictError extends Error {}

function validateNoteText(text: string): string {
  const t = text.trim();
  if (!t) throw new Error('记录内容不能为空');
  if (t.length > MAX_NOTE_CHARS) throw new Error(`记录过长（>${MAX_NOTE_CHARS} 字符）`);
  return t;
}

export async function appendNote(s: SessionLoc, text: string, remote: LakeRemote = resolveLakeRemote()): Promise<LakeRecord[]> {
  const t = validateNoteText(text);
  const content = await enqueueWrite(s, notesPath(s), remote, old => {
    const base = old ? (old.endsWith('\n') ? old : `${old}\n`) : '';
    return `${base}${JSON.stringify({ ts: new Date().toISOString(), type: 'note', text: t })}\n`;
  }, 'note +1');
  return parseRecords(content);
}

/** 编辑既有 note 记录：按 (ts + 原文本) 定位行，替换文本、保留原 ts；不改写评分卡快照 */
export async function editNote(
  s: SessionLoc, match: { ts: string; text: string }, newText: string, remote: LakeRemote = resolveLakeRemote(),
): Promise<LakeRecord[]> {
  const t = validateNoteText(newText);
  const content = await enqueueWrite(s, notesPath(s), remote, old => {
    if (!old) return null;
    const lines = old.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const rec = parseRecord(lines[i] ?? '');
      if (rec && rec.type === 'note' && rec.ts === match.ts && rec.text === match.text) {
        lines[i] = JSON.stringify({ ts: rec.ts, type: 'note', text: t });
        return lines.join('\n');
      }
    }
    return null;
  }, 'note edit');
  return parseRecords(content);
}

export async function appendScorecard(
  s: SessionLoc,
  card: { totalScore: number | null; dimensions: ScorecardEntry['dimensions']; computedAt: string },
  remote: LakeRemote = resolveLakeRemote(),
): Promise<LakeRecord[]> {
  if (card.dimensions.length === 0) throw new Error('评分卡无维度数据');
  const content = await enqueueWrite(s, notesPath(s), remote, old => {
    const base = old ? (old.endsWith('\n') ? old : `${old}\n`) : '';
    return `${base}${JSON.stringify({ ts: new Date().toISOString(), type: 'scorecard', ...card })}\n`;
  }, 'scorecard +1');
  return parseRecords(content);
}

export type OpGenValue = 'success' | 'failure' | null

// ── 范式级目标配置（<paradigm>/<paradigm>.jsonl，与目录同名）────────────
// 该类算子的优化目标：基线耗时 + 期望耗时（毫秒）。追加式 jsonl，最后一条
// 有效记录生效（历史留在文件与 git 中）；SessionLoc 仅为复用写队列而造。
export interface ParadigmTarget { baselineMs: number | null; expectedMs: number | null }

function paradigmName(name: string): string {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`无效范式目录: "${name.slice(0, 40)}"`);
  return name;
}

function paradigmTargetPath(paradigm: string): string {
  const p = paradigmName(paradigm);
  return `${p}/${p}.jsonl`;
}

export async function readParadigmTarget(paradigm: string, remote: LakeRemote = resolveLakeRemote()): Promise<ParadigmTarget | null> {
  const dir = await ensureMirrorAsync(remote);
  const content = await showFile(dir, `origin/${remote.branch}:${paradigmTargetPath(paradigm)}`);
  if (!content) return null;
  let out: ParadigmTarget | null = null;
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const v = JSON.parse(t) as { type?: unknown; baselineMs?: unknown; expectedMs?: unknown };
      if (v.type === 'opgen-target') {
        out = {
          baselineMs: typeof v.baselineMs === 'number' && Number.isFinite(v.baselineMs) && v.baselineMs > 0 ? v.baselineMs : null,
          expectedMs: typeof v.expectedMs === 'number' && Number.isFinite(v.expectedMs) && v.expectedMs > 0 ? v.expectedMs : null,
        };
      }
    } catch { /* 畸形行跳过 */ }
  }
  return out;
}

export async function setParadigmTarget(
  paradigm: string, baselineMs: number | null, expectedMs: number | null, remote: LakeRemote = resolveLakeRemote(),
): Promise<void> {
  for (const v of [baselineMs, expectedMs]) {
    if (v != null && (!Number.isFinite(v) || v <= 0)) throw new Error('目标耗时必须为正数（毫秒）');
  }
  const p = paradigmName(paradigm);
  await enqueueWrite({ sid: p, paradigm: p, isBaseline: false }, paradigmTargetPath(p), remote, old => {
    const base = old ? (old.endsWith('\n') ? old : `${old}\n`) : '';
    return `${base}${JSON.stringify({ type: 'opgen-target', baselineMs, expectedMs, updatedAt: new Date().toISOString() })}\n`;
  }, 'paradigm target');
}

/** 修正上传时标注的算子生成结果：改写 meta.json 的 x_cannbay.data.opGen（null=清除标注） */
export async function setOpGen(s: SessionLoc, value: OpGenValue, remote: LakeRemote = resolveLakeRemote()): Promise<void> {
  await enqueueWrite(s, metaPath(s), remote, old => {
    if (!old) return null;
    try {
      const meta = JSON.parse(old) as { x_cannbay?: { data?: Record<string, unknown> } };
      const data = meta.x_cannbay?.data;
      if (!data || typeof data !== 'object') return null;
      if (value == null) delete data.opGen;
      else data.opGen = value;
      return `${JSON.stringify(meta, null, 2)}\n`;
    } catch { return null; }
  }, 'meta opgen');
}

async function enqueueWrite(
  s: SessionLoc, relPath: string, remote: LakeRemote,
  mutate: (old: string | null) => string | null,
  label: string,
): Promise<string> {
  const run = writeQueue.then(() => writeLakeFileLocked(s, relPath, remote, mutate, label));
  writeQueue = run.catch(() => { /* 失败不阻断后续排队写入 */ });
  return run;
}

async function writeLakeFileLocked(
  s: SessionLoc, relPath: string, remote: LakeRemote,
  mutate: (old: string | null) => string | null,
  label: string,
): Promise<string> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < PUSH_RETRIES; attempt++) {
    const dir = await ensureMirrorAsync(remote);
    const parent = revParseMain(dir, remote);
    if (!parent) throw new Error('数据湖镜像缺 main 分支');
    const old = await showFile(dir, `origin/${remote.branch}:${relPath}`);
    const content = mutate(old);
    if (content === null) throw new NotesConflictError('记录不存在或已被修改，请刷新后重试');
    const idx = path.join(os.tmpdir(), `cannbay-lake-index-${process.pid}-${Date.now()}`);
    try {
      markLakePhase('fetch', `推送实验记录（${s.sid}）…`);
      const env = { ...process.env, GIT_INDEX_FILE: idx };
      runGit(`git read-tree "${parent}"`, dir, 120_000, { env });
      const blob = runGit('git hash-object -w --stdin', dir, 120_000, { env, input: content }).toString('utf8').trim();
      runGit(`git update-index --add --cacheinfo "100644,${blob},${relPath}"`, dir, 120_000, { env });
      const tree = runGit('git write-tree', dir, 120_000, { env }).toString('utf8').trim();
      const commit = runGit(
        `git -c user.name=cannbay-viewer -c user.email=viewer@localhost commit-tree "${tree}" -p "${parent}" -m "notes(viewer): ${s.sid} ${label}"`,
        dir, 120_000, { env },
      ).toString('utf8').trim();
      const code = await pushLakeAsync(dir, remote, commit);
      if (code !== 0) {
        lastErr = new Error('推送被远端拒绝（并发更新），fetch 换父提交后重试');
        // 重试必须建立在新 origin/main 上：上一轮 ensure 刚把 lastFreshAt 写新，
        // 再走 ensureMirrorAsync 会被 15s TTL 短路拿到同一旧父提交 → 死循环式
        // 三连拒。这里显式强制 fetch（绕过 TTL）。
        await runGitAsync(`git fetch --progress origin ${remote.branch}`, dir, 120_000);
        continue;
      }
      // push 到 URL 不更新本地远端跟踪 ref，补一次 fetch 让后续读取立即可见
      await runGitAsync(`git fetch --quiet origin ${remote.branch}`, dir, 120_000);
      markLakePhase('idle');
      return content;
    } catch (e) {
      lastErr = e;
    } finally {
      try { fs.rmSync(idx, { force: true }); } catch { /* best-effort */ }
    }
  }
  markLakePhase('idle');
  if (lastErr instanceof NotesConflictError) throw lastErr;
  throw lastErr instanceof Error ? new Error(redactLakeSecrets(lastErr.message, remote)) : new Error('推送失败');
}
