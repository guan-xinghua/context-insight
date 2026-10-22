// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// lake remote 单元：地址归一化（ai.gitcode.com → gitcode.com）、凭据内嵌、
// 分支/目录白名单（shell 注入面）、单源解析（resolveLakeRemote = 服务端
// lake-config.json 唯一；resolveAdhocRemote = 编辑态探测）、错误消息脱敏。
import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

delete process.env.LAKE_CACHE_DIR;
const TMP_UNIT = fs.mkdtempSync(path.join(os.tmpdir(), 'lake-remote-ut-'));
seedLakeConfig(TMP_UNIT, { address: '/tmp/unit-env-remote.git', branch: 'envbr' });
afterAll(() => { fs.rmSync(TMP_UNIT, { recursive: true, force: true }); });

const remote = await import('../../src/lib/lake/remote');
const platform = await import('../../src/lib/lake/platform');
// await import 的命名空间不能用在类型位置（TS2503）——类型走 type-only import
import type { LakeRemote } from '../../src/lib/lake/remote';
const mirrorMod = await import('../../src/lib/lake/mirror');
const { migrateLakeConfig } = await import('../../src/lib/lake-config');
import { seedLakeConfig, switchLakeConfig } from '../helpers/lake-env';

describe('normalizeGitAddress：ai.gitcode.com 归一化 + 安全面', () => {
  it('ai.gitcode.com → gitcode.com（git http 实际服务主机）', () => {
    expect(remote.normalizeGitAddress('https://example.com/corpus-archive'))
      .toBe('https://example.com/corpus-archive');
  });
  it('普通 gitcode 地址与尾斜杠', () => {
    expect(remote.normalizeGitAddress('https://example.com/a/b.git/')).toBe('https://example.com/a/b.git');
  });
  it('其他主机不改写', () => {
    expect(remote.normalizeGitAddress('https://example.com/lake.git'))
      .toBe('https://example.com/lake.git');
  });
  it('URL 里已有的 userinfo 剥离（凭据只走 auth 字段）', () => {
    expect(remote.normalizeGitAddress('https://user:pass@gitcode.com/a')).toBe('https://gitcode.com/a');
  });
  it('本地路径 / ssh 透传（测试指向本地 bare 仓）', () => {
    expect(remote.normalizeGitAddress(' /tmp/x/remote.git ')).toBe('/tmp/x/remote.git');
    expect(remote.normalizeGitAddress('git@host:org/repo.git')).toBe('git@host:org/repo.git');
  });
  it('shell 注入字符拒绝', () => {
    for (const bad of ['https://gitcode.com/a"b', 'https://gitcode.com/a;b', 'a|b', 'a&b', 'a$b', 'a`b', "a'b", 'a\nb']) {
      expect(() => remote.normalizeGitAddress(bad)).toThrow();
    }
  });
  it('空 / 非法 URL 拒绝', () => {
    expect(() => remote.normalizeGitAddress('')).toThrow();
    expect(() => remote.normalizeGitAddress('https://')).toThrow();
  });
});

describe('embedCredentials：两种认证二选一', () => {
  it('令牌模式：无账户 → oauth2:token', () => {
    expect(remote.embedCredentials('https://example.com/a/b', { authMode: 'token', token: 'tok' }))
      .toBe('https://oauth2:tok@example.com/a/b');
  });
  it('令牌模式：有账户 → account:token', () => {
    expect(remote.embedCredentials('https://example.com/a/b', { authMode: 'token', account: 'wang', token: 'tok' }))
      .toBe('https://wang:tok@example.com/a/b');
  });
  it('特殊字符编码（@ : 不破坏 URL 解析）', () => {
    expect(remote.embedCredentials('https://example.com/a/b', { authMode: 'token', token: 'a@b:c' }))
      .toBe('https://oauth2:a%40b%3Ac@example.com/a/b');
  });
  it('账密模式：缺一即 no-op', () => {
    expect(remote.embedCredentials('https://example.com/a/b', { authMode: 'password', account: 'u' }))
      .toBe('https://example.com/a/b');
    expect(remote.embedCredentials('https://example.com/a/b', { authMode: 'password', password: 'p' }))
      .toBe('https://example.com/a/b');
  });
  it('账密模式：完整则内嵌', () => {
    expect(remote.embedCredentials('https://example.com/a/b', { authMode: 'password', account: 'u', password: 'p' }))
      .toBe('https://u:p@example.com/a/b');
  });
  it('替换既有 userinfo（默认远端 + 自有凭据场景）', () => {
    expect(remote.embedCredentials('https://old:x@example.com/r', { authMode: 'token', token: 't' }))
      .toBe('https://oauth2:t@example.com/r');
  });
  it('本地路径远端不内嵌（测试环境安全）', () => {
    expect(remote.embedCredentials('/tmp/x.git', { authMode: 'token', token: 'tok' })).toBe('/tmp/x.git');
  });
  it('authMode none → no-op', () => {
    expect(remote.embedCredentials('https://example.com/a/b', { authMode: 'none' })).toBe('https://example.com/a/b');
  });
});

