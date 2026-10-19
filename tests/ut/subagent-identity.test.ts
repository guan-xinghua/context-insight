// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 子代理身份双字段 IT（subagentType + dispatchStep）：Perf TopDown 的
// SUBAGENT 行要同时展示「类型」（design-tiling-splitter）与「派发步骤」
// （⑦ group 同步）。两信息的可靠源随形态分叉：proxy 形态 Turn.subagentName
// = cpx meta.name = Task description（自证身份，桥锚定错位不污染）；原生
// 形态 subagentName 泛化（claude native "design" / opencode title 截断），
// 步骤取 Bridge.dispatchContent。类型四形态唯一运行时源是
// Bridge.subagentType。覆盖列表 route 与详情 route 两个读侧。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { prisma } from '../setup';
import { GET as turnsListGet } from '@/app/api/observe/session/turns/route';
import { GET as turnDetailGet, __clearTurnDetailCaches } from '@/app/api/observe/session/turns/[turnId]/route';
import { isBackgroundDispatch } from '@/lib/subagent-identity';

const TASK_PROXY = 'sub-identity-it-proxy';
const TASK_REUSE = 'sub-identity-it-reuse';
const SUB_REUSE2 = 'sub-identity-sub-reuse';
const TASK_NATIVE = 'sub-identity-it-native';
const TASK_NOBRIDGE = 'sub-identity-it-nobridge';
const SUB_PROXY = 'sub-identity-sub-proxy';
const SUB_NATIVE = 'sub-identity-sub-native';
const SUB_NOBRIDGE = 'sub-identity-sub-nobridge';

let proxySubTurn: string;
let nativeSubTurn: string;
let nobridgeSubTurn: string;
let reuseSubTurn: string;

beforeAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: { in: [TASK_PROXY, TASK_NATIVE, TASK_NOBRIDGE, TASK_REUSE] } } });
  __clearTurnDetailCaches();

  // proxy 形态（version 带 -proxy 后缀）：subagentName=meta.name=Task
  // description；桥 dispatchContent 故意塞另一条派发的描述（现场锚定错位
  // 形态：Perf 行主副标题编号不一致）——步骤必须信 name 而非桥
  const proxy = await prisma.session.create({
    data: { taskId: TASK_PROXY, framework: 'opencode-proxy', version: 'cpx-0.1.9-proxy' },
  });
  await prisma.interactionBridge.create({
    data: {
      sessionId: proxy.id, dispatchExecutionId: 'exec-x',
      dispatchContent: '⑥ base 切分(返工r2最后)',
      subagentSessionId: SUB_PROXY, subagentType: 'design-sync-planner', status: 'completed',
    },
  });
  const t1 = await prisma.turn.create({
    data: {
      sessionId: proxy.id, turnIndex: 1, role: 'assistant', isSubagent: true,
      subagentSessionId: SUB_PROXY, subagentName: '⑦ group 同步',
    },
  });
  proxySubTurn = t1.id;
  await prisma.turn.create({ data: { sessionId: proxy.id, turnIndex: 2, role: 'assistant' } });

  // 原生形态（version null）：subagentName 泛化 "design"，步骤取桥
  // dispatchContent（含换行压平）
  const native = await prisma.session.create({
    data: { taskId: TASK_NATIVE, framework: 'opencode' },
  });
  await prisma.interactionBridge.create({
    data: {
      sessionId: native.id, dispatchExecutionId: 'exec-y',
      dispatchContent: '⑦ group 同步\n详细职责见 agent 定义',
      subagentSessionId: SUB_NATIVE, subagentType: 'design-sync-planner', status: 'completed',
    },
  });
  const t2 = await prisma.turn.create({
    data: {
      sessionId: native.id, turnIndex: 1, role: 'assistant', isSubagent: true,
      subagentSessionId: SUB_NATIVE, subagentName: 'design',
    },
  });
  nativeSubTurn = t2.id;

  // 复用会话（同 sid 两次派发，返工在后）：列表与详情身份都必须取首发
  const reuse = await prisma.session.create({
    data: { taskId: TASK_REUSE, framework: 'opencode' },
  });
  await prisma.interactionBridge.create({
    data: {
      sessionId: reuse.id, dispatchExecutionId: 'exec-r1',
      dispatchContent: 'P1 需求分析', dispatchTimestamp: new Date('2026-10-01T00:00:00Z'),
      subagentSessionId: SUB_REUSE2, subagentType: 'ascendc-ops-architect', status: 'completed',
    },
  });
  await prisma.interactionBridge.create({
    data: {
      sessionId: reuse.id, dispatchExecutionId: 'exec-r2',
      dispatchContent: 'P1 返工 r1', dispatchTimestamp: new Date('2026-10-01T01:00:00Z'),
      subagentSessionId: SUB_REUSE2, subagentType: 'ascendc-ops-architect', status: 'completed',
    },
  });
  const tr = await prisma.turn.create({
    data: {
      sessionId: reuse.id, turnIndex: 1, role: 'assistant', isSubagent: true,
      subagentSessionId: SUB_REUSE2, subagentName: 'design',
    },
  });
  reuseSubTurn = tr.id;

  // 无桥（cpx meta 三 null 的漏网子代理）：步骤回落 subagentName，类型 null
  const nb = await prisma.session.create({
    data: { taskId: TASK_NOBRIDGE, framework: 'claude-code-proxy', version: 'cpx-0.1.9-proxy' },
  });
  const t3 = await prisma.turn.create({
    data: {
      sessionId: nb.id, turnIndex: 1, role: 'assistant', isSubagent: true,
      subagentSessionId: SUB_NOBRIDGE, subagentName: '⑨ group kernel(返工r1)',
    },
  });
  nobridgeSubTurn = t3.id;
}, 60_000);

afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: { in: [TASK_PROXY, TASK_NATIVE, TASK_NOBRIDGE, TASK_REUSE] } } }).catch(() => {});
});

interface Row {
  turnId: string;
  turnIndex: number;
  subagentType: string | null;
  dispatchStep: string | null;
}

async function listRows(taskId: string, framework: string): Promise<Row[]> {
  const res = await turnsListGet(new NextRequest(
    `http://localhost/api/observe/session/turns?taskId=${taskId}&framework=${framework}`,
  ));
  expect(res.status).toBe(200);
  return (await res.json() as { items: Row[] }).items;
}

describe('子代理身份双字段：subagentType + dispatchStep', () => {
  it('proxy：步骤=subagentName（桥锚定错位不污染），类型=桥 subagentType', async () => {
    const rows = await listRows(TASK_PROXY, 'opencode-proxy');
    const sub = rows.find(r => r.turnId === proxySubTurn);
    expect(sub?.dispatchStep).toBe('⑦ group 同步');
    expect(sub?.subagentType).toBe('design-sync-planner');
  });

  it('proxy root turn：两字段 null', async () => {
    const rows = await listRows(TASK_PROXY, 'opencode-proxy');
    const root = rows.find(r => r.turnId !== proxySubTurn);
    expect(root?.subagentType).toBeNull();
    expect(root?.dispatchStep).toBeNull();
  });

  it('原生：subagentName 泛化时步骤取桥 dispatchContent（换行压平）', async () => {
    const rows = await listRows(TASK_NATIVE, 'opencode');
    const sub = rows.find(r => r.turnId === nativeSubTurn);
    expect(sub?.dispatchStep).toBe('⑦ group 同步 详细职责见 agent 定义');
    expect(sub?.subagentType).toBe('design-sync-planner');
  });

  it('无桥：步骤回落 subagentName，类型 null', async () => {
    const rows = await listRows(TASK_NOBRIDGE, 'claude-code-proxy');
    const sub = rows.find(r => r.turnId === nobridgeSubTurn);
    expect(sub?.dispatchStep).toBe('⑨ group kernel(返工r1)');
    expect(sub?.subagentType).toBeNull();
  });

  it('复用会话：列表与详情身份同取首发派发（不再一处返工一处首发）', async () => {
    const rows = await listRows(TASK_REUSE, 'opencode');
    const sub = rows.find(r => r.turnId === reuseSubTurn);
    expect(sub?.dispatchStep).toBe('P1 需求分析');
    const res = await turnDetailGet(
      new NextRequest(`http://localhost/api/observe/session/turns/${reuseSubTurn}`),
      { params: Promise.resolve({ turnId: reuseSubTurn }) },
    );
    const body = await res.json() as { dispatchStep: string | null };
    expect(body.dispatchStep).toBe('P1 需求分析');
  });

  it('isBackgroundDispatch：result 侧转义引号形态同样判后台', () => {
    const escaped = '[{"type":"text","text":"<task id=\\"ses_x\\" state=\\"running\\">"}]';
    expect(isBackgroundDispatch(null, escaped)).toBe(true);
    expect(isBackgroundDispatch(null, '<task id="ses_x" state="running">')).toBe(true);
    expect(isBackgroundDispatch(null, '<task id="ses_x" state="completed">')).toBe(false);
  });

  it('详情 route 与列表同口径（proxy subagent turn）', async () => {
    const res = await turnDetailGet(
      new NextRequest(`http://localhost/api/observe/session/turns/${proxySubTurn}`),
      { params: Promise.resolve({ turnId: proxySubTurn }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { subagentType: string | null; dispatchStep: string | null };
    expect(body.dispatchStep).toBe('⑦ group 同步');
    expect(body.subagentType).toBe('design-sync-planner');
  });
});
