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

export async function GET(request: NextRequest) {
  try {
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

    const items = bridges.map(b => {
      const timing = subagentTiming(turnsBySession.get(b.subagentSessionId ?? '') ?? [], b.dispatchTimestamp);
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
      responseTimestamp: timing?.responseTimestamp ?? b.responseTimestamp?.toISOString() ?? null,
      subagentSessionId: b.subagentSessionId,
      subagentType: b.subagentType,
      subagentName: b.subagentName,
      agentName: b.subagentType ?? b.subagentName ?? (b.subagentSessionId ? executionMap.get(b.subagentSessionId) ?? null : null),
      status: b.status,
      subagentTokens: b.subagentTokens,
      subagentLatencyMs: timing?.latencyMs ?? b.subagentLatencyMs,
      });
    });

    return NextResponse.json({ items, total: items.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
