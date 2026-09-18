// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { NextRequest, NextResponse } from 'next/server';
import { importSession } from '@/app/cannbay_viewer/_lib/insight-data';
import { invalidateCaches } from '@/app/cannbay_viewer/_lib/runs';

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    const { sid } = await request.json() as { sid?: string };
    if (!sid) {
      return NextResponse.json({ error: 'Missing sid' }, { status: 400 });
    }
    const result = await importSession(sid);
    if (!result.ok) {
      return NextResponse.json({ error: result.error ?? 'Import failed' }, { status: 502 });
    }
    invalidateCaches();
    return NextResponse.json({ ok: true, sid });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
