// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// viewer 异步链私有仓凭据 IT（现场回归：进 viewer 页面终端停在 Username for
// 'https://gitcode.com'）。链路 = ensureMirrorAsync（clone，凭据通道已被
// lake-lsremote-auth-it ⑥⑦ 锁）→ readLakeSessions → readSessionMetasDetailed
// 的「缺失 meta blob 按 OID 批量预取」——该 fetch 曾走匿名 runGitAsync：私有
// 远端 401 后 git 无 credential helper 可问，退到终端问用户名，HTTP 请求冻到
// 超时、提示串进服务器终端。锁两件事：
//   ① meta 预取凭据经一次性 credential helper 送达（网关 authlog 全程 Basic，
//      无匿名撞门记录）且 meta 字段真实回填（匿名 401 时恒 null）
//   ② materializeSession（导入链）在私有远端上照常物化（prefetchBlobs +
//      batch cat-file 的 helper 通道改造不回归）
// 隔离：CANNBOT_PROXY_DIR/LAKE_CACHE_DIR 重定向临时目录；GIT_TERMINAL_PROMPT=0
// 让红态（匿名 401）快速失败而不是挂终端到超时。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { seedLakeConfig } from '../helpers/lake-env';

process.env.GIT_TERMINAL_PROMPT = '0';
process.env.no_proxy = ['127.0.0.1', 'localhost', process.env.no_proxy].filter(Boolean).join(',');
process.env.NO_PROXY = process.env.no_proxy;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lake-viewer-auth-'));
const DOCROOT = path.join(TMP, 'srvroot');
const BARE = path.join(DOCROOT, 'repo.git');
const AUTHLOG = path.join(TMP, 'authlog.jsonl');
const SEED = path.join(TMP, 'seed');
const USER = 'viewer-it-user';
const PASS = 'viewer-it-pass-0123456789';

const savedEnv: Record<string, string | undefined> = {};
let server: ReturnType<typeof spawn> | null = null;
let REMOTE_URL = '';

function git(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: 'pipe', timeout: 60_000 }).toString();
}

