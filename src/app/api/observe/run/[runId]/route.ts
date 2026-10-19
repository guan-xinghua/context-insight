// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// GET    /api/observe/run/[runId] —— Run 详情：view-model + 成员会话 join。
// DELETE /api/observe/run/[runId] —— 删 run 目录（不级联删除已导入会话）。

import { NextRequest, NextResponse } from 'next/server';
import { withRouteLog } from '@/lib/api-route';
import { prisma } from '@/lib/db';
import { logError, logInfo } from '@/lib/logger';
import { deleteRun, readRun, runsRoot } from '@/lib/run/run-store';
import { deleteOwnedSessionRows } from '@/lib/run/session-scope';
import { buildViewModel } from '@/lib/run/view-model';
import { attachSessionRefs, joinSessionRefs } from '@/lib/run/session-link';

export const GET = withRouteLog(
  'observe/run/[runId]',
  async (_request: NextRequest, { params }: { params: Promise<{ runId: string }> }) => {
    const { runId } = await params;
    try {
      const stored = readRun(runId);
      if (!stored) {
        return NextResponse.json({ error: `Run not found: ${runId}`, reason: 'run-not-found' }, { status: 404 });
      }
      const vm = buildViewModel(stored.index);
      // 成员 ↔ Prisma 会话 join（缺正文成员 session=null，视图容忍渲染）
      const lookup = await joinSessionRefs(stored.index, prisma);
      attachSessionRefs(vm, lookup);
      return NextResponse.json({
        run: {
          runId: stored.runId,
          name: stored.manifest.name ?? null,
          status: vm.status,
          exportDataComplete: vm.exportDataComplete,
          startedAt: vm.startedAt,
          finishedAt: vm.finishedAt,
          import: stored.meta?.data ?? null,
        },
        viewModel: vm,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logError('route:observe/run/[runId]', '读取 run 失败', { runId, error: message });
      return NextResponse.json({ error: message }, { status: 500 });
    }
  },
);

export const DELETE = withRouteLog(
  'observe/run/[runId]',
  async (_request: NextRequest, { params }: { params: Promise<{ runId: string }> }) => {
    const { runId } = await params;
    try {
      // 级联清理本 run 导入的会话行（owned 精确对，用户自有会话不受影响），
      // 再删 run 目录——先会话后目录，中途失败时整体可重试
      const stored = readRun(runId);
      const owned = stored?.meta?.data.ownedSessions ?? [];
      const deletedSessions = await deleteOwnedSessionRows(prisma, runsRoot(), owned);
      const ok = deleteRun(runId);
      if (!ok) {
        return NextResponse.json({ error: `Run not found: ${runId}`, reason: 'run-not-found' }, { status: 404 });
      }
      logInfo('route:observe/run/[runId]', '删除 run（级联清理导入会话）', {
        runId,
        deletedSessions,
      });
      return NextResponse.json({ ok: true, runId, deletedSessions });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logError('route:observe/run/[runId]', '删除 run 失败', { runId, error: message });
      return NextResponse.json({ error: message }, { status: 500 });
    }
  },
);
