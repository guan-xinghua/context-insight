// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { MetricCards } from '@/components/MetricCards';
import { SessionList } from '@/components/SessionList';
import { LocalFileImport } from '@/components/LocalFileImport';
import { ImportHistory } from '@/components/ImportHistory';
import { AppHeader } from '@/components/layout/AppHeader';
import { BAY_VIEWER_NAME } from '@/lib/branding';
import { prisma } from '@/lib/db';
import { excludedSessionIds } from '@/lib/run/session-scope';
import { runsRoot } from '@/lib/run/run-store';
import { sessionDurationMs } from '@/lib/session-duration';
import { getActiveSplitMap } from '@/lib/active-time-map';
import { getLlmActiveMsMap } from '@/lib/llm-active-map';
import { EyeIcon, SettingsIcon } from 'lucide-react';
import { countToolCallErrors } from '@/lib/tool-call-errors';

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; pageSize?: string; isSubagent?: string; user?: string; q?: string }>;
}) {
  const params = await searchParams;
  const page = Math.max(1, Number(params.page ?? 1));
  const pageSize = Math.max(1, Math.min(100, Number(params.pageSize ?? 20)));
  // 会话搜索（keyword / sessionID）：taskId / query / label 任一子串命中
  const q = params.q?.trim() ?? '';

  // run 域会话隔离：bundle 导入的成员行不进 Sessions 视图（design 决策）。
  // 空 run 集 = 零开销短路（where 不变，行为与之前逐字节一致）。
  const excludedIds = await excludedSessionIds(prisma, runsRoot());
  const scope = excludedIds.length > 0 ? { id: { notIn: excludedIds } } : null;

  const totalSessions = await prisma.session.count(scope ? { where: scope } : undefined);
  const aggregates = await prisma.session.aggregate({
    ...(scope ? { where: scope } : {}),
    _sum: { totalTokens: true, totalCost: true, totalLatencyMs: true },
    _avg: { totalLatencyMs: true },
  });
  // Avg Duration 墙钟口径：Σ(endTime-startTime)÷N（endTime 缺失回落 totalLatencyMs）
  const wallRows = await prisma.session.findMany({
    ...(scope ? { where: scope } : {}),
    select: { startTime: true, endTime: true, totalLatencyMs: true },
  });
  const totalDurationMs = wallRows.reduce((sum, s) => sum + sessionDurationMs(s.startTime, s.endTime, s.totalLatencyMs), 0);
  const avgDurationMs = wallRows.length > 0 ? totalDurationMs / wallRows.length : 0;

  const conditions: Record<string, unknown>[] = [];
  if (scope) conditions.push(scope);
  if (params.user) conditions.push({ user: params.user });
  if (q) conditions.push({ OR: [{ taskId: { contains: q } }, { query: { contains: q } }, { label: { contains: q } }] });
  const where: Record<string, unknown> = conditions.length > 0 ? { AND: conditions } : {};

  const sessions = await prisma.session.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * pageSize,
    take: pageSize,
    select: {
      id: true,
      taskId: true,
      query: true,
      framework: true,
      version: true,
      startTime: true,
      endTime: true,
      totalTokens: true,
      totalCost: true,
      totalLatencyMs: true,
      totalToolCallCount: true,
      totalSkillLoadCount: true,
      totalSubagentCount: true,
      model: true,
      user: true,
      sourcePath: true,
      createdAt: true,
    },
  });

  const total = await prisma.session.count({ where });

  // Compute per-session error counts from tool call resultJson
  const sessionIds = sessions.map(s => s.id);
  const errorToolCalls = await prisma.toolCall.findMany({
    where: {
      turn: { sessionId: { in: sessionIds } },
      OR: [
        { state: { in: ['error', 'failed'] } },
        { errorType: { not: null } },
        { resultJson: { contains: '<tool_use_error>' } },
        { resultJson: { contains: 'Exit code' } },
      ],
    },
    select: {
      id: true,
      toolName: true,
      resultJson: true,
      state: true,
      errorType: true,
      errorMessage: true,
      turn: { select: { sessionId: true, turnIndex: true } },
    },
  });

  const errorSkillEvents = await prisma.skillEvent.findMany({
    where: {
      turn: { sessionId: { in: sessionIds } },
      success: false,
      errorMessage: { not: null },
    },
    select: {
      skillName: true,
      eventType: true,
      success: true,
      errorMessage: true,
      turn: { select: { sessionId: true, turnIndex: true } },
    },
  });

  const errorCountsBySession = countToolCallErrors(errorToolCalls, errorSkillEvents);

  const totalErrors = sessionIds.reduce((sum, sid) => sum + (errorCountsBySession.get(sid)?.count ?? 0), 0);

  // LLM Active（模型推理时间）：单查询批量取本页会话 turn 窗口算区间并集
  // ——列表 Duration 语义，墙钟由 Start→End 列反映
  const llmActive = await getLlmActiveMsMap(sessions.map(s => s.id));
  // 活跃 / 墙钟（事件聚类口径，与详情页 Wall Clock 拆分同源）：同样单查询批量
  const activeSplit = await getActiveSplitMap(sessions);

  const items = sessions.map((s) => {
    const eInfo = errorCountsBySession.get(s.id)
    return {
      sessionId: s.id,
      taskId: s.taskId,
      query: s.query,
      startTime: s.startTime.toISOString(),
      endTime: s.endTime ? s.endTime.toISOString() : null,
      importedAt: s.createdAt.toISOString(),
      totalTokens: s.totalTokens,
      totalCost: s.totalCost,
      totalLatencyMs: s.totalLatencyMs,
      llmActiveMs: llmActive.get(s.id) ?? null,
      activeMs: activeSplit.get(s.id)?.activeMs ?? null,
      wallMs: activeSplit.get(s.id)?.wallMs ?? null,
      totalToolCallCount: s.totalToolCallCount,
      totalSkillLoadCount: s.totalSkillLoadCount,
      totalSubagentCount: s.totalSubagentCount,
      model: s.model,
      user: s.user,
      framework: s.framework,
      version: s.version,
      sourcePath: s.sourcePath,
      errorCount: eInfo?.count ?? 0,
      firstErrorTurnIndex: eInfo?.firstTurnIndex ?? null,
    }
  });

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <main className="flex w-full max-w-7xl flex-col gap-6 px-6 py-8 mx-auto">
        <AppHeader
          actions={
            <>
              <LocalFileImport />
              <a href="/lake_viewer" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-sm font-medium hover:bg-accent/30 transition-colors">
                <EyeIcon className="size-4 text-cyan-500" />
                {BAY_VIEWER_NAME}
              </a>
              <a href="/settings" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-sm font-medium hover:bg-accent/30 transition-colors">
                <SettingsIcon className="size-4 text-muted-foreground" />
                设置
              </a>
            </>
          }
        />
        <MetricCards
          totalSessions={totalSessions}
          totalTokens={aggregates._sum.totalTokens ?? 0}
          totalCost={aggregates._sum.totalCost ?? 0}
          avgDurationMs={avgDurationMs}
          totalErrors={totalErrors}
        />
        <SessionList items={items} total={total} page={page} pageSize={pageSize} q={q} totalCount={totalSessions} />
        <ImportHistory />
      </main>
    </div>
  );
}
