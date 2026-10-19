// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '@/lib/db';
import { getLakeListing } from '@/app/lake_viewer/_lib/runs';
import { inferLanes } from '@/lib/swimlane-lanes';
import { withRouteLog } from '@/lib/api-route';

/** 会话车道表三级解析：① 湖范式（listing 反查，60s TTL 缓存）×
 *  swimlane-lanes.json（范式 → 车道表，仓库根可配置）命中即用（声明即
 *  信任）② 范式缺失/未配置（本地会话未上湖、根级/sessions/ 通用目录）→
 *  派发描述内容签名推断（inferLanes，阈值与口径见该函数）③ 都不满足
 *  返回空表——泳道回落贪心，非车道工作流零行为变化。source 标记来源，
 *  推断车道在泳道图上带标记，避免读图时把猜测当成声明。 */
export const GET = withRouteLog('observe/session/lanes', async (request: NextRequest) => {
  const searchParams = request.nextUrl.searchParams;
  const taskId = searchParams.get('taskId');
  const framework = searchParams.get('framework');
  if (!taskId) {
    return NextResponse.json({ error: 'taskId is required' }, { status: 400 });
  }

  // 同 sid 双记录（capture/native）按 framework 消歧——裸 taskId 会任取一行，
  // 喂给 inferLanes 的桥来自错误记录类（与 turns/bridges 路由同口径）
  const sessionWhere: Record<string, string> = { taskId };
  if (framework) sessionWhere.framework = framework;
  const session = await prisma.session.findFirst({ where: sessionWhere });
  if (!session) {
    return NextResponse.json({ error: `Session not found: taskId=${taskId}` }, { status: 404 });
  }

  let paradigm: string | null = null;
  try {
    const listing = await getLakeListing();
    const hit = listing.sessions.find(s => s.sid === taskId && s.paradigm)
      ?? listing.sessions.find(s => s.sid === taskId);
    paradigm = hit?.paradigm || null;
  } catch {
    // 湖不可达：范式缺失走 ② 推断，本地会话不受湖故障影响
  }

  const config = loadLanesConfig();
  const declared = paradigm ? config[paradigm] : undefined;
  if (declared) {
    return NextResponse.json({ paradigm, lanes: declared, source: 'paradigm' });
  }

  const bridges = await prisma.interactionBridge.findMany({
    where: { sessionId: session.id },
    select: { dispatchContent: true },
  });
  const inferred = inferLanes(bridges.map(b => b.dispatchContent), config);
  return NextResponse.json({
    paradigm: inferred?.paradigm ?? paradigm,
    lanes: inferred?.lanes ?? [],
    source: inferred ? 'inferred' : null,
  });
});

let lanesCache: Record<string, string[]> | null = null;

function loadLanesConfig(): Record<string, string[]> {
  if (lanesCache !== null) return lanesCache;
  try {
    const p = path.join(process.cwd(), 'swimlane-lanes.json');
    if (fs.existsSync(p)) {
      lanesCache = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, string[]>;
      return lanesCache;
    }
  } catch (e) {
    console.warn('Failed to load swimlane-lanes.json:', e);
  }
  lanesCache = {};
  return lanesCache;
}
