// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 评分卡确定性层的独立出口（Run 观测台融合用）：只跑规则评分器——不读捕获
// 文件（wire/fullContext 不取）、不走基线语料、不请 LLM，只要 turns+toolCalls
// 就能出分。维度分 = 维度定义的 weighted-average 在规则子集上的归一（口径与
// 整卡聚合同源：aggregateDimension 只对 ok 项加权，na/error 自动剔除）。
// 注意：与整卡相比这是「部分覆盖」的分数（D4 缺基线比值、D5 缺 LLM 熟练度），
// 消费侧展示时必须标注「规则层」语义，不得冒充整卡维度分。

import { d4Scorers } from './d4-efficiency/scorers';
import { d5Scorers } from './d5-redundancy/scorers';
import { d4Efficiency } from './d4-efficiency/definition';
import { d5Redundancy } from './d5-redundancy/definition';
import { aggregateDimension } from './core/aggregator';
import type { DimensionDefinition, ScoreItemSchema } from './core/schema';
import type { SubItemResult } from './core/types';
import type { AssembledInput, ScoreToolCall, ScoreTurn } from './core/assembler/types';

export interface RuleScoreItem {
  itemId: string;
  label: string;
  status: 'ok' | 'not-applicable' | 'error';
  score: number | null;
  value?: number | string | boolean;
  unit?: string | null;
  formula?: string | null;
  note?: string | null;
  evidence: Array<{ turnIndex: number | null; label: string }>;
}

export interface SessionRuleScores {
  /** D4 效率规则分（parallel+compaction 子集归一；规则层无基线比值） */
  d4: number | null;
  /** D5 冗余规则分（redispatch+repeat+toolErrors 子集归一；规则层无 LLM 熟练度） */
  d5: number | null;
  items: RuleScoreItem[];
}

/** 规则层覆盖的子项：D4.parallel/D4.compaction + D5.redispatch/D5.repeat/D5.toolErrors。
 *  D4.waste/D5.tools/D5.skills 是诊断项（不进维度分），不在融合范围。 */
const RULE_DIMENSIONS: Array<{ def: DimensionDefinition; scorers: () => import('./core/scorer').Scorer[] }> = [
  { def: d4Efficiency, scorers: d4Scorers },
  { def: d5Redundancy, scorers: d5Scorers },
];

function minimalInput(turns: ScoreTurn[], toolCalls: ScoreToolCall[]): AssembledInput {
  return {
    trajectoryDigest: '',
    memoryDigest: '',
    userMessages: [],
    toolCalls,
    turns,
    measures: { totalTokens: 0, toolTimeMs: 0, llmTimeMs: 0, inputTokens: 0 },
    taskType: 'unknown',
    workflowDecl: null,
    finishReason: 'unknown',
    interrupts: [],
    wire: null,
    redactionEvents: [],
    executions: [],
  };
}

/** 跑规则评分器并按维度定义聚合（子集归一）。逐项 try/catch：单评分器异常转
 *  error 态，不影响其余子项——与整卡 runner 的容错口径一致。 */
export async function ruleScoresOf(turns: ScoreTurn[], toolCalls: ScoreToolCall[]): Promise<SessionRuleScores> {
  const input = minimalInput(turns, toolCalls);
  const results = new Map<string, SubItemResult>();

  for (const { def, scorers } of RULE_DIMENSIONS) {
    const ruleItems = new Set(def.items.filter(i => i.scorerKind === 'rule' && !i.diagnostic).map(i => i.id));
    const defOf = new Map<string, ScoreItemSchema>(def.items.map(i => [i.id, i]));
    for (const scorer of scorers()) {
      if (!ruleItems.has(scorer.id)) continue;
      const itemDef = defOf.get(scorer.id)!;
      try {
        results.set(scorer.id, await scorer.run({ input, def: itemDef }));
      } catch (err) {
        results.set(scorer.id, {
          itemId: scorer.id,
          label: itemDef.name,
          status: 'error',
          evidence: [],
          error: { message: err instanceof Error ? err.message : '评分器异常' },
        });
      }
    }
  }

  const dimScore = (def: DimensionDefinition): number | null => {
    const items = def.items
      .filter(i => i.scorerKind === 'rule' && !i.diagnostic)
      .map(i => results.get(i.id))
      .filter((r): r is SubItemResult => r != null);
    const aggregated = aggregateDimension(def, items);
    return typeof aggregated.score === 'number' ? aggregated.score : null;
  };

  const toRuleItem = (r: SubItemResult): RuleScoreItem => ({
    itemId: r.itemId,
    label: r.label,
    status: r.status,
    score: typeof r.score === 'number' ? r.score : null,
    value: r.value,
    unit: r.unit ?? null,
    formula: r.formula ?? null,
    note: r.note ?? null,
    evidence: r.evidence.map(e => ({ turnIndex: e.turnIndex, label: e.label })),
  });

  return {
    d4: dimScore(d4Efficiency),
    d5: dimScore(d5Redundancy),
    items: [...results.values()].map(toRuleItem),
  };
}
