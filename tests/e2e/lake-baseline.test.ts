// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// lake baseline IT（位置即身份，结构即状态）：
//   baseline = 住在 <paradigm>/baseline/ 里的那个会话 —— 无标记文件、无徽标数据源，
//   路径推导（listSessions isBaseline / materialize 三段定位 / uploadFolder 交换语义）。
//   更换 baseline = 一次 commit 原子交换：新会话进 baseline/、原 baseline 移回范式
//   普通目录。env 必须在 lake 模块加载前设置（mirror.ts 模块顶层读取 env）。
import { describe, it, expect, afterAll } from 'vitest';
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lake-baseline-it-'));
const BARE = path.join(TMP, 'remote.git');
const SEED = path.join(TMP, 'seed');
const CACHE = path.join(TMP, 'cache');
const FIXTURES = path.join(TMP, 'fixtures');

execSync(`git init --bare -b main "${BARE}"`, { stdio: 'pipe' });
git('git config uploadpack.allowFilter true', BARE);
git('git config uploadpack.allowAnySHA1InWant true', BARE);
execSync(`git clone --quiet "${BARE}" "${SEED}"`, { stdio: 'pipe' });
fs.writeFileSync(path.join(SEED, 'README.md'), '# baseline it\n');
for (const d of ['contraction', 'others']) {
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

const SID_A = 'cc-baseline-it-a';
const SID_B = 'cc-baseline-it-b';
const SIDS = [SID_A, SID_B];

function writeFixture(sid: string, marker: string): string {
  fs.mkdirSync(FIXTURES, { recursive: true });
  const f = path.join(FIXTURES, `${sid}.jsonl`);
  fs.writeFileSync(f, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: `baseline IT ${marker}` }, timestamp: '2026-08-28T03:00:00.000Z', source: 'claude-proxy', x_cannbay: { schema: 'it-wire-evidence', version: 1, data: {} } }),
    JSON.stringify({ type: 'assistant', message: { id: `m_${sid}`, role: 'assistant', content: [{ type: 'text', text: `回复 ${marker}` }], model: 'test-model', usage: { input_tokens: 10, output_tokens: 2 } }, timestamp: '2026-08-28T03:00:05.000Z' }),
  ].join('\n') + '\n');
  return f;
}

async function importFixture(sid: string, marker: string): Promise<void> {
  const f = writeFixture(sid, marker);
  await importSession(f, sid, prisma, f, 'claude-jsonl');
}

function tree(spec: string): string {
  return git(`git ls-tree -r --name-only main -- ${spec}`, BARE);
}

/** sid 的直接子路径行（精确段匹配，防递归清单子串误中 baseline 路径） */
function sessionPaths(sid: string): string[] {
  return tree('').split('\n')
    .filter(l => l.split('/').includes(sid));
}

/** sid 所在位置前缀（如 contraction/<sid> 或 contraction/baseline/<sid>）集合 */
function sessionLocations(sid: string): Set<string> {
  return new Set(sessionPaths(sid).map(l => {
    const segs = l.split('/');
    return segs.slice(0, segs.indexOf(sid) + 1).join('/');
  }));
}

