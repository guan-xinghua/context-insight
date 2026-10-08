// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getOrStartLlmExtract } from '@/lib/llm-workflow-extract';
import { withRouteLog } from '@/lib/api-route';

/**
 * Skills tab 的 LLM root 行「提取/重试」按钮：GET 启动/查询提取任务。
 * 服务端模块级缓存 + 非阻塞：GET 立即返回（不占 HTTP 连接），前端轮询。
 * 失败的 job 不自动重启（前端轮询会把它变成无限重启死循环）——显式重试带 ?restart=1。
 */
export const GET = withRouteLog('observe/session/llm-workflow-extract', async (request: Request) => {
  const { searchParams } = new URL(request.url);
  const taskId = searchParams.get('taskId');
  const framework = searchParams.get('framework');
  const restart = searchParams.get('restart') === '1';

  if (!taskId) {
    return NextResponse.json({ error: 'Missing taskId' }, { status: 400 });
  }

  const session = await prisma.session.findFirst({
    where: framework ? { taskId, framework } : { taskId },
    select: { id: true },
  });
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  // 非阻塞：首次调用启动后台 claude CLI，立即返回 loading=true；
  // restart=1（重试按钮）→ 强制丢弃已失败的 job 重启
  const job = getOrStartLlmExtract(taskId, session.id, prisma, { force: restart });

  return NextResponse.json({
    loading: job.loading,
    content: job.content,
    source: job.source,
    length: job.content?.length ?? 0,
    error: job.error,
  });
});
