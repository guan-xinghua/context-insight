// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// GET /api/observe/run/[runId]/member?nodeId&generation —— 节点实例详情
// （五键的节点维度：attempts 逐条 + 会话 join + 同节点跨代全景）。

import { NextRequest, NextResponse } from 'next/server';
import { withRouteLog } from '@/lib/api-route';
import { prisma } from '@/lib/db';
import { logError } from '@/lib/logger';
import { readRun } from '@/lib/run/run-store';
import { buildViewModel, findNodeInstance } from '@/lib/run/view-model';
import { attachSessionRefs, joinSessionRefs } from '@/lib/run/session-link';
import { attachSessionScores } from '@/lib/run/session-score';

export const GET = withRouteLog(
  'observe/run/[runId]/member',
  async (request: NextRequest, { params }: { params: Promise<{ runId: string }> }) => {
    const { runId } = await params;
    const { searchParams } = request.nextUrl;
    const nodeId = searchParams.get('nodeId');
    const generation = Number.parseInt(searchParams.get('generation') ?? '', 10);
    if (!nodeId || !Number.isInteger(generation) || generation < 0) {
      return NextResponse.json(
        { error: 'Missing or invalid query params: nodeId (string), generation (non-negative int)' },
        { status: 400 },
      );
    }
    try {
      const stored = readRun(runId);
      if (!stored) {
        return NextResponse.json({ error: `Run not found: ${runId}`, reason: 'run-not-found' }, { status: 404 });
      }
      const vm = buildViewModel(stored.index);
      const node = findNodeInstance(vm, nodeId, generation);
      if (!node) {
        return NextResponse.json(
          { error: `Member not found: nodeId=${nodeId} generation=${generation}`, reason: 'member-not-found' },
          { status: 404 },
        );
      }
      const lookup = await joinSessionRefs(stored.index, prisma);
      await attachSessionScores(lookup, prisma);
      attachSessionRefs(vm, lookup);
      // 同逻辑节点跨代全景（侧栏「出现在第 N 代」导航）
      const peers = vm.nodes
        .filter(n => n.nodeId === nodeId && n.generation !== generation)
        .sort((a, b) => a.generation - b.generation)
        .map(n => ({ key: n.key, generation: n.generation, status: n.status }));
      // 该节点触发的回滚记录
      const rollbacks = vm.rollbacks.filter(r => r.triggerKey === node.key);
      return NextResponse.json({ node, peers, rollbacks });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logError('route:observe/run/[runId]/member', '读取成员失败', { runId, nodeId, error: message });
      return NextResponse.json({ error: message }, { status: 500 });
    }
  },
);
