// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 统一日志 IT：lake 导入全链路（物化 → 写库 → 补列）的过程事件必须落盘——
// 导入 start/done、[import] 管线阶段行、materialize 首尾行；失败路径 error 行
// 在场。这正是「导入失败零痕迹」事故的回归锁：服务端日志文件里能完整还原
// 一次导入的时序与归属（sid 贯穿）。评分 judge 日志（score-judge-logs）不在
// 此链路，保持独立（数据产物，非过程日志）。
// 隔离：本地 bare 仓（lake-prefetch.test.ts 同款）+ CANNBOT_LOG_DIR /
// CANNBOT_PROXY_DIR / LAKE_CACHE_DIR 重定向 tmp；beforeAll 删掉 setup.ts 的
// 全局静音 CANNBOT_LOG。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { seedLakeConfig } from '../helpers/lake-env';
import { prisma } from '../setup';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lake-logger-it-'));
const LOG_DIR = path.join(TMP, 'logs');
const BARE = path.join(TMP, 'remote.git');
const SEED = path.join(TMP, 'seed');

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['CANNBOT_LOG', 'CANNBOT_LOG_DIR', 'CANNBOT_PROXY_DIR', 'LAKE_CACHE_DIR', 'LAKE_LFS'] as const;

function git(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: 'pipe', timeout: 60_000 });
}

function metaJson(sid: string): string {
  return JSON.stringify({
    x_cannbay: {
      schema: 'cc-session-meta',
      version: 1,
      data: { producer: 'cpx', framework: 'opencode', ccVersion: '1.2.3', opGen: 'success', sid },
    },
  }, null, 2) + '\n';
}

function todayLog(): string {
  return path.join(LOG_DIR, `insight-${new Date().toISOString().slice(0, 10)}.log`);
}

function readLog(): string {
  try { return fs.readFileSync(todayLog(), 'utf8'); } catch { return ''; }
}

beforeAll(async () => {
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  process.env.CANNBOT_LOG_DIR = LOG_DIR;
  process.env.LAKE_LFS = '0';
  delete process.env.CANNBOT_LOG;   // 抵消 tests/setup.ts 全局静音

  execSync(`git init --bare -b main "${BARE}"`, { stdio: 'pipe' });
  git('git config uploadpack.allowFilter true', BARE);
  git('git config uploadpack.allowAnySHA1InWant true', BARE);
  execSync(`git clone --quiet "${BARE}" "${SEED}"`, { stdio: 'pipe' });
  const sid = 'ses_logit_a';
  const dir = path.join(SEED, 'it-log', sid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.meta.json`), metaJson(sid));
  fs.writeFileSync(path.join(dir, `${sid}.jsonl.gz`), zlib.gzipSync(Buffer.from(JSON.stringify({ type: 'user', message: { role: 'user', content: 'log it' }, timestamp: '2026-10-06T00:00:00Z' }) + '\n')));
  git('git add .', SEED);
  git('git -c user.name=seeder -c user.email=s@t commit -q -m "提交人: seeder 内容描述: log it"', SEED);
  git('git push -q origin main', SEED);

  seedLakeConfig(TMP, { address: BARE });
  // 共享 dev.db 的确定性：上次运行的残留行会让 dedup 走 merge 路径
  // （imported=false），先清本测试自己的行
  await prisma.session.deleteMany({ where: { taskId: 'ses_logit_a' } });
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

const lake = await import('../../src/lib/lake');

describe('统一日志：lake 导入链路过程事件落盘', () => {
  it('importLakeSession 成功：start/done + materialize 首尾 + [import] 管线阶段行齐备，sid 贯穿', async () => {
    const out = await lake.importLakeSession('ses_logit_a', prisma, undefined, 'capture');
    expect(out.imported).toBe(true);
    const log = readLog();
    expect(log).toContain('[INFO][import]:lake import start sid=ses_logit_a recording=capture');
    expect(log).toContain('[INFO][lake]:materialize start sid=ses_logit_a');
    expect(log).toContain('[INFO][lake]:materialize done sid=ses_logit_a');
    expect(log).toMatch(/\[INFO\]\[import\]:readSession sid=ses_logit_a ms=\d+ interactions=\d+/);
    expect(log).toMatch(/\[INFO\]\[import\]:normalize\+split sid=ses_logit_a ms=\d+/);
    expect(log).toMatch(/\[INFO\]\[import\]:new path total sid=ses_logit_a ms=\d+/);
    expect(log).toContain('[INFO][import]:lake import done sid=ses_logit_a');
    // 成功路径无失败/告警行
    expect(log).not.toContain('[ERROR]');
    expect(log).not.toContain('[WARN]');
  }, 120_000);

  it('importLakeSession 失败：error 行在场且带 sid（此前服务端零痕迹的回归锁）', async () => {
    await expect(lake.importLakeSession('ses_no_such', prisma, undefined, 'capture')).rejects.toThrow();
    const log = readLog();
    expect(log).toContain('[ERROR][import]:lake import failed sid=ses_no_such');
  }, 120_000);
});
