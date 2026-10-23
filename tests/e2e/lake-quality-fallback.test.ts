// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 质量列回落 IT：未导入行的质量分从仓内评审记录（notes scorecard 快照）读取
// ——评分发生过（记录已推仓）就该显示，不要求每台机器先导入重算。锁三件事：
//   ① 未导入行：末条 scorecard 记录的 totalScore/dimensions 显示为
//      scoreSource='lake-note'（数值按 0-1 → 0-100 归一）
//   ② 已导入行：本机评分链出分，scoreSource='local'（回落不越位）
//   ③ 未导入且仓里也无记录：totalScore null + scoreSource null（不硬造）
// 隔离同 lake-viewer-prefetch-auth / logger-lake-import（本地 bare + env 重定向）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { seedLakeConfig } from '../helpers/lake-env';
import { prisma } from '../setup';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lake-quality-fb-'));
const BARE = path.join(TMP, 'remote.git');
const SEED = path.join(TMP, 'seed');

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['CONTEXT_PROXY_DIR', 'LAKE_CACHE_DIR', 'LAKE_LFS'] as const;

function git(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: 'pipe', timeout: 60_000 });
}

function metaJson(sid: string): string {
  return JSON.stringify({
    x_lake: {
      schema: 'cc-session-meta',
      version: 1,
      data: { producer: 'cpx', framework: 'opencode', ccVersion: '1.2.3', sid },
    },
  }, null, 2) + '\n';
}

function jsonlGz(text: string): Buffer {
  return zlib.gzipSync(Buffer.from(JSON.stringify({ type: 'user', message: { role: 'user', content: text }, timestamp: '2026-10-08T00:00:00Z' }) + '\n'));
}

/** 范式布局 <paradigm>/<sid>/；withNotes = 附加评审记录（末条 scorecard 为准） */
function seedSession(paradigm: string, sid: string, withNotes?: Record<string, unknown>[]): void {
  const dir = path.join(SEED, paradigm, sid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.meta.json`), metaJson(sid));
  fs.writeFileSync(path.join(dir, `${sid}.jsonl.gz`), jsonlGz(`payload ${sid}`));
  if (withNotes?.length) fs.writeFileSync(path.join(dir, `${sid}.notes.jsonl`), withNotes.map(l => JSON.stringify(l)).join('\n') + '\n');
  git('git add .', SEED);
  git(`git -c user.name=seeder -c user.email=s@t commit -q -m "提交人: seeder 内容描述: session ${sid}"`, SEED);
  git('git push -q origin main', SEED);
}

beforeAll(async () => {
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  process.env.CONTEXT_PROXY_DIR = path.join(TMP, 'proxy');
  process.env.LAKE_CACHE_DIR = path.join(TMP, 'cache');
  process.env.LAKE_LFS = '0';

  execSync(`git init --bare -b main "${BARE}"`, { stdio: 'pipe' });
  git('git config uploadpack.allowFilter true', BARE);
  git('git config uploadpack.allowAnySHA1InWant true', BARE);
  execSync(`git clone --quiet "${BARE}" "${SEED}"`, { stdio: 'pipe' });

  // A：将导入本机（本机评分链出分）；B：不导入，仓里带两条 scorecard 记录（末条为准）
  seedSession('it-qb', 'ses_qb_a');
  seedSession('it-qb', 'ses_qb_b', [
    { ts: '2026-10-08T01:00:00.000Z', type: 'scorecard', totalScore: 0.42, computedAt: '2026-10-08T01:00:00.000Z',
      dimensions: [{ dimensionId: 'D3', name: '质量', score: 0.5 }] },
    { ts: '2026-10-08T02:00:00.000Z', type: 'scorecard', totalScore: 0.66, computedAt: '2026-10-08T02:00:00.000Z',
      dimensions: [{ dimensionId: 'D3', name: '质量', score: 0.8 }] },
  ]);
  // C：不导入且无记录——不硬造分数
  seedSession('it-qb', 'ses_qb_c');

  seedLakeConfig(TMP, { address: BARE });
  for (const sid of ['ses_qb_a', 'ses_qb_b', 'ses_qb_c']) {
    await prisma.session.deleteMany({ where: { taskId: sid } });
  }
  const lake = await import('../../src/lib/lake');
  await lake.importLakeSession('ses_qb_a', prisma, undefined, 'capture');
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

const runs = await import('../../src/app/lake_viewer/_lib/runs');

describe('质量列回落：未导入行读仓内评审记录快照', () => {
  it('未导入 + 仓有评审记录：末条 scorecard 出分，scoreSource=lake-note，维度归一', async () => {
    const result = await runs.listRuns({ paradigm: 'it-qb' });
    const b = result.items.find(r => r.sid === 'ses_qb_b');
    expect(b, '未导入行应在清单').toBeTruthy();
    expect(b!.imported).toBe(false);
    expect(b!.totalScore).toBe(66);          // 末条 0.66（不是首条 0.42）
    expect(b!.scoreSource).toBe('lake-note');
    expect(b!.dimensions).toEqual([{ dimensionId: 'D3', name: '质量', score: 80 }]);
  }, 120_000);

  it('已导入行仍走本机评分链：scoreSource=local（回落不越位）', async () => {
    const result = await runs.listRuns({ paradigm: 'it-qb' });
    const a = result.items.find(r => r.sid === 'ses_qb_a');
    expect(a!.imported).toBe(true);
    expect(a!.totalScore).not.toBeNull();    // 确定性层现算必有分
    expect(a!.scoreSource).toBe('local');
  }, 120_000);

  it('未导入且仓里无记录：totalScore null + scoreSource null（不硬造）', async () => {
    const result = await runs.listRuns({ paradigm: 'it-qb' });
    const c = result.items.find(r => r.sid === 'ses_qb_c');
    expect(c!.imported).toBe(false);
    expect(c!.totalScore).toBeNull();
    expect(c!.scoreSource).toBeNull();
  }, 120_000);
});