function basic(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

function readAuthlog(): Array<{ ts: number; auth: string }> {
  if (!fs.existsSync(AUTHLOG)) return [];
  return fs.readFileSync(AUTHLOG, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function metaJson(sid: string): string {
  return JSON.stringify({
    x_cannbay: {
      schema: 'cc-session-meta',
      version: 1,
      data: { producer: 'cpx', framework: 'opencode', ccVersion: '1.2.3', opGen: 'success', sid },
    },
  }, null, 2) + '\n';
}

function jsonlGz(text: string): Buffer {
  return zlib.gzipSync(Buffer.from(JSON.stringify({ type: 'user', message: { role: 'user', content: text }, timestamp: '2026-10-05T00:00:00Z' }) + '\n'));
}

/** 范式布局 <paradigm>/<sid>/<sid>.{meta.json,jsonl.gz}（spec §2，viewer 读取面）。 */
function seedSession(paradigm: string, sid: string): void {
  const dir = path.join(SEED, paradigm, sid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.meta.json`), metaJson(sid));
  fs.writeFileSync(path.join(dir, `${sid}.jsonl.gz`), jsonlGz(`payload ${sid}`));
  git('git add .', SEED);
  git(`git -c user.name=seeder -c user.email=s@t commit -q -m "提交人: seeder 内容描述: session ${sid}"`, SEED);
  git('git push -q origin main', SEED);
}

beforeAll(() => {
  for (const k of ['CANNBOT_PROXY_DIR', 'LAKE_CACHE_DIR', 'LAKE_LFS']) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.CANNBOT_PROXY_DIR = path.join(TMP, 'proxy');
  process.env.LAKE_CACHE_DIR = path.join(TMP, 'cache');
  // LAKE_LFS=0：materializeSession 走经典 prefetch+batch 分支——LFS 分支的
  // cat-file --filters 凭据走同一个 spawnGitAuthed helper（通道已覆盖），
  // 不让 IT 依赖测试机装没装 git-lfs
  process.env.LAKE_LFS = '0';

  execSync(`git init --bare -b main "${BARE}"`, { stdio: 'pipe' });
  // partial clone + 按 OID fetch 的服务端开关（镜像层两条读路径都依赖）
  git('git config uploadpack.allowFilter true', BARE);
  git('git config uploadpack.allowAnySHA1InWant true', BARE);
  execSync(`git clone --quiet "${BARE}" "${SEED}"`, { stdio: 'pipe' });
  seedSession('it-vp', 'ses_vauth_a');
  seedSession('it-vp', 'ses_vauth_b');
  // 范式优化目标文件（readParadigmTarget 的读取对象；partial clone 下该 blob
  // 不在本地，git show 懒取回源——私有仓匿名 401 即本用例的红态）
  fs.mkdirSync(path.join(SEED, 'it-vp'), { recursive: true });
  fs.writeFileSync(path.join(SEED, 'it-vp', 'it-vp.jsonl'), JSON.stringify({ type: 'opgen-target', baselineMs: 12345, expectedMs: 6789 }) + '\n');
  git('git add .', SEED);
  git('git -c user.name=seeder -c user.email=s@t commit -q -m "target"', SEED);
  git('git push -q origin main', SEED);

  const helper = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ut', 'helpers', 'authed-git-http-server.mjs');
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
        seedLakeConfig(TMP, { address: REMOTE_URL });
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

const mirror = await import('../../src/lib/lake/mirror');
const notes = await import('../../src/lib/lake/notes');
const remoteMod = await import('../../src/lib/lake/remote');
const { setStoredCredentials } = await import('../../src/lib/lake/auth');

describe('viewer 异步链私有仓凭据（meta 按 OID 预取经一次性 helper）', () => {
  it('① clone 后 readLakeSessions：meta 预取全程 Basic 送达、meta 字段回填（红态=匿名 401 → meta 恒 null）', async () => {
    setStoredCredentials(REMOTE_URL, USER, PASS);
    const dir = await mirror.ensureMirrorAsync();   // clone 段（凭据通道已由 lsremote ⑥ 锁，此处只做铺垫）
    const before = readAuthlog().length;
    const sessions = await mirror.readLakeSessions(dir, remoteMod.resolveLakeRemote());
    const rows = sessions.filter(s => s.sid.startsWith('ses_vauth_'));
    expect(rows.length).toBe(2);
    // 匿名 401 时 meta 全体 null（framework 是 meta 独有字段——树结构给不出）
    expect(rows.every(s => s.framework === 'opencode' && s.producer === 'cpx')).toBe(true);
    // oid 预取确实回源了，且凭据经 helper 送达（git http 协议固有形态：匿名
    // 首探 → 401 挑战 → Basic 重试——窗口里必然混有匿名探针，判据是 Basic
    // 存在而非唯一；红态 = 只有匿名探针、零 Basic，oid 预取整体失败）
    const fresh = readAuthlog().slice(before).map(e => e.auth);
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh).toContain(basic(USER, PASS));
  }, 120_000);

  it('② readParadigmTarget：git show 懒取经一次性 helper 带凭据（红态=匿名 401 抛错）', async () => {
    const before = readAuthlog().length;
    const target = await notes.readParadigmTarget('it-vp');
    expect(target).toEqual({ baselineMs: 12345, expectedMs: 6789 });
    const auths = readAuthlog().slice(before).map(e => e.auth);
    expect(auths.length).toBeGreaterThan(0);
    expect(auths).toContain(basic(USER, PASS));
  }, 120_000);

  it('③ materializeSession：私有远端导入链照常物化（gz 逐字节一致）', async () => {
    const mainJsonl = await mirror.materializeSession('ses_vauth_a');
    expect(fs.readFileSync(mainJsonl)).toEqual(jsonlGz('payload ses_vauth_a'));
  }, 120_000);
});
