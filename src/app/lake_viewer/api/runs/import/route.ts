// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { NextRequest, NextResponse } from 'next/server';
import { importSession } from '@/app/lake_viewer/_lib/insight-data';
import { invalidateCaches } from '@/app/lake_viewer/_lib/runs';
import { sessionHref } from '@/lib/shared/session-link';
import { withRouteLog } from '@/lib/api-route';

export const maxDuration = 300;

export const POST = withRouteLog('lake_viewer/api/runs/import', async (request: NextRequest) => {
  const { sid, recording } = await request.json() as { sid?: string; recording?: string };
  if (!sid) {
    return NextResponse.json({ error: 'Missing sid' }, { status: 400 });
  }
  // recording 缺省按 capture 兼容旧客户端；非法值同样回落（导入侧会因目录
  // 不存在而 502，无需在此强校验）
  const result = await importSession(sid, recording === 'native' ? 'native' : 'capture');
  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? 'Import failed' }, { status: 502 });
  }
  invalidateCaches();
  // 权威深链（sessionHref 契约）：framework 用导入结果的行级回读（记录类，
  // 捕获行带 -proxy 后缀）——lake meta 的 agent 裸名会挡成 404。回读失败
  // （DB 故障极端场景）降级为无消歧参数：详情页单行直取/双行走消歧分支
  return NextResponse.json({ ok: true, sid, insightUrl: sessionHref(sid, result.framework) });
});
