// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and
// conditions of the CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 推送凭据管理 IT（insight 侧）：
//   ① 设置页凭据 API（/api/settings/lake-auth）：PUT 保存（本地 bare 探测
//      通过 → verifiedAt 落档）/ GET 脱敏清单 / DELETE 清除；响应任何分支
//      不回传令牌明文；lake-auth.json 0600
//   ② 上传前置检查：https 远端无凭据 → 路由 400 + code=no-credentials
//      （结构化错误码，前端据此给「前往设置页」引导）；本地 bare 不受影响
//   ③ 错误分类 classifyLakeError 六分类（与 cpx 同链）
//   ④ PUT 探测零 shell（spawnSync 数组参）+ 元字符前置校验（CWE-78：请求体
//      URL 绝不进 shell——旧 execSync 模板串拼接会被 $()/; 注入）
// 隔离：CONTEXT_PROXY_DIR 重定向到临时目录；本地 bare 仓做探测目标（零网络）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { switchLakeConfig } from '../helpers/lake-env';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lake-auth-route-it-'));
const BARE = path.join(TMP, 'remote.git');

execSync(`git init --bare -b main "${BARE}"`, { stdio: 'pipe' });

const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of ['CONTEXT_PROXY_DIR', 'LAKE_PUSH_URL', 'LAKE_USERNAME', 'LAKE_TOKEN']) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.CONTEXT_PROXY_DIR = path.join(TMP, 'proxy');
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

const authRoute = await import('../../src/app/api/settings/lake-auth/route');
const lakeRoute = await import('../../src/app/api/ingest/lake/route');
const { classifyLakeError, MissingPushCredentialsError, authFilePath, getStoredCredentials, listStoredRemotes } = await import('../../src/lib/lake/auth');

function putRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/settings/lake-auth', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function delRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/settings/lake-auth', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('① 设置页凭据 API（服务端存储）', () => {
  it('PUT 保存（本地 bare 探测通过）→ GET 脱敏清单 → DELETE 清除；全程不回传明文', async () => {
    const res = await authRoute.PUT(putRequest({ url: BARE, username: 'zhangsan', token: 'it-secret-tok-445566' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, username: 'zhangsan', reachable: true });
    expect(body.tokenMasked).toBe('it-…5566');
    expect(typeof body.verifiedAt).toBe('string');
    expect(JSON.stringify(body)).not.toContain('it-secret-tok-445566');
    // 文件面：0600 + 键归一（本地路径原样）
    expect(fs.statSync(authFilePath()).mode & 0o777).toBe(0o600);
    expect(getStoredCredentials(BARE)).toEqual({ username: 'zhangsan', password: 'it-secret-tok-445566' });

    const list = await authRoute.GET();
    const listBody = await list.json();
    const hit = listBody.remotes.find((r: { url: string }) => r.url === BARE);
    expect(hit).toMatchObject({ username: 'zhangsan', tokenMasked: 'it-…5566' });
    expect(JSON.stringify(listBody)).not.toContain('it-secret-tok-445566');

    const del = await authRoute.DELETE(delRequest({ url: BARE }));
    expect((await del.json()).had).toBe(true);
    expect(getStoredCredentials(BARE)).toBeNull();
  });

  it('PUT 校验：缺地址/缺凭据 → 400；探测失败（不存在的路径）仍保存但不落 verifiedAt', async () => {
    expect((await authRoute.PUT(putRequest({ username: 'u', token: 't' }))).status).toBe(400);
    expect((await authRoute.PUT(putRequest({ url: BARE, username: '', token: 't' }))).status).toBe(400);
    const badPath = path.join(TMP, 'no-such-remote.git');
    const res = await authRoute.PUT(putRequest({ url: badPath, username: 'u2', token: 't2-987654321' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reachable).toBe(false);
    expect(body.verifiedAt).toBeNull();
    expect(getStoredCredentials(badPath)).toEqual({ username: 'u2', password: 't2-987654321' });
  });
});

describe('② 上传前置检查（路由级结构化错误码）', () => {
  it('https 远端无凭据 → 400 + code=no-credentials（DB/git 零触达前 fail-fast；body config 单源忽略）', async () => {
    // https 远端经服务端配置注入；body config 地址被忽略（携带 BARE 也不生效）
    switchLakeConfig({ address: 'https://example.com/someone/private-repo.git' });
    const res = await lakeRoute.POST(new NextRequest('http://localhost/api/ingest/lake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'upload',
        taskId: 'ses-no-creds-it',
        description: '提交人: 张三',
        config: { address: BARE },
      }),
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('no-credentials');
    expect(body.error).toContain('设置');
    expect(body.error).toContain('推送凭据');
  });
});

describe('③ classifyLakeError 六分类（与 cpx 同链）', () => {
  it('无凭据 > LFS 未启用 > 配额 > 无权限 > 鉴权失败 > 未知', () => {
    expect(classifyLakeError(new MissingPushCredentialsError('https://x'))).toBe('no-credentials');
    expect(classifyLakeError(new Error('batch response: 413 Request Entity Too Large'))).toBe('quota');
    expect(classifyLakeError(new Error('remote: CH.00905403 not allowed to push'))).toBe('forbidden');
    expect(classifyLakeError(new Error("fatal: Authentication failed for 'https://example.com/x'"))).toBe('auth-failed');
    expect(classifyLakeError(new Error('unrelated'))).toBe('unknown');
  });
  it('平台码分诊（真机实测文本）：00905401=凭据无效→auth-failed；00905403=无写权限→forbidden', () => {
    expect(classifyLakeError(Object.assign(new Error('git push'), { stderr: Buffer.from('remote: <CH.00905401> HTTP Basic: Access denied.\nfatal: Authentication failed for \'https://example.com/lake.git/\'') }))).toBe('auth-failed');
    expect(classifyLakeError(Object.assign(new Error('git push'), { stderr: Buffer.from('remote: <CH.00905403> not allowed to push code to this project') }))).toBe('forbidden');
  });
  it('LFS 未启用分诊在 forbidden 之前（真机事故回归锁：GitCode batch 拒绝文本含 "forbidden" 字样，令牌确有权限却被误报「令牌无推送权限」）', () => {
    // 用户真机报错原文（gitcode.com TTELab/Bundle-lake）：git-lfs batch API 的
    // 项目级 LFS 未启用拒绝——与令牌无关，换凭据解决不了
    const stderr = Buffer.from(
      'Locking support detected on remote "origin". Consider enabling it with: $ git config lfs.https://gitcode.com/TTELab/Bundle-lake.git/info/lfs.locksverify true\n' +
      'batch response: {"message": "Access forbidden. project lfs not enabled.", "documentation_url": ""}\n' +
      'error: failed to push some refs to \'https://gitcode.com/TTELab/Bundle-lake.git\'',
    );
    expect(classifyLakeError(Object.assign(new Error('Command failed: git push'), { stderr }))).toBe('lfs-not-enabled');
    // 平台变体与白话文案锚点
    expect(classifyLakeError(new Error('LFS is not enabled for this project'))).toBe('lfs-not-enabled');
    expect(classifyLakeError(new Error('batch response: LFS is disabled'))).toBe('lfs-not-enabled');
    // 反例：自举钩子的本机安装提示不是平台设置问题（不落 lfs-not-enabled）
    expect(classifyLakeError(new Error('git-lfs not installed'))).toBe('unknown');
  });
});

describe('④ PUT 探测零 shell + 元字符前置校验（CWE-78：请求体 URL 绝不进 shell）', () => {
  it('源级：探测走 spawnSync 数组参（不经 shell），无 execSync 调用形态', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/app/api/settings/lake-auth/route.ts'), 'utf8');
    expect(src).toContain("spawnSync('git', ['ls-remote'");
    expect(src).not.toMatch(/\bexecSync\s*\(/);
  });

  it('命令替换/反引号/分号地址 → 400 前置拒绝；不执行（marker 不落盘）、不落库', async () => {
    const marker = path.join(TMP, 'pwned-marker');
    const evilUrls = [
      `https://x.com/$(touch ${marker})`,
      'https://x.com/`touch ' + marker + '`',
      `https://x.com/a; touch ${marker}`,
      `https://evil.com/x|touch ${marker}`,
    ];
    for (const evil of evilUrls) {
      const res = await authRoute.PUT(putRequest({ url: evil, username: 'u3', token: 't3-111222333444' }));
      expect(res.status, `应 400 拒绝: ${evil}`).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('非法字符');
    }
    expect(fs.existsSync(marker)).toBe(false);
    expect(getStoredCredentials(evilUrls[0])).toBeNull();
  });

  it('非黑名单字符（括号）不受误伤：本地括号路径 bare 仓探测可达（spawnSync 数组参原样传递）', async () => {
    const parenBare = path.join(TMP, '(paren)-remote.git');
    execSync(`git init --bare -b main "${parenBare}"`, { stdio: 'pipe' });
    const res = await authRoute.PUT(putRequest({ url: parenBare, username: 'u4', token: 't4-444555666777' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reachable).toBe(true);
    expect(typeof body.verifiedAt).toBe('string');
    expect(getStoredCredentials(parenBare)).toEqual({ username: 'u4', password: 't4-444555666777' });
  });
});

describe('⑤ 旧名凭据文件读兜底（cannbay-auth.json → lake-auth.json 存量无感迁移）', () => {
  it('新名缺失读旧名兜底；新名存在即权威（清空不复活旧凭据）', () => {
    const dir = path.dirname(authFilePath());
    const legacy = path.join(dir, 'cannbay-auth.json');
    const current = authFilePath();
    // 清场：从「两文件均无」起步，避免前序用例残留
    fs.rmSync(current, { force: true });
    fs.rmSync(legacy, { force: true });

    // 旧名文件存在、新名缺失 → 读旧名兜底（存量凭据不丢）
    fs.writeFileSync(legacy, JSON.stringify({
      remotes: { 'https://legacy.example.com/repo.git': { username: 'old-user', token: 'old-token-112233' } },
    }, null, 2));
    expect(getStoredCredentials('https://legacy.example.com/repo.git')).toEqual({ username: 'old-user', password: 'old-token-112233' });
    expect(listStoredRemotes().some((r) => r.url === 'https://legacy.example.com/repo.git')).toBe(true);

    // 新名文件存在（即使空 remotes）即权威 → 不再读旧名（用户清空不复活旧凭据）
    fs.writeFileSync(current, JSON.stringify({ remotes: {} }, null, 2));
    expect(getStoredCredentials('https://legacy.example.com/repo.git')).toBeNull();

    fs.rmSync(current, { force: true });
    fs.rmSync(legacy, { force: true });
  });
});
