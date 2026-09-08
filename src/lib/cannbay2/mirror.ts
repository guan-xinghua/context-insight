// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// cannbay2 git 镜像层：partial clone（--filter=blob:none）单镜像上传下载共用。
// 列表 = ls-tree + 一次 git log walk（零 blob 下载）；导入 = 按会话 cat-file
// 物化（重排成 proxy 布局）；上传 = narrow sparse-checkout + scoped add +
// commit + push main。写操作进程内 mutex 串行。测试通过
// CANNBAY2_REMOTE_URL / CANNBAY2_PUSH_URL / CANNBAY2_CACHE_DIR 指向本地 bare 仓。
import { execSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { defaultCannbay2Remote, escapeRegExp, normalizeDirPrefix, stripUrlCreds } from './remote';
import type { Cannbay2Remote } from './remote';

export { CANNBAY2_PULL_URL, CANNBAY2_PUSH_URL, CANNBAY2_BRANCH } from './remote';
export type { Cannbay2Remote } from './remote';

export function cannbay2CacheDir(remote?: Cannbay2Remote): string {
  return (remote ?? defaultCannbay2Remote()).cacheDir;
}

export function runGit(cmd: string, cwd: string, timeoutMs = 120_000): Buffer {
  return execSync(cmd, { cwd, stdio: 'pipe', timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 });
}

function runGitText(cmd: string, cwd: string): string {
  return runGit(cmd, cwd).toString();
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
}

/** 会话在仓内的位置：<root>/<sid>/（普通）或 <root>/baseline/<sid>/（baseline）。 */
export interface SessionLocation {
  root: string;
  baseline: boolean;
}

function locationPath(loc: SessionLocation, sid: string): string {
  return loc.baseline ? `${loc.root}/baseline/${sid}` : `${loc.root}/${sid}`;
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
    const pathPattern = remote.paradigmRoots
      ? /^[^/]+\/(?:baseline\/)?([^/]+)\/\1\.meta\.json$/
      : new RegExp(`^${escapeRegExp(remote.rootDir)}\\/(?:baseline\\/)?([^/]+)\\/\\1\\.meta\\.json$`);
    const wanted: Array<{ sid: string; oid: string }> = [];
    for (const rec of treeOut.split('\0')) {
      const entry = splitLsTreeEntry(rec);
      if (!entry) continue;
      const oidMatch = entry.meta.match(/^[0-9]+\s+blob\s+([0-9a-f]+)$/);
      if (!oidMatch) continue;
      const pathMatch = entry.path.match(pathPattern);
      if (pathMatch) wanted.push({ sid: pathMatch[1], oid: oidMatch[1] });
    }
    if (wanted.length === 0) return out;
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
        out.set(w.sid, {
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
  const dir = ensureMirror(remote);
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
      const sid = multiRoot ? m[3] : m[2];
      fileCount.set(sid, (fileCount.get(sid) ?? 0) + 1);
      sidLoc.set(sid, { root: multiRoot ? m[1] : remote.rootDir, baseline: m[m.length - 2] != null });
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
          const sid = multiRoot ? m[3] : m[2];
          if (!sidCommit.has(sid)) sidCommit.set(sid, { author, time, subject });
        }
      }
    }
  } catch { /* 无历史时列表退化为纯文件名 */ }

  const entries: Cannbay2SessionEntry[] = [];
  const metas = readSessionMetas(dir, remote);
  for (const [sid, count] of fileCount) {
    const newest = sidCommit.get(sid);
    const author = newest?.author ?? '';
    const { submitter, description } = parseCommitSubject(newest?.subject ?? '', author);
    const meta = metas.get(sid);
    const loc = sidLoc.get(sid) ?? { root: remote.rootDir, baseline: false };
    const paradigm = multiRoot && loc.root !== remote.rootDir ? loc.root : null;
    entries.push({ sid, fileCount: count, author, submitter, description, commitTime: newest?.time ?? '', framework: meta?.framework ?? null, ccVersion: meta?.ccVersion ?? null, producer: meta?.producer ?? null, opGen: meta?.opGen ?? null, paradigm, isBaseline: loc.baseline });
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
  const dir = ensureMirror(remote);
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
function locateSessionLocations(dir: string, remote: Cannbay2Remote, sid: string): SessionLocation[] {
  if (!remote.paradigmRoots) {
    const locs: SessionLocation[] = [];
    for (const baseline of [false, true]) {
      const p = `${remote.rootDir}${baseline ? '/baseline' : ''}/${sid}`;
      if (runGitText(`git ls-tree --name-only origin/${remote.branch} ${p}`, dir).trim()) {
        locs.push({ root: remote.rootDir, baseline });
      }
    }
    return locs;
  }
  const out = lsTreeFiles(dir, '', remote).join('\n');
  const re = new RegExp(`^([^/]+)\\/(baseline\\/)?${escapeRegExp(sid)}\\/`);
  const locs = new Map<string, SessionLocation>();
  for (const line of out.split('\n')) {
    const m = line.match(re);
    if (m) locs.set(`${m[1]}/${m[2] ?? ''}`, { root: m[1], baseline: m[2] != null });
  }
  return [...locs.values()];
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

/**
 * 把 <root>[/baseline]/<sid>/ 物化到 <cache>/materialized/，重排成 proxy 布局
 * （<sid>.jsonl 与 <sid>/subagents/ 并列 —— claude-jsonl adapter 的约定）。
 * 多根模式自动定位所在位置（范式目录/baseline/存量区）。返回主 jsonl 路径。
 */
export function materializeSession(sid: string, remote: Cannbay2Remote = defaultCannbay2Remote()): string {
  const dir = ensureMirror(remote);
  if (!revParseMain(dir, remote)) throw new Error('cannbay2 mirror has no main branch');
  if (!/^[\w.-]+$/.test(sid)) throw new Error(`Invalid session id: "${sid}"`);

  const locs = locateSessionLocations(dir, remote, sid);
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

  const matDir = path.join(dir, 'materialized', sid);
  fs.rmSync(matDir, { recursive: true, force: true });
  let mainJsonl: string | null = null;
  // 注：cat-file 触发逐对象懒取（每次一次 HTTPS 协商）。实测批量 fetch 无收益
  // （1MB 会话 1.6-1.7s vs 逐取 1.1-1.5s，成本均在协商固定开销），保持简单。
  for (const e of entries) {
    const rel = e.repoPath.slice(prefix.length);
    // sessions/<sid>/<sid>.jsonl[.gz]|<sid>.meta.json → materialized/<sid>.jsonl[.gz]|.meta.json
    // sessions/<sid>/subagents/* → materialized/<sid>/subagents/*
    // .jsonl.gz 是压缩出仓形态（治理后 gzip，proxy/COMPRESSION-DESIGN.md）；
    // 旧明文仓件照旧物化为 .jsonl —— 双形态并存，parseJsonlLines 透明解压。
    const targetRel = rel === `${sid}.jsonl` || rel === `${sid}.jsonl.gz` || rel === `${sid}.meta.json`
      ? rel
      : `${sid}/${rel}`;
    const target = path.join(dir, 'materialized', targetRel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, runGit(`git cat-file -p ${e.oid}`, dir));
    if (targetRel === `${sid}.jsonl` || targetRel === `${sid}.jsonl.gz`) mainJsonl = target;
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
export async function uploadFolder(stagingDir: string, sid: string, commitMessage: string, remote: Cannbay2Remote = defaultCannbay2Remote(), category?: string, baseline?: boolean): Promise<UploadResult> {
  return withWriteLock(async () => {
    // sid/category 拼进多条 git 命令（sparse-checkout set / add / ls-tree），
    // 白名单校验防命令注入 —— 与 materializeSession 同款（branch/rootDir
    // 已在 remote.ts resolve 时过同款白名单）
    if (!/^[\w.-]+$/.test(sid)) throw new Error(`Invalid session id: "${sid}"`);
    if (category != null && !/^[\w.-]+$/.test(category)) throw new Error(`Invalid paradigm dir: "${category}"`);
    const targetRoot = category ?? remote.rootDir;
    const dir = ensureMirror(remote);
    if (!revParseMain(dir, remote)) throw new Error('cannbay2 mirror has no main branch');

    // 本会话既有位置（除目标外全删：换范式 / 普通↔baseline 迁移）
    const staleLocs = locateSessionLocations(dir, remote, sid)
      .filter(l => !(l.root === targetRoot && l.baseline === !!baseline));
    // baseline 交换：范式现任 baseline 会话（≠ 本 sid）移回范式普通目录
    const swapBack: string[] = baseline
      ? locateBaselineSids(dir, remote, targetRoot).filter(s => s !== sid)
      : [];

    runGit('git sparse-checkout init --no-cone', dir);
    runGit(`git sparse-checkout set "/${targetRoot}/${sid}/**" "/.gitattributes"${staleLocs.map(l => ` "/${locationPath(l, sid)}/**"`).join('')}${baseline ? ` "/${targetRoot}/baseline/**"` : ''}${swapBack.map(s => ` "/${targetRoot}/${s}/**"`).join('')}`, dir);
    runGit(`git checkout -B ${remote.branch} origin/${remote.branch}`, dir);
    runGit('git reset --quiet', dir); // 丢弃上次失败上传可能残留的 staged 状态

    // staging 是该会话的完整权威集合：先清空目标目录与旧位置再拷入。
    // （旧明文残留清理同理：scoped add 不删旧根文件，必须显式 rm）
    for (const l of [...staleLocs.map(l => locationPath(l, sid)), baseline ? `${targetRoot}/baseline/${sid}` : `${targetRoot}/${sid}`]) {
      fs.rmSync(path.join(dir, ...l.split('/')), { recursive: true, force: true });
    }
    const targetRel = baseline ? `${targetRoot}/baseline/${sid}` : `${targetRoot}/${sid}`;
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
    if (fs.existsSync(gaPath)) {
      const ga = fs.readFileSync(gaPath, 'utf8');
      const fixed = ga.split('\n').filter(l => !l.includes('filter=lfs')).join('\n');
      if (fixed !== ga) {
        fs.writeFileSync(gaPath, fixed);
        runGit('git add .gitattributes', dir);
        gitattributesFixed = true;
      }
    }

    const addPaths = [targetRel, ...staleLocs.map(l => locationPath(l, sid)), ...swapPaths, ...(baseline ? [`${targetRoot}/baseline`] : [])];
    runGit(`git add ${addPaths.join(' ')}`, dir);
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
      const push = () => { runGit(`git push "${remote.pushUrl}" ${remote.branch}`, dir, 300_000); };
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
