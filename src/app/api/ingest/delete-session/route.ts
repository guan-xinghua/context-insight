// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { withRouteLog } from '@/lib/api-route';
import { logInfo, logWarn } from '@/lib/logger';
import { invalidateCaches } from '@/app/lake_viewer/_lib/runs';
import { cascadeDeleteSessionRows } from '@/lib/ingest/session-cascade';

// Delete a session and ALL its child rows. SQLite foreign-key cascade is not
// reliably enforced (PRAGMA state varies), so child rows are removed explicitly
// in dependency order inside a transaction (shared with run 域删除级联).
async function cascadeDeleteSession(id: string): Promise<void> {
  await cascadeDeleteSessionRows(prisma, [id]);
}

export const DELETE = withRouteLog('ingest/delete-session', async (request: NextRequest) => {
  const body = await request.json();
  const { taskId, framework, deleteAll, sessions: batchSessions } = body;

  if (deleteAll) {
    const count = await prisma.session.count();
    // Explicit cascade: delete child rows in dependency order inside a
    // transaction. SQLite foreign-key cascade is not reliably enforced
    // (PRAGMA state varies), so without this child rows orphan and accumulate.
    await prisma.$transaction([
      prisma.executionSkill.deleteMany({}),
      prisma.toolCall.deleteMany({}),
      prisma.skillEvent.deleteMany({}),
      prisma.execution.deleteMany({}),
      prisma.sessionSkill.deleteMany({}),
      prisma.interactionBridge.deleteMany({}),
      prisma.turn.deleteMany({}),
      prisma.session.deleteMany({}),
    ]);
    logInfo('route:ingest/delete-session', '全库清空', { deleteAll: true, deleted: count });
    invalidateCaches();
    return NextResponse.json({ deleted: count });
  }

  if (Array.isArray(batchSessions)) {
    let deleted = 0;
    for (const entry of batchSessions) {
      if (!entry || typeof entry.taskId !== 'string') continue;
      const where: Record<string, string> = { taskId: entry.taskId };
      if (typeof entry.framework === 'string') where.framework = entry.framework;
      const found = await prisma.session.findMany({ where });
      for (const s of found) {
        await cascadeDeleteSession(s.id);
        deleted++;
      }
    }
    logInfo('route:ingest/delete-session', '批量删除完成', { batch: batchSessions.length, deleted });
    invalidateCaches();
    return NextResponse.json({ deleted, batch: batchSessions.length });
  }

  if (!taskId) {
    return NextResponse.json({ error: 'Missing taskId' }, { status: 400 });
  }

  const where: Record<string, string> = { taskId };
  if (framework) where.framework = framework;

  const sessions = await prisma.session.findMany({ where });

  if (sessions.length === 0) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  // 方案一双行防误删：无 framework 消歧且命中多行（同 sid 双记录并存）时
  // 拒绝执行，返回 409 + rowCount 让前端弹确认——无消歧删除会级联清掉
  // 全部行。前端显式带 confirmAll: true（用户已确认）才放行
  if (!framework && sessions.length > 1 && body.confirmAll !== true) {
    logWarn('route:ingest/delete-session', '删除被拒（多行未消歧）', { taskId, rowCount: sessions.length });
    return NextResponse.json({
      error: `Multiple sessions (${sessions.length}) share taskId "${taskId}" (dual recording) — delete-all requires confirmation`,
      multiRow: true,
      rowCount: sessions.length,
      taskId,
    }, { status: 409 });
  }

  for (const s of sessions) {
    await cascadeDeleteSession(s.id);
  }
  logInfo('route:ingest/delete-session', '会话已删除', { taskId, framework: framework ?? '', deleted: sessions.length });
  invalidateCaches();
  return NextResponse.json({ deleted: sessions.length, taskId });
});
