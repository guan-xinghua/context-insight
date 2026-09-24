// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// cannbay2 remote 单元：地址归一化（ai.gitcode.com → gitcode.com）、凭据内嵌、
// 分支/目录白名单（shell 注入面）、resolve 优先级（body > env > 硬编码）、
// localStorage 迁移、错误消息脱敏。
import { describe, it, expect, vi, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CANNBAY2_REMOTE_URL = '/tmp/unit-env-remote.git';
process.env.CANNBAY2_BRANCH = 'envbr';
delete process.env.CANNBAY2_CACHE_DIR;
delete process.env.CANNBAY2_PUSH_URL;

const remote = await import('../../src/lib/cannbay2/remote');
// await import 的命名空间不能用在类型位置（TS2503）——类型走 type-only import
import type { Cannbay2Remote } from '../../src/lib/cannbay2/remote';
const mirrorMod = await import('../../src/lib/cannbay2/mirror');
const { migrateCannbayConfig, cannbayRemoteInput, DEFAULT_CANNBAY_ADDRESS } = await import('../../src/lib/cannbay-config');

describe('normalizeGitAddress：ai.gitcode.com 归一化 + 安全面', () => {
  it('ai.gitcode.com → gitcode.com（git http 实际服务主机）', () => {
    expect(remote.normalizeGitAddress('https://example.com/trace_corpus'))
      .toBe('https://example.com/trace_corpus');
  });
  it('普通 gitcode 地址与尾斜杠', () => {
    expect(remote.normalizeGitAddress('https://example.com/a/b.git/')).toBe('https://example.com/a/b.git');
  });
  it('其他主机不改写', () => {
    expect(remote.normalizeGitAddress('https://example.com/cannbay2.git'))
      .toBe('https://example.com/cannbay2.git');
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
  it('缺省回落 sessions', () => {
    expect(remote.normalizeDirectory(undefined)).toBe('sessions');
    expect(remote.normalizeDirectory('  ')).toBe('sessions');
  });
});

describe('escapeRegExp：目录白名单含 `.`，拼正则前必须转义', () => {
  it('v1.2 目录不误配 v1x2', () => {
    const re = new RegExp(`^${remote.escapeRegExp('v1.2')}/([^/]+)/`);
    expect(re.test('v1.2/sid/x.jsonl')).toBe(true);
    expect(re.test('v1x2/sid/x.jsonl')).toBe(false);
  });
});

describe('resolveCannbay2Remote：body > env > 硬编码默认', () => {
  it('无 body → env 远端 + env 分支', () => {
    const r = remote.resolveCannbay2Remote();
    expect(r.pullUrl).toBe('/tmp/unit-env-remote.git');
    expect(r.branch).toBe('envbr');
    expect(r.rootDir).toBe('sessions');
  });
  it('body address 覆盖 env；无 branch 时不吃 env 分支（env 分支属于 env 远端）', () => {
    const r = remote.resolveCannbay2Remote({ address: 'https://example.com/trace_corpus' });
    expect(r.pullUrl).toBe('https://example.com/trace_corpus');
    expect(r.pushUrl).toBe('https://example.com/trace_corpus');
    expect(r.branch).toBe('main');
  });
  it('body branch 覆盖（带地址与不带地址两种）', () => {
    expect(remote.resolveCannbay2Remote({ address: 'https://example.com/a/b', branch: 'srb_7_sessions' }).branch).toBe('srb_7_sessions');
    expect(remote.resolveCannbay2Remote({ branch: 'dev' }).branch).toBe('dev');
  });
  it('body 目录替换 sessions 前缀', () => {
    expect(remote.resolveCannbay2Remote({ directory: 'trace/2026-08' }).rootDir).toBe('trace/2026-08');
  });
  it('凭据：pull 原样内嵌，push 拆为无凭据 URL + pushAuth（平台拒请求直带密码）', () => {
    const r = remote.resolveCannbay2Remote({ address: 'https://ai.gitcode.com/a/b', authMode: 'token', token: 'tk' });
    expect(r.pullUrl).toBe('https://oauth2:tk@gitcode.com/a/b');
    expect(r.pushUrl).toBe('https://gitcode.com/a/b');
    expect(r.pushUrl).not.toContain('@');
    expect(r.pushAuth).toEqual({ username: 'oauth2', password: 'tk' });
  });
  it('默认仓凭据链（：表单凭据 > cannbay-auth.json > 匿名；env 完整 URL 最高优先', async () => {
    // 历史"默认仓 push 一律内置共享令牌（CH.00905403 防劫持）"已随内置令牌
    // 出源退役：用户以自己身份推默认仓（需仓主加协作者），凭据链与自定义
    // 远端统一。env 的 pull 是本地路径（非 http 不嵌凭据）——验证 push 侧即可
    const saved = { ...process.env };
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cannbay2-auth-ut-'));
    try {
      // ⓪ 表单凭据 + http 远端：pullUrl 内嵌表单凭据 → pullAuth=null（不双重供给）
      const r0 = remote.resolveCannbay2Remote({ address: 'https://example.com/a/b.git', authMode: 'token', account: 'customer', token: 'their-token' });
      expect(r0.pullUrl).toContain('customer:their-token@');
      expect(r0.pullAuth).toBeNull();
      // ① 表单凭据（设置页即时测试形态）：直接生效为 push 身份
      const r1 = remote.resolveCannbay2Remote({ authMode: 'token', account: 'customer', token: 'their-token' });
      expect(r1.pushAuth).toEqual({ username: 'customer', password: 'their-token' });
      expect(r1.pushUrl).toBe('/tmp/unit-env-remote.git');
      expect(r1.pushUrl).not.toContain('@');
      // ② 无表单凭据 → cannbay-auth.json 兜底（CANNBOT_PROXY_DIR 重定向隔离）
      process.env.CANNBOT_PROXY_DIR = path.join(tmpHome, 'proxy');
      const { setStoredCredentials, clearStoredCredentials } = await import('../../src/lib/cannbay2/auth');
      setStoredCredentials('/tmp/unit-env-remote.git', 'stored-u', 'stored-t-123456');
      const r2 = remote.resolveCannbay2Remote();
      expect(r2.pushAuth).toEqual({ username: 'stored-u', password: 'stored-t-123456' });
      // pull 侧同样消费已存凭据（私有仓拉取闭环）
      expect(r2.pullAuth).toEqual({ username: 'stored-u', password: 'stored-t-123456' });
      // ③ env 分离对压过 auth 文件
      process.env.CANNBAY2_USERNAME = 'env-u';
      process.env.CANNBAY2_TOKEN = 'env-t';
      const r3 = remote.resolveCannbay2Remote();
      expect(r3.pushAuth).toEqual({ username: 'env-u', password: 'env-t' });
      // pull 侧同链消费 env 分离对（env 私有默认仓 clone/fetch 凭据闭环，
      // 不再 test 能过而 list/import 匿名 401）
      expect(r3.pullAuth).toEqual({ username: 'env-u', password: 'env-t' });
      // 自定义地址不吃 env 凭据（env 令牌不得外送到请求方任意地址）
      expect(remote.resolveCannbay2Remote({ address: 'https://example.com/z/z.git' }).pullAuth).toBeNull();
      delete process.env.CANNBAY2_USERNAME;
      delete process.env.CANNBAY2_TOKEN;
      // ④ env 完整 URL 覆写最高优先（push 目标 + 凭据一并来自 URL）
      process.env.CANNBAY2_PUSH_URL = 'https://eu:et@example.com/x/y.git';
      const r4 = remote.resolveCannbay2Remote();
      expect(r4.pushUrl).toBe('https://example.com/x/y.git');
      expect(r4.pushAuth).toEqual({ username: 'eu', password: 'et' });
      // ① 覆写凭据 pull 侧同链消费（与 lake/remote.ts resolveLakeRemote 对齐）
      expect(r4.pullAuth).toEqual({ username: 'eu', password: 'et' });
      // ⑤ 全空 → 匿名
      delete process.env.CANNBAY2_PUSH_URL;
      clearStoredCredentials(undefined);
      const r5 = remote.resolveCannbay2Remote();
      expect(r5.pushAuth).toBeNull();
      expect(r5.pullAuth).toBeNull();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
  it('cacheDir：一律按远端 URL+分支哈希隔离（默认远端也对齐——迁址后旧镜像不串仓），同输入稳定、异远端隔离', () => {
    const a1 = remote.resolveCannbay2Remote({ address: '/tmp/r1.git' }).cacheDir;
    const a2 = remote.resolveCannbay2Remote({ address: '/tmp/r1.git' }).cacheDir;
    const b = remote.resolveCannbay2Remote({ address: '/tmp/r2.git' }).cacheDir;
    const br = remote.resolveCannbay2Remote({ address: '/tmp/r1.git', branch: 'dev' }).cacheDir;
    const def = remote.resolveCannbay2Remote().cacheDir;
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1).not.toBe(br);
    // 默认远端同样落在哈希目录下（不再直用缓存根——根级旧镜像在默认仓迁址
    // 后 origin 仍指旧仓，fetch 照样成功导致静默读写错误仓库，2026-09-22 实测）
    expect(path.dirname(def)).toBe(path.dirname(a1));
    expect(def).not.toBe(a1);
  });
  it('CANNBAY2_CACHE_DIR 动态覆盖（哈希基目录随之切换）', () => {
    process.env.CANNBAY2_CACHE_DIR = '/tmp/unit-cache-override';
    try {
      const def = remote.resolveCannbay2Remote().cacheDir;
      expect(path.dirname(def)).toBe('/tmp/unit-cache-override');
      const custom = remote.resolveCannbay2Remote({ address: '/tmp/r1.git' }).cacheDir;
      expect(path.dirname(custom)).toBe('/tmp/unit-cache-override');
      expect(custom).not.toBe(def);
    } finally {
      delete process.env.CANNBAY2_CACHE_DIR;
    }
  });
});

describe('parseUrlCreds：内嵌凭据拆分（push 走 helper 通道的前提）', () => {
  it('https://user:pass@host → 无凭据 URL + auth 对', () => {
    const a = remote.parseUrlCreds('https://duanbingzhe:tok@example.com/cannbay-lake.git');
    expect(a.credless).toBe('https://example.com/cannbay-lake.git');
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
      const before = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('insight-cannbay2-auth-'));
      const r = remote.resolveCannbay2Remote({ address: bare, branch: 'main' });
      expect(r.pushAuth).toBeNull(); // 本地路径无凭据
      const withAuth: Cannbay2Remote = { ...r, pushAuth: { username: 'it-user', password: 'it-pass' } };
      mirrorMod.pushMirror(work, withAuth);
      expect(execSync('git rev-parse main', { cwd: bare, stdio: 'pipe' }).toString().trim())
        .toBe(execSync('git rev-parse HEAD', { cwd: work, stdio: 'pipe' }).toString().trim());
      const after = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('insight-cannbay2-auth-'));
      expect(after).toEqual(before); // helper 临时目录用后即删
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
      const before = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('insight-cannbay2-auth-'));
      const r = remote.resolveCannbay2Remote({ address: bare, branch: 'main' });
      const withPullAuth: Cannbay2Remote = { ...r, cacheDir: cache, pullAuth: { username: 'pull-u', password: 'pull-p' } };
      const dir = mirrorMod.ensureMirror(withPullAuth);
      // 镜像就绪：origin/main 可解析（clone/fetch 走通——本地传输不咨询凭据，
      // helper 的价值在 https 挑战-应答，此处锁命令构造与临时目录生命周期）
      expect(execSync('git rev-parse --verify -q refs/remotes/origin/main', { cwd: dir, stdio: 'pipe' }).toString().trim())
        .toBe(execSync('git rev-parse main', { cwd: bare, stdio: 'pipe' }).toString().trim());
      const after = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('insight-cannbay2-auth-'));
      expect(after).toEqual(before); // helper 临时目录用后即删
      // 二次 ensure 走 fetch 路径同样带 helper 生命周期（无残留即证）
      mirrorMod.ensureMirror(withPullAuth);
      expect(fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('insight-cannbay2-auth-'))).toEqual(before);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  it('pushAuth 含换行：helper 协议非法，立即拒绝且不落临时目录', () => {
    const r = remote.resolveCannbay2Remote({ address: '/tmp/x.git', branch: 'main' });
    const bad: Cannbay2Remote = { ...r, pushAuth: { username: 'u', password: 'p\nq' } };
    const before = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('insight-cannbay2-auth-'));
    expect(() => mirrorMod.pushMirror('/tmp', bad)).toThrow('newline');
    expect(fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('insight-cannbay2-auth-'))).toEqual(before);
  });
});

