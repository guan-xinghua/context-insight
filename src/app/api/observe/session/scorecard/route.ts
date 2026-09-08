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
import { runScorecard, scorecardStore } from '@/lib/scoring';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const taskId = searchParams.get('taskId');
    if (!taskId) {
      return NextResponse.json({ error: 'Missing taskId' }, { status: 400 });
    }

    const session = await prisma.session.findFirst({ where: { taskId }, select: { id: true } });
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    const cached = await scorecardStore().get(session.id);
    if (cached) return NextResponse.json(cached);

    // 首次打开：现算确定性层（零 LLM）并写盘
    const card = await runScorecard(taskId, prisma);
    if (!card) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }
    return NextResponse.json(card);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// 强制重算确定性层（旧卡自动归档 archive/，历史保留）
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { taskId?: string };
    if (!body.taskId) {
      return NextResponse.json({ error: 'Missing taskId' }, { status: 400 });
    }
    const card = await runScorecard(body.taskId, prisma);
    if (!card) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }
    return NextResponse.json(card);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
