// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { computeSessionActiveSplit } from '@/lib/active-time';
import { isProxyVersion } from '@/lib/shared/session-format';
import { computeLlmActiveMs } from '@/lib/session-duration';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const taskId = searchParams.get('taskId');
    const framework = searchParams.get('framework');
    const sessionId = searchParams.get('sessionId');

    if (!taskId && !sessionId) {
      return NextResponse.json(
        { error: 'Missing required parameter: taskId or sessionId' },
        { status: 400 }
      );
    }

    let where: Record<string, string>;
    if (sessionId) {
      where = { id: sessionId };
    } else if (framework) {
      where = { taskId: taskId!, framework };
    } else {
      where = { taskId: taskId! };
    }

    const sessions = await prisma.session.findMany({
      where,
      include: {
        executions: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            agentName: true,
            agentSessionId: true,
            isSubagent: true,
            parentExecutionId: true,
            tokens: true,
            maxSingleCallTokens: true,
            cost: true,
            toolCallCount: true,
            skillLoadCount: true,
            model: true,
            createdAt: true,
            latencyMs: true,
          },
        },
        skills: {
          select: {
            skillName: true,
            skillVersion: true,
            invocationCount: true,
          },
        },
      },
    });

    if (sessions.length === 0) {
      return NextResponse.json(
        { error: `Session not found: taskId=${taskId}` },
        { status: 404 }
      );
    }

    if (sessions.length > 1 && !framework && !sessionId) {
      return NextResponse.json({
        multiple: true,
        sessions: sessions.map(s => ({
          sessionId: s.id,
          taskId: s.taskId,
          framework: s.framework,
          label: s.label,
          query: s.query,
          model: s.model,
          startTime: s.startTime,
        })),
      });
    }

    const session = sessions[0];

    // Fetch first user prompts for root and each subagent.
    // Previous version loaded *all* user turns (with full content) just to
    // pick the first per group on a 4000-turn session — that's hundreds of KB
    // of unused content pulled across thousands of rows.
    //
    // Root: findFirst with take:1 — exactly one row.
    // Subagents: findMany for isSubagent=true user turns, dedupe by
    // subagentSessionId in memory (one query instead of N per-subagent).
    const rootFirstUserTurn = await prisma.turn.findFirst({
      where: { sessionId: session.id, role: 'user', isSubagent: false },
      orderBy: { turnIndex: 'asc' },
      select: { contentSummary: true, content: true },
    });
    const rootFirstPrompt: string | null = rootFirstUserTurn
      ? (rootFirstUserTurn.contentSummary ?? rootFirstUserTurn.content?.substring(0, 80) ?? null)
      : null;

    const subUserTurns = await prisma.turn.findMany({
      where: { sessionId: session.id, role: 'user', isSubagent: true, subagentSessionId: { not: null } },
      orderBy: [{ turnIndex: 'asc' }],
      select: { contentSummary: true, content: true, subagentSessionId: true },
    });
    const subFirstPrompts = new Map<string, string>();
    for (const t of subUserTurns) {
      if (t.subagentSessionId && !subFirstPrompts.has(t.subagentSessionId)) {
        subFirstPrompts.set(t.subagentSessionId, t.contentSummary ?? t.content?.substring(0, 80) ?? '');
      }
    }

    // ── 每个 agent 的「turns 跨度」+「原始活跃区间」──────────────────
    // span：身份与 Turns 页签的 subagent 分组一致（subagentSessionId = transcript
    //   文件名 stem），跨度 = 首条 turn 的 createdAt_ts → 末条 turn 的 completedAt。
    //   **含休眠空档**，所以一根条子 = 这个 subagent 的一生。
    // intervals：每个 turn 的原始 [start, end]，**不合并、不截断**——休眠阈值
    //   （单条 turn 最多算多久活跃 + 相邻间隔多大算断开）由前端预设档位控制，
    //   调档位在前端重聚类，无需重新请求。前端拿 span 画整根浅色底、拿聚类后
    //   的活跃段画深色覆盖，休眠就自然显出来了。
    // proxy 与否的判定只此一处（下面 computeSessionActiveSplit 的 latency 展开
    // 同一口径）。native 行绝不展开——见本条下方注释。
    const isProxySession = isProxyVersion(session.version);
    const turnTimes = await prisma.turn.findMany({
      where: { sessionId: session.id },
      select: { isSubagent: true, subagentSessionId: true, createdAt_ts: true, completedAt: true, latencyMs: true },
    });
    // 身份键必须让 root 与任何 subagent 互不重叠：subagentSessionId 在 schema 里
    // 可空（isSubagent=true + null 行），`?? ''` 会与 root 的 key 撞车，把这类 turn
    // 并进主 agent 的 span / activeIntervals（主条子跨度与活跃段被污染）。其余按
    // subagentSessionId 分组的查询（本文件 L111、turns/route.ts L121、
    // agent-role-name-map.ts L40）都是 `{ not: null }` 口径——这里用哨兵前缀保持
    // 同一口径，同时不丢数据（不会被任何 execution 命中，也就不参与绘制）。
    const keyOf = (isSubagent: boolean, agentSessionId: string | null) =>
      isSubagent ? `sub:${agentSessionId ?? ''}` : 'root';
    const spanByKey = new Map<string, { start: number; end: number }>();
    const intervalsByKey = new Map<string, Array<{ start: number; end: number }>>();
    for (const t of turnTimes) {
      const key = keyOf(t.isSubagent, t.subagentSessionId);
      const rawStart = t.createdAt_ts ?? t.completedAt;
      if (!rawStart) continue;
      const start = rawStart.getTime();
      const end = Math.max(start, (t.completedAt ?? rawStart).getTime());
      // proxy（cpx 捕获）assistant 行的 completedAt 系统性缺失：createdAt_ts
      // 就是响应完成时刻，在途窗口是 [t - latencyMs, t]（latencyMs = wire
      // duration_ms）——与 session-duration.ts 的 turnWindow 同口径。不补起点
      // 的话每条 interval 都塌成零宽 [t, t]，前端 filter(end > start) 把它们
      // 全丢掉（或被兜底画成整根实色），活跃/休眠可视化整体失效。
      // native 行不适用：它的 completedAt 缺失时 latencyMs 可能是「到下一轮的
      // 间隔」（含小时级空闲段），展开会把空闲画成活跃。
      const intervalStart = isProxySession && !t.completedAt && t.latencyMs > 0
        ? start - t.latencyMs
        : start;

      const sp = spanByKey.get(key);
      if (!sp) spanByKey.set(key, { start, end });
      else { sp.start = Math.min(sp.start, start); sp.end = Math.max(sp.end, end); }

      const arr = intervalsByKey.get(key) ?? [];
      arr.push({ start: intervalStart, end });
      intervalsByKey.set(key, arr);
    }
    const spanFor = (isSubagent: boolean, agentSessionId: string | null) =>
      spanByKey.get(keyOf(isSubagent, agentSessionId)) ?? null;
    const activeIntervalsFor = (isSubagent: boolean, agentSessionId: string | null) =>
      intervalsByKey.get(keyOf(isSubagent, agentSessionId)) ?? [];


    const agents = session.executions.map((e) => ({
      executionId: e.id,
      agentName: e.agentName,
      agentSessionId: e.agentSessionId,
      isSubagent: e.isSubagent,
      parentExecutionId: e.parentExecutionId,
      tokens: e.tokens,
      maxSingleCallTokens: e.maxSingleCallTokens,
      cost: e.cost,
      toolCallCount: e.toolCallCount,
      skillLoadCount: e.skillLoadCount,
      model: e.model,
      createdAt: e.createdAt.toISOString(),
      latencyMs: e.latencyMs,
      span: spanFor(e.isSubagent, e.agentSessionId),
      activeIntervals: activeIntervalsFor(e.isSubagent, e.agentSessionId),
      firstPrompt: e.isSubagent
        ? (subFirstPrompts.get(e.agentSessionId ?? '') ?? null)
        : rootFirstPrompt,
    }));

    const skills = session.skills.map((s) => ({
      skillName: s.skillName,
      version: s.skillVersion,
      invocationCount: s.invocationCount,
    }));

    // wire 捕获（-proxy version）的 Turn.latencyMs 是真实 API 调用时长
    // （duration_ms）——按 [t-latency, t] 展开成活跃区间，慢调用不被阈值切走。
    // native 行的 latencyMs = completed-created（可横跨空闲段），不能展开。
    const activeSplit = await computeSessionActiveSplit(
      () => prisma.turn.findMany({
        where: { sessionId: session.id },
        select: { createdAt_ts: true, createdAt: true, latencyMs: true, role: true },
      }),
      session.startTime.getTime(),
      session.endTime ? session.endTime.getTime() : null,
      isProxySession
    );
    // LLM 活跃时间：assistant turn 在途窗口区间并集（root + subagent 合并去重叠）。
    // proxy 行 completedAt 缺失，computeLlmActiveMs 用 createdAt - latencyMs 推窗口起点。
    const llmTurns = await prisma.turn.findMany({
      where: { sessionId: session.id, role: 'assistant' },
      select: { createdAt_ts: true, completedAt: true, latencyMs: true },
    });
    const llmActiveMs = computeLlmActiveMs(llmTurns);

    return NextResponse.json({
      sessionId: session.id,
      taskId: session.taskId,
      label: session.label,
      query: session.query,
      framework: session.framework,
      frameworkVersion: session.version,
      parentId: session.parentId,
      directory: session.directory,
      summaryAdditions: session.summaryAdditions,
      summaryDeletions: session.summaryDeletions,
      summaryFiles: session.summaryFiles,
      startTime: session.startTime,
      endTime: session.endTime,
      wallMs: activeSplit?.wallMs ?? null,
      activeMs: activeSplit?.activeMs ?? null,
      inactiveMs: activeSplit?.inactiveMs ?? null,
      activeClusterCount: activeSplit?.clusterCount ?? null,
      totalTokens: session.totalTokens,
      totalInputTokens: session.totalInputTokens,
      totalOutputTokens: session.totalOutputTokens,
      totalReasoningTokens: session.totalReasoningTokens,
      totalCacheReadTokens: session.totalCacheReadTokens,
      totalCacheWriteTokens: session.totalCacheWriteTokens,
      totalCost: session.totalCost,
      totalLatencyMs: session.totalLatencyMs,
      llmActiveMs,
      totalToolCallCount: session.totalToolCallCount,
      totalLlmCallCount: session.totalLlmCallCount,
      totalSkillLoadCount: session.totalSkillLoadCount,
      totalSubagentCount: session.totalSubagentCount,
      model: session.model,
      user: session.user,
      sourcePath: session.sourcePath,
      agents,
      skills,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
