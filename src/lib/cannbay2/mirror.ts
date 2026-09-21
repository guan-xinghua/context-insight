// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// cannbay2 git 镜像层：partial clone（--filter=blob:none）单镜像上传下载共用。
// 列表 = ls-tree + 一次 git log walk + meta 批量读（缺失 blob 先批量预取，
// 一轮 fetch 协商拉齐；listOverview 让列表+顶层目录共享单轮 fetch）；导入 =
// 缺失 blob 批量预取后 cat-file --batch 分批物化（重排成 proxy 布局）；
// 上传 = narrow sparse-checkout + scoped add + commit + push main。
// 写操作进程内 mutex 串行。测试通过
// CANNBAY2_REMOTE_URL / CANNBAY2_PUSH_URL / CANNBAY2_CACHE_DIR 指向本地 bare 仓。
import { execSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultCannbay2Remote, escapeRegExp, normalizeDirPrefix, stripUrlCreds } from './remote';
import type { Cannbay2Remote } from './remote';
import { isProxyVersion } from '../shared/session-format';

export { CANNBAY2_PULL_URL, CANNBAY2_PUSH_URL, CANNBAY2_BRANCH } from './remote';
export type { Cannbay2Remote } from './remote';

export function cannbay2CacheDir(remote?: Cannbay2Remote): string {
  return (remote ?? defaultCannbay2Remote()).cacheDir;
}

// LFS 免疫（per-command 中和，镜像内 git 操作对"装没装 git-lfs"完全不敏感）：
// 数据仓 .gitattributes 带 filter=lfs 行 + 客户机 gitconfig 挂着 lfs filter 时——
// checkout：孤儿指针触发 smudge 下载，远端 LFS 未启用 → 403 "project lfs not
//   enabled" → fatal（客户现场实测：git lfs uninstall 清不掉 system/XDG 级
//   配置，靠改机器状态不可靠）；smudge=cat → 指针原样落盘不下载
// add：clean=cat → 新文件永不指针化（与 uploadFolder 的 .gitattributes strip
//   双保险，strip 管"仓里不再有 lfs 行"，这里管"本机 filter 不生效"）
// required=false → 即便 filter 配置异常也放行不炸
const LFS_NEUTRALIZE = '-c filter.lfs.process= -c filter.lfs.smudge=cat -c filter.lfs.clean=cat -c filter.lfs.required=false';

// raw = 跳过中和（LFS 模式的 add/push/物化专用：clean 出指针、pre-push 钩子
// 上传 LFS 对象、smudge 按需拉实体）；其余命令保持中和（checkout 的
// smudge=cat 让既有 LFS 文件落指针文本——clean 对指针透传，re-add 不炸）
export function runGit(cmd: string, cwd: string, timeoutMs = 120_000, opts?: { raw?: boolean }): Buffer {
  const neutral = !opts?.raw && cmd.startsWith('git ')
    ? `git ${LFS_NEUTRALIZE} ${cmd.slice('git '.length)}`
    : cmd;
  return execSync(neutral, { cwd, stdio: 'pipe', timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 });
}

function runGitText(cmd: string, cwd: string): string {
  return runGit(cmd, cwd).toString();
}

// ── blob 批量预取 ────────────────────────────────────────────────────
// partial clone（--filter=blob:none）下 blob 按需懒取：每个缺失对象一次独立
// HTTPS 协商（atomgit 实测 ~1s/个）。批量预取 = 一轮 git fetch <oids> 协商拉齐
// 全部缺失（实测 1601 个 meta 9.3s，懒取需 ~28min），与懒取走同一服务端能力
// （uploadpack.allowAnySHA1InWant；atomgit 支持，本地 bare fixture 同配）。
// 任何失败静默跳过 —— 后续逐对象 cat-file 懒取路径不变，行为不劣化。

// 单次 fetch 的 OID 数（命令行长度安全：200 × 41B ≈ 8KB，Windows 限制内）
const FETCH_OID_CHUNK = 200;

/** 本地已落库对象清单（--batch-all-objects 只列本地，不触发懒取）。 */
export function localObjectOids(dir: string): Set<string> {
  const out = runGit("git cat-file --batch-all-objects --batch-check='%(objectname)'", dir);
  return new Set(out.toString('utf8').split('\n').map(l => l.trim()).filter(Boolean));
}

/** 把缺失 blob 分块批量拉齐。oid 白名单校验（拼进 shell 命令）。 */
export function prefetchBlobs(dir: string, oids: string[]): void {
  const valid = oids.filter(o => /^[0-9a-f]{40,64}$/.test(o));
  for (let i = 0; i < valid.length; i += FETCH_OID_CHUNK) {
    try {
      runGit(`git fetch --quiet origin ${valid.slice(i, i + FETCH_OID_CHUNK).join(' ')}`, dir, 300_000);
    } catch { /* 服务端拒绝按 OID fetch 等 → 回退逐对象懒取 */ }
  }
}

// ── 镜像生命周期 ───────────────────────────────────────────────────────

