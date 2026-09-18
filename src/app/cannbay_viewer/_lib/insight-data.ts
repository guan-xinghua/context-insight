// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// viewer 进程内取数层：并入 insight 后不再 HTTP 自调用——会话指标直查 prisma、
// 评分卡直用 scoring store/runner、导入直调 cannbay2 编排。对外保持旧 HTTP 层
// 的形状（Map<taskId> 键 + 失败 null 降级），runs.ts 聚合逻辑零改动。
import { prisma } from '@/lib/db';
import { runScorecard, scorecardStore, type Scorecard } from '@/lib/scoring';
import { importCannbay2Session } from '@/lib/cannbay2';

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

// 全量会话 map（taskId 即数据仓 sid）。DB 故障返回 null——runs 层按「库不可读」
// 降级（指标列空、行标未导入），不拖垮数据湖侧列表；null 不落缓存，下次即重试。
export async function listInsightSessions(): Promise<Map<string, InsightSession> | null> {
  try {
    const sessions = await prisma.session.findMany({
      select: { taskId: true, startTime: true, endTime: true, totalTokens: true, framework: true, version: true, model: true },
    });
    const out = new Map<string, InsightSession>();
    for (const s of sessions) {
      if (!s.taskId) continue;
      out.set(s.taskId, {
        taskId: s.taskId,
        startTime: s.startTime ? s.startTime.toISOString() : null,
        endTime: s.endTime ? s.endTime.toISOString() : null,
        totalTokens: s.totalTokens,
        framework: s.framework,
        version: s.version,
        model: s.model,
      });
    }
    return out;
  } catch {
    return null;
  }
}

// 单会话评分卡：缓存命中零等待；首次现算确定性层（零 LLM），与 observe/session/
// scorecard 路由同口径。aborted（截断）卡与未找到一律 null；查询失败上抛
// （区别于「确定无卡」）——调用方降级但不缓存，避免瞬态 DB 故障被 TTL 放大
// 成「未评分」（与 listInsightSessions 的失败不缓存策略对齐）。
export async function getScorecard(taskId: string): Promise<InsightScorecard | null> {
  const session = await prisma.session.findFirst({ where: { taskId }, select: { id: true } });
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

// 一键导入：cannbay2 导入编排（物化 + 写库 + x_cannbay 补列），大会话可达数分钟
export async function importSession(sid: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await importCannbay2Session(sid, prisma);
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
