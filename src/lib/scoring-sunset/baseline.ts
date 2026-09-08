// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 基线对比（P3 第一步）：评分卡 vs 基线文件的逐指标四态判定。
// 基线文件 schema = workflow-scorecard-baseline v1（default-baseline.json 为
// 占位示例，可经页面「导入基线」替换为真实语料分布）。

import defaultBaselineJson from './default-baseline.json';
import { LOOP_BAND_SCORE } from './aggregate';
import type { WorkflowScorecard, MetricResult } from './types';

export interface BaselineMetric {
  unit?: string;
  direction: 'lower-better' | 'higher-better';
  n?: number;
  p25: number;
  p50: number;
  p75: number;
}

export interface BaselineFile {
  schema: 'workflow-scorecard-baseline';
  version: 1;
  name: string;
  source?: { cohort?: string; sessions?: number; computedAt?: string; provenance?: string };
  metrics: Record<string, BaselineMetric>;
}

export type BaselineGrade = 'BETTER' | 'COMPARABLE' | 'WORSE' | 'NO_BASELINE';

export interface BaselineRow {
  id: string;
  label: string;
  grade: BaselineGrade;
  sessionValue: number | null;
  sessionDisplay: string | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  unit: string | null;
}

const DIRECTIONS = ['lower-better', 'higher-better'] as const;

export function isValidBaseline(v: unknown): v is BaselineFile {
  if (!v || typeof v !== 'object') return false;
  const b = v as Record<string, unknown>;
  if (b['schema'] !== 'workflow-scorecard-baseline' || b['version'] !== 1) return false;
  if (typeof b['name'] !== 'string' || !b['metrics'] || typeof b['metrics'] !== 'object') return false;
  for (const m of Object.values(b['metrics'] as Record<string, unknown>)) {
    if (!m || typeof m !== 'object') return false;
    const mm = m as Record<string, unknown>;
    if (!DIRECTIONS.includes(mm['direction'] as never)) return false;
    for (const k of ['p25', 'p50', 'p75']) {
      if (typeof mm[k] !== 'number' || !Number.isFinite(mm[k] as number)) return false;
    }
  }
  return true;
}

export const DEFAULT_BASELINE: BaselineFile | null = isValidBaseline(defaultBaselineJson)
  ? (defaultBaselineJson as BaselineFile)
  : null;

// 评分卡 → 参与对比的指标值（D5 用档位分值参与，与聚合口径一致）
function cardMetricValues(card: WorkflowScorecard): Array<{ id: string; label: string; m: MetricResult | null; bandScore?: number }> {
  const d = card.deterministic;
  const e = card.efficiency;
  return [
    { id: 'D1', label: '重复读', m: d.repeatedRead },
    { id: 'D2a', label: '轮内重复副本', m: d.dupInjectionCopies },
    { id: 'D2b', label: '缓存未覆盖', m: d.cacheMissPrefixCost },
    { id: 'D2c', label: '陈旧结果', m: d.staleToolResults },
    { id: 'D3', label: '返工环', m: d.revertCycles },
    { id: 'D3b', label: 'churn 文件', m: d.churnFiles },
    { id: 'D4', label: '裸写率', m: d.nakedWrite },
    { id: 'D5', label: '循环档位', m: d.loop, bandScore: LOOP_BAND_SCORE[d.loop.band as keyof typeof LOOP_BAND_SCORE] ?? 1 },
    { id: 'D6', label: '计划对账', m: d.planDeviation },
    { id: 'E1', label: '单位成果成本', m: e.costPerOutcome },
    { id: 'E1b', label: '单任务 token', m: e.tokenPerTask },
    { id: 'E1c', label: '时间成本', m: e.timeCost },
    { id: 'E3a', label: '输入冗余', m: e.inputRedundancy },
    {
      id: 'healthScore',
      label: '健康分',
      m: card.aggregate.healthScore == null
        ? null
        : { id: 'healthScore', label: '健康分', status: 'ok', value: card.aggregate.healthScore, formula: '', inputs: [], evidence: [] },
    },
  ];
}

