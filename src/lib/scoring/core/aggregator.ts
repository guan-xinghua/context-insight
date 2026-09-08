// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 聚合引擎（角色③）：只认角色和通用规则，不认识具体维度——
// 策略是数据（ScoreItemSchema/DimensionDefinition 里声明），新增维度零改引擎。

import type { AggregationPolicy, DimensionDefinition } from './schema';
import type { DimensionResult, SubItemResult } from './types';

export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** 否决判定值：触发即总分出局（带原因标注，不进基线语料） */
export const VETO_VERDICTS = ['未完成', 'violation'];

// ── 维度聚合：按该维声明的策略解释执行 ─────────────────────

export function aggregateDimension(
  def: DimensionDefinition,
  items: SubItemResult[],
): { status: DimensionResult['status']; score?: number | null; verdict?: string; disclose?: string } {
  const policy = def.aggregation;
  const diagnosticIds = new Set(def.items.filter(i => i.diagnostic).map(i => i.id));
  const okItems = items.filter(i => !diagnosticIds.has(i.itemId) && i.status === 'ok');
  const sc = okItems.filter(i => typeof i.score === 'number');
  const allNa = items.every(i => i.status === 'not-applicable');
  const noData = allNa ? 'not-applicable' : 'error';

  if (policy.kind === 'three-state') {
    const verdictOf = (id: string) => items.find(i => i.itemId === id)?.verdict;
    // 完成度分（可选）：指定子项的数值分取均值——D1 自身的维度分（雷达/明细用）
    const completionScore = () => {
      const of = policy.completionScoreOf;
      if (!of) return undefined;
      const vals = of
        .map(id => items.find(i => i.itemId === id))
        .filter((i): i is SubItemResult => i != null && i.status === 'ok' && typeof i.score === 'number')
        .map(i => i.score as number);
      return vals.length > 0 ? round2(vals.reduce((a, b) => a + b, 0) / vals.length) : undefined;
    };
    // 判定转分（可选）：分数跟着**组合规则的结论**走——规则判 violation 才归 0
    //（授权豁免等降级规则排在通配之前，降级后按疑似口径轻扣：被降级的违规也
    //计入疑似次数）；无 verdictScore 的维度（D1）仍走完成度分
    const verdictScoreOf = (combined: string) => {
      const vs = policy.verdictScore;
      if (!vs) return completionScore();
      if (combined === 'violation') return vs.violation;
      const n = items.filter(i => i.verdict === 'suspected' || i.verdict === 'violation').length;
      return round2(Math.max(0, 1 - vs.suspectedPenalty * n));
    };
    for (const rule of policy.rules) {
      const hit = Object.entries(rule.when).every(([key, want]) =>
        key === '*'
          ? items.some(i => i.verdict === want)
          : verdictOf(key) === want,
      );
      if (hit) return { status: 'scored', verdict: rule.then, disclose: rule.disclose, score: verdictScoreOf(rule.then) };
    }
    return { status: allNa ? 'not-applicable' : 'scored', verdict: policy.fallback, score: verdictScoreOf(policy.fallback) };
  }

  if (okItems.length === 0) return { status: noData };

  if (policy.kind === 'weighted-average') {
    if (sc.length === 0) return { status: noData };
    const weightOf = new Map(def.items.map(i => [i.id, i.weight ?? 1]));
    const wSum = sc.reduce((s, i) => s + (weightOf.get(i.itemId) ?? 1), 0);
    const value = sc.reduce((s, i) => s + (i.score as number) * (weightOf.get(i.itemId) ?? 1), 0) / wSum;
    return { status: 'scored', score: round2(value) };
  }

  if (policy.kind === 'average-with-floor') {
    if (sc.length === 0) return { status: noData };
    const weightOf = new Map(def.items.map(i => [i.id, i.weight ?? 1]));
    const wSum = sc.reduce((s, i) => s + (weightOf.get(i.itemId) ?? 1), 0);
    const mean = sc.reduce((s, i) => s + (i.score as number) * (weightOf.get(i.itemId) ?? 1), 0) / wSum;
    const floorItem = items.find(i => i.itemId === policy.floorItemId);
    const floored = floorItem?.status === 'ok'
      && typeof floorItem.score === 'number'
      && floorItem.score <= policy.floorThreshold;
    return { status: 'scored', score: round2(floored ? Math.min(mean, policy.floorMaxScore) : mean) };
  }

  // 扣分制：子项产出次数（value），不要求 score
  if (policy.kind === 'count-deduction') {
    const deduction = okItems.reduce((s, i) => {
      const per = policy.perEvent[i.itemId];
      if (!per) return s;
      const count = typeof i.value === 'number' ? i.value : 0;
      return s + per * count;
    }, 0);
    return { status: 'scored', score: round2(Math.max(0, 1 - deduction)) };
  }

  // direct：单子项分数即维度分
  if (sc.length === 0) return { status: noData };
  return { status: 'scored', score: round2(sc[0]?.score as number) };
}

