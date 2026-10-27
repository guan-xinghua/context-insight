// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// lake_viewer bundle 视图 IT（路由级，真 bare 数据湖 + 真测试库）：
// 上传 bundle → bundles 列表路由（含 imported 标记）→ 范式侧栏可见专区 →
// 导入路由发起 job → 轮询完成 → 会话入库 → imported 翻转。env 必须在
// lake 模块加载前设置（mirror.ts 模块顶层读取 env）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';
import { seedLakeConfig } from '../../helpers/lake-env';

function git(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: 'pipe', timeout: 60_000 }).toString();
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lake-viewer-bundle-it-'));
const BARE = path.join(TMP, 'remote.git');
const SEED = path.join(TMP, 'seed');
const CACHE = path.join(TMP, 'cache');
const HOME = path.join(TMP, 'home');
const FIXTURE = path.join(TMP, 'fixture');
const RUN_ID = 'vbnd01';
const SID = 'VS1';

execSync(`git init --bare -b main "${BARE}"`, { stdio: 'pipe' });
git('git config uploadpack.allowFilter true', BARE);
git('git config uploadpack.allowAnySHA1InWant true', BARE);
execSync(`git clone --quiet "${BARE}" "${SEED}"`, { stdio: 'pipe' });
fs.writeFileSync(path.join(SEED, 'README.md'), '# lake viewer bundle test\n');
fs.writeFileSync(path.join(SEED, '.gitattributes'), '*.jsonl filter=lfs diff=lfs merge=lfs -text\n');
fs.mkdirSync(path.join(SEED, 'elementwise'), { recursive: true });
fs.writeFileSync(path.join(SEED, 'elementwise', '.gitkeep'), '');
git('git add .', SEED);
git('git -c user.name=seed -c user.email=seed@t commit -q -m init', SEED);
git('git push -q origin main', SEED);

seedLakeConfig(TMP, { address: BARE });
process.env.LAKE_LFS = '0';
process.env.LAKE_CACHE_DIR = CACHE;
process.env.CONTEXT_INSIGHT_HOME = HOME;

// fixture bundle（与 e2e/lake-bundle.test.ts 同构的最小包）
fs.mkdirSync(path.join(FIXTURE, 'sessions', SID), { recursive: true });
fs.writeFileSync(path.join(FIXTURE, 'workflow.json'), JSON.stringify({
  schema: 'workflow-bundle', version: 1, id: RUN_ID, kind: 'workflow',
  name: 'viewer bundle IT', startedAt: null, finishedAt: null,
  data: {
    exportDataComplete: true,
    members: [
      { id: SID, kind: 'session', name: `${SID} 执行`, startedAt: null, finishedAt: null, sessionId: SID, location: `sessions/${SID}` },
      { id: 'M1', kind: 'process', name: '打包', startedAt: null, finishedAt: null, output: { text: 'done' } },
    ],
    relations: [{ from: SID, to: 'M1', annotation: { type: 'depends_on' } }],
  },
}));
fs.writeFileSync(
  path.join(FIXTURE, 'workflow.schema.json'),
  fs.readFileSync(path.resolve(__dirname, '../data/run/workflow-bundle.v1.schema.json'), 'utf-8'),
);
fs.writeFileSync(path.join(FIXTURE, 'sessions', SID, `${SID}.jsonl`), [
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'viewer bundle 导入' }, timestamp: '2026-10-10T03:00:00.000Z' }),
  JSON.stringify({ type: 'assistant', message: { id: `msg_${SID}`, role: 'assistant', content: [{ type: 'text', text: '完成' }], model: 'test-model', usage: { input_tokens: 10, output_tokens: 2 } }, timestamp: '2026-10-10T03:00:05.000Z' }),
].join('\n') + '\n');
fs.writeFileSync(path.join(FIXTURE, 'sessions', SID, `${SID}.meta.json`), JSON.stringify({
  x_lake: { schema: 'cc-session-meta', version: 1, data: { producer: 'insight-export', framework: 'opencode', ccVersion: '1.19.0', sid: SID } },
}));

const prisma = new PrismaClient();