function gradeOf(value: number, base: BaselineMetric): BaselineGrade {
  if (base.direction === 'lower-better') {
    if (value <= base.p25) return 'BETTER';
    if (value <= base.p75) return 'COMPARABLE';
    return 'WORSE';
  }
  if (value >= base.p75) return 'BETTER';
  if (value >= base.p25) return 'COMPARABLE';
  return 'WORSE';
}

export function displayBaselineValue(v: number | null, unit: string | null): string | null {
  if (v == null) return null;
  if (unit === 'ratio' || unit === 'band-score') return `${Math.round(v * 100)}%`;
  if (unit === 'USD') return `$${v}`;
  if (unit === 'seconds') return v >= 3600 ? `${(v / 3600).toFixed(1)}h` : `${Math.round(v / 60)}min`;
  if (unit === 'tokens') return `${(v / 1_000_000).toFixed(1)}M`;
  return String(v);
}

export function compareWithBaseline(card: WorkflowScorecard, baseline: BaselineFile): BaselineRow[] {
  return cardMetricValues(card).map(({ id, label, m, bandScore }) => {
    const base = baseline.metrics[id];
    const value = id === 'D5' ? (bandScore ?? null) : m?.status === 'ok' && typeof m.value === 'number' ? m.value : null;
    if (!base || value == null) {
      return { id, label, grade: 'NO_BASELINE' as BaselineGrade, sessionValue: value, sessionDisplay: displayBaselineValue(value, base?.unit ?? null), p25: base?.p25 ?? null, p50: base?.p50 ?? null, p75: base?.p75 ?? null, unit: base?.unit ?? null };
    }
    return {
      id,
      label,
      grade: gradeOf(value, base),
      sessionValue: value,
      sessionDisplay: displayBaselineValue(value, base.unit ?? null),
      p25: base.p25,
      p50: base.p50,
      p75: base.p75,
      unit: base.unit ?? null,
    };
  });
}

// ── 基线相对分：指标在基线分布中的位置 → 0-1 分 ────────────
// ≤P25 记 1.0，P25~P75 线性递减，≥P75 记 0（越高越好反向）；
// 基线文件只携带三分位数，区间外不再外推（截断）。可比指标取均值。

export interface BaselineRelativeResult {
  /** 逐指标位置分（key = 指标 id；null = 不可比）；healthScore 仅对照不进相对分（避免合成指标双重计入） */
  scores: Record<string, number | null>;
  relativeScore: number | null;
  comparable: number;
  total: number;
}

function positionScore(value: number, base: BaselineMetric): number {
  const span = base.p75 - base.p25;
  if (base.direction === 'lower-better') {
    if (value <= base.p25) return 1;
    if (value >= base.p75) return 0;
    return span <= 0 ? 1 : 1 - (value - base.p25) / span;
  }
  if (value >= base.p75) return 1;
  if (value <= base.p25) return 0;
  return span <= 0 ? 0 : (value - base.p25) / span;
}

export function baselineRelativeScores(card: WorkflowScorecard, baseline: BaselineFile): BaselineRelativeResult {
  const scores: Record<string, number | null> = {};
  const scored: number[] = [];
  let total = 0;
  for (const row of cardMetricValues(card)) {
    if (row.id === 'healthScore') continue;
    total++;
    const base = baseline.metrics[row.id];
    const value = row.id === 'D5' ? (row.bandScore ?? null) : row.m?.status === 'ok' && typeof row.m.value === 'number' ? row.m.value : null;
    if (!base || value == null) {
      scores[row.id] = null;
      continue;
    }
    const s = Math.round(positionScore(value, base) * 100) / 100;
    scores[row.id] = s;
    scored.push(s);
  }
  return {
    scores,
    relativeScore: scored.length === 0 ? null : Math.round((scored.reduce((a, b) => a + b, 0) / scored.length) * 100) / 100,
    comparable: scored.length,
    total,
  };
}