describe('cannbay-config：迁移与请求体裁剪', () => {
  it('legacy {address,account,password} → 地址保留 + authMode password', () => {
    const m = migrateCannbayConfig({ address: 'https://example.com/a/b', account: 'u', password: 'p' });
    expect(m).toMatchObject({ address: 'https://example.com/a/b', authMode: 'password', account: 'u', password: 'p', token: '', branch: 'main', directory: '' });
  });
  it('旧版预设形状归一：default/trace_corpus/空 → 默认地址', () => {
    expect(migrateCannbayConfig({ addressPreset: 'default', address: '', authMode: 'token', token: 't' })!.address).toBe(DEFAULT_CANNBAY_ADDRESS);
    expect(migrateCannbayConfig({ addressPreset: 'trace_corpus', address: '', authMode: 'token', token: 't' })!.address)
      .toBe(DEFAULT_CANNBAY_ADDRESS);
    expect(migrateCannbayConfig({})!.address).toBe(DEFAULT_CANNBAY_ADDRESS);
  });
  it('新形状透传；垃圾 → null', () => {
    expect(migrateCannbayConfig({ address: 'https://example.com/a/b', authMode: 'token', token: 't' }))
      .toMatchObject({ address: 'https://example.com/a/b', authMode: 'token', token: 't' });
    expect(migrateCannbayConfig(null)).toBeNull();
    expect(migrateCannbayConfig('x')).toBeNull();
  });
  it('cannbayRemoteInput：默认地址 + 全空 → 空 body（未配置用户请求体不变）', () => {
    expect(cannbayRemoteInput(null)).toEqual({});
    expect(cannbayRemoteInput({ address: '', authMode: 'none', account: '', password: '', token: '', branch: '', directory: '' })).toEqual({});
    expect(cannbayRemoteInput({ address: DEFAULT_CANNBAY_ADDRESS, authMode: 'none', account: '', password: '', token: '', branch: '', directory: '' })).toEqual({});
  });
  it('cannbayRemoteInput：凭据默认剥离（服务端凭据源），includeCreds 才随请求（测试连接验证的是输入值）', () => {
    const cfg = { address: DEFAULT_CANNBAY_ADDRESS, authMode: 'token' as const, account: '', password: '', token: 'tk', branch: 'main', directory: '' };
    // 默认（列表/导入/上传）：不带凭据——凭据由服务端 cannbay-auth.json 按地址解析；
    // 默认地址+默认分支+无目录无可传信息 → 整个省略 config
    const plain = cannbayRemoteInput(cfg);
    expect(plain).toEqual({});
    // includeCreds（设置页测试连接）：带上表单凭据、仍不带地址
    const withCreds = cannbayRemoteInput(cfg, { includeCreds: true });
    expect(withCreds.config).toMatchObject({ authMode: 'token', token: 'tk' });
    expect((withCreds.config as Record<string, unknown>).address).toBeUndefined();
    expect((withCreds.config as Record<string, unknown>).branch).toBeUndefined();
  });
  it('cannbayRemoteInput：分支默认 main 不外发，非 main 才带', () => {
    expect((cannbayRemoteInput({ address: 'https://x.git', authMode: 'none', account: '', password: '', token: '', branch: 'main', directory: '' }).config as Record<string, unknown>).branch).toBeUndefined();
    expect(cannbayRemoteInput({ address: 'https://x.git', authMode: 'none', account: '', password: '', token: '', branch: 'srb_7_sessions', directory: '' }).config).toMatchObject({ branch: 'srb_7_sessions' });
  });
  it('cannbayRemoteInput：按认证方式裁剪字段（隐藏输入框的历史值不得泄进请求）', () => {
    const tokenBody = cannbayRemoteInput({ address: 'https://x.git', authMode: 'token', account: 'stale-user', password: 'stale-pass', token: 'tk', branch: '', directory: '' }).config as Record<string, unknown>;
    expect(tokenBody).not.toHaveProperty('account');
    expect(tokenBody).not.toHaveProperty('password');
    const passBody = cannbayRemoteInput({ address: 'https://x.git', authMode: 'password', account: 'u', password: 'p', token: 'stale-token', branch: '', directory: '' }).config as Record<string, unknown>;
    expect(passBody).not.toHaveProperty('token');
  });
  it('cannbayRemoteInput：自定义远端 → {config} 含地址；凭据默认剥离 / includeCreds 带上', () => {
    const cfg = { address: 'https://example.com/trace_corpus', authMode: 'token' as const, account: '', password: '', token: 'tk', branch: 'srb_7_sessions', directory: 'trace/2026-08' };
    expect(cannbayRemoteInput(cfg).config).toMatchObject({ address: 'https://example.com/trace_corpus', authMode: 'none', branch: 'srb_7_sessions', directory: 'trace/2026-08' });
    expect(cannbayRemoteInput(cfg, { includeCreds: true }).config).toMatchObject({ address: 'https://example.com/trace_corpus', authMode: 'token', token: 'tk', branch: 'srb_7_sessions', directory: 'trace/2026-08' });
  });
});

