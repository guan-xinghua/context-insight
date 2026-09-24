// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// cannbay2 范式目录 IT（目录即范式注册表，insight 零范式知识）：
// 本地 bare 仓预置范式目录 → 上传选范式落 <paradigm>/<sid>/ → 列表多根聚合
// （paradigm 字段）→ 导入自动定位 → 换范式重传（同 commit 删旧写新、sid 全仓
// 唯一）→ 网关必填/动态白名单/自定义远端拦截。env 必须在 cannbay2 模块加载前
// 设置（mirror.ts 在模块顶层读取 env）。
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { readCaptureText } from '../../src/lib/compression.ts';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';
import { importSession } from '../../src/lib/ingest/data-service.ts';

function git(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: 'pipe', timeout: 60_000 }).toString();
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cannbay2-paradigm-it-'));
const BARE = path.join(TMP, 'remote.git');
const SEED = path.join(TMP, 'seed');
const CACHE = path.join(TMP, 'cache');
const FIXTURES = path.join(TMP, 'fixtures');

// 范式目录注册表快照：三个顶层目录（模拟数据仓侧新建；insight 动态发现）
const PARADIGM_DIRS = ['contraction', 'others', 'reduction'];

execSync(`git init --bare -b main "${BARE}"`, { stdio: 'pipe' });
git('git config uploadpack.allowFilter true', BARE);
git('git config uploadpack.allowAnySHA1InWant true', BARE);
execSync(`git clone --quiet "${BARE}" "${SEED}"`, { stdio: 'pipe' });
fs.writeFileSync(path.join(SEED, 'README.md'), '# paradigm it\n');
for (const d of PARADIGM_DIRS) {
  fs.mkdirSync(path.join(SEED, d), { recursive: true });
  fs.writeFileSync(path.join(SEED, d, '.gitkeep'), '');
}
git('git add .', SEED);
git('git -c user.name=seed -c user.email=seed@t commit -q -m init', SEED);
git('git push -q origin main', SEED);

process.env.CANNBAY2_REMOTE_URL = BARE;
process.env.CANNBAY2_LFS = '0';
process.env.CANNBAY2_PUSH_URL = BARE;
process.env.CANNBAY2_CACHE_DIR = CACHE;

const prisma = new PrismaClient();

const cannbay2 = await import('../../src/lib/cannbay2');
const mirror = await import('../../src/lib/cannbay2/mirror');
const remoteMod = await import('../../src/lib/cannbay2/remote');
const route = await import('../../src/app/api/ingest/cannbay2/route');

const SID_P1 = 'cc-paradigm-it-0001';
const SID_P2 = 'cc-paradigm-it-0002';
const SIDS = [SID_P1, SID_P2];

function writeFixture(sid: string, marker: string): string {
  fs.mkdirSync(FIXTURES, { recursive: true });
  const f = path.join(FIXTURES, `${sid}.jsonl`);
  fs.writeFileSync(f, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: `范式上传 ${marker}` }, timestamp: '2026-08-27T03:00:00.000Z', source: 'claude-proxy', x_cannbay: { schema: 'it-wire-evidence', version: 1, data: {} } }),
    JSON.stringify({ type: 'assistant', message: { id: `m_${sid}`, role: 'assistant', content: [{ type: 'text', text: `回复 ${marker}` }], model: 'test-model', usage: { input_tokens: 10, output_tokens: 2 } }, timestamp: '2026-08-27T03:00:05.000Z' }),
  ].join('\n') + '\n');
  return f;
}

async function importFixture(sid: string, marker: string): Promise<void> {
  const f = writeFixture(sid, marker);
  await importSession(f, sid, prisma, f, 'claude-jsonl');
}

function bareTree(spec: string): string {
  return git(`git ls-tree -r --name-only main -- ${spec}`, BARE);
}

