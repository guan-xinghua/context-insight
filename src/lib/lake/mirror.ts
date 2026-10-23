// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// lake git 镜像层：partial clone（--filter=blob:none）单镜像上传下载共用。
// 列表 = ls-tree + 一次 git log walk + meta 批量读（缺失 blob 先批量预取，
// 一轮 fetch 协商拉齐；listOverview 让列表+顶层目录共享单轮 fetch）；导入 =
// 缺失 blob 批量预取后 cat-file --batch 分批物化（重排成 proxy 布局）；
// 上传 = narrow sparse-checkout + scoped add + commit + push main。
// 写操作进程内 mutex 串行。单源架构：远端配置只从服务端 lake-config.json
// 来（测试经 CONTEXT_PROXY_DIR 隔离 + 写该文件，镜像缓存 LAKE_CACHE_DIR）。
import { execSync, spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultLakeRemote, escapeRegExp, normalizeDirPrefix, redactRemoteSecrets, stripUrlCreds } from './remote';
import type { LakeRemote, PushAuth } from './remote';
import { BUNDLE_ROOT_DIR, BUNDLE_MANIFEST_FILE, BUNDLE_META_FILE } from './bundle-layout';
import { privateLfsBinDir, ensureLfsBinaryAvailable } from './lfs-setup';
import { readEnvelope } from '../shared/envelope';
import { isProxyVersion } from '../shared/session-format';
// 相对导入纪律：mirror.ts 的导入图会被 tmp/ 下的 tsx 子进程脚本直接引
// （lake-mirror-init IT 等）——子进程入口不在 tsconfig include 内，@/ 别名
// 整体失效，本图内一律相对路径（logger → logger-config → store 同链同理）
import { createLogger } from '../logger';

const lakeLog = createLogger('lake');

export type { LakeRemote } from './remote';

export function lakeCacheDir(remote?: LakeRemote): string {
  return (remote ?? defaultLakeRemote()).cacheDir;
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
// opts.env / opts.input：git plumbing 场景（notes 记录链的临时 GIT_INDEX_FILE
// 操纵、hash-object -w --stdin 内容写入）——env 与 process.env 合并传入。
// GIT_TERMINAL_PROMPT=0 不可被调用方覆写：服务端 git 绝不允许终端交互——
// 私有仓匿名 401 时 git 会退到终端问用户名，把 HTTP 请求冻到超时、提示
// 串进服务器终端（现场形态：进 viewer 页面终端停在 Username for ...）。
// 快速失败，错误文案由 classifyLakeError 分诊 auth-failed
export function runGit(
  cmd: string,
  cwd: string,
  timeoutMs = 120_000,
  opts?: { raw?: boolean; env?: NodeJS.ProcessEnv; input?: string },
): Buffer {
  const neutral = !opts?.raw && cmd.startsWith('git ')
    ? `git ${LFS_NEUTRALIZE} ${cmd.slice('git '.length)}`
    : cmd;
  return execSync(neutral, {
    cwd, stdio: 'pipe', timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, ...(opts?.env ?? {}), GIT_TERMINAL_PROMPT: '0' },
    ...(opts?.input != null ? { input: opts.input } : {}),
  });
}

function runGitText(cmd: string, cwd: string): string {
  return runGit(cmd, cwd).toString();
}

// ── blob 批量预取 ────────────────────────────────────────────────────
// partial clone（--filter=blob:none）下 blob 按需懒取：每个缺失对象一次独立
// HTTPS 协商（平台实测 ~1s/个）。批量预取 = 一轮 git fetch <oids> 协商拉齐
// 全部缺失（实测 1601 个 meta 9.3s，懒取需 ~28min），与懒取走同一服务端能力
// （uploadpack.allowAnySHA1InWant；平台支持，本地 bare fixture 同配）。
// 任何失败静默跳过 —— 后续逐对象 cat-file 懒取路径不变，行为不劣化。

// 单次 fetch 的 OID 数（命令行长度安全：200 × 41B ≈ 8KB，Windows 限制内）
const FETCH_OID_CHUNK = 200;

/** 本地已落库对象清单（--batch-all-objects 只列本地，不触发懒取）。 */
export function localObjectOids(dir: string): Set<string> {
  const out = runGit("git cat-file --batch-all-objects --batch-check='%(objectname)'", dir);
  return new Set(out.toString('utf8').split('\n').map(l => l.trim()).filter(Boolean));
}

/** 把缺失 blob 分块批量拉齐。oid 白名单校验（拼进 shell 命令）。私有仓经
 * 一次性 credential helper 鉴权（同 clone/fetch 的 pullAuth 通道）。 */
