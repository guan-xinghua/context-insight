// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { subagentTiming } from '@/lib/subagent-timing';
import { withRouteLog } from '@/lib/api-route';
import { isBackgroundDispatch } from '@/lib/subagent-identity';

export const GET = withRouteLog('observe/session/bridges', async (request: NextRequest) => {
  const { searchParams } = request.nextUrl;
  const taskId = searchParams.get('taskId');
  const framework = searchParams.get('framework');

  if (!taskId) {
    return NextResponse.json(
      { error: 'Missing required parameter: taskId' },
      { status: 400 }
    );
  }

  const session = await prisma.session.findFirst({
    where: framework ? { taskId, framework } : { taskId },
  });

  if (!session) {
    return NextResponse.json(
      { error: `Session not found: taskId=${taskId}` },
      { status: 404 }
    );
  }

  const bridges = await prisma.interactionBridge.findMany({
    where: { sessionId: session.id },
    orderBy: [{ dispatchTimestamp: 'asc' }],
  });

  const subagentSessionIds = bridges
    .map(b => b.subagentSessionId)
    .filter((id): id is string => id !== null);
  
  const executions = subagentSessionIds.length > 0
    ? await prisma.execution.findMany({
        where: { sessionId: session.id, agentSessionId: { in: subagentSessionIds } },
        select: { agentSessionId: true, agentName: true },
      })
    : [];
  
  const executionMap = new Map(executions.map(e => [e.agentSessionId, e.agentName]));

  const subTurns = subagentSessionIds.length > 0
    ? await prisma.turn.findMany({
        where: { sessionId: session.id, subagentSessionId: { in: subagentSessionIds } },
        select: { subagentSessionId: true, createdAt_ts: true, completedAt: true, latencyMs: true },
      })
    : [];
  const turnsBySession = new Map<string, typeof subTurns>();
  for (const turn of subTurns) {
    if (!turn.subagentSessionId) continue;
    const group = turnsBySession.get(turn.subagentSessionId) ?? [];
    group.push(turn);
    turnsBySession.set(turn.subagentSessionId, group);
  }

  // 后台异步判据在派发 ToolCall 的 args/result（opencode background 参数 /
  // claude "Async agent launched" result）——批量取一次，桥逐条映射
  const dispatchCallIds = bridges.map(b => b.dispatchToolCallId).filter((x): x is string => !!x)
  const dispatchCalls = dispatchCallIds.length > 0
    ? await prisma.toolCall.findMany({
        where: { id: { in: dispatchCallIds } },
        select: { id: true, argsJson: true, resultJson: true },
      })
    : []
  const backgroundByCallId = new Map(dispatchCalls.map(tc => [tc.id, isBackgroundDispatch(tc.argsJson, tc.resultJson)]))

  // 复用会话（首发+返工同 sid）的读侧窗口配对——与 ingest 同口径。不配对的
  // 话这里拿全会话 turn 重算 timing，会把库里已按窗口写对的 response 又盖
  // 回会话全局末条（两桥同 response、泳道/turns 页窗口互相包含）
  const sidDispatchTimes = new Map<string, number[]>()
  for (const b of bridges) {
    if (!b.subagentSessionId || !b.dispatchTimestamp) continue
    const ms = new Date(b.dispatchTimestamp).getTime()
    if (!Number.isFinite(ms)) continue
    const arr = sidDispatchTimes.get(b.subagentSessionId) ?? []
    arr.push(ms)
    sidDispatchTimes.set(b.subagentSessionId, arr)
  }
  for (const arr of sidDispatchTimes.values()) arr.sort((a, b) => a - b)

  const windowedTimingTurns = (b: (typeof bridges)[number]) => {
    const all = turnsBySession.get(b.subagentSessionId ?? '') ?? []
    const dMs = b.dispatchTimestamp ? new Date(b.dispatchTimestamp).getTime() : NaN
    if (!Number.isFinite(dMs) || all.length === 0) return all
    const sidT = sidDispatchTimes.get(b.subagentSessionId!) ?? []
    const next = sidT.find(t => t > dMs) ?? null
    const after = all.filter(t => {
      const ts = t.createdAt_ts ? new Date(t.createdAt_ts).getTime() : NaN
      return Number.isFinite(ts) && ts >= dMs
    })
    const win = next !== null
      ? after.filter(t => new Date(t.createdAt_ts!).getTime() < next)
      : after
    if (win.length > 0) return win
    if (next !== null) {
      // 与 ingest 同款空窗回退：只放开下界仍卡上界，宁空勿吞下窗
      const bounded = all.filter(t => {
        const ts = t.createdAt_ts ? new Date(t.createdAt_ts).getTime() : NaN
        return Number.isFinite(ts) && ts < next
      })
      if (bounded.length > 0) return bounded
      return []
    }
    if (after.length > 0) return after
    return all
  }

  const items = bridges.map(b => {
    const timing = subagentTiming(windowedTimingTurns(b), b.dispatchTimestamp);
    // responseTimestamp 钳到同 sid 下次派发时刻：窗口按 createdAt 选 turn，
    // 窗内 turn 的 completedAt 可能越过下次派发（后台/返工重入仍在跑）——
    // 不钳的话下游 ts <= responseTimestamp 的读侧窗口会把下窗 turn 吞回来
    //（与 ingest [dispatch_i, dispatch_{i+1}) 上界同口径）
    const respMs = timing ? new Date(timing.responseTimestamp).getTime()
      : b.responseTimestamp ? b.responseTimestamp.getTime() : null;
    const dMs = b.dispatchTimestamp ? b.dispatchTimestamp.getTime() : NaN;
    const nextMs = Number.isFinite(dMs)
      ? sidDispatchTimes.get(b.subagentSessionId ?? '')?.find(t => t > dMs) ?? null
      : null;
    const clampedMs = respMs !== null && nextMs !== null ? Math.min(respMs, nextMs) : respMs;
    return ({
    bridgeId: b.id,
    dispatchExecutionId: b.dispatchExecutionId,
    dispatchTurnId: b.dispatchTurnId,
    dispatchToolCallId: b.dispatchToolCallId,
    dispatchContent: b.dispatchContent,
    dispatchTimestamp: b.dispatchTimestamp?.toISOString() ?? null,
    responseExecutionId: b.responseExecutionId,
    responseTurnId: b.responseTurnId,
    responseContent: b.responseContent,
    responseTimestamp: clampedMs !== null ? new Date(clampedMs).toISOString() : null,
    subagentSessionId: b.subagentSessionId,
    subagentType: b.subagentType,
    subagentName: b.subagentName,
    agentName: b.subagentType ?? b.subagentName ?? (b.subagentSessionId ? executionMap.get(b.subagentSessionId) ?? null : null),
    status: b.status,
    subagentTokens: b.subagentTokens,
    subagentLatencyMs: timing?.latencyMs ?? b.subagentLatencyMs,
    dispatchBackground: b.dispatchToolCallId ? backgroundByCallId.get(b.dispatchToolCallId) ?? false : false,
    });
  });

  return NextResponse.json({ items, total: items.length });
});
