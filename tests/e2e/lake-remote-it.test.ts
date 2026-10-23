// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// lake remote IT：可配置远端全链路——自定义目录（上传→列表→导入回环）、
// 自定义分支、per-remote 缓存隔离、路由级 body-over-env、400 校验、
// 凭据脱敏（失败消息不带 token / 带凭据 URL）。env 必须在模块加载前设置。
import { describe, it, expect, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { importSession } from '../../src/lib/ingest/data-service.ts';
import { seedLakeConfig, switchLakeConfig } from '../helpers/lake-env';

function git(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: 'pipe', timeout: 60_000 }).toString();
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lake-remote-it-'));
const BARE_A = path.join(TMP, 'remote-a.git');
const BARE_B = path.join(TMP, 'remote-b.git');
const CACHE = path.join(TMP, 'cache');
const FIXTURES = path.join(TMP, 'fixtures');

function seedBare(bare: string, extraBranch?: string): void {
  execSync(`git init --bare -b main "${bare}"`, { stdio: 'pipe' });
  git('git config uploadpack.allowFilter true', bare);
  git('git config uploadpack.allowAnySHA1InWant true', bare);
  const seed = path.join(TMP, `seed-${path.basename(bare, '.git')}`);
  execSync(`git clone --quiet "${bare}" "${seed}"`, { stdio: 'pipe' });
  fs.writeFileSync(path.join(seed, 'README.md'), '# remote it\n');
  // git 不跟踪空目录：sessions/ 加占位，让根目录浏览（按文件推导）可见
  fs.mkdirSync(path.join(seed, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'sessions', '.gitkeep'), '');
  fs.mkdirSync(path.join(seed, 'others'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'others', '.gitkeep'), '');
  fs.writeFileSync(path.join(seed, '.gitattributes'), '*.jsonl filter=lfs diff=lfs merge=lfs -text\n');
  git('git add .', seed);
  git('git -c user.name=seed -c user.email=seed@t commit -q -m init', seed);
  git('git push -q origin main', seed);
  if (extraBranch) {
    git(`git checkout -q -b ${extraBranch}`, seed);
    fs.writeFileSync(path.join(seed, 'branch-marker'), extraBranch);
    git('git add .', seed);
    git(`git -c user.name=seed -c user.email=seed@t commit -q -m "seed ${extraBranch}"`, seed);
    git(`git push -q origin ${extraBranch}`, seed);
  }
}

seedBare(BARE_A);
seedBare(BARE_B, 'srb_7_sessions');
// 带斜杠分支：选择器白名单应过滤（分支不支持 /，见 remote.ts validateBranch）
{
  const seed = path.join(TMP, 'seed-remote-b');
  git('git checkout -q -b feat/x', seed);
  fs.writeFileSync(path.join(seed, 'slash-branch-marker'), 'x');
  git('git add .', seed);
  git('git -c user.name=seed -c user.email=seed@t commit -q -m "seed feat/x"', seed);
  git('git push -q origin feat/x', seed);
}
// 中文月份目录（客户现场 语料仓布局：<范式>/<月份>/<提交人>/，
// 01_longtail_op_gen/7月）—— 目录白名单放行非 ASCII 段的回归锚点
{
  const seed = path.join(TMP, 'seed-remote-a');
  fs.mkdirSync(path.join(seed, '01_longtail_op_gen', '7月', 'sessions-07-fj'), { recursive: true });
  fs.writeFileSync(path.join(seed, '01_longtail_op_gen', '7月', 'sessions-07-fj', '.gitkeep'), '');
  git('git add .', seed);
  git('git -c user.name=seed -c user.email=seed@t commit -q -m "seed 中文月份目录"', seed);
  git('git push -q origin main', seed);
}

process.env.LAKE_LFS = '0';
process.env.LAKE_CACHE_DIR = CACHE;
seedLakeConfig(TMP, { address: BARE_A });

const SID_DEF = 'cc-remote-it-def';
const SID_DIR = 'cc-remote-it-dir';
const SID_BR = 'cc-remote-it-br';
const SID_CN = 'cc-remote-it-cn';
const fixtureLines = [
  // 捕获形态（同 sid 双记录 IT 后）：上传走裸 <sid>/ 主位（原生 claude 行会上传到 <sid>.native/）
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'remote 可配置远端 IT' }, timestamp: '2026-08-24T03:00:00.000Z', source: 'claude-proxy', x_lake: { schema: 'it-wire-evidence', version: 1, data: {} } }),
  JSON.stringify({ type: 'assistant', message: { id: 'msg_rit_1', role: 'assistant', content: [{ type: 'text', text: 'ok' }], model: 'test-model', usage: { input_tokens: 10, output_tokens: 2 } }, timestamp: '2026-08-24T03:00:05.000Z' }),
].join('\n') + '\n';

