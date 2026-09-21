// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 列表页 LLM Active 批量计算：单查询取一组会话的全部 assistant turn 窗口，
// 内存分组后逐会话区间并集（computeLlmActiveMs）。列表 SSR（page.tsx）与
// /api/observe/data 共用——避免 N+1（与列表既有 error 统计查询同款模式）。
import { prisma } from '@/lib/db';
import { computeLlmActiveMs } from '@/lib/session-duration';

export async function getLlmActiveMsMap(sessionIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (sessionIds.length === 0) return out;
  const turns = await prisma.turn.findMany({
    where: { sessionId: { in: sessionIds }, role: 'assistant' },
    select: { sessionId: true, createdAt_ts: true, completedAt: true, latencyMs: true },
  });
  const bySession = new Map<string, Array<{ createdAt_ts: Date | null; completedAt: Date | null; latencyMs: number }>>();
  for (const t of turns) {
    if (t.createdAt_ts == null) continue;
    const list = bySession.get(t.sessionId) ?? [];
    list.push({ createdAt_ts: t.createdAt_ts, completedAt: t.completedAt, latencyMs: t.latencyMs });
    bySession.set(t.sessionId, list);
  }
  for (const [sid, list] of bySession) {
    out.set(sid, computeLlmActiveMs(list));
  }
  return out;
}
