// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software and is distributed under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may not use this file except in compliance with the License.
// A copy of the License is located in the "LICENSE" file at the root of the source tree.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND,
// EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY,
// OR FITNESS FOR A PARTICULAR PURPOSE. See the License for the specific language governing
// permissions and limitations under the License.

// 上传链私有仓惰性物化凭据 IT（现场回归：客户上传报「令牌无效或已过期」，
// 实为 partial clone 镜像内 checkout/reset 物化触发的 promisor 懒取走匿名
// ——干净机器（无全局 credential helper）上私有远端 401，错误经
// classifyLakeError 分诊成 auth-failed，弹窗文案误导为令牌问题）。
// 链路 = ensureMirror（clone，一次性 helper 通道已锁）→ uploadFolder 的
// sparse-checkout + checkout -B（物化稀疏锥 → 懒取 blob 回源）→ push。
// 锁三件事：
//   ① uploadFolder 在私有远端上全链成功（红态 = checkout -B 匿名懒取 401
//      抛 "could not read Username / could not fetch … from promisor remote"）
//   ② 上传窗口内的回源请求凭据经镜像仓级 credential helper 送达（Basic
//      出现在 authlog，且不是 clone 段带来的——基线在 ensureMirror 之后取）
//   ③ 镜像仓自持凭据的机制面：.git/lake-cred-helper.sh 在位、仓级
//      credential.helper 配置生效（git credential fill 在镜像内可解析出凭据）
// 隔离：CANNBOT_PROXY_DIR/LAKE_CACHE_DIR 重定向临时目录；GIT_CONFIG_GLOBAL/
// SYSTEM 指向空文件——测试机恰好配置的全局 credential.helper 不参与（干净
// 机器形态是本用例的红态前提，不能被开发机的全局配置漂白）；LAKE_LFS=0
// 不依赖测试机装没装 git-lfs。
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
// 干净机器形态：ambient git 配置（全局/系统 credential.helper 等）一律缺席。
// 传 /dev/null——两变量只影响 git 进程的配置来源，不影响代码内 fs 直读。
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_SYSTEM = '/dev/null';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lake-upload-auth-'));
const DOCROOT = path.join(TMP, 'srvroot');
const BARE = path.join(DOCROOT, 'repo.git');
const AUTHLOG = path.join(TMP, 'authlog.jsonl');
const SEED = path.join(TMP, 'seed');
const STAGING = path.join(TMP, 'staging');
const USER = 'upit-user';
const PASS = 'upit-pass-0123456789';
const SID = 'ses_upauth_a';
const PARADIGM = 'it-up';

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
  return zlib.gzipSync(Buffer.from(JSON.stringify({ type: 'user', message: { role: 'user', content: text }, timestamp: '2026-10-21T00:00:00Z' }) + '\n'));
}

/** 范式布局 <paradigm>/<sid>/<sid>.{meta.json,jsonl.gz}（spec §2）。 */
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
  for (const k of ['CANNBOT_PROXY_DIR', 'LAKE_CACHE_DIR', 'LAKE_LFS', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) {
    savedEnv[k] = process.env[k];
  }
  process.env.CANNBOT_PROXY_DIR = path.join(TMP, 'proxy');
  process.env.LAKE_CACHE_DIR = path.join(TMP, 'cache');
  process.env.LAKE_LFS = '0';

  execSync(`git init --bare -b main "${BARE}"`, { stdio: 'pipe' });
  // partial clone + 按 OID fetch 的服务端开关（镜像层两条读路径都依赖）
  git('git config uploadpack.allowFilter true', BARE);
  git('git config uploadpack.allowAnySHA1InWant true', BARE);
  execSync(`git clone --quiet "${BARE}" "${SEED}"`, { stdio: 'pipe' });
  seedSession(PARADIGM, SID);
  seedSession(PARADIGM, 'ses_upauth_b');

  // 上传 staging（uploadFolder 契约：<staging>/sessions/<sid>/）
  fs.mkdirSync(path.join(STAGING, 'sessions', SID), { recursive: true });
  fs.writeFileSync(path.join(STAGING, 'sessions', SID, `${SID}.meta.json`), metaJson(SID));
  fs.writeFileSync(path.join(STAGING, 'sessions', SID, `${SID}.jsonl.gz`), jsonlGz('payload upload-a'));

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
const remoteMod = await import('../../src/lib/lake/remote');
const { setStoredCredentials } = await import('../../src/lib/lake/auth');

describe('上传链私有仓惰性物化凭据（镜像仓级 credential helper）', () => {
  it('① uploadFolder：私有远端全链成功（红态 = checkout 物化匿名懒取 401）', async () => {
    setStoredCredentials(REMOTE_URL, USER, PASS);
    // 先落镜像（clone 段的 Basic 与上传窗口切割开——authlog 基线在 ensureMirror 之后）
    const dir = await mirror.ensureMirror();
    const before = readAuthlog().length;
    const result = await mirror.uploadFolder(STAGING, SID, `提交人: ${USER} 内容描述: lazy-fetch auth IT`, undefined, PARADIGM);
    expect(result.unchanged).toBe(false);
    // 上传窗口内（稀疏锥物化懒取 + push）凭据经镜像仓级 helper 送达
    const auths = readAuthlog().slice(before).map(e => e.auth);
    expect(auths.length).toBeGreaterThan(0);
    expect(auths).toContain(basic(USER, PASS));
    // 远端确实收到（数据完整性，非只看返回值）
    expect(git(`git rev-parse origin/main:${PARADIGM}/${SID}/${SID}.jsonl.gz`, dir)).toBeTruthy();
  }, 180_000);

  it('② 镜像自持凭据机制面：helper 在位 + git credential fill 仓内可解析', async () => {
    const r = remoteMod.resolveLakeRemote();
    const helper = path.join(r.cacheDir, '.git', 'lake-cred-helper.sh');
    expect(fs.existsSync(helper)).toBe(true);
    // 只读仓级配置（--local）：全链 --get-all 会混入机器 ambient 链
    // （macOS 上 Xcode 自带 credential.helper=osxkeychain 不经
    //  GIT_CONFIG_SYSTEM=/dev/null 抑制），与镜像写入的 --local 配置无关
    const helpers = git('git config --local --get-all credential.helper', r.cacheDir).replace(/\n$/, '').split('\n');
    expect(helpers).toEqual(['', helper]);
    // 架构属性：镜像内任意 git 进程（含 promisor 懒取）都能解析出凭据——
    // 干净机器形态（GIT_CONFIG_GLOBAL/SYSTEM 已指空）下仍可解析
    const fill = execSync('git credential fill', {
      cwd: r.cacheDir,
      input: `url=${REMOTE_URL}\n`,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }).toString();
    expect(fill).toContain(`username=${USER}`);
    expect(fill).toContain(`password=${PASS}`);
  }, 60_000);

  it('③ 凭据轮换：换令牌后镜像 helper 同步更新', async () => {
    const NEW_PASS = 'upit-pass-rotated-9876';
    setStoredCredentials(REMOTE_URL, USER, NEW_PASS);
    const dir = await mirror.ensureMirror();
    expect(fs.readFileSync(path.join(dir, '.git', 'lake-cred-helper.sh'), 'utf8')).toContain(NEW_PASS);
    const fill = execSync('git credential fill', {
      cwd: dir,
      input: `url=${REMOTE_URL}\n`,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }).toString();
    expect(fill).toContain(`password=${NEW_PASS}`);
  }, 60_000);
});