describe('validateBranch / normalizeDirectory：与 sid 同款白名单', () => {
  it('分支注入面全拒', () => {
    for (const bad of ['main; touch pwned', '../../etc', 'a\\b', '$(x)', '`x`', 'a|b', 'a&b', 'a\nb', 'feature/x', ' -b main']) {
      expect(() => remote.validateBranch(bad)).toThrow(/无效分支名/);
    }
  });
  it('合法分支接受（含 srb_7_sessions）', () => {
    expect(remote.validateBranch(' srb_7_sessions ')).toBe('srb_7_sessions');
    expect(remote.validateBranch('main')).toBe('main');
  });
  it('目录注入面全拒', () => {
    for (const bad of ['../../etc', 'a\\b', 'a/./b', 'a/../b', 'a//b', 'a b', 'a;b', '$(x)', 'a|b', 'a\nb', 'a`b']) {
      expect(() => remote.normalizeDirectory(bad)).toThrow();
    }
  });
  it('合法目录接受（多级 + 点号段）', () => {
    expect(remote.normalizeDirectory('trace/2026-08/wang-zhiyue2')).toBe('trace/2026-08/wang-zhiyue2');
    expect(remote.normalizeDirectory('v1.2')).toBe('v1.2');
    expect(remote.normalizeDirectory(' /trace/2026-08/ ')).toBe('trace/2026-08');
  });
  it('中文目录段接受（语料仓布局 <范式>/<月份>，如 01_longtail_op_gen/7月）', () => {
    expect(remote.normalizeDirectory('01_longtail_op_gen/7月')).toBe('01_longtail_op_gen/7月');
    expect(remote.normalizeDirPrefix('01_longtail_op_gen/7月/')).toBe('01_longtail_op_gen/7月');
    expect(remote.normalizeDirectory('中文目录')).toBe('中文目录');
  });
  it('中文段内混入注入字符 / 路径语义字符仍拒绝', () => {
    for (const bad of ['7月 a', '7月;a', '7月$(x)', '7月`x`', '7月|a', '7月&b', '7月"a', "7月'a", '7月\\a', '7月\na', '7月/../x', '7月//x']) {
      expect(() => remote.normalizeDirectory(bad)).toThrow(/无效目录/);
    }
  });
  it('缺省回落仓库根（sessions 存量区默认已退役）', () => {
    expect(remote.normalizeDirectory(undefined)).toBe('');
    expect(remote.normalizeDirectory('  ')).toBe('');
    expect(remote.normalizeDirectory('trace/2026-08')).toBe('trace/2026-08');
  });
});

describe('escapeRegExp：目录白名单含 `.`，拼正则前必须转义', () => {
  it('v1.2 目录不误配 v1x2', () => {
    const re = new RegExp(`^${remote.escapeRegExp('v1.2')}/([^/]+)/`);
    expect(re.test('v1.2/sid/x.jsonl')).toBe(true);
    expect(re.test('v1x2/sid/x.jsonl')).toBe(false);
  });
});

