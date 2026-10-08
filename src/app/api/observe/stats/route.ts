// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { sessionDurationMs, computeLlmActiveMs } from '@/lib/session-duration';
import { withRouteLog } from '@/lib/api-route';

export const GET = withRouteLog('observe/stats', async (request: NextRequest) => {
  const { searchParams } = request.nextUrl;
  const taskId = searchParams.get('taskId');

  if (!taskId) {
    const totalSessions = await prisma.session.count();
    const aggregates = await prisma.session.aggregate({
      _sum: { totalTokens: true, totalCost: true, totalLatencyMs: true },
      _avg: { totalLatencyMs: true },
    });
    // Avg Duration 墙钟口径：Σ(endTime-startTime)÷N（endTime 缺失回落 totalLatencyMs），
    // 不能用 _avg totalLatencyMs（并行 subagent 双计会膨胀，可超墙钟）
    const wallRows = await prisma.session.findMany({
      select: { startTime: true, endTime: true, totalLatencyMs: true },
    });
    const durations = wallRows.map(s => sessionDurationMs(s.startTime, s.endTime, s.totalLatencyMs));
    const totalDurationMs = durations.reduce((a, b) => a + b, 0);

    return NextResponse.json({
      totalSessions,
      totalTokens: aggregates._sum.totalTokens ?? 0,
      totalCost: aggregates._sum.totalCost ?? 0,
      totalLatencyMs: aggregates._sum.totalLatencyMs ?? 0,
      avgLatencyMs: aggregates._avg.totalLatencyMs ?? 0,
      totalDurationMs,
      avgDurationMs: wallRows.length > 0 ? totalDurationMs / wallRows.length : 0,
    });
  }

  const session = await prisma.session.findFirst({
    where: { taskId, ...(searchParams.get('framework') ? { framework: searchParams.get('framework')! } : {}) },
    select: {
      id: true,
      startTime: true,
      endTime: true,
      totalTokens: true,
      totalCost: true,
      totalLatencyMs: true,
      totalInputTokens: true,
      totalOutputTokens: true,
      totalReasoningTokens: true,
      totalCacheReadTokens: true,
      totalCacheWriteTokens: true,
      totalToolCallCount: true,
      totalSkillLoadCount: true,
      totalSubagentCount: true,
      totalLlmCallCount: true,
    },
  });

  if (!session) {
    return NextResponse.json(
      { error: `Session not found: taskId=${taskId}` },
      { status: 404 }
    );
  }

  return NextResponse.json({
    taskId,
    startTime: session.startTime,
    endTime: session.endTime,
    totalTokens: session.totalTokens,
    totalInputTokens: session.totalInputTokens,
    totalOutputTokens: session.totalOutputTokens,
    totalReasoningTokens: session.totalReasoningTokens,
    totalCacheReadTokens: session.totalCacheReadTokens,
    totalCacheWriteTokens: session.totalCacheWriteTokens,
    totalCost: session.totalCost,
    totalLatencyMs: session.totalLatencyMs,
    llmActiveMs: computeLlmActiveMs(await prisma.turn.findMany({
      where: { sessionId: session.id, role: 'assistant' },
      select: { createdAt_ts: true, completedAt: true, latencyMs: true },
    })),
    totalToolCallCount: session.totalToolCallCount,
    totalSkillLoadCount: session.totalSkillLoadCount,
    totalSubagentCount: session.totalSubagentCount,
    totalLlmCallCount: session.totalLlmCallCount,
  });
});
