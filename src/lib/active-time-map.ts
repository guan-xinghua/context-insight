// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 首页列表「活跃 / 墙钟」列的批量取数：单查询取本页会话 turns → 逐会话委托
// computeSessionActiveSplit（与会话详情 Wall Clock 拆分、lake viewer 耗时列
// 同一实现，展开规则不复制）。
import { prisma } from '@/lib/db';
import { computeSessionActiveSplit, type ActiveTimeTurnRow } from '@/lib/active-time';
import { isProxyVersion } from '@/lib/shared/session-format';

export interface SessionActiveEntry {
  activeMs: number | null;
  wallMs: number | null;
}

export async function getActiveSplitMap(
  sessions: Array<{ id: string; startTime: Date; endTime: Date | null; version: string | null }>,
): Promise<Map<string, SessionActiveEntry>> {
  const out = new Map<string, SessionActiveEntry>();
  if (sessions.length === 0) return out;
  const turns = await prisma.turn.findMany({
    where: { sessionId: { in: sessions.map(s => s.id) } },
    select: { sessionId: true, createdAt_ts: true, createdAt: true, latencyMs: true, role: true },
  });
  const rowsBySession = new Map<string, ActiveTimeTurnRow[]>();
  for (const t of turns) {
    const list = rowsBySession.get(t.sessionId) ?? [];
    list.push(t);
    rowsBySession.set(t.sessionId, list);
  }
  for (const s of sessions) {
    const wallMs = s.endTime && s.endTime.getTime() >= s.startTime.getTime()
      ? s.endTime.getTime() - s.startTime.getTime()
      : null;
    const split = await computeSessionActiveSplit(
      () => Promise.resolve(rowsBySession.get(s.id) ?? []),
      s.startTime.getTime(),
      s.endTime ? s.endTime.getTime() : null,
      isProxyVersion(s.version),
    );
    let activeMs = split?.activeMs ?? null;
    if (activeMs != null && wallMs != null && activeMs > wallMs) activeMs = wallMs;
    out.set(s.id, { activeMs, wallMs });
  }
  return out;
}
