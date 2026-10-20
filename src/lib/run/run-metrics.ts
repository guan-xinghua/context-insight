// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Run 系统级观测的指标聚合（纯函数，展示层与服务端皆可用）：节点用量（指标
// 透镜着色）与 Run 级汇总（时间轴摘要栏）都从这里推导。时长口径统一为「尝试
// 有效跨度」——首次会话开始 → 末次会话结束（含执行→验收派发间隙），尝试卡片
// 徽标与节点透镜同源（attemptRangeOf/attemptSpanMs），部分之和恒等于整体；
// 「失败尝试」按 attempt.status === 'failed' 归集——重试开销（时间轴摘要）与
// 浪费账本共用该口径。

import type { AttemptRecord, NodeInstance } from "./view-model";
import type { SessionRef } from "./model";

/** ISO → 时间戳；null/非法返回 null（时间口径组件共用）。 */
export function validTs(iso: string | null): number | null {
  if (iso === null) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

export function sessionSpanMs(s: SessionRef): number | null {  const st = validTs(s.startTime);
  const en = validTs(s.endTime);
  if (st !== null && en !== null && en >= st) return en - st;
  return s.durationMs !== null && s.durationMs >= 0 ? s.durationMs : null;
}

/** 尝试有效起止：manifest 成员时间戳缺失（session 成员常见）时用成员会话行
 *  起止兜底——首个会话开始 → 最后一个会话结束（含执行→验收派发间隙）。
 *  尝试卡片徽标、节点透镜、时间轴摘要共用该口径。 */
export function attemptRangeOf(a: AttemptRecord): { start: string | null; end: string | null } {
  const starts: number[] = [];
  const ends: number[] = [];
  const push = (iso: string | null, list: number[]) => {
    const t = validTs(iso);
    if (t !== null) list.push(t);
  };
  push(a.startedAt, starts);
  push(a.finishedAt, ends);
  for (const m of [a.executeMember, a.verifyMember]) {
    if (!m?.session) continue;
    push(m.session.startTime, starts);
    push(m.session.endTime, ends);
  }
  return {
    start: starts.length > 0 ? new Date(Math.min(...starts)).toISOString() : null,
    end: ends.length > 0 ? new Date(Math.max(...ends)).toISOString() : null,
  };
}

/** 尝试时长：有效起止跨度；无起止时退化为 Σ 会话时长（durationMs 兜底）。 */
export function attemptSpanMs(a: AttemptRecord): number | null {
  const st = validTs(attemptRangeOf(a).start);
  const en = validTs(attemptRangeOf(a).end);
  if (st !== null && en !== null && en >= st) return en - st;
  let sum = 0;
  let any = false;
  for (const m of [a.executeMember, a.verifyMember]) {
    if (!m?.session) continue;
    const ms = sessionSpanMs(m.session);
    if (ms !== null) {
      sum += ms;
      any = true;
    }
  }
  return any ? sum : null;
}

export interface NodeUsage {
  sessions: number;
  totalTokens: number;
  totalMs: number;          // 节点时长 = Σ尝试跨度 + 尝试间等待（即节点墙钟）
  activeMs: number;         // Σ 尝试有效跨度（与尝试徽标同口径，含派发间隙）
  turns: number;
  cacheReadTokens: number;
  failedMs: number;         // 失败尝试的有效跨度（重试开销）
  failedTokens: number;     // 失败尝试的 token（重试浪费）
  execMs: number;           // Σ 执行会话时长
  verifyMs: number;         // Σ 验收会话时长
  gapMs: number;            // 派发间隙 = Σ跨度 − 执行 − 验收（下限 0，执行→验收）
  waitMs: number;           // 重试等待 = 节点墙钟 − Σ跨度（下限 0，上次尝试结束 → 重试派发）
  verifyTokens: number;
  contextPeakPct: number | null; // 成员会话的上下文峰值水位最大值（0-100，无数据 null）
  redundancyScore: number | null; // 成员会话的 D5 冗余规则分最小值（0-1，越低越糙；无评分 null）
}

/** 节点实例用量：聚合其全部尝试的成员会话（执行 + 验收）。无会话成员返回 null。 */
export function nodeUsageOf(node: NodeInstance): NodeUsage | null {
  const u: NodeUsage = {
    sessions: 0, totalTokens: 0, totalMs: 0, activeMs: 0, turns: 0,
    cacheReadTokens: 0, failedMs: 0, failedTokens: 0,
    execMs: 0, verifyMs: 0, gapMs: 0, waitMs: 0, verifyTokens: 0,
    contextPeakPct: null, redundancyScore: null,
  };
  let any = false;
  let wallStart: number | null = null;
  let wallEnd: number | null = null;
  for (const a of node.attempts) {
    const failed = a.status === "failed";
    const spanMs = attemptSpanMs(a);
    if (spanMs !== null) {
      u.activeMs += spanMs;
      if (failed) u.failedMs += spanMs;
    }
    for (const m of [a.executeMember, a.verifyMember]) {
      if (!m?.session) continue;
      const s = m.session;
      any = true;
      u.sessions += 1;
      u.totalTokens += s.totalTokens;
      u.turns += s.turns;
      u.cacheReadTokens += s.cacheReadTokens ?? 0;
      if (s.contextPeakPct != null) {
        u.contextPeakPct = u.contextPeakPct === null ? s.contextPeakPct : Math.max(u.contextPeakPct, s.contextPeakPct);
      }
      const ruleD5 = s.ruleScores?.d5 ?? null;
      if (ruleD5 !== null) {
        u.redundancyScore = u.redundancyScore === null ? ruleD5 : Math.min(u.redundancyScore, ruleD5);
      }
      if (failed) u.failedTokens += s.totalTokens;
      const ms = sessionSpanMs(s);
      if (m.role === "verify") {
        u.verifyTokens += s.totalTokens;
        if (ms !== null) u.verifyMs += ms;
      } else if (ms !== null) {
        u.execMs += ms;
      }
      const st = validTs(s.startTime);
      const en = validTs(s.endTime);
      if (st !== null) wallStart = wallStart === null ? st : Math.min(wallStart, st);
      if (en !== null) wallEnd = wallEnd === null ? en : Math.max(wallEnd, en);
    }
  }
  u.gapMs = Math.max(u.activeMs - u.execMs - u.verifyMs, 0);
  if (wallStart !== null && wallEnd !== null && wallEnd > wallStart) {
    u.waitMs = Math.max(wallEnd - wallStart - u.activeMs, 0);
  }
  u.totalMs = u.activeMs + u.waitMs;
  return any ? u : null;
}

export interface RunUsageSummary {
  wallMs: number | null;      // 最早会话开始 → 最晚会话结束
  busyMs: number;             // Σ 节点时长（含派发间隙与重试等待，与侧栏/透镜同口径）
  parallelism: number | null; // busyMs ÷ wallMs（平均并发数）
  retryShare: number | null;  // 失败尝试跨度 ÷ busyMs（不含其后的重试等待）
  execMs: number;             // Σ 执行会话时长（构成四元）
  verifyMs: number;           // Σ 验收会话时长
  gapMs: number;              // Σ 派发间隙（执行 → 验收）
  waitMs: number;             // Σ 重试等待（尝试之间）
  totalTokens: number;
  failedTokens: number;
  contextPeakPct: number | null; // 全部成员会话的上下文峰值水位最大值（0-100）
}

/** Run 级汇总（时间轴摘要栏）：时间口径跨全部会话（不限有时间条的成员）。 */
export function runUsageOf(nodes: NodeInstance[]): RunUsageSummary {
  const sum: RunUsageSummary = {
    wallMs: null, busyMs: 0, parallelism: null, retryShare: null,
    execMs: 0, verifyMs: 0, gapMs: 0, waitMs: 0,
    totalTokens: 0, failedTokens: 0, contextPeakPct: null,
  };
  let retryMs = 0;
  let minStart: number | null = null;
  let maxEnd: number | null = null;
  for (const node of nodes) {
    const u = nodeUsageOf(node);
    if (u === null) continue;
    sum.busyMs += u.totalMs;
    sum.totalTokens += u.totalTokens;
    sum.failedTokens += u.failedTokens;
    sum.execMs += u.execMs;
    sum.verifyMs += u.verifyMs;
    sum.gapMs += u.gapMs;
    sum.waitMs += u.waitMs;
    if (u.contextPeakPct !== null) {
      sum.contextPeakPct = sum.contextPeakPct === null ? u.contextPeakPct : Math.max(sum.contextPeakPct, u.contextPeakPct);
    }
    retryMs += u.failedMs;
    for (const a of node.attempts) {
      for (const m of [a.executeMember, a.verifyMember]) {
        if (!m?.session) continue;
        const st = validTs(m.session.startTime);
        const en = validTs(m.session.endTime);
        if (st !== null) minStart = minStart === null ? st : Math.min(minStart, st);
        if (en !== null) maxEnd = maxEnd === null ? en : Math.max(maxEnd, en);
      }
    }
  }
  if (minStart !== null && maxEnd !== null && maxEnd > minStart) {
    sum.wallMs = maxEnd - minStart;
    sum.parallelism = sum.busyMs / sum.wallMs;
  }
  if (sum.busyMs > 0) {
    sum.retryShare = retryMs / sum.busyMs;
  }
  return sum;
}

// ── 指标透镜 ────────────────────────────────────────────────

export type LensKey = "status" | "tokens" | "duration" | "turns" | "cache" | "context" | "redundancy";

export const LENS_META: Array<{ key: LensKey; label: string; legend: string }> = [
  { key: "status", label: "状态", legend: "节点状态" },
  { key: "tokens", label: "Token", legend: "Token 消耗" },
  { key: "duration", label: "时长", legend: "节点时长（含间隙与尝试间等待）" },
  { key: "turns", label: "轮次", legend: "轮次" },
  { key: "cache", label: "缓存", legend: "缓存命中占比" },
  { key: "context", label: "水位", legend: "上下文峰值水位（成员会话最大值）" },
  { key: "redundancy", label: "冗余", legend: "会话冗余程度：反复跑/子任务重派/失败白干越多分越低（1 = 干净）" },
];

/** 绝对阈值透镜（不按分位着色）：水位有天然健康区间——85% 逼限就是逼限，
 *  与「别人更差」无关。冗余分同理（评分卡同款阈值：≥0.8 良好 / ≥0.6 一般）。
 *  返回 null = 走分位边界。 */
export function lensFixedBoundaries(lens: LensKey): number[] | null {
  if (lens === "context") return [50, 80];
  if (lens === "redundancy") return [0.6, 0.8];
  return null;
}

export function lensValue(lens: LensKey, u: NodeUsage): number | null {
  switch (lens) {
    case "tokens": return u.totalTokens > 0 ? u.totalTokens : null;
    case "duration": return u.totalMs > 0 ? u.totalMs : null;
    case "turns": return u.turns > 0 ? u.turns : null;
    case "cache": return u.totalTokens > 0
      ? u.cacheReadTokens / u.totalTokens
      : null;
    case "context": return u.contextPeakPct !== null && u.contextPeakPct > 0 ? u.contextPeakPct : null;
    case "redundancy": return u.redundancyScore;
    default: return null;
  }
}

/** 分位边界（五分位去重）：透镜着色用排序分桶，对长尾（单节点吃掉大头）稳健。 */
export function lensBoundaries(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
  const out: number[] = [];
  for (const v of [at(0.2), at(0.4), at(0.6), at(0.8)]) {
    if (out.length === 0 || v > out[out.length - 1]) out.push(v);
  }
  return out;
}

/** 值 → 桶序（0..boundaries.length，越大越深）。 */
export function lensRank(boundaries: number[], v: number): number {
  let i = 0;
  while (i < boundaries.length && v > boundaries[i]) i += 1;
  return i;
}

// 会话用量缩写（右侧胶囊，完整数值经 title 悬浮可见）：1.2k / 653k / 1.2M
export function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) {
    // 999,500 ≤ n < 1,000,000 时 Math.round(n/1_000)=1000 会产出「1000k」，
    // 与 ≥1M 档的「1.0M」衔接不一致——四舍五入到 1000k 时回落 M 档
    const k = Math.round(n / 1_000);
    if (k >= 1000) return `${(n / 1_000_000).toFixed(1)}M`;
    return `${k}k`;
  }
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}min`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

export function lensValueText(lens: LensKey, u: NodeUsage): string {
  switch (lens) {
    case "tokens": return compactTokens(u.totalTokens);
    case "duration": return formatDurationMs(u.totalMs);
    case "turns": return `${u.turns} 轮`;
    case "cache": return `${Math.round((u.cacheReadTokens / Math.max(u.totalTokens, 1)) * 100)}%`;
    case "context": return u.contextPeakPct !== null ? `${Math.round(u.contextPeakPct)}%` : "";
    case "redundancy": return u.redundancyScore !== null ? u.redundancyScore.toFixed(2) : "";
    default: return "";
  }
}
