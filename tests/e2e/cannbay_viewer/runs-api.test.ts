// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// runs 路由 e2e：本地 bare 数据湖 × 真测试库（进程内取数）。含一键导入全链路
// （物化 bare 仓 jsonl → claude-jsonl 适配 → 写库）。不设 CANNBAY_VIEWER_CACHE_DIR
// ——viewer 列表与 cannbay2 导入共用 CANNBAY2_CACHE_DIR 同一镜像（生产同款拓扑，
// 亦即「session 文件只落一处」的契约）。env 必须在 src 模块导入前设置
//（lake/cannbay2 remote 的 env 常量在 import 时求值）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';
import { makeBareLake } from '../../ut/cannbay_viewer/helpers/makeLake';
import { withDbRaceRetry } from '../../db-race';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cannbay-viewer-runsapi-'));
process.env.CANNBAY2_REMOTE_URL = path.join(TMP, 'lake.git');
process.env.CANNBAY2_PUSH_URL = path.join(TMP, 'lake.git');
process.env.CANNBAY2_CACHE_DIR = path.join(TMP, 'insight-cache');
process.env.SCORING_DATA_DIR = path.join(TMP, 'scorecards');
// 本套件测导入编排（物化→写库→状态翻转），不测 LFS bootstrap——无 git-lfs
// 的机器上默认 LFS 模式会 requireGitLfs fail-fast，fixture 显式关掉聚焦逻辑
process.env.CANNBAY2_LFS = '0';

const prisma = new PrismaClient();

const OUR_SIDS = ['e2e-aaaa1111', 'e2e-base9999', 'e2e-cccc3333', 'e2e-con2222', 'e2e-dual5555', 'e2e-legacy0', 'e2e-nat4444', 'gemm-base01'];

beforeAll(async () => {
  makeBareLake(path.join(TMP, 'lake.git'), [
    {
      time: '2026-08-01T10:00:00+08:00',
      message: 'ele first run',
      sessions: [
        { sid: 'e2e-aaaa1111', paradigm: 'elementwise', framework: 'claude-code', ccVersion: '1.2.3', opGen: 'success' },
        { sid: 'e2e-legacy0', paradigm: '', legacy: true, framework: 'opencode', ccVersion: '0.9.0' },
      ],
    },
    {
      time: '2026-09-01T10:00:00+08:00',
      message: '提交人: li4 内容描述: baseline + new runs 批次 备注: 无',
      sessions: [
        { sid: 'e2e-base9999', paradigm: 'elementwise', baseline: true, framework: 'opencode', ccVersion: '0.9.1', producer: 'insight-export' },
        // cccc 不在测试库，但 meta 带指标快照 → 未导入行也有精确耗时/Token
        { sid: 'e2e-cccc3333', paradigm: 'elementwise', framework: 'claude-code', ccVersion: '1.2.3', startTime: '2026-09-01T11:20:00+08:00', endTime: '2026-09-01T11:50:00+08:00', totalTokens: 45_000, model: 'glm-4.7' },
        { sid: 'e2e-con2222', paradigm: 'contraction', framework: 'codex', ccVersion: '2.0.0', workflow: 'wf-v3', opGen: 'failure' },
        // 原生会话双记录位：目录 e2e-nat4444.native/，目录内文件用真实 sid 命名
        { sid: 'e2e-nat4444', paradigm: 'contraction', recording: 'native', framework: 'opencode', ccVersion: '1.18.30', startTime: '2026-09-02T09:00:00+08:00', endTime: '2026-09-02T09:30:00+08:00', totalTokens: 5_000, model: 'glm-5.3-flash' },
      ],
    },
    {
      time: '2026-09-03T10:00:00+08:00',
      message: '提交人: qi8 内容描述: 同 sid 双记录对 备注: 无',
      sessions: [
        { sid: 'e2e-dual5555', paradigm: 'dualdb', framework: 'claude-code-proxy', ccVersion: '1.0.0' },
        { sid: 'e2e-dual5555', paradigm: 'dualdb', recording: 'native', framework: 'opencode', ccVersion: '1.18.30', startTime: '2026-09-03T09:00:00+08:00', endTime: '2026-09-03T09:30:00+08:00', totalTokens: 6_000, model: 'glm-5.3-flash' },
      ],
    },
  ]);
  await withDbRaceRetry(() => prisma.session.deleteMany({ where: { taskId: { in: OUR_SIDS } } }));

  // 已导入两行：aaaa + baseline（taskId 即数据仓 sid）
  await prisma.session.createMany({
    data: [
      { taskId: 'e2e-aaaa1111', framework: 'claude-code', version: '1.2.3', startTime: new Date('2026-08-01T10:05:00+08:00'), endTime: new Date('2026-08-01T10:35:00+08:00'), totalTokens: 120_000, model: 'test-model-a' },
      { taskId: 'e2e-base9999', framework: 'opencode', version: '0.9.1', startTime: new Date('2026-08-20T09:00:00+08:00'), endTime: new Date('2026-08-20T09:30:00+08:00'), totalTokens: 80_000 },
    ],
  });
});

