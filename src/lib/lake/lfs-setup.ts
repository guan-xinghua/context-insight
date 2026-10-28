// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// insight 侧 git-lfs 自举（与 cpx src/lfs-setup.ts 受控双实现——命令常量/
// 资产命名/sha256 pin 表一致，parity 由两侧 IT 锁定）。用户场景：纯 insight
// 安装（无 cpx）首次上传 LFS 默认开——缺 git-lfs 不再要求用户手工安装，
// 自动下载私有件到 ~/.context-insight/bin（与 cpx 自举产物同位复用，零全局
// 污染）。零手工路径（依次自愈）：
//   ① 系统件（PATH 里的 git-lfs，上游 mirror.ts 解析优先）
//   ② 旧代私有件复用：品牌更名前数据目录（~/.cannbot-insight/bin 等）里
//      pin 同版本的 git-lfs 直接拷贝，免重复下载
//   ③ 下载回退链：CONTEXT_CPX_LFS_BASE 显式镜像（单源）> GitHub 直连 >
//      内置公共镜像（实测可达性筛选；sha256 pin 校验——下载源只是运输
//      通道，镜像内容不可信也过不了校验）
// 版本 pin + sha256 校验（源：git-lfs v3.8.0 release sha256sums.asc），
// 失败降级为指引报错（不比无自举的现状差）。

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BRAND_LEGACY_CONFIG_DIRS } from '../branding';

const GIT_LFS_VERSION = '3.8.0';
const GIT_LFS_SHA256: Record<string, string> = {
  'linux-x64': 'e455e00f15d9b95661b8d53498ffb0c3367962cf1ec73c31ab7369516cd6ab8d',
  'linux-arm64': 'ac9c8efac980bb0505ead384d087e2acb6486fd8498691a2165fa174ec6118c2',
  'darwin-x64': 'f1c17aeca0b4eaab9ea606226477dbed3b84b56fe0811a9f967d2ea2b2393c53',
  'darwin-arm64': 'caff76a7d070d8160c89bc39b6e85d98f24135b6fed038a3b4de2590d25102d8',
};
const DEFAULT_BASE = 'https://github.com/git-lfs/git-lfs/releases/download';
// 内置公共镜像回退链（仅 GitHub 直连失败时逐个尝试；可达性实测筛选——
// ghproxy.net 慢、hub.gitmirror.com 失联、gh-proxy.net 返回占位页，均不入链）
const MIRROR_BASES = [
  'https://gh-proxy.com/https://github.com/git-lfs/git-lfs/releases/download',
  'https://ghfast.top/https://github.com/git-lfs/git-lfs/releases/download',
];

export function platformKey(): string {
  const p = process.platform;
  const a = process.arch;
  if (p === 'linux' && (a === 'x64' || a === 'arm64')) return `linux-${a}`;
  if (p === 'darwin' && (a === 'x64' || a === 'arm64')) return `darwin-${a}`;
  return '';
}

export function lfsAssetName(key: string): string {
  const arch = key.endsWith('-x64') ? 'amd64' : 'arm64';
  return key.startsWith('darwin')
    ? `git-lfs-darwin-${arch}-v${GIT_LFS_VERSION}.zip`
    : `git-lfs-linux-${arch}-v${GIT_LFS_VERSION}.tar.gz`;
}

export function lfsDownloadUrl(key: string, baseUrl?: string): string {
  const base = (baseUrl ?? process.env.CONTEXT_CPX_LFS_BASE ?? DEFAULT_BASE).replace(/\/+$/, '');
  return `${base}/v${GIT_LFS_VERSION}/${lfsAssetName(key)}`;
}

/** 下载源回退链（有序）：显式镜像/env 覆写 = 单源（用户意图优先，不再
 *  叠加内置源）；缺省 = GitHub 直连 → 内置公共镜像。 */
export function lfsDownloadCandidates(key: string, baseUrl?: string): string[] {
  if (baseUrl ?? process.env.CONTEXT_CPX_LFS_BASE) return [lfsDownloadUrl(key, baseUrl)];
  return [lfsDownloadUrl(key), ...MIRROR_BASES.map(b => `${b}/v${GIT_LFS_VERSION}/${lfsAssetName(key)}`)];
}

function sourceLabel(url: string): string {
  if (url.startsWith(DEFAULT_BASE)) return 'GitHub 直连';
  const mirror = MIRROR_BASES.find(b => url.startsWith(b));
  if (mirror) return `镜像 ${new URL(mirror).hostname}`;
  return '自备镜像';
}

