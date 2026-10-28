// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// insight 侧 git-lfs 自举 IT（与 cpx lfs-setup.test.ts 同构——受控双实现
// parity 锁）。全程离线：下载走注入 fetchImpl + 测试内构造的真实 tar.gz
// 夹具；bin 目录经 CONTEXT_PROXY_DIR 重定向隔离（绝不触碰真实
// ~/.context-insight/bin）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  platformKey, lfsAssetName, lfsDownloadUrl, lfsDownloadCandidates, privateLfsBinDir, lfsBinaryPath,
  privateGitLfsOk, ensureLfsBinaryAvailable, lfsSetupGuidance, prewarmLfsBinary,
} from '../../src/lib/lake/lfs-setup';
import { ensureLfsReadyWithBootstrap } from '../../src/lib/lake/mirror';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-lfs-setup-it-'));
// 重定向数据目录：私有 bin 落在测试沙箱（与 cpx 同语义）
process.env.CONTEXT_PROXY_DIR = path.join(TMP, 'proxy');

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
    process.env.CONTEXT_CPX_LFS_BASE = 'https://mirror.example.com/git-lfs/';
    expect(lfsDownloadUrl('linux-x64')).toBe('https://mirror.example.com/git-lfs/v3.8.0/git-lfs-linux-amd64-v3.8.0.tar.gz');
    delete process.env.CONTEXT_CPX_LFS_BASE;
    expect(lfsDownloadUrl('linux-x64', 'https://dep.example.com/')).toBe('https://dep.example.com/v3.8.0/git-lfs-linux-amd64-v3.8.0.tar.gz');
  });

  it('privateLfsBinDir：CONTEXT_PROXY_DIR 重定向优先（与镜像/cpx 同语义）', () => {
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
    })).rejects.toThrow(/CONTEXT_CPX_LFS_BASE/);
    expect(fs.existsSync(lfsBinaryPath())).toBe(false);
  });

  it('下载 404 → 指引报错（网络不可达同形态）', async () => {
    fs.rmSync(path.join(TMP, 'bin'), { recursive: true, force: true });
    await expect(ensureLfsBinaryAvailable({ fetchImpl: fetchOf({}), log: () => {} }))
      .rejects.toThrow(lfsSetupGuidance('下载 HTTP 404').slice(0, 20));
  });

  it('下载源回退链（纯函数）：缺省 = GitHub 直连 → 内置镜像；env/注入覆写 = 单源', () => {
    const c = lfsDownloadCandidates('linux-x64');
    expect(c).toHaveLength(3);
    expect(c[0]).toBe('https://github.com/git-lfs/git-lfs/releases/download/v3.8.0/git-lfs-linux-amd64-v3.8.0.tar.gz');
    expect(c[1]).toContain('gh-proxy.com');
    expect(c[2]).toContain('ghfast.top');
    process.env.CONTEXT_CPX_LFS_BASE = 'https://mirror.example.com/git-lfs/';
    expect(lfsDownloadCandidates('linux-x64')).toHaveLength(1);
    delete process.env.CONTEXT_CPX_LFS_BASE;
    expect(lfsDownloadCandidates('linux-x64', 'https://dep.example.com/')).toHaveLength(1);
  });

  it.skipIf(!KEY || !KEY.startsWith('linux'))('回退链自愈：GitHub 直连 404 → 镜像命中 → 安装成功（顺序断言）', async () => {
    fs.rmSync(path.join(TMP, 'bin'), { recursive: true, force: true });
    const seen: string[] = [];
    const fetchSpy = (async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url.startsWith('https://gh-proxy.com/')) {
        return new Response(fs.readFileSync(path.join(TMP, 'fixture-linux-x64', 'git-lfs-linux-amd64-v3.8.0.tar.gz')), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;
    await ensureLfsBinaryAvailable({ fetchImpl: fetchSpy, sha256: FIXTURE_SHA['linux-x64'], log: () => {} });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain('github.com');
    expect(seen[1]).toContain('gh-proxy.com');
    expect(privateGitLfsOk()).toBe(true);
  });

  it.skipIf(!KEY || !KEY.startsWith('linux'))('全部源失败 → 聚合原因的指引报错（仍含自备镜像出路）', async () => {
    fs.rmSync(path.join(TMP, 'bin'), { recursive: true, force: true });
    await expect(ensureLfsBinaryAvailable({ fetchImpl: fetchOf({}), log: () => {} }))
      .rejects.toThrow(/全部下载源失败[\s\S]*CONTEXT_CPX_LFS_BASE/);
  });

  it.skipIf(!KEY)('旧代私有件复用：pin 同版本的健康件直接拷贝，零下载', async () => {
    fs.rmSync(path.join(TMP, 'bin'), { recursive: true, force: true });
    const legacyDir = path.join(TMP, 'legacy-bin');
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacy = path.join(legacyDir, 'git-lfs');
    fs.writeFileSync(legacy, '#!/bin/sh\necho "git-lfs/3.8.0 (legacy fixture)"\n', { mode: 0o755 });
    let fetched = 0;
    const fetchSpy = (async () => { fetched += 1; return new Response('x', { status: 200 }); }) as unknown as typeof fetch;
    await ensureLfsBinaryAvailable({ fetchImpl: fetchSpy, legacyBins: [legacy], log: () => {} });
    expect(fetched).toBe(0);
    expect(privateGitLfsOk()).toBe(true);
  });

  it.skipIf(!KEY || !KEY.startsWith('linux'))('旧代版本不匹配（≠ pin）→ 不复用，走下载回退链', async () => {
    fs.rmSync(path.join(TMP, 'bin'), { recursive: true, force: true });
    const legacyDir = path.join(TMP, 'legacy-bin-old');
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacy = path.join(legacyDir, 'git-lfs');
    fs.writeFileSync(legacy, '#!/bin/sh\necho "git-lfs/3.7.0 (old)"\n', { mode: 0o755 });
    await ensureLfsBinaryAvailable({
      fetchImpl: fetchOf({ 'git-lfs-linux-amd64-v3.8.0.tar.gz': path.join(TMP, 'fixture-linux-x64', 'git-lfs-linux-amd64-v3.8.0.tar.gz') }),
      legacyBins: [legacy],
      sha256: FIXTURE_SHA['linux-x64'],
      log: () => {},
    });
    expect(privateGitLfsOk()).toBe(true);
  });

  it.skipIf(!KEY || !KEY.startsWith('linux'))('并发去重：并发触发只下载一次（后到者等待同一承诺）', async () => {
    fs.rmSync(path.join(TMP, 'bin'), { recursive: true, force: true });
    let fetched = 0;
    const fetchSpy = (async (input: RequestInfo | URL) => {
      fetched += 1;
      await new Promise(r => setTimeout(r, 50));
      return fetchOf({ 'git-lfs-linux-amd64-v3.8.0.tar.gz': path.join(TMP, 'fixture-linux-x64', 'git-lfs-linux-amd64-v3.8.0.tar.gz') })(input);
    }) as unknown as typeof fetch;
    await Promise.all([
      ensureLfsBinaryAvailable({ fetchImpl: fetchSpy, sha256: FIXTURE_SHA['linux-x64'], log: () => {} }),
      ensureLfsBinaryAvailable({ fetchImpl: fetchSpy, sha256: FIXTURE_SHA['linux-x64'], log: () => {} }),
    ]);
    expect(fetched).toBe(1);
    expect(privateGitLfsOk()).toBe(true);
  });

  it('prewarm：测试环境（VITEST 置位）no-op，不触网不落盘', async () => {
    fs.rmSync(path.join(TMP, 'bin'), { recursive: true, force: true });
    prewarmLfsBinary();
    await new Promise(r => setTimeout(r, 30));
    expect(fs.existsSync(lfsBinaryPath())).toBe(false);
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
