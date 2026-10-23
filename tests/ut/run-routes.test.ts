// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// run 域 API 路由 IT（页面/API 层验证）：runs 列表 / run 详情（join 注入）/
// 成员五键 / 反向归属 / 删除 / import-bundle 入口校验（含白名单闸）与
// job 状态查询。存储走临时 CONTEXT_INSIGHT_HOME，prisma mock（详情路由的
// 会话 join 只读两查询）。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fakePrisma = {
  session: { findMany: vi.fn(), deleteMany: vi.fn(), delete: vi.fn() },
  turn: { groupBy: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() },
  toolCall: { findMany: vi.fn(), deleteMany: vi.fn() },
  skillEvent: { deleteMany: vi.fn() },
  execution: { deleteMany: vi.fn() },
  executionSkill: { deleteMany: vi.fn() },
  sessionSkill: { deleteMany: vi.fn() },
  interactionBridge: { deleteMany: vi.fn() },
  $transaction: vi.fn(),
};
vi.mock('@/lib/db', () => ({ prisma: fakePrisma }));

const { GET: listRunsGET } = await import('@/app/api/observe/runs/route');
const { GET: runDetailGET, DELETE: runDetailDELETE } = await import('@/app/api/observe/run/[runId]/route');
const { GET: memberGET } = await import('@/app/api/observe/run/[runId]/member/route');
const { GET: bySessionGET } = await import('@/app/api/observe/run/by-session/[taskId]/route');
const { POST: importBundlePOST } = await import('@/app/api/ingest/import-bundle/route');
const { GET: importStatusGET } = await import('@/app/api/ingest/import-bundle/status/route');
const { saveRun, readRun } = await import('@/lib/run/run-store');
const { parseManifest } = await import('@/lib/run/reader');
const { getImportJob } = await import('@/lib/run/import-service');

/** 轮询 job 到终态（done/error）：保证后台写盘在 tmpHome 清理前收尾。 */
async function waitForJob(jobId: string, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = getImportJob(jobId);
    if (!job || job.step === 'done' || job.step === 'error') return;
    if (Date.now() > deadline) throw new Error(`job ${jobId} 未在 ${timeoutMs}ms 内收尾`);
    await new Promise(r => setTimeout(r, 100));
  }
}

const MINI_BUNDLE = path.resolve(__dirname, './data/run/mini-bundle');
const miniManifest = parseManifest(JSON.parse(fs.readFileSync(path.join(MINI_BUNDLE, 'workflow.json'), 'utf-8')));

let tmpHome: string;
const ENV_KEYS = ['CONTEXT_INSIGHT_HOME', 'CONTEXT_INSIGHT_IMPORT_ROOTS'] as const;
const ORIG_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-run-api-'));
  for (const k of ENV_KEYS) ORIG_ENV[k] = process.env[k];
  process.env.CONTEXT_INSIGHT_HOME = tmpHome;
  delete process.env.CONTEXT_INSIGHT_IMPORT_ROOTS;
  fakePrisma.session.findMany.mockReset().mockResolvedValue([]);
  fakePrisma.session.deleteMany.mockReset();
  fakePrisma.session.delete.mockReset();
  fakePrisma.turn.groupBy.mockReset().mockResolvedValue([]);
  fakePrisma.turn.findMany.mockReset().mockResolvedValue([]);
  fakePrisma.toolCall.findMany.mockReset().mockResolvedValue([]);
  fakePrisma.$transaction.mockReset().mockResolvedValue([]);
  // 预置 mini run（graph-demo 结构断言走 reader/view-model IT，这里覆盖链路）
  saveRun(miniManifest, null, path.join(tmpHome, 'runs'));
});