describe('resolveLakeRemote：单源（服务端 lake-config.json 唯一）', () => {
  it('读服务端配置（地址/分支）；未配置 fail-fast——env 地址通道已退役', () => {
    const r = remote.resolveLakeRemote();
    expect(r.pullUrl).toBe('/tmp/unit-env-remote.git');
    expect(r.branch).toBe('envbr');
    expect(r.rootDir).toBe('');
  });
  it('env 通道退役锁：LAKE_REMOTE_URL/LAKE_BRANCH/LAKE_PUSH_URL 设了也不生效', () => {
    const saved = { ...process.env };
    try {
      switchLakeConfig({ address: '/tmp/unit-env-remote.git', branch: 'envbr' });
      process.env.LAKE_REMOTE_URL = '/tmp/other-remote.git';
      process.env.LAKE_BRANCH = 'otherbr';
      process.env.LAKE_PUSH_URL = 'https://eu:et@example.com/x/y.git';
      process.env.LAKE_USERNAME = 'env-u';
      process.env.LAKE_TOKEN = 'env-t';
      const r = remote.resolveLakeRemote();
      expect(r.pullUrl).toBe('/tmp/unit-env-remote.git');
      expect(r.pushUrl).toBe('/tmp/unit-env-remote.git');
      expect(r.branch).toBe('envbr');
      expect(r.pushAuth).toBeNull();
      expect(r.pullAuth).toBeNull();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
  it('服务端未配置 → fail-fast 指引配置入口', () => {
    const saved = { ...process.env };
    try {
      // serverConfigPath = dirname(CANNBOT_PROXY_DIR)/lake-config.json——
      // 隔离须换父目录（同父不同 proxy 子目录共享同一配置文件）
      process.env.CANNBOT_PROXY_DIR = path.join(TMP_UNIT, 'empty', 'proxy');
      expect(() => remote.resolveLakeRemote()).toThrow(/未配置数据仓地址/);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
  it('服务端配置切远端/分支/目录生效', () => {
    switchLakeConfig({ address: 'https://example.com/corpus-archive', branch: 'srb_7_sessions', directory: 'trace/2026-08' });
    const r = remote.resolveLakeRemote();
    expect(r.pullUrl).toBe('https://example.com/corpus-archive');
    expect(r.branch).toBe('srb_7_sessions');
    expect(r.rootDir).toBe('trace/2026-08');
    switchLakeConfig({ address: '/tmp/unit-env-remote.git', branch: 'envbr' });
  });
  it('凭据：服务端配置远端一律 lake-auth.json 按地址解析（pull/push 同源）', async () => {
    const saved = { ...process.env };
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lake-auth-ut-'));
    try {
      process.env.CANNBOT_PROXY_DIR = path.join(tmpHome, 'proxy');
      switchLakeConfig({ address: '/tmp/unit-env-remote.git' });
      const { setStoredCredentials, clearStoredCredentials } = await import('../../src/lib/lake/auth');
      setStoredCredentials('/tmp/unit-env-remote.git', 'stored-u', 'stored-t-123456');
      const r = remote.resolveLakeRemote();
      expect(r.pushAuth).toEqual({ username: 'stored-u', password: 'stored-t-123456' });
      expect(r.pullAuth).toEqual({ username: 'stored-u', password: 'stored-t-123456' });
      clearStoredCredentials(undefined);
      const anon = remote.resolveLakeRemote();
      expect(anon.pushAuth).toBeNull();
      expect(anon.pullAuth).toBeNull();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      switchLakeConfig({ address: '/tmp/unit-env-remote.git', branch: 'envbr' });
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

describe('resolveAdhocRemote：编辑态探测（test/branches/dirs 消费）', () => {
  it('显式地址必填（无服务端回落）；分支/目录缺省 main/根', () => {
    expect(() => remote.resolveAdhocRemote({})).toThrow(/缺少远端地址/);
    const r = remote.resolveAdhocRemote({ address: 'https://example.com/a/b' });
    expect(r.pullUrl).toBe('https://example.com/a/b');
    expect(r.branch).toBe('main');
    expect(r.rootDir).toBe('');
  });
  it('分支/目录取输入值', () => {
    expect(remote.resolveAdhocRemote({ address: 'https://example.com/a/b', branch: 'srb_7_sessions' }).branch).toBe('srb_7_sessions');
    expect(remote.resolveAdhocRemote({ address: 'https://example.com/a/b', directory: 'trace/2026-08' }).rootDir).toBe('trace/2026-08');
  });
  it('凭据：pull 原样内嵌，push 拆为无凭据 URL + pushAuth（平台拒请求直带密码）', () => {
    const r = remote.resolveAdhocRemote({ address: 'https://ai.gitcode.com/a/b', authMode: 'token', token: 'tk' });
    expect(r.pullUrl).toBe('https://oauth2:tk@gitcode.com/a/b');
    expect(r.pushUrl).toBe('https://gitcode.com/a/b');
    expect(r.pushUrl).not.toContain('@');
    expect(r.pushAuth).toEqual({ username: 'oauth2', password: 'tk' });
    expect(r.pullAuth).toBeNull();
  });
  it('表单凭据空 → lake-auth.json 兜底', async () => {
    const saved = { ...process.env };
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lake-auth-ut-'));
    try {
      process.env.CANNBOT_PROXY_DIR = path.join(tmpHome, 'proxy');
      const { setStoredCredentials, clearStoredCredentials } = await import('../../src/lib/lake/auth');
      setStoredCredentials('https://example.com/a/b.git', 'stored-u', 'stored-t');
      const r = remote.resolveAdhocRemote({ address: 'https://example.com/a/b.git' });
      expect(r.pushAuth).toEqual({ username: 'stored-u', password: 'stored-t' });
      expect(r.pullAuth).toEqual({ username: 'stored-u', password: 'stored-t' });
      clearStoredCredentials(undefined);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
  it('cacheDir：一律按远端 URL+分支哈希隔离，同输入稳定、异远端隔离', () => {
    const a1 = remote.resolveAdhocRemote({ address: '/tmp/r1.git' }).cacheDir;
    const a2 = remote.resolveAdhocRemote({ address: '/tmp/r1.git' }).cacheDir;
    const b = remote.resolveAdhocRemote({ address: '/tmp/r2.git' }).cacheDir;
    const br = remote.resolveAdhocRemote({ address: '/tmp/r1.git', branch: 'dev' }).cacheDir;
    const def = remote.resolveLakeRemote().cacheDir;
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1).not.toBe(br);
    expect(path.dirname(def)).toBe(path.dirname(a1));
  });
  it('LAKE_CACHE_DIR 动态覆盖（哈希基目录随之切换）', () => {
    process.env.LAKE_CACHE_DIR = '/tmp/unit-cache-override';
    try {
      const def = remote.resolveLakeRemote().cacheDir;
      expect(path.dirname(def)).toBe('/tmp/unit-cache-override');
      const custom = remote.resolveAdhocRemote({ address: '/tmp/r1.git' }).cacheDir;
      expect(path.dirname(custom)).toBe('/tmp/unit-cache-override');
      expect(custom).not.toBe(def);
    } finally {
      delete process.env.LAKE_CACHE_DIR;
    }
  });
});

describe('parseUrlCreds：内嵌凭据拆分（push 走 helper 通道的前提）', () => {
  it('https://user:pass@host → 无凭据 URL + auth 对', () => {
    const a = remote.parseUrlCreds('https://duanbingzhe:tok@example.com/lake.git');
    expect(a.credless).toBe('https://example.com/lake.git');
    expect(a.auth).toEqual({ username: 'duanbingzhe', password: 'tok' });
  });
  it('URL 编码凭据解码（embedCredentials 写入侧 encodeURIComponent）', () => {
    const b = remote.parseUrlCreds('https://oauth2:tok%40x%3A@host/repo.git');
    expect(b.auth).toEqual({ username: 'oauth2', password: 'tok@x:' });
    expect(b.credless).toBe('https://host/repo.git');
  });
  it('无凭据 https / 本地路径 / ssh 透传，auth=null', () => {
    for (const u of ['https://example.com/a/b.git', '/tmp/x.git', 'git@host:org/repo.git']) {
      expect(remote.parseUrlCreds(u)).toEqual({ credless: u, auth: null });
    }
  });
});

/** 一次性 helper 临时目录（insight-lake-auth-*）用后即删的收敛断言辅助：
 *  瞬时快照对并行用例敏感——其他 worker 同刻持有/清理的目录会闯进快照，
 *  两个方向（新增闯入 / 快照内条目被他人清理）都会假红。等"不再有快照之外
 *  新目录"的收敛态；快照内目录消失不影响判定——本用例自己的泄漏目录不在
 *  快照里且用后仍在，等待窗口（10s）内必然可见。 */
const authDirsSettled = (before: string[]): boolean => {
  for (let i = 0; i < 40; i++) {
    const fresh = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('insight-lake-auth-') && !before.includes(n));
    if (fresh.length === 0) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  return false;
};

describe('pushMirror：401 挑战-应答通道（本地 bare IT）', () => {
  it('pushAuth 存在：一次性 helper 构造/清理 + push 成功（本地传输不咨询凭据，锁命令构造与生命周期）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-pushmirror-it-'));
    try {
      const bare = path.join(tmp, 'bare.git');
      execSync(`git init --bare -b main "${bare}"`, { stdio: 'pipe' });
      const work = path.join(tmp, 'work');
      fs.mkdirSync(work, { recursive: true });
      const git = (cmd: string) => execSync(cmd, { cwd: work, stdio: 'pipe' });
      git('git init -b main .');
      fs.writeFileSync(path.join(work, 'f.txt'), 'x');
      git('git -c user.name=t -c user.email=t@x add -A');
      git('git -c user.name=t -c user.email=t@x commit -m m');
      const before = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('insight-lake-auth-'));
      const r = remote.resolveAdhocRemote({ address: bare, branch: 'main' });
      expect(r.pushAuth).toBeNull(); // 本地路径无凭据
      const withAuth: LakeRemote = { ...r, pushAuth: { username: 'it-user', password: 'it-pass' } };
      mirrorMod.pushMirror(work, withAuth);
      expect(execSync('git rev-parse main', { cwd: bare, stdio: 'pipe' }).toString().trim())
        .toBe(execSync('git rev-parse HEAD', { cwd: work, stdio: 'pipe' }).toString().trim());
      expect(authDirsSettled(before)).toBe(true); // helper 临时目录用后即删
      // pushAuth=null 直推路径
      fs.writeFileSync(path.join(work, 'g.txt'), 'y');
      git('git -c user.name=t -c user.email=t@x add -A');
      git('git -c user.name=t -c user.email=t@x commit -m m2');
      mirrorMod.pushMirror(work, r);
      expect(execSync('git rev-parse main', { cwd: bare, stdio: 'pipe' }).toString().trim())
        .toBe(execSync('git rev-parse HEAD', { cwd: work, stdio: 'pipe' }).toString().trim());
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  it('pullAuth 存在：clone/fetch 经一次性 helper（本地传输不咨询凭据，锁命令构造与生命周期）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-pullmirror-it-'));
    try {
      const bare = path.join(tmp, 'bare.git');
      execSync(`git init --bare -b main "${bare}"`, { stdio: 'pipe' });
      const work = path.join(tmp, 'work');
      fs.mkdirSync(work, { recursive: true });
      const git = (cmd: string) => execSync(cmd, { cwd: work, stdio: 'pipe' });
      git('git init -b main .');
      fs.writeFileSync(path.join(work, 'f.txt'), 'x');
      git('git -c user.name=t -c user.email=t@x add -A');
      git('git -c user.name=t -c user.email=t@x commit -m m');
      git(`git push --quiet "${bare}" main`);
      const cache = path.join(tmp, 'cache');
      const before = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('insight-lake-auth-'));
      const r = remote.resolveAdhocRemote({ address: bare, branch: 'main' });
      const withPullAuth: LakeRemote = { ...r, cacheDir: cache, pullAuth: { username: 'pull-u', password: 'pull-p' } };
      const dir = mirrorMod.ensureMirror(withPullAuth);
      // 镜像就绪：origin/main 可解析（clone/fetch 走通——本地传输不咨询凭据，
      // helper 的价值在 https 挑战-应答，此处锁命令构造与临时目录生命周期）
      expect(execSync('git rev-parse --verify -q refs/remotes/origin/main', { cwd: dir, stdio: 'pipe' }).toString().trim())
        .toBe(execSync('git rev-parse main', { cwd: bare, stdio: 'pipe' }).toString().trim());
      expect(authDirsSettled(before)).toBe(true); // helper 临时目录用后即删
      // 二次 ensure 走 fetch 路径同样带 helper 生命周期（无残留即证）
      mirrorMod.ensureMirror(withPullAuth);
      expect(authDirsSettled(before)).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  it('pushAuth 含换行：helper 协议非法，立即拒绝且不落临时目录', () => {
    const r = remote.resolveAdhocRemote({ address: '/tmp/x.git', branch: 'main' });
    const bad: LakeRemote = { ...r, pushAuth: { username: 'u', password: 'p\nq' } };
    const before = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('insight-lake-auth-'));
    expect(() => mirrorMod.pushMirror('/tmp', bad)).toThrow('newline');
    expect(authDirsSettled(before)).toBe(true);
  });
});

describe('lake-config：迁移与请求体裁剪', () => {
  it('legacy {address,account,password} → 地址保留 + authMode password', () => {
    const m = migrateLakeConfig({ address: 'https://example.com/a/b', account: 'u', password: 'p' });
    expect(m).toMatchObject({ address: 'https://example.com/a/b', authMode: 'password', account: 'u', password: 'p', token: '', branch: 'main', directory: '' });
  });
  it('空地址 = 未自定义（不再回落占位默认——平台化后无占位地址）', () => {
    expect(migrateLakeConfig({ addressPreset: 'default', address: '', authMode: 'token', token: 't' })!.address).toBe('');
    expect(migrateLakeConfig({ address: '', authMode: 'token', token: 't' })!.address).toBe('');
    expect(migrateLakeConfig({})!.address).toBe('');
  });
  it('新形状透传；垃圾 → null', () => {
    expect(migrateLakeConfig({ address: 'https://example.com/a/b', authMode: 'token', token: 't' }))
      .toMatchObject({ address: 'https://example.com/a/b', authMode: 'token', token: 't' });
    expect(migrateLakeConfig(null)).toBeNull();
    expect(migrateLakeConfig('x')).toBeNull();
  });
});

describe('testLakeRemote：选了认证方式但没填凭据 → 直接失败', () => {
  it('令牌模式缺令牌', async () => {
    const r = await remote.testLakeRemote({ authMode: 'token', token: '' });
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/未填写令牌/);
  });
  it('账密模式缺账户或密码', async () => {
    expect((await remote.testLakeRemote({ authMode: 'password', account: 'u' })).message).toMatch(/未填写完整/);
    expect((await remote.testLakeRemote({ authMode: 'password', password: 'p' })).message).toMatch(/未填写完整/);
  });
});

describe('listRemoteDirs 入口校验：prefix 拼命令前先过白名单（lib 层防线）', () => {
  it('非法前缀直接抛、不触达 git', () => {
    for (const bad of ['a b', 'a;rm', '$(x)', 'a\\b', '../x']) {
      expect(() => mirrorMod.listRemoteDirs(remote.defaultLakeRemote(), bad)).toThrow(/无效目录/);
    }
  });
});

describe('tokenOwner：api/v5/user 反查令牌属主', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('200 → login（fallback username）；令牌走 Bearer 头而非 URL query（防访问/反代日志侧录）', async () => {
    const f1 = vi.fn(async (_url: unknown, _init?: unknown) => new Response(JSON.stringify({ login: 'wang-zhiyue2' }), { status: 200 }));
    vi.stubGlobal('fetch', f1);
    expect(await platform.tokenOwner('https://oauth2:t@gitcode.com/a/b', 't')).toBe('wang-zhiyue2');
    // 传输形态锁：URL 无令牌、Bearer 头携带（旧实现 ?access_token= 进日志）
    const [url, init] = f1.mock.calls[0] as [string, { headers?: Record<string, string> }];
    expect(String(url)).toBe('https://gitcode.com/api/v5/user');
    expect(String(url)).not.toContain('access_token');
    expect(init?.headers?.Authorization).toBe('Bearer t');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ username: 'fallback-user' }), { status: 200 })));
    expect(await platform.tokenOwner('https://oauth2:t@gitcode.com/a/b', 't')).toBe('fallback-user');
  });
  it('401 / 异常 / 非 gitcode / 空密钥 → null（不放大失败）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error_code":401}', { status: 401 })));
    expect(await platform.tokenOwner('https://oauth2:t@gitcode.com/a/b', 't')).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('net'); }));
    expect(await platform.tokenOwner('https://oauth2:t@gitcode.com/a/b', 't')).toBeNull();
    expect(await platform.tokenOwner('/tmp/local.git', 't')).toBeNull();
    expect(await platform.tokenOwner('https://example.com/a/b', '')).toBeNull();
  });
});

