// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 疑似点人工复核：POST 记一条确认（problem=有问题扣分 / fine=没问题出池），
// 返回应用确认状态后重新聚合的整卡。疑似点在卡上（itemId × turnIndex × label 定位），
// 服务端从缓存卡里找回该条 evidence 再记——key 与卡同源，不接受客户端自拼。

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { loadRegistry, scorecardStore, deriveItemScores } from '@/lib/scoring';
import { pointKeyOf, recordAdjudication } from '@/lib/scoring/core/adjudicate';
import { applyOverlays } from '@/lib/scoring/core/overlays';
import { withRouteLog } from '@/lib/api-route';
import { logInfo } from '@/lib/logger';

export const POST = withRouteLog('observe/session/scorecard/adjudicate', async (request: NextRequest) => {
  const body = await request.json() as {
    taskId?: string;
    framework?: string;
    itemId?: string;
    turnIndex?: number | null;
    label?: string;
    confirmed?: 'problem' | 'fine';
  };
  if (!body.taskId || !body.itemId || typeof body.label !== 'string' || (body.confirmed !== 'problem' && body.confirmed !== 'fine')) {
    return NextResponse.json({ error: 'Missing taskId/itemId/label/confirmed（problem|fine）' }, { status: 400 });
  }

  const session = await prisma.session.findFirst({
    where: { taskId: body.taskId, ...(body.framework ? { framework: body.framework } : {}) },
    select: { id: true },
  });
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  const card = await scorecardStore().get(session.id);
  if (!card) {
    return NextResponse.json({ error: '还没有评分卡——先计算/评审出卡再确认' }, { status: 404 });
  }

  // 从卡上找回该疑似点（防自拼 key）：itemId + turnIndex + label 三元组匹配
  const item = card.dimensions.flatMap(d => d.items).find(i => i.itemId === body.itemId);
  const point = item?.evidence.find(e => e.label === body.label && e.turnIndex === (body.turnIndex ?? null));
  if (!item || !point || item.verdict !== 'suspected') {
    return NextResponse.json({ error: '卡上找不到该疑似点（或已不是疑似）——先重算评分卡' }, { status: 404 });
  }

  recordAdjudication(session.id, pointKeyOf(item.itemId, point), body.confirmed);
  logInfo('route:observe/session/scorecard/adjudicate', '人工复核判定', { taskId: body.taskId, itemId: item.itemId, label: body.label, turnIndex: body.turnIndex ?? null, confirmed: body.confirmed });
  const registry = await loadRegistry();
  return NextResponse.json(deriveItemScores(await applyOverlays(card, registry.defs, registry.profile), registry.defs));
});
