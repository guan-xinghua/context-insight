// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 基准测试填报：用户把基准测试排行榜总分（百分制）填到本 session，
// 评分时折算 0-10 进 D3「基准测试评分」子项。GET 读当前值，POST 写入。

import { NextRequest, NextResponse } from 'next/server';
import { logError, logInfo } from '@/lib/logger';
import { prisma } from '@/lib/db';
import { loadSessionBenchReport, writeSessionBenchReport, type SessionBenchReportFile } from '@/lib/scoring/core/bench-report/session-bench-report';

export const maxDuration = 60;

async function resolveSessionId(taskId: string, framework?: string | null): Promise<string | null> {
  const session = await prisma.session.findFirst({ where: { taskId, ...(framework ? { framework } : {}) }, select: { id: true } });
  return session?.id ?? null;
}

export async function GET(request: NextRequest) {
  try {
    const taskId = request.nextUrl.searchParams.get('taskId');
    const framework = request.nextUrl.searchParams.get('framework');
    if (!taskId) return NextResponse.json({ error: 'Missing taskId' }, { status: 400 });
    const sessionId = await resolveSessionId(taskId, framework);
    if (!sessionId) return NextResponse.json({ error: `session not found: ${taskId}` }, { status: 404 });
    const bench = await loadSessionBenchReport(sessionId);
    return NextResponse.json({ score: bench?.score ?? null, note: bench?.note ?? null, filledAt: bench?.filledAt ?? null });
  } catch (e) {
    logError('route:observe/session/scorecard/bench-report', 'bench-report 失败', { error: e instanceof Error ? e.message : String(e) });
    return NextResponse.json({ error: e instanceof Error ? e.message : 'internal error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { taskId, framework, score, note } = (await request.json()) as { taskId?: string; framework?: string; score?: unknown; note?: unknown };
    if (!taskId) return NextResponse.json({ error: 'Missing taskId' }, { status: 400 });
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100) {
      return NextResponse.json({ error: 'score 必须是 0-100 的数字（百分制总分）' }, { status: 400 });
    }
    const sessionId = await resolveSessionId(taskId, framework);
    if (!sessionId) return NextResponse.json({ error: `session not found: ${taskId}` }, { status: 404 });

    const file: SessionBenchReportFile = {
      schema: 'workflow-session-bench-report',
      version: 1,
      sessionId,
      score,
      note: typeof note === 'string' && note.trim() ? note.trim() : undefined,
      filledAt: new Date().toISOString(),
    };
    const written = await writeSessionBenchReport(file);
    logInfo('route:observe/session/scorecard/bench-report', '基准测试填报', { taskId: sessionId, score });
    return NextResponse.json({ ok: true, score, file: written });
  } catch (e) {
    logError('route:observe/session/scorecard/bench-report', 'bench-report 失败', { error: e instanceof Error ? e.message : String(e) });
    return NextResponse.json({ error: e instanceof Error ? e.message : 'internal error' }, { status: 500 });
  }
}