describe('redactRemoteSecrets：错误消息出边界前脱敏', () => {
  it('带凭据 URL → 无凭据地址；裸凭据 → ***', () => {
    const r = remote.resolveAdhocRemote({ address: 'https://example.com/a/b', authMode: 'token', token: 'secret-token-123456' });
    const msg = remote.redactRemoteSecrets(
      `Command failed: git push "https://oauth2:secret-token-123456@example.com/a/b" main\nfatal: Authentication failed for secret-token-123456`,
      r,
      [undefined, undefined, 'secret-token-123456'],
    );
    expect(msg).not.toContain('secret-token-123456');
    expect(msg).not.toContain('oauth2:');
    expect(msg).toContain('https://example.com/a/b');
    expect(msg).toContain('***');
  });
});

describe('credentialTestMessage：测试连接结论文案（PR #38 审查意见：owner=null 不得伪称已验证）', () => {
  it('gitcode + owner=null（令牌无效/过期/属主查询失败）→ 凭据未能验证；绝不出现「凭据已验证」', () => {
    const m = remote.credentialTestMessage({ owner: null, account: 'someone', authMode: 'token', isGitcode: true });
    expect(m).toMatch(/凭据未能验证/);
    expect(m).not.toContain('凭据已验证');
  });
  it('gitcode + owner 与所填账户不一致 → 提示属主归属（git 认证不校验用户名）', () => {
    const m = remote.credentialTestMessage({ owner: 'real-owner', account: 'someone', authMode: 'token', isGitcode: true });
    expect(m).toContain('real-owner');
    expect(m).toMatch(/不一致/);
  });
  it('gitcode + password 模式 + owner 已知 → 提示密码位实为令牌', () => {
    const m = remote.credentialTestMessage({ owner: 'real-owner', account: 'real-owner', authMode: 'password', isGitcode: true });
    expect(m).toMatch(/密码位实为令牌/);
  });
  it('gitcode + owner 已知且一致/令牌模式 → 凭据已验证 + 属主', () => {
    const m = remote.credentialTestMessage({ owner: 'real-owner', account: 'real-owner', authMode: 'token', isGitcode: true });
    expect(m).toMatch(/凭据已验证/);
    expect(m).toContain('real-owner');
  });
  it('非 gitcode → 诚实文案（不声称凭据已验证，有效性由首次上传确认）', () => {
    const m = remote.credentialTestMessage({ owner: null, account: 'u', authMode: 'token', isGitcode: false });
    expect(m).not.toContain('凭据已验证');
    expect(m).toMatch(/首次上传确认/);
  });
});

