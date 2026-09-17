// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 设为基线会话：把本 session 的确定性度量（token/工具耗时/四类冗余比率）写成
// 该任务类型的基线——基线 = 一个样例会话（同类任务各一），新会话与它比比值。
// 度量提取与评分同一组函数（core/baseline/measures），设基线时怎么量、评分时就怎么量。

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { assembleInput } from '@/lib/scoring/core/assembler';
import { BASELINE_MEASURES } from '@/lib/scoring/core/baseline/measures';
import { writeSessionBaseline, type SessionBaselineFile, type SessionBaselineMetric } from '@/lib/scoring/core/baseline/session-baseline';

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    const { taskId, framework } = (await request.json()) as { taskId?: string; framework?: string };
    if (!taskId) return NextResponse.json({ error: 'Missing taskId' }, { status: 400 });

    const assembled = await assembleInput(taskId, prisma, framework || undefined);
    if (!assembled) return NextResponse.json({ error: `session not found: ${taskId}` }, { status: 404 });
    const { input, raw } = assembled;
    if (input.taskType === 'unknown') {
      return NextResponse.json({ error: '任务类型未知（无法归入 operator/general 基线组）；先在含算子特征的会话上设置' }, { status: 400 });
    }

    const metrics: Record<string, SessionBaselineMetric> = {};
    for (const [key, entry] of Object.entries(BASELINE_MEASURES)) {
      const value = entry.measure(input);
      if (value != null) metrics[key] = { value, unit: entry.unit };
    }
    const label = input.userMessages[0]?.text?.slice(0, 40) || raw.session.taskId;
    const file: SessionBaselineFile = {
      schema: 'workflow-session-baseline',
      version: 1,
      taskType: input.taskType,
      sessionId: raw.session.sessionId,
      label,
      computedAt: new Date().toISOString(),
      metrics,
      context: {
        models: [...new Set(raw.turns.map(t => t.model).filter((m): m is string => m != null))],
        frameworkVersion: raw.session.version ?? null,
      },
    };
    const written = await writeSessionBaseline(file);
    return NextResponse.json({
      ok: true,
      taskType: file.taskType,
      sessionId: file.sessionId,
      label: file.label,
      metricsCount: Object.keys(metrics).length,
      file: written,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'internal error' }, { status: 500 });
  }
}