afterAll(async () => {
  for (const sid of SIDS) {
    try { await prisma.session.deleteMany({ where: { taskId: sid } }); } catch { /* ignore */ }
  }
  await prisma.$disconnect();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('baseline：位置即身份（上传 → 落位 → 列表 → 交换 → 导入）', () => {
  it('baseline 上传落 <paradigm>/baseline/<sid>/，列表 isBaseline 由路径推导、无幻影', async () => {
    await importFixture(SID_A, 'v1');
    const up = await lake.uploadLakeSession(prisma, SID_A, '提交人: 测试者\n内容描述: baseline 首任', undefined, 'contraction', true);
    expect(up.folder).toBe(`contraction/baseline/${SID_A}/`);
    expect(tree(`contraction/baseline/${SID_A}/`)).toContain(`${SID_A}.jsonl.7z`);
    // 普通位置无此会话（精确段匹配：所有路径段中 sid 只出现在 baseline 位置）
    expect(sessionPaths(SID_A).every(l => l.startsWith('contraction/baseline/'))).toBe(true);

    const entry = lake.listLakeSessions().find(s => s.sid === SID_A);
    expect(entry?.paradigm).toBe('contraction');
    expect(entry?.isBaseline).toBe(true);
    // 无幻影：baseline 保留目录名不作为 sid 出现
    expect(lake.listLakeSessions().some(s => s.sid === 'baseline')).toBe(false);
  });

  it('更换 baseline：新会话进 baseline/，原 baseline 移回范式普通目录（一次 commit 原子交换）', async () => {
    await importFixture(SID_B, 'v2');
    const before = git('git rev-parse main', BARE).trim();
    const up = await lake.uploadLakeSession(prisma, SID_B, '提交人: 测试者\n内容描述: 更换 baseline', undefined, 'contraction', true);
    expect(up.folder).toBe(`contraction/baseline/${SID_B}/`);
    expect(git('git rev-parse main', BARE).trim()).not.toBe(before);

    // 新 baseline 就位
    expect(tree(`contraction/baseline/${SID_B}/`)).toContain(`${SID_B}.jsonl.7z`);
    // 原 baseline 移回范式普通目录（会话不丢，位置换回）
    expect(tree(`contraction/${SID_A}/`)).toContain(`${SID_A}.jsonl.7z`);
    expect(tree(`contraction/baseline/${SID_A}/`)).toBe('');
    // sid 各自全仓唯一（位置前缀集合 = 单一目标位置）
    expect(sessionLocations(SID_A)).toEqual(new Set([`contraction/${SID_A}`]));
    expect(sessionLocations(SID_B)).toEqual(new Set([`contraction/baseline/${SID_B}`]));
    // 列表：范式内 baseline 唯一
    const entries = lake.listLakeSessions().filter(s => s.paradigm === 'contraction');
    expect(entries.filter(s => s.isBaseline).map(s => s.sid)).toEqual([SID_B]);
  });

  it('本会话已在 baseline 位重传 baseline → 覆盖自身（unchanged 语义不破坏）', async () => {
    const up = await lake.uploadLakeSession(prisma, SID_B, '提交人: 测试者\n内容描述: 重传同内容 baseline', undefined, 'contraction', true);
    expect(up.unchanged).toBe(true);
    expect(tree(`contraction/baseline/${SID_B}/`)).toContain(`${SID_B}.jsonl.7z`);
  });

  it('baseline 会话导入：三段路径自动定位，turns 重建', async () => {
    await prisma.session.deleteMany({ where: { taskId: SID_B } });
    const result = await lake.importLakeSession(SID_B, prisma);
    expect(result).toBeTruthy();
    const session = await prisma.session.findFirst({ where: { taskId: SID_B } });
    expect(session).toBeDefined();
    const turns = await prisma.turn.findMany({ where: { sessionId: session!.id } });
    expect(turns.length).toBeGreaterThanOrEqual(2);
    // 原 baseline（已移回普通目录）同样可导入
    await prisma.session.deleteMany({ where: { taskId: SID_A } });
    const resultA = await lake.importLakeSession(SID_A, prisma);
    expect(resultA).toBeTruthy();
  });

  it('勾选 baseline 的会话原在普通位置 → 移动进 baseline（旧位置删除）', async () => {
    // SID_A 当前在普通位置（上轮交换移回）；重传勾选 baseline → 移入 baseline
    const up = await lake.uploadLakeSession(prisma, SID_A, '提交人: 测试者\n内容描述: 移入 baseline', undefined, 'contraction', true);
    expect(up.folder).toBe(`contraction/baseline/${SID_A}/`);
    expect(tree(`contraction/baseline/${SID_A}/`)).toContain(`${SID_A}.jsonl.7z`);
    expect(sessionPaths(SID_A).every(l => l.startsWith('contraction/baseline/'))).toBe(true);
    // SID_B 被交换移回普通位置
    expect(sessionPaths(SID_B).every(l => l.startsWith(`contraction/${SID_B}/`))).toBe(true);
  });

  it('网关：baseline 必须选中范式（无 category 拒）；自定义远端 + category 可用', async () => {
    await expect(lake.uploadLakeSession(prisma, SID_A, '提交人: 测试者\n内容描述: x', undefined, undefined, true))
      .rejects.toThrow(/baseline 上传必须选中范式目录/);
  });

  it('普通上传不受 baseline 影响（同范式非 baseline 落普通位置）', async () => {
    const up = await lake.uploadLakeSession(prisma, SID_B, '提交人: 测试者\n内容描述: 普通上传', undefined, 'contraction');
    expect(up.folder).toBe(`contraction/${SID_B}/`);
    expect(tree(`contraction/baseline/${SID_A}/`)).toContain(`${SID_A}.jsonl.7z`);
    const entry = lake.listLakeSessions().find(s => s.sid === SID_B);
    expect(entry?.isBaseline).toBe(false);
  });

  it('自定义远端手工 baseline 结构：无幻影、meta 可读、物化定位、baseline + category 可用', async () => {
    // 自定义数据湖仓里用户手工放置 <rootDir>/baseline/<sid>/：列表按真实 sid
    // 展示（isBaseline 由路径推导，不再产生 sid='baseline' 幻影会话）
    const cfgCustom = remoteMod.resolveAdhocRemote({ address: BARE });
    const manualSid = 'cc-baseline-manual';
    const manualDir = path.join(SEED, 'sessions', 'baseline', manualSid);
    fs.mkdirSync(manualDir, { recursive: true });
    const plain = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: '手工 baseline 结构' }, timestamp: '2026-08-28T05:00:00.000Z' }),
      JSON.stringify({ type: 'assistant', message: { id: 'm_manual', role: 'assistant', content: [{ type: 'text', text: 'ok' }], model: 'm', usage: { input_tokens: 1, output_tokens: 1 } }, timestamp: '2026-08-28T05:00:02.000Z' }),
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(manualDir, `${manualSid}.jsonl`), plain);
    fs.writeFileSync(path.join(manualDir, `${manualSid}.meta.json`), JSON.stringify({
      x_cannbay: { schema: 'cc-session-meta', version: 1, data: { producer: 'cpx', framework: 'claude-code', ccVersion: '9.9.9', sid: manualSid } },
    }));
    git('git add .', SEED);
    git('git -c user.name=seed -c user.email=seed@t commit -q -m "manual baseline structure"', SEED);
    // bare 仓已被 upload 推进（SEED 停在 init）→ rebase 后再推
    git('git pull --rebase -q origin main', SEED);
    git('git push -q origin main', SEED);

    const scoped = lake.listLakeSessions(cfgCustom);
    // 无幻影：不出现 sid='baseline'
    expect(scoped.some(s => s.sid === 'baseline')).toBe(false);
    const entry = scoped.find(s => s.sid === manualSid);
    expect(entry).toBeDefined();
    expect(entry!.isBaseline).toBe(true);
    // meta 批量读同样识别 baseline 段（framework/ccVersion 可见）
    expect(entry!.framework).toBe('claude-code');
    expect(entry!.ccVersion).toBe('9.9.9');
    // 物化定位 baseline 三段路径 → 可导入
    const mainJsonl = mirror.materializeSession(manualSid, cfgCustom);
    expect(fs.readFileSync(mainJsonl, 'utf8')).toContain('手工 baseline 结构');
    // 二合一后自定义远端 baseline + category 可用（不再拒）
    const upBaseline = await lake.uploadLakeSession(prisma, SID_A, '提交人: 测试者\n内容描述: baseline 自定义远端', cfgCustom, 'contraction', true);
    expect(upBaseline.folder).toContain('baseline');
  });
});
