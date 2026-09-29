// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// ls-remote 凭据通道 IT（PR #38 审查意见回归锁）：真实 401 挑战-应答链路——
// git smart-http 网关（git http-backend + 强制 Basic 认证，独立子进程，同进程
// 会因 execSync 冻结事件循环而死锁）做「私有远端」，lake-auth.json 存量
// 凭据（表单为空——凭据不落 localStorage 后的常态）必须经一次性 credential
// helper 供给 branches/test 的 ls-remote：
//   ① action=branches：旧实现匿名 ls-remote → 恒 401 → 分支下拉永远
//      「获取分支失败」，且用户重输令牌也不会随请求发出（无恢复路径）
//   ② action=test：旧实现只内嵌表单凭据——表单为空时有效存量凭据被误报
//      「连接失败」；网关 authlog 断言凭据确实送达（而非匿名撞门）
//   ③ 存量凭据无效 → 401 挑战失败 → 如实报失败（helper 通道双向诚实）
//   ④ 表单凭据（includeCreds 形态）同走 helper 通道（URL 零内嵌）
// env 凭据通道（pullAuth 与 push 同链，clone/fetch 级回归锁）：
//   ⑥ env 分离对 + env 私有默认仓 → 无 config 的 list：clone 必须经一次性
//      helper 供给 env 凭据（旧实现 pullAuth 只回落 lake-auth.json →
//      匿名 401 → list/import/upload 全挂在 ensureMirror 克隆段，而 test 走
//      pushAuth 能过——用户以为配置完毕实则不可用）
//   ⑦ LAKE_PUSH_URL 完整凭据 URL 覆写 → pullAuth 同链继承（fetch 段）
//   ⑧ env 凭据对任意用户配置地址生效（默认仓退役后统一链——
//      错误实现会把 env 令牌经 401 挑战送到请求方主机）
// 隔离：CANNBOT_PROXY_DIR 重定向临时目录；GIT_TERMINAL_PROMPT=0 消除 git
// 终端提示的不确定性（stdio 管道下提示会挂到超时）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedLakeConfig, switchLakeConfig } from '../helpers/lake-env';

process.env.GIT_TERMINAL_PROMPT = '0';
process.env.no_proxy = ['127.0.0.1', 'localhost', process.env.no_proxy].filter(Boolean).join(',');
process.env.NO_PROXY = process.env.no_proxy;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lake-lsremote-auth-it-'));
const DOCROOT = path.join(TMP, 'srvroot');
const BARE = path.join(DOCROOT, 'repo.git');
const BARE_LEAK = path.join(DOCROOT, 'leak-guard.git');
const AUTHLOG = path.join(TMP, 'authlog.jsonl');
const USER = 'it-remote-user';
const PASS = 'it-remote-pass-0123456789';

function git(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: 'pipe', timeout: 60_000 }).toString();
}

function seedBare(): void {
  fs.mkdirSync(DOCROOT, { recursive: true });
  execSync(`git init --bare -b main "${BARE}"`, { stdio: 'pipe' });
  const seed = path.join(TMP, 'seed');
  execSync(`git clone --quiet "${BARE}" "${seed}"`, { stdio: 'pipe' });
  fs.writeFileSync(path.join(seed, 'marker.txt'), 'authed ls-remote it\n');
  git('git add .', seed);
  git('git -c user.name=seed -c user.email=seed@t commit -q -m init', seed);
  git('git push -q origin main', seed);
  git('git checkout -q -b dev-branch', seed);
  fs.writeFileSync(path.join(seed, 'branch-marker'), 'dev');
  git('git add .', seed);
  git('git -c user.name=seed -c user.email=seed@t commit -q -m dev', seed);
  git('git push -q origin dev-branch', seed);
}

