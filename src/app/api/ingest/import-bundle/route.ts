// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// POST /api/ingest/import-bundle —— workflow-bundle 导入（job 化，design.md §5）。
// 校验失败同步 4xx；通过则后台 job 全量导入会话并立即返回 jobId，
// 进度走 GET /api/ingest/import-bundle/status?jobId=。

import { NextRequest, NextResponse } from 'next/server';
import { withRouteLog } from '@/lib/api-route';
import { checkImportablePath } from '@/lib/ingest/import-paths';
import { prisma } from '@/lib/db';
import { logError } from '@/lib/logger';
import { createImportJob, validateBundleDir } from '@/lib/run/import-service';

export const maxDuration = 300;

export const POST = withRouteLog('ingest/import-bundle', async (request: NextRequest) => {
  try {
    const body = await request.json();
    const dirPath: unknown = (body as { dirPath?: unknown }).dirPath;
    if (typeof dirPath !== 'string' || dirPath.length === 0) {
      return NextResponse.json({ error: 'Missing required field: dirPath' }, { status: 400 });
    }

    // 白名单收紧（CANNBOT_INSIGHT_IMPORT_ROOTS 设置时）先于一切文件读取——
    // 与 import-file / import-file/sessions / browse-directory 同一前置闸
    const pathDecision = checkImportablePath(dirPath);
    if (!pathDecision.ok) {
      return NextResponse.json(
        {
          error: `Path "${dirPath}" is outside the allowed import roots: ${pathDecision.roots.join(', ')}`,
          reason: 'path-outside-import-roots',
        },
        { status: 403 },
      );
    }

    const validation = validateBundleDir(dirPath);
    if (!validation.ok || !validation.manifest) {
      return NextResponse.json(
        { error: validation.error, reason: validation.reason },
        { status: validation.status },
      );
    }

    const jobId = createImportJob(dirPath, validation.manifest, { prisma });
    return NextResponse.json({ ok: true, jobId, runId: validation.manifest.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logError('route:ingest/import-bundle', '导入 bundle 失败', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
});
