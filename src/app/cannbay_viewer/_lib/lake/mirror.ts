// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 数据湖 git 镜像层（vendor 自 insight cannbay2/mirror.ts 的只读子集，决策
// §10-2 先冗余后收敛：仅列表读取，无上传链/物化/spread 写操作）。partial
// clone（--filter=blob:none）——列表 = ls-tree + 一次 git log walk + 一次
// cat-file --batch 批量 meta 读取（meta 为 KB 级小 blob，其余零 blob 下载）。
// 测试通过 CANNBAY2_REMOTE_URL / CANNBAY_VIEWER_CACHE_DIR 指向本地 bare 仓。
import { execSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { escapeRegExp, redactLakeSecrets, resolveLakeRemote, stripUrlCreds } from './remote';
import type { LakeRemote } from './remote';

export { resolveLakeRemote } from './remote';
export type { LakeRemote } from './remote';

// 双记录目录布局（与 cannbay2/mirror.ts 同构）：捕获/主位占裸 <sid>/，原生
// 会话占 <sid>.native/（目录内文件仍以真实 sid 命名）。同一 sid 可各有一条。
export type RecordingClass = 'capture' | 'native';

const NATIVE_FOLDER_SUFFIX = '.native';

/** 仓内目录名 → (真实 sid, 记录类)。无 .native 后缀的目录一律视为捕获位。 */
export function parseSessionFolder(folder: string): { sid: string; recording: RecordingClass } {
  return folder.endsWith(NATIVE_FOLDER_SUFFIX)
    ? { sid: folder.slice(0, -NATIVE_FOLDER_SUFFIX.length), recording: 'native' }
    : { sid: folder, recording: 'capture' };
}

/** 记录类 → 仓内目录名。 */
export function sessionFolderName(sid: string, recording: RecordingClass = 'capture'): string {
  return recording === 'native' ? `${sid}${NATIVE_FOLDER_SUFFIX}` : sid;
}

// LFS 免疫（per-command 中和，镜像内 git 操作对"装没装 git-lfs"完全不敏感）：
// 数据仓 .gitattributes 带 filter=lfs 行 + 客户机 gitconfig 挂着 lfs filter 时——
// checkout：孤儿指针触发 smudge 下载，远端 LFS 未启用 → 403 "project lfs not
//   enabled" → fatal（客户现场实测：git lfs uninstall 清不掉 system/XDG 级
//   配置，靠改机器状态不可靠）；smudge=cat → 指针原样落盘不下载
// add：clean=cat → 新文件永不指针化
// required=false → 即便 filter 配置异常也放行不炸
const LFS_NEUTRALIZE = '-c filter.lfs.process= -c filter.lfs.smudge=cat -c filter.lfs.clean=cat -c filter.lfs.required=false';

export function runGit(cmd: string, cwd: string, timeoutMs = 120_000, opts: { env?: NodeJS.ProcessEnv; input?: string } = {}): Buffer {
  const neutral = cmd.startsWith('git ')
    ? `git ${LFS_NEUTRALIZE} ${cmd.slice('git '.length)}`
    : cmd;
  try {
    return execSync(neutral, {
      cwd, stdio: 'pipe', timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      input: opts.input,
    });
  } catch (e) {
    const err = e as Error & { stderr?: Buffer };
    const detail = [err.message, err.stderr?.toString('utf8') ?? ''].join('\n');
    throw new Error(redactLakeSecrets(detail, resolveLakeRemote()));
  }
}

function runGitText(cmd: string, cwd: string): string {
  return runGit(cmd, cwd).toString();
}

// ── 镜像生命周期 ───────────────────────────────────────────────────────

// 跨进程初始化锁：next dev 多 worker / 与其它工具并存时，多进程会在同一
// cacheDir 上并发首拉镜像 → "destination path already exists and is not an
// empty directory"。锁文件 O_EXCL 创建，持锁者完成后删除；进程崩溃残留的
// 锁按 mtime 超龄击穿（>15min，克隆自身 600s 超时 + 余量）。
function mirrorLocallyUsable(dir: string, remote: LakeRemote): boolean {
  try {
    const originUrl = runGitText('git remote get-url origin', dir).trim();
    if (stripUrlCreds(originUrl) !== stripUrlCreds(remote.pullUrl)) return false;
    runGit(`git rev-parse --verify -q "refs/remotes/origin/${remote.branch}"`, dir);
    return true;
  } catch {
    return false;
  }
}

export function revParseMain(dir: string, remote: LakeRemote = resolveLakeRemote()): string | null {
  try {
    return runGitText(`git rev-parse origin/${remote.branch}`, dir).trim();
  } catch {
    return null;
  }
}

// ── 异步镜像生命周期 + 进度追踪 ────────────────────────────────────────
// execSync 会阻塞整个事件循环（首拉克隆可达数分钟），期间任何请求都无法应答，
// 前端只能干等。克隆/拉取走异步 spawn，stderr 进度行（--progress 强制输出）
// 汇入全局进度快照，/api/lake-status 轮询据此展示"正在克隆 45%"。

export interface LakeProgress {
  phase: 'idle' | 'fetch' | 'clone' | 'list';
  detail: string;
  since: number;
}

let lakeProgressState: LakeProgress = { phase: 'idle', detail: '', since: 0 };

function setLakePhase(phase: LakeProgress['phase'], detail = ''): void {
  lakeProgressState = { phase, detail, since: Date.now() };
}

export function markLakePhase(phase: LakeProgress['phase'], detail = ''): void {
  setLakePhase(phase, detail);
}

export function lakeProgress(): LakeProgress & { elapsedMs: number } {
  return { ...lakeProgressState, elapsedMs: lakeProgressState.since ? Date.now() - lakeProgressState.since : 0 };
}

export function runGitAsync(cmd: string, cwd: string, timeoutMs: number, onStderr?: (line: string) => void): Promise<number> {
  const neutral = cmd.startsWith('git ')
    ? `git ${LFS_NEUTRALIZE} ${cmd.slice('git '.length)}`
    : cmd;
  return new Promise((resolve) => {
    // detached：bash 自成进程组长。超时必须杀整组——只杀 bash 会把 git
    // （孙进程）留成孤儿，继续写 tmp/镜像并与重试竞争。
    const child = spawn('bash', ['-c', neutral], { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let pending = '';
    child.stderr.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      const lines = pending.split(/\r|\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) onStderr?.(trimmed);
      }
    });
    const timer = setTimeout(() => {
      try {
        if (child.pid != null) process.kill(-child.pid, 'SIGKILL');
      } catch { child.kill('SIGKILL'); }
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      const rest = pending.trim();
      if (rest) onStderr?.(rest);
      resolve(code ?? -1);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(-1);
    });
  });
}

