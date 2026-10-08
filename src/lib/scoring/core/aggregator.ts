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
import type { DimensionResult, Scorecard, SubItemResult } from './types';

export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** 否决判定值：触发即总分出局（带原因标注，不进基线语料） */
export const VETO_VERDICTS = ['未完成', 'violation'];

// na 归因：材料客观缺失（评过了，结论是不适用）不算覆盖度缺口——它是对会话的
// 判定，不是评审没干活；只有评审缺口（未开启 LLM 评审 / Mate 未给出子项）才拉低
// 覆盖度。显式 naKind 优先，存量卡按 note 文案归类（现场 §f5fe259d 的
// D3.testResults「缺少改代码后的测试运行」被覆盖度误折）
const NA_GAP_RE = /未开启 LLM 评审|Mate 评审未给出/;

export function isNaReviewGap(item: SubItemResult): boolean {
  if (item.status !== 'not-applicable') return false;
  if (item.naKind) return item.naKind === 'gap';
  return NA_GAP_RE.test(item.note ?? '');
}

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
    // 判定转分（可选）：分数跟着**组合规则的结论**走——声明 violationPenalty 的维
    // 按次扣分（违规每次 −violationPenalty、疑似每次 −suspectedPenalty，扣到 0 为止，
    // 不整维归零）；未声明的维维持"violation → 定值"（豁免等降级规则命中的按疑似
    // 口径轻扣）；无 verdictScore 的维度（D1）仍走完成度分
    const verdictScoreOf = (combined: string) => {
      const vs = policy.verdictScore;
      if (!vs) return completionScore();
      if (combined === 'violation') {
        if (vs.violationPenalty == null) return vs.violation;
        const nV = items.filter(i => i.verdict === 'violation').length;
        const nS = items.filter(i => i.verdict === 'suspected').length;
        return round2(Math.max(0, 1 - vs.violationPenalty * nV - vs.suspectedPenalty * nS));
      }
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

  // 2. 覆盖度：应评项 = 进总分的全部非诊断子项（材料缺失的 na 弃权不算——那是
  // 评过的结论不是评审缺口）；已评项 = 其中 status ok 的
  let covered = 0;
  let applicable = 0;
  for (const def of defs) {
    if (def.role === 'optional' && !def.includeInTotal) continue;
    const diagnosticIds = new Set(def.items.filter(i => i.diagnostic).map(i => i.id));
    const result = dimResults.find(d => d.dimensionId === def.id);
    for (const item of def.items) {
      if (diagnosticIds.has(item.id)) continue;
      const res = result?.items.find(i => i.itemId === item.id);
      if (res?.status === 'not-applicable' && !isNaReviewGap(res)) continue;   // 材料缺失弃权：不进分母
      applicable++;
      if (res?.status === 'ok') covered++;
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

// ── 子项有效分（展示层「得分/满分」）：折算规则与聚合同口径 ─────────────
// 数值分优先；判定型子项按三态口径折算（无发现/达标 1、疑似 1−penalty、违规/未达标 0）；
// 扣分制子项按声明费率算 max(0, 1−费率×次数)。判不了（无法判定/诊断项/非 ok）→ null 不出分。

const VERDICT_ZERO = new Set(['violation', '未完成', 'fail', 'failed', 'unmet', 'missing', 'incomplete', 'unauthorized', 'error', 'low']);
const VERDICT_FULL = new Set(['clean', '完成', 'pass', 'passed', 'met', 'covered', 'completed', 'authorized', 'high']);

export function itemEffScoreOf(def: DimensionDefinition, item: SubItemResult): number | null {
  if (item.status !== 'ok') return null;
  if (typeof item.score === 'number') return item.score;
  const policy = def.aggregation;
  if (policy.kind === 'count-deduction') {
    const per = policy.perEvent[item.itemId];
    if (!per) return null;                          // 诊断项（不在费率表）不出分
    const count = typeof item.value === 'number' ? item.value : 0;
    return round2(Math.max(0, 1 - per * count));
  }
  if (!item.verdict) return null;
  if (VERDICT_ZERO.has(item.verdict)) {
    if (policy.kind === 'three-state' && policy.verdictScore) {
      const vs = policy.verdictScore;
      return vs.violationPenalty != null ? round2(1 - vs.violationPenalty) : vs.violation;
    }
    return 0;
  }
  if (item.verdict === 'suspected') {
    const penalty = policy.kind === 'three-state' ? (policy.verdictScore?.suspectedPenalty ?? 0.2) : 0.2;
    return round2(1 - penalty);
  }
  if (VERDICT_FULL.has(item.verdict)) return 1;
  if (item.verdict === 'partial') return 0.5;
  return null;                                      // 无法判定 / not-run / unidentifiable → 不出分
}

/** 覆盖层：给卡上每个子项盖 effScore（在 adjudications 之后应用——疑似确认态要反映到折算里） */
export function deriveItemScores(card: Scorecard, defs: DimensionDefinition[]): Scorecard {
  const defOf = new Map(defs.map(d => [d.id, d]));
  const dimensions = card.dimensions.map(dim => {
    const def = defOf.get(dim.dimensionId);
    if (!def) return dim;
    // 维内占比（展示用）：只标加权维的计分子项——按次扣分/三态组合维没有逐项权重
    const weightOf = def.aggregation.kind === 'weighted-average'
      ? new Map(def.items.filter(i => !i.diagnostic && i.weight != null).map(i => [i.id, i.weight as number]))
      : null;
    let changed = false;
    const items = dim.items.map(item => {
      const eff = itemEffScoreOf(def, item);
      const weight = weightOf?.get(item.itemId);
      const next = { ...item, effScore: eff };
      if (weight != null) next.weightInDim = weight;
      if ((item.effScore ?? null) === eff && item.weightInDim === next.weightInDim) return item;
      changed = true;
      return next;
    });
    return changed ? { ...dim, items } : dim;
  });
  // 未覆盖清单（与 aggregateCard 的覆盖度同口径：跳过不进总分的维与诊断项、
  // 材料缺失的 na 弃权）——「× 覆盖度 97% 是哪项没评到」一眼可查，不用翻维卡折叠行
  const coverageGap: string[] = [];
  for (const def of defs) {
    if (def.role === 'optional' && !def.includeInTotal) continue;
    const diagnosticIds = new Set(def.items.filter(i => i.diagnostic).map(i => i.id));
    const result = dimensions.find(d => d.dimensionId === def.id);
    for (const item of def.items) {
      if (diagnosticIds.has(item.id)) continue;
      const res = result?.items.find(i => i.itemId === item.id);
      if (res?.status === 'not-applicable' && !isNaReviewGap(res)) continue;   // 材料缺失弃权：不算未覆盖
      if (res?.status !== 'ok') coverageGap.push(`${item.id} ${item.name}`);
    }
  }
  return { ...card, dimensions, framework: { ...card.framework, coverageGap } };
}

/** 覆盖层 profile 匹配守卫（三处覆盖层共用一个口径）：liveProfile 未传（测试/内部
 *  调用）视为匹配；否则卡上口径快照须与现行 profile 同 id（null=默认对 null） */
export function profileMatches(card: Scorecard, liveProfile: { id: string; name: string } | null | undefined): boolean {
  return liveProfile === undefined
    || (card.framework.profile?.id ?? null) === (liveProfile?.id ?? null);
}

/** 读时重聚合：按 defs 重算各维度分与整卡框架（维度分/总分是 defs 的确定函数，
 *  语义与费率修正对存量卡立即生效）。只重算 defs 认识的维；异形卡护栏由调用方掌握 */
export function reaggregateWith(card: Scorecard, defs: DimensionDefinition[]): Scorecard {
  const defOf = new Map(defs.map(d => [d.id, d]));
  const dimensions = card.dimensions.map(dim => {
    const def = defOf.get(dim.dimensionId);
    return def ? { ...dim, ...aggregateDimension(def, dim.items) } : dim;
  });
  return { ...card, dimensions, framework: { ...card.framework, ...aggregateCard(dimensions, defs) } };
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
