// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software and is distributed under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may not use this file except in compliance with the License.
// A copy of the License is located in the "LICENSE" file at the root of the source tree.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND,
// EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY,
// OR FITNESS FOR A PARTICULAR PURPOSE. See the License for the specific language governing
// permissions and limitations under the License.

// 镜像仓级凭据自持 UT（架构修复的机制面锁定，e2e/lake-upload-lazyfetch-auth
// 锁行为面）。锁四件事：
//   ① 确定性：机器 ambient 全局配置带诱饵 credential helper 时，镜像内
//      credential fill 仍解析出单源凭据（清位项 "" 隔离 system/global 链）
//   ② 卸载：单源凭据清除后，helper 文件与仓级配置一并移除（镜像停止认证）
//   ③ 瞬态防护：编辑态表单凭据（resolveAdhocRemote，storedAuth 缺省）不落盘
//   ④ 幂等：稳态下连续 ensureMirror 不改写 helper（mtime 不动）
// 隔离：CANNBOT_PROXY_DIR/LAKE_CACHE_DIR 重定向临时目录；GIT_CONFIG_GLOBAL
// 指向带诱饵的临时配置（同时天然构成 ① 的测试条件）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seedLakeConfig } from '../helpers/lake-env';

process.env.GIT_TERMINAL_PROMPT = '0';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lake-mirror-cred-'));
const BARE = path.join(TMP, 'bare.git');
const REMOTE_URL = `file://${BARE}`;
const USER = 'cred-ut-user';
const PASS = 'cred-ut-pass-0123456789';

// 诱饵全局配置：credential.helper 指向输出错误凭据的脚本——若清位项失效，
// fill 会解析出诱饵值（红态可见）
const DECOY_GLOBAL = path.join(TMP, 'decoy-gitconfig');
const DECOY_HELPER = path.join(TMP, 'decoy-helper.sh');

const savedEnv: Record<string, string | undefined> = {};

function git(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: 'pipe', timeout: 60_000 }).toString();
}

function credFill(cwd: string, url: string): { code: number; out: string } {
  try {
    const out = execSync('git credential fill', {
      cwd,
      input: `url=${url}\n`,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }).toString();
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer };
    return { code: err.status ?? -1, out: err.stdout?.toString() ?? '' };
  }
}

beforeAll(() => {
  for (const k of ['CANNBOT_PROXY_DIR', 'LAKE_CACHE_DIR', 'LAKE_LFS', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) {
    savedEnv[k] = process.env[k];
  }
  process.env.CANNBOT_PROXY_DIR = path.join(TMP, 'proxy');
  process.env.LAKE_CACHE_DIR = path.join(TMP, 'cache');
  process.env.LAKE_LFS = '0';
  process.env.GIT_CONFIG_GLOBAL = DECOY_GLOBAL;
  process.env.GIT_CONFIG_SYSTEM = '/dev/null';

  execSync(`git init --bare -b main "${BARE}"`, { stdio: 'pipe' });
  git('git config uploadpack.allowFilter true', BARE);
  git('git config uploadpack.allowAnySHA1InWant true', BARE);
  // 裸仓放一个提交（镜像 clone/校验需要可解析的 main）
  const seed = path.join(TMP, 'seed');
  execSync(`git clone --quiet "${BARE}" "${seed}"`, { stdio: 'pipe' });
  fs.writeFileSync(path.join(seed, 'README.md'), '# lake\n');
  git('git add .', seed);
  git('git -c user.name=seeder -c user.email=s@t commit -q -m "init"', seed);
  git('git push -q origin main', seed);

  fs.writeFileSync(DECOY_HELPER, ['#!/bin/sh', "cat <<'DECOYEOF'", 'username=decoy', 'password=decoy-wrong', 'DECOYEOF', ''].join('\n'), { mode: 0o700 });
  fs.writeFileSync(DECOY_GLOBAL, `[credential]\n\thelper = ${DECOY_HELPER}\n`);

  seedLakeConfig(TMP, { address: REMOTE_URL });
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

const mirror = await import('../../src/lib/lake/mirror');
const remoteMod = await import('../../src/lib/lake/remote');
const { setStoredCredentials, clearStoredCredentials } = await import('../../src/lib/lake/auth');

function helperPathOf(r: { cacheDir: string }): string {
  return path.join(r.cacheDir, '.git', 'lake-cred-helper.sh');
}

describe('镜像仓级凭据自持（syncMirrorCredentials）', () => {
  it('① 安装 + 确定性：ambient 诱饵全局 helper 不参与，fill 解析单源凭据', () => {
    setStoredCredentials(REMOTE_URL, USER, PASS);
    const dir = mirror.ensureMirror();
    const helper = helperPathOf(remoteMod.resolveLakeRemote());
    expect(fs.existsSync(helper)).toBe(true);
    const content = fs.readFileSync(helper, 'utf8');
    expect(content).toContain(`username=${USER}`);
    expect(content).toContain(`password=${PASS}`);
    // 仓级配置（--local 视角）：清位项（隔离 system/global 诱饵）+ 我们的
    // helper，保序。全链视角（不带 --local）形如 [诱饵, "", ours]——诱饵在
    // 清位项之前，被 "" 中和，这正是确定性的运行形态
    expect(git('git config --local --get-all credential.helper', dir).replace(/\n$/, '').split('\n'))
      .toEqual(['', helper]);
    // 架构属性：诱饵在 ambient 全局位时，镜像内 fill 仍是单源凭据
    const fill = credFill(dir, REMOTE_URL);
    expect(fill.code).toBe(0);
    expect(fill.out).toContain(`username=${USER}`);
    expect(fill.out).toContain(`password=${PASS}`);
    expect(fill.out).not.toContain('decoy');
  });

  it('② 卸载：单源凭据清除后，helper 与仓级配置一并移除、镜像回归机器自然形态', () => {
    clearStoredCredentials(REMOTE_URL);
    const dir = mirror.ensureMirror();
    expect(fs.existsSync(helperPathOf(remoteMod.resolveLakeRemote()))).toBe(false);
    expect(git('git config --local --get-all credential.helper 2>/dev/null || true', dir).trim()).toBe('');
    // 边界语义（有意为之）：撤销 = 回归修复前形态——insight 不再管理该镜像
    // 的凭据，ambient 链（本用例的诱饵 helper）恢复参与。不替用户做"永久
    // 隔离机器配置"的决定；单源在管期间（①）才提供确定性隔离
    const fill = credFill(dir, REMOTE_URL);
    expect(fill.code).toBe(0);
    expect(fill.out).toContain('username=decoy');
  });

  it('③ 瞬态防护：编辑态表单凭据（adhoc）不落盘进镜像', () => {
    const adhoc = remoteMod.resolveAdhocRemote({
      address: REMOTE_URL,
      authMode: 'token',
      account: 'form-user',
      token: 'form-transient-token',
    });
    const dir = mirror.ensureMirror(adhoc);
    expect(fs.existsSync(path.join(dir, '.git', 'lake-cred-helper.sh'))).toBe(false);
    expect(git('git config --local --get-all credential.helper 2>/dev/null || true', dir).trim()).toBe('');
  });

  it('④ 幂等：稳态下连续 ensureMirror 不改写 helper（mtime 不动）', () => {
    setStoredCredentials(REMOTE_URL, USER, PASS);
    mirror.ensureMirror();
    const helper = helperPathOf(remoteMod.resolveLakeRemote());
    const mtime = fs.statSync(helper).mtimeMs;
    mirror.ensureMirror();
    mirror.ensureMirror();
    expect(fs.statSync(helper).mtimeMs).toBe(mtime);
  });
});