async function tryFetchMirrorAsync(dir: string, remote: LakeRemote): Promise<boolean> {
  if (!fs.existsSync(path.join(dir, '.git'))) return false;
  setLakePhase('fetch', `origin/${remote.branch}`);
  const code = await runGitAsyncWithAuth(`git fetch --progress origin ${remote.branch}`, dir, remote.pullAuth, 120_000,
    line => setLakePhase('fetch', redactLakeSecrets(line, remote)));
  if (code === 0) { setLakePhase('idle'); return true; }
  return mirrorLocallyUsable(dir, remote);
}

// 异步锁等待：同步版用 Atomics.wait 自旋会阻塞事件循环，这里改轮询锁文件。
// 不变量（与 cannbay2 共用镜像目录后的关键约束）：**锁绝不被跨 await 长持有**
// —— cannbay2 的同步镜像路径（withMirrorInitLock，Atomics.wait 真阻塞事件
// 循环）等这个锁时，若 viewer 把锁握在分钟级异步克隆上，克隆完成回调永远
// 无法派发 → 整进程假死到 15min 锁超龄。因此锁内只做快操作（fetch 验证 /
// rm+rename 交换，毫秒级），长克隆在锁外完成后再短暂持锁交换。
async function acquireInitLockAsync(lock: string): Promise<void> {
  const STALE_MS = 15 * 60_000;
  const deadline = Date.now() + STALE_MS;
  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      return;
    } catch (e) {
      if (e instanceof Error && (e as NodeJS.ErrnoException).code === 'EEXIST') {
        try {
          const stat = fs.statSync(lock);
          if (Date.now() - stat.mtimeMs > STALE_MS) {
            fs.rmSync(lock, { force: true });
            continue;
          }
        } catch { /* 锁刚被删除 → 重试竞争 */ }
        if (Date.now() > deadline) throw new Error(`cannbay viewer mirror init lock timeout: ${lock}`);
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      throw e;
    }
  }
}

