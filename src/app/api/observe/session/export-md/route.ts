// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { NextRequest, NextResponse } from 'next/server';
import { exportSessionToMarkdown } from '@/lib/export/markdown-exporter';
import { prisma } from '@/lib/db';
import { withRouteLog } from '@/lib/api-route';
import { logInfo } from '@/lib/logger';

export const GET = withRouteLog('observe/session/export-md', async (request: NextRequest) => {
  const { searchParams } = request.nextUrl;
  const taskId = searchParams.get('taskId');
  const framework = searchParams.get('framework');

  if (!taskId) {
    return NextResponse.json(
      { error: 'Missing required parameter: taskId' },
      { status: 400 }
    );
  }

  const markdown = await exportSessionToMarkdown(taskId, prisma, framework ?? undefined);

  const filename = `session_${taskId}.md`;
  logInfo('route:observe/session/export-md', '会话已导出（md）', { taskId, bytes: markdown.length });

  return new NextResponse(markdown, {
    status: 200,
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
});