afterEach(() => {
  for (const [k, v] of Object.entries(ORIG_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function get(apiPath: string): never {
  return { nextUrl: new URL(`http://localhost${apiPath}`) } as never;
}
function post(apiPath: string, body: unknown): never {
  return {
    nextUrl: new URL(`http://localhost${apiPath}`),
    json: async () => body,
  } as never;
}
function del(apiPath: string): never {
  return { nextUrl: new URL(`http://localhost${apiPath}`) } as never;
}
const paramsOf = async <T>(p: T) => ({ params: p }) as never;

describe('GET /api/observe/runs', () => {
  it('列表：预置 mini run + 派生统计', async () => {
    const res = await listRunsGET(get('/api/observe/runs'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.runs).toHaveLength(1);
    expect(data.runs[0]).toMatchObject({
      runId: 'minidemo01',
      name: 'mini-bundle',
      rollbackCount: 1,
      subgraphCount: 1,
      memberCount: 11,
    });
  });
});

describe('GET /api/observe/run/[runId]', () => {
  it('详情：view-model + 会话 join 注入（mock prisma 两行）', async () => {
    fakePrisma.session.findMany.mockResolvedValue([
      {
        id: 'row_a', taskId: 'ses_mini_a', framework: 'opencode', label: null,
        startTime: new Date('2026-10-13T02:00:12Z'), endTime: new Date('2026-10-13T02:00:17Z'),
        totalTokens: 15, totalLatencyMs: 5000,
      },
    ]);
    fakePrisma.turn.groupBy.mockResolvedValue([{ sessionId: 'row_a', _count: { _all: 1 }, _max: { contextWindowPct: 72.5 } }]);

    const res = await runDetailGET(get('/api/observe/run/minidemo01'), await paramsOf(Promise.resolve({ runId: 'minidemo01' })));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.run.runId).toBe('minidemo01');
    expect(data.viewModel.nodes.length).toBeGreaterThan(0);
    // join 注入：build g0 执行成员的 session 引用带 turns/framework/上下文峰值水位
    const build0 = data.viewModel.nodes.find(
      (n: { nodeId: string; generation: number }) => n.nodeId === 'build' && n.generation === 0,
    );
    expect(build0.attempts[0].executeMember.session).toMatchObject({
      taskId: 'ses_mini_a', framework: 'opencode', turns: 1, contextPeakPct: 72.5,
    });
    // 缺正文成员（mock 只返回一行）：verify 成员 session=null
    expect(build0.attempts[0].verifyMember.session).toBeNull();
  });

  it('详情：会话评分融合——turns+toolCalls 批量采集后 ruleScores 注入成员引用', async () => {
    fakePrisma.session.findMany.mockResolvedValue([
      {
        id: 'row_a', taskId: 'ses_mini_a', framework: 'opencode', label: null,
        startTime: new Date('2026-10-13T02:00:12Z'), endTime: new Date('2026-10-13T02:00:17Z'),
        totalTokens: 15, totalLatencyMs: 5000,
      },
    ]);
    fakePrisma.turn.groupBy.mockResolvedValue([{ sessionId: 'row_a', _count: { _all: 1 }, _max: { contextWindowPct: null } }]);
    const turnRow = (i: number) => ({
      sessionId: 'row_a', id: `t${i}`, turnIndex: i, role: 'assistant', agentName: null,
      isSubagent: false, subagentSessionId: null, contentSummary: null, content: null,
      totalTokens: 100, inputTokens: 100, inputMessagesTokens: 100, latencyMs: 10,
      createdAt: null, createdAt_ts: null, model: null,
    });
    const callRow = (i: number, args: string) => ({
      id: `c${i}`, toolName: 'Bash', argsJson: args, resultJson: null, state: 'ok',
      errorType: null, durationMs: 0, startedAt: null, completedAt: null, errorMessage: null,
      turn: { sessionId: 'row_a', turnIndex: 0, isSubagent: false, agentName: null },
    });
    fakePrisma.turn.findMany.mockResolvedValue([turnRow(0), turnRow(1)]);
    // 3 连发同参数（原样重复）+ 3 个互异调用 → 冗余分 <1、findings 浮出 D5.repeat
    fakePrisma.toolCall.findMany.mockResolvedValue([
      callRow(0, '{"cmd":"git status"}'),
      callRow(1, '{"cmd":"git status"}'),
      callRow(2, '{"cmd":"git status"}'),
      callRow(3, '{"cmd":"make"}'),
      callRow(4, '{"cmd":"ls"}'),
      callRow(5, '{"cmd":"pwd"}'),
    ]);

    const res = await runDetailGET(get('/api/observe/run/minidemo01'), await paramsOf(Promise.resolve({ runId: 'minidemo01' })));
    expect(res.status).toBe(200);
    const data = await res.json();
    const build0 = data.viewModel.nodes.find(
      (n: { nodeId: string; generation: number }) => n.nodeId === 'build' && n.generation === 0,
    );
    const scores = build0.attempts[0].executeMember.session.ruleScores;
    expect(scores.d5).toBeLessThan(1);
    expect(scores.findings.some((f: { itemId: string }) => f.itemId === 'D5.repeat')).toBe(true);
    // 采集走了批量 in 查询（按落库行 id，非源 sid）
    expect(fakePrisma.toolCall.findMany.mock.calls[0][0].where).toEqual({ turn: { sessionId: { in: ['row_a'] } } });
  });

  it('未知 run → 404；非法 runId → 404（不炸）', async () => {
    const missing = await runDetailGET(get('/api/observe/run/nope'), await paramsOf(Promise.resolve({ runId: 'nope' })));
    expect(missing.status).toBe(404);
    const evil = await runDetailGET(get('/api/observe/run/..%2Fetc'), await paramsOf(Promise.resolve({ runId: '../etc' })));
    expect(evil.status).toBe(404);
  });
});

describe('GET /api/observe/run/[runId]/member', () => {
  it('五键节点详情：attempts + 跨代 peers + 触发的回滚', async () => {
    const res = await memberGET(
      get('/api/observe/run/minidemo01/member?nodeId=build&generation=0'),
      await paramsOf(Promise.resolve({ runId: 'minidemo01' })),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.node.nodeId).toBe('build');
    expect(data.node.attempts[0].status).toBe('failed');
    expect(data.node.attempts[0].verification).toMatchObject({ type: 'agent', status: 'failed' });
    expect(data.peers).toEqual([{ key: 'n-build-g1', generation: 1, status: 'passed' }]);
    expect(data.rollbacks).toHaveLength(1);
    expect(data.rollbacks[0].to).toMatchObject({ nodeId: 'build', generation: 1, attempt: 1 });
  });

  it('缺参 → 400；成员不存在 → 404', async () => {
    const noParam = await memberGET(
      get('/api/observe/run/minidemo01/member?nodeId=build'),
      await paramsOf(Promise.resolve({ runId: 'minidemo01' })),
    );
    expect(noParam.status).toBe(400);
    const missing = await memberGET(
      get('/api/observe/run/minidemo01/member?nodeId=ghost&generation=0'),
      await paramsOf(Promise.resolve({ runId: 'minidemo01' })),
    );
    expect(missing.status).toBe(404);
  });
});

describe('GET /api/observe/run/by-session/[taskId]', () => {
  it('反向归属：按 sid 扫 manifest（不触 DB）', async () => {
    const res = await bySessionGET(
      get('/api/observe/run/by-session/ses_mini_a'),
      await paramsOf(Promise.resolve({ taskId: 'ses_mini_a' })),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.memberships).toEqual([
      {
        runId: 'minidemo01', runName: 'mini-bundle', nodeId: 'build',
        generation: 0, attempt: 1, role: 'execute',
        memberName: 'build：第 0 代第 1 次执行', kind: 'session',
      },
    ]);
    expect(fakePrisma.session.findMany).not.toHaveBeenCalled();
  });

  it('无归属会话 → 空数组（徽标零渲染）', async () => {
    const res = await bySessionGET(
      get('/api/observe/run/by-session/ses_unknown'),
      await paramsOf(Promise.resolve({ taskId: 'ses_unknown' })),
    );
    const data = await res.json();
    expect(data.memberships).toEqual([]);
  });
});

describe('DELETE /api/observe/run/[runId]', () => {
  it('删除 run 目录（无 owned 登记 → 零会话级联动作）', async () => {
    const res = await runDetailDELETE(
      del('/api/observe/run/minidemo01'),
      await paramsOf(Promise.resolve({ runId: 'minidemo01' })),
    );
    expect(res.status).toBe(200);
    expect(readRun('minidemo01', path.join(tmpHome, 'runs'))).toBeNull();
    expect(fakePrisma.session.deleteMany).not.toHaveBeenCalled(); // 无级联删除动作
  });

  it('级联清理 owned 会话行（run 导入的行删除，依赖序单事务）', async () => {
    // 重新预置：meta 带 ownedSessions（模拟 bundle 导入后的 run）
    saveRun(
      miniManifest,
      {
        schema: 'insight-run-import',
        version: 1,
        data: {
          importedAt: '2026-10-15T10:00:00+08:00',
          sourceDir: '/bundle/mini',
          manifestFile: 'workflow.json',
          exportDataComplete: true,
          sessions: { total: 4, imported: 4, existing: 0, missingFile: 0, failed: 0 },
          failures: [],
          warnings: [],
          ownedSessions: [
            { sid: 'ses_mini_a', framework: 'opencode' },
            { sid: 'ses_mini_b', framework: 'claude-code' },
          ],
        },
      },
      path.join(tmpHome, 'runs'),
    );
    fakePrisma.session.findMany.mockResolvedValue([
      { id: 'row-a', taskId: 'ses_mini_a', framework: 'opencode' },
      { id: 'row-b', taskId: 'ses_mini_b', framework: 'claude-code' },
    ]);
    fakePrisma.$transaction.mockReset().mockResolvedValue([]);
    fakePrisma.session.deleteMany.mockReset();

    const res = await runDetailDELETE(
      del('/api/observe/run/minidemo01'),
      await paramsOf(Promise.resolve({ runId: 'minidemo01' })),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deletedSessions).toBe(2);
    // 级联 = 依赖序单事务（8 组清理，session 行按 id 集删除）
    expect(fakePrisma.$transaction).toHaveBeenCalledTimes(1);
    const ops = fakePrisma.$transaction.mock.calls[0][0] as unknown[];
    expect(ops).toHaveLength(8);
    expect(fakePrisma.session.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['row-a', 'row-b'] } },
    });
    expect(readRun('minidemo01', path.join(tmpHome, 'runs'))).toBeNull();
  });

  it('未知 run → 404', async () => {
    const res = await runDetailDELETE(
      del('/api/observe/run/no-such-run'),
      await paramsOf(Promise.resolve({ runId: 'no-such-run' })),
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /api/ingest/import-bundle', () => {
  it('缺 dirPath → 400；目录不存在 → 404；缺 workflow.json → 400（不起 job）', async () => {
    expect((await importBundlePOST(post('/api/ingest/import-bundle', {}))).status).toBe(400);
    expect((await importBundlePOST(post('/api/ingest/import-bundle', { dirPath: '/nonexistent' }))).status).toBe(404);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-no-bundle-'));
    try {
      const res = await importBundlePOST(post('/api/ingest/import-bundle', { dirPath: empty }));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.reason).toBe('bundle-manifest-missing');
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('白名单收紧（CONTEXT_INSIGHT_IMPORT_ROOTS）→ 403 先于文件读取', async () => {
    process.env.CONTEXT_INSIGHT_IMPORT_ROOTS = path.join(tmpHome, 'allowed');
    const res = await importBundlePOST(post('/api/ingest/import-bundle', { dirPath: MINI_BUNDLE }));
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.reason).toBe('path-outside-import-roots');
  });

  it('合法 bundle（白名单内）→ 起 job 返回 jobId（后台导入）', async () => {
    process.env.CONTEXT_INSIGHT_IMPORT_ROOTS = MINI_BUNDLE;
    const res = await importBundlePOST(post('/api/ingest/import-bundle', { dirPath: MINI_BUNDLE }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.runId).toBe('minidemo01');
    expect(data.jobId).toMatch(/^job-/);
    // job 用 mock prisma（本文件级 mock）→ 会话导入失败计数，但 job 正常收尾
    await waitForJob(data.jobId);
  });
});

describe('GET /api/ingest/import-bundle/status', () => {
  it('未知 jobId → 404；缺参 → 400', async () => {
    expect((await importStatusGET(get('/api/ingest/import-bundle/status'))).status).toBe(400);
    const res = await importStatusGET(get('/api/ingest/import-bundle/status?jobId=ghost'));
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.reason).toBe('job-not-found');
  });

  it('刚创建的 job 可查询（runId 透传）', async () => {
    const started = await importBundlePOST(post('/api/ingest/import-bundle', { dirPath: MINI_BUNDLE }));
    const { jobId } = await started.json();
    const res = await importStatusGET(get(`/api/ingest/import-bundle/status?jobId=${jobId}`));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.job.jobId).toBe(jobId);
    expect(data.job.runId).toBe('minidemo01');
    expect(['validate', 'store', 'import', 'done']).toContain(data.job.step);
    await waitForJob(jobId);
  });
});