function releaseInitLock(lock: string): void {
  try {
    const holder = fs.readFileSync(lock, 'utf8');
    if (holder === String(process.pid)) fs.rmSync(lock, { force: true });
  } catch { /* best-effort */ }
}

// ensure 单飞 + fetch TTL：ensureMirrorAsync 在每个 API 路径上（runs/notes/
// health 2s 轮询），不做节流会把每次筛选/轮询变成一次平台往返，并发
// 调用还会在同一 cacheDir 上踩 ref 锁。TTL 内的镜像视为新鲜，直接复用。
const FETCH_TTL_MS = 15_000;
const lastFreshAt = new Map<string, number>();
const inflightEnsure = new Map<string, Promise<string>>();

export async function ensureMirrorAsync(remote: LakeRemote = resolveLakeRemote()): Promise<string> {
  const dir = path.resolve(remote.cacheDir);
  if (fs.existsSync(path.join(dir, '.git')) && Date.now() - (lastFreshAt.get(dir) ?? 0) <= FETCH_TTL_MS) {
    return dir;
  }
  const existing = inflightEnsure.get(dir);
  if (existing) return existing;
  const run = ensureMirrorUncached(dir, remote)
    .finally(() => { inflightEnsure.delete(dir); });
  inflightEnsure.set(dir, run);
  return run;
}

// 锁外长克隆 → 短暂持锁交换。并发冷启动（viewer 本身 / cannbay2 同步路径）
// 可能各自克隆一份 tmp——浪费一次克隆但安全：交换由锁串行，后换者胜；
// 交换前的「他人是否已交付」判定用本地检查（mirrorLocallyUsable，纯本地 git
// 读、毫秒级），不用 fetch（网络操作进锁定区等于换一种方式长持锁）。

/**
 * Run a git command with a one-shot credential helper (401 challenge-response
 * auth) — private-repo pull support. URLs never carry embedded credentials;
 * the helper script lives in a 0700 temp dir and is removed afterwards.
 * auth=null runs the command as-is.
 */