afterAll(async () => {
  await withDbRaceRetry(() => prisma.session.deleteMany({ where: { taskId: { in: OUR_SIDS } } }));
  await prisma.$disconnect();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

const runsReq = (query: string) => new NextRequest(`http://localhost/cannbay_viewer/api/runs?${query}`);
const importReq = (sid: string, recording?: 'capture' | 'native') => new NextRequest('http://localhost/cannbay_viewer/api/runs/import', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(recording ? { sid, recording } : { sid }),
});

interface ApiRun {
  sid: string;
  imported: boolean;
  durationMs: number | null;
  totalTokens: number | null;
  model: string | null;
  startTime: string | null;
  startTimeApprox: boolean;
  description: string | null;
  author: string | null;
}

describe('GET /cannbay_viewer/api/runs', () => {
  it('混合口径 join：已导入出指标、未导入降级、baseline 在列', async () => {
    const { GET } = await import('../../../src/app/cannbay_viewer/api/runs/route');
    const res = await GET(runsReq('paradigm=elementwise'));
    expect(res.status).toBe(200);
    const data = await res.json() as { total: number; baselineSid: string | null; items: ApiRun[] };
    expect(data.baselineSid).toBe('e2e-base9999');
    expect(data.total).toBe(3);
    const bySid = new Map(data.items.map(x => [x.sid, x]));

    expect(bySid.get('e2e-aaaa1111')?.imported).toBe(true);
    expect(bySid.get('e2e-aaaa1111')?.durationMs).toBe(30 * 60_000);
    expect(bySid.get('e2e-aaaa1111')?.totalTokens).toBe(120_000);
    expect(bySid.get('e2e-aaaa1111')?.model).toBe('test-model-a');

    const cccc = bySid.get('e2e-cccc3333');
    expect(cccc?.imported).toBe(false);
    // 未导入行展示 meta 指标快照（spec §4.4），无需先导入
    expect(cccc?.durationMs).toBe(30 * 60_000);
    expect(cccc?.totalTokens).toBe(45_000);
    expect(cccc?.model).toBe('glm-4.7');
    expect(cccc?.startTimeApprox).toBe(false);
    expect(cccc?.description).toBe('baseline + new runs 批次');
    expect(cccc?.author).toBe('li4');

    expect(bySid.get('e2e-base9999')?.imported).toBe(true);
  });

  it('缺 paradigm → 400', async () => {
    const { GET } = await import('../../../src/app/cannbay_viewer/api/runs/route');
    const res = await GET(runsReq('framework=claude-code'));
    expect(res.status).toBe(400);
  });
});

describe('GET /cannbay_viewer/api/paradigms', () => {
  it('范式清单（目录即注册表）', async () => {
    const { GET } = await import('../../../src/app/cannbay_viewer/api/paradigms/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json() as { items: Array<{ name: string; runCount: number }> };
    const names = data.items.map(p => p.name);
    expect(names).toContain('elementwise');
    expect(names).toContain('contraction');
    expect(names).not.toContain('sessions');
  });
});

describe('镜像目录共用（session 文件只落一处）', () => {
  it('viewer 默认镜像 = insight cannbay2 默认镜像（不设 CANNBAY_VIEWER_CACHE_DIR 时）', async () => {
    const { resolveLakeRemote } = await import('../../../src/app/cannbay_viewer/_lib/lake/remote');
    const { resolveCannbay2Remote } = await import('../../../src/lib/cannbay2/remote');
    expect(resolveLakeRemote().cacheDir).toBe(resolveCannbay2Remote().cacheDir);
  });

  it('冷启动锁不跨克隆：viewer 异步克隆期间 cannbay2 同步 ensure 不死锁', async () => {
    const coldDir = path.join(TMP, 'cold-shared');
    process.env.CANNBAY2_CACHE_DIR = coldDir;
    process.env.CANNBAY_VIEWER_CACHE_DIR = coldDir;
    try {
      const viewerMirror = await import('../../../src/app/cannbay_viewer/_lib/lake/mirror');
      const cannbay2Mirror = await import('../../../src/lib/cannbay2/mirror');
      const pending = viewerMirror.ensureMirrorAsync();
      // viewer 克隆进行中触发 cannbay2 同步路径：若 viewer 把锁握在异步克隆上，
      // 这里 withMirrorInitLock 的 Atomics.wait 自旋会阻塞事件循环 → 上面的
      // Promise 永不完成 → 本用例超时失败（回归哨兵）
      const dir2 = cannbay2Mirror.ensureMirror();
      expect(fs.existsSync(path.join(dir2, '.git'))).toBe(true);
      const dir1 = await pending;
      expect(fs.existsSync(path.join(dir1, '.git'))).toBe(true);
    } finally {
      delete process.env.CANNBAY_VIEWER_CACHE_DIR;
      process.env.CANNBAY2_CACHE_DIR = path.join(TMP, 'insight-cache');
    }
  });
});

describe('POST /cannbay_viewer/api/runs/import（一键导入全链路）', () => {
  it('导入 bare 仓会话 → 写库 → 该行转已导入并出指标', async () => {
    const { GET: getRuns } = await import('../../../src/app/cannbay_viewer/api/runs/route');
    const { POST } = await import('../../../src/app/cannbay_viewer/api/runs/import/route');

    const before = await (await getRuns(runsReq('paradigm=elementwise'))).json() as { items: ApiRun[] };
    expect(before.items.find(x => x.sid === 'e2e-cccc3333')?.imported).toBe(false);

    const res = await POST(importReq('e2e-cccc3333'));
    const body0 = await res.json().catch(() => null);
    expect(res.status, `body: ${JSON.stringify(body0)}`).toBe(200);
    expect((body0 as { ok: boolean }).ok).toBe(true);

    const after = await (await getRuns(runsReq('paradigm=elementwise'))).json() as { items: ApiRun[] };
    const row = after.items.find(x => x.sid === 'e2e-cccc3333');
    expect(row?.imported).toBe(true);
    // 会话行真实落库（taskId 即 sid）
    const dbRow = await prisma.session.findFirst({ where: { taskId: 'e2e-cccc3333' }, select: { id: true } });
    expect(dbRow).toBeTruthy();
  });

  it('导入 native 位会话（.native 目录）→ 写库 → 行转已导入', async () => {
    const { GET: getRuns } = await import('../../../src/app/cannbay_viewer/api/runs/route');
    const { POST } = await import('../../../src/app/cannbay_viewer/api/runs/import/route');

    const before = await (await getRuns(runsReq('paradigm=contraction'))).json() as { items: Array<ApiRun & { recording?: string }> };
    const natRow = before.items.find(x => x.sid === 'e2e-nat4444');
    // 列表层（回归：native 目录 meta 此前读不出 → 工具未知/时间为上传时刻）
    expect(natRow?.recording).toBe('native');
    expect(natRow?.imported).toBe(false);
    expect(natRow?.model).toBe('glm-5.3-flash');
    expect(natRow?.startTimeApprox).toBe(false);
    expect(natRow?.startTime).toBe('2026-09-02T09:00:00+08:00');

    const res = await POST(importReq('e2e-nat4444', 'native'));
    const body1 = await res.json().catch(() => null);
    expect(res.status, `body: ${JSON.stringify(body1)}`).toBe(200);
    expect((body1 as { ok: boolean }).ok).toBe(true);

    const after = await (await getRuns(runsReq('paradigm=contraction'))).json() as { items: ApiRun[] };
    expect(after.items.find(x => x.sid === 'e2e-nat4444')?.imported).toBe(true);
    const dbRow = await prisma.session.findFirst({ where: { taskId: 'e2e-nat4444' }, select: { id: true } });
    expect(dbRow).toBeTruthy();
  });

  it('双记录只导 native → capture 行仍为未导入，不借显他行指标（review 回归）', async () => {
    const { GET: getRuns } = await import('../../../src/app/cannbay_viewer/api/runs/route');
    const { POST } = await import('../../../src/app/cannbay_viewer/api/runs/import/route');

    const res = await POST(importReq('e2e-dual5555', 'native'));
    const body2 = await res.json().catch(() => null);
    expect(res.status, `body: ${JSON.stringify(body2)}`).toBe(200);

    const after = await (await getRuns(runsReq('paradigm=dualdb'))).json() as { items: Array<ApiRun & { recording?: string }> };
    const nat = after.items.find(x => x.sid === 'e2e-dual5555' && x.recording === 'native');
    const cap = after.items.find(x => x.sid === 'e2e-dual5555' && x.recording === 'capture');
    expect(nat?.imported).toBe(true);
    // 此前：单键 map 只剩一行 → 两条 lake 行都命中 → capture 行错标已导入
    expect(cap?.imported).toBe(false);
    // capture 行指标仍来自自身 meta 快照，未被 native 行污染
    expect(cap?.model).toBeNull();
    expect(cap?.totalTokens).toBeNull();
  });

  it('未知 sid → 502（物化失败上抛为导入错误）', async () => {
    const { POST } = await import('../../../src/app/cannbay_viewer/api/runs/import/route');
    const res = await POST(importReq('no-such-sid-anywhere'));
    expect(res.status).toBe(502);
  });

  it('缺 sid → 400', async () => {
    const { POST } = await import('../../../src/app/cannbay_viewer/api/runs/import/route');
    const res = await POST(new NextRequest('http://localhost/cannbay_viewer/api/runs/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }));
    expect(res.status).toBe(400);
  });
});
