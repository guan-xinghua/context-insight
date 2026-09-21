// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getLlmActiveMsMap } from '@/lib/llm-active-map';
import { getActiveSplitMap } from '@/lib/active-time-map';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const page = Math.max(1, Number(searchParams.get('page') ?? 1));
    const pageSize = Math.max(1, Math.min(100, Number(searchParams.get('pageSize') ?? 20)));
    const isSubagent = searchParams.get('isSubagent');
    const user = searchParams.get('user');
    // 会话搜索（keyword / sessionID）：taskId / query / label 任一子串命中
    const q = searchParams.get('q')?.trim() ?? '';

    const conditions: Record<string, unknown>[] = [];
    if (user) conditions.push({ user });
    if (q) conditions.push({ OR: [{ taskId: { contains: q } }, { query: { contains: q } }, { label: { contains: q } }] });
    if (isSubagent !== null && isSubagent !== undefined && isSubagent !== '') {
      conditions.push({ executions: { some: { isSubagent: isSubagent === 'true' } } });
    }
    const where: Record<string, unknown> = conditions.length > 0 ? { AND: conditions } : {};

    const [total, totalCount] = await Promise.all([
      prisma.session.count({ where }),
      q ? prisma.session.count() : Promise.resolve(null),
    ]);

    const sessions = await prisma.session.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        taskId: true,
        query: true,
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
        framework: true,
        version: true,
        sourcePath: true,
        createdAt: true,
      },
    });

    // LLM Active（模型推理时间）：单查询批量取本页会话 turn 窗口算区间并集
    // ——列表 Duration 语义，墙钟由 Start→End 列反映
    const llmActive = await getLlmActiveMsMap(sessions.map(s => s.id));
    // 活跃 / 墙钟（事件聚类口径，与详情页 Wall Clock 拆分同源）
    const activeSplit = await getActiveSplitMap(sessions);

    const items = sessions.map((s) => ({
      sessionId: s.id,
      taskId: s.taskId,
      query: s.query,
      startTime: s.startTime,
      endTime: s.endTime,
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
    }));

    return NextResponse.json({ items, total, page, ...(totalCount != null ? { totalCount } : {}) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
