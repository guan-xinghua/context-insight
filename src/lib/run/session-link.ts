// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Run 域 ↔ Session 域 join（design.md §4.4，Run 域唯一触 DB 模块）。
// 弱关联：成员 sessionId → Session.taskId；同 sid 双记录（wire 捕获 vs 原生）
// 必须消歧——bundle 会话全部是原生记录，匹配走 agentFrameworkOf 谓词族，
// 禁止对 framework 裸等值。

import type { PrismaClient } from '@prisma/client';
import type { RunIndex } from './reader';
import type { SessionRef } from './model';
import type { RunViewModel, SessionMemberRef } from './view-model';
import { agentFrameworkOf } from '@/lib/shared/session-format';
import { listRuns, readRun } from './run-store';

/** 反向归属条目（session 详情页徽标数据源）。 */
export interface RunMembership {
  runId: string;
  runName: string | null;
  nodeId: string;
  generation: number;
  attempt: number;
  role: 'execute' | 'verify';
  memberName: string | null;
  kind: 'process' | 'session' | 'workflow';
}

/** 成员 sid → 落库行的批量 join。每 sid 最多返回一条（消歧规则见内注释）。 */
export async function joinSessionRefs(
  index: RunIndex,
  prisma: PrismaClient,
): Promise<Map<string, SessionRef>> {
  const sids = [
    ...new Set(
      index.graphMembers
        .map(m => m.member.sessionId)
        .filter((sid): sid is string => typeof sid === 'string' && sid.length > 0),
    ),
  ];
  const result = new Map<string, SessionRef>();
  if (sids.length === 0) return result;

  const rows = await prisma.session.findMany({
    where: { taskId: { in: sids } },
    select: {
      id: true, taskId: true, framework: true, label: true,
      startTime: true, endTime: true, totalTokens: true, totalLatencyMs: true,
    },
  });

  // turns 计数：Turn 外键是 Session.id（cuid），按 rowId 一次 groupBy
  const turnsByRow = new Map<string, number>();
  if (rows.length > 0) {
    const turnGroups = await prisma.turn.groupBy({
      by: ['sessionId'],
      where: { sessionId: { in: rows.map(r => r.id) } },
      _count: { _all: true },
    });
    for (const g of turnGroups) turnsByRow.set(g.sessionId, g._count._all);
  }

  const byTaskId = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byTaskId.get(row.taskId) ?? [];
    list.push(row);
    byTaskId.set(row.taskId, list);
  }

  for (const sid of sids) {
    const candidates = byTaskId.get(sid);
    if (!candidates || candidates.length === 0) continue;
    // 消歧（谓词族，禁裸等值）：①优先原生行（agentFrameworkOf 剥 -proxy 后缀
    // 等于 framework 原值 = 非 proxy 记录）；②同 sid 多原生行（罕见双框架导出）
    // 优先有 turn 的行；③仍并列取首行（稳定序：DB 返回序）
    const native = candidates.filter(r => agentFrameworkOf(r.framework) === r.framework);
    const pool = native.length > 0 ? native : candidates;
    const withTurns = pool.filter(r => (turnsByRow.get(r.id) ?? 0) > 0);
    const chosen = (withTurns.length > 0 ? withTurns : pool)[0];
    result.set(sid, {
      taskId: sid,
      framework: chosen.framework,
      rowId: chosen.id,
      turns: turnsByRow.get(chosen.id) ?? 0,
      totalTokens: chosen.totalTokens,
      durationMs: chosen.endTime
        ? chosen.endTime.getTime() - chosen.startTime.getTime()
        : null,
      label: chosen.label,
      startTime: chosen.startTime ? chosen.startTime.toISOString() : null,
      endTime: chosen.endTime ? chosen.endTime.toISOString() : null,
    });
  }
  return result;
}

/** 把 join 结果注入 view-model 的成员引用（API 层组装，view-model 保持纯函数）。 */
export function attachSessionRefs(
  vm: RunViewModel,
  lookup: Map<string, SessionRef>,
): void {
  const attach = (ref: SessionMemberRef): void => {
    ref.session = ref.sessionId ? lookup.get(ref.sessionId) ?? null : null;
  };
  for (const node of vm.nodes) {
    for (const attempt of node.attempts) {
      attach(attempt.executeMember);
      if (attempt.verifyMember) attach(attempt.verifyMember);
    }
    for (const pending of node.pendingMembers) attach(pending);
  }
}

/** 反向归属：扫描 runs/ 全部 manifest，找出引用该 sid 的成员（五键还原）。
 * 只读 manifest 不触 DB；run 量级小，扫描代价可忽略。 */
export function findRunMemberships(
  taskId: string,
  opts?: { root?: string },
): RunMembership[] {
  const memberships: RunMembership[] = [];
  const { runs } = listRuns(opts?.root);
  for (const item of runs) {
    const stored = readRun(item.runId, opts?.root);
    if (!stored) continue;
    for (const m of stored.index.members) {
      if (m.member.sessionId !== taskId) continue;
      memberships.push({
        runId: item.runId,
        runName: stored.manifest.name ?? null,
        nodeId: m.graph?.nodeId ?? m.member.id,
        generation: m.graph?.generation ?? 0,
        attempt: m.graph?.attempt ?? 0,
        role: m.graph?.role ?? 'execute',
        memberName: m.member.name ?? null,
        kind: m.member.kind,
      });
    }
  }
  return memberships;
}