// env 已设，动态加载模块与路由
const bundle = await import('../../../src/lib/lake/bundle');
const bundlesRoute = await import('../../../src/app/lake_viewer/api/bundles/route');
const bundlesImportRoute = await import('../../../src/app/lake_viewer/api/bundles/import/route');
const paradigmsRoute = await import('../../../src/app/lake_viewer/api/paradigms/route');
const importService = await import('../../../src/lib/run/import-service');

function makeGet(url: string): NextRequest {
  return new NextRequest(url);
}
function makePost(url: string, body: unknown): NextRequest {
  return new NextRequest(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function waitForJob(jobId: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = importService.getImportJob(jobId);
    if (state && (state.step === 'done' || state.step === 'error')) return state;
    if (Date.now() > deadline) throw new Error(`import job ${jobId} timeout (step=${state?.step})`);
    await new Promise(r => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  // 直接 vitest（绕过 pretest 重建库）重跑时清掉上次导入的夹具行
  await prisma.session.deleteMany({ where: { taskId: SID } });
  // run 级上传链路：先本地导入（数据源 = insight）再上传
  const validation = importService.validateBundleDir(FIXTURE);
  expect(validation.ok).toBe(true);
  const jobId = importService.createImportJob(FIXTURE, validation.manifest!, { prisma, root: path.join(HOME, 'runs') });
  const state = await waitForJob(jobId);
  expect(state.step).toBe('done');
  await bundle.uploadLakeBundle(prisma, RUN_ID, '提交人: 张三\n内容描述: viewer bundle IT');
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: SID } }).catch(() => {});
  await prisma.$disconnect().catch(() => {});
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('lake_viewer bundle 视图：列表路由 + 侧栏可见性', () => {
  it('GET /api/bundles：条目字段齐全（meta/manifest 汇总）+ imported=true（本地导入后）', async () => {
    const res = await bundlesRoute.GET(makeGet('http://localhost/lake_viewer/api/bundles'));
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<Record<string, unknown>> };
    const entry = body.items.find(e => e.runId === RUN_ID);
    expect(entry).toBeTruthy();
    expect(entry!.name).toBe('viewer bundle IT');
    expect(entry!.memberCount).toBe(2);
    expect(entry!.sessionCount).toBe(1);
    expect(entry!.submitter).toBe('张三');
    expect(entry!.imported).toBe(true);
  });

  it('GET /api/paradigms：opsbot-bundle 出现在侧栏目录清单（普通范式并存）', async () => {
    const res = await paradigmsRoute.GET(makeGet('http://localhost/lake_viewer/api/paradigms'));
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ name: string }> };
    const names = body.items.map(p => p.name);
    expect(names).toContain('opsbot-bundle');
    expect(names).toContain('elementwise');
  });
});

describe('lake_viewer bundle 导入路由', () => {
  it('缺 runId → 400；不存在的 bundle → 502', async () => {
    const bad = await bundlesImportRoute.POST(makePost('http://localhost/lake_viewer/api/bundles/import', {}));
    expect(bad.status).toBe(400);
    const missing = await bundlesImportRoute.POST(makePost('http://localhost/lake_viewer/api/bundles/import', { runId: 'nosuchbundle' }));
    expect(missing.status).toBe(502);
  });

  it('POST 导入：job 完成、会话入库、列表 imported 翻转', async () => {
    const res = await bundlesImportRoute.POST(makePost('http://localhost/lake_viewer/api/bundles/import', { runId: RUN_ID }));
    expect(res.status).toBe(200);
    const handle = await res.json() as { jobId: string; state: { runId: string } };
    expect(handle.state.runId).toBe(RUN_ID);

    const state = await waitForJob(handle.jobId);
    expect(state.step).toBe('done');
    expect(state.error).toBeNull();
    // VS1 已在本地导入时入库 → lake 导入幂等走 existing
    expect(state.existing).toBe(1);

    const row = await prisma.session.findFirst({ where: { taskId: SID } });
    expect(row).toBeTruthy();
    expect(row!.framework).toBe('opencode');

    const listRes = await bundlesRoute.GET(makeGet('http://localhost/lake_viewer/api/bundles'));
    const body = await listRes.json() as { items: Array<{ runId: string; imported: boolean }> };
    expect(body.items.find(e => e.runId === RUN_ID)!.imported).toBe(true);
  });
});
