// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// lake 范式目录 IT（目录即范式注册表，insight 零范式知识）：
// 本地 bare 仓预置范式目录 → 上传选范式落 <paradigm>/<sid>/ → 列表多根聚合
// （paradigm 字段）→ 导入自动定位 → 换范式重传（同 commit 删旧写新、sid 全仓
// 唯一）→ 网关必填/动态白名单/自定义远端拦截。env 必须在 lake 模块加载前
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
import { seedLakeConfig, switchLakeConfig } from '../helpers/lake-env';

function git(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: 'pipe', timeout: 60_000 }).toString();
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lake-paradigm-it-'));
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

seedLakeConfig(TMP, { address: BARE });
process.env.LAKE_LFS = '0';
process.env.LAKE_CACHE_DIR = CACHE;

const prisma = new PrismaClient();

const lake = await import('../../src/lib/lake');
const mirror = await import('../../src/lib/lake/mirror');
const remoteMod = await import('../../src/lib/lake/remote');
const route = await import('../../src/app/api/ingest/lake/route');

const SID_P1 = 'cc-paradigm-it-0001';
const SID_P2 = 'cc-paradigm-it-0002';
const SIDS = [SID_P1, SID_P2];

function writeFixture(sid: string, marker: string): string {
  fs.mkdirSync(FIXTURES, { recursive: true });
  const f = path.join(FIXTURES, `${sid}.jsonl`);
  fs.writeFileSync(f, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: `范式上传 ${marker}` }, timestamp: '2026-08-27T03:00:00.000Z', source: 'claude-proxy', x_lake: { schema: 'it-wire-evidence', version: 1, data: {} } }),
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
  return new NextRequest('http://localhost/api/ingest/lake', {
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
  it('listParadigmDirs = 远端全部顶层目录（存量区特判已退役），排序返回', () => {
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

  it('route action=dirs 根目录返回全部顶层目录（设置页编辑态探测——config 带地址）', async () => {
    const res = await route.POST(makeRequest({ action: 'dirs', config: { address: BARE } }));
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
    const up = await lake.uploadLakeSession(prisma, SID_P1, '提交人: 测试者\n内容描述: 范式上传', undefined, 'contraction');
    expect(up.folder).toBe(`contraction/${SID_P1}/`);
    expect(bareTree(`contraction/${SID_P1}/`)).toContain(`${SID_P1}.jsonl.7z`);
    expect(bareTree('sessions/')).not.toContain(SID_P1);
    // commit subject 服务端注入范式行（人类可读；列表 paradigm 以目录为准）
    const subject = git('git log -1 --pretty=%B main', BARE);
    expect(subject).toContain('范式: contraction');
  });

  it('list 多根聚合：entry.paradigm = 顶层目录名；治理 gzip 出仓形态不变', () => {
    const entry = lake.listLakeSessions().find(s => s.sid === SID_P1);
    expect(entry).toBeDefined();
    expect(entry!.paradigm).toBe('contraction');
    expect(entry!.submitter).toBe('测试者');
    expect(bareTree(`contraction/${SID_P1}/`)).toContain(`${SID_P1}.meta.json`);
  });

  it('导入自动定位：删本地会话 → 范式目录物化导入，turns 重建', async () => {
    await prisma.session.deleteMany({ where: { taskId: SID_P1 } });
    const result = await lake.importLakeSession(SID_P1, prisma);
    expect(result).toBeTruthy();
    const session = await prisma.session.findFirst({ where: { taskId: SID_P1 } });
    expect(session).toBeDefined();
    const turns = await prisma.turn.findMany({ where: { sessionId: session!.id } });
    expect(turns.length).toBeGreaterThanOrEqual(2);
  });

  it('others 目录：非算子会话兼容上传', async () => {
    await importFixture(SID_P2, 'others');
    const up = await lake.uploadLakeSession(prisma, SID_P2, '提交人: 测试者\n内容描述: 非算子会话', undefined, 'others');
    expect(up.folder).toBe(`others/${SID_P2}/`);
    expect(lake.listLakeSessions().find(s => s.sid === SID_P2)?.paradigm).toBe('others');
  });

  it('换范式重传：同 commit 删旧目录写新目录，sid 全仓唯一', async () => {
    const before = git('git rev-parse main', BARE).trim();
    const up = await lake.uploadLakeSession(prisma, SID_P1, '提交人: 测试者\n内容描述: 换范式', undefined, 'reduction');
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
    const entry = lake.listLakeSessions().find(s => s.sid === SID_P1);
    expect(entry!.paradigm).toBe('reduction');
    const mat = mirror.materializeSession(SID_P1);
    const text = readCaptureText(mat);
    expect(text).toContain('范式上传 v1');
  });
});

describe('范式网关：必填 + 动态白名单 + 自定义远端拦截', () => {
  it('缺 category 落仓库根 / 不存在目录 → 拒绝（动态白名单）', async () => {
    const upNoCat = await lake.uploadLakeSession(prisma, SID_P2, '提交人: 测试者\n内容描述: 无目录');
    expect(upNoCat.folder).toBe(`${SID_P2}/`);
    await expect(lake.uploadLakeSession(prisma, SID_P2, '提交人: 测试者\n内容描述: x', undefined, 'sessions'))
      .rejects.toThrow(/不存在/);
    await expect(lake.uploadLakeSession(prisma, SID_P2, '提交人: 测试者\n内容描述: x', undefined, 'typo_dir'))
      .rejects.toThrow(/不存在/);
  });

  it('route 层透传 category（200）与自定义远端拦截', async () => {
    const res = await route.POST(makeRequest({ action: 'upload', taskId: SID_P2, description: '提交人: 测试者\n内容描述: route 透传', category: 'others' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.folder).toBe(`others/${SID_P2}/`);

    // 二合一后自定义远端同链：无 category 落上传缺省目录（''=仓库根）
    const cfgCustom = remoteMod.resolveAdhocRemote({ address: BARE });
    const upCustom = await lake.uploadLakeSession(prisma, SID_P2, '提交人: 测试者\n内容描述: 远端无目录', cfgCustom);
    expect(upCustom.folder).toBe(`${SID_P2}/`);
  });

  it('二合一后自定义远端也多根：listParadigmDirs 正常、列表 paradigm 按目录、category 上传可用', async () => {
    const cfgCustom = remoteMod.resolveAdhocRemote({ address: BARE });
    // 自定义远端（自定义 cacheDir 的 BARE）：与默认仓共用同一镜像（远端同址）
    // → 范式目录照常列出
    const paradigms = mirror.listParadigmDirs(cfgCustom);
    expect(paradigms).toContain('others');
    const upCustom = await lake.uploadLakeSession(prisma, SID_P2, '提交人: 测试者\n内容描述: x', cfgCustom, 'others');
    expect(upCustom.folder).toContain('others');
    const scoped = lake.listLakeSessions(cfgCustom);
    expect(scoped.some(s => s.paradigm === 'others')).toBe(true);
  });

  it('多根布局损坏（同 sid 双根并存）→ materialize 拒绝不猜', async () => {
    // 手工构造双根：others/ 已有 SID_P2，再在 sessions/ 种一份副本
    const seedDir = path.join(TMP, 'seed-corrupt');
    fs.rmSync(seedDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(seedDir, 'sessions', SID_P2), { recursive: true });
    fs.writeFileSync(path.join(seedDir, 'sessions', SID_P2, `${SID_P2}.jsonl`), '{}\n');
    execSync(`git init -q -b main`, { cwd: seedDir, stdio: 'pipe' });
    execSync(`git add -A`, { cwd: seedDir, stdio: 'pipe' });
    execSync(`git -c user.name=t -c user.email=t@t commit -q -m seed`, { cwd: seedDir, stdio: 'pipe' });
    // BARE 已有 main 分支：fetch 已有历史 + merge 允许无关历史 + push
    execSync(`git fetch -q "${BARE}" main`, { cwd: seedDir, stdio: 'pipe' });
    execSync(`git merge -q --allow-unrelated-histories -m merge FETCH_HEAD`, { cwd: seedDir, stdio: 'pipe' });
    execSync(`git push -q "${BARE}" main`, { cwd: seedDir, stdio: 'pipe' });
    // 镜像需强制刷新（cache TTL / 新 commit 推入后 fetch 可见）
    await expect(() => mirror.materializeSession(SID_P2)).toThrow(/multiple locations/);
    // 收尾：用范式上传归位（删 sessions/ 副本，恢复全仓唯一）
    const up = await lake.uploadLakeSession(prisma, SID_P2, '提交人: 测试者\n内容描述: 归位', undefined, 'others');
    expect(up.folder).toBe(`others/${SID_P2}/`);
    expect(bareTree('sessions/')).not.toContain(SID_P2);
    expect(() => mirror.materializeSession(SID_P2)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────
// viewer 范式目标文件 × 根级会话锚定（客户现场 op-fusion 回归锁）：
//   viewer 给范式设算子优化目标时写 <paradigm>/<paradigm>.jsonl（明文追加式，
//   与目录同名）——与根级会话 <sid>/<sid>.jsonl 形态撞名。修复前：根级识别
//   把范式目录整个当成一个"根级会话"（sid=目录名）→ 导入范式选择器冒出
//   「根目录」幻影桶 + 该范式从清单里被剔除（客户现场 op-fusion 消失）。
//   修复 = 根级只认管道产物形态（.jsonl.7z/.jsonl.gz/.meta.json——出仓必
//   压缩），裸 .jsonl 不算。
describe('viewer 范式目标文件不产生幻影根级会话（op-fusion 回归）', () => {
  it('目标文件 + 范式会话并存：范式身份保持、无根目录桶、根级真会话仍可见', async () => {
    // ① 模拟 viewer 写目标文件（notes(viewer) commit + 与目录同名的裸 jsonl）
    git('git checkout -q main', SEED);
    git('git pull --rebase -q origin main', SEED);
    fs.writeFileSync(path.join(SEED, 'contraction', 'contraction.jsonl'),
      JSON.stringify({ type: 'opgen-target', baselineMs: 39240000, expectedMs: 14400000, updatedAt: '2026-09-16T11:08:39.078Z' }) + '\n');
    git('git add .', SEED);
    git('git -c user.name=seed -c user.email=seed@t commit -q -m "notes(viewer): contraction paradigm target"', SEED);
    git('git push -q origin main', SEED);

    // ② 范式注册表包含 contraction（目标文件未把它变成"会话目录"）
    expect(mirror.listParadigmDirs()).toContain('contraction');

    // ③ 列表：无 sid='contraction' 幻影、无 paradigm=null 条目（根目录桶空）
    const entries = lake.listLakeSessions();
    expect(entries.some(e => e.sid === 'contraction')).toBe(false);
    expect(entries.filter(e => !e.paradigm).map(e => e.sid)).toEqual([]);

    // ④ 对照组：真根级会话（管道产物 .jsonl.7z 锚定）仍可见且归「根目录」桶
    await importFixture(SID_P2, 'root-v1');
    const upRoot = await lake.uploadLakeSession(prisma, SID_P2, '提交人: 测试者\n内容描述: 根级上传');
    expect(upRoot.folder).toBe(`${SID_P2}/`);
    const rootEntries = lake.listLakeSessions();
    const rootEntry = rootEntries.find(e => e.sid === SID_P2);
    expect(rootEntry).toBeDefined();
    expect(rootEntry!.paradigm).toBeNull();
    // 幻影仍未出现（目标文件与真根级会话并存）
    expect(rootEntries.some(e => e.sid === 'contraction')).toBe(false);
    expect(mirror.listParadigmDirs()).toContain('contraction');
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
    const sessions = lake.listLakeSessions();
    expect(sessions.every(s => !s.sid.includes('"'))).toBe(true);
    expect(sessions.every(s => s.paradigm == null || !s.paradigm.includes('"'))).toBe(true);
  });
});
