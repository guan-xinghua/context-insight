// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 聚合模型：综合健康分 = 加权(确定性 40% · 语义 40% · 效率 20%) × 覆盖度折扣。
// P1：语义层未接入（P2），结构性缺失不计入权重与覆盖度——否则所有会话恒被压到
// 0.6 上限，携带零信息；覆盖度在确定性/效率两维的指标槽位上计算（缺数据不进
// 分母）。hard gate 阈值见 HARD_GATE。

import type { MetricResult, LoopBand } from './types';

export const WEIGHTS = { deterministic: 0.4, semantic: 0.4, efficiency: 0.2 } as const;

export const LOOP_BAND_SCORE: Record<LoopBand, number> = { none: 1, minor: 0.8, moderate: 0.5, severe: 0.2 };

export const HARD_GATE = {
  loopBandSevere: 'severe',
  nakedWriteRatio: 0.8,
  /** D2 口径修订后的闸门：轮内重复注入副本 > 0.5（roadmap #7 无缓存短会话实测 0.54 一档） */
  dupInjectionCopiesRatio: 0.5,
} as const;

export const REWORK_CYCLE_CAP = 5;

export interface AggregateResult {
  healthScore: number | null;
  coverage: number;
  dimensions: { deterministic: number | null; semantic: number | null; efficiency: number | null };
  shortBoard: string | null;
  hardGateTriggered: boolean;
  hardGateReasons: string[];
  deterministicComponents: Array<{ id: string; label: string; score: number; formula: string }>;
  efficiencyComponents: Array<{ id: string; label: string; score: number; formula: string }>;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

export function aggregateScore(input: {
  d1: MetricResult;
  d2a: MetricResult;
  d2b: MetricResult;
  d2c: MetricResult;
  revertCycles: MetricResult;
  nakedWrite: MetricResult;
  loopBand: LoopBand;
  loopMetric: MetricResult;
  planDeviation: MetricResult;
  inputRedundancy: MetricResult;
  compactLoss: MetricResult;
  sessionTotalTokens: number;
  /** P2 语义分（0-1，mean(非弃权维)/10）；null/缺省 = 未评审不进分母 */
  semanticScore?: number | null;
}): AggregateResult {
  const det: AggregateResult['deterministicComponents'] = [];
  if (input.d1.status === 'ok' && input.d1.value != null) {
    det.push({ id: 'D1', label: '重复读', score: 1 - input.d1.value, formula: `1 − ${input.d1.value}` });
  }
  if (input.d2a.status === 'ok' && input.d2a.value != null) {
    det.push({ id: 'D2a', label: '轮内重复副本', score: 1 - input.d2a.value, formula: `1 − ${input.d2a.value}` });
  }
  if (input.d2b.status === 'ok' && input.d2b.value != null) {
    det.push({ id: 'D2b', label: '缓存未覆盖', score: 1 - input.d2b.value, formula: `1 − ${input.d2b.value}` });
  }
  if (input.d2c.status === 'ok' && input.d2c.value != null) {
    det.push({ id: 'D2c', label: '陈旧结果', score: 1 - input.d2c.value, formula: `1 − ${input.d2c.value}` });
  }
  if (input.revertCycles.status === 'ok' && input.revertCycles.value != null) {
    const s = 1 - Math.min(1, input.revertCycles.value / REWORK_CYCLE_CAP);
    det.push({ id: 'D3', label: '返工环', score: s, formula: `1 − min(1, ${input.revertCycles.value}/${REWORK_CYCLE_CAP})` });
  }
  if (input.nakedWrite.status === 'ok' && input.nakedWrite.value != null) {
    det.push({ id: 'D4', label: '裸写', score: 1 - input.nakedWrite.value, formula: `1 − ${input.nakedWrite.value}` });
  }
  det.push({ id: 'D5', label: '循环', score: LOOP_BAND_SCORE[input.loopBand], formula: `档位 ${input.loopBand} → ${LOOP_BAND_SCORE[input.loopBand]}` });
  if (input.planDeviation.status === 'ok' && input.planDeviation.value != null) {
    det.push({ id: 'D6', label: '计划对账', score: input.planDeviation.value, formula: `${input.planDeviation.value}` });
  }

  const eff: AggregateResult['efficiencyComponents'] = [];
  if (input.inputRedundancy.status === 'ok' && input.inputRedundancy.value != null) {
    eff.push({ id: 'E3a', label: '输入冗余', score: 1 - input.inputRedundancy.value, formula: `1 − ${input.inputRedundancy.value}` });
  }
  if (input.compactLoss.status === 'ok' && input.compactLoss.value != null) {
    const denom = Math.max(1, input.sessionTotalTokens);
    eff.push({ id: 'E3c', label: '压缩损失', score: 1 - Math.min(1, input.compactLoss.value / denom), formula: `1 − min(1, ${input.compactLoss.value}/${denom})` });
  }

  const detScoreRaw = mean(det.map(c => c.score));
  const effScoreRaw = mean(eff.map(c => c.score));
  // 账本原则：维分先取整到展示精度（两位），健康分用取整后的值计算——
  // 展示的维分 + 公式可精确复算健康分
  const detScore = detScoreRaw == null ? null : Math.round(detScoreRaw * 100) / 100;
  const effScore = effScoreRaw == null ? null : Math.round(effScoreRaw * 100) / 100;
  const semanticScoreRounded = input.semanticScore == null ? null : Math.round(input.semanticScore * 100) / 100;

  // 覆盖度：P1 可计槽位 = 确定性 8 槽（D2 拆 a/b/c 后）+ 效率 2 槽；P2 语义评审存在时加语义 1 槽
  const detSlots = ['D1', 'D2a', 'D2b', 'D2c', 'D3', 'D4', 'D5', 'D6'];
  const effSlots = ['E3a', 'E3c'];
  const hasSemantic = input.semanticScore != null;
  const covered = det.length + eff.length + (hasSemantic ? 1 : 0);
  const applicable = detSlots.length + effSlots.length + (hasSemantic ? 1 : 0);
  // 覆盖度同样取整到展示精度，健康分用取整值——公示的覆盖率可精确复算
  const coverage = Math.round((covered / applicable) * 100) / 100;

  let healthScore: number | null = null;
  const dims: Array<{ name: string; score: number; weight: number }> = [];
  if (detScore != null) dims.push({ name: 'deterministic', score: detScore, weight: WEIGHTS.deterministic });
  if (semanticScoreRounded != null) dims.push({ name: 'semantic', score: semanticScoreRounded, weight: WEIGHTS.semantic });
  if (effScore != null) dims.push({ name: 'efficiency', score: effScore, weight: WEIGHTS.efficiency });
  if (dims.length > 0) {
    const wSum = dims.reduce((s, d) => s + d.weight, 0);
    const weighted = dims.reduce((s, d) => s + d.score * d.weight, 0) / wSum;
    healthScore = Math.round(weighted * coverage * 100) / 100;
  }

  const shortBoard = dims.length > 0
    ? dims.reduce((min, d) => (d.score < min.score ? d : min), dims[0]).name
    : null;

  const hardGateReasons: string[] = [];
  if (input.loopBand === HARD_GATE.loopBandSevere) hardGateReasons.push('循环档位 severe（交替/连发死循环）');
  if (input.nakedWrite.status === 'ok' && input.nakedWrite.value != null && input.nakedWrite.value > HARD_GATE.nakedWriteRatio) {
    hardGateReasons.push(`裸写率 ${input.nakedWrite.value} > ${HARD_GATE.nakedWriteRatio}`);
  }
  if (input.d2a.status === 'ok' && input.d2a.value != null && input.d2a.value > HARD_GATE.dupInjectionCopiesRatio) {
    hardGateReasons.push(`轮内重复注入副本 ${input.d2a.value} > ${HARD_GATE.dupInjectionCopiesRatio}`);
  }

  return {
    healthScore,
    coverage,
    dimensions: {
      deterministic: detScore,
      semantic: semanticScoreRounded,
      efficiency: effScore,
    },
    shortBoard,
    hardGateTriggered: hardGateReasons.length > 0,
    hardGateReasons,
    deterministicComponents: det,
    efficiencyComponents: eff,
  };
}