describe('testCannbay2Remote：选了认证方式但没填凭据 → 直接失败', () => {
  it('令牌模式缺令牌', async () => {
    const r = await remote.testCannbay2Remote({ authMode: 'token', token: '' });
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/未填写令牌/);
  });
  it('账密模式缺账户或密码', async () => {
    expect((await remote.testCannbay2Remote({ authMode: 'password', account: 'u' })).message).toMatch(/未填写完整/);
    expect((await remote.testCannbay2Remote({ authMode: 'password', password: 'p' })).message).toMatch(/未填写完整/);
  });
});

describe('listRemoteDirs 入口校验：prefix 拼命令前先过白名单（lib 层防线）', () => {
  it('非法前缀直接抛、不触达 git', () => {
    for (const bad of ['a b', 'a;rm', '$(x)', 'a\\b', '../x']) {
      expect(() => mirrorMod.listRemoteDirs(remote.defaultCannbay2Remote(), bad)).toThrow(/无效目录/);
    }
  });
});

describe('gitcodeTokenOwner：api/v5/user 反查令牌属主', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('200 → login（fallback username）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ login: 'wang-zhiyue2' }), { status: 200 })));
    expect(await remote.gitcodeTokenOwner('https://oauth2:t@gitcode.com/a/b', 't')).toBe('wang-zhiyue2');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ username: 'fallback-user' }), { status: 200 })));
    expect(await remote.gitcodeTokenOwner('https://oauth2:t@gitcode.com/a/b', 't')).toBe('fallback-user');
  });
  it('401 / 异常 / 非 gitcode / 空密钥 → null（不放大失败）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error_code":401}', { status: 401 })));
    expect(await remote.gitcodeTokenOwner('https://oauth2:t@gitcode.com/a/b', 't')).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('net'); }));
    expect(await remote.gitcodeTokenOwner('https://oauth2:t@gitcode.com/a/b', 't')).toBeNull();
    expect(await remote.gitcodeTokenOwner('/tmp/local.git', 't')).toBeNull();
    expect(await remote.gitcodeTokenOwner('https://example.com/a/b', '')).toBeNull();
  });
});

describe('redactRemoteSecrets：错误消息出边界前脱敏', () => {
  it('带凭据 URL → 无凭据地址；裸凭据 → ***', () => {
    const r = remote.resolveCannbay2Remote({ address: 'https://example.com/a/b', authMode: 'token', token: 'secret-token-123456' });
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
    const src = read('../../src/lib/cannbay2/remote.ts');
    const testBody = src.slice(src.indexOf('export async function testCannbay2Remote'), src.indexOf('export function listRemoteBranches'));
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
    const authSrc = read('../../src/lib/cannbay2/auth.ts');
    expect(authSrc).not.toContain('cpx auth');
    expect(authSrc).toContain('cbi auth');
    expect(read('../../src/lib/cannbay2/remote.ts')).not.toContain('cpx auth');
  });
});