// 泄漏防护专用第二个私有仓：独立 cacheDir（⑧ 匿名克隆必走首拉，不会命中
// ⑥ 已建的镜像被 stale-serve 兜底），且若实现错误地把 env 凭据供给自定义
// 地址，克隆会成功（200）——红绿两向都能判
function seedLeakGuardBare(): void {
  execSync(`git init --bare -b main "${BARE_LEAK}"`, { stdio: 'pipe' });
  const seed = path.join(TMP, 'leak-seed');
  execSync(`git clone --quiet "${BARE_LEAK}" "${seed}"`, { stdio: 'pipe' });
  fs.writeFileSync(path.join(seed, 'marker.txt'), 'leak guard\n');
  git('git add .', seed);
  git('git -c user.name=seed -c user.email=seed@t commit -q -m init', seed);
  git('git push -q origin main', seed);
}

const savedEnv: Record<string, string | undefined> = {};
let server: ReturnType<typeof spawn> | null = null;
let REMOTE_URL = '';
let LEAK_URL = '';

function readAuthlog(): Array<{ ts: number; auth: string }> {
  if (!fs.existsSync(AUTHLOG)) return [];
  return fs.readFileSync(AUTHLOG, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function basic(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

beforeAll(() => {
  for (const k of ['CANNBOT_PROXY_DIR', 'LAKE_PUSH_URL', 'LAKE_USERNAME', 'LAKE_TOKEN', 'LAKE_REMOTE_URL', 'LAKE_CACHE_DIR']) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.CANNBOT_PROXY_DIR = path.join(TMP, 'proxy');
  // env 凭据通道用例会触发真实 clone/fetch：镜像缓存必须留在 TMP，
  // 不得落在仓工作树默认位置
  process.env.LAKE_CACHE_DIR = path.join(TMP, 'cache');
  seedBare();
  seedLeakGuardBare();

  const helper = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'authed-git-http-server.mjs');
  server = spawn(process.execPath, [helper, DOCROOT, AUTHLOG, USER, PASS], { stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  return new Promise<void>(resolve => {
    const timer = setTimeout(() => { throw new Error(`authed git http server 未就绪: ${buf}`); }, 30_000);
    server!.stdout!.on('data', (c: Buffer) => {
      buf += c.toString();
      const m = buf.match(/PORT=(\d+)/);
      if (m) {
        clearTimeout(timer);
        REMOTE_URL = `http://127.0.0.1:${m[1]}/repo.git`;
        LEAK_URL = `http://127.0.0.1:${m[1]}/leak-guard.git`;
        resolve();
      }
    });
    server!.stderr!.on('data', (c: Buffer) => { buf += c.toString(); });
  });
}, 120_000);

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  server?.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const route = await import('../../src/app/api/ingest/lake/route');
const remoteMod = await import('../../src/lib/lake/remote');
const { setStoredCredentials, clearStoredCredentials } = await import('../../src/lib/lake/auth');

function post(body: unknown): Promise<Response> {
  return route.POST(new NextRequest('http://localhost/api/ingest/lake', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

describe('branches/test 凭据通道：已存凭据经一次性 helper 供给 ls-remote（401 挑战-应答）', () => {
  it('① branches：表单为空（凭据不落 localStorage 的常态）→ 消费 lake-auth.json 存量凭据，私有 http 远端分支可达', async () => {
    setStoredCredentials(REMOTE_URL, USER, PASS);
    const res = await post({ action: 'branches', config: { address: REMOTE_URL } });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.branches).toContain('main');
    expect(data.branches).toContain('dev-branch');
    // 凭据确实送到了网关（helper 通道），而非匿名撞门 401
    const auths = readAuthlog().map(e => e.auth);
    expect(auths).toContain(`Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`);
  });

  it('② test：表单为空 + 有效存量凭据 → 连接成功（旧实现匿名 401 → 误报连接失败）', async () => {
    const res = await post({ action: 'test', config: { address: REMOTE_URL } });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.message).toMatch(/连接成功/);
    expect(data.message).not.toMatch(/匿名/);
    expect(readAuthlog().map(e => e.auth)).toContain(`Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`);
  });

  it('③ test：存量凭据无效 → 401 挑战失败，如实报失败（helper 通道双向诚实）', async () => {
    setStoredCredentials(REMOTE_URL, USER, 'wrong-pass-000000');
    const res = await post({ action: 'test', config: { address: REMOTE_URL } });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(false);
  });

  it('④ 无任何凭据 → branches 401 失败且消息不带凭据痕迹（脱敏）', async () => {
    clearStoredCredentials(REMOTE_URL);
    const res = await post({ action: 'branches', config: { address: REMOTE_URL } });
    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain(USER);
    expect(text).not.toContain(PASS);
  });

  it('⑤ 表单凭据（includeCreds 形态）同走 helper 通道：URL 零内嵌也能过 401', async () => {
    const res = await post({ action: 'branches', config: { address: REMOTE_URL, authMode: 'token', account: USER, token: PASS } });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.branches).toContain('dev-branch');
    expect(readAuthlog().map(e => e.auth)).toContain(`Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`);
  });
});

describe('单源通道：服务端配置远端 + lake-auth.json 凭据（clone/fetch 经一次性 helper）', () => {
  it('⑥ 服务端配置私有远端 + 已存凭据 → 无 config 的 list 成功：clone 段消费已存凭据（旧实现匿名 401，list/import/upload 全挂在 ensureMirror）', async () => {
    clearStoredCredentials(REMOTE_URL);
    setStoredCredentials(REMOTE_URL, USER, PASS);
    seedLakeConfig(TMP, { address: REMOTE_URL });
    const before = readAuthlog().length;
    const res = await post({ action: 'list' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.sessions)).toBe(true);
    // 已存凭据确实经 helper 送达网关（而非匿名撞门 401）——viewer 等无请求体
    // 通道的服务端消费面同链
    expect(readAuthlog().slice(before).map(e => e.auth)).toContain(basic(USER, PASS));
  });

  it('⑦ 已建镜像的 fetch 段同样经 helper 送达（凭据同链，不因缓存降级匿名）', async () => {
    // ⑥ 已建镜像：本用例走 fetch 段（tryFetchMirror）——已存凭据同样送达
    const before = readAuthlog().length;
    const res = await post({ action: 'list', config: { address: LEAK_URL } });
    // body config 被忽略（单源）：仍按服务端配置的 REMOTE_URL 走 fetch
    expect(res.status).toBe(200);
    expect(readAuthlog().slice(before).map(e => e.auth)).toContain(basic(USER, PASS));
  });

  it('⑧ 服务端配置切远端 → 凭据按地址解析（leak-guard 仓同样闭环，URL 零内嵌）', async () => {
    setStoredCredentials(LEAK_URL, USER, PASS);
    switchLakeConfig({ address: LEAK_URL });
    try {
      const before = readAuthlog().length;
      const res = await post({ action: 'list' });
      expect(res.status).toBe(200);
      expect(readAuthlog().slice(before).map(e => e.auth)).toContain(basic(USER, PASS));
    } finally {
      switchLakeConfig({ address: REMOTE_URL });
    }
  });

  it('⑨ env 凭据通道退役锁：LAKE_USERNAME/LAKE_TOKEN/LAKE_PUSH_URL 设了也不生效（匿名 401 如实失败）', async () => {
    clearStoredCredentials(REMOTE_URL);
    process.env.LAKE_USERNAME = USER;
    process.env.LAKE_TOKEN = PASS;
    process.env.LAKE_PUSH_URL = REMOTE_URL;
    try {
      // 热镜像容错（fetch 失败回落本地可用）会掩盖凭据缺失——清掉镜像
      // 强制走 clone 段（匿名 401 才是 env 不生效的如实体）
      fs.rmSync(remoteMod.resolveLakeRemote().cacheDir, { recursive: true, force: true });
      const res = await post({ action: 'list' });
      // env 凭据不生效即匿名撞门失败（401 错误形态随 clone/fetch 路径而异，
      // 关键锁：失败 + PASS 零泄漏）
      expect([400, 500]).toContain(res.status);
      const text = JSON.stringify(await res.json());
      expect(text).not.toContain(PASS);
    } finally {
      delete process.env.LAKE_USERNAME;
      delete process.env.LAKE_TOKEN;
      delete process.env.LAKE_PUSH_URL;
    }
  });
});
