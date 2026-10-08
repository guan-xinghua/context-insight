// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { analyzeWorkflow } from '@/lib/ai/analyzer';
import type { AIProviderConfig } from '@/lib/ai/analyzer';
import { withRouteLog } from '@/lib/api-route';
import { logInfo } from '@/lib/logger';

export const POST = withRouteLog('ai/analyze-workflow', async (request: NextRequest) => {
  const body = await request.json();
  const { taskId, provider } = body as {
    taskId: string;
    provider: AIProviderConfig;
  };

  if (!taskId) {
    return NextResponse.json({ error: 'Missing taskId' }, { status: 400 });
  }

  if (!provider?.baseUrl || !provider?.apiKey || !provider?.model) {
    return NextResponse.json({ error: 'Missing provider config (baseUrl, apiKey, model)' }, { status: 400 });
  }

  const t0 = Date.now();
  logInfo('route:ai/analyze-workflow', 'workflow 分析开始', { taskId, model: provider.model ?? '' });
  const result = await analyzeWorkflow(taskId, provider, prisma);
  logInfo('route:ai/analyze-workflow', 'workflow 分析完成', { taskId, ms: Date.now() - t0 });

  return NextResponse.json({ result });
});
