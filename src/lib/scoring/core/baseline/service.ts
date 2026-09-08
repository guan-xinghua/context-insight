// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 基线服务（角色⑤）·遗留工具：分位数位置分（v2 早期占位方案，现评分走
// session-baseline 的单会话比值）。positionScore/gradeOf/displayBaselineValue 仍被
// 引用（展示格式化 / 测试），分布基线留作语料攒多后的可选升级。

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
  version: 1 | 2;
  name: string;
  source?: { cohort?: string; sessions?: number; computedAt?: string; provenance?: string };
  /** v2：按任务类型分组的第二层（起步 flat，语料攒多后按组细分） */
  cohorts?: Record<string, { metrics: Record<string, BaselineMetric> }>;
  metrics: Record<string, BaselineMetric>;
}

export type BaselineGrade = 'BETTER' | 'COMPARABLE' | 'WORSE' | 'NO_BASELINE';

const DIRECTIONS = ['lower-better', 'higher-better'] as const;

export function isValidBaseline(v: unknown): v is BaselineFile {
  if (!v || typeof v !== 'object') return false;
  const b = v as Record<string, unknown>;
  if (b['schema'] !== 'workflow-scorecard-baseline' || (b['version'] !== 1 && b['version'] !== 2)) return false;
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

/** 位置分（方向感知）：lower-better 时越小越好 */
export function positionScore(value: number, base: BaselineMetric): number {
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

export function gradeOf(value: number, base: BaselineMetric): BaselineGrade {
  if (base.direction === 'lower-better') {
    if (value <= base.p25) return 'BETTER';
    if (value <= base.p75) return 'COMPARABLE';
    return 'WORSE';
  }
  if (value >= base.p75) return 'BETTER';
  if (value >= base.p25) return 'COMPARABLE';
  return 'WORSE';
}

/** 查指标基线：cohort 优先（operator/general），回落 flat metrics */
export function lookupMetric(
  baseline: BaselineFile | null,
  key: string,
  cohort?: 'operator' | 'general' | 'unknown',
): BaselineMetric | null {
  if (!baseline) return null;
  if (cohort && cohort !== 'unknown' && baseline.cohorts?.[cohort]?.metrics?.[key]) {
    return baseline.cohorts[cohort].metrics[key];
  }
  return baseline.metrics[key] ?? null;
}

export function displayBaselineValue(v: number | null, unit?: string | null): string | null {
  if (v == null) return null;
  if (unit === 'ratio' || unit === 'band-score') return `${Math.round(v * 100)}%`;
  if (unit === 'seconds') return v >= 3600 ? `${(v / 3600).toFixed(1)}h` : `${Math.round(v / 60)}min`;
  if (unit === 'tokens') return v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : `${Math.round(v / 1000)}k`;
  if (unit === 'ms') return v >= 60_000 ? `${(v / 60_000).toFixed(1)}min` : `${(v / 1000).toFixed(1)}s`;
  if (unit === '轮') return `${Math.round(v)} 轮`;
  return String(v);
}