function sourceTimeoutMs(url: string): number {
  if (url.startsWith(DEFAULT_BASE)) return 90_000;
  if (MIRROR_BASES.some(b => url.startsWith(b))) return 45_000;
  return 120_000; // env/测试注入源：用户自备，给足时长
}

/** 私有 bin 目录（~/.context-insight/bin；CONTEXT_PROXY_DIR 重定向优先——
 *  与 cpx 自举产物同位互用，测试隔离同语义）。'.context-insight' 引号字面量
 *  由 pack-cannbot 规则表品牌翻转（cannbot 变体 → ~/.cannbot-insight/bin）。 */
export function privateLfsBinDir(): string {
  return path.join(path.dirname(process.env.CONTEXT_PROXY_DIR ?? path.join(os.homedir(), '.context-insight', 'proxy')), 'bin');
}

export function lfsBinaryPath(): string {
  return path.join(privateLfsBinDir(), 'git-lfs');
}

/** 私有件健康检查（直接执行 `<path> version`）。 */
export function privateGitLfsOk(): boolean {
  const p = lfsBinaryPath();
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    return spawnSync(p, ['version'], { stdio: 'pipe', timeout: 10_000 }).status === 0;
  } catch {
    return false;
  }
}

/** 可执行件版本号（`git-lfs/3.8.0 (...)` → "3.8.0"）；不可执行/无版本输出 → null */
function gitLfsVersionOf(bin: string): string | null {
  try {
    const r = spawnSync(bin, ['version'], { stdio: 'pipe', timeout: 10_000 });
    if (r.status !== 0) return null;
    const m = /git-lfs\/(\d+\.\d+\.\d+)/.exec(r.stdout?.toString() ?? '');
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** 旧代数据目录的私有件候选（品牌更名前 ~/*-insight/bin）：CONTEXT_PROXY_DIR
 *  重定向（沙箱/测试）时不探测——只认真实家目录的旧代产物，测试保持离线。 */
function legacyLfsBinCandidates(): string[] {
  if (process.env.CONTEXT_PROXY_DIR) return [];
  return BRAND_LEGACY_CONFIG_DIRS.map(d => path.join(os.homedir(), d, 'bin', 'git-lfs'));
}

export function lfsSetupGuidance(reason: string): string {
  return `LFS 模式需要 git-lfs，自动获取失败（${reason}；已依次尝试 GitHub 直连与公共镜像回退）。出路：
  1. 配置可达镜像后重试上传（将自动重试自举）：CONTEXT_CPX_LFS_BASE=<镜像基址>（按 git-lfs releases/download 路径结构镜像，如 https://gh-proxy.com/https://github.com/git-lfs/git-lfs/releases/download）
  2. 系统安装 git-lfs 并确保在 PATH：https://git-lfs.github.com（apt install git-lfs / brew install git-lfs）
  3. 关闭 LFS 走普通 git 存储：LAKE_LFS=0（受 git 仓容量配额钳制）`;
}

export interface LfsSetupDeps {
  fetchImpl?: typeof fetch;
  /** 测试注入：覆写下载基址（缺省 env CONTEXT_CPX_LFS_BASE > GitHub 官方 + 镜像回退链） */
  baseUrl?: string;
  /** 测试注入：覆写期望 sha256（缺省 = pin 表） */
  sha256?: string;
  /** 测试注入：旧代私有件候选（缺省 = 品牌更名前数据目录探测） */
  legacyBins?: string[];
  log?: (msg: string) => void;
}

function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function extractArchive(archive: string, dest: string): void {
  const r = archive.endsWith('.tar.gz')
    ? spawnSync('tar', ['-xzf', archive, '-C', dest], { stdio: 'pipe', timeout: 60_000 })
    : spawnSync('unzip', ['-o', archive, '-d', dest], { stdio: 'pipe', timeout: 60_000 });
  if (r.error || r.status !== 0) {
    throw new Error(`解压失败（${archive.endsWith('.tar.gz') ? 'tar' : 'unzip'} ${r.error ? r.error.message : `exit ${r.status}`}）`);
  }
}

// release 归档为单顶层目录 git-lfs-<ver>/git-lfs；walk 兜底不依赖该布局
function findBinary(root: string): string | null {
  const stack = [root];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isFile() && e.name === 'git-lfs') return p;
      if (e.isDirectory()) stack.push(p);
    }
  }
  return null;
}

