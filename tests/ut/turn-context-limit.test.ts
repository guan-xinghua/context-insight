// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License).
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// contextWindowLimit 窗口基数一致性 IT：turn 无 model（user turn 常态，user 消息
// 落库不带 model）时回退会话级 model——修复前 null 一律落 200k 全局默认，同一
// glm-5.3 会话 root 卡片按 1M、subagent user turn 卡片按 200k 各说各话（现场：
// 34.1kt 系统隐藏开销被算成 17%，实际应为 3.4%）。混模会话（PR review ①）：
// subagent 的 null-model turn 回退该 subagent 自己首个 assistant turn 的 model
// （assistant 落库带的是它自己 jsonl 的 model，可与 root 不同），不能回退 root
// 会话 model。覆盖两个读侧 API：turn 详情（含 -continuation 合成轮）与 turns
// 列表（含 continuation 条目）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { prisma } from '../setup';
import { GET as turnsListGet } from '@/app/api/observe/session/turns/route';
import { GET as turnDetailGet, __clearTurnDetailCaches } from '@/app/api/observe/session/turns/[turnId]/route';

const TASK_GLM = 'ctx-limit-it-glm53';
const TASK_NOMODEL = 'ctx-limit-it-nomodel';
const TASK_MIX = 'ctx-limit-it-mixed';
const SUB_MIX = 'sub-mixed-model';

let turnUser: string;
let turnAsst: string;
let turnEmptyModel: string;
let turnCompaction: string;
let turnUserNoModel: string;
let turnSubUser: string;
let turnSubCompaction: string;

beforeAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: { in: [TASK_GLM, TASK_NOMODEL, TASK_MIX] } } });
  __clearTurnDetailCaches();

  const glm = await prisma.session.create({ data: { taskId: TASK_GLM, model: 'glm-5.3' } });
  turnUser = (await prisma.turn.create({
    data: { sessionId: glm.id, turnIndex: 1, role: 'user', content: '提问' },
  })).id;
  turnAsst = (await prisma.turn.create({
    data: { sessionId: glm.id, turnIndex: 2, role: 'assistant', model: 'glm-5.3' },
  })).id;
  turnEmptyModel = (await prisma.turn.create({
    data: { sessionId: glm.id, turnIndex: 4, role: 'user', content: '空串 model 也算缺失', model: '' },
  })).id;
  // opencode 形态的压缩轮：agentName=compaction 的 assistant turn，列表 API 会
  // 在其后合成 -continuation 条目。带上与主链路不同的 model（摘要常用小模型，
  // opencode-db 落库不区分 agent='compaction'）——合成 continuation 的基数
  // 必须与主链路同源，不能取 compaction turn 自己的 model
  turnCompaction = (await prisma.turn.create({
    data: { sessionId: glm.id, turnIndex: 3, role: 'assistant', agentName: 'compaction', contentSummary: '压缩摘要', model: 'claude-sonnet-4' },
  })).id;

  const noModel = await prisma.session.create({ data: { taskId: TASK_NOMODEL } });
  turnUserNoModel = (await prisma.turn.create({
    data: { sessionId: noModel.id, turnIndex: 1, role: 'user', content: '提问' },
  })).id;

  // 混模会话：root glm-5.3（1M），subagent 自己跑 claude-sonnet-4（200k）——
  // subagent 的 user turn 回退须取 subagent 的 model，不能拿 root 的 1M
  const mix = await prisma.session.create({ data: { taskId: TASK_MIX, model: 'glm-5.3' } });
  turnSubUser = (await prisma.turn.create({
    data: { sessionId: mix.id, turnIndex: 10, role: 'user', isSubagent: true, subagentSessionId: SUB_MIX, content: 'subagent 提问' },
  })).id;
  await prisma.turn.create({
    data: { sessionId: mix.id, turnIndex: 11, role: 'assistant', isSubagent: true, subagentSessionId: SUB_MIX, model: 'claude-sonnet-4' },
  });
  // subagent 侧压缩轮带 root 的 model（判别用：取 compaction 自己的 model 会
  // 得 1M，取 subagent 的 model 得 200k——正确值是后者）
  turnSubCompaction = (await prisma.turn.create({
    data: { sessionId: mix.id, turnIndex: 12, role: 'assistant', isSubagent: true, subagentSessionId: SUB_MIX, agentName: 'compaction', contentSummary: 'subagent 压缩摘要', model: 'glm-5.3' },
  })).id;
  await prisma.turn.create({
    data: { sessionId: mix.id, turnIndex: 1, role: 'user', content: 'root 提问' },
  });
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: { in: [TASK_GLM, TASK_NOMODEL, TASK_MIX] } } }).catch(() => {});
});