// 跨进程初始化锁：模块级 writeLock 只在单进程内有效，next dev 多 worker /
// CLI 自动拉起的第二后端 / TUI+Web 并存时，多进程会在同一 cacheDir 上并发
// 首拉镜像 → "destination path already exists and is not an empty
// directory"。锁文件 O_EXCL 创建，持锁者完成后删除；进程崩溃残留的锁按
// mtime 超龄击穿（>15min，克隆自身 600s 超时 + 余量）。
function withMirrorInitLock(dir: string, fn: () => void): void {
  const lock = `${dir}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const STALE_MS = 15 * 60_000;
  const deadline = Date.now() + STALE_MS;
  const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
      break;
    } catch {
      try {
        const st = fs.statSync(lock);
        if (Date.now() - st.mtimeMs > STALE_MS) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch { /* 锁刚被释放 —— 立即重试 */ }
      if (Date.now() > deadline) throw new Error(`cannbay2 mirror init lock timeout: ${lock}`);
      sleep(250);
    }
  }
  try {
    fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

// 克隆进唯一临时目录再原子 rename 到 cacheDir：git clone 永远不会撞上
// "目标目录非空"（半成品/并发写入者只可能出现在 tmp 名下，rename 后的
// 最终目录只在克隆完整落盘后才存在）。失败时清理 tmp，不留残骸。
// 目标路径一律 path.resolve：git 以自身 cwd 解析相对目标参数、Node fs 按
// 进程 cwd 解析，二者基准不同——相对 cacheDir 会被 git 解析到双重路径，
// rename 时源不存在（ENOENT）。
function cloneMirror(dir: string, remote: Cannbay2Remote): void {
  const target = path.resolve(dir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    // --no-local：本地路径 clone 默认走硬链接、忽略 --filter（测试指向本地 bare 仓时
    // 会退化成全量镜像、物化不再是按需下载）；HTTPS 远端不受影响
    runGit(`git clone --quiet --no-local --filter=blob:none --no-checkout "${remote.pullUrl}" "${tmp}"`, path.dirname(target), 600_000);
    // 走到这里必然持锁：旧目录只可能是已判定损坏的残留（fetch 失败 / 上次中断），
    // 没有合法并发读者，安全删除后让位。rename 前重建父目录：克隆耗时数分钟，
    // 期间父目录可能被外部清理掉。
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(tmp, target);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

/** 镜像本地结构完好且 origin 指向期望远端：origin 地址（去凭据比对，凭据
 *  轮换不误判）与 remote.pullUrl 一致 + origin/<branch> 引用可解析。半成品
 *  克隆（无引用）、损坏仓（garbage .git）、被改坏/指错远端的镜像都过不了。 */
function mirrorLocallyUsable(dir: string, remote: Cannbay2Remote): boolean {
  try {
    const originUrl = runGitText('git remote get-url origin', dir).trim();
    if (stripUrlCreds(originUrl) !== stripUrlCreds(remote.pullUrl)) return false;
    runGit(`git rev-parse --verify -q "refs/remotes/origin/${remote.branch}"`, dir);
    return true;
  } catch {
    return false;
  }
}

/** 镜像存在且 fetch 成功（元数据就绪）。fetch 失败 ≠ 损坏：
 *  - origin 完好 + 引用可解析 → 瞬态失败（网络抖动 / 另一进程在同一镜像里
 *    上传时的 refs 锁竞争）→ 保留镜像（元数据可能略旧），绝不 rmSync 重建
 *    ——否则会炸掉在途上传的仓库；
 *  - 地址不符 / 引用缺失 → 配置级损坏或半成品 → 走重建自愈。 */
function tryFetchMirror(dir: string, remote: Cannbay2Remote): boolean {
  if (!fs.existsSync(path.join(dir, '.git'))) return false;
  try {
    runGit(`git fetch --quiet origin ${remote.branch}`, dir);
    return true;
  } catch {
    return mirrorLocallyUsable(dir, remote);
  }
}

/** 确保 partial clone 镜像存在且 origin/<branch> 元数据最新（不下载 blob）。
 *  首拉/重建在跨进程文件锁下进行 + 锁内双检（等锁期间同伴可能已完成），
 *  自愈只删自身 cacheDir，不动兄弟远端缓存。 */
export function ensureMirror(remote: Cannbay2Remote = defaultCannbay2Remote()): string {
  const dir = path.resolve(remote.cacheDir);
  if (tryFetchMirror(dir, remote)) return dir;
  withMirrorInitLock(dir, () => {
    if (!tryFetchMirror(dir, remote)) {
      cloneMirror(dir, remote);
    }
  });
  return dir;
}

export function revParseMain(dir: string, remote: Cannbay2Remote = defaultCannbay2Remote()): string | null {
  try {
    return runGitText(`git rev-parse origin/${remote.branch}`, dir).trim();
  } catch {
    return null;
  }
}

// ── 列表（零 blob） ────────────────────────────────────────────────────

export interface Cannbay2SessionEntry {
  sid: string;
  fileCount: number;
  author: string;
  submitter: string;
  description: string;
  commitTime: string;
  /** cc-session-meta 声明的框架（opencode / claude-code…），meta 缺失/旧文件为 null */
  framework: string | null;
  /** cc-session-meta 声明的原始版本号，无则 null */
  ccVersion: string | null;
  /** cc-session-meta 声明的生产者（cpx=proxy 捕获 / insight-export / insight-upload），无则 null */
  producer: string | null;
  /** 算子生成结果标注（cc-session-meta 可选字段 opGen，上传时人工勾选），无则 null=未标注 */
  opGen: 'success' | 'failure' | null;
  /** 所在顶层范式目录（多根模式，目录即注册表）；存量区 sessions/ 与单根远端为 null */
  paradigm: string | null;
  /** 是否范式 baseline 会话（位置即身份：<paradigm>/baseline/<sid>/，路径推导非存储标记） */
  isBaseline: boolean;
  /** 记录类（同 sid 双记录）：capture=裸 <sid>/ 目录（wire 捕获 / 主位上传），
   *  native=<sid>.native/ 目录（原生 claude 会话文件）。同一 sid 可各有一条。 */
  recording: RecordingClass;
}

/** 会话在仓内的位置：<root>/<sid>/（普通）或 <root>/baseline/<sid>/（baseline）。 */
/** 记录类（同 sid 双记录·cannbay 侧）：同一 sid 的 wire 捕获与原生会话两份
 *  记录在仓内并存——捕获占裸 <sid>/（cpx 直传/insight 捕获行/存量数据零迁移，
 *  今日行为不变），原生 claude 会话占 <sid>.native/（目录内文件仍以真实 sid
 *  命名，materialize/导入侧 taskId 不带后缀）。不变量从「sid 全仓唯一」升级
 *  为「sid × 记录类 全仓唯一」；同记录类重传仍是整体替换（幂等/清旧语义不变）。 */
export type RecordingClass = 'capture' | 'native';

const NATIVE_FOLDER_SUFFIX = '.native';

/** 记录类 → 仓内目录名。native 加 .native 后缀——点分隔（uuid 形态 sid 不含
 *  点）与真实 sid 的裸目录零歧义。 */
export function sessionFolderOf(sid: string, recording: RecordingClass = 'capture'): string {
  return recording === 'native' ? `${sid}${NATIVE_FOLDER_SUFFIX}` : sid;
}

/** 仓内目录名 → (真实 sid, 记录类)。无 .native 后缀的目录一律视为捕获位
 *  （含存量数据与 opencode/insight-export 的主位上传）。 */
export function parseSessionFolder(folder: string): { sid: string; recording: RecordingClass } {
  return folder.endsWith(NATIVE_FOLDER_SUFFIX)
    ? { sid: folder.slice(0, -NATIVE_FOLDER_SUFFIX.length), recording: 'native' }
    : { sid: folder, recording: 'capture' };
}

export interface SessionLocation {
  root: string;
  baseline: boolean;
  recording: RecordingClass;
}

function locationPath(loc: SessionLocation, sid: string): string {
  const folder = sessionFolderOf(sid, loc.recording);
  return loc.baseline ? `${loc.root}/baseline/${folder}` : `${loc.root}/${folder}`;
}

function parseCommitSubject(subject: string, author: string): { submitter: string; description: string } {
  let submitter = '';
  let description = '';
  const subMatch = subject.match(/提交人\s*[:：]\s*/);
  const descMatch = subject.match(/(?:内容)?描述\s*[:：]\s*/);
  const subStart = subMatch ? (subMatch.index ?? 0) + subMatch[0].length : -1;
  const descIdx = descMatch ? (descMatch.index ?? 0) : -1;
  if (subStart >= 0) {
    const end = descIdx >= subStart ? descIdx : subject.length;
    submitter = subject.slice(subStart, end).trim();
  }
  if (descIdx >= 0) description = subject.slice(descIdx + (descMatch![0].length)).trim().split('\n')[0];
  if (!submitter) submitter = author;
  if (!description) description = subject.split('\n')[0];
  return { submitter, description };
}

// ── ls-tree 输出解析（quotepath 防线）──────────────────────────────────
// git 默认 core.quotepath 会把含非 ASCII 的整条路径加引号转义（如
// "09_fa_op_gen/7\346\234\210/…"）——路径里只要有一段中文（trace_corpus
// 的 <类别>/<月份>/ 布局），按 "/" 切分就会得到带引号前缀的目录名，与
// 纯 ASCII 路径推出的干净目录名并存（UI 两个同名目录，带引号的无效）。
// 所有 ls-tree 一律 -z（NUL 分隔，路径永不转义/加引号）；decodeGitPath
// 兜底解码——防御非 -z 路径（git 版本差异）与历史调用点。
function decodeGitPath(p: string): string {
  if (!p.startsWith('"')) return p;
  try {
    return JSON.parse(p) as string;
  } catch {
    return p.replace(/^"|"$/g, '');
  }
}

// ls-tree -z 全格式条目拆分：<mode> SP <type> SP <oid> TAB <path>。
// -z 只把行分隔符换成 NUL（路径可含 \n），meta 与 path 之间恒为 TAB。
function splitLsTreeEntry(rec: string): { meta: string; path: string } | null {
  const tab = rec.indexOf('\t');
  if (tab < 0) return null;
  return { meta: rec.slice(0, tab), path: decodeGitPath(rec.slice(tab + 1)) };
}

// ls-tree -r -z --name-only → 文件路径数组（NUL 分隔，无引号转义）。
function lsTreeFiles(dir: string, spec: string, remote: Cannbay2Remote): string[] {
  const out = runGit(`git ls-tree -r -z --name-only origin/${remote.branch}${spec}`, dir);
  return out.toString('utf8').split('\0').map(decodeGitPath).filter(l => l.length > 0);
}

// ls-tree -z（顶层单层树）→ 目录名数组。
function lsTreeTopDirs(dir: string, remote: Cannbay2Remote): string[] {
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

/**
 * 单个子进程 `cat-file --batch` 流式读取全部 <rootDir>/<sid>/<sid>.meta.json。
 * meta 都是 KB 级小 blob，批量一次协议协商拉取（对比逐 blob cat-file 每个一次
 * 协商）；已缓存的 blob 纯本地读。列表 type 列的唯一数据源。
 * 多根模式 meta 可位于任一顶层目录（<paradigm>/<sid>/<sid>.meta.json），含
 * baseline 位置（<paradigm>/baseline/<sid>/<sid>.meta.json）。
 */
function readSessionMetas(dir: string, remote: Cannbay2Remote): Map<string, { framework: string | null; ccVersion: string | null; producer: string | null; opGen: 'success' | 'failure' | null }> {
  const out = new Map<string, { framework: string | null; ccVersion: string | null; producer: string | null; opGen: 'success' | 'failure' | null }>();
  try {
    const spec = remote.paradigmRoots ? '' : ` -- ${remote.rootDir}/`;
    const treeOut = runGit(`git ls-tree -r -z origin/${remote.branch}${spec}`, dir).toString('utf8');
    // 双目录形态（同 sid 双记录）：裸 <sid>/<sid>.meta.json（捕获/主位）与
    // <sid>.native/<sid>.meta.json（原生——目录带后缀、文件用真实 sid）。
    // 键 = 目录名（folder），与 listSessionsIn 的 fileCount/sidLoc 对齐
    const rootSeg = remote.paradigmRoots ? '[^/]+' : escapeRegExp(remote.rootDir);
    const pathPattern = new RegExp(`^${rootSeg}\\/(?:baseline\\/)?([^/]+)\\/\\1\\.meta\\.json$`);
    const nativePathPattern = new RegExp(`^${rootSeg}\\/(?:baseline\\/)?([^/]+)\\.native\\/\\1\\.meta\\.json$`);
    const wanted: Array<{ folder: string; oid: string }> = [];
    for (const rec of treeOut.split('\0')) {
      const entry = splitLsTreeEntry(rec);
      if (!entry) continue;
      const oidMatch = entry.meta.match(/^[0-9]+\s+blob\s+([0-9a-f]+)$/);
      if (!oidMatch) continue;
      // 裸形态捕获组 = 目录名；.native 形态捕获组 = 去后缀 sid，补回后缀才是目录名（map 键）
      const bare = entry.path.match(pathPattern);
      const native = bare ? null : entry.path.match(nativePathPattern);
      if (bare) wanted.push({ folder: bare[1], oid: oidMatch[1] });
      else if (native) wanted.push({ folder: `${native[1]}${NATIVE_FOLDER_SUFFIX}`, oid: oidMatch[1] });
    }
    if (wanted.length === 0) return out;
    // 缺失 meta blob 批量预取：一轮 fetch 协商拉齐（懒取是逐对象一次协商，
    // 千级缺失时列表被 120s 超时截断、type 列残缺；实测 2370 缺失 ≈ 42min
    // 懒取 vs ~10s 批量）。失败回退懒取。
    const local = localObjectOids(dir);
    const missing = wanted.filter(w => !local.has(w.oid)).map(w => w.oid);
    if (missing.length > 0) prefetchBlobs(dir, missing);
    // spawnSync（非 execSync）：execSync 自定义 stdio 时不返回 stdout，且输入
    // 走 stdin 需要独立 pipe —— 这里要求拿回完整批量输出 buffer
    const batch = spawnSync('git', ['cat-file', '--batch'],
      { cwd: dir, input: wanted.map(w => `${w.oid}\n`).join(''), maxBuffer: 256 * 1024 * 1024, timeout: 120_000 });
    // 输出格式（每个请求一条）：<oid> SP <type> SP <size>\n<content>\n\n
    let offset = 0;
    const buf = batch.stdout ?? Buffer.alloc(0);
    const text = (start: number, end: number): string => buf.toString('utf8', start, end);
    for (const w of wanted) {
      if (offset >= buf.length) break;
      const headerEnd = buf.indexOf(0x0a, offset);
      if (headerEnd < 0) break;
      const header = text(offset, headerEnd);
      const sizeMatch = header.match(/^\S+\s+\S+\s+(\d+)$/);
      if (!sizeMatch) { offset = headerEnd + 1; continue; } // missing 行（不该发生）跳过
      const size = parseInt(sizeMatch[1], 10);
      const body = text(headerEnd + 1, headerEnd + 1 + size);
      offset = headerEnd + 1 + size + 1; // content + 结尾空行
      try {
        const meta = JSON.parse(body) as { x_cannbay?: { data?: { framework?: unknown; ccVersion?: unknown; producer?: unknown; opGen?: unknown } } };
        const d = meta.x_cannbay?.data;
        out.set(w.folder, {
          framework: typeof d?.framework === 'string' ? d.framework : null,
          ccVersion: typeof d?.ccVersion === 'string' ? d.ccVersion : null,
          producer: typeof d?.producer === 'string' ? d.producer : null,
          // opGen（可选字段，spec §4.4）：只认 success/failure，其余值/缺省一律未标注
          opGen: d?.opGen === 'success' || d?.opGen === 'failure' ? d.opGen : null,
        });
      } catch { /* 截断/畸形 meta → null，不拖垮整个列表 */ }
    }
  } catch { /* meta 批量读失败 → type 列降级为空，列表主体不受影响 */ }
  return out;
}

/** ls-tree + 一次 git log walk + 一次批量 meta 读取 → 全部会话文件夹及提交元数据。 */
export function listSessions(remote: Cannbay2Remote = defaultCannbay2Remote()): Cannbay2SessionEntry[] {
  return listSessionsIn(ensureMirror(remote), remote);
}

function listSessionsIn(dir: string, remote: Cannbay2Remote): Cannbay2SessionEntry[] {
  const mainRev = revParseMain(dir, remote);
  if (!mainRev) return [];

  // 多根模式（默认仓）：全仓扫描，<顶层目录>/<sid>/ 双段路径即会话（顶层目录
  // = 范式，sessions/ = 存量区 → paradigm null）。baseline 位置三段路径
  // <paradigm>/baseline/<sid>/（baseline 为范式级保留目录名，不当作 sid）。
  // 单根模式（自定义远端）：rootDir pathspec 扫描，同样识别 baseline 段 ——
  // 防手工放置的 <rootDir>/baseline/<sid>/ 产生 sid='baseline' 幻影会话。
  const multiRoot = remote.paradigmRoots;
  const filePattern = multiRoot
    ? /^([^/]+)\/(baseline\/)?([^/]+)\//
    : new RegExp(`^${escapeRegExp(remote.rootDir)}/(baseline/)?([^/]+)/`);
  const spec = multiRoot ? '' : ` -- ${remote.rootDir}/`;
  const treeFiles = lsTreeFiles(dir, spec, remote);
  const fileCount = new Map<string, number>();
  const sidLoc = new Map<string, SessionLocation>();
  for (const line of treeFiles) {
    const m = line.match(filePattern);
    if (m) {
      // m 捕获的是目录名（folder）——同 sid 双记录下 bare 与 .native 是两个目录，
      // 各自一条目；真实 sid 由 parseSessionFolder 剥后缀还原
      const folder = multiRoot ? m[3] : m[2];
      fileCount.set(folder, (fileCount.get(folder) ?? 0) + 1);
      sidLoc.set(folder, { root: multiRoot ? m[1] : remote.rootDir, baseline: m[m.length - 2] != null, recording: parseSessionFolder(folder).recording });
    }
  }

  // 一次 log walk：sid → 最后触碰 commit（log 新→旧，首个命中即最新）。
  // 单遍分组 O(files)——按 sid 再 filter 一遍是 O(N²)，千级会话时列表超 2s。
  // -c core.quotepath=off：log --name-only 的中文路径同样默认转义加引号
  const sidCommit = new Map<string, { author: string; time: string; subject: string }>();
  try {
    const logOut = runGitText(
      `git -c core.quotepath=off log --pretty=format:%x00%an%x1f%aI%x1f%s --name-only origin/${remote.branch}${spec}`,
      dir,
    );
    for (const record of logOut.split('\x00')) {
      const lines = record.split('\n').filter(l => l.trim());
      if (lines.length === 0) continue;
      const [author, time, ...subjectParts] = lines[0].split('\x1f');
      const subject = subjectParts.join('\x1f');
      for (const file of lines.slice(1)) {
        const m = file.match(filePattern);
        if (m) {
          const folder = multiRoot ? m[3] : m[2];
          if (!sidCommit.has(folder)) sidCommit.set(folder, { author, time, subject });
        }
      }
    }
  } catch { /* 无历史时列表退化为纯文件名 */ }

  const entries: Cannbay2SessionEntry[] = [];
  const metas = readSessionMetas(dir, remote);
  for (const [folder, count] of fileCount) {
    const { sid, recording } = parseSessionFolder(folder);
    const newest = sidCommit.get(folder);
    const author = newest?.author ?? '';
    const { submitter, description } = parseCommitSubject(newest?.subject ?? '', author);
    const meta = metas.get(folder);
    const loc = sidLoc.get(folder) ?? { root: remote.rootDir, baseline: false, recording };
    const paradigm = multiRoot && loc.root !== remote.rootDir ? loc.root : null;
    entries.push({ sid, recording, fileCount: count, author, submitter, description, commitTime: newest?.time ?? '', framework: meta?.framework ?? null, ccVersion: meta?.ccVersion ?? null, producer: meta?.producer ?? null, opGen: meta?.opGen ?? null, paradigm, isBaseline: loc.baseline });
  }
  entries.sort((a, b) => (b.commitTime || '').localeCompare(a.commitTime || ''));
  return entries;
}

// ── 目录浏览（ls-tree -r 全量文件清单 → 推导一级子目录） ────────────────

// ls-tree 带目录 pathspec 只列直属 blob、不列子目录（实测），因此用 -r 全量
// 文件路径推导：任一文件的下一级祖先目录即一级子目录（git 无空目录，成立）
export function listRemoteDirs(remote: Cannbay2Remote = defaultCannbay2Remote(), prefix = ''): string[] {
  // 入口校验（与 uploadFolder 对 sid 同款双重防线）：prefix 拼进 shell 命令
  const p = normalizeDirPrefix(prefix);
  return listDirsIn(ensureMirror(remote), remote, p);
}

function listDirsIn(dir: string, remote: Cannbay2Remote, p: string): string[] {
  if (!revParseMain(dir, remote)) return [];
  const spec = p ? ` -- ${p}/` : '';
  const files = lsTreeFiles(dir, spec, remote);
  const dirs = new Set<string>();
  for (const line of files) {
    const rel = p ? line.slice(p.length + 1) : line;
    const slash = rel.indexOf('/');
    if (slash > 0) dirs.add((p ? `${p}/` : '') + rel.slice(0, slash));
  }
  return [...dirs].sort();
}

export interface Cannbay2Overview {
  sessions: Cannbay2SessionEntry[];
  /** 顶层目录清单（与 listRemoteDirs('') 同源，含存量区 sessions；自定义单根远端恒 []）。
   *  导入对话框的范式下拉与会话列表一次请求共享一轮 mirror fetch（原来 dirs+list
   *  两路各 fetch 一次 ~1s×2）。 */
  topDirs: string[];
}

/** 会话列表 + 顶层目录合并读取：单轮 ensureMirror fetch 服务两份数据。 */
export function listOverview(remote: Cannbay2Remote = defaultCannbay2Remote()): Cannbay2Overview {
  const dir = ensureMirror(remote);
  return {
    sessions: listSessionsIn(dir, remote),
    topDirs: remote.paradigmRoots ? listDirsIn(dir, remote, '') : [],
  };
}

// ── 范式目录注册表（目录即范式，insight 零范式知识）──────────────────────

/** 顶层范式目录清单（上传下拉数据源 + 网关动态白名单）：排除存量区 sessions。
 *  单根远端（自定义地址）不启用 → 恒 []。新增范式只需在数据仓建目录。 */
export function listParadigmDirs(remote: Cannbay2Remote = defaultCannbay2Remote()): string[] {
  if (!remote.paradigmRoots) return [];
  const dir = ensureMirror(remote);
  if (!revParseMain(dir, remote)) return [];
  return lsTreeTopDirs(dir, remote)
    .filter(name => name !== remote.rootDir)
    .sort();
}

/** sid 现存于哪些位置（含 baseline 三段路径；多根全仓搜，单根在 rootDir 下搜
 *  普通与 baseline 两处 —— 自定义仓手工放置的 baseline 结构也能定位）。 */
function locateSessionLocations(dir: string, remote: Cannbay2Remote, sid: string, recording: RecordingClass = 'capture'): SessionLocation[] {
  const folder = sessionFolderOf(sid, recording);
  if (!remote.paradigmRoots) {
    const locs: SessionLocation[] = [];
    for (const baseline of [false, true]) {
      const p = `${remote.rootDir}${baseline ? '/baseline' : ''}/${folder}`;
      if (runGitText(`git ls-tree --name-only origin/${remote.branch} ${p}`, dir).trim()) {
        locs.push({ root: remote.rootDir, baseline, recording });
      }
    }
    return locs;
  }
  // 逐项匹配（不 join('\n')/split('\n')）：ls-tree -z 路径可含 \n（NUL 才是
  // 分隔符），按行拆会让恶意文件路径伪造出 `evil-root/<sid>/` 形态的"行"
  // ——完全可控的 root 进入 locs 后直通下游 shell 命令（sparse/add/show）
  const files = lsTreeFiles(dir, '', remote);
  const re = new RegExp(`^([^/]+)\\/(baseline\\/)?${escapeRegExp(folder)}\\/`);
  const locs = new Map<string, SessionLocation>();
  for (const f of files) {
    const m = f.match(re);
    if (m) locs.set(`${m[1]}/${m[2] ?? ''}`, { root: m[1], baseline: m[2] != null, recording });
  }
  // root 段级白名单（与 normalizeDirPrefix 同款规则，非 ASCII 放行、shell
  // 元字符与空白全挡）：root 来自 ls-tree 原始输出不受控——旧仓/手工推送
  // 的顶层目录名会经 locationPath 直通 sparse-checkout/git add/git show 的
  // shell 字符串。非法段丢弃整个 loc（保守不动语义，与"归属不明不动"一致）
  return [...locs.values()].filter(l => isSafeRootSegment(l.root));
}

/** root（范式目录名/存量区目录名）的段级安全校验——与 remote.ts
 *  normalizeDirPrefix 的段规则同源：shell 元字符与路径语义字符全在 ASCII
 *  区，白名单只约束 ASCII 段即可保住注入面（非 ASCII 段如 "7月" 放行）。 */
function isSafeRootSegment(root: string): boolean {
  if (root === '.' || root === '..') return false;
  return /^[\w\u0080-\uFFFF.-]+$/.test(root);
}

/** 存量裸目录归属判定（同 sid 双记录收全的迁移路径）：裸 <sid>/ 目录的
 *  cc-session-meta 内容——与 uploadCannbay2Session 的记录类推导同构
 *  （isProxyVersion(version) || framework 带 -proxy → capture，否则 native）：
 *  - producer=cpx（cpx 捕获直传/伴生 meta）= 捕获，位置正确绝不触碰
 *  - framework 带 -proxy（insight 合成 meta 携带行 framework）= 捕获行，
 *    同样不动
 *  - ccVersion 带 proxy marker（早期捕获行 framework 无后缀 + version 带
 *    marker 的旧形态——合成 meta / DB 导出 meta 都原样抄行值，ccVersion
 *    是该形态下唯一的 proxy 信号）= 捕获行，不动——漏判会把存量捕获
 *    裸目录误判为存量原生而删除（wire 捕获记录被毁）
 *  - producer=insight-export / insight-upload 且无任何 proxy 信号（insight
 *    侧导出件）= 存量原生（旧世界落错裸位）→ 待迁移
 *  - 无 meta / 畸形 / git show 失败 = 归属不明，保守不动（宁可残留勿误删） */
function bareDirHoldsNativeRecording(dir: string, remote: Cannbay2Remote, loc: SessionLocation, sid: string): boolean {
  try {
    const metaPath = `${locationPath(loc, sid)}/${sid}.meta.json`;
    // spawnSync argv（非 runGit shell 字符串）：metaPath 含来自 ls-tree 的
    // root 段——即便有 isSafeRootSegment 白名单，meta 读取也彻底绕开 shell
    // 作纵深（与 LFS cat-file 同款纪律）
    const r = spawnSync('git', ['show', `origin/${remote.branch}:${metaPath}`],
      { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    if (r.error || r.status !== 0) return false;
    const data = (JSON.parse(r.stdout.toString('utf8')) as { x_cannbay?: { data?: { producer?: unknown; framework?: unknown; ccVersion?: unknown } } }).x_cannbay?.data;
    if (data == null || typeof data !== 'object') return false;
    if (data.producer === 'cpx') return false;
    if (typeof data.framework === 'string' && data.framework.endsWith('-proxy')) return false;
    if (typeof data.ccVersion === 'string' && isProxyVersion(data.ccVersion)) return false;
    return data.producer === 'insight-export' || data.producer === 'insight-upload';
  } catch {
    return false;
  }
}

/** 范式 baseline 目录下现任会话 sid 列表（结构即状态：baseline/ 下唯一 <sid>/ 即基准）。 */
function locateBaselineSids(dir: string, remote: Cannbay2Remote, paradigm: string): string[] {
  const out = runGit(`git ls-tree -z --name-only origin/${remote.branch} ${paradigm}/baseline/`, dir).toString('utf8');
  const sids: string[] = [];
  for (const line of out.split('\0')) {
    const m = decodeGitPath(line).trim().match(/^[^/]+\/baseline\/([^/]+)\/?$/);
    if (m && m[1] !== '.gitkeep') sids.push(m[1]);
  }
  return sids;
}

// ── 导入物化（cat-file，按需下载 blob） ─────────────────────────────────

// 非 LFS 批量物化：单进程 --batch-check 取各 blob 尺寸（仅头部输出）→ 按
// 累计体积分批（≤64MB/批，有界内存）→ 每批单进程 --batch 流式写盘。预取
// 后全本地，省去逐文件 cat-file spawn（334 文件会话 3.8s → ~0.4s）。
// batch 应答里 missing / 非 blob 的条目 → 逐文件 cat-file -p 兜底（懒取）。
const MATERIALIZE_BATCH_BYTES = 64 * 1024 * 1024;
const MATERIALIZE_BATCH_COUNT = 128;

function materializeBlobsByBatch(dir: string, planned: Array<{ oid: string; target: string }>): void {
  const sizeRes = spawnSync('git', ['cat-file', '--batch-check'],
    { cwd: dir, input: planned.map(p => `${p.oid}\n`).join(''), maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
  const sizes = new Map<string, number>();
  for (const line of (sizeRes.stdout ?? Buffer.alloc(0)).toString('utf8').split('\n')) {
    const m = line.match(/^([0-9a-f]+) \w+ (\d+)$/);
    if (m) sizes.set(m[1], parseInt(m[2], 10));
  }
  const skipped: Array<{ oid: string; target: string }> = [];
  let batch: Array<{ oid: string; target: string }> = [];
  let batchBytes = 0;
  const flush = (): void => {
    if (batch.length === 0) return;
    const res = spawnSync('git', ['cat-file', '--batch'],
      { cwd: dir, input: batch.map(p => `${p.oid}\n`).join(''), maxBuffer: 512 * 1024 * 1024, timeout: 300_000 });
    const buf = res.stdout ?? Buffer.alloc(0);
    let offset = 0;
    for (const p of batch) {
      const headerEnd = buf.indexOf(0x0a, offset);
      if (headerEnd < 0) break;
      const header = buf.toString('utf8', offset, headerEnd);
      const m = header.match(/^[0-9a-f]+ blob (\d+)$/);
      if (!m) {
        skipped.push(p);
        offset = headerEnd + 1;
        continue;
      }
      const size = parseInt(m[1], 10);
      // Buffer.subarray 二进制安全（gzip blob 原样落盘）
      fs.writeFileSync(p.target, buf.subarray(headerEnd + 1, headerEnd + 1 + size));
      offset = headerEnd + 1 + size + 1;
    }
    batch = [];
    batchBytes = 0;
  };
  for (const p of planned) {
    const sz = sizes.get(p.oid) ?? 0;
    if (batch.length >= MATERIALIZE_BATCH_COUNT || (batchBytes + sz > MATERIALIZE_BATCH_BYTES && batch.length > 0)) flush();
    batch.push(p);
    batchBytes += sz;
  }
  flush();
  for (const p of skipped) {
    fs.writeFileSync(p.target, runGit(`git cat-file -p ${p.oid}`, dir));
  }
}

/**
 * 把 <root>[/baseline]/<sid>/ 物化到 <cache>/materialized/，重排成 proxy 布局
 * （<sid>.jsonl 与 <sid>/subagents/ 并列 —— claude-jsonl adapter 的约定）。
 * 多根模式自动定位所在位置（范式目录/baseline/存量区）。返回主 jsonl 路径。
 */
export function materializeSession(sid: string, remote: Cannbay2Remote = defaultCannbay2Remote(), recording: RecordingClass = 'capture'): string {
  const dir = ensureMirror(remote);
  if (!revParseMain(dir, remote)) throw new Error('cannbay2 mirror has no main branch');
  if (!/^[\w.-]+$/.test(sid)) throw new Error(`Invalid session id: "${sid}"`);

  // LFS 模式：.jsonl.7z/.jsonl.gz 仓内是指针 blob，cat-file 须带 --filters 让 smudge
  // 按需拉取 LFS 实体（本地 .git/lfs/objects 缓存，重复导入零下载）。
  // --filters 的属性解析读工作树 .gitattributes——读路径镜像默认无 checkout，
  // 需从 origin/main 物化一份（上传路径的 sparse 流程本就含 /.gitattributes）。
  // 判定对齐 ensureLfsGitattributes（缺 *.gz filter=lfs 声明即刷新，不是仅看
  // 文件存在）：同一镜像默认模式上传会把剔除过 lfs 行的 .gitattributes 写回
  // 工作树（LFS 免疫操作），此后远端切回 LFS 模式时过期副本会让 --filters
  // 不做 smudge——指针文本被当作 gzip 内容落盘，导入在解压环节报费解错误
  if (remote.lfs) {
    ensureLfsReady(dir);
    const gaPath = path.join(dir, '.gitattributes');
    let gaCur = '';
    try { gaCur = fs.readFileSync(gaPath, 'utf8'); } catch { /* 无文件 */ }
    // 判定对齐 ensureLfsGitattributes（*.7z 新形态 + *.gz 存量，缺任一即刷新）
    const gaStale = !/^\*\.7z\s+filter=lfs/m.test(gaCur) || !/^\*\.gz\s+filter=lfs/m.test(gaCur);
    if (gaStale) {
      try {
        fs.writeFileSync(gaPath, runGit(`git show origin/${remote.branch}:.gitattributes`, dir));
      } catch { /* 仓内无 .gitattributes → 无 lfs 声明，不可能存在指针件 */ }
    }
  }

  const locs = locateSessionLocations(dir, remote, sid, recording);
  if (locs.length === 0) throw new Error(`Session folder not found in cannbay2: "${sid}"`);
  if (locs.length > 1) throw new Error(`Session "${sid}" exists in multiple locations (${locs.map(l => locationPath(l, sid)).join(', ')}): 数据仓布局损坏，请手工修复`);

  const prefix = `${locationPath(locs[0], sid)}/`;
  // -z：路径永不 quotepath 转义；条目 <mode> SP <type> SP <oid> TAB <path> NUL
  const treeOut = runGit(`git ls-tree -r -z origin/${remote.branch} -- ${prefix}`, dir).toString('utf8');
  const entries: Array<{ mode: string; type: string; oid: string; repoPath: string }> = [];
  for (const rec of treeOut.split('\0')) {
    const entry = splitLsTreeEntry(rec);
    if (!entry) continue;
    const m = entry.meta.match(/^(\d+)\s+(\w+)\s+([0-9a-f]+)$/);
    if (!m) continue;
    entries.push({ mode: m[1], type: m[2], oid: m[3], repoPath: entry.path });
  }
  if (entries.length === 0) throw new Error(`Session folder not found in cannbay2: "${sid}"`);

  // 物化目标按记录类区分（同 sid 双记录互不覆盖）：capture = <sid>.jsonl[.7z|.gz] +
  // <sid>/subagents/（现状，兼容存量）；native = <sid>.native.jsonl[.7z|.gz] +
  // <sid>.native/subagents/。sid 平铺会让第二份物化覆盖第一份，导入后行
  // sourcePath 指到别人内容、增量刷新读错源（e2e 现场）。
  const matStem = sessionFolderOf(sid, recording);
  const matDir = path.join(dir, 'materialized', matStem);
  fs.rmSync(matDir, { recursive: true, force: true });
  let mainJsonl: string | null = null;
  // sessions/<folder>/<sid>.jsonl[.7z|.gz]|<sid>.meta.json → materialized/<matStem>.jsonl[.7z|.gz]|.meta.json
  // sessions/<folder>/subagents/* → materialized/<matStem>/subagents/*
  // .jsonl.7z 是压缩出仓形态（治理后 7z，proxy/COMPRESSION-DESIGN.md）；
  // 存量 .jsonl.gz 与旧明文仓件照旧物化 —— 三形态并存，parseJsonlLines 透明解压。
  const targetRelOf = (rel: string): string =>
    rel === `${sid}.jsonl` || rel === `${sid}.jsonl.7z` || rel === `${sid}.jsonl.gz` || rel === `${sid}.meta.json` ? rel.replace(sid, matStem) : `${matStem}/${rel}`;

  if (remote.lfs) {
    // LFS：指针 blob 实体在 LFS 存储，--filters smudge 逐文件拉取（不能批量）。
    // repoPath 来自 ls-tree -z 原始输出（除 NUL 外任意字节都可能出现），必须走
    // spawnSync argv 形式——内插进 shell 字符串会被恶意文件名（如 `sub"; cmd;
    // ".jsonl.gz`）注入任意命令；oid 是十六进制无此风险
    for (const e of entries) {
      const rel = targetRelOf(e.repoPath.slice(prefix.length));
      const target = path.join(dir, 'materialized', rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const cat = spawnSync('git', ['cat-file', '--filters', `--path=${e.repoPath}`, e.oid],
        { cwd: dir, stdio: 'pipe', timeout: 300_000, maxBuffer: 256 * 1024 * 1024 });
      if (cat.error || cat.status !== 0) {
        throw new Error(`git cat-file --filters failed for "${e.repoPath}" (${e.oid}): ${cat.error?.message ?? cat.stderr?.toString()}`);
      }
      fs.writeFileSync(target, cat.stdout);
      if (rel === `${matStem}.jsonl` || rel === `${matStem}.jsonl.7z` || rel === `${matStem}.jsonl.gz`) mainJsonl = target;
    }
  } else {
    // 批量物化：缺失 blob 先批量预取（一轮协商拉齐，替代逐文件懒取——实测
    // 167 缺失 ~80-95s 懒取 vs 7.2s 批量），再单进程分批写盘
    const local = localObjectOids(dir);
    const missing = entries.filter(e => !local.has(e.oid)).map(e => e.oid);
    if (missing.length > 0) prefetchBlobs(dir, missing);
    const planned: Array<{ oid: string; target: string }> = [];
    for (const e of entries) {
      const rel = targetRelOf(e.repoPath.slice(prefix.length));
      const target = path.join(dir, 'materialized', rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      planned.push({ oid: e.oid, target });
      if (rel === `${matStem}.jsonl` || rel === `${matStem}.jsonl.7z` || rel === `${matStem}.jsonl.gz`) mainJsonl = target;
    }
    materializeBlobsByBatch(dir, planned);
  }
  if (!mainJsonl) throw new Error(`Main jsonl missing for session "${sid}"`);
  return mainJsonl;
}

// ── 上传（sparse 物化 + scoped add + commit + push） ────────────────────

let writeLock: Promise<unknown> | null = null;
async function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  while (writeLock) await writeLock;
  let release: () => void = () => {};
  writeLock = new Promise<void>(r => { release = r; });
  try {
    return await fn();
  } finally {
    writeLock = null;
    release();
  }
}

