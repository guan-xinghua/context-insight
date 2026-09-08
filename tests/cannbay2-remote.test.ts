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
import path from 'node:path';

process.env.CANNBAY2_REMOTE_URL = '/tmp/unit-env-remote.git';
process.env.CANNBAY2_BRANCH = 'envbr';
delete process.env.CANNBAY2_CACHE_DIR;
delete process.env.CANNBAY2_PUSH_URL;

const remote = await import('../src/lib/cannbay2/remote');
const mirrorMod = await import('../src/lib/cannbay2/mirror');
const { migrateCannbayConfig, cannbayRemoteInput, DEFAULT_CANNBAY_ADDRESS } = await import('../src/lib/cannbay-config');

describe('normalizeGitAddress：ai.gitcode.com 归一化 + 安全面', () => {
  it('ai.gitcode.com → gitcode.com（git http 实际服务主机）', () => {
    expect(remote.normalizeGitAddress('https://ai.gitcode.com/cann_corpus/trace_corpus'))
      .toBe('https://gitcode.com/cann_corpus/trace_corpus');
  });
  it('普通 gitcode 地址与尾斜杠', () => {
    expect(remote.normalizeGitAddress('https://gitcode.com/a/b.git/')).toBe('https://gitcode.com/a/b.git');
  });
  it('其他主机不改写', () => {
    expect(remote.normalizeGitAddress('https://atomgit.com/guanxinghua/cannbay2.git'))
      .toBe('https://atomgit.com/guanxinghua/cannbay2.git');
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
    expect(remote.embedCredentials('https://gitcode.com/a/b', { authMode: 'token', token: 'tok' }))
      .toBe('https://oauth2:tok@gitcode.com/a/b');
  });
  it('令牌模式：有账户 → account:token', () => {
    expect(remote.embedCredentials('https://gitcode.com/a/b', { authMode: 'token', account: 'wang', token: 'tok' }))
      .toBe('https://wang:tok@gitcode.com/a/b');
  });
  it('特殊字符编码（@ : 不破坏 URL 解析）', () => {
    expect(remote.embedCredentials('https://gitcode.com/a/b', { authMode: 'token', token: 'a@b:c' }))
      .toBe('https://oauth2:a%40b%3Ac@gitcode.com/a/b');
  });
  it('账密模式：缺一即 no-op', () => {
    expect(remote.embedCredentials('https://gitcode.com/a/b', { authMode: 'password', account: 'u' }))
      .toBe('https://gitcode.com/a/b');
    expect(remote.embedCredentials('https://gitcode.com/a/b', { authMode: 'password', password: 'p' }))
      .toBe('https://gitcode.com/a/b');
  });
  it('账密模式：完整则内嵌', () => {
    expect(remote.embedCredentials('https://gitcode.com/a/b', { authMode: 'password', account: 'u', password: 'p' }))
      .toBe('https://u:p@gitcode.com/a/b');
  });
  it('替换既有 userinfo（默认远端 + 自有凭据场景）', () => {
    expect(remote.embedCredentials('https://old:x@atomgit.com/r', { authMode: 'token', token: 't' }))
      .toBe('https://oauth2:t@atomgit.com/r');
  });
  it('本地路径远端不内嵌（测试环境安全）', () => {
    expect(remote.embedCredentials('/tmp/x.git', { authMode: 'token', token: 'tok' })).toBe('/tmp/x.git');
  });
  it('authMode none → no-op', () => {
    expect(remote.embedCredentials('https://gitcode.com/a/b', { authMode: 'none' })).toBe('https://gitcode.com/a/b');
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
  it('中文目录段接受（trace_corpus 布局 <范式>/<月份>，如 01_longtail_op_gen/7月）', () => {
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
    const r = remote.resolveCannbay2Remote({ address: 'https://ai.gitcode.com/cann_corpus/trace_corpus' });
    expect(r.pullUrl).toBe('https://gitcode.com/cann_corpus/trace_corpus');
    expect(r.pushUrl).toBe('https://gitcode.com/cann_corpus/trace_corpus');
    expect(r.branch).toBe('main');
  });
  it('body branch 覆盖（带地址与不带地址两种）', () => {
    expect(remote.resolveCannbay2Remote({ address: 'https://gitcode.com/a/b', branch: 'srb_7_sessions' }).branch).toBe('srb_7_sessions');
    expect(remote.resolveCannbay2Remote({ branch: 'dev' }).branch).toBe('dev');
  });
  it('body 目录替换 sessions 前缀', () => {
    expect(remote.resolveCannbay2Remote({ directory: 'trace/2026-08' }).rootDir).toBe('trace/2026-08');
  });
  it('凭据同时进 pull/push URL', () => {
    const r = remote.resolveCannbay2Remote({ address: 'https://ai.gitcode.com/a/b', authMode: 'token', token: 'tk' });
    expect(r.pullUrl).toBe('https://oauth2:tk@gitcode.com/a/b');
    expect(r.pushUrl).toBe(r.pullUrl);
  });
  it('默认仓 push 不被用户凭据劫持（CH.00905403 修复）：未配自定义地址时 push 用内置共享令牌，pull 仍可带用户凭据', () => {
    // 场景：客户在设置页配了自己的数据之湖令牌、地址留默认 → 此前
    // embedCredentials 会剥掉内置凭据换成客户身份 push 共享仓 → atomgit
    // 报"not allowed to push code to this project"（身份合法、无写权限）
    const r = remote.resolveCannbay2Remote({ authMode: 'token', account: 'customer', token: 'their-token' });
    expect(r.pushUrl).toBe(remote.CANNBAY2_PUSH_URL); // 内置共享令牌原样保留
    expect(r.pushUrl).not.toContain('their-token');
    // pull 保持既有语义：http 地址带用户凭据（embedCredentials 单测已覆盖），
    // 本测试 env 的 pull 是本地路径（非 http 不嵌凭据），验证不被改写即可
    expect(r.pullUrl).toBe('/tmp/unit-env-remote.git');
  });
  it('cacheDir：自定义远端走哈希目录，同输入稳定、异远端隔离', () => {
    const a1 = remote.resolveCannbay2Remote({ address: '/tmp/r1.git' }).cacheDir;
    const a2 = remote.resolveCannbay2Remote({ address: '/tmp/r1.git' }).cacheDir;
    const b = remote.resolveCannbay2Remote({ address: '/tmp/r2.git' }).cacheDir;
    const br = remote.resolveCannbay2Remote({ address: '/tmp/r1.git', branch: 'dev' }).cacheDir;
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1).not.toBe(br);
  });
  it('CANNBAY2_CACHE_DIR 动态覆盖（与原 cannbay2CacheDir 行为一致）', () => {
    process.env.CANNBAY2_CACHE_DIR = '/tmp/unit-cache-override';
    try {
      expect(remote.resolveCannbay2Remote().cacheDir).toBe('/tmp/unit-cache-override');
      expect(remote.resolveCannbay2Remote({ address: '/tmp/r1.git' }).cacheDir)
        .toBe(path.join('/tmp/unit-cache-override', path.basename(remote.resolveCannbay2Remote({ address: '/tmp/r1.git' }).cacheDir)));
    } finally {
      delete process.env.CANNBAY2_CACHE_DIR;
    }
  });
});

describe('cannbay-config：迁移与请求体裁剪', () => {
  it('legacy {address,account,password} → 地址保留 + authMode password', () => {
    const m = migrateCannbayConfig({ address: 'https://gitcode.com/a/b', account: 'u', password: 'p' });
    expect(m).toMatchObject({ address: 'https://gitcode.com/a/b', authMode: 'password', account: 'u', password: 'p', token: '', branch: 'main', directory: '' });
  });
  it('旧版预设形状归一：default → 默认地址；trace_corpus → 语料仓地址；空 → 默认地址', () => {
    expect(migrateCannbayConfig({ addressPreset: 'default', address: '', authMode: 'token', token: 't' })!.address).toBe(DEFAULT_CANNBAY_ADDRESS);
    expect(migrateCannbayConfig({ addressPreset: 'trace_corpus', address: '', authMode: 'token', token: 't' })!.address)
      .toBe('https://ai.gitcode.com/cann_corpus/trace_corpus');
    expect(migrateCannbayConfig({})!.address).toBe(DEFAULT_CANNBAY_ADDRESS);
  });
  it('新形状透传；垃圾 → null', () => {
    expect(migrateCannbayConfig({ address: 'https://gitcode.com/a/b', authMode: 'token', token: 't' }))
      .toMatchObject({ address: 'https://gitcode.com/a/b', authMode: 'token', token: 't' });
    expect(migrateCannbayConfig(null)).toBeNull();
    expect(migrateCannbayConfig('x')).toBeNull();
  });
  it('cannbayRemoteInput：默认地址 + 全空 → 空 body（未配置用户请求体不变）', () => {
    expect(cannbayRemoteInput(null)).toEqual({});
    expect(cannbayRemoteInput({ address: '', authMode: 'none', account: '', password: '', token: '', branch: '', directory: '' })).toEqual({});
    expect(cannbayRemoteInput({ address: DEFAULT_CANNBAY_ADDRESS, authMode: 'none', account: '', password: '', token: '', branch: '', directory: '' })).toEqual({});
  });
  it('cannbayRemoteInput：默认地址 + 凭据 → 带上但不带地址（测试连接须能验证令牌，env 语义保留）', () => {
    const body = cannbayRemoteInput({ address: DEFAULT_CANNBAY_ADDRESS, authMode: 'token', account: '', password: '', token: 'tk', branch: 'main', directory: '' });
    expect(body.config).toMatchObject({ authMode: 'token', token: 'tk' });
    expect((body.config as Record<string, unknown>).address).toBeUndefined();
    expect((body.config as Record<string, unknown>).branch).toBeUndefined();
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
  it('cannbayRemoteInput：自定义远端 → {config} 含地址', () => {
    const body = cannbayRemoteInput({ address: 'https://ai.gitcode.com/cann_corpus/trace_corpus', authMode: 'token', account: '', password: '', token: 'tk', branch: 'srb_7_sessions', directory: 'trace/2026-08' });
    expect(body.config).toMatchObject({ address: 'https://ai.gitcode.com/cann_corpus/trace_corpus', authMode: 'token', token: 'tk', branch: 'srb_7_sessions', directory: 'trace/2026-08' });
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
    expect(await remote.gitcodeTokenOwner('https://gitcode.com/a/b', '')).toBeNull();
  });
});

describe('redactRemoteSecrets：错误消息出边界前脱敏', () => {
  it('带凭据 URL → 无凭据地址；裸凭据 → ***', () => {
    const r = remote.resolveCannbay2Remote({ address: 'https://gitcode.com/a/b', authMode: 'token', token: 'secret-token-123456' });
    const msg = remote.redactRemoteSecrets(
      `Command failed: git push "https://oauth2:secret-token-123456@gitcode.com/a/b" main\nfatal: Authentication failed for secret-token-123456`,
      r,
      [undefined, undefined, 'secret-token-123456'],
    );
    expect(msg).not.toContain('secret-token-123456');
    expect(msg).not.toContain('oauth2:');
    expect(msg).toContain('https://gitcode.com/a/b');
    expect(msg).toContain('***');
  });
});
