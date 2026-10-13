// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement (the "License").
// Please refer to the License for details.
// You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// codex-proxy 捕获子代理身份对齐 IT（真机 replayA 暴露的两处展示缺陷）：
// ① 0 turns：cpx 给子代理文件铸的 id（sub-<hash>）早于 spawn 输出到达，
//    bridge-builder 按 spawn 输出的 agent_id 锚定 → 两边 id 对不上，Turns
//    泳道/性能视图全部 0 turns。修复：listSubagentSessions 产出规范连接键
//    （meta backfill 的 agentId ?? 文件名 id，contract.SubagentRef），打标/
//    泳道 join/turns 详情全部单键。
// ② #0 出现 <environment_context> user message：codex 静态注入应丢弃、事件
//    注入（subagent_notification）应为 system turn——注入指纹框架自持
//    （injections/codex.ts），与 codex 原生 adapter 共用同一分类器，两条
//    路径时间线一致。
import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importSession } from '../../src/lib/ingest/data-service.ts';
import { listSubagentSessions } from '../../src/lib/ingest/adapters/claude-jsonl.ts';

const prisma = new PrismaClient();
const SID = 'codxproxy-join-0001';
const AGENT_ID = '01a1209a-fixture-agent-000000000001';
const FILE_ID = 'sub-heisen0001';
const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'codex-proxy-subagent-join');
const FILE = path.join(DATA_DIR, `cpx-${SID}.jsonl`);

let sessionId: string | null = null;

afterAll(async () => {
  if (sessionId) {
    const id = sessionId;
    await prisma.$transaction([
      prisma.executionSkill.deleteMany({ where: { execution: { sessionId: id } } }),
      prisma.toolCall.deleteMany({ where: { turn: { sessionId: id } } }),
      prisma.skillEvent.deleteMany({ where: { turn: { sessionId: id } } }),
      prisma.execution.deleteMany({ where: { sessionId: id } }),
      prisma.sessionSkill.deleteMany({ where: { sessionId: id } }),
      prisma.interactionBridge.deleteMany({ where: { sessionId: id } }),
      prisma.turn.deleteMany({ where: { sessionId: id } }),
      prisma.session.delete({ where: { id } }),
    ]);
  }
  await prisma.$disconnect();
});

describe('codex-proxy 子代理身份对齐 + 注入分类（fixture = 真机 replayA 形状）', () => {
  it('listSubagentSessions 产出规范连接键（meta agentId 优先，文件名 id 回退）', () => {
    const subs = listSubagentSessions(FILE, SID);
    expect(subs).toHaveLength(1);
    // codex-proxy：meta backfill 的 agentId 是规范 id（bridge/execution 锚定键）
    expect(subs[0].id).toBe(AGENT_ID);
    expect(subs[0].filePath).toContain(FILE_ID);
  });

  it('完整导入：turn 标记用 agentId，与 Bridge/Execution 三方对齐（0 turns 回归锁）', async () => {
    const r = await importSession(FILE, SID, prisma, FILE, 'claude-jsonl');
    expect(r.imported).toBe(true);
    const session = await prisma.session.findFirst({ where: { taskId: SID } });
    expect(session).toBeTruthy();
    sessionId = session!.id;

    const turns = await prisma.turn.findMany({
      where: { sessionId: session!.id },
      select: { role: true, isSubagent: true, subagentSessionId: true, content: true },
      orderBy: { turnIndex: 'asc' },
    });
    const subTurns = turns.filter(t => t.isSubagent);
    expect(subTurns.length).toBeGreaterThanOrEqual(2);
    for (const t of subTurns) expect(t.subagentSessionId).toBe(AGENT_ID);

    const bridge = await prisma.interactionBridge.findFirst({
      where: { sessionId: session!.id, subagentSessionId: AGENT_ID },
    });
    expect(bridge).toBeTruthy();

    const execution = await prisma.execution.findFirst({
      where: { sessionId: session!.id, agentSessionId: AGENT_ID },
    });
    expect(execution).toBeTruthy();

    // 「0 turns」症状的精确回归锁：泳道计数 = bridge.subagentSessionId 命中的
    // 子代理 turn 数（TurnTimeline subTurnsBySession 同款口径）
    const laneTurnCount = turns.filter(t => t.isSubagent && t.subagentSessionId === bridge!.subagentSessionId).length;
    expect(laneTurnCount).toBeGreaterThanOrEqual(2);
  });

  it('注入分类：静态注入（environment_context）不进时间线，事件注入为 system turn', async () => {
    const session = await prisma.session.findFirst({ where: { taskId: SID } });
    expect(session).toBeTruthy();
    const turns = await prisma.turn.findMany({
      where: { sessionId: session!.id },
      select: { role: true, isSubagent: true, content: true },
    });

    // 主线程 + 子代理文件各有一条 env_ctx 注入，全部应被丢弃（assistant 回复
    // 里逐字引用 <environment_context> 字样的真实输出不受影响——真机 replayA
    // 的 Heisenberg 报告就引用了设计文档原文）
    expect(turns.filter(t => t.role !== 'assistant' && (t.content ?? '').includes('<environment_context>'))).toHaveLength(0);

    // subagent_notification → 摘要化 system turn（claude task-notification 同款）
    const notifTurns = turns.filter(t => (t.content ?? '').startsWith('✅ 子代理完成'));
    expect(notifTurns).toHaveLength(1);
    expect(notifTurns[0].role).toBe('system');

    // 真实提示不被误伤：主任务与子代理任务仍是 user turn
    const taskTurns = turns.filter(t => (t.content ?? '').includes('分析'));
    expect(taskTurns.filter(t => t.role === 'user').length).toBeGreaterThanOrEqual(2);
  });
});