export interface UploadResult {
  folder: string;
  unchanged: boolean;
  gitattributesFixed: boolean;
}

// ── LFS 模式（opt-in：remote.lfs，config.lfs > env CANNBAY2_LFS）─────────

export function hasGitLfs(): boolean {
  try {
    const r = spawnSync('git', ['lfs', 'version'], { stdio: 'pipe', timeout: 10_000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

// cpx 私有 git-lfs 件（~/.cannbot-insight/bin/git-lfs，cpx lfs-setup 自举产物：
// 系统 git-lfs 缺失时下载，零全局污染）。insight 复用同一份——两包数据目录
// 同源，PATH 注入后 git 子进程（filter/钩子）自然命中。CANNBOT_PROXY_DIR 重定向
// 优先（与 cpx lfs-setup 同语义，测试隔离用）。'.cannbot-insight' 引号字面量
// 由 pack-context 规则表品牌翻转（context 变体 → ~/.context-insight/bin）。
function privateLfsBinDir(): string {
  return path.join(path.dirname(process.env.CANNBOT_PROXY_DIR ?? path.join(os.homedir(), '.cannbot-insight', 'proxy')), 'bin');
}

/** 私有件存在且系统无 git-lfs 时前置 bin 目录到本进程 PATH（幂等；不碰
 *  gitconfig / 用户 shell 配置——仅本进程树，镜像 git 子进程自然继承）。 */
function ensurePrivateLfsOnPath(): void {
  const binDir = privateLfsBinDir();
  const priv = path.join(binDir, 'git-lfs');
  if (!fs.existsSync(priv)) return;
  if ((process.env.PATH ?? '').split(path.delimiter).includes(binDir)) return;
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`;
}

// git-lfs pre-push 钩子（与 `git lfs install` 写入的同款）：push 时上传
// LFS 对象。手工写入而非调 `git lfs install`——后者会顺带改全局 gitconfig，
// 库代码不该碰用户全局配置。
const LFS_PRE_PUSH_HOOK = '#!/bin/sh\ncommand -v git-lfs >/dev/null 2>&1 || { echo "git-lfs not installed"; exit 2; }\ngit lfs pre-push "$@"\n';

/** 镜像内 LFS 就绪：fail-fast git-lfs 在机检查 + 仓级 filter 配置 + pre-push
 *  钩子。幂等；不触碰全局配置（仓级配置优先级高于全局，双保险）。
 *  git-lfs 解析链：系统件 > cpx 私有件（~/.cannbot-insight/bin，PATH 注入）。 */
export function ensureLfsReady(dir: string): void {
  ensurePrivateLfsOnPath();
  if (!hasGitLfs()) {
    throw new Error('LFS 模式需要 git-lfs（`git lfs version` 不可用），三条出路任选：'
      + ' ① 系统安装 git-lfs 并确保在 PATH（https://git-lfs.github.com）；'
      + ' ② 跑一次 `cpx lfs-setup` 自举私有件到 ~/.cannbot-insight/bin（insight 自动复用，零全局污染）；'
      + ' ③ 设置 env CANNBAY2_LFS=0 关闭 LFS 走普通 git 存储');
  }
  runGit('git config filter.lfs.process "git-lfs filter-process"', dir, 10_000, { raw: true });
  runGit('git config filter.lfs.smudge "git-lfs smudge -- %f"', dir, 10_000, { raw: true });
  runGit('git config filter.lfs.clean "git-lfs clean -- %f"', dir, 10_000, { raw: true });
  runGit('git config filter.lfs.required true', dir, 10_000, { raw: true });
  const hook = path.join(dir, '.git', 'hooks', 'pre-push');
  if (!fs.existsSync(hook)) {
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, LFS_PRE_PUSH_HOOK, { mode: 0o755 });
  }
}

// LFS 模式下确保 .gitattributes 声明 *.7z / *.gz 走 LFS（缺行补行，与默认模式
// 的"剔除 lfs 行"互为镜像操作；*.gz 行必须保留——湖内存量 gz blob 的指针化
// 依赖它；模板仓自带则零改动。与 cpx mirror.ts 同构——parity IT 锁定）。
// 导出供 IT 直测（纯 fs + git add，不依赖 git-lfs 真机件——LFS 全链路 IT
// 无 git-lfs 机器整组 skip，本函数的补行/去重逻辑须在无 git-lfs 环境可回归）
export function ensureLfsGitattributes(dir: string): void {
  const gaPath = path.join(dir, '.gitattributes');
  const wanted = ['*.7z filter=lfs diff=lfs merge=lfs -text', '*.gz filter=lfs diff=lfs merge=lfs -text'];
  let cur = '';
  try { cur = fs.readFileSync(gaPath, 'utf8'); } catch { /* 无文件 */ }
  let changed = false;
  let out = cur.replace(/\n*$/, cur ? '\n' : '');
  for (const want of wanted) {
    const pat = want.split(' ')[0].replace(/[.*]/g, c => `\\${c}`);
    if (!new RegExp(`^${pat}\\s+filter=lfs`, 'm').test(out)) {
      out += `${want}\n`;
      changed = true;
    }
  }
  if (changed) {
    fs.writeFileSync(gaPath, out);
    runGit('git add .gitattributes', dir);
  }
}

/**
 * 把 stagingDir/sessions/<sid>/ 提交推送到远端 main。
 * - 目标位置：category + baseline → <category>/baseline/<sid>/（范式基准）；
 *   仅 category → <category>/<sid>/；无 category → rootDir（单根远端）
 * - baseline 交换语义（结构即状态，一次 commit 原子完成）：
 *   新会话写入 baseline/ 位置；范式原 baseline 会话（若为不同 sid）移回
 *   范式普通目录 <category>/<sidOld>/，baseline/ 下只保留新会话
 * - 旧位置清理：sid 已存在于其他位置（换范式/普通↔baseline 迁移）→
 *   sparse 物化旧位置、同 commit 删旧写新，保证 sid 全仓唯一
 * - narrow sparse-checkout：只物化该会话文件夹（+ .gitattributes）
 * - .gitattributes 若含 filter=lfs 行（任意 glob：*.jsonl/*.gz/…）→ 同 commit
 *   全部剔除。装了 git-lfs 的机器 add 会按这些行把文件指针化，push 需上传
 *   LFS 对象，孤儿指针直接阻断 push（客户现场：数据仓 HF 模板 *.gz 行 +
 *   .jsonl.gz 会话件）；未装 lfs 的机器 filter 未配置被静默忽略——同一仓
 *   两种机器行为分叉，剔除是唯一确定性防线
 * - push 失败（并发推进）→ fetch+merge 后重试一次
 */
export async function uploadFolder(stagingDir: string, sid: string, commitMessage: string, remote: Cannbay2Remote = defaultCannbay2Remote(), category?: string, baseline?: boolean, recording: RecordingClass = 'capture'): Promise<UploadResult> {
  return withWriteLock(async () => {
    // sid/category 拼进多条 git 命令（sparse-checkout set / add / ls-tree），
    // 白名单校验防命令注入 —— 与 materializeSession 同款（branch/rootDir
    // 已在 remote.ts resolve 时过同款白名单）
    if (!/^[\w.-]+$/.test(sid)) throw new Error(`Invalid session id: "${sid}"`);
    if (category != null && !/^[\w.-]+$/.test(category)) throw new Error(`Invalid paradigm dir: "${category}"`);
    const targetRoot = category ?? remote.rootDir;
    const dir = ensureMirror(remote);
    if (!revParseMain(dir, remote)) throw new Error('cannbay2 mirror has no main branch');
    // LFS 模式：镜像内就绪（git-lfs 检查 + filter 配置 + pre-push 钩子）
    if (remote.lfs) ensureLfsReady(dir);
    // 同 sid 双记录：目录名按记录类区分（捕获=裸 sid/，原生 claude=sid.native/）。
    // 全部路径推导（sparse/rm/target/交换）统一走 folder，另一记录类的目录
    // 永不触碰
    const folder = sessionFolderOf(sid, recording);

    // 本记录类的既有位置（除目标外全删：换范式 / 普通↔baseline 迁移）——
    // 只清理同记录类，另一记录类的目录不动（各自独立迁移/替换）
    // 存量迁移（旧世界非 proxy 上传落在裸 <sid>/）：记录类推导收全后裸目录
    // 不在 native 记录类的定位视野内 → 永不清理——list 同 sid 双条目、旧
    // 原生内容错标 capture 且永远无法被重传替换。上传 native 时识别裸目录
    // 的内容归属（bareDirHoldsNativeRecording：meta producer=cpx 或
    // framework 带 -proxy = 捕获不动；insight 导出件 = 存量原生 → 作为
    // 过期位置一并删除，本次上传在同 commit 完成迁移；无 meta 归属不明
    // 保守不动——宁可残留勿误删）
    const staleLocs = [
      ...locateSessionLocations(dir, remote, sid, recording)
        .filter(l => !(l.root === targetRoot && l.baseline === !!baseline)),
      // 裸目录与 .native 目标是不同路径，不存在「即目标位」——无需排除过滤
      ...(recording === 'native'
        ? locateSessionLocations(dir, remote, sid, 'capture')
            .filter(l => bareDirHoldsNativeRecording(dir, remote, l, sid))
        : []),
    ];
    // baseline 交换（按记录类执行）：范式现任 baseline 的同记录类会话（≠ 本
    // 目录）移回范式普通目录；另一记录类的 baseline 条目不动（每记录类各一个基准）。
    // isSafeRootSegment：baseline/ 下 ls-tree 原始目录名与本 PR 收口的 root
    // 同一威胁模型（旧仓/手工推送），不过滤即直通 sparse-checkout/git add
    // 的 shell 字符串；合法目录名（<sid> / <sid>.native，上传侧 \w.- 校验过）
    // 不受影响
    const swapBack: string[] = baseline
      ? locateBaselineSids(dir, remote, targetRoot)
          .filter(f => f !== folder && parseSessionFolder(f).recording === recording && isSafeRootSegment(f))
      : [];

    runGit('git sparse-checkout init --no-cone', dir);
    runGit(`git sparse-checkout set "/${targetRoot}/${folder}/**" "/.gitattributes"${staleLocs.map(l => ` "/${locationPath(l, sid)}/**"`).join('')}${baseline ? ` "/${targetRoot}/baseline/**"` : ''}${swapBack.map(s => ` "/${targetRoot}/${s}/**"`).join('')}`, dir);
    runGit(`git checkout -B ${remote.branch} origin/${remote.branch}`, dir);
    runGit('git reset --quiet', dir); // 丢弃上次失败上传可能残留的 staged 状态

    // staging 是该记录的完整权威集合：先清空目标目录与旧位置再拷入。
    // （旧明文残留清理同理：scoped add 不删旧根文件，必须显式 rm）
    for (const l of [...staleLocs.map(l => locationPath(l, sid)), baseline ? `${targetRoot}/baseline/${folder}` : `${targetRoot}/${folder}`]) {
      fs.rmSync(path.join(dir, ...l.split('/')), { recursive: true, force: true });
    }
    const targetRel = baseline ? `${targetRoot}/baseline/${folder}` : `${targetRoot}/${folder}`;
    const targetDir = path.join(dir, ...targetRel.split('/'));
    fs.mkdirSync(targetDir, { recursive: true });
    fs.cpSync(path.join(stagingDir, 'sessions', sid), targetDir, { recursive: true });

    // 交换：原 baseline 会话移回范式普通目录（文件原样，git rename 识别与否不影响 tree）
    const swapPaths: string[] = [];
    if (baseline) {
      fs.rmSync(path.join(dir, ...targetRoot.split('/'), 'baseline', '.gitkeep'), { force: true });
      for (const old of swapBack) {
        fs.rmSync(path.join(dir, ...targetRoot.split('/'), old), { recursive: true, force: true });
        fs.renameSync(
          path.join(dir, ...targetRoot.split('/'), 'baseline', old),
          path.join(dir, ...targetRoot.split('/'), old),
        );
        swapPaths.push(`${targetRoot}/${old}`);
      }
    }

    let gitattributesFixed = false;
    const gaPath = path.join(dir, '.gitattributes');
    if (remote.lfs) {
      // LFS 模式：反向操作——确保 *.gz 声明走 LFS（缺则补），绝不剔除
      ensureLfsGitattributes(dir);
    } else if (fs.existsSync(gaPath)) {
      const ga = fs.readFileSync(gaPath, 'utf8');
      const fixed = ga.split('\n').filter(l => !l.includes('filter=lfs')).join('\n');
      if (fixed !== ga) {
        fs.writeFileSync(gaPath, fixed);
        runGit('git add .gitattributes', dir);
        gitattributesFixed = true;
      }
    }

    const addPaths = [targetRel, ...staleLocs.map(l => locationPath(l, sid)), ...swapPaths, ...(baseline ? [`${targetRoot}/baseline`] : [])];
    // LFS 模式 add 不中和：clean 过滤器要把 .gz 转成 LFS 指针（对指针文本
    // 透传，baseline 搬移的 re-add 不重传）
    runGit(`git add ${addPaths.join(' ')}`, dir, 120_000, remote.lfs ? { raw: true } : undefined);
    const msgFile = path.join(dir, '_commit_msg.txt');
    fs.writeFileSync(msgFile, commitMessage);
    let unchanged = false;
    try {
      runGit(`git -c user.name=cannbot-insight -c user.email=insight@localhost commit -F "${msgFile}"`, dir);
    } catch {
      // commit 失败 ≠ 无变化：staged 仍有差异说明是真实失败（hook 拒绝/index 损坏等），
      // 不能静默报 unchanged 跳过 push。git diff --cached --quiet：exit 0 = 无 staged 差异
      try {
        runGit('git diff --cached --quiet', dir);
        unchanged = true; // 确无 staged 变更（重复上传同内容）
      } catch {
        throw new Error(`git commit failed for session "${sid}" while staged changes exist`);
      }
    }
    try { fs.unlinkSync(msgFile); } catch { /* ignore */ }

    if (!unchanged) {
      const push = () => { pushMirror(dir, remote); };
      try {
        push();
      } catch {
        runGit(`git fetch --quiet origin ${remote.branch}`, dir);
        runGit(`git -c user.name=cannbot-insight -c user.email=insight@localhost merge --allow-unrelated-histories --no-edit origin/${remote.branch}`, dir);
        push();
      }
    }
    return { folder: `${targetRel}/`, unchanged, gitattributesFixed };
  });
}

/**
 * 401 挑战-应答式 push：pushUrl 一律无凭据，凭据经一次性 credential helper
 * 供给——atomgit 网关已拒"请求直带密码"的内嵌 URL（proactive Basic 直接
 * CH.00905401 拒绝；同凭据经 401 挑战后重试可通过，2026-09-14 实测）。
 * helper 脚本只落 0700 临时目录、用后即删，凭据不进命令行（execSync 失败
 * 消息不含凭据）。`-c credential.helper=` 先清空继承链（全局 store 等），
 * 保证显式凭据确定性生效。pushAuth=null（本地 bare / 匿名推）直推。
 * LFS 模式：不用 --no-verify（pre-push 钩子 = LFS 对象上传通道，跳过即
 * 产生孤儿指针）；helper 的 -c 配置经 GIT_CONFIG_PARAMETERS 传给钩子，
 * git-lfs 的 batch API 鉴权与 git push 同源。
 */
export function pushMirror(dir: string, remote: Cannbay2Remote): void {
  const verify = remote.lfs ? '' : ' --no-verify';
  const raw = remote.lfs ? { raw: true as const } : undefined;
  if (!remote.pushAuth) {
    runGit(`git push${verify} "${remote.pushUrl}" ${remote.branch}`, dir, 300_000, raw);
    return;
  }
  const { username, password } = remote.pushAuth;
  if (/[\r\n]/.test(username) || /[\r\n]/.test(password)) {
    throw new Error('push 凭据含换行符（credential helper 协议非法）');
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-cannbay2-auth-'));
  try {
    const helper = path.join(tmp, 'helper.sh');
    fs.writeFileSync(
      helper,
      `#!/bin/sh\ncat <<'INSIGHTEOF'\nusername=${username}\npassword=${password}\nINSIGHTEOF\n`,
      { mode: 0o700 },
    );
    runGit(
      `git -c credential.helper= -c credential.helper="${helper}" push${verify} "${remote.pushUrl}" ${remote.branch}`,
      dir,
      300_000,
      raw,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