async function runGitAsyncWithAuth(
  cmd: string,
  cwd: string,
  auth: LakeRemote['pullAuth'],
  timeoutMs: number,
  onStderr?: (line: string) => void,
): Promise<number> {
  if (!auth) return runGitAsync(cmd, cwd, timeoutMs, onStderr);
  if (/[\r\n]/.test(auth.username) || /[\r\n]/.test(auth.password)) {
    throw new Error('git credentials contain newline (invalid for credential helper protocol)');
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-lake-auth-'));
  try {
    const helper = path.join(tmp, 'helper.sh');
    fs.writeFileSync(
      helper,
      `#!/bin/sh\ncat <<'LAKEEOF'\nusername=${auth.username}\npassword=${auth.password}\nLAKEEOF\n`,
      { mode: 0o700 },
    );
    const prefix = `-c credential.helper= -c credential.helper="${helper}"`;
    const wrapped = cmd.startsWith('git ') ? `git ${prefix} ${cmd.slice('git '.length)}` : cmd;
    return await runGitAsync(wrapped, cwd, timeoutMs, onStderr);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function cloneAndSwapAsync(dir: string, remote: LakeRemote): Promise<void> {
  const target = path.resolve(dir);
  const tmp = `${target}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    setLakePhase('clone', '连接远端…');
    const code = await runGitAsyncWithAuth(
      `git clone --no-local --filter=blob:none --no-checkout --progress "${remote.pullUrl}" "${tmp}"`,
      path.dirname(target), remote.pullAuth, 600_000,
      line => setLakePhase('clone', redactLakeSecrets(line, remote)),
    );
    if (code !== 0) throw new Error(`git clone 失败（exit ${code}），详见 /api/lake-status`);
    const lock = `${dir}.lock`;
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    await acquireInitLockAsync(lock);
    try {
      if (!mirrorLocallyUsable(dir, remote)) {
        fs.rmSync(target, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(tmp, target);
      } else {
        fs.rmSync(tmp, { recursive: true, force: true }); // 他人已交付可用镜像
      }
    } finally {
      releaseInitLock(lock);
    }
    setLakePhase('idle');
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

async function ensureMirrorUncached(dir: string, remote: LakeRemote): Promise<string> {
  if (await tryFetchMirrorAsync(dir, remote)) {
    lastFreshAt.set(dir, Date.now());
    return dir;
  }
  // 锁定区只做本地判定（毫秒级）：fetch 失败后他人是否已克隆好镜像；
  // 网络 fetch 已在上方无锁完成，长克隆在 cloneAndSwap 锁外进行
  const lock = `${dir}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  let usable = false;
  await acquireInitLockAsync(lock);
  try {
    usable = mirrorLocallyUsable(dir, remote);
  } finally {
    releaseInitLock(lock);
  }
  if (!usable) {
    await cloneAndSwapAsync(dir, remote);
  }
  lastFreshAt.set(dir, Date.now());
  return dir;
}

// ── ls-tree 输出解析（quotepath 防线）──────────────────────────────────
// git 默认 core.quotepath 会把含非 ASCII 的整条路径加引号转义——所有
// ls-tree 一律 -z（NUL 分隔，路径永不转义/加引号）；decodeGitPath 兜底解码。

function decodeGitPath(p: string): string {
  if (!p.startsWith('"')) return p;
  try {
    return JSON.parse(p) as string;
  } catch {
    return p.replace(/^"|"$/g, '');
  }
}

function splitLsTreeEntry(rec: string): { meta: string; path: string } | null {
  const tab = rec.indexOf('\t');
  if (tab < 0) return null;
  return { meta: rec.slice(0, tab), path: decodeGitPath(rec.slice(tab + 1)) };
}

function lsTreeFiles(dir: string): string[] {
  const out = runGit(`git ls-tree -r -z --name-only origin/${resolveLakeRemote().branch}`, dir);
  return out.toString('utf8').split('\0').map(decodeGitPath).filter(l => l.length > 0);
}

function lsTreeTopDirs(dir: string, remote: LakeRemote): string[] {
  const out = runGit(`git ls-tree -z origin/${remote.branch}`, dir);
  const names: string[] = [];
  for (const rec of out.toString('utf8').split('\0')) {
    const entry = splitLsTreeEntry(rec);
    if (!entry) continue;
    if (/^\d+\s+tree\s+[0-9a-f]+$/.test(entry.meta)) {
      names.push(entry.path.replace(/\/$/, ''));
    }
  }
  return names;
}

// ── 列表（零 blob）─────────────────────────────────────────────────────

export interface LakeSession {
  sid: string;
  recording: RecordingClass;
  fileCount: number;
  commitTime: string;
  commitSubject: string;
  framework: string | null;
  ccVersion: string | null;
  producer: string | null;
  workflow: string | null;
  opGen: 'success' | 'failure' | null;
  /** 上传时刻写进 meta 的指标快照（spec §4.4 可选字段）；存量旧 meta 为 null */
  startTime: string | null;
  durationMs: number | null;
  /** 活跃时长快照（spec §4.4 可选字段，同上传时刻写入）；旧 meta 为 null */
  activeMs: number | null;
  totalTokens: number | null;
  /** 会话主模型（首条 assistant 轮），同指标快照一道写入 meta */
  model: string | null;
  paradigm: string | null;
  isBaseline: boolean;
}

// 单个子进程 `cat-file --batch` 流式读取全部 <paradigm>/<sid>/<sid>.meta.json。
// meta 都是 KB 级小 blob，批量一次协议协商拉取；已缓存的 blob 纯本地读。
// 异步 spawn：冷镜像首列时按需拉取 meta blob 可达秒级（劣化链路更久），
// 同步等待会冻住整个事件循环（LakeProgressView 停更、所有路由无响应）。
interface SessionMeta {
  framework: string | null;
  ccVersion: string | null;
  producer: string | null;
  workflow: string | null;
  opGen: 'success' | 'failure' | null;
  startTime: string | null;
  durationMs: number | null;
  activeMs: number | null;
  totalTokens: number | null;
  model: string | null;
}

// 双目录形态（同 sid 双记录）：裸 <sid>/<sid>.meta.json（捕获/主位）与
// <sid>.native/<sid>.meta.json（原生——目录带后缀、文件用真实 sid）。
function wantedMetaEntries(treeOut: string): Array<{ folder: string; oid: string }> {
  const barePattern = /^[^/]+\/(?:baseline\/)?([^/]+)\/\1\.meta\.json$/;
  const nativePattern = /^[^/]+\/(?:baseline\/)?([^/]+)\.native\/\1\.meta\.json$/;
  const wanted: Array<{ folder: string; oid: string }> = [];
  for (const rec of treeOut.split('\0')) {
    const entry = splitLsTreeEntry(rec);
    if (!entry) continue;
    const oidMatch = entry.meta.match(/^[0-9]+\s+blob\s+([0-9a-f]+)$/);
    if (!oidMatch) continue;
    // 裸形态捕获组 = 目录名；.native 形态捕获组 = 去后缀 sid，补回后缀才是目录名（map 键）
    const bare = entry.path.match(barePattern);
    const native = bare ? null : entry.path.match(nativePattern);
    if (bare) wanted.push({ folder: bare[1], oid: oidMatch[1] });
    else if (native) wanted.push({ folder: `${native[1]}${NATIVE_FOLDER_SUFFIX}`, oid: oidMatch[1] });
  }
  return wanted;
}

// 输出格式（每个请求一条）：<oid> SP <type> SP <size>\n<content>\n\n
function parseSessionMetas(buf: Buffer, wanted: Array<{ folder: string; oid: string }>): Map<string, SessionMeta> {
  const out = new Map<string, SessionMeta>();
  let offset = 0;
  const text = (start: number, end: number): string => buf.toString('utf8', start, end);
  for (const w of wanted) {
    if (offset >= buf.length) break;
    const headerEnd = buf.indexOf(0x0a, offset);
    if (headerEnd < 0) break;
    const header = text(offset, headerEnd);
    const sizeMatch = header.match(/^\S+\s+\S+\s+(\d+)$/);
    if (!sizeMatch) { offset = headerEnd + 1; continue; }
    const size = parseInt(sizeMatch[1], 10);
    const body = text(headerEnd + 1, headerEnd + 1 + size);
    offset = headerEnd + 1 + size + 1;
    try {
      const meta = JSON.parse(body) as { x_cannbay?: { data?: { framework?: unknown; ccVersion?: unknown; producer?: unknown; workflow?: unknown; opGen?: unknown; startTime?: unknown; durationMs?: unknown; activeMs?: unknown; totalTokens?: unknown; model?: unknown } } };
      const d = meta.x_cannbay?.data;
      out.set(w.folder, {
        framework: typeof d?.framework === 'string' ? d.framework : null,
        ccVersion: typeof d?.ccVersion === 'string' ? d.ccVersion : null,
        producer: typeof d?.producer === 'string' ? d.producer : null,
        // workflow 版本（§10 决策 1 预留位）：cpx 落地前恒 null，落地后零改造直显
        workflow: typeof d?.workflow === 'string' ? d.workflow : null,
        // opGen（可选字段，spec §4.4）：只认 success/failure，其余值/缺省一律未标注
        opGen: d?.opGen === 'success' || d?.opGen === 'failure' ? d.opGen : null,
        // 指标快照（可选字段，spec §4.4，上传时刻写入）：存量旧 meta 缺省为 null
        startTime: typeof d?.startTime === 'string' ? d.startTime : null,
        model: typeof d?.model === 'string' && d.model ? d.model : null,
        durationMs: typeof d?.durationMs === 'number' && Number.isFinite(d.durationMs) ? d.durationMs : null,
        activeMs: typeof d?.activeMs === 'number' && Number.isFinite(d.activeMs) ? d.activeMs : null,
        totalTokens: typeof d?.totalTokens === 'number' && Number.isFinite(d.totalTokens) ? d.totalTokens : null,
      });
    } catch { /* 截断/畸形 meta → null，不拖垮整个列表 */ }
  }
  return out;
}

// 缺失 blob 预取分块：单次 fetch 的 OID 参数长度上限（与 cannbay2 同值）
const FETCH_OID_CHUNK = 200;

async function readSessionMetas(dir: string): Promise<Map<string, SessionMeta>> {
  try {
    const treeOut = runGit(`git ls-tree -r -z origin/${resolveLakeRemote().branch}`, dir).toString('utf8');
    const wanted = wantedMetaEntries(treeOut);
    if (wanted.length === 0) return new Map();
    // 缺失 meta blob 批量预取：懒取是逐对象一次协商，冷镜像千级缺失时批量读
    // 会被 120s 超时截断、指标列残缺（cannbay2 实测 2370 缺失懒取 ≈42min vs
    // 批量 ~10s）。本地对象清单是纯本地读；fetch 走异步不阻塞事件循环，
    // 失败（服务端拒按 OID fetch 等）自然回退逐对象懒取。
    const local = new Set(
      runGit(`git cat-file --batch-all-objects --batch-check='%(objectname)'`, dir)
        .toString('utf8').split('\n').map(l => l.trim()).filter(Boolean),
    );
    const missing = wanted
      .filter(w => !local.has(w.oid))
      .map(w => w.oid)
      .filter(o => /^[0-9a-f]{40,64}$/.test(o)); // 拼 shell 命令前的白名单校验
    for (let i = 0; i < missing.length; i += FETCH_OID_CHUNK) {
      await runGitAsync(`git fetch --quiet origin ${missing.slice(i, i + FETCH_OID_CHUNK).join(' ')}`, dir, 300_000);
    }
    const buf = await new Promise<Buffer>(resolve => {
      const child = spawn('git', ['cat-file', '--batch'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.on('close', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
      child.on('error', () => { clearTimeout(timer); resolve(Buffer.alloc(0)); });
      child.stdin.on('error', () => { /* EPIPE：进程早退，close 兜底 resolve */ });
      child.stdin.end(wanted.map(w => `${w.oid}\n`).join(''));
    });
    return parseSessionMetas(buf, wanted);
  } catch { /* meta 批量读失败 → 指标列降级为空，列表主体不受影响 */ }
  return new Map();
}

/** ls-tree + 一次 git log walk + 一次批量 meta 读取 → 全部运行及提交元数据。
 *  布局（spec §2）：<paradigm>/<sid>/（范式目录即注册表）、<paradigm>/baseline/<sid>/、
 *  <paradigm>/<sid>.native/（原生会话双记录位，目录内文件用真实 sid 命名）、
 *  sessions/<sid>/（存量区 → paradigm null，不入范式视图）。 */
export async function listSessions(remote: LakeRemote = resolveLakeRemote()): Promise<LakeSession[]> {
  return readLakeSessions(await ensureMirrorAsync(remote), remote);
}

/** 镜像已就绪前提下的纯读取段（ensure 由调用方完成，避免一次构建三连 fetch）。 */
export async function readLakeSessions(dir: string, remote: LakeRemote): Promise<LakeSession[]> {
  markLakePhase('list', '读取范式与会话清单…');
  const mainRev = revParseMain(dir, remote);
  if (!mainRev) { markLakePhase('idle'); return []; }

  const filePattern = /^([^/]+)\/(baseline\/)?([^/]+)\//;
  const treeFiles = lsTreeFiles(dir);
  const fileCount = new Map<string, number>();
  const sidLoc = new Map<string, { root: string; baseline: boolean }>();
  for (const line of treeFiles) {
    const m = line.match(filePattern);
    if (m) {
      // m 捕获的是目录名（folder）——同 sid 双记录下裸目录与 .native 是两个
      // 目录，各自一条目；真实 sid 由 parseSessionFolder 剥后缀还原
      const folder = m[3];
      fileCount.set(folder, (fileCount.get(folder) ?? 0) + 1);
      sidLoc.set(folder, { root: m[1], baseline: m[2] != null });
    }
  }

  // 一次 log walk：位置限定 sid → 上传 commit 的时间 + subject（log 新→旧，
  // 持续覆写——walk 结束留存该位置最老一次触碰，即当前位置的首传 commit）。
  // 单遍分组 O(files)。-c core.quotepath=off：log --name-only 的中文路径同样
  // 默认转义；%x1f 分隔时间与 subject（%s 单行，含上传时填的 提交人/内容描述/备注）。
  // 归属取「当前位置的首传」而非「最后触碰」或「全局首传」：
  // - 最后触碰：任何维护提交（viewer 记录/标注、meta 指标回填、baseline 搬移）
  //   都会把描述列顶成维护信息、开始时间平移；
  // - 全局首传：跨位置迁移（cpx 自动上传 others/ → 人工范式上传）会把归属
  //   顶成自动上传的 bot 身份（cann-robot），而不是把会话放进范式的人。
  // notes(viewer): 前缀跳过保留（防御性：正常时序下它不可能是首传）。
  const sidCommit = new Map<string, { time: string; subject: string }>();
  try {
    const logOut = runGitText(
      `git -c core.quotepath=off log --pretty=format:%x00%aI%x1f%s --name-only origin/${remote.branch}`,
      dir,
    );
    for (const record of logOut.split('\x00')) {
      const lines = record.split('\n').filter(l => l.trim());
      if (lines.length === 0) continue;
      const sep = lines[0].indexOf('\x1f');
      const time = sep < 0 ? lines[0] : lines[0].slice(0, sep);
      const subject = sep < 0 ? '' : lines[0].slice(sep + 1);
      if (subject.startsWith('notes(viewer):')) continue;
      for (const file of lines.slice(1)) {
        const m = file.match(filePattern);
        if (m) sidCommit.set(`${m[1]}/${m[2] ?? ''}${m[3]}`, { time, subject });
      }
    }
  } catch { /* 无历史时列表退化为纯文件名 */ }

  const entries: LakeSession[] = [];
  const metas = await readSessionMetas(dir);
  for (const [folder, count] of fileCount) {
    const { sid, recording } = parseSessionFolder(folder);
    const meta = metas.get(folder);
    const loc = sidLoc.get(folder) ?? { root: 'sessions', baseline: false };
    const upload = sidCommit.get(`${loc.root}/${loc.baseline ? 'baseline/' : ''}${folder}`);
    entries.push({
      sid,
      recording,
      fileCount: count,
      commitTime: upload?.time ?? '',
      commitSubject: upload?.subject ?? '',
      framework: meta?.framework ?? null,
      ccVersion: meta?.ccVersion ?? null,
      producer: meta?.producer ?? null,
      workflow: meta?.workflow ?? null,
      opGen: meta?.opGen ?? null,
      startTime: meta?.startTime ?? null,
      durationMs: meta?.durationMs ?? null,
      activeMs: meta?.activeMs ?? null,
      totalTokens: meta?.totalTokens ?? null,
      model: meta?.model ?? null,
      paradigm: loc.root,
      isBaseline: loc.baseline,
    });
  }
  entries.sort((a, b) => (b.commitTime || '').localeCompare(a.commitTime || ''));
  markLakePhase('idle');
  return entries;
}

/** 顶层范式目录清单：目录即范式，排除存量区 sessions/。 */
export async function listParadigmDirs(remote: LakeRemote = resolveLakeRemote()): Promise<string[]> {
  const dir = await ensureMirrorAsync(remote);
  return readParadigmDirs(dir, remote);
}

export function readParadigmDirs(dir: string, remote: LakeRemote): string[] {
  if (!revParseMain(dir, remote)) return [];
  return lsTreeTopDirs(dir, remote)
    .filter(name => name !== 'sessions')
    .sort();
}

export { escapeRegExp };
