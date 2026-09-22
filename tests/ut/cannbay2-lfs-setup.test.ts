// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// insight 侧 git-lfs 自举 IT（与 cpx lfs-setup.test.ts 同构——受控双实现
// parity 锁）。全程离线：下载走注入 fetchImpl + 测试内构造的真实 tar.gz
// 夹具；bin 目录经 CANNBOT_PROXY_DIR 重定向隔离（绝不触碰真实
// ~/.cannbot-insight/bin）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  platformKey, lfsAssetName, lfsDownloadUrl, privateLfsBinDir, lfsBinaryPath,
  privateGitLfsOk, ensureLfsBinaryAvailable, lfsSetupGuidance,
} from '../../src/lib/cannbay2/lfs-setup';
import { ensureLfsReadyWithBootstrap } from '../../src/lib/cannbay2/mirror';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-lfs-setup-it-'));
// 重定向数据目录：私有 bin 落在测试沙箱（与 cpx 同语义）
process.env.CANNBOT_PROXY_DIR = path.join(TMP, 'proxy');

function git(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: 'pipe', timeout: 60_000 });
}

// ── 测试内构造真实 tar.gz 夹具：单顶层目录 git-lfs-x.y.z/ 下的可执行 git-lfs 桩 ──
const FIXTURE_SHA: Record<string, string> = {};
function buildArchive(platform: string): string {
  const stage = path.join(TMP, `fixture-${platform}`);
  const pkg = path.join(stage, `git-lfs-3.8.0`);
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'git-lfs'), '#!/bin/sh\necho "git-lfs/9.9.9 (fixture)"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(pkg, 'README.md'), 'fixture\n');
  const arch = platform.endsWith('-x64') ? 'amd64' : 'arm64';
  const name = platform.startsWith('darwin')
    ? `git-lfs-darwin-${arch}-v3.8.0.zip`
    : `git-lfs-linux-${arch}-v3.8.0.tar.gz`;
  if (name.endsWith('.tar.gz')) {
    execSync(`tar -czf "${name}" git-lfs-3.8.0`, { cwd: stage, stdio: 'pipe' });
  } else {
    execSync(`zip -q -r "${name}" git-lfs-3.8.0`, { cwd: stage, stdio: 'pipe' });
  }
  const f = path.join(stage, name);
  FIXTURE_SHA[platform] = createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  return f;
}