export function prefetchBlobs(dir: string, oids: string[], auth?: { username: string; password: string } | null): void {
  const valid = oids.filter(o => /^[0-9a-f]{40,64}$/.test(o));
  for (let i = 0; i < valid.length; i += FETCH_OID_CHUNK) {
    try {
      runGitWithAuth(`git fetch --quiet origin ${valid.slice(i, i + FETCH_OID_CHUNK).join(' ')}`, dir, auth ?? null, 300_000);
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
      if (Date.now() > deadline) throw new Error(`lake mirror init lock timeout: ${lock}`);
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
function cloneMirror(dir: string, remote: LakeRemote): void {
  const target = path.resolve(dir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    // --no-local：本地路径 clone 默认走硬链接、忽略 --filter（测试指向本地 bare 仓时
    // 会退化成全量镜像、物化不再是按需下载）；HTTPS 远端不受影响
    runGitWithAuth(
      `git clone --quiet --no-local --filter=blob:none --no-checkout "${remote.pullUrl}" "${tmp}"`,
      path.dirname(target),
      remote.pullAuth,
      600_000,
    );
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

/** 镜像存在且 fetch 成功（元数据就绪）。fetch 失败 ≠ 损坏：
 *  - origin 完好 + 引用可解析 → 瞬态失败（网络抖动 / 另一进程在同一镜像里
 *    上传时的 refs 锁竞争）→ 保留镜像（元数据可能略旧），绝不 rmSync 重建
 *    ——否则会炸掉在途上传的仓库；
 *  - 地址不符 / 引用缺失 → 配置级损坏或半成品 → 走重建自愈。
 * origin 一致性在 fetch 之前校验：镜像路径与远端的绑定只靠目录约定（cacheDir
 * 哈希），同一路径换远端（env 覆写换址 / 哈希碰撞外的人工挪用）时旧 origin
 * 的 fetch 照样成功——不先验地址就会静默读写错误的仓库（2026-09-22 默认仓
 * 迁址实测：主页仍显示旧仓 113 会话）。rev-parse 不在此处做：空仓克隆后
 * 无 origin/<branch> 是合法中间态，fetch 它成功即认可。 */
function tryFetchMirror(dir: string, remote: LakeRemote): boolean {
  if (!fs.existsSync(path.join(dir, '.git'))) return false;
  try {
    const originUrl = runGitText('git remote get-url origin', dir).trim();
    if (stripUrlCreds(originUrl) !== stripUrlCreds(remote.pullUrl)) return false;
  } catch {
    return false;
  }
  try {
    runGitWithAuth(`git fetch --quiet origin ${remote.branch}`, dir, remote.pullAuth);
    return true;
  } catch {
    return mirrorLocallyUsable(dir, remote);
  }
}

/** 确保 partial clone 镜像存在且 origin/<branch> 元数据最新（不下载 blob）。
 *  首拉/重建在跨进程文件锁下进行 + 锁内双检（等锁期间同伴可能已完成），
 *  自愈只删自身 cacheDir，不动兄弟远端缓存。 */
export function ensureMirror(remote: LakeRemote = defaultLakeRemote()): string {
  const dir = path.resolve(remote.cacheDir);
  if (tryFetchMirror(dir, remote)) {
    syncMirrorCredentials(dir, remote);
    return dir;
  }
  withMirrorInitLock(dir, () => {
    if (!tryFetchMirror(dir, remote)) {
      cloneMirror(dir, remote);
    }
  });
  syncMirrorCredentials(dir, remote);
  return dir;
}

// ── 镜像仓级凭据自持 ─────────────────────────────────────────────────
// partial clone 的 promisor 懒取（checkout/reset 物化稀疏锥、cat-file 补漏、
// sparse-checkout 应用）由 git 内部回源，凭据取自 git 配置链（system →
// global → repo → -c），不走 insight 的一次性 helper——后者只覆盖显式包裹
// 的命令。干净机器（无全局 credential helper）上私有远端的懒取恒匿名 401
// （现场形态：上传弹「令牌无效或已过期」，实为 checkout -B 物化懒取被拒，
// 经 classifyLakeError 分诊成 auth-failed）。
// 根治 = 镜像仓自持凭据：lake-auth.json 单源凭据固化进镜像本地配置——
//   .git/lake-cred-helper.sh（0700，与一次性 helper 同 heredoc 协议）
//   repo config: credential.helper=""（清 system/global 继承链，确定性）
//               + credential.helper=<helper 路径>
// 此后镜像内一切 git 进程——显式命令、内部懒取、LFS 钩子（git-lfs 的
// credential fill 同读仓级配置）、用户手工进镜像操作——都从仓级配置解析
// 凭据，与机器环境解耦。一次性 helper（clone 在镜像成形前仍必需；显式
// fetch/push 的确定性通道）保留，两层互不冲突（-c 链优先，同源同值）。

const CRED_HELPER_NAME = 'lake-cred-helper.sh';

/** 与一次性 helper 同款 heredoc 协议（username/password 字面量已在
 *  runGitWithAuth 同款校验里拒过换行；此处再拒一次防御内部构造路径）。 */
function credHelperScript(auth: { username: string; password: string }): string {
  if (/[\r\n]/.test(auth.username) || /[\r\n]/.test(auth.password)) {
    throw new Error('git credentials contain newline (invalid for credential helper protocol)');
  }
  return `#!/bin/sh\ncat <<'INSIGHTEOF'\nusername=${auth.username}\npassword=${auth.password}\nINSIGHTEOF\n`;
}

/** 仓级 credential.helper 值清单（保序，含空值清位项；[] = 未配置）。
 *  --local 限定：幂等比较只看镜像自己的配置，不混入机器 ambient 链。 */
function localCredHelpers(dir: string): string[] {
  try {
    const out = runGit('git config --local --get-all credential.helper', dir).toString('utf8');
    // 只剥结尾换行，保留中间的空行——空值清位项是配置的一部分
    return out.replace(/\n$/, '').split('\n');
  } catch { return []; }
}

/** 仓级 credential.helper 配置落位（幂等：已一致零 git 调用）。
 *  helperPath=null → 卸载（凭据撤销后镜像必须停止认证）。
 *  argv 形态 spawn：helper 路径可含空格，不经 shell。 */
function setLocalCredHelpers(dir: string, helperPath: string | null): void {
  const want = helperPath ? ['', helperPath] : [];
  const cur = localCredHelpers(dir);
  if (cur.length === want.length && cur.every((v, i) => v === want[i])) return;
  const run = (args: string[]): void => {
    const r = spawnSync('git', args, {
      cwd: dir, stdio: 'pipe', timeout: 10_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    // exit 5 = unset 目标不存在（首次安装/已清理），预期内
    if (r.status !== 0 && r.status !== 5) {
      throw new Error(`git config ${args.join(' ')} failed (exit ${r.status})`);
    }
  };
  run(['config', '--local', '--unset-all', 'credential.helper']);
  if (helperPath) {
    run(['config', '--local', '--add', 'credential.helper', '']);
    run(['config', '--local', '--add', 'credential.helper', helperPath]);
  }
}

/** 镜像凭据同步（ensureMirror 双栈收敛点，幂等）：
 *  - storedAuth 且有凭据 → helper 内容变化才重写（临时文件 + rename 原子
 *    落位，并发 ensureMirror 不撕裂），仓级配置落位；轮换即随下次
 *    ensureMirror 生效
 *  - storedAuth 且无凭据（单源查过为空/已清除）→ 卸载 helper 与配置
 *  - 非 storedAuth（adhoc 编辑态）→ 零动作：镜像绑定的始终是持久单源凭据，
 *    表单瞬态值不落盘（上次安装的状态不受 adhoc 调用影响） */
function syncMirrorCredentials(dir: string, remote: LakeRemote): void {
  if (remote.storedAuth !== true) return;
  const helperPath = path.join(dir, '.git', CRED_HELPER_NAME);
  if (remote.pullAuth) {
    const content = credHelperScript(remote.pullAuth);
    let cur: string | null = null;
    try { cur = fs.readFileSync(helperPath, 'utf8'); } catch { /* 未安装 */ }
    if (cur !== content) {
      const tmp = `${helperPath}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, content, { mode: 0o700 });
      fs.renameSync(tmp, helperPath);
    }
    setLocalCredHelpers(dir, helperPath);
  } else {
    fs.rmSync(helperPath, { force: true });
    setLocalCredHelpers(dir, null);
  }
}

export function revParseMain(dir: string, remote: LakeRemote = defaultLakeRemote()): string | null {
  try {
    return runGitText(`git rev-parse origin/${remote.branch}`, dir).trim();
  } catch {
    return null;
  }
}

// ── 列表（零 blob） ────────────────────────────────────────────────────

export interface LakeSessionEntry {
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
  /** 任务结果标注（cc-session-meta 可选字段 opGen，上传时人工勾选），无则 null=未标注 */
  opGen: 'success' | 'failure' | null;
  /** 所在顶层范式目录（全仓顶层目录即注册表，恒多根：rootDir 位置同普通
   *  目录名——rootDir 仅作上传缺省目录，不参与扫描分流）；根级会话（repo
   *  根 <sid>/，root=''）为 null——导入侧归入「根目录」桶 */
  paradigm: string | null;
  /** 是否范式 baseline 会话（位置即身份：<paradigm>/baseline/<sid>/，路径推导非存储标记） */
  isBaseline: boolean;
  /** 记录类（同 sid 双记录）：capture=裸 <sid>/ 目录（wire 捕获 / 主位上传），
   *  native=<sid>.native/ 目录（原生 claude 会话文件）。同一 sid 可各有一条。 */
  recording: RecordingClass;
}

/** 会话在仓内的位置：<root>/<sid>/（普通）或 <root>/baseline/<sid>/（baseline）。 */
/** 记录类（同 sid 双记录·lake 侧）：同一 sid 的 wire 捕获与原生会话两份
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

/** 仓内文件路径 → 会话目录归属（任意深度统一推导）：文件所在目录的末段即
 *  会话目录（subagents/ 名下的文件归父会话）；紧邻会话目录之前的 baseline
 *  段计 baseline 位；根级会话（<sid>/<file>，无范式前缀，缺省上传位）root
 *  为 ''。一级范式 <paradigm>/<sid>/ 与嵌套自定义 directory
 *  <dir>/<sub>/<sid>/（如 trace/2026-08/<sid>/）统一识别——中间目录（月份
 *  等）不直接含文件，天然不产生幻影条目。根级仅认「锚定文件名」：目录内
 *  须有 <sid>.jsonl.7z / <sid>.jsonl.gz / <sid>.meta.json（上传管道出仓必
 *  压缩——裸 .jsonl 不是管道产物）或 subagents/ 子目录——viewer 的范式
 *  目标文件 <paradigm>/<paradigm>.jsonl（明文追加式）与语料目录散置 jsonl
 *  都不是根级会话，目录保持范式身份。顶层散文件（无目录）不识别。 */
function resolveSessionPath(p: string): { folder: string; root: string; baseline: boolean; dirPath: string } | null {
  const slash = p.lastIndexOf('/');
  if (slash < 0) return null;
  const segs = p.slice(0, slash).split('/');
  // bundle 专区（opsbot-bundle/<runId>/…）不是会话布局：成员会话只归 bundle，
  // 不进会话列表/定位视野（设计 lake-bundle R5）
  if (segs[0] === BUNDLE_ROOT_DIR) return null;
  let fi = segs.length - 1;
  if (segs[fi] === 'subagents') {
    if (fi === 0) return null;
    fi -= 1;
  }
  if (fi < 0) return null;
  const folder = segs[fi];
  if (!folder || folder === 'baseline') return null;
  // 根级会话锚定（仅压缩态/meta——裸 .jsonl 恰是 viewer 范式目标文件
  // <paradigm>/<paradigm>.jsonl 的形态，不能当会话）。根级 baseline
  // （baseline/<sid>/，仅手工放置）同判：root='' + baseline 位
  const isRootBaseline = fi === 1 && segs[0] === 'baseline';
  if (fi === 0 || isRootBaseline) {
    const realSid = parseSessionFolder(folder).sid;
    const anchored = new RegExp(`^${isRootBaseline ? 'baseline\\/' : ''}${escapeRegExp(folder)}\\/${escapeRegExp(realSid)}\\.(?:jsonl\\.(?:7z|gz)|meta\\.json)$`).test(p)
      || (!isRootBaseline && p.startsWith(`${folder}/subagents/`));
    if (!anchored) return null;
  }
  return { folder, root: fi === 0 || isRootBaseline ? '' : segs[0], baseline: fi >= 1 && segs[fi - 1] === 'baseline', dirPath: segs.slice(0, fi + 1).join('/') };
}

export interface SessionLocation {
  root: string;
  baseline: boolean;
  recording: RecordingClass;
}

function locationPath(loc: SessionLocation, sid: string): string {
  const folder = sessionFolderOf(sid, loc.recording);
  const base = loc.root ? `${loc.root}/` : '';
  return loc.baseline ? `${base}baseline/${folder}` : `${base}${folder}`;
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
// "09_fa_op_gen/7\346\234\210/…"）——路径里只要有一段中文（语料仓
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
function lsTreeFiles(dir: string, spec: string, remote: LakeRemote): string[] {
  const out = runGit(`git ls-tree -r -z --name-only origin/${remote.branch}${spec}`, dir);
  return out.toString('utf8').split('\0').map(decodeGitPath).filter(l => l.length > 0);
}

// ls-tree -z（顶层单层树）→ 目录名数组。
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

/**
 * 单个子进程 `cat-file --batch` 流式读取全部 <rootDir>/<sid>/<sid>.meta.json。
 * meta 都是 KB 级小 blob，批量一次协议协商拉取（对比逐 blob cat-file 每个一次
 * 协商）；已缓存的 blob 纯本地读。列表 type 列的唯一数据源。
 * 多根模式 meta 可位于任一顶层目录（<paradigm>/<sid>/<sid>.meta.json），含
 * baseline 位置（<paradigm>/baseline/<sid>/<sid>.meta.json）。
 */
function readSessionMetas(dir: string, remote: LakeRemote): Map<string, { framework: string | null; ccVersion: string | null; producer: string | null; opGen: 'success' | 'failure' | null; submitter: string | null; description: string | null; remark: string | null }> {
  const out = new Map<string, { framework: string | null; ccVersion: string | null; producer: string | null; opGen: 'success' | 'failure' | null; submitter: string | null; description: string | null; remark: string | null }>();
  try {
    const spec = '';
    const treeOut = runGit(`git ls-tree -r -z origin/${remote.branch}${spec}`, dir).toString('utf8');
    // 双目录形态（同 sid 双记录）：裸 <sid>/<sid>.meta.json（捕获/主位）与
    // <sid>.native/<sid>.meta.json（原生——目录带后缀、文件用真实 sid）。
    // 键 = 目录名（folder），与 listSessionsIn 的 fileCount/sidLoc 对齐；
    // 路径归属经 resolveSessionPath（任意深度——嵌套 directory 下同形态可寻）
    const wanted: Array<{ folder: string; oid: string }> = [];
    for (const rec of treeOut.split('\0')) {
      const entry = splitLsTreeEntry(rec);
      if (!entry) continue;
      const oidMatch = entry.meta.match(/^[0-9]+\s+blob\s+([0-9a-f]+)$/);
      if (!oidMatch) continue;
      const loc = resolveSessionPath(entry.path);
      if (!loc) continue;
      const fileName = entry.path.slice(entry.path.lastIndexOf('/') + 1);
      // 裸形态文件名 = 目录名；.native 形态文件名 = 去后缀真实 sid，补回后缀才是目录名（map 键）
      if (fileName === `${loc.folder}.meta.json`) wanted.push({ folder: loc.folder, oid: oidMatch[1] });
      else if (loc.folder.endsWith(NATIVE_FOLDER_SUFFIX) && fileName === `${loc.folder.slice(0, -NATIVE_FOLDER_SUFFIX.length)}.meta.json`) wanted.push({ folder: loc.folder, oid: oidMatch[1] });
    }
    if (wanted.length === 0) return out;
    // 缺失 meta blob 批量预取：一轮 fetch 协商拉齐（懒取是逐对象一次协商，
    // 千级缺失时列表被 120s 超时截断、type 列残缺；实测 2370 缺失 ≈ 42min
    // 懒取 vs ~10s 批量）。失败回退懒取。
    const local = localObjectOids(dir);
    const missing = wanted.filter(w => !local.has(w.oid)).map(w => w.oid);
    if (missing.length > 0) prefetchBlobs(dir, missing, remote.pullAuth);
    // spawnSync（非 execSync）：execSync 自定义 stdio 时不返回 stdout，且输入
    // 走 stdin 需要独立 pipe —— 这里要求拿回完整批量输出 buffer
    const batch = spawnGitAuthed(['cat-file', '--batch'], dir, remote.pullAuth, 120_000,
      { input: wanted.map(w => `${w.oid}\n`).join(''), maxBuffer: 256 * 1024 * 1024 });
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
        const d = readEnvelope(JSON.parse(body))?.data;
        out.set(w.folder, {
          framework: typeof d?.framework === 'string' ? d.framework : null,
          ccVersion: typeof d?.ccVersion === 'string' ? d.ccVersion : null,
          producer: typeof d?.producer === 'string' ? d.producer : null,
          // opGen（可选字段，spec §4.4）：只认 success/failure，其余值/缺省一律未标注
          opGen: d?.opGen === 'success' || d?.opGen === 'failure' ? d.opGen : null,
          // 提交信息快照（可选字段，spec §4.4，上传时刻写入）：归属权威源，
          // 存量旧 meta 缺省为 null（读方回落 git log 推导）
          submitter: typeof d?.submitter === 'string' && d.submitter ? d.submitter : null,
          description: typeof d?.description === 'string' && d.description ? d.description : null,
          remark: typeof d?.remark === 'string' && d.remark ? d.remark : null,
        });
      } catch { /* 截断/畸形 meta → null，不拖垮整个列表 */ }
    }
  } catch { /* meta 批量读失败 → type 列降级为空，列表主体不受影响 */ }
  return out;
}

/** ls-tree + 一次 git log walk + 一次批量 meta 读取 → 全部会话文件夹及提交元数据。 */
export function listSessions(remote: LakeRemote = defaultLakeRemote()): LakeSessionEntry[] {
  return listSessionsIn(ensureMirror(remote), remote);
}

function listSessionsIn(dir: string, remote: LakeRemote): LakeSessionEntry[] {
  const mainRev = revParseMain(dir, remote);
  if (!mainRev) return [];

  // 恒多根全树扫描：会话目录按「最深层含文件目录」推导（resolveSessionPath）
  // ——一级范式 <paradigm>/<sid>/、根级 <sid>/（缺省上传位）、嵌套自定义
  // directory <dir>/<sub>/<sid>/ 统一识别；baseline 段紧邻会话目录前计 baseline 位
  const treeFiles = lsTreeFiles(dir, '', remote);
  const fileCount = new Map<string, number>();
  const sidLoc = new Map<string, SessionLocation>();
  for (const line of treeFiles) {
    const loc = resolveSessionPath(line);
    if (!loc) continue;
    fileCount.set(loc.folder, (fileCount.get(loc.folder) ?? 0) + 1);
    const prev = sidLoc.get(loc.folder);
    // 同 sid 多位置（如根级/存量 + 范式位并存）：保留范式位（root≠rootDir）
    // ——根级/存量条目不覆盖已注册的范式条目
    const isParadigmLoc = loc.root !== remote.rootDir;
    if (!prev || isParadigmLoc || prev.root === remote.rootDir) {
      sidLoc.set(loc.folder, { root: loc.root, baseline: loc.baseline, recording: parseSessionFolder(loc.folder).recording });
    }
  }

  // 一次 log walk：sid → 最后触碰 commit（log 新→旧，首个命中即最新；
  // notes(viewer): 维护提交跳过）。单遍分组 O(files)——按 sid 再 filter 一遍
  // 是 O(N²)，千级会话时列表超 2s。
  // -c core.quotepath=off：log --name-only 的中文路径同样默认转义加引号
  const sidCommit = new Map<string, { author: string; time: string; subject: string }>();
  try {
    const logOut = runGitText(
      `git -c core.quotepath=off log --pretty=format:%x00%an%x1f%aI%x1f%s --name-only origin/${remote.branch}`,
      dir,
    );
    for (const record of logOut.split('\x00')) {
      const lines = record.split('\n').filter(l => l.trim());
      if (lines.length === 0) continue;
      const [author, time, ...subjectParts] = lines[0].split('\x1f');
      const subject = subjectParts.join('\x1f');
      // viewer 记录/标注提交不参与归属：提交人/描述存上传 commit 的
      // message，被 viewer 提交顶掉会显示成 lake-viewer 与维护信息
      // （readLakeSessions / readSubmitInfo 的前缀契约同源）。跳过后
      // 归属 = 最后一条上传/维护提交，覆盖重传仍更新描述
      if (subject.startsWith('notes(viewer):')) continue;
      for (const file of lines.slice(1)) {
        const loc = resolveSessionPath(file);
        if (loc && !sidCommit.has(loc.folder)) sidCommit.set(loc.folder, { author, time, subject });
      }
    }
  } catch { /* 无历史时列表退化为纯文件名 */ }

  const entries: LakeSessionEntry[] = [];
  const metas = readSessionMetas(dir, remote);
  for (const [folder, count] of fileCount) {
    const { sid, recording } = parseSessionFolder(folder);
    const newest = sidCommit.get(folder);
    const author = newest?.author ?? '';
    const parsed = parseCommitSubject(newest?.subject ?? '', author);
    const meta = metas.get(folder);
    // 归属 meta 优先（提交信息快照，上传时刻写入的权威字段）、log 推导回落
    // （存量旧 meta 无字段）——与提交信息格式约定解耦，维护提交无法污染
    const submitter = meta?.submitter ?? parsed.submitter;
    const description = meta?.description ?? parsed.description;
    const loc = sidLoc.get(folder) ?? { root: remote.rootDir, baseline: false, recording };
    // 恒多根彻底：范式 = 所在顶层目录（sessions/ 与自定义 directory 同为
    // 普通目录名）；根级会话（root=''）无范式 → null（导入侧「根目录」桶）
    const paradigm = loc.root || null;
    entries.push({ sid, recording, fileCount: count, author, submitter, description, commitTime: newest?.time ?? '', framework: meta?.framework ?? null, ccVersion: meta?.ccVersion ?? null, producer: meta?.producer ?? null, opGen: meta?.opGen ?? null, paradigm, isBaseline: loc.baseline });
  }
  entries.sort((a, b) => (b.commitTime || '').localeCompare(a.commitTime || ''));
  return entries;
}

// ── 目录浏览（ls-tree -r 全量文件清单 → 推导一级子目录） ────────────────

// ls-tree 带目录 pathspec 只列直属 blob、不列子目录（实测），因此用 -r 全量
// 文件路径推导：任一文件的下一级祖先目录即一级子目录（git 无空目录，成立）
export function listRemoteDirs(remote: LakeRemote = defaultLakeRemote(), prefix = ''): string[] {
  // 入口校验（与 uploadFolder 对 sid 同款双重防线）：prefix 拼进 shell 命令
  const p = normalizeDirPrefix(prefix);
  return listDirsIn(ensureMirror(remote), remote, p);
}

function listDirsIn(dir: string, remote: LakeRemote, p: string): string[] {
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

export interface LakeOverview {
  sessions: LakeSessionEntry[];
  /** 顶层目录清单（与 listRemoteDirs('') 同源，全仓顶层目录）。
   *  导入对话框的范式下拉与会话列表一次请求共享一轮 mirror fetch（原来 dirs+list
   *  两路各 fetch 一次 ~1s×2）。 */
  topDirs: string[];
}

/** 会话列表 + 顶层目录合并读取：单轮 ensureMirror fetch 服务两份数据。 */
export function listOverview(remote: LakeRemote = defaultLakeRemote()): LakeOverview {
  const dir = ensureMirror(remote);
  return {
    sessions: listSessionsIn(dir, remote),
    topDirs: listDirsIn(dir, remote, ''),
  };
}

// ── 范式目录注册表（目录即范式，insight 零范式知识）──────────────────────

/** 顶层范式目录清单（上传下拉数据源 + 网关动态白名单）：全仓顶层目录即
 *  范式注册表（sessions/ 存量区特判已退役——它就是普通范式目录）。
 *  新增范式只需在数据仓建目录。 */
export function listParadigmDirs(remote: LakeRemote = defaultLakeRemote()): string[] {
  if (!remote) return [];
  const dir = ensureMirror(remote);
  if (!revParseMain(dir, remote)) return [];
  return lsTreeTopDirs(dir, remote).sort();
}

/** sid 现存于哪些位置（含 baseline 三段路径）：恒多根全仓搜（范式一级 /
 *  嵌套自定义 directory），外加根级 <sid>/ 位（缺省上传位——root=''）。 */
function locateSessionLocations(dir: string, remote: LakeRemote, sid: string, recording: RecordingClass = 'capture'): SessionLocation[] {
  const folder = sessionFolderOf(sid, recording);
  // 逐项匹配（不 join('\n')/split('\n')）：ls-tree -z 路径可含 \n（NUL 才是
  // 分隔符），按行拆会让恶意文件路径伪造出 `evil-root/<sid>/` 形态的"行"
  // ——完全可控的 root 进入 locs 后直通下游 shell 命令（sparse/add/show）
  // bundle 专区同理排除（runId 恰与 sid 同形时的防误定位）
  const files = lsTreeFiles(dir, '', remote).filter(f => !f.startsWith(`${BUNDLE_ROOT_DIR}/`));
  const re = new RegExp(`^([^/]+)\\/(baseline\\/)?${escapeRegExp(folder)}\\/`);
  const locs = new Map<string, SessionLocation>();
  for (const f of files) {
    const m = f.match(re);
    if (m) locs.set(`${m[1]}/${m[2] ?? ''}`, { root: m[1], baseline: m[2] != null, recording });
  }
  // 根级会话位（<sid>/ 与根级 baseline/<sid>/，无范式前缀）：缺省上传落点。
  // 锚定判定（与 resolveSessionPath fi==0 同款，仅压缩态/meta——裸 .jsonl 是
  // viewer 范式目标文件形态，不算）：目录内须有以真实 sid 命名的会话文件或
  // subagents/ 子目录；语料目录散置 jsonl 不算（防误定位 → 上传清理误删语料数据）
  const realSid = parseSessionFolder(folder).sid;
  const anchoredRe = new RegExp(`^${escapeRegExp(folder)}\\/${escapeRegExp(realSid)}\\.(?:jsonl\\.(?:7z|gz)|meta\\.json)$`);
  const rootBaselineRe = new RegExp(`^baseline\\/${escapeRegExp(folder)}\\/${escapeRegExp(realSid)}\\.(?:jsonl\\.(?:7z|gz)|meta\\.json)$`);
  const rootLevel = files.some(f => anchoredRe.test(f) || f.startsWith(`${folder}/subagents/`));
  const rootBaseline = files.some(f => rootBaselineRe.test(f));
  // root 段级白名单（与 normalizeDirPrefix 同款规则，非 ASCII 放行、shell
  // 元字符与空白全挡）：root 来自 ls-tree 原始输出不受控——旧仓/手工推送
  // 的顶层目录名会经 locationPath 直通 sparse-checkout/git add/git show 的
  // shell 字符串。非法段丢弃整个 loc（保守不动语义，与"归属不明不动"一致）
  const safe = [...locs.values()].filter(l => isSafeRootSegment(l.root));
  if (rootLevel) safe.push({ root: '', baseline: false, recording });
  if (rootBaseline) safe.push({ root: '', baseline: true, recording });

  // rootDir 作用域兜底（自定义 directory 的嵌套路径）：<rootDir>/<sid>/
  // 不匹配多根一级范式正则；rootDir 为根（''）时上面根级位已覆盖。
  // baseline 段命中与否分别记录（旧实现 some() 后统一记 baseline:false：
  // <rootDir>/baseline/<sid>/ 被解析成 <rootDir>/<sid>/——物化定位与
  // staleLocs 清理全指错路径）；双形态并存 = 布局损坏，交由多重定位报错
  if (remote.rootDir.includes('/') && safe.length === 0) {
    const nested = `${remote.rootDir}/`.replace(/\/+$/, '') + '/';
    const nestedRe = new RegExp(`^${escapeRegExp(nested)}(baseline\/)?${escapeRegExp(folder)}\/`);
    let nestedPlain = false;
    let nestedBaseline = false;
    for (const f of files) {
      const m = f.match(nestedRe);
      if (!m) continue;
      if (m[1] != null) nestedBaseline = true;
      else nestedPlain = true;
    }
    if (nestedPlain) safe.push({ root: remote.rootDir, baseline: false, recording });
    if (nestedBaseline) safe.push({ root: remote.rootDir, baseline: true, recording });
  }
  return safe;
}

/** root（范式目录名/存量区目录名）的段级安全校验——与 remote.ts
 *  normalizeDirPrefix 的段规则同源：shell 元字符与路径语义字符全在 ASCII
 *  区，白名单只约束 ASCII 段即可保住注入面（非 ASCII 段如 "7月" 放行）。 */
function isSafeRootSegment(root: string): boolean {
  if (root === '.' || root === '..') return false;
  return /^[\w\u0080-\uFFFF.-]+$/.test(root);
}

/** 存量裸目录归属判定（同 sid 双记录收全的迁移路径）：裸 <sid>/ 目录的
 *  cc-session-meta 内容——与 uploadLakeSession 的记录类推导同构
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
function bareDirHoldsNativeRecording(dir: string, remote: LakeRemote, loc: SessionLocation, sid: string): boolean {
  try {
    const metaPath = `${locationPath(loc, sid)}/${sid}.meta.json`;
    // spawnSync argv（非 runGit shell 字符串）：metaPath 含来自 ls-tree 的
    // root 段——即便有 isSafeRootSegment 白名单，meta 读取也彻底绕开 shell
    // 作纵深（与 LFS cat-file 同款纪律）
    const r = spawnGitAuthed(['show', `origin/${remote.branch}:${metaPath}`], dir, remote.pullAuth, 60_000,
      { maxBuffer: 8 * 1024 * 1024 });
    if (r.error || r.status !== 0) return false;
    const data = readEnvelope(JSON.parse(r.stdout.toString('utf8')))?.data;
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
function locateBaselineSids(dir: string, remote: LakeRemote, paradigm: string): string[] {
  // paradigm=''（仓库根）：根级 baseline/ 位
  const prefix = paradigm ? `${paradigm}/` : '';
  const out = runGit(`git ls-tree -z --name-only origin/${remote.branch} ${prefix}baseline/`, dir).toString('utf8');
  const sids: string[] = [];
  for (const line of out.split('\0')) {
    const m = decodeGitPath(line).trim().match(new RegExp(`^${paradigm ? '[^/]+/' : ''}baseline\\/([^/]+)\\/?$`));
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

function materializeBlobsByBatch(dir: string, planned: Array<{ oid: string; target: string }>, auth: { username: string; password: string } | null): void {
  const sizeRes = spawnGitAuthed(['cat-file', '--batch-check'], dir, auth, 120_000,
    { input: planned.map(p => `${p.oid}\n`).join(''), maxBuffer: 16 * 1024 * 1024 });
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
    const res = spawnGitAuthed(['cat-file', '--batch'], dir, auth, 300_000,
      { input: batch.map(p => `${p.oid}\n`).join(''), maxBuffer: 512 * 1024 * 1024 });
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
export function materializeSession(sid: string, remote: LakeRemote = defaultLakeRemote(), recording: RecordingClass = 'capture'): string {
  const t0 = Date.now();
  lakeLog.info('materialize start', { sid, recording, lfs: remote.lfs });
  const dir = ensureMirror(remote);
  if (!revParseMain(dir, remote)) throw new Error('lake mirror has no main branch');
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
        fs.writeFileSync(gaPath, runGitWithAuth(`git show origin/${remote.branch}:.gitattributes`, dir, remote.pullAuth));
      } catch { /* 仓内无 .gitattributes → 无 lfs 声明，不可能存在指针件 */ }
    }
  }

  const locs = locateSessionLocations(dir, remote, sid, recording);
  if (locs.length === 0) throw new Error(`Session folder not found in lake: "${sid}"`);
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
  if (entries.length === 0) throw new Error(`Session folder not found in lake: "${sid}"`);

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
      const cat = spawnGitAuthed(['cat-file', '--filters', `--path=${e.repoPath}`, e.oid], dir, remote.pullAuth, 300_000);
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
    if (missing.length > 0) prefetchBlobs(dir, missing, remote.pullAuth);
    const planned: Array<{ oid: string; target: string }> = [];
    for (const e of entries) {
      const rel = targetRelOf(e.repoPath.slice(prefix.length));
      const target = path.join(dir, 'materialized', rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      planned.push({ oid: e.oid, target });
      if (rel === `${matStem}.jsonl` || rel === `${matStem}.jsonl.7z` || rel === `${matStem}.jsonl.gz`) mainJsonl = target;
    }
    materializeBlobsByBatch(dir, planned, remote.pullAuth);
  }
  if (!mainJsonl) throw new Error(`Main jsonl missing for session "${sid}"`);
  lakeLog.info('materialize done', { sid, recording, ms: Date.now() - t0 });
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

// ── LFS 模式（opt-in：remote.lfs，config.lfs > env LAKE_LFS）─────────

export function hasGitLfs(): boolean {
  try {
    const r = spawnSync('git', ['lfs', 'version'], { stdio: 'pipe', timeout: 10_000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** 私有 bin 目录（~/.context-insight/bin）与自举下载见 lfs-setup.ts——
 *  与 cpx 自举产物同位互用。此处仅消费目录。 */
// cpx 私有 git-lfs 件（~/.context-insight/bin/git-lfs，cpx lfs-setup 自举产物：
// 系统 git-lfs 缺失时下载，零全局污染）。insight 复用同一份——两包数据目录
// 同源，PATH 注入后 git 子进程（filter/钩子）自然命中。CONTEXT_PROXY_DIR 重定向
// 优先（与 cpx lfs-setup 同语义，测试隔离用）。
// （privateLfsBinDir 已收敛到 ./lfs-setup.ts 单一来源）

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
 *  git-lfs 解析链：系统件 > cpx/insight 私有件（~/.context-insight/bin，PATH 注入）。 */
export function ensureLfsReady(dir: string): void {
  ensurePrivateLfsOnPath();
  if (!hasGitLfs()) {
    throw new Error('LFS 模式需要 git-lfs（`git lfs version` 不可用），三条出路任选：'
      + ' ① 系统安装 git-lfs 并确保在 PATH（https://git-lfs.github.com）；'
      + ' ② 直接重试上传——insight 会自动下载私有件到 ~/.context-insight/bin（与 cpx lfs-setup 产物同位互用，零全局污染；慢网络可设 CONTEXT_CPX_LFS_BASE 镜像）；'
      + ' ③ 设置 env LAKE_LFS=0 关闭 LFS 走普通 git 存储');
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

/** 上传路径 LFS 就绪（带自举）：私有件在位 → PATH 前置直接过检；缺失 →
 *  自动下载安装（sha256 校验，见 lfs-setup.ts）后再过检。用户场景零手工
 *  安装——纯 insight 安装（无 cpx）首次上传即自愈。失败抛指引（网络不可达
 *  等），捕获保留本地，配置镜像后重试上传即自动重试自举。 */
export async function ensureLfsReadyWithBootstrap(dir: string): Promise<void> {
  ensurePrivateLfsOnPath();
  if (!hasGitLfs()) {
    await ensureLfsBinaryAvailable();
    ensurePrivateLfsOnPath();
  }
  ensureLfsReady(dir);
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
export async function uploadFolder(stagingDir: string, sid: string, commitMessage: string, remote: LakeRemote = defaultLakeRemote(), category?: string, baseline?: boolean, recording: RecordingClass = 'capture'): Promise<UploadResult> {
  const t0 = Date.now();
  lakeLog.info('upload start', { sid, category: category ?? '', baseline: baseline ?? false, recording });
  return withWriteLock(async () => {
    // sid/category 拼进多条 git 命令（sparse-checkout set / add / ls-tree），
    // 白名单校验防命令注入 —— 与 materializeSession 同款（branch/rootDir
    // 已在 remote.ts resolve 时过同款白名单）
    if (!/^[\w.-]+$/.test(sid)) throw new Error(`Invalid session id: "${sid}"`);
    if (category != null && !/^[\w.-]+$/.test(category)) throw new Error(`Invalid paradigm dir: "${category}"`);
    const targetRoot = category ?? remote.rootDir;
    // 根级落盘（targetRoot=''）路径前缀：<sid>/ 直接在仓库根
    const tp = targetRoot ? `${targetRoot}/` : '';
    const dir = ensureMirror(remote);
    if (!revParseMain(dir, remote)) throw new Error('lake mirror has no main branch');
    // LFS 模式：镜像内就绪（git-lfs 检查 + filter 配置 + pre-push 钩子）。
    // 自举版——私有件缺失时自动下载（用户场景零手工安装）
    if (remote.lfs) await ensureLfsReadyWithBootstrap(dir);
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
    runGit(`git sparse-checkout set "/${tp}${folder}/**" "/.gitattributes"${staleLocs.map(l => ` "/${locationPath(l, sid)}/**"`).join('')}${baseline ? ` "/${tp}baseline/**"` : ''}${swapBack.map(s => ` "/${tp}${s}/**"`).join('')}`, dir);
    // 自愈：上次失败上传可能残留脏工作树（物化件未提交/push 被拒后 staged），
    // checkout -B 会拒绝覆盖。镜像工作树本就是可丢弃的物化缓存——失败时
    // 硬复位 + 清未跟踪后重试（happy path 零开销；runGit 默认过滤器中性化，
    // 复位不依赖 git-lfs 在机）。此前该态一旦出现，之后每次上传都死在
    // checkout（实测 2026-09-21：配额拒 push 遗留 → 下次上传报
    // "local changes would be overwritten"）
    try {
      runGit(`git checkout -B ${remote.branch} origin/${remote.branch}`, dir);
    } catch {
      lakeLog.warn('镜像工作树脏（上次失败上传残留），硬复位自愈', { sid });
      runGit(`git reset --hard origin/${remote.branch}`, dir);
      runGit('git clean -fdq', dir);
      runGit(`git checkout -B ${remote.branch} origin/${remote.branch}`, dir);
    }
    runGit('git reset --quiet', dir); // 丢弃上次失败上传可能残留的 staged 状态

    // staging 是该记录的完整权威集合：先清空目标目录与旧位置再拷入。
    // （旧明文残留清理同理：scoped add 不删旧根文件，必须显式 rm）
    for (const l of [...staleLocs.map(l => locationPath(l, sid)), baseline ? `${tp}baseline/${folder}` : `${tp}${folder}`]) {
      fs.rmSync(path.join(dir, ...l.split('/')), { recursive: true, force: true });
    }
    const targetRel = baseline ? `${tp}baseline/${folder}` : `${tp}${folder}`;
    const targetDir = path.join(dir, ...targetRel.split('/'));
    fs.mkdirSync(targetDir, { recursive: true });
    fs.cpSync(path.join(stagingDir, 'sessions', sid), targetDir, { recursive: true });

    // 交换：原 baseline 会话移回范式普通目录（文件原样，git rename 识别与否不影响 tree）
    const swapPaths: string[] = [];
    if (baseline) {
      // 目标根段（category 目录或仓库根本身——根级 baseline 落 <root>/baseline/）
      const targetBaseSegs = targetRoot ? targetRoot.split('/') : [];
      fs.rmSync(path.join(dir, ...targetBaseSegs, 'baseline', '.gitkeep'), { force: true });
      for (const old of swapBack) {
        fs.rmSync(path.join(dir, ...targetBaseSegs, old), { recursive: true, force: true });
        fs.renameSync(
          path.join(dir, ...targetBaseSegs, 'baseline', old),
          path.join(dir, ...targetBaseSegs, old),
        );
        swapPaths.push(`${tp}${old}`);
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

    const addPaths = [targetRel, ...staleLocs.map(l => locationPath(l, sid)), ...swapPaths, ...(baseline ? [`${tp}baseline`] : [])];
    // LFS 模式 add 不中和：clean 过滤器要把 .gz 转成 LFS 指针（对指针文本
    // 透传，baseline 搬移的 re-add 不重传）
    runGit(`git add ${addPaths.join(' ')}`, dir, 120_000, remote.lfs ? { raw: true } : undefined);
    const msgFile = path.join(dir, '_commit_msg.txt');
    fs.writeFileSync(msgFile, commitMessage);
    let unchanged = false;
    try {
      runGit(`git -c user.name=context-insight -c user.email=insight@localhost commit -F "${msgFile}"`, dir);
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
        lakeLog.warn('push 被拒，fetch+merge 换父提交后重试', { sid, category: category ?? '' });
        runGit(`git fetch --quiet origin ${remote.branch}`, dir);
        runGit(`git -c user.name=context-insight -c user.email=insight@localhost merge --allow-unrelated-histories --no-edit origin/${remote.branch}`, dir);
        push();
      }
    }
    lakeLog.debug('upload commit 完成', { sid, unchanged, ms: Date.now() - t0 });
    return { folder: `${targetRel}/`, unchanged, gitattributesFixed };
  });
}

/**
 * Run a git command with a one-shot credential helper (401 challenge-response
 * auth): URLs never carry embedded credentials — hosting gateways reject
 * proactive Basic auth on the request line. The helper script lives in a 0700
 * temp dir and is removed afterwards; credentials never appear on the command
 * line (execSync failure messages stay clean). `-c credential.helper=` clears
 * the inherited chain (global store etc.) so the explicit helper applies
 * deterministically. auth=null runs the command as-is (local bare / anonymous).
 * Returns the command stdout (ls-remote consumers read ref advertisements).
 */
export function runGitWithAuth(
  cmd: string,
  cwd: string,
  auth: PushAuth | null,
  timeoutMs = 120_000,
  opts?: { raw?: boolean },
): Buffer {
  if (!auth) {
    return runGit(cmd, cwd, timeoutMs, opts);
  }
  const { username, password } = auth;
  if (/[\r\n]/.test(username) || /[\r\n]/.test(password)) {
    throw new Error('git credentials contain newline (invalid for credential helper protocol)');
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-lake-auth-'));
  try {
    const helper = path.join(tmp, 'helper.sh');
    fs.writeFileSync(
      helper,
      `#!/bin/sh\ncat <<'INSIGHTEOF'\nusername=${username}\npassword=${password}\nINSIGHTEOF\n`,
      { mode: 0o700 },
    );
    return runGit(
      `git -c credential.helper= -c credential.helper="${helper}" ${cmd.replace(/^git /, '')}`,
      cwd,
      timeoutMs,
      opts,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** spawnSync git 公共纪律（argv 形态，meta 读取/物化面用）：① 绝不禁不了
 *  终端——GIT_TERMINAL_PROMPT=0 让私有仓匿名 401 快速失败（lazy-fetch/
 *  物化/LFS smudge 都会回源远端，终端提示会把请求冻在 Username for ...）；
 *  ② 凭据经一次性 credential helper（与 runGitWithAuth 同协议，-c 配置经
 *  GIT_CONFIG_PARAMETERS 传导给 git-lfs 子进程）；auth=null 匿名原样执行。 */
function spawnGitAuthed(
  argv: string[],
  cwd: string,
  auth: { username: string; password: string } | null,
  timeoutMs: number,
  opts?: { maxBuffer?: number; input?: string },
): SpawnSyncReturns<Buffer> {
  const base = { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: timeoutMs, maxBuffer: opts?.maxBuffer ?? 256 * 1024 * 1024 };
  if (!auth) return spawnSync('git', argv, { ...base, ...(opts?.input != null ? { input: opts.input, stdio: ['pipe', 'pipe', 'pipe'] as const } : { stdio: ['ignore', 'pipe', 'pipe'] as const }) });
  if (/[\r\n]/.test(auth.username) || /[\r\n]/.test(auth.password)) {
    throw new Error('git credentials contain newline (invalid for credential helper protocol)');
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-lake-auth-'));
  try {
    const helper = path.join(tmp, 'helper.sh');
    fs.writeFileSync(
      helper,
      `#!/bin/sh\ncat <<'INSIGHTEOF'\nusername=${auth.username}\npassword=${auth.password}\nINSIGHTEOF\n`,
      { mode: 0o700 },
    );
    return spawnSync('git', ['-c', 'credential.helper=', '-c', `credential.helper=${helper}`, ...argv],
      { ...base, ...(opts?.input != null ? { input: opts.input, stdio: ['pipe', 'pipe', 'pipe'] as const } : { stdio: ['ignore', 'pipe', 'pipe'] as const }) });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * 401 挑战-应答式 push：pushUrl 一律无凭据，凭据经一次性 credential helper
 * 供给——托管平台网关已拒"请求直带密码"的内嵌 URL（proactive Basic 直接
 * 拒绝；同凭据经 401 挑战后重试可通过）。凭据不进命令行。
 * LFS 模式：不用 --no-verify（pre-push 钩子 = LFS 对象上传通道，跳过即
 * 产生孤儿指针）；helper 的 -c 配置经 GIT_CONFIG_PARAMETERS 传给钩子，
 * git-lfs 的 batch API 鉴权与 git push 同源。
 */
export function pushMirror(dir: string, remote: LakeRemote): void {
  const verify = remote.lfs ? '' : ' --no-verify';
  const raw = remote.lfs ? { raw: true as const } : undefined;
  const t0 = Date.now();
  runGitWithAuth(`git push${verify} "${remote.pushUrl}" ${remote.branch}`, dir, remote.pushAuth, 300_000, raw);
  lakeLog.debug('push done', { ms: Date.now() - t0, lfs: remote.lfs });
}

// ── 异步栈（原 viewer 双栈时代副本统一并入，P2）─────────────────────────
// 大仓首克隆分钟级、冷镜像批量 meta 预取秒级——同步 execSync 会冻住事件循环
// （所有路由无响应、进度 UI 停更）。异步 spawn + stderr 进度行汇入全局进度
// 快照，/api/lake-status 轮询据此展示"正在克隆 45%"。

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
    const child = spawn('bash', ['-c', neutral], { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
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

/** 异步版一次性 credential helper（与同步 runGitWithAuth 同协议：URL 零内嵌
 *  凭据，helper 脚本 0700 临时目录用后即删；auth=null 原样执行）。 */
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

async function tryFetchMirrorAsync(dir: string, remote: LakeRemote): Promise<boolean> {
  if (!fs.existsSync(path.join(dir, '.git'))) return false;
  setLakePhase('fetch', `origin/${remote.branch}`);
  const code = await runGitAsyncWithAuth(`git fetch --progress origin ${remote.branch}`, dir, remote.pullAuth, 120_000,
    line => setLakePhase('fetch', redactRemoteSecrets(line, remote, [])));
  if (code === 0) { setLakePhase('idle'); return true; }
  lakeLog.warn('mirror fetch 失败，回落本地镜像', { branch: remote.branch, code });
  return mirrorLocallyUsable(dir, remote);
}

// 异步锁等待：同步版 withMirrorInitLock 用 Atomics.wait 真阻塞事件循环，
// 这里改轮询锁文件。不变量（共用镜像目录后的关键约束）：**锁绝不被跨
// await 长持有**——同步镜像路径等这个锁时，若异步侧把锁握在分钟级克隆上，
// 克隆完成回调永远无法派发 → 整进程假死到 15min 锁超龄。因此锁内只做快
// 操作（fetch 验证 / rm+rename 交换，毫秒级），长克隆在锁外完成后短暂持锁交换。
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
        if (Date.now() > deadline) throw new Error(`lake mirror init lock timeout: ${lock}`);
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
// health 2s 轮询），不做节流会把每次筛选/轮询变成一次平台往返，并发调用
// 还会在同一 cacheDir 上踩 ref 锁。TTL 内的镜像视为新鲜，直接复用。
const FETCH_TTL_MS = 15_000;
const lastFreshAt = new Map<string, number>();
const inflightEnsure = new Map<string, Promise<string>>();

export async function ensureMirrorAsync(remote: LakeRemote = defaultLakeRemote()): Promise<string> {
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

// 锁外长克隆 → 短暂持锁交换。并发冷启动（异步路径 / 同步路径）可能各自
// 克隆一份 tmp——浪费一次克隆但安全：交换由锁串行，后换者胜；交换前的
// 「他人是否已交付」判定用本地检查（mirrorLocallyUsable，纯本地 git 读、
// 毫秒级），不用 fetch（网络操作进锁定区等于换一种方式长持锁）。
async function cloneAndSwapAsync(dir: string, remote: LakeRemote): Promise<void> {
  const target = path.resolve(dir);
  const tmp = `${target}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    setLakePhase('clone', '连接远端…');
    const t0 = Date.now();
    lakeLog.info('clone start', { branch: remote.branch });
    const code = await runGitAsyncWithAuth(
      `git clone --no-local --filter=blob:none --no-checkout --progress "${remote.pullUrl}" "${tmp}"`,
      path.dirname(target), remote.pullAuth, 600_000,
      line => setLakePhase('clone', redactRemoteSecrets(line, remote, [])),
    );
    if (code !== 0) {
      lakeLog.warn('clone 失败', { code });
      throw new Error(`git clone 失败（exit ${code}），详见 /api/lake-status`);
    }
    lakeLog.info('clone done', { ms: Date.now() - t0 });
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
    syncMirrorCredentials(dir, remote);
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
  syncMirrorCredentials(dir, remote);
  return dir;
}

// ── 详细列表（异步，viewer 消费面：含 meta 指标快照的富形态）──────────

export interface LakeSession {
  sid: string;
  recording: RecordingClass;
  fileCount: number;
  commitTime: string;
  commitSubject: string;
  /** 提交人快照（spec §4.4 可选字段，上传时刻随 meta 写入）——归属权威源；
   *  存量旧 meta 为 null，消费方回落 commitSubject 推导（parseSubmitInfo） */
  submitter: string | null;
  /** 内容描述快照（同提交人一道写入）；null = 回落 commitSubject 推导 */
  description: string | null;
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
interface SessionMeta {
  framework: string | null;
  ccVersion: string | null;
  producer: string | null;
  workflow: string | null;
  opGen: 'success' | 'failure' | null;
  submitter: string | null;
  description: string | null;
  remark: string | null;
  startTime: string | null;
  durationMs: number | null;
  activeMs: number | null;
  totalTokens: number | null;
  model: string | null;
}

// 双目录形态（同 sid 双记录）：裸 <sid>/<sid>.meta.json（捕获/主位）与
// <sid>.native/<sid>.meta.json（原生——目录带后缀、文件用真实 sid）。
// 路径归属经 resolveSessionPath（任意深度——嵌套 directory 下同形态可寻）
function wantedMetaEntries(treeOut: string): Array<{ folder: string; oid: string }> {
  const wanted: Array<{ folder: string; oid: string }> = [];
  for (const rec of treeOut.split('\0')) {
    const entry = splitLsTreeEntry(rec);
    if (!entry) continue;
    const oidMatch = entry.meta.match(/^[0-9]+\s+blob\s+([0-9a-f]+)$/);
    if (!oidMatch) continue;
    const loc = resolveSessionPath(entry.path);
    if (!loc) continue;
    const fileName = entry.path.slice(entry.path.lastIndexOf('/') + 1);
    // 裸形态文件名 = 目录名；.native 形态文件名 = 去后缀真实 sid，补回后缀才是目录名（map 键）
    if (fileName === `${loc.folder}.meta.json`) wanted.push({ folder: loc.folder, oid: oidMatch[1] });
    else if (loc.folder.endsWith(NATIVE_FOLDER_SUFFIX) && fileName === `${loc.folder.slice(0, -NATIVE_FOLDER_SUFFIX.length)}.meta.json`) wanted.push({ folder: loc.folder, oid: oidMatch[1] });
  }
  return wanted;
}

// cat-file --batch 输出格式（每个请求一条）：<oid> SP <type> SP <size>\n<content>\n\n
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
      const d = readEnvelope(JSON.parse(body))?.data;
      out.set(w.folder, {
        framework: typeof d?.framework === 'string' ? d.framework : null,
        ccVersion: typeof d?.ccVersion === 'string' ? d.ccVersion : null,
        producer: typeof d?.producer === 'string' ? d.producer : null,
        // workflow 版本（§10 决策 1 预留位）：cpx 落地前恒 null，落地后零改造直显
        workflow: typeof d?.workflow === 'string' ? d.workflow : null,
        // opGen（可选字段，spec §4.4）：只认 success/failure，其余值/缺省一律未标注
        opGen: d?.opGen === 'success' || d?.opGen === 'failure' ? d.opGen : null,
        // 提交信息快照（可选字段，spec §4.4，上传时刻写入）：归属权威源，
        // 存量旧 meta 缺省为 null（消费方回落 commitSubject 推导）
        submitter: typeof d?.submitter === 'string' && d.submitter ? d.submitter : null,
        description: typeof d?.description === 'string' && d.description ? d.description : null,
        remark: typeof d?.remark === 'string' && d.remark ? d.remark : null,
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

async function readSessionMetasDetailed(dir: string, remote: LakeRemote): Promise<Map<string, SessionMeta>> {
  try {
    // 单根模式（自定义远端）只读 rootDir 子树——与同步版 readSessionMetas
    // 同语义；多根（范式）模式全树
    const spec = '';
    const treeOut = runGit(`git ls-tree -r -z origin/${remote.branch}${spec}`, dir).toString('utf8');
    const wanted = wantedMetaEntries(treeOut);
    if (wanted.length === 0) return new Map();
    // 缺失 meta blob 批量预取：懒取是逐对象一次协商，冷镜像千级缺失时批量读
    // 会被 120s 超时截断、指标列残缺（实测 2370 缺失懒取 ≈42min vs 批量
    // ~10s）。本地对象清单是纯本地读；fetch 走异步不阻塞事件循环，失败
    // （服务端拒按 OID fetch 等）自然回退逐对象懒取。
    const local = localObjectOids(dir);
    const missing = wanted
      .filter(w => !local.has(w.oid))
      .map(w => w.oid);
    for (let i = 0; i < missing.length; i += FETCH_OID_CHUNK) {
      await runGitAsyncWithAuth(`git fetch --quiet origin ${missing.slice(i, i + FETCH_OID_CHUNK).join(' ')}`, dir, remote.pullAuth, 300_000);
    }
    const buf = await new Promise<Buffer>(resolve => {
      const child = spawn('git', ['cat-file', '--batch'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
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

/** 异步详细列表（viewer 消费面）：ls-tree + 一次 git log walk + 一次批量
 *  meta 读取 → 全部运行及提交元数据。布局（spec §2）：<paradigm>/<sid>/
 *  （范式目录即注册表）、<paradigm>/baseline/<sid>/、<paradigm>/<sid>.native/
 *  （原生会话双记录位，目录内文件用真实 sid 命名）、sessions/<sid>/（存量
 *  区；特判已退役——即普通范式目录，paradigm='sessions'）。 */
export async function listSessionsDetailed(remote: LakeRemote = defaultLakeRemote()): Promise<LakeSession[]> {
  return readLakeSessions(await ensureMirrorAsync(remote), remote);
}

/** 镜像已就绪前提下的纯读取段（ensure 由调用方完成，避免一次构建三连 fetch）。 */
export async function readLakeSessions(dir: string, remote: LakeRemote): Promise<LakeSession[]> {
  const t0 = Date.now();
  markLakePhase('list', '读取范式与会话清单…');
  const mainRev = revParseMain(dir, remote);
  if (!mainRev) { markLakePhase('idle'); return []; }

  const treeFiles = lsTreeFiles(dir, '', remote);
  const fileCount = new Map<string, number>();
  const sidLoc = new Map<string, { root: string; baseline: boolean; dirPath: string }>();
  for (const line of treeFiles) {
    const loc = resolveSessionPath(line);
    if (loc) {
      // folder 是目录名——同 sid 双记录下裸目录与 .native 是两个目录，各自
      // 一条目；真实 sid 由 parseSessionFolder 剥后缀还原
      fileCount.set(loc.folder, (fileCount.get(loc.folder) ?? 0) + 1);
      sidLoc.set(loc.folder, { root: loc.root, baseline: loc.baseline, dirPath: loc.dirPath });
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
  //   顶成自动上传的 bot 身份，而不是把会话放进范式的人。
  // notes(viewer): 前缀跳过保留（防御性：正常时序下它不可能是首传）。
  // D 之后归属展示 meta 优先（提交人/描述快照随 meta 写入）——此处的
  // subject/time 是存量会话的回落源 + 全会话的 commitTime 权威。
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
        const loc = resolveSessionPath(file);
        if (loc) sidCommit.set(loc.dirPath, { time, subject });
      }
    }
  } catch { /* 无历史时列表退化为纯文件名 */ }

  const entries: LakeSession[] = [];
  const metas = await readSessionMetasDetailed(dir, remote);
  for (const [folder, count] of fileCount) {
    const { sid, recording } = parseSessionFolder(folder);
    const meta = metas.get(folder);
    const loc = sidLoc.get(folder) ?? { root: remote.rootDir, baseline: false, dirPath: `${remote.rootDir ? `${remote.rootDir}/` : ''}${folder}` };
    const upload = sidCommit.get(loc.dirPath);
    entries.push({
      sid,
      recording,
      fileCount: count,
      commitTime: upload?.time ?? '',
      commitSubject: upload?.subject ?? '',
      submitter: meta?.submitter ?? null,
      description: meta?.description ?? null,
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
  lakeLog.debug('list done', { count: entries.length, ms: Date.now() - t0 });
  return entries;
}

/** 顶层范式目录清单（异步版，viewer 消费面）：全仓顶层目录即范式注册表
 *  （sessions/ 存量区特判已退役）。 */
export async function listParadigmDirsDetailed(remote: LakeRemote = defaultLakeRemote()): Promise<string[]> {
  const dir = await ensureMirrorAsync(remote);
  return readParadigmDirs(dir, remote);
}

export function readParadigmDirs(dir: string, remote: LakeRemote): string[] {
  if (!revParseMain(dir, remote)) return [];
  return lsTreeTopDirs(dir, remote).sort();
}

// ── bundle 对象（opsbot-bundle/<runId>/，设计 lake-bundle）───────────
// 与会话对象共用 runGit/ensureMirror/pushMirror/withWriteLock 原语；语义差异
// （无 baseline/记录类/范式位）不进会话函数——各自独立函数，互不触碰。

export interface LakeBundleEntry {
  runId: string;
  name: string | null;
  exportDataComplete: boolean | null;
  memberCount: number | null;
  sessionCount: number | null;
  submitter: string | null;
  description: string | null;
  remark: string | null;
  uploadedAt: string | null;
  fileCount: number;
  commitTime: string;
}

// manifest 成员计数（递归含嵌套子 workflow）
function countBundleMembers(data: { members?: unknown[] }): number {
  let n = 0;
  for (const m of data.members ?? []) {
    n += 1;
    if (m && typeof m === 'object' && 'data' in (m as Record<string, unknown>)) {
      const inner = (m as { data?: { members?: unknown[] } }).data;
      if (inner && typeof inner === 'object') n += countBundleMembers(inner);
    }
  }
  return n;
}

/** bundle 列表：锚定目录扫描（含 workflow.json 即 bundle）+ 两个 JSON blob
 *  读取（manifest/meta）+ 一次 log walk 取 commitTime。 */
export function listBundles(remote: LakeRemote = defaultLakeRemote()): LakeBundleEntry[] {
  const dir = ensureMirror(remote);
  if (!revParseMain(dir, remote)) return [];
  const files = lsTreeFiles(dir, ` -- ${BUNDLE_ROOT_DIR}/`, remote);
  if (files.length === 0) return [];

  // runId → { 锚定 blob、其余文件清单 }；锚定 = <runId>/workflow.json
  const perRun = new Map<string, { anchored: boolean; files: string[]; blobOids: Map<string, string> }>();
  const treeOut = runGit(`git ls-tree -r -z origin/${remote.branch} -- ${BUNDLE_ROOT_DIR}/`, dir).toString('utf8');
  for (const rec of treeOut.split('\0')) {
    const entry = splitLsTreeEntry(rec);
    if (!entry) continue;
    const m = entry.meta.match(/^(\d+)\s+(\w+)\s+([0-9a-f]+)$/);
    if (!m || m[2] !== 'blob') continue;
    const rel = entry.path.slice(`${BUNDLE_ROOT_DIR}/`.length);
    const slash = rel.indexOf('/');
    if (slash <= 0) continue; // 顶层散文件忽略（无 runId 归属）
    const runId = rel.slice(0, slash);
    const file = rel.slice(slash + 1);
    let item = perRun.get(runId);
    if (!item) { item = { anchored: false, files: [], blobOids: new Map() }; perRun.set(runId, item); }
    item.files.push(file);
    item.blobOids.set(file, m[3]);
    if (file === BUNDLE_MANIFEST_FILE) item.anchored = true;
  }

  // commitTime：一次 log walk，runId 前缀首命中（新→旧）即最新上传
  const runCommit = new Map<string, { time: string; subject: string }>();
  try {
    const logOut = runGitText(
      `git -c core.quotepath=off log --pretty=format:%x00%aI%x1f%s --name-only origin/${remote.branch}`,
      dir,
    );
    const prefixOf = (f: string): string | null => {
      if (!f.startsWith(`${BUNDLE_ROOT_DIR}/`)) return null;
      const rest = f.slice(`${BUNDLE_ROOT_DIR}/`.length);
      const slash = rest.indexOf('/');
      return slash > 0 ? rest.slice(0, slash) : null;
    };
    for (const record of logOut.split('\x00')) {
      const lines = record.split('\n').filter(l => l.trim());
      if (lines.length === 0) continue;
      const sep = lines[0].indexOf('\x1f');
      if (sep < 0) continue;
      for (const file of lines.slice(1)) {
        const runId = prefixOf(file);
        if (runId && !runCommit.has(runId)) runCommit.set(runId, { time: lines[0].slice(0, sep), subject: lines[0].slice(sep + 1) });
      }
    }
  } catch { /* 无历史时 commitTime 退化空串 */ }

  const readJson = (oid: string): Record<string, unknown> | null => {
    try { return JSON.parse(runGit(`git cat-file blob ${oid}`, dir).toString('utf8')) as Record<string, unknown>; }
    catch { return null; }
  };

  const entries: LakeBundleEntry[] = [];
  for (const [runId, item] of perRun) {
    if (!item.anchored) continue;
    const manifest = item.blobOids.has(BUNDLE_MANIFEST_FILE) ? readJson(item.blobOids.get(BUNDLE_MANIFEST_FILE)!) : null;
    const meta = item.blobOids.has(BUNDLE_META_FILE) ? readJson(item.blobOids.get(BUNDLE_META_FILE)!) : null;
    const metaData = readEnvelope(meta)?.schema === 'cc-bundle-meta' ? (readEnvelope(meta)!.data as Record<string, unknown> | undefined) : undefined;
    const data = (manifest?.data ?? {}) as { members?: unknown[]; exportDataComplete?: unknown };
    // sessionCount 权威源 = 仓内 sessions/ 一级目录数
    const sessionDirs = new Set(item.files
      .filter(f => f.startsWith('sessions/') && f.indexOf('/', 'sessions/'.length) > 0)
      .map(f => f.slice('sessions/'.length, f.indexOf('/', 'sessions/'.length))));
    entries.push({
      runId,
      name: typeof manifest?.name === 'string' ? manifest.name : null,
      exportDataComplete: manifest ? data.exportDataComplete === true : null,
      memberCount: manifest ? countBundleMembers(data) : null,
      sessionCount: sessionDirs.size || null,
      submitter: typeof metaData?.submitter === 'string' ? metaData.submitter : null,
      description: typeof metaData?.description === 'string' ? metaData.description : null,
      remark: typeof metaData?.remark === 'string' ? metaData.remark : null,
      uploadedAt: typeof metaData?.uploadedAt === 'string' ? metaData.uploadedAt : null,
      fileCount: item.files.length,
      commitTime: runCommit.get(runId)?.time ?? '',
    });
  }
  entries.sort((a, b) => (b.commitTime || '').localeCompare(a.commitTime || ''));
  return entries;
}

/** bundle 物化（只读路径，不触碰镜像工作树）：ls-tree 前缀 + blob 批量预取
 *  + cat-file --batch 分批写盘（与 materializeSession 同构；LFS 模式指针件
 *  逐文件 --filters smudge）。压缩态原样物化（解压归编排层）。 */
export function materializeBundle(runId: string, targetDir: string, remote: LakeRemote = defaultLakeRemote()): string {
  const t0 = Date.now();
  if (!/^[\w.-]+$/.test(runId)) throw new Error(`Invalid bundle id: "${runId}"`);
  lakeLog.info('bundle materialize start', { runId });
  const dir = ensureMirror(remote);
  if (!revParseMain(dir, remote)) throw new Error('lake mirror has no main branch');
  const prefix = `${BUNDLE_ROOT_DIR}/${runId}/`;
  const treeOut = runGit(`git ls-tree -r -z origin/${remote.branch} -- ${prefix}`, dir).toString('utf8');
  const entries: Array<{ oid: string; repoPath: string }> = [];
  for (const rec of treeOut.split('\0')) {
    const entry = splitLsTreeEntry(rec);
    if (!entry) continue;
    const m = entry.meta.match(/^(\d+)\s+(\w+)\s+([0-9a-f]+)$/);
    if (!m || m[2] !== 'blob') continue;
    if (!entry.path.startsWith(prefix)) continue;
    entries.push({ oid: m[3], repoPath: entry.path });
  }
  if (entries.length === 0 || !entries.some(e => e.repoPath === `${prefix}${BUNDLE_MANIFEST_FILE}`)) {
    throw new Error(`Bundle not found in lake: "${runId}"`);
  }
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
  if (remote.lfs) {
    for (const e of entries) {
      const target = path.join(targetDir, e.repoPath.slice(prefix.length));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const cat = spawnGitAuthed(['cat-file', '--filters', `--path=${e.repoPath}`, e.oid], dir, remote.pullAuth, 300_000);
      if (cat.error || cat.status !== 0) {
        throw new Error(`git cat-file --filters failed for "${e.repoPath}" (${e.oid}): ${cat.error?.message ?? cat.stderr?.toString()}`);
      }
      fs.writeFileSync(target, cat.stdout);
    }
  } else {
    const local = localObjectOids(dir);
    const missing = entries.filter(e => !local.has(e.oid)).map(e => e.oid);
    if (missing.length > 0) prefetchBlobs(dir, missing, remote.pullAuth);
    const planned = entries.map(e => {
      const target = path.join(targetDir, e.repoPath.slice(prefix.length));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      return { oid: e.oid, target };
    });
    materializeBlobsByBatch(dir, planned, remote.pullAuth);
  }
  lakeLog.info('bundle materialize done', { runId, files: entries.length, ms: Date.now() - t0 });
  return targetDir;
}

/** bundle 上传：narrow sparse 物化专区目录 + scoped add + commit + push
 *  （与 uploadFolder 同构管道；无 baseline/记录类/范式位概念）。staging 布局
 *  stagingDir/<runId>/ = 权威全集，目标整体替换（原子语义）。 */
export async function uploadBundleFolder(
  stagingDir: string, runId: string, commitMessage: string, remote: LakeRemote = defaultLakeRemote(),
): Promise<UploadResult> {
  const t0 = Date.now();
  lakeLog.info('bundle upload start', { runId });
  return withWriteLock(async () => {
    if (!/^[\w.-]+$/.test(runId)) throw new Error(`Invalid bundle id: "${runId}"`);
    const dir = ensureMirror(remote);
    if (!revParseMain(dir, remote)) throw new Error('lake mirror has no main branch');
    if (remote.lfs) await ensureLfsReadyWithBootstrap(dir);
    const targetRel = `${BUNDLE_ROOT_DIR}/${runId}`;

    runGit('git sparse-checkout init --no-cone', dir);
    runGit(`git sparse-checkout set "/${targetRel}/**" "/.gitattributes"`, dir);
    try {
      runGit(`git checkout -B ${remote.branch} origin/${remote.branch}`, dir);
    } catch {
      lakeLog.warn('镜像工作树脏（上次失败上传残留），硬复位自愈', { runId });
      runGit(`git reset --hard origin/${remote.branch}`, dir);
      runGit('git clean -fdq', dir);
      runGit(`git checkout -B ${remote.branch} origin/${remote.branch}`, dir);
    }
    runGit('git reset --quiet', dir);

    fs.rmSync(path.join(dir, ...targetRel.split('/')), { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, ...targetRel.split('/')), { recursive: true });
    fs.cpSync(path.join(stagingDir, runId), path.join(dir, ...targetRel.split('/')), { recursive: true });

    let gitattributesFixed = false;
    const gaPath = path.join(dir, '.gitattributes');
    if (remote.lfs) {
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

    runGit(`git add ${targetRel}`, dir, 120_000, remote.lfs ? { raw: true } : undefined);
    const msgFile = path.join(dir, '_commit_msg.txt');
    fs.writeFileSync(msgFile, commitMessage);
    let unchanged = false;
    try {
      runGit(`git -c user.name=context-insight -c user.email=insight@localhost commit -F "${msgFile}"`, dir);
    } catch {
      try {
        runGit('git diff --cached --quiet', dir);
        unchanged = true;
      } catch {
        throw new Error(`git commit failed for bundle "${runId}" while staged changes exist`);
      }
    }
    try { fs.unlinkSync(msgFile); } catch { /* ignore */ }

    if (!unchanged) {
      const push = () => { pushMirror(dir, remote); };
      try {
        push();
      } catch {
        lakeLog.warn('push 被拒，fetch+merge 换父提交后重试', { runId });
        runGit(`git fetch --quiet origin ${remote.branch}`, dir);
        runGit(`git -c user.name=context-insight -c user.email=insight@localhost merge --allow-unrelated-histories --no-edit origin/${remote.branch}`, dir);
        push();
      }
    }
    lakeLog.info('bundle upload done', { runId, unchanged, ms: Date.now() - t0 });
    return { folder: `${targetRel}/`, unchanged, gitattributesFixed };
  });
}