describe('ls-remote 凭据通道接线（源级锁，PR #38 审查意见回归锚点）', () => {
  const read = (rel: string): string => fs.readFileSync(path.resolve(__dirname, rel), 'utf8');

  it('test/branches 的 ls-remote 一律经 runGitWithAuth 供给解析链凭据，URL 零内嵌', () => {
    const src = read('../../src/lib/lake/remote.ts');
    const testBody = src.slice(src.indexOf('export async function testLakeRemote'), src.indexOf('export function listRemoteBranches'));
    expect(testBody).toContain('runGitWithAuth');
    expect(testBody).toContain('remote.pushAuth');
    expect(testBody).toContain('parseUrlCreds(remote.pullUrl).credless');
    expect(testBody).not.toContain('execSync(');
    const branchBody = src.slice(src.indexOf('export function listRemoteBranches'));
    expect(branchBody).toContain('runGitWithAuth');
    expect(branchBody).toContain('remote.pullAuth');
    expect(branchBody).not.toContain('execSync(');
  });

  it('无凭据指引指向真实入口 cbi auth（cpx auth 已随重构移除，照做会撞 unknown command）', () => {
    const authSrc = read('../../src/lib/lake/auth.ts');
    expect(authSrc).not.toContain('cpx auth');
    expect(authSrc).toContain('cbi auth');
    expect(read('../../src/lib/lake/remote.ts')).not.toContain('cpx auth');
  });
});