function makeRequest(body: unknown) {
  return new NextRequest('http://localhost/api/ingest/cannbay2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterAll(async () => {
  for (const sid of SIDS) {
    try { await prisma.session.deleteMany({ where: { taskId: sid } }); } catch { /* ignore */ }
  }
  await prisma.$disconnect();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('范式目录注册表：目录即范式，insight 动态发现', () => {
  it('listParadigmDirs = 远端顶层目录（排除存量区 sessions），排序返回', () => {
    expect(mirror.listParadigmDirs()).toEqual([...PARADIGM_DIRS].sort());
  });

  it('数据仓新建顶层目录后零改动可见（注册表随远端演进）', () => {
    git('git checkout -q main', SEED);
    fs.mkdirSync(path.join(SEED, 'sort_select'), { recursive: true });
    fs.writeFileSync(path.join(SEED, 'sort_select', '.gitkeep'), '');
    git('git add .', SEED);
    git('git -c user.name=seed -c user.email=seed@t commit -q -m "add paradigm sort_select"', SEED);
    git('git push -q origin main', SEED);
    PARADIGM_DIRS.push('sort_select');
    expect(mirror.listParadigmDirs()).toEqual([...PARADIGM_DIRS].sort());
  });

  it('route action=dirs 根目录返回全部顶层目录（下拉数据源，调用方过滤存量区）', async () => {
    const res = await route.POST(makeRequest({ action: 'dirs' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    // 空目录 git 不跟踪（按文件推导）——本仓 sessions/ 尚无文件故不在列表；
    // 范式目录因 .gitkeep 占位可见
    expect(data.dirs).toContain('contraction');
    expect(data.dirs).toContain('sort_select');
  });
});

describe('范式上传：上传选范式 → <paradigm>/<sid>/ → 列表/导入回环', () => {
  it('上传 category=contraction → 远端落 contraction/<sid>/，sessions/ 无此会话', async () => {
    await importFixture(SID_P1, 'v1');
    const up = await cannbay2.uploadCannbay2Session(prisma, SID_P1, '提交人: 测试者\n内容描述: 范式上传', undefined, 'contraction');
    expect(up.folder).toBe(`contraction/${SID_P1}/`);
    expect(bareTree(`contraction/${SID_P1}/`)).toContain(`${SID_P1}.jsonl.7z`);
    expect(bareTree('sessions/')).not.toContain(SID_P1);
    // commit subject 服务端注入范式行（人类可读；列表 paradigm 以目录为准）
    const subject = git('git log -1 --pretty=%B main', BARE);
    expect(subject).toContain('范式: contraction');
  });

  it('list 多根聚合：entry.paradigm = 顶层目录名；治理 gzip 出仓形态不变', () => {
    const entry = cannbay2.listCannbay2Sessions().find(s => s.sid === SID_P1);
    expect(entry).toBeDefined();
    expect(entry!.paradigm).toBe('contraction');
    expect(entry!.submitter).toBe('测试者');
    expect(bareTree(`contraction/${SID_P1}/`)).toContain(`${SID_P1}.meta.json`);
  });

  it('导入自动定位：删本地会话 → 范式目录物化导入，turns 重建', async () => {
    await prisma.session.deleteMany({ where: { taskId: SID_P1 } });
    const result = await cannbay2.importCannbay2Session(SID_P1, prisma);
    expect(result).toBeTruthy();
    const session = await prisma.session.findFirst({ where: { taskId: SID_P1 } });
    expect(session).toBeDefined();
    const turns = await prisma.turn.findMany({ where: { sessionId: session!.id } });
    expect(turns.length).toBeGreaterThanOrEqual(2);
  });

  it('others 目录：非算子会话兼容上传', async () => {
    await importFixture(SID_P2, 'others');
    const up = await cannbay2.uploadCannbay2Session(prisma, SID_P2, '提交人: 测试者\n内容描述: 非算子会话', undefined, 'others');
    expect(up.folder).toBe(`others/${SID_P2}/`);
    expect(cannbay2.listCannbay2Sessions().find(s => s.sid === SID_P2)?.paradigm).toBe('others');
  });

  it('换范式重传：同 commit 删旧目录写新目录，sid 全仓唯一', async () => {
    const before = git('git rev-parse main', BARE).trim();
    const up = await cannbay2.uploadCannbay2Session(prisma, SID_P1, '提交人: 测试者\n内容描述: 换范式', undefined, 'reduction');
    expect(up.folder).toBe(`reduction/${SID_P1}/`);
    const after = git('git rev-parse main', BARE).trim();
    expect(after).not.toBe(before);
    // 旧目录删除、新目录就位
    expect(bareTree(`reduction/${SID_P1}/`)).toContain(`${SID_P1}.jsonl.7z`);
    expect(bareTree(`contraction/${SID_P1}/`)).toBe('');
    // sid 全仓唯一（只在一个根下出现）
    const all = bareTree('').split('\n').filter(l => l.includes(`/${SID_P1}/`));
    expect(all.length).toBeGreaterThan(0);
    expect(new Set(all.map(l => l.split('/')[0])).size).toBe(1);
    expect(new Set(all.map(l => l.split('/')[0]))).toEqual(new Set(['reduction']));
    // 列表 paradigm 跟随新目录；内容仍是原会话
    const entry = cannbay2.listCannbay2Sessions().find(s => s.sid === SID_P1);
    expect(entry!.paradigm).toBe('reduction');
    const mat = mirror.materializeSession(SID_P1);
    const text = readCaptureText(mat);
    expect(text).toContain('范式上传 v1');
  });
});

describe('范式网关：必填 + 动态白名单 + 自定义远端拦截', () => {
  it('缺 category / category=sessions / 不存在目录 → 拒绝且远端无新 commit', async () => {
    const before = git('git rev-parse main', BARE).trim();
    await expect(cannbay2.uploadCannbay2Session(prisma, SID_P2, '提交人: 测试者\n内容描述: x'))
      .rejects.toThrow(/范式目录必填/);
    await expect(cannbay2.uploadCannbay2Session(prisma, SID_P2, '提交人: 测试者\n内容描述: x', undefined, 'sessions'))
      .rejects.toThrow(/存量会话区/);
    await expect(cannbay2.uploadCannbay2Session(prisma, SID_P2, '提交人: 测试者\n内容描述: x', undefined, 'typo_dir'))
      .rejects.toThrow(/不存在/);
    expect(git('git rev-parse main', BARE).trim()).toBe(before);
  });

  it('route 层透传 category（200）与自定义远端拦截', async () => {
    const res = await route.POST(makeRequest({ action: 'upload', taskId: SID_P2, description: '提交人: 测试者\n内容描述: route 透传', category: 'others' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.folder).toBe(`others/${SID_P2}/`);

    // 自定义远端（address）：无 category 照常（单根 rootDir）；带 category 拒绝
    const cfgCustom = remoteMod.resolveCannbay2Remote({ address: BARE });
    expect(cfgCustom.paradigmRoots).toBe(false);
    const upCustom = await cannbay2.uploadCannbay2Session(prisma, SID_P2, '提交人: 测试者\n内容描述: 单根远端', cfgCustom);
    expect(upCustom.folder).toBe(`sessions/${SID_P2}/`);
    // 单根上传后多根列表里同一 sid 出现两个根 —— 布局损坏由 materialize 显式报错（不猜）
    await expect(cannbay2.uploadCannbay2Session(prisma, SID_P2, '提交人: 测试者\n内容描述: y', cfgCustom, 'others'))
      .rejects.toThrow(/不支持范式目录/);
  });

  it('自定义远端（address）不启用范式：listParadigmDirs 恒空、列表 paradigm 恒 null、category 上传被拒', async () => {
    const cfgCustom = remoteMod.resolveCannbay2Remote({ address: BARE });
    expect(cfgCustom.paradigmRoots).toBe(false);
    expect(mirror.listParadigmDirs(cfgCustom)).toEqual([]);
    // 单根列表（directory/rootDir 扫描）：paradigm 恒 null，导入 UI 对自定义
    // 远端不得把顶层目录当范式注册表展示
    const scoped = cannbay2.listCannbay2Sessions(cfgCustom);
    expect(scoped.every(s => s.paradigm === null)).toBe(true);
    await expect(cannbay2.uploadCannbay2Session(prisma, SID_P2, '提交人: 测试者\n内容描述: x', cfgCustom, 'others'))
      .rejects.toThrow(/不支持范式目录/);
  });

  it('多根布局损坏（同 sid 双根并存）→ materialize 拒绝不猜', async () => {
    // 上一用例已在 sessions/ 与 others/ 各放一份 SID_P2 —— 物化必须显式报错
    await expect(() => mirror.materializeSession(SID_P2)).toThrow(/multiple locations/);
    // 收尾：用范式上传归位（删 sessions/ 副本，恢复全仓唯一）
    const up = await cannbay2.uploadCannbay2Session(prisma, SID_P2, '提交人: 测试者\n内容描述: 归位', undefined, 'others');
    expect(up.folder).toBe(`others/${SID_P2}/`);
    expect(bareTree('sessions/')).not.toContain(SID_P2);
    expect(() => mirror.materializeSession(SID_P2)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────
// git quotepath 回归（客户现场语料仓：设置页浏览目录出现两个"同名"
// 目录，一个带双引号一个不带，带引号的无效）。真实根因：仓是干净的，但
// 含中文子目录（<类别>/<月份>/ 布局，如 09_fa_op_gen/7月/）——git 默认
// core.quotepath 把含非 ASCII 的整条路径加引号转义（"09_fa_op_gen/7\346…
// /README.md"），listRemoteDirs 按首个 "/" 切分得到带引号前缀的目录名，
// 与纯 ASCII 路径推出的干净目录名并存 → 两个同名条目。修复：ls-tree
// 一律 -z（NUL 分隔，路径永不转义）+ log walk 关 quotepath。
describe('quotepath：中文子目录不得产生带引号的重复目录条目', () => {
  it('客户场景复现：<类别>/<中文月份>/ 布局 → listRemoteDirs 单一干净条目', () => {
    // seed 可能落后于 bare（uploadFolder 直接 push 过）→ 先 rebase 再推
    git('git checkout -q main', SEED);
    git('git pull --rebase -q origin main', SEED);
    // 模拟 语料仓布局：类别目录 = ASCII、月份子目录 = 中文、外加纯
    // ASCII README（两条路径形态并存——正是触发双条目的组合）
    fs.mkdirSync(path.join(SEED, '09_fa_op_gen', '7月'), { recursive: true });
    fs.writeFileSync(path.join(SEED, '09_fa_op_gen', '7月', 'README.md'), '# month\n');
    fs.writeFileSync(path.join(SEED, '09_fa_op_gen', 'README.md'), '# cat\n');
    git('git add .', SEED);
    git('git -c user.name=seed -c user.email=seed@t commit -q -m "chinese month dirs"', SEED);
    git('git push -q origin main', SEED);

    // 根目录浏览：09_fa_op_gen 只出现一次，无引号前缀（修复前会同时出现
    // "09_fa_op_gen 与 09_fa_op_gen 两条）
    const dirs = mirror.listRemoteDirs();
    expect(dirs.filter(d => d.includes('09_fa_op_gen'))).toEqual(['09_fa_op_gen']);
    expect(dirs.some(d => d.includes('"'))).toBe(false);

    // 钻取进类别目录：中文月份子目录原样返回（无引号、无八进制转义）
    const months = mirror.listRemoteDirs(undefined, '09_fa_op_gen');
    expect(months).toEqual(['09_fa_op_gen/7月']);

    // 顶层范式清单：中文目录原样可见，无引号条目
    const paradigms = mirror.listParadigmDirs();
    expect(paradigms).toContain('09_fa_op_gen');
    expect(paradigms.some(d => d.includes('"'))).toBe(false);

    // 会话列表不产生引号幻影 sid（平铺文件不构成 <sid>/ 文件夹约定）
    const sessions = cannbay2.listCannbay2Sessions();
    expect(sessions.every(s => !s.sid.includes('"'))).toBe(true);
    expect(sessions.every(s => s.paradigm == null || !s.paradigm.includes('"'))).toBe(true);
  });
});
