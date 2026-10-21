// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { NextRequest, NextResponse } from 'next/server';
import { importLakeBundle } from '@/lib/lake/bundle';
import { prisma } from '@/lib/db';
import { withRouteLog } from '@/lib/api-route';

export const maxDuration = 300;

export const POST = withRouteLog('lake_viewer/api/bundles/import', async (request: NextRequest) => {
  const { runId } = await request.json() as { runId?: string };
  if (!runId) {
    return NextResponse.json({ error: 'Missing runId' }, { status: 400 });
  }
  try {
    const handle = importLakeBundle(runId, { prisma });
    return NextResponse.json(handle);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Import failed' },
      { status: 502 },
    );
  }
});
