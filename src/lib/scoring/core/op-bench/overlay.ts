// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// CANN-Bench 填报的读时覆盖：填报是确定性输入，保存后不需要整卡重算（重算会把
// LLM/Mate 评审卡覆盖成确定性层）——读卡时重折算 D3.cannBench 一项并重聚合该维
// 与总分即可，其他子项与评审盖章原样保留。与人工复核覆盖层（applyAdjudications）
// 同一套读时机制。

import { profileMatches, aggregateCard, aggregateDimension } from '../aggregator';
import type { DimensionDefinition } from '../schema';
import type { Scorecard } from '../types';
import { benchToScore10, loadSessionOpBench } from './session-op-bench';
import { round2 } from '../scorer';

export async function applyOpBench(
  card: Scorecard,
  defs: DimensionDefinition[],
  liveProfile?: { id: string; name: string } | null,
): Promise<Scorecard> {
  const def = defs.find(d => d.id === 'D3');
  const dim = card.dimensions.find(d => d.dimensionId === 'D3');
  if (!def || !dim) return card;
  const itemId = def.items.find(i => i.scorerKind === 'user-input')?.id;
  if (!itemId) return card;

  const bench = await loadSessionOpBench(card.sessionId);
  // 与 OpBenchScorer 同口径（子项构造单一来源在 scorer；此处是它的读时孪生）
  const item = card.taskType !== 'operator'
    ? { itemId, label: 'CANN-Bench 评分', status: 'not-applicable' as const, evidence: [], note: '非算子类任务，无法评判' }
    : bench
      ? {
        itemId, label: 'CANN-Bench 评分', status: 'ok' as const, evidence: [],
        value: benchToScore10(bench.score), unit: 'score/10',
        score: round2(benchToScore10(bench.score) / 10),
        formula: `CANN-Bench 总分 ${bench.score}/100 → ${benchToScore10(bench.score)}/10`,
        note: bench.note?.trim() || `填报于 ${bench.filledAt.slice(0, 10)}`,
      }
      : {
        itemId, label: 'CANN-Bench 评分', status: 'ok' as const, evidence: [],
        value: 8, unit: 'score/10', score: 0.8,
        formula: '未填报 CANN-Bench 结果，按默认 80 计（与基线相当档）',
        note: '默认分（未填报）：在 Score 页「CANN-Bench 填报」填入 cannbench.com 总分，保存即生效',
      };
  const idx = dim.items.findIndex(i => i.itemId === itemId);
  if (idx < 0) return card;
  const items = [...dim.items];
  items[idx] = item as typeof dim.items[number];
  const reaggregate = profileMatches(card, liveProfile);
  const dimensions = card.dimensions.map(d => d === dim
    ? (reaggregate ? { ...d, items, ...aggregateDimension(def, items) } : { ...d, items })
    : d);
  return reaggregate
    ? { ...card, dimensions, framework: { ...card.framework, ...aggregateCard(dimensions, defs) } }
    : { ...card, dimensions };
}