async function getTurnDetail(turnId: string) {
  const res = await turnDetailGet(
    new NextRequest(`http://localhost/api/observe/session/turns/${turnId}`),
    { params: Promise.resolve({ turnId }) },
  );
  return { status: res.status, body: await res.json() as { contextWindowLimit?: number; model?: string | null } };
}

describe('contextWindowLimit：turn 无 model 回退会话级 model', () => {
  it('turn 详情：user turn（model null）与同会话 assistant turn 同基 1M', async () => {
    const user = await getTurnDetail(turnUser);
    expect(user.status).toBe(200);
    expect(user.body.model).toBeNull();
    expect(user.body.contextWindowLimit).toBe(1000000);
    const asst = await getTurnDetail(turnAsst);
    expect(asst.body.model).toBe('glm-5.3');
    expect(asst.body.contextWindowLimit).toBe(1000000);
  });

  it('turn 详情：空串 model 与 null 同样视为缺失，回退会话基数（两 route 同口径）', async () => {
    // 回归锁：详情 route 曾用 ?? —— '' 非空值直传 getContextWindowLimit 落
    // 200k 默认，跳过会话回退；列表 route 真值判断则回退 → 同数据两口径
    const { body } = await getTurnDetail(turnEmptyModel);
    expect(body.model).toBe('');
    expect(body.contextWindowLimit).toBe(1000000);
    const res = await turnsListGet(new NextRequest(`http://localhost/api/observe/session/turns?taskId=${TASK_GLM}`));
    const data = await res.json() as { items: Array<{ turnIndex: number; contextWindowLimit: number }> };
    expect(data.items.find(t => t.turnIndex === 4)?.contextWindowLimit).toBe(1000000);
  });

  it('turn 详情：会话自身无 model 时保持 200k 默认（回归锁）', async () => {
    const { body } = await getTurnDetail(turnUserNoModel);
    expect(body.contextWindowLimit).toBe(200000);
  });

  it('turn 详情：-continuation 合成轮同样按会话 model 取基数', async () => {
    const { status, body } = await getTurnDetail(`${turnCompaction}-continuation`);
    expect(status).toBe(200);
    expect(body.contextWindowLimit).toBe(1000000);
  });

  it('turns 列表：null-model turn 与合成 continuation 条目都用会话基数', async () => {
    const res = await turnsListGet(new NextRequest(`http://localhost/api/observe/session/turns?taskId=${TASK_GLM}`));
    const data = await res.json() as { items: Array<{ turnId: string; turnIndex: number; model: string | null; contextWindowLimit: number }> };
    const user = data.items.find(t => t.turnIndex === 1);
    expect(user?.model).toBeNull();
    expect(user?.contextWindowLimit).toBe(1000000);
    // compaction turn 自带 model（claude 200k），合成 continuation 仍按会话
    // 基数 1M——与详情 -continuation 分支同口径，不取 compaction 的 model
    const cont = data.items.find(t => t.turnId.endsWith('-continuation'));
    expect(cont?.contextWindowLimit).toBe(1000000);
  });

  it('混模会话：subagent null-model turn 回退 subagent 自己的 model（200k），不拿 root 的 1M', async () => {
    // subagent assistant turn 落库带自己 jsonl 的 model（claude-sonnet-4 → 200k），
    // 同 lane 的 user turn（model null）基数必须与它同源——回退 root 会话
    // model（glm-5.3 → 1M）会让同一张卡百分比偏小 5 倍
    const sub = await getTurnDetail(turnSubUser);
    expect(sub.status).toBe(200);
    expect(sub.body.model).toBeNull();
    expect(sub.body.contextWindowLimit).toBe(200000);

    // 列表同口径：subagent user turn 200k / root user turn 1M
    const res = await turnsListGet(new NextRequest(`http://localhost/api/observe/session/turns?taskId=${TASK_MIX}`));
    const data = await res.json() as { items: Array<{ turnId: string; turnIndex: number; role: string; isSubagent: boolean; contextWindowLimit: number }> };
    expect(data.items.find(t => t.turnIndex === 10)?.contextWindowLimit).toBe(200000);
    expect(data.items.find(t => t.turnIndex === 1)?.contextWindowLimit).toBe(1000000);
    // subagent compaction 的合成 continuation：列表与详情同基（subagent model
    // 200k）——compaction turn 自己的 model（glm 1M）不得命中
    const subCont = data.items.find(t => t.turnId.endsWith('-continuation'));
    expect(subCont?.contextWindowLimit).toBe(200000);

    const cont = await getTurnDetail(`${turnSubCompaction}-continuation`);
    expect(cont.status).toBe(200);
    expect(cont.body.contextWindowLimit).toBe(200000);
  });
});
