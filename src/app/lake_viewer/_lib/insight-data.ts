// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// viewer 进程内取数层：并入 insight 后不再 HTTP 自调用——会话指标直查 prisma、
// 评分卡直用 scoring store/runner、导入直调 lake 编排。对外保持旧 HTTP 层
// 的形状（Map<taskId> 键 + 失败 null 降级），runs.ts 聚合逻辑零改动。
import { prisma } from '@/lib/db';
import { runScorecard, scorecardStore, type Scorecard } from '@/lib/scoring';
import { importLakeSession } from '@/lib/lake';
import { computeSessionActiveSplit } from '@/lib/active-time';
import { isProxyVersion } from '@/lib/shared/session-format';

export interface InsightSession {
  taskId: string;
  startTime: string | null;
  endTime: string | null;
  totalTokens: number | null;
  framework: string | null;
  version: string | null;
  model: string | null;
}

export interface InsightScorecard {
  totalScore: number | null;
  dimensions: Array<{ dimensionId: string; name: string; score: number | null }>;
  computedAt: string;
}

// 全量会话索引（taskId → 本地行集）：同 sid 双记录在 DB 是两行（capture/
// native framework 各异），单键 map 会互相覆盖。DB 故障返回 null——runs 层按
// 「库不可读」降级（指标列空、行标未导入），不拖垮数据湖侧列表；null 不落
// 缓存，下次即重试。
export async function listInsightSessions(): Promise<Map<string, InsightSession[]> | null> {
  try {
    const sessions = await prisma.session.findMany({
      select: { taskId: true, startTime: true, endTime: true, totalTokens: true, framework: true, version: true, model: true },
    });
    const out = new Map<string, InsightSession[]>();
    for (const s of sessions) {
      if (!s.taskId) continue;
      const rows = out.get(s.taskId) ?? [];
      rows.push({
        taskId: s.taskId,
        startTime: s.startTime ? s.startTime.toISOString() : null,
        endTime: s.endTime ? s.endTime.toISOString() : null,
        totalTokens: s.totalTokens,
        framework: s.framework,
        version: s.version,
        model: s.model,
      });
      out.set(s.taskId, rows);
    }
    return out;
  } catch {
    return null;
  }
}

// 单会话活跃时长（毫秒）：与会话详情页 Wall Clock 拆分同口径（事件聚类 +
// wire 调用区间展开）。无 turns / 会话未找到返回 null（调用方回落墙钟）；
// 查询失败上抛由调用方降级不缓存。
export async function getActiveDurationMs(taskId: string, framework?: string | null): Promise<number | null> {
  let session = framework
    ? await prisma.session.findFirst({ where: { taskId, framework }, select: { id: true, startTime: true, endTime: true, version: true } })
    : null;
  if (!session) session = await prisma.session.findFirst({ where: { taskId }, select: { id: true, startTime: true, endTime: true, version: true } });
  if (!session) return null;
  const split = await computeSessionActiveSplit(
    () => prisma.turn.findMany({
      where: { sessionId: session!.id },
      select: { createdAt_ts: true, createdAt: true, latencyMs: true, role: true },
    }),
    session.startTime.getTime(),
    session.endTime ? session.endTime.getTime() : null,
    isProxyVersion(session.version)
  );
  return split?.activeMs ?? null;
}

// 单会话评分卡：缓存命中零等待；首次现算确定性层（零 LLM），与 observe/session/
// scorecard 路由同口径。aborted（截断）卡与未找到一律 null；查询失败上抛
// （区别于「确定无卡」）——调用方降级但不缓存，避免瞬态 DB 故障被 TTL 放大
// 成「未评分」（与 listInsightSessions 的失败不缓存策略对齐）。
export async function getScorecard(taskId: string, framework?: string | null): Promise<InsightScorecard | null> {
  // 同 sid 双记录两行：优先按 framework 取本记录的行；未带 framework 或未命中
  // 回落裸 taskId（存量/单记录语义不变）
  let session = framework
    ? await prisma.session.findFirst({ where: { taskId, framework }, select: { id: true } })
    : null;
  if (!session) session = await prisma.session.findFirst({ where: { taskId }, select: { id: true } });
  if (!session) return null;
  let card: Scorecard | null = await scorecardStore().get(session.id);
  if (!card) card = await runScorecard(taskId, prisma);
  if (!card || card.status === 'aborted') return null;
  return {
    totalScore: card.framework.totalScore ?? null,
    dimensions: card.dimensions.map(d => ({
      dimensionId: d.dimensionId,
      name: d.name,
      score: d.score ?? null,
    })),
    computedAt: card.computedAt,
  };
}

// 一键导入：lake 导入编排（物化 + 写库 + x_cannbay 补列），大会话可达数分钟。
// recording 定位仓内记录位：native = <sid>.native/（原生会话），capture = 裸 <sid>/
export async function importSession(sid: string, recording: 'capture' | 'native' = 'capture'): Promise<{ ok: boolean; error?: string }> {
  try {
    await importLakeSession(sid, prisma, undefined, recording);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// 有界并发 map（评分卡逐会话现算，避免一次性打满事件循环）
export async function mapBounded<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) break;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}
