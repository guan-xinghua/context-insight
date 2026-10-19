// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 车道表 route IT：三级解析。① 湖范式命中（声明即信任，source=paradigm）
// ② 范式缺失/未配置（本地会话未上湖、sessions/ 通用目录）→ 桥派发描述
// 内容签名推断（source=inferred，本地 op-fusion 会话的核心场景）③ 内容
// 不过阈 → 空表回落贪心（source=null）。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { prisma } from '../setup';

const lakeSessions = [
  { sid: 'ses-lane-it-known', paradigm: 'op-fusion' },
  { sid: 'ses-lane-it-unknown', paradigm: 'op-split' },
  { sid: 'ses-lane-it-sessions', paradigm: 'sessions' },
];
vi.mock('@/app/lake_viewer/_lib/runs', () => ({
  getLakeListing: async () => ({ sessions: lakeSessions, paradigms: [], baselineByParadigm: new Map(), head: null }),
}));

import { GET } from '@/app/api/observe/session/lanes/route';

const KNOWN = 'ses-lane-it-known';
const UNKNOWN = 'ses-lane-it-unknown';
const NOLAKE = 'ses-lane-it-nolake';
const SESSIONS_DIR = 'ses-lane-it-sessions';
const WEAK = 'ses-lane-it-weak';
const DUAL = 'ses-lane-it-dual';

const OP_FUSION_DISPATCHES = [
  'P1 需求分析', 'R 门控：P1 审核',
  '④ 模板计算流：base', '④ 模板计算流：group',
  'R 门控：④ base 审核', '④.5 存活节点：group', '⑤ VF 融合：base',
];

beforeAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: { in: [KNOWN, UNKNOWN, NOLAKE, SESSIONS_DIR, WEAK, DUAL] } } });
  const ids: Record<string, string> = {};
  for (const taskId of [KNOWN, UNKNOWN, NOLAKE, SESSIONS_DIR, WEAK]) {
    const s = await prisma.session.create({ data: { taskId, framework: 'opencode' } });
    ids[taskId] = s.id;
  }
  // 同 sid 双记录：桥只在 proxy 行——framework 消歧后推断必须读对行的桥
  const dualProxy = await prisma.session.create({ data: { taskId: DUAL, framework: 'opencode-proxy' } });
  await prisma.session.create({ data: { taskId: DUAL, framework: 'opencode' } });
  await prisma.interactionBridge.createMany({
    data: OP_FUSION_DISPATCHES.map(dispatchContent => ({
      sessionId: dualProxy.id, dispatchExecutionId: 'exec-lane-it', dispatchContent, status: 'completed',
    })),
  });
  // 本地/通用目录会话的桥：op-fusion 形态派发描述（7 条有效，5 命中，率 0.71）
  for (const taskId of [NOLAKE, SESSIONS_DIR]) {
    await prisma.interactionBridge.createMany({
      data: OP_FUSION_DISPATCHES.map(dispatchContent => ({
        sessionId: ids[taskId], dispatchExecutionId: 'exec-lane-it', dispatchContent, status: 'completed',
      })),
    });
  }
  // 弱内容会话：10 条里 1 条含 base（率 0.1、单车道）
  await prisma.interactionBridge.createMany({
    data: Array.from({ length: 10 }, (_, i) => ({
      sessionId: ids[WEAK], dispatchExecutionId: 'exec-lane-it',
      dispatchContent: i === 0 ? 'base 知识库检索' : `前置阶段 ${i}`, status: 'completed',
    })),
  });
  // 范式命中的会话也放弱内容桥：声明即信任，不进推断、不被内容推翻
  await prisma.interactionBridge.createMany({
    data: [{ sessionId: ids[KNOWN], dispatchExecutionId: 'exec-lane-it', dispatchContent: 'P1 需求分析', status: 'completed' }],
  });
}, 60_000);
afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: { in: [KNOWN, UNKNOWN, NOLAKE, SESSIONS_DIR, WEAK, DUAL] } } }).catch(() => {});
});

async function get(taskId: string) {
  const res = await GET(new NextRequest(`http://localhost/api/observe/session/lanes?taskId=${taskId}&framework=opencode`));
  return { status: res.status, body: await res.json() as { paradigm: string | null; lanes: string[]; source: string | null } };
}

describe('lanes route：范式声明 × 内容签名推断', () => {
  it('湖范式命中 → 声明即信任（弱内容不推翻），source=paradigm', async () => {
    const { status, body } = await get(KNOWN);
    expect(status).toBe(200);
    expect(body.paradigm).toBe('op-fusion');
    expect(body.lanes).toEqual(['base', 'group', 'empty']);
    expect(body.source).toBe('paradigm');
  });

  it('范式未配置且无过阈内容 → 空表（回落贪心）', async () => {
    const { body } = await get(UNKNOWN);
    expect(body.paradigm).toBe('op-split');
    expect(body.lanes).toEqual([]);
    expect(body.source).toBeNull();
  });

  it('本地会话（湖无此 sid）+ op-fusion 派发描述 → 推断命中，source=inferred', async () => {
    const { body } = await get(NOLAKE);
    expect(body.paradigm).toBe('op-fusion');
    expect(body.lanes).toEqual(['base', 'group', 'empty']);
    expect(body.source).toBe('inferred');
  });

  it('通用目录范式（sessions，无配置键）+ 过阈内容 → 推断命中（现场 f31a 形态）', async () => {
    const { body } = await get(SESSIONS_DIR);
    expect(body.paradigm).toBe('op-fusion');
    expect(body.lanes).toEqual(['base', 'group', 'empty']);
    expect(body.source).toBe('inferred');
  });

  it('弱内容（率 0.1、单车道）→ 空表 + 保留原范式', async () => {
    const { body } = await get(WEAK);
    expect(body.paradigm).toBeNull();
    expect(body.lanes).toEqual([]);
    expect(body.source).toBeNull();
  });

  it('同 sid 双记录：framework 消歧读对行的桥（桥在 proxy 行）', async () => {
    const res = await GET(new NextRequest(`http://localhost/api/observe/session/lanes?taskId=${DUAL}&framework=opencode-proxy`));
    const body = await res.json() as { paradigm: string | null; lanes: string[]; source: string | null };
    expect(body.paradigm).toBe('op-fusion');
    expect(body.lanes).toEqual(['base', 'group', 'empty']);
    expect(body.source).toBe('inferred');
    // 消歧到无桥的另一行：推断不越行借数据
    const res2 = await GET(new NextRequest(`http://localhost/api/observe/session/lanes?taskId=${DUAL}&framework=opencode`));
    const body2 = await res2.json() as { paradigm: string | null; lanes: string[]; source: string | null };
    expect(body2.lanes).toEqual([]);
    expect(body2.source).toBeNull();
  });
});