/** 落位私有件（拷贝 + 执行位 + 自检）；失败抛错由调用方决定回退。 */
function installFromBinary(bin: string): void {
  fs.mkdirSync(privateLfsBinDir(), { recursive: true });
  fs.copyFileSync(bin, lfsBinaryPath());
  fs.chmodSync(lfsBinaryPath(), 0o755);
  if (!privateGitLfsOk()) throw new Error('安装后自检失败（私有件不可执行）');
}

async function downloadAndInstall(url: string, key: string, deps: LfsSetupDeps, log: (m: string) => void): Promise<void> {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), `insight-lfs-setup-${process.pid}-`));
  try {
    log(`git-lfs 自举：下载 ${url}（约 6MB）`);
    const res = await (deps.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(sourceTimeoutMs(url)) });
    if (!res.ok) throw new Error(`下载 HTTP ${res.status}`);
    fs.writeFileSync(path.join(staging, lfsAssetName(key)), Buffer.from(await res.arrayBuffer()));

    const expect = deps.sha256 ?? GIT_LFS_SHA256[key];
    const got = sha256File(path.join(staging, lfsAssetName(key)));
    if (got !== expect) {
      throw new Error(`sha256 校验失败（期望 ${expect.slice(0, 12)}…，实得 ${got.slice(0, 12)}…）——下载源可能损坏或被污染`);
    }

    const ex = path.join(staging, 'ex');
    fs.mkdirSync(ex);
    extractArchive(path.join(staging, lfsAssetName(key)), ex);
    const bin = findBinary(ex);
    if (!bin) throw new Error('归档中未找到 git-lfs 可执行件');
    installFromBinary(bin);
    log(`git-lfs 私有件就绪 → ${lfsBinaryPath()}`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

// 并发去重（single-flight）：预热与上传并发触发自举时只跑一次（后到者等同一承诺，不重复下载）
let lfsBootstrapInflight: Promise<void> | null = null;

async function runLfsBootstrap(deps: LfsSetupDeps): Promise<void> {
  const key = platformKey();
  if (!key) {
    throw new Error(lfsSetupGuidance(`当前平台 ${process.platform}-${process.arch} 无自举资产（覆盖 linux/darwin x64/arm64）`));
  }
  const log = deps.log ?? ((m: string) => console.error(`[lake] ${m}`));

  // ① 旧代私有件复用：品牌更名前数据目录里 pin 同版本的健康件直接拷贝
  for (const legacy of deps.legacyBins ?? legacyLfsBinCandidates()) {
    if (gitLfsVersionOf(legacy) === GIT_LFS_VERSION) {
      try {
        installFromBinary(legacy);
        log(`git-lfs 私有件复用旧代产物 → ${lfsBinaryPath()}（源 ${legacy}）`);
        return;
      } catch { /* 拷贝失败（权限等）继续走下载 */ }
    }
  }

  // ② 下载回退链：逐源尝试（sha256 pin 保证镜像内容可信），全败聚合原因
  const failures: string[] = [];
  for (const url of lfsDownloadCandidates(key, deps.baseUrl)) {
    try {
      await downloadAndInstall(url, key, deps, log);
      return;
    } catch (e) {
      failures.push(`${sourceLabel(url)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(lfsSetupGuidance(`全部下载源失败（${failures.join('；')}）`));
}

/** 确保 git-lfs 私有件可用：已就绪（私有件在位）→ 跳过；旧代产物可复用 →
 *  拷贝；否则按下载源回退链自动下载（sha256 校验）安装到
 *  ~/.context-insight/bin。全部失败抛指引错误（上传路径据此拒绝，捕获保留
 *  本地）。系统件的解析由镜像侧 PATH 前置完成（系统件优先于私有件）。 */
export async function ensureLfsBinaryAvailable(deps: LfsSetupDeps = {}): Promise<void> {
  if (privateGitLfsOk()) return;
  if (!lfsBootstrapInflight) {
    lfsBootstrapInflight = runLfsBootstrap(deps).finally(() => { lfsBootstrapInflight = null; });
  }
  return lfsBootstrapInflight;
}

/** 后台预热（fire-and-forget）：lake 数据动作（列表/上传/导入）触发，把自举
 *  在用户填表/浏览期间跑完——正式上传时同步检查大概率直接通过。测试
 *  （VITEST）与数据目录重定向（CONTEXT_PROXY_DIR 沙箱）下 no-op，保持测试
 *  离线确定性；失败静默（上传路径还会同步重试并给出指引）。 */
export function prewarmLfsBinary(): void {
  if (process.env.VITEST || process.env.CONTEXT_PROXY_DIR) return;
  void ensureLfsBinaryAvailable().catch(() => {});
}
