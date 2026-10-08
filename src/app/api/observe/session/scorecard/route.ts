// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 评分卡 v2（六维）：文件存储 data/scorecards/（缓存定位——事实源是 turns 数据，
// 随时可删可重算）。GET 读最新一张，没有则现算确定性层（首次打开零等待）；
// POST 强制重算。aborted（截断）卡不写盘，直接返回并说明原因。

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { runScorecard, loadRegistry, scorecardStore, deriveItemScores } from '@/lib/scoring';
import { applyOverlays } from '@/lib/scoring/core/overlays';
import { withRouteLog } from '@/lib/api-route';

export const GET = withRouteLog('observe/session/scorecard', async (request: NextRequest) => {
  const { searchParams } = new URL(request.url);
  const taskId = searchParams.get('taskId');
  const framework = searchParams.get('framework');
  if (!taskId) {
    return NextResponse.json({ error: 'Missing taskId' }, { status: 400 });
  }

  const session = await prisma.session.findFirst({ where: { taskId, ...(framework ? { framework } : {}) }, select: { id: true } });
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  const cached = await scorecardStore().get(session.id);
  const registry = await loadRegistry();
  if (cached) {
    return NextResponse.json(deriveItemScores(await applyOverlays(cached, registry.defs, registry.profile), registry.defs));
  }

  // 首次打开：现算确定性层（零 LLM）并写盘
  const card = await runScorecard(taskId, prisma, framework ? { framework } : {});
  if (!card) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  return NextResponse.json(deriveItemScores(await applyOverlays(card, registry.defs, registry.profile), registry.defs));
});

// 强制重算确定性层（旧卡自动归档 archive/，历史保留）
export const POST = withRouteLog('observe/session/scorecard', async (request: NextRequest) => {
  const body = await request.json() as { taskId?: string; framework?: string };
  if (!body.taskId) {
    return NextResponse.json({ error: 'Missing taskId' }, { status: 400 });
  }
  const card = await runScorecard(body.taskId, prisma, body.framework ? { framework: body.framework } : {});
  if (!card) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  const registry = await loadRegistry();
  return NextResponse.json(deriveItemScores(await applyOverlays(card, registry.defs, registry.profile), registry.defs));
});
