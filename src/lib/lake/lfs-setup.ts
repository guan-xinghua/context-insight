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
// 自动下载私有件到 ~/.cannbot-insight/bin（与 cpx 自举产物同位复用，零全局
// 污染）。版本 pin + sha256 校验（源：git-lfs v3.8.0 release sha256sums.asc），
// 下载源支持 env CANNBOT_CPX_LFS_BASE 覆写（与 cpx 同名——用户配一次两用），
// 失败降级为指引报错（不比无自举的现状差）。

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GIT_LFS_VERSION = '3.8.0';
const GIT_LFS_SHA256: Record<string, string> = {
  'linux-x64': 'e455e00f15d9b95661b8d53498ffb0c3367962cf1ec73c31ab7369516cd6ab8d',
  'linux-arm64': 'ac9c8efac980bb0505ead384d087e2acb6486fd8498691a2165fa174ec6118c2',
  'darwin-x64': 'f1c17aeca0b4eaab9ea606226477dbed3b84b56fe0811a9f967d2ea2b2393c53',
  'darwin-arm64': 'caff76a7d070d8160c89bc39b6e85d98f24135b6fed038a3b4de2590d25102d8',
};
const DEFAULT_BASE = 'https://github.com/git-lfs/git-lfs/releases/download';

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
  const base = (baseUrl ?? process.env.CANNBOT_CPX_LFS_BASE ?? DEFAULT_BASE).replace(/\/+$/, '');
  return `${base}/v${GIT_LFS_VERSION}/${lfsAssetName(key)}`;
}

/** 私有 bin 目录（~/.cannbot-insight/bin；CANNBOT_PROXY_DIR 重定向优先——
 *  与 cpx 自举产物同位互用，测试隔离同语义）。'.cannbot-insight' 引号字面量
 *  由 pack-context 规则表品牌翻转（context 变体 → ~/.context-insight/bin）。 */
export function privateLfsBinDir(): string {
  return path.join(path.dirname(process.env.CANNBOT_PROXY_DIR ?? path.join(os.homedir(), '.cannbot-insight', 'proxy')), 'bin');
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

export function lfsSetupGuidance(reason: string): string {
  return `LFS 模式需要 git-lfs，自动获取失败（${reason}）。出路：
  1. 配置可达镜像后重试上传（将自动重试自举）：CANNBOT_CPX_LFS_BASE=<镜像基址>（按 git-lfs releases/download 路径结构镜像，如 https://gh-proxy.com/https://github.com/git-lfs/git-lfs/releases/download）
  2. 系统安装 git-lfs 并确保在 PATH：https://git-lfs.github.com（apt install git-lfs / brew install git-lfs）
  3. 关闭 LFS 走普通 git 存储：LAKE_LFS=0（受 git 仓容量配额钳制）`;
}

export interface LfsSetupDeps {
  fetchImpl?: typeof fetch;
  /** 测试注入：覆写下载基址（缺省 env CANNBOT_CPX_LFS_BASE > GitHub 官方） */
  baseUrl?: string;
  /** 测试注入：覆写期望 sha256（缺省 = pin 表） */
  sha256?: string;
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

/** 确保 git-lfs 私有件可用：已就绪（私有件在位）→ 跳过；否则自动下载
 *  （sha256 校验）安装到 ~/.cannbot-insight/bin。全部失败抛指引错误
 *  （上传路径据此拒绝，捕获保留本地）。系统件的解析由镜像侧 PATH 前置
 *  完成（系统件优先于私有件）。 */
export async function ensureLfsBinaryAvailable(deps: LfsSetupDeps = {}): Promise<void> {
  if (privateGitLfsOk()) return;

  const key = platformKey();
  if (!key) {
    throw new Error(lfsSetupGuidance(`当前平台 ${process.platform}-${process.arch} 无自举资产（覆盖 linux/darwin x64/arm64）`));
  }
  const log = deps.log ?? ((m: string) => console.error(`[lake] ${m}`));
  const url = lfsDownloadUrl(key, deps.baseUrl);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), `insight-lfs-setup-${process.pid}-`));
  try {
    log(`git-lfs 自举：下载 ${url}（约 6MB，慢网络可设 CANNBOT_CPX_LFS_BASE 镜像）`);
    const res = await (deps.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(120_000) });
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

    fs.mkdirSync(privateLfsBinDir(), { recursive: true });
    fs.copyFileSync(bin, lfsBinaryPath());
    fs.chmodSync(lfsBinaryPath(), 0o755);
    if (!privateGitLfsOk()) throw new Error('安装后自检失败（私有件不可执行）');
    log(`git-lfs 私有件就绪 → ${lfsBinaryPath()}`);
  } catch (e) {
    throw new Error(lfsSetupGuidance(e instanceof Error ? e.message : String(e)));
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