function fetchOf(fileMap: Record<string, string>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [frag, file] of Object.entries(fileMap)) {
      if (url.includes(frag)) {
        return new Response(fs.readFileSync(file), { status: 200 });
      }
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

const KEY = platformKey();

beforeAll(() => {
  // 夹具按需构造（linux 用 tar.gz；darwin 宿主机上 zip 可能缺失——非 darwin
  // 平台只测 tar.gz 形态，资产命名/URL 映射另由纯函数用例覆盖）
  buildArchive('linux-x64');
});

describe('insight git-lfs 自举（与 cpx 受控双实现 parity）', () => {
  it('平台 → 资产名 / 下载 URL：常量与 cpx 一致（linux amd64 tar.gz / darwin zip）', () => {
    expect(lfsAssetName('linux-x64')).toBe('git-lfs-linux-amd64-v3.8.0.tar.gz');
    expect(lfsAssetName('linux-arm64')).toBe('git-lfs-linux-arm64-v3.8.0.tar.gz');
    expect(lfsAssetName('darwin-x64')).toBe('git-lfs-darwin-amd64-v3.8.0.zip');
    expect(lfsDownloadUrl('linux-x64')).toBe('https://github.com/git-lfs/git-lfs/releases/download/v3.8.0/git-lfs-linux-amd64-v3.8.0.tar.gz');
    process.env.CANNBOT_CPX_LFS_BASE = 'https://mirror.example.com/git-lfs/';
    expect(lfsDownloadUrl('linux-x64')).toBe('https://mirror.example.com/git-lfs/v3.8.0/git-lfs-linux-amd64-v3.8.0.tar.gz');
    delete process.env.CANNBOT_CPX_LFS_BASE;
    expect(lfsDownloadUrl('linux-x64', 'https://dep.example.com/')).toBe('https://dep.example.com/v3.8.0/git-lfs-linux-amd64-v3.8.0.tar.gz');
  });

  it('privateLfsBinDir：CANNBOT_PROXY_DIR 重定向优先（与镜像/cpx 同语义）', () => {
    expect(privateLfsBinDir()).toBe(path.join(TMP, 'bin'));
    expect(lfsBinaryPath()).toBe(path.join(TMP, 'bin', 'git-lfs'));
  });

  it.skipIf(!KEY || !KEY.startsWith('linux'))('离线全链：注入 fetch + 真实 tar.gz → 安装私有件并自检通过；二次调用零下载', async () => {
    expect(fs.existsSync(lfsBinaryPath())).toBe(false);
    const seen: string[] = [];
    const fetchSpy = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return fetchOf({ 'git-lfs-linux-amd64-v3.8.0.tar.gz': path.join(TMP, 'fixture-linux-x64', 'git-lfs-linux-amd64-v3.8.0.tar.gz') })(input);
    }) as unknown as typeof fetch;
    await ensureLfsBinaryAvailable({ fetchImpl: fetchSpy, sha256: FIXTURE_SHA['linux-x64'], log: () => {} });
    expect(seen).toHaveLength(1);
    expect(privateGitLfsOk()).toBe(true); // 安装后自检（桩可执行且 version 成功）

    await ensureLfsBinaryAvailable({ fetchImpl: fetchOf({}), log: () => {} }); // 404 fetch —— 但私有件已就绪，不应触网
    expect(privateGitLfsOk()).toBe(true);
  });

  it('sha256 校验失败 → 指引报错（含镜像出路），不落盘半成品', async () => {
    fs.rmSync(path.join(TMP, 'bin'), { recursive: true, force: true });
    await expect(ensureLfsBinaryAvailable({
      fetchImpl: fetchOf({ 'git-lfs-linux-amd64-v3.8.0.tar.gz': path.join(TMP, 'fixture-linux-x64', 'git-lfs-linux-amd64-v3.8.0.tar.gz') }),
      sha256: 'deadbeef'.repeat(8),
      log: () => {},
    })).rejects.toThrow(/CANNBOT_CPX_LFS_BASE/);
    expect(fs.existsSync(lfsBinaryPath())).toBe(false);
  });

  it('下载 404 → 指引报错（网络不可达同形态）', async () => {
    fs.rmSync(path.join(TMP, 'bin'), { recursive: true, force: true });
    await expect(ensureLfsBinaryAvailable({ fetchImpl: fetchOf({}), log: () => {} }))
      .rejects.toThrow(lfsSetupGuidance('下载 HTTP 404').slice(0, 20));
  });

  it('ensureLfsReadyWithBootstrap：私有件在位 → 跳过下载直接过检（仓级 filter 配置写入）', async () => {
    // 预置私有件（复制桩）→ PATH 前置 → hasGitLfs 真 → 不触网
    fs.mkdirSync(path.join(TMP, 'bin'), { recursive: true });
    fs.copyFileSync(path.join(TMP, 'fixture-linux-x64', 'git-lfs-3.8.0', 'git-lfs'), lfsBinaryPath());
    fs.chmodSync(lfsBinaryPath(), 0o755);

    const repo = path.join(TMP, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    git('git init -q -b main', repo);
    git('git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init', repo);

    await ensureLfsReadyWithBootstrap(repo);
    const cfg = fs.readFileSync(path.join(repo, '.git', 'config'), 'utf8');
    expect(cfg).toContain('[filter "lfs"]');
    expect(cfg).toContain('process = git-lfs filter-process');
    expect(cfg).toContain('clean = git-lfs clean -- %f');
    expect(fs.existsSync(path.join(repo, '.git', 'hooks', 'pre-push'))).toBe(true);
  });
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