// ── 整卡聚合：否决检查 → 加权 → 覆盖度折扣 ─────────────────

export interface FrameworkAggregates {
  totalScore: number | null;
  veto: { triggered: boolean; reasons: string[] } | null;
  coverage: number;
  weightsUsed: Record<string, number>;
}

export function aggregateCard(dimResults: DimensionResult[], defs: DimensionDefinition[]): FrameworkAggregates {
  const defOf = new Map(defs.map(d => [d.id, d]));

  // 1. 否决检查（只认角色和判定，不认维度）：violation / 未完成 一律硬否决，
  //    总分归 0——没交付或行为出格，总分是处分不是测量；维度分照常出，供诊断
  const vetoReasons: string[] = [];
  for (const dim of dimResults) {
    const def = defOf.get(dim.dimensionId);
    if (def?.role !== 'veto' || !dim.verdict) continue;
    if (dim.verdict === 'violation') {
      vetoReasons.push(`${dim.name}（行为违规）${dim.disclose ? ' · ' + dim.disclose : ''}`);
    } else if (dim.verdict === '未完成') {
      vetoReasons.push(`${dim.name}（未完成）${dim.disclose ? ' · ' + dim.disclose : ''}`);
    }
  }
  const veto = vetoReasons.length > 0 ? { triggered: true, reasons: vetoReasons } : null;

  // 2. 覆盖度：应评项 = 进总分的全部非诊断子项；已评项 = 其中 status ok 的
  let covered = 0;
  let applicable = 0;
  for (const def of defs) {
    if (def.role === 'optional' && !def.includeInTotal) continue;
    const diagnosticIds = new Set(def.items.filter(i => i.diagnostic).map(i => i.id));
    const result = dimResults.find(d => d.dimensionId === def.id);
    for (const item of def.items) {
      if (diagnosticIds.has(item.id)) continue;
      applicable++;
      if (result?.items.find(i => i.itemId === item.id)?.status === 'ok') covered++;
    }
  }
  const coverage = applicable === 0 ? 1 : round2(covered / applicable);

  // 3. 总分：veto → 0（否决是 0 分，不是没分）；否则加权维（有分的）按参与权重归一 × 覆盖度
  const weightsUsed: Record<string, number> = {};
  const participants: Array<{ id: string; score: number; weight: number }> = [];
  for (const dim of dimResults) {
    const def = defOf.get(dim.dimensionId);
    if (!def || (def.role !== 'weighted' && !(def.role === 'optional' && def.includeInTotal))) continue;
    if (dim.status !== 'scored' || typeof dim.score !== 'number') continue;
    participants.push({ id: dim.dimensionId, score: dim.score, weight: def.weightInTotal ?? 0 });
  }
  let totalScore: number | null = null;
  if (veto != null) {
    totalScore = 0;
  } else if (participants.length > 0) {
    const wSum = participants.reduce((s, p) => s + p.weight, 0);
    for (const p of participants) weightsUsed[p.id] = round2(p.weight / wSum);
    totalScore = round2((participants.reduce((s, p) => s + p.score * p.weight, 0) / wSum) * coverage);
  }

  return { totalScore, veto, coverage, weightsUsed };
}

export function policyLabel(p: AggregationPolicy): string {
  switch (p.kind) {
    case 'three-state': return '三态组合';
    case 'average-with-floor': return '平均+封顶';
    case 'weighted-average': return '加权平均';
    case 'count-deduction': return '按次扣分';
    case 'direct': return '直接分';
  }
}
