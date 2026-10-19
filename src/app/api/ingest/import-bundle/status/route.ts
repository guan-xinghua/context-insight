// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// GET /api/ingest/import-bundle/status?jobId= —— 导入 job 进度轮询。
// job 注册表进程内（单实例部署模型）；重启丢失可接受：manifest 已落盘、
// 会话导入幂等，重新发起即续传。

import { NextRequest, NextResponse } from 'next/server';
import { withRouteLog } from '@/lib/api-route';
import { getImportJob } from '@/lib/run/import-service';

export const GET = withRouteLog('ingest/import-bundle/status', async (request: NextRequest) => {
  const jobId = request.nextUrl.searchParams.get('jobId');
  if (!jobId) {
    return NextResponse.json({ error: 'Missing required query param: jobId' }, { status: 400 });
  }
  const job = getImportJob(jobId);
  if (!job) {
    return NextResponse.json(
      { error: `Job not found: ${jobId}（不存在或已过期，重新发起导入即续传）`, reason: 'job-not-found' },
      { status: 404 },
    );
  }
  return NextResponse.json({ job });
});
