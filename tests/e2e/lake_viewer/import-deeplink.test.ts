// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 导入深链契约 e2e：lake_viewer「导入查看」的跳转链接身份。契约——
// /session/<taskId>?framework=<DB 行 recording class>，与 observe API 的
// (taskId, framework) 精确消歧同键。framework 参数的合法来源仅两处：DB 行
// 本身（已导入清单行）/ 导入结果回读（服务端刚建行）；导入前的 lake meta
// agent 名是裸归属（捕获行入库时分类器加 -proxy 记录类后缀），禁止预拼。
// 客户案：meta framework=opencode 的 cpx 捕获会话，导入后旧链接
// ?framework=opencode 被详情页消歧过滤挡成 404 空页。
// env 必须在 src 模块导入前设置（lake remote 的 env 常量在 import 时求值）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';
import { makeBareLake } from '../../ut/lake_viewer/helpers/makeLake';
import { withDbRaceRetry } from '../../db-race';
import { seedLakeConfig } from '../../helpers/lake-env';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lake-viewer-deeplink-'));
seedLakeConfig(TMP, { address: path.join(TMP, 'lake.git') });
process.env.LAKE_CACHE_DIR = path.join(TMP, 'insight-cache');
process.env.SCORING_DATA_DIR = path.join(TMP, 'scorecards');
process.env.LAKE_LFS = '0';

const prisma = new PrismaClient();

// 客户案形态：capture 位 meta framework=裸 agent 名（cpx 捕获上传），导入后
// DB 行 framework=opencode-proxy（分类器 meta 规则 + 方案一记录类后缀）
const CAP_SID = 'e2e-dl-cap0001';
// native 位：producer=insight-export 的载体声明身份（无 -proxy 后缀）
const NAT_SID = 'e2e-dl-nat0001';
const OUR_SIDS = [CAP_SID, NAT_SID];

beforeAll(async () => {
  makeBareLake(path.join(TMP, 'lake.git'), [
    {
      time: '2026-10-14T10:00:00+08:00',
      message: '提交人: dl1 内容描述: 导入深链契约批次 备注: 无',
      sessions: [
        { sid: CAP_SID, paradigm: 'deeplink', framework: 'opencode', ccVersion: '1.18.30' },
        { sid: NAT_SID, paradigm: 'deeplink', recording: 'native', framework: 'claude-code', ccVersion: '1.0.0', producer: 'insight-export' },
      ],
    },
  ]);
  await withDbRaceRetry(() => prisma.session.deleteMany({ where: { taskId: { in: OUR_SIDS } } }));
});

afterAll(async () => {
  await withDbRaceRetry(() => prisma.session.deleteMany({ where: { taskId: { in: OUR_SIDS } } }));
  await prisma.$disconnect();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

const runsReq = () => new NextRequest('http://localhost/lake_viewer/api/runs?paradigm=deeplink');
const importReq = (sid: string, recording?: 'capture' | 'native') => new NextRequest('http://localhost/lake_viewer/api/runs/import', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(recording ? { sid, recording } : { sid }),
});

interface RunRow { sid: string; recording: string; imported: boolean; insightUrl: string | null }

async function listRuns(): Promise<RunRow[]> {
  const { GET } = await import('../../../src/app/lake_viewer/api/runs/route');
  const res = await GET(runsReq());
  expect(res.status).toBe(200);
  const data = await res.json() as { items: RunRow[] };
  return data.items;
}

// 深链回环：URL 路径段 = taskId、query = framework，按 observe API（详情页
// 取数源）的参数形态解析必须命中行——这就是客户在详情页看到的最终结果
async function fetchByDeepLink(href: string): Promise<number> {
  const { GET: getSession } = await import('../../../src/app/api/observe/session/route');
  const u = new URL(href, 'http://localhost');
  const taskId = u.pathname.split('/').filter(Boolean).pop();
  const q = new URLSearchParams({ taskId: taskId! });
  const fw = u.searchParams.get('framework');
  if (fw) q.set('framework', fw);
  const res = await getSession(new NextRequest(`http://localhost/api/observe/session?${q.toString()}`));
  return res.status;
}

describe('lake_viewer 导入深链契约（framework 参数 = DB 行记录类）', () => {
  it('未导入行不伪造深链：lake meta agent 名不是记录类，导入前无从预拼', async () => {
    const items = await listRuns();
    const cap = items.find(x => x.sid === CAP_SID);
    expect(cap?.recording).toBe('capture');
    // 旧实现此处预拼 ?framework=opencode（meta 裸名）——导入完成即 404
    expect(cap?.insightUrl).toBeNull();
  });

  it('导入捕获位 → 响应回带权威深链（opencode-proxy 记录类）→ observe 回环命中', async () => {
    const { POST } = await import('../../../src/app/lake_viewer/api/runs/import/route');
    const res = await POST(importReq(CAP_SID));
    const body = await res.json().catch(() => null);
    expect(res.status, `body: ${JSON.stringify(body)}`).toBe(200);
    expect((body as { ok: boolean }).ok).toBe(true);
    expect((body as { insightUrl: string }).insightUrl).toBe(`/session/${CAP_SID}?framework=opencode-proxy`);

    // 旧链接（meta 裸名）在此处正是客户的 404；新链接必须回环命中
    expect(await fetchByDeepLink(`/session/${CAP_SID}?framework=opencode`)).toBe(404);
    expect(await fetchByDeepLink((body as { insightUrl: string }).insightUrl)).toBe(200);
  });

  it('导入后清单行深链取行级记录类（消歧命中 -proxy 行）', async () => {
    const items = await listRuns();
    const cap = items.find(x => x.sid === CAP_SID);
    expect(cap?.imported).toBe(true);
    expect(cap?.insightUrl).toBe(`/session/${CAP_SID}?framework=opencode-proxy`);
  });

  it('native 位导入深链不带 -proxy（载体声明身份，记录类 = 框架名）', async () => {
    const { POST } = await import('../../../src/app/lake_viewer/api/runs/import/route');
    const res = await POST(importReq(NAT_SID, 'native'));
    const body = await res.json().catch(() => null);
    expect(res.status, `body: ${JSON.stringify(body)}`).toBe(200);
    expect((body as { insightUrl: string }).insightUrl).toBe(`/session/${NAT_SID}?framework=claude-code`);
    expect(await fetchByDeepLink((body as { insightUrl: string }).insightUrl)).toBe(200);
  });
});