const prisma = new PrismaClient();

const lake = await import('../../src/lib/lake');
const remote = await import('../../src/lib/lake/remote');
const route = await import('../../src/app/api/ingest/lake/route');

const cfgDir = remote.resolveAdhocRemote({ address: BARE_A, directory: 'trace/2026-08' });
const cfgBranch = remote.resolveAdhocRemote({ address: BARE_B, branch: 'srb_7_sessions' });
const cfgCn = remote.resolveAdhocRemote({ address: BARE_A, directory: '01_longtail_op_gen/7月' });

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/ingest/lake', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function importFixture(sid: string): Promise<void> {
  const file = path.join(FIXTURES, `${sid}.jsonl`);
  fs.mkdirSync(FIXTURES, { recursive: true });
  fs.writeFileSync(file, fixtureLines);
  await importSession(file, sid, prisma, file, 'claude-jsonl');
}

afterAll(async () => {
  for (const sid of [SID_DEF, SID_DIR, SID_BR, SID_CN]) {
    try { await prisma.session.deleteMany({ where: { taskId: sid } }); } catch { /* ignore */ }
  }
  await prisma.$disconnect();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('单源路由：无 config 请求 = 服务端配置远端', () => {
  it('无 config 上传落根级，无 config 列表可见', async () => {
    await importFixture(SID_DEF);
    const up = await lake.uploadLakeSession(prisma, SID_DEF, '提交人: 测试者\n内容描述: 默认远端', undefined, 'others');
    expect(up.unchanged).toBe(false);
    const res = await route.POST(makeRequest({ action: 'list' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.sessions.some((s: { sid: string }) => s.sid === SID_DEF)).toBe(true);
  });
});

describe('自定义目录：上传 → 列表 → 导入回环（导入+上传同目录生效）', () => {
  it('上传落 trace/2026-08/<sid>/，多根列表全可见', async () => {
    await importFixture(SID_DIR);
    const up = await lake.uploadLakeSession(prisma, SID_DIR, '提交人: 测试者\n内容描述: 目录上传', cfgDir);
    expect(up.folder).toBe(`trace/2026-08/${SID_DIR}/`);
    // push 到 URL 不更新镜像的远端跟踪引用 —— 断言直接查 bare 仓（事实源）
    const tree = git(`git ls-tree -r --name-only main -- trace/2026-08/${SID_DIR}/`, BARE_A);
    expect(tree).toContain(`${SID_DIR}.jsonl`);
    expect(git('git ls-tree -r --name-only main -- sessions/', BARE_A)).not.toContain(SID_DIR);

    // 恒多根：全仓顶层目录都可见（不再按 directory 裁剪）
    const scoped = lake.listLakeSessions(cfgDir);
    expect(scoped.some(s => s.sid === SID_DIR)).toBe(true);
    const def = lake.listLakeSessions();
    expect(def.some(s => s.sid === SID_DIR)).toBe(true);
  });

  it('导入回环：删本地会话后按目录物化导入，turns 重建', async () => {
    await prisma.session.deleteMany({ where: { taskId: SID_DIR } });
    const result = await lake.importLakeSession(SID_DIR, prisma, cfgDir);
    expect(result).toBeTruthy();
    const session = await prisma.session.findFirst({ where: { taskId: SID_DIR } });
    expect(session).toBeDefined();
    const turns = await prisma.turn.findMany({ where: { sessionId: session!.id } });
    expect(turns.length).toBeGreaterThanOrEqual(2);
  });
});

describe('自定义分支：上传落 srb_7_sessions，main 不动', () => {
  it('上传 + 列表按分支生效', async () => {
    await importFixture(SID_BR);
    const mainBefore = git('git rev-parse main', BARE_B).trim();
    const up = await lake.uploadLakeSession(prisma, SID_BR, '提交人: 测试者\n内容描述: 分支上传', cfgBranch);
    expect(up.unchanged).toBe(false);
    expect(git('git rev-parse main', BARE_B).trim()).toBe(mainBefore);
    const tree = git(`git ls-tree -r --name-only srb_7_sessions -- ${SID_BR}/`, BARE_B);
    expect(tree).toContain(`${SID_BR}.jsonl`);
    const scoped = lake.listLakeSessions(cfgBranch);
    expect(scoped.some(s => s.sid === SID_BR)).toBe(true);
  });
});

describe('中文目录远端（语料仓 <范式>/<月份> 布局）：上传 → 列表 → 导入回环', () => {
  it('上传落 01_longtail_op_gen/7月/<sid>/，bare 仓与 scoped 列表可见，同目录存量不干扰', async () => {
    await importFixture(SID_CN);
    const up = await lake.uploadLakeSession(prisma, SID_CN, '提交人: 测试者\n内容描述: 中文目录上传', cfgCn);
    expect(up.folder).toBe(`01_longtail_op_gen/7月/${SID_CN}/`);
    const tree = git(`git ls-tree -r --name-only main -- "01_longtail_op_gen/7月/${SID_CN}/"`, BARE_A);
    expect(tree).toContain(`${SID_CN}.jsonl`);
    const scoped = lake.listLakeSessions(cfgCn);
    expect(scoped.some(s => s.sid === SID_CN)).toBe(true);
    expect(scoped.some(s => s.sid === 'sessions-07-fj')).toBe(true);
    // 恒多根：rootDir 不再裁剪扫描范围——同一 bare 仓（BARE_A）任何 directory
    // 视角都见全量列表（旧「其他目录作用域不可见」语义已随二合一退役）
    expect(lake.listLakeSessions(cfgDir).some(s => s.sid === SID_CN)).toBe(true);
  });

  it('导入回环：删本地会话后从中文目录物化导入，turns 重建', async () => {
    await prisma.session.deleteMany({ where: { taskId: SID_CN } });
    const result = await lake.importLakeSession(SID_CN, prisma, cfgCn);
    expect(result).toBeTruthy();
    const session = await prisma.session.findFirst({ where: { taskId: SID_CN } });
    expect(session).toBeDefined();
    const turns = await prisma.turn.findMany({ where: { sessionId: session!.id } });
    expect(turns.length).toBeGreaterThanOrEqual(2);
  });
});

describe('per-remote 缓存隔离', () => {
  it('两个远端缓存目录不同且互不串列表', () => {
    expect(cfgDir.cacheDir).not.toBe(cfgBranch.cacheDir);
    expect(cfgDir.cacheDir.startsWith(CACHE)).toBe(true);
    expect(cfgBranch.cacheDir.startsWith(CACHE)).toBe(true);
    const a = lake.listLakeSessions(cfgDir);
    const b = lake.listLakeSessions(cfgBranch);
    expect(a.some(s => s.sid === SID_DIR)).toBe(true);
    expect(a.some(s => s.sid === SID_BR)).toBe(false);
    expect(b.some(s => s.sid === SID_BR)).toBe(true);
    expect(b.some(s => s.sid === SID_DIR)).toBe(false);
  });
});

describe('目录浏览：action=dirs 逐级列出子目录（文件清单推导）', () => {
  it('根目录：一级子目录含 sessions 与 trace，不含 blob', async () => {
    const res = await route.POST(makeRequest({ action: 'dirs', config: { address: BARE_A } }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.dirs).toContain('sessions');
    expect(data.dirs).toContain('trace');
    expect(data.dirs).not.toContain('README.md');
  });
  it('drill-down：trace → trace/2026-08 → 会话文件夹', async () => {
    const l1 = await (await route.POST(makeRequest({ action: 'dirs', prefix: 'trace', config: { address: BARE_A } }))).json();
    expect(l1.dirs).toEqual(['trace/2026-08']);
    const l2 = await (await route.POST(makeRequest({ action: 'dirs', prefix: 'trace/2026-08', config: { address: BARE_A } }))).json();
    expect(l2.dirs).toContain(`trace/2026-08/${SID_DIR}`);
  });
  it('中文目录 drill-down（客户现场语料仓：<范式> → <月份> → <提交人>），不再 400 无效目录', async () => {
    const l0 = await (await route.POST(makeRequest({ action: 'dirs', config: { address: BARE_A } }))).json();
    expect(l0.dirs).toContain('01_longtail_op_gen');
    const l1 = await (await route.POST(makeRequest({ action: 'dirs', prefix: '01_longtail_op_gen', config: { address: BARE_A } }))).json();
    expect(l1.dirs).toContain('01_longtail_op_gen/7月');
    // 修复前：normalizeDirPrefix 白名单 (\w 纯 ASCII) 拒绝 "7月" → 400 无效目录
    const l2 = await route.POST(makeRequest({ action: 'dirs', prefix: '01_longtail_op_gen/7月', config: { address: BARE_A } }));
    expect(l2.status).toBe(200);
    expect((await l2.json()).dirs).toContain('01_longtail_op_gen/7月/sessions-07-fj');
  });
  it('分支远端：srb_7_sessions 根含 sessions', async () => {
    const res = await route.POST(makeRequest({ action: 'dirs', config: { address: BARE_B, branch: 'srb_7_sessions' } }));
    const data = await res.json();
    expect(data.dirs).toContain('sessions');
  });
  it('非法前缀 → 400', async () => {
    const res = await route.POST(makeRequest({ action: 'dirs', prefix: 'a b', config: { address: BARE_A } }));
    expect(res.status).toBe(400);
  });
});

describe('分支选择：action=branches（ls-remote --heads）', () => {
  it('BARE_A → [main]；BARE_B → main + srb_7_sessions，斜杠分支被过滤', async () => {
    const a = await (await route.POST(makeRequest({ action: 'branches', config: { address: BARE_A } }))).json();
    expect(a.branches).toEqual(['main']);
    const b = await (await route.POST(makeRequest({ action: 'branches', config: { address: BARE_B } }))).json();
    expect(b.branches).toContain('main');
    expect(b.branches).toContain('srb_7_sessions');
    expect(b.branches).not.toContain('feat/x');
  });
  it('配置里的分支字段被忽略（正在改这个字段也能列分支）', async () => {
    const res = await route.POST(makeRequest({ action: 'branches', config: { address: BARE_B, branch: 'mid-edit garbage' } }));
    expect(res.status).toBe(200);
    expect((await res.json()).branches).toContain('srb_7_sessions');
  });
  it('失败消息脱敏：token 不出现在响应', async () => {
    const TOKEN = 'it-secret-tok-987654';
    const res = await route.POST(makeRequest({ action: 'branches', config: { address: 'https://127.0.0.1:1/x.git', authMode: 'token', token: TOKEN } }));
    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('oauth2:');
  });
});

describe('路由级：单源（list 忽略 body config）、校验 400、test 动作、凭据脱敏', () => {
  it('服务端配置切换远端/分支（body config 被忽略——BARE_B 分支会话经路由可见）', async () => {
    switchLakeConfig({ address: BARE_B, branch: 'srb_7_sessions' });
    const res = await route.POST(makeRequest({ action: 'list', config: { address: BARE_A } }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.sessions.some((s: { sid: string }) => s.sid === SID_BR)).toBe(true);
    switchLakeConfig({ address: BARE_A });
  });

  it('非法目录 → 400 且消息指向字段（探测动作 test/dirs 消费 config；list/upload 单源忽略）', async () => {
    // list：body config 整体忽略（单源）——非法值不拦，按服务端配置正常出列表
    const list = await route.POST(makeRequest({ action: 'list', config: { directory: 'a b' } }));
    expect(list.status).toBe(200);
    // 探测动作消费编辑态 config：非法目录 400
    for (const action of ['test', 'dirs']) {
      const res = await route.POST(makeRequest({ action, config: { address: BARE_A, directory: 'a b' } }));
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toMatch(/无效目录/);
    }
    // branches 容忍脏 branch（分支选择器不消费该字段）；非法分支在 adhoc 消费处拦
    const br = await route.POST(makeRequest({ action: 'test', config: { address: BARE_A, branch: 'main; rm -rf /' } }));
    expect(br.status).toBe(400);
    expect(JSON.stringify(await br.json())).toMatch(/无效分支名/);
  });

  it('action=test：本地远端成功（无凭据 → 明示匿名）', async () => {
    const res = await route.POST(makeRequest({ action: 'test', config: { address: BARE_A } }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.message).toMatch(/匿名/);
  });
  it('action=test：选了认证方式但没填凭据 → 失败并提示', async () => {
    const t = await (await route.POST(makeRequest({ action: 'test', config: { address: BARE_A, authMode: 'token', token: '' } }))).json();
    expect(t.success).toBe(false);
    expect(t.message).toMatch(/未填写令牌/);
    const p = await (await route.POST(makeRequest({ action: 'test', config: { address: BARE_A, authMode: 'password', account: 'u' } }))).json();
    expect(p.success).toBe(false);
    expect(p.message).toMatch(/未填写完整/);
  });

  it('失败消息脱敏：token 与带凭据 URL 不出现在响应（test 与 upload 两条路径）', async () => {
    const TOKEN = 'it-secret-tok-987654';
    const dead = { address: 'https://127.0.0.1:1/x.git', authMode: 'token' as const, token: TOKEN };
    const test = await route.POST(makeRequest({ action: 'test', config: dead }));
    const testData = await test.json();
    expect(testData.success).toBe(false);
    expect(JSON.stringify(testData)).not.toContain(TOKEN);
    expect(JSON.stringify(testData)).not.toContain('oauth2:');

    // upload 单源：死地址经服务端配置注入（body config 被忽略）
    switchLakeConfig({ address: dead.address });
    const up = await route.POST(makeRequest({ action: 'upload', taskId: SID_DEF, config: { address: BARE_A } }));
    expect(up.status).toBe(500);
    switchLakeConfig({ address: BARE_A });
    const upText = JSON.stringify(await up.json());
    expect(upText).not.toContain(TOKEN);
    expect(upText).not.toContain('oauth2:');
    expect(upText).not.toMatch(/https:\/\/[^"']*@/);
  });
});
