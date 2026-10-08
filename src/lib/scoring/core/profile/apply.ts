// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// applyProfile：把 profile 覆盖到内置定义上（克隆后过滤/加权/注入自定义项）。
// 自定义项只出分不出判定：D2/D6 目标标 diagnostic（只展示不进维度分），
// D1 目标进完成度均值（completionScoreOf 追加，不碰三态规则），D3/D4/D5 进加权平均。
// 评分器复用 BandJudge / UserRule（与 D7 同一套，按构造不发否决类判定）。

import type { DimensionDefinition, ScoreItemSchema } from '../schema';
import type { Scorer } from '../scorer';
import { BandJudgeScorer, BinaryJudgeScorer } from '../judge';
import { UserRuleScorer } from '../../user/rule-scorer';
import { D1_LOCKED_ITEMS, EXCLUDE_DEGRADES } from './types';
import type { ScoringProfile } from './types';

export interface AppliedProfile {
  defs: DimensionDefinition[];
  scorers: Scorer[];
  warnings: string[];
}

export function applyProfile(builtins: DimensionDefinition[], profile: ScoringProfile | null): AppliedProfile {
  if (!profile) {
    return { defs: [...builtins], scorers: [], warnings: [] };
  }
  const warnings: string[] = [];
  const defs = structuredClone(builtins) as DimensionDefinition[];
  const knownIds = new Set(defs.flatMap(d => d.items.map(i => i.id)));

  const excluded = new Set((profile.excludedItems ?? []).filter(id => {
    if (!knownIds.has(id)) {
      warnings.push(`已忽略失效子项：${id}（内置定义里不存在）`);
      return false;
    }
    if ((D1_LOCKED_ITEMS as readonly string[]).includes(id)) {
      warnings.push(`已忽略非法勾除：${id}（D1 否决证据链固定项）`);
      return false;
    }
    const degrade = EXCLUDE_DEGRADES[id];
    if (degrade) warnings.push(degrade);
    return true;
  }));
  if (excluded.size > 0) {
    for (const def of defs) def.items = def.items.filter(i => !excluded.has(i.id));
  }

  for (const [id, w] of Object.entries(profile.itemWeights ?? {})) {
    if (!knownIds.has(id)) {
      warnings.push(`已忽略失效子项权重：${id}`);
      continue;
    }
    const item = defs.flatMap(d => d.items).find(i => i.id === id);
    if (item) item.weight = w;
  }

  for (const [dim, w] of Object.entries(profile.dimensionWeights ?? {})) {
    const def = defs.find(d => d.id === dim);
    if (!def || def.role !== 'weighted') {
      warnings.push(`已忽略非法维度权重：${dim}（只接受 D2–D6）`);
      continue;
    }
    def.weightInTotal = w;
  }

  const scorers: Scorer[] = [];
  for (const custom of profile.customItems ?? []) {
    const def = defs.find(d => d.id === custom.targetDimension);
    if (!def) {
      warnings.push(`已忽略自定义项 ${custom.id}：目标维度不存在`);
      continue;
    }
    if (knownIds.has(custom.id)) {
      warnings.push(`已忽略自定义项 ${custom.id}：id 与内置子项冲突`);
      continue;
    }
    if (custom.kind === 'rule' && !custom.rule) {
      warnings.push(`已忽略自定义项 ${custom.id}：规则缺失`);
      continue;
    }
    const diagnostic = custom.targetDimension === 'D2' || custom.targetDimension === 'D6';
    const item: ScoreItemSchema = {
      id: custom.id,
      dimension: custom.targetDimension,
      name: custom.name,
      scorerKind: custom.kind === 'rule' ? 'rule' : 'llm',
      note: custom.note,
      ...(diagnostic ? { diagnostic: true } : {}),
      ...(custom.kind === 'llm' && custom.bands ? { bands: custom.bands } : {}),
      ...(custom.weight != null && !diagnostic && custom.targetDimension !== 'D1' ? { weight: custom.weight } : {}),
    };
    def.items.push(item);
    if (custom.targetDimension === 'D1'
      && def.aggregation.kind === 'three-state'
      && def.aggregation.completionScoreOf) {
      def.aggregation.completionScoreOf = [...def.aggregation.completionScoreOf, custom.id];
    }
    scorers.push(custom.kind === 'rule'
      ? new UserRuleScorer(item, custom.rule!)
      : custom.kind === 'binary'
        ? new BinaryJudgeScorer(item, { criteria: `${custom.name}${custom.note ? `：${custom.note}` : ''}` })
        : new BandJudgeScorer(item, { focus: `${custom.name}（维度内自定义项）${custom.note ?? ''}` }));
    knownIds.add(custom.id);
  }

  return { defs, scorers, warnings };
}
