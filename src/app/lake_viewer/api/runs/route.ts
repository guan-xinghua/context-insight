// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { NextRequest, NextResponse } from 'next/server';
import { listRuns } from '@/app/lake_viewer/_lib/runs';
import { ensureMirrorAsync } from '@/lib/lake/mirror';
import { withRouteLog } from '@/lib/api-route';

function csv(p: string | null): string[] | undefined {
  if (!p) return undefined;
  const list = p.split(',').map(s => s.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

export const GET = withRouteLog('lake_viewer/api/runs', async (request: NextRequest) => {
  const { searchParams } = request.nextUrl;
  const paradigm = searchParams.get('paradigm');
  if (!paradigm) {
    return NextResponse.json({ error: 'Missing paradigm' }, { status: 400 });
  }
  await ensureMirrorAsync();
  const opGenRaw = searchParams.get('opGen');    const scoredRaw = searchParams.get('scored');
  const importedRaw = searchParams.get('imported');
  const result = await listRuns({
    paradigm,
    framework: csv(searchParams.get('framework')),
    ccVersion: csv(searchParams.get('ccVersion')),
    opGen: opGenRaw === 'success' || opGenRaw === 'failure' ? opGenRaw : undefined,
    scored: scoredRaw === 'true' ? true : scoredRaw === 'false' ? false : undefined,
    imported: importedRaw === 'true' ? true : importedRaw === 'false' ? false : undefined,
    q: searchParams.get('q')?.trim() || undefined,
    from: searchParams.get('from') || undefined,
    to: searchParams.get('to') || undefined,
    tz: searchParams.get('tz') || undefined,
  });
  return NextResponse.json(result);
});
