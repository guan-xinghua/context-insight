// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { NextRequest, NextResponse } from 'next/server';
import { deltaRefreshSession } from '@/lib/ingest/data-service';
import { prisma } from '@/lib/db';

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { taskId, framework } = body;

    if (!taskId) {
      return NextResponse.json({ error: 'Missing taskId' }, { status: 400 });
    }

    const where: Record<string, string> = { taskId };
    if (framework) where.framework = framework;

    const session = await prisma.session.findFirst({ where });

    if (!session) {
      return NextResponse.json({ error: `Session not found: "${taskId}"` }, { status: 404 });
    }

    if (!session.sourcePath) {
      return NextResponse.json({ error: 'No sourcePath stored for this session — cannot refresh' }, { status: 400 });
    }

    // 直传已按 framework 消歧解析出的行——同 sid 双行下裸 taskId 会在
    // deltaRefreshSession 内二次查找时打到另一行（刷新错行）
    const result = await deltaRefreshSession(taskId, prisma, session);

    // 漂移全量重建单独提示：addedTurns 是相对替换前的净增，总轮数在
    // rebuiltTurns——不能把整个会话的轮数报成「新增 N 轮」
    const message = result.fullRebuild
      ? `检测到源回溯性变化（位次漂移），已全量重建 ${result.rebuiltTurns ?? 0} 轮`
      : result.addedTurns > 0
        ? `增量刷新完成，新增 ${result.addedTurns} 轮，更新 ${result.updatedTurns} 轮`
        : `增量刷新完成，更新 ${result.updatedTurns} 轮`;

    return NextResponse.json({
      success: true,
      sessionId: session.id,
      addedTurns: result.addedTurns,
      updatedTurns: result.updatedTurns,
      addedToolCalls: result.addedToolCalls,
      updatedToolCalls: result.updatedToolCalls,
      addedSkillEvents: result.addedSkillEvents,
      fullRebuild: result.fullRebuild ?? false,
      rebuiltTurns: result.rebuiltTurns ?? 0,
      message,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
