// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { NextResponse } from 'next/server';
import { readParadigmTarget, setParadigmTarget, NotesConflictError } from '@/lib/lake/notes';

export async function GET(_req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  try {
    return NextResponse.json({ name, target: await readParadigmTarget(name) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'bad paradigm' }, { status: 400 });
  }
}

// body: {baselineMs?: number|null, expectedMs?: number|null}（正数毫秒；null=清除该目标）。
// 畸形 body / 两键俱缺一律 400——目标记录是追加式"末条生效"，吞成全 null 会
// 把团队已存参考线整条抹掉。
export async function POST(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  let body: { baselineMs?: unknown; expectedMs?: unknown };
  try {
    body = await req.json() as { baselineMs?: unknown; expectedMs?: unknown };
  } catch {
    return NextResponse.json({ error: 'invalid json body' }, { status: 400 });
  }
  if (!('baselineMs' in body) && !('expectedMs' in body)) {
    return NextResponse.json({ error: 'baselineMs or expectedMs required' }, { status: 400 });
  }
  // 键存在但值既非 number 也非显式 null → 400：静默收敛成 null 会追加一条全
  // null 记录，末条生效语义下等于把团队已存参考线整条抹掉
  for (const key of ['baselineMs', 'expectedMs'] as const) {
    if (key in body && body[key] !== null && typeof body[key] !== 'number') {
      return NextResponse.json({ error: `${key} must be a number or null` }, { status: 400 });
    }
  }
  const baselineMs = typeof body.baselineMs === 'number' ? body.baselineMs : null;
  const expectedMs = typeof body.expectedMs === 'number' ? body.expectedMs : null;
  try {
    await setParadigmTarget(name, baselineMs, expectedMs);
    return NextResponse.json({ name, target: await readParadigmTarget(name) });
  } catch (e) {
    if (e instanceof NotesConflictError) return NextResponse.json({ error: e.message }, { status: 409 });
    return NextResponse.json({ error: e instanceof Error ? e.message : 'save failed' }, { status: 400 });
  }
}
